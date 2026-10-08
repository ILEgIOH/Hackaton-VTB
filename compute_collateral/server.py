"""HTTP-сервер (stdlib): JSON API + статика интерфейса."""
from __future__ import annotations

import json
import mimetypes
import re
import secrets
import time
from datetime import date
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

from . import ai, alerts, engine, market, parsers, report
from .market import MODELS
from .store import DATA_DIR, Store, check_password

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_UPLOAD = 20 * 1024 * 1024
DOC_TYPES = {"conclusion": "Заключение", "contract": "Договор", "data": "Данные", "act": "Акт"}


class ApiError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.code = code


def ts_to_date(ts):
    return time.strftime("%d.%m.%Y", time.localtime(ts))


class App:
    def __init__(self, store: Store):
        self.store = store
        self.routes = []
        self._register()

    # ----- helpers -----
    def deal(self, did) -> dict:
        d = self.store.db["deals"].get(did)
        if not d:
            raise ApiError("Сделка не найдена", 404)
        return d

    def cfg(self):
        return ai.ai_config(self.store.db["settings"])

    def route(self, method, pattern, public=False):
        def deco(fn):
            self.routes.append((method, re.compile("^" + pattern + "$"), fn, public))
            return fn
        return deco

    def ensure_docs(self, deal, author="Система"):
        docs = self.store.db["documents"].setdefault(deal["id"], [])
        have = {d.get("generated") for d in docs}
        today = ts_to_date(time.time())
        mode = deal.get("telemetry_mode")
        for gen, name, typ, who, ext in (
                ("report", "Заключение об оценке залога", "conclusion", author, "html"),
                ("equipment", "Перечень оборудования", "data", "От заёмщика", "xlsx"),
                ("telemetry", "Данные с серверов на дату оценки", "data", "Агент" if mode == "agent" else "Файл nvidia-smi", "csv")):
            if gen == "telemetry" and mode in (None, "none"):
                continue
            if gen not in have:
                docs.append(dict(id=secrets.token_hex(5), name=name, type=typ, date=today, author=who, generated=gen, ext=ext))

    def deal_payload(self, deal, user):
        now = time.time()
        detail = engine.deal_detail(deal, now)
        sub = [n for n in self.store.db["notifications"] if n["deal_id"] == deal["id"] and n["status"] in ("new", "in_work")]
        return dict(
            id=deal["id"], borrower=deal["borrower"], location=deal["location"], contract=deal.get("contract"),
            status=deal["status"], loan=deal["loan"], telemetry_mode=deal.get("telemetry_mode"), agent_token=deal["agent_token"],
            detail=detail, servers=engine.servers_view(deal, now), alerts=len(sub), models={k: MODELS[k]["scen"] for k in detail["valuation"]["per_model"]},
            ai_report=self.store.db["ai_reports"].get(deal["id"]), ai_ready=ai.ai_ready(self.cfg()),
        )

    # ----- routes -----
    def _register(self):
        r, st = self.route, self.store

        @r("POST", "/api/login", public=True)
        def login(ctx):
            b = ctx.json()
            u = next((x for x in st.db["users"] if x["email"].lower() == str(b.get("email", "")).strip().lower()), None)
            if not u or not check_password(str(b.get("password", "")), u["password"]):
                raise ApiError("Неверная почта или пароль", 401)
            ctx.set_cookie = st.new_session(u["email"])
            return dict(name=u["name"], initials=u["initials"], role=u["role"])

        @r("POST", "/api/logout", public=True)
        def logout(ctx):
            st.sessions.pop(ctx.token or "", None)
            ctx.clear_cookie = True
            return dict(ok=True)

        @r("GET", "/api/me", public=True)
        def me(ctx):
            u = ctx.user
            if not u:
                raise ApiError("Не авторизован", 401)
            return dict(name=u["name"], initials=u["initials"], role=u["role"], email=u["email"])

        @r("GET", "/api/portfolio")
        def portfolio(ctx):
            now = time.time()
            rows = [engine.deal_summary(d, now) for d in st.db["deals"].values() if d["status"] == "active"]
            for row in rows:
                d = st.db["deals"][row["id"]]
                row["servers"] = len(d["servers"])
            val = sum(x["market"] for x in rows)
            debt = sum(x["debt"] for x in rows)
            counts = {k: sum(1 for x in rows if x["status"] == k) for k in ("breach", "near", "ok")}
            pending = sum(1 for n in st.db["notifications"] if n["status"] in ("new", "in_work"))
            return dict(rows=rows, total_value=val, total_debt=debt, avg_coverage=val / debt if debt else None,
                        counts=counts, attention=counts["breach"] + counts["near"], pending=pending)

        @r("GET", r"/api/deals/(?P<id>[\w-]+)")
        def deal_get(ctx, id):
            return self.deal_payload(self.deal(id), ctx.user)

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/whatif")
        def whatif(ctx, id):
            deal = self.deal(id)
            b = ctx.json()
            loan = dict(deal["loan"])
            try:
                loan.update(amount=float(b["amount"]), term=int(b["term"]), rate=float(b["rate"]))
            except (KeyError, ValueError):
                raise ApiError("Неверные параметры кредита")
            if not (1e5 <= loan["amount"] <= 5e9 and 1 <= loan["term"] <= 120 and 0 <= loan["rate"] <= 60):
                raise ApiError("Параметры вне допустимых пределов")
            val = engine.valuation(deal)
            fc = engine.forecast(deal, loan, val=val)
            scen = b.get("scenario") if b.get("scenario") in engine.SCENARIOS else "pess"
            return dict(forecast=fc, recommendation=engine.recommend_ltv(fc, val["market"], scen), gap=engine.pessimistic_gap(fc["points"]),
                        half_year=engine.half_year_table(fc), market=val["market"], liquidation=val["liquidation"])

        @r("POST", "/api/parse-equipment")
        def parse_eq(ctx):
            try:
                return parsers.parse_equipment(ctx.headers.get("X-Filename", "file.csv"), ctx.body())
            except ValueError as e:
                raise ApiError(str(e))
            except Exception:
                raise ApiError("Не удалось прочитать файл. Нужен Excel (.xlsx) или CSV")

        @r("GET", "/api/template.csv", public=True)
        def template(ctx):
            return ctx.raw(("﻿" + parsers.TEMPLATE_CSV).encode("utf-8"), "text/csv; charset=utf-8", "equipment_template.csv")

        @r("POST", "/api/deals")
        def create_deal(ctx):
            b = ctx.json()
            name, loc, servers = str(b.get("borrower", "")).strip(), str(b.get("location", "")).strip(), b.get("servers") or []
            if not name:
                raise ApiError("Укажите заёмщика")
            if not servers or not all(s.get("gpus") for s in servers):
                raise ApiError("Загрузите перечень оборудования")
            for s in servers:
                if s.get("model") not in MODELS:
                    raise ApiError("Неизвестная модель оборудования")
                s["last_seen"] = None
            did = "d" + secrets.token_hex(4)
            deal = dict(id=did, borrower=name, location=loc or "—", contract="КД-" + date.today().strftime("%Y") + "-" + secrets.token_hex(2).upper(),
                        telemetry_mode=None, simulated=False, status="draft", servers=servers, agent_token=secrets.token_hex(12),
                        created=date.today().isoformat(),
                        loan=dict(amount=0, term=36, rate=18.0, schedule="annuity", issue_date=date.today().isoformat(), covenant=1.25))
            st.db["deals"][did] = deal
            st.save()
            return dict(id=did, agent_token=deal["agent_token"])

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/telemetry")
        def telemetry(ctx, id):
            deal = self.deal(id)
            mode = ctx.json().get("mode")
            if mode not in ("agent", "file", "none"):
                raise ApiError("Неизвестный режим телеметрии")
            deal["telemetry_mode"] = mode
            if mode == "none":
                for s in deal["servers"]:
                    for g in s["gpus"]:
                        for k in ("temp", "util", "hours", "actual_serial"):
                            g.pop(k, None)
            st.save()
            return dict(ok=True)

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/telemetry-file")
        def telemetry_file(ctx, id):
            deal = self.deal(id)
            try:
                rows = parsers.parse_smi(ctx.headers.get("X-Filename", "smi.csv"), ctx.body())
            except ValueError as e:
                raise ApiError(str(e))
            by_serial = {g["serial"]: (s, g) for s in deal["servers"] for g in s["gpus"]}
            by_slot = {(s["name"], g["idx"]): g for s in deal["servers"] for g in s["gpus"]}
            matched, extra, today = 0, [], date.today()
            for row in rows:
                hit = by_serial.get(row["serial"])
                slot = by_slot.get((row["host"], row["index"])) if row["host"] and row["index"] is not None else None
                g = hit[1] if hit else slot
                if g is None:
                    extra.append(row["serial"])
                    continue
                g["actual_serial"] = row["serial"]
                matched += bool(hit)
                hours = row["hours"]
                if hours is None and g.get("commissioned"):
                    hours = round((today - date.fromisoformat(g["commissioned"])).days * 24 * 0.68)
                g.update(temp=row["temp"], util=row["util"], hours=hours or 0)
            deal["telemetry_mode"] = "file"
            st.save()
            total = sum(len(s["gpus"]) for s in deal["servers"])
            return dict(total=total, matched=matched, extra=extra, missing=total - matched)

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/demo-agent")
        def demo_agent(ctx, id):
            import random
            deal = self.deal(id)
            rng = random.Random(deal["id"])
            now = time.time()
            for s in deal["servers"]:
                s["last_seen"] = now
                t0, u0, h0 = rng.randint(60, 70), rng.randint(82, 93), rng.randint(5200, 7000)
                for g in s["gpus"]:
                    g.update(actual_serial=g["serial"], temp=t0 + rng.randint(-2, 2), util=u0 + rng.randint(-3, 3), hours=h0 - rng.randint(0, 4))
            deal.update(telemetry_mode="agent", simulated=True)
            st.save()
            return dict(ok=True)

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/loan")
        def set_loan(ctx, id):
            deal = self.deal(id)
            b = ctx.json()
            try:
                loan = dict(amount=float(b["amount"]), term=int(b["term"]), rate=float(b["rate"]),
                            schedule=b.get("schedule", "annuity"), covenant=float(b.get("covenant", 1.25)),
                            issue_date=date.fromisoformat(b["issue_date"]).isoformat())
            except (KeyError, ValueError):
                raise ApiError("Проверьте параметры кредита")
            if not (1e5 <= loan["amount"] <= 5e9 and 1 <= loan["term"] <= 120 and 0 <= loan["rate"] <= 60 and 1 <= loan["covenant"] <= 5):
                raise ApiError("Параметры вне допустимых пределов")
            if loan["schedule"] not in ("annuity", "differentiated"):
                raise ApiError("Неизвестный график погашения")
            if not deal.get("telemetry_mode"):
                deal["telemetry_mode"] = "none"
            deal["loan"], deal["status"] = loan, "active"
            self.ensure_docs(deal, ctx.user["name"])
            alerts.sync(st.db, deal)
            st.save()
            return dict(id=deal["id"])

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/reassess")
        def reassess(ctx, id):
            deal = self.deal(id)
            alerts.sync(st.db, deal)
            deal["assessed_at"] = time.time()
            st.save()
            return self.deal_payload(deal, ctx.user)

        @r("GET", r"/api/deals/(?P<id>[\w-]+)/report.html")
        def report_html(ctx, id):
            deal = self.deal(id)
            html = report.conclusion_html(deal, engine.deal_detail(deal, time.time()), st.db["ai_reports"].get(id), ctx.user["name"])
            return ctx.raw(html.encode("utf-8"), "text/html; charset=utf-8", f"zaklyuchenie_{id}.html")

        @r("GET", r"/api/deals/(?P<id>[\w-]+)/documents")
        def docs_list(ctx, id):
            deal = self.deal(id)
            self.ensure_docs(deal, ctx.user["name"])
            return [dict(id=d["id"], name=d["name"], type=d["type"], type_label=DOC_TYPES[d["type"]], date=d["date"],
                         author=d["author"], ext=d.get("ext", "")) for d in st.db["documents"][id]]

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/documents")
        def docs_upload(ctx, id):
            self.deal(id)
            fname = unquote(ctx.headers.get("X-Filename", "document"))
            typ = ctx.headers.get("X-Doc-Type", "contract")
            if typ not in DOC_TYPES:
                raise ApiError("Неизвестный тип документа")
            data = ctx.body()
            did = secrets.token_hex(5)
            safe = re.sub(r"[^\w.\-]+", "_", Path(fname).name) or "document"
            path = DATA_DIR / "docs" / id
            path.mkdir(parents=True, exist_ok=True)
            (path / f"{did}_{safe}").write_bytes(data)
            ext = safe.rsplit(".", 1)[-1].lower() if "." in safe else ""
            st.db["documents"].setdefault(id, []).append(dict(id=did, name=Path(fname).stem, type=typ, date=ts_to_date(time.time()),
                                                              author=ctx.user["name"], file=f"{id}/{did}_{safe}", ext=ext))
            st.save()
            return dict(ok=True)

        @r("GET", r"/api/deals/(?P<id>[\w-]+)/documents/(?P<doc>\w+)")
        def doc_download(ctx, id, doc):
            deal = self.deal(id)
            d = next((x for x in st.db["documents"].get(id, []) if x["id"] == doc), None)
            if not d:
                raise ApiError("Документ не найден", 404)
            gen = d.get("generated")
            if gen == "report":
                return report_html(ctx, id)
            if gen == "equipment":
                return ctx.raw(report.equipment_xlsx(deal), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "equipment.xlsx")
            if gen == "telemetry":
                return ctx.raw(report.telemetry_csv(deal), "text/csv; charset=utf-8", "telemetry.csv")
            p = (DATA_DIR / "docs" / d["file"]).resolve()
            if not str(p).startswith(str((DATA_DIR / "docs").resolve())) or not p.exists():
                raise ApiError("Файл не найден", 404)
            return ctx.raw(p.read_bytes(), mimetypes.guess_type(p.name)[0] or "application/octet-stream", p.name.split("_", 1)[-1])

        @r("GET", "/api/market")
        def market_get(ctx):
            return market.market_table()

        @r("GET", "/api/notifications")
        def notifs(ctx):
            deals = st.db["deals"]
            out = sorted(st.db["notifications"], key=lambda n: -n["ts"])
            return [dict(n, borrower=deals[n["deal_id"]]["borrower"] if n["deal_id"] in deals else "—") for n in out]

        @r("POST", r"/api/notifications/(?P<id>\w+)/action")
        def notif_action(ctx, id):
            try:
                n = alerts.apply_action(st.db, id, ctx.json().get("action"), ctx.user)
            except KeyError as e:
                raise ApiError(str(e), 404)
            except ValueError as e:
                raise ApiError(str(e))
            st.save()
            return n

        @r("GET", "/api/settings")
        def settings_get(ctx):
            c = self.cfg()
            return dict(ai=dict(enabled=bool(st.db["settings"]["ai"].get("enabled")), base_url=c["base_url"], model=c["model"],
                                interval_min=c.get("interval_min", 30), has_key=bool(c["api_key"])),
                        simulate=st.db["settings"].get("simulate", True))

        @r("POST", "/api/settings")
        def settings_set(ctx):
            b = ctx.json()
            a = st.db["settings"]["ai"]
            for k in ("base_url", "model"):
                if isinstance(b.get("ai", {}).get(k), str) and b["ai"][k].strip():
                    a[k] = b["ai"][k].strip()
            if "enabled" in b.get("ai", {}):
                a["enabled"] = bool(b["ai"]["enabled"])
            if isinstance(b.get("ai", {}).get("api_key"), str) and b["ai"]["api_key"].strip():
                a["api_key"] = b["ai"]["api_key"].strip()
            if b.get("ai", {}).get("clear_key"):
                a["api_key"] = ""
            if "interval_min" in b.get("ai", {}):
                a["interval_min"] = max(1, min(1440, int(b["ai"]["interval_min"])))
            if "simulate" in b:
                st.db["settings"]["simulate"] = bool(b["simulate"])
            st.save()
            return settings_get(ctx)

        @r("POST", "/api/ai/test")
        def ai_test(ctx):
            c = self.cfg()
            if not (c["api_key"] or "localhost" in c["base_url"] or "127.0.0.1" in c["base_url"]):
                raise ApiError("Не указан API-ключ")
            try:
                reply = ai.chat(c, [dict(role="user", content="Ответь одним словом: работает")], timeout=30)
            except Exception as e:
                raise ApiError(str(e), 502)
            return dict(ok=True, reply=reply[:200], model=c["model"])

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/ai-analyze")
        def ai_analyze(ctx, id):
            deal = self.deal(id)
            rep = ai.analyze(deal, engine.deal_detail(deal, time.time()), self.cfg())
            st.db["ai_reports"][id] = rep
            st.save()
            return rep

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/ai-chat")
        def ai_chat(ctx, id):
            deal = self.deal(id)
            q = str(ctx.json().get("question", "")).strip()[:2000]
            if not q:
                raise ApiError("Введите вопрос")
            try:
                return dict(answer=ai.ask(deal, engine.deal_detail(deal, time.time()), self.cfg(), q))
            except Exception as e:
                raise ApiError(str(e), 502)

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/incident")
        def incident(ctx, id):
            """Демо: смоделировать инцидент на серверах, чтобы показать реакцию мониторинга."""
            deal = self.deal(id)
            kind = ctx.json().get("type")
            srv = deal["servers"][-1]
            if kind == "overheat":
                for g in srv["gpus"][:3]:
                    g.update(temp=91, hot=True)
            elif kind == "swap":
                srv["gpus"][-1]["actual_serial"] = "1654029999" + secrets.token_hex(2)[:3].replace("a", "1")
            elif kind == "offline":
                srv.update(frozen=True, last_seen=time.time() - 2 * 3600)
            elif kind == "reset":
                for s in deal["servers"]:
                    s.pop("frozen", None)
                    s["last_seen"] = time.time()
                    for g in s["gpus"]:
                        g.pop("hot", None)
                        if g.get("actual_serial") and g["actual_serial"] != g["serial"] and g["serial"] != "1654023118915":
                            g["actual_serial"] = g["serial"]
                        if g.get("temp", 0) > 80:
                            g["temp"] = 66
            else:
                raise ApiError("Неизвестный тип инцидента")
            alerts.sync(st.db, deal)
            st.save()
            return dict(ok=True)

        @r("POST", "/api/agent/ingest", public=True)
        def ingest(ctx):
            b = ctx.json()
            deal = next((d for d in st.db["deals"].values() if secrets.compare_digest(d["agent_token"], str(b.get("token", "")))), None)
            if not deal:
                raise ApiError("Неверный токен агента", 401)
            srv = next((s for s in deal["servers"] if s["name"] == b.get("server")), None)
            if not srv:
                raise ApiError(f"Сервер {b.get('server')} не входит в перечень оборудования", 404)
            now = time.time()
            for rep in b.get("gpus", []):
                idx = rep.get("index")
                g = next((x for x in srv["gpus"] if x["idx"] == idx), None)
                if g is None:
                    continue
                hours = rep.get("hours")
                if hours is not None and g.get("hours") and hours < g["hours"] - 1:
                    st.db["events"].append(dict(ts=now, deal=deal["id"], server=srv["name"], gpu=idx, event="hours_reset",
                                                old=g["hours"], new=hours))
                g.update(actual_serial=str(rep.get("serial", "")) or None, temp=rep.get("temperature"), util=rep.get("utilization"))
                if hours is not None:
                    g["hours"] = hours
            srv["last_seen"] = now
            srv.pop("frozen", None)
            if deal["telemetry_mode"] != "agent":
                deal["telemetry_mode"], deal["simulated"] = "agent", False
            alerts.sync(st.db, deal, now)
            st.save()
            return dict(ok=True)


class Ctx:
    def __init__(self, h: BaseHTTPRequestHandler, query):
        self.h, self.query = h, query
        self.headers, self.set_cookie, self.clear_cookie = h.headers, None, False
        c = SimpleCookie(h.headers.get("Cookie", ""))
        self.token = c["cc_session"].value if "cc_session" in c else None
        self.user = None
        self._body = None

    def body(self) -> bytes:
        if self._body is None:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_UPLOAD:
                raise ApiError("Файл слишком большой (максимум 20 МБ)", 413)
            self._body = self.h.rfile.read(n) if n else b""
        return self._body

    def json(self) -> dict:
        try:
            v = json.loads(self.body() or b"{}")
            return v if isinstance(v, dict) else {}
        except json.JSONDecodeError:
            raise ApiError("Некорректный JSON")

    def raw(self, data: bytes, ctype: str, filename: str | None = None):
        return RawResponse(data, ctype, filename)


class RawResponse:
    def __init__(self, data, ctype, filename):
        self.data, self.ctype, self.filename = data, ctype, filename


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "ComputeCollateral/0.1"

        def log_message(self, *a):
            pass

        def _send(self, code, data: bytes, ctype, extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or []):
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _static(self, path):
            rel = "index.html" if path in ("/", "") else path.lstrip("/")
            p = (WEB_DIR / rel).resolve()
            if not str(p).startswith(str(WEB_DIR.resolve())) or not p.is_file():
                p = WEB_DIR / "index.html"
            ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            self._send(200, p.read_bytes(), ctype)

        def _dispatch(self, method):
            url = urlparse(self.path)
            if not url.path.startswith("/api/"):
                if method != "GET":
                    return self._send(405, b"", "text/plain")
                return self._static(url.path)
            ctx = Ctx(self, parse_qs(url.query))
            try:
                if method == "POST":
                    ctx.body()  # всегда вычитываем тело, иначе ломается keep-alive
                with app.store.lock:
                    ctx.user = app.store.user_for(ctx.token)
                    for m, rx, fn, public in app.routes:
                        mt = rx.match(url.path)
                        if m == method and mt:
                            if not public and not ctx.user:
                                raise ApiError("Требуется вход", 401)
                            res = fn(ctx, **mt.groupdict())
                            break
                    else:
                        raise ApiError("Не найдено", 404)
                extra = []
                if ctx.set_cookie:
                    extra.append(("Set-Cookie", f"cc_session={ctx.set_cookie}; Path=/; HttpOnly; SameSite=Strict"))
                if ctx.clear_cookie:
                    extra.append(("Set-Cookie", "cc_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"))
                if isinstance(res, RawResponse):
                    if res.filename:
                        extra.append(("Content-Disposition", f"attachment; filename*=UTF-8''{quote(res.filename)}"))
                    return self._send(200, res.data, res.ctype, extra)
                self._send(200, json.dumps(res, ensure_ascii=False).encode(), "application/json; charset=utf-8", extra)
            except ApiError as e:
                self._send(e.code, json.dumps(dict(error=str(e)), ensure_ascii=False).encode(), "application/json; charset=utf-8")
            except Exception as e:  # noqa
                import traceback
                traceback.print_exc()
                self._send(500, json.dumps(dict(error="Внутренняя ошибка: " + str(e)), ensure_ascii=False).encode(), "application/json; charset=utf-8")

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

    return Handler


def create_server(store: Store, host="127.0.0.1", port=8765):
    app = App(store)
    return ThreadingHTTPServer((host, port), make_handler(app))

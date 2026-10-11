"""HTTP-сервер (stdlib): JSON API + статика интерфейса. Права проверяются здесь, а не только в интерфейсе."""
from __future__ import annotations

import json
import mimetypes
import random
import re
import secrets
import time
from datetime import date
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

from . import ai, alerts, docs, engine, mailer, market, parsers, report, users
from .market import MODELS
from .store import DATA_DIR, Store, check_password, hash_password

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_UPLOAD = 21 * 1024 * 1024
DOC_TYPES = {"conclusion": "Заключение", "contract": "Договор", "data": "Данные", "act": "Акт", "other": "Другое"}
DOC_EXT = {"pdf", "doc", "docx", "xls", "xlsx", "jpg", "jpeg", "png"}
BANK_DOMAIN = "bank.ru"
LOCK_MINUTES, MAX_FAILS = 15, 3
CALC_STEP_SEC = 0.9
CALC_STEPS = ["Сверяем серийные номера с перечнем", "Обрабатываем данные {cards} карт", "Собираем цены дилеров и ставки аренды",
              "Считаем три метода оценки", "Строим прогноз и подбираем LTV"]
LOAN_LIMITS = dict(amount=(1e6, 5e8), term=(6, 60), rate=(1, 40), covenant=(1.0, 2.0))


class ApiError(Exception):
    def __init__(self, msg, status=400, **extra):
        super().__init__(msg)
        self.code, self.extra = status, extra     # .code — HTTP-статус; extra["code"] — машинный код для интерфейса


def ts_to_date(ts):
    return time.strftime("%d.%m.%Y", time.localtime(ts))


def fmt_rub(v):
    return f"{v / 1e6:.1f}".replace(".", ",") + " млн ₽"


def validate_loan(b: dict, today: date | None = None, need_date=True) -> dict:
    """Правила полей (ТЗ): сумма 1–500 млн, срок 6–60 мес., ставка 1–40 %, ковенант 1,00–2,00, дата выдачи не раньше сегодня."""
    errs, loan = {}, {}
    def num(key, cast):
        try:
            v = cast(str(b.get(key)).replace(" ", "").replace(",", "."))
        except (ValueError, TypeError):
            errs[key] = "Введите число"
            return None
        lo, hi = LOAN_LIMITS[key]
        if not lo <= v <= hi:
            errs[key] = {"amount": "Введите сумму от 1 до 500 млн ₽", "term": "Срок от 6 до 60 месяцев", "rate": "Ставка от 1 до 40 % годовых",
                         "covenant": "Ковенант от 1,00 до 2,00"}[key]
            return None
        return v
    loan["amount"], loan["term"], loan["rate"] = num("amount", float), num("term", lambda x: int(float(x))), num("rate", float)
    if "covenant" in b or need_date:
        loan["covenant"] = num("covenant", float) if "covenant" in b else engine.TH["covenant"]
    loan["schedule"] = b.get("schedule", "annuity")
    if loan["schedule"] not in ("annuity", "differentiated"):
        errs["schedule"] = "Неизвестный график"
    if need_date:
        try:
            d = date.fromisoformat(str(b.get("issue_date")))
            if d < (today or date.today()):
                errs["issue_date"] = "Дата не может быть раньше сегодняшней"
            loan["issue_date"] = d.isoformat()
        except ValueError:
            errs["issue_date"] = "Укажите дату выдачи"
    if errs:
        raise ApiError("Проверьте параметры кредита", 422, fields=errs)
    return loan


class App:
    def __init__(self, store: Store):
        self.store = store
        self.routes = []
        self.bootstrap()
        self._register()

    def bootstrap(self):
        db = self.store.db
        market.apply_state(db.get("market"))
        engine.TH.update(db.get("settings", {}).get("thresholds", {}))

    # ----- helpers -----
    @property
    def db(self):
        return self.store.db

    def deal(self, did, allow_draft=True) -> dict:
        d = self.db["deals"].get(did)
        if not d or (d["status"] == "draft" and not allow_draft):
            raise ApiError("Сделка не найдена", 404)
        return d

    def cfg(self):
        return ai.ai_config(self.db["settings"])

    def route(self, method, pattern, public=False, perm=None):
        def deco(fn):
            self.routes.append((method, re.compile("^" + pattern + "$"), fn, public, perm))
            return fn
        return deco

    def finalize_calcs(self, now=None):
        """Завершает расчёты новых оценок (экран N11): сделка становится активной, автору приходит «Оценка готова»."""
        now = now or time.time()
        for d in self.db["deals"].values():
            c = d.get("calc")
            if d["status"] == "calculating" and c and now - c["started"] >= CALC_STEP_SEC * len(CALC_STEPS):
                d["status"] = "active"
                d["assessments"] = d.get("assessments", []) + [self.snapshot(d, c["author_name"], now)]
                self.ensure_docs(d, c["author_name"])
                alerts.add(self.db, d, "ready", f"Оценка готова: {d['borrower']}", f"Рыночная стоимость {fmt_rub(d['assessments'][-1]['market'])}", "low", now,
                           "Открыть компанию", author=c["author"], status="new")
                alerts.sync(self.db, d, now)
                self.store.save()

    def snapshot(self, deal, author, now=None):
        now = now or time.time()
        v = engine.valuation(deal, now)
        rec = engine.recommend_ltv(engine.forecast(deal, val=v), v["market"])
        return dict(ts=now, author=author, market=v["market"], liquidation=v["liquidation"], ltv=rec["ltv"], wear=v["wear"], cards=v["cards"],
                    prices={k: m["median"] for k, m in MODELS.items()})

    def ensure_market_fresh(self):
        m = self.db.setdefault("market", dict(factors={k: 1.0 for k in MODELS}, updated=date.today().isoformat()))
        if m.get("updated") != date.today().isoformat():
            market.refresh_prices(m, random.Random())
            self.store.save()

    def ensure_docs(self, deal, author="Система"):
        dl = self.db["documents"].setdefault(deal["id"], [])
        have = {d.get("generated") for d in dl}
        today = ts_to_date(time.time())
        mode = deal.get("telemetry_mode")
        for gen, name, typ, who, ext in (
                ("report", "Заключение об оценке залога", "conclusion", author, "pdf"),
                ("equipment", "Перечень оборудования", "data", "От заёмщика", "xlsx"),
                ("telemetry", "Данные с серверов на дату оценки", "data", "Агент" if mode == "agent" else "Файл nvidia-smi", "csv")):
            if gen == "telemetry" and mode in (None, "none"):
                continue
            if gen not in have:
                dl.append(dict(id=secrets.token_hex(5), name=name, type=typ, date=today, ts=time.time(), author=who, generated=gen, ext=ext))

    def deal_payload(self, deal, user):
        now = time.time()
        detail = engine.deal_detail(deal, now)
        sub = [n for n in self.db["notifications"] if n["deal_id"] == deal["id"] and n["status"] in alerts.OPEN_STATES]
        asm = deal.get("assessments", [])
        servers = engine.servers_view(deal, now)
        return dict(
            id=deal["id"], borrower=deal["borrower"], inn=deal.get("inn"), location=deal["location"], contract=deal.get("contract"),
            application=deal.get("application"), contact=deal.get("contact"), contact_email=deal.get("contact_email"),
            status=deal["status"], loan=deal["loan"], telemetry_mode=deal.get("telemetry_mode"), agent_token=deal["agent_token"],
            agent_key=deal.get("agent_key"), detail=detail, servers=servers, alerts=len(sub),
            models={k: MODELS[k]["scen"] for k in detail["valuation"]["per_model"]}, thresholds=engine.TH,
            ai_report=self.db["ai_reports"].get(deal["id"]), ai_ready=ai.ai_ready(self.cfg()),
            assessed_at=asm[-1]["ts"] if asm else None, last_assessment=asm[-1] if asm else None, tranches_suspended=bool(deal.get("tranches_suspended")),
            market_updated=self.db.get("market", {}).get("updated"),
        )

    def visible_notes(self, user):
        out = []
        for n in self.db["notifications"]:
            if n["kind"] == "ready" and n.get("author") != user["email"]:
                continue        # «Оценка готова» приходит только автору оценки
            if users.notify_pref(user, n["kind"])["app"]:
                out.append(n)
        return out

    def pending_count(self, user):
        return sum(1 for n in self.visible_notes(user) if n["status"] in alerts.OPEN_STATES)

    def settings_payload(self, user):
        s = self.db["settings"]
        c = self.cfg()
        return dict(
            thresholds=dict(engine.TH), can_edit_thresholds=users.can(user, "edit_thresholds"),
            notify=[dict(kind=k, label=l, to=to, **users.notify_pref(user, k)) for k, l, to in users.NOTIFY_TYPES],
            ai=dict(enabled=bool(s["ai"].get("enabled")), base_url=c["base_url"], model=c["model"], interval_min=c.get("interval_min", 30),
                    has_key=bool(c["api_key"]), key_from_env=bool(__import__("os").environ.get("CC_AI_API_KEY") or __import__("os").environ.get("ANTHROPIC_API_KEY")), can_edit=users.can(user, "ai_settings")),
            simulate=s.get("simulate", True))

    # ----- routes -----
    def _register(self):
        r, st = self.route, self.store

        # --- вход ---
        @r("POST", "/api/login", public=True)
        def login(ctx):
            b = ctx.json()
            email = str(b.get("email", "")).strip().lower()
            if not re.fullmatch(r"[^@\s]+@" + re.escape(BANK_DOMAIN), email):
                raise ApiError(f"Укажите рабочую почту на домене @{BANK_DOMAIN}", 400, field="email")
            f = st.failures.get(email, [0, 0])
            if f[1] > time.time():
                raise ApiError(f"Вход временно закрыт на {LOCK_MINUTES} минут. Попробуйте позже", 423, locked_until=f[1])
            u = next((x for x in self.db["users"] if x["email"] == email), None)
            if not u or not check_password(str(b.get("password", "")), u["password"]):
                f = [f[0] + 1, 0] if f[1] == 0 or f[1] < time.time() else f
                if f[0] >= MAX_FAILS:
                    f = [0, time.time() + LOCK_MINUTES * 60]
                    st.failures[email] = f
                    raise ApiError(f"Вход временно закрыт на {LOCK_MINUTES} минут из-за трёх неудачных попыток", 423, locked_until=f[1])
                st.failures[email] = f
                left = MAX_FAILS - f[0]
                raise ApiError(f"Неверная почта или пароль. Осталось {left} {'попытка' if left == 1 else 'попытки'}", 401, attempts_left=left)
            st.failures.pop(email, None)
            ctx.set_cookie = st.new_session(u["email"])
            return users.public(u)

        @r("POST", "/api/logout", public=True)
        def logout(ctx):
            st.sessions.pop(ctx.token or "", None)
            ctx.clear_cookie = True
            return dict(ok=True)

        @r("GET", "/api/me", public=True)
        def me(ctx):
            if not ctx.user:
                raise ApiError("Сессия завершена" if ctx.expired else "Не авторизован", 401, code="session_expired" if ctx.expired else "auth")
            return dict(users.public(ctx.user), pending=self.pending_count(ctx.user))

        @r("POST", "/api/password-reset", public=True)
        def pw_reset(ctx):
            email = str(ctx.json().get("email", "")).strip().lower()
            u = next((x for x in self.db["users"] if x["email"] == email), None)
            if u:   # ответ одинаковый независимо от того, есть ли такая почта (защита от подбора)
                tok = secrets.token_urlsafe(18)
                self.db.setdefault("resets", {})[tok] = dict(email=email, until=time.time() + 30 * 60)
                try:
                    mailer.send(self.db, email, "Восстановление пароля ComputeCollateral",
                                f"Ссылка для нового пароля действует 30 минут: http://127.0.0.1:8765/#/reset/{tok}", "noreply@bank.ru", "reset")
                except RuntimeError:
                    pass
                st.save()
            return dict(ok=True)

        @r("POST", "/api/password-reset/confirm", public=True)
        def pw_confirm(ctx):
            b = ctx.json()
            rec = self.db.get("resets", {}).get(str(b.get("token")))
            if not rec or rec["until"] < time.time():
                raise ApiError("Ссылка устарела. Запросите новую", 400)
            if len(str(b.get("password", ""))) < 8:
                raise ApiError("Пароль не короче 8 символов", 422)
            u = next(x for x in self.db["users"] if x["email"] == rec["email"])
            u["password"] = hash_password(str(b["password"]))
            self.db["resets"].pop(b["token"])
            st.failures.pop(u["email"], None)
            st.save()
            return dict(ok=True)

        # --- портфель, поиск ---
        @r("GET", "/api/portfolio", perm="view")
        def portfolio(ctx):
            self.finalize_calcs()
            now = time.time()
            rows = [engine.deal_summary(d, now) for d in self.db["deals"].values() if d["status"] == "active"]
            for row in rows:
                d = self.db["deals"][row["id"]]
                row["servers"] = len(d["servers"])
                row["borrower_inn"] = d.get("inn")
            val = sum(x["market"] for x in rows)
            debt = sum(x["debt"] for x in rows)
            counts = {k: sum(1 for x in rows if x["status"] == k) for k in ("breach", "near", "ok")}
            return dict(rows=rows, total_value=val, total_debt=debt, avg_coverage=val / debt if debt else None,
                        counts=counts, attention=counts["breach"] + counts["near"], pending=self.pending_count(ctx.user), thresholds=dict(engine.TH),
                        calculating=[dict(id=d["id"], borrower=d["borrower"]) for d in self.db["deals"].values() if d["status"] == "calculating"])

        @r("GET", "/api/search", perm="view")
        def search(ctx):
            q = (ctx.query.get("q", [""])[0] or "").strip().lower()
            if len(q) < 3:
                return dict(items=[])
            items = []
            for d in self.db["deals"].values():
                if d["status"] != "active":
                    continue
                if q in d["borrower"].lower() or q in str(d.get("inn", "")) or q in str(d.get("contract", "")).lower():
                    items.append(dict(type="company", title=d["borrower"], sub=f"Сделка {d.get('contract', '')}, {d['location']}", deal_id=d["id"]))
                for s in d["servers"]:
                    for g in s["gpus"]:
                        if q in g["serial"]:
                            items.append(dict(type="card", title=f"Карта {MODELS[s['model']]['name']}, s/n {g['serial']}", sub=f"{d['borrower']}, сервер {s['name']}",
                                              deal_id=d["id"], server=s["name"], serial=g["serial"]))
            return dict(items=items[:8], total=len(items))

        @r("GET", "/api/check-inn", perm="create_assessment")
        def check_inn(ctx):
            inn = (ctx.query.get("inn", [""])[0] or "").strip()
            if not parsers.inn_valid(inn):
                return dict(valid=False, existing=None)
            ex = next((d for d in self.db["deals"].values() if d.get("inn") == inn and d["status"] in ("active", "calculating")), None)
            asm = ex.get("assessments", []) if ex else []
            return dict(valid=True, existing=dict(id=ex["id"], borrower=ex["borrower"], contract=ex.get("contract"),
                                                  assessed=ts_to_date(asm[-1]["ts"]) if asm else None) if ex else None)

        # --- сделка ---
        @r("GET", r"/api/deals/(?P<id>[\w-]+)", perm="view")
        def deal_get(ctx, id):
            self.finalize_calcs()
            return self.deal_payload(self.deal(id), ctx.user)

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/whatif", perm="view")
        def whatif(ctx, id):
            deal = self.deal(id)
            b = ctx.json()
            loan = dict(deal["loan"], **validate_loan(dict(b, covenant=deal["loan"].get("covenant", 1.25)), need_date=False))
            val = engine.valuation(deal)
            fc = engine.forecast(deal, loan, val=val)
            scen = b.get("scenario") if b.get("scenario") in engine.SCENARIOS else "pess"
            basis = "liquidation" if b.get("basis") == "liquidation" else "market"
            return dict(forecast=fc, recommendation=engine.recommend_ltv(fc, val["market"], scen, basis), gap=engine.pessimistic_gap(fc["points"]),
                        half_year=engine.half_year_table(fc), market=val["market"], liquidation=val["liquidation"])

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/terms", perm="edit_terms")
        def save_terms(ctx, id):
            deal = self.deal(id, allow_draft=False)
            deal["loan"] = dict(deal["loan"], **validate_loan(dict(ctx.json(), covenant=deal["loan"].get("covenant", 1.25)), need_date=False))
            alerts.sync(self.db, deal)
            st.save()
            return self.deal_payload(deal, ctx.user)

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/reassess", perm="reassess")
        def reassess(ctx, id):
            deal = self.deal(id, allow_draft=False)
            now = time.time()
            prev = (deal.get("assessments") or [None])[-1]
            # 1) прежняя оценка сохраняется в «Документах»
            if prev:
                dd = engine.deal_detail(deal, prev["ts"])
                self.save_snapshot_doc(deal, prev, ctx.user["short"])
            # 2) свежие цены дилеров и данные агента
            market.refresh_prices(self.db["market"], random.Random())
            snap = self.snapshot(deal, ctx.user["short"], now)
            deal.setdefault("assessments", []).append(snap)
            change = None
            if prev:
                delta = snap["market"] / prev["market"] - 1
                reason = "существенных изменений нет"
                if abs(snap["wear"] - prev["wear"]) > 0.002:
                    reason = "изменились данные агента"
                lc = self.db["market"].get("last_change", {})
                used = [k for k in engine.card_counts(deal) if k in lc]
                if used:
                    top = max(used, key=lambda k: abs(lc[k]))
                    if abs(lc[top]) >= 0.002 and abs(delta) >= 0.002:
                        reason = f"цены дилеров на {top} " + ("снизились" if lc[top] < 0 else "выросли")
                change = dict(prev=prev["market"], now=snap["market"], pct=delta, reason=reason, prev_date=ts_to_date(prev["ts"]))
            alerts.sync(self.db, deal, now)
            alerts.add(self.db, deal, "ready", f"Переоценка готова: {deal['borrower']}", f"Рыночная стоимость {fmt_rub(snap['market'])}", "low", now,
                       "Открыть компанию", author=ctx.user["email"])
            st.save()
            return dict(change=change, deal=self.deal_payload(deal, ctx.user))

        @r("GET", r"/api/deals/(?P<id>[\w-]+)/calc", perm="view")
        def calc_status(ctx, id):
            self.finalize_calcs()
            d = self.deal(id)
            c = d.get("calc")
            if d["status"] == "active" or not c:
                return dict(done=d["status"] == "active", step=len(CALC_STEPS), steps=[x.format(cards=0) for x in CALC_STEPS])
            el = time.time() - c["started"]
            step = min(len(CALC_STEPS), int(el / CALC_STEP_SEC))
            cards = sum(len(s["gpus"]) for s in d["servers"])
            return dict(done=False, step=step, progress=min(1.0, el / (CALC_STEP_SEC * len(CALC_STEPS))), steps=[x.format(cards=cards) for x in CALC_STEPS])

        # --- мастер «Новая оценка» ---
        @r("POST", "/api/parse-equipment", perm="create_assessment")
        def parse_eq(ctx):
            try:
                return parsers.parse_equipment(ctx.headers.get("X-Filename", "file.csv") and unquote(ctx.headers.get("X-Filename", "file.csv")), ctx.body())
            except parsers.FileError as e:
                raise ApiError(str(e), 422)
            except Exception:
                raise ApiError("Не удалось прочитать файл. Нужен Excel (.xlsx) или CSV", 422)

        @r("GET", "/api/template.csv", public=True)
        def template(ctx):
            return ctx.raw(("﻿" + parsers.TEMPLATE_CSV).encode("utf-8"), "text/csv; charset=utf-8", "equipment_template.csv")

        @r("GET", "/api/template.xlsx", public=True)
        def template_x(ctx):
            return ctx.raw(parsers.template_xlsx(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "equipment_template.xlsx")

        @r("POST", "/api/deals", perm="create_assessment")
        def create_deal(ctx):
            b = ctx.json()
            errs = parsers.validate_borrower(b)
            if errs:
                raise ApiError("Проверьте данные заёмщика", 422, fields=errs)
            servers = b.get("servers") or []
            if not servers or not all(s.get("gpus") for s in servers):
                raise ApiError("Загрузите перечень оборудования", 422)
            for s in servers:
                if s.get("model") not in MODELS:
                    raise ApiError("Неизвестная модель оборудования", 422)
                s["last_seen"] = None
            inn = str(b["inn"]).strip()
            ex = next((d for d in self.db["deals"].values() if d.get("inn") == inn and d["status"] in ("active", "calculating")), None)
            if ex and not b.get("force"):
                raise ApiError("Компания с этим ИНН уже есть в портфеле", 409, existing=dict(id=ex["id"], borrower=ex["borrower"], contract=ex.get("contract")))
            for old in [k for k, d in self.db["deals"].items() if d["status"] == "draft" and d.get("author") == ctx.user["email"]]:
                del self.db["deals"][old]      # у сотрудника один черновик
            did = "d" + secrets.token_hex(4)
            app_no = str(b["application"]).strip().upper().replace("KD", "КД")
            self.db["deals"][did] = dict(
                id=did, borrower=str(b["name"]).strip(), inn=inn, location=str(b["location"]).strip(), contract=app_no, application=app_no,
                contact=str(b["contact"]).strip(), contact_email=str(b.get("contact_email", "")).strip(), telemetry_mode=None, simulated=False,
                status="draft", servers=servers, author=ctx.user["email"], agent_token=secrets.token_hex(12), agent_key=_agent_key(),
                created=date.today().isoformat(), assessments=[], draft_step=3,
                loan=dict(amount=0, term=36, rate=18.0, schedule="annuity", issue_date=date.today().isoformat(), covenant=engine.TH["covenant"]))
            st.save()
            return dict(id=did, agent_token=self.db["deals"][did]["agent_token"], agent_key=self.db["deals"][did]["agent_key"])

        @r("GET", "/api/draft", perm="create_assessment")
        def get_draft(ctx):
            d = next((x for x in self.db["deals"].values() if x["status"] == "draft" and x.get("author") == ctx.user["email"]), None)
            if not d:
                return dict(draft=None)
            return dict(draft=dict(id=d["id"], borrower=d["borrower"], inn=d["inn"], application=d["application"], location=d["location"], contact=d["contact"],
                                   contact_email=d.get("contact_email", ""), step=d.get("draft_step", 2), telemetry_mode=d.get("telemetry_mode"),
                                   servers=[dict(name=s["name"], model=s["model"], gpus=s["gpus"]) for s in d["servers"]], agent_key=d.get("agent_key"),
                                   cards=sum(len(s["gpus"]) for s in d["servers"])))

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/discard", perm="create_assessment")
        def discard(ctx, id):
            d = self.deal(id)
            if d["status"] == "draft":
                del self.db["deals"][id]
                st.save()
            return dict(ok=True)

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/step", perm="create_assessment")
        def set_step(ctx, id):
            d = self.deal(id)
            if d["status"] == "draft":
                d["draft_step"] = int(ctx.json().get("step", 2))
                st.save()
            return dict(ok=True)

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/telemetry", perm="create_assessment")
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

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/telemetry-file", perm="create_assessment")
        def telemetry_file(ctx, id):
            deal = self.deal(id)
            try:
                rows = parsers.parse_smi(unquote(ctx.headers.get("X-Filename", "smi.csv")), ctx.body())
            except parsers.FileError as e:
                raise ApiError(str(e), 422)
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

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/demo-agent", perm="create_assessment")
        def demo_agent(ctx, id):
            deal = self.deal(id)
            rng = random.Random(deal["id"])
            now = time.time()
            silent = int(ctx.json().get("silent", 0))      # сколько серверов оставить «молчащими» (демонстрация N08)
            for i, s in enumerate(deal["servers"]):
                t0, u0, h0 = rng.randint(60, 70), rng.randint(82, 93), rng.randint(5200, 7000)
                s["last_seen"] = None if i >= len(deal["servers"]) - silent else now
                for g in s["gpus"]:
                    if s["last_seen"]:
                        g.update(actual_serial=g["serial"], temp=t0 + rng.randint(-2, 2), util=u0 + rng.randint(-3, 3), hours=h0 - rng.randint(0, 4))
            deal.update(telemetry_mode="agent", simulated=True)
            st.save()
            return dict(ok=True)

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/invite-cod", perm="create_assessment")
        def invite_cod(ctx, id):
            deal = self.deal(id)
            if not deal.get("contact_email"):
                raise ApiError("У контакта в ЦОД не указана почта (шаг «Заёмщик»)", 422)
            host = ctx.headers.get("Host", "127.0.0.1:8765")
            names = ", ".join(s["name"] for s in deal["servers"])
            body = (f"Здравствуйте, {deal.get('contact', '')}!\n\nДля оценки залога {deal['borrower']} просим подключить агента мониторинга на серверах ({names}).\n\n"
                    f"Ключ подключения: {deal['agent_key']}\nНа каждом сервере выполните:\n"
                    f"  python agent.py --server http://{host} --key {deal['agent_key']} --name <имя сервера>\n\nАгент отправляет только серийные номера, температуру, загрузку и наработку карт.")
            try:
                mailer.send(self.db, deal["contact_email"], f"Подключение агента: {deal['borrower']}", body, ctx.user["email"], "invite", deal["id"])
            except RuntimeError as e:
                raise ApiError(str(e), 502)
            st.save()
            return dict(ok=True, to=deal["contact_email"])

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/loan", perm="create_assessment")
        def set_loan(ctx, id):
            deal = self.deal(id)
            loan = validate_loan(ctx.json())
            if not deal.get("telemetry_mode"):
                deal["telemetry_mode"] = "none"
            deal["loan"], deal["status"] = loan, "calculating"
            deal["calc"] = dict(started=time.time(), author=ctx.user["email"], author_name=ctx.user["short"])
            st.save()
            return dict(id=deal["id"])

        # --- оборудование: письмо в ЦОД ---
        @r("POST", r"/api/deals/(?P<id>[\w-]+)/write-cod", perm="write_cod")
        def write_cod(ctx, id):
            deal = self.deal(id, allow_draft=False)
            b = ctx.json()
            if not deal.get("contact_email"):
                raise ApiError("У контакта в ЦОД не указана почта", 422)
            subj, msg = str(b.get("subject", "")).strip(), str(b.get("message", "")).strip()
            if not subj or not msg:
                raise ApiError("Заполните тему и сообщение", 422)
            try:
                mailer.send(self.db, deal["contact_email"], subj, msg, ctx.user["email"], "cod", deal["id"])
            except RuntimeError as e:
                raise ApiError(str(e), 502)
            st.save()
            return dict(ok=True, to=deal["contact_email"], contact=deal.get("contact"))

        # --- документы ---
        @r("GET", r"/api/deals/(?P<id>[\w-]+)/documents", perm="view")
        def docs_list(ctx, id):
            deal = self.deal(id)
            self.ensure_docs(deal, ctx.user["short"])
            return [dict(id=d["id"], name=d["name"], type=d["type"], type_label=DOC_TYPES[d["type"]], date=d["date"], author=d["author"], ext=d.get("ext", ""),
                         comment=d.get("comment", "")) for d in sorted(self.db["documents"][id], key=lambda x: -x.get("ts", 0))]

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/documents", perm="upload_docs")
        def docs_upload(ctx, id):
            self.deal(id)
            fname = unquote(ctx.headers.get("X-Filename", "document"))
            typ = ctx.headers.get("X-Doc-Type", "contract")
            if typ not in DOC_TYPES:
                raise ApiError("Выберите тип документа", 422)
            ext = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
            if ext not in DOC_EXT:
                raise ApiError("Файл: PDF, Word, Excel, JPG или PNG", 422)
            data = ctx.body()
            if len(data) > 20 * 1024 * 1024:
                raise ApiError("Файл больше 20 МБ", 413)
            if not data:
                raise ApiError("Файл пуст", 422)
            self.store_doc(id, Path(fname).stem, typ, ctx.user["short"], ext, data, unquote(ctx.headers.get("X-Comment", "")))
            st.save()
            return dict(ok=True)

        @r("GET", r"/api/deals/(?P<id>[\w-]+)/documents/(?P<doc>\w+)", perm="view")
        def doc_download(ctx, id, doc):
            deal = self.deal(id)
            d = next((x for x in self.db["documents"].get(id, []) if x["id"] == doc), None)
            if not d:
                raise ApiError("Документ не найден", 404)
            inline = ctx.query.get("inline", ["0"])[0] == "1"
            gen = d.get("generated")
            if gen == "report":
                data, mime, ext = self.render_conclusion(deal, ctx.user, "pdf" if _has_reportlab() else "html")
                return ctx.raw(data, mime, f"zaklyuchenie.{ext}", inline)
            if gen == "equipment":
                return ctx.raw(report.equipment_xlsx(deal), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "equipment.xlsx", inline)
            if gen == "telemetry":
                return ctx.raw(report.telemetry_csv(deal), "text/csv; charset=utf-8", "telemetry.csv", inline)
            p = (DATA_DIR / "docs" / d["file"]).resolve()
            if not str(p).startswith(str((DATA_DIR / "docs").resolve())) or not p.exists():
                raise ApiError("Файл не найден", 404)
            return ctx.raw(p.read_bytes(), mimetypes.guess_type(p.name)[0] or "application/octet-stream", d["name"] + "." + d.get("ext", ""), inline)

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/export", perm="export")
        def export(ctx, id):
            deal = self.deal(id, allow_draft=False)
            b = ctx.json()
            fmt = b.get("format", "pdf")
            if fmt not in ("pdf", "docx"):
                raise ApiError("Формат: PDF или Word", 422)
            secs = [s for s in b.get("sections", docs.SECTION_KEYS) if s in docs.SECTION_KEYS]
            try:
                data, mime, ext = self.render_conclusion(deal, ctx.user, fmt, secs)
            except ImportError:
                raise ApiError("Не удалось сформировать заключение: на сервере не установлена библиотека " +
                               ("reportlab (pip install reportlab)" if fmt == "pdf" else "python-docx (pip install python-docx)"), 500)
            except Exception as e:
                raise ApiError("Не удалось сформировать заключение. Попробуйте ещё раз", 500, detail=str(e))
            name = f"Заключение об оценке залога от {ts_to_date(time.time())}"
            doc_id = self.store_doc(id, name, "conclusion", ctx.user["short"], ext, data)
            st.save()
            return dict(doc_id=doc_id, name=name, ext=ext, url=f"/api/deals/{id}/documents/{doc_id}")

        # --- рынок ---
        @r("GET", "/api/market", perm="view")
        def market_get(ctx):
            self.ensure_market_fresh()
            return market.market_table(self.db.get("market"))

        # --- уведомления ---
        @r("GET", "/api/notifications", perm="view")
        def notifs(ctx):
            self.finalize_calcs()
            out = sorted(self.visible_notes(ctx.user), key=lambda n: -n["ts"])
            return [alerts.view(self.db, n, ctx.user) for n in out]

        @r("GET", "/api/staff", perm="view")
        def staff(ctx):
            return [dict(email=u["email"], name=u["short"], role=users.ROLES[u["role"]]) for u in self.db["users"] if u["role"] != "leasing"]

        @r("POST", r"/api/notifications/(?P<id>\w+)/decide", perm="view")
        def decide(ctx, id):
            b = ctx.json()
            try:
                res = alerts.apply_decision(self.db, id, b.get("action"), b.get("payload") or {}, ctx.user, b.get("request_id"))
            except LookupError as e:
                raise ApiError(str(e), 404)
            except PermissionError as e:
                raise ApiError(str(e), 403, code="forbidden")
            except alerts.ConflictError as e:
                raise ApiError(str(e), 409, notification=alerts.view(self.db, e.notification, ctx.user))
            except ValueError as e:
                raise ApiError(str(e), 422)
            except RuntimeError as e:
                raise ApiError(str(e), 502)
            res["pending"] = self.pending_count(ctx.user)
            st.save()
            return res

        # --- настройки ---
        @r("GET", "/api/settings", perm="view")
        def settings_get(ctx):
            return self.settings_payload(ctx.user)

        @r("POST", "/api/settings/notify", perm="own_notify_settings")
        def settings_notify(ctx):
            b = ctx.json()
            valid = {k for k, _, _ in users.NOTIFY_TYPES}
            prefs = ctx.user.setdefault("notify", {})
            for k, v in (b.get("notify") or {}).items():
                if k in valid:
                    prefs[k] = dict(app=bool(v.get("app")), email=bool(v.get("email")))
            st.save()
            return self.settings_payload(ctx.user)

        @r("POST", "/api/settings/thresholds", perm="edit_thresholds")
        def settings_th(ctx):
            b = ctx.json()
            try:
                cov, near = float(b["covenant"]), float(b["near"])
                warn, notify = float(b["offline_warn_h"]), float(b["offline_notify_h"])
            except (KeyError, ValueError):
                raise ApiError("Проверьте значения порогов", 422)
            if not 1.0 <= cov <= 2.0 or not cov < near <= 3.0:
                raise ApiError("Ковенант от 1,00 до 2,00, а порог «близко» выше ковенанта", 422)
            if not 0 < warn < notify <= 720:
                raise ApiError("«Предупредить» должно быть раньше, чем «уведомить»", 422)
            engine.TH.update(covenant=cov, near=near, offline_warn_h=warn, offline_notify_h=notify)
            self.db["settings"]["thresholds"] = dict(engine.TH)
            st.save()
            return self.settings_payload(ctx.user)

        @r("POST", "/api/settings/ai", perm="ai_settings")
        def settings_ai(ctx):
            b = ctx.json()
            a = self.db["settings"]["ai"]
            for k in ("base_url", "model"):
                if isinstance(b.get(k), str) and b[k].strip():
                    a[k] = b[k].strip()
            if "enabled" in b:
                a["enabled"] = bool(b["enabled"])
            if isinstance(b.get("api_key"), str) and b["api_key"].strip():
                a["api_key"] = b["api_key"].strip()
            if b.get("clear_key"):
                a["api_key"] = ""
            if "interval_min" in b:
                a["interval_min"] = max(1, min(1440, int(b["interval_min"])))
            if "simulate" in b:
                self.db["settings"]["simulate"] = bool(b["simulate"])
            st.save()
            return self.settings_payload(ctx.user)

        @r("POST", "/api/ai/test", perm="ai_settings")
        def ai_test(ctx):
            c = self.cfg()
            if not (c["api_key"] or "localhost" in c["base_url"] or "127.0.0.1" in c["base_url"]):
                raise ApiError("Не указан API-ключ", 422)
            try:
                reply = ai.chat(c, [dict(role="user", content="Ответь одним словом: работает")], timeout=30)
            except Exception as e:
                raise ApiError(str(e), 502)
            return dict(ok=True, reply=reply[:200], model=c["model"])

        @r("POST", "/api/ai/models", perm="ai_settings")
        def ai_models(ctx):
            try:
                return dict(models=ai.list_models(self.cfg()))
            except Exception as e:
                raise ApiError(str(e), 502)

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/ai-analyze", perm="view")
        def ai_analyze(ctx, id):
            deal = self.deal(id, allow_draft=False)
            rep = ai.analyze(deal, engine.deal_detail(deal, time.time()), self.cfg())
            self.db["ai_reports"][id] = rep
            st.save()
            return rep

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/ai-chat", perm="view")
        def ai_chat(ctx, id):
            deal = self.deal(id, allow_draft=False)
            q = str(ctx.json().get("question", "")).strip()[:2000]
            if not q:
                raise ApiError("Введите вопрос")
            try:
                return dict(answer=ai.ask(deal, engine.deal_detail(deal, time.time()), self.cfg(), q))
            except Exception as e:
                raise ApiError(str(e), 502)

        @r("POST", r"/api/deals/(?P<id>[\w-]+)/incident", perm="reassess")
        def incident(ctx, id):
            """Демо: смоделировать инцидент на серверах, чтобы показать реакцию мониторинга."""
            deal = self.deal(id, allow_draft=False)
            kind = ctx.json().get("type")
            srv = deal["servers"][-1]
            if kind == "overheat":
                for g in srv["gpus"][:3]:
                    g.update(temp=91, hot=True)
            elif kind == "swap":
                srv["gpus"][-1]["actual_serial"] = "1654029999" + secrets.token_hex(2)[:3].replace("a", "1")
            elif kind == "offline":
                srv.update(frozen=True, last_seen=time.time() - 26 * 3600)
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
            alerts.sync(self.db, deal)
            st.save()
            return dict(ok=True)

        @r("POST", "/api/agent/ingest", public=True)
        def ingest(ctx):
            b = ctx.json()
            key = str(b.get("key") or b.get("token") or "")
            deal = next((d for d in self.db["deals"].values() if secrets.compare_digest(d["agent_token"], key) or secrets.compare_digest(d.get("agent_key", ""), key)), None)
            if not deal:
                raise ApiError("Неверный ключ агента", 401)
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
                    self.db["events"].append(dict(ts=now, deal=deal["id"], server=srv["name"], gpu=idx, event="hours_reset", old=g["hours"], new=hours))
                g.update(actual_serial=str(rep.get("serial", "")) or None, temp=rep.get("temperature"), util=rep.get("utilization"))
                if hours is not None:
                    g["hours"] = hours
            srv["last_seen"] = now
            srv.pop("frozen", None)
            if deal["telemetry_mode"] != "agent":
                deal["telemetry_mode"], deal["simulated"] = "agent", False
            if deal["status"] == "active":
                alerts.sync(self.db, deal, now)
            st.save()
            return dict(ok=True)

    # ----- вспомогательные -----
    def render_conclusion(self, deal, user, fmt, sections=None):
        now = time.time()
        detail = engine.deal_detail(deal, now)
        doc = docs.build(deal, detail, engine.servers_view(deal, now), self.db["ai_reports"].get(deal["id"]), user["short"], sections)
        return docs.render(doc, fmt)

    def store_doc(self, deal_id, name, typ, author, ext, data, comment=""):
        did = secrets.token_hex(5)
        safe = re.sub(r"[^\w.\-]+", "_", name)[:60] or "document"
        path = DATA_DIR / "docs" / deal_id
        path.mkdir(parents=True, exist_ok=True)
        (path / f"{did}_{safe}.{ext}").write_bytes(data)
        self.db["documents"].setdefault(deal_id, []).append(dict(id=did, name=name, type=typ, date=ts_to_date(time.time()), ts=time.time(), author=author,
                                                                  ext=ext, file=f"{deal_id}/{did}_{safe}.{ext}", comment=comment))
        return did

    def save_snapshot_doc(self, deal, prev, author):
        """Предыдущая оценка сохраняется копией в «Документах» (ТЗ, C05/C06)."""
        try:
            detail = engine.deal_detail(deal, time.time())
            doc = docs.build(deal, detail, engine.servers_view(deal, time.time()), None, author)
            doc["meta"] = f"Оценка от {ts_to_date(prev['ts'])}, рыночная стоимость {fmt_rub(prev['market'])}"
            data, _, ext = docs.render(doc, "pdf" if _has_reportlab() else "html")
            self.store_doc(deal["id"], f"Заключение об оценке залога от {ts_to_date(prev['ts'])}", "conclusion", prev.get("author", author), ext, data)
        except Exception:
            pass


def _has_reportlab():
    try:
        import reportlab  # noqa: F401
        return True
    except ImportError:
        return False


def _agent_key():
    al = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    return "CC-" + "".join(secrets.choice(al) for _ in range(4)) + "-" + "".join(secrets.choice(al) for _ in range(4))


class Ctx:
    def __init__(self, h: BaseHTTPRequestHandler, query):
        self.h, self.query = h, query
        self.headers, self.set_cookie, self.clear_cookie = h.headers, None, False
        c = SimpleCookie(h.headers.get("Cookie", ""))
        self.token = c["cc_session"].value if "cc_session" in c else None
        self.user, self.expired = None, False
        self._body = None

    def body(self) -> bytes:
        if self._body is None:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_UPLOAD:
                raise ApiError("Файл слишком большой", 413)
            self._body = self.h.rfile.read(n) if n else b""
        return self._body

    def json(self) -> dict:
        try:
            v = json.loads(self.body() or b"{}")
            return v if isinstance(v, dict) else {}
        except json.JSONDecodeError:
            raise ApiError("Некорректный JSON")

    def raw(self, data: bytes, ctype: str, filename: str | None = None, inline: bool = False):
        return RawResponse(data, ctype, filename, inline)


class RawResponse:
    def __init__(self, data, ctype, filename, inline=False):
        self.data, self.ctype, self.filename, self.inline = data, ctype, filename, inline


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "ComputeCollateral/0.2"

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
                    ctx.user, ctx.expired = app.store.user_for(ctx.token)
                    for m, rx, fn, public, perm in app.routes:
                        mt = rx.match(url.path)
                        if m == method and mt:
                            if not public and not ctx.user:
                                raise ApiError("Сессия завершена" if ctx.expired else "Требуется вход", 401, code="session_expired" if ctx.expired else "auth")
                            if perm and not users.can(ctx.user, perm):
                                raise ApiError("Нет доступа к этому действию", 403, code="forbidden")
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
                        disp = "inline" if res.inline else "attachment"
                        extra.append(("Content-Disposition", f"{disp}; filename*=UTF-8''{quote(res.filename)}"))
                    return self._send(200, res.data, res.ctype, extra)
                self._send(200, json.dumps(res, ensure_ascii=False).encode(), "application/json; charset=utf-8", extra)
            except ApiError as e:
                self._send(e.code, json.dumps(dict(error=str(e), **e.extra), ensure_ascii=False).encode(), "application/json; charset=utf-8")
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
    srv = ThreadingHTTPServer((host, port), make_handler(app))
    srv.app = app
    return srv

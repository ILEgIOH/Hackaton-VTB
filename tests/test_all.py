import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request
from datetime import date, timedelta
from http.cookiejar import CookieJar
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from compute_collateral import ai, alerts, docs, engine, market, parsers, seed, users  # noqa: E402
from compute_collateral.server import create_server  # noqa: E402
from compute_collateral.store import Store  # noqa: E402


def make_deal(n=32, hours=6363, temp=66, util=89, model="H100", mode="agent", last_seen=None):
    last_seen = last_seen if last_seen is not None else time.time()
    gpus = [dict(idx=i % 8, serial=str(1000000000000 + i), actual_serial=str(1000000000000 + i), temp=temp, util=util, hours=hours,
                 commissioned="2025-02-12") for i in range(n)]
    servers = [dict(name=f"srv-{k + 1:02d}", model=model, gpus=gpus[k * 8:(k + 1) * 8], last_seen=last_seen) for k in range(n // 8)]
    return dict(id="t", borrower="T", location="L", servers=servers, telemetry_mode=mode, status="active", agent_token="x",
                loan=dict(amount=60e6, term=36, rate=18, schedule="annuity", issue_date="2026-10-15", covenant=1.25))


class Engine(unittest.TestCase):
    def setUp(self):
        engine.TH.update(covenant=1.25, near=1.40, offline_warn_h=1.0, offline_notify_h=24.0)
        market.apply_state(None)

    def test_schedule(self):
        s = engine.schedule(60e6, 36, 18)
        self.assertEqual(len(s), 37)
        self.assertEqual(s[-1], 0)
        self.assertTrue(all(a > b for a, b in zip(s, s[1:])))
        self.assertAlmostEqual(engine.schedule(12e6, 12, 10, "differentiated")[6], 6e6)

    def test_valuation_matches_spec(self):
        v = engine.valuation(make_deal())
        self.assertAlmostEqual(v["cost"] / 1e6, 102.1, delta=0.2)
        self.assertAlmostEqual(v["income"] / 1e6, 91.6, delta=0.5)         # ТЗ: 91,6
        self.assertAlmostEqual(v["market"] / 1e6, 94.0, delta=0.5)         # ТЗ: 94,0
        self.assertAlmostEqual(v["liquidation"] / v["market"], 0.72, places=3)

    def test_ltv_market_and_liquidation_basis(self):
        d = make_deal()
        v = engine.valuation(d)
        fc = engine.forecast(d, today=date(2026, 10, 8), val=v)
        self.assertAlmostEqual(engine.recommend_ltv(fc, v["market"])["ltv"], 0.524, delta=0.005)                    # ТЗ C01: 52,4 %
        self.assertAlmostEqual(engine.recommend_ltv(fc, v["market"], "pess", "liquidation")["ltv"], 0.377, delta=0.005)  # ТЗ C04: 37,7 %

    def test_ltv_cap_75(self):
        d = make_deal()
        d["loan"]["amount"] = 5e6
        v = engine.valuation(d)
        r = engine.recommend_ltv(engine.forecast(d, today=date(2026, 10, 8), val=v), v["market"])
        self.assertLessEqual(r["ltv"], 0.75 + 1e-9)

    def test_status_thresholds_spec(self):
        self.assertEqual(engine.status_of(1.06, 1.25), "breach")
        self.assertEqual(engine.status_of(1.32, 1.25), "near")
        self.assertEqual(engine.status_of(1.41, 1.25), "ok")
        self.assertEqual(engine.status_of(1.25, 1.25), "near")

    def test_silent_server_gets_7_percent(self):
        d = make_deal(last_seen=time.time() - 26 * 3600)
        self.assertEqual(engine.valuation(d)["wear"], 0.07)
        self.assertFalse(engine.is_online(d["servers"][0], time.time()))
        ok = make_deal(last_seen=time.time() - 30 * 60)
        self.assertTrue(engine.is_online(ok["servers"][0], time.time()))
        self.assertLess(engine.valuation(ok)["wear"], 0.04)

    def test_no_telemetry_haircut(self):
        self.assertEqual(engine.valuation(make_deal(mode="none"))["wear"], 0.07)

    def test_low_data_weights(self):
        d = make_deal(16, model="H200")
        v = engine.valuation(d)
        self.assertEqual(v["low_data"], ["H200"])
        exp = 0.4 * v["cost"] + 0.25 * v["comparative"] + 0.35 * v["income"]
        self.assertAlmostEqual(v["weighted"], exp, delta=1)

    def test_gap_in_12_months_only(self):
        d = make_deal()
        det = engine.deal_detail(d, time.time(), today=date(2026, 10, 8))
        self.assertIsNotNone(det["gap"])
        self.assertTrue(det["gap12"] is None or det["gap12"]["first_month"] <= 12)

    def test_swap_detection(self):
        d = make_deal()
        d["servers"][0]["gpus"][2]["actual_serial"] = "666"
        self.assertEqual(engine.equipment_state(d, time.time())["code"], "swap")

    def test_market_daily_refresh_changes_prices(self):
        import random
        st = dict(factors={k: 1.0 for k in market.MODELS}, updated="2026-10-01")
        before = market.MODELS["H100"]["median"]
        market.refresh_prices(st, random.Random(1))
        self.assertNotEqual(market.MODELS["H100"]["median"], before)
        market.apply_state(None)
        self.assertEqual(market.MODELS["H100"]["median"], before)


class Parsers(unittest.TestCase):
    def test_ok(self):
        r = parsers.parse_equipment("e.csv", parsers.TEMPLATE_CSV.encode("utf-8-sig"))
        self.assertEqual((r["cards"], r["errors"], r["count_servers"]), (3, 0, 2))

    def test_row_errors_match_spec_messages(self):
        data = ("Сервер;Модель;Серийный номер;Дата ввода\nsrv-01;H100 SXM 80 ГБ;1654023118421;12.02.2025\n"
                "srv-02;RTX 4090;2330417702211;03.06.2025\nsrv-03;H100 SXM 80 ГБ;1654023118421;03.06.2025\n"
                "srv-04;H100 SXM 80 ГБ;1654023119560;12.03.2099\nsrv-05;H100;123;01.01.2025\n")
        r = parsers.parse_equipment("e.csv", data.encode())
        errs = [x["error"] for x in r["rows"]]
        self.assertIsNone(errs[0])
        self.assertEqual(errs[1], "Модель не поддерживается: только H100, H200, A100, L40S")
        self.assertEqual(errs[2], "Серийный номер повторяется, см. строку 2")
        self.assertEqual(errs[3], "Дата ввода позже сегодняшней")
        self.assertEqual(errs[4], "Серийный номер: 13 цифр")
        self.assertEqual(r["errors"], 4)
        self.assertEqual(r["cards"], 1)          # в серверы попали только корректные строки

    def test_file_level_errors(self):
        for name, data in (("a.csv", b"a;b\n1;2\n"), ("a.csv", b""), ("a.pdf", b"x")):
            with self.assertRaises(parsers.FileError):
                parsers.parse_equipment(name, data)
        with self.assertRaises(parsers.FileError) as c:
            parsers.parse_equipment("a.csv", b"\xd0\xa1\xd0\xb5\xd1\x80\xd0\xb2\xd0\xb5\xd1\x80;\xd0\x9c\xd0\xbe\xd0\xb4\xd0\xb5\xd0\xbb\xd1\x8c\n1;2\n")
        self.assertIn("Серийный номер", str(c.exception))

    def test_row_limit_and_size(self):
        big = "Сервер;Модель;Серийный номер;Дата ввода\n" + "".join(f"s;H100;{1000000000000 + i};01.01.2025\n" for i in range(1001))
        with self.assertRaises(parsers.FileError):
            parsers.parse_equipment("a.csv", big.encode())
        with self.assertRaises(parsers.FileError):
            parsers.parse_equipment("a.csv", b"x" * (10 * 1024 * 1024 + 1))

    def test_xlsx_template_and_roundtrip(self):
        from compute_collateral.report import equipment_xlsx
        r = parsers.parse_equipment("x.xlsx", equipment_xlsx(make_deal(16)))
        self.assertEqual(r["cards"], 16)
        self.assertTrue(parsers.template_xlsx().startswith(b"PK"))

    def test_inn(self):
        self.assertTrue(parsers.inn_valid(parsers.make_inn("770123456")))
        self.assertFalse(parsers.inn_valid("7701234567"))
        self.assertFalse(parsers.inn_valid("12345"))
        errs = parsers.validate_borrower(dict(name="a", inn="1", application="x", location="", contact="", contact_email="bad"))
        self.assertEqual(set(errs), {"name", "inn", "application", "location", "contact", "contact_email"})

    def test_smi(self):
        rows = parsers.parse_smi("s.csv", b"index, serial, name, temperature.gpu, utilization.gpu [%]\n0, 1654023118421, H100, 64, 87 %\n")
        self.assertEqual((rows[0]["serial"], rows[0]["temp"], rows[0]["util"]), ("1654023118421", 64, 87))


class Docs(unittest.TestCase):
    def test_pdf_docx_html(self):
        d = make_deal()
        det = engine.deal_detail(d, time.time())
        doc = docs.build(d, det, engine.servers_view(d, time.time()), None, "Е. Соколова")
        pdf, _, ext = docs.render(doc, "pdf")
        self.assertTrue(pdf.startswith(b"%PDF") and ext == "pdf")
        dx, _, _ = docs.render(doc, "docx")
        self.assertTrue(dx.startswith(b"PK"))
        self.assertIn("Заключение об оценке залога", docs.to_html(doc))

    def test_sections_are_optional(self):
        d = make_deal()
        det = engine.deal_detail(d, time.time())
        full = docs.to_html(docs.build(d, det, [], None, "x"))
        part = docs.to_html(docs.build(d, det, [], None, "x", sections=["valuation"]))
        self.assertIn("График погашения", full)
        self.assertNotIn("График погашения", part)
        self.assertNotIn("Прогноз покрытия", part)


class AI(unittest.TestCase):
    def test_extract_json_fenced(self):
        self.assertEqual(ai.extract_json('```json\n{"risk":"low"}\n```')["risk"], "low")

    def test_rules_find_overheat_and_impossible_hours(self):
        d = make_deal()
        d["servers"][0]["gpus"][0].update(temp=90, hours=999999)
        rep = ai.rules_report(d, engine.deal_detail(d, time.time()), time.time())
        titles = " ".join(f["title"] for f in rep["findings"])
        self.assertIn("перегрев", titles.lower())
        self.assertIn("Наработка больше возраста", titles)
        self.assertEqual(rep["risk"], "high")

    def test_claude_provider_uses_sdk(self):
        from unittest import mock
        import types
        cfg = dict(enabled=True, base_url="https://api.anthropic.com", api_key="k", model="claude-opus-5-5")
        self.assertTrue(ai.is_anthropic(cfg))
        fake = types.SimpleNamespace(content=[types.SimpleNamespace(type="text", text="ok")], stop_reason="end_turn")
        client = mock.Mock()
        client.messages.create.return_value = fake
        with mock.patch.object(ai, "_claude_client", return_value=(mock.Mock(), client)):
            out = ai.chat(cfg, [dict(role="system", content="S"), dict(role="user", content="hi")])
        self.assertEqual(out, "ok")
        kw = client.messages.create.call_args.kwargs
        self.assertEqual(kw["system"], "S")
        self.assertEqual(kw["messages"], [dict(role="user", content="hi")])
        self.assertNotIn("temperature", kw)

    def test_ai_failure_falls_back_to_rules(self):
        d = make_deal()
        rep = ai.analyze(d, engine.deal_detail(d, time.time()), dict(enabled=True, base_url="http://127.0.0.1:1/v1", api_key="k", model="m"))
        self.assertEqual(rep["source"], "rules")
        self.assertIn("ai_error", rep)

    def test_ai_response_cannot_lower_risk(self):
        d = make_deal()
        d["servers"][0]["gpus"][0]["actual_serial"] = "666"
        orig = ai.chat
        ai.chat = lambda *a, **k: '{"risk":"low","summary":"всё хорошо","findings":[],"recommendations":[]}'
        try:
            rep = ai.analyze(d, engine.deal_detail(d, time.time()), dict(enabled=True, base_url="x", api_key="k", model="m"))
        finally:
            ai.chat = orig
        self.assertEqual((rep["source"], rep["risk"]), ("ai", "high"))

    def test_http_roundtrip_and_models(self):
        from http.server import BaseHTTPRequestHandler, HTTPServer
        seen = {}

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def _ok(self, obj):
                out = json.dumps(obj).encode()
                self.send_response(200); self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)

            def do_GET(self):
                seen["models_auth"] = self.headers.get("Authorization")
                self._ok(dict(data=[dict(id="m-b"), dict(id="m-a")]))

            def do_POST(self):
                seen.update(auth=self.headers.get("Authorization"), path=self.path, body=json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                c = json.dumps(dict(risk="medium", summary="Проверка ИИ", findings=[dict(severity="warning", title="Тест", detail="d", server="srv-01", gpu=0)], recommendations=["Проверить охлаждение"]))
                self._ok(dict(choices=[dict(message=dict(content="```json\n" + c + "\n```"))]))

        srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            cfg = dict(enabled=True, base_url=f"http://127.0.0.1:{srv.server_address[1]}/v1", api_key="sk-test", model="m1")
            d = make_deal()
            rep = ai.analyze(d, engine.deal_detail(d, time.time()), cfg)
            models = ai.list_models(cfg)
        finally:
            srv.shutdown()
        self.assertEqual((rep["source"], rep["summary"]), ("ai", "Проверка ИИ"))
        self.assertEqual((seen["path"], seen["auth"], seen["body"]["model"]), ("/v1/chat/completions", "Bearer sk-test", "m1"))
        self.assertIn("srv-01", seen["body"]["messages"][1]["content"])
        self.assertEqual(models, ["m-a", "m-b"])


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        import compute_collateral.server as srvmod
        import compute_collateral.store as stmod
        stmod.DATA_DIR = srvmod.DATA_DIR = Path(cls.tmp.name)
        store = Store(Path(cls.tmp.name) / "db.json")
        seed.seed(store)
        cls.store = store
        cls.srv = create_server(store, "127.0.0.1", 0)
        cls.app = cls.srv.app
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.ops = {}

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.tmp.cleanup()

    def opener(self, who):
        if who not in self.ops:
            self.ops[who] = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
        return self.ops[who]

    def call(self, path, body=None, headers=None, raw=False, who="analyst"):
        data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api{path}", data=data, headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with self.opener(who).open(req) as r:
                out = r.read()
                return out if raw else json.loads(out)
        except urllib.error.HTTPError as e:
            return dict(json.loads(e.read()), code=e.code)

    EMAILS = dict(analyst="e.sokolova@bank.ru", risk="a.kim@bank.ru", collateral="m.orlova@bank.ru", leasing="leasing@bank.ru")

    def login(self, who="analyst"):
        r = self.call("/login", dict(email=self.EMAILS[who], password=seed.DEMO_PASSWORD), who=who)
        self.assertIn("name", r)
        return r

    # --- вход ---
    def test_01_login_rules(self):
        self.assertEqual(self.call("/portfolio", who="anon")["code"], 401)
        self.assertEqual(self.call("/login", dict(email="x@gmail.com", password="y"), who="anon")["code"], 400)   # только домен банка
        r1 = self.call("/login", dict(email="a.kim@bank.ru", password="bad"), who="lock")
        self.assertEqual((r1["code"], r1["attempts_left"]), (401, 2))
        self.call("/login", dict(email="a.kim@bank.ru", password="bad"), who="lock")
        r3 = self.call("/login", dict(email="a.kim@bank.ru", password="bad"), who="lock")
        self.assertEqual(r3["code"], 423)
        self.assertEqual(self.call("/login", dict(email="a.kim@bank.ru", password=seed.DEMO_PASSWORD), who="lock")["code"], 423)   # даже верный пароль закрыт
        self.store.failures.clear()

    def test_02_session_expires_after_30_min(self):
        self.login("collateral")
        tok = next(t for t, s in self.store.sessions.items() if s["email"] == self.EMAILS["collateral"])
        self.store.sessions[tok]["last"] -= 31 * 60
        r = self.call("/portfolio", who="collateral")
        self.assertEqual(r["code"], 401)
        self.assertEqual(r["error"], "Сессия завершена")

    def test_03_password_reset_does_not_leak(self):
        a = self.call("/password-reset", dict(email="e.sokolova@bank.ru"), who="anon")
        b = self.call("/password-reset", dict(email="nobody@bank.ru"), who="anon")
        self.assertEqual(a, b)
        tok = list(self.store.db["resets"])[-1]
        self.assertEqual(self.call("/password-reset/confirm", dict(token=tok, password="short"), who="anon")["code"], 422)
        self.assertTrue(self.call("/password-reset/confirm", dict(token=tok, password="NewPassword9"), who="anon")["ok"])
        self.assertTrue(self.call("/login", dict(email="e.sokolova@bank.ru", password="NewPassword9"), who="anon").get("name"))
        # вернуть демо-пароль
        u = next(x for x in self.store.db["users"] if x["email"] == "e.sokolova@bank.ru")
        from compute_collateral.store import hash_password
        u["password"] = hash_password(seed.DEMO_PASSWORD)

    # --- роли ---
    def test_04_roles_enforced_server_side(self):
        for w in ("analyst", "risk", "collateral", "leasing"):
            self.login(w)
        self.assertEqual(self.call("/draft", who="risk")["code"], 403)                  # новая оценка — только аналитик
        self.assertEqual(self.call("/deals/neurocluster/terms", dict(amount=5e7, term=36, rate=18), who="collateral")["code"], 403)
        self.assertEqual(self.call("/deals/neurocluster/reassess", {}, who="risk")["code"], 403)
        self.assertEqual(self.call("/deals/neurocluster/reassess", {}, who="leasing")["code"], 403)
        self.assertEqual(self.call("/deals/neurocluster/documents", b"x", {"X-Filename": "a.pdf", "X-Doc-Type": "act", "Content-Type": "application/octet-stream"}, who="risk")["code"], 403)
        self.assertEqual(self.call("/settings/thresholds", dict(covenant=1.3, near=1.5, offline_warn_h=1, offline_notify_h=24), who="analyst")["code"], 403)
        self.assertTrue(self.call("/deals/neurocluster", who="leasing")["id"])         # смотреть могут все
        self.assertEqual(self.call("/deals/neurocluster/export", dict(format="pdf"), who="leasing").get("ext"), "pdf")

    def test_05_decision_permissions_by_kind(self):
        notes = self.call("/notifications", who="analyst")
        swap = next(n for n in notes if n["kind"] == "swap" and n["status"] in ("new", "in_work"))
        self.assertEqual(swap["actions"], [])                                          # у аналитика нет кнопок на «Подмену»
        r = self.call(f"/notifications/{swap['id']}/decide", dict(action="inspect", payload=dict(date=(date.today() + timedelta(1)).isoformat(), responsible="m.orlova@bank.ru")), who="analyst")
        self.assertEqual(r["code"], 403)
        lz = self.call("/notifications", who="leasing")
        self.assertTrue(all(n["actions"] == [] for n in lz))                           # ВТБ Лизинг — только чтение

    # --- портфель и сделка ---
    def test_06_portfolio_and_search(self):
        self.login()
        p = self.call("/portfolio")
        self.assertEqual((len(p["rows"]), p["counts"]["breach"], p["counts"]["near"]), (6, 1, 2))
        self.assertEqual(p["pending"], 3)
        s = self.call("/search?q=1654023118")
        self.assertTrue(all(i["type"] in ("card", "company") for i in s["items"]))
        self.assertEqual(self.call("/search?q=16")["items"], [])                        # меньше 3 символов — пусто
        self.assertEqual(self.call("/search?q=" + urllib.parse.quote("Нейрокластер"))["items"][0]["type"], "company")

    def test_07_whatif_validation_and_terms_saved(self):
        self.login()
        w = self.call("/deals/neurocluster/whatif", dict(amount=40e6, term=36, rate=18, scenario="pess"))
        self.assertFalse(w["recommendation"]["exceeds"])
        liq = self.call("/deals/neurocluster/whatif", dict(amount=60e6, term=36, rate=18, scenario="pess", basis="liquidation"))
        self.assertAlmostEqual(liq["recommendation"]["ltv"], 0.377, delta=0.006)
        bad = self.call("/deals/neurocluster/whatif", dict(amount=600e6, term=3, rate=50))
        self.assertEqual(bad["code"], 422)
        self.assertEqual(set(bad["fields"]), {"amount", "term", "rate"})
        self.assertEqual(self.call("/deals/neurocluster/terms", dict(amount=45e6, term=36, rate=18))["loan"]["amount"], 45e6)
        self.call("/deals/neurocluster/terms", dict(amount=60e6, term=36, rate=18))

    # --- мастер ---
    def test_08_wizard_full_flow(self):
        self.login()
        csv = ("Сервер;Модель;Серийный номер;Дата ввода\n" + "".join(f"srv-01;H100 SXM 80 ГБ;{1700000000000 + i};12.02.2025\n" for i in range(8))
               + "srv-02;RTX 4090;1700000000099;12.02.2025\n").encode()
        eq = self.call("/parse-equipment", csv, {"X-Filename": "t.csv", "Content-Type": "application/octet-stream"})
        self.assertEqual((eq["errors"], eq["cards"]), (1, 8))
        inn = parsers.make_inn("500100732")
        base = dict(name="ООО «Тест»", inn=inn, application="КД-2026-0999", location="ЦОД, Казань", contact="Иван", contact_email="i@test.example", servers=eq["servers"])
        self.assertEqual(self.call("/deals", dict(base, inn="123"))["code"], 422)
        dup = self.call("/deals", dict(base, inn=self.store.db["deals"]["neurocluster"]["inn"]))
        self.assertEqual((dup["code"], dup["existing"]["id"]), (409, "neurocluster"))
        c = self.call("/deals", base)
        did = c["id"]
        self.assertTrue(c["agent_key"].startswith("CC-"))
        self.assertEqual(self.call("/draft")["draft"]["id"], did)
        self.assertEqual(len(self.call("/portfolio")["rows"]), 6)                      # черновик не в портфеле
        self.assertTrue(self.call("/agent/ingest", dict(key=c["agent_key"], server="srv-01", gpus=[dict(index=0, serial="1700000000000", temperature=65, utilization=88, hours=6000)]), who="anon")["ok"])
        self.assertEqual(self.call("/agent/ingest", dict(key="CC-XXXX-YYYY", server="srv-01", gpus=[]), who="anon")["code"], 401)
        self.assertEqual(self.call(f"/deals/{did}/invite-cod", {})["to"], "i@test.example")
        bad = self.call(f"/deals/{did}/loan", dict(amount=0, term=72, rate=18, issue_date="2020-01-01", covenant=3))
        self.assertEqual((bad["code"], set(bad["fields"])), (422, {"amount", "term", "issue_date", "covenant"}))
        ok = self.call(f"/deals/{did}/loan", dict(amount=5e6, term=24, rate=17, schedule="annuity", issue_date=date.today().isoformat(), covenant=1.25))
        self.assertEqual(ok["id"], did)
        self.assertFalse(self.call(f"/deals/{did}/calc")["done"])
        self.assertEqual(len(self.call("/portfolio")["rows"]), 6)                      # пока считается — не в портфеле
        self.store.db["deals"][did]["calc"]["started"] -= 60
        self.assertTrue(self.call(f"/deals/{did}/calc")["done"])
        self.assertEqual(len(self.call("/portfolio")["rows"]), 7)
        kinds = [n["kind"] for n in self.call("/notifications") if n["deal_id"] == did]
        self.assertIn("ready", kinds)                                                  # «Оценка готова»
        self.assertIn(self.call(f"/deals/{did}/documents")[0]["type"], ("conclusion", "data"))
        mails = [m for m in self.store.db["outbox"] if m["deal_id"] == did]
        self.assertTrue(any(m["kind"] == "invite" for m in mails))

    # --- переоценка и документы ---
    def test_09_reassess_keeps_previous_and_reports_change(self):
        self.login("collateral")
        before = len(self.call("/deals/neurocluster/documents", who="collateral"))
        r = self.call("/deals/neurocluster/reassess", {}, who="collateral")
        self.assertIn("change", r)
        self.assertEqual(set(r["change"]), {"prev", "now", "pct", "reason", "prev_date"})
        self.assertEqual(len(self.call("/deals/neurocluster/documents", who="collateral")), before + 1)   # предыдущая оценка в «Документах»
        self.assertGreaterEqual(len(self.store.db["deals"]["neurocluster"]["assessments"]), 2)

    def test_10_export_formats_and_documents(self):
        self.login()
        r = self.call("/deals/neurocluster/export", dict(format="docx", sections=["valuation"]))
        self.assertEqual(r["ext"], "docx")
        self.assertTrue(self.call(r["url"][4:], raw=True).startswith(b"PK"))
        self.assertEqual(self.call("/deals/neurocluster/export", dict(format="exe"))["code"], 422)
        up = self.call("/deals/neurocluster/documents", b"hello", {"X-Filename": "a%20b.pdf", "X-Doc-Type": "act", "X-Comment": "%D0%BE%D1%81%D0%BC%D0%BE%D1%82%D1%80", "Content-Type": "application/octet-stream"})
        self.assertTrue(up["ok"])
        self.assertEqual(self.call("/deals/neurocluster/documents", b"x", {"X-Filename": "a.exe", "X-Doc-Type": "act", "Content-Type": "application/octet-stream"})["code"], 422)
        docs_ = self.call("/deals/neurocluster/documents")
        mine = next(d for d in docs_ if d["type"] == "act")
        self.assertEqual(mine["comment"], "осмотр")
        self.assertEqual(self.call(f"/deals/neurocluster/documents/{mine['id']}", raw=True), b"hello")

    def test_11_write_cod_sends_mail(self):
        self.login()
        n = len(self.store.db["outbox"])
        r = self.call("/deals/neurocluster/write-cod", dict(subject="Тема", message="Текст"))
        self.assertEqual(r["to"], "a.morozov@neurocluster.example")
        self.assertEqual(len(self.store.db["outbox"]), n + 1)
        self.assertEqual(self.call("/deals/neurocluster/write-cod", dict(subject="", message=""))["code"], 422)

    # --- уведомления ---
    def test_12_decisions_conflict_and_idempotency(self):
        self.login("collateral"); self.login("risk")
        notes = self.call("/notifications", who="collateral")
        cov = next(n for n in notes if n["kind"] == "covenant" and n["status"] == "new")
        self.assertTrue(cov["can_decide"] and [a["id"] for a in cov["actions"]] == ["request", "reassess"])
        due = (date.today() + timedelta(10)).isoformat()
        bad = self.call(f"/notifications/{cov['id']}/decide", dict(action="request", payload=dict(amount=0, due=due)), who="collateral")
        self.assertEqual(bad["code"], 422)
        sent = len(self.store.db["outbox"])
        body = dict(action="request", payload=dict(amount=7200000, due=due, responsible="i.petrov@bank.ru", message="Просим обеспечение"), request_id="rq-1")
        r1 = self.call(f"/notifications/{cov['id']}/decide", body, who="collateral")
        self.assertEqual(r1["notification"]["status"], "decided")
        self.assertIn("Запрошено обеспечение 7,2 млн ₽", r1["notification"]["decision"]["text"])
        r2 = self.call(f"/notifications/{cov['id']}/decide", body, who="collateral")   # повтор после сбоя сети — без дубля письма
        self.assertEqual(r2["notification"]["id"], cov["id"])
        self.assertEqual(len(self.store.db["outbox"]), sent + 1)
        other = self.call(f"/notifications/{cov['id']}/decide", dict(action="reassess", payload={}, request_id="rq-2"), who="risk")   # «уже решено другим»
        self.assertEqual(other["code"], 409)
        self.assertEqual(other["notification"]["decision"]["by"], "М. Орлова")

    def test_13_watch_returns_after_date(self):
        self.login("analyst")
        n = next(x for x in self.call("/notifications") if x["kind"] == "forecast" and x["status"] == "new")
        r = self.call(f"/notifications/{n['id']}/decide", dict(action="watch", payload=dict(date=(date.today() + timedelta(5)).isoformat(), comment="ждём"), request_id="w1"))
        self.assertEqual(r["notification"]["status"], "watching")
        rec = next(x for x in self.store.db["notifications"] if x["id"] == n["id"])
        rec["wake_at"] = time.time() - 1
        alerts.sync(self.store.db, self.store.db["deals"][rec["deal_id"]])
        self.assertEqual(rec["status"], "new")

    def test_14_notification_prefs_and_thresholds(self):
        self.login("risk")
        self.call("/settings/notify", dict(notify=dict(link=dict(app=False, email=False))), who="risk")
        self.assertTrue(all(n["kind"] != "link" for n in self.call("/notifications", who="risk")))
        self.assertTrue(any(n["kind"] == "link" for n in self.call("/notifications", who="collateral")))
        bad = self.call("/settings/thresholds", dict(covenant=1.5, near=1.4, offline_warn_h=1, offline_notify_h=24), who="risk")
        self.assertEqual(bad["code"], 422)
        ok = self.call("/settings/thresholds", dict(covenant=1.25, near=1.40, offline_warn_h=2, offline_notify_h=24), who="risk")
        self.assertEqual(ok["thresholds"]["offline_warn_h"], 2)
        self.call("/settings/thresholds", dict(covenant=1.25, near=1.40, offline_warn_h=1, offline_notify_h=24), who="risk")

    def test_15_silent_24h_creates_link_alert(self):
        self.login()
        self.call("/deals/quantcloud/incident", dict(type="offline"))
        kinds = [(n["kind"], n["status"]) for n in self.call("/notifications") if n["deal_id"] == "quantcloud"]
        self.assertIn(("link", "new"), kinds)
        det = self.call("/deals/quantcloud")["detail"]
        self.assertEqual(det["equipment"]["code"], "offline")
        self.call("/deals/quantcloud/incident", dict(type="reset"))
        self.assertIn(("link", "closed"), [(n["kind"], n["status"]) for n in self.call("/notifications") if n["deal_id"] == "quantcloud"])

    def test_16_market_sources_and_settings_do_not_leak_key(self):
        self.login()
        m = self.call("/market")
        h200 = next(r for r in m["rows"] if r["key"] == "H200")
        self.assertTrue(h200["low_data"] and len(h200["sources"]["dealers"]) == 2)
        self.call("/settings/ai", dict(api_key="sk-secret", enabled=True))
        s = self.call("/settings")
        self.assertTrue(s["ai"]["has_key"])
        self.assertNotIn("sk-secret", json.dumps(s))
        self.call("/settings/ai", dict(clear_key=True, enabled=False))


if __name__ == "__main__":
    unittest.main()

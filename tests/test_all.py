import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from datetime import date
from http.cookiejar import CookieJar
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from compute_collateral import ai, alerts, engine, parsers, seed  # noqa: E402
from compute_collateral.server import create_server  # noqa: E402
from compute_collateral.store import Store  # noqa: E402


def make_deal(n=32, hours=6363, temp=66, util=89, model="H100", mode="agent"):
    gpus = [dict(idx=i % 8, serial=str(1000 + i), actual_serial=str(1000 + i), temp=temp, util=util, hours=hours,
                 commissioned="2025-02-12") for i in range(n)]
    servers = [dict(name=f"srv-{k + 1:02d}", model=model, gpus=gpus[k * 8:(k + 1) * 8], last_seen=time.time()) for k in range(n // 8)]
    return dict(id="t", borrower="T", location="L", servers=servers, telemetry_mode=mode, status="active", agent_token="x",
                loan=dict(amount=60e6, term=36, rate=18, schedule="annuity", issue_date="2026-10-15", covenant=1.25))


class Engine(unittest.TestCase):
    def test_schedule(self):
        s = engine.schedule(60e6, 36, 18)
        self.assertEqual(len(s), 37)
        self.assertAlmostEqual(s[0], 60e6)
        self.assertEqual(s[-1], 0)
        self.assertTrue(all(a > b for a, b in zip(s, s[1:])))
        d = engine.schedule(12e6, 12, 10, "differentiated")
        self.assertAlmostEqual(d[6], 6e6)

    def test_add_months_clamps_day(self):
        self.assertEqual(engine.add_months(date(2026, 1, 31), 1), date(2026, 2, 28))

    def test_valuation_matches_reference(self):
        v = engine.valuation(make_deal())
        self.assertAlmostEqual(v["cost"] / 1e6, 102.1, delta=0.2)
        self.assertAlmostEqual(v["market"] / 1e6, 94.0, delta=1.5)          # макет: 94,0 млн ₽
        self.assertAlmostEqual(v["liquidation"] / v["market"], 0.72, places=3)

    def test_no_telemetry_haircut(self):
        d = make_deal(mode="none")
        self.assertEqual(engine.valuation(d)["wear"], 0.07)

    def test_overheat_lowers_value(self):
        cool, hot = engine.valuation(make_deal(temp=60))["market"], engine.valuation(make_deal(temp=88))["market"]
        self.assertLess(hot, cool)

    def test_recommend_ltv_reference(self):
        d = make_deal()
        v = engine.valuation(d)
        fc = engine.forecast(d, today=date(2026, 10, 8), val=v)
        r = engine.recommend_ltv(fc, v["market"])
        self.assertAlmostEqual(r["ltv"], 0.524, delta=0.01)                 # макет: 52,4 %
        self.assertTrue(r["exceeds"])
        # при рекомендованной сумме разрыва в пессимистичном сценарии нет
        d["loan"]["amount"] = r["max_loan"] * 0.999
        fc2 = engine.forecast(d, today=date(2026, 10, 8), val=v)
        self.assertIsNone(engine.pessimistic_gap(fc2["points"]))

    def test_gap_and_scenario_order(self):
        d = make_deal()
        fc = engine.forecast(d, today=date(2026, 10, 8))
        self.assertIsNotNone(engine.pessimistic_gap(fc["points"]))
        for p in fc["points"][1:-1]:
            self.assertGreater(p["opt"], p["base"])
            self.assertGreater(p["base"], p["pess"])

    def test_status_thresholds(self):
        self.assertEqual(engine.status_of(1.06, 1.25), "breach")
        self.assertEqual(engine.status_of(1.32, 1.25), "near")
        self.assertEqual(engine.status_of(1.57, 1.25), "ok")

    def test_swap_detection(self):
        d = make_deal()
        d["servers"][0]["gpus"][2]["actual_serial"] = "666"
        self.assertEqual(len(engine.serial_mismatches(d)), 1)
        self.assertEqual(engine.equipment_state(d, time.time())["code"], "swap")


class Parsers(unittest.TestCase):
    def test_csv_ok(self):
        r = parsers.parse_equipment("e.csv", parsers.TEMPLATE_CSV.encode("utf-8-sig"))
        self.assertEqual(r["cards"], 3)
        self.assertEqual(r["count_servers"], 2)
        self.assertEqual(r["errors"], [])
        self.assertEqual(r["servers"][0]["model"], "H100")

    def test_csv_errors(self):
        data = "Сервер;Модель;Серийный номер;Дата ввода\nsrv-01;H100;1;01.01.2025\nsrv-01;H100;1;01.01.2025\nsrv-02;RTX 4090;2;01.01.2025\nsrv-03;A100;;01.01.2025\n"
        r = parsers.parse_equipment("e.csv", data.encode())
        self.assertEqual(len(r["errors"]), 3)

    def test_xlsx_roundtrip(self):
        from compute_collateral.report import equipment_xlsx
        r = parsers.parse_equipment("x.xlsx", equipment_xlsx(make_deal(16)))
        self.assertEqual(r["cards"], 16)

    def test_missing_columns(self):
        with self.assertRaises(ValueError):
            parsers.parse_equipment("e.csv", b"a;b\n1;2\n")

    def test_smi(self):
        rows = parsers.parse_smi("s.csv", b"index, serial, name, temperature.gpu, utilization.gpu [%]\n0, 1654023118421, H100, 64, 87 %\n")
        self.assertEqual(rows[0]["serial"], "1654023118421")
        self.assertEqual((rows[0]["temp"], rows[0]["util"]), (64, 87))


class AI(unittest.TestCase):
    def test_extract_json_fenced(self):
        self.assertEqual(ai.extract_json('```json\n{"risk":"low"}\n```')["risk"], "low")
        self.assertEqual(ai.extract_json('Вот ответ: {"risk":"high"} спасибо')["risk"], "high")

    def test_rules_find_overheat_and_impossible_hours(self):
        d = make_deal()
        d["servers"][0]["gpus"][0].update(temp=90, hours=999999)
        rep = ai.rules_report(d, engine.deal_detail(d, time.time()), time.time())
        titles = " ".join(f["title"] for f in rep["findings"])
        self.assertIn("перегрев", titles.lower())
        self.assertIn("Наработка больше возраста", titles)
        self.assertEqual(rep["risk"], "high")

    def test_ai_failure_falls_back_to_rules(self):
        d = make_deal()
        cfg = dict(enabled=True, base_url="http://127.0.0.1:1/v1", api_key="k", model="m")
        rep = ai.analyze(d, engine.deal_detail(d, time.time()), cfg)
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
        self.assertEqual(rep["source"], "ai")
        self.assertEqual(rep["risk"], "high")


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        store = Store(Path(cls.tmp.name) / "db.json")
        seed.seed(store)
        cls.store = store
        cls.srv = create_server(store, "127.0.0.1", 0)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.tmp.cleanup()

    def call(self, path, body=None, headers=None, raw=False, opener=None):
        data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api{path}", data=data, headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with (opener or self.op).open(req) as r:
                out = r.read()
                return out if raw else json.loads(out)
        except urllib.error.HTTPError as e:
            return dict(error=json.loads(e.read()).get("error"), code=e.code)

    def login(self):
        r = self.call("/login", dict(email=seed.DEMO_EMAIL, password=seed.DEMO_PASSWORD))
        self.assertIn("name", r)

    def test_1_auth_required(self):
        anon = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
        self.assertEqual(self.call("/portfolio", opener=anon)["code"], 401)
        self.assertEqual(self.call("/login", dict(email="x", password="y"), opener=anon)["code"], 401)

    def test_2_portfolio_and_deal(self):
        self.login()
        p = self.call("/portfolio")
        self.assertEqual(len(p["rows"]), 6)
        self.assertEqual(p["counts"]["breach"], 1)
        d = self.call("/deals/neurocluster")
        self.assertAlmostEqual(d["detail"]["recommendation"]["ltv"], 0.524, delta=0.01)
        w = self.call("/deals/neurocluster/whatif", dict(amount=40e6, term=36, rate=18, scenario="pess"))
        self.assertFalse(w["recommendation"]["exceeds"])
        self.assertEqual(self.call("/deals/neurocluster/whatif", dict(amount=-1, term=36, rate=18))["code"], 400)
        self.assertEqual(self.call("/deals/nope")["code"], 404)

    def test_3_wizard_agent_and_incident(self):
        self.login()
        eq = self.call("/parse-equipment", parsers.TEMPLATE_CSV.encode(), {"X-Filename": "t.csv", "Content-Type": "application/octet-stream"})
        self.assertEqual(eq["cards"], 3)
        c = self.call("/deals", dict(borrower="ООО «Тест»", location="ЦОД", servers=eq["servers"]))
        did, token = c["id"], c["agent_token"]
        self.assertEqual(len(self.call("/portfolio")["rows"]), 6)           # черновик не в портфеле
        # реальный агент присылает данные; srv-01 / GPU1 — чужой серийный номер
        anon = urllib.request.build_opener()
        ok = self.call("/agent/ingest", dict(token=token, server="srv-01", gpus=[
            dict(index=0, serial="1654023118421", temperature=65, utilization=88, hours=6000),
            dict(index=1, serial="9999", temperature=66, utilization=90, hours=6000)]), opener=anon)
        self.assertTrue(ok["ok"])
        self.assertEqual(self.call("/agent/ingest", dict(token="bad", server="srv-01", gpus=[]), opener=anon)["code"], 401)
        self.assertEqual(self.call("/agent/ingest", dict(token=token, server="zzz", gpus=[]), opener=anon)["code"], 404)
        r = self.call(f"/deals/{did}/loan", dict(amount=5e6, term=24, rate=17, schedule="annuity", issue_date="2026-11-01", covenant=1.25))
        self.assertEqual(r["id"], did)
        self.assertEqual(len(self.call("/portfolio")["rows"]), 7)
        notifs = [n for n in self.call("/notifications") if n["deal_id"] == did]
        self.assertIn("swap", [n["kind"] for n in notifs])
        sw = next(n for n in notifs if n["kind"] == "swap")
        res = self.call(f"/notifications/{sw['id']}/action", dict(action="inspect"))
        self.assertEqual(res["status"], "decided")
        self.assertEqual(self.call(f"/notifications/{sw['id']}/action", dict(action="inspect"))["code"], 400)

    def test_4_documents_and_report(self):
        self.login()
        docs = self.call("/deals/neurocluster/documents")
        self.assertTrue(any(d["type"] == "conclusion" for d in docs))
        rep = self.call("/deals/neurocluster/report.html", raw=True).decode()
        self.assertIn("Заключение об оценке залога", rep)
        up = self.call("/deals/neurocluster/documents", b"hello", {"X-Filename": "a%20b.pdf", "X-Doc-Type": "act", "Content-Type": "application/octet-stream"})
        self.assertTrue(up["ok"])
        docs = self.call("/deals/neurocluster/documents")
        mine = next(d for d in docs if d["type"] == "act")
        self.assertEqual(self.call(f"/deals/neurocluster/documents/{mine['id']}", raw=True), b"hello")
        x = next(d for d in docs if d["ext"] == "xlsx")
        self.assertEqual(parsers.parse_equipment("e.xlsx", self.call(f"/deals/neurocluster/documents/{x['id']}", raw=True))["cards"], 32)

    def test_5_settings_do_not_leak_key(self):
        self.login()
        self.call("/settings", dict(ai=dict(api_key="sk-secret", enabled=True)))
        s = self.call("/settings")
        self.assertTrue(s["ai"]["has_key"])
        self.assertNotIn("sk-secret", json.dumps(s))
        self.call("/settings", dict(ai=dict(clear_key=True, enabled=False)))

    def test_6_incident_creates_alert(self):
        self.login()
        self.call("/deals/quantcloud/incident", dict(type="overheat"))
        kinds = [n["kind"] for n in self.call("/notifications") if n["deal_id"] == "quantcloud"]
        self.assertIn("hardware", kinds)
        self.call("/deals/quantcloud/incident", dict(type="reset"))


if __name__ == "__main__":
    unittest.main()


class AIHttp(unittest.TestCase):
    """Проверка настоящего HTTP-обмена с OpenAI-совместимым сервером (локальный мок)."""

    def test_chat_completions_roundtrip(self):
        from http.server import BaseHTTPRequestHandler, HTTPServer
        seen = {}

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def do_POST(self):
                seen["auth"] = self.headers.get("Authorization")
                seen["path"] = self.path
                seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                content = json.dumps(dict(risk="medium", summary="Проверка ИИ", findings=[dict(severity="warning", title="Тест", detail="d", server="srv-01", gpu=0)],
                                          recommendations=["Проверить охлаждение"]))
                out = json.dumps(dict(choices=[dict(message=dict(content="```json\n" + content + "\n```"))])).encode()
                self.send_response(200); self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)

        srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            d = make_deal()
            cfg = dict(enabled=True, base_url=f"http://127.0.0.1:{srv.server_address[1]}/v1", api_key="sk-test", model="m1")
            rep = ai.analyze(d, engine.deal_detail(d, time.time()), cfg)
        finally:
            srv.shutdown()
        self.assertEqual(rep["source"], "ai")
        self.assertEqual(rep["summary"], "Проверка ИИ")
        self.assertEqual(seen["path"], "/v1/chat/completions")
        self.assertEqual(seen["auth"], "Bearer sk-test")
        self.assertEqual(seen["body"]["model"], "m1")
        self.assertIn("srv-01", seen["body"]["messages"][1]["content"])   # телеметрия ушла в модель

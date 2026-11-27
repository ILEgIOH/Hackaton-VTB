"""Спринт 2: безопасность, комплаенс, аудит, эксплуатация."""
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from compute_collateral import ai, engine, parsers, security, seed  # noqa: E402
from compute_collateral.journal import Journal  # noqa: E402
from compute_collateral.server import create_server  # noqa: E402
from compute_collateral.store import Store  # noqa: E402


class JournalTests(unittest.TestCase):
    def test_hash_chain_detects_tampering(self):
        with tempfile.TemporaryDirectory() as d:
            j = Journal(Path(d) / "j.sqlite")
            for i in range(5):
                j.audit(f"user{i}@bank.ru", "reassess", "neurocluster", role="analyst", details=dict(n=i))
            self.assertEqual(j.verify()["ok"], True)
            self.assertEqual(j.verify()["checked"], 5)
            # правка задним числом
            raw = sqlite3.connect(Path(d) / "j.sqlite")
            raw.execute("UPDATE audit SET actor='hacker@bank.ru' WHERE id=3")
            raw.commit()
            raw.close()
            v = j.verify()
            self.assertFalse(v["ok"])
            self.assertEqual(v["broken_at"], 3)

    def test_delete_in_middle_detected(self):
        j = Journal()
        for i in range(4):
            j.audit("a@bank.ru", "export", str(i))
        j.db.execute("DELETE FROM audit WHERE id=2")
        self.assertEqual(j.verify()["broken_at"], 3)

    def test_telemetry_history_and_retention(self):
        j = Journal()
        now = time.time()
        j.add_telemetry([(now - 500 * 86400, "d1", "srv-01", 0, "1", 60, 80, 100), (now, "d1", "srv-01", 0, "1", 65, 85, 110)])
        self.assertEqual(len(j.telemetry_history("d1")), 2)
        self.assertEqual(j.purge_telemetry(400, now), 1)
        self.assertEqual(j.telemetry_history("d1")[0]["temp"], 65)


class SecurityUnit(unittest.TestCase):
    def test_signature_window_and_replay(self):
        key, body, now = "CC-AAAA-BBBB", b'{"server":"srv-01"}', time.time()
        ts = str(int(now))
        sig = security.sign(key, ts, body)
        self.assertIsNone(security.verify_signature(key, ts, sig, body, now))
        self.assertEqual(security.verify_signature(key, ts, sig, body, now), "повтор уже принятого пакета")
        self.assertEqual(security.verify_signature(key, ts, security.sign(key, ts, body + b" "), body, now), "неверная подпись")
        old = str(int(now - 3600))
        self.assertIn("устарел", security.verify_signature(key, old, security.sign(key, old, body), body, now))

    def test_egress_only_in_onprem(self):
        with mock.patch.dict(os.environ, {"CC_ONPREM": ""}):
            security.check_egress("https://api.openai.com/v1")      # вне контура — можно
        with mock.patch.dict(os.environ, {"CC_ONPREM": "1", "CC_ALLOWED_HOSTS": "llm.bank.local"}):
            with self.assertRaises(PermissionError):
                security.check_egress("https://api.openai.com/v1")
            security.check_egress("http://127.0.0.1:11434/v1")
            security.check_egress("http://10.20.30.40:8000/v1")
            security.check_egress("http://llm.bank.local/v1")
            security.check_egress("stub://local")
            with self.assertRaises(RuntimeError):        # и сам клиент ИИ не пойдёт наружу
                ai.chat(dict(base_url="https://api.openai.com/v1", api_key="x", model="m"), [dict(role="user", content="hi")])

    def test_deidentified_snapshot_for_ai(self):
        from test_all import make_deal
        d = make_deal()
        d["borrower"], d["contract"] = "ООО «Секрет»", "КД-1"
        d["servers"][0]["gpus"][1]["actual_serial"] = "9999999999999"
        snap = ai.snapshot(d, engine.deal_detail(d, time.time()), time.time())
        text = json.dumps(snap, ensure_ascii=False)
        self.assertNotIn("Секрет", text)
        self.assertNotIn("КД-1", text)
        self.assertNotIn("1000000000000", text)
        self.assertNotIn("9999999999999", text)
        g = snap["servers"][0]["gpus"]
        self.assertTrue(g[0]["serial_match"])
        self.assertFalse(g[1]["serial_match"])
        self.assertTrue(snap["deidentified"])


class SecurityApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        import compute_collateral.server as srvmod
        import compute_collateral.store as stmod
        stmod.DATA_DIR = srvmod.DATA_DIR = Path(cls.tmp.name)
        cls.store = Store(Path(cls.tmp.name) / "db.json", journal=Journal(Path(cls.tmp.name) / "journal.sqlite"))
        seed.seed(cls.store)
        cls.bad_inn = parsers.make_inn("770123456")
        (Path(cls.tmp.name) / "stoplist.csv").write_text(f"ИНН;Основание\n{cls.bad_inn};перечень (тест)\n", "utf-8")
        cls.srv = create_server(cls.store, "127.0.0.1", 0)
        cls.app = cls.srv.app
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.ops = {}

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.tmp.cleanup()

    def req(self, path, body=None, headers=None, who="anon", raw=False):
        if who not in self.ops:
            self.ops[who] = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
        data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}/api{path}", data=data, headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with self.ops[who].open(r) as resp:
                out = resp.read()
                return (out, dict(resp.headers)) if raw else json.loads(out)
        except urllib.error.HTTPError as e:
            return dict(json.loads(e.read()), code=e.code)

    def login(self, who, email):
        return self.req("/login", dict(email=email, password=seed.DEMO_PASSWORD), who=who)

    def test_01_health_metrics_and_headers(self):
        h = self.req("/health")
        self.assertTrue(h["ok"])
        body, headers = self.req("/metrics", raw=True)
        self.assertIn(b"cc_requests_total", body)
        self.assertIn(b"cc_deals_active 6", body)
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])

    def test_02_audit_logs_actions_and_failed_logins(self):
        self.req("/login", dict(email="e.sokolova@bank.ru", password="wrong"), who="x")
        self.login("analyst", "e.sokolova@bank.ru")
        self.req("/deals/neurocluster/reassess", {}, who="analyst")
        self.assertEqual(self.req("/audit", who="analyst")["code"], 403)            # аналитик журнал не видит
        self.login("risk", "a.kim@bank.ru")
        items = self.req("/audit", who="risk")["items"]
        acts = [i["action"] for i in items]
        self.assertIn("login_failed", acts)
        self.assertIn("reassess", acts)
        self.assertIn("audit_view", acts)
        self.assertNotIn("wrong", json.dumps(items, ensure_ascii=False))          # пароли в журнал не попадают
        self.assertTrue(self.req("/audit/verify", {}, who="risk")["ok"])

    def test_03_signed_agent_packets(self):
        deal = self.store.db["deals"]["neurocluster"]
        key = deal["agent_key"]
        body = json.dumps(dict(server="srv-01", gpus=[dict(index=0, serial=deal["servers"][0]["gpus"][0]["serial"], temperature=67,
                                                           utilization=90, hours=7000)])).encode()
        ts = str(int(time.time()))
        hdr = {"X-CC-Key-Id": security.key_id(key), "X-CC-Timestamp": ts, "X-CC-Signature": security.sign(key, ts, body)}
        self.assertTrue(self.req("/agent/ingest", body, hdr)["ok"])
        self.assertEqual(self.req("/agent/ingest", body, hdr)["code"], 401)                        # повтор
        bad = dict(hdr, **{"X-CC-Signature": "0" * 64, "X-CC-Timestamp": str(int(time.time()) + 1)})
        self.assertEqual(self.req("/agent/ingest", body, bad)["code"], 401)                        # подделка
        self.assertGreaterEqual(len(self.app.journal.telemetry_history("neurocluster", "srv-01", 0)), 1)
        with mock.patch.dict(os.environ, {"CC_AGENT_SIGNED_ONLY": "1"}):
            r = self.req("/agent/ingest", dict(key=key, server="srv-01", gpus=[]))
            self.assertEqual(r["code"], 401)
            self.assertIn("подпись", r["error"])
        rejected = [i for i in self.app.journal.audit_list(50) if i["action"] == "agent_rejected"]
        self.assertGreaterEqual(len(rejected), 3)

    def test_04_aml_stoplist_blocks_deal(self):
        self.login("analyst2", "e.sokolova@bank.ru")
        chk = self.req(f"/check-inn?inn={self.bad_inn}", who="analyst2")
        self.assertTrue(chk.get("aml", {}).get("hit"))
        r = self.req("/deals", dict(name="ООО Тест", inn=self.bad_inn, location="М", application="КД-2026-0001", contact="И", contact_email="i@t.ru",
                                    servers=[dict(name="srv-01", model="H100", gpus=[dict(idx=0, serial="1700000000001")])]), who="analyst2")
        self.assertEqual(r["code"], 422)
        self.assertIn("inn", r["fields"])
        self.assertTrue(any(i["action"] == "aml_block" for i in self.app.journal.audit_list(50)))

    def test_05_csrf_origin_check(self):
        r = self.req("/login", dict(email="e.sokolova@bank.ru", password=seed.DEMO_PASSWORD), {"Origin": "https://evil.example"}, who="y")
        self.assertEqual(r["code"], 403)

    def test_06_auto_revaluation_590p(self):
        deal = self.store.db["deals"]["datafork"]
        deal["assessments"][-1]["ts"] -= 120 * 86400                     # последняя оценка — 4 месяца назад
        n = len(deal["assessments"])
        done = self.app.auto_revalue()
        self.assertIn("datafork", done)
        self.assertEqual(len(deal["assessments"]), n + 1)
        self.assertEqual(self.app.auto_revalue(), [])                      # свежие не трогаем
        self.assertTrue(any(i["action"] == "auto_revalue" for i in self.app.journal.audit_list(50)))

    def test_07_security_status(self):
        self.login("coll", "m.orlova@bank.ru")
        s = self.req("/security", who="coll")
        self.assertTrue(s["deidentify"])
        self.assertEqual(s["stoplist"]["loaded"], 1)
        self.assertTrue(s["audit"]["can_view"])



class MaskingTests(unittest.TestCase):
    """Маскирование свободного текста перед нейросетью и правило «ИИ только дополняет правила»."""
    CFG = dict(enabled=True, base_url="http://10.0.0.5/v1", api_key="k", model="m")

    def deal(self):
        from test_all import make_deal
        d = make_deal()
        d.update(borrower="ООО «ДатаЦентр Север»", inn="7701234567", contract="КД-2026-0412", contact="Иван Смирнов",
                 contact_email="i.smirnov@dcnorth.ru", location="ЦОД «Север-2», Москва")
        return d

    def run_ai(self, d, reply, question=None):
        sent, orig = [], ai.chat

        def fake(cfg, messages, **k):
            sent.extend(m["content"] for m in messages)
            return reply
        ai.chat = fake
        try:
            det = engine.deal_detail(d, time.time())
            out = ai.ask_ex(d, det, self.CFG, question) if question else ai.analyze(d, det, self.CFG)
        finally:
            ai.chat = orig
        return out, "\n".join(sent)

    def test_question_pii_never_reaches_model(self):
        d = self.deal()
        q = ("Что с ДатаЦентр Север по договору КД-2026-0412? Пишет i.smirnov@dcnorth.ru и a.petrov@mail.ru, тел. +7 916 123-45-67, "
             "ИНН 7701234567, карта 2200 1234 5678 9012, СНИЛС 112-233-445 95, паспорт 45 12 345678")
        (ans, masked), blob = self.run_ai(d, "У [ЗАЁМЩИК] по договору [ДОГОВОР] всё в порядке", q)
        for secret in ("ДатаЦентр", "КД-2026-0412", "7701234567", "smirnov", "petrov", "916 123", "2200 1234", "112-233", "345678",
                       "Смирнов", "Север-2"):
            self.assertNotIn(secret, blob)
        self.assertEqual(ans, "У ООО «ДатаЦентр Север» по договору КД-2026-0412 всё в порядке")
        self.assertGreaterEqual(masked["email"], 1)
        self.assertEqual(masked["phone"], 1)

    def test_serials_in_rule_findings_masked_and_restored(self):
        d = self.deal()
        d["servers"][0]["gpus"][0]["actual_serial"] = "1999999999999"
        reply = ('{"risk":"low","summary":"Карта S-XXXX","findings":[{"severity":"warning","title":"Проверить [ЗАЁМЩИК]","detail":"x"}],'
                 '"recommendations":["Сверить [ДОГОВОР]"]}')
        rep, blob = self.run_ai(d, reply)
        self.assertNotIn("1999999999999", blob)                    # ни в снимке, ни в тексте замечаний правил
        self.assertNotIn("1000000000000", blob)
        self.assertIn("S-", blob)
        self.assertEqual(rep["risk"], "high")                       # модель сказала low — правила сильнее
        self.assertTrue(any(x["title"].startswith("Серийный") and x["source"] == "rules" for x in rep["findings"]))
        self.assertIn("1999999999999", next(x["detail"] for x in rep["findings"] if x["title"].startswith("Серийный")))
        self.assertEqual(rep["ai_findings"][0]["title"], "Проверить ООО «ДатаЦентр Север»")
        self.assertIn("Назначить выездную проверку и приостановить выдачу траншей", rep["recommendations"])
        self.assertIn("Сверить КД-2026-0412", rep["recommendations"])
        self.assertTrue(rep["masked"].get("серийные номера"))

    def test_ai_cannot_drop_or_duplicate_rule_findings(self):
        d = self.deal()
        d["servers"][0]["gpus"][0].update(temp=90)
        reply = ('{"risk":"medium","summary":"ok","findings":[{"severity":"info","title":"Критический перегрев","server":"srv-01","gpu":0},'
                 '{"severity":"warning","title":"Неровная загрузка","detail":"..."}],"recommendations":[]}')
        rep, _ = self.run_ai(d, reply)
        self.assertTrue(any(x["title"] == "Критический перегрев" for x in rep["findings"]))
        self.assertEqual([x["title"] for x in rep["ai_findings"]], ["Неровная загрузка"])

    def test_amounts_and_unknown_serials_untouched(self):
        txt, st = security.mask_text("Долг 1234567890 руб.? Нет: 60000000 и серийный 1654023118421", None)
        self.assertIn("60000000", txt)
        self.assertIn("1654023118421", txt)                         # 13 цифр — не ИНН и не карта

    def test_masking_can_be_disabled_explicitly(self):
        d = self.deal()
        with mock.patch.dict(os.environ, {"CC_AI_DEIDENTIFY": "0"}):
            (_, masked), blob = self.run_ai(d, "ok", "Как дела у ДатаЦентр Север?")
        self.assertIn("ДатаЦентр", blob)
        self.assertEqual(masked, {})

class DeferredStore(unittest.TestCase):
    def test_write_behind_batches_writes(self):
        with tempfile.TemporaryDirectory() as d:
            st = Store(Path(d) / "db.json", write_delay=0.2)
            st.db = dict(x=0)
            for i in range(200):
                st.db["x"] = i
                st.save()
            time.sleep(0.6)
            self.assertLessEqual(st.writes, 3)
            self.assertEqual(json.loads((Path(d) / "db.json").read_text())["x"], 199)


if __name__ == "__main__":
    unittest.main()

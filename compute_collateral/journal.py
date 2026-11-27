"""Журнал аудита и история телеметрии в SQLite (стандартная библиотека, работает в закрытом контуре без внешних сервисов).

* audit — кто, когда и что сделал в системе. Записи связаны цепочкой SHA-256: каждая хранит хэш предыдущей,
  поэтому правку или удаление задним числом видно при проверке (verify). Журнал только дописывается.
* telemetry — история показаний агентов (серийный номер, температура, загрузка, наработка) для разбора инцидентов
  и износа; старые строки удаляются по сроку хранения (CC_TELEMETRY_DAYS, по умолчанию 400 дней).

Для промышленного контура те же таблицы переносятся в PostgreSQL / Postgres Pro без изменения API модуля.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path

GENESIS = "0" * 64

ACTION_LABELS = {
    "login": "Вход в систему", "login_failed": "Неудачный вход", "login_locked": "Вход заблокирован", "logout": "Выход",
    "pw_reset": "Запрос восстановления пароля", "pw_confirm": "Смена пароля",
    "create_deal": "Новая оценка: данные заёмщика", "discard": "Удаление черновика", "set_step": "Шаг мастера",
    "telemetry": "Режим телеметрии", "telemetry_file": "Загрузка снимка nvidia-smi", "demo_agent": "Демо-агент",
    "invite_cod": "Письмо в ЦОД", "set_loan": "Условия кредита", "write_cod": "Письмо в ЦОД",
    "save_terms": "Изменение условий кредита", "reassess": "Переоценка залога", "auto_revalue": "Плановая переоценка (590-П)",
    "docs_upload": "Загрузка документа", "doc_download": "Скачивание документа", "export": "Выгрузка заключения",
    "decide": "Решение по уведомлению", "settings_notify": "Настройки уведомлений", "settings_th": "Пороги мониторинга",
    "settings_ai": "Настройки ИИ", "ai_test": "Проверка подключения ИИ", "ai_models": "Список моделей ИИ",
    "ai_analyze": "ИИ-анализ сделки", "ai_chat": "Вопрос ИИ", "incident": "Демо-инцидент", "aml_block": "Стоп-лист 115-ФЗ: сделка остановлена",
    "agent_rejected": "Отклонён пакет агента", "audit_verify": "Проверка целостности журнала", "audit_view": "Просмотр журнала аудита",
    "whatif": "Расчёт «что если»", "startup": "Запуск сервиса", "template": "Шаблон перечня", "template_x": "Шаблон перечня", "parse_eq": "Разбор перечня",
}


def _canon(rec: dict) -> str:
    return json.dumps(rec, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class Journal:
    def __init__(self, path: str | Path = ":memory:"):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.lock = threading.Lock()
        with self.lock:
            if self.path != ":memory:":
                self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=NORMAL")
            self.db.executescript("""
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts REAL, actor TEXT, role TEXT, action TEXT, object TEXT,
                                             ip TEXT, result TEXT, details TEXT, prev TEXT, hash TEXT);
            CREATE INDEX IF NOT EXISTS audit_obj ON audit(object);
            CREATE TABLE IF NOT EXISTS telemetry(ts REAL, deal TEXT, server TEXT, gpu INTEGER, serial TEXT, temp REAL, util REAL, hours REAL);
            CREATE INDEX IF NOT EXISTS tel_deal ON telemetry(deal, ts);
            """)

    # ---------- аудит ----------
    def audit(self, actor: str, action: str, obj: str = "", role: str = "", ip: str = "", result: str = "ok",
              details: dict | None = None, ts: float | None = None) -> dict:
        ts = ts or time.time()
        body = dict(ts=round(ts, 3), actor=actor or "—", role=role or "", action=action, object=obj or "", ip=ip or "",
                    result=result, details=details or {})
        with self.lock:
            row = self.db.execute("SELECT hash FROM audit ORDER BY id DESC LIMIT 1").fetchone()
            prev = row[0] if row else GENESIS
            h = hashlib.sha256((prev + _canon(body)).encode()).hexdigest()
            cur = self.db.execute("INSERT INTO audit(ts,actor,role,action,object,ip,result,details,prev,hash) VALUES(?,?,?,?,?,?,?,?,?,?)",
                                  (body["ts"], body["actor"], body["role"], action, body["object"], body["ip"], result,
                                   _canon(body["details"]), prev, h))
        return dict(body, id=cur.lastrowid, hash=h)

    def audit_list(self, limit: int = 200, obj: str | None = None, actor: str | None = None) -> list[dict]:
        q, args = "SELECT id,ts,actor,role,action,object,ip,result,details,hash FROM audit", []
        cond = []
        if obj:
            cond.append("object=?"); args.append(obj)
        if actor:
            cond.append("actor=?"); args.append(actor)
        if cond:
            q += " WHERE " + " AND ".join(cond)
        q += " ORDER BY id DESC LIMIT ?"
        args.append(int(limit))
        with self.lock:
            rows = self.db.execute(q, args).fetchall()
        out = []
        for i, ts, actor_, role, action, o, ip, res, det, h in rows:
            out.append(dict(id=i, ts=ts, actor=actor_, role=role, action=action, label=ACTION_LABELS.get(action, action), object=o,
                            ip=ip, result=res, details=json.loads(det or "{}"), hash=h[:12]))
        return out

    def audit_count(self) -> int:
        with self.lock:
            return self.db.execute("SELECT COUNT(*) FROM audit").fetchone()[0]

    def verify(self) -> dict:
        """Пересчитывает цепочку хэшей. ok=False и broken_at=id первой испорченной записи, если журнал правили."""
        prev = GENESIS
        n = 0
        with self.lock:
            rows = self.db.execute("SELECT id,ts,actor,role,action,object,ip,result,details,prev,hash FROM audit ORDER BY id").fetchall()
        for i, ts, actor, role, action, o, ip, res, det, p, h in rows:
            body = dict(ts=ts, actor=actor, role=role, action=action, object=o, ip=ip, result=res, details=json.loads(det or "{}"))
            if p != prev or hashlib.sha256((prev + _canon(body)).encode()).hexdigest() != h:
                return dict(ok=False, checked=n, broken_at=i)
            prev, n = h, n + 1
        return dict(ok=True, checked=n, broken_at=None, head=prev[:12])

    # ---------- телеметрия ----------
    def add_telemetry(self, rows: list[tuple]):
        """rows: (ts, deal, server, gpu, serial, temp, util, hours)"""
        if not rows:
            return
        with self.lock:
            self.db.executemany("INSERT INTO telemetry VALUES(?,?,?,?,?,?,?,?)", rows)

    def telemetry_history(self, deal: str, server: str | None = None, gpu: int | None = None, since: float = 0, limit: int = 5000) -> list[dict]:
        q, args = "SELECT ts,server,gpu,serial,temp,util,hours FROM telemetry WHERE deal=? AND ts>=?", [deal, since]
        if server:
            q += " AND server=?"; args.append(server)
        if gpu is not None:
            q += " AND gpu=?"; args.append(int(gpu))
        q += " ORDER BY ts DESC LIMIT ?"
        args.append(int(limit))
        with self.lock:
            rows = self.db.execute(q, args).fetchall()
        return [dict(ts=a, server=b, gpu=c, serial=d, temp=e, util=f, hours=g) for a, b, c, d, e, f, g in rows]

    def telemetry_count(self) -> int:
        with self.lock:
            return self.db.execute("SELECT COUNT(*) FROM telemetry").fetchone()[0]

    def purge_telemetry(self, older_than_days: float, now: float | None = None) -> int:
        cut = (now or time.time()) - older_than_days * 86400
        with self.lock:
            return self.db.execute("DELETE FROM telemetry WHERE ts<?", (cut,)).rowcount

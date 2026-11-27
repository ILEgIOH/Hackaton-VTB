"""Безопасность и комплаенс: подпись пакетов агента, закрытый контур, обезличивание данных для ИИ, стоп-лист 115-ФЗ.

Переменные окружения:
  CC_ONPREM=1               закрытый контур: ИИ и SMTP только на внутренних адресах (localhost, 10/8, 172.16/12, 192.168/16)
                            или на хостах из CC_ALLOWED_HOSTS; неподписанные пакеты агента отклоняются
  CC_ALLOWED_HOSTS=a,b      внутренние имена, которые разрешены в закрытом контуре (например, llm.bank.local)
  CC_AGENT_SIGNED_ONLY=1    принимать от агентов только подписанные пакеты (в закрытом контуре включено всегда)
  CC_AI_DEIDENTIFY=0        отключить обезличивание снимка для ИИ (по умолчанию включено)
  CC_STOPLIST=path.csv      локальный перечень ИНН (115-ФЗ): ИНН;основание — загружается банком из перечней в контуре
"""
from __future__ import annotations

import csv
import hashlib
import hmac
import ipaddress
import os
import re
import socket
import time
from pathlib import Path
from urllib.parse import urlparse

SIG_WINDOW = 300          # пакет агента действителен ±5 минут
_seen_sigs: dict[str, float] = {}


def onprem() -> bool:
    return os.environ.get("CC_ONPREM") == "1"


def signed_only() -> bool:
    return onprem() or os.environ.get("CC_AGENT_SIGNED_ONLY") == "1"


# ---------- подпись пакетов агента (HMAC-SHA256) ----------

def key_id(agent_key: str) -> str:
    """Идентификатор ключа: агент передаёт его вместо самого ключа, сам ключ по сети не ходит."""
    return hashlib.sha256(agent_key.encode()).hexdigest()[:16]


def sign(agent_key: str, ts: str, body: bytes) -> str:
    return hmac.new(agent_key.encode(), ts.encode() + b"." + body, hashlib.sha256).hexdigest()


def verify_signature(agent_key: str, ts: str, sig: str, body: bytes, now: float | None = None) -> str | None:
    """None — подпись верна; иначе причина отказа. Защита от повтора: окно ±5 минут и запоминание подписей."""
    now = now or time.time()
    try:
        t = float(ts)
    except (TypeError, ValueError):
        return "нет метки времени"
    if abs(now - t) > SIG_WINDOW:
        return "пакет устарел или часы сервера рассинхронизированы"
    if not hmac.compare_digest(sign(agent_key, ts, body), str(sig or "")):
        return "неверная подпись"
    for k in [k for k, v in _seen_sigs.items() if v < now - 2 * SIG_WINDOW]:
        _seen_sigs.pop(k, None)
    if sig in _seen_sigs:
        return "повтор уже принятого пакета"
    _seen_sigs[sig] = now
    return None


# ---------- закрытый контур ----------

def _allowed_names() -> set[str]:
    return {h.strip().lower() for h in os.environ.get("CC_ALLOWED_HOSTS", "").split(",") if h.strip()}


def host_internal(host: str) -> bool:
    host = (host or "").strip("[]").lower()
    if not host:
        return False
    if host in _allowed_names() or host == "localhost":
        return True
    try:
        ips = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            ips = [ipaddress.ip_address(a[4][0]) for a in socket.getaddrinfo(host, None)]
        except OSError:
            return False
    return bool(ips) and all(ip.is_private or ip.is_loopback or ip.is_link_local for ip in ips)


def check_egress(url_or_host: str, what: str = "Адрес"):
    """В закрытом контуре запрещает обращения наружу. Вне контура — ничего не делает."""
    if not onprem():
        return
    host = urlparse(url_or_host).hostname if "://" in url_or_host else url_or_host
    if url_or_host.startswith("stub"):
        return
    if not host_internal(host or ""):
        raise PermissionError(f"Закрытый контур: {what.lower()} {host} вне сети банка. Разрешены внутренние адреса "
                              "и хосты из CC_ALLOWED_HOSTS")


# ---------- обезличивание для ИИ (152-ФЗ, банковская тайна) ----------

def deidentify_enabled() -> bool:
    return os.environ.get("CC_AI_DEIDENTIFY", "1") != "0"


def pseudo(value: str, salt: str, prefix: str) -> str:
    return prefix + hashlib.sha256((salt + "|" + str(value)).encode()).hexdigest()[:6].upper()


def deidentify_snapshot(snap: dict, salt: str) -> dict:
    """Убирает из снимка название заёмщика и номер договора, заменяет серийные номера псевдонимами.
    Модель по-прежнему видит, совпадает ли фактический номер с договорным, — этого достаточно для анализа."""
    out = dict(snap, borrower="[ЗАЁМЩИК]", contract="[ДОГОВОР]" if snap.get("contract") else None)
    servers = []
    for s in snap.get("servers", []):
        gpus = []
        for g in s.get("gpus", []):
            sc, sa = g.get("serial_contract"), g.get("serial_actual")
            gpus.append(dict(g, serial_contract=pseudo(sc, salt, "S-") if sc else None,
                             serial_actual=pseudo(sa, salt, "S-") if sa else None,
                             serial_match=(sa == sc) if sa else None))
        servers.append(dict(s, gpus=gpus))
    out["servers"] = servers
    out["deidentified"] = True
    return out


# ---------- стоп-лист 115-ФЗ ----------

_stop_cache: dict = {}


def stoplist_path() -> Path:
    from .store import DATA_DIR
    return Path(os.environ.get("CC_STOPLIST", DATA_DIR / "stoplist.csv"))


def stoplist() -> dict[str, str]:
    p = stoplist_path()
    if not p.exists():
        return {}
    mt = p.stat().st_mtime
    if _stop_cache.get("mt") != mt:
        rows = {}
        with p.open(encoding="utf-8") as f:
            for row in csv.reader(f, delimiter=";"):
                if row and row[0].strip().isdigit():
                    rows[row[0].strip()] = (row[1].strip() if len(row) > 1 else "") or "внутренний перечень банка"
        _stop_cache.update(mt=mt, rows=rows)
    return _stop_cache["rows"]


def aml_check(inn: str) -> dict | None:
    reason = stoplist().get(str(inn).strip())
    return dict(hit=True, reason=reason) if reason else None


# ---------- маскирование текста перед отправкой в нейросеть ----------
# Снимок сделки обезличивается структурно (deidentify_snapshot). Но в нейросеть уходит и свободный текст:
# замечания правил (в них есть серийные номера) и вопросы сотрудника в чате (туда могут вписать что угодно).
# mask_text() убирает из такого текста реквизиты сделки и типовые персональные данные, unmask_text() возвращает
# реквизиты сделки в ответ модели, чтобы сотрудник банка видел обычный текст. Что ушло наружу — только метки.

DEAL_LABELS = (("borrower", "[ЗАЁМЩИК]"), ("inn", "[ИНН_ЗАЁМЩИКА]"), ("contract", "[ДОГОВОР]"), ("application", "[ДОГОВОР]"),
               ("contact", "[КОНТАКТ_ЦОД]"), ("contact_email", "[EMAIL_КОНТАКТА]"), ("location", "[ЛОКАЦИЯ]"))

# Порядок важен: почта и телефон раньше чисел; номер карты (16 цифр) раньше ИНН (10/12 цифр).
# Серийные номера GPU — 13 цифр, под шаблоны ИНН и карты не попадают; номера этой сделки заменяются псевдонимами отдельно.
PII_PATTERNS = (
    ("email", re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"), "[EMAIL]"),
    ("phone", re.compile(r"(?<![\d+])(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)"), "[ТЕЛЕФОН]"),
    ("card", re.compile(r"(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)"), "[НОМЕР_КАРТЫ]"),
    ("snils", re.compile(r"(?<!\d)\d{3}-\d{3}-\d{3}[ -]\d{2}(?!\d)"), "[СНИЛС]"),
    ("passport", re.compile(r"(?i)паспорт\D{0,12}\d{2}\s?\d{2}\s?\d{6}"), "[ПАСПОРТ]"),
    ("account", re.compile(r"(?<!\d)[34]\d{19}(?!\d)"), "[СЧЁТ]"),
    ("inn", re.compile(r"(?<!\d)(?:\d{12}|\d{10})(?!\d)"), "[ИНН]"),
)


def _deal_map(deal: dict, salt: str) -> dict[str, str]:
    """Реальное значение → метка. Длинные значения первыми, чтобы не заменить часть строки."""
    m: dict[str, str] = {}
    for key, label in DEAL_LABELS:
        v = str(deal.get(key) or "").strip()
        if len(v) >= 3 and v not in m:
            m[v] = label
        if key == "borrower" and v:   # «Нейрокластер» без ООО и кавычек — тоже заёмщик
            core = re.sub(r"^(ООО|АО|ПАО|ЗАО|ОАО|ИП|LLC)\s+", "", v, flags=re.I).strip("«»\"' ")
            if len(core) >= 4 and core not in m:
                m[core] = label
    for s in deal.get("servers", []):
        for g in s.get("gpus", []):
            for v in (g.get("serial"), g.get("actual_serial")):
                if v and str(v) not in m:
                    m[str(v)] = pseudo(v, salt, "S-")
    return dict(sorted(m.items(), key=lambda kv: -len(kv[0])))


def mask_text(text: str, deal: dict | None = None, salt: str = "") -> tuple[str, dict[str, int]]:
    """-> (текст без реквизитов и ПДн, сколько чего заменено). Счётчик пишется в журнал аудита, сами значения — нет."""
    stats: dict[str, int] = {}
    if deal:
        for real, label in _deal_map(deal, salt).items():
            text, n = re.subn(re.escape(real), label, text, flags=re.I)
            if n:
                k = "серийные номера" if label.startswith("S-") else label.strip("[]").lower()
                stats[k] = stats.get(k, 0) + n
    for name, rx, label in PII_PATTERNS:
        text, n = rx.subn(label, text)
        if n:
            stats[name] = stats.get(name, 0) + n
    return text, stats


def unmask_text(text: str, deal: dict, salt: str = "") -> str:
    """Возвращает в ответ модели реквизиты сделки и реальные серийные номера. Общие метки ([EMAIL], [ТЕЛЕФОН]…)
    не восстанавливаются: их значения модели не передавались и в ответе не нужны."""
    back: dict[str, str] = {}
    for real, label in _deal_map(deal, salt).items():
        back.setdefault(label, real)
    for label in sorted(back, key=len, reverse=True):
        text = text.replace(label, back[label])
    return text

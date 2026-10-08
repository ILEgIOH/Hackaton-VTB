"""Разбор файлов заёмщика: перечень оборудования и снимок nvidia-smi (CSV/XLSX)."""
from __future__ import annotations

import csv
import io
import re
from collections import OrderedDict
from datetime import date, datetime

from .market import normalize_model

TEMPLATE_CSV = (
    "Сервер;Модель;Серийный номер;Дата ввода\r\n"
    "srv-01;H100 SXM 80 ГБ;1654023118421;12.02.2025\r\n"
    "srv-01;H100 SXM 80 ГБ;1654023118422;12.02.2025\r\n"
    "srv-02;H100 SXM 80 ГБ;1654023118908;03.06.2025\r\n"
)

HEAD_SYNONYMS = {
    "server": ("сервер", "server", "host", "hostname", "узел"),
    "model": ("модель", "model", "gpu", "name", "карта"),
    "serial": ("серийный", "serial", "s/n", "sn"),
    "date": ("дата", "date", "commission", "ввод"),
}


def _rows(filename: str, data: bytes) -> list[list]:
    name = filename.lower()
    if name.endswith((".xlsx", ".xlsm")):
        from openpyxl import load_workbook
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        return [list(r) for r in wb.active.iter_rows(values_only=True)]
    text = None
    for enc in ("utf-8-sig", "cp1251"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise ValueError("Не удалось прочитать файл: неизвестная кодировка")
    try:
        dialect = csv.Sniffer().sniff(text[:2048], delimiters=";,\t")
    except csv.Error:
        dialect = csv.excel
    return list(csv.reader(io.StringIO(text), dialect))


def _col_map(header: list) -> dict:
    cols = {}
    for i, h in enumerate(header):
        hl = str(h or "").strip().lower()
        for key, syns in HEAD_SYNONYMS.items():
            if key not in cols and any(s in hl for s in syns):
                cols[key] = i
    return cols


def _parse_date(v):
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = str(v or "").strip()
    for fmt in ("%d.%m.%Y", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def parse_equipment(filename: str, data: bytes) -> dict:
    """Возвращает {servers:[{name, model, gpus:[{idx, serial, commissioned}]}], errors:[...]}."""
    rows = [r for r in _rows(filename, data) if any(str(c or "").strip() for c in r)]
    if not rows:
        raise ValueError("Файл пуст")
    cols = _col_map(rows[0])
    missing = [k for k in ("server", "model", "serial") if k not in cols]
    if missing:
        raise ValueError("Не найдены колонки: " + ", ".join(
            {"server": "Сервер", "model": "Модель", "serial": "Серийный номер"}[k] for k in missing))
    servers: "OrderedDict[str, dict]" = OrderedDict()
    errors, seen = [], set()
    for ln, r in enumerate(rows[1:], start=2):
        get = lambda k: str(r[cols[k]]).strip() if k in cols and cols[k] < len(r) and r[cols[k]] is not None else ""
        name, model_raw = get("server"), get("model")
        serial = re.sub(r"\.0$", "", get("serial"))
        model = normalize_model(model_raw)
        if not name:
            errors.append(f"Строка {ln}: не указан сервер")
            continue
        if not serial:
            errors.append(f"Строка {ln}: нет серийного номера")
            continue
        if serial in seen:
            errors.append(f"Строка {ln}: дубль серийного номера {serial}")
            continue
        if not model:
            errors.append(f"Строка {ln}: неизвестная модель «{model_raw}» (поддерживаются H100, H200, A100, L40S)")
            continue
        srv = servers.setdefault(name, dict(name=name, model=model, gpus=[]))
        if srv["model"] != model:
            errors.append(f"Строка {ln}: в сервере {name} смешаны модели {srv['model']} и {model}")
            continue
        seen.add(serial)
        d = _parse_date(r[cols["date"]]) if "date" in cols and cols["date"] < len(r) else None
        srv["gpus"].append(dict(idx=len(srv["gpus"]), serial=serial, commissioned=d))
    return dict(servers=list(servers.values()), errors=errors,
                cards=sum(len(s["gpus"]) for s in servers.values()), count_servers=len(servers))


def parse_smi(filename: str, data: bytes) -> list[dict]:
    """CSV из `nvidia-smi --query-gpu=index,serial,name,temperature.gpu,utilization.gpu --format=csv`."""
    rows = [r for r in _rows(filename, data) if any(str(c or "").strip() for c in r)]
    if not rows:
        raise ValueError("Файл пуст")
    head = [str(h).strip().lower() for h in rows[0]]
    def find(*keys):
        for i, h in enumerate(head):
            if any(k in h for k in keys):
                return i
        return None
    i_serial, i_temp, i_util = find("serial"), find("temperature", "temp"), find("utilization", "util", "загруз")
    i_host, i_idx, i_hours = find("host", "server", "сервер"), find("index"), find("hours", "наработ")
    if i_serial is None or i_temp is None:
        raise ValueError("В файле нет колонок serial и temperature.gpu "
                         "(команда: nvidia-smi --query-gpu=index,serial,name,temperature.gpu,utilization.gpu --format=csv)")
    num = lambda v: float(re.sub(r"[^\d.]", "", str(v)) or 0)
    out = []
    for r in rows[1:]:
        if len(r) <= max(i_serial, i_temp):
            continue
        out.append(dict(
            serial=re.sub(r"\.0$", "", str(r[i_serial]).strip()), temp=num(r[i_temp]),
            util=num(r[i_util]) if i_util is not None and i_util < len(r) else 0,
            host=str(r[i_host]).strip() if i_host is not None and i_host < len(r) else None,
            index=int(num(r[i_idx])) if i_idx is not None and i_idx < len(r) else None,
            hours=num(r[i_hours]) if i_hours is not None and i_hours < len(r) else None,
        ))
    return out

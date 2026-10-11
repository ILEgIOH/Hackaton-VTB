"""Уведомления (ТЗ, «Уведомления: когда появляются» и экраны U01–U08): правила создают, сотрудник решает."""
from __future__ import annotations

import time
from datetime import date

from . import engine, mailer, users

LABELS = dict(swap="Подмена оборудования", covenant="Нарушение ковенанта", threshold="Близко к порогу", forecast="Прогноз",
              link="Связь с сервером", hardware="Состояние оборудования", ready="Оценка готова")
# первая кнопка совпадает с рекомендацией системы
ACTIONS = {
    "swap": [("inspect", "Назначить проверку"), ("request", "Запросить обеспечение")],
    "link": [("write_cod", "Написать в ЦОД")],
    "hardware": [("inspect", "Назначить проверку"), ("watch", "Наблюдать")],
    "covenant": [("request", "Запросить обеспечение"), ("reassess", "Назначить переоценку")],
    "threshold": [("reassess", "Назначить переоценку"), ("watch", "Наблюдать")],
    "forecast": [("params", "Изменить параметры"), ("watch", "Наблюдать")],
    "ready": [("open", "Открыть компанию")],
}
STATE_LABEL = dict(new="новое", in_work="в работе", decided="решение принято", watching="на наблюдении", closed="закрыто")
OPEN_STATES = ("new", "in_work")


def fm(v):
    return f"{v / 1e6:.1f}".replace(".", ",")


def dmy(iso):
    return f"{iso[8:10]}.{iso[5:7]}.{iso[:4]}"


def _open(db, key):
    return next((n for n in db["notifications"] if n["key"] == key and n["status"] not in ("closed", "decided")), None)


def _recipients(db, kind, author=None):
    out = []
    for u in db["users"]:
        want = users.RECIPIENTS.get(kind, [])
        if u["role"] in want or ("author" in want and author and u["email"] == author):
            out.append(u)
    return out


def add(db, deal, kind, title, text, sev, now, rec=None, author=None, status=None, assignee=None) -> dict:
    n = dict(id=f"n{len(db['notifications']) + 1}", deal_id=deal["id"], kind=kind, label=LABELS[kind], title=title, text=text, severity=sev,
             ts=now, status=status or "new", recommendation=rec, unit=users.UNIT[kind], assignee=assignee, decision=None, wake_at=None,
             key=f"{deal['id']}:{kind}", author=author)
    db["notifications"].append(n)
    for u in _recipients(db, kind, author):
        if users.notify_pref(u, kind)["email"]:
            try:
                mailer.send(db, u["email"], f"[ComputeCollateral] {n['label']}: {deal['borrower']}", f"{title}\n\n{text}\n", "noreply@bank.ru", "notification", deal["id"])
            except RuntimeError:
                pass
    return n


def sync(db: dict, deal: dict, now: float | None = None) -> list[dict]:
    """Создаёт недостающие уведомления по сделке, закрывает устаревшие, возвращает новые."""
    now = now or time.time()
    if deal.get("status") != "active":
        return []
    d = engine.deal_detail(deal, now)
    new, did = [], deal["id"]
    for n in db["notifications"]:   # срок наблюдения истёк — вернуть в «Ждут решения»
        if n["deal_id"] == did and n["status"] == "watching" and n.get("wake_at") and n["wake_at"] <= now:
            n.update(status="new", text=n["text"] + ". Срок наблюдения истёк", wake_at=None)
    mm = d["equipment"]["mismatches"]
    if mm and not _open(db, f"{did}:swap"):
        m = mm[0]
        new.append(add(db, deal, "swap", "Серийный номер карты не совпадает с договором",
                       f"Сервер {m['server']}, GPU {m['gpu']}. По договору s/n {m['contract']}, установлен {m['actual']}", "high", now,
                       "Выездная проверка, приостановить выдачу траншей"))
    cov, cv = d["coverage_now"], d["forecast"]["covenant"]
    if d["status"] == "breach" and not _open(db, f"{did}:covenant"):
        need = cv * d["debt_now"] - d["valuation"]["market"]
        new.append(add(db, deal, "covenant", f"Покрытие {engine_c2(cov)} при ковенанте {engine_c2(cv)}",
                       f"Для возврата к ковенанту не хватает {fm(need)} млн ₽", "high", now, f"Дополнительное обеспечение на {fm(need)} млн ₽"))
    elif d["status"] == "near" and not _open(db, f"{did}:threshold"):
        recent = any(n["deal_id"] == did and n["kind"] == "threshold" and now - n["ts"] < 30 * 86400 for n in db["notifications"])
        if not recent:   # «впервые за 30 дней»
            new.append(add(db, deal, "threshold", f"Покрытие снизилось до {engine_c2(cov)}",
                           f"Ковенант {engine_c2(cv)}, запас {round((cov / cv - 1) * 100)} %", "medium", now, "Назначить переоценку или наблюдать"))
    g = d["gap12"]
    if g and not _open(db, f"{did}:forecast"):
        new.append(add(db, deal, "forecast", f"Через {g['first_month']} {_pl(g['first_month'], 'месяц', 'месяца', 'месяцев')} залог может стать дешевле долга",
                       f"В пессимистичном сценарии разрыв продлится {g['months']} мес., максимум {fm(g['max_gap'])} млн ₽", "medium", now,
                       f"Снизить сумму до {fm(d['recommendation']['max_loan'])} млн ₽ или сократить срок"))
    if deal.get("telemetry_mode") == "agent":
        long_silent = [s for s in deal["servers"] if engine.silent_seconds(s, now) > engine.TH["offline_notify_h"] * 3600 and s.get("last_seen")]
        ex = _open(db, f"{did}:link")
        if long_silent and not ex:
            s = long_silent[0]
            h = int(engine.silent_seconds(s, now) // 3600)
            new.append(add(db, deal, "link", f"Сервер {s['name']} не передаёт данные {h} ч",
                           f"Последние данные {time.strftime('%d.%m.%Y в %H:%M', time.localtime(s['last_seen']))}. Карты сервера оценены с поправкой 7 %", "low", now, "Написать в ЦОД"))
        elif ex and not long_silent:
            ex.update(status="closed", unit="Система", text=ex["text"] + f". Связь восстановлена в {time.strftime('%H:%M', time.localtime(now))}")
    hot = [(s["name"], g2) for s in deal["servers"] for g2 in s["gpus"] if (g2.get("temp") or 0) >= 85]
    if hot and not _open(db, f"{did}:hardware"):
        nm, g2 = hot[0]
        new.append(add(db, deal, "hardware", f"Перегрев: {nm}, GPU {g2['idx']} — {g2['temp']} °C",
                       "Температура выше 85 °C ускоряет износ и снижает стоимость залога", "medium", now, "Проверить охлаждение и нагрузку"))
    return new


def engine_c2(v):
    return f"{v:.2f}".replace(".", ",")


def _pl(n, a, b, c):
    m, k = n % 100, n % 10
    return c if 10 < m < 20 else a if k == 1 else b if 1 < k < 5 else c


# ---------- представление и решения ----------

def view(db: dict, n: dict, user: dict) -> dict:
    deal = db["deals"].get(n["deal_id"])
    perm = users.DECIDE_PERM.get(n["kind"], "view")
    can = users.can(user, perm) and n["kind"] != "ready" or n["kind"] == "ready"
    open_ = n["status"] in OPEN_STATES
    dec = n.get("decision")
    parts = [n.get("unit") or ""]
    if n.get("assignee") or (dec and dec.get("by")):
        parts.append(n.get("assignee") or dec["by"])
    state = STATE_LABEL[n["status"]]
    if n["status"] == "watching" and n.get("wake_at"):
        state += " до " + time.strftime("%d.%m.%Y", time.localtime(n["wake_at"]))
    parts.append(state)
    out = {k: v for k, v in n.items() if k not in ("author",)}
    out.update(borrower=deal["borrower"] if deal else "—", meta=", ".join(p for p in parts if p),
               can_decide=bool(open_ and can and n["kind"] != "ready" or (open_ and n["kind"] == "ready")),
               actions=[dict(id=a, label=l, primary=i == 0) for i, (a, l) in enumerate(ACTIONS.get(n["kind"], []))] if open_ and can else [])
    return out


def apply_decision(db: dict, nid: str, action: str, payload: dict, user: dict, request_id: str | None = None) -> dict:
    """Возвращает уведомление. ValueError — неверные данные, PermissionError — нет прав, LookupError — нет такого,
    ConflictError — решение уже принято другим сотрудником."""
    reqs = db.setdefault("requests", {})
    if request_id and request_id in reqs:   # повтор после сбоя сети: тот же результат, без дубля письма
        return reqs[request_id]
    n = next((x for x in db["notifications"] if x["id"] == nid), None)
    if not n:
        raise LookupError("Уведомление не найдено")
    if not users.can(user, users.DECIDE_PERM.get(n["kind"], "view")):
        raise PermissionError("Нет прав на это решение")
    if n["status"] not in OPEN_STATES:
        raise ConflictError(n)
    spec = next((a for a in ACTIONS.get(n["kind"], []) if a[0] == action), None)
    if not spec:
        raise ValueError("Действие недоступно")
    deal = db["deals"].get(n["deal_id"], {})
    now = time.time()
    p = payload or {}
    text = ""
    if action == "request":
        amount = _num(p.get("amount"), "Введите сумму обеспечения")
        due = _date(p.get("due"), "Укажите срок")
        who = _staff(db, p.get("responsible"))
        msg = str(p.get("message", "")).strip()
        text = f"Запрошено обеспечение {fm(amount)} млн ₽ до {dmy(due)}"
        _mail_contact(db, deal, user, "Запрос дополнительного обеспечения", msg or f"Просим предоставить дополнительное обеспечение до {dmy(due)}.")
        n["assignee"] = who
        toast = "Запрос отправлен заёмщику. Решение сохранено"
    elif action == "inspect":
        due = _date(p.get("date"), "Укажите дату проверки")
        who = _staff(db, p.get("responsible"))
        text = f"Назначена выездная проверка на {dmy(due)}" + ("; выдача траншей приостановлена" if p.get("suspend") else "")
        n["assignee"] = who
        if p.get("suspend"):
            deal["tranches_suspended"] = True
        toast = "Проверка назначена. Решение сохранено"
    elif action == "watch":
        due = _date(p.get("date"), "Укажите дату повторной проверки")
        text = f"Оставлено на наблюдении до {dmy(due)}" + (f". {p['comment']}" if str(p.get("comment", "")).strip() else "")
        n["status"] = "watching"
        n["wake_at"] = time.mktime(date.fromisoformat(due).timetuple())
        toast = "Сохранено. В указанную дату уведомление вернётся в «Ждут решения»"
    elif action == "reassess":
        text = "Назначена переоценка"
        toast = "Переоценка назначена. Решение сохранено"
    elif action == "params":
        text = "Условия кредита будут пересмотрены"
        toast = "Решение сохранено"
    elif action == "write_cod":
        text = "Письмо в ЦОД отправлено"
        toast = "Решение сохранено"
    elif action == "open":
        text = "Открыто"
        toast = ""
    else:
        raise ValueError("Действие недоступно")
    if n["status"] != "watching":
        n["status"] = "closed" if n["kind"] == "ready" else "decided"
    n["decision"] = dict(text=text, by=user["short"], ts=now, action=action, payload=p)
    n["unit"] = n.get("unit") or users.ROLES[user["role"]]
    db.setdefault("events", []).append(dict(ts=now, user=user["email"], notification=nid, action=action, payload=p))
    res = dict(notification=view(db, n, user), toast=toast)
    if request_id:
        reqs[request_id] = res
    return res


class ConflictError(Exception):
    def __init__(self, n):
        super().__init__("Уведомление обновилось: решение уже принято")
        self.notification = n


def _num(v, msg):
    try:
        x = float(str(v).replace(" ", "").replace(",", "."))
    except ValueError:
        raise ValueError(msg) from None
    if x <= 0:
        raise ValueError(msg)
    return x


def _date(v, msg):
    try:
        d = date.fromisoformat(str(v))
    except ValueError:
        raise ValueError(msg) from None
    if d < date.today():
        raise ValueError("Дата не может быть раньше сегодняшней")
    return d.isoformat()


def _staff(db, email):
    u = next((x for x in db["users"] if x["email"] == email or x["short"] == email), None)
    return u["short"] if u else None


def _mail_contact(db, deal, user, subject, body):
    to = deal.get("contact_email")
    if not to:
        return None
    return mailer.send(db, to, subject, body, user["email"], "borrower", deal.get("id"))

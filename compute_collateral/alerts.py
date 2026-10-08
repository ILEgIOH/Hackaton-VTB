"""Уведомления: правила создают их по состоянию сделок, аналитик принимает решения."""
from __future__ import annotations

import time

from . import engine

ACTIONS = {
    "swap": [("inspect", "Назначить проверку", "Назначена выездная проверка"), ("request", "Запросить обеспечение", "Запрошено обеспечение")],
    "covenant": [("request", "Запросить обеспечение", "Запрошено дополнительное обеспечение"), ("reassess", "Назначить переоценку", "Назначена переоценка")],
    "threshold": [("reassess", "Назначить переоценку", "Назначена переоценка"), ("watch", "Наблюдать", "Взято под наблюдение")],
    "forecast": [("params", "Изменить параметры", "Параметры кредита будут пересмотрены"), ("watch", "Наблюдать", "Взято под наблюдение")],
    "hardware": [("inspect", "Назначить проверку", "Назначена выездная проверка"), ("watch", "Наблюдать", "Взято под наблюдение")],
    "link": [],
}
LABELS = dict(swap="Подмена оборудования", covenant="Нарушение ковенанта", threshold="Близко к порогу",
              forecast="Прогноз", hardware="Состояние оборудования", link="Связь с сервером")
RECOMMEND = dict(swap="Выездная проверка, приостановить выдачу траншей", forecast=None, covenant=None,
                 threshold="Назначить переоценку", hardware="Проверить охлаждение и нагрузку")


def _open(db, key):
    return next((n for n in db["notifications"] if n["key"] == key and n["status"] != "closed"), None)


def _add(db, deal, kind, title, text, sev, now, rec=None, owner="Система"):
    n = dict(id=f"n{len(db['notifications']) + 1}", deal_id=deal["id"], kind=kind, label=LABELS[kind], title=title, text=text,
             severity=sev, owner=owner, status="new" if ACTIONS[kind] else "closed",
             actions=[dict(id=a, label=l, primary=i == 0) for i, (a, l, _) in enumerate(ACTIONS[kind])],
             ts=now, decision=None, key=f"{deal['id']}:{kind}", recommendation=rec)
    db["notifications"].append(n)
    return n


def sync(db: dict, deal: dict, now: float | None = None) -> list[dict]:
    """Создаёт недостающие уведомления по сделке и закрывает устаревшие. Возвращает новые."""
    now = now or time.time()
    if deal.get("status") != "active":
        return []
    d = engine.deal_detail(deal, now)
    new = []
    mism = d["equipment"]["mismatches"]
    if mism and not _open(db, f"{deal['id']}:swap"):
        m = mism[0]
        new.append(_add(db, deal, "swap", "Серийный номер карты не совпадает с договором",
                        f"Сервер {m['server']}, GPU {m['gpu']}. По договору s/n {m['contract']}, установлен {m['actual']}",
                        "high", now, RECOMMEND["swap"]))
    cov, covenant = d["coverage_now"], d["forecast"]["covenant"]
    if d["status"] == "breach" and not _open(db, f"{deal['id']}:covenant"):
        need = covenant * d["debt_now"] - d["valuation"]["market"]
        new.append(_add(db, deal, "covenant", f"Покрытие {cov:.2f} при ковенанте {covenant:.2f}".replace(".", ","),
                        f"Для возврата к ковенанту нужно дополнительное обеспечение на {need / 1e6:.1f} млн ₽".replace(".", ","),
                        "high", now, f"Дополнительное обеспечение на {need / 1e6:.1f} млн ₽".replace(".", ",")))
    elif d["status"] == "near" and not _open(db, f"{deal['id']}:threshold"):
        new.append(_add(db, deal, "threshold", f"Покрытие снизилось до {cov:.2f}".replace(".", ","),
                        f"Ковенант {covenant:.2f}, запас {(cov / covenant - 1) * 100:.0f} %".replace(".", ","), "medium", now,
                        RECOMMEND["threshold"]))
    if d["gap"] and not _open(db, f"{deal['id']}:forecast"):
        g = d["gap"]
        new.append(_add(db, deal, "forecast", f"Через {g['first_month']} мес. залог может стать дешевле долга",
                        f"В пессимистичном сценарии разрыв продлится {g['months']} мес. Максимум {g['max_gap'] / 1e6:.1f} млн ₽".replace(".", ","),
                        "medium", now, f"Снизить сумму до {d['recommendation']['max_loan'] / 1e6:.1f} млн ₽ или сократить срок".replace(".", ",")))
    if deal.get("telemetry_mode") == "agent":
        down = d["equipment"]["offline"]
        existing = _open(db, f"{deal['id']}:link")
        if down and not existing:
            n = _add(db, deal, "link", f"Сервер {down[0]} не выходит на связь",
                     "Агент не присылал данные более 5 минут", "low", now)
            n["status"] = "new"
            n["actions"] = [dict(id="watch", label="Наблюдать", primary=True)]
            new.append(n)
        elif existing and not down:
            existing.update(status="closed", text=existing["text"] + f". Связь восстановлена в {time.strftime('%H:%M', time.localtime(now))}",
                            owner="Система")
    hot = [(s["name"], g) for s in deal["servers"] for g in s["gpus"] if (g.get("temp") or 0) >= 85]
    if hot and not _open(db, f"{deal['id']}:hardware"):
        name, g = hot[0]
        new.append(_add(db, deal, "hardware", f"Перегрев: {name}, GPU {g['idx']} — {g['temp']} °C",
                        "Температура выше 85 °C ускоряет износ и снижает стоимость залога", "medium", now, RECOMMEND["hardware"]))
    return new


def apply_action(db: dict, nid: str, action: str, user: dict) -> dict:
    n = next((x for x in db["notifications"] if x["id"] == nid), None)
    if not n:
        raise KeyError("Уведомление не найдено")
    spec = next((a for a in ACTIONS.get(n["kind"], []) if a[0] == action), None)
    if not spec or n["status"] in ("decided", "closed"):
        raise ValueError("Действие недоступно")
    n["status"] = "decided"
    n["decision"] = f"{spec[2]}, {time.strftime('%d.%m.%Y')}"
    n["owner"] = user["name"]
    db["events"].append(dict(ts=time.time(), user=user["email"], notification=nid, action=action))
    return n

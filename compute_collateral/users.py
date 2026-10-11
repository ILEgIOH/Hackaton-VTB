"""Роли и права (ТЗ, «Роли и доступ»). Учётные записи и роли выдаёт банк; здесь — демо-набор."""
from __future__ import annotations

ROLES = {
    "analyst": "Кредитный аналитик",
    "risk": "Управление рисков",
    "collateral": "Залоговая служба",
    "leasing": "ВТБ Лизинг",
}

# действие -> какие роли могут
PERMS = {
    "view": {"analyst", "risk", "collateral", "leasing"},
    "create_assessment": {"analyst"},
    "edit_terms": {"analyst"},
    "reassess": {"analyst", "collateral"},
    "export": {"analyst", "risk", "collateral", "leasing"},
    "upload_docs": {"analyst", "collateral"},
    "decide_equipment": {"collateral"},          # подмена, связь с сервером
    "decide_covenant": {"risk", "collateral"},   # нарушение ковенанта
    "decide_forecast": {"analyst", "risk"},      # прогноз, близко к порогу
    "write_cod": {"analyst", "collateral"},
    "edit_thresholds": {"risk"},
    "own_notify_settings": {"analyst", "risk", "collateral", "leasing"},
    "ai_settings": {"analyst", "risk"},
}

# какой вид решения нужен для типа уведомления
DECIDE_PERM = {"swap": "decide_equipment", "link": "decide_equipment", "hardware": "decide_equipment",
               "covenant": "decide_covenant", "threshold": "decide_forecast", "forecast": "decide_forecast", "ready": "view"}

# кому приходит уведомление (колонка «Кому приходит» в настройках)
RECIPIENTS = {"swap": ["collateral"], "link": ["collateral"], "hardware": ["collateral"], "covenant": ["collateral", "risk"],
              "threshold": ["risk"], "forecast": ["analyst", "risk"], "ready": ["author"]}
UNIT = {"swap": "Залоговая служба", "link": "Залоговая служба", "hardware": "Залоговая служба", "covenant": "Залоговая служба",
        "threshold": "Управление рисков", "forecast": "Аналитик", "ready": "Система"}

NOTIFY_TYPES = [  # порядок и подписи как на экране «Настройки уведомлений»
    ("swap", "Подмена оборудования", "Залоговая служба"),
    ("covenant", "Нарушение ковенанта", "Залоговая служба, управление рисков"),
    ("forecast", "Прогноз ухудшился", "Аналитик, управление рисков"),
    ("threshold", "Близко к порогу", "Управление рисков"),
    ("link", "Нет связи с сервером", "Залоговая служба"),
    ("ready", "Оценка готова", "Автор оценки"),
]
DEFAULT_NOTIFY = {"swap": (True, True), "covenant": (True, True), "forecast": (True, False), "threshold": (True, False),
                  "link": (True, False), "ready": (True, False), "hardware": (True, False)}


def can(user: dict | None, perm: str) -> bool:
    return bool(user) and user["role"] in PERMS.get(perm, set())


def can_map(user: dict) -> dict:
    return {p: user["role"] in roles for p, roles in PERMS.items()}


def public(user: dict) -> dict:
    return dict(email=user["email"], name=user["name"], short=user["short"], initials=user["initials"], role=user["role"],
                role_label=ROLES[user["role"]], can=can_map(user))


def notify_pref(user: dict, kind: str) -> dict:
    p = (user.get("notify") or {}).get(kind)
    if p is None:
        a, e = DEFAULT_NOTIFY.get(kind, (True, False))
        return dict(app=a, email=e)
    return dict(app=bool(p.get("app", True)), email=bool(p.get("email", False)))

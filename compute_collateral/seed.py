"""Демо-данные: портфель из шести сделок по макету."""
from __future__ import annotations

import random
import secrets
import time
from datetime import date

from . import alerts, engine
from .parsers import make_inn
from .store import hash_password
from . import market

DEMO_EMAIL, DEMO_PASSWORD = "e.sokolova@bank.ru", "Compute2026"
STAFF = [  # (почта, имя, коротко, инициалы, роль)
    ("e.sokolova@bank.ru", "Екатерина Соколова", "Е. Соколова", "ЕС", "analyst"),
    ("a.kim@bank.ru", "Алексей Ким", "А. Ким", "АК", "risk"),
    ("m.orlova@bank.ru", "Мария Орлова", "М. Орлова", "МО", "collateral"),
    ("i.petrov@bank.ru", "Игорь Петров", "И. Петров", "ИП", "collateral"),
    ("leasing@bank.ru", "Сотрудник ВТБ Лизинга", "ВТБ Лизинг", "ВЛ", "leasing"),
]
REQUISITES = {  # id -> (ИНН-основа, заявка, контакт, почта)
    "datafork": ("234010101", "КД-2026-0311", "Олег Лебедев", "o.lebedev@dataforge.example"),
    "sibcomp": ("540210202", "КД-2026-0287", "Нина Ким", "n.kim@sibvych.example"),
    "neuroset": ("667010303", "КД-2026-0377", "Павел Зуев", "p.zuev@neuroset.example"),
    "neurocluster": ("770123456", "КД-2026-0418", "Андрей Морозов", "a.morozov@neurocluster.example"),
    "quantcloud": ("780210404", "КД-2026-0345", "Анна Фомина", "a.fomina@quant.example"),
    "technocod": ("770710505", "КД-2026-0301", "Сергей Лукин", "s.lukin@technocod.example"),
}

# (id, заёмщик, модель, серверов, локация, целевое покрытие, прошло мес., срок, ставка, особенности)
DEALS = [
    ("datafork", "ООО «ДатаФорж»", "L40S", 6, "ЦОД «Юг-1», Краснодар", 1.06, 8, 24, 19.0, {}),
    ("sibcomp", "АО «Сибирские вычисления»", "A100", 8, "ЦОД «Сибирь», Новосибирск", 1.32, 7, 36, 17.5, {}),
    ("neuroset", "ООО «Нейросеть Регион»", "H100", 3, "ЦОД «Урал», Екатеринбург", 1.33, 5, 36, 18.0, {"swap": ("srv-02", 5)}),
    ("neurocluster", "ООО «Нейрокластер»", "H100", 4, "ЦОД «Север-2», Москва", None, 0, 36, 18.0,
     {"amount": 60_000_000, "hours": (6120, 6340, 7010, 5980), "temps": (64, 67, 72, 62), "utils": (87, 91, 94, 83),
      "issue": date(2026, 10, 15), "contract": "КД-2026-0418"}),
    ("quantcloud", "ООО «Квант Облако»", "H200", 2, "ЦОД «Балт», Санкт-Петербург", 1.66, 6, 36, 17.0, {}),
    ("technocod", "ПАО «ТехноЦОД»", "A100", 5, "ЦОД «Центр», Москва", 2.03, 9, 36, 16.5, {}),
]

BASE_SERIAL = 1654023118421
SERIAL_BASES = {"datafork": 1654011118421, "sibcomp": 1654012118421, "neuroset": 1654013118421, "neurocluster": 1654023118421,
                "quantcloud": 1654014118421, "technocod": 1654015118421}


def agent_key():
    al = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    return "CC-" + "".join(secrets.choice(al) for _ in range(4)) + "-" + "".join(secrets.choice(al) for _ in range(4))


def build_servers(rng, model, n_servers, serial_start, tele=True, special=None):
    special = special or {}
    servers, serial = [], serial_start
    for i in range(n_servers):
        name = f"srv-{i + 1:02d}"
        comm = date(2025, 2, 12) if i == 0 else date(2025, 6, 3) if i < 3 else date(2025, 9, 1)
        hrs = special.get("hours", (None,) * n_servers)[i] or rng.randint(5200, 7400)
        t0 = special.get("temps", (None,) * n_servers)[i] or rng.randint(60, 72)
        u0 = special.get("utils", (None,) * n_servers)[i] or rng.randint(80, 95)
        gpus = []
        for g in range(8):
            gpu = dict(idx=g, serial=str(serial), commissioned=comm.isoformat())
            if tele:
                gpu.update(actual_serial=str(serial), temp=t0 + rng.randint(-2, 2),
                           util=min(99, u0 + rng.randint(-3, 3)), hours=hrs - rng.randint(0, 4))
            gpus.append(gpu)
            serial += 1
        servers.append(dict(name=name, model=model, gpus=gpus, last_seen=time.time() if tele else None))
        serial += rng.randint(300, 600)
    return servers


def make_deal(did, borrower, model, n_servers, location, target_cov, elapsed, term, rate, extra, idx, today):
    rng = random.Random(did)
    servers = build_servers(rng, model, n_servers, SERIAL_BASES[did], special=extra)
    if "swap" in extra:
        sname, gidx = extra["swap"]
        g = next(s for s in servers if s["name"] == sname)["gpus"][gidx]
        g["serial"] = "1654023118915"
        g["actual_serial"] = "1654023887102"  # в слоте стоит чужая карта
    inn, app, contact, email = REQUISITES[did]
    deal = dict(
        id=did, borrower=borrower, inn=make_inn(inn), location=location, contract=app, application=app, contact=contact, contact_email=email,
        telemetry_mode="agent", simulated=True, status="active", servers=servers, author="e.sokolova@bank.ru",
        agent_token=secrets.token_hex(12), agent_key=agent_key(), created=date.today().isoformat(), assessments=[],
    )
    issue = extra.get("issue") or engine.add_months(today, -elapsed)
    amount = extra.get("amount")
    if amount is None:
        market = engine.valuation(deal)["market"]
        factor = engine.schedule(1.0, term, rate)[elapsed]
        amount = round(market / (target_cov * factor) / 100_000) * 100_000
    deal["loan"] = dict(amount=amount, term=term, rate=rate, schedule="annuity",
                        issue_date=issue.isoformat(), covenant=1.25)
    return deal


def snapshot(deal, now, factor=1.0, author="Е. Соколова"):
    v = engine.valuation(deal, now)
    fc = engine.forecast(deal, val=v)
    rec = engine.recommend_ltv(fc, v["market"])
    return dict(ts=now, author=author, market=v["market"] * factor, liquidation=v["liquidation"] * factor, ltv=rec["ltv"], wear=v["wear"], cards=v["cards"])


def seed(store):
    today = date.today()
    deals = {d[0]: make_deal(*d[:9], d[9], i, today) for i, d in enumerate(DEALS)}
    now = time.time()
    market_state = dict(factors={k: 1.0 for k in market.MODELS}, updated=today.isoformat())
    market.apply_state(market_state)
    for d in deals.values():   # предыдущая оценка, от неё считается «было → стало» при переоценке
        d["assessments"].append(snapshot(d, now - 3 * 86400, 1.0245 if d["id"] == "neurocluster" else 1.01))
    db = dict(
        users=[dict(email=e, name=n, short=sh, initials=i, role=r, password=hash_password(DEMO_PASSWORD), notify={}) for e, n, sh, i, r in STAFF],
        deals=deals, notifications=[], documents={}, ai_reports={}, events=[], outbox=[], requests={}, market=market_state,
        settings=dict(ai=dict(enabled=False, base_url="https://api.openai.com/v1", api_key="",
                              model="gpt-4o-mini", interval_min=30),
                      simulate=True, thresholds=dict(engine.TH)),
    )
    store.db = db
    day = 86400

    def n(deal, kind, title, text, sev, unit, assignee, status, hours_ago, rec=None, decision=None, wake_days=None):
        db["notifications"].append(dict(
            id=f"n{len(db['notifications']) + 1}", deal_id=deal, kind=kind, label=alerts.LABELS[kind], title=title, text=text, severity=sev,
            ts=now - hours_ago * 3600, status=status, recommendation=rec, unit=unit, assignee=assignee, decision=decision,
            wake_at=(now + wake_days * day) if wake_days else None, key=f"{deal}:{kind}", author=None))
    n("neuroset", "swap", "Серийный номер карты не совпадает с договором", "Сервер srv-02, GPU 5. По договору s/n 1654023118915, установлен 1654023887102",
      "high", "Залоговая служба", "М. Орлова", "in_work", 32, "Выездная проверка, приостановить выдачу траншей")
    n("datafork", "covenant", "Покрытие 1,06 при ковенанте 1,25", "Ставки аренды L40S упали на 18 % за квартал, оценка снизилась на 4,1 млн ₽",
      "high", "Залоговая служба", "И. Петров", "new", 24, "Дополнительное обеспечение на 7,2 млн ₽")
    n("neurocluster", "forecast", "Через 10 месяцев залог может стать дешевле долга", "После выхода нового поколения чипов цены H100 могут упасть ещё на 15 %",
      "medium", "Аналитик", "Е. Соколова", "new", 21, "Снизить сумму до 49,3 млн ₽ или сократить срок")
    n("sibcomp", "threshold", "Покрытие снизилось до 1,32", "Цены дилеров на A100 упали на 9 % за месяц", "medium", "Управление рисков", "А. Ким", "decided", 72,
      decision=dict(text="Назначена переоценка, " + today.strftime("%d.%m.%Y"), by="А. Ким", ts=now - 70 * 3600, action="reassess", payload={}))
    n("technocod", "link", "Сервер srv-07 не передавал данные 3 часа", "Плановые работы в ЦОДе, связь восстановлена в 14:20", "low", "Система", None, "closed", 168)
    n("neuroset", "threshold", "Покрытие снизилось до 1,33", "Ковенант 1,25, запас 6 %", "medium", "Управление рисков", "А. Ким", "decided", 96,
      decision=dict(text="Назначена переоценка, " + (today).strftime("%d.%m.%Y"), by="А. Ким", ts=now - 90 * 3600, action="reassess", payload={}))
    n("neuroset", "forecast", "Через 9 месяцев залог может стать дешевле долга", "В пессимистичном сценарии разрыв продлится 20 мес.", "medium", "Аналитик", "Е. Соколова",
      "watching", 120, "Снизить сумму или сократить срок", decision=dict(text="Оставлено на наблюдении", by="Е. Соколова", ts=now - 100 * 3600, action="watch", payload={}), wake_days=20)
    return db

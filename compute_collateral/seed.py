"""Демо-данные: портфель из шести сделок по макету."""
from __future__ import annotations

import random
import secrets
import time
from datetime import date

from . import engine
from .store import hash_password

DEMO_EMAIL, DEMO_PASSWORD = "e.sokolova@bank.ru", "Compute2026"

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
    servers = build_servers(rng, model, n_servers, BASE_SERIAL + idx * 100_000, special=extra)
    if "swap" in extra:
        sname, gidx = extra["swap"]
        g = next(s for s in servers if s["name"] == sname)["gpus"][gidx]
        g["serial"] = "1654023118915"
        g["actual_serial"] = "1654023887102"  # в слоте стоит чужая карта
    deal = dict(
        id=did, borrower=borrower, location=location, contract=extra.get("contract", f"КД-2026-{300 + idx * 37:04d}"),
        telemetry_mode="agent", simulated=True, status="active", servers=servers,
        agent_token=secrets.token_hex(12), created=date.today().isoformat(),
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


def seed(store):
    today = date.today()
    deals = {d[0]: make_deal(*d[:9], d[9], i, today) for i, d in enumerate(DEALS)}
    db = dict(
        users=[dict(email=DEMO_EMAIL, name="Е. Соколова", initials="ЕС", role="Кредитный аналитик",
                    password=hash_password(DEMO_PASSWORD))],
        deals=deals, notifications=[], documents={}, ai_reports={}, events=[],
        settings=dict(ai=dict(enabled=False, base_url="https://api.openai.com/v1", api_key="",
                              model="gpt-4o-mini", interval_min=30),
                      simulate=True),
    )
    store.db = db
    # демонстрационные уведомления из макета; остальные добавляет монитор
    now = time.time()
    day = 86400

    def n(deal, kind, label, title, text, sev, owner, status, actions, hours_ago, decision=None):
        db["notifications"].append(dict(
            id=f"n{len(db['notifications']) + 1}", deal_id=deal, kind=kind, label=label, title=title, text=text,
            severity=sev, owner=owner, status=status, actions=actions, ts=now - hours_ago * 3600,
            decision=decision, key=f"{deal}:{kind}"))
    n("neuroset", "swap", "Подмена оборудования", "Серийный номер карты не совпадает с договором",
      "Сервер srv-02, GPU 5. По договору s/n 1654023118915, установлен 1654023887102", "high",
      "Залоговая служба, М. Орлова", "in_work",
      [dict(id="inspect", label="Назначить проверку", primary=True), dict(id="request", label="Запросить обеспечение")],
      32, None)
    n("datafork", "covenant", "Нарушение ковенанта", "Покрытие 1,06 при ковенанте 1,25",
      "Ставки аренды L40S упали на 18 % за квартал, оценка снизилась на 4,1 млн ₽", "high",
      "Залоговая служба, И. Петров", "new",
      [dict(id="request", label="Запросить обеспечение", primary=True), dict(id="reassess", label="Назначить переоценку")],
      24)
    n("neurocluster", "forecast", "Прогноз", "Через 10 месяцев залог может стать дешевле долга",
      "После выхода нового поколения чипов цены H100 могут упасть ещё на 15 %", "medium", "Е. Соколова", "new",
      [dict(id="params", label="Изменить параметры", primary=True), dict(id="watch", label="Наблюдать")], 21)
    n("sibcomp", "threshold", "Близко к порогу", "Покрытие снизилось до 1,32", "Цены дилеров на A100 упали на 9 % за месяц",
      "medium", "Управление рисков, А. Ким", "decided", [], 3 * day / 3600, decision="Назначена переоценка")
    n("technocod", "link", "Связь с сервером", "Сервер srv-07 не выходил на связь 3 часа",
      "Плановые работы в ЦОДе, связь восстановлена в 14:20", "low", "Система", "closed", [], 7 * day / 3600)
    return db

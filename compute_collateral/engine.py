"""Движок оценки: три подхода, износ, сценарии цены, график долга, ковенанты, рекомендуемый LTV."""
from __future__ import annotations

from calendar import monthrange
import time as _time
from collections import Counter, defaultdict
from datetime import date

from .market import MODELS, LOW_DATA_DEALERS

WEIGHTS = dict(cost=0.30, comparative=0.40, income=0.30)
LOW_DATA_WEIGHTS = dict(cost=0.40, comparative=0.25, income=0.35)   # мало цен по модели (ТЗ, «Логика расчётов»)
LIQUIDATION_DISCOUNT = 0.28
NO_TELEMETRY_HAIRCUT = 0.07
LTV_CAP = 0.75
SCENARIOS = ("opt", "base", "pess")
# пороги задаёт управление рисков (экран «Настройки уведомлений»)
TH = dict(covenant=1.25, near=1.40, offline_warn_h=1.0, offline_notify_h=24.0)


# ---------- даты и график платежей ----------

def add_months(d: date, k: int) -> date:
    idx = d.month - 1 + k
    y, m = d.year + idx // 12, idx % 12 + 1
    return date(y, m, min(d.day, monthrange(y, m)[1]))


def months_between(a: date, b: date) -> int:
    k = (b.year - a.year) * 12 + b.month - a.month
    return k - 1 if b.day < a.day else k


def schedule(amount: float, term: int, rate: float, kind: str = "annuity"):
    """Остаток долга после k-го платежа, k = 0..term."""
    bal = [float(amount)]
    if kind == "differentiated":
        for k in range(1, term + 1):
            bal.append(amount * (1 - k / term))
        return bal
    r = rate / 100 / 12
    pay = amount / term if r == 0 else amount * r / (1 - (1 + r) ** -term)
    b = float(amount)
    for _ in range(term):
        b = max(0.0, b * (1 + r) - pay)
        bal.append(b)
    bal[-1] = 0.0
    return bal


# ---------- износ ----------

def gpu_wear(g: dict) -> float:
    """Поправка на износ одной карты, доля (0.016 = 1,6 %)."""
    hours = g.get("hours") or 0
    temp = g.get("temp") or 0
    util = g.get("util") or 0
    w = hours / 1000 * 0.0026
    w += max(0, temp - 65) * 0.0015
    w += max(0, util - 92) * 0.001
    return round(min(w, NO_TELEMETRY_HAIRCUT), 4)


def has_telemetry(g: dict) -> bool:
    return g.get("temp") is not None


def server_wear(deal: dict, server: dict, now: float | None = None) -> float:
    now = now or _time.time()
    ws = [card_wear(deal, server, g, now) for g in server["gpus"]]
    return sum(ws) / len(ws) if ws else NO_TELEMETRY_HAIRCUT


def silent_seconds(server: dict, now: float) -> float:
    ls = server.get("last_seen")
    return float("inf") if not ls else now - ls


def is_silent(deal: dict, server: dict, now: float) -> bool:
    """Агент молчит дольше порога «предупредить» — карты сервера оцениваются с поправкой 7 %."""
    return deal.get("telemetry_mode") == "agent" and silent_seconds(server, now) > TH["offline_warn_h"] * 3600


def card_wear(deal: dict, server: dict, g: dict, now: float) -> float:
    if deal.get("telemetry_mode") in (None, "none") or not has_telemetry(g) or is_silent(deal, server, now):
        return NO_TELEMETRY_HAIRCUT
    return gpu_wear(g)


def deal_wear(deal: dict, now: float | None = None) -> float:
    now = now or _time.time()
    ws = [card_wear(deal, s, g, now) for s in deal["servers"] for g in s["gpus"]]
    return sum(ws) / len(ws) if ws else NO_TELEMETRY_HAIRCUT


# ---------- оценка ----------

RENT_DECAY, DISCOUNT, SERVICE_YEARS = 0.30, 0.22, 3


def income_per_card(m: dict) -> float:
    """Доход от аренды за оставшийся срок службы: ставка × 8760 × загрузка, ставки падают на 30 % в год, дисконт 22 %."""
    year = m["rent"] * 8760 * m["util"]
    return sum(year * (1 - RENT_DECAY) ** t / (1 + DISCOUNT) ** (t + 1) for t in range(SERVICE_YEARS))


def card_counts(deal: dict) -> Counter:
    c = Counter()
    for s in deal["servers"]:
        for g in s["gpus"]:
            c[s["model"]] += 1
    return c


def valuation(deal: dict, now: float | None = None) -> dict:
    counts = card_counts(deal)
    wear = deal_wear(deal, now)
    cost = comp = inc = 0.0
    per_model = {}
    low_data = []
    for model, n in counts.items():
        m = MODELS[model]
        c = n * m["new"]
        low = m["dealers"] < LOW_DATA_DEALERS
        cp = n * (m["world"] if low else m["secondary"])
        ic = n * income_per_card(m)
        if low:
            low_data.append(model)
        w = LOW_DATA_WEIGHTS if low else WEIGHTS
        blended = w["cost"] * c + w["comparative"] * cp + w["income"] * ic
        per_model[model] = dict(cards=n, cost=c, comparative=cp, income=ic,
                                weighted=blended, market=blended * (1 - wear))
        cost, comp, inc = cost + c, comp + cp, inc + ic
    weighted = sum(pm["weighted"] for pm in per_model.values())
    market = weighted * (1 - wear)
    cards = sum(counts.values())
    return dict(
        cost=cost, comparative=comp, income=inc, weighted=weighted, wear=wear,
        market=market, liquidation=market * (1 - LIQUIDATION_DISCOUNT),
        per_card=market / cards if cards else 0, cards=cards, per_model=per_model,
        low_data=low_data, weights=WEIGHTS, liquidation_discount=LIQUIDATION_DISCOUNT,
    )


def scenario_factor(model: str, scen: str, month: int) -> float:
    s = MODELS[model]["scen"]
    if scen == "opt":
        return (1 - s["opt"]) ** (month / 12)
    if scen == "base":
        return (1 - s["base"]) ** (month / 12)
    f = (1 - s["pess1"]) ** (min(month, 12) / 12) * (1 - s["pess2"]) ** (max(month - 12, 0) / 12)
    if s["newgen_month"] is not None and month >= s["newgen_month"]:
        f *= 1 - s["newgen_drop"]
    return f


# ---------- прогноз покрытия ----------

def loan_params(loan: dict) -> dict:
    return dict(amount=float(loan["amount"]), term=int(loan["term"]), rate=float(loan["rate"]),
                kind=loan.get("schedule", "annuity"), covenant=float(loan.get("covenant", 1.25)),
                issue_date=loan["issue_date"] if isinstance(loan["issue_date"], date)
                else date.fromisoformat(loan["issue_date"]))


def forecast(deal: dict, loan: dict | None = None, today: date | None = None, val: dict | None = None) -> dict:
    today = today or date.today()
    lp = loan_params(loan or deal["loan"])
    val = val or valuation(deal)
    sched = schedule(lp["amount"], lp["term"], lp["rate"], lp["kind"])
    elapsed = max(0, months_between(lp["issue_date"], today))
    elapsed = min(elapsed, lp["term"])
    start = today if elapsed > 0 else lp["issue_date"]
    n = lp["term"] - elapsed
    pts = []
    for m in range(n + 1):
        row = dict(m=m, date=add_months(start, m).isoformat(), debt=sched[elapsed + m])
        for scen in SCENARIOS:
            row[scen] = sum(pm["market"] * scenario_factor(model, scen, m)
                            for model, pm in val["per_model"].items())
        pts.append(row)
    liq = 1 - LIQUIDATION_DISCOUNT
    for p in pts:
        for scen in SCENARIOS:
            p[scen + "_liq"] = p[scen] * liq
    return dict(points=pts, elapsed=elapsed, covenant=lp["covenant"], amount=lp["amount"],
                term=lp["term"], rate=lp["rate"])


def coverage(value: float, debt: float):
    return None if debt <= 1 else value / debt


def pessimistic_gap(pts: list[dict]):
    gaps = [(p["m"], p["debt"] - p["pess"]) for p in pts if p["debt"] > 1 and p["pess"] < p["debt"]]
    if not gaps:
        return None
    first, last = gaps[0][0], gaps[-1][0]
    mx = max(g[1] for g in gaps)
    return dict(first_month=first, first_date=pts[first]["date"], months=last - first + 1,
                max_gap=mx, last_date=pts[last]["date"])


def recommend_ltv(fc: dict, market: float, scen: str = "pess", basis: str = "market") -> dict:
    """Наибольшая сумма, при которой в выбранном сценарии долг каждый месяц не выше стоимости залога.
    basis="liquidation": стоимость берётся ×0,72. LTV = сумма / текущая рыночная стоимость, не выше 75 %."""
    key = scen + ("_liq" if basis == "liquidation" else "")
    pts = fc["points"]
    covs = [p[key] / p["debt"] for p in pts if p["debt"] > 1]
    min_cov = min(covs) if covs else 99.0
    max_loan = fc["amount"] * min_cov
    if market and max_loan > LTV_CAP * market:
        max_loan = LTV_CAP * market
    rec_ltv = max_loan / market if market else 0
    return dict(max_loan=max_loan, ltv=rec_ltv, requested_ltv=fc["amount"] / market if market else 0,
                exceeds=fc["amount"] > max_loan + 1, min_pess_coverage=min_cov, headroom=max_loan - fc["amount"])


def half_year_table(fc: dict) -> list[dict]:
    pts = fc["points"]
    rows = []
    for p in pts:
        if p["m"] == 0 or p["m"] % 6:
            continue
        paid = p["debt"] <= 1
        rows.append(dict(date=p["date"], debt=p["debt"], paid=paid,
                         base=None if paid else p["base"] / p["debt"],
                         pess=None if paid else p["pess"] / p["debt"]))
    return rows


# ---------- состояние оборудования ----------

def serial_mismatches(deal: dict) -> list[dict]:
    out = []
    for s in deal["servers"]:
        for g in s["gpus"]:
            a = g.get("actual_serial")
            if a and a != g["serial"]:
                out.append(dict(server=s["name"], gpu=g["idx"], contract=g["serial"], actual=a))
    return out


def is_online(server: dict, now: float, warn_h: float | None = None) -> bool:
    """На связи: данные приходили не позднее порога «сервер молчит, предупредить» (по ТЗ — 1 час)."""
    ls = server.get("last_seen")
    return bool(ls) and now - ls <= (warn_h if warn_h is not None else TH["offline_warn_h"]) * 3600


def equipment_state(deal: dict, now: float) -> dict:
    mism = serial_mismatches(deal)
    mode = deal.get("telemetry_mode")
    offline = [s["name"] for s in deal["servers"] if mode == "agent" and not is_online(s, now)]
    total = sum(len(s["gpus"]) for s in deal["servers"])
    seen = sum(1 for s in deal["servers"] for g in s["gpus"] if g.get("actual_serial"))
    matched = sum(1 for s in deal["servers"] for g in s["gpus"] if g.get("actual_serial") == g["serial"])
    if mism:
        label, code = "Подмена", "swap"
    elif offline:
        label, code = "Нет связи", "offline"
    elif mode == "none" or not seen:
        label, code = "Нет данных", "nodata"
    else:
        label, code = "На месте", "ok"
    silent = [dict(server=s["name"], cards=len(s["gpus"]), hours=silent_seconds(s, now) / 3600 if s.get("last_seen") else None,
                   last_seen=s.get("last_seen")) for s in deal["servers"] if s["name"] in offline]
    online_n = sum(1 for s in deal["servers"] if mode == "agent" and is_online(s, now))
    return dict(code=code, label=label, mismatches=mism, offline=offline, silent=silent, online=online_n, servers=len(deal["servers"]),
                total=total, matched=matched, seen=seen)


def near_level(covenant: float) -> float:
    return covenant * TH["near"] / TH["covenant"]


def status_of(cov_now: float | None, covenant: float) -> str:
    if cov_now is None:
        return "ok"
    if cov_now < covenant:
        return "breach"
    if cov_now < near_level(covenant):
        return "near"
    return "ok"


def deal_summary(deal: dict, now: float, today: date | None = None) -> dict:
    """Лёгкая сводка для портфеля."""
    val = valuation(deal, now)
    fc = forecast(deal, today=today, val=val)
    p0 = fc["points"][0]
    cov_now = coverage(val["market"], p0["debt"])
    p12 = fc["points"][min(12, len(fc["points"]) - 1)]
    cov12 = coverage(p12["pess"], p12["debt"])
    eq = equipment_state(deal, now)
    models = Counter()
    for s in deal["servers"]:
        models[s["model"]] += len(s["gpus"])
    top = models.most_common(1)[0] if models else ("", 0)
    return dict(
        id=deal["id"], borrower=deal["borrower"], market=val["market"], debt=p0["debt"],
        coverage=cov_now, coverage12=cov12, equipment=eq["label"], equipment_code=eq["code"],
        status=status_of(cov_now, fc["covenant"]), covenant=fc["covenant"],
        title=f"{sum(models.values())} × {top[0]}" if len(models) == 1 else
        " + ".join(f"{n} × {m}" for m, n in models.items()),
    )


def deal_detail(deal: dict, now: float, today: date | None = None) -> dict:
    val = valuation(deal, now)
    fc = forecast(deal, today=today, val=val)
    pts = fc["points"]
    p0 = pts[0]
    cov_now = coverage(val["market"], p0["debt"])
    rec = recommend_ltv(fc, val["market"])
    gap = pessimistic_gap(pts)
    gap12 = pessimistic_gap([p for p in pts if p["m"] <= 12])
    eq = equipment_state(deal, now)
    sc = {}
    for model in val["per_model"]:
        s = MODELS[model]["scen"]
        sc[model] = dict(pess1=s["pess1"], newgen_drop=s["newgen_drop"], newgen_month=s["newgen_month"])
    return dict(valuation=val, forecast=fc, coverage_now=cov_now, status=status_of(cov_now, fc["covenant"]),
                recommendation=rec, gap=gap, gap12=gap12, equipment=eq, half_year=half_year_table(fc),
                scenario_notes=sc, debt_now=p0["debt"])


def servers_view(deal: dict, now: float) -> list[dict]:
    mode = deal.get("telemetry_mode")
    out = []
    for s in deal["servers"]:
        gpus = s["gpus"]
        tele = [g for g in gpus if has_telemetry(g)]
        out.append(dict(
            name=s["name"], model=s["model"], cards=len(gpus),
            hours=round(sum(g.get("hours") or 0 for g in tele) / len(tele)) if tele else None,
            util=round(sum(g["util"] for g in tele) / len(tele)) if tele else None,
            temp=round(sum(g["temp"] for g in tele) / len(tele)) if tele else None,
            wear=server_wear(deal, s, now) if mode else None,
            matched=sum(1 for g in gpus if g.get("actual_serial") == g["serial"]),
            seen=sum(1 for g in gpus if g.get("actual_serial")),
            online=is_online(s, now) if mode == "agent" else None,
            silent_hours=(silent_seconds(s, now) / 3600 if s.get("last_seen") else None) if mode == "agent" else None,
            last_seen=s.get("last_seen"),
            gpus=[dict(idx=g["idx"], serial=g["serial"], actual=g.get("actual_serial"), temp=g.get("temp"),
                       util=g.get("util"), hours=g.get("hours"), match=g.get("actual_serial") == g["serial"]
                       if g.get("actual_serial") else None) for g in gpus],
        ))
    return out

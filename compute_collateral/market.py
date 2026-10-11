"""Рыночные данные по GPU (цены в рублях за одну карту с долей серверной платформы)."""
from datetime import date, timedelta

CBR_RATE = 82.40

# new      — цена новой карты у дилеров (затратный подход)
# secondary — медиана сделок вторичного рынка за 90 дней (сравнительный подход)
# util     — типовая загрузка в аренде (доходный подход)
# scen     — параметры сценариев падения цены (доля в год)
MODELS = {
    "H100": dict(
        name="H100 SXM", full="H100 SXM 80 ГБ", dealers=9, median=2_650_000, world=2_400_000,
        rent=250, markup=0.18, low=2_050_000, high=3_050_000, accuracy=0.06,
        new=3_190_000, secondary=2_962_500, util=0.84,
        scen=dict(opt=0.22, base=0.316, pess1=0.50, pess2=0.50, newgen_month=8, newgen_drop=0.15),
    ),
    "H200": dict(
        name="H200", full="H200", dealers=2, median=3_400_000, world=3_250_000,
        rent=320, markup=0.18, low=3_100_000, high=3_600_000, accuracy=0.15,
        new=4_100_000, secondary=3_300_000, util=0.75,
        scen=dict(opt=0.15, base=0.25, pess1=0.45, pess2=0.40, newgen_month=10, newgen_drop=0.10),
    ),
    "A100": dict(
        name="A100 80 ГБ", full="A100 80 ГБ", dealers=11, median=1_200_000, world=1_050_000,
        rent=140, markup=0.15, low=950_000, high=1_450_000, accuracy=0.05,
        new=1_450_000, secondary=1_150_000, util=0.60,
        scen=dict(opt=0.15, base=0.22, pess1=0.35, pess2=0.35, newgen_month=None, newgen_drop=0.0),
    ),
    "L40S": dict(
        name="L40S", full="L40S", dealers=7, median=780_000, world=700_000,
        rent=90, markup=0.15, low=620_000, high=920_000, accuracy=0.07,
        new=950_000, secondary=740_000, util=0.60,
        scen=dict(opt=0.15, base=0.20, pess1=0.30, pess2=0.30, newgen_month=None, newgen_drop=0.0),
    ),
}

LOW_DATA_DEALERS = 3


def normalize_model(text: str):
    """'H100 SXM 80 ГБ' -> 'H100'. None, если модель не распознана."""
    t = (text or "").upper().replace(" ", "")
    for key in ("H200", "H100", "A100", "L40S"):
        if key in t:
            return key
    return None




# ---------- источники цены (экран «Рыночные данные», раскрытие модели) ----------
DEALERS = {
    "H100": [("Москва", 2_950_000, 1), ("Москва", 2_800_000, 2), ("Санкт-Петербург", 2_650_000, 1), ("Екатеринбург", 2_550_000, 3),
             ("Москва", 3_050_000, 2), ("Новосибирск", 2_450_000, 4), ("Казань", 2_700_000, 2), ("Москва", 2_050_000, 5), ("Краснодар", 2_600_000, 1)],
    "H200": [("Москва", 3_600_000, 3), ("Санкт-Петербург", 3_100_000, 8)],
    "A100": [("Москва", 1_450_000, 1), ("Москва", 1_350_000, 2), ("Санкт-Петербург", 1_250_000, 1), ("Казань", 1_200_000, 3), ("Екатеринбург", 1_150_000, 2),
             ("Новосибирск", 1_100_000, 4), ("Москва", 1_050_000, 2), ("Краснодар", 1_000_000, 5), ("Москва", 980_000, 1), ("Самара", 960_000, 6), ("Москва", 950_000, 3)],
    "L40S": [("Москва", 920_000, 1), ("Санкт-Петербург", 860_000, 2), ("Москва", 800_000, 2), ("Казань", 780_000, 3), ("Екатеринбург", 700_000, 4), ("Москва", 650_000, 1), ("Краснодар", 620_000, 5)],
}
WORLD_DEALS = {"H100": 14, "H200": 6, "A100": 22, "L40S": 17}
_BASE = {k: {f: m[f] for f in ("median", "world", "secondary", "new", "rent")} for k, m in MODELS.items()}


def apply_state(state: dict | None):
    """Применяет сохранённые рыночные цены (множители к базе) к MODELS."""
    f = (state or {}).get("factors", {})
    for k, m in MODELS.items():
        for fld in ("median", "world", "secondary", "new", "rent"):
            m[fld] = round(_BASE[k][fld] * f.get(k, 1.0))


def refresh_prices(state: dict, rng, today: date | None = None) -> dict:
    """Ежедневное обновление цен (демо-симуляция прайс-листов): небольшой дрейф с лёгким уклоном вниз."""
    today = today or date.today()
    prev = {k: MODELS[k]["median"] for k in MODELS}
    fac = state.setdefault("factors", {k: 1.0 for k in MODELS})
    for k in MODELS:
        fac[k] = max(0.5, fac.get(k, 1.0) * (1 + rng.uniform(-0.012, 0.006)))
    state["updated"] = today.isoformat()
    apply_state(state)
    state["last_change"] = {k: MODELS[k]["median"] / prev[k] - 1 for k in MODELS}
    return state


def market_table(state: dict | None = None):
    state = state or {}
    updated = state.get("updated") or date.today().isoformat()
    stale = (date.today() - date.fromisoformat(updated)).days > 3
    rows = []
    for key, m in MODELS.items():
        dl = DEALERS.get(key, [])
        rows.append(dict(
            key=key, model=m["full"] if key != "H100" else "H100 SXM",
            median=m["median"], world=m["world"], rent=m["rent"], markup=m["markup"],
            dealers=m["dealers"], accuracy=m["accuracy"], low=m["low"], high=m["high"],
            low_data=m["dealers"] < LOW_DATA_DEALERS,
            spread=round((m["high"] / m["low"] - 1) * 100) if m["dealers"] >= LOW_DATA_DEALERS else None,
            sources=dict(
                dealers=[dict(name=f"Дилер {i + 1}, {c}", price=round(p * m["median"] / _BASE[key]["median"]),
                              price_date=(date.fromisoformat(updated) - timedelta(days=d)).isoformat()) for i, (c, p, d) in enumerate(dl)],
                world=dict(usd=round(m["world"] / CBR_RATE), rub=m["world"], deals=WORLD_DEALS[key], rate=CBR_RATE, markup=m["markup"]),
            ),
        ))
    return dict(rows=rows, cbr_rate=CBR_RATE, updated=updated, stale=stale)

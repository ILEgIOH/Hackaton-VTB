"""Рыночные данные по GPU (цены в рублях за одну карту с долей серверной платформы)."""
from datetime import date

CBR_RATE = 82.40

# new      — цена новой карты у дилеров (затратный подход)
# secondary — медиана сделок вторичного рынка за 90 дней (сравнительный подход)
# util     — типовая загрузка в аренде (доходный подход)
# scen     — параметры сценариев падения цены (доля в год)
MODELS = {
    "H100": dict(
        name="H100 SXM", full="H100 SXM 80 ГБ", dealers=9, median=2_650_000, world=2_400_000,
        rent=250, markup=0.18, low=2_050_000, high=3_050_000, accuracy=0.06,
        new=3_190_000, secondary=2_962_500, util=0.87,
        scen=dict(opt=0.22, base=0.316, pess1=0.50, pess2=0.50, newgen_month=8, newgen_drop=0.15),
    ),
    "H200": dict(
        name="H200", full="H200", dealers=2, median=3_400_000, world=3_250_000,
        rent=320, markup=0.18, low=3_100_000, high=3_600_000, accuracy=0.15,
        new=4_100_000, secondary=3_300_000, util=0.85,
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


def market_table():
    rows = []
    for key, m in MODELS.items():
        rows.append(dict(
            key=key, model=m["full"] if key != "H100" else "H100 SXM",
            median=m["median"], world=m["world"], rent=m["rent"], markup=m["markup"],
            dealers=m["dealers"], accuracy=m["accuracy"], low=m["low"], high=m["high"],
            low_data=m["dealers"] < LOW_DATA_DEALERS,
            spread=round((m["high"] / m["low"] - 1) * 100) if m["dealers"] >= LOW_DATA_DEALERS else None,
        ))
    return dict(rows=rows, cbr_rate=CBR_RATE, updated=date.today().isoformat())

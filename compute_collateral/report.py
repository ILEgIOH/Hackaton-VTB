"""Генерация документов: заключение об оценке (HTML для печати/PDF), перечень оборудования (XLSX), телеметрия (CSV)."""
from __future__ import annotations

import csv
import html
import io
from datetime import date

from . import engine

RUB = lambda v: f"{v / 1e6:,.1f} млн ₽".replace(",", " ").replace(".", ",")
F2 = lambda v: "—" if v is None else f"{v:.2f}".replace(".", ",")
SCEN = dict(opt="Оптимистичный", base="Базовый", pess="Пессимистичный")


def conclusion_html(deal: dict, detail: dict, ai_report: dict | None, author: str) -> str:
    v, fc, rec = detail["valuation"], detail["forecast"], detail["recommendation"]
    e = html.escape
    rows = "".join(
        f"<tr><td>{r['date'][8:]}.{r['date'][5:7]}.{r['date'][:4]}</td><td>{RUB(r['debt'])}</td>"
        f"<td>{'погашен' if r['paid'] else F2(r['base'])}</td><td>{'погашен' if r['paid'] else F2(r['pess'])}</td></tr>"
        for r in detail["half_year"])
    eq = detail["equipment"]
    risks = []
    if detail["gap"]:
        g = detail["gap"]
        risks.append(f"В пессимистичном сценарии залог станет дешевле долга {g['first_date']}; разрыв продлится "
                     f"{g['months']} мес., максимум {RUB(g['max_gap'])}.")
    if rec["exceeds"]:
        risks.append(f"Запрошенная сумма {RUB(fc['amount'])} выше рекомендуемой {RUB(rec['max_loan'])} (LTV {rec['ltv'] * 100:.1f} %).")
    for m in eq["mismatches"]:
        risks.append(f"Серийный номер не совпадает: {m['server']}, GPU {m['gpu']} — по договору {m['contract']}, установлен {m['actual']}.")
    if v["low_data"]:
        risks.append("Недостаточно рыночных данных по моделям: " + ", ".join(v["low_data"]) + " — точность ±15 %.")
    if ai_report:
        risks.append("ИИ-наблюдатель: " + ai_report["summary"])
    risk_html = "".join(f"<li>{e(r)}</li>" for r in risks) or "<li>Существенных рисков не выявлено.</li>"
    return f"""<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Заключение об оценке залога — {e(deal['borrower'])}</title>
<style>body{{font:14px/1.5 Manrope,Arial,sans-serif;color:#051F45;max-width:820px;margin:32px auto;padding:0 20px}}
h1{{font-size:24px;margin:0}}h2{{font-size:16px;margin:26px 0 8px;border-bottom:1px solid #EBDCC5;padding-bottom:4px}}
table{{border-collapse:collapse;width:100%}}td,th{{padding:6px 8px;border-bottom:1px solid #EBDCC5;text-align:left}}th{{color:#3E4E68;font-weight:600}}
.big{{font-size:28px;font-weight:700}}.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}}.muted{{color:#3E4E68}}
@media print{{body{{margin:0}}}}</style></head><body>
<p class="muted">ComputeCollateral · {date.today().strftime('%d.%m.%Y')}</p>
<h1>Заключение об оценке залога</h1><p class="muted">{e(deal['borrower'])} · сделка {e(deal.get('contract', ''))} · {e(deal['location'])}<br>Подготовил: {e(author)}</p>
<div class="grid"><div><div class="muted">Рыночная стоимость</div><div class="big">{RUB(v['market'])}</div></div>
<div><div class="muted">Ликвидационная стоимость</div><div class="big">{RUB(v['liquidation'])}</div></div>
<div><div class="muted">Рекомендуемый LTV</div><div class="big">{rec['ltv'] * 100:.1f} %</div></div></div>
<h2>Параметры кредита</h2><p>Сумма {RUB(fc['amount'])}, срок {fc['term']} мес., ставка {fc['rate']} % годовых, ковенант покрытия {F2(fc['covenant'])}.
Текущее покрытие: {F2(detail['coverage_now'])}. Рекомендуемая максимальная сумма: {RUB(rec['max_loan'])}.</p>
<h2>Из чего сложилась оценка</h2><table><tr><th>Подход</th><th>Вес</th><th>Стоимость</th></tr>
<tr><td>Затратный</td><td>30 %</td><td>{RUB(v['cost'])}</td></tr><tr><td>Сравнительный</td><td>40 %</td><td>{RUB(v['comparative'])}</td></tr>
<tr><td>Доходный</td><td>30 %</td><td>{RUB(v['income'])}</td></tr><tr><td>Среднее с учётом весов</td><td></td><td>{RUB(v['weighted'])}</td></tr>
<tr><td>Поправка за износ</td><td></td><td>−{v['wear'] * 100:.1f} %</td></tr><tr><th>Рыночная стоимость</th><td></td><th>{RUB(v['market'])}</th></tr></table>
<h2>Покрытие по полугодиям</h2><table><tr><th>Дата</th><th>Остаток долга</th><th>Базовый</th><th>Пессим.</th></tr>{rows}</table>
<h2>Оборудование</h2><p>{v['cards']} карт. Серийные номера подтверждены: {eq['matched']} из {eq['total']}. Телеметрия: {e({'agent': 'агент на серверах', 'file': 'файл nvidia-smi', 'none': 'нет (поправка до 7 %)'}.get(deal.get('telemetry_mode'), '—'))}.</p>
<h2>Риски и замечания</h2><ul>{risk_html}</ul></body></html>"""


def equipment_xlsx(deal: dict) -> bytes:
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Оборудование"
    ws.append(["Сервер", "Модель", "Серийный номер", "Дата ввода"])
    for s in deal["servers"]:
        for g in s["gpus"]:
            c = g.get("commissioned")
            ws.append([s["name"], s["model"], g["serial"], date.fromisoformat(c).strftime("%d.%m.%Y") if c else ""])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def telemetry_csv(deal: dict) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["server", "index", "serial_contract", "serial_actual", "temperature_c", "utilization_pct", "hours"])
    for s in deal["servers"]:
        for g in s["gpus"]:
            w.writerow([s["name"], g["idx"], g["serial"], g.get("actual_serial", ""), g.get("temp", ""), g.get("util", ""), g.get("hours", "")])
    return ("﻿" + buf.getvalue()).encode("utf-8")

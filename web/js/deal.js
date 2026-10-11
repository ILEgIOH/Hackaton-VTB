/* Компания: обзор C01–C06, оборудование E01–E05, документы D01–D04, ИИ-наблюдатель */
"use strict";
let DEAL_BANNER = null;
const SC = { opt: "Оптимистичный", base: "Базовый", pess: "Пессимистичный" };
function tickStep(v) { return v > 240e6 ? 100e6 : v > 120e6 ? 40e6 : v > 60e6 ? 20e6 : v > 30e6 ? 10e6 : 5e6; }
function niceMax(v) { const s = tickStep(v); return Math.ceil(v / s) * s; }

function chartSvg(fc, liquid, newgen) {
  const pts = fc.points, n = pts.length, W = 760, H = 330, ml = 46, mr = 10, mt = 10, mb = 34, iw = W - ml - mr, ih = H - mt - mb;
  const k = s => liquid ? s + "_liq" : s;
  const max = niceMax(Math.max(...pts.map(p => Math.max(p.opt, p.debt))) * 1.02);
  const x = i => ml + iw * i / Math.max(1, n - 1), y = v => mt + ih * (1 - v / max);
  const line = key => pts.map((p, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p[key]).toFixed(1)).join(" ");
  let debt = "M" + x(0) + " " + y(pts[0].debt);
  pts.forEach((p, i) => { if (i) debt += ` H${x(i).toFixed(1)} V${y(p.debt).toFixed(1)}`; });
  const band = pts.map((p, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p[k("opt")]).toFixed(1)).join(" ") + " " + pts.slice().reverse().map((p, i) => "L" + x(n - 1 - i).toFixed(1) + " " + y(p[k("pess")]).toFixed(1)).join(" ") + "Z";
  let hatch = "";
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1], da = a.debt - a[k("pess")], db = b.debt - b[k("pess")];
    if (da > 0 || db > 0) hatch += `<path d="M${x(i)} ${y(a.debt)} H${x(i + 1)} V${y(b[k("pess")])} L${x(i)} ${y(a[k("pess")])}Z" fill="url(#hat)"/>`;
  }
  const grid = []; for (let v = 0; v <= max + 1; v += tickStep(max)) grid.push(`<line x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}" stroke="#EBDCC5" stroke-dasharray="${v ? "3 4" : ""}"/><text x="${ml - 8}" y="${y(v) + 4}" text-anchor="end" font-size="12" fill="#3E4E68">${Math.round(v / 1e6)}</text>`);
  const lab = []; const stepL = Math.max(1, Math.round((n - 1) / 6));
  for (let i = 0; i < n; i += stepL) lab.push(`<text x="${Math.min(x(i), W - 22)}" y="${H - 10}" text-anchor="middle" font-size="12" fill="#3E4E68">${pts[i].date.slice(5, 7)}.${pts[i].date.slice(0, 4)}</text>`);
  const ng = newgen != null && newgen < n ? `<line x1="${x(newgen)}" x2="${x(newgen)}" y1="${mt}" y2="${mt + ih}" stroke="#C1121F" stroke-width="1" stroke-dasharray="2 4" opacity=".7"/><text x="${x(newgen) + 6}" y="${mt + ih - 8}" font-size="12" fill="#3E4E68">новое поколение чипов</text>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" id="chart"><defs><pattern id="hat" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#fbe1e3"/><line x1="0" y1="0" x2="0" y2="6" stroke="#C1121F" stroke-width="2"/></pattern></defs>
   ${grid.join("")}<path d="${band}" fill="#4C9DB0" opacity=".13"/>${hatch}
   <path d="${line(k("opt"))}" fill="none" stroke="#9fc9d4" stroke-width="2"/><path d="${line(k("pess"))}" fill="none" stroke="#7b8799" stroke-width="2" stroke-dasharray="5 4"/>
   <path d="${line(k("base"))}" fill="none" stroke="#4C9DB0" stroke-width="3"/><path d="${debt}" fill="none" stroke="#051F45" stroke-width="2.5"/>${ng}${lab.join("")}
   <line id="cl" y1="${mt}" y2="${mt + ih}" stroke="#3E4E68" stroke-width="1" opacity="0"/><circle id="cd" r="5" fill="#4C9DB0" stroke="#fff" stroke-width="2" opacity="0"/></svg>`;
}
function bindChart(box, fc, liquid) {
  const svg = $("#chart", box), tip = $(".tip", box), pts = fc.points, n = pts.length, k = s => liquid ? s + "_liq" : s;
  const W = 760, ml = 46, mr = 10, iw = W - ml - mr;
  box.onmousemove = e => {
    const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * W;
    const i = Math.max(0, Math.min(n - 1, Math.round((px - ml) / iw * (n - 1)))), p = pts[i];
    const cx = ml + iw * i / Math.max(1, n - 1);
    const max = niceMax(Math.max(...pts.map(q => Math.max(q.opt, q.debt))) * 1.02);
    $("#cl", box).setAttribute("x1", cx); $("#cl", box).setAttribute("x2", cx); $("#cl", box).setAttribute("opacity", 1);
    $("#cd", box).setAttribute("cx", cx); $("#cd", box).setAttribute("cy", 10 + 286 * (1 - p[k("base")] / max)); $("#cd", box).setAttribute("opacity", 1);
    tip.innerHTML = `<b>${dmy(p.date)}</b><div><span class="muted">Оптимистичный</span><span class="num">${mln(p[k("opt")])}</span></div><div><span class="muted">Базовый</span><span class="num">${mln(p[k("base")])}</span></div><div><span class="muted">Пессимистичный</span><span class="num">${mln(p[k("pess")])}</span></div><div><span class="muted">Остаток долга</span><span class="num">${mln(p.debt)}</span></div>`;
    tip.style.display = "block";
    const bx = box.getBoundingClientRect(); let left = e.clientX - bx.left + 16; if (left + 230 > bx.width) left = e.clientX - bx.left - 240;
    tip.style.left = left + "px"; tip.style.top = "30px";
  };
  box.onmouseleave = () => { tip.style.display = "none"; $("#cl", box).setAttribute("opacity", 0); $("#cd", box).setAttribute("opacity", 0); };
}

const dtime = ts => ts ? fd(ts) + " в " + ft(ts) : "—";
const hoursTxt = h => { const n = Math.round(h); return n + " " + plural(n, "час", "часа", "часов"); };

async function viewDeal(id, tab, query) {
  const D = await api("/deals/" + id);
  if (D.status === "draft") { location.hash = "#/new"; return; }
  if (D.status === "calculating") {
    render("portfolio", `<div class="center-msg"><h2>Идёт расчёт оценки</h2><p>${esc(D.borrower)}. Как только расчёт закончится, придёт уведомление «Оценка готова».</p><span class="spin"></span></div>`);
    POLL = setInterval(async () => { try { const c = await api(`/deals/${id}/calc`); if (c.done) { clearInterval(POLL); route(); } } catch { } }, 1500); return;
  }
  BADGE = ME.pending ?? BADGE;
  const T = { overview: () => overviewTab(D), equipment: () => equipmentTab(D, query), documents: () => documentsTab(D), ai: () => aiTab(D) }[tab] || (() => overviewTab(D));
  render("portfolio", dealHead(D, tab) + `<div id="dt"></div>`);
  bindHead(D);
  await T();
  if (PENDING_REASSESS === id && can("reassess")) { PENDING_REASSESS = null; reassessModal(D); }          // из уведомления «Назначить переоценку»
  if (PENDING_COD && PENDING_COD.id === id && tab === "equipment") { const s = PENDING_COD.server; PENDING_COD = null; codModal(D, s); }   // «Написать в ЦОД»
}
function dealHead(D, tab) {
  const st = D.detail.status, v = D.detail.valuation;
  return `<div class="crumbs"><a href="#/portfolio">Портфель залогов</a> / ${esc(D.borrower)}</div>
  <div class="head"><div><div class="dealhead"><h1>${esc(D.borrower)}</h1><span class="chip-st">${sdot(st, STATUS[st])}</span></div>
  <div class="sub">Сделка ${esc(D.contract)}, ${v.cards} × ${Object.keys(v.per_model).map(k => ({ H100: "H100 SXM 80 ГБ", H200: "H200", A100: "A100 80 ГБ", L40S: "L40S" }[k])).join(" + ")} в ${esc(D.location)}</div></div>
  <div class="row">${can("reassess") ? '<button class="btn" id="reass">Переоценить</button>' : ""}${can("export") ? `<button class="btn primary" id="exp">${ICON.down} Выгрузить заключение</button>` : ""}</div></div>
  <div class="tabs">${[["overview", "Обзор"], ["equipment", "Оборудование"], ["documents", "Документы"], ["ai", "ИИ-наблюдатель"]].map(([k, t]) => `<button class="tab ${tab === k ? "on" : ""}" data-tab="${k}">${t}</button>`).join("")}
  <button class="end" id="dalerts">${ICON.bell} Уведомления ${D.alerts ? `<span class="badge">${D.alerts}</span>` : ""}</button></div>`;
}
function bindHead(D) {
  $$("[data-tab]").forEach(b => b.onclick = () => location.hash = `#/deal/${D.id}/${b.dataset.tab}`);
  $("#dalerts").onclick = () => location.hash = "#/notifications?deal=" + D.id;
  const r = $("#reass"); if (r) r.onclick = () => reassessModal(D);
  const e = $("#exp"); if (e) e.onclick = () => exportModal(D);
}

/* ---- C05, C06: переоценка ---- */
const STEPS_RE = ["Берём свежие цены дилеров и ставки аренды", "Сверяем серийные номера и данные агента", "Пересчитываем три метода оценки", "Строим прогноз и подбираем LTV"];
function reassessModal(D) {
  const m = modal({ title: "Переоценить залог", sub: `${D.borrower}, текущая оценка от ${D.assessed_at ? fd(D.assessed_at) : "—"}`, narrow: true,
    body: '<p style="margin:0 0 10px;font-size:14px">Возьмём свежие цены дилеров, ставки аренды и данные агента на сегодня. Условия кредита не изменятся.</p><p class="muted" style="margin:0;font-size:14px">Предыдущая оценка сохранится во вкладке «Документы».</p>',
    actions: [{ id: "c", label: "Отмена", onClick: c => c.close() }, { id: "ok", label: "Переоценить", primary: true, onClick: ctl => submitModal(ctl, "ok", async () => {
      $(".mbody", ctl.el).innerHTML = `<ul class="calc" style="padding:0;margin:0">${STEPS_RE.map((t, i) => `<li class="${i === 0 ? "cur" : ""}" id="rs${i}">${i === 0 ? '<span class="spin"></span>' : '<span class="pt"></span>'}${t}</li>`).join("")}</ul>`;
      ctl.btn("c").disabled = true; ctl.btn("ok").disabled = true;
      let i = 0; const anim = setInterval(() => { const li = $("#rs" + i); if (li) { li.className = "done"; li.firstChild.outerHTML = '<span class="ok-t">' + ICON.check + "</span>"; } i++; const nx = $("#rs" + i); if (nx) { nx.className = "cur"; nx.firstChild.outerHTML = '<span class="spin"></span>'; } }, 650);
      let r; try { [r] = await Promise.all([api(`/deals/${D.id}/reassess`, { body: {} }), new Promise(res => setTimeout(res, 2700))]); } finally { clearInterval(anim); }
      ctl.close(); toast("Оценка обновлена");
      if (r.change) DEAL_BANNER = { id: D.id, c: r.change, at: Date.now() };
      route();
    }) }] });
  return m;
}
const bannerHtml = D => {
  if (!DEAL_BANNER || DEAL_BANNER.id !== D.id) return "";
  const c = DEAL_BANNER.c, d = c.pct;
  return `<div class="note-ok" id="c6"><b><i class="dot" style="background:var(--teal)"></i>Оценка обновлена ${fd(Date.now() / 1000)}</b>Рыночная стоимость ${nf(c.prev / 1e6, 1)} → ${nf(c.now / 1e6, 1)} млн ₽ (${d >= 0 ? "+" : "−"}${nf(Math.abs(d) * 100, 1)} %): ${esc(c.reason)}. Предыдущая оценка во вкладке «Документы»</div>`;
};

/* ---- D02: выгрузить заключение ---- */
function exportModal(D) {
  const SECS = [["valuation", "Стоимость и три метода оценки"], ["forecast", "Прогноз и график покрытия"], ["equipment", "Список оборудования и состояние"], ["schedule", "График погашения"]];
  let fmt = "pdf";
  const m = modal({ title: "Выгрузить заключение", sub: `${D.borrower}, оценка от ${D.assessed_at ? fd(D.assessed_at) : fd(Date.now() / 1000)}`,
    body: `<div class="fld"><label>Формат</label><div class="seg" id="ff"><button class="on" data-f="pdf" type="button">PDF</button><button data-f="docx" type="button">Word</button></div></div>
      <div class="fld"><label>Что включить</label>${SECS.map(([k, t]) => `<label class="chk"><input type="checkbox" data-s="${k}" checked> ${t}</label>`).join("")}</div><p class="muted" style="font-size:12px;margin:0">Копия сохранится во вкладке «Документы».</p>`,
    actions: [{ id: "c", label: "Отмена", onClick: c => c.close() }, { id: "ok", label: "Скачать", primary: true, onClick: ctl => submitModal(ctl, "ok", async () => {
      const secs = $$("[data-s]:checked", ctl.el).map(x => x.dataset.s); if (!secs.length) { ctl.error("Выберите разделы", "Нужен хотя бы один раздел заключения."); ctl.btn("ok").disabled = false; return; }
      const r = await api(`/deals/${D.id}/export`, { body: { format: fmt, sections: secs } });
      ctl.close(); toast("Заключение сформировано, копия во вкладке «Документы»");
      if (window.CC_DEMO_OPEN) window.CC_DEMO_OPEN(r); else { const a = document.createElement("a"); a.href = r.url; a.download = r.name + "." + r.ext; document.body.appendChild(a); a.click(); a.remove(); }
      if (/documents/.test(location.hash)) route();
    }) }] });
  $("#ff", m.el).onclick = e => { const b = e.target.closest("[data-f]"); if (!b) return; fmt = b.dataset.f; $$("#ff button", m.el).forEach(x => x.classList.toggle("on", x === b)); };
}

/* ---- C01–C04: обзор ---- */
async function overviewTab(D) {
  const V = D.detail.valuation, loan = D.loan, eq = D.detail.equipment, edit = can("edit_terms");
  const BKEY = "cc_basis_" + ME.email;
  let st = { amount: loan.amount, term: loan.term, rate: loan.rate, scen: "pess", liquid: lsGet(BKEY) === "liq", wi: D.detail }, t = null, saveT = null;
  const main = Object.keys(V.per_model)[0], sc = D.models[main] || {};
  const dealers = { H100: 9, H200: 2, A100: 11, L40S: 7 }[main] || 9;
  const silent = eq.silent || [];
  const strip = eq.mismatches.length ? `<a href="#/deal/${D.id}/equipment"><i class="dot breach"></i><span style="color:#ff8a93">Подмена оборудования: ${eq.mismatches.length} ${plural(eq.mismatches.length, "карта", "карты", "карт")} не совпада${eq.mismatches.length === 1 ? "ет" : "ют"} с договором залога</span></a>`
    : silent.length ? `<a href="#/deal/${D.id}/equipment"><i class="dot near"></i><span style="color:#f1b95b">Нет связи с ${silent.map(s => s.server).join(", ")}: карты оценены с поправкой 7 %</span></a>`
    : D.telemetry_mode === "none" ? `<i class="dot near"></i>Телеметрия не подключена: применена поправка 7 %, состояние карт неизвестно`
    : `<a href="#/deal/${D.id}/equipment"><i class="dot ok"></i>Оборудование на месте: ${eq.online} из ${eq.servers} ${plural(eq.servers, "сервера", "серверов", "серверов")} на связи, ${eq.matched} из ${eq.total} серийных номеров совпадают с договором залога</a>`;
  $("#dt").innerHTML = `${bannerHtml(D)}
  <section class="hero three"><div><div class="l">Рыночная стоимость</div><div class="v num">${mln(V.market)}</div><div class="s">≈ ${nf(V.per_card / 1e6, 2)} млн ₽ за карту с долей серверной платформы</div></div>
   <div class="liq"><div class="l">Ликвидационная стоимость</div><div class="v num">${mln(V.liquidation)}</div><div class="s">При срочной продаже за 4–6 месяцев, дисконт ${Math.round(V.liquidation_discount * 100)} %</div></div>
   <div><div class="l">Рекомендуемый LTV</div><div class="v teal num" id="h-ltv"></div><div class="s" id="h-req"></div><div class="s" id="h-ex" style="margin-top:6px"></div></div>
   <div class="strip">${strip}</div></section>
  <div class="card chartpanel"><div><div class="row-between" style="margin:0"><h2>Стоимость залога и остаток долга</h2><div class="seg" id="lq"><button class="${st.liquid ? "" : "on"}" data-l="0">Рыночная</button><button class="${st.liquid ? "on" : ""}" data-l="1">Ликвидационная</button></div></div>
   <div class="legend"><span><i style="border-color:#9fc9d4"></i>Оптимистичный</span><span><i style="border-color:#4C9DB0"></i>Базовый</span><span><i style="border-color:#7b8799;border-top-style:dashed"></i>Пессимистичный</span><span><i style="border-color:#051F45"></i>Остаток долга</span><span><i class="hatch"></i>Залог не покрывает долг</span></div>
   <div class="chartbox" id="cb"><div class="tip"></div><div id="cs"></div></div><div id="banner"></div></div>
   <div><h2 style="font-size:19px;margin-bottom:26px">Параметры кредита</h2>
    ${edit ? `<div class="sl"><div class="t">Сумма<b id="v-a"></b></div><input type="range" id="r-a" min="1000000" max="${Math.min(5e8, Math.max(2 * loan.amount, 120e6))}" step="1000000" value="${loan.amount}"></div>
    <div class="sl"><div class="t">Срок<b id="v-t"></b></div><input type="range" id="r-t" min="6" max="60" step="6" value="${loan.term}"></div>
    <div class="sl"><div class="t">Ставка<b id="v-r"></b></div><input type="range" id="r-r" min="1" max="40" step="0.5" value="${loan.rate}"></div><div class="savedot" id="sv"></div>`
    : `<div class="ro-val"><span>Сумма</span><b>${mln(loan.amount)}</b></div><div class="ro-val"><span>Срок</span><b>${loan.term} мес.</b></div><div class="ro-val"><span>Ставка</span><b>${nf(loan.rate, 1)} %</b></div><div class="ro-val"><span>Ковенант</span><b>${cov(loan.covenant)}</b></div>`}
    <div class="muted" style="margin:6px 0 10px;font-size:14px">Сценарий для расчёта LTV</div><div class="seg" id="sc"><button data-s="opt">Оптим.</button><button data-s="base">Базовый</button><button class="on" data-s="pess">Пессим.</button></div>
    <p class="muted" style="font-size:14px;margin-top:28px;border-top:1px solid var(--line);padding-top:22px">В пессимистичном сценарии ${esc(main)} дешевеет на ${Math.round((sc.pess1 || 0) * 100)} % в год${sc.newgen_drop ? ` и ещё на ${Math.round(sc.newgen_drop * 100)} % после выхода нового поколения чипов` : ""}.</p></div></div>
  <div class="two"><div class="card"><h2 style="margin-bottom:6px">Из чего сложилась оценка</h2>
   ${(() => { const w = V.low_data.length ? [40, 25, 35] : [30, 40, 30]; return [["Затратный", w[0], V.cost, `Цена новых карт у ${dealers} дилеров минус износ`], ["Сравнительный", w[1], V.comparative, "Сделки вторичного рынка за 90 дней"], ["Доходный", w[2], V.income, "Доход от аренды за 3 года службы"]].map(([n, wt, v, d]) => `<div class="mrow"><div class="t"><span>${n} <small>вес ${wt} %</small></span><b class="num">${mln(v)}</b></div><div class="bg"><i style="width:${v / Math.max(V.cost, V.comparative, V.income) * 100}%"></i></div><div class="d">${d}</div></div>`).join(""); })()}
   <div style="border-top:1px solid var(--line);margin-top:24px;padding-top:12px"><div class="kv"><span>Среднее с учётом весов</span><span class="num">${mln(V.weighted)}</span></div><div class="kv"><span>Поправка за износ</span><span class="num">−${nf(V.wear * 100, 1)} %</span></div><div class="kv total"><span>Рыночная стоимость</span><span class="num">${mln(V.market)}</span></div></div>
   ${V.low_data.length ? `<div class="info warn" style="margin:18px 0 0;padding:14px 18px;font-size:14px"><b>Мало данных</b> по ${V.low_data.join(", ")}: оценка по мировым ценам, точность ±15 %. Веса 0,4 / 0,25 / 0,35.</div>` : ""}
   <p class="muted" style="font-size:12px;margin:16px 0 0">Стоимость считается по формулам. Нейросеть в расчёте не участвует.</p></div>
   <div class="card"><h2 style="margin-bottom:6px">Покрытие по полугодиям</h2><div class="tblwrap" style="padding:0"><table class="tbl"><thead><tr><th>Дата</th><th class="r">Остаток долга</th><th class="r">Базовый</th><th class="r">Пессим.</th></tr></thead><tbody id="hy"></tbody></table></div></div></div>`;
  const covCls = v => v == null ? "" : v < 1 ? "red" : v < 1.25 ? "amber" : "";
  const draw = () => {
    const wi = st.wi, fc = wi.forecast;
    $("#cs").innerHTML = chartSvg(fc, st.liquid, st.scen === "pess" ? sc.newgen_month : null); bindChart($("#cb"), fc, st.liquid);
    const g = wi.gap, rec = wi.recommendation;
    $("#banner").innerHTML = g ? `<div class="banner"><b><i class="dot breach"></i>В пессимистичном сценарии залог станет дешевле долга ${dmy(g.first_date)}</b>Через ${g.first_month} ${plural(g.first_month, "месяц", "месяца", "месяцев")}. Разрыв продлится ${g.months} ${plural(g.months, "месяц", "месяца", "месяцев")}, максимум ${nf(g.max_gap / 1e6, 1)} млн ₽</div>` : `<div class="banner ok"><b>В пессимистичном сценарии залог покрывает долг весь срок кредита</b></div>`;
    $("#h-ltv").textContent = nf(rec.ltv * 100, 1) + " %";
    $("#h-req").textContent = `Запрошено ${nf(rec.requested_ltv * 100, 1)} %, это ${nf(st.amount / 1e6, 1)} млн ₽`;
    $("#h-ex").innerHTML = rec.exceeds ? `<span style="color:#ff8a93"><i class="dot breach"></i>Выше рекомендации. Максимум ${nf(rec.max_loan / 1e6, 1)} млн ₽</span>` : `<span style="color:#7fd6a2"><i class="dot ok"></i>В пределах рекомендации, запас ${nf(rec.headroom / 1e6, 1)} млн ₽</span>`;
    $("#hy").innerHTML = wi.half_year.map(r => `<tr><td class="num">${dmy(r.date)}</td><td class="r num">${mln(r.debt)}</td><td class="r num ${covCls(r.base)}">${r.paid ? '<span class="muted">погашен</span>' : cov(r.base)}</td><td class="r num ${covCls(r.pess)}">${r.paid ? '<span class="muted">погашен</span>' : cov(r.pess)}</td></tr>`).join("");
    if (edit) { $("#v-a").textContent = mln(st.amount); $("#v-t").textContent = st.term + " мес."; $("#v-r").textContent = nf(st.rate, 1) + " %"; }
  };
  const recalc = () => { clearTimeout(t); t = setTimeout(async () => { try { st.wi = await api(`/deals/${D.id}/whatif`, { body: { amount: st.amount, term: st.term, rate: st.rate, scenario: st.scen, basis: st.liquid ? "liquidation" : "market" } }); draw(); } catch (e) { toast(e.message, true); } }, 120); };
  const save = () => { clearTimeout(saveT); saveT = setTimeout(async () => { const sv = $("#sv"); try { await api(`/deals/${D.id}/terms`, { body: { amount: st.amount, term: st.term, rate: st.rate } }); if (sv) sv.textContent = "Условия сохранены в сделке"; } catch (e) { if (sv) sv.textContent = ""; toast(e.message, true); } }, 700); };
  if (edit) [["r-a", "amount"], ["r-t", "term"], ["r-r", "rate"]].forEach(([i, k]) => $("#" + i).oninput = e => { st[k] = +e.target.value; $("#v-a").textContent = mln(st.amount); $("#v-t").textContent = st.term + " мес."; $("#v-r").textContent = nf(st.rate, 1) + " %"; $("#sv").textContent = ""; recalc(); save(); });
  $("#sc").onclick = e => { const b = e.target.closest("[data-s]"); if (!b) return; st.scen = b.dataset.s; $$("#sc button").forEach(x => x.classList.toggle("on", x === b)); recalc(); };
  $("#lq").onclick = e => { const b = e.target.closest("[data-l]"); if (!b) return; st.liquid = b.dataset.l === "1"; lsSet(BKEY, st.liquid ? "liq" : "mkt"); $$("#lq button").forEach(x => x.classList.toggle("on", x === b)); recalc(); };
  if (st.liquid) recalc(); else draw();
}

/* ---- E01–E05: оборудование ---- */
function equipmentTab(D, query) {
  const V = D.detail.valuation, S = D.servers, eq = D.detail.equipment, mism = eq.mismatches, silent = eq.silent || [], mode = D.telemetry_mode;
  const focusSrv = query.get("server"), focusSer = query.get("serial");
  let openIdx = focusSrv ? S.findIndex(s => s.name === focusSrv) : S.findIndex(s => s.matched < s.cards && s.seen);
  if (openIdx < 0) openIdx = 0;
  const models = Object.keys(V.per_model).join(", ");
  const avgH = S.filter(s => s.hours != null);
  const link = s => mode === "agent" ? (s.online ? sdot("ok", "На связи") : sdot("near", s.silent_hours != null ? "Нет связи " + hoursTxt(s.silent_hours) : "Нет сигнала")) : mode === "file" ? '<span class="muted">Снимок</span>' : '<span class="muted">—</span>';
  const bar = (v, max, cls = "") => v == null ? "" : `<span class="bar ${cls}" style="margin:0 12px 0 0"><i style="width:${Math.min(100, v / max * 100)}%"></i></span>`;
  const banners = mism.map(m => `<div class="banner-amber red"><div><b>Серийный номер GPU ${m.gpu} на ${esc(m.server)} не совпадает с договором</b>По договору s/n ${esc(m.contract)}, сейчас установлен ${esc(m.actual)}</div><a class="btn sm primary" href="#/notifications?deal=${D.id}">Открыть уведомление</a></div>`).join("")
    + silent.map(s => `<div class="banner-amber"><div><b>${esc(s.server)} не передаёт данные ${s.hours != null ? hoursTxt(s.hours) : ""}</b>Стоимость его ${s.cards} ${plural(s.cards, "карты", "карт", "карт")} снижена на 7 %, пока связь не восстановится</div>${can("write_cod") ? `<button class="btn sm" data-cod="${esc(s.server)}">Написать в ЦОД</button>` : ""}</div>`).join("");
  const rowsHtml = S.map((s, i) => {
    const swap = s.seen && s.matched < s.cards, sil = mode === "agent" && !s.online;
    const lastTxt = s.last_seen ? "Последние данные " + dtime(s.last_seen) : "Данных нет";
    return `<tr class="click ${swap ? "row-bad" : sil ? "row-yel" : ""}" data-tg="${i}"><td><div class="name">${esc(s.name)}</div><div class="sm">${s.cards} × ${esc(s.model)} SXM</div></td>
     <td>${sil ? '<span class="muted">нет данных</span>' : s.seen ? `<span class="${swap ? "s-breach" : "ok-t"}"><i class="dot" style="background:currentColor"></i>${s.matched} из ${s.cards} совпадают</span>` : '<span class="muted">не проверялись</span>'}</td>
     ${sil ? `<td colspan="3" style="color:var(--amber-t)">${lastTxt}</td>` : `<td class="r num">${s.hours != null ? int(s.hours) + " ч" : "—"}</td><td class="num">${bar(s.util, 100)}${s.util != null ? s.util + " %" : "—"}</td><td class="num">${bar(s.temp, 100, s.temp >= 80 ? "breach" : "")}${s.temp != null ? s.temp + " °C" : "—"}</td>`}
     <td class="r num">${s.wear != null ? "−" + nf(s.wear * 100, 1) + " %" : "—"}</td><td>${link(s)}</td></tr>
     <tr id="g${i}" ${i === openIdx ? "" : "hidden"}><td colspan="7" style="padding:0"><div class="gpus">${s.gpus.map(g => `<div class="gpu ${g.match === false ? "bad" : ""} ${g.temp >= 80 ? "hot" : ""} ${focusSer && g.serial === focusSer ? "sel" : ""}"><b>GPU ${g.idx}</b>${g.temp != null ? `<small>${g.temp} °C · ${int(g.util)} %</small>` : ""}<small class="num">…${esc(String(g.actual || g.serial).slice(-5))}</small>${g.match === false ? '<small class="red">чужая</small>' : ""}</div>`).join("")}</div></td></tr>`;
  }).join("");
  $("#dt").innerHTML = `${banners}<div class="stats"><div><div class="l">Серверов</div><div class="v">${S.length}</div></div><div><div class="l">Карт ${esc(models)}</div><div class="v">${V.cards}</div></div>
  <div><div class="l">На связи</div><div class="v num" style="${mode === "agent" && eq.online < S.length ? "color:var(--amber-t)" : ""}">${mode === "agent" ? `${eq.online} из ${S.length}` : "—"}</div></div><div><div class="l">Поправка за износ</div><div class="v num">−${nf(V.wear * 100, 1)} %</div></div></div>
  <div class="card tblwrap"><table class="tbl"><thead><tr><th>Сервер</th><th>Серийные номера</th><th class="r">Наработка</th><th>Загрузка</th><th>Температура</th><th class="r">Поправка</th><th>Связь</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
  $("#dt").onclick = e => {
    const c = e.target.closest("[data-cod]"); if (c) return codModal(D, c.dataset.cod);
    const r = e.target.closest("[data-tg]"); if (!r) return; const x = $("#g" + r.dataset.tg); const was = !x.hidden;
    $$('[id^="g"]', $("#dt")).forEach(y => { if (/^g\d+$/.test(y.id)) y.hidden = true; }); x.hidden = was;   // раскрыт один сервер за раз
  };
}
/* E05: письмо в ЦОД */
function codModal(D, srv) {
  const s = D.servers.find(x => x.name === srv) || {};
  const m = modal({ title: "Написать в ЦОД", sub: "Письмо уйдёт с вашей рабочей почты",
    body: `<div class="fld"><label>Кому</label><input class="inp" id="to" readonly value="${esc((D.contact || "") + (D.contact_email ? ", " + D.contact_email : ""))}"></div>
      <div class="fld"><label>Тема</label><input class="inp" id="sj" value="Сервер ${esc(srv)} не передаёт данные"></div>
      <div class="fld"><label>Сообщение</label><textarea class="inp" id="ms">Здравствуйте! ${s.last_seen ? "С " + dtime(s.last_seen) + " " : ""}сервер ${esc(srv)} не передаёт данные агенту. Проверьте, пожалуйста, питание и сеть сервера.</textarea></div>`,
    actions: [{ id: "c", label: "Отмена", onClick: c => c.close() }, { id: "ok", label: "Отправить", primary: true, onClick: ctl => submitModal(ctl, "ok", async () => { const r = await api(`/deals/${D.id}/write-cod`, { body: { subject: $("#sj", ctl.el).value, message: $("#ms", ctl.el).value } }); ctl.close(); toast("Письмо отправлено: " + r.to); }) }] });
  if (!D.contact_email) m.error("У контакта нет почты", "Укажите почту контакта в ЦОД в карточке сделки.");
}

/* ---- D01, D03, D04: документы ---- */
async function documentsTab(D) {
  let docs = await api(`/deals/${D.id}/documents`), f = "all";
  const tabs = [["all", "Все"], ["conclusion", "Заключения"], ["contract", "Договоры"], ["data", "Данные"], ["act", "Акты"]];
  const ICOLS = { pdf: "pdf", html: "pdf" };
  const draw = () => {
    const list = docs.filter(d => f === "all" || d.type === f);
    $("#dt").innerHTML = docs.length === 0 ? `<div class="card center-msg"><h2>Документов пока нет</h2><p>Заключение появится здесь после первой выгрузки. Договоры и акты можно загрузить вручную</p>${can("upload_docs") ? '<button class="btn primary" id="up">Загрузить документ</button>' : ""}</div>` :
    `<div class="row-between"><div class="tabs plain" style="margin:0" id="dtabs">${tabs.map(([k, t]) => `<button class="tab ${f === k ? "on" : ""}" data-f="${k}">${t}<small>${k === "all" ? docs.length : docs.filter(d => d.type === k).length}</small></button>`).join("")}</div>${can("upload_docs") ? `<button class="btn" id="up">${ICON.up.replace('width="44" height="44"', 'width="18" height="18"')} Загрузить документ</button>` : ""}</div>
    <div class="card tblwrap"><table class="tbl"><thead><tr><th>Документ</th><th>Тип</th><th>Дата</th><th>Добавил</th><th></th></tr></thead><tbody>${list.map(d => `<tr><td><div class="row"><span class="ftype ${ICOLS[d.ext] ? "pdf" : ""}" style="width:56px;height:56px;font-size:13px">${esc((d.ext || "file").toUpperCase())}</span><div><a href="/api/deals/${D.id}/documents/${d.id}?inline=1" target="_blank" rel="noopener" style="color:inherit;text-decoration:none"><b style="font-size:17px;font-weight:600">${esc(d.name)}</b></a>${d.comment ? `<div class="muted" style="font-size:13px">${esc(d.comment)}</div>` : ""}</div></div></td><td>${esc(d.type_label)}</td><td class="num">${esc(d.date)}</td><td>${esc(d.author)}</td><td class="r"><a href="/api/deals/${D.id}/documents/${d.id}" download>Скачать</a></td></tr>`).join("") || '<tr><td colspan="5" class="muted" style="text-align:center;padding:40px">Документов этого типа нет</td></tr>'}</tbody></table></div>`;
    const dt = $("#dtabs"); if (dt) dt.onclick = e => { const b = e.target.closest("[data-f]"); if (b) { f = b.dataset.f; draw(); } };
    const up = $("#up"); if (up) up.onclick = () => uploadModal(D, async () => { docs = await api(`/deals/${D.id}/documents`); draw(); });
  };
  draw();
}
function uploadModal(D, done) {
  let file = null;
  const m = modal({ title: "Загрузить документ", sub: `${D.borrower}, сделка ${D.contract}`, narrow: true,
    body: `<div class="fld"><label>Тип документа</label><select class="inp" id="dty"><option value="contract">Договор</option><option value="act">Акт осмотра</option><option value="conclusion">Заключение</option><option value="other">Другое</option></select></div>
      <div class="fld" id="fl"><label>Файл</label><div class="drop" id="dz" style="padding:20px;border-radius:12px"><div id="fn" class="muted">PDF, Word, Excel, JPG или PNG до 20 МБ</div><button class="btn sm" id="pk" type="button" style="margin-top:10px">Выбрать файл</button></div></div>
      <div class="fld"><label>Комментарий, необязательно</label><input class="inp" id="cm" maxlength="200"></div><input type="file" id="fx" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png" hidden>`,
    actions: [{ id: "c", label: "Отмена", onClick: c => c.close() }, { id: "ok", label: "Загрузить", primary: true, onClick: ctl => submitModal(ctl, "ok", async () => {
      if (!file) { ctl.error("Выберите файл", "Нужен PDF, Word, Excel, JPG или PNG до 20 МБ."); ctl.btn("ok").disabled = false; return; }
      if (file.size > 20 * 1024 * 1024) { ctl.error("Файл больше 20 МБ", ""); ctl.btn("ok").disabled = false; return; }
      await api(`/deals/${D.id}/documents`, { body: file, headers: { "X-Filename": encodeURIComponent(file.name), "X-Doc-Type": $("#dty", ctl.el).value, "X-Comment": encodeURIComponent($("#cm", ctl.el).value) } });
      ctl.close(); toast("Документ загружен"); done();
    }) }] });
  const pick = f => { file = f; $("#fn", m.el).innerHTML = `<b>${esc(f.name)}</b> · ${nf(f.size / 1048576, 1)} МБ`; m.clearError(); };
  $("#pk", m.el).onclick = () => $("#fx", m.el).click(); $("#fx", m.el).onchange = e => e.target.files[0] && pick(e.target.files[0]);
  const dz = $("#dz", m.el); dz.ondragover = e => e.preventDefault(); dz.ondrop = e => { e.preventDefault(); e.dataTransfer.files[0] && pick(e.dataTransfer.files[0]); };
}

/* ---- ИИ-наблюдатель ---- */
function aiTab(D) {
  const el = $("#dt"), id = D.id, RISK = { low: "Низкий риск", medium: "Средний риск", high: "Высокий риск" };
  const draw = r => {
    el.innerHTML = `<div class="two"><div class="card"><div class="row-between"><h2>Анализ ИИ-наблюдателя</h2><button class="btn primary sm" id="run">Запустить анализ</button></div>
      <p class="muted" style="font-size:13px;margin:-8px 0 14px">Справочная подсказка. На стоимость залога, статусы и решения по сделке не влияет: решения принимает сотрудник банка.</p>
      ${r ? `<div class="row" style="margin-bottom:12px"><span class="pill ${r.risk}">${RISK[r.risk]}</span><span class="muted" style="font-size:14px">${r.source === "ai" ? "модель " + esc(r.model) : "правила (ИИ не подключён)"} · ${fdt(r.ts)}</span></div><p style="margin:0 0 14px;font-size:17px">${esc(r.summary)}</p>
      ${r.ai_error ? `<div class="info warn" style="padding:12px 16px;font-size:14px">ИИ недоступен: ${esc(r.ai_error)}. Показаны результаты правил.</div>` : ""}
      ${r.findings.map(x => `<div class="find"><span class="sv ${x.severity}"></span><div><b>${esc(x.title)}${x.server ? ` — ${esc(x.server)}${x.gpu != null ? ", GPU " + x.gpu : ""}` : ""}</b><span>${esc(x.detail || "")}</span></div></div>`).join("") || '<p class="muted">Замечаний нет.</p>'}
      ${r.recommendations?.length ? `<h2 style="font-size:17px;margin:20px 0 6px">Рекомендации</h2><ul style="margin:0;padding-left:20px">${r.recommendations.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}` : `<p class="muted">Анализ ещё не запускался.</p>`}
      ${D.ai_ready ? "" : `<div class="info warn" style="margin:20px 0 0;padding:14px 18px;font-size:14px">Подключите модель в <a href="#/settings">настройках</a> — она будет разбирать телеметрию вместе с правилами.</div>`}</div>
     <div class="card" style="padding:34px"><h2>Спросить ИИ о сделке</h2><div class="chat"><div class="msgs" id="msgs"><div class="msg a">Задайте вопрос по залогу: например, «какие серверы вызывают опасения?» или «что будет с покрытием через год?»</div></div>
      <div class="row"><input class="inp" id="qq" placeholder="Ваш вопрос" style="flex:1"><button class="btn primary" id="ask">Спросить</button></div></div>
      ${can("reassess") ? `<h2 style="font-size:17px;margin:34px 0 8px">Демонстрация инцидентов</h2><p class="muted" style="font-size:14px;margin:0 0 12px">Имитирует событие на серверах заёмщика — мониторинг создаст уведомление, ИИ проанализирует ситуацию.</p>
      <div class="row">${[["overheat", "Перегрев"], ["swap", "Подмена карты"], ["offline", "Обрыв связи"], ["reset", "Сбросить"]].map(([k, t]) => `<button class="btn sm" data-inc="${k}">${t}</button>`).join("")}</div>` : ""}</div></div>`;
    $("#run").onclick = async e => { e.target.disabled = true; e.target.textContent = "Анализируем…"; try { draw(await api(`/deals/${id}/ai-analyze`, { body: {} })); } catch (er) { toast(er.message, true); e.target.disabled = false; e.target.textContent = "Запустить анализ"; } };
    const msgs = $("#msgs"), say = (c, t) => { const d = document.createElement("div"); d.className = "msg " + c; d.textContent = t; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; };
    const ask = async () => { const q = $("#qq").value.trim(); if (!q) return; $("#qq").value = ""; say("u", q); const w = say("a", "…"); try { w.textContent = (await api(`/deals/${id}/ai-chat`, { body: { question: q } })).answer; } catch (e) { w.textContent = e.message; } };
    $("#ask").onclick = ask; $("#qq").onkeydown = e => e.key === "Enter" && ask();
    $$("[data-inc]").forEach(b => b.onclick = async () => { try { await api(`/deals/${id}/incident`, { body: { type: b.dataset.inc } }); toast("Готово — смотрите «Уведомления» и запустите анализ"); } catch (e) { toast(e.message, true); } });
  };
  draw(D.ai_report);
}

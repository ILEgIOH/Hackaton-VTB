/* ComputeCollateral — автономная демо-версия: вся серверная часть (расчёт, мониторинг, уведомления)
   работает в браузере. Подменяет fetch к /api через window.CC_DEMO. Порт compute_collateral/*.py */
(function () {
"use strict";
const DAY = 86400000, nowS = () => Date.now() / 1000;
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = s => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const today = () => { const t = new Date(); return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())); };
function addMonths(d, k) { const i = d.getUTCMonth() + k, y = d.getUTCFullYear() + Math.floor(i / 12), m = ((i % 12) + 12) % 12; const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last))); }
function monthsBetween(a, b) { const k = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth(); return b.getUTCDate() < a.getUTCDate() ? k - 1 : k; }
const dmy = s => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
const c2 = v => v.toFixed(2).replace(".", ","), m1 = v => (v / 1e6).toFixed(1).replace(".", ",");
const hex = n => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
function rngFor(seed) { let h = 1779033703 ^ seed.length; for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; } let a = h >>> 0; const f = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; f.int = (lo, hi) => lo + Math.floor(f() * (hi - lo + 1)); f.pick = a2 => a2[Math.floor(f() * a2.length)]; return f; }

/* ---------- рынок ---------- */
const MODELS = {
  H100: { name: "H100 SXM", full: "H100 SXM 80 ГБ", dealers: 9, median: 2650000, world: 2400000, rent: 250, markup: .18, low: 2050000, high: 3050000, accuracy: .06, new: 3190000, secondary: 2962500, util: .87, scen: { opt: .22, base: .316, pess1: .5, pess2: .5, newgen_month: 8, newgen_drop: .15 } },
  H200: { name: "H200", full: "H200", dealers: 2, median: 3400000, world: 3250000, rent: 320, markup: .18, low: 3100000, high: 3600000, accuracy: .15, new: 4100000, secondary: 3300000, util: .85, scen: { opt: .15, base: .25, pess1: .45, pess2: .4, newgen_month: 10, newgen_drop: .1 } },
  A100: { name: "A100 80 ГБ", full: "A100 80 ГБ", dealers: 11, median: 1200000, world: 1050000, rent: 140, markup: .15, low: 950000, high: 1450000, accuracy: .05, new: 1450000, secondary: 1150000, util: .6, scen: { opt: .15, base: .22, pess1: .35, pess2: .35, newgen_month: null, newgen_drop: 0 } },
  L40S: { name: "L40S", full: "L40S", dealers: 7, median: 780000, world: 700000, rent: 90, markup: .15, low: 620000, high: 920000, accuracy: .07, new: 950000, secondary: 740000, util: .6, scen: { opt: .15, base: .2, pess1: .3, pess2: .3, newgen_month: null, newgen_drop: 0 } },
};
const normModel = t => { t = (t || "").toUpperCase().replace(/ /g, ""); return ["H200", "H100", "A100", "L40S"].find(k => t.includes(k)) || null; };

/* ---------- движок ---------- */
const WEIGHTS = { cost: .3, comparative: .4, income: .3 }, LIQ = .28, NO_TEL = .07, NEAR = 1.15, OFFLINE = 300, SCEN = ["opt", "base", "pess"];
function schedule(amount, term, rate, kind) {
  const bal = [amount];
  if (kind === "differentiated") { for (let k = 1; k <= term; k++) bal.push(amount * (1 - k / term)); return bal; }
  const r = rate / 100 / 12, pay = r === 0 ? amount / term : amount * r / (1 - Math.pow(1 + r, -term)); let b = amount;
  for (let i = 0; i < term; i++) { b = Math.max(0, b * (1 + r) - pay); bal.push(b); }
  bal[bal.length - 1] = 0; return bal;
}
const hasTel = g => g.temp != null;
const gpuWear = g => Math.min((g.hours || 0) / 1000 * .0026 + Math.max(0, (g.temp || 0) - 65) * .0015 + Math.max(0, (g.util || 0) - 92) * .001, NO_TEL);
function dealWear(deal) {
  const gpus = deal.servers.flatMap(s => s.gpus); if (!gpus.length || deal.telemetry_mode === "none" || !deal.telemetry_mode) return NO_TEL;
  return gpus.reduce((a, g) => a + (hasTel(g) ? gpuWear(g) : NO_TEL), 0) / gpus.length;
}
function serverWear(s, mode) { if (mode === "none") return NO_TEL; return s.gpus.reduce((a, g) => a + (hasTel(g) ? gpuWear(g) : NO_TEL), 0) / (s.gpus.length || 1); }
function incomePerCard(m) { const net = m.rent * 8760 * m.util * .55; let pv = 0; for (let t = 1; t <= 3; t++) pv += net / Math.pow(1.2, t); return pv + .45 * m.median / Math.pow(1.2, 3); }
function valuation(deal) {
  const counts = {}; deal.servers.forEach(s => counts[s.model] = (counts[s.model] || 0) + s.gpus.length);
  const wear = dealWear(deal); let cost = 0, comp = 0, inc = 0; const per = {}, low = [];
  for (const [model, n] of Object.entries(counts)) {
    const m = MODELS[model], c = n * m.new, lw = m.dealers < 3, cp = n * (lw ? m.world : m.secondary), ic = n * incomePerCard(m);
    if (lw) low.push(model);
    const bl = WEIGHTS.cost * c + WEIGHTS.comparative * cp + WEIGHTS.income * ic;
    per[model] = { cards: n, cost: c, comparative: cp, income: ic, weighted: bl, market: bl * (1 - wear) };
    cost += c; comp += cp; inc += ic;
  }
  const weighted = WEIGHTS.cost * cost + WEIGHTS.comparative * comp + WEIGHTS.income * inc, market = weighted * (1 - wear), cards = Object.values(counts).reduce((a, b) => a + b, 0);
  return { cost, comparative: comp, income: inc, weighted, wear, market, liquidation: market * (1 - LIQ), per_card: cards ? market / cards : 0, cards, per_model: per, low_data: low, weights: WEIGHTS, liquidation_discount: LIQ };
}
function scenFactor(model, scen, m) {
  const s = MODELS[model].scen;
  if (scen === "opt") return Math.pow(1 - s.opt, m / 12);
  if (scen === "base") return Math.pow(1 - s.base, m / 12);
  let f = Math.pow(1 - s.pess1, Math.min(m, 12) / 12) * Math.pow(1 - s.pess2, Math.max(m - 12, 0) / 12);
  if (s.newgen_month != null && m >= s.newgen_month) f *= 1 - s.newgen_drop; return f;
}
function forecast(deal, loan, val) {
  loan = loan || deal.loan; val = val || valuation(deal);
  const amount = +loan.amount, term = +loan.term, rate = +loan.rate, cov = +(loan.covenant ?? 1.25), issue = parse(loan.issue_date);
  const sched = schedule(amount, term, rate, loan.schedule || "annuity"), t0 = today();
  const elapsed = Math.min(Math.max(0, monthsBetween(issue, t0)), term), start = elapsed > 0 ? t0 : issue, n = term - elapsed, pts = [];
  for (let m = 0; m <= n; m++) {
    const row = { m, date: iso(addMonths(start, m)), debt: sched[elapsed + m] };
    for (const sc of SCEN) row[sc] = Object.entries(val.per_model).reduce((a, [model, pm]) => a + pm.market * scenFactor(model, sc, m), 0);
    pts.push(row);
  }
  pts.forEach(p => SCEN.forEach(sc => p[sc + "_liq"] = p[sc] * (1 - LIQ)));
  return { points: pts, elapsed, covenant: cov, amount, term, rate };
}
const coverage = (v, d) => d <= 1 ? null : v / d;
function pessGap(pts) {
  const g = pts.filter(p => p.debt > 1 && p.pess < p.debt); if (!g.length) return null;
  return { first_month: g[0].m, first_date: g[0].date, months: g[g.length - 1].m - g[0].m + 1, max_gap: Math.max(...g.map(p => p.debt - p.pess)), last_date: g[g.length - 1].date };
}
function recommend(fc, market, scen) {
  scen = scen || "pess"; const covs = fc.points.filter(p => p.debt > 1).map(p => p[scen] / p.debt), minCov = covs.length ? Math.min(...covs) : 99, maxLoan = fc.amount * minCov;
  return { max_loan: maxLoan, ltv: market ? Math.min(maxLoan / market, .8) : 0, requested_ltv: market ? fc.amount / market : 0, exceeds: fc.amount > maxLoan + 1, min_pess_coverage: minCov };
}
function halfYear(fc) { return fc.points.filter(p => p.m && p.m % 6 === 0).map(p => { const paid = p.debt <= 1; return { date: p.date, debt: p.debt, paid, base: paid ? null : p.base / p.debt, pess: paid ? null : p.pess / p.debt }; }); }
const mismatches = deal => deal.servers.flatMap(s => s.gpus.filter(g => g.actual_serial && g.actual_serial !== g.serial).map(g => ({ server: s.name, gpu: g.idx, contract: g.serial, actual: g.actual_serial })));
const isOnline = (s, now) => !!s.last_seen && now - s.last_seen < OFFLINE;
function equipmentState(deal, now) {
  const mism = mismatches(deal), mode = deal.telemetry_mode, offline = deal.servers.filter(s => mode === "agent" && !isOnline(s, now)).map(s => s.name);
  const all = deal.servers.flatMap(s => s.gpus), total = all.length, seen = all.filter(g => g.actual_serial).length, matched = all.filter(g => g.actual_serial === g.serial).length;
  let label, code;
  if (mism.length) [label, code] = ["Подмена", "swap"]; else if (offline.length) [label, code] = ["Нет связи", "offline"]; else if (mode === "none" || !seen) [label, code] = ["Нет данных", "nodata"]; else [label, code] = ["На месте", "ok"];
  return { code, label, mismatches: mism, offline, total, matched, seen };
}
const statusOf = (c, cov) => c == null ? "ok" : c < cov ? "breach" : c < cov * NEAR ? "near" : "ok";
function dealSummary(deal, now) {
  const val = valuation(deal), fc = forecast(deal, null, val), p0 = fc.points[0], cn = coverage(val.market, p0.debt), p12 = fc.points[Math.min(12, fc.points.length - 1)], eq = equipmentState(deal, now);
  const models = {}; deal.servers.forEach(s => models[s.model] = (models[s.model] || 0) + s.gpus.length); const ents = Object.entries(models);
  return { id: deal.id, borrower: deal.borrower, market: val.market, debt: p0.debt, coverage: cn, coverage12: coverage(p12.pess, p12.debt), equipment: eq.label, equipment_code: eq.code, status: statusOf(cn, fc.covenant), covenant: fc.covenant, title: ents.length === 1 ? `${ents[0][1]} × ${ents[0][0]}` : ents.map(([m, n]) => `${n} × ${m}`).join(" + ") };
}
function dealDetail(deal, now) {
  const val = valuation(deal), fc = forecast(deal, null, val), pts = fc.points, p0 = pts[0], cn = coverage(val.market, p0.debt), notes = {};
  Object.keys(val.per_model).forEach(m => { const s = MODELS[m].scen; notes[m] = { pess1: s.pess1, newgen_drop: s.newgen_drop, newgen_month: s.newgen_month }; });
  return { valuation: val, forecast: fc, coverage_now: cn, status: statusOf(cn, fc.covenant), recommendation: recommend(fc, val.market), gap: pessGap(pts), equipment: equipmentState(deal, now), half_year: halfYear(fc), scenario_notes: notes, debt_now: p0.debt };
}
function serversView(deal, now) {
  const mode = deal.telemetry_mode;
  return deal.servers.map(s => {
    const tele = s.gpus.filter(hasTel), avg = k => tele.length ? Math.round(tele.reduce((a, g) => a + (g[k] || 0), 0) / tele.length) : null;
    return { name: s.name, model: s.model, cards: s.gpus.length, hours: avg("hours"), util: avg("util"), temp: avg("temp"), wear: mode ? serverWear(s, mode) : null,
      matched: s.gpus.filter(g => g.actual_serial === g.serial).length, seen: s.gpus.filter(g => g.actual_serial).length, online: mode === "agent" ? isOnline(s, now) : null, last_seen: s.last_seen,
      gpus: s.gpus.map(g => ({ idx: g.idx, serial: g.serial, actual: g.actual_serial, temp: g.temp, util: g.util, hours: g.hours, match: g.actual_serial ? g.actual_serial === g.serial : null })) };
  });
}

/* ---------- состояние и демо-данные ---------- */
const DB = { deals: {}, notifications: [], documents: {}, ai_reports: {}, settings: { ai: { enabled: false, base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", interval_min: 30, api_key: "" }, simulate: true }, blobs: {} };
let ME = null;
const USER = { email: "e.sokolova@bank.ru", name: "Е. Соколова", initials: "ЕС", role: "Кредитный аналитик" };
const DEALS = [
  ["datafork", "ООО «ДатаФорж»", "L40S", 6, "ЦОД «Юг-1», Краснодар", 1.06, 8, 24, 19, {}], ["sibcomp", "АО «Сибирские вычисления»", "A100", 8, "ЦОД «Сибирь», Новосибирск", 1.32, 7, 36, 17.5, {}],
  ["neuroset", "ООО «Нейросеть Регион»", "H100", 3, "ЦОД «Урал», Екатеринбург", 1.33, 5, 36, 18, { swap: ["srv-02", 5] }],
  ["neurocluster", "ООО «Нейрокластер»", "H100", 4, "ЦОД «Север-2», Москва", null, 0, 36, 18, { amount: 6e7, hours: [6120, 6340, 7010, 5980], temps: [64, 67, 72, 62], utils: [87, 91, 94, 83], issue: "fixed", contract: "КД-2026-0418" }],
  ["quantcloud", "ООО «Квант Облако»", "H200", 2, "ЦОД «Балт», Санкт-Петербург", 1.66, 6, 36, 17, {}], ["technocod", "ПАО «ТехноЦОД»", "A100", 5, "ЦОД «Центр», Москва", 2.03, 9, 36, 16.5, {}],
];
function buildServers(rng, model, n, serial, sp, tele) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const comm = i === 0 ? "2025-02-12" : i < 3 ? "2025-06-03" : "2025-09-01", hrs = (sp.hours && sp.hours[i]) || rng.int(5200, 7400), t0 = (sp.temps && sp.temps[i]) || rng.int(60, 72), u0 = (sp.utils && sp.utils[i]) || rng.int(80, 95), gpus = [];
    for (let g = 0; g < 8; g++) { const gp = { idx: g, serial: String(serial), commissioned: comm }; if (tele) Object.assign(gp, { actual_serial: String(serial), temp: t0 + rng.int(-2, 2), util: Math.min(99, u0 + rng.int(-3, 3)), hours: hrs - rng.int(0, 4) }); gpus.push(gp); serial++; }
    out.push({ name: `srv-${pad(i + 1)}`, model, gpus, last_seen: tele ? nowS() : null }); serial += rng.int(300, 600);
  }
  return out;
}
function makeDeal(d, idx) {
  const [id, borrower, model, ns, loc, target, elapsed, term, rate, ex] = d, rng = rngFor(id), servers = buildServers(rng, model, ns, 1654023118421 + idx * 100000, ex, true);
  if (ex.swap) { const g = servers.find(s => s.name === ex.swap[0]).gpus[ex.swap[1]]; g.serial = "1654023118915"; g.actual_serial = "1654023887102"; }
  const deal = { id, borrower, location: loc, contract: ex.contract || `КД-2026-${String(300 + idx * 37).padStart(4, "0")}`, telemetry_mode: "agent", simulated: true, status: "active", servers, agent_token: hex(24) };
  const issue = ex.issue ? addMonths(today(), 0) : addMonths(today(), -elapsed); let amount = ex.amount;
  if (amount == null) { const mk = valuation(deal).market, f = schedule(1, term, rate)[elapsed]; amount = Math.round(mk / (target * f) / 1e5) * 1e5; }
  const issueIso = ex.issue ? iso(new Date(today().getTime() + 7 * DAY)) : iso(issue);
  deal.loan = { amount, term, rate, schedule: "annuity", issue_date: issueIso, covenant: 1.25 }; return deal;
}
const ACTIONS = { swap: [["inspect", "Назначить проверку", "Назначена выездная проверка"], ["request", "Запросить обеспечение", "Запрошено обеспечение"]], covenant: [["request", "Запросить обеспечение", "Запрошено дополнительное обеспечение"], ["reassess", "Назначить переоценку", "Назначена переоценка"]], threshold: [["reassess", "Назначить переоценку", "Назначена переоценка"], ["watch", "Наблюдать", "Взято под наблюдение"]], forecast: [["params", "Изменить параметры", "Параметры кредита будут пересмотрены"], ["watch", "Наблюдать", "Взято под наблюдение"]], hardware: [["inspect", "Назначить проверку", "Назначена выездная проверка"], ["watch", "Наблюдать", "Взято под наблюдение"]], link: [] };
const LABELS = { swap: "Подмена оборудования", covenant: "Нарушение ковенанта", threshold: "Близко к порогу", forecast: "Прогноз", hardware: "Состояние оборудования", link: "Связь с сервером" };
const actionsOf = (kind, only) => (only || ACTIONS[kind]).map(([id, label], i) => ({ id, label, primary: i === 0 }));
function addNote(deal, kind, title, text, sev, now, rec) { const n = { id: "n" + (DB.notifications.length + 1), deal_id: deal.id, kind, label: LABELS[kind], title, text, severity: sev, owner: "Система", status: ACTIONS[kind].length ? "new" : "closed", actions: actionsOf(kind), ts: now, decision: null, key: `${deal.id}:${kind}`, recommendation: rec || null }; DB.notifications.push(n); return n; }
const openNote = key => DB.notifications.find(n => n.key === key && n.status !== "closed");
function syncAlerts(deal, now) {
  if (deal.status !== "active") return; now = now || nowS(); const d = dealDetail(deal, now), id = deal.id;
  const mm = d.equipment.mismatches;
  if (mm.length && !openNote(id + ":swap")) addNote(deal, "swap", "Серийный номер карты не совпадает с договором", `Сервер ${mm[0].server}, GPU ${mm[0].gpu}. По договору s/n ${mm[0].contract}, установлен ${mm[0].actual}`, "high", now, "Выездная проверка, приостановить выдачу траншей");
  const cov = d.coverage_now, cv = d.forecast.covenant;
  if (d.status === "breach" && !openNote(id + ":covenant")) { const need = cv * d.debt_now - d.valuation.market; addNote(deal, "covenant", `Покрытие ${c2(cov)} при ковенанте ${c2(cv)}`, `Для возврата к ковенанту нужно дополнительное обеспечение на ${m1(need)} млн ₽`, "high", now, `Дополнительное обеспечение на ${m1(need)} млн ₽`); }
  else if (d.status === "near" && !openNote(id + ":threshold")) addNote(deal, "threshold", `Покрытие снизилось до ${c2(cov)}`, `Ковенант ${c2(cv)}, запас ${Math.round((cov / cv - 1) * 100)} %`, "medium", now, "Назначить переоценку");
  if (d.gap && !openNote(id + ":forecast")) addNote(deal, "forecast", `Через ${d.gap.first_month} мес. залог может стать дешевле долга`, `В пессимистичном сценарии разрыв продлится ${d.gap.months} мес. Максимум ${m1(d.gap.max_gap)} млн ₽`, "medium", now, `Снизить сумму до ${m1(d.recommendation.max_loan)} млн ₽ или сократить срок`);
  if (deal.telemetry_mode === "agent") {
    const down = d.equipment.offline, ex = openNote(id + ":link");
    if (down.length && !ex) { const n = addNote(deal, "link", `Сервер ${down[0]} не выходит на связь`, "Агент не присылал данные более 5 минут", "low", now); n.status = "new"; n.actions = [{ id: "watch", label: "Наблюдать", primary: true }]; }
    else if (ex && !down.length) { ex.status = "closed"; ex.text += `. Связь восстановлена в ${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`; }
  }
  const hot = deal.servers.flatMap(s => s.gpus.filter(g => (g.temp || 0) >= 85).map(g => [s.name, g]));
  if (hot.length && !openNote(id + ":hardware")) addNote(deal, "hardware", `Перегрев: ${hot[0][0]}, GPU ${hot[0][1].idx} — ${hot[0][1].temp} °C`, "Температура выше 85 °C ускоряет износ и снижает стоимость залога", "medium", now, "Проверить охлаждение и нагрузку");
}
function seedNotes() {
  const now = nowS(), n = (deal, kind, title, text, sev, owner, status, hoursAgo, rec, decision, only) => DB.notifications.push({ id: "n" + (DB.notifications.length + 1), deal_id: deal, kind, label: LABELS[kind], title, text, severity: sev, owner, status, actions: ["new", "in_work"].includes(status) ? actionsOf(kind, only) : [], ts: now - hoursAgo * 3600, decision: decision || null, key: `${deal}:${kind}`, recommendation: rec || null });
  n("neuroset", "swap", "Серийный номер карты не совпадает с договором", "Сервер srv-02, GPU 5. По договору s/n 1654023118915, установлен 1654023887102", "high", "Залоговая служба, М. Орлова", "in_work", 32, "Выездная проверка, приостановить выдачу траншей");
  n("datafork", "covenant", "Покрытие 1,06 при ковенанте 1,25", "Ставки аренды L40S упали на 18 % за квартал, оценка снизилась на 4,1 млн ₽", "high", "Залоговая служба, И. Петров", "new", 24, "Дополнительное обеспечение на 7,2 млн ₽");
  n("neurocluster", "forecast", "Через 10 месяцев залог может стать дешевле долга", "После выхода нового поколения чипов цены H100 могут упасть ещё на 15 %", "medium", "Е. Соколова", "new", 21, "Снизить сумму до 49,3 млн ₽ или сократить срок");
  n("sibcomp", "threshold", "Покрытие снизилось до 1,32", "Цены дилеров на A100 упали на 9 % за месяц", "medium", "Управление рисков, А. Ким", "decided", 72, null, "Назначена переоценка, " + dmy(iso(today())));
  n("technocod", "link", "Сервер srv-07 не выходил на связь 3 часа", "Плановые работы в ЦОДе, связь восстановлена в 14:20", "low", "Система", "closed", 168);
}
function ensureDocs(deal) {
  const docs = DB.documents[deal.id] = DB.documents[deal.id] || [], have = new Set(docs.map(d => d.generated)), mode = deal.telemetry_mode, td = dmy(iso(today()));
  [["report", "Заключение об оценке залога", "conclusion", "Е. Соколова", "html"], ["equipment", "Перечень оборудования", "data", "От заёмщика", "csv"], ["telemetry", "Данные с серверов на дату оценки", "data", mode === "agent" ? "Агент" : "Файл nvidia-smi", "csv"]].forEach(([g, name, type, who, ext]) => { if (g === "telemetry" && (!mode || mode === "none")) return; if (!have.has(g)) docs.push({ id: hex(10), name, type, date: td, author: who, generated: g, ext }); });
}
function init() {
  DEALS.forEach((d, i) => { const deal = makeDeal(d, i); DB.deals[deal.id] = deal; });
  seedNotes(); Object.values(DB.deals).forEach(d => { syncAlerts(d); ensureDocs(d); });
}

/* ---------- ИИ (правила) ---------- */
function ruleFindings(deal, detail, now) {
  const f = [], td = today();
  detail.equipment.mismatches.forEach(m => f.push({ severity: "critical", title: "Серийный номер не совпадает с договором", server: m.server, gpu: m.gpu, detail: `По договору ${m.contract}, установлен ${m.actual}. Возможна подмена карты.` }));
  deal.servers.forEach(s => {
    if (deal.telemetry_mode === "agent" && !isOnline(s, now)) { const mins = Math.round((now - (s.last_seen || 0)) / 60); f.push({ severity: mins > 60 ? "critical" : "warning", title: "Нет связи с сервером", server: s.name, gpu: null, detail: `Последние данные ${mins} мин назад.` }); }
    s.gpus.forEach(g => {
      if (g.temp != null && g.temp >= 85) f.push({ severity: "critical", title: "Критический перегрев", server: s.name, gpu: g.idx, detail: `${g.temp} °C — риск ускоренного износа.` });
      else if (g.temp != null && g.temp >= 80) f.push({ severity: "warning", title: "Повышенная температура", server: s.name, gpu: g.idx, detail: `${g.temp} °C.` });
      if (g.hours && g.commissioned) { const age = Math.round((td - parse(g.commissioned)) / DAY) * 24; if (g.hours > age * 1.02 + 24) f.push({ severity: "critical", title: "Наработка больше возраста карты", server: s.name, gpu: g.idx, detail: `${Math.round(g.hours)} ч при возрасте ${age} ч — данные недостоверны или карту заменили.` }); else if (age > 2000 && g.hours < age * .05) f.push({ severity: "warning", title: "Подозрительно малая наработка", server: s.name, gpu: g.idx, detail: `${Math.round(g.hours)} ч при возрасте ${age} ч — возможна замена карты.` }); }
    });
    const u = s.gpus.filter(g => g.util != null).map(g => g.util); if (u.length && u.reduce((a, b) => a + b, 0) / u.length < 5 && isOnline(s, now)) f.push({ severity: "warning", title: "Сервер простаивает", server: s.name, gpu: null, detail: "Средняя загрузка карт ниже 5 % — оборудование не приносит дохода." });
  });
  const cov = detail.coverage_now, cv = detail.forecast.covenant;
  if (cov != null && cov < cv) f.push({ severity: "critical", title: "Нарушение ковенанта покрытия", server: null, gpu: null, detail: `Покрытие ${c2(cov)} ниже ковенанта ${c2(cv)}.` });
  else if (detail.status === "near") f.push({ severity: "warning", title: "Покрытие близко к порогу", server: null, gpu: null, detail: `Покрытие ${c2(cov)} при ковенанте ${c2(cv)}.` });
  if (detail.gap) f.push({ severity: "warning", title: "Прогноз: залог может стать дешевле долга", server: null, gpu: null, detail: `В пессимистичном сценарии с ${dmy(detail.gap.first_date)}, разрыв до ${m1(detail.gap.max_gap)} млн ₽.` });
  return f;
}
function rulesReport(deal, detail, now) {
  const findings = ruleFindings(deal, detail, now), rank = { info: 0, warning: 1, critical: 2 }, top = Math.max(0, ...findings.map(x => rank[x.severity])), recs = [], t = x => findings.some(f => x(f.title.toLowerCase()));
  if (t(s => s.startsWith("серийный"))) recs.push("Назначить выездную проверку и приостановить выдачу траншей");
  if (t(s => s.includes("ковенант"))) recs.push("Запросить дополнительное обеспечение или назначить переоценку");
  if (t(s => s.includes("перегрев") || s.includes("температур"))) recs.push("Запросить у заёмщика отчёт об охлаждении и обслуживании");
  if (t(s => s.includes("связи"))) recs.push("Связаться с заёмщиком и уточнить причину отсутствия телеметрии");
  return { risk: ["low", "medium", "high"][top], summary: findings.length ? `Найдено замечаний: ${findings.length}.` : "Аномалий не обнаружено, залог в норме.", findings, recommendations: recs, source: "rules", ts: now };
}

/* ---------- отчёт и документы ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const RUB = v => (v / 1e6).toFixed(1).replace(".", ",") + " млн ₽";
function reportHtml(deal, detail, ai) {
  const v = detail.valuation, fc = detail.forecast, rec = detail.recommendation, eq = detail.equipment;
  const rows = detail.half_year.map(r => `<tr><td>${dmy(r.date)}</td><td>${RUB(r.debt)}</td><td>${r.paid ? "погашен" : c2(r.base)}</td><td>${r.paid ? "погашен" : c2(r.pess)}</td></tr>`).join("");
  const risks = [];
  if (detail.gap) risks.push(`В пессимистичном сценарии залог станет дешевле долга ${dmy(detail.gap.first_date)}; разрыв продлится ${detail.gap.months} мес., максимум ${RUB(detail.gap.max_gap)}.`);
  if (rec.exceeds) risks.push(`Запрошенная сумма ${RUB(fc.amount)} выше рекомендуемой ${RUB(rec.max_loan)} (LTV ${(rec.ltv * 100).toFixed(1).replace(".", ",")} %).`);
  eq.mismatches.forEach(m => risks.push(`Серийный номер не совпадает: ${m.server}, GPU ${m.gpu} — по договору ${m.contract}, установлен ${m.actual}.`));
  if (v.low_data.length) risks.push("Недостаточно рыночных данных по моделям: " + v.low_data.join(", ") + " — точность ±15 %.");
  if (ai) risks.push("ИИ-наблюдатель: " + ai.summary);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>body{font:14px/1.5 Manrope,Arial,sans-serif;color:#051F45;margin:0;padding:24px 28px;background:#fff}h1{font-size:24px;margin:0}h2{font-size:16px;margin:24px 0 8px;border-bottom:1px solid #EBDCC5;padding-bottom:4px}table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #EBDCC5;text-align:left}th{color:#3E4E68}.big{font-size:26px;font-weight:700}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}.m{color:#3E4E68}</style></head><body>
<p class="m">ComputeCollateral · ${dmy(iso(today()))}</p><h1>Заключение об оценке залога</h1><p class="m">${esc(deal.borrower)} · сделка ${esc(deal.contract)} · ${esc(deal.location)}<br>Подготовил: Е. Соколова</p>
<div class="grid"><div><div class="m">Рыночная стоимость</div><div class="big">${RUB(v.market)}</div></div><div><div class="m">Ликвидационная стоимость</div><div class="big">${RUB(v.liquidation)}</div></div><div><div class="m">Рекомендуемый LTV</div><div class="big">${(rec.ltv * 100).toFixed(1).replace(".", ",")} %</div></div></div>
<h2>Параметры кредита</h2><p>Сумма ${RUB(fc.amount)}, срок ${fc.term} мес., ставка ${fc.rate} % годовых, ковенант покрытия ${c2(fc.covenant)}. Текущее покрытие: ${detail.coverage_now == null ? "—" : c2(detail.coverage_now)}. Рекомендуемая максимальная сумма: ${RUB(rec.max_loan)}.</p>
<h2>Из чего сложилась оценка</h2><table><tr><th>Подход</th><th>Вес</th><th>Стоимость</th></tr><tr><td>Затратный</td><td>30 %</td><td>${RUB(v.cost)}</td></tr><tr><td>Сравнительный</td><td>40 %</td><td>${RUB(v.comparative)}</td></tr><tr><td>Доходный</td><td>30 %</td><td>${RUB(v.income)}</td></tr><tr><td>Среднее с учётом весов</td><td></td><td>${RUB(v.weighted)}</td></tr><tr><td>Поправка за износ</td><td></td><td>−${(v.wear * 100).toFixed(1).replace(".", ",")} %</td></tr><tr><th>Рыночная стоимость</th><td></td><th>${RUB(v.market)}</th></tr></table>
<h2>Покрытие по полугодиям</h2><table><tr><th>Дата</th><th>Остаток долга</th><th>Базовый</th><th>Пессим.</th></tr>${rows}</table>
<h2>Оборудование</h2><p>${v.cards} карт. Серийные номера подтверждены: ${eq.matched} из ${eq.total}.</p><h2>Риски и замечания</h2><ul>${(risks.map(r => `<li>${esc(r)}</li>`).join("")) || "<li>Существенных рисков не выявлено.</li>"}</ul></body></html>`;
}
const TEMPLATE = "Сервер;Модель;Серийный номер;Дата ввода\r\nsrv-01;H100 SXM 80 ГБ;1654023118421;12.02.2025\r\nsrv-01;H100 SXM 80 ГБ;1654023118422;12.02.2025\r\nsrv-01;H100 SXM 80 ГБ;1654023118423;12.02.2025\r\nsrv-01;H100 SXM 80 ГБ;1654023118424;12.02.2025\r\nsrv-01;H100 SXM 80 ГБ;1654023118425;12.02.2025\r\nsrv-01;H100 SXM 80 ГБ;1654023118426;12.02.2025\r\nsrv-01;H100 SXM 80 ГБ;1654023118427;12.02.2025\r\nsrv-01;H100 SXM 80 ГБ;1654023118428;12.02.2025\r\nsrv-02;H100 SXM 80 ГБ;1654023118908;03.06.2025\r\nsrv-02;H100 SXM 80 ГБ;1654023118909;03.06.2025\r\nsrv-02;H100 SXM 80 ГБ;1654023118910;03.06.2025\r\nsrv-02;H100 SXM 80 ГБ;1654023118911;03.06.2025\r\nsrv-02;H100 SXM 80 ГБ;1654023118912;03.06.2025\r\nsrv-02;H100 SXM 80 ГБ;1654023118913;03.06.2025\r\nsrv-02;H100 SXM 80 ГБ;1654023118914;03.06.2025\r\nsrv-02;H100 SXM 80 ГБ;1654023118915;03.06.2025\r\n";
const telemetryCsv = deal => "server;index;serial_contract;serial_actual;temperature_c;utilization_pct;hours\r\n" + deal.servers.flatMap(s => s.gpus.map(g => [s.name, g.idx, g.serial, g.actual_serial || "", g.temp ?? "", g.util ?? "", g.hours != null ? Math.round(g.hours) : ""].join(";"))).join("\r\n");
const equipmentCsv = deal => "Сервер;Модель;Серийный номер;Дата ввода\r\n" + deal.servers.flatMap(s => s.gpus.map(g => [s.name, s.model, g.serial, g.commissioned ? dmy(g.commissioned) : ""].join(";"))).join("\r\n");

/* ---------- разбор CSV ---------- */
function csvRows(text) {
  text = text.replace(/^﻿/, ""); const first = text.split(/\r?\n/)[0] || "", delim = [";", "\t", ","].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0], rows = [];
  for (const line of text.split(/\r?\n/)) { if (!line.trim()) continue; const out = []; let cur = "", q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === delim && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); rows.push(out.map(x => x.trim())); }
  return rows;
}
const SYN = { server: ["сервер", "server", "host", "hostname", "узел"], model: ["модель", "model", "gpu", "name", "карта"], serial: ["серийный", "serial", "s/n", "sn"], date: ["дата", "date", "commission", "ввод"] };
function parseDate(s) { let m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s); if (m) return `${m[3]}-${m[2]}-${m[1]}`; m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; }
async function readText(blob, name) {
  if (/\.xlsx?m?$/i.test(name || "")) throw new Error("В демо-версии поддерживается только CSV. Используйте «Загрузить пример» или шаблон");
  return await blob.text();
}
async function parseEquipment(blob, name) {
  const rows = csvRows(await readText(blob, name)); if (!rows.length) throw new Error("Файл пуст");
  const cols = {}; rows[0].forEach((h, i) => { const hl = h.toLowerCase(); for (const [k, syn] of Object.entries(SYN)) if (!(k in cols) && syn.some(s => hl.includes(s))) cols[k] = i; });
  const miss = ["server", "model", "serial"].filter(k => !(k in cols)); if (miss.length) throw new Error("Не найдены колонки: " + miss.map(k => ({ server: "Сервер", model: "Модель", serial: "Серийный номер" }[k])).join(", "));
  const servers = new Map(), errors = [], seen = new Set();
  rows.slice(1).forEach((r, i) => {
    const ln = i + 2, name = r[cols.server] || "", mraw = r[cols.model] || "", serial = (r[cols.serial] || "").replace(/\.0$/, ""), model = normModel(mraw);
    if (!name) return errors.push(`Строка ${ln}: не указан сервер`); if (!serial) return errors.push(`Строка ${ln}: нет серийного номера`); if (seen.has(serial)) return errors.push(`Строка ${ln}: дубль серийного номера ${serial}`);
    if (!model) return errors.push(`Строка ${ln}: неизвестная модель «${mraw}» (поддерживаются H100, H200, A100, L40S)`);
    if (!servers.has(name)) servers.set(name, { name, model, gpus: [] }); const s = servers.get(name); if (s.model !== model) return errors.push(`Строка ${ln}: в сервере ${name} смешаны модели ${s.model} и ${model}`);
    seen.add(serial); s.gpus.push({ idx: s.gpus.length, serial, commissioned: "date" in cols ? parseDate(r[cols.date] || "") : null });
  });
  const list = [...servers.values()]; return { servers: list, errors, cards: list.reduce((a, s) => a + s.gpus.length, 0), count_servers: list.length };
}
async function parseSmi(blob, name) {
  const rows = csvRows(await readText(blob, name)); if (!rows.length) throw new Error("Файл пуст");
  const head = rows[0].map(h => h.toLowerCase()), find = (...k) => { const i = head.findIndex(h => k.some(x => h.includes(x))); return i < 0 ? null : i; };
  const iS = find("serial"), iT = find("temperature", "temp"), iU = find("utilization", "util", "загруз"), iH = find("host", "server", "сервер"), iI = find("index");
  if (iS == null || iT == null) throw new Error("В файле нет колонок serial и temperature.gpu (команда: nvidia-smi --query-gpu=index,serial,name,temperature.gpu,utilization.gpu --format=csv)");
  const num = v => parseFloat(String(v).replace(/[^\d.]/g, "")) || 0;
  return rows.slice(1).filter(r => r.length > Math.max(iS, iT)).map(r => ({ serial: r[iS].replace(/\.0$/, ""), temp: num(r[iT]), util: iU != null ? num(r[iU]) : 0, host: iH != null ? r[iH] : null, index: iI != null ? Math.round(num(r[iI])) : null }));
}

/* ---------- монитор ---------- */
function drift() {
  const now = nowS();
  Object.values(DB.deals).forEach(deal => {
    if (deal.status !== "active") return;
    if (DB.settings.simulate && deal.simulated) deal.servers.forEach(s => { if (s.frozen) return; s.last_seen = now; s.gpus.forEach(g => { if (g.temp == null) return; if (g.hot) { g.temp = Math.min(95, g.temp + (Math.random() < .5 ? 1 : 0)); return; } g.temp = Math.max(55, Math.min(78, g.temp + [-1, 0, 0, 1][Math.floor(Math.random() * 4)])); g.util = Math.max(40, Math.min(99, g.util + [-2, -1, 0, 1, 2][Math.floor(Math.random() * 5)])); g.hours = (g.hours || 0) + 8 / 3600; }); });
    syncAlerts(deal, now);
  });
}

/* ---------- API ---------- */
const err = (m, c) => { const e = new Error(m); e.code = c; return e; };
const getDeal = id => DB.deals[id] || (() => { throw err("Сделка не найдена", 404); })();
const aiReady = () => false;
function dealPayload(deal) {
  const now = nowS(), detail = dealDetail(deal, now), models = {}; Object.keys(detail.valuation.per_model).forEach(k => models[k] = MODELS[k].scen);
  return { id: deal.id, borrower: deal.borrower, location: deal.location, contract: deal.contract, status: deal.status, loan: deal.loan, telemetry_mode: deal.telemetry_mode, agent_token: deal.agent_token, detail, servers: serversView(deal, now), alerts: DB.notifications.filter(n => n.deal_id === deal.id && ["new", "in_work"].includes(n.status)).length, models, ai_report: DB.ai_reports[deal.id] || null, ai_ready: aiReady() };
}
const TYPE_LABEL = { conclusion: "Заключение", contract: "Договор", data: "Данные", act: "Акт" };
const DEMO_NOTE = "В демо-версии внешние API отключены. Запустите приложение локально (python run.py) и подключите модель в настройках";
const routes = [];
const R = (m, p, fn) => routes.push([m, new RegExp("^" + p + "$"), fn]);
R("POST", "/login", async b => { if (String(b.email).trim().toLowerCase() !== USER.email || b.password !== "Compute2026") throw err("Неверная почта или пароль", 401); ME = USER; return { name: USER.name, initials: USER.initials, role: USER.role }; });
R("POST", "/logout", async () => { ME = null; return { ok: true }; });
R("GET", "/me", async () => { if (!ME) throw err("Не авторизован", 401); return ME; });
R("GET", "/portfolio", async () => {
  const now = nowS(), rows = Object.values(DB.deals).filter(d => d.status === "active").map(d => ({ ...dealSummary(d, now), servers: d.servers.length })), val = rows.reduce((a, r) => a + r.market, 0), debt = rows.reduce((a, r) => a + r.debt, 0), counts = { breach: 0, near: 0, ok: 0 }; rows.forEach(r => counts[r.status]++);
  return { rows, total_value: val, total_debt: debt, avg_coverage: debt ? val / debt : null, counts, attention: counts.breach + counts.near, pending: DB.notifications.filter(n => ["new", "in_work"].includes(n.status)).length };
});
R("GET", "/deals/([\\w-]+)", async (b, m) => dealPayload(getDeal(m[1])));
R("POST", "/deals/([\\w-]+)/whatif", async (b, m) => {
  const deal = getDeal(m[1]), loan = { ...deal.loan, amount: +b.amount, term: +b.term, rate: +b.rate };
  if (!(loan.amount >= 1e5 && loan.amount <= 5e9 && loan.term >= 1 && loan.term <= 120 && loan.rate >= 0 && loan.rate <= 60)) throw err("Параметры вне допустимых пределов", 400);
  const val = valuation(deal), fc = forecast(deal, loan, val); return { forecast: fc, recommendation: recommend(fc, val.market, SCEN.includes(b.scenario) ? b.scenario : "pess"), gap: pessGap(fc.points), half_year: halfYear(fc), market: val.market, liquidation: val.liquidation };
});
R("POST", "/parse-equipment", async (b, m, o) => parseEquipment(o.body, (o.headers || {})["X-Filename"]));
R("POST", "/deals", async b => {
  if (!String(b.borrower || "").trim()) throw err("Укажите заёмщика", 400); if (!b.servers || !b.servers.length) throw err("Загрузите перечень оборудования", 400);
  const id = "d" + hex(8); b.servers.forEach(s => s.last_seen = null);
  DB.deals[id] = { id, borrower: b.borrower.trim(), location: (b.location || "").trim() || "—", contract: "КД-" + new Date().getFullYear() + "-" + hex(4).toUpperCase(), telemetry_mode: null, simulated: false, status: "draft", servers: b.servers, agent_token: hex(24), loan: { amount: 0, term: 36, rate: 18, schedule: "annuity", issue_date: iso(today()), covenant: 1.25 } };
  return { id, agent_token: DB.deals[id].agent_token };
});
R("POST", "/deals/([\\w-]+)/telemetry", async (b, m) => { const d = getDeal(m[1]); if (!["agent", "file", "none"].includes(b.mode)) throw err("Неизвестный режим телеметрии", 400); d.telemetry_mode = b.mode; if (b.mode === "none") d.servers.forEach(s => s.gpus.forEach(g => { delete g.temp; delete g.util; delete g.hours; delete g.actual_serial; })); return { ok: true }; });
R("POST", "/deals/([\\w-]+)/telemetry-file", async (b, m, o) => {
  const d = getDeal(m[1]), rows = await parseSmi(o.body, (o.headers || {})["X-Filename"]), bySerial = new Map(d.servers.flatMap(s => s.gpus.map(g => [g.serial, g]))), bySlot = new Map(d.servers.flatMap(s => s.gpus.map(g => [s.name + "|" + g.idx, g]))); let matched = 0; const extra = [];
  rows.forEach(r => { const hit = bySerial.get(r.serial), g = hit || (r.host && r.index != null ? bySlot.get(r.host + "|" + r.index) : null); if (!g) return extra.push(r.serial); g.actual_serial = r.serial; if (hit) matched++; const hrs = g.commissioned ? Math.round((today() - parse(g.commissioned)) / DAY * 24 * .68) : 0; Object.assign(g, { temp: r.temp, util: r.util, hours: hrs }); });
  d.telemetry_mode = "file"; const total = d.servers.reduce((a, s) => a + s.gpus.length, 0); return { total, matched, extra, missing: total - matched };
});
R("POST", "/deals/([\\w-]+)/demo-agent", async (b, m) => { const d = getDeal(m[1]), rng = rngFor(d.id), now = nowS(); d.servers.forEach(s => { s.last_seen = now; const t0 = rng.int(60, 70), u0 = rng.int(82, 93), h0 = rng.int(5200, 7000); s.gpus.forEach(g => Object.assign(g, { actual_serial: g.serial, temp: t0 + rng.int(-2, 2), util: u0 + rng.int(-3, 3), hours: h0 - rng.int(0, 4) })); }); d.telemetry_mode = "agent"; d.simulated = true; return { ok: true }; });
R("POST", "/deals/([\\w-]+)/loan", async (b, m) => {
  const d = getDeal(m[1]), loan = { amount: +b.amount, term: Math.round(+b.term), rate: +b.rate, schedule: b.schedule || "annuity", covenant: +(b.covenant ?? 1.25), issue_date: String(b.issue_date || "") };
  if (![loan.amount, loan.term, loan.rate, loan.covenant].every(Number.isFinite) || !/^\d{4}-\d{2}-\d{2}$/.test(loan.issue_date)) throw err("Проверьте параметры кредита", 400);
  if (!(loan.amount >= 1e5 && loan.amount <= 5e9 && loan.term >= 1 && loan.term <= 120 && loan.rate >= 0 && loan.rate <= 60 && loan.covenant >= 1 && loan.covenant <= 5)) throw err("Параметры вне допустимых пределов", 400);
  if (!d.telemetry_mode) d.telemetry_mode = "none"; d.loan = loan; d.status = "active"; ensureDocs(d); syncAlerts(d); return { id: d.id };
});
R("POST", "/deals/([\\w-]+)/reassess", async (b, m) => { const d = getDeal(m[1]); syncAlerts(d); return dealPayload(d); });
R("GET", "/market", async () => ({ rows: Object.entries(MODELS).map(([key, m]) => ({ key, model: key === "H100" ? "H100 SXM" : m.full, median: m.median, world: m.world, rent: m.rent, markup: m.markup, dealers: m.dealers, accuracy: m.accuracy, low: m.low, high: m.high, low_data: m.dealers < 3, spread: m.dealers >= 3 ? Math.round((m.high / m.low - 1) * 100) : null })), cbr_rate: 82.4, updated: iso(today()) }));
R("GET", "/notifications", async () => [...DB.notifications].sort((a, b) => b.ts - a.ts).map(n => ({ ...n, borrower: DB.deals[n.deal_id] ? DB.deals[n.deal_id].borrower : "—" })));
R("POST", "/notifications/(\\w+)/action", async (b, m) => {
  const n = DB.notifications.find(x => x.id === m[1]); if (!n) throw err("Уведомление не найдено", 404);
  const spec = (ACTIONS[n.kind] || []).find(a => a[0] === b.action) || (n.kind === "link" && b.action === "watch" ? ["watch", "", "Взято под наблюдение"] : null);
  if (!spec || ["decided", "closed"].includes(n.status)) throw err("Действие недоступно", 400); n.status = "decided"; n.decision = `${spec[2]}, ${dmy(iso(today()))}`; n.owner = USER.name; n.actions = []; return n;
});
const settingsGet = async () => ({ ai: { enabled: DB.settings.ai.enabled, base_url: DB.settings.ai.base_url, model: DB.settings.ai.model, interval_min: DB.settings.ai.interval_min, has_key: !!DB.settings.ai.api_key }, simulate: DB.settings.simulate });
R("GET", "/settings", settingsGet);
R("POST", "/settings", async b => { const a = DB.settings.ai, x = b.ai || {}; ["base_url", "model"].forEach(k => { if (typeof x[k] === "string" && x[k].trim()) a[k] = x[k].trim(); }); if ("enabled" in x) a.enabled = !!x.enabled; if (typeof x.api_key === "string" && x.api_key.trim()) a.api_key = x.api_key.trim(); if (x.clear_key) a.api_key = ""; if ("interval_min" in x) a.interval_min = Math.max(1, Math.min(1440, +x.interval_min || 30)); if ("simulate" in b) DB.settings.simulate = !!b.simulate; return settingsGet(); });
R("POST", "/ai/test", async () => { throw err(DEMO_NOTE, 502); });
R("POST", "/deals/([\\w-]+)/ai-analyze", async (b, m) => { const d = getDeal(m[1]), now = nowS(); const rep = rulesReport(d, dealDetail(d, now), now); DB.ai_reports[d.id] = rep; return rep; });
R("POST", "/deals/([\\w-]+)/ai-chat", async (b, m) => {
  const d = getDeal(m[1]), q = String(b.question || "").trim(); if (!q) throw err("Введите вопрос", 400); const now = nowS(), det = dealDetail(d, now), rep = rulesReport(d, det, now);
  return { answer: `Демо-режим: нейросеть не подключена, отвечаю по правилам мониторинга.\n\nПокрытие сейчас ${det.coverage_now == null ? "—" : c2(det.coverage_now)} при ковенанте ${c2(det.forecast.covenant)}. ${rep.summary}\n` + rep.findings.slice(0, 5).map(f => `• ${f.title}${f.server ? " (" + f.server + (f.gpu != null ? ", GPU " + f.gpu : "") + ")" : ""}: ${f.detail}`).join("\n") + (rep.recommendations.length ? "\n\nРекомендации:\n" + rep.recommendations.map(r => "• " + r).join("\n") : "") };
});
R("POST", "/deals/([\\w-]+)/incident", async (b, m) => {
  const d = getDeal(m[1]), srv = d.servers[d.servers.length - 1];
  if (b.type === "overheat") srv.gpus.slice(0, 3).forEach(g => { g.temp = 91; g.hot = true; });
  else if (b.type === "swap") srv.gpus[srv.gpus.length - 1].actual_serial = "1654029999" + hex(3);
  else if (b.type === "offline") { srv.frozen = true; srv.last_seen = nowS() - 7200; }
  else if (b.type === "reset") d.servers.forEach(s => { delete s.frozen; s.last_seen = nowS(); s.gpus.forEach(g => { delete g.hot; if (g.actual_serial && g.actual_serial !== g.serial && g.serial !== "1654023118915") g.actual_serial = g.serial; if ((g.temp || 0) > 80) g.temp = 66; }); });
  else throw err("Неизвестный тип инцидента", 400);
  syncAlerts(d); return { ok: true };
});
R("GET", "/deals/([\\w-]+)/documents", async (b, m) => { const d = getDeal(m[1]); ensureDocs(d); return DB.documents[d.id].map(x => ({ id: x.id, name: x.name, type: x.type, type_label: TYPE_LABEL[x.type], date: x.date, author: x.author, ext: x.ext })); });
R("POST", "/deals/([\\w-]+)/documents", async (b, m, o) => {
  const d = getDeal(m[1]), h = o.headers || {}, type = h["X-Doc-Type"] || "contract"; if (!TYPE_LABEL[type]) throw err("Неизвестный тип документа", 400);
  const fname = decodeURIComponent(h["X-Filename"] || "document"), id = hex(10), ext = fname.includes(".") ? fname.split(".").pop().toLowerCase() : ""; DB.blobs[id] = o.body;
  DB.documents[d.id].push({ id, name: fname.replace(/\.[^.]+$/, ""), type, date: dmy(iso(today())), author: USER.name, ext, file: true }); return { ok: true };
});

window.CC_DEMO = async function (path, opts) {
  opts = opts || {}; const method = opts.body !== undefined ? "POST" : "GET", p = path.split("?")[0];
  await new Promise(r => setTimeout(r, 15));
  if (!["/login", "/me", "/logout"].includes(p) && !ME) throw new Error("Требуется вход");
  for (const [m, rx, fn] of routes) { const mt = rx.exec(p); if (m === method && mt) return JSON.parse(JSON.stringify(await fn(opts.body instanceof Blob ? {} : (opts.body || {}), mt, opts))); }
  throw new Error("Не найдено");
};
window.CC_DEMO_SAMPLES = { template: TEMPLATE, smi: () => { const d = { servers: [] }; return "index, serial, name, temperature.gpu, utilization.gpu [%]\n" + Array.from({ length: 8 }, (_, i) => `${i}, ${1654023118421 + i}, NVIDIA H100 80GB HBM3, ${62 + (i * 3) % 7}, ${82 + (i * 5) % 11} %`).join("\n") + "\n" + Array.from({ length: 8 }, (_, i) => `${i}, ${i === 7 ? "1654023999999" : 1654023118908 + i}, NVIDIA H100 80GB HBM3, ${64 + (i * 2) % 6}, ${85 + (i * 3) % 9} %`).join("\n"); } };

/* ---------- «скачивание»: в песочнице файлы не сохраняются, показываем содержимое в окне ---------- */
function showDoc(title, kind, content) {
  const m = document.createElement("div"); m.className = "modal";
  m.innerHTML = `<div class="card" style="width:min(900px,94vw);max-height:90vh;display:flex;flex-direction:column;padding:22px"><div class="row-between" style="margin-bottom:14px"><h2 style="font-size:19px">${esc(title)}</h2><div class="row">${kind === "text" ? '<button class="btn sm" id="cp">Копировать</button>' : ""}<button class="btn sm primary" id="cl">Закрыть</button></div></div>${kind === "html" ? '<iframe id="fr" style="border:1px solid var(--line);border-radius:12px;flex:1;min-height:60vh;background:#fff"></iframe>' : '<pre id="tx" style="margin:0;overflow:auto;flex:1;background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px;font-size:13px;white-space:pre-wrap"></pre>'}<p class="muted" style="font-size:13px;margin:12px 0 0">В демо файл не сохраняется на диск: в обычной версии приложения это обычная загрузка.</p></div>`;
  document.body.appendChild(m); if (kind === "html") m.querySelector("#fr").srcdoc = content; else m.querySelector("#tx").textContent = content;
  m.querySelector("#cl").onclick = () => m.remove(); m.addEventListener("click", e => { if (e.target === m) m.remove(); });
  const cp = m.querySelector("#cp"); if (cp) cp.onclick = () => { const t = m.querySelector("#tx"); const ok = () => { cp.textContent = "Скопировано"; }; (navigator.clipboard ? navigator.clipboard.writeText(content).then(ok) : Promise.reject()).catch(() => { const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r); cp.textContent = "Выделено — Ctrl+C"; }); };
}
document.addEventListener("click", async e => {
  const a = e.target.closest('a[href^="/api/"]'); if (!a) return; e.preventDefault(); const h = a.getAttribute("href"); let mt;
  if (h === "/api/template.csv") return showDoc("Шаблон перечня оборудования (CSV)", "text", TEMPLATE);
  if ((mt = /^\/api\/deals\/([\w-]+)\/report\.html$/.exec(h))) { const d = getDeal(mt[1]); return showDoc("Заключение об оценке залога", "html", reportHtml(d, dealDetail(d, nowS()), DB.ai_reports[d.id])); }
  if ((mt = /^\/api\/deals\/([\w-]+)\/documents\/(\w+)$/.exec(h))) {
    const d = getDeal(mt[1]), doc = DB.documents[d.id].find(x => x.id === mt[2]); if (!doc) return;
    if (doc.generated === "report") return showDoc(doc.name, "html", reportHtml(d, dealDetail(d, nowS()), DB.ai_reports[d.id]));
    if (doc.generated === "equipment") return showDoc(doc.name + " (CSV)", "text", equipmentCsv(d));
    if (doc.generated === "telemetry") return showDoc(doc.name + " (CSV)", "text", telemetryCsv(d));
    const blob = DB.blobs[doc.id]; if (blob && /^(txt|csv|json|md)$/.test(doc.ext)) return showDoc(doc.name, "text", await blob.text());
    return showDoc(doc.name, "text", `Файл «${doc.name}.${doc.ext}» загружен в демо-сессию (${blob ? Math.round(blob.size / 1024) + " КБ" : ""}). Просмотр бинарных файлов в демо недоступен.`);
  }
}, true);

init(); setInterval(drift, 8000);
})();

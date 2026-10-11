/* ComputeCollateral — автономная демо-версия: «сервер» (расчёты, роли, уведомления, письма, документы) работает в браузере.
   Подменяет fetch к /api через window.CC_DEMO. Порт compute_collateral/*.py — логика и тексты совпадают с серверной версией. */
(function () {
"use strict";
const DAY = 86400000, nowS = () => Date.now() / 1000, pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = s => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const today = () => { const t = new Date(); return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())); };
const todayIso = () => iso(today());
function addMonths(d, k) { const i = d.getUTCMonth() + k, y = d.getUTCFullYear() + Math.floor(i / 12), m = ((i % 12) + 12) % 12, last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last))); }
function monthsBetween(a, b) { const k = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth(); return b.getUTCDate() < a.getUTCDate() ? k - 1 : k; }
const dmy = s => s ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : "—";
const c2 = v => v.toFixed(2).replace(".", ","), m1 = v => (v / 1e6).toFixed(1).replace(".", ","), fm = m1;
const hex = n => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const tsDate = ts => { const d = new Date(ts * 1000); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };
const tsTime = ts => { const d = new Date(ts * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function rngFor(seed) { let h = 1779033703 ^ seed.length; for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; } let a = h >>> 0; const f = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; f.int = (lo, hi) => lo + Math.floor(f() * (hi - lo + 1)); return f; }
const err = (m, status, data) => { const e = new Error(m); e.status = status || 400; e.data = Object.assign({}, data || {}); return e; };
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };

/* ---------- рынок ---------- */
const CBR = 82.4;
const MODELS = {
  H100: { name: "H100 SXM", full: "H100 SXM 80 ГБ", dealers: 9, median: 2650000, world: 2400000, rent: 250, markup: .18, low: 2050000, high: 3050000, accuracy: .06, new: 3190000, secondary: 2962500, util: .84, scen: { opt: .22, base: .316, pess1: .5, pess2: .5, newgen_month: 8, newgen_drop: .15 } },
  H200: { name: "H200", full: "H200", dealers: 2, median: 3400000, world: 3250000, rent: 320, markup: .18, low: 3100000, high: 3600000, accuracy: .15, new: 4100000, secondary: 3300000, util: .75, scen: { opt: .15, base: .25, pess1: .45, pess2: .4, newgen_month: 10, newgen_drop: .1 } },
  A100: { name: "A100 80 ГБ", full: "A100 80 ГБ", dealers: 11, median: 1200000, world: 1050000, rent: 140, markup: .15, low: 950000, high: 1450000, accuracy: .05, new: 1450000, secondary: 1150000, util: .6, scen: { opt: .15, base: .22, pess1: .35, pess2: .35, newgen_month: null, newgen_drop: 0 } },
  L40S: { name: "L40S", full: "L40S", dealers: 7, median: 780000, world: 700000, rent: 90, markup: .15, low: 620000, high: 920000, accuracy: .07, new: 950000, secondary: 740000, util: .6, scen: { opt: .15, base: .2, pess1: .3, pess2: .3, newgen_month: null, newgen_drop: 0 } },
};
const BASE = {}; Object.entries(MODELS).forEach(([k, m]) => BASE[k] = { median: m.median, world: m.world, secondary: m.secondary, new: m.new, rent: m.rent });
const DEALERS = { H100: [["Москва", 2950000, 1], ["Москва", 2800000, 2], ["Санкт-Петербург", 2650000, 1], ["Екатеринбург", 2550000, 3], ["Москва", 3050000, 2], ["Новосибирск", 2450000, 4], ["Казань", 2700000, 2], ["Москва", 2050000, 5], ["Краснодар", 2600000, 1]], H200: [["Москва", 3600000, 3], ["Санкт-Петербург", 3100000, 8]], A100: [["Москва", 1450000, 1], ["Москва", 1350000, 2], ["Санкт-Петербург", 1250000, 1], ["Казань", 1200000, 3], ["Екатеринбург", 1150000, 2], ["Новосибирск", 1100000, 4], ["Москва", 1050000, 2], ["Краснодар", 1000000, 5], ["Москва", 980000, 1], ["Самара", 960000, 6], ["Москва", 950000, 3]], L40S: [["Москва", 920000, 1], ["Санкт-Петербург", 860000, 2], ["Москва", 800000, 2], ["Казань", 780000, 3], ["Екатеринбург", 700000, 4], ["Москва", 650000, 1], ["Краснодар", 620000, 5]] };
const WORLD_DEALS = { H100: 14, H200: 6, A100: 22, L40S: 17 };
const MARKET = { factors: { H100: 1, H200: 1, A100: 1, L40S: 1 }, updated: todayIso(), last_change: {} };
function applyMarket() { for (const [k, m] of Object.entries(MODELS)) for (const f of ["median", "world", "secondary", "new", "rent"]) m[f] = Math.round(BASE[k][f] * MARKET.factors[k]); }
function refreshPrices() { const prev = {}; Object.keys(MODELS).forEach(k => prev[k] = MODELS[k].median); Object.keys(MODELS).forEach(k => MARKET.factors[k] = Math.max(.5, MARKET.factors[k] * (1 + (Math.random() * .018 - .012)))); applyMarket(); MARKET.updated = todayIso(); Object.keys(MODELS).forEach(k => MARKET.last_change[k] = MODELS[k].median / prev[k] - 1); }
const normModel = t => { t = (t || "").toUpperCase().replace(/ /g, ""); return ["H200", "H100", "A100", "L40S"].find(k => t.includes(k)) || null; };

/* ---------- роли ---------- */
const ROLES = { analyst: "Кредитный аналитик", risk: "Управление рисков", collateral: "Залоговая служба", leasing: "ВТБ Лизинг" };
const PERMS = { view: ["analyst", "risk", "collateral", "leasing"], create_assessment: ["analyst"], edit_terms: ["analyst"], reassess: ["analyst", "collateral"], export: ["analyst", "risk", "collateral", "leasing"], upload_docs: ["analyst", "collateral"], decide_equipment: ["collateral"], decide_covenant: ["risk", "collateral"], decide_forecast: ["analyst", "risk"], write_cod: ["analyst", "collateral"], edit_thresholds: ["risk"], own_notify_settings: ["analyst", "risk", "collateral", "leasing"], ai_settings: ["analyst", "risk"] };
const DECIDE_PERM = { swap: "decide_equipment", link: "decide_equipment", hardware: "decide_equipment", covenant: "decide_covenant", threshold: "decide_forecast", forecast: "decide_forecast", ready: "view" };
const RECIPIENTS = { swap: ["collateral"], link: ["collateral"], hardware: ["collateral"], covenant: ["collateral", "risk"], threshold: ["risk"], forecast: ["analyst", "risk"], ready: ["author"] };
const UNIT = { swap: "Залоговая служба", link: "Залоговая служба", hardware: "Залоговая служба", covenant: "Залоговая служба", threshold: "Управление рисков", forecast: "Аналитик", ready: "Система" };
const NOTIFY_TYPES = [["swap", "Подмена оборудования", "Залоговая служба"], ["covenant", "Нарушение ковенанта", "Залоговая служба, управление рисков"], ["forecast", "Прогноз ухудшился", "Аналитик, управление рисков"], ["threshold", "Близко к порогу", "Управление рисков"], ["link", "Нет связи с сервером", "Залоговая служба"], ["ready", "Оценка готова", "Автор оценки"]];
const DEF_NOTIFY = { swap: [1, 1], covenant: [1, 1], forecast: [1, 0], threshold: [1, 0], link: [1, 0], ready: [1, 0], hardware: [1, 0] };
const USERS = [["e.sokolova@bank.ru", "Екатерина Соколова", "Е. Соколова", "ЕС", "analyst"], ["a.kim@bank.ru", "Алексей Ким", "А. Ким", "АК", "risk"], ["m.orlova@bank.ru", "Мария Орлова", "М. Орлова", "МО", "collateral"], ["i.petrov@bank.ru", "Игорь Петров", "И. Петров", "ИП", "collateral"], ["leasing@bank.ru", "Сотрудник ВТБ Лизинга", "ВТБ Лизинг", "ВЛ", "leasing"]].map(([email, name, short, initials, role]) => ({ email, name, short, initials, role, notify: {} }));
const can = (u, p) => !!u && (PERMS[p] || []).includes(u.role);
const pub = u => ({ email: u.email, name: u.name, short: u.short, initials: u.initials, role: u.role, role_label: ROLES[u.role], can: Object.fromEntries(Object.keys(PERMS).map(p => [p, can(u, p)])) });
const notifyPref = (u, k) => { const p = u.notify[k]; if (p) return { app: !!p.app, email: !!p.email }; const d = DEF_NOTIFY[k] || [1, 0]; return { app: !!d[0], email: !!d[1] }; };

/* ---------- движок (порт engine.py) ---------- */
const TH = { covenant: 1.25, near: 1.4, offline_warn_h: 1, offline_notify_h: 24 };
const WEIGHTS = { cost: .3, comparative: .4, income: .3 }, LOW_W = { cost: .4, comparative: .25, income: .35 }, LIQ = .28, NO_TEL = .07, LTV_CAP = .75, SCEN = ["opt", "base", "pess"];
function schedule(amount, term, rate, kind) {
  const bal = [amount]; if (kind === "differentiated") { for (let k = 1; k <= term; k++) bal.push(amount * (1 - k / term)); return bal; }
  const r = rate / 100 / 12, pay = r === 0 ? amount / term : amount * r / (1 - Math.pow(1 + r, -term)); let b = amount;
  for (let i = 0; i < term; i++) { b = Math.max(0, b * (1 + r) - pay); bal.push(b); } bal[bal.length - 1] = 0; return bal;
}
const hasTel = g => g.temp != null;
const gpuWear = g => Math.min((g.hours || 0) / 1000 * .0026 + Math.max(0, (g.temp || 0) - 65) * .0015 + Math.max(0, (g.util || 0) - 92) * .001, NO_TEL);
const silentSec = (s, now) => s.last_seen ? now - s.last_seen : Infinity;
const isSilent = (deal, s, now) => deal.telemetry_mode === "agent" && silentSec(s, now) > TH.offline_warn_h * 3600;
const cardWear = (deal, s, g, now) => (!deal.telemetry_mode || deal.telemetry_mode === "none" || !hasTel(g) || isSilent(deal, s, now)) ? NO_TEL : gpuWear(g);
function dealWear(deal, now) { const ws = deal.servers.flatMap(s => s.gpus.map(g => cardWear(deal, s, g, now))); return ws.length ? ws.reduce((a, b) => a + b, 0) / ws.length : NO_TEL; }
const serverWear = (deal, s, now) => s.gpus.length ? s.gpus.reduce((a, g) => a + cardWear(deal, s, g, now), 0) / s.gpus.length : NO_TEL;
function incomePerCard(m) { const year = m.rent * 8760 * m.util; let t = 0; for (let i = 0; i < 3; i++) t += year * Math.pow(.7, i) / Math.pow(1.22, i + 1); return t; }
function valuation(deal, now) {
  now = now || nowS(); const counts = {}; deal.servers.forEach(s => counts[s.model] = (counts[s.model] || 0) + s.gpus.length);
  const wear = dealWear(deal, now); let cost = 0, comp = 0, inc = 0; const per = {}, low = [];
  for (const [model, n] of Object.entries(counts)) {
    const m = MODELS[model], c = n * m.new, lw = m.dealers < 3, cp = n * (lw ? m.world : m.secondary), ic = n * incomePerCard(m); if (lw) low.push(model);
    const w = lw ? LOW_W : WEIGHTS, bl = w.cost * c + w.comparative * cp + w.income * ic;
    per[model] = { cards: n, cost: c, comparative: cp, income: ic, weighted: bl, market: bl * (1 - wear) }; cost += c; comp += cp; inc += ic;
  }
  const weighted = Object.values(per).reduce((a, p) => a + p.weighted, 0), market = weighted * (1 - wear), cards = Object.values(counts).reduce((a, b) => a + b, 0);
  return { cost, comparative: comp, income: inc, weighted, wear, market, liquidation: market * (1 - LIQ), per_card: cards ? market / cards : 0, cards, per_model: per, low_data: low, liquidation_discount: LIQ };
}
function scenFactor(model, scen, m) {
  const s = MODELS[model].scen; if (scen === "opt") return Math.pow(1 - s.opt, m / 12); if (scen === "base") return Math.pow(1 - s.base, m / 12);
  let f = Math.pow(1 - s.pess1, Math.min(m, 12) / 12) * Math.pow(1 - s.pess2, Math.max(m - 12, 0) / 12); if (s.newgen_month != null && m >= s.newgen_month) f *= 1 - s.newgen_drop; return f;
}
function forecast(deal, loan, val) {
  loan = loan || deal.loan; val = val || valuation(deal); const amount = +loan.amount, term = +loan.term, rate = +loan.rate, cv = +(loan.covenant ?? 1.25), issue = parse(loan.issue_date);
  const sched = schedule(amount, term, rate, loan.schedule || "annuity"), t0 = today(), elapsed = Math.min(Math.max(0, monthsBetween(issue, t0)), term), start = elapsed > 0 ? t0 : issue, n = term - elapsed, pts = [];
  for (let m = 0; m <= n; m++) { const row = { m, date: iso(addMonths(start, m)), debt: sched[elapsed + m] }; for (const sc of SCEN) row[sc] = Object.entries(val.per_model).reduce((a, [model, pm]) => a + pm.market * scenFactor(model, sc, m), 0); pts.push(row); }
  pts.forEach(p => SCEN.forEach(sc => p[sc + "_liq"] = p[sc] * (1 - LIQ)));
  return { points: pts, elapsed, covenant: cv, amount, term, rate };
}
const coverage = (v, d) => d <= 1 ? null : v / d;
function pessGap(pts) { const g = pts.filter(p => p.debt > 1 && p.pess < p.debt); if (!g.length) return null; return { first_month: g[0].m, first_date: g[0].date, months: g[g.length - 1].m - g[0].m + 1, max_gap: Math.max(...g.map(p => p.debt - p.pess)), last_date: g[g.length - 1].date }; }
function recommend(fc, market, scen, basis) {
  const key = (scen || "pess") + (basis === "liquidation" ? "_liq" : ""), covs = fc.points.filter(p => p.debt > 1).map(p => p[key] / p.debt), minCov = covs.length ? Math.min(...covs) : 99; let maxLoan = fc.amount * minCov;
  if (market && maxLoan > LTV_CAP * market) maxLoan = LTV_CAP * market;
  return { max_loan: maxLoan, ltv: market ? maxLoan / market : 0, requested_ltv: market ? fc.amount / market : 0, exceeds: fc.amount > maxLoan + 1, min_pess_coverage: minCov, headroom: maxLoan - fc.amount };
}
const halfYear = fc => fc.points.filter(p => p.m && p.m % 6 === 0).map(p => { const paid = p.debt <= 1; return { date: p.date, debt: p.debt, paid, base: paid ? null : p.base / p.debt, pess: paid ? null : p.pess / p.debt }; });
const mismatches = deal => deal.servers.flatMap(s => s.gpus.filter(g => g.actual_serial && g.actual_serial !== g.serial).map(g => ({ server: s.name, gpu: g.idx, contract: g.serial, actual: g.actual_serial })));
const isOnline = (s, now) => !!s.last_seen && now - s.last_seen <= TH.offline_warn_h * 3600;
function equipmentState(deal, now) {
  const mism = mismatches(deal), mode = deal.telemetry_mode, offline = deal.servers.filter(s => mode === "agent" && !isOnline(s, now)).map(s => s.name);
  const all = deal.servers.flatMap(s => s.gpus), total = all.length, seen = all.filter(g => g.actual_serial).length, matched = all.filter(g => g.actual_serial === g.serial).length; let label, code;
  if (mism.length) [label, code] = ["Подмена", "swap"]; else if (offline.length) [label, code] = ["Нет связи", "offline"]; else if (mode === "none" || !seen) [label, code] = ["Нет данных", "nodata"]; else [label, code] = ["На месте", "ok"];
  const silent = deal.servers.filter(s => offline.includes(s.name)).map(s => ({ server: s.name, cards: s.gpus.length, hours: s.last_seen ? silentSec(s, now) / 3600 : null, last_seen: s.last_seen }));
  return { code, label, mismatches: mism, offline, silent, online: deal.servers.filter(s => mode === "agent" && isOnline(s, now)).length, servers: deal.servers.length, total, matched, seen };
}
const nearLevel = cv => cv * TH.near / TH.covenant;
const statusOf = (c, cv) => c == null ? "ok" : c < cv ? "breach" : c < nearLevel(cv) ? "near" : "ok";
function dealSummary(deal, now) {
  const val = valuation(deal, now), fc = forecast(deal, null, val), p0 = fc.points[0], cn = coverage(val.market, p0.debt), p12 = fc.points[Math.min(12, fc.points.length - 1)], eq = equipmentState(deal, now), models = {};
  deal.servers.forEach(s => models[s.model] = (models[s.model] || 0) + s.gpus.length); const ents = Object.entries(models);
  return { id: deal.id, borrower: deal.borrower, market: val.market, debt: p0.debt, coverage: cn, coverage12: coverage(p12.pess, p12.debt), equipment: eq.label, equipment_code: eq.code, status: statusOf(cn, fc.covenant), covenant: fc.covenant, title: ents.length === 1 ? `${ents[0][1]} × ${ents[0][0]}` : ents.map(([m, n]) => `${n} × ${m}`).join(" + ") };
}
function dealDetail(deal, now) {
  now = now || nowS(); const val = valuation(deal, now), fc = forecast(deal, null, val), pts = fc.points, p0 = pts[0], cn = coverage(val.market, p0.debt), notes = {};
  Object.keys(val.per_model).forEach(m => { const s = MODELS[m].scen; notes[m] = { pess1: s.pess1, newgen_drop: s.newgen_drop, newgen_month: s.newgen_month }; });
  return { valuation: val, forecast: fc, coverage_now: cn, status: statusOf(cn, fc.covenant), recommendation: recommend(fc, val.market), gap: pessGap(pts), gap12: pessGap(pts.filter(p => p.m <= 12)), equipment: equipmentState(deal, now), half_year: halfYear(fc), scenario_notes: notes, debt_now: p0.debt };
}
function serversView(deal, now) {
  const mode = deal.telemetry_mode;
  return deal.servers.map(s => { const tele = s.gpus.filter(hasTel), avg = k => tele.length ? Math.round(tele.reduce((a, g) => a + (g[k] || 0), 0) / tele.length) : null;
    return { name: s.name, model: s.model, cards: s.gpus.length, hours: avg("hours"), util: avg("util"), temp: avg("temp"), wear: mode ? serverWear(deal, s, now) : null, matched: s.gpus.filter(g => g.actual_serial === g.serial).length, seen: s.gpus.filter(g => g.actual_serial).length,
      online: mode === "agent" ? isOnline(s, now) : null, silent_hours: mode === "agent" && s.last_seen ? silentSec(s, now) / 3600 : null, last_seen: s.last_seen,
      gpus: s.gpus.map(g => ({ idx: g.idx, serial: g.serial, actual: g.actual_serial, temp: g.temp, util: g.util, hours: g.hours, match: g.actual_serial ? g.actual_serial === g.serial : null })) }; });
}

/* ---------- состояние и демо-данные ---------- */
const DB = { users: USERS, deals: {}, notifications: [], documents: {}, ai_reports: {}, outbox: [], requests: {}, blobs: {}, settings: { ai: { enabled: false, base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", interval_min: 30, api_key: "" }, simulate: true } };
let ME = null; const FAILS = {};
function innMake(b9) { const d = [...b9].map(Number); return b9 + String(d.reduce((a, x, i) => a + x * [2, 4, 10, 3, 5, 9, 4, 6, 8][i], 0) % 11 % 10); }
function innOk(inn) { if (!/^(\d{10}|\d{12})$/.test(inn)) return false; const d = [...inn].map(Number), chk = ws => ws.reduce((a, w, i) => a + w * d[i], 0) % 11 % 10; if (inn.length === 10) return chk([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9]; return chk([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && chk([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11]; }
const agentKey = () => { const al = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ", r = () => al[Math.floor(Math.random() * al.length)]; return "CC-" + r() + r() + r() + r() + "-" + r() + r() + r() + r(); };
const DEALS = [
  ["datafork", "ООО «ДатаФорж»", "L40S", 6, "ЦОД «Юг-1», Краснодар", 1.06, 8, 24, 19, {}], ["sibcomp", "АО «Сибирские вычисления»", "A100", 8, "ЦОД «Сибирь», Новосибирск", 1.32, 7, 36, 17.5, {}],
  ["neuroset", "ООО «Нейросеть Регион»", "H100", 3, "ЦОД «Урал», Екатеринбург", 1.33, 5, 36, 18, { swap: ["srv-02", 5] }],
  ["neurocluster", "ООО «Нейрокластер»", "H100", 4, "ЦОД «Север-2», Москва", null, 0, 36, 18, { amount: 6e7, hours: [6120, 6340, 7010, 5980], temps: [64, 67, 72, 62], utils: [87, 91, 94, 83], issue: "fixed" }],
  ["quantcloud", "ООО «Квант Облако»", "H200", 2, "ЦОД «Балт», Санкт-Петербург", 1.66, 6, 36, 17, {}], ["technocod", "ПАО «ТехноЦОД»", "A100", 5, "ЦОД «Центр», Москва", 2.03, 9, 36, 16.5, {}],
];
const REQ = { datafork: ["234010101", "КД-2026-0311", "Олег Лебедев", "o.lebedev@dataforge.example"], sibcomp: ["540210202", "КД-2026-0287", "Нина Ким", "n.kim@sibvych.example"], neuroset: ["667010303", "КД-2026-0377", "Павел Зуев", "p.zuev@neuroset.example"], neurocluster: ["770123456", "КД-2026-0418", "Андрей Морозов", "a.morozov@neurocluster.example"], quantcloud: ["780210404", "КД-2026-0345", "Анна Фомина", "a.fomina@quant.example"], technocod: ["770710505", "КД-2026-0301", "Сергей Лукин", "s.lukin@technocod.example"] };
const SBASE = { datafork: 1654011118421, sibcomp: 1654012118421, neuroset: 1654013118421, neurocluster: 1654023118421, quantcloud: 1654014118421, technocod: 1654015118421 };
function buildServers(rng, model, n, serial, sp) {
  const out = [];
  for (let i = 0; i < n; i++) { const comm = i === 0 ? "2025-02-12" : i < 3 ? "2025-06-03" : "2025-09-01", hrs = (sp.hours && sp.hours[i]) || rng.int(5200, 7400), t0 = (sp.temps && sp.temps[i]) || rng.int(60, 72), u0 = (sp.utils && sp.utils[i]) || rng.int(80, 95), gpus = [];
    for (let g = 0; g < 8; g++) { gpus.push({ idx: g, serial: String(serial), commissioned: comm, actual_serial: String(serial), temp: t0 + rng.int(-2, 2), util: Math.min(99, u0 + rng.int(-3, 3)), hours: hrs - rng.int(0, 4) }); serial++; }
    out.push({ name: `srv-${pad(i + 1)}`, model, gpus, last_seen: nowS() }); serial += rng.int(300, 600); }
  return out;
}
function snapshot(deal, author, now, factor) { now = now || nowS(); const v = valuation(deal, now), rec = recommend(forecast(deal, null, v), v.market); return { ts: now, author, market: v.market * (factor || 1), liquidation: v.liquidation * (factor || 1), ltv: rec.ltv, wear: v.wear, cards: v.cards, prices: Object.fromEntries(Object.keys(MODELS).map(k => [k, MODELS[k].median])) }; }
function makeDeal(d, idx) {
  const [id, borrower, model, ns, loc, target, elapsed, term, rate, ex] = d, rng = rngFor(id), servers = buildServers(rng, model, ns, SBASE[id], ex);
  if (ex.swap) { const g = servers.find(s => s.name === ex.swap[0]).gpus[ex.swap[1]]; g.serial = "1654023118915"; g.actual_serial = "1654023887102"; }
  const [inn9, app, contact, email] = REQ[id], deal = { id, borrower, inn: innMake(inn9), location: loc, contract: app, application: app, contact, contact_email: email, telemetry_mode: "agent", simulated: true, status: "active", servers, author: "e.sokolova@bank.ru", agent_token: hex(24), agent_key: agentKey(), assessments: [] };
  let amount = ex.amount; if (amount == null) { const mk = valuation(deal).market, f = schedule(1, term, rate)[elapsed]; amount = Math.round(mk / (target * f) / 1e5) * 1e5; }
  const issue = ex.issue ? iso(new Date(today().getTime() + 7 * DAY)) : iso(addMonths(today(), -elapsed));
  deal.loan = { amount, term, rate, schedule: "annuity", issue_date: issue, covenant: 1.25 }; return deal;
}

/* ---------- уведомления ---------- */
const LABELS = { swap: "Подмена оборудования", covenant: "Нарушение ковенанта", threshold: "Близко к порогу", forecast: "Прогноз", link: "Связь с сервером", hardware: "Состояние оборудования", ready: "Оценка готова" };
const ACTIONS = { swap: [["inspect", "Назначить проверку"], ["request", "Запросить обеспечение"]], link: [["write_cod", "Написать в ЦОД"]], hardware: [["inspect", "Назначить проверку"], ["watch", "Наблюдать"]], covenant: [["request", "Запросить обеспечение"], ["reassess", "Назначить переоценку"]], threshold: [["reassess", "Назначить переоценку"], ["watch", "Наблюдать"]], forecast: [["params", "Изменить параметры"], ["watch", "Наблюдать"]], ready: [["open", "Открыть компанию"]] };
const STATE = { new: "новое", in_work: "в работе", decided: "решение принято", watching: "на наблюдении", closed: "закрыто" }, OPEN = ["new", "in_work"];
const openNote = key => DB.notifications.find(n => n.key === key && !["closed", "decided"].includes(n.status));
function addNote(deal, kind, title, text, sev, now, rec, author, status) {
  const n = { id: "n" + (DB.notifications.length + 1), deal_id: deal.id, kind, label: LABELS[kind], title, text, severity: sev, ts: now, status: status || "new", recommendation: rec || null, unit: UNIT[kind], assignee: null, decision: null, wake_at: null, key: `${deal.id}:${kind}`, author: author || null };
  DB.notifications.push(n);
  DB.users.forEach(u => { const want = RECIPIENTS[kind] || []; if ((want.includes(u.role) || (want.includes("author") && author === u.email)) && notifyPref(u, kind).email) DB.outbox.push({ to: u.email, subject: `[ComputeCollateral] ${n.label}: ${deal.borrower}`, body: title, kind: "notification", ts: now }); });
  return n;
}
function syncAlerts(deal, now) {
  if (deal.status !== "active") return; now = now || nowS(); const d = dealDetail(deal, now), id = deal.id;
  DB.notifications.forEach(n => { if (n.deal_id === id && n.status === "watching" && n.wake_at && n.wake_at <= now) { n.status = "new"; n.text += ". Срок наблюдения истёк"; n.wake_at = null; } });
  const mm = d.equipment.mismatches; if (mm.length && !openNote(id + ":swap")) addNote(deal, "swap", "Серийный номер карты не совпадает с договором", `Сервер ${mm[0].server}, GPU ${mm[0].gpu}. По договору s/n ${mm[0].contract}, установлен ${mm[0].actual}`, "high", now, "Выездная проверка, приостановить выдачу траншей");
  const cov = d.coverage_now, cv = d.forecast.covenant;
  if (d.status === "breach" && !openNote(id + ":covenant")) { const need = cv * d.debt_now - d.valuation.market; addNote(deal, "covenant", `Покрытие ${c2(cov)} при ковенанте ${c2(cv)}`, `Для возврата к ковенанту не хватает ${fm(need)} млн ₽`, "high", now, `Дополнительное обеспечение на ${fm(need)} млн ₽`); }
  else if (d.status === "near" && !openNote(id + ":threshold") && !DB.notifications.some(n => n.deal_id === id && n.kind === "threshold" && now - n.ts < 30 * 86400)) addNote(deal, "threshold", `Покрытие снизилось до ${c2(cov)}`, `Ковенант ${c2(cv)}, запас ${Math.round((cov / cv - 1) * 100)} %`, "medium", now, "Назначить переоценку или наблюдать");
  const g = d.gap12; if (g && !openNote(id + ":forecast")) addNote(deal, "forecast", `Через ${g.first_month} ${plural(g.first_month, "месяц", "месяца", "месяцев")} залог может стать дешевле долга`, `В пессимистичном сценарии разрыв продлится ${g.months} мес., максимум ${fm(g.max_gap)} млн ₽`, "medium", now, `Снизить сумму до ${fm(d.recommendation.max_loan)} млн ₽ или сократить срок`);
  if (deal.telemetry_mode === "agent") {
    const ls = deal.servers.filter(s => s.last_seen && silentSec(s, now) > TH.offline_notify_h * 3600), ex = openNote(id + ":link");
    if (ls.length && !ex) addNote(deal, "link", `Сервер ${ls[0].name} не передаёт данные ${Math.floor(silentSec(ls[0], now) / 3600)} ч`, `Последние данные ${tsDate(ls[0].last_seen)} в ${tsTime(ls[0].last_seen)}. Карты сервера оценены с поправкой 7 %`, "low", now, "Написать в ЦОД");
    else if (ex && !ls.length) { ex.status = "closed"; ex.unit = "Система"; ex.text += `. Связь восстановлена в ${tsTime(now)}`; }
  }
  const hot = deal.servers.flatMap(s => s.gpus.filter(g2 => (g2.temp || 0) >= 85).map(g2 => [s.name, g2])); if (hot.length && !openNote(id + ":hardware")) addNote(deal, "hardware", `Перегрев: ${hot[0][0]}, GPU ${hot[0][1].idx} — ${hot[0][1].temp} °C`, "Температура выше 85 °C ускоряет износ и снижает стоимость залога", "medium", now, "Проверить охлаждение и нагрузку");
}
function noteView(n, user) {
  const deal = DB.deals[n.deal_id], perm = DECIDE_PERM[n.kind] || "view", open = OPEN.includes(n.status), canDo = n.kind === "ready" ? n.author === user.email : can(user, perm), dec = n.decision, parts = [n.unit || ""];
  if (n.assignee || (dec && dec.by)) parts.push(n.assignee || dec.by); let st = STATE[n.status]; if (n.status === "watching" && n.wake_at) st += " до " + tsDate(n.wake_at); parts.push(st);
  const o = Object.assign({}, n); delete o.author; return Object.assign(o, { borrower: deal ? deal.borrower : "—", meta: parts.filter(Boolean).join(", "), can_decide: open && canDo, actions: open && canDo ? (ACTIONS[n.kind] || []).map(([a, l], i) => ({ id: a, label: l, primary: i === 0 })) : [] });
}
const visibleNotes = u => DB.notifications.filter(n => !(n.kind === "ready" && n.author !== u.email) && notifyPref(u, n.kind).app);
const pending = u => visibleNotes(u).filter(n => OPEN.includes(n.status)).length;
function seedNotes() {
  const now = nowS(), day = 86400;
  const n = (deal, kind, title, text, sev, unit, assignee, status, hoursAgo, rec, decision, wake) => DB.notifications.push({ id: "n" + (DB.notifications.length + 1), deal_id: deal, kind, label: LABELS[kind], title, text, severity: sev, ts: now - hoursAgo * 3600, status, recommendation: rec || null, unit, assignee, decision: decision || null, wake_at: wake ? now + wake * day : null, key: `${deal}:${kind}`, author: null });
  n("neuroset", "swap", "Серийный номер карты не совпадает с договором", "Сервер srv-02, GPU 5. По договору s/n 1654023118915, установлен 1654023887102", "high", "Залоговая служба", "М. Орлова", "in_work", 32, "Выездная проверка, приостановить выдачу траншей");
  n("datafork", "covenant", "Покрытие 1,06 при ковенанте 1,25", "Ставки аренды L40S упали на 18 % за квартал, оценка снизилась на 4,1 млн ₽", "high", "Залоговая служба", "И. Петров", "new", 24, "Дополнительное обеспечение на 7,2 млн ₽");
  n("neurocluster", "forecast", "Через 10 месяцев залог может стать дешевле долга", "После выхода нового поколения чипов цены H100 могут упасть ещё на 15 %", "medium", "Аналитик", "Е. Соколова", "new", 21, "Снизить сумму до 49,3 млн ₽ или сократить срок");
  n("sibcomp", "threshold", "Покрытие снизилось до 1,32", "Цены дилеров на A100 упали на 9 % за месяц", "medium", "Управление рисков", "А. Ким", "decided", 72, null, { text: "Назначена переоценка, " + tsDate(now), by: "А. Ким", ts: now - 70 * 3600 });
  n("technocod", "link", "Сервер srv-07 не передавал данные 3 часа", "Плановые работы в ЦОДе, связь восстановлена в 14:20", "low", "Система", null, "closed", 168);
  n("neuroset", "threshold", "Покрытие снизилось до 1,33", "Ковенант 1,25, запас 6 %", "medium", "Управление рисков", "А. Ким", "decided", 96, null, { text: "Назначена переоценка, " + tsDate(now), by: "А. Ким", ts: now - 90 * 3600 });
  n("neuroset", "forecast", "Через 9 месяцев залог может стать дешевле долга", "В пессимистичном сценарии разрыв продлится 20 мес.", "medium", "Аналитик", "Е. Соколова", "watching", 120, "Снизить сумму или сократить срок", { text: "Оставлено на наблюдении", by: "Е. Соколова", ts: now - 100 * 3600 }, 20);
}
const staff = () => DB.users.filter(u => u.role !== "leasing");
const staffShort = key => { const u = DB.users.find(x => x.email === key || x.short === key); return u ? u.short : null; };
function ensureDocs(deal, author) {
  const dl = DB.documents[deal.id] = DB.documents[deal.id] || [], have = new Set(dl.map(d => d.generated)), mode = deal.telemetry_mode;
  [["report", "Заключение об оценке залога", "conclusion", author || "Система", "pdf"], ["equipment", "Перечень оборудования", "data", "От заёмщика", "xlsx"], ["telemetry", "Данные с серверов на дату оценки", "data", mode === "agent" ? "Агент" : "Файл nvidia-smi", "csv"]].forEach(([g, name, type, who, ext]) => { if (g === "telemetry" && (!mode || mode === "none")) return; if (!have.has(g)) dl.push({ id: hex(10), name, type, date: tsDate(nowS()), ts: nowS(), author: who, generated: g, ext }); });
}
function init() {
  applyMarket(); DEALS.forEach((d, i) => { const deal = makeDeal(d, i); DB.deals[deal.id] = deal; });
  Object.values(DB.deals).forEach(d => d.assessments.push(snapshot(d, "Е. Соколова", nowS() - 3 * 86400, d.id === "neurocluster" ? 1.0245 : 1.01)));
  seedNotes(); Object.values(DB.deals).forEach(d => { syncAlerts(d); ensureDocs(d, "Е. Соколова"); });
}

/* ---------- разбор файлов ---------- */
function csvRows(text) { text = text.replace(/^﻿/, ""); const first = text.split(/\r?\n/)[0] || "", delim = [";", "\t", ","].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0], rows = [];
  text.split(/\r?\n/).forEach((line, i) => { if (!line.trim()) return; const out = []; let cur = "", q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === delim && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); rows.push([i + 1, out.map(x => x.trim())]); }); return rows; }
const SYN = { server: ["сервер", "server", "host", "hostname", "узел"], model: ["модель", "model", "gpu", "name", "карта"], serial: ["серийный", "serial", "s/n", "sn"], date: ["дата", "date", "commission", "ввод"] }, COLT = { server: "Сервер", model: "Модель", serial: "Серийный номер", date: "Дата ввода" };
const pDate = s => { let m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s); if (m) return `${m[3]}-${m[2]}-${m[1]}`; m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
async function readText(blob, name, size) {
  if (!blob || !blob.size) throw err("Файл пуст", 422); if (blob.size > 10 * 1024 * 1024) throw err("Файл больше 10 МБ", 422);
  if (/\.xlsx?m?$/i.test(name || "")) throw err("В демо-версии поддерживается только CSV. Используйте «Загрузить пример» или скачайте шаблон", 422);
  if (!/\.(csv|txt|tsv)$/i.test(name || "")) throw err("Нужен файл Excel (.xlsx) или CSV", 422); return await blob.text();
}
async function parseEquipment(blob, name) {
  const raw = csvRows(await readText(blob, name)); if (!raw.length) throw err("Файл пуст", 422);
  const cols = {}; raw[0][1].forEach((h, i) => { const hl = h.toLowerCase(); for (const [k, syn] of Object.entries(SYN)) if (!(k in cols) && syn.some(s => hl.includes(s))) cols[k] = i; });
  const miss = ["server", "model", "serial", "date"].filter(k => !(k in cols)); if (miss.length) throw err("В файле нет колонки «" + miss.map(k => COLT[k]).join("», «") + "». Скачайте шаблон и сверьтесь с ним", 422);
  const body = raw.slice(1); if (body.length > 1000) throw err(`В файле ${body.length} строк, максимум 1000`, 422);
  const first = {}, rows = [], servers = new Map(), t = todayIso();
  body.forEach(([line, r]) => {
    const name2 = r[cols.server] || "", mraw = r[cols.model] || "", serial = (r[cols.serial] || "").replace(/\.0$/, ""), d = pDate(r[cols.date] || ""), model = normModel(mraw); let e = null;
    if (!name2) e = "Не указан сервер"; else if (!model) e = "Модель не поддерживается: только H100, H200, A100, L40S"; else if (!serial) e = "Нет серийного номера"; else if (!/^\d{13}$/.test(serial)) e = "Серийный номер: 13 цифр"; else if (serial in first) e = `Серийный номер повторяется, см. строку ${first[serial]}`;
    else if (!d) e = "Дата ввода: ДД.ММ.ГГГГ"; else if (d > t) e = "Дата ввода позже сегодняшней"; else if (servers.has(name2) && servers.get(name2).model !== model) e = `В сервере ${name2} смешаны модели ${servers.get(name2).model} и ${model}`;
    if (serial && !(serial in first)) first[serial] = line; rows.push({ line, server: name2, model: mraw, serial, date: d, ok: !e, error: e });
    if (!e) { if (!servers.has(name2)) servers.set(name2, { name: name2, model, gpus: [] }); const s = servers.get(name2); s.gpus.push({ idx: s.gpus.length, serial, commissioned: d }); }
  });
  const list = [...servers.values()]; return { rows, servers: list, errors: rows.filter(r => !r.ok).length, total: rows.length, cards: list.reduce((a, s) => a + s.gpus.length, 0), count_servers: list.length };
}
async function parseSmi(blob, name) {
  const raw = csvRows(await readText(blob, name)); if (!raw.length) throw err("Файл пуст", 422); const head = raw[0][1].map(h => h.toLowerCase()), find = (...k) => { const i = head.findIndex(h => k.some(x => h.includes(x))); return i < 0 ? null : i; };
  const iS = find("serial"), iT = find("temperature", "temp"), iU = find("utilization", "util", "загруз"), iH = find("host", "server", "сервер"), iI = find("index");
  if (iS == null || iT == null) throw err("В файле нет колонок serial и temperature.gpu (команда: nvidia-smi --query-gpu=index,serial,name,temperature.gpu,utilization.gpu --format=csv)", 422);
  const num = v => parseFloat(String(v).replace(/[^\d.]/g, "")) || 0;
  return raw.slice(1).map(x => x[1]).filter(r => r.length > Math.max(iS, iT)).map(r => ({ serial: r[iS].replace(/\.0$/, ""), temp: num(r[iT]), util: iU != null ? num(r[iU]) : 0, host: iH != null ? r[iH] : null, index: iI != null ? Math.round(num(r[iI])) : null }));
}
const TEMPLATE = (() => { let s = "Сервер;Модель;Серийный номер;Дата ввода\r\n", n = 1654023118421; for (const [srv, d] of [["srv-01", "12.02.2025"], ["srv-02", "03.06.2025"]]) for (let i = 0; i < 8; i++) s += `${srv};H100 SXM 80 ГБ;${n++};${d}\r\n`; return s; })();
const smiCsv = servers => "index, serial, name, temperature.gpu, utilization.gpu [%]\n" + (servers || []).flatMap(s => s.gpus.map((g, i) => `${g.idx}, ${g.serial}, NVIDIA ${s.model} 80GB, ${62 + (i * 3) % 7}, ${82 + (i * 5) % 11} %`)).join("\n");
const equipmentCsv = deal => "Сервер;Модель;Серийный номер;Дата ввода\r\n" + deal.servers.flatMap(s => s.gpus.map(g => [s.name, s.model, g.serial, g.commissioned ? dmy(g.commissioned) : ""].join(";"))).join("\r\n");
const telemetryCsv = deal => "server;index;serial_contract;serial_actual;temperature_c;utilization_pct;hours\r\n" + deal.servers.flatMap(s => s.gpus.map(g => [s.name, g.idx, g.serial, g.actual_serial || "", g.temp ?? "", g.util ?? "", g.hours != null ? Math.round(g.hours) : ""].join(";"))).join("\r\n");

/* ---------- заключение (HTML-предпросмотр) ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const RUB = v => (v / 1e6).toFixed(1).replace(".", ",") + " млн ₽";
function conclusionHtml(deal, detail, secs, author, metaOverride) {
  secs = secs || ["valuation", "forecast", "equipment", "schedule"]; const v = detail.valuation, fc = detail.forecast, rec = detail.recommendation, eq = detail.equipment, now = nowS(), sv = serversView(deal, now);
  const tbl = (h, rows) => `<table><tr>${h.map(x => `<th>${esc(x)}</th>`).join("")}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
  let out = `<p class="m">ComputeCollateral</p><h1>Заключение об оценке залога</h1><p class="m">${esc(deal.borrower)} · сделка ${esc(deal.contract)} · ${esc(deal.location)}<br>${esc(metaOverride || "Подготовил: " + author + " · " + tsDate(now))}</p>
  <div class="grid"><div><div class="m">Рыночная стоимость</div><div class="big">${RUB(v.market)}</div></div><div><div class="m">Ликвидационная стоимость</div><div class="big">${RUB(v.liquidation)}</div></div><div><div class="m">Рекомендуемый LTV</div><div class="big">${(rec.ltv * 100).toFixed(1).replace(".", ",")} %</div></div></div>
  <h2>Параметры кредита</h2><p>Сумма ${RUB(fc.amount)}, срок ${fc.term} мес., ставка ${String(fc.rate).replace(".", ",")} % годовых, ковенант покрытия ${c2(fc.covenant)}. Текущее покрытие: ${detail.coverage_now == null ? "—" : c2(detail.coverage_now)}. Рекомендуемая максимальная сумма: ${RUB(rec.max_loan)}.</p>`;
  if (secs.includes("valuation")) out += `<h2>Из чего сложилась оценка</h2>` + tbl(["Подход", "Вес", "Стоимость"], [["Затратный", v.low_data.length ? "40 %" : "30 %", RUB(v.cost)], ["Сравнительный", v.low_data.length ? "25 %" : "40 %", RUB(v.comparative)], ["Доходный", v.low_data.length ? "35 %" : "30 %", RUB(v.income)], ["Среднее с учётом весов", "", RUB(v.weighted)], ["Поправка за износ", "", "−" + (v.wear * 100).toFixed(1).replace(".", ",") + " %"], ["Рыночная стоимость", "", RUB(v.market)]]);
  if (secs.includes("forecast")) out += `<h2>Прогноз покрытия</h2>` + tbl(["Дата", "Остаток долга", "Базовый", "Пессим."], detail.half_year.map(r => [dmy(r.date), RUB(r.debt), r.paid ? "погашен" : c2(r.base), r.paid ? "погашен" : c2(r.pess)]));
  if (secs.includes("equipment")) out += `<h2>Оборудование</h2><p>${v.cards} карт. Серийные номера подтверждены: ${eq.matched} из ${eq.total}.</p>` + tbl(["Сервер", "Карт", "Наработка, ч", "Загрузка", "Темп.", "Серийные номера", "Связь"], sv.map(s => [s.name, s.cards, s.hours ?? "—", s.util == null ? "—" : s.util + " %", s.temp == null ? "—" : s.temp + " °C", s.seen ? `${s.matched} из ${s.cards}` : "не проверены", s.online === true ? "на связи" : s.online === false ? "нет связи" : "—"]));
  if (secs.includes("schedule")) { const sc = schedule(fc.amount, fc.term, fc.rate, deal.loan.schedule), st = parse(deal.loan.issue_date); out += `<h2>График погашения</h2>` + tbl(["№", "Дата", "Остаток долга после платежа"], sc.slice(1).map((b, k) => [k + 1, dmy(iso(addMonths(st, k + 1))), RUB(b)])); }
  const risks = []; if (detail.gap) risks.push(`В пессимистичном сценарии залог станет дешевле долга ${dmy(detail.gap.first_date)}; разрыв продлится ${detail.gap.months} мес., максимум ${RUB(detail.gap.max_gap)}.`); if (rec.exceeds) risks.push(`Запрошенная сумма ${RUB(fc.amount)} выше рекомендуемой ${RUB(rec.max_loan)}.`);
  eq.mismatches.forEach(m => risks.push(`Серийный номер не совпадает: ${m.server}, GPU ${m.gpu} — по договору ${m.contract}, установлен ${m.actual}.`)); (eq.silent || []).forEach(s => risks.push(`Сервер ${s.server} не передаёт данные, его карты оценены с поправкой 7 %.`));
  out += `<h2>Риски и замечания</h2><ul>${risks.map(r => `<li>${esc(r)}</li>`).join("") || "<li>Существенных рисков не выявлено.</li>"}</ul>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>body{font:14px/1.5 Manrope,Arial,sans-serif;color:#051F45;margin:0;padding:24px 28px;background:#fff}h1{font-size:24px;margin:0}h2{font-size:16px;margin:24px 0 8px;border-bottom:1px solid #EBDCC5;padding-bottom:4px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:6px 8px;border-bottom:1px solid #EBDCC5;text-align:left}th{color:#3E4E68}.big{font-size:26px;font-weight:700}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}.m{color:#3E4E68}</style></head><body>${out}</body></html>`;
}

/* ---------- ИИ (правила) ---------- */
function ruleFindings(deal, detail, now) {
  const f = [], td = today();
  detail.equipment.mismatches.forEach(m => f.push({ severity: "critical", title: "Серийный номер не совпадает с договором", server: m.server, gpu: m.gpu, detail: `По договору ${m.contract}, установлен ${m.actual}. Возможна подмена карты.` }));
  deal.servers.forEach(s => {
    if (deal.telemetry_mode === "agent" && !isOnline(s, now)) { const hrs = Math.round(silentSec(s, now) / 3600); f.push({ severity: hrs > 24 ? "critical" : "warning", title: "Нет связи с сервером", server: s.name, gpu: null, detail: `Последние данные ${hrs} ч назад. Карты оценены с поправкой 7 %.` }); }
    s.gpus.forEach(g => { if (g.temp != null && g.temp >= 85) f.push({ severity: "critical", title: "Критический перегрев", server: s.name, gpu: g.idx, detail: `${g.temp} °C — риск ускоренного износа.` }); else if (g.temp != null && g.temp >= 80) f.push({ severity: "warning", title: "Повышенная температура", server: s.name, gpu: g.idx, detail: `${g.temp} °C.` });
      if (g.hours && g.commissioned) { const age = Math.round((td - parse(g.commissioned)) / DAY) * 24; if (g.hours > age * 1.02 + 24) f.push({ severity: "critical", title: "Наработка больше возраста карты", server: s.name, gpu: g.idx, detail: `${Math.round(g.hours)} ч при возрасте ${age} ч — данные недостоверны или карту заменили.` }); } });
  });
  const cov = detail.coverage_now, cv = detail.forecast.covenant; if (cov != null && cov < cv) f.push({ severity: "critical", title: "Нарушение ковенанта покрытия", server: null, gpu: null, detail: `Покрытие ${c2(cov)} ниже ковенанта ${c2(cv)}.` }); else if (detail.status === "near") f.push({ severity: "warning", title: "Покрытие близко к порогу", server: null, gpu: null, detail: `Покрытие ${c2(cov)} при ковенанте ${c2(cv)}.` });
  if (detail.gap12) f.push({ severity: "warning", title: "Прогноз: залог может стать дешевле долга", server: null, gpu: null, detail: `В пессимистичном сценарии с ${dmy(detail.gap12.first_date)}, разрыв до ${m1(detail.gap12.max_gap)} млн ₽.` });
  return f;
}
function rulesReport(deal, detail, now) {
  const findings = ruleFindings(deal, detail, now), rank = { info: 0, warning: 1, critical: 2 }, top = Math.max(0, ...findings.map(x => rank[x.severity])), recs = [], t = fn => findings.some(f => fn(f.title.toLowerCase()));
  if (t(s => s.startsWith("серийный"))) recs.push("Назначить выездную проверку и приостановить выдачу траншей"); if (t(s => s.includes("ковенант"))) recs.push("Запросить дополнительное обеспечение или назначить переоценку"); if (t(s => s.includes("перегрев") || s.includes("температур"))) recs.push("Запросить у заёмщика отчёт об охлаждении и обслуживании"); if (t(s => s.includes("связи"))) recs.push("Связаться с ЦОДом и уточнить причину отсутствия телеметрии");
  return { risk: ["low", "medium", "high"][top], summary: findings.length ? `Найдено замечаний: ${findings.length}.` : "Аномалий не обнаружено, залог в норме.", findings, recommendations: recs, source: "rules", ts: now };
}

/* ---------- API ---------- */
const getDeal = (id, draft) => { const d = DB.deals[id]; if (!d || (d.status === "draft" && draft === false)) throw err("Сделка не найдена", 404); return d; };
const CALC_STEPS = ["Сверяем серийные номера с перечнем", "Обрабатываем данные {cards} карт", "Собираем цены дилеров и ставки аренды", "Считаем три метода оценки", "Строим прогноз и подбираем LTV"], STEP_S = 0.9;
function finalizeCalcs(now) {
  now = now || nowS();
  Object.values(DB.deals).forEach(d => { const c = d.calc; if (d.status === "calculating" && c && now - c.started >= STEP_S * CALC_STEPS.length) { d.status = "active"; d.assessments.push(snapshot(d, c.author_name, now)); ensureDocs(d, c.author_name); addNote(d, "ready", `Оценка готова: ${d.borrower}`, `Рыночная стоимость ${RUB(d.assessments[d.assessments.length - 1].market)}`, "low", now, "Открыть компанию", c.author); syncAlerts(d, now); } });
}
function dealPayload(deal) {
  const now = nowS(), detail = dealDetail(deal, now), models = {}; Object.keys(detail.valuation.per_model).forEach(k => models[k] = MODELS[k].scen); const asm = deal.assessments || [];
  return { id: deal.id, borrower: deal.borrower, inn: deal.inn, location: deal.location, contract: deal.contract, application: deal.application, contact: deal.contact, contact_email: deal.contact_email, status: deal.status, loan: deal.loan, telemetry_mode: deal.telemetry_mode, agent_token: deal.agent_token, agent_key: deal.agent_key, detail, servers: serversView(deal, now),
    alerts: DB.notifications.filter(n => n.deal_id === deal.id && OPEN.includes(n.status)).length, models, thresholds: TH, ai_report: DB.ai_reports[deal.id] || null, ai_ready: false, assessed_at: asm.length ? asm[asm.length - 1].ts : null, last_assessment: asm.length ? asm[asm.length - 1] : null, tranches_suspended: !!deal.tranches_suspended, market_updated: MARKET.updated };
}
const LIMITS = { amount: [1e6, 5e8, "Введите сумму от 1 до 500 млн ₽"], term: [6, 60, "Срок от 6 до 60 месяцев"], rate: [1, 40, "Ставка от 1 до 40 % годовых"], covenant: [1, 2, "Ковенант от 1,00 до 2,00"] };
function validateLoan(b, needDate, covDefault) {
  const f = {}, loan = {}; const num = (k, cast) => { const v = cast(String(b[k]).replace(/\s/g, "").replace(",", ".")); if (!Number.isFinite(v)) { f[k] = "Введите число"; return null; } const [lo, hi, msg] = LIMITS[k]; if (!(v >= lo && v <= hi)) { f[k] = msg; return null; } return v; };
  loan.amount = num("amount", parseFloat); loan.term = num("term", x => Math.trunc(parseFloat(x))); loan.rate = num("rate", parseFloat); loan.covenant = ("covenant" in b) ? num("covenant", parseFloat) : covDefault; loan.schedule = b.schedule || "annuity";
  if (needDate) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.issue_date || ""))) f.issue_date = "Укажите дату выдачи"; else if (b.issue_date < todayIso()) f.issue_date = "Дата не может быть раньше сегодняшней"; else loan.issue_date = b.issue_date; }
  if (Object.keys(f).length) throw err("Проверьте параметры кредита", 422, { fields: f }); return loan;
}
const needPerm = p => { if (!can(ME, p)) throw err("Нет доступа к этому действию", 403, { code: "forbidden" }); };
const routes = []; const R = (m, p, perm, fn) => routes.push([m, new RegExp("^" + p + "$"), perm, fn]);
const OPENS = []; /* уведомления «ready» */

R("POST", "/login", "pub", async b => {
  const email = String(b.email || "").trim().toLowerCase(); if (!/^[^@\s]+@bank\.ru$/.test(email)) throw err("Укажите рабочую почту на домене @bank.ru", 400, { field: "email" });
  const f = FAILS[email] || [0, 0]; if (f[1] > Date.now()) throw err("Вход временно закрыт на 15 минут. Попробуйте позже", 423);
  const u = DB.users.find(x => x.email === email);
  if (!u || b.password !== "Compute2026") { const n = f[1] ? 1 : f[0] + 1; if (n >= 3) { FAILS[email] = [0, Date.now() + 15 * 60000]; throw err("Вход временно закрыт на 15 минут из-за трёх неудачных попыток", 423); } FAILS[email] = [n, 0]; const left = 3 - n; throw err(`Неверная почта или пароль. Осталось ${left} ${left === 1 ? "попытка" : "попытки"}`, 401, { attempts_left: left }); }
  delete FAILS[email]; ME = u; return pub(u);
});
R("POST", "/logout", "pub", async () => { ME = null; return { ok: true }; });
R("GET", "/me", "pub", async () => { if (!ME) throw err("Не авторизован", 401, { code: "auth" }); return Object.assign(pub(ME), { pending: pending(ME) }); });
R("POST", "/password-reset", "pub", async () => ({ ok: true }));
R("POST", "/password-reset/confirm", "pub", async () => { throw err("В демо-версии смена пароля отключена", 400); });
R("GET", "/portfolio", "view", async () => {
  finalizeCalcs(); const now = nowS(), rows = Object.values(DB.deals).filter(d => d.status === "active").map(d => Object.assign(dealSummary(d, now), { servers: d.servers.length, borrower_inn: d.inn })), val = rows.reduce((a, r) => a + r.market, 0), debt = rows.reduce((a, r) => a + r.debt, 0), counts = { breach: 0, near: 0, ok: 0 }; rows.forEach(r => counts[r.status]++);
  return { rows, total_value: val, total_debt: debt, avg_coverage: debt ? val / debt : null, counts, attention: counts.breach + counts.near, pending: pending(ME), thresholds: TH, calculating: Object.values(DB.deals).filter(d => d.status === "calculating").map(d => ({ id: d.id, borrower: d.borrower })) };
});
R("GET", "/search", "view", async (b, m, o, q) => {
  const s = (q.get("q") || "").trim().toLowerCase(); if (s.length < 3) return { items: [] }; const items = [];
  Object.values(DB.deals).filter(d => d.status === "active").forEach(d => { if (d.borrower.toLowerCase().includes(s) || String(d.inn).includes(s) || String(d.contract).toLowerCase().includes(s)) items.push({ type: "company", title: d.borrower, sub: `Сделка ${d.contract}, ${d.location}`, deal_id: d.id }); d.servers.forEach(sv => sv.gpus.forEach(g => { if (g.serial.includes(s)) items.push({ type: "card", title: `Карта ${MODELS[sv.model].name}, s/n ${g.serial}`, sub: `${d.borrower}, сервер ${sv.name}`, deal_id: d.id, server: sv.name, serial: g.serial }); })); });
  return { items: items.slice(0, 8), total: items.length };
});
R("GET", "/check-inn", "create_assessment", async (b, m, o, q) => { const inn = (q.get("inn") || "").trim(); if (!innOk(inn)) return { valid: false, existing: null }; const ex = Object.values(DB.deals).find(d => d.inn === inn && ["active", "calculating"].includes(d.status)); const a = ex ? ex.assessments : []; return { valid: true, existing: ex ? { id: ex.id, borrower: ex.borrower, contract: ex.contract, assessed: a.length ? tsDate(a[a.length - 1].ts) : null } : null }; });
R("GET", "/deals/([\\w-]+)", "view", async (b, m) => { finalizeCalcs(); return dealPayload(getDeal(m[1])); });
R("POST", "/deals/([\\w-]+)/whatif", "view", async (b, m) => { const deal = getDeal(m[1]), loan = Object.assign({}, deal.loan, validateLoan(b, false, deal.loan.covenant)), val = valuation(deal), fc = forecast(deal, loan, val); return { forecast: fc, recommendation: recommend(fc, val.market, SCEN.includes(b.scenario) ? b.scenario : "pess", b.basis === "liquidation" ? "liquidation" : "market"), gap: pessGap(fc.points), half_year: halfYear(fc), market: val.market, liquidation: val.liquidation }; });
R("POST", "/deals/([\\w-]+)/terms", "edit_terms", async (b, m) => { const deal = getDeal(m[1], false); deal.loan = Object.assign({}, deal.loan, validateLoan(b, false, deal.loan.covenant)); syncAlerts(deal); return dealPayload(deal); });
function noteReassess(deal, user) {
  const prev = deal.assessments[deal.assessments.length - 1], now = nowS();
  if (prev) DB.documents[deal.id].push({ id: hex(10), name: `Заключение об оценке залога от ${tsDate(prev.ts)}`, type: "conclusion", date: tsDate(now), ts: now, author: prev.author || user.short, ext: "pdf", html: conclusionHtml(deal, dealDetail(deal, now), null, user.short, `Оценка от ${tsDate(prev.ts)}, рыночная стоимость ${RUB(prev.market)}`) });
  refreshPrices(); const snap = snapshot(deal, user.short, now); deal.assessments.push(snap); let change = null;
  if (prev) { const delta = snap.market / prev.market - 1; let reason = "существенных изменений нет"; if (Math.abs(snap.wear - prev.wear) > .002) reason = "изменились данные агента"; const mine = new Set(deal.servers.map(x => x.model)), used = Object.keys(snap.prices).filter(k => k in MARKET.last_change && mine.has(k)); if (used.length) { const top = used.sort((a, c) => Math.abs(MARKET.last_change[c]) - Math.abs(MARKET.last_change[a]))[0]; if (Math.abs(MARKET.last_change[top]) >= .002 && Math.abs(delta) >= .002) reason = `цены дилеров на ${top} ` + (MARKET.last_change[top] < 0 ? "снизились" : "выросли"); } change = { prev: prev.market, now: snap.market, pct: delta, reason, prev_date: tsDate(prev.ts) }; }
  syncAlerts(deal, now); addNote(deal, "ready", `Переоценка готова: ${deal.borrower}`, `Рыночная стоимость ${RUB(snap.market)}`, "low", now, "Открыть компанию", user.email); return change;
}
R("POST", "/deals/([\\w-]+)/reassess", "reassess", async (b, m) => { const deal = getDeal(m[1], false), change = noteReassess(deal, ME); return { change, deal: dealPayload(deal) }; });
R("GET", "/deals/([\\w-]+)/calc", "view", async (b, m) => { finalizeCalcs(); const d = getDeal(m[1]), c = d.calc; if (d.status === "active" || !c) return { done: d.status === "active", step: CALC_STEPS.length, steps: CALC_STEPS.map(x => x.replace("{cards}", 0)) }; const el = nowS() - c.started, cards = d.servers.reduce((a, s) => a + s.gpus.length, 0); return { done: false, step: Math.min(CALC_STEPS.length, Math.floor(el / STEP_S)), progress: Math.min(1, el / (STEP_S * CALC_STEPS.length)), steps: CALC_STEPS.map(x => x.replace("{cards}", cards)) }; });
R("POST", "/parse-equipment", "create_assessment", async (b, m, o) => parseEquipment(o.body, decodeURIComponent((o.headers || {})["X-Filename"] || "file.csv")));
R("POST", "/deals", "create_assessment", async b => {
  const f = {}, name = String(b.name || "").trim(), inn = String(b.inn || "").trim(); if (name.length < 2 || name.length > 200) f.name = "От 2 до 200 символов"; if (!innOk(inn)) f.inn = "10 или 12 цифр, проверьте контрольную сумму"; if (!/^(КД|KD)-\d{4}-\d{4}$/i.test(String(b.application || "").trim())) f.application = "Формат КД-ГГГГ-NNNN, например КД-2026-0418"; if (!String(b.location || "").trim()) f.location = "Укажите, где стоит оборудование"; if (!String(b.contact || "").trim()) f.contact = "Укажите контакт в ЦОД"; if (String(b.contact_email || "").trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.contact_email.trim())) f.contact_email = "Проверьте адрес почты";
  if (Object.keys(f).length) throw err("Проверьте данные заёмщика", 422, { fields: f }); if (!b.servers || !b.servers.length) throw err("Загрузите перечень оборудования", 422);
  const ex = Object.values(DB.deals).find(d => d.inn === inn && ["active", "calculating"].includes(d.status)); if (ex && !b.force) throw err("Компания с этим ИНН уже есть в портфеле", 409, { existing: { id: ex.id, borrower: ex.borrower, contract: ex.contract } });
  Object.keys(DB.deals).forEach(k => { if (DB.deals[k].status === "draft" && DB.deals[k].author === ME.email) delete DB.deals[k]; }); b.servers.forEach(s => s.last_seen = null);
  const id = "d" + hex(8), app = String(b.application).trim().toUpperCase().replace("KD", "КД");
  DB.deals[id] = { id, borrower: name, inn, location: String(b.location).trim(), contract: app, application: app, contact: String(b.contact).trim(), contact_email: String(b.contact_email || "").trim(), telemetry_mode: null, simulated: false, status: "draft", servers: b.servers, author: ME.email, agent_token: hex(24), agent_key: agentKey(), assessments: [], draft_step: 3, loan: { amount: 0, term: 36, rate: 18, schedule: "annuity", issue_date: todayIso(), covenant: TH.covenant } };
  return { id, agent_token: DB.deals[id].agent_token, agent_key: DB.deals[id].agent_key };
});
R("GET", "/draft", "create_assessment", async () => { const d = Object.values(DB.deals).find(x => x.status === "draft" && x.author === ME.email); if (!d) return { draft: null }; return { draft: { id: d.id, borrower: d.borrower, inn: d.inn, application: d.application, location: d.location, contact: d.contact, contact_email: d.contact_email, step: d.draft_step || 3, telemetry_mode: d.telemetry_mode, servers: d.servers.map(s => ({ name: s.name, model: s.model, gpus: s.gpus })), agent_key: d.agent_key, cards: d.servers.reduce((a, s) => a + s.gpus.length, 0) } }; });
R("POST", "/deals/([\\w-]+)/discard", "create_assessment", async (b, m) => { const d = getDeal(m[1]); if (d.status === "draft") delete DB.deals[m[1]]; return { ok: true }; });
R("POST", "/deals/([\\w-]+)/step", "create_assessment", async (b, m) => { const d = getDeal(m[1]); if (d.status === "draft") d.draft_step = +b.step || 3; return { ok: true }; });
R("POST", "/deals/([\\w-]+)/telemetry", "create_assessment", async (b, m) => { const d = getDeal(m[1]); if (!["agent", "file", "none"].includes(b.mode)) throw err("Неизвестный режим телеметрии", 400); d.telemetry_mode = b.mode; if (b.mode === "none") d.servers.forEach(s => s.gpus.forEach(g => { delete g.temp; delete g.util; delete g.hours; delete g.actual_serial; })); return { ok: true }; });
R("POST", "/deals/([\\w-]+)/telemetry-file", "create_assessment", async (b, m, o) => {
  const d = getDeal(m[1]), rows = await parseSmi(o.body, decodeURIComponent((o.headers || {})["X-Filename"] || "smi.csv")), bySerial = new Map(d.servers.flatMap(s => s.gpus.map(g => [g.serial, g]))), bySlot = new Map(d.servers.flatMap(s => s.gpus.map(g => [s.name + "|" + g.idx, g]))); let matched = 0; const extra = [];
  rows.forEach(r => { const hit = bySerial.get(r.serial), g = hit || (r.host && r.index != null ? bySlot.get(r.host + "|" + r.index) : null); if (!g) return extra.push(r.serial); g.actual_serial = r.serial; if (hit) matched++; Object.assign(g, { temp: r.temp, util: r.util, hours: g.commissioned ? Math.round((today() - parse(g.commissioned)) / DAY * 24 * .68) : 0 }); });
  d.telemetry_mode = "file"; const total = d.servers.reduce((a, s) => a + s.gpus.length, 0); return { total, matched, extra, missing: total - matched };
});
R("POST", "/deals/([\\w-]+)/demo-agent", "create_assessment", async (b, m) => { const d = getDeal(m[1]), rng = rngFor(d.id), now = nowS(), silent = +b.silent || 0; d.servers.forEach((s, i) => { const t0 = rng.int(60, 70), u0 = rng.int(82, 93), h0 = rng.int(5200, 7000); s.last_seen = i >= d.servers.length - silent ? null : now; if (s.last_seen) s.gpus.forEach(g => Object.assign(g, { actual_serial: g.serial, temp: t0 + rng.int(-2, 2), util: u0 + rng.int(-3, 3), hours: h0 - rng.int(0, 4) })); }); d.telemetry_mode = "agent"; d.simulated = true; return { ok: true }; });
R("POST", "/deals/([\\w-]+)/invite-cod", "create_assessment", async (b, m) => { const d = getDeal(m[1]); if (!d.contact_email) throw err("У контакта в ЦОД не указана почта (шаг «Заёмщик»)", 422); DB.outbox.push({ to: d.contact_email, subject: `Подключение агента: ${d.borrower}`, kind: "invite", ts: nowS() }); return { ok: true, to: d.contact_email }; });
R("POST", "/deals/([\\w-]+)/loan", "create_assessment", async (b, m) => { const d = getDeal(m[1]), loan = validateLoan(b, true, TH.covenant); if (!d.telemetry_mode) d.telemetry_mode = "none"; d.loan = loan; d.status = "calculating"; d.calc = { started: nowS(), author: ME.email, author_name: ME.short }; return { id: d.id }; });
R("POST", "/deals/([\\w-]+)/write-cod", "write_cod", async (b, m) => { const d = getDeal(m[1], false); if (!d.contact_email) throw err("У контакта в ЦОД не указана почта", 422); if (!String(b.subject || "").trim() || !String(b.message || "").trim()) throw err("Заполните тему и сообщение", 422); DB.outbox.push({ to: d.contact_email, subject: b.subject, body: b.message, kind: "cod", ts: nowS() }); return { ok: true, to: d.contact_email, contact: d.contact }; });
const TYPE_LABEL = { conclusion: "Заключение", contract: "Договор", data: "Данные", act: "Акт", other: "Другое" };
R("GET", "/deals/([\\w-]+)/documents", "view", async (b, m) => { const d = getDeal(m[1]); ensureDocs(d, ME.short); return DB.documents[d.id].slice().sort((a, c) => (c.ts || 0) - (a.ts || 0)).map(x => ({ id: x.id, name: x.name, type: x.type, type_label: TYPE_LABEL[x.type], date: x.date, author: x.author, ext: x.ext, comment: x.comment || "" })); });
R("POST", "/deals/([\\w-]+)/documents", "upload_docs", async (b, m, o) => {
  const d = getDeal(m[1]), h = o.headers || {}, type = h["X-Doc-Type"] || "contract"; if (!TYPE_LABEL[type]) throw err("Выберите тип документа", 422); const fname = decodeURIComponent(h["X-Filename"] || "document"), ext = fname.includes(".") ? fname.split(".").pop().toLowerCase() : "";
  if (!["pdf", "doc", "docx", "xls", "xlsx", "jpg", "jpeg", "png"].includes(ext)) throw err("Файл: PDF, Word, Excel, JPG или PNG", 422); if (o.body.size > 20 * 1024 * 1024) throw err("Файл больше 20 МБ", 413); if (!o.body.size) throw err("Файл пуст", 422);
  const id = hex(10); DB.blobs[id] = o.body; DB.documents[d.id].push({ id, name: fname.replace(/\.[^.]+$/, ""), type, date: tsDate(nowS()), ts: nowS(), author: ME.short, ext, comment: decodeURIComponent(h["X-Comment"] || ""), file: true }); return { ok: true };
});
R("POST", "/deals/([\\w-]+)/export", "export", async (b, m) => {
  const d = getDeal(m[1], false), fmt = b.format || "pdf"; if (!["pdf", "docx"].includes(fmt)) throw err("Формат: PDF или Word", 422); const secs = (b.sections || []).filter(s => ["valuation", "forecast", "equipment", "schedule"].includes(s)), name = `Заключение об оценке залога от ${tsDate(nowS())}`, id = hex(10);
  DB.documents[d.id].push({ id, name, type: "conclusion", date: tsDate(nowS()), ts: nowS(), author: ME.short, ext: fmt, html: conclusionHtml(d, dealDetail(d, nowS()), secs, ME.short), demoFmt: fmt }); return { doc_id: id, name, ext: fmt, url: `/api/deals/${d.id}/documents/${id}` };
});
R("GET", "/market", "view", async () => { if (MARKET.updated !== todayIso()) refreshPrices(); const stale = (today() - parse(MARKET.updated)) / DAY > 3; return { rows: Object.entries(MODELS).map(([key, mm]) => ({ key, model: key === "H100" ? "H100 SXM" : mm.full, median: mm.median, world: mm.world, rent: mm.rent, markup: mm.markup, dealers: mm.dealers, accuracy: mm.accuracy, low: mm.low, high: mm.high, low_data: mm.dealers < 3, spread: mm.dealers >= 3 ? Math.round((mm.high / mm.low - 1) * 100) : null, sources: { dealers: DEALERS[key].map(([c, p, dd], i) => ({ name: `Дилер ${i + 1}, ${c}`, price: Math.round(p * mm.median / BASE[key].median), price_date: iso(new Date(parse(MARKET.updated).getTime() - dd * DAY)) })), world: { usd: Math.round(mm.world / CBR), rub: mm.world, deals: WORLD_DEALS[key], rate: CBR, markup: mm.markup } } })), cbr_rate: CBR, updated: MARKET.updated, stale }; });
R("GET", "/notifications", "view", async () => { finalizeCalcs(); return visibleNotes(ME).sort((a, b) => b.ts - a.ts).map(n => noteView(n, ME)); });
R("GET", "/staff", "view", async () => staff().map(u => ({ email: u.email, name: u.short, role: ROLES[u.role] })));
const dateOk = (v, msg) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw err(msg, 422); if (v < todayIso()) throw err("Дата не может быть раньше сегодняшней", 422); return v; };
R("POST", "/notifications/(\\w+)/decide", "view", async (b, m) => {
  if (b.request_id && DB.requests[b.request_id]) return DB.requests[b.request_id]; const n = DB.notifications.find(x => x.id === m[1]); if (!n) throw err("Уведомление не найдено", 404);
  if (!can(ME, DECIDE_PERM[n.kind] || "view")) throw err("Нет прав на это решение", 403, { code: "forbidden" });
  if (!OPEN.includes(n.status)) throw err("Уведомление обновилось: решение уже принято", 409, { notification: noteView(n, ME) });
  const spec = (ACTIONS[n.kind] || []).find(a => a[0] === b.action); if (!spec) throw err("Действие недоступно", 422); const deal = DB.deals[n.deal_id] || {}, p = b.payload || {}; let text = "", toast = "";
  if (b.action === "request") { const amt = parseFloat(String(p.amount).replace(/\s/g, "").replace(",", ".")); if (!(amt > 0)) throw err("Введите сумму обеспечения", 422); const due = dateOk(p.due, "Укажите срок"); text = `Запрошено обеспечение ${fm(amt)} млн ₽ до ${dmy(due)}`; if (deal.contact_email) DB.outbox.push({ to: deal.contact_email, subject: "Запрос дополнительного обеспечения", body: p.message, kind: "borrower", ts: nowS() }); n.assignee = staffShort(p.responsible); toast = "Запрос отправлен заёмщику. Решение сохранено"; }
  else if (b.action === "inspect") { const due = dateOk(p.date, "Укажите дату проверки"); text = `Назначена выездная проверка на ${dmy(due)}` + (p.suspend ? "; выдача траншей приостановлена" : ""); n.assignee = staffShort(p.responsible); if (p.suspend) deal.tranches_suspended = true; toast = "Проверка назначена. Решение сохранено"; }
  else if (b.action === "watch") { const due = dateOk(p.date, "Укажите дату повторной проверки"); text = `Оставлено на наблюдении до ${dmy(due)}` + (String(p.comment || "").trim() ? ". " + p.comment : ""); n.status = "watching"; n.wake_at = parse(due).getTime() / 1000; toast = "Сохранено. В указанную дату уведомление вернётся в «Ждут решения»"; }
  else if (b.action === "reassess") { text = "Назначена переоценка"; toast = "Переоценка назначена. Решение сохранено"; } else if (b.action === "params") { text = "Условия кредита будут пересмотрены"; toast = "Решение сохранено"; } else if (b.action === "write_cod") { text = "Письмо в ЦОД отправлено"; toast = "Решение сохранено"; } else text = "Открыто";
  if (n.status !== "watching") n.status = n.kind === "ready" ? "closed" : "decided"; n.decision = { text, by: ME.short, ts: nowS(), action: b.action, payload: p }; n.unit = n.unit || ROLES[ME.role];
  const res = { notification: noteView(n, ME), toast, pending: pending(ME) }; if (b.request_id) DB.requests[b.request_id] = res; return res;
});
const settingsPayload = () => ({ thresholds: Object.assign({}, TH), can_edit_thresholds: can(ME, "edit_thresholds"), notify: NOTIFY_TYPES.map(([k, l, to]) => Object.assign({ kind: k, label: l, to }, notifyPref(ME, k))), ai: { enabled: DB.settings.ai.enabled, base_url: DB.settings.ai.base_url, model: DB.settings.ai.model, interval_min: DB.settings.ai.interval_min, has_key: !!DB.settings.ai.api_key, key_from_env: false, can_edit: can(ME, "ai_settings") }, simulate: DB.settings.simulate });
R("GET", "/settings", "view", async () => settingsPayload());
R("POST", "/settings/notify", "own_notify_settings", async b => { Object.entries(b.notify || {}).forEach(([k, v]) => { if (NOTIFY_TYPES.some(t => t[0] === k)) ME.notify[k] = { app: !!v.app, email: !!v.email }; }); return settingsPayload(); });
R("POST", "/settings/thresholds", "edit_thresholds", async b => { const cov = parseFloat(b.covenant), near = parseFloat(b.near), warn = parseFloat(b.offline_warn_h), nf2 = parseFloat(b.offline_notify_h); if (!(cov >= 1 && cov <= 2 && cov < near && near <= 3)) throw err("Ковенант от 1,00 до 2,00, а порог «близко» выше ковенанта", 422); if (!(warn > 0 && warn < nf2 && nf2 <= 720)) throw err("«Предупредить» должно быть раньше, чем «уведомить»", 422); Object.assign(TH, { covenant: cov, near, offline_warn_h: warn, offline_notify_h: nf2 }); return settingsPayload(); });
R("POST", "/settings/ai", "ai_settings", async b => { const a = DB.settings.ai; ["base_url", "model"].forEach(k => { if (typeof b[k] === "string" && b[k].trim()) a[k] = b[k].trim(); }); if ("enabled" in b) a.enabled = !!b.enabled; if (typeof b.api_key === "string" && b.api_key.trim()) a.api_key = b.api_key.trim(); if (b.clear_key) a.api_key = ""; if ("interval_min" in b) a.interval_min = Math.max(1, Math.min(1440, +b.interval_min || 30)); if ("simulate" in b) DB.settings.simulate = !!b.simulate; return settingsPayload(); });
const DEMO_NOTE = "В демо-версии внешние API отключены. Запустите приложение локально (python run.py) и подключите модель в настройках";
R("POST", "/ai/test", "ai_settings", async () => { throw err(DEMO_NOTE, 502); }); R("POST", "/ai/models", "ai_settings", async () => { throw err(DEMO_NOTE, 502); });
R("POST", "/deals/([\\w-]+)/ai-analyze", "view", async (b, m) => { const d = getDeal(m[1], false), now = nowS(), rep = rulesReport(d, dealDetail(d, now), now); DB.ai_reports[d.id] = rep; return rep; });
R("POST", "/deals/([\\w-]+)/ai-chat", "view", async (b, m) => { const d = getDeal(m[1], false), q = String(b.question || "").trim(); if (!q) throw err("Введите вопрос", 400); const now = nowS(), det = dealDetail(d, now), rep = rulesReport(d, det, now); return { answer: `Демо-режим: нейросеть не подключена, отвечаю по правилам мониторинга.\n\nПокрытие сейчас ${det.coverage_now == null ? "—" : c2(det.coverage_now)} при ковенанте ${c2(det.forecast.covenant)}. ${rep.summary}\n` + rep.findings.slice(0, 5).map(f => `• ${f.title}${f.server ? " (" + f.server + (f.gpu != null ? ", GPU " + f.gpu : "") + ")" : ""}: ${f.detail}`).join("\n") + (rep.recommendations.length ? "\n\nРекомендации:\n" + rep.recommendations.map(r => "• " + r).join("\n") : "") }; });
R("POST", "/deals/([\\w-]+)/incident", "reassess", async (b, m) => {
  const d = getDeal(m[1], false), srv = d.servers[d.servers.length - 1];
  if (b.type === "overheat") srv.gpus.slice(0, 3).forEach(g => { g.temp = 91; g.hot = true; }); else if (b.type === "swap") srv.gpus[srv.gpus.length - 1].actual_serial = "1654029999" + hex(3); else if (b.type === "offline") { srv.frozen = true; srv.last_seen = nowS() - 26 * 3600; }
  else if (b.type === "reset") d.servers.forEach(s => { delete s.frozen; s.last_seen = nowS(); s.gpus.forEach(g => { delete g.hot; if (g.actual_serial && g.actual_serial !== g.serial && g.serial !== "1654023118915") g.actual_serial = g.serial; if ((g.temp || 0) > 80) g.temp = 66; }); }); else throw err("Неизвестный тип инцидента", 400);
  syncAlerts(d); return { ok: true };
});

window.CC_DEMO = async function (path, opts) {
  opts = opts || {}; const method = opts.body !== undefined ? "POST" : "GET", [p, qs] = path.split("?"), q = new URLSearchParams(qs || ""); await new Promise(r => setTimeout(r, 15));
  for (const [m, rx, perm, fn] of routes) { const mt = rx.exec(p); if (m === method && mt) { if (perm !== "pub") { if (!ME) throw err("Требуется вход", 401, { code: "auth" }); if (perm && !can(ME, perm)) throw err("Нет доступа к этому действию", 403, { code: "forbidden" }); } const body = opts.body instanceof Blob ? {} : (opts.body || {}); return JSON.parse(JSON.stringify(await fn(body, mt, opts, q))); } }
  throw err("Не найдено", 404);
};
window.CC_DEMO_SAMPLES = { template: TEMPLATE, smi: servers => smiCsv(servers) };

/* ---------- файлы в песочнице не сохраняются: показываем содержимое в окне ---------- */
function showDoc(title, kind, content, note) {
  const m = document.createElement("div"); m.className = "modal-ov";
  m.innerHTML = `<div class="modal-box" style="width:min(900px,96vw);display:flex;flex-direction:column;max-height:88vh"><button class="modal-x" aria-label="Закрыть">×</button><h2>${esc(title)}</h2>${kind === "text" ? '<div class="row" style="margin:6px 0 12px"><button class="btn sm" id="cp">Копировать</button></div>' : '<div style="height:10px"></div>'}${kind === "html" ? '<iframe id="fr" style="border:1px solid var(--line);border-radius:12px;flex:1;min-height:60vh;background:#fff"></iframe>' : '<pre id="tx" style="margin:0;overflow:auto;flex:1;background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px;font-size:13px;white-space:pre-wrap"></pre>'}<p class="muted" style="font-size:13px;margin:12px 0 0">${esc(note || "В демо файл не сохраняется на диск: в обычной версии приложения это обычная загрузка.")}</p></div>`;
  document.body.appendChild(m); if (kind === "html") m.querySelector("#fr").srcdoc = content; else m.querySelector("#tx").textContent = content;
  const close = () => { document.removeEventListener("keydown", onk, true); m.remove(); }, onk = e => { if (e.key === "Escape") close(); }; document.addEventListener("keydown", onk, true);
  m.querySelector(".modal-x").onclick = close; m.addEventListener("mousedown", e => { if (e.target === m) close(); });
  const cp = m.querySelector("#cp"); if (cp) cp.onclick = () => { const t = m.querySelector("#tx"), ok = () => { cp.textContent = "Скопировано"; }; (navigator.clipboard ? navigator.clipboard.writeText(content).then(ok) : Promise.reject()).catch(() => { const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r); cp.textContent = "Выделено — Ctrl+C"; }); };
}
function openDocument(deal, doc) {
  if (doc.html) return showDoc(doc.name, "html", doc.html, doc.demoFmt === "docx" ? "В демо вместо Word-файла показан предпросмотр содержимого." : doc.ext === "pdf" ? "В демо вместо PDF показан предпросмотр содержимого; в обычной версии скачивается настоящий PDF." : undefined);
  if (doc.generated === "report") return showDoc(doc.name, "html", conclusionHtml(deal, dealDetail(deal, nowS()), null, doc.author), "В демо вместо PDF показан предпросмотр содержимого; в обычной версии скачивается настоящий PDF.");
  if (doc.generated === "equipment") return showDoc(doc.name + " (CSV)", "text", equipmentCsv(deal)); if (doc.generated === "telemetry") return showDoc(doc.name + " (CSV)", "text", telemetryCsv(deal));
  const blob = DB.blobs[doc.id]; if (blob && /^(txt|csv|json|md)$/.test(doc.ext)) blob.text().then(t => showDoc(doc.name, "text", t)); else showDoc(doc.name, "text", `Файл «${doc.name}.${doc.ext}» загружен в демо-сессию (${blob ? Math.round(blob.size / 1024) + " КБ" : ""}). Просмотр таких файлов в демо недоступен.`);
}
window.CC_DEMO_OPEN = r => { const m = /deals\/([\w-]+)\/documents\/(\w+)/.exec(r.url), d = DB.deals[m[1]], doc = DB.documents[m[1]].find(x => x.id === m[2]); openDocument(d, doc); };
document.addEventListener("click", e => {
  const a = e.target.closest('a[href^="/api/"]'); if (!a) return; e.preventDefault(); const h = a.getAttribute("href"); let mt;
  if (/^\/api\/template\.(csv|xlsx)$/.test(h)) return showDoc("Шаблон перечня оборудования (CSV)", "text", TEMPLATE, "В демо шаблон показан как CSV: скопируйте текст в файл .csv. В обычной версии скачивается Excel-шаблон.");
  if ((mt = /^\/api\/deals\/([\w-]+)\/documents\/(\w+)/.exec(h))) { const d = DB.deals[mt[1]], doc = DB.documents[mt[1]].find(x => x.id === mt[2]); if (doc) openDocument(d, doc); }
}, true);

init();
setInterval(() => { const now = nowS(); Object.values(DB.deals).forEach(deal => { if (deal.status !== "active") return; if (DB.settings.simulate && deal.simulated) deal.servers.forEach(s => { if (s.frozen) return; s.last_seen = now; s.gpus.forEach(g => { if (g.temp == null) return; if (g.hot) { g.temp = Math.min(95, g.temp + (Math.random() < .5 ? 1 : 0)); return; } g.temp = Math.max(55, Math.min(78, g.temp + [-1, 0, 0, 1][Math.floor(Math.random() * 4)])); g.util = Math.max(40, Math.min(99, g.util + [-2, -1, 0, 1, 2][Math.floor(Math.random() * 5)])); g.hours = (g.hours || 0) + 8 / 3600; }); }); syncAlerts(deal, now); }); finalizeCalcs(now); }, 8000);
})();

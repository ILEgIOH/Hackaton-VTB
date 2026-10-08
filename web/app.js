/* ComputeCollateral — интерфейс (vanilla JS, без сборки) */
"use strict";
const $app = document.getElementById("app");
let ME = null, BADGE = 0, POLL = null;

/* ---------- утилиты ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (v, d = 1) => v == null ? "—" : Number(v).toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d });
const mln = v => nf(v / 1e6, 1) + " млн ₽";
const cov = v => v == null ? "—" : nf(v, 2);
const int = v => v == null ? "—" : Math.round(v).toLocaleString("ru-RU");
const dmy = iso => iso ? iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(0, 4) : "—";
const ago = ts => { const d = new Date(ts * 1000); return d.toLocaleDateString("ru-RU") + ", " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); };
const STATUS = { ok: "Норма", near: "Близко к порогу", breach: "Нарушение" };
const sdot = (cls, text) => `<span class="s-${cls}"><i class="dot"></i>${esc(text)}</span>`;
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function toast(msg, bad) {
  const t = $("#toast"); t.textContent = msg; t.className = "show" + (bad ? " bad" : "");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = "", 3500);
}
async function api(path, opts = {}) {
  if (window.CC_DEMO) return window.CC_DEMO(path, opts); // автономная демо-версия: «сервер» работает в браузере
  const o = { method: opts.body !== undefined ? "POST" : "GET", headers: { ...(opts.headers || {}) }, credentials: "same-origin" };
  if (opts.body !== undefined) {
    if (opts.body instanceof Blob) o.body = opts.body;
    else { o.body = JSON.stringify(opts.body); o.headers["Content-Type"] = "application/json"; }
  }
  const r = await fetch("/api" + path, o);
  if (r.status === 401 && path !== "/login") { ME = null; location.hash = "#/login"; throw new Error("Требуется вход"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Ошибка " + r.status);
  return data;
}
const ICON = {
  chip: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 3v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5z"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>',
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  bell: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8M10 21a2 2 0 004 0"/></svg>',
  up: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>',
  down: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  eye: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>',
};

/* ---------- каркас ---------- */
function shell(active, inner) {
  const nav = [["portfolio", "Портфель залогов", "#/portfolio"], ["new", "Новая оценка", "#/new"], ["market", "Рыночные данные", "#/market"], ["notifications", "Уведомления", "#/notifications"]];
  return `<header class="top">
    <a class="logo" href="#/portfolio"><i>${ICON.chip}</i><span><b>Compute</b><span>Collateral</span></span></a>
    <nav class="nav">${nav.map(([k, t, h]) => `<a href="${h}" class="${active === k ? "on" : ""}">${t}${k === "notifications" && BADGE ? `<span class="badge">${BADGE}</span>` : ""}</a>`).join("")}</nav>
    <span class="sp"></span>
    <button class="icon-btn" data-act="search" title="Поиск по заёмщику">${ICON.search}</button>
    <a class="icon-btn" href="#/notifications" title="Уведомления">${ICON.bell}</a>
    <div class="user" data-act="usermenu" role="button" tabindex="0"><span class="avatar">${esc(ME.initials)}</span><span style="white-space:nowrap">${esc(ME.name)}<small>${esc(ME.role)}</small></span>
      <div class="menu" id="umenu" hidden><a href="#/settings">Настройки</a><button data-act="logout">Выйти</button></div></div>
  </header><main>${inner}</main>`;
}
function render(active, inner) { $app.innerHTML = shell(active, inner); }

/* ---------- роутер ---------- */
async function route() {
  clearInterval(POLL); POLL = null;
  const h = location.hash.replace(/^#\/?/, "") || "portfolio";
  const [page, a, b] = h.split("?")[0].split("/");
  if (!ME) { try { ME = await api("/me"); } catch { return viewLogin(); } }
  if (page === "login") { location.hash = "#/portfolio"; return; }
  refreshBadge();
  try {
    if (page === "portfolio") await viewPortfolio();
    else if (page === "new") await viewWizard();
    else if (page === "deal") await viewDeal(a, b || "overview");
    else if (page === "market") await viewMarket();
    else if (page === "notifications") await viewNotifications(new URLSearchParams(h.split("?")[1] || "").get("deal"));
    else if (page === "settings") await viewSettings();
    else location.hash = "#/portfolio";
  } catch (e) {
    if (e.message !== "Требуется вход") render("", `<div class="card loading">${esc(e.message)}</div>`);
  }
}
async function refreshBadge() {
  try { const p = await api("/portfolio"); BADGE = p.pending; const nb = $(".nav a:last-child"); if (nb) nb.innerHTML = "Уведомления" + (BADGE ? `<span class="badge">${BADGE}</span>` : ""); } catch { }
}
window.addEventListener("hashchange", route);
document.addEventListener("click", e => {
  const m = $("#umenu"); if (m && !e.target.closest(".user")) m.hidden = true;
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.dataset.act;
  if (act === "usermenu") { const m2 = $("#umenu"); m2.hidden = !m2.hidden; }
  else if (act === "logout") api("/logout", { body: {} }).then(() => { ME = null; location.hash = "#/login"; route(); });
  else if (act === "search") { if (location.hash.startsWith("#/portfolio") || location.hash === "") $("#q")?.focus(); else { location.hash = "#/portfolio"; setTimeout(() => $("#q")?.focus(), 200); } }
});

/* ---------- вход ---------- */
function viewLogin() {
  $app.innerHTML = `<div class="login"><div class="box"><div class="logo"><i>${ICON.chip}</i><span><b>Compute</b><span>Collateral</span></span></div>
  <form class="card" id="lf"><h1>Вход</h1>
    <label class="f">Рабочая почта</label><input class="inp" name="email" type="email" value="e.sokolova@bank.ru" autocomplete="username" required>
    <label class="f" style="margin-top:22px">Пароль</label><div class="pw"><input class="inp" name="password" type="password" autocomplete="current-password" ${window.CC_DEMO ? 'value="Compute2026"' : ""} required><button type="button" id="eye" title="Показать пароль">${ICON.eye}</button></div>
    <div style="text-align:right;margin:14px 0 26px"><a href="#" id="forgot">Забыли пароль?</a></div>
    <button class="btn primary" style="width:100%;justify-content:center;height:58px;font-size:18px">Войти</button><div class="err" id="le"></div>
    <p class="muted" style="font-size:13px;margin:22px 0 0">Демо-доступ: e.sokolova@bank.ru / Compute2026</p></form></div></div>`;
  const f = $("#lf");
  $("#eye").onclick = () => { const i = f.password; i.type = i.type === "password" ? "text" : "password"; };
  $("#forgot").onclick = e => { e.preventDefault(); toast("Для сброса пароля обратитесь в службу безопасности банка"); };
  f.onsubmit = async e => {
    e.preventDefault();
    try { ME = await api("/login", { body: { email: f.email.value, password: f.password.value } }); location.hash = "#/portfolio"; route(); }
    catch (er) { $("#le").textContent = er.message; }
  };
}

/* ---------- портфель ---------- */
async function viewPortfolio() {
  const p = await api("/portfolio"); BADGE = p.pending;
  let tab = "all", q = "";
  const body = () => {
    const rows = p.rows.filter(r => (tab === "all" || r.status === tab) && r.borrower.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => (a.coverage ?? 99) - (b.coverage ?? 99));
    return rows.length ? rows.map(r => `<tr class="click" data-id="${r.id}">
      <td><div class="name">${esc(r.borrower)}</div><div class="sm">${esc(r.title)}</div></td>
      <td class="r num">${mln(r.market)}</td><td class="r num">${mln(r.debt)}</td>
      <td class="num" style="white-space:nowrap"><b>${cov(r.coverage)}</b><span class="bar ${r.status}"><i style="width:${Math.min(100, (r.coverage || 0) / 2.5 * 100)}%"></i></span></td>
      <td class="r num ${r.coverage12 != null && r.coverage12 < 1 ? "red" : ""}">${cov(r.coverage12)}</td>
      <td>${sdot(r.equipment_code === "ok" ? "ok" : r.equipment_code === "swap" ? "swap" : r.equipment_code, r.equipment)}</td>
      <td>${sdot(r.status, STATUS[r.status])}</td></tr>`).join("") : `<tr><td colspan="7" class="muted" style="text-align:center;padding:50px">Ничего не найдено</td></tr>`;
  };
  const att = p.counts.breach + p.counts.near;
  render("portfolio", `<div class="head"><h1>Портфель залогов</h1><a class="btn primary" href="#/new">${ICON.plus} Новая оценка</a></div>
  <section class="hero"><div><div class="l">Стоимость залогов</div><div class="v num">${mln(p.total_value)}</div><div class="s">рыночная, на сегодня</div></div>
  <div><div class="l">Остаток долга</div><div class="v num">${mln(p.total_debt)}</div><div class="s">по ${p.rows.length} ${plural(p.rows.length, "сделке", "сделкам", "сделкам")}</div></div>
  <div><div class="l">Среднее покрытие</div><div class="v num">${cov(p.avg_coverage)}</div><div class="s">ковенант не ниже 1,25</div></div>
  <div><div class="l">Требуют внимания</div><div class="v amber">${att} ${plural(att, "сделка", "сделки", "сделок")}</div><div class="s">${p.counts.breach} ${plural(p.counts.breach, "нарушение", "нарушения", "нарушений")}, ${p.counts.near} близко к порогу</div></div></section>
  <div class="row-between"><div class="tabs plain" id="tabs" style="margin:0">${[["all", "Все", p.rows.length], ["breach", "Нарушение", p.counts.breach], ["near", "Близко к порогу", p.counts.near], ["ok", "Норма", p.counts.ok]].map(([k, t, n]) => `<button class="tab ${k === "all" ? "on" : ""}" data-t="${k}">${t}<small>${n}</small></button>`).join("")}</div>
  <label class="search">${ICON.search}<input id="q" placeholder="Поиск по заёмщику"></label></div>
  <div class="card tblwrap"><table class="tbl"><thead><tr><th>Заёмщик</th><th class="r">Стоимость залога</th><th class="r">Остаток долга</th><th>Покрытие ↑</th><th class="r">Покрытие через 12 мес.</th><th>Оборудование</th><th>Статус</th></tr></thead><tbody id="tb">${body()}</tbody></table></div>`);
  const redraw = () => { $("#tb").innerHTML = body(); };
  $("#tabs").onclick = e => { const b = e.target.closest("[data-t]"); if (!b) return; tab = b.dataset.t; $$("#tabs .tab").forEach(x => x.classList.toggle("on", x === b)); redraw(); };
  $("#q").oninput = e => { q = e.target.value; redraw(); };
  $("#tb").onclick = e => { const tr = e.target.closest("tr[data-id]"); if (tr) location.hash = "#/deal/" + tr.dataset.id; };
}

/* ---------- новая оценка ---------- */
let WIZ = null;
const freshWiz = () => ({ step: 1, borrower: "", location: "", file: null, parsed: null, deal: null, mode: "agent", smi: null, tele: null, loan: { amount: 60000000, term: 36, rate: 18, schedule: "annuity", issue_date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), covenant: 1.25 } });
async function viewWizard() { if (!WIZ || WIZ.done) WIZ = freshWiz(); wizRender(); }
function wizSteps() {
  const names = ["Оборудование", "Телеметрия", "Параметры кредита"];
  return `<div class="steps">${names.map((n, i) => `${i ? '<span class="ln"></span>' : ""}<div class="step ${WIZ.step === i + 1 ? "on" : WIZ.step > i + 1 ? "done" : ""}"><span class="c">${WIZ.step > i + 1 ? ICON.check : i + 1}</span>${n}</div>`).join("")}</div>`;
}
function wizRender() {
  const w = WIZ;
  const head = `<h1>Новая оценка</h1><div class="sub" style="font-size:19px">${esc(w.borrower) || "Новая сделка"}</div>${wizSteps()}`;
  if (w.step === 1) return wizStep1(head);
  if (w.step === 2) return wizStep2(head);
  return wizStep3(head);
}
function wizStep1(head) {
  const w = WIZ, p = w.parsed;
  const tbl = p ? (() => { const rows = p.servers.flatMap(s => s.gpus.map(g => ({ s: s.name, m: s.model, g }))); return `<div class="card tblwrap"><table class="tbl"><thead><tr><th>Сервер</th><th>Модель</th><th>Серийный номер</th><th>Дата ввода</th></tr></thead><tbody>${rows.slice(0, 8).map(r => `<tr><td><b>${esc(r.s)}</b></td><td>${esc(r.m)}</td><td class="num">${esc(r.g.serial)}</td><td class="num">${dmy(r.g.commissioned)}</td></tr>`).join("")}</tbody></table>${rows.length > 8 ? `<div class="muted" style="padding:6px 24px 20px">Ещё ${rows.length - 8} ${plural(rows.length - 8, "строка", "строки", "строк")}</div>` : ""}</div>`; })() : "";
  render("new", `${head}
  <div class="grid2" style="margin-bottom:26px"><div><label class="f">Заёмщик</label><input class="inp" id="wb" value="${esc(w.borrower)}" placeholder="ООО «Название»"></div>
  <div><label class="f">Где стоит оборудование</label><input class="inp" id="wl" value="${esc(w.location)}" placeholder="ЦОД, город"></div></div>
  ${p ? `<div class="card filecard"><div class="ftype">XLSX</div><div style="flex:1"><div style="font-size:21px;font-weight:600">${esc(w.file)}</div><div class="muted">${p.errors.length ? "" : "Загружен сейчас, "}<a href="#" id="repl">заменить</a></div></div>
  <div class="${p.errors.length ? "red" : "s-ok"}"><i class="dot" style="background:currentColor"></i>${p.cards} карт, ${p.count_servers} ${plural(p.count_servers, "сервер", "сервера", "серверов")}, ${p.errors.length ? "ошибок: " + p.errors.length : "ошибок нет"}</div></div>
  ${p.errors.length ? `<div class="info bad"><b>Исправьте файл и загрузите заново</b><br>${p.errors.slice(0, 6).map(esc).join("<br>")}${p.errors.length > 6 ? `<br>…и ещё ${p.errors.length - 6}` : ""}</div>` : ""}${tbl}
  <div class="foot"><span></span><button class="btn primary" id="next" ${p.errors.length || !p.cards ? "disabled" : ""}>Далее</button></div>`
      : `<div class="drop" id="drop"><div class="ic">${ICON.up}</div><h2>Загрузите список оборудования</h2><p class="muted" style="font-size:18px;margin:0 0 28px">Файл Excel или CSV от заёмщика, можно перетащить сюда</p>
  <button class="btn primary" id="pick" style="padding:18px 40px;font-size:18px">Загрузить файл</button><p class="muted" style="margin-top:28px">Нет файла у заёмщика? <a href="/api/template.csv">Скачать шаблон</a></p>${window.CC_DEMO ? '<p><button class="btn" id="sample">Загрузить пример файла</button></p>' : ""}</div>`}
  <input type="file" id="fi" accept=".xlsx,.xlsm,.csv" hidden>`);
  const keep = () => { w.borrower = $("#wb").value; w.location = $("#wl").value; };
  const send = async f => {
    keep();
    try { w.parsed = await api("/parse-equipment", { body: f, headers: { "X-Filename": f.name } }); w.file = f.name; wizRender(); }
    catch (e) { toast(e.message, true); }
  };
  $("#wb").oninput = keep; $("#wl").oninput = keep;
  $("#fi").onchange = e => e.target.files[0] && send(e.target.files[0]);
  $("#pick") && ($("#pick").onclick = () => $("#fi").click());
  $("#sample") && ($("#sample").onclick = () => send(new File([CC_DEMO_SAMPLES.template], "equipment_example.csv")));
  $("#repl") && ($("#repl").onclick = e => { e.preventDefault(); $("#fi").click(); });
  const d = $("#drop");
  if (d) { d.ondragover = e => { e.preventDefault(); d.classList.add("over"); }; d.ondragleave = () => d.classList.remove("over"); d.ondrop = e => { e.preventDefault(); d.classList.remove("over"); e.dataTransfer.files[0] && send(e.dataTransfer.files[0]); }; }
  $("#next") && ($("#next").onclick = async () => {
    keep(); if (!w.borrower.trim()) { toast("Укажите заёмщика", true); $("#wb").focus(); return; }
    try {
      if (w.deal) { /* уже создан черновик — переиспользуем */ } else w.deal = await api("/deals", { body: { borrower: w.borrower, location: w.location, servers: w.parsed.servers } });
      w.step = 2; wizRender();
    } catch (e) { toast(e.message, true); }
  });
}
function wizStep2(head) {
  const w = WIZ;
  const opts = [["agent", "Агент на серверах", "Данные идут постоянно. После выдачи кредита банк видит, если оборудование заменили или отключили"], ["file", "Файл nvidia-smi", "Разовый снимок состояния карт. Наблюдать за залогом после выдачи нельзя"], ["none", "Без телеметрии", "Оценка с понижающей поправкой до 7 %, состояние карт неизвестно"]];
  render("new", `${head}<div class="opts">${opts.map(([k, t, d]) => `<div class="opt ${w.mode === k ? "on" : ""}" data-m="${k}"><span class="rd"></span><div><b>${t}</b><span>${d}</span></div></div>`).join("")}</div><div id="tp"></div>
  <div class="foot"><button class="btn" id="back">Назад</button><button class="btn primary" id="next">Далее</button></div><input type="file" id="fi" accept=".csv,.xlsx" hidden>`);
  $$(".opt").forEach(o => o.onclick = () => { w.mode = o.dataset.m; w.smi = null; wizStep2(head); });
  $("#back").onclick = () => { w.step = 1; wizRender(); };
  $("#next").onclick = async () => {
    try {
      if (w.mode === "agent" && !(w.tele && w.tele.agent)) { toast("Подключите агент или выберите другой вариант", true); return; }
      if (w.mode === "file" && !w.smi) { toast("Загрузите файл nvidia-smi", true); return; }
      if (w.mode === "none") await api(`/deals/${w.deal.id}/telemetry`, { body: { mode: "none" } });
      w.step = 3; wizRender();
    } catch (e) { toast(e.message, true); }
  };
  const tp = $("#tp"), id = w.deal.id;
  const table = d => { const rows = d.servers.flatMap(s => s.gpus.filter(g => g.temp != null).map(g => ({ s: s.name, g }))); return rows.length ? `<div class="card tblwrap"><table class="tbl"><thead><tr><th>Сервер</th><th>Карта</th><th>Серийный номер</th><th class="r">Температура</th><th class="r">Загрузка</th><th class="r">Наработка</th></tr></thead><tbody>${rows.slice(0, 5).map(r => `<tr><td><b>${esc(r.s)}</b></td><td>GPU ${r.g.idx}</td><td class="num">${esc(r.g.actual || r.g.serial)}</td><td class="r num">${r.g.temp} °C</td><td class="r num">${int(r.g.util)} %</td><td class="r num">${int(r.g.hours)} ч</td></tr>`).join("")}</tbody></table>${rows.length > 5 ? `<div class="muted" style="padding:6px 24px 20px">Ещё ${rows.length - 5} ${plural(rows.length - 5, "карта", "карты", "карт")}</div>` : ""}</div>` : ""; };
  const agentInfo = async () => {
    const d = await api("/deals/" + id); const online = d.servers.filter(s => s.online).length, seen = d.servers.flatMap(s => s.gpus).filter(g => g.actual).length, tot = d.servers.reduce((a, s) => a + s.cards, 0);
    w.tele = { agent: online > 0 };
    const match = d.servers.flatMap(s => s.gpus).filter(g => g.match).length;
    tp.innerHTML = online ? `<div class="info"><b><i class="dot"></i>Агент подключён: ${online} из ${d.servers.length} серверов на связи</b><br>Данные получены по ${seen} картам, серийные номера совпадают с перечнем у ${match} из ${tot}</div>${table(d)}`
      : `<div class="info warn"><b>Ожидаем подключения агента</b><br>На каждом сервере запустите: <code>python agent/agent.py --server http://${esc(location.host)} --token ${esc(d.agent_token)} --name &lt;имя сервера из перечня&gt;</code><br><span style="font-size:14px">Страница обновляется автоматически. Для демонстрации можно подключить имитацию агентов.</span></div><button class="btn" id="demo">Подключить демо-агентов (симуляция)</button>`;
    $("#demo") && ($("#demo").onclick = async () => { await api(`/deals/${id}/demo-agent`, { body: {} }); agentInfo(); });
  };
  if (w.mode === "agent") { agentInfo(); POLL = setInterval(() => { if (!$("#demo") && w.tele?.agent) return; agentInfo(); }, 4000); }
  else if (w.mode === "file") {
    const show = r => { tp.innerHTML = `<div class="info ${r.missing ? "warn" : ""}"><b>Снимок загружен: ${r.matched} из ${r.total} карт найдены по серийным номерам</b>${r.missing ? `<br>Не найдено в файле: ${r.missing}` : ""}${r.extra.length ? `<br>Лишние номера: ${r.extra.slice(0, 5).map(esc).join(", ")}${r.extra.length > 5 ? "…" : ""}` : ""}</div><button class="btn" id="pk">Заменить файл</button>`; $("#pk").onclick = () => $("#fi").click(); };
    tp.innerHTML = `<div class="info"><b>Загрузите вывод nvidia-smi</b><br>Команда: <code>nvidia-smi --query-gpu=index,serial,name,temperature.gpu,utilization.gpu --format=csv &gt; smi.csv</code></div><button class="btn primary" id="pk">Выбрать файл</button>`;
    $("#pk").onclick = () => $("#fi").click();
    if (w.smi) show(w.smi);
    const upl = async f => { try { w.smi = await api(`/deals/${id}/telemetry-file`, { body: f, headers: { "X-Filename": f.name } }); show(w.smi); } catch (er) { toast(er.message, true); } };
    $("#fi").onchange = e => e.target.files[0] && upl(e.target.files[0]);
    if (window.CC_DEMO) { const b = document.createElement("button"); b.className = "btn"; b.style.marginLeft = "12px"; b.textContent = "Загрузить пример снимка"; b.onclick = () => upl(new File([CC_DEMO_SAMPLES.smi()], "smi_example.csv")); $("#pk").after(b); }
  } else tp.innerHTML = `<div class="info warn"><b>Состояние карт неизвестно</b><br>К рыночной стоимости применяется поправка 7 %, наблюдать за залогом после выдачи кредита будет нельзя.</div>`;
}
function wizStep3(head) {
  const w = WIZ, l = w.loan;
  render("new", `${head}<div class="card" style="padding:44px 50px"><div class="grid3">
   <div><label class="f">Сумма кредита, ₽</label><input class="inp" id="la" type="number" min="100000" step="100000" value="${l.amount}"></div>
   <div><label class="f">Срок, месяцев</label><input class="inp" id="lt" type="number" min="1" max="120" value="${l.term}"></div>
   <div><label class="f">Ставка, % годовых</label><input class="inp" id="lr" type="number" min="0" max="60" step="0.1" value="${l.rate}"></div>
   <div><label class="f">График погашения</label><select class="inp" id="ls"><option value="annuity" ${l.schedule === "annuity" ? "selected" : ""}>Аннуитетный</option><option value="differentiated" ${l.schedule === "differentiated" ? "selected" : ""}>Дифференцированный</option></select></div>
   <div><label class="f">Дата выдачи</label><input class="inp" id="ld" type="date" value="${l.issue_date}"></div>
   <div><label class="f">Ковенант покрытия</label><input class="inp" id="lc" type="number" min="1" max="5" step="0.05" value="${l.covenant}"></div></div></div>
  <div class="summary"><div><div class="l">Оборудование</div><div class="v">${w.parsed.cards} × ${esc(w.parsed.servers[0].model)}</div></div><div><div class="l">Где стоит</div><div class="v">${esc(w.location) || "—"}</div></div>
  <div><div class="l">Телеметрия</div><div class="v">${{ agent: "Агент на серверах", file: "Файл nvidia-smi", none: "Без телеметрии" }[w.mode]}</div></div><div><div class="l">Серийные номера</div><div class="v">${w.mode === "none" ? "не проверяются" : "сверяются с перечнем"}</div></div></div>
  <div class="foot"><button class="btn" id="back">Назад</button><button class="btn primary" id="go">Рассчитать оценку</button></div>`);
  $("#back").onclick = () => { w.step = 2; wizRender(); };
  $("#go").onclick = async () => {
    Object.assign(l, { amount: +$("#la").value, term: +$("#lt").value, rate: +$("#lr").value, schedule: $("#ls").value, issue_date: $("#ld").value, covenant: +$("#lc").value });
    try { await api(`/deals/${w.deal.id}/loan`, { body: l }); const id = w.deal.id; w.done = true; location.hash = "#/deal/" + id; } catch (e) { toast(e.message, true); }
  };
}

/* ---------- сделка ---------- */
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
function dealHead(D, tab) {
  const st = D.detail.status;
  return `<div class="crumbs"><a href="#/portfolio">Портфель залогов</a> / ${esc(D.borrower)}</div>
  <div class="head"><div><div class="dealhead"><h1>${esc(D.borrower)}</h1>${sdot(st, STATUS[st])}</div>
  <div class="sub">Сделка ${esc(D.contract)}, ${D.detail.valuation.cards} × ${Object.keys(D.detail.valuation.per_model).join(" + ")} в ${esc(D.location)}</div></div>
  <div class="row"><button class="btn" id="reass">Переоценить</button><a class="btn primary" href="/api/deals/${D.id}/report.html" download>${ICON.down} Выгрузить заключение</a></div></div>
  <div class="tabs">${[["overview", "Обзор"], ["equipment", "Оборудование"], ["documents", "Документы"], ["ai", "ИИ-мониторинг"]].map(([k, t]) => `<button class="tab ${tab === k ? "on" : ""}" data-tab="${k}">${t}</button>`).join("")}
  <button class="end" id="dalerts">${ICON.bell} Уведомления ${D.alerts ? `<span class="badge">${D.alerts}</span>` : ""}</button></div>`;
}
async function viewDeal(id, tab) {
  const D = await api("/deals/" + id);
  const bind = () => {
    $$("[data-tab]").forEach(b => b.onclick = () => location.hash = `#/deal/${id}/${b.dataset.tab}`);
    $("#dalerts").onclick = () => location.hash = "#/notifications?deal=" + id;
    $("#reass").onclick = async () => { try { await api(`/deals/${id}/reassess`, { body: {} }); toast("Оценка пересчитана по текущим данным"); route(); } catch (e) { toast(e.message, true); } };
  };
  if (tab === "equipment") { render("portfolio", dealHead(D, tab) + equipmentTab(D)); bind(); $$("[data-tg]").forEach(r => r.onclick = () => { const x = $("#g" + r.dataset.tg); x.hidden = !x.hidden; }); }
  else if (tab === "documents") { render("portfolio", dealHead(D, tab) + `<div id="docs"></div>`); bind(); docsTab(id); }
  else if (tab === "ai") { render("portfolio", dealHead(D, tab) + `<div id="aitab"></div>`); bind(); aiTab(D); }
  else { render("portfolio", dealHead(D, tab) + `<div id="ov"></div>`); bind(); overviewTab(D); }
}
function overviewTab(D) {
  const V = D.detail.valuation, loan = D.loan, eq = D.detail.equipment;
  let st = { amount: loan.amount, term: loan.term, rate: loan.rate, scen: "pess", liquid: false, wi: D.detail }, t = null;
  const main = Object.keys(V.per_model)[0], sc = D.models[main] || {};
  const strip = eq.mismatches.length ? `<i class="dot breach"></i><span style="color:#ff8a93">Подмена оборудования: ${eq.mismatches.length} ${plural(eq.mismatches.length, "карта", "карты", "карт")} не совпада${eq.mismatches.length === 1 ? "ет" : "ют"} с договором залога</span>`
    : D.telemetry_mode === "none" ? `<i class="dot near"></i>Телеметрия не подключена — применена поправка 7 %, состояние карт неизвестно`
      : `<i class="dot"></i>Оборудование на месте: ${D.servers.filter(s => s.online !== false).length} из ${D.servers.length} серверов на связи, ${eq.matched} из ${eq.total} серийных номеров совпадают с договором залога`;
  const dealers = { H100: 9, H200: 2, A100: 11, L40S: 7 }[main] || 9, pc = V.per_model[main];
  $("#ov").innerHTML = `
  <section class="hero three"><div><div class="l">Рыночная стоимость</div><div class="v num">${mln(V.market)}</div><div class="s">≈ ${nf(V.per_card / 1e6, 2)} млн ₽ за карту с долей серверной платформы</div></div>
   <div class="liq"><div class="l">Ликвидационная стоимость</div><div class="v num">${mln(V.liquidation)}</div><div class="s">При срочной продаже за 4–6 месяцев, дисконт ${Math.round(V.liquidation_discount * 100)} %</div></div>
   <div><div class="l">Рекомендуемый LTV</div><div class="v teal num" id="h-ltv"></div><div class="s" id="h-req"></div><div class="s alert" id="h-ex" style="margin-top:6px"></div></div>
   <div class="strip">${strip}</div></section>
  <div class="card chartpanel"><div><div class="row-between" style="margin:0"><h2>Стоимость залога и остаток долга</h2><div class="seg" id="lq"><button class="on" data-l="0">Рыночная</button><button data-l="1">Ликвидационная</button></div></div>
   <div class="legend"><span><i style="border-color:#9fc9d4"></i>Оптимистичный</span><span><i style="border-color:#4C9DB0"></i>Базовый</span><span><i style="border-color:#7b8799;border-top-style:dashed"></i>Пессимистичный</span><span><i style="border-color:#051F45"></i>Остаток долга</span><span><i class="hatch"></i>Залог не покрывает долг</span></div>
   <div class="chartbox" id="cb"><div class="tip"></div><div id="cs"></div></div><div id="banner"></div></div>
   <div><h2 style="font-size:19px;margin-bottom:26px">Параметры кредита</h2>
    <div class="sl"><div class="t">Сумма<b id="v-a"></b></div><input type="range" id="r-a" min="5000000" max="${Math.max(2 * loan.amount, 60e6)}" step="500000" value="${loan.amount}"></div>
    <div class="sl"><div class="t">Срок<b id="v-t"></b></div><input type="range" id="r-t" min="6" max="60" step="1" value="${loan.term}"></div>
    <div class="sl"><div class="t">Ставка<b id="v-r"></b></div><input type="range" id="r-r" min="5" max="30" step="0.5" value="${loan.rate}"></div>
    <div class="muted" style="margin:6px 0 10px;font-size:14px">Сценарий для расчёта LTV</div><div class="seg" id="sc"><button data-s="opt">Оптим.</button><button data-s="base">Базовый</button><button class="on" data-s="pess">Пессим.</button></div>
    <p class="muted" style="font-size:14px;margin-top:28px;border-top:1px solid var(--line);padding-top:22px">В пессимистичном сценарии ${esc(main)} дешевеет на ${Math.round((sc.pess1 || 0) * 100)} % в год${sc.newgen_drop ? ` и ещё на ${Math.round(sc.newgen_drop * 100)} % после выхода нового поколения чипов` : ""}.</p></div></div>
  <div class="two"><div class="card"><h2 style="margin-bottom:6px">Из чего сложилась оценка</h2>
   ${[["Затратный", 30, V.cost, `Цена новых карт у ${dealers} дилеров минус износ`], ["Сравнительный", 40, V.comparative, "Сделки вторичного рынка за 90 дней"], ["Доходный", 30, V.income, "Доход от аренды за 3 года службы"]].map(([n, w, v, d]) => `<div class="mrow"><div class="t"><span>${n} <small>вес ${w} %</small></span><b class="num">${mln(v)}</b></div><div class="bg"><i style="width:${v / Math.max(V.cost, V.comparative, V.income) * 100}%"></i></div><div class="d">${d}</div></div>`).join("")}
   <div style="border-top:1px solid var(--line);margin-top:24px;padding-top:12px"><div class="kv"><span>Среднее с учётом весов</span><span class="num">${mln(V.weighted)}</span></div><div class="kv"><span>Поправка за износ</span><span class="num">−${nf(V.wear * 100, 1)} %</span></div><div class="kv total"><span>Рыночная стоимость</span><span class="num">${mln(V.market)}</span></div></div>
   ${V.low_data.length ? `<div class="info warn" style="margin:18px 0 0;padding:14px 18px;font-size:14px">Мало рыночных данных по ${V.low_data.join(", ")}: оценка по мировым ценам, точность ±15 %</div>` : ""}</div>
   <div class="card"><h2 style="margin-bottom:6px">Покрытие по полугодиям</h2><div class="tblwrap" style="padding:0"><table class="tbl"><thead><tr><th>Дата</th><th class="r">Остаток долга</th><th class="r">Базовый</th><th class="r">Пессим.</th></tr></thead><tbody id="hy"></tbody></table></div></div></div>`;
  const covCls = v => v == null ? "" : v < 1 ? "red" : v < 1.25 ? "amber" : "";
  const draw = () => {
    const wi = st.wi, fc = wi.forecast;
    $("#cs").innerHTML = chartSvg(fc, st.liquid, st.scen === "pess" ? sc.newgen_month : null); bindChart($("#cb"), fc, st.liquid);
    const g = wi.gap, rec = wi.recommendation;
    $("#banner").innerHTML = g ? `<div class="banner"><b><i class="dot breach"></i>В пессимистичном сценарии залог станет дешевле долга ${dmy(g.first_date)}</b>Через ${g.first_month} ${plural(g.first_month, "месяц", "месяца", "месяцев")}. Разрыв продлится ${g.months} ${plural(g.months, "месяц", "месяца", "месяцев")}, максимум ${nf(g.max_gap / 1e6, 1)} млн ₽</div>`
      : `<div class="banner ok"><b>В пессимистичном сценарии залог покрывает долг весь срок кредита</b></div>`;
    $("#h-ltv").textContent = nf(rec.ltv * 100, 1) + " %";
    $("#h-req").textContent = `Запрошено ${nf(rec.requested_ltv * 100, 1)} %, это ${nf(st.amount / 1e6, 1)} млн ₽`;
    $("#h-ex").innerHTML = rec.exceeds ? `<i class="dot breach"></i>Выше рекомендации. Максимум ${nf(rec.max_loan / 1e6, 1)} млн ₽` : `<span style="color:#8fd0df"><i class="dot"></i>В рамках рекомендации</span>`;
    $("#hy").innerHTML = wi.half_year.map(r => `<tr><td class="num">${dmy(r.date)}</td><td class="r num">${mln(r.debt)}</td><td class="r num ${covCls(r.base)}">${r.paid ? '<span class="muted">погашен</span>' : cov(r.base)}</td><td class="r num ${covCls(r.pess)}">${r.paid ? '<span class="muted">погашен</span>' : cov(r.pess)}</td></tr>`).join("");
    $("#v-a").textContent = mln(st.amount); $("#v-t").textContent = st.term + " мес."; $("#v-r").textContent = nf(st.rate, 1) + " %";
  };
  const recalc = () => { clearTimeout(t); t = setTimeout(async () => { try { st.wi = await api(`/deals/${D.id}/whatif`, { body: { amount: st.amount, term: st.term, rate: st.rate, scenario: st.scen } }); draw(); } catch (e) { toast(e.message, true); } }, 120); };
  [["r-a", "amount"], ["r-t", "term"], ["r-r", "rate"]].forEach(([i, k]) => $("#" + i).oninput = e => { st[k] = +e.target.value; $("#v-a").textContent = mln(st.amount); $("#v-t").textContent = st.term + " мес."; $("#v-r").textContent = nf(st.rate, 1) + " %"; recalc(); });
  $("#sc").onclick = e => { const b = e.target.closest("[data-s]"); if (!b) return; st.scen = b.dataset.s; $$("#sc button").forEach(x => x.classList.toggle("on", x === b)); recalc(); };
  $("#lq").onclick = e => { const b = e.target.closest("[data-l]"); if (!b) return; st.liquid = b.dataset.l === "1"; $$("#lq button").forEach(x => x.classList.toggle("on", x === b)); draw(); };
  draw();
}
function equipmentTab(D) {
  const V = D.detail.valuation, S = D.servers;
  const avgH = S.filter(s => s.hours != null);
  const link = s => D.telemetry_mode === "agent" ? (s.online ? sdot("ok", "На связи") : sdot("offline", "Нет связи")) : D.telemetry_mode === "file" ? '<span class="muted">Снимок</span>' : '<span class="muted">—</span>';
  const bar = (v, max, cls = "") => v == null ? "—" : `<span class="bar ${cls}" style="margin:0 12px 0 0"><i style="width:${Math.min(100, v / max * 100)}%"></i></span>`;
  return `<div class="stats"><div><div class="l">Серверов</div><div class="v">${S.length}</div></div><div><div class="l">Карт ${Object.keys(V.per_model).join(", ")}</div><div class="v">${V.cards}</div></div>
  <div><div class="l">Средняя наработка</div><div class="v num">${avgH.length ? int(avgH.reduce((a, s) => a + s.hours, 0) / avgH.length) + " ч" : "—"}</div></div><div><div class="l">Поправка за износ</div><div class="v num">−${nf(V.wear * 100, 1)} %</div></div></div>
  <div class="card tblwrap"><table class="tbl"><thead><tr><th>Сервер</th><th>Серийные номера</th><th class="r">Наработка</th><th>Загрузка</th><th>Температура</th><th class="r">Поправка</th><th>Связь</th></tr></thead><tbody>
  ${S.map((s, i) => { const bad = s.seen && s.matched < s.cards; return `<tr class="click" data-tg="${i}"><td><div class="name">${esc(s.name)}</div><div class="sm">${s.cards} × ${esc(s.model)}</div></td>
   <td>${s.seen ? `<span class="${bad ? "s-swap" : "s-ok"}"><i class="dot"></i>${s.matched} из ${s.cards} совпадают</span>` : '<span class="muted">не проверялись</span>'}</td>
   <td class="r num">${s.hours != null ? int(s.hours) + " ч" : "—"}</td><td class="num">${bar(s.util, 100)}${s.util != null ? s.util + " %" : "—"}</td><td class="num">${bar(s.temp, 100, s.temp >= 80 ? "breach" : "")}${s.temp != null ? s.temp + " °C" : "—"}</td>
   <td class="r num">${s.wear != null ? "−" + nf(s.wear * 100, 1) + " %" : "—"}</td><td>${link(s)}</td></tr>
   <tr id="g${i}" ${i ? "hidden" : ""}><td colspan="7" style="padding:0"><div class="gpus">${s.gpus.map(g => `<div class="gpu ${g.match === false ? "bad" : ""} ${g.temp >= 80 ? "hot" : ""}"><b>GPU ${g.idx}</b>${g.temp != null ? `<small>${g.temp} °C · ${int(g.util)} %</small>` : ""}<small class="num">…${esc(String(g.actual || g.serial).slice(-5))}</small>${g.match === false ? '<small class="red">не совпадает</small>' : ""}</div>`).join("")}</div></td></tr>`; }).join("")}</tbody></table></div>`;
}
async function docsTab(id) {
  const docs = await api(`/deals/${id}/documents`); let f = "all";
  const tabs = [["all", "Все"], ["conclusion", "Заключения"], ["contract", "Договоры"], ["data", "Данные"], ["act", "Акты"]];
  const draw = () => {
    const list = docs.filter(d => f === "all" || d.type === f);
    $("#docs").innerHTML = `<div class="row-between"><div class="tabs plain" style="margin:0" id="dt">${tabs.map(([k, t]) => `<button class="tab ${f === k ? "on" : ""}" data-f="${k}">${t}<small>${k === "all" ? docs.length : docs.filter(d => d.type === k).length}</small></button>`).join("")}</div><button class="btn" id="up">${ICON.up.replace('width="44" height="44"', 'width="18" height="18"')} Загрузить документ</button></div>
    <div class="card tblwrap"><table class="tbl"><thead><tr><th>Документ</th><th>Тип</th><th>Дата</th><th>Добавил</th><th></th></tr></thead><tbody>${list.map(d => `<tr><td><div class="row"><span class="ftype ${d.ext === "pdf" || d.ext === "html" ? "pdf" : ""}" style="width:56px;height:56px;font-size:13px">${esc((d.ext || "file").toUpperCase())}</span><b style="font-size:17px;font-weight:600">${esc(d.name)}</b></div></td><td>${esc(d.type_label)}</td><td class="num">${esc(d.date)}</td><td>${esc(d.author)}</td><td class="r"><a href="/api/deals/${id}/documents/${d.id}" download>Скачать</a></td></tr>`).join("") || '<tr><td colspan="5" class="muted" style="text-align:center;padding:40px">Документов нет</td></tr>'}</tbody></table></div>`;
    $("#dt").onclick = e => { const b = e.target.closest("[data-f]"); if (b) { f = b.dataset.f; draw(); } };
    $("#up").onclick = () => {
      const m = document.createElement("div"); m.className = "modal"; m.innerHTML = `<div class="card"><h2 style="margin-bottom:20px">Загрузить документ</h2><label class="f">Тип</label><select class="inp" id="mt"><option value="contract">Договор</option><option value="act">Акт</option><option value="data">Данные</option><option value="conclusion">Заключение</option></select><label class="f" style="margin-top:16px">Файл</label><input class="inp" type="file" id="mf" style="padding-top:13px"><div class="foot" style="margin-top:24px"><button class="btn" id="mc">Отмена</button><button class="btn primary" id="ms">Загрузить</button></div></div>`;
      document.body.appendChild(m); $("#mc", m).onclick = () => m.remove();
      $("#ms", m).onclick = async () => { const file = $("#mf", m).files[0]; if (!file) return toast("Выберите файл", true); try { await api(`/deals/${id}/documents`, { body: file, headers: { "X-Filename": encodeURIComponent(file.name), "X-Doc-Type": $("#mt", m).value } }); m.remove(); toast("Документ загружен"); docsTab(id); } catch (e) { toast(e.message, true); } };
    };
  };
  draw();
}
function aiTab(D) {
  const el = $("#aitab"), id = D.id, RISK = { low: "Низкий риск", medium: "Средний риск", high: "Высокий риск" };
  const draw = r => {
    el.innerHTML = `<div class="two"><div class="card"><div class="row-between"><h2>Анализ ИИ-наблюдателя</h2><button class="btn primary sm" id="run">Запустить анализ</button></div>
      ${r ? `<div class="row" style="margin-bottom:12px"><span class="pill ${r.risk}">${RISK[r.risk]}</span><span class="muted" style="font-size:14px">${r.source === "ai" ? "модель " + esc(r.model) : "правила (ИИ не подключён)"} · ${ago(r.ts)}</span></div><p style="margin:0 0 14px;font-size:17px">${esc(r.summary)}</p>
      ${r.ai_error ? `<div class="info warn" style="padding:12px 16px;font-size:14px">ИИ недоступен: ${esc(r.ai_error)}. Показаны результаты правил.</div>` : ""}
      ${r.findings.map(f => `<div class="find"><span class="sv ${f.severity}"></span><div><b>${esc(f.title)}${f.server ? ` — ${esc(f.server)}${f.gpu != null ? ", GPU " + f.gpu : ""}` : ""}</b><span>${esc(f.detail || "")}</span></div></div>`).join("") || '<p class="muted">Замечаний нет.</p>'}
      ${r.recommendations?.length ? `<h2 style="font-size:17px;margin:20px 0 6px">Рекомендации</h2><ul style="margin:0;padding-left:20px">${r.recommendations.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}` : `<p class="muted">Анализ ещё не запускался.</p>`}
      ${D.ai_ready ? "" : `<div class="info warn" style="margin:20px 0 0;padding:14px 18px;font-size:14px">Подключите ИИ-модель в <a href="#/settings">настройках</a> — она будет разбирать телеметрию вместе с правилами.</div>`}</div>
     <div class="card" style="padding:34px"><h2>Спросить ИИ о сделке</h2><div class="chat"><div class="msgs" id="msgs"><div class="msg a">Задайте вопрос по залогу: например, «какие серверы вызывают опасения?» или «что будет с покрытием через год?»</div></div>
      <div class="row"><input class="inp" id="qq" placeholder="Ваш вопрос" style="flex:1"><button class="btn primary" id="ask">Спросить</button></div></div>
      <h2 style="font-size:17px;margin:34px 0 8px">Демонстрация инцидентов</h2><p class="muted" style="font-size:14px;margin:0 0 12px">Имитирует событие на серверах заёмщика — мониторинг создаст уведомление, ИИ проанализирует ситуацию.</p>
      <div class="row">${[["overheat", "Перегрев"], ["swap", "Подмена карты"], ["offline", "Обрыв связи"], ["reset", "Сбросить"]].map(([k, t]) => `<button class="btn sm" data-inc="${k}">${t}</button>`).join("")}</div></div></div>`;
    $("#run").onclick = async e => { e.target.disabled = true; e.target.textContent = "Анализируем…"; try { draw(await api(`/deals/${id}/ai-analyze`, { body: {} })); } catch (er) { toast(er.message, true); e.target.disabled = false; } };
    const msgs = $("#msgs"), say = (c, t) => { const d = document.createElement("div"); d.className = "msg " + c; d.textContent = t; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; };
    const ask = async () => { const q = $("#qq").value.trim(); if (!q) return; $("#qq").value = ""; say("u", q); const w = say("a", "…"); try { w.textContent = (await api(`/deals/${id}/ai-chat`, { body: { question: q } })).answer; } catch (e) { w.textContent = e.message; } };
    $("#ask").onclick = ask; $("#qq").onkeydown = e => e.key === "Enter" && ask();
    $$("[data-inc]").forEach(b => b.onclick = async () => { try { await api(`/deals/${id}/incident`, { body: { type: b.dataset.inc } }); toast("Готово — смотрите «Уведомления» и запустите анализ"); } catch (e) { toast(e.message, true); } });
  };
  draw(D.ai_report);
}

/* ---------- рыночные данные ---------- */
async function viewMarket() {
  const M = await api("/market"), MAX = 4e6, pc = v => v / MAX * 100;
  render("market", `<h1>Рыночные данные</h1><div class="sub" style="font-size:18px;margin-bottom:34px">Цена одной карты с долей серверной платформы. Курс ЦБ ${nf(M.cbr_rate, 2)} ₽ за доллар, обновлено ${dmy(M.updated)}</div>
  <div class="card mk"><div class="row-between"><h2>Цены российских дилеров, млн ₽</h2><div class="lg"><span><i style="width:30px;height:10px;border-radius:9px;background:#bddbe3"></i>Разброс</span><span><i style="width:14px;height:14px;border-radius:50%;background:var(--teal)"></i>Медиана</span><span><i style="width:10px;height:10px;border:2px solid var(--navy);transform:rotate(45deg)"></i>Мировая цена</span></div></div>
  ${M.rows.map(r => `<div class="mkrow"><div><div class="nm">${esc(r.model)}</div>${r.low_data ? '<div class="warnl"><i class="dot near"></i>Мало данных</div>' : ""}</div>
   <div class="rng"><div class="ax"></div><span class="lb" style="left:${pc(r.low)}%">${nf(r.low / 1e6, 2)}</span><span class="lb" style="left:${pc(r.high)}%">${nf(r.high / 1e6, 2)}</span><div class="sp ${r.low_data ? "dash" : ""}" style="left:${pc(r.low)}%;width:${pc(r.high) - pc(r.low)}%"></div><div class="md" style="left:${pc(r.median)}%"></div><div class="wd" style="left:${pc(r.world)}%"></div></div>
   <div class="muted">${r.low_data ? `Только ${r.dealers} ${plural(r.dealers, "дилер", "дилера", "дилеров")}. Оценка по мировым ценам, точность ±${Math.round(r.accuracy * 100)} %` : `Разница ${r.spread} % между ${r.dealers} дилерами`}</div></div>`).join("")}</div>
  <div class="card tblwrap"><table class="tbl"><thead><tr><th>Модель</th><th class="r">Медиана дилеров</th><th class="r">Мировая цена</th><th class="r">Аренда за час</th><th class="r">Наценка импорта</th><th class="r">Дилеров</th><th class="r">Точность</th></tr></thead><tbody>
  ${M.rows.map(r => `<tr><td><b style="font-size:18px">${esc(r.model)}</b></td><td class="r num">${int(r.median)} ₽</td><td class="r num">${int(r.world)} ₽</td><td class="r num">${int(r.rent)} ₽</td><td class="r num">${Math.round(r.markup * 100)} %</td><td class="r num">${r.dealers}</td><td class="r num ${r.low_data ? "amber" : ""}">±${Math.round(r.accuracy * 100)} %</td></tr>`).join("")}</tbody></table></div>`);
}

/* ---------- уведомления ---------- */
async function viewNotifications(dealFilter) {
  let list = await api("/notifications"); if (dealFilter) list = list.filter(n => n.deal_id === dealFilter);
  const open = n => n.status === "new" || n.status === "in_work";
  const group = { swap: "swap", covenant: "cov", threshold: "cov", forecast: "forecast", link: "link", hardware: "hw" }, GL = { swap: "Подмена", cov: "Ковенанты", forecast: "Прогноз", link: "Связь", hw: "Оборудование" };
  const kinds = [...new Set(list.map(n => group[n.kind]))]; let f = "all";
  const SC2 = { high: "breach", medium: "near", low: "offline" }, ST = { new: "новое", in_work: "в работе", decided: "решение принято", closed: "закрыто" };
  const draw = () => {
    const vis = list.filter(n => f === "all" || (f === "wait" ? open(n) : group[n.kind] === f));
    const waiting = list.filter(open).length;
    $("#nl").innerHTML = vis.map(n => `<div class="item ${n.status === "closed" ? "dim" : ""}"><div><div class="kind"><span class="s-${SC2[n.severity]}"><i class="dot"></i>${esc(n.label)}</span><a class="b" href="#/deal/${n.deal_id}" style="text-decoration:none">${esc(n.borrower)}</a><span class="t num">${ago(n.ts)}</span></div>
      <h3>${esc(n.title)}</h3><div style="font-size:17px">${esc(n.text)}</div><div class="muted" style="margin-top:14px;font-size:14px">${esc(n.owner)}, ${ST[n.status]}</div></div>
      <div>${n.status === "decided" ? `<div class="decided"><b>Решение принято</b><br>${esc(n.decision || "")}</div>` : open(n) && n.actions.length ? `${n.recommendation ? `<div style="margin-bottom:14px"><b>Рекомендация.</b> <span class="muted">${esc(n.recommendation)}</span></div>` : ""}<div class="acts">${n.actions.map(a => `<button class="btn ${a.primary ? "primary" : ""}" data-n="${n.id}" data-a="${a.id}">${esc(a.label)}</button>`).join("")}</div>` : ""}</div></div>`).join("") || '<div class="muted" style="padding:60px;text-align:center">Уведомлений нет</div>';
    $$("[data-n]").forEach(b => b.onclick = async () => { try { await api(`/notifications/${b.dataset.n}/action`, { body: { action: b.dataset.a } }); toast("Решение записано"); viewNotifications(dealFilter); } catch (e) { toast(e.message, true); } });
    $$("#nt .tab").forEach(t => t.classList.toggle("on", t.dataset.f === f));
    $("#sub").textContent = waiting ? `${waiting} ждут решения` : "Все решения приняты";
  };
  render("notifications", `<div class="head"><div><h1>Уведомления</h1><div class="sub" id="sub" style="font-size:18px"></div>${dealFilter ? `<p><a href="#/notifications">Показать по всем сделкам</a></p>` : ""}</div><a class="btn" href="#/settings">Настроить</a></div>
  <div class="tabs" id="nt"><button class="tab on" data-f="all">Все<small>${list.length}</small></button><button class="tab" data-f="wait">Ждут решения<small>${list.filter(open).length}</small></button>${kinds.map(k => `<button class="tab" data-f="${k}">${GL[k]}<small>${list.filter(n => group[n.kind] === k).length}</small></button>`).join("")}</div>
  <div class="card nlist" id="nl"></div>`);
  $("#nt").onclick = e => { const b = e.target.closest("[data-f]"); if (b) { f = b.dataset.f; draw(); } };
  draw(); BADGE = list.filter(open).length;
}

/* ---------- настройки ---------- */
async function viewSettings() {
  const S = await api("/settings"), a = S.ai;
  render("", `<h1 style="margin-bottom:30px">Настройки</h1><div class="two"><div class="card"><h2 style="margin-bottom:6px">ИИ-наблюдатель</h2><p class="muted" style="margin-top:0">Подключается к любому API, совместимому с OpenAI (OpenAI, OpenRouter, Groq, Together, локальные Ollama / vLLM / LM Studio).</p>
   <label class="tog" style="margin:22px 0"><input type="checkbox" id="ae" ${a.enabled ? "checked" : ""}> Включить ИИ-анализ телеметрии</label>
   <label class="f">Адрес API (base URL)</label><input class="inp" id="au" value="${esc(a.base_url)}"><label class="f" style="margin-top:18px">Модель</label><input class="inp" id="am" value="${esc(a.model)}">
   <label class="f" style="margin-top:18px">API-ключ ${a.has_key ? '<span class="s-ok">· сохранён</span>' : ""}</label><input class="inp" id="ak" type="password" placeholder="${a.has_key ? "оставьте пустым, чтобы не менять" : "sk-…"}" autocomplete="off">
   <label class="f" style="margin-top:18px">Периодичность анализа, мин</label><input class="inp" id="ai" type="number" min="1" value="${a.interval_min}">
   <div class="row" style="margin-top:26px"><button class="btn primary" id="sv">Сохранить</button><button class="btn" id="ts">Проверить подключение</button>${a.has_key ? '<button class="btn" id="ck">Удалить ключ</button>' : ""}</div><div id="tr" style="margin-top:14px"></div></div>
   <div class="card" style="padding:34px"><h2 style="margin-bottom:6px">Мониторинг</h2><p class="muted" style="margin-top:0">Агенты на серверах заёмщика отправляют телеметрию на <code>POST /api/agent/ingest</code>. Для демонстрации включена симуляция агентов — телеметрия демо-сделок меняется в реальном времени.</p>
   <label class="tog" style="margin-top:22px"><input type="checkbox" id="sim" ${S.simulate ? "checked" : ""}> Симулировать агентов в демо-сделках</label>
   <p class="muted" style="font-size:14px;margin-top:30px">Ключ API хранится локально в <code>data/db.json</code> и никогда не отправляется в интерфейс. Также можно задать переменные <code>CC_AI_API_KEY</code>, <code>CC_AI_BASE_URL</code>, <code>CC_AI_MODEL</code>.</p></div></div>`);
  const save = async extra => { await api("/settings", { body: { ai: { enabled: $("#ae").checked, base_url: $("#au").value, model: $("#am").value, api_key: $("#ak").value, interval_min: +$("#ai").value, ...extra }, simulate: $("#sim").checked } }); };
  $("#sv").onclick = async () => { try { await save(); toast("Настройки сохранены"); viewSettings(); } catch (e) { toast(e.message, true); } };
  $("#sim").onchange = () => save().catch(e => toast(e.message, true));
  $("#ck") && ($("#ck").onclick = async () => { await save({ clear_key: true, api_key: "" }); toast("Ключ удалён"); viewSettings(); });
  $("#ts").onclick = async e => { e.target.disabled = true; $("#tr").innerHTML = '<span class="muted">Проверяем…</span>'; try { await save(); const r = await api("/ai/test", { body: {} }); $("#tr").innerHTML = `<div class="info" style="margin:0"><b>Подключение работает</b> · ${esc(r.model)}<br>Ответ: ${esc(r.reply)}</div>`; } catch (er) { $("#tr").innerHTML = `<div class="info bad" style="margin:0">${esc(er.message)}</div>`; } e.target.disabled = false; };
}

route();

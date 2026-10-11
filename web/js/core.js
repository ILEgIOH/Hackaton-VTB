/* ComputeCollateral — ядро интерфейса: утилиты, API, окна, шапка, маршрутизация, ошибки X01–X05 */
"use strict";
const $app = document.getElementById("app");
let ME = null, BADGE = 0, POLL = null, RETURN_TO = null, EXPIRED_SHOWN = false, LAST_ACT = Date.now();

/* ---------- утилиты ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (v, d = 1) => v == null ? "—" : Number(v).toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d });
/* суммы от 1 млн — «94,0 млн ₽»; меньше — «2 650 000 ₽» (ТЗ, форматы) */
const mln = v => v == null ? "—" : Math.abs(v) >= 1e6 ? nf(v / 1e6, 1) + " млн ₽" : Math.round(v).toLocaleString("ru-RU") + " ₽";
const rub = v => v == null ? "—" : Math.round(v).toLocaleString("ru-RU") + " ₽";
const cov = v => v == null ? "—" : nf(v, 2);
const pct = (v, d = 1) => nf(v * 100, d) + " %";
const int = v => v == null ? "—" : Math.round(v).toLocaleString("ru-RU");
const dmy = iso => iso ? iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(0, 4) : "—";
const MSK = { timeZone: "Europe/Moscow" };
const fd = ts => new Date(ts * 1000).toLocaleDateString("ru-RU", { ...MSK, day: "2-digit", month: "2-digit", year: "numeric" });
const ft = ts => new Date(ts * 1000).toLocaleTimeString("ru-RU", { ...MSK, hour: "2-digit", minute: "2-digit" });
const fdt = ts => fd(ts) + ", " + ft(ts);
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { } };
const rid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const STATUS = { ok: "Норма", near: "Близко к порогу", breach: "Нарушение" };
const sdot = (cls, text) => `<span class="s-${cls}"><i class="dot"></i>${esc(text)}</span>`;
const can = p => !!(ME && ME.can && ME.can[p]);

function toast(msg, bad) {
  const t = $("#toast"); t.textContent = msg; t.className = "show" + (bad ? " bad" : "");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = "", 4000);   // подтверждения исчезают через 4 секунды
}

/* ---------- API ---------- */
class ApiErr extends Error { constructor(m, status, data) { super(m); this.status = status; this.data = data || {}; this.code = (data || {}).code; } }
async function api(path, opts = {}) {
  if (window.CC_DEMO) return window.CC_DEMO(path, opts);
  const o = { method: opts.body !== undefined ? "POST" : "GET", headers: { ...(opts.headers || {}) }, credentials: "same-origin" };
  if (opts.body !== undefined) {
    if (opts.body instanceof Blob) o.body = opts.body;
    else { o.body = JSON.stringify(opts.body); o.headers["Content-Type"] = "application/json"; }
  }
  let r;
  try { r = await fetch("/api" + path, o); } catch { throw new ApiErr("Нет связи с сервером", 0, { code: "network" }); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && path !== "/login") {
      if (data.code === "session_expired") { sessionExpired(); } else if (ME) { ME = null; }
    }
    throw new ApiErr(data.error || "Ошибка " + r.status, r.status, data);
  }
  return data;
}

/* ---------- окна поверх страницы ---------- */
function modal({ title, sub, body, narrow, actions = [], onClose, dismissable = true }) {
  const ov = document.createElement("div"); ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal-box ${narrow ? "narrow" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">${dismissable ? '<button class="modal-x" aria-label="Закрыть">×</button>' : ""}
    <h2>${esc(title)}</h2>${sub ? `<p class="sub muted">${esc(sub)}</p>` : ""}<div class="mbody">${body || ""}</div><div class="merr"></div>
    ${actions.length ? `<div class="modal-foot">${actions.map(a => `<button class="btn ${a.primary ? "primary" : ""} ${a.cls || ""}" data-a="${a.id}">${esc(a.label)}</button>`).join("")}</div>` : ""}</div>`;
  document.body.appendChild(ov);
  const ctl = {
    el: ov, $: s => $(s, ov), $$: s => $$(s, ov),
    close() { document.removeEventListener("keydown", onKey, true); ov.remove(); onClose && onClose(); },
    error(title2, text, retry) { $(".merr", ov).innerHTML = `<div class="err-box"><b>${esc(title2)}</b>${esc(text || "")}</div>`; if (retry) { const b = $(`[data-a="${retry}"]`, ov); if (b) { b.textContent = "Повторить"; b.disabled = false; } } },
    clearError() { $(".merr", ov).innerHTML = ""; },
    btn(id) { return $(`[data-a="${id}"]`, ov); },
  };
  const onKey = e => { if (e.key === "Escape" && dismissable && ov === [...document.querySelectorAll(".modal-ov")].pop()) ctl.close(); };
  document.addEventListener("keydown", onKey, true);
  if (dismissable) { $(".modal-x", ov).onclick = ctl.close; ov.addEventListener("mousedown", e => { if (e.target === ov) ctl.close(); }); }
  actions.forEach(a => { ctl.btn(a.id).onclick = () => a.onClick && a.onClick(ctl); });
  const first = $("input,select,textarea", ov); if (first) first.focus();
  return ctl;
}
/* отправка из окна: сбой сети не закрывает окно, данные остаются, «Повторить» шлёт тот же запрос (X05) */
async function submitModal(ctl, btnId, fn) {
  const b = ctl.btn(btnId); b.disabled = true; ctl.clearError();
  try { await fn(); }
  catch (e) {
    b.disabled = false;
    if (e.status === 0) ctl.error("Не удалось отправить", "Нет связи с сервером. Данные в форме сохранены.", btnId);
    else if (e.status === 409) throw e;
    else { ctl.error("Не удалось отправить", e.message); if (e.data && e.data.fields) fieldErrors(ctl.el, e.data.fields); }
  }
}
function fieldErrors(root, fields) {
  $$(".fld", root).forEach(f => { f.classList.remove("bad"); const m = $(".msg", f); m && m.remove(); });
  Object.entries(fields || {}).forEach(([k, msg]) => {
    const inp = $(`[name="${k}"]`, root); if (!inp) return;
    const f = inp.closest(".fld"); if (!f) return; f.classList.add("bad"); f.insertAdjacentHTML("beforeend", `<div class="msg">${esc(msg)}</div>`);
  });
}

/* ---------- иконки ---------- */
const ICON = {
  chip: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 3v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5z"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  bell: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8M10 21a2 2 0 004 0"/></svg>',
  up: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>',
  down: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  eye: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>',
  cal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
};

/* ---------- каркас, шапка, поиск ---------- */
function shell(active, inner) {
  const nav = [["portfolio", "Портфель залогов", "#/portfolio"], ...(can("create_assessment") ? [["new", "Новая оценка", "#/new"]] : []), ["market", "Рыночные данные", "#/market"], ["notifications", "Уведомления", "#/notifications"]];
  return `<header class="top">
    <a class="logo" href="#/portfolio"><i>${ICON.chip}</i><span><b>Compute</b><span>Collateral</span></span></a>
    <nav class="nav">${nav.map(([k, t, h]) => `<a href="${h}" class="${active === k ? "on" : ""}" data-nav="${k}">${t}${k === "notifications" && BADGE ? `<span class="badge">${BADGE}</span>` : ""}</a>`).join("")}</nav>
    <span class="sp"></span>
    <div class="search-h">${ICON.search}<input id="hs" placeholder="Компания, серийный номер" autocomplete="off" aria-label="Поиск"><div class="sdrop" id="sd" hidden></div></div>
    <div class="user" data-act="usermenu" role="button" tabindex="0"><span class="avatar">${esc(ME.initials)}</span><span style="white-space:nowrap">${esc(ME.short)}<small>${esc(ME.role_label)}</small></span>
      <div class="menu" id="umenu" hidden><div class="who"><b>${esc(ME.name)}</b><small>${esc(ME.role_label)}</small><small>${esc(ME.email)}</small></div><a href="#/settings">Настройки уведомлений</a><button class="out" data-act="logout">Выйти</button></div></div>
  </header><main id="main">${inner}</main>`;
}
function render(active, inner) { $app.innerHTML = shell(active, inner); bindSearch(); }
function setMain(html) { const m = $("#main"); if (m) m.innerHTML = html; }

function bindSearch() {
  const inp = $("#hs"), dd = $("#sd"); if (!inp) return;
  let items = [], sel = -1;
  const draw = (q, total) => {
    if (q.length < 3) { dd.hidden = true; return; }
    dd.hidden = false;
    dd.innerHTML = items.length ? `<div class="hd">Найдено ${total} ${total === 1 ? "результат" : plural(total, "результат", "результата", "результатов")}</div>` + items.map((it, i) => `<div class="it ${i === sel ? "on" : ""}" data-i="${i}"><b>${esc(it.title)}</b><span>${esc(it.sub)}</span></div>`).join("") : '<div class="hd">Ничего не найдено</div>';
  };
  const go = it => { dd.hidden = true; inp.value = ""; location.hash = it.type === "company" ? `#/deal/${it.deal_id}` : `#/deal/${it.deal_id}/equipment?server=${encodeURIComponent(it.server)}&serial=${it.serial}`; };
  const run = debounce(async () => { const q = inp.value.trim(); if (q.length < 3) return draw(q); try { const r = await api("/search?q=" + encodeURIComponent(q)); items = r.items; sel = -1; draw(q, r.total ?? r.items.length); } catch { } }, 300);
  inp.oninput = run;
  inp.onkeydown = e => {
    if (e.key === "Escape") { dd.hidden = true; inp.blur(); }
    else if (e.key === "ArrowDown" && items.length) { sel = (sel + 1) % items.length; draw(inp.value.trim(), items.length); e.preventDefault(); }
    else if (e.key === "ArrowUp" && items.length) { sel = (sel - 1 + items.length) % items.length; draw(inp.value.trim(), items.length); e.preventDefault(); }
    else if (e.key === "Enter" && items.length) go(items[Math.max(sel, 0)]);
  };
  dd.onmousedown = e => { const it = e.target.closest(".it"); if (it) go(items[+it.dataset.i]); };
  inp.onblur = () => setTimeout(() => dd.hidden = true, 150);
}

document.addEventListener("click", e => {
  const m = $("#umenu"); if (m && !e.target.closest(".user")) m.hidden = true;
  const el = e.target.closest("[data-act]"); if (!el) return;
  if (el.dataset.act === "usermenu") { const m2 = $("#umenu"); m2.hidden = !m2.hidden; }
  else if (el.dataset.act === "logout") api("/logout", { body: {} }).then(() => { ME = null; RETURN_TO = null; location.hash = "#/login"; route(); });
});
["mousemove", "keydown", "click", "touchstart"].forEach(ev => document.addEventListener(ev, () => { LAST_ACT = Date.now(); }, { passive: true }));
setInterval(() => { if (ME && Date.now() - LAST_ACT > 30 * 60 * 1000) sessionExpired(); }, 20000);

/* X04: сессия завершена, введённое в формах сохраняется (страница остаётся на месте) */
function sessionExpired() {
  if (EXPIRED_SHOWN || !ME) return; EXPIRED_SHOWN = true; RETURN_TO = location.hash;
  modal({ title: "Сессия завершена", narrow: true, dismissable: false, body: '<p class="muted" style="margin:0">Вы не работали 30 минут. Войдите снова, и откроется та же страница. Введённые данные форм сохранены.</p>',
    actions: [{ id: "re", label: "Войти снова", primary: true, onClick: () => { $$(".modal-ov").forEach(o => o.remove()); EXPIRED_SHOWN = false; ME = null; viewLogin(); } }] });
}

/* ---------- состояния: загрузка X01, ошибка X02, нет доступа X03 ---------- */
const skeleton = () => `<div class="sk" style="width:200px;height:26px;margin-bottom:18px"></div><div class="sk" style="height:100px;margin-bottom:34px"></div><div class="sk" style="width:260px;height:20px;margin-bottom:14px"></div>${'<div class="sk" style="height:38px;margin-bottom:8px"></div>'.repeat(6)}`;
const errorView = (title, retryFn) => { setMain(`<div class="center-msg"><h2>${esc(title)}</h2><p>Проверьте подключение к сети банка или попробуйте через минуту</p><button class="btn primary" id="retry">Повторить</button></div>`); $("#retry").onclick = retryFn; };
const noAccess = text => { render("", `<div class="center-msg"><h2>Нет доступа к этому разделу</h2><p>${esc(text || "Если доступ нужен, обратитесь к руководителю подразделения")}</p><a class="btn primary" href="#/portfolio">В портфель</a></div>`); };

/* ---------- маршрутизация ---------- */
async function route() {
  clearInterval(POLL); POLL = null; EXPIRED_SHOWN = false;
  const full = location.hash.replace(/^#\/?/, "") || "portfolio";
  const [path, qs] = full.split("?"), query = new URLSearchParams(qs || "");
  const [page, a, b] = path.split("/");
  if (page === "reset") return viewReset(a);
  if (page === "forgot") return viewForgot(query.get("email") || "");
  if (!ME) { try { ME = await api("/me"); } catch (e) { return viewLogin(); } }
  if (page === "login") { location.hash = "#/portfolio"; return; }
  if (!$("#main")) render("", skeleton()); else setMain(skeleton());
  try {
    BADGE = ME.pending ?? BADGE;
    if (page === "portfolio") await viewPortfolio(query);
    else if (page === "new") { if (!can("create_assessment")) return noAccess("Новую оценку могут создавать кредитные аналитики. Если доступ нужен, обратитесь к руководителю подразделения"); await viewWizard(); }
    else if (page === "deal") await viewDeal(a, b || "overview", query);
    else if (page === "market") await viewMarket();
    else if (page === "notifications") await viewNotifications(query);
    else if (page === "settings") await viewSettings();
    else location.hash = "#/portfolio";
  } catch (e) {
    if (e.status === 403) return noAccess();
    if (e.status === 401) return;
    if (e.status === 404) return render("", `<div class="center-msg"><h2>Страница не найдена</h2><p>Возможно, сделка удалена или ссылка устарела</p><a class="btn primary" href="#/portfolio">В портфель</a></div>`);
    errorView({ portfolio: "Не удалось загрузить портфель", deal: "Не удалось загрузить компанию", market: "Не удалось загрузить рыночные данные", notifications: "Не удалось загрузить уведомления" }[page] || "Не удалось загрузить страницу", route);
  }
}
async function refreshBadge() {
  try { const m = await api("/me"); BADGE = m.pending; const nb = $('[data-nav="notifications"]'); if (nb) nb.innerHTML = "Уведомления" + (BADGE ? `<span class="badge">${BADGE}</span>` : ""); } catch { }
}
window.addEventListener("hashchange", route);

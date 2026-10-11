/* Уведомления U01–U07 и настройки U08, подключение ИИ */
"use strict";
let PENDING_REASSESS = null, PENDING_COD = null;
const GROUP = { swap: "swap", covenant: "cov", threshold: "cov", forecast: "forecast", link: "link", hardware: "hw", ready: "ready" };
const GLABEL = { swap: "Подмена", cov: "Ковенанты", forecast: "Прогноз", link: "Связь", hw: "Оборудование", ready: "Готово" };
const SEV = { high: "breach", medium: "near", low: "offline" };

async function viewNotifications(query) {
  const dealFilter = query.get("deal");
  let list = await api("/notifications"), f = query.get("f") || "all";
  if (dealFilter) list = list.filter(n => n.deal_id === dealFilter);
  const open = n => n.status === "new" || n.status === "in_work";
  const reload = async () => { list = await api("/notifications"); if (dealFilter) list = list.filter(n => n.deal_id === dealFilter); draw(); refreshBadge(); };
  const kinds = ["swap", "cov", "forecast", "link"].concat([...new Set(list.map(n => GROUP[n.kind]))].filter(k => !["swap", "cov", "forecast", "link"].includes(k)));
  const draw = () => {
    const vis = list.filter(n => f === "all" || (f === "wait" ? open(n) : GROUP[n.kind] === f)), waiting = list.filter(open).length;
    $("#sub").textContent = waiting ? `${waiting} ждут решения` : "Ничего не ждёт решения";
    $("#nt").innerHTML = `<button class="tab ${f === "all" ? "on" : ""}" data-f="all">Все<small>${list.length}</small></button><button class="tab ${f === "wait" ? "on" : ""}" data-f="wait">Ждут решения<small>${waiting}</small></button>` + kinds.map(k => `<button class="tab ${f === k ? "on" : ""}" data-f="${k}">${GLABEL[k]}<small>${list.filter(n => GROUP[n.kind] === k).length}</small></button>`).join("");
    $("#nl").innerHTML = vis.length === 0 ? `<div class="center-msg"><div class="ic-ok">${ICON.check.replace('width="20" height="20"', 'width="30" height="30"')}</div><h2>${f === "wait" || waiting === 0 ? "Всё разобрано" : "Уведомлений нет"}</h2><p>${f === "wait" || waiting === 0 ? "Новых событий, которые ждут решения, нет" : "В этом разделе пока ничего нет"}</p></div>` :
      vis.map(n => `<div class="item ${n.status === "closed" ? "dim" : ""}"><div><div class="kind"><span class="s-${SEV[n.severity]}"><i class="dot"></i>${esc(n.kind === "swap" ? "Подмена оборудования" : n.label)}</span><a class="b" href="#/deal/${n.deal_id}" style="text-decoration:none">${esc(n.borrower)}</a><span class="t num">${fdt(n.ts)}</span></div>
        <h3>${esc(n.title)}</h3><div style="font-size:17px">${esc(n.text)}</div><div class="muted" style="margin-top:14px;font-size:14px">${esc(n.meta)}</div></div>
        <div>${right(n)}</div></div>`).join("");
    $$("[data-n]").forEach(b => b.onclick = () => onAction(list.find(x => x.id === b.dataset.n), b.dataset.a));
  };
  const right = n => {
    if (n.status === "decided" || n.status === "watching") return `<div class="decided"><b>${n.status === "watching" ? "На наблюдении" : "Решение принято"}</b><br>${esc(n.decision ? n.decision.text : "")}<div class="by">${n.decision ? esc(n.decision.by) + ", " + fd(n.decision.ts) : ""}</div></div>`;
    if (open(n) && n.actions.length) return `${n.recommendation ? `<div style="margin-bottom:14px"><b>Рекомендация.</b> <span class="muted">${esc(n.recommendation)}</span></div>` : ""}<div class="acts">${n.actions.map(a => `<button class="btn ${a.primary ? "primary" : ""}" data-n="${n.id}" data-a="${a.id}">${esc(a.label)}</button>`).join("")}</div>`;
    return open(n) && n.recommendation ? `<div><b>Рекомендация.</b> <span class="muted">${esc(n.recommendation)}</span></div>` : "";
  };
  render("notifications", `<div class="head"><div><h1>Уведомления</h1><div class="sub" id="sub" style="font-size:18px"></div>${dealFilter ? `<p><a href="#/notifications">Показать по всем сделкам</a></p>` : ""}</div><a class="btn" href="#/settings">Настроить</a></div>
    <div class="tabs" id="nt"></div><div class="card nlist" id="nl"></div>`);
  $("#nt").onclick = e => { const b = e.target.closest("[data-f]"); if (b) { f = b.dataset.f; draw(); } };
  draw(); BADGE = list.filter(open).length;

  async function decide(n, action, payload, ctl) {
    try { const r = await api(`/notifications/${n.id}/decide`, { body: { action, payload, request_id: ctl ? ctl.rid : rid() } }); if (ctl) ctl.close(); if (r.toast) toast(r.toast); BADGE = r.pending; await reload(); return r; }
    catch (e) {
      if (e.status === 409) { if (ctl) ctl.close(); toast("Уведомление обновилось: решение уже принято"); await reload(); return null; }
      throw e;
    }
  }
  async function onAction(n, a) {
    if (!n) return;
    if (a === "request") return requestModal(n, decide);
    if (a === "inspect") return inspectModal(n, decide);
    if (a === "watch") return watchModal(n, decide);
    if (a === "write_cod") { const m = /Сервер (\S+)/.exec(n.title); PENDING_COD = { id: n.deal_id, server: m ? m[1] : "" }; location.hash = `#/deal/${n.deal_id}/equipment`; return; }
    try {
      const r = await decide(n, a, {});
      if (r && a === "reassess") { PENDING_REASSESS = n.deal_id; location.hash = "#/deal/" + n.deal_id; }
      else if (r && (a === "params" || a === "open")) location.hash = "#/deal/" + n.deal_id;
    } catch (e) { toast(e.message, true); }
  }
}
const addDays = n => { const d = new Date(Date.now() + n * 864e5); return d.toISOString().slice(0, 10); };
async function staffOptions(sel) { let st = []; try { st = await api("/staff"); } catch { } return st.map(u => `<option value="${esc(u.email)}" ${u.email === sel ? "selected" : ""}>${esc(u.name)}, ${esc(u.role.toLowerCase())}</option>`).join(""); }

/* U02 */
async function requestModal(n, decide) {
  const D = await api("/deals/" + n.deal_id), cv = D.loan.covenant, cc = D.detail.coverage_now, need = Math.max(0, cv * D.detail.debt_now - D.detail.valuation.market);
  const due = addDays(14), amount = Math.ceil(need / 1e5) * 1e5 || 1e6;
  const m = modal({ title: "Запросить обеспечение", sub: `${D.borrower}, сделка ${D.contract}`,
    body: `<div class="facts"><div><div class="l">Покрытие</div><div class="v red">${cov(cc)}</div></div><div><div class="l">Ковенант</div><div class="v">${cov(cv)}</div></div><div><div class="l">Не хватает</div><div class="v red">${mln(need)}</div></div></div>
      <div class="grid2"><div class="fld"><label>Сумма, ₽</label><input class="inp" name="amount" inputmode="numeric" value="${amount}"></div><div class="fld"><label>Срок</label><input class="inp" name="due" type="date" min="${addDays(0)}" value="${due}"></div></div>
      <div class="fld"><label>Ответственный</label><select class="inp" name="responsible">${await staffOptions(ME.role === "collateral" ? ME.email : "i.petrov@bank.ru")}</select></div>
      <div class="fld"><label>Сообщение заёмщику</label><textarea class="inp" name="message">Стоимость залога снизилась. Просим предоставить дополнительное обеспечение до ${dmy(due)}</textarea></div>${D.contact_email ? "" : '<div class="muted" style="font-size:13px">У контакта нет почты — письмо не будет отправлено, решение сохранится.</div>'}`,
    actions: [{ id: "c", label: "Отмена", onClick: c => c.close() }, { id: "ok", label: "Отправить", primary: true, onClick: ctl => submitModal(ctl, "ok", () => decide(n, "request", { amount: $('[name="amount"]', ctl.el).value, due: $('[name="due"]', ctl.el).value, responsible: $('[name="responsible"]', ctl.el).value, message: $('[name="message"]', ctl.el).value }, ctl)) }] });
  m.rid = rid();
}
/* U05 */
async function inspectModal(n, decide) {
  const D = await api("/deals/" + n.deal_id), m = /Сервер (\S+), GPU (\d+)/.exec(n.text);
  const mm = modal({ title: "Назначить выездную проверку", sub: `${D.borrower}, ${D.location}`, narrow: true,
    body: `<div class="grid2"><div class="fld"><label>Дата проверки</label><input class="inp" name="date" type="date" min="${addDays(0)}" value="${addDays(3)}"></div><div class="fld"><label>Ответственный</label><select class="inp" name="responsible">${await staffOptions(ME.role === "collateral" ? ME.email : "m.orlova@bank.ru")}</select></div></div>
      <div class="fld"><label>Что проверить</label><textarea class="inp" name="what">${m ? `Сервер ${esc(m[1])}, GPU ${m[2]}: сверить серийный номер с договором залога` : "Осмотреть оборудование и сверить серийные номера с договором залога"}</textarea></div>
      <label class="chk"><input type="checkbox" name="suspend" checked> Приостановить выдачу траншей до проверки</label>`,
    actions: [{ id: "c", label: "Отмена", onClick: c => c.close() }, { id: "ok", label: "Назначить", primary: true, onClick: ctl => submitModal(ctl, "ok", () => decide(n, "inspect", { date: $('[name="date"]', ctl.el).value, responsible: $('[name="responsible"]', ctl.el).value, what: $('[name="what"]', ctl.el).value, suspend: $('[name="suspend"]', ctl.el).checked }, ctl)) }] });
  mm.rid = rid();
}
/* U06 */
function watchModal(n, decide) {
  const m = modal({ title: "Оставить на наблюдении", sub: `${n.borrower}, ${n.label.toLowerCase()}`, narrow: true,
    body: `<div class="fld"><label>Проверить снова</label><input class="inp" name="date" type="date" min="${addDays(1)}" value="${addDays(30)}"></div><div class="fld"><label>Комментарий</label><textarea class="inp" name="comment" placeholder="Например: ждём анонса нового поколения чипов"></textarea></div><p class="muted" style="font-size:12px;margin:0">В указанную дату уведомление вернётся во вкладку «Ждут решения».</p>`,
    actions: [{ id: "c", label: "Отмена", onClick: c => c.close() }, { id: "ok", label: "Сохранить", primary: true, onClick: ctl => submitModal(ctl, "ok", () => decide(n, "watch", { date: $('[name="date"]', ctl.el).value, comment: $('[name="comment"]', ctl.el).value }, ctl)) }] });
  m.rid = rid();
}

/* ---------- U08: настройки ---------- */
const PRESETS = [["OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"], ["OpenRouter", "https://openrouter.ai/api/v1", "openai/gpt-4o-mini"], ["Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"],
  ["Claude (Anthropic)", "https://api.anthropic.com", "claude-opus-5-5"], ["Ollama (локально)", "http://localhost:11434/v1", "llama3.1"]];
async function viewSettings() {
  const S = await api("/settings"), th = S.thresholds, ed = S.can_edit_thresholds, a = S.ai;
  render("notifications", `<div class="crumbs"><a href="#/notifications">Уведомления</a> / Настройки</div><h1 style="margin-bottom:6px">Настройки уведомлений</h1><div class="sub" style="margin-bottom:26px">Какие события и куда присылать вам</div>
  <div class="card tblwrap"><table class="tbl"><thead><tr><th>Событие</th><th>Кому приходит</th><th>В приложении</th><th>На почту</th></tr></thead><tbody>${S.notify.map(n => `<tr><td><b>${esc(n.label)}</b></td><td class="muted">${esc(n.to)}</td><td><label class="sw"><input type="checkbox" data-k="${n.kind}" data-ch="app" ${n.app ? "checked" : ""}><i></i></label></td><td><label class="sw"><input type="checkbox" data-k="${n.kind}" data-ch="email" ${n.email ? "checked" : ""}><i></i></label></td></tr>`).join("")}</tbody></table></div>
  <div class="card" style="padding:30px 36px;margin-top:26px"><div class="row-between" style="margin-bottom:14px"><h2>Пороги</h2><span class="muted" style="font-size:14px">${ed ? "Вы можете менять пороги" : "Меняет только управление рисков"}</span></div>
   <div class="grid3" id="th" style="grid-template-columns:repeat(4,1fr)">${[["covenant", "Ковенант покрытия", nf(th.covenant, 2), ""], ["near", "«Близко к порогу» ниже", nf(th.near, 2), ""], ["offline_warn_h", "Сервер молчит, предупредить через, ч", nf(th.offline_warn_h, 0), ""], ["offline_notify_h", "Сервер молчит, уведомить через, ч", nf(th.offline_notify_h, 0), ""]].map(([k, t, v]) => `<div class="fld"><label>${t}</label><input class="inp" name="${k}" value="${v}" ${ed ? "" : "disabled"} style="${ed ? "" : "background:#f3ecdd"}"></div>`).join("")}</div></div>
  <div class="foot" style="margin-top:20px"><span></span><button class="btn primary" id="save">Сохранить</button></div>
  ${a.can_edit ? `<div class="card" style="padding:30px 36px;margin-top:34px"><h2 style="margin-bottom:4px">Нейросеть: подключение по API</h2><p class="muted" style="margin:0 0 16px;font-size:14px">Подойдёт любой сервис с OpenAI-совместимым API. Модель только подсказывает по телеметрии, в расчёт стоимости не входит.</p>
   <div class="preset" id="pr">${PRESETS.map(p => `<button type="button" data-u="${esc(p[1])}" data-m="${esc(p[2])}">${esc(p[0])}</button>`).join("")}</div>
   <div class="grid2"><div class="fld"><label>Адрес API (base URL)</label><input class="inp" id="au" value="${esc(a.base_url)}"></div><div class="fld"><label>Модель</label><input class="inp" id="am" list="ml" value="${esc(a.model)}"><datalist id="ml"></datalist></div>
    <div class="fld"><label>API-ключ ${a.has_key ? `<span class="ok-t">· ${a.key_from_env ? "задан в .env" : "сохранён"}</span>` : ""}</label><input class="inp" id="ak" type="password" autocomplete="off" placeholder="${a.has_key ? "оставьте пустым, чтобы не менять" : "sk-…"}"></div><div class="fld"><label>Анализ каждые, мин</label><input class="inp" id="ai" type="number" min="1" value="${a.interval_min}"></div></div>
   <label class="chk"><input type="checkbox" id="ae" ${a.enabled ? "checked" : ""}> Включить ИИ-анализ телеметрии</label>
   <div class="row" style="margin-top:16px"><button class="btn primary" id="sv">Сохранить</button><button class="btn" id="ts">Проверить подключение</button><button class="btn" id="lm">Список моделей</button>${a.has_key && !a.key_from_env ? '<button class="btn" id="ck">Удалить ключ</button>' : ""}</div><div id="tr" style="margin-top:14px"></div>
   <p class="muted" style="font-size:13px;margin:18px 0 0">Ключ можно задать и без интерфейса: файл <code>.env</code> (CC_AI_API_KEY, CC_AI_BASE_URL, CC_AI_MODEL). В интерфейс ключ не возвращается.</p>
   <label class="chk" style="margin-top:12px"><input type="checkbox" id="sim" ${S.simulate ? "checked" : ""}> Симулировать агентов в демо-сделках</label></div>` : ""}`);
  $("#save").onclick = async e => {
    e.target.disabled = true;
    try {
      const notify = {}; $$("[data-k]").forEach(c => { (notify[c.dataset.k] = notify[c.dataset.k] || {})[c.dataset.ch] = c.checked; });
      await api("/settings/notify", { body: { notify } });
      if (ed) { const g = k => parseFloat(String($(`[name="${k}"]`, $("#th")).value).replace(",", ".")); await api("/settings/thresholds", { body: { covenant: g("covenant"), near: g("near"), offline_warn_h: g("offline_warn_h"), offline_notify_h: g("offline_notify_h") } }); }
      toast("Настройки сохранены");
    } catch (er) { toast(er.message, true); }
    e.target.disabled = false;
  };
  if (a.can_edit) {
    const aiBody = extra => ({ base_url: $("#au").value, model: $("#am").value, api_key: $("#ak").value, interval_min: +$("#ai").value, enabled: $("#ae").checked, simulate: $("#sim").checked, ...extra });
    $$("#pr button").forEach(b => b.onclick = () => { $("#au").value = b.dataset.u; $("#am").value = b.dataset.m; $$("#pr button").forEach(x => x.classList.toggle("on", x === b)); });
    $("#sv").onclick = async () => { try { await api("/settings/ai", { body: aiBody() }); toast("Настройки сохранены"); viewSettings(); } catch (e) { toast(e.message, true); } };
    $("#sim").onchange = () => api("/settings/ai", { body: aiBody() }).catch(e => toast(e.message, true));
    const ck = $("#ck"); if (ck) ck.onclick = async () => { await api("/settings/ai", { body: aiBody({ clear_key: true, api_key: "" }) }); toast("Ключ удалён"); viewSettings(); };
    $("#ts").onclick = async e => { e.target.disabled = true; $("#tr").innerHTML = '<span class="muted"><span class="spin"></span> Проверяем…</span>'; try { await api("/settings/ai", { body: aiBody() }); const r = await api("/ai/test", { body: {} }); $("#tr").innerHTML = `<div class="info" style="margin:0"><b>Подключение работает</b> · ${esc(r.model)}<br>Ответ: ${esc(r.reply)}</div>`; } catch (er) { $("#tr").innerHTML = `<div class="info bad" style="margin:0">${esc(er.message)}</div>`; } e.target.disabled = false; };
    $("#lm").onclick = async e => { e.target.disabled = true; try { await api("/settings/ai", { body: aiBody() }); const r = await api("/ai/models", { body: {} }); $("#ml").innerHTML = r.models.map(m => `<option value="${esc(m)}">`).join(""); toast(`Моделей найдено: ${r.models.length}. Выберите в поле «Модель»`); $("#am").focus(); } catch (er) { $("#tr").innerHTML = `<div class="info bad" style="margin:0">${esc(er.message)}</div>`; } e.target.disabled = false; };
  }
}

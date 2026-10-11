/* Новая оценка N01–N11: заёмщик → оборудование → телеметрия → параметры кредита → расчёт */
"use strict";
let WIZ = null;
const STEPS = ["Заёмщик", "Оборудование", "Телеметрия", "Параметры кредита"];
const FIELDS = [["name", "Название компании", "ООО «Название»"], ["inn", "ИНН", "10 или 12 цифр"], ["application", "Номер кредитной заявки", "КД-2026-0418"],
                ["location", "Где стоит оборудование", "ЦОД, город"], ["contact", "Контакт в ЦОД", "Имя и фамилия"], ["contact_email", "Почта контакта", "необязательно"]];
const formKey = () => "cc_wiz_form_" + (ME ? ME.email : "");
const newWiz = () => { let f = {}; try { f = JSON.parse(lsGet(formKey()) || "{}"); } catch { } return { step: 1, form: { name: "", inn: "", application: "", location: "", contact: "", contact_email: "", ...f }, force: false, dup: null, parsed: null, fileName: "", draft: null, mode: "agent", smi: null, agentSince: null, loan: { amount: 60000000, term: 36, rate: 18, schedule: "annuity", issue_date: new Date().toISOString().slice(0, 10), covenant: 1.25 }, excluded: false }; };

async function viewWizard() {
  if (!WIZ || WIZ.done) {
    WIZ = newWiz();
    const d = (await api("/draft")).draft;       // «Новая оценка» продолжает черновик с того же шага
    if (d) Object.assign(WIZ, { draft: d, step: d.step || 3, form: { name: d.borrower, inn: d.inn, application: d.application, location: d.location, contact: d.contact, contact_email: d.contact_email || "" }, mode: d.telemetry_mode || "agent",
      parsed: { servers: d.servers, cards: d.cards, count_servers: d.servers.length, errors: 0, rows: [], total: d.cards }, fileName: "перечень оборудования (черновик)" });
  }
  wizRender();
}
function wizHead() {
  const w = WIZ;
  return `<h1>Новая оценка</h1><div class="sub" style="font-size:18px">${w.form.name ? esc(w.form.name) + (w.form.inn ? ", ИНН " + esc(w.form.inn) : "") : "Новая сделка"}</div>
  <div class="steps">${STEPS.map((n, i) => `${i ? '<span class="ln"></span>' : ""}<div class="step ${w.step === i + 1 ? "on" : w.step > i + 1 ? "done" : ""}"><span class="c">${w.step > i + 1 ? ICON.check : i + 1}</span>${n}</div>`).join("")}</div>`;
}
function wizRender() { ({ 1: wizStep1, 2: wizStep2, 3: wizStep3, 4: wizStep4, 5: wizCalc })[WIZ.step](); }

/* ---- N01, N02 ---- */
function wizStep1() {
  const w = WIZ;
  render("new", `${wizHead()}<div class="card" style="padding:34px 40px" id="fm"><div class="grid2">${FIELDS.map(([k, t, ph]) => `<div class="fld"><label>${t}</label><input class="inp" name="${k}" value="${esc(w.form[k])}" placeholder="${ph}" autocomplete="off"></div>`).join("")}</div></div>
  <div id="dup"></div><div class="foot"><span></span><button class="btn primary" id="next">Далее</button></div>`);
  const fm = $("#fm");
  const check = () => {
    const f = w.form, errs = {};
    if (f.name.trim().length < 2 || f.name.length > 200) errs.name = "От 2 до 200 символов";
    if (!/^(\d{10}|\d{12})$/.test(f.inn.trim()) || !innOk(f.inn.trim())) errs.inn = "10 или 12 цифр, проверьте контрольную сумму";
    if (!/^(КД|KD)-\d{4}-\d{4}$/i.test(f.application.trim())) errs.application = "Формат КД-ГГГГ-NNNN, например КД-2026-0418";
    if (!f.location.trim()) errs.location = "Укажите, где стоит оборудование";
    if (!f.contact.trim()) errs.contact = "Укажите контакт в ЦОД";
    if (f.contact_email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.contact_email.trim())) errs.contact_email = "Проверьте адрес почты";
    return errs;
  };
  const show = (errs, only) => { $$(".fld", fm).forEach(fl => { const n = $("input", fl).name; if (only && only !== n) return; fl.classList.toggle("bad", !!errs[n]); const m = $(".msg", fl); m && m.remove(); if (errs[n]) fl.insertAdjacentHTML("beforeend", `<div class="msg">${esc(errs[n])}</div>`); }); };
  fm.addEventListener("input", e => { w.form[e.target.name] = e.target.value; lsSet(formKey(), JSON.stringify(w.form)); if (e.target.name === "inn") dupCheck(); });
  fm.addEventListener("focusout", e => { if (e.target.name) show(check(), e.target.name); });
  async function dupCheck() {
    const inn = w.form.inn.trim(); w.dup = null; w.force = false; drawDup();
    if (!/^(\d{10}|\d{12})$/.test(inn) || !innOk(inn)) return;
    try { const r = await api("/check-inn?inn=" + inn); if (w.form.inn.trim() === inn) { w.dup = r.existing; drawDup(); } } catch { }
  }
  function drawDup() {
    const d = $("#dup"), nx = $("#next"); if (!d) return;
    if (w.dup && !w.force) { d.innerHTML = `<div class="banner-amber"><div><b>Компания с этим ИНН уже есть в портфеле</b>${esc(w.dup.borrower)}, сделка ${esc(w.dup.contract || "")}${w.dup.assessed ? ", оценка от " + w.dup.assessed : ""}</div><div class="row"><button class="btn sm" id="open">Открыть компанию</button><button class="btn sm primary" id="newdeal">Новая сделка для неё</button></div></div>`; nx.disabled = true;
      $("#open").onclick = async () => { if (w.draft) await api(`/deals/${w.draft.id}/discard`, { body: {} }).catch(() => { }); WIZ = null; location.hash = "#/deal/" + w.dup.id; };
      $("#newdeal").onclick = () => { w.force = true; drawDup(); }; }
    else { d.innerHTML = ""; nx.disabled = false; }
  }
  $("#next").onclick = () => { const errs = check(); show(errs); if (Object.keys(errs).length) return $(`[name="${Object.keys(errs)[0]}"]`, fm).focus(); w.step = 2; wizRender(); };
  if (innOk(w.form.inn.trim()) && /^(\d{10}|\d{12})$/.test(w.form.inn.trim())) dupCheck();
}
function innOk(inn) {
  const d = [...inn].map(Number), chk = ws => ws.reduce((a, w, i) => a + w * d[i], 0) % 11 % 10;
  if (inn.length === 10) return chk([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  if (inn.length === 12) return chk([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && chk([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
  return false;
}

/* ---- N03, N04, N05 ---- */
function wizStep2() {
  const w = WIZ, p = w.parsed, bad = p ? p.errors : 0;
  let shown = 8;
  const fileCard = () => !p ? "" : `<div class="card filecard"><div class="ftype">${/xlsx?$/i.test(w.fileName) ? "XLSX" : "CSV"}</div><div style="flex:1"><div style="font-size:20px;font-weight:600">${esc(w.fileName)}</div><div class="muted" style="font-size:14px">${w.draft ? "" : "Загружен сейчас, "}<a href="#" id="repl">заменить</a></div></div>
    <div class="${bad && !w.excluded ? "red" : "ok-t"}"><i class="dot" style="background:currentColor"></i>${bad && !w.excluded ? `${bad} ${plural(bad, "строка", "строки", "строк")} из ${p.total} с ошибками` : `${p.cards} ${plural(p.cards, "карта", "карты", "карт")}, ${p.count_servers} ${plural(p.count_servers, "сервер", "сервера", "серверов")}, ${w.excluded ? "исключено строк: " + bad : "ошибок нет"}`}</div></div>`;
  const tableRows = () => {
    if (bad && !w.excluded) return p.rows.slice(0, 80).map(r => `<tr class="${r.ok ? "" : "row-bad"}"><td class="muted num">${r.line}</td><td>${esc(r.server)}</td><td>${esc(r.model)}</td><td class="num">${esc(r.serial)}</td><td class="num">${dmy(r.date)}</td><td>${r.ok ? '<span class="ok-t"><i class="dot ok"></i>Верно</span>' : `<span class="why">${esc(r.error)}</span>`}</td></tr>`).join("");
    const flat = p.servers.flatMap(s => s.gpus.map(g => ({ s: s.name, m: s.model, g })));
    return flat.slice(0, shown).map(r => `<tr><td><b>${esc(r.s)}</b></td><td>${esc(r.m)}</td><td class="num">${esc(r.g.serial)}</td><td class="num">${dmy(r.g.commissioned)}</td></tr>`).join("") + (flat.length > shown ? `<tr><td colspan="4" class="muted" style="cursor:pointer" id="more">Ещё ${flat.length - shown} ${plural(flat.length - shown, "строка", "строки", "строк")}</td></tr>` : "");
  };
  const tableHead = bad && !w.excluded ? "<th>Строка</th><th>Сервер</th><th>Модель</th><th>Серийный номер</th><th>Дата ввода</th><th>Проверка</th>" : "<th>Сервер</th><th>Модель</th><th>Серийный номер</th><th>Дата ввода</th>";
  render("new", `${wizHead()}
   ${!p ? `<div class="drop" id="drop"><div class="ic">${ICON.up}</div><h2>Загрузите список оборудования</h2><p class="muted" style="font-size:17px;margin:0 0 26px">Файл Excel или CSV от заёмщика, до 10 МБ, можно перетащить сюда</p>
     <button class="btn primary lg" id="pick" style="padding:0 40px">Загрузить файл</button><div id="ferr"></div><p class="muted" style="margin-top:26px">Нет файла у заёмщика? <a href="/api/template.xlsx">Скачать шаблон</a></p>${window.CC_DEMO ? '<p><button class="btn sm" id="sample">Загрузить пример файла</button></p>' : ""}</div>`
    : `${fileCard()}<div class="card tblwrap"><table class="tbl"><thead><tr>${tableHead}</tr></thead><tbody id="tb2">${tableRows()}</tbody></table></div>
      ${bad && !w.excluded ? `<div class="foot"><button class="btn" id="excl">Исключить ${bad} ${plural(bad, "строку", "строки", "строк")} и продолжить</button><button class="btn" disabled>Далее</button></div>` : ""}`}
   ${p && !(bad && !w.excluded) ? `<div class="foot"><button class="btn" id="back">Назад</button><button class="btn primary" id="next">Далее</button></div>` : !p ? `<div class="foot"><button class="btn" id="back">Назад</button><span></span></div>` : ""}<input type="file" id="fi" accept=".xlsx,.xlsm,.csv" hidden>`);
  const send = async f => {
    const fe = $("#ferr"); if (fe) fe.innerHTML = "";
    if (f.size > 10 * 1024 * 1024) return ferr("Файл больше 10 МБ");
    if (!/\.(xlsx|xlsm|csv)$/i.test(f.name)) return ferr("Нужен файл Excel (.xlsx) или CSV");
    try { w.parsed = await api("/parse-equipment", { body: f, headers: { "X-Filename": encodeURIComponent(f.name) } }); w.fileName = f.name; w.excluded = false; w.draft = null; wizRender(); }
    catch (e) { ferr(e.message); }
  };
  function ferr(m) { const fe = $("#ferr"); if (fe) fe.innerHTML = `<div class="err" style="margin-top:14px">${esc(m)}</div>`; else toast(m, true); }
  const pick = $("#pick"); if (pick) pick.onclick = () => $("#fi").click();
  const repl = $("#repl"); if (repl) repl.onclick = e => { e.preventDefault(); w.parsed = null; w.draft = null; wizRender(); };
  $("#fi").onchange = e => e.target.files[0] && send(e.target.files[0]);
  const sm = $("#sample"); if (sm) sm.onclick = () => send(new File([CC_DEMO_SAMPLES.template], "equipment_example.csv"));
  const dz = $("#drop"); if (dz) { dz.ondragover = e => { e.preventDefault(); dz.classList.add("over"); }; dz.ondragleave = () => dz.classList.remove("over"); dz.ondrop = e => { e.preventDefault(); dz.classList.remove("over"); e.dataTransfer.files[0] && send(e.dataTransfer.files[0]); }; }
  const mr = $("#more"); if (mr) mr.onclick = () => { shown = 1e9; $("#tb2").innerHTML = tableRows(); };
  const ex = $("#excl"); if (ex) ex.onclick = () => { w.excluded = true; wizRender(); };
  const bk = $("#back"); if (bk) bk.onclick = () => { w.step = 1; wizRender(); };
  const nx = $("#next"); if (nx) nx.onclick = async () => {
    nx.disabled = true;
    try {
      if (!w.draft) { const f = w.form; const r = await api("/deals", { body: { name: f.name, inn: f.inn, application: f.application, location: f.location, contact: f.contact, contact_email: f.contact_email, servers: w.parsed.servers, force: w.force } }); w.draft = { id: r.id, agent_key: r.agent_key }; }
      w.step = 3; wizRender();
    } catch (e) { nx.disabled = false; if (e.status === 409) { w.dup = e.data.existing; w.step = 1; wizRender(); } else if (e.data && e.data.fields) { w.step = 1; wizRender(); setTimeout(() => toast("Проверьте данные заёмщика", true), 50); } else toast(e.message, true); }
  };
}

/* ---- N06, N07, N08 ---- */
function wizStep3() {
  const w = WIZ, id = w.draft.id;
  const opts = [["agent", "Агент на серверах", "Данные идут постоянно. После выдачи кредита банк видит, если оборудование заменили или отключили"], ["file", "Файл nvidia-smi", "Разовый снимок состояния карт. Наблюдать за залогом после выдачи нельзя"], ["none", "Без телеметрии", "Оценка с понижающей поправкой до 7 %, состояние карт неизвестно"]];
  render("new", `${wizHead()}<div class="opts">${opts.map(([k, t, d]) => `<div class="opt ${w.mode === k ? "on" : ""}" data-m="${k}"><span class="rd"></span><div><b>${t}</b><span>${d}</span></div></div>`).join("")}</div><div id="tp"></div>
  <div class="foot"><button class="btn" id="back">Назад</button><div class="row" id="nbar"></div></div><input type="file" id="fi" accept=".csv,.xlsx" hidden>`);
  $$(".opt").forEach(o => o.onclick = () => { w.mode = o.dataset.m; w.smi = null; wizStep3(); });
  $("#back").onclick = () => { w.step = 2; wizRender(); };
  const goNext = async () => { try { if (w.mode === "none") await api(`/deals/${id}/telemetry`, { body: { mode: "none" } }); await api(`/deals/${id}/step`, { body: { step: 4 } }); w.step = 4; wizRender(); } catch (e) { toast(e.message, true); } };
  const nbar = (btns) => { $("#nbar").innerHTML = btns; };
  const tp = $("#tp");
  if (w.mode === "agent") {
    api(`/deals/${id}/telemetry`, { body: { mode: "agent" } }).catch(() => { });
    w.agentSince = w.agentSince || Date.now();
    const key = w.draft.agent_key || "";
    const cmd = `python agent.py --server http://${location.host} --key ${key} --name <имя сервера из перечня>`;
    const refresh = async () => {
      if (!$("#tp")) return;
      let d; try { d = await api("/deals/" + id); } catch { return; }
      const S = d.servers, on = S.filter(s => s.online).length, total = S.length, waited = (Date.now() - w.agentSince) / 60000, partial = (on > 0 && on < total) || (on === 0 && waited >= 30);
      const rowsT = S.map(s => `<tr><td><b>${esc(s.name)}</b></td><td class="num">${s.online ? s.cards : 0}</td><td>${s.last_seen ? agoShort(s.last_seen) : "нет сигнала"}</td><td>${s.online ? sdot("ok", "На связи") : sdot("near", "Ждём сигнал")}</td></tr>`).join("");
      const demoBox = `<div class="muted" style="font-size:13px;margin-top:14px">Демонстрация без реальных серверов: <a href="#" id="dm1">подключить всех</a> · <a href="#" id="dm2">подключить часть (последние ${Math.max(1, Math.ceil(total / 2))} молчат)</a></div>`;
      tp.innerHTML = on === total && total > 0 ? `<div class="info" style="background:#e1f1e7;color:#1e5a37"><b><i class="dot ok"></i>Агент подключён: ${on} из ${total} ${plural(total, "сервера", "серверов", "серверов")} на связи</b><br>Данные получены по ${d.detail.equipment.seen} картам, серийные номера ${d.detail.equipment.matched === d.detail.equipment.total ? "совпадают с перечнем" : "совпадают у " + d.detail.equipment.matched + " из " + d.detail.equipment.total}</div>${d.detail.equipment.mismatches.length ? `<div class="banner-amber red"><div><b>Есть несовпадения серийных номеров: ${d.detail.equipment.mismatches.length}</b>После расчёта по сделке появится уведомление «Подмена оборудования»</div></div>` : ""}${gpuTable(S)}`
        : partial ? `<div class="banner-amber"><div><b>На связи ${on} из ${total} ${plural(total, "сервера", "серверов", "серверов")}</b>${S.filter(s => !s.online).map(s => esc(s.name)).join(" и ")} не отвечают${waited >= 1 ? " " + Math.round(waited) + " мин" : ""}. Их карты можно оценить с поправкой −7 %</div></div><div class="card tblwrap"><table class="tbl"><thead><tr><th>Сервер</th><th>Карт</th><th>Последний сигнал</th><th>Связь</th></tr></thead><tbody>${rowsT}</tbody></table></div>`
        : `<div class="card" style="padding:30px 36px"><h2 style="font-size:19px;margin-bottom:6px">Подключение агента</h2>
          <div class="num-step"><span class="n">1</span><div>Передайте ЦОДу ключ подключения<br><span class="keychip" style="margin-top:8px">${esc(key)}</span> <button class="btn sm" id="cp">Копировать</button></div></div>
          <div class="num-step"><span class="n">2</span><div style="flex:1;min-width:0">ЦОД запускает установку на каждом сервере<div class="cmd">${esc(cmd)}</div></div></div>
          <div class="num-step"><span class="n">3</span><div>Ждём первый сигнал: <b>${on} из ${total} ${plural(total, "сервера", "серверов", "серверов")}</b> <span class="spin"></span></div></div></div>`;
      tp.insertAdjacentHTML("beforeend", demoBox + (on === total && total > 0 ? "" : ""));
      nbar(`<button class="btn" id="inv">Отправить инструкцию в ЦОД</button>` + (partial ? `<button class="btn" id="again">Проверить снова</button><button class="btn primary" id="skip">Продолжить без них</button>` : `<button class="btn primary" id="next" ${on === total && total > 0 ? "" : "disabled"}>Далее</button>`));
      const cp = $("#cp"); if (cp) cp.onclick = () => { navigator.clipboard ? navigator.clipboard.writeText(key).then(() => toast("Скопировано")).catch(() => toast("Скопируйте ключ вручную: " + key)) : toast("Скопируйте ключ вручную: " + key); };
      $("#inv").onclick = async e => { e.target.disabled = true; try { const r = await api(`/deals/${id}/invite-cod`, { body: {} }); toast("Инструкция отправлена: " + r.to); } catch (er) { toast(er.message, true); } e.target.disabled = false; };
      const nx = $("#next"); if (nx) nx.onclick = goNext;
      const sk = $("#skip"); if (sk) sk.onclick = goNext;
      const ag = $("#again"); if (ag) ag.onclick = () => { refresh(); toast("Проверяем снова…"); };
      const d1 = $("#dm1"); if (d1) d1.onclick = async e => { e.preventDefault(); await api(`/deals/${id}/demo-agent`, { body: {} }); refresh(); };
      const d2 = $("#dm2"); if (d2) d2.onclick = async e => { e.preventDefault(); await api(`/deals/${id}/demo-agent`, { body: { silent: Math.max(1, Math.ceil(total / 2)) } }); refresh(); };
    };
    refresh(); POLL = setInterval(refresh, 4000);
  } else if (w.mode === "file") {
    const show = r => { tp.innerHTML = `<div class="info ${r.missing ? "warn" : ""}"><b>Снимок загружен: ${r.matched} из ${r.total} карт найдены по серийным номерам</b>${r.missing ? `<br>Не найдено в файле: ${r.missing}` : ""}${r.extra.length ? `<br>Лишние номера: ${r.extra.slice(0, 5).map(esc).join(", ")}${r.extra.length > 5 ? "…" : ""}` : ""}</div><button class="btn" id="pk">Заменить файл</button>`; $("#pk").onclick = () => $("#fi").click(); nbar(`<button class="btn primary" id="next">Далее</button>`); $("#next").onclick = goNext; };
    tp.innerHTML = `<div class="info"><b>Загрузите вывод nvidia-smi</b><br>Команда: <code>nvidia-smi --query-gpu=index,serial,name,temperature.gpu,utilization.gpu --format=csv &gt; smi.csv</code></div><button class="btn primary" id="pk">Выбрать файл</button>${window.CC_DEMO ? ' <button class="btn" id="smp">Загрузить пример снимка</button>' : ""}`;
    nbar(`<button class="btn primary" id="next" disabled>Далее</button>`);
    $("#pk").onclick = () => $("#fi").click();
    const upl = async f => { try { w.smi = await api(`/deals/${id}/telemetry-file`, { body: f, headers: { "X-Filename": encodeURIComponent(f.name) } }); show(w.smi); } catch (er) { toast(er.message, true); } };
    $("#fi").onchange = e => e.target.files[0] && upl(e.target.files[0]);
    const sm = $("#smp"); if (sm) sm.onclick = () => upl(new File([CC_DEMO_SAMPLES.smi(w.parsed.servers)], "smi_example.csv"));
    if (w.smi) show(w.smi);
  } else {
    tp.innerHTML = `<div class="info warn"><b>Состояние карт неизвестно</b><br>К рыночной стоимости применяется поправка 7 %, наблюдать за залогом после выдачи кредита будет нельзя.</div>`;
    nbar(`<button class="btn primary" id="next">Далее</button>`); $("#next").onclick = goNext;
  }
}
const agoShort = ts => { const m = Math.round((Date.now() / 1000 - ts) / 60); return m < 1 ? "только что" : m < 60 ? m + " мин назад" : Math.round(m / 60) + " ч назад"; };
function gpuTable(S) {
  const rows = S.flatMap(s => s.gpus.filter(g => g.temp != null).map(g => ({ s: s.name, g }))).slice(0, 5);
  const total = S.reduce((a, s) => a + s.gpus.filter(g => g.temp != null).length, 0);
  return `<div class="card tblwrap"><table class="tbl"><thead><tr><th>Сервер</th><th>Карта</th><th>Серийный номер</th><th class="r">Температура</th><th class="r">Загрузка</th><th class="r">Наработка</th></tr></thead><tbody>${rows.map(r => `<tr><td><b>${esc(r.s)}</b></td><td>GPU ${r.g.idx}</td><td class="num">${esc(r.g.actual || r.g.serial)}</td><td class="r num">${r.g.temp} °C</td><td class="r num">${int(r.g.util)} %</td><td class="r num">${int(r.g.hours)} ч</td></tr>`).join("")}</tbody></table>${total > 5 ? `<div class="muted" style="padding:6px 24px 20px">Ещё ${total - 5} ${plural(total - 5, "карта", "карты", "карт")}</div>` : ""}</div>`;
}

/* ---- N09, N10 ---- */
function wizStep4() {
  const w = WIZ, l = w.loan, p = w.parsed;
  render("new", `${wizHead()}<div class="card" style="padding:36px 44px" id="lf"><div class="grid3">
   <div class="fld"><label>Сумма кредита, ₽</label><input class="inp" name="amount" inputmode="numeric" value="${l.amount}"></div>
   <div class="fld"><label>Срок, месяцев</label><input class="inp" name="term" inputmode="numeric" value="${l.term}"></div>
   <div class="fld"><label>Ставка, % годовых</label><input class="inp" name="rate" inputmode="decimal" value="${l.rate}"></div>
   <div class="fld"><label>График погашения</label><select class="inp" name="schedule"><option value="annuity" ${l.schedule === "annuity" ? "selected" : ""}>Аннуитетный</option><option value="differentiated" ${l.schedule === "differentiated" ? "selected" : ""}>Дифференцированный</option></select></div>
   <div class="fld"><label>Дата выдачи</label><input class="inp" name="issue_date" type="date" min="${new Date().toISOString().slice(0, 10)}" value="${l.issue_date}"></div>
   <div class="fld"><label>Ковенант покрытия</label><input class="inp" name="covenant" inputmode="decimal" value="${l.covenant}"></div></div></div>
  <div class="summary"><div><div class="l">Оборудование</div><div class="v">${p.cards} × ${esc(p.servers[0].model)}</div></div><div><div class="l">Где стоит</div><div class="v">${esc(w.form.location) || "—"}</div></div>
  <div><div class="l">Телеметрия</div><div class="v">${{ agent: "Агент на серверах", file: "Файл nvidia-smi", none: "Без телеметрии" }[w.mode]}</div></div><div><div class="l">Серийные номера</div><div class="v">${w.mode === "none" ? "не проверяются" : "сверяются с перечнем"}</div></div></div>
  <div class="foot"><button class="btn" id="back">Назад</button><button class="btn primary" id="go">Рассчитать оценку</button></div>`);
  const f = $("#lf"), num = v => parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  const rules = { amount: [1e6, 5e8, "Введите сумму от 1 до 500 млн ₽"], term: [6, 60, "Срок от 6 до 60 месяцев"], rate: [1, 40, "Ставка от 1 до 40 % годовых"], covenant: [1, 2, "Ковенант от 1,00 до 2,00"] };
  const validate = () => {
    const errs = {};
    for (const [k, [lo, hi, msg]] of Object.entries(rules)) { const v = num($(`[name="${k}"]`, f).value); if (!(v >= lo && v <= hi)) errs[k] = msg; }
    const d = $('[name="issue_date"]', f).value; if (!d) errs.issue_date = "Укажите дату выдачи"; else if (d < new Date().toISOString().slice(0, 10)) errs.issue_date = "Дата не может быть раньше сегодняшней";
    return errs;
  };
  const paint = () => { const errs = validate(); fieldErrors(f, errs); $("#go").disabled = !!Object.keys(errs).length; return errs; };
  f.addEventListener("input", () => { Object.assign(l, { amount: num($('[name="amount"]', f).value), term: num($('[name="term"]', f).value), rate: num($('[name="rate"]', f).value), schedule: $('[name="schedule"]', f).value, issue_date: $('[name="issue_date"]', f).value, covenant: num($('[name="covenant"]', f).value) }); paint(); });
  paint();
  $("#back").onclick = () => { w.step = 3; wizRender(); };
  $("#go").onclick = async () => {
    if (Object.keys(paint()).length) return;
    $("#go").disabled = true;
    try { await api(`/deals/${w.draft.id}/loan`, { body: l }); w.step = 5; wizRender(); }
    catch (e) { $("#go").disabled = false; if (e.data && e.data.fields) fieldErrors(f, e.data.fields); else toast(e.message, true); }
  };
}

/* ---- N11: расчёт ---- */
function wizCalc() {
  const w = WIZ, id = w.draft.id;
  render("new", `<h1>Новая оценка</h1><div class="sub" style="font-size:18px">${esc(w.form.name)}, ИНН ${esc(w.form.inn)}</div><div class="steps">${STEPS.map((n, i) => `${i ? '<span class="ln"></span>' : ""}<div class="step done"><span class="c">${ICON.check}</span>${n}</div>`).join("")}</div>
  <div class="card calc" id="cc"><h2 style="font-size:22px">Считаем оценку</h2><p class="muted" style="margin:6px 0 0">Обычно до минуты. Можно уйти со страницы, придёт уведомление</p><div class="pb"><i style="width:3%"></i></div><ul id="cs"></ul></div>`);
  let fails = 0;
  const tick = async () => {
    if (!$("#cc")) return;
    try {
      const c = await api(`/deals/${id}/calc`);
      $(".pb i").style.width = Math.max(3, (c.done ? 1 : c.progress || 0) * 100) + "%";
      $("#cs").innerHTML = c.steps.map((t, i) => `<li class="${i < c.step || c.done ? "done" : i === c.step ? "cur" : ""}">${i < c.step || c.done ? '<span class="ok-t">' + ICON.check + "</span>" : i === c.step ? '<span class="spin"></span>' : '<span class="pt"></span>'}${esc(t)}</li>`).join("");
      if (c.done) { clearInterval(POLL); toast("Оценка готова"); const did = id; WIZ = null; lsSet(formKey(), "{}"); setTimeout(() => location.hash = "#/deal/" + did, 600); }
    } catch (e) { if (++fails >= 3) { clearInterval(POLL); setMain(`<div class="card calc"><h2>Не удалось рассчитать</h2><p class="muted">Данные шагов сохранены.</p><button class="btn primary" id="rt">Повторить</button></div>`); $("#rt").onclick = () => { w.step = 4; wizRender(); }; } }
  };
  tick(); POLL = setInterval(tick, 700);
}

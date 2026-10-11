/* Вход V01–V04, восстановление пароля */
"use strict";
const authShell = inner => { $app.innerHTML = `<div class="login"><div class="box"><div class="logo"><i>${ICON.chip}</i><span><b>Compute</b><span>Collateral</span></span></div><div class="card">${inner}</div></div></div>`; };
const BANK_RE = /^[^@\s]+@bank\.ru$/i;
const DEMO_USERS = [["e.sokolova@bank.ru", "Аналитик"], ["a.kim@bank.ru", "Риски"], ["m.orlova@bank.ru", "Залоговая служба"], ["leasing@bank.ru", "ВТБ Лизинг"]];

function viewLogin(prefill) {
  authShell(`<form id="lf" novalidate><h1>Вход</h1>
    <div class="fld" style="margin-top:30px"><label>Рабочая почта</label><input class="inp" name="email" type="email" value="${esc(prefill || "e.sokolova@bank.ru")}" autocomplete="username"></div>
    <div class="fld"><label>Пароль</label><div class="pw"><input class="inp" name="password" type="password" autocomplete="current-password" ${window.CC_DEMO ? 'value="Compute2026"' : ""}><button type="button" id="eye" title="Показать пароль" aria-label="Показать или скрыть пароль">${ICON.eye}</button></div></div>
    <div style="text-align:right;margin:0 0 22px"><a href="#" id="forgot">Забыли пароль?</a></div>
    <button class="btn primary lg" style="width:100%;justify-content:center" id="go">Войти</button>
    <div class="demo-users" title="Демо-доступ, пароль Compute2026">${DEMO_USERS.map(([e, n]) => `<button type="button" data-e="${e}">${n}</button>`).join("")}</div>
    <p class="muted" style="font-size:12px;margin:10px 0 0">Демо-пароль для всех: Compute2026</p></form>`);
  const f = $("#lf"), setErr = (name, msg) => { const fl = f[name].closest(".fld"); fl.classList.toggle("bad", !!msg); const m = $(".msg", fl); m && m.remove(); if (msg) fl.insertAdjacentHTML("beforeend", `<div class="msg">${esc(msg)}</div>`); };
  $("#eye").onclick = () => { const i = f.password; i.type = i.type === "password" ? "text" : "password"; };
  $("#forgot").onclick = e => { e.preventDefault(); location.hash = "#/forgot?email=" + encodeURIComponent(f.email.value); };
  $$(".demo-users button").forEach(b => b.onclick = () => { f.email.value = b.dataset.e; f.password.value = "Compute2026"; setErr("email", ""); setErr("password", ""); });
  f.email.onblur = () => setErr("email", f.email.value && !BANK_RE.test(f.email.value.trim()) ? "Укажите рабочую почту на домене @bank.ru" : "");
  f.onsubmit = async e => {
    e.preventDefault(); setErr("email", ""); setErr("password", "");
    if (!BANK_RE.test(f.email.value.trim())) return setErr("email", "Укажите рабочую почту на домене @bank.ru");
    if (!f.password.value) return setErr("password", "Введите пароль");
    const b = $("#go"); b.disabled = true; b.textContent = "Входим…";
    try { ME = await api("/login", { body: { email: f.email.value, password: f.password.value } }); const back = RETURN_TO; RETURN_TO = null; location.hash = back && !/login|forgot|reset/.test(back) ? back : "#/portfolio"; route(); }
    catch (er) { b.disabled = false; b.textContent = "Войти"; f.password.value = ""; f.password.focus(); setErr("password", er.status === 0 ? "Нет связи с сервером. Попробуйте ещё раз" : er.message); }
  };
}

function viewForgot(email) {
  authShell(`<form id="ff" novalidate><h1 style="font-size:28px">Восстановление пароля</h1><p class="muted" style="margin:10px 0 24px">Укажите рабочую почту, мы пришлём ссылку для нового пароля.</p>
    <div class="fld"><label>Рабочая почта</label><input class="inp" name="email" type="email" value="${esc(email)}"></div>
    <button class="btn primary" style="width:100%;justify-content:center" id="go">Отправить ссылку</button>
    <p style="text-align:center;margin:18px 0 0"><a href="#/login" id="back">Вернуться ко входу</a></p></form>`);
  const f = $("#ff");
  $("#back").onclick = e => { e.preventDefault(); location.hash = "#/login"; viewLogin(f.email.value); };
  f.onsubmit = async e => {
    e.preventDefault();
    const fl = f.email.closest(".fld"), old = $(".msg", fl); old && old.remove();
    if (!BANK_RE.test(f.email.value.trim())) { fl.classList.add("bad"); fl.insertAdjacentHTML("beforeend", '<div class="msg">Укажите рабочую почту на домене @bank.ru</div>'); return; }
    try { await api("/password-reset", { body: { email: f.email.value } }); } catch (er) { if (er.status === 0) { fl.insertAdjacentHTML("beforeend", '<div class="msg">Нет связи с сервером. Попробуйте ещё раз</div>'); return; } }
    sent(f.email.value);
  };
  function sent(addr) {
    authShell(`<h1 style="font-size:28px">Проверьте почту</h1><p class="muted" style="margin:10px 0 22px">Если адрес ${esc(addr)} зарегистрирован, на него придёт ссылка для нового пароля. Она действует 30 минут.</p>
      <button class="btn" style="width:100%;justify-content:center" id="again" disabled>Отправить ещё раз через 0:60</button><p style="text-align:center;margin:18px 0 0"><a href="#/login" id="back2">Вернуться ко входу</a></p>`);
    let left = 60; const b = $("#again");
    const t = setInterval(() => { left--; if (!$("#again")) return clearInterval(t); if (left <= 0) { clearInterval(t); b.disabled = false; b.textContent = "Отправить ещё раз"; } else b.textContent = `Отправить ещё раз через 0:${String(left).padStart(2, "0")}`; }, 1000);
    b.onclick = async () => { try { await api("/password-reset", { body: { email: addr } }); } catch { } toast("Письмо отправлено повторно"); sent(addr); };
    $("#back2").onclick = e => { e.preventDefault(); location.hash = "#/login"; viewLogin(addr); };
  }
}

function viewReset(token) {
  authShell(`<form id="rf" novalidate><h1 style="font-size:28px">Новый пароль</h1><p class="muted" style="margin:10px 0 24px">Не короче 8 символов.</p>
    <div class="fld"><label>Новый пароль</label><input class="inp" name="p1" type="password" autocomplete="new-password"></div>
    <div class="fld"><label>Повторите пароль</label><input class="inp" name="p2" type="password" autocomplete="new-password"></div>
    <button class="btn primary" style="width:100%;justify-content:center">Сохранить пароль</button></form>`);
  const f = $("#rf");
  f.onsubmit = async e => {
    e.preventDefault(); $$(".msg", f).forEach(m => m.remove());
    const bad = (n, t) => { const fl = f[n].closest(".fld"); fl.classList.add("bad"); fl.insertAdjacentHTML("beforeend", `<div class="msg">${t}</div>`); };
    if (f.p1.value.length < 8) return bad("p1", "Не короче 8 символов");
    if (f.p1.value !== f.p2.value) return bad("p2", "Пароли не совпадают");
    try { await api("/password-reset/confirm", { body: { token, password: f.p1.value } }); toast("Пароль изменён. Войдите с новым паролем"); location.hash = "#/login"; viewLogin(); }
    catch (er) { bad("p1", esc(er.message)); }
  };
}

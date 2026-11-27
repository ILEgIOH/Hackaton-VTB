/* Безопасность и аудит (Спринт 2): состояние защиты, журнал действий с проверкой целостности */
"use strict";
const RES = { denied: "отказ", rejected: "отклонён", blocked: "остановлено" };

async function viewSecurity() {
  const S = await api("/security");
  const yes = (ok, t, f) => `<span class="pill" style="background:${ok ? "var(--teal-bg)" : "var(--amber-bg)"};color:${ok ? "#14505f" : "#7a5410"}">${ok ? t : f}</span>`;
  const row = (title, state, text) => `<div class="card" style="padding:22px 26px"><div class="row-between" style="gap:12px;align-items:flex-start"><b style="font-size:17px">${title}</b>${state}</div><div class="muted" style="margin-top:10px;font-size:14px">${text}</div></div>`;
  const cards = [
    row("Закрытый контур", yes(S.onprem, "Включён", "Демо-режим"),
      S.onprem ? "Нейросеть и почта — только внутри сети банка. Обращения наружу блокируются" : "Для промышленного контура: CC_ONPREM=1 — ИИ и почта только на внутренних адресах"),
    row("Нейросеть", yes(S.ai.internal || S.ai.russian, S.ai.internal ? "В контуре банка" : "Российская", "Внешняя"),
      `${esc(S.ai.base_url)}. ИИ подсказывает, но не меняет оценку и статусы`),
    row("Маскирование данных для ИИ", yes(S.deidentify, "Включено", "Выключено"),
      "Название, ИНН, договор, контакты заёмщика и серийные номера заменяются метками; из вопросов в чате вырезаются почты, телефоны, карты, СНИЛС. В журнал пишется только, что скрыто"),
    row("Подпись пакетов агента", yes(S.signed_only, "Обязательна", "Поддерживается"),
      "HMAC-SHA256, окно ±5 минут, защита от повтора. Ключ агента по сети не передаётся"),
    row("Стоп-лист 115-ФЗ", yes(S.stoplist.loaded > 0, `${S.stoplist.loaded} ИНН`, "Не загружен"),
      `Новая сделка с ИНН из перечня останавливается до проверки комплаенса. Файл ${esc(S.stoplist.path)} обновляет банк в контуре`),
    row("Доступ", yes(true, "По ролям", ""),
      `Только домен банка, ${S.lock.fails} ошибки → блокировка на ${S.lock.minutes} мин, сессия ${S.session_min} мин, права проверяются на сервере`),
    row("Плановая переоценка", yes(true, `Каждые ${S.revalue_days} дн.`, ""),
      "590-П: залог переоценивается автоматически не реже раза в квартал, прежняя оценка сохраняется в документах"),
    row("История телеметрии", yes(true, `${S.telemetry.rows.toLocaleString("ru-RU")} записей`, ""),
      `Хранится ${S.telemetry.retention_days} дней, затем удаляется автоматически`),
    row("Журнал аудита", yes(true, `${S.audit.records.toLocaleString("ru-RU")} записей`, ""),
      "Входы, отказы в доступе, оценки, решения, выгрузки и настройки. Записи связаны цепочкой SHA-256"),
  ];
  render("", `<div class="head"><div><h1>Безопасность и аудит</h1><div class="sub" style="font-size:18px">Как сервис защищает данные банка и заёмщиков</div></div></div>
    <div class="grid3" style="gap:18px;margin-bottom:36px">${cards.join("")}</div>
    <div id="aud"></div>`);
  if (!S.audit.can_view) { $("#aud").innerHTML = `<div class="info">Журнал аудита доступен управлению рисков и залоговой службе</div>`; return; }
  const A = await api("/audit?limit=100");
  $("#aud").innerHTML = `<div class="row-between" style="margin-bottom:16px"><h2 style="margin:0">Журнал аудита <small class="muted" style="font-size:15px;font-weight:400">последние ${A.items.length} из ${A.total}</small></h2>
      <button class="btn" id="vf">Проверить целостность</button></div><div id="vr"></div>
    <div class="card tblwrap"><table class="tbl"><thead><tr><th>Время</th><th>Кто</th><th>Действие</th><th>Объект</th><th>Результат</th><th>IP</th><th>Хэш</th></tr></thead><tbody>
    ${A.items.map(i => `<tr><td class="num">${fdt(i.ts)}</td><td>${esc(i.actor)}</td><td>${esc(i.label)}${Object.keys(i.details || {}).length ? `<div class="sm">${esc(Object.entries(i.details).map(([k, v]) => k + ": " + v).join(", "))}</div>` : ""}</td>
      <td>${i.object ? `<a href="#/deal/${esc(i.object)}">${esc(i.object)}</a>` : ""}</td>
      <td>${i.result === "ok" ? '<span class="s-ok"><i class="dot"></i>ок</span>' : `<span class="s-breach"><i class="dot"></i>${esc(RES[i.result] || i.result)}</span>`}</td>
      <td class="num muted">${esc(i.ip)}</td><td class="num muted" style="font-family:ui-monospace,Menlo,monospace;font-size:13px">${esc(i.hash)}</td></tr>`).join("")}
    </tbody></table></div>`;
  $("#vf").onclick = async e => {
    e.target.disabled = true;
    try {
      const v = await api("/audit/verify", { body: {} });
      $("#vr").innerHTML = v.ok ? `<div class="info"><b>Журнал цел.</b> Проверено записей: ${v.checked}. Последний хэш ${esc(v.head || "")}…</div>`
        : `<div class="info bad"><b>Журнал изменён задним числом!</b> Цепочка нарушена на записи №${v.broken_at}</div>`;
    } catch (er) { toast(er.message, true); }
    e.target.disabled = false;
  };
}

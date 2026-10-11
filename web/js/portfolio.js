/* Портфель P01–P04 и рыночные данные M01–M02 */
"use strict";
const EQ_CLS = { ok: "ok", swap: "breach", offline: "near", nodata: "offline" };

async function viewPortfolio(query) {
  const p = await api("/portfolio"); BADGE = p.pending;
  let tab = ["breach", "near", "ok"].includes(query.get("f")) ? query.get("f") : "all", q = "", sortKey = "coverage", sortDir = 1;
  const COLS = [["borrower", "Заёмщик", false], ["market", "Стоимость залога", true], ["debt", "Остаток долга", true], ["coverage", "Покрытие", true], ["coverage12", "Покрытие через 12 мес.", true], ["equipment", "Оборудование", false], ["status", "Статус", false]];
  const rowsOf = () => p.rows.filter(r => (tab === "all" || r.status === tab) && r.borrower.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => ((a[sortKey] ?? 99) - (b[sortKey] ?? 99)) * sortDir);
  const body = () => {
    const rows = rowsOf();
    return rows.length ? rows.map(r => `<tr class="click" data-id="${r.id}"><td><div class="name">${esc(r.borrower)}</div><div class="sm">${esc(r.title)}</div></td>
      <td class="r num">${mln(r.market)}</td><td class="r num">${mln(r.debt)}</td>
      <td class="num" style="white-space:nowrap"><b>${cov(r.coverage)}</b><span class="bar ${r.status}"><i style="width:${Math.min(100, (r.coverage || 0) / 2.5 * 100)}%"></i></span></td>
      <td class="r num ${r.coverage12 != null && r.coverage12 < 1 ? "red" : ""}">${cov(r.coverage12)}</td>
      <td>${sdot(EQ_CLS[r.equipment_code] || "ok", r.equipment)}</td><td>${sdot(r.status, STATUS[r.status])}</td></tr>`).join("")
      : `<tr><td colspan="7"><div class="center-msg" style="padding:50px"><h2 style="font-size:18px">Нет сделок по запросу</h2><button class="btn sm" id="reset">Сбросить</button></div></td></tr>`;
  };
  const head = () => COLS.map(([k, t, sortable]) => `<th class="${sortable && k !== "borrower" ? (k === "coverage" ? "" : "r") : ""}" ${sortable ? `data-s="${k}" style="cursor:pointer"` : ""}>${t}${sortKey === k ? (sortDir > 0 ? " ↑" : " ↓") : ""}</th>`).join("");
  if (!p.rows.length) {
    return render("portfolio", `<div class="head"><h1>Портфель залогов</h1></div><div class="card center-msg" style="padding:110px 20px"><h2>Здесь появятся сделки под залог GPU</h2><p>Загрузите список оборудования заёмщика, и сервис оценит залог, построит прогноз и предложит LTV</p>${can("create_assessment") ? `<a class="btn primary" href="#/new">${ICON.plus} Новая оценка</a>` : ""}</div>`);
  }
  const att = p.counts.breach + p.counts.near;
  render("portfolio", `<div class="head"><h1>Портфель залогов</h1>${can("create_assessment") ? `<a class="btn primary" href="#/new">${ICON.plus} Новая оценка</a>` : ""}</div>
  ${p.calculating.length ? `<div class="note-ok"><b><span class="spin"></span> Идёт расчёт оценки</b>${p.calculating.map(c => esc(c.borrower)).join(", ")}. Когда всё будет готово, придёт уведомление «Оценка готова».</div>` : ""}
  <section class="hero"><div><div class="l">Стоимость залогов</div><div class="v num">${mln(p.total_value)}</div><div class="s">рыночная, на сегодня</div></div>
  <div><div class="l">Остаток долга</div><div class="v num">${mln(p.total_debt)}</div><div class="s">по ${p.rows.length} ${plural(p.rows.length, "сделке", "сделкам", "сделкам")}</div></div>
  <div><div class="l">Среднее покрытие</div><div class="v num">${cov(p.avg_coverage)}</div><div class="s">ковенант не ниже ${cov(p.thresholds.covenant)}</div></div>
  <div id="attn" style="${att ? "cursor:pointer" : ""}"><div class="l">Требуют внимания</div><div class="v amber" style="color:#f1b95b">${att} ${plural(att, "сделка", "сделки", "сделок")}</div><div class="s">${p.counts.breach} ${plural(p.counts.breach, "нарушение", "нарушения", "нарушений")}, ${p.counts.near} близко к порогу</div></div></section>
  <div class="row-between"><div class="tabs plain" id="tabs" style="margin:0">${[["all", "Все", p.rows.length], ["breach", "Нарушение", p.counts.breach], ["near", "Близко к порогу", p.counts.near], ["ok", "Норма", p.counts.ok]].map(([k, t, n]) => `<button class="tab ${k === tab ? "on" : ""}" data-t="${k}">${t}<small>${n}</small></button>`).join("")}</div>
  <label class="search">${ICON.search.replace("<svg", '<svg width="20" height="20"')}<input id="q" placeholder="Поиск по заёмщику"></label></div>
  <div class="card tblwrap"><table class="tbl"><thead><tr id="th">${head()}</tr></thead><tbody id="tb">${body()}</tbody></table></div>`);
  const redraw = () => { $("#tb").innerHTML = body(); $("#th").innerHTML = head(); bindRows(); };
  const bindRows = () => { const rs = $("#reset"); if (rs) rs.onclick = () => { q = ""; tab = "all"; $("#q").value = ""; $$("#tabs .tab").forEach(x => x.classList.toggle("on", x.dataset.t === "all")); redraw(); }; };
  $("#tabs").onclick = e => { const b = e.target.closest("[data-t]"); if (!b) return; tab = b.dataset.t; $$("#tabs .tab").forEach(x => x.classList.toggle("on", x === b)); redraw(); };
  $("#q").oninput = e => { q = e.target.value; redraw(); };
  $("#th").onclick = e => { const h = e.target.closest("[data-s]"); if (!h) return; if (sortKey === h.dataset.s) sortDir = -sortDir; else { sortKey = h.dataset.s; sortDir = 1; } redraw(); };
  $("#tb").onclick = e => { const tr = e.target.closest("tr[data-id]"); if (tr) location.hash = "#/deal/" + tr.dataset.id; };
  const at = $("#attn"); if (att) at.onclick = () => { tab = p.counts.breach ? "breach" : "near"; $$("#tabs .tab").forEach(x => x.classList.toggle("on", x.dataset.t === tab)); redraw(); };
  bindRows();
}

/* ---------- рыночные данные ---------- */
async function viewMarket() {
  const M = await api("/market"), MAX = 4e6, pc = v => v / MAX * 100;
  let open = null, sortKey = null, sortDir = 1;
  const rowsOf = () => sortKey ? [...M.rows].sort((a, b) => ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)) * sortDir) : M.rows;
  const src = r => { const s = r.sources, w = s.world; return `<div class="src"><b>Откуда цена ${esc(r.model)}</b>${s.dealers.map(d => `<div class="kv"><span>${esc(d.name)}</span><span class="num">${rub(d.price)}</span><span class="muted" style="font-size:13px">прайс от ${dmy(d.price_date)}</span></div>`).join("")}
    <div class="kv"><span>Вторичный рынок США и ЕС</span><span class="num">${int(w.usd).toLocaleString("ru-RU")} $ → ${rub(w.rub)}</span><span class="muted" style="font-size:13px">медиана ${w.deals} сделок, курс ЦБ ${nf(M.cbr_rate, 2)}, наценка ${Math.round(w.markup * 100)} %</span></div></div>`; };
  const draw = () => {
    $("#chart").innerHTML = M.rows.map(r => `<div class="mkblock"><div class="mkrow" data-m="${r.key}" style="cursor:pointer"><div><div class="nm">${esc(r.model)}</div>${r.low_data ? '<div class="warnl"><i class="dot near"></i>Мало данных</div>' : ""}</div>
      <div class="rng"><div class="ax"></div><span class="lb" style="left:${pc(r.low)}%">${nf(r.low / 1e6, 2)}</span><span class="lb" style="left:${pc(r.high)}%">${nf(r.high / 1e6, 2)}</span><div class="sp ${r.low_data ? "dash" : ""}" style="left:${pc(r.low)}%;width:${pc(r.high) - pc(r.low)}%"></div><div class="md" style="left:${pc(r.median)}%"></div><div class="wd" style="left:${pc(r.world)}%"></div></div>
      <div class="muted">${r.low_data ? `Только ${r.dealers} ${plural(r.dealers, "дилер", "дилера", "дилеров")}. Оценка по мировым ценам, точность ±${Math.round(r.accuracy * 100)} %` : `Разница ${r.spread} % между ${r.dealers} дилерами`}</div></div>${open === r.key ? src(r) : ""}</div>`).join("");
    $("#mt").innerHTML = rowsOf().map(r => `<tr><td><b style="font-size:18px">${esc(r.model)}</b></td><td class="r num">${rub(r.median)}</td><td class="r num">${rub(r.world)}</td><td class="r num">${rub(r.rent)}</td><td class="r num">${Math.round(r.markup * 100)} %</td><td class="r num">${r.dealers}</td><td class="r num ${r.low_data ? "amber" : ""}"><b>±${Math.round(r.accuracy * 100)} %</b></td></tr>`).join("");
    $$("#mh th[data-s]").forEach(th => th.textContent = th.dataset.t + (sortKey === th.dataset.s ? (sortDir > 0 ? " ↑" : " ↓") : ""));
  };
  render("market", `<h1>Рыночные данные</h1><div class="sub" style="font-size:18px;margin-bottom:34px">Цена одной карты с долей серверной платформы. Курс ЦБ ${nf(M.cbr_rate, 2)} ₽ за доллар, обновлено <span class="${M.stale ? "amber" : ""}" style="${M.stale ? "background:var(--amber-bg);padding:1px 8px;border-radius:6px" : ""}">${dmy(M.updated)}${M.stale ? " (данные старше 3 дней)" : ""}</span></div>
  <div class="card mk"><div class="row-between"><h2>Цены российских дилеров, млн ₽</h2><div class="lg"><span><i style="width:30px;height:10px;border-radius:9px;background:#bddbe3"></i>Разброс</span><span><i style="width:14px;height:14px;border-radius:50%;background:var(--teal)"></i>Медиана</span><span><i style="width:10px;height:10px;border:2px solid var(--navy);transform:rotate(45deg)"></i>Мировая цена с наценкой</span></div></div><div id="chart"></div></div>
  <div class="card tblwrap"><table class="tbl"><thead><tr id="mh"><th>Модель</th>${[["median", "Медиана дилеров"], ["world", "Мировая цена"], ["rent", "Аренда за час"], ["markup", "Наценка импорта"], ["dealers", "Дилеров"], ["accuracy", "Точность"]].map(([k, t]) => `<th class="r" data-s="${k}" data-t="${t}" style="cursor:pointer">${t}</th>`).join("")}</tr></thead><tbody id="mt"></tbody></table></div>`);
  draw();
  $("#chart").onclick = e => { const r = e.target.closest("[data-m]"); if (!r) return; open = open === r.dataset.m ? null : r.dataset.m; draw(); };
  $("#mh").onclick = e => { const h = e.target.closest("[data-s]"); if (!h) return; if (sortKey === h.dataset.s) sortDir = -sortDir; else { sortKey = h.dataset.s; sortDir = 1; } draw(); };
}

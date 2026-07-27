/* Interactive layer for the one-off ad group impact dashboard.
   DATA is injected by render.py; see build.py for its shape. */
(function () {
"use strict";

const DATES = DATA.dates;
const N = DATES.length;
const SERIES = DATA.series;
const CAMPS = DATA.campaigns;
const EVENTS = DATA.events;
const META = DATA.meta;

const DATE_IDX = Object.create(null);
DATES.forEach((d, i) => { DATE_IDX[d] = i; });

const C = {
  spend: "#6d72f6", roas: "#2bc9a0", icr: "#f0a13d", share: "#a371f7",
  event: "#f0616f", grid: "rgba(255,255,255,0.07)", text: "rgba(255,255,255,0.72)",
};

const state = {
  app: "all",
  from: 0,
  to: N - 1,
  smooth: 7,
  window: META.default_window || 7,
  selected: new Set(CAMPS.map(c => c.id)),
  focus: "__all__",
  miniMetric: "roas",
  scatterMode: "level",
  impactSort: { key: "roas_delta", dir: -1 },
};

/* ------------------------------------------------------------------ format */

const nf = new Intl.NumberFormat("ru-RU");
const fmtMoney = v => (v == null || !isFinite(v)) ? "—" : "$" + nf.format(Math.round(v));
const fmtMoney2 = v => (v == null || !isFinite(v)) ? "—" : "$" + v.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
const fmtInt = v => (v == null || !isFinite(v)) ? "—" : nf.format(Math.round(v));
const fmtPct = (v, d) => (v == null || !isFinite(v)) ? "—" : (v * 100).toFixed(d == null ? 2 : d) + "%";
const fmtPP = v => (v == null || !isFinite(v)) ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + " pp";
const fmtDeltaPct = v => (v == null || !isFinite(v)) ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(0) + "%";
const signClass = v => (v == null || !isFinite(v)) ? "dim" : (v > 0 ? "pos" : (v < 0 ? "neg" : "dim"));

/* -------------------------------------------------------------- data utils */

function activeCampaigns() {
  return CAMPS.filter(c => state.selected.has(c.id) && (state.app === "all" || c.app === state.app));
}

function appCampaigns() {
  return CAMPS.filter(c => state.app === "all" || c.app === state.app);
}

/** Expand a campaign's compact array onto the full date axis. */
function expand(cid, key) {
  const out = new Float64Array(N);
  const s = SERIES[cid];
  if (!s) return out;
  const arr = s[key], start = s.start;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v != null) out[start + i] = v;
  }
  return out;
}

const _cache = new Map();
function campaignArrays(cid) {
  if (!_cache.has(cid)) {
    _cache.set(cid, {
      spend: expand(cid, "spend"),
      installs: expand(cid, "installs"),
      impressions: expand(cid, "impressions"),
      revenue: expand(cid, "revenue_d1"),
      gadsSpend: expand(cid, "gads_spend"),
      gadsTestSpend: expand(cid, "gads_test_spend"),
    });
  }
  return _cache.get(cid);
}

const SUM_KEYS = ["spend", "installs", "impressions", "revenue", "gadsSpend", "gadsTestSpend"];

function sumArrays(cids) {
  const acc = {};
  SUM_KEYS.forEach(k => { acc[k] = new Float64Array(N); });
  for (const cid of cids) {
    const a = campaignArrays(cid);
    for (let i = 0; i < N; i++) {
      for (const k of SUM_KEYS) acc[k][i] += a[k][i];
    }
  }
  return acc;
}

/** Trailing-window ratio: sum(num)/sum(den) — far steadier than averaging daily ratios. */
function ratioRolling(num, den, w) {
  const out = new Array(N).fill(null);
  let sn = 0, sd = 0;
  for (let i = 0; i < N; i++) {
    sn += num[i]; sd += den[i];
    if (i >= w) { sn -= num[i - w]; sd -= den[i - w]; }
    if (i >= w - 1 && sd > 0) out[i] = sn / sd;
  }
  return out;
}

function meanRolling(arr, w) {
  const out = new Array(N).fill(null);
  let s = 0;
  for (let i = 0; i < N; i++) {
    s += arr[i];
    if (i >= w) s -= arr[i - w];
    if (i >= w - 1) out[i] = s / w;
  }
  return out;
}

function slice(arr) { return Array.prototype.slice.call(arr, state.from, state.to + 1); }
function sliceDates() { return DATES.slice(state.from, state.to + 1); }

function eventsFor(cids) {
  const set = cids instanceof Set ? cids : new Set(cids);
  return EVENTS.filter(e => set.has(e.campaign_id) && DATE_IDX[e.date] >= state.from && DATE_IDX[e.date] <= state.to);
}

function eventsByDate(cids) {
  const map = new Map();
  for (const e of eventsFor(cids)) {
    const item = map.get(e.date) || { date: e.date, n: 0, names: [] };
    item.n += e.n;
    item.names.push(e.names);
    map.set(e.date, item);
  }
  return map;
}

function weekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : null;
}

/* ----------------------------------------------------------------- charts */

const charts = {};
function chart(id) {
  if (!charts[id]) {
    charts[id] = echarts.init(document.getElementById(id), null, { renderer: "canvas" });
  }
  return charts[id];
}
window.addEventListener("resize", () => {
  Object.values(charts).forEach(c => c.resize());
  Object.values(miniCharts).forEach(c => c.resize());
});

const axisCommon = {
  axisLine: { lineStyle: { color: C.grid } },
  axisTick: { show: false },
  axisLabel: { color: C.text, fontSize: 11 },
  splitLine: { lineStyle: { color: C.grid } },
};

function markLineData(dates) {
  return dates.map(d => ({ xAxis: d }));
}

function renderMain() {
  const cids = state.focus === "__all__" ? activeCampaigns().map(c => c.id) : [state.focus];
  const acc = sumArrays(cids);
  const w = state.smooth;
  const spend = w > 1 ? meanRolling(acc.spend, w) : Array.from(acc.spend);
  const roas = ratioRolling(acc.revenue, acc.spend, w);
  const icr = ratioRolling(acc.installs, acc.impressions, w);
  const share = ratioRolling(acc.gadsTestSpend, acc.gadsSpend, w);
  const dates = sliceDates();
  const evMap = eventsByDate(cids);
  const evDates = Array.from(evMap.keys()).filter(d => DATE_IDX[d] >= state.from && DATE_IDX[d] <= state.to);

  chart("chartMain").setOption({
    backgroundColor: "transparent",
    animation: false,
    grid: { left: 62, right: 62, top: 34, bottom: 46 },
    legend: { top: 0, textStyle: { color: C.text }, itemWidth: 14, itemHeight: 8 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#1c1e21",
      borderColor: "#2a2d31",
      textStyle: { color: "#f0f2f5", fontSize: 12 },
      formatter(params) {
        const d = params[0].axisValue;
        let html = "<b>" + d + "</b>";
        for (const p of params) {
          if (p.seriesName === "Запуск тестов") continue;
          const v = p.value == null ? "—"
            : (p.seriesName === "Спенд" ? fmtMoney2(p.value) : (p.value).toFixed(2) + "%");
          html += "<br>" + p.marker + p.seriesName + ": <b>" + v + "</b>";
        }
        const ev = evMap.get(d);
        if (ev) {
          html += '<br><span style="color:' + C.event + '">▲ запущено тестовых адгрупп: <b>' + ev.n + "</b></span>";
          html += '<br><span style="color:#8b939c;font-size:11px">' + ev.names.join("<br>").replace(/ \| /g, "<br>") + "</span>";
        }
        return html;
      },
    },
    xAxis: Object.assign({ type: "category", data: dates, boundaryGap: true }, axisCommon, { splitLine: { show: false } }),
    yAxis: [
      Object.assign({ type: "value", name: "спенд", nameTextStyle: { color: C.text, fontSize: 11 },
        axisLabel: { color: C.text, fontSize: 11, formatter: v => "$" + nf.format(v) } }, axisCommon),
      Object.assign({ type: "value", name: "%", nameTextStyle: { color: C.text, fontSize: 11 },
        axisLabel: { color: C.text, fontSize: 11, formatter: v => v.toFixed(1) + "%" },
        splitLine: { show: false } }, axisCommon),
    ],
    dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 10, borderColor: "#2a2d31",
      backgroundColor: "#1c1e21", fillerColor: "rgba(109,114,246,0.18)", textStyle: { color: C.text, fontSize: 10 } }],
    series: [
      {
        name: "Спенд", type: "bar", yAxisIndex: 0, data: slice(spend),
        itemStyle: { color: "rgba(109,114,246,0.42)" }, barMaxWidth: 14,
        markLine: {
          silent: true, symbol: "none",
          lineStyle: { color: "rgba(240,97,111,0.45)", type: "solid", width: 1 },
          label: { show: false },
          data: markLineData(evDates),
        },
      },
      { name: "ROAS D1", type: "line", yAxisIndex: 1, smooth: true, showSymbol: false,
        data: slice(roas).map(v => v == null ? null : v * 100),
        lineStyle: { color: C.roas, width: 2 }, itemStyle: { color: C.roas }, connectNulls: false },
      { name: "ICR", type: "line", yAxisIndex: 1, smooth: true, showSymbol: false,
        data: slice(icr).map(v => v == null ? null : v * 100),
        lineStyle: { color: C.icr, width: 2 }, itemStyle: { color: C.icr }, connectNulls: false },
      { name: "Доля тестов в спенде", type: "line", yAxisIndex: 1, smooth: true, showSymbol: false,
        data: slice(share).map(v => v == null ? null : v * 100),
        lineStyle: { color: C.share, width: 1.6, type: "dashed" }, itemStyle: { color: C.share }, connectNulls: false },
      {
        name: "Запуск тестов", type: "scatter", yAxisIndex: 1,
        data: evDates.map(d => ({ value: [d, 0], n: evMap.get(d).n })),
        symbol: "triangle", symbolSize: p => Math.min(20, 7 + 2.5 * (evMap.get(p[0]) || { n: 1 }).n),
        itemStyle: { color: C.event }, tooltip: { show: false }, z: 5,
      },
    ],
  }, true);
}

const miniCharts = {};
function renderSmallMultiples() {
  const host = document.getElementById("smallMultiples");
  const camps = activeCampaigns().slice(0, 24);
  host.innerHTML = "";
  if (!camps.length) { host.innerHTML = '<div class="empty">Кампании не выбраны</div>'; return; }
  Object.keys(miniCharts).forEach(k => { miniCharts[k].dispose(); delete miniCharts[k]; });

  const dates = sliceDates();
  const w = state.smooth;
  for (const c of camps) {
    const box = document.createElement("div");
    box.className = "mini";
    box.innerHTML = '<div class="t" title="' + escapeAttr(c.name) + '">' + escapeHtml(c.name) + "</div>";
    const cv = document.createElement("div");
    cv.className = "c";
    box.appendChild(cv);
    host.appendChild(box);

    const a = campaignArrays(c.id);
    const metric = state.miniMetric === "roas"
      ? ratioRolling(a.revenue, a.spend, w)
      : ratioRolling(a.installs, a.impressions, w);
    const color = state.miniMetric === "roas" ? C.roas : C.icr;
    const evDates = eventsFor([c.id]).map(e => e.date);

    const inst = echarts.init(cv, null, { renderer: "canvas" });
    inst.setOption({
      backgroundColor: "transparent", animation: false,
      grid: { left: 44, right: 40, top: 12, bottom: 22 },
      tooltip: { trigger: "axis", backgroundColor: "#1c1e21", borderColor: "#2a2d31",
        textStyle: { color: "#f0f2f5", fontSize: 11 },
        formatter(params) {
          let html = "<b>" + params[0].axisValue + "</b>";
          for (const p of params) {
            html += "<br>" + p.marker + p.seriesName + ": <b>" +
              (p.value == null ? "—" : (p.seriesName === "Спенд" ? fmtMoney2(p.value) : p.value.toFixed(2) + "%")) + "</b>";
          }
          return html;
        } },
      xAxis: Object.assign({ type: "category", data: dates }, axisCommon,
        { splitLine: { show: false }, axisLabel: { color: C.text, fontSize: 9, interval: Math.ceil(dates.length / 5) } }),
      yAxis: [
        Object.assign({ type: "value" }, axisCommon,
          { axisLabel: { color: C.text, fontSize: 9, formatter: v => "$" + (v >= 1000 ? (v / 1000).toFixed(0) + "k" : v.toFixed(0)) } }),
        Object.assign({ type: "value" }, axisCommon,
          { splitLine: { show: false }, axisLabel: { color: C.text, fontSize: 9, formatter: v => v.toFixed(1) + "%" } }),
      ],
      series: [
        { name: "Спенд", type: "bar", data: slice(a.spend), itemStyle: { color: "rgba(109,114,246,0.35)" }, barMaxWidth: 6,
          markLine: { silent: true, symbol: "none", label: { show: false },
            lineStyle: { color: "rgba(240,97,111,0.5)", width: 1 }, data: markLineData(evDates) } },
        { name: state.miniMetric === "roas" ? "ROAS D1" : "ICR", type: "line", yAxisIndex: 1, showSymbol: false, smooth: true,
          data: slice(metric).map(v => v == null ? null : v * 100), lineStyle: { color: color, width: 1.8 }, itemStyle: { color: color } },
      ],
    }, true);
    miniCharts[c.id] = inst;
  }
}

/* ----------------------------------------------------------------- impact */

function windowStats(a, lo, hi) {
  lo = Math.max(lo, 0); hi = Math.min(hi, N - 1);
  if (lo > hi) return null;
  let spend = 0, rev = 0, inst = 0, impr = 0, gads = 0, gadsTest = 0;
  for (let i = lo; i <= hi; i++) {
    spend += a.spend[i]; rev += a.revenue[i]; inst += a.installs[i]; impr += a.impressions[i];
    gads += a.gadsSpend[i]; gadsTest += a.gadsTestSpend[i];
  }
  const days = hi - lo + 1;
  return {
    days: days,
    spend: spend / days,
    roas: spend > 0 ? rev / spend : null,
    icr: impr > 0 ? inst / impr : null,
    share: gads > 0 ? gadsTest / gads : null,
  };
}

function computeImpact() {
  const w = state.window;
  const names = Object.create(null);
  CAMPS.forEach(c => { names[c.id] = c.name; });
  const rows = [];
  for (const ev of EVENTS) {
    if (!state.selected.has(ev.campaign_id)) continue;
    const camp = CAMPS.find(c => c.id === ev.campaign_id);
    if (!camp || (state.app !== "all" && camp.app !== state.app)) continue;
    const idx = DATE_IDX[ev.date];
    if (idx == null || idx < state.from || idx > state.to) continue;
    const a = campaignArrays(ev.campaign_id);
    const before = windowStats(a, idx - w, idx - 1);
    const after = windowStats(a, idx, idx + w - 1);
    if (!before || !after) continue;
    rows.push({
      campaign: names[ev.campaign_id] || ev.campaign_id,
      campaign_id: ev.campaign_id,
      app: camp.app,
      date: ev.date,
      n: ev.n,
      adgroups: ev.names,
      spend_before: before.spend, spend_after: after.spend,
      spend_delta_pct: before.spend > 0 ? (after.spend - before.spend) / before.spend : null,
      roas_before: before.roas, roas_after: after.roas,
      roas_delta: (before.roas != null && after.roas != null) ? after.roas - before.roas : null,
      icr_before: before.icr, icr_after: after.icr,
      icr_delta: (before.icr != null && after.icr != null) ? after.icr - before.icr : null,
      share_before: before.share, share_after: after.share,
    });
  }
  return rows;
}

function renderImpact(rows) {
  const withRoas = rows.filter(r => r.roas_delta != null);
  const sorted = withRoas.slice().sort((a, b) => b.roas_delta - a.roas_delta);
  const top = sorted.slice(0, 20).concat(sorted.slice(-20)).filter((v, i, arr) => arr.indexOf(v) === i);
  top.sort((a, b) => b.roas_delta - a.roas_delta);

  const pos = withRoas.filter(r => r.roas_delta > 0).length;
  const med = withRoas.length ? median(withRoas.map(r => r.roas_delta)) : null;
  const medIcr = rows.filter(r => r.icr_delta != null).length ? median(rows.filter(r => r.icr_delta != null).map(r => r.icr_delta)) : null;
  document.getElementById("impactSummary").innerHTML =
    withRoas.length
      ? "Запусков в выборке: <b>" + rows.length + "</b> · с базой для сравнения: <b>" + withRoas.length +
        "</b> · ROAS D1 вырос в <b>" + pos + "</b> из " + withRoas.length + " (" + (100 * pos / withRoas.length).toFixed(0) +
        "%) · медиана Δ ROAS D1 <b>" + fmtPP(med) + "</b> · медиана Δ ICR <b>" + fmtPP(medIcr) + "</b>" +
        " · окно ±" + state.window + "д"
      : "Ни одного запуска с достаточной историей в выбранном периоде.";

  chart("chartImpact").setOption({
    backgroundColor: "transparent", animation: false,
    grid: { left: 62, right: 24, top: 14, bottom: 96 },
    tooltip: {
      trigger: "item", backgroundColor: "#1c1e21", borderColor: "#2a2d31", textStyle: { color: "#f0f2f5", fontSize: 12 },
      formatter(p) {
        const r = top[p.dataIndex];
        return "<b>" + escapeHtml(r.campaign) + "</b><br>" + r.date + " · " + r.n + " тестовых адгрупп" +
          "<br>ROAS D1: " + fmtPct(r.roas_before) + " → " + fmtPct(r.roas_after) + " (<b>" + fmtPP(r.roas_delta) + "</b>)" +
          "<br>ICR: " + fmtPct(r.icr_before) + " → " + fmtPct(r.icr_after) +
          "<br>Спенд/день: " + fmtMoney(r.spend_before) + " → " + fmtMoney(r.spend_after) +
          "<br>Доля тестов в спенде: " + fmtPct(r.share_before, 1) + " → " + fmtPct(r.share_after, 1) +
          '<br><span style="color:#8b939c;font-size:11px">' + escapeHtml(r.adgroups).replace(/ \| /g, "<br>") + "</span>";
      },
    },
    xAxis: Object.assign({ type: "category", data: top.map(r => shortName(r.campaign) + " " + r.date.slice(5)) },
      axisCommon, { splitLine: { show: false }, axisLabel: { color: C.text, fontSize: 10, rotate: 55, interval: 0 } }),
    yAxis: Object.assign({ type: "value", name: "Δ ROAS D1, pp", nameTextStyle: { color: C.text, fontSize: 11 },
      axisLabel: { color: C.text, fontSize: 11, formatter: v => v.toFixed(1) } }, axisCommon),
    series: [{
      type: "bar", data: top.map(r => ({ value: r.roas_delta * 100, itemStyle: { color: r.roas_delta >= 0 ? C.roas : C.event } })),
      barMaxWidth: 22,
    }],
  }, true);

  renderImpactTable(rows);
}

const IMPACT_COLS = [
  { key: "campaign", label: "Кампания", cls: "l", fmt: v => escapeHtml(v) },
  { key: "date", label: "Запуск", cls: "l", fmt: v => v },
  { key: "n", label: "Тестов", fmt: fmtInt },
  { key: "adgroups", label: "Адгруппы", cls: "l", fmt: v => '<span class="dim">' + escapeHtml(v) + "</span>" },
  { key: "spend_before", label: "Спенд до", fmt: fmtMoney },
  { key: "spend_after", label: "Спенд после", fmt: fmtMoney },
  { key: "spend_delta_pct", label: "Δ спенд", fmt: fmtDeltaPct, sign: true },
  { key: "roas_before", label: "ROAS D1 до", fmt: v => fmtPct(v) },
  { key: "roas_after", label: "ROAS D1 после", fmt: v => fmtPct(v) },
  { key: "roas_delta", label: "Δ ROAS D1", fmt: fmtPP, sign: true },
  { key: "icr_before", label: "ICR до", fmt: v => fmtPct(v) },
  { key: "icr_after", label: "ICR после", fmt: v => fmtPct(v) },
  { key: "icr_delta", label: "Δ ICR", fmt: fmtPP, sign: true },
  { key: "share_before", label: "Доля тестов до", fmt: v => fmtPct(v, 1) },
  { key: "share_after", label: "Доля тестов после", fmt: v => fmtPct(v, 1) },
];

let impactRows = [];
function renderImpactTable(rows) {
  impactRows = rows;
  const { key, dir } = state.impactSort;
  const sorted = rows.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x > y ? 1 : x < y ? -1 : 0) * dir;
  });
  let html = "<thead><tr>";
  for (const c of IMPACT_COLS) {
    const arrow = key === c.key ? (dir === 1 ? " ▲" : " ▼") : "";
    html += '<th class="' + (c.cls || "") + '" data-key="' + c.key + '">' + c.label + arrow + "</th>";
  }
  html += "</tr></thead><tbody>";
  for (const r of sorted) {
    html += "<tr>";
    for (const c of IMPACT_COLS) {
      const cls = (c.cls || "") + (c.sign ? " " + signClass(r[c.key]) : "");
      html += '<td class="' + cls.trim() + '">' + c.fmt(r[c.key]) + "</td>";
    }
    html += "</tr>";
  }
  html += "</tbody>";
  const table = document.getElementById("impactTable");
  table.innerHTML = html;
  table.querySelectorAll("th").forEach(th => {
    th.onclick = () => {
      const k = th.dataset.key;
      state.impactSort = { key: k, dir: state.impactSort.key === k ? -state.impactSort.dir : -1 };
      renderImpactTable(impactRows);
    };
  });
}

function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/* --------------------------------------------------------- weekly heatmap */

function weeklyByCampaign(cids) {
  const weeks = [];
  const weekIdx = Object.create(null);
  for (let i = state.from; i <= state.to; i++) {
    const wk = weekStart(DATES[i]);
    if (weekIdx[wk] == null) { weekIdx[wk] = weeks.length; weeks.push(wk); }
  }
  const evCount = Object.create(null);
  for (const e of EVENTS) {
    const i = DATE_IDX[e.date];
    if (i == null || i < state.from || i > state.to) continue;
    const k = e.campaign_id + "|" + weekStart(e.date);
    evCount[k] = (evCount[k] || 0) + e.n;
  }
  const out = [];
  for (const cid of cids) {
    const a = campaignArrays(cid);
    const rows = weeks.map(() => ({ spend: 0, rev: 0, inst: 0, impr: 0, tests: 0 }));
    for (let i = state.from; i <= state.to; i++) {
      const w = rows[weekIdx[weekStart(DATES[i])]];
      w.spend += a.spend[i]; w.rev += a.revenue[i]; w.inst += a.installs[i]; w.impr += a.impressions[i];
    }
    weeks.forEach((wk, j) => { rows[j].tests = evCount[cid + "|" + wk] || 0; });
    out.push({ cid: cid, weeks: rows });
  }
  return { weeks: weeks, data: out };
}

function renderHeatmap() {
  const camps = activeCampaigns().slice(0, 20);
  const el = chart("chartHeat");
  if (!camps.length) { el.clear(); return; }
  const { weeks, data } = weeklyByCampaign(camps.map(c => c.id));
  const names = camps.map(c => shortName(c.name, 34));

  const cells = [], marks = [], values = [];
  data.forEach((row, y) => {
    row.weeks.forEach((w, x) => {
      if (w.spend <= 0) return;
      const roas = w.rev / w.spend;
      values.push(roas);
      cells.push({ value: [x, y, roas * 100], spend: w.spend, tests: w.tests });
      if (w.tests > 0) marks.push([x, y, w.tests]);
    });
  });
  values.sort((a, b) => a - b);
  const lo = values.length ? values[Math.floor(values.length * 0.05)] * 100 : 0;
  const hi = values.length ? values[Math.floor(values.length * 0.95)] * 100 : 1;

  document.getElementById("chartHeat").style.height = Math.max(300, 120 + camps.length * 26) + "px";
  el.resize();
  el.setOption({
    backgroundColor: "transparent", animation: false,
    grid: { left: 250, right: 30, top: 52, bottom: 78 },
    tooltip: {
      backgroundColor: "#1c1e21", borderColor: "#2a2d31", textStyle: { color: "#f0f2f5", fontSize: 12 },
      formatter(p) {
        const head = "неделя " + weeks[p.value[0]] + "<br><b>" + escapeHtml(camps[p.value[1]].name) + "</b>";
        if (p.seriesName === "Запуски") {
          return head + '<br><span style="color:' + C.event + '">запущено тестовых адгрупп: <b>' + p.value[2] + "</b></span>";
        }
        return head + "<br>ROAS D1: <b>" + p.value[2].toFixed(2) + "%</b><br>спенд: " + fmtMoney(p.data.spend) +
          (p.data.tests ? '<br><span style="color:' + C.event + '">тестов запущено: ' + p.data.tests + "</span>" : "");
      },
    },
    xAxis: Object.assign({ type: "category", data: weeks }, axisCommon,
      { splitLine: { show: false }, axisLabel: { color: C.text, fontSize: 10, rotate: 55, interval: Math.max(0, Math.ceil(weeks.length / 26) - 1) } }),
    yAxis: Object.assign({ type: "category", data: names }, axisCommon,
      { splitLine: { show: false }, axisLabel: { color: C.text, fontSize: 11 } }),
    visualMap: {
      // The heatmap rows carry extra payload, so pin the colour to the ROAS dimension.
      min: lo, max: hi, dimension: 2, seriesIndex: 0, calculable: true,
      orient: "horizontal", left: "center", top: 6, itemWidth: 12, itemHeight: 130,
      textStyle: { color: C.text, fontSize: 10 }, formatter: v => v.toFixed(2) + "%",
      inRange: { color: ["#20304f", "#3363a8", "#46a8e6", "#2bc9a0", "#8ff0c4"] },
    },
    series: [
      { name: "ROAS D1", type: "heatmap", data: cells, progressive: 0,
        itemStyle: { borderColor: "#0c0d0f", borderWidth: 1 }, emphasis: { itemStyle: { borderColor: "#fff" } } },
      { name: "Запуски", type: "scatter", data: marks, symbol: "diamond",
        symbolSize: v => Math.min(16, 6 + 2 * v[2]), itemStyle: { color: C.event, borderColor: "#0c0d0f", borderWidth: 1 }, z: 6 },
    ],
  }, true);
}

/* --------------------------------------------------------------- scatter */

function renderScatter() {
  const camps = activeCampaigns();
  const el = chart("chartScatter");
  if (!camps.length) { el.clear(); document.getElementById("corrNote").textContent = ""; return; }
  const { weeks, data } = weeklyByCampaign(camps.map(c => c.id));

  const pts = [], xs = [], ys = [];
  data.forEach((row, ci) => {
    row.weeks.forEach((w, j) => {
      if (w.spend <= 0) return;
      const roas = w.rev / w.spend;
      let y = roas;
      if (state.scatterMode === "delta") {
        const prev = row.weeks[j - 1];
        if (!prev || prev.spend <= 0) return;
        y = roas - prev.rev / prev.spend;
      }
      pts.push({ value: [w.tests, y * 100], camp: camps[ci].name, week: weeks[j], spend: w.spend, roas: roas });
      xs.push(w.tests); ys.push(y);
    });
  });

  const r = pearson(xs, ys);
  document.getElementById("corrNote").innerHTML =
    "Точка — кампания×неделя. X — сколько тестовых адгрупп запущено за неделю, Y — " +
    (state.scatterMode === "delta" ? "изменение ROAS D1 к прошлой неделе" : "ROAS D1 недели") +
    ". Наблюдений: <b>" + pts.length + "</b>" +
    (r == null ? "" : " · корреляция Пирсона <b>r = " + r.toFixed(3) + "</b>" +
      (Math.abs(r) < 0.1 ? " — связи практически нет" : Math.abs(r) < 0.3 ? " — слабая связь" : " — заметная связь"));

  el.setOption({
    backgroundColor: "transparent", animation: false,
    grid: { left: 72, right: 30, top: 34, bottom: 54 },
    tooltip: {
      backgroundColor: "#1c1e21", borderColor: "#2a2d31", textStyle: { color: "#f0f2f5", fontSize: 12 },
      formatter(p) {
        const d = p.data;
        return "<b>" + escapeHtml(d.camp) + "</b><br>неделя " + d.week +
          "<br>тестов запущено: <b>" + d.value[0] + "</b>" +
          "<br>" + (state.scatterMode === "delta" ? "Δ ROAS D1: <b>" + d.value[1].toFixed(2) + " pp</b>" : "ROAS D1: <b>" + d.value[1].toFixed(2) + "%</b>") +
          "<br>спенд за неделю: " + fmtMoney(d.spend);
      },
    },
    xAxis: Object.assign({ type: "value", name: "тестовых адгрупп за неделю", nameLocation: "middle", nameGap: 28,
      nameTextStyle: { color: C.text, fontSize: 11 }, minInterval: 1 }, axisCommon),
    yAxis: Object.assign({ type: "value", name: state.scatterMode === "delta" ? "Δ ROAS D1, pp" : "ROAS D1, %",
      nameTextStyle: { color: C.text, fontSize: 11 }, axisLabel: { color: C.text, fontSize: 11, formatter: v => v.toFixed(1) } }, axisCommon),
    series: [{
      type: "scatter", data: pts, symbolSize: d => Math.max(5, Math.min(22, Math.sqrt(d[0] + 1) * 6)),
      itemStyle: { color: "rgba(70,168,230,0.55)", borderColor: "rgba(70,168,230,0.9)" },
    }],
  }, true);
}

/* ------------------------------------------------------------------- kpis */

function renderKpis() {
  const cids = activeCampaigns().map(c => c.id);
  const acc = sumArrays(cids);
  let spend = 0, rev = 0, inst = 0, impr = 0;
  for (let i = state.from; i <= state.to; i++) {
    spend += acc.spend[i]; rev += acc.revenue[i]; inst += acc.installs[i]; impr += acc.impressions[i];
  }
  const ev = eventsFor(cids);
  const tests = ev.reduce((s, e) => s + e.n, 0);
  const items = [
    ["Спенд", fmtMoney(spend)],
    ["Инсталлы", fmtInt(inst)],
    ["ROAS D1", spend > 0 ? fmtPct(rev / spend) : "—"],
    ["ICR", impr > 0 ? fmtPct(inst / impr) : "—"],
    ["Запусков тестов", fmtInt(ev.length)],
    ["Тестовых адгрупп", fmtInt(tests)],
    ["Кампаний", fmtInt(cids.length)],
  ];
  document.getElementById("kpis").innerHTML = items
    .map(([k, v]) => '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + v + "</div></div>").join("");
}

/* --------------------------------------------------------------- controls */

function shortName(s, len) {
  s = String(s || "");
  len = len || 26;
  return s.length > len ? s.slice(0, len - 1) + "…" : s;
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}
function escapeAttr(s) { return escapeHtml(s); }

function buildCampaignList() {
  const q = document.getElementById("campSearch").value.trim().toLowerCase();
  const list = appCampaigns().filter(c => !q || c.name.toLowerCase().includes(q));
  document.getElementById("campList").innerHTML = list.map(c =>
    '<label><input type="checkbox" data-id="' + c.id + '"' + (state.selected.has(c.id) ? " checked" : "") + ">" +
    '<span title="' + escapeAttr(c.name) + '">' + escapeHtml(shortName(c.name, 34)) + "</span>" +
    '<span class="amt">' + fmtMoney(c.spend) + (c.n_events ? " · " + c.n_events + "🚩" : "") + "</span></label>"
  ).join("") || '<div class="empty" style="padding:14px">Ничего не найдено</div>';

  document.getElementById("campList").querySelectorAll("input").forEach(inp => {
    inp.onchange = () => {
      if (inp.checked) state.selected.add(inp.dataset.id); else state.selected.delete(inp.dataset.id);
      updateCampCount();
      renderAll();
    };
  });
  updateCampCount();
}

function updateCampCount() {
  const total = appCampaigns().length;
  const sel = appCampaigns().filter(c => state.selected.has(c.id)).length;
  document.getElementById("campCount").textContent = "(" + sel + " из " + total + ")";
}

function buildFocusSelect() {
  const camps = activeCampaigns();
  const sel = document.getElementById("focusSel");
  sel.innerHTML = '<option value="__all__">Все выбранные кампании (сумма)</option>' +
    camps.map(c => '<option value="' + c.id + '">' + escapeHtml(c.name) + " — " + fmtMoney(c.spend) + "</option>").join("");
  sel.value = camps.some(c => c.id === state.focus) ? state.focus : "__all__";
  state.focus = sel.value;
}

function segment(id, onPick) {
  const host = document.getElementById(id);
  host.querySelectorAll("button").forEach(b => {
    b.onclick = () => {
      host.querySelectorAll("button").forEach(x => x.classList.remove("on"));
      b.classList.add("on");
      onPick(b.dataset.v);
    };
  });
}

function exportImpactCsv() {
  const cols = IMPACT_COLS.map(c => c.key);
  const head = IMPACT_COLS.map(c => c.label).join(",");
  const lines = impactRows.map(r => cols.map(k => {
    const v = r[k];
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(","));
  const blob = new Blob(["﻿" + head + "\n" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "test_adgroup_impact_" + state.window + "d.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ------------------------------------------------------------------- init */

function renderAll() {
  buildFocusSelect();
  renderKpis();
  renderMain();
  renderSmallMultiples();
  renderImpact(computeImpact());
  renderHeatmap();
  renderScatter();
}

function init() {
  document.getElementById("subtitle").textContent =
    META.platform + " · Google-канал в Adjust (" + META.channel + ") · " +
    META.date_from + " — " + META.date_to;

  const chips = [
    ["ROAS D1", META.roas_source],
    ["ICR", META.icr_definition],
    ["Кампаний", String(CAMPS.length)],
    ["Запусков тестов", String(EVENTS.length)],
    ["Собрано", META.generated_at],
  ].map(([k, v]) => '<span class="chip">' + k + " <b>" + escapeHtml(v) + "</b></span>");
  if (META.unmatched_spend_share > 0.02) {
    chips.push('<span class="chip warn">не сматчено с Google Ads <b>' +
      (META.unmatched_spend_share * 100).toFixed(1) + "%</b> спенда Adjust</span>");
  }
  document.getElementById("meta").innerHTML = chips.join("");

  const apps = Array.from(new Set(CAMPS.map(c => c.app))).sort();
  document.getElementById("appSel").innerHTML =
    '<option value="all">Все приложения</option>' + apps.map(a => '<option value="' + escapeAttr(a) + '">' + escapeHtml(a) + "</option>").join("");
  document.getElementById("appSel").onchange = e => {
    state.app = e.target.value;
    buildCampaignList();
    renderAll();
  };

  const from = document.getElementById("dateFrom"), to = document.getElementById("dateTo");
  from.min = to.min = DATES[0]; from.max = to.max = DATES[N - 1];
  from.value = DATES[0]; to.value = DATES[N - 1];
  const onDate = () => {
    state.from = Math.max(0, DATE_IDX[from.value] != null ? DATE_IDX[from.value] : 0);
    state.to = Math.min(N - 1, DATE_IDX[to.value] != null ? DATE_IDX[to.value] : N - 1);
    if (state.from > state.to) { const t = state.from; state.from = state.to; state.to = t; }
    renderAll();
  };
  from.onchange = to.onchange = onDate;

  segment("smoothSeg", v => { state.smooth = +v; renderMain(); renderSmallMultiples(); });
  segment("winSeg", v => { state.window = +v; renderImpact(computeImpact()); });
  segment("miniMetricSeg", v => { state.miniMetric = v; renderSmallMultiples(); });
  segment("scatterSeg", v => { state.scatterMode = v; renderScatter(); });

  document.getElementById("focusSel").onchange = e => { state.focus = e.target.value; renderMain(); };
  document.getElementById("campSearch").oninput = buildCampaignList;
  document.getElementById("campAll").onclick = () => {
    appCampaigns().forEach(c => state.selected.add(c.id));
    buildCampaignList(); renderAll();
  };
  document.getElementById("campNone").onclick = () => {
    appCampaigns().forEach(c => state.selected.delete(c.id));
    buildCampaignList(); renderAll();
  };
  document.getElementById("campTop").onclick = () => {
    const top = appCampaigns().slice(0, 10).map(c => c.id);
    appCampaigns().forEach(c => state.selected.delete(c.id));
    top.forEach(id => state.selected.add(id));
    buildCampaignList(); renderAll();
  };
  document.getElementById("exportImpact").onclick = exportImpactCsv;

  buildCampaignList();
  renderAll();
}

init();
})();

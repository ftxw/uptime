/* 二级页面：单站点详情 —— 零框架、零外部依赖
   数据来自单接口 /api/site（配置 + 状态 + SSL + 统计 + 序列 + 最近检查 + 故障记录）。
   图表用原生 SVG 手绘（不引任何图表库，国内加载更稳，且体积为 0）。
   策略与首页一致：先用 localStorage 的上次数据渲染，再后台拉新覆盖 —— 首屏不等网络。 */

const ICONS = {
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1 1 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
};

const svg = (n, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ""}</svg>`;

const qs = (s) => document.querySelector(s);

const STATE_LABEL = { up: "正常", down: "故障", degraded: "降级", unknown: "未知" };
const pad2 = (n) => String(n).padStart(2, "0");

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function relTime(iso) {
  if (!iso) return "从未检查";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function fmtFull(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtAxis(t, hours) {
  const d = new Date(t);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return hours <= 24 ? hm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

function fmtDur(sec) {
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h} 小时 ${m} 分`;
}

const fmtInterval = (min) => (min >= 60 ? `${min / 60} 小时` : `${min} 分钟`);
const ms = (v) => (v === null || v === undefined ? "--" : `${v} ms`);

/** 小时数 → 人话（168 → "7 天"，24 → "24 小时"）。故障记录窗口用得上 */
function fmtHours(h) {
  const n = Number(h);
  if (!n) return "";
  // 24 小时说成"1 天"反而别扭：窗口上限就是 24 小时，这里优先按小时表达
  if (n < 48 || n % 24 !== 0) return `${n} 小时`;
  return `${n / 24} 天`;
}

/** y 轴上界取整到 1/2/2.5/5×10^n，避免刻度出现 1237 这种数字 */
function nice(v) {
  if (!v || v <= 0) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * p;
}

/* ── 顶部与卡片 ────────────────────────────────────────── */

function renderHead(d) {
  const st = d.state || "unknown";
  const s = d.site;
  qs("#title").innerHTML =
    `${escapeHtml(s.name)} <span class="badge b-${st}">${STATE_LABEL[st]}</span>` +
    (d.degrade_reason
      ? ` <span class="muted" style="font-size:13px;font-weight:400">· ${escapeHtml(
          d.degrade_reason
        )}</span>`
      : "");

  const last = d.last || {};
  // 隐藏地址的站点：副标题里不出现 URL（服务端本就不下发），
  // 右上角「打开站点」整个撤掉 —— 访客既看不到地址，也没有入口点过去。
  const hidden = s.hide_url === true;
  qs("#subtitle").textContent =
    `${s.group_name}${hidden ? "" : ` · ${s.url}`} · 最近检查 ${relTime(last.ts)}` +
    (d.consecutive_fail ? ` · 连续失败 ${d.consecutive_fail} 次` : "");

  const visit = qs("#visit");
  visit.hidden = hidden;
  // 隐藏态连 href 都不留：留着 href 就等于把地址摆在源码和右键菜单里
  if (hidden) visit.removeAttribute("href");
  else visit.href = s.url;
  document.title = `${s.name} · 站点详情`;
}


function renderKpis(d) {
  const w = d.window || {};
  const l = d.latency || {};
  const s = d.site || {};
  const ssl = d.ssl;

  // SSL 卡片：未检测 / 有效天数 / 无效 —— 与首页、后台的三态判定同口径
  // （valid 由 stateOf 算好，已含「过期」与「未授权」两种情况）。
  let sslVal = "未检测";
  let sslCls = "i-muted";
  if (ssl && !ssl.error) {
    sslVal = ssl.days_remaining != null ? `${ssl.days_remaining} 天` : ssl.valid ? "有效" : "无效";
    sslCls = ssl.valid ? "i-success" : "i-destructive";
  } else if (ssl && ssl.error) {
    sslVal = "检测失败";
    sslCls = "i-destructive";
  }

  const cards = [
    { label: "可用率", value: w.uptime != null ? w.uptime.toFixed(1) + "%" : "--", icon: "shield", cls: "i-primary" },
    { label: "检查间隔", value: fmtInterval(s.interval_min), icon: "clock", cls: "i-muted" },
    { label: "SSL 证书", value: sslVal, icon: "lock", cls: sslCls },
    { label: "平均响应", value: ms(l.avg), icon: "activity", cls: "i-success" },
  ];

  qs("#kpis").innerHTML = cards
    .map(
      (c) => `<div class="card glass stat">
        <div class="stat-icon ${c.cls}">${svg(c.icon)}</div>
        <div style="min-width:0">
          <p class="stat-label">${c.label}</p>
          <p class="stat-value">${c.value}</p>
        </div>
      </div>`
    )
    .join("");
}

/* ── 响应时间趋势图（原生 SVG）──────────────────────────── */

function renderChart(series, hours) {
  const box = qs("#chart");
  // 服务端只下发「有记录」的桶（每点的 t = 该桶最后一条检查的时间），
  // 所以长度即点数，最多 24 个；空时段不会伪造出节点。
  const pts = series || [];
  if (!pts.length || !pts.some((p) => p.n > 0)) {
    box.innerHTML = '<div class="chart-empty">暂无数据 —— 该窗口内还没有检查记录</div>';
    return;
  }

  const W = Math.max(320, Math.round(box.clientWidth || 720));
  const H = 260;
  const pad = { l: 56, r: 16, t: 16, b: 30 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const T = (p) => new Date(p.t).getTime();
  const t0 = T(pts[0]);
  const t1 = T(pts[pts.length - 1]);
  const span = Math.max(1, t1 - t0);
  // 只有一个点（站点刚建好）时 t0===t1，按比例算会贴在左边缘 —— 居中更好看
  const solo = pts.length === 1;

  // y 上界按 95 分位定，避免个别尖峰把整张图压扁；至少留 50ms 视觉空间
  const vals = pts.filter((p) => p.v != null).map((p) => p.v).sort((a, b) => a - b);
  const p95v = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))] : 100;
  const ymax = nice(Math.max(vals.length ? vals[vals.length - 1] : 100, p95v * 1.15, 50));

  const X = (t) => (solo ? pad.l + iw / 2 : pad.l + ((t - t0) / span) * iw);
  const Y = (v) => pad.t + ih - (Math.min(Math.max(v, 0), ymax) / ymax) * ih;

  // 网格 + y 轴刻度
  let grid = "";
  const STEP = 4;
  for (let i = 0; i <= STEP; i++) {
    const v = (ymax * i) / STEP;
    const y = Y(v);
    grid += `<line class="grid-line${i ? " dash" : ""}" x1="${pad.l}" y1="${y.toFixed(
      1
    )}" x2="${pad.l + iw}" y2="${y.toFixed(1)}"/>`;
    grid += `<text class="axis-text" x="${pad.l - 8}" y="${(y + 4).toFixed(
      1
    )}" text-anchor="end">${Math.round(v)}</text>`;
  }

  // x 轴刻度
  const ticks = Math.min(5, pts.length);
  for (let i = 0; i < ticks; i++) {
    const t = t0 + span * (ticks === 1 ? 0.5 : i / (ticks - 1));
    const anchor = i === 0 ? "start" : i === ticks - 1 ? "end" : "middle";
    grid += `<text class="axis-text" x="${X(t).toFixed(1)}" y="${
      H - 8
    }" text-anchor="${anchor}">${fmtAxis(t, hours)}</text>`;
  }

  // 折线 + 面积：全失败的桶（v 为 null）处断开，不虚构数值。
  // 服务端只会给出「有记录」的桶，所以这里不必再处理空桶 —— 没有测过的时段
  // 本来就没有节点，连起来才是编造数据。
  const segs = [];
  let cur = [];
  for (const p of pts) {
    if (!p.n) continue;
    if (p.v == null) {
      if (cur.length) {
        segs.push(cur);
        cur = [];
      }
    } else cur.push(p);
  }
  if (cur.length) segs.push(cur);

  const baseY = pad.t + ih;
  let body = "";
  for (const s of segs) {
    if (s.length === 1) {
      const p = s[0];
      body += `<circle class="chart-dot" cx="${X(T(p)).toFixed(1)}" cy="${Y(p.v).toFixed(
        1
      )}" r="2.5"/>`;
      continue;
    }
    const d = s
      .map((p, i) => `${i ? "L" : "M"}${X(T(p)).toFixed(1)},${Y(p.v).toFixed(1)}`)
      .join(" ");
    body += `<path class="chart-area" d="${d} L${X(T(s[s.length - 1])).toFixed(1)},${baseY} L${X(
      T(s[0])
    ).toFixed(1)},${baseY} Z"/>`;
    body += `<path class="chart-line" d="${d}"/>`;
  }

  // 有失败的桶，在折线上标红点
  let bad = "";
  for (const p of pts) {
    if (p.ok < p.n && p.v != null) {
      bad += `<circle class="chart-dot-bad" cx="${X(T(p)).toFixed(1)}" cy="${Y(p.v).toFixed(
        1
      )}" r="3.5"/>`;
    }
  }

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="响应时间趋势图">
    <defs>
      <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" style="stop-color:hsl(var(--primary));stop-opacity:.30"/>
        <stop offset="100%" style="stop-color:hsl(var(--primary));stop-opacity:0"/>
      </linearGradient>
    </defs>
    ${grid}
    ${body}
    ${bad}
    <line class="chart-guide" id="guide" x1="0" y1="${pad.t}" x2="0" y2="${pad.t + ih}" style="opacity:0"/>
    <circle class="chart-hi" id="hi" r="4" style="opacity:0"/>
    <rect class="chart-hit" id="hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}"/>
  </svg>`;

  /* 悬浮交互：找最近的桶，显示十字线 + 提示 */
  const el = box.querySelector("svg");
  const guide = box.querySelector("#guide");
  const hiDot = box.querySelector("#hi");
  const tip = qs("#tip");

  const hide = () => {
    guide.style.opacity = 0;
    hiDot.style.opacity = 0;
    tip.classList.remove("show");
  };

  const onMove = (cx, cy) => {
    const r = el.getBoundingClientRect();
    const sx = (cx - r.left) * (W / (r.width || W));
    if (sx < pad.l - 8 || sx > pad.l + iw + 8) return hide();

    let best = null;
    let bd = Infinity;
    for (const p of pts) {
      const d = Math.abs(X(T(p)) - sx);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (!best) return hide();

    const bx = X(T(best));
    guide.setAttribute("x1", bx);
    guide.setAttribute("x2", bx);
    guide.style.opacity = 1;

    if (best.v != null) {
      hiDot.setAttribute("cx", bx);
      hiDot.setAttribute("cy", Y(best.v));
      hiDot.style.opacity = 1;
    } else {
      hiDot.style.opacity = 0;
    }

    const detail =
      best.n === 0
        ? `<span class="muted">该时段无检查记录</span>`
        : (best.v != null
            ? `平均 ${best.v} ms<br>`
            : `<span class="muted">该时段全部失败</span><br>`) +
          `成功 ${best.ok}/${best.n}` +
          (best.max != null ? `<br>最高 ${best.max} ms` : "");
    tip.innerHTML = `<b>${fmtFull(best.t)}</b><br>` + detail;
    tip.classList.add("show");
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = Math.min(cx + 14, innerWidth - tw - 8) + "px";
    tip.style.top = Math.max(cy - th - 12, 8) + "px";
  };

  el.addEventListener("mousemove", (e) => onMove(e.clientX, e.clientY));
  el.addEventListener("mouseleave", hide);
  el.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];
      if (t) onMove(t.clientX, t.clientY);
    },
    { passive: true }
  );
  el.addEventListener("touchend", hide);
}

/* ── 30 天色条 ─────────────────────────────────────────── */

function renderBars(bars) {
  const el = qs("#bar");
  const list = bars || [];
  if (!list.length) {
    el.innerHTML = '<span class="s-none" style="flex:1"></span>';
    qs("#barsum").textContent = "";
    return;
  }
  el.innerHTML = list
    .map((b) => {
      // 与服务端 / 首页同一口径：fault 才是"真故障"，blip 只是抖动。
      // 措辞上把判据写进提示，避免再出现「明明有失败为什么不是红的」这类疑问。
      const label =
        b.st === "none"
          ? "无数据"
          : b.st === "up"
          ? "全天正常"
          : b.st === "fault"
          ? "当天有故障（连续失败达到该站点阈值）"
          : "当天有抖动（失败未达故障阈值）";
      const detail = b.n ? `（${b.ok}/${b.n} 次成功）` : "";
      return `<span class="s-${b.st}" data-d="${b.d}" data-s="${label}" data-n="${detail}"></span>`;
    })
    .join("");

  const tracked = list.filter((b) => b.n > 0);
  const okAll = tracked.filter((b) => b.st === "up").length;
  qs("#barsum").textContent = tracked.length
    ? `${okAll}/${tracked.length} 天完全正常`
    : "暂无历史数据";
}

/* ── 最近检查 / 故障记录 ───────────────────────────────── */

// 注意：曾经这里是 renderRecent(recent, ssl)，但 ssl 从未被用到 —— 调用点也只传了一个。
// 多余的形参容易让读者以为"最近检查"里会显示证书信息，删掉以免误导。
function renderRecent(recent) {
  const el = qs("#recent");
  const list = recent || [];
  qs("#recentsum").textContent = list.length ? `最近 ${list.length} 条` : "";
  if (!list.length) {
    el.innerHTML = `<div class="empty">暂无检查记录</div>`;
    return;
  }
  el.innerHTML = list
    .map((r) => {
      const cls = r.ok ? "b-up" : "b-down";
      const label = r.ok ? "正常" : "故障";
      // 来源标签由服务端算好（origin，格式 GP:CN · Beijing/9808）——
      // 以前这里直接吐 source 原文（`gp:CN+datacenter-network · Beijing/45090`），
      // 与首页 / 后台的写法各不相同。取不到 origin 时退回 source 原文，不显示空白。
      const src = r.origin || r.source || "";
      return `<div class="lst-row">
        <span class="badge ${cls}">${label}</span>
        <span class="mono" style="min-width:34px">${r.status ?? "--"}</span>
        <span class="mono" style="min-width:72px">${
          r.ttfb != null ? r.ttfb + " ms" : "--"
        }</span>
        <span class="grow muted" style="font-size:12px" title="${escapeHtml(
          // 失败行优先显示错误原因（比"在哪跑的"更要紧），但来源仍放进 title ——
          // 否则排查"这次是怎么失败的"时完全看不到是哪台跑的
          r.error ? `${r.error} · ${src}` : src
        )}">${escapeHtml(r.error || src)}</span>
        <span class="mono muted" style="font-size:12px">${fmtFull(r.ts)}</span>
      </div>`;
    })
    .join("");
}

function renderIncidents(incidents, winHours) {
  const el = qs("#incidents");
  const list = incidents || [];
  const ongoing = list.filter((i) => i.ongoing).length;
  // 窗口写进标题：服务端只回看最近 168 小时（更长的窗口对"最近 N 条故障记录"没有意义，
  // 却要逐行扫完整个窗口），不写出来会让人以为 30 天视图里这份列表也覆盖 30 天。
  const win = fmtHours(winHours);
  qs("#incsum").textContent = list.length
    ? `${win ? `最近 ${win} · ` : ""}${list.length} 次记录${ongoing ? ` · ${ongoing} 次未恢复` : ""}`
    : "";
  if (!list.length) {
    el.innerHTML = `<div class="empty">暂无故障记录<br>
      <span style="font-size:12px">连续失败达到阈值（判为真实故障）才会记录${
        win ? ` · 仅统计最近 ${win}` : ""
      }</span></div>`;
    return;
  }
  el.innerHTML = list
    .map(
      (i) => `<div class="inc-row">
      <span class="badge ${i.ongoing ? "b-down" : "b-degraded"}" style="margin-top:2px">${
        i.ongoing ? "进行中" : "已恢复"
      }</span>
      <div class="grow" style="min-width:0">
        <div>${escapeHtml(i.error || "无错误详情")}</div>
        <div class="muted" style="font-size:12px;margin-top:3px">
          ${fmtFull(i.start)} → ${i.end ? fmtFull(i.end) : "持续中"} · 历时 ${fmtDur(
        i.duration_s
      )} · 约 ${i.checks_est} 次检查
        </div>
      </div>
    </div>`
    )
    .join("");
}

/* ── 主流程 ────────────────────────────────────────────── */

/* 无缓存 + 请求失败时把骨架屏收掉。
   否则页面会一直停在灰条上 —— 那比「加载中…」更容易被误读成"这站点没有记录"。
   收掉后回到紧凑的失败态，只留标题/副标题上那句原因。 */
function renderFailed(msg) {
  document.querySelectorAll(".skel").forEach((el) => el.remove());
  ["#recent", "#incidents"].forEach((sel) => {
    const el = qs(sel);
    if (el && !el.children.length) el.innerHTML = `<div class="empty">${escapeHtml(msg)}</div>`;
  });
  qs("#chart").innerHTML = `<div class="chart-empty">${escapeHtml(msg)}</div>`;
  qs("#bar").innerHTML = '<span style="flex:1"></span>';
}

const params = new URLSearchParams(location.search);
const SITE_ID = params.get("id") || "";
// 趋势窗口固定在服务端决定（上限 24 小时，不满则从首条记录算起），前端不再有 hours 参数。
const TREND_HOURS = 24;

// 带版本号：缓存里含站点 URL，而 hide_url 改完就不该再让访客看到 ——
// 换 key 让旧副本（url 还是明文的那份）一次作废，避免首帧抢先渲染出地址。
// 与 app.js 的 CACHE_KEY 同一处理，改缓存字段语义时两处一起 bump。
// v4：series 的点改为「桶内最后一条检查的时间」（不再是桶起点），且只含有数据的桶，
//     旧副本会把节点画在整点边界上，整份作废。
const cacheKey = () => `uptime:site:v4:${SITE_ID}`;

function render(d) {
  if (!d || !d.ok) return;
  // 页头品牌名跟随后台设置（详情页的 document.title 仍用站点名，更有用）
  if (d.settings && d.settings.site_title) {
    const b = document.getElementById("brand-name");
    if (b) b.textContent = d.settings.site_title;
  }
  renderHead(d);
  renderKpis(d);
  renderChart(d.series, TREND_HOURS);
  renderBars(d.bars);
  renderRecent(d.recent);
  renderIncidents(d.incidents, d.window && d.window.incident_hours);

  const w = d.window || {};
  // 跨度写实际值：新站点数据不足 24 小时时，窗口就是「首条记录 → 最后一次检查」，
  // 不能笼统写"最近 24 小时"，否则用户会以为中间缺了一大段。
  // 同时把右端时间写出来：曲线停在最后一次监测上是刻意的（不是数据丢了），
  // 不写清楚的话，看到"停在一小时前"的人只会以为图表坏了。
  const span = Number(w.span_sec || 0);
  const until = w.last_check_ts ? fmtFull(w.last_check_ts) : "";
  qs("#foot").textContent =
    `窗口：${until ? `截至 ${until} 的` : ""}最近 ${span >= 86400 ? "24 小时" : fmtDur(span)}` +
    ` · 共 ${w.checks} 次检查（失败 ${w.failures} 次）· ` +
    `探测位置 ${d.site.gp_magic || "默认筛选"} · SSL 随探测顺带采集`;
}

async function load() {
  if (!SITE_ID) {
    qs("#title").textContent = "缺少站点参数";
    qs("#subtitle").textContent = "请从总览页点击站点名称进入详情。";
    renderFailed("缺少站点参数");
    return;
  }

  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(cacheKey()) || "null");
  } catch (e) {}
  if (cached) render(cached); // 先渲染缓存，首屏不等网络

  qs("#refresh").disabled = true;
  try {
    const r = await fetch(`/api/site?id=${encodeURIComponent(SITE_ID)}`, {
      headers: { accept: "application/json" },
    });
    const data = await r.json();
    if (data && data.ok) {
      render(data);
      try {
        localStorage.setItem(cacheKey(), JSON.stringify(data));
      } catch (e) {}
    } else if (!cached) {
      qs("#title").textContent = "加载失败";
      qs("#subtitle").textContent = (data && data.error) || "接口返回异常";
      renderFailed("加载失败");
    }
  } catch (e) {
    if (!cached) {
      qs("#subtitle").textContent = "加载失败，稍后重试";
      renderFailed("加载失败，稍后重试");
    }
  } finally {
    qs("#refresh").disabled = false;
  }
}

qs("#refresh").addEventListener("click", load);

qs("#theme").addEventListener("click", () => {
  const dark = document.documentElement.classList.toggle("dark");
  try {
    localStorage.setItem("theme", dark ? "dark" : "light");
  } catch (e) {}
});

/* 色条悬浮提示 */
const tip = qs("#tip");
document.addEventListener("mouseover", (e) => {
  const seg = e.target.closest(".bar span");
  if (!seg) return;
  tip.innerHTML = `<b>${seg.dataset.d}</b><br>${seg.dataset.s}${seg.dataset.n || ""}`;
  tip.classList.add("show");
});
document.addEventListener("mousemove", (e) => {
  if (!tip.classList.contains("show")) return;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = Math.max(e.clientY - tip.offsetHeight - 10, 8) + "px";
});
document.addEventListener("mouseout", (e) => {
  if (e.target.closest(".bar span")) tip.classList.remove("show");
});

/* 窗口尺寸变化时重绘图表（SVG 坐标是按像素算的，必须重算） */
let rt = null;
addEventListener("resize", () => {
  clearTimeout(rt);
  rt = setTimeout(() => {
    const c = (() => {
      try {
        return JSON.parse(localStorage.getItem(cacheKey()) || "null");
      } catch (e) {
        return null;
      }
    })();
    if (c && c.series) renderChart(c.series, TREND_HOURS);
  }, 180);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) load();
});

load();
setInterval(() => {
  if (!document.hidden) load();
}, 60000);

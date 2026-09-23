/* 二级页面：单站点详情 —— 零框架、零外部依赖
   数据来自单接口 /api/site（配置 + 状态 + SSL + 统计 + 序列 + 最近检查 + 故障记录）。
   图表用原生 SVG 手绘（不引任何图表库，国内加载更稳，且体积为 0）。
   策略与首页一致：先用 localStorage 的上次数据渲染，再后台拉新覆盖 —— 首屏不等网络。 */

const ICONS = {
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1 1 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
  gauge: '<path d="M12 14 4 6"/><circle cx="12" cy="14" r="8"/>',
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
  qs("#subtitle").textContent =
    `${s.group_name} · ${s.url} · 最近检查 ${relTime(last.ts)}` +
    (d.consecutive_fail ? ` · 连续失败 ${d.consecutive_fail} 次` : "");

  qs("#visit").href = s.url;
  document.title = `${s.name} · 站点详情`;
}

function renderCards(d) {
  const s = d.site;
  const ssl = d.ssl;
  const last = d.last || {};

  let sslVal = "未检测";
  let sslIconCls = "i-muted";
  let sslTip = "证书尚未检测";
  if (ssl && !ssl.error) {
    sslVal = ssl.days_remaining != null ? `${ssl.days_remaining} 天` : ssl.valid ? "有效" : "无效";
    sslIconCls = ssl.valid ? "i-success" : "i-destructive";
    sslTip = `${ssl.issuer || "?"} · ${ssl.protocol || "?"} · 到期 ${(ssl.expires_at || "").slice(0, 10)}`;
  }

  const cards = [
    {
      ic: "globe",
      k: "URL 地址",
      v: `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer"
             title="${escapeHtml(s.url)}">${escapeHtml(s.url)}${svg("external")}</a>`,
    },
    { ic: "clock", k: "检查间隔", v: fmtInterval(s.interval_min) },
    {
      ic: "shield",
      icCls: sslIconCls,
      k: "SSL 证书",
      v: sslVal,
      tip: sslTip,
    },
    {
      ic: "gauge",
      k: "当前响应时间",
      v: last.ttfb != null ? `${last.ttfb} ms` : "--",
      tip: last.error ? `最近错误：${last.error}` : "",
    },
  ];

  qs("#dcards").innerHTML = cards
    .map(
      (c) => `<div class="card glass dcard"${c.tip ? ` title="${escapeHtml(c.tip)}"` : ""}>
        <span class="ic ${c.icCls || ""}">${svg(c.ic)}</span>
        <div style="min-width:0">
          <p class="k">${c.k}</p>
          <p class="v"${c.ic === "globe" ? "" : ' style="font-family:var(--font-mono)"'}>${c.v}</p>
        </div>
      </div>`
    )
    .join("");
}

function renderKpis(d) {
  const w = d.window || {};
  const l = d.latency || {};
  const fails = w.failures || 0;

  const cards = [
    { label: "可用率", value: w.uptime != null ? w.uptime.toFixed(1) + "%" : "--", icon: "shield", cls: "i-primary" },
    { label: "平均响应", value: ms(l.avg), icon: "activity", cls: "i-success" },
    { label: "P95 响应", value: ms(l.p95), icon: "up", cls: "i-primary" },
    { label: "最快 / 最慢", value: `${l.min ?? "--"} / ${l.max ?? "--"} ms`, icon: "down", cls: "i-muted" },
    {
      label: "失败次数",
      value: fails,
      icon: "alert",
      cls: fails > 0 ? "i-destructive" : "i-muted",
    },
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
  const pts = (series || []).filter((p) => p.n > 0);
  if (!pts.length) {
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

  // y 上界按 95 分位定，避免个别尖峰把整张图压扁；至少留 50ms 视觉空间
  const vals = pts.filter((p) => p.v != null).map((p) => p.v).sort((a, b) => a - b);
  const p95v = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))] : 100;
  const ymax = nice(Math.max(vals.length ? vals[vals.length - 1] : 100, p95v * 1.15, 50));

  const X = (t) => pad.l + ((t - t0) / span) * iw;
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

  // 折线 + 面积：全失败的桶（v 为 null）处断开，不虚构数值
  const segs = [];
  let cur = [];
  for (const p of pts) {
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
        <stop offset="0%" stop-color="hsl(160 84% 39%)" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="hsl(160 84% 39%)" stop-opacity="0"/>
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

    tip.innerHTML =
      `<b>${fmtFull(best.t)}</b><br>` +
      (best.v != null ? `平均 ${best.v} ms<br>` : `<span class="muted">该时段全部失败</span><br>`) +
      `成功 ${best.ok}/${best.n}` +
      (best.max != null ? `<br>最高 ${best.max} ms` : "");
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
      const label =
        b.st === "none"
          ? "无数据"
          : b.st === "up"
          ? "全天正常"
          : b.st === "down"
          ? "全天故障"
          : "当天有故障";
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

function renderRecent(recent, ssl) {
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
      const src = r.probe ? `${r.source || ""} · ${r.probe}` : r.source || "";
      return `<div class="lst-row">
        <span class="badge ${cls}">${label}</span>
        <span class="mono" style="min-width:34px">${r.status ?? "--"}</span>
        <span class="mono" style="min-width:72px">${
          r.ttfb != null ? r.ttfb + " ms" : "--"
        }</span>
        <span class="grow muted" style="font-size:12px" title="${escapeHtml(
          r.error || src
        )}">${escapeHtml(r.error || src)}</span>
        <span class="mono muted" style="font-size:12px">${fmtFull(r.ts)}</span>
      </div>`;
    })
    .join("");
}

function renderIncidents(incidents) {
  const el = qs("#incidents");
  const list = incidents || [];
  const ongoing = list.filter((i) => i.ongoing).length;
  qs("#incsum").textContent = list.length
    ? `${list.length} 次记录${ongoing ? ` · ${ongoing} 次未恢复` : ""}`
    : "";
  if (!list.length) {
    el.innerHTML = `<div class="empty">暂无故障记录<br>
      <span style="font-size:12px">连续失败达到阈值（判为真实故障）才会记录</span></div>`;
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

const params = new URLSearchParams(location.search);
const SITE_ID = params.get("id") || "";
let HOURS = Number(params.get("hours") || 24);
if (![6, 24, 168, 720].includes(HOURS)) HOURS = 24;

const cacheKey = () => `uptime:site:${SITE_ID}:${HOURS}`;

function render(d) {
  if (!d || !d.ok) return;
  // 页头品牌名跟随后台设置（详情页的 document.title 仍用站点名，更有用）
  if (d.settings && d.settings.site_title) {
    const b = document.getElementById("brand-name");
    if (b) b.textContent = d.settings.site_title;
  }
  renderHead(d);
  renderCards(d);
  renderKpis(d);
  renderChart(d.series, HOURS);
  renderBars(d.bars);
  renderRecent(d.recent);
  renderIncidents(d.incidents);

  const w = d.window || {};
  qs("#bucket").textContent = w.bucket_label ? `每个点 = ${w.bucket_label}聚合` : "";
  qs("#foot").textContent =
    `窗口：最近 ${w.hours} 小时 · 共 ${w.checks} 次检查（失败 ${w.failures} 次）· ` +
    `探测后端 ${
      d.site.probe_kind === "globalping"
        ? `Globalping（${d.site.gp_magic || "默认筛选"}）`
        : `CF Durable Object（${(d.site.cf_hint || "").toUpperCase()}）`
    } · SSL 由 Globalping 每站点每日检测一次`;
}

async function load() {
  if (!SITE_ID) {
    qs("#title").textContent = "缺少站点参数";
    qs("#subtitle").textContent = "请从总览页点击站点名称进入详情。";
    return;
  }

  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(cacheKey()) || "null");
  } catch (e) {}
  if (cached) render(cached); // 先渲染缓存，首屏不等网络

  qs("#refresh").disabled = true;
  try {
    const r = await fetch(`/api/site?id=${encodeURIComponent(SITE_ID)}&hours=${HOURS}`, {
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
    }
  } catch (e) {
    if (!cached) qs("#subtitle").textContent = "加载失败，稍后重试";
  } finally {
    qs("#refresh").disabled = false;
  }
}

/* 时间范围切换 —— 用 URL 记录，便于分享某个窗口的链接 */
qs("#range").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-h]");
  if (!btn) return;
  HOURS = Number(btn.dataset.h);
  [...qs("#range").children].forEach((b) => b.classList.toggle("on", b === btn));
  const u = new URL(location.href);
  u.searchParams.set("hours", String(HOURS));
  history.replaceState(null, "", u);
  qs("#chart").innerHTML = '<div class="chart-empty">加载中…</div>';
  load();
});

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
    if (c && c.series) renderChart(c.series, HOURS);
  }, 180);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) load();
});

/* 初始化范围按钮状态 */
[...qs("#range").children].forEach((b) =>
  b.classList.toggle("on", Number(b.dataset.h) === HOURS)
);

load();
setInterval(() => {
  if (!document.hidden) load();
}, 60000);

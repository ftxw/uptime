/* 前台状态页 —— 零框架、零外部依赖
   策略：先用 localStorage 里的上次数据立刻渲染（首屏不等网络），再后台拉 /api/overview 覆盖。
   布局对齐 ftxw/uptime-monitor：分组一张卡 + 组内分隔行 + 「响应时间 / SSL / 可用率」三列。 */

const API = "/api/overview";
const CACHE_KEY = "uptime:overview";

/* 分类：GROUPS 为接口返回的全部分组，FILTER 为空表示"全部" */
let GROUPS = [];
let FILTER = "";

const ICONS = {
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1 1 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
};

const svg = (n, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>`;

const qs = (s) => document.querySelector(s);

function relTime(iso) {
  if (!iso) return "从未检查";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

const STATE_LABEL = { up: "正常", down: "故障", degraded: "降级", unknown: "未知" };

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const fmtInterval = (min) => (min >= 60 ? `${min / 60} 小时` : `${min} 分钟`);

/* ── 渲染 ──────────────────────────────────────────────── */

function renderStats(s) {
  const cards = [
    { label: "监控总数", value: s.total, icon: "activity", cls: "i-primary" },
    { label: "运行中", value: s.up, icon: "up", cls: "i-success" },
    { label: "离线", value: s.down, icon: "down", cls: "i-destructive" },
    {
      label: "可用率",
      value: (s.uptime_24h ?? 100).toFixed(1) + "%",
      icon: "shield",
      cls: "i-primary",
    },
    {
      label: "活跃事件",
      value: s.incidents,
      icon: "alert",
      cls: s.incidents > 0 ? "i-destructive" : "i-muted",
    },
  ];
  qs("#stats").innerHTML = cards
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

function barHtml(m) {
  const segs = (m.bars || [])
    .map((b) => {
      const cls =
        b.st === "up" ? "s-up"
        : b.st === "down" ? "s-down"
        : b.st === "recovered" ? "s-recovered"
        : b.st === "degraded" ? "s-degraded"
        : "";
      const label =
        b.st === "none" ? "无数据"
        : b.st === "up" ? "全天正常"
        : b.st === "down" ? "全天故障"
        : "当天有故障";
      return `<span class="${cls}" data-d="${b.d}" data-s="${label}"></span>`;
    })
    .join("");
  return `<div class="bar" aria-label="最近 30 天运行历史">${segs}</div>`;
}

function monitorRow(m) {
  const st = m.state || "unknown";
  const ssl = m.ssl;
  let sslIcon = "shield-unknown";
  let sslText = "--";
  if (ssl && !ssl.error) {
    sslIcon = ssl.valid ? "shield-ok" : "shield-bad";
    sslText = ssl.days_remaining != null ? `${ssl.days_remaining} 天` : "有效";
  }
  const sslTitle = ssl && !ssl.error
    ? `颁发者 ${ssl.issuer || "?"} · ${ssl.protocol || "?"} · 到期 ${(ssl.expires_at || "").slice(0, 10)}`
    : "证书未检测";

  const degrade = m.degrade_reason
    ? ` <span class="muted" title="降级原因">· ${escapeHtml(m.degrade_reason)}</span>`
    : "";

  return `<div class="mrow">
    <div class="mrow-main">
      <div class="mrow-name">
        <a href="/monitor?id=${encodeURIComponent(m.id)}" title="查看详情${m.last_error ? " · " + escapeHtml(m.last_error) : ""}">${escapeHtml(m.name)}</a>
        <span class="badge b-${st}">${STATE_LABEL[st]}</span>
        <span class="muted" style="font-size:12px">${escapeHtml(m.id)}</span>
      </div>
      <div class="mrow-sub">
        <span class="ico url">${svg("globe")}${escapeHtml(m.url)}</span>
        <span class="ico">${svg("clock")}${fmtInterval(m.interval_min)}</span>
        <span class="ico muted" title="${escapeHtml(m.last_source || "")}">${escapeHtml(
          m.probe_kind === "globalping" ? "Globalping" : "CF · " + (m.cf_hint || "").toUpperCase()
        )}${m.last_probe ? " · " + escapeHtml(m.last_probe) : ""}</span>
        <span class="muted">${relTime(m.last_ts)}${degrade}</span>
      </div>
    </div>

    <div class="mrow-bar">${barHtml(m)}</div>

    <div class="mrow-metrics">
      <div class="metric">
        <span class="k">响应时间</span>
        <span class="v">${m.last_ttfb != null ? m.last_ttfb + " ms" : "--"}</span>
      </div>
      <div class="metric" title="${escapeHtml(sslTitle)}">
        <span class="k">SSL</span>
        <span class="v">${svg("shield", sslIcon)}${sslText}</span>
      </div>
      <div class="metric">
        <span class="k">可用率</span>
        <span class="v">${m.uptime_24h != null ? m.uptime_24h.toFixed(1) + "%" : "--"}</span>
      </div>
    </div>

    <div class="mrow-act">
      <a class="btn btn-sm" href="${escapeHtml(m.url)}" target="_blank" rel="noopener noreferrer"
         title="打开链接">${svg("external")}</a>
    </div>
  </div>`;
}

function renderGroups() {
  const el = qs("#groups");
  const groups = FILTER ? GROUPS.filter((g) => g.name === FILTER) : GROUPS;

  if (!groups.length) {
    el.className = "stack";
    el.innerHTML = `<div class="card glass empty-lg">
      ${svg("globe")}
      <p class="t">${GROUPS.length ? "该分类下没有站点" : "还没有监控"}</p>
      <p class="s">${
        GROUPS.length ? "换个分类看看，或点「全部」。" : "去「管理」页添加第一个站点。"
      }</p>
    </div>`;
    return;
  }

  el.className = "mgroups";
  el.innerHTML = groups
    .map((g) => {
      const items = g.monitors || [];
      const head =
        GROUPS.length > 1
          ? `<div class="mgroup-head">${escapeHtml(g.name)} <span class="count">(${items.length})</span></div>`
          : "";
      return `<div class="card glass">
        ${head}
        <div class="mgroup-body">${items.map(monitorRow).join("")}</div>
      </div>`;
    })
    .join("");
}

/* 分类筛选条：只在有多个分类时出现，避免单分类站点被无意义的 UI 占据 */
function renderChips() {
  const el = qs("#chips");
  if (!GROUPS.length || GROUPS.length <= 1) {
    el.innerHTML = "";
    return;
  }
  const items = [{ name: "", label: "全部", n: GROUPS.reduce((a, g) => a + (g.monitors || []).length, 0) }]
    .concat(GROUPS.map((g) => ({ name: g.name, label: g.name, n: (g.monitors || []).length })));
  el.innerHTML = items
    .map(
      (c) => `<button class="chip${FILTER === c.name ? " on" : ""}" data-cat="${escapeHtml(
        c.name
      )}">${escapeHtml(c.label)}<span class="n">${c.n}</span></button>`
    )
    .join("");
}

/**
 * 应用服务端设置（后台「设置」里的站点标题与默认主题）。
 * 主题优先级：用户手动切过（localStorage.theme）> 服务端默认 > 跟随系统。
 * 同时把默认值写进 theme-default，供下次访问时的 <head> 内联脚本提前应用（避免闪白）。
 */
function applySettings(st) {
  if (!st) return;
  if (st.site_title) {
    document.title = st.site_title;
    const b = document.getElementById("brand-name");
    if (b) b.textContent = st.site_title;
  }
  try {
    if (st.default_theme) localStorage.setItem("theme-default", st.default_theme);
  } catch (e) {}
  try {
    if (localStorage.getItem("theme")) return; // 用户手动选过 → 尊重其选择
    if (!st.default_theme || st.default_theme === "auto") return;
    document.documentElement.classList.toggle("dark", st.default_theme === "dark");
  } catch (e) {}
}

function render(data) {
  if (!data || !data.stats) return;
  applySettings(data.settings);
  renderStats(data.stats);
  GROUPS = data.groups || [];
  if (FILTER && !GROUPS.some((g) => g.name === FILTER)) FILTER = ""; // 分类被删/改名后自动回到全部
  renderChips();
  renderGroups();
  const t = new Date(data.now || Date.now());
  const d = data.stats.degraded || 0;
  qs("#subtitle").textContent =
    `共 ${data.stats.total} 个监控` +
    (d ? ` · ${d} 个降级` : "") +
    ` · 更新于 ${t.toLocaleTimeString("zh-CN")}`;
  qs("#foot").textContent =
    "点击站点名称进入详情页（趋势 / 证书 / 故障记录）。探测由 Cloudflare Durable Object 与 Globalping 探针执行；" +
    "SSL 证书信息由 Globalping 提供（每站点每日检测一次），剩余 ≤ 14 天判定为降级。";
}

/* ── 数据 ──────────────────────────────────────────────── */

async function load() {
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
  } catch (e) {}
  if (cached) render(cached); // 先渲染缓存 → 首屏不等网络

  qs("#refresh").disabled = true;
  try {
    const r = await fetch(API, { headers: { accept: "application/json" } });
    const data = await r.json();
    if (data && data.ok !== false) {
      render(data);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) {}
    }
  } catch (e) {
    if (!cached) qs("#subtitle").textContent = "加载失败，稍后重试";
  } finally {
    qs("#refresh").disabled = false;
  }
}

/* ── 交互 ──────────────────────────────────────────────── */

qs("#refresh").addEventListener("click", load);

/* 分类筛选：纯前端过滤，不发请求 —— 数据本来就一次全拿到了 */
qs("#chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  FILTER = chip.dataset.cat || "";
  renderChips();
  renderGroups();
});

qs("#theme").addEventListener("click", () => {
  const dark = document.documentElement.classList.toggle("dark");
  try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch (e) {}
});

const tip = qs("#tip");
document.addEventListener("mouseover", (e) => {
  const seg = e.target.closest(".bar span");
  if (!seg) return;
  tip.innerHTML = `<b>${seg.dataset.s}</b><br>${seg.dataset.d}`;
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

document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });

load();
setInterval(() => { if (!document.hidden) load(); }, 60000);

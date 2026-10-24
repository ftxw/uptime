/* 后台管理 —— 零框架、零外部依赖
   风格与前台一致（同一份 app.css）。

   结构参考 HaoNav 的「链接管理」面板：
     左卡 = 分类目录（点即筛选，选中态为实心主色块，卡头带「+ 添加分类」）
     右卡 = 站点列表（卡头带「+ 添加站点」，表格内含拖拽排序）
   两卡在宽屏下等高、各自独立滚动。

   保存后立即生效：写接口会递增配置版本，前台缓存的 key 随之变化（详见 src/index.js）。 */

const API = "/api";
const qs = (s) => document.querySelector(s);

/** 间隔的友好显示：60 → "1 小时"，其余 → "N 分钟" */
const fmtInterval = (min) => {
  const n = Number(min) || 5;
  return n >= 60 ? `${n / 60} 小时` : `${n} 分钟`;
};

let SITES = [];   // 顺序 = 前台渲染顺序（分类 → sort → id）
let CATS = [];
let FILTER = "";  // "" = 全部
let DRAG_CAT = null;     // 正在拖拽的分类名
let DRAG_SITE = null;    // 正在拖拽的站点 id
let AUTHED = false;
let SETTINGS = null;     // /admin 一次性带回的设置，用于设置面板预填
// 证书结果不再单独一张 map：/admin 已把 ssl_* 摊平在**每个站点行**里（见 sslCell）。
// 原先既发整张 map 又发扁平字段，同一份证书在一个响应里出现两遍，体积近乎翻倍。

const UNGROUPED = "未分组";
const ALL = "__all__";
const groupOf = (s) => (s && s.group_name && String(s.group_name).trim()) || UNGROUPED;
const siteById = (id) => SITES.find((s) => s.id === id);

const ICON = {
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function relTime(iso) {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/**
 * 顶部滑出提示（toast）。形态对齐 HaoNav 的「链接已复制」：
 * 顶部居中、宽度随文案自适应的小胶囊，一句话短文案，几秒后自动消失。
 *
 * ⚠️ 文案务必短 —— 挤在一条胶囊里，超过一屏宽度就会折行、失去"一眼扫过"的效果。
 *
 * 为什么是 fixed：这些提示原先插在页头下方、属文档流 —— 一出现就把下面的
 * 卡片整体顶下去，消失又弹回来，屏幕一直在跳。现在挂到 body 末尾的
 * #toast-host 上（fixed，从顶部滑出），完全不参与布局；多条会依次堆叠。
 *
 * 生命周期：入 DOM → 下一帧加 .show 触发滑出 → 到时移除 .show → 过渡结束摘节点。
 * 时长按严重程度分档（warn/error 给足阅读时间，但仍会自动消失，没有常驻条目）。
 */
const TOAST_MS = { info: 3000, warn: 5000, error: 6000 };

function banner(msg, kind) {
  const host = qs("#toast-host");
  if (!host || !msg) return;

  const el = document.createElement("div");
  el.className = "alert alert-" + (kind || "info") + " toast";
  el.textContent = msg;
  host.appendChild(el);

  // 先入 DOM 再加 .show：否则首次渲染就已是终态，滑出动画不会播。
  requestAnimationFrame(() => el.classList.add("show"));

  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 320); // 等过渡播完再摘掉节点
  }, TOAST_MS[kind] || TOAST_MS.info);
}

/**
 * 「未设置管理员密码」——不是提示，而是**唯一的界面**。
 *
 * 服务端在 ADMIN_PASSWORD 未配置时整体停用后台（fail-closed，见 src/index.js），
 * 所以这里不会有任何数据可显示：后台的骨架一直保持 visibility:hidden。
 *
 * 之前的行为是"未配置就放开认证"，只在顶部闪一条 5 秒警告 ——
 * 那等于用一个瞬间消失的提示去兜住"任何人都能改配置"这件事，兜不住。
 */
function showSetup() {
  AUTHED = false;
  // dialog 在 top layer，层级高于遮罩 —— 不关掉的话，用户看到的是
  // 「设置弹窗」压在「后台已停用」遮罩上面，两个界面叠在一起。
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  qs("#setup-mask").hidden = false;
  qs("#main").style.visibility = "hidden";
  qs("#logout").hidden = true;
}

/**
 * 「整屏遮罩」类错误：未登录（401）与后台停用（403 need_setup）。
 * 这两种情况遮罩已经把界面盖住了，再弹 toast 没人看得到 —— 静默即可。
 */
const isMasked = (e) => Boolean(e && (e.needLogin || e.needSetup));

/* ── 请求封装：401 弹登录、403 need_setup 弹「后台已停用」───────── */

async function api(path, opts = {}) {
  const headers = { accept: "application/json", ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(API + path, {
    ...opts,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  // 先解析一次响应体：下面两种错误分支都要用它的 error 文案。
  // （body 只能读一次，所以不能在各分支里各读一遍。）
  let d = null;
  try {
    d = await r.json();
  } catch {
    d = null;
  }

  // 401 = 配了密码但没登录 / 会话过期 → 弹登录框
  if (r.status === 401) {
    showLogin();
    const e = new Error((d && d.error) || "未登录或会话已过期");
    e.needLogin = true;
    throw e;
  }

  // 403 + need_setup = 服务端没配 ADMIN_PASSWORD，后台整体停用。
  // 这时**不能**弹登录框 —— 密码根本没配置，输什么都进不去，
  // 用户只会以为是自己记错了密码。改弹说明页，直接告诉他去设变量。
  if (r.status === 403 && d && d.need_setup) {
    showSetup();
    const e = new Error(d.error || "未设置管理员密码");
    e.needSetup = true;
    throw e;
  }

  return d || { ok: false, error: `HTTP ${r.status}` };
}

const post = (path, body) => api(path, { method: "POST", body });
const del = (path) => api(path, { method: "DELETE" });

/* ── 登录 ──────────────────────────────────────────────── */

function showLogin() {
  AUTHED = false;
  qs("#login-mask").hidden = false;
  qs("#main").style.visibility = "hidden";
  qs("#logout").hidden = true;
  setTimeout(() => qs("#login-pwd")?.focus(), 50);
}

function hideLogin() {
  AUTHED = true;
  qs("#login-mask").hidden = true;
  qs("#main").style.visibility = "visible";
  qs("#logout").hidden = false; // 已进入后台就常显「退出」
}

qs("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = qs("#login-btn");
  const err = qs("#login-err");
  const pwd = qs("#login-pwd").value;
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "登录中…";
  try {
    const r = await fetch(`${API}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pwd }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "登录失败");
    qs("#login-pwd").value = "";
    hideLogin();
    await loadAll();
    banner("已登录", "info");
  } catch (err2) {
    err.textContent = err2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "登录";
  }
});

qs("#logout").addEventListener("click", async () => {
  // all:true —— 让服务端轮换签名密钥，作废这台设备以外可能已经泄露的所有会话。
  // 会话本身是无状态签名 token，这是唯一能真正"下线"它们的办法。
  await post("/logout", { all: true }).catch(() => {});
  SITES = [];
  CATS = [];
  qs("#rows").innerHTML = "";
  qs("#cats").innerHTML = "";
  showLogin();
});

/* ── 目录 / 列表渲染 ───────────────────────────────────── */

const cmps = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function sortSites(list) {
  return [...list].sort(
    (a, b) =>
      cmps(groupOf(a), groupOf(b)) ||
      Number(a.sort ?? 0) - Number(b.sort ?? 0) ||
      cmps(String(a.id), String(b.id))
  );
}

const visibleSites = () => (FILTER ? SITES.filter((s) => groupOf(s) === FILTER) : SITES);

/** 左侧分类目录：全部 → 各分类 → 未分组（永远常显，方便把游离站点归拢） */
function catDir() {
  const counts = new Map();
  for (const s of SITES) {
    const g = groupOf(s);
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const list = [{ key: ALL, name: "全部", count: SITES.length, system: true }];

  const ungroupedExplicit = CATS.some((c) => c.name === UNGROUPED);

  // 显式分类（含「未分组」）—— 一律常显，不再因无站点而隐藏
  for (const c of CATS) {
    list.push({ key: c.name, name: c.name, count: counts.get(c.name) || 0 });
  }
  // 站点上出现、但未登记进分类表的分类名（例如直接手输的分类名）
  for (const [g, n] of counts) {
    if (g === UNGROUPED) continue; // 未分组单独兜底，避免重复
    if (!CATS.some((c) => c.name === g)) list.push({ key: g, name: g, count: n });
  }
  // 「未分组」兜底项：永远常显（即使没有任何站点落在它名下）
  if (!ungroupedExplicit) {
    list.push({ key: UNGROUPED, name: UNGROUPED, count: counts.get(UNGROUPED) || 0, system: true });
  }
  return list;
}

function renderCats() {
  const el = qs("#cats");
  const dir = catDir();
  fillGroupSelect();

  el.innerHTML = dir
    .map((it) => {
      const on = FILTER === (it.key === ALL ? "" : it.key);
      const ops = it.system
        ? ""
        : `<span class="ops">
            <button data-act="cat-edit" data-name="${escapeHtml(it.name)}" title="编辑名称">${ICON.pen}</button>
            <button data-act="cat-del" data-name="${escapeHtml(it.name)}" title="删除分类">${ICON.x}</button>
          </span>`;

      // 「全部」是系统项：不可重命名/删除，也不参与排序
      return `<div class="cat-item${on ? " on" : ""}" data-cat="${
        it.key === ALL ? "" : escapeHtml(it.key)
      }" ${it.system ? "" : 'draggable="true"'} role="button" tabindex="0">
        <span class="nm">${escapeHtml(it.name)}</span>
        ${ops}
        <span class="n">${it.count}</span>
      </div>`;
    })
    .join("");
}

/**
 * 站点表单里的分类下拉：**只列已有分类**。
 * 不支持在这里新建分类 —— 新建/改名/删除统一在左侧「分类」栏做，
 * 避免"同一个分类两个入口"带来的状态不一致（例如下拉里临时新建一个、
 * 之后在左侧改名，两边指向的分裂）。
 */
function fillGroupSelect(current) {
  const sel = qs("#f-group");
  if (!sel) return;
  const keep = current ?? sel.value;
  const names = CATS.map((c) => c.name);
  // 「未分组」永远作为兜底项 —— 还没建过任何分类时下拉不能是空的
  if (!names.includes(UNGROUPED)) names.unshift(UNGROUPED);
  if (keep && !names.includes(keep)) names.push(keep);
  sel.innerHTML = names
    .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
    .join("");
  if (keep && names.includes(keep)) sel.value = keep;
}

/**
 * 监测间隔下拉：**动态补项**，绝不静默改写站点的间隔。
 *
 * 为什么必须这样做：下拉只有 1/5/10/30/60，而服务端 `clampInt(interval_min,1,1440,5)`
 * 允许 1–1440 的**任意**整数（接口直连、或早期数据都可能出现 15、45 这类值）。
 * 旧写法 `qs("#f-interval").value = String(n)` 遇到列表里没有的值时，
 * `<select>` 找不到匹配项 → `selectedIndex = -1`、下拉**一片空白**；
 * 用户接着点「保存」，`Number("") || 5` 会把 15 **静默改成 5** ——
 * 一次「打开编辑 → 保存」就改掉了配置，页面没有任何提示。
 * 这里照搬 fillGroupSelect 的思路：列表里没有就补一项并选中。
 */
function fillIntervalSelect(current) {
  const sel = qs("#f-interval");
  if (!sel) return;
  const want = String(current ?? 5);
  if (![...sel.options].some((o) => o.value === want)) {
    const o = document.createElement("option");
    o.value = want;
    o.textContent = fmtInterval(want);
    sel.appendChild(o);
  }
  sel.value = want;
}

/**
 * 证书降级阈值（天）—— **跟随后台设置**，不写死。
 *
 * 原实现是硬编码 `d <= 14`，而 `ssl_warn_days` 是可配置项（默认 14）。
 * 一旦把阈值调到 30 天，前台页脚会跟着变，后台却仍按 14 天判色 ——
 * 剩 20 天的证书在后台显示为**绿色**，正好在最该报警的地方报喜不报忧。
 */
function warnDays() {
  const n = Number(SETTINGS && SETTINGS.ssl_warn_days);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

/**
 * 证书单元格。入参是**站点行**（/admin 已把 ssl 表的列摊平成 ssl_* 前缀），
 * 不再是单独一张 site→证书 的 map —— 同一份数据在响应里只出现一次。
 */
function sslCell(s) {
  if (!s || !s.ssl_checked_ts) return `<span class="muted">未检测</span>`;
  if (s.ssl_error) return `<span class="ssl ssl-warn">未知</span>`;
  const d = s.ssl_days_left;
  let cls = "ssl-ok";
  if (s.ssl_authorized === 0) cls = "ssl-bad";
  else if (d !== null && d <= warnDays()) cls = "ssl-warn";
  const text = d === null ? "有效" : d < 0 ? "已过期" : `${d} 天`;
  return `<span class="ssl ${cls}" title="${escapeHtml(s.ssl_issuer || "")} · ${escapeHtml(
    s.ssl_protocol || ""
  )} · 到期 ${escapeHtml(s.ssl_expires_at || "")}">${text}</span>`;
}

async function renderRows() {
  const list = visibleSites();
  const title = FILTER || "全部";
  // 拖拽排序只在**具体分类**视图下开放：「全部」视图里列表混着多个分类，而 sort
  // 只在同一分类内比较 —— 跨分类拖拽改了 sort 也不改变它所在的位置，表现为
  // 「拖了没反应」。与其让用户对着一个静默失败的手势猜，不如先要求选个分类。
  const canDrag = Boolean(FILTER);
  qs("#sites-title").innerHTML = `站点 <span class="muted" style="font-weight:400;font-size:12px">${escapeHtml(
    title
  )} · ${list.length} 个 · ${canDrag ? "可拖拽排序" : "选择分类后可拖拽排序"}</span>`;

  if (!list.length) {
    qs("#rows").innerHTML = `<tr><td colspan="5" class="empty">${
      SITES.length ? "该分类下还没有站点" : "还没有站点，点右上角「添加站点」"
    }</td></tr>`;
    return;
  }

  qs("#rows").innerHTML = list
    .map((s) => {
      // 三态（与前台同一口径）：后端在 buildAdminPayload 里用 stateOf() 算好，
      // 这里不能只看 last_ok —— 那会把「证书快过期 / 响应偏慢」的站点显示成绿色「正常」，
      // 而后台恰恰是最该看到降级的地方。
      const st =
        s.state === "up"
          ? "正常"
          : s.state === "down"
          ? "故障"
          : s.state === "degraded"
          ? "降级"
          : "未检查";
      const cls =
        s.state === "up"
          ? "b-up"
          : s.state === "down"
          ? "b-down"
          : s.state === "degraded"
          ? "b-degraded"
          : "b-unknown";
      // 降级原因放在 badge 的 title 里，鼠标悬浮可见（不额外占列宽）
      const stTitle = s.degrade_reason ? ` title="${escapeHtml(s.degrade_reason)}"` : "";
      const g = groupOf(s);

      return `<tr data-id="${escapeHtml(s.id)}" data-group="${escapeHtml(g)}"${
        canDrag ? ' draggable="true"' : ""
      }>
        <td>
          <div style="font-weight:500">${escapeHtml(s.name)}${
        s.enabled ? "" : ' <span class="muted" style="font-size:11px">已暂停</span>'
      }</div>
          <div class="muted" style="font-size:11px;opacity:.65"${
            s.origin ? ` title="${escapeHtml(s.origin)}"` : ""
          }>${fmtInterval(s.interval_min)}</div>
        </td>
        <td><span class="mono" style="font-size:12px">${escapeHtml(s.url)}</span>${
        // 后台看到的永远是明文地址（否则没法编辑），所以额外标一个「已隐藏」——
        // 不然前台不显示时，运营会以为是前端出了 bug
        s.hide_url ? ' <span class="muted" style="font-size:11px">已隐藏</span>' : ""
      }</td>
        <td>${sslCell(s)}</td>
        <td><span class="badge ${cls}"${stTitle}>${st}</span><div class="muted" style="font-size:11px">${relTime(
        s.last_ts
      )}</div></td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-sm" data-act="proxy-test" data-id="${escapeHtml(s.id)}">测</button>
          <button class="btn btn-sm" data-act="edit" data-id="${escapeHtml(s.id)}">编辑</button>
          <button class="btn btn-sm btn-danger" data-act="del" data-id="${escapeHtml(s.id)}">删除</button>
        </td>
      </tr>`;
    })
    .join("");
}

/** 页头品牌名跟随站点标题（数据已由 /admin 带回，不必再单独请求 /api/overview） */
function applyBrandTitle(st) {
  const t = st && st.site_title;
  if (!t) return;
  document.title = `${t} · 管理`;
  const b = document.getElementById("brand-name");
  if (b) b.textContent = t;
}

/**
 * 后台数据加载：**一次请求**拿全（站点 + 最近状态 + 分类 + 设置）。
 *
 * 为什么不再分开发 /sites 与 /categories：本站在 CF 边缘，从国内访问单次往返
 * 约 0.2s（实测静态文件 TTFB 中位 767ms，其中大部分是链路）。原先 /session →
 * /sites → /categories 是**串行**的，加上首屏 HTML 共 4 个 RTT，叠起来就明显慢。
 * 合并成 1 个 /admin 后，首屏只剩「HTML + /admin」两个请求。
 */
/**
 * 拉取后台全量数据（一次 /admin 拿到站点 + 分类 + 证书 + 设置）。
 *
 * ⚠️ 401 / 403(need_setup) 时**必须让异常继续往上抛**，不要在这里吞掉：
 *    `api()` 已经弹出了对应的遮罩，而 bootstrap 要靠这个异常来判断"没进去"。
 *    一旦在此 return，bootstrap 会以为加载成功、继续执行 hideLogin()，
 *    把刚弹出的登录框又藏回去 —— 表现为后台一片空白且无法登录。
 */
async function loadAll() {
  const d = await api("/admin");
  if (!d.ok) {
    // ⚠️ 必须让异常继续往上抛（不是弹个提示就 return）：
    //    bootstrap 正是靠"有没有异常"判断"到底进没进去"，一旦在此 return，
    //    它会以为加载成功、继续执行 hideLogin() —— 于是 /admin 返回 5xx 时
    //    用户看到的是一个**空壳后台**（提示一闪而过、表格永远是空的），
    //    而不是一个说得清原因的失败态。提示统一由 bootstrap 弹，避免弹两条。
    //    服务端对 D1 类故障会附一条 `hint`（可执行的下一步），一并带出来 ——
    //    否则用户只看到 "no such table: sites" 这种原文，不知道该做什么。
    throw new Error((d.error || "加载失败") + (d.hint ? `｜${d.hint}` : ""));
  }

  SITES = sortSites(d.sites || []);
  CATS = d.categories || [];
  if (d.settings) SETTINGS = d.settings; // 供设置面板预填，打开时不必先等网络
  applyBrandTitle(SETTINGS);

  renderCats();
  await renderRows();
}

/* ── 分类：切换 / 新建 / 改名 / 删除 / 排序 ─────────────── */

qs("#cats").addEventListener("click", async (e) => {
  const actBtn = e.target.closest("button[data-act]");
  if (actBtn) {
    e.stopPropagation();
    return handleCatAction(actBtn);
  }
  const item = e.target.closest(".cat-item");
  if (!item) return;
  FILTER = item.dataset.cat || "";
  renderCats();
  renderRows();
});

qs("#cats").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  // 分类项里还嵌着「编辑 / 删除」两个按钮。Enter / Space 在按钮上的默认动作就是"点击"，
  // 而下面那句 preventDefault() 会把这个默认动作吃掉 —— 不放行按钮的话，
  // 键盘用户按下去毫无反应（鼠标点击是另一条路径，所以只有键盘会撞上）。
  if (e.target.closest("button")) return;
  const item = e.target.closest(".cat-item");
  if (!item) return;
  e.preventDefault();
  FILTER = item.dataset.cat || "";
  renderCats();
  renderRows();
});

async function handleCatAction(btn) {
  const act = btn.dataset.act;
  const name = btn.dataset.name;

  if (act === "cat-edit") return openCatForm(name);

  if (act === "cat-del") {
    const n = CATS.find((c) => c.name === name)?.count ?? 0;
    if (
      !confirm(
        `删除分类「${name}」？\n该分类下的 ${n} 个站点会被移到「${UNGROUPED}」，站点本身不会被删除。`
      )
    )
      return;
    try {
      const d = await post("/categories", { action: "delete", name });
      if (!d.ok) throw new Error(d.error || "删除失败");
      if (FILTER === name) FILTER = "";
      banner(`已删除分类「${name}」，${n} 个站点移到「${UNGROUPED}」`, "info");
      await loadAll();
    } catch (err) {
      if (!isMasked(err)) banner("删除失败：" + err.message, "error");
    }
  }
}

/**
 * 「取消 / 关闭」按钮统一在这里关掉所属弹窗。
 *
 * ⚠️ 它们刻意**不是** submit 按钮，原因不只是风格：表单是 `method="dialog"`，
 *    而「隐式提交」（在任意输入框里按回车）用的 submitter 是表单的**默认按钮**——
 *    即树序里第一个 submit 按钮。原先关闭按钮在弹窗右上角、排在保存按钮之前，
 *    于是按回车会以 `submitter.value === "cancel"` 触发 submit：保存处理器把它当成
 *    "取消"直接 return（且**没有** preventDefault），method="dialog" 随即关掉弹窗。
 *    结果就是「在输入框里改完按回车 = 关闭弹窗且丢掉全部改动，还没有任何报错」。
 *    改成 type="button" 后，保存按钮成为唯一的（也就是默认的）submit 按钮，回车即保存。
 */
for (const b of document.querySelectorAll("[data-close]")) {
  b.addEventListener("click", () => b.closest("dialog")?.close());
}

/* ── 分类表单弹窗（新建 / 重命名共用同一个 dialog）───────── */

const catdlg = qs("#catdlg");
let CAT_EDITING = null; // null = 新建；否则是正在重命名的原分类名

function openCatForm(name) {
  CAT_EDITING = name || null;
  qs("#catdlg-title").textContent = name ? "编辑分类" : "添加分类";
  qs("#c-name").value = name || "";
  qs("#c-name-hint").textContent = name
    ? "重命名会同步更新该分类下的所有站点"
    : "分类只用于分组展示，不影响探测行为";
  qs("#catdlg-err").hidden = true;
  catdlg.showModal();
  setTimeout(() => {
    const i = qs("#c-name");
    i.focus();
    i.select();
  }, 50);
}

qs("#cat-add-toggle").addEventListener("click", () => openCatForm(null));

qs("#catform").addEventListener("submit", async (e) => {
  // 只处理「保存」（`submitter` 为空时也按保存走，做一层防御）。
  //
  // ⚠️ 原写法 `if (e.submitter?.value !== "save") return;` 是个静默 bug：
  //    隐式提交（在输入框里按回车）的 submitter 是表单的**默认按钮**，
  //    而当时关闭按钮是树序里第一个 submit 按钮 → submitter.value === "cancel"，
  //    于是这里直接 return 且**不执行 preventDefault()**，method="dialog" 随即关掉弹窗 ——
  //    用户看到弹窗关闭、没有任何报错或提示，以为保存成功，实际一个字都没提交。
  //    现已把关闭/取消按钮改成 type="button"（见 [data-close] 的处理），
  //    保存按钮成为唯一的默认按钮，回车即保存。
  if (e.submitter && e.submitter.value !== "save") return;
  e.preventDefault();

  const errEl = qs("#catdlg-err");
  const name = qs("#c-name").value.trim();
  errEl.hidden = true;

  if (!name) {
    errEl.textContent = "请输入分类名称";
    errEl.hidden = false;
    return;
  }
  if (CAT_EDITING && name === CAT_EDITING) {
    catdlg.close();
    return;
  }

  const btn = qs("#cat-save");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    const d = CAT_EDITING
      ? await post("/categories", { action: "rename", name: CAT_EDITING, new_name: name })
      : await post("/categories", { action: "create", name });
    if (!d.ok) throw new Error(d.error || "保存失败");

    if (CAT_EDITING) {
      if (FILTER === CAT_EDITING) FILTER = name;
      banner(`已重命名「${CAT_EDITING}」→「${name}」`, "info");
    } else {
      FILTER = name; // 新建后直接切过去，方便紧接着往里加站点
      banner(`已创建分类「${name}」`, "info");
    }
    CAT_EDITING = null;
    catdlg.close();
    await loadAll();
  } catch (err) {
    errEl.textContent = isMasked(err) ? err.message : "保存失败：" + err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "保存";
  }
});

/* ── 分类拖拽排序（与站点拖拽互不干扰：各用独立状态与容器监听）── */

const catList = qs("#cats");

/** 从 DOM 读当前顺序（跳过后台的系统项「全部」）—— 比从 CATS 推更贴合用户所见 */
function catOrderFromDom() {
  return [...catList.querySelectorAll(".cat-item[data-cat]")]
    .map((el) => el.dataset.cat)
    .filter(Boolean);
}

/**
 * 拖拽结束后提交新顺序。
 *
 * ⚠️ 关键点：只提交**显式分类**（v2_categories 里登记过的）。
 * 左侧目录里还会出现「未分组」和只在站点上出现过的分类名 —— 它们不是显式分类，
 * 若一并提交，后端 reorder 会 INSERT 进分类表，把它们「升级」成显式分类，
 * 于是「未分组」会永远占着目录、删除也删不掉。所以这里按 explicit 过滤。
 */
async function saveCatOrder(names) {
  const explicit = new Set(CATS.filter((c) => c.explicit).map((c) => c.name));
  const only = names.filter((n) => explicit.has(n));
  if (!only.length) return;
  try {
    const d = await post("/categories", { action: "reorder", names: only });
    if (!d.ok) throw new Error(d.error || "排序失败");
    banner("分类顺序已保存", "info");
    await loadAll();
  } catch (err) {
    if (!isMasked(err)) banner("分类排序失败：" + err.message, "error");
    await loadAll().catch(() => {}); // 同上：catch 里再抛会变成未处理的 rejection
  }
}

catList.addEventListener("dragstart", (e) => {
  const item = e.target.closest('.cat-item[draggable="true"]');
  if (!item) return;
  DRAG_CAT = item.dataset.cat;
  try {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", DRAG_CAT);
  } catch (err) {}
  item.classList.add("dragging");
});

catList.addEventListener("dragend", () => {
  DRAG_CAT = null;
  catList
    .querySelectorAll(".cat-item")
    .forEach((el) => el.classList.remove("dragging", "drag-over"));
});

catList.addEventListener("dragover", (e) => {
  if (!DRAG_CAT) return;
  const item = e.target.closest('.cat-item[draggable="true"]');
  if (!item) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  catList
    .querySelectorAll(".cat-item.drag-over")
    .forEach((el) => el.classList.remove("drag-over"));
  item.classList.add("drag-over");
});

catList.addEventListener("drop", (e) => {
  if (!DRAG_CAT) return;
  const item = e.target.closest('.cat-item[draggable="true"]');
  if (!item) return;
  e.preventDefault();

  const src = DRAG_CAT;
  const target = item.dataset.cat;
  DRAG_CAT = null;
  catList
    .querySelectorAll(".cat-item")
    .forEach((el) => el.classList.remove("dragging", "drag-over"));
  if (!target || target === src) return;

  const names = catOrderFromDom();
  const si = names.indexOf(src);
  if (si < 0) return;
  names.splice(si, 1);
  const di = names.indexOf(target);
  names.splice(di < 0 ? names.length : di, 0, src);
  saveCatOrder(names);
});

/* ── 站点列表拖拽排序 ───────────────────────────────────── */

const rowsEl = qs("#rows");

function clearRowDragUi() {
  rowsEl
    .querySelectorAll(".row-dragging, .row-drag-over")
    .forEach((el) => el.classList.remove("row-dragging", "row-drag-over"));
}

/**
 * 提交站点新顺序。
 *
 * 与分类的 reorder 同一约定（只传顺序、不传对象），但传的是**当前视图下全部站点的
 * id**：sort 只在同一分类内比较，整组重排不会与别的分类撞位；反过来只传被移动的
 * 那一条，服务端也无从判断它该落在哪里（一条记录谈不上"顺序"）。
 *
 * 成功与失败都重新拉取 —— 失败时列表会回到服务端的真实顺序，不会停在一个
 * "本地看着已经变了、一刷新又变回去"的假状态。
 */
async function saveSiteOrder(ids) {
  try {
    const d = await post("/sites", { action: "reorder", ids });
    if (!d.ok) throw new Error(d.error || "排序失败");
    banner("站点顺序已保存", "info");
  } catch (err) {
    if (!isMasked(err)) banner("站点排序失败：" + err.message, "error");
  }
  await loadAll().catch(() => {});
}

rowsEl.addEventListener("dragstart", (e) => {
  const tr = e.target.closest('tr[draggable="true"]');
  if (!tr) return;
  DRAG_SITE = tr.dataset.id;
  try {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", DRAG_SITE);
  } catch (err) {}
  tr.classList.add("row-dragging");
});

rowsEl.addEventListener("dragend", () => {
  DRAG_SITE = null;
  clearRowDragUi();
});

rowsEl.addEventListener("dragover", (e) => {
  if (!DRAG_SITE) return;
  const tr = e.target.closest('tr[draggable="true"]');
  if (!tr) return;
  e.preventDefault(); // 不 preventDefault 就没有后续的 drop 事件
  e.dataTransfer.dropEffect = "move";
  rowsEl
    .querySelectorAll(".row-drag-over")
    .forEach((el) => el.classList.remove("row-drag-over"));
  tr.classList.add("row-drag-over");
});

rowsEl.addEventListener("drop", (e) => {
  if (!DRAG_SITE) return;
  const tr = e.target.closest('tr[draggable="true"]');
  if (!tr) return;
  e.preventDefault();

  const src = DRAG_SITE;
  const target = tr.dataset.id;
  DRAG_SITE = null;
  clearRowDragUi();
  if (!target || target === src) return;

  // 取的是**拖拽前的 DOM 顺序**（拖动过程中没有实时挪行），所以先摘掉源、再插到目标位
  const ids = [...rowsEl.querySelectorAll("tr[data-id]")].map((el) => el.dataset.id);
  const si = ids.indexOf(src);
  if (si < 0) return;
  ids.splice(si, 1);
  const di = ids.indexOf(target);
  ids.splice(di < 0 ? ids.length : di, 0, src);
  saveSiteOrder(ids);
});

/* ── 站点表单 ──────────────────────────────────────────── */

const dlg = qs("#dlg");

/** 表单里最终选定的分类名 */
const currentGroupValue = () => qs("#f-group").value || UNGROUPED;

function openForm(site) {
  qs("#dlg-title").textContent = site ? "编辑站点" : "添加站点";
  qs("#f-id").value = site?.id || "";
  qs("#f-id").readOnly = Boolean(site);
  // ⚠️ 必须清掉「用户手动改过 ID」的标记：它挂在 DOM 元素上，会跟着弹窗活到下一次打开。
  //    不清的话，第一次新建时手动改过一次 ID，此后每次「添加站点」输名称都不再联动生成 ID，
  //    看起来就像"自动生成功能坏了"。编辑态由 readOnly 挡住，不需要这个标记。
  delete qs("#f-id").dataset.touched;
  qs("#f-name").value = site?.name || "";
  qs("#f-url").value = site?.url || "";
  // 勾选框 = 布尔开关，默认不勾（与数据库默认值 0 一致）
  qs("#f-hideurl").checked = Boolean(site?.hide_url);
  // 新建时预填当前筛选的分类，少点一次
  fillGroupSelect(
    site?.group_name || (FILTER && FILTER !== UNGROUPED ? FILTER : UNGROUPED)
  );
  qs("#f-codes").value = site?.expect_codes || "";
  qs("#f-threshold").value = site?.fail_threshold ?? 3;
  fillIntervalSelect(site?.interval_min ?? 5);
  qs("#f-enabled").value = String(site?.enabled ?? 1);
  qs("#dlg-err").hidden = true;
  dlg.showModal();
}

qs("#form").addEventListener("submit", async (e) => {
  // 只处理「保存」（`submitter` 为空时也按保存走，做一层防御）。
  //
  // ⚠️ 原写法 `if (e.submitter?.value !== "save") return;` 是个静默 bug：
  //    隐式提交（在输入框里按回车）的 submitter 是表单的**默认按钮**，
  //    而当时关闭按钮是树序里第一个 submit 按钮 → submitter.value === "cancel"，
  //    于是这里直接 return 且**不执行 preventDefault()**，method="dialog" 随即关掉弹窗 ——
  //    用户看到弹窗关闭、没有任何报错或提示，以为保存成功，实际一个字都没提交。
  //    现已把关闭/取消按钮改成 type="button"（见 [data-close] 的处理），
  //    保存按钮成为唯一的默认按钮，回车即保存。
  if (e.submitter && e.submitter.value !== "save") return;
  e.preventDefault();

  const body = {
    id: qs("#f-id").value.trim(),
    name: qs("#f-name").value.trim(),
    url: qs("#f-url").value.trim(),
    group_name: currentGroupValue(),
    expect_codes: qs("#f-codes").value.trim(),
    hide_url: qs("#f-hideurl").checked,
    fail_threshold: Number(qs("#f-threshold").value || 3),
    interval_min: Number(qs("#f-interval").value || 5),
    enabled: qs("#f-enabled").value === "1",
  };
  if (!body.id || !body.url) return;

  // 「显示顺序」已从表单移除，排序统一由列表拖拽负责（见 saveSiteOrder）。
  // 但**编辑时必须把原值带回去**：服务端把"没给 sort"的站点当作新建、排到队尾 ——
  // 否则每改一次名字，站点就会被悄悄挪到列表最后。
  // 新建时**刻意不带**这个字段，交给服务端分配队尾位置。
  const prev = siteById(body.id);
  if (prev) body.sort = Number(prev.sort) || 0;

  try {
    const d = await post("/sites", body);
    if (!d.ok) throw new Error(d.error || "保存失败");
    dlg.close();
    banner("已保存", "info");
    await loadAll();
  } catch (err) {
    const el = qs("#dlg-err");
    el.textContent = isMasked(err) ? err.message : "保存失败：" + err.message;
    el.hidden = false;
  }
});

qs("#add").addEventListener("click", () => openForm(null));

/* ── 站点操作 ──────────────────────────────────────────── */

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || btn.closest("#cats")) return; // 分类按钮由上面单独处理
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  const site = id ? siteById(id) : null;

  if (act === "edit") return openForm(site);

  if (act === "del") {
    if (!confirm(`确定删除「${site?.name || id}」？`)) return;
    try {
      const d = await del(`/sites?id=${encodeURIComponent(id)}`);
      banner(d.ok ? "已删除" : "删除失败：" + d.error, d.ok ? "info" : "error");
      await loadAll();
    } catch (err) {
      if (!isMasked(err)) banner("删除失败：" + err.message, "error");
    }
    return;
  }

  if (act === "proxy-test") {
    btn.disabled = true;
    btn.textContent = "…";
    try {
      // 位置（区域组 / 筛选）统一由后端从全局设置取，前端不再传 ——
      // 保证"测出来的"与"真实探测"走同一套参数。
      // 带上 site=<id>：让后端把这次结果写进 checks，
      // 这样手动测的点会出现在详情页折线与「最近检查」里。
      // ⚠️ 必须是 POST：这个接口会落库并可能消耗 Globalping 额度，
      //    GET 语义的幂等前提不成立（也避免被导航/预取意外触发）。
      const d = await post("/test", { site: site.id });
      const res = (d.results || [])[0] || {};
      // 来源标签由服务端算好（origin），与前台首页 / 详情页同一口径 ——
      // 以前这里自己拼「机房 SJC」，与前台写法不一致。
      const where = d.origin || "";
      // 文案压成一条紧凑的短句：toast 是单个胶囊，字段用 · 分隔比用中文更省宽度
      const mark = d.persisted ? (d.persisted.ok ? " · 已记录" : ` · 未记录：${d.persisted.reason || "失败"}`) : "";
      // 顺序：先重渲染表格（让「状态 / 最近检查」立刻反映这次结果），再弹提示 ——
      // 这样用户看到的是"表已更新"而不是先闪一条提示再等表格刷新。
      // 这里只调 renderRows 而不是 loadAll：后者会重拉一次全量数据，
      // 让这条刚弹出的结果提示白等一个 RTT。
      if (d.persisted) await renderRows();
      // 上色按**判定结果**，不是按"传输是否成功"：
      //   `res.ok` 只说明 fetch 没抛错，而「期望 200、实得 500」这类**判定失败**
      //   在它看来仍是 true —— 于是文案写着"未记录：状态码 500 不在期望集合"、
      //   气泡却是绿色，读起来自相矛盾。
      //   verdict 由 /api/test 按 gpDecide / judge 给出（与自动探测同一口径）。
      const judged = d.verdict ? d.verdict.ok : d.persisted ? d.persisted.ok : res.ok;
      banner(
        `${site.name} · HTTP ${res.status ?? "—"} · ${res.ttfb ?? "—"}ms · ${where} · ${
          d.roundTripMs ?? "—"
        }ms${mark}`,
        judged ? "info" : "error"
      );
    } catch (err) {
      if (!isMasked(err)) banner("测试失败：" + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "测";
    }
  }
});

qs("#checkall").addEventListener("click", async () => {
  const b = qs("#checkall");
  b.disabled = true;
  const old = b.innerHTML;
  b.textContent = "检查中…";
  try {
    // 同理必须是 POST —— 手动跑一轮会真实发起探测并写库
    const d = await post("/run", {});
    const n = (d.persisted?.persisted || 0) + (d.collect?.collected || 0);
    banner(`已执行一轮检查 · 落库 ${n} 条`, "info");
    await renderRows();
  } catch (e) {
    if (!isMasked(e)) banner("执行失败：" + e.message, "error");
  } finally {
    b.disabled = false;
    b.innerHTML = old;
  }
});

/* ── 设置 ──────────────────────────────────────────────── */

const setdlg = qs("#setdlg");

/** 位置筛选下拉里的「自定义…」哨兵值 */
const MAGIC_CUSTOM = "__custom__";
/**
 * 预设选项（必须与 admin.html 里 `#s-magic` 的 <option> 一致，顺序也一致）。
 * ⚠️ **[0] 被当作「内置默认值」使用**（见 writeMagicLike）—— 它必须等于
 *    `src/settings.js` 的 `SETTING_META.gp_magic.def`（两者同值），否则"库里没这一行"时
 *    回显的选中项会与服务端实际生效的筛选不一致。改默认值要三处一起改。
 */
const MAGIC_PRESETS = [
  "CN+datacenter-network",
  "CN",
  "CN+eyeball-network",
  "east-asia",
  "western-europe",
  "north-america",
];

/**
 * 读「预设 + 自定义」型下拉：选中预设就取预设值，选中「自定义」则取旁边的输入框。
 */
function readMagicLike(selId, customId) {
  const v = qs(selId).value;
  return v === MAGIC_CUSTOM ? qs(customId).value.trim() : v;
}

/**
 * 写「预设 + 自定义」型下拉：预设值→选中对应项；非预设值→切到「自定义」并填入输入框。
 *
 * ⚠️ 两个下拉里都**没有「不指定」这一项**（按要求移除），所以空值不能再映射成 `""`——
 *    那会让 <select> 找不到匹配项而变成"什么都不选中"的空白态（selectedIndex = -1）。
 *    改为回落到 `MAGIC_PRESETS[0]`（内置默认），界面上永远有确定的选中项，
 *    保存时会把该值显式写进 meta。**实际探测效果不变**：空值与
 *    `CN+datacenter-network` 本来等价（`effectiveEnv` 对空值回落 `SETTING_META` 的 def），
 *    区别只是从「跟着代码默认走」变成「把当前默认显式落库」。
 */
function writeMagicLike(selId, customId, v) {
  const val = v || MAGIC_PRESETS[0];
  const isPreset = MAGIC_PRESETS.includes(val);
  qs(selId).value = isPreset ? val : MAGIC_CUSTOM;
  qs(customId).value = isPreset ? "" : val;
  qs(customId).hidden = qs(selId).value !== MAGIC_CUSTOM;
}

/** `#s-magic`：对全部站点的**可用性探测**生效 */
function readMagic() {
  return readMagicLike("#s-magic", "#s-magic-custom");
}
function writeMagic(v) {
  writeMagicLike("#s-magic", "#s-magic-custom", v);
}

async function openSettings() {
  qs("#set-err").hidden = true;

  // 先用 /admin 已带回的设置立即填充并打开 —— 不必额外等一次网络往返。
  // 随后静默拉一次 /settings 校正（可能被其他会话改过），不阻塞界面。
  if (SETTINGS) {
    fillSettingsForm(SETTINGS);
    setdlg.showModal();
    api("/settings")
      .then((d) => {
        if (d && d.ok && d.settings) {
          SETTINGS = d.settings;
          fillSettingsForm(d.settings);
        }
      })
      .catch(() => {});
    return;
  }

  try {
    const d = await api("/settings");
    if (!d.ok) throw new Error(d.error || "读取设置失败");
    SETTINGS = d.settings || {};
    fillSettingsForm(SETTINGS);
    setdlg.showModal();
  } catch (e) {
    if (!isMasked(e)) banner("读取设置失败：" + e.message, "error");
  }
}

/** 把设置值填进弹窗表单（数据可能来自 /admin 预取，也可能来自 /settings 新拉） */
function fillSettingsForm(s) {
  qs("#s-title").value = s.site_title || "";
  qs("#s-theme").value = s.default_theme || "auto";
  qs("#s-utc").value = s.utc_offset_min ?? "";
  writeMagic(s.gp_magic || "");
  // 回填 gp_limit。取值**只**由这个下拉的 <option> 定义（服务端刻意不做校验），
  // 但库里仍可能是下拉之外的值 —— 环境变量 GP_LIMIT=7，或早期用数字框存下的值。
  // 直接赋值会让 selectedIndex = -1（显示成空白），点保存又被洗成默认档，
  // 等于静默改掉用户配置。所以这里补一项：没有引入任何校验，只保证"所见即所存"。
  const limitSel = qs("#s-limit");
  const limitVal = String(s.gp_limit ?? "");
  if (limitVal && ![...limitSel.options].some((o) => o.value === limitVal)) {
    limitSel.add(new Option(`${limitVal} · 非预设档`, limitVal));
  }
  if (limitVal) limitSel.value = limitVal;
  qs("#s-gptimeout").value = s.gp_timeout_sec || "";
  qs("#s-warn").value = s.ssl_warn_days || "";
  qs("#s-ipver").value = s.gp_ip_version || "4";
  qs("#s-budget").value = s.subreq_budget || "";
  qs("#s-keep").value = s.check_keep_days || "";
  qs("#s-recent").value = s.recent_limit || "";
  qs("#s-incident").value = s.incident_limit || "";
  qs("#s-gp-token").value = "";
  qs("#s-gp-token-hint").textContent = s.has_globalping_token
    ? `已配置：${s.globalping_token_masked}（留空则保留）`
    : "未配置（额度 250 次/小时；配置后 500 次/小时）";
}

qs("#settings-open").addEventListener("click", openSettings);

/**
 * 「清除 Token」—— 界面上删除已配置 Globalping Token 的**唯一**入口。
 *
 * 服务端的 `clear_globalping_token` 分支一直存在，但前端从来没发送过它，
 * 于是这个能力等于不存在：输入框留空只会走"保留旧值"（发 `__KEEP__`），
 * 用户配错 token 之后没有任何办法撤回。破坏性操作，先确认一次。
 */
qs("#s-gp-token-clear").addEventListener("click", async () => {
  if (!confirm("清除已保存的 Globalping Token？\n清除后额度回落到匿名档（250 次/小时）。")) return;
  const btn = qs("#s-gp-token-clear");
  btn.disabled = true;
  try {
    const r = await post("/settings", { clear_globalping_token: true });
    if (!r.ok) throw new Error(r.error || "清除失败");
    qs("#s-gp-token").value = "";
    qs("#s-gp-token-hint").textContent = "未配置（额度 250 次/小时；配置后 500 次/小时）";
    banner("Token 已清除", "info");
    await loadAll();
  } catch (err) {
    if (!isMasked(err)) banner("清除失败：" + err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// 位置筛选下拉选到「自定义…」时展开旁边的输入框
for (const [selId, customId] of [["#s-magic", "#s-magic-custom"]]) {
  qs(selId).addEventListener("change", () => {
    const custom = qs(selId).value === MAGIC_CUSTOM;
    qs(customId).hidden = !custom;
    if (custom) qs(customId).focus();
  });
}

qs("#setform").addEventListener("submit", async (e) => {
  // 只处理「保存」（`submitter` 为空时也按保存走，做一层防御）。
  //
  // ⚠️ 原写法 `if (e.submitter?.value !== "save") return;` 是个静默 bug：
  //    隐式提交（在输入框里按回车）的 submitter 是表单的**默认按钮**，
  //    而当时关闭按钮是树序里第一个 submit 按钮 → submitter.value === "cancel"，
  //    于是这里直接 return 且**不执行 preventDefault()**，method="dialog" 随即关掉弹窗 ——
  //    用户看到弹窗关闭、没有任何报错或提示，以为保存成功，实际一个字都没提交。
  //    现已把关闭/取消按钮改成 type="button"（见 [data-close] 的处理），
  //    保存按钮成为唯一的默认按钮，回车即保存。
  if (e.submitter && e.submitter.value !== "save") return;
  e.preventDefault();

  const errEl = qs("#set-err");
  errEl.hidden = true;

  const btn = qs("#set-save");
  btn.disabled = true;
  btn.textContent = "保存中…";

  const body = {
    site_title: qs("#s-title").value.trim(),
    default_theme: qs("#s-theme").value,
    utc_offset_min: qs("#s-utc").value.trim(),
    gp_magic: readMagic(),
    gp_limit: qs("#s-limit").value.trim(),
    gp_timeout_sec: qs("#s-gptimeout").value.trim(),
    ssl_warn_days: qs("#s-warn").value.trim(),
    gp_ip_version: qs("#s-ipver").value,
    subreq_budget: qs("#s-budget").value.trim(),
    check_keep_days: qs("#s-keep").value.trim(),
    recent_limit: qs("#s-recent").value.trim(),
    incident_limit: qs("#s-incident").value.trim(),
    // 留空 = 不修改已有 token（后端识别 __KEEP__）
    globalping_token: qs("#s-gp-token").value.trim() || "__KEEP__",
  };

  try {
    const d = await post("/settings", body);
    if (!d.ok) throw new Error(d.error || "保存失败");
    setdlg.close();
    banner("设置已保存", "info");
    await loadAll();
  } catch (err) {
    errEl.textContent = isMasked(err) ? err.message : "保存失败：" + err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "保存";
  }
});

/* ── 主题 / 启动 ───────────────────────────────────────── */

qs("#theme").addEventListener("click", () => {
  const dark = document.documentElement.classList.toggle("dark");
  try {
    localStorage.setItem("theme", dark ? "dark" : "light");
  } catch (e) {}
});

// 名称自动生成 id
qs("#f-name").addEventListener("input", (e) => {
  const idEl = qs("#f-id");
  if (idEl.readOnly || idEl.dataset.touched) return;
  idEl.value = e.target.value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
});
qs("#f-id").addEventListener("input", (e) => {
  e.target.dataset.touched = "1";
});

async function bootstrap() {
  // 一次 /admin 同时拿到「登录态」与「全部数据」——不再先发 /session 再发数据。
  // 未登录时它返回 401：api() 已经弹出登录框，并把 needLogin 抛到这里。
  // ⚠️ 这种情况必须**直接返回**，绝不能继续往下走 ——
  //    下面的 hideLogin() 会把刚弹出的登录框又藏回去，变成空白页无法登录。
  try {
    await loadAll();
    hideLogin();
  } catch (e) {
    // ① needLogin：配了密码但未登录 → 登录框已由 api() 弹出
    // ② needSetup：没配密码（后台停用）→ 说明页已由 api() 弹出
    // 两种都交给用户，不要在这里再弹 toast（遮罩已经把界面挡住了，提示没人看得到）。
    if (e.needLogin || e.needSetup) return;
    banner("加载失败：" + e.message, "error");
  }
}

// 「我已设置，重新检查」——只刷新页面，重新走一次 bootstrap 的判定。
// 变量在 Cloudflare 侧是**秒级生效**的，不需要等部署，所以刷新就能进。
qs("#setup-reload").addEventListener("click", () => location.reload());

bootstrap();
// 每 2 分钟**重新拉数据**，而不是只重渲染 DOM。
// 旧实现只调 renderRows()：相对时间（"3 分钟前"）会不停变新，但底层数据一直是你
// 上次操作时的那份 —— 于是页面上会出现"刚刚检查过"却其实是半小时前的错觉。
// loadAll 失败时静默（401 会由 api() 弹登录框，其余交给下次轮询）。
setInterval(() => {
  if (document.hidden || !AUTHED) return;
  loadAll().catch(() => {});
}, 120000);

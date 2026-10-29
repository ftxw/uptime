/** 后台管理 —— 零框架、零外部依赖，风格与前台共用 app.css。 */

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
let PROBE = null;        // /admin 带回的探针健康（最近一次成功/失败/额度退避窗口）
// 证书结果不再单独一张 map：/admin 已把 ssl_* 摊平在每个站点行里（见 sslCell）。
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

/** 顶部滑出 toast：短文案、自动消失。 */
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

/** 未配置管理员密码时这是唯一界面：服务端 fail-closed，没有任何数据可显示。 */
function showSetup() {
  AUTHED = false;
  // dialog 在 top layer，层级高于遮罩 —— 不关掉的话，用户看到的是
  // 「设置弹窗」压在「后台已停用」遮罩上面，两个界面叠在一起。
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  qs("#setup-mask").hidden = false;
  qs("#main").style.visibility = "hidden";
  qs("#logout").hidden = true;
}

/** 整屏遮罩类错误（401 / 403 need_setup）：遮罩已盖住界面，静默即可。 */
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
  // 这时不能弹登录框 —— 密码根本没配置，输什么都进不去，
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

/**
 * 分组排序必须跟前台 / 左侧目录一致：按 categories.sort 的**显式顺序**，
 * 而不是分组名的码点顺序。否则用户在左边把「生产环境」拖到第一位，
 * 右边的分组块仍按拼音/Unicode 排，看起来像“只改了左边一项”。
 * 不在 CATS 里的分组（站点上手输的）排到末尾，并按名字稳定排序。
 */
function groupRank(name) {
  const i = CATS.findIndex((c) => c.name === name);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

function sortSites(list) {
  return [...list].sort(
    (a, b) =>
      groupRank(groupOf(a)) - groupRank(groupOf(b)) ||
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

/** 分类下拉只列已有分类；新建/改名统一在左侧分类栏做，避免两个入口状态不一致。 */
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

/** 间隔下拉动态补项，绝不静默改写站点间隔（服务端允许 1–1440 任意值）。 */
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

/** 证书降级阈值跟随后台设置，不写死。 */
function warnDays() {
  const n = Number(SETTINGS && SETTINGS.ssl_warn_days);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

/** 证书单元格：入参是摊平了 ssl_* 的站点行。 */
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
  // 拖拽排序只在具体分类视图下开放：「全部」视图里列表混着多个分类，而 sort
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

/** 后台一次请求拿全：站点 + 最近状态 + 分类 + 设置。 */
/** 拉取后台全量数据；401/403 必须继续抛，bootstrap 靠异常判断有没有进去。 */
async function loadAll() {
  const d = await api("/admin");
  if (!d.ok) {
    // 异常必须继续往上抛：否则 bootstrap 会误判加载成功。
    throw new Error((d.error || "加载失败") + (d.hint ? `｜${d.hint}` : ""));
  }

  // CATS 必须先赋值：sortSites 依赖它算分组顺序。
  CATS = d.categories || [];
  SITES = sortSites(d.sites || []);
  if (d.settings) SETTINGS = d.settings; // 供设置面板预填，打开时不必先等网络
  PROBE = d.probe || null;
  applyBrandTitle(SETTINGS);

  renderCats();
  await renderRows();
  // 额度账随「站点数 / 间隔 / 是否配 Token」变，这三者都由 /admin 带回，故在这里统一重算
  renderQuota();
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

/** 取消/关闭按钮统一在这里关弹窗；刻意不是 submit，避免隐式提交误触。 */
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
  // 只处理 submitter 为 save 的提交；submitter 为空也按保存走。
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

/** 拖拽结束后提交新顺序，只提交显式分类。 */
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

/** 提交站点新顺序：只传当前视图下全部站点的 id。 */
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

  // 取的是拖拽前的 DOM 顺序（拖动过程中没有实时挪行），所以先摘掉源、再插到目标位
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
  // 只处理 save 提交，submitter 为空也按保存走。
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
  // 不再静默 return：字段缺失时必须告诉用户，否则看起来像"点了没反应"。
  const requireEl = qs("#dlg-err");
  if (!body.id || !body.url) {
    requireEl.textContent = !body.id ? "请填写站点标识（可用「名称」自动生成）" : "请填写监控地址";
    requireEl.hidden = false;
    return;
  }

  // 排序统一由列表拖拽负责，但编辑时要把原 sort 带回去，否则会被挪到队尾。
  const prev = siteById(body.id);
  if (prev) body.sort = Number(prev.sort) || 0;

  try {
    const d = await post("/sites", body);
    if (!d.ok) throw new Error(d.error || "保存失败");
    // upserted = 0 说明服务端一条都没写（id/url 被过滤掉）：别提示"已保存"。
    if (d.upserted === 0) throw new Error("服务端没有写入任何站点（站点标识或地址为空）");
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
    // 文案要点明「历史数据一起删」：服务端是级联删除（sites / checks / ssl / state / pending），
    // 而"删除站点"听起来像是只删掉一个条目。
    if (!confirm(`确定删除「${site?.name || id}」？\n该站点的探测明细、证书与状态会一并删除，不可撤销。`))
      return;
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
      // 位置由后端从全局设置取，前端不传；带 site=<id> 让结果落库。
      const d = await post("/test", { site: site.id });
      const res = (d.results || [])[0] || {};
      // 来源标签由服务端算好（origin），与前台首页 / 详情页同一口径 ——
      // 以前这里自己拼「机房 SJC」，与前台写法不一致。
      const where = d.origin || "";
      // 文案压成一条紧凑的短句：toast 是单个胶囊，字段用 · 分隔比用中文更省宽度
      let mark = d.persisted ? (d.persisted.ok ? " · 已记录" : ` · 未记录：${d.persisted.reason || "失败"}`) : "";
      // 连续失败达到阈值时直接说出来：否则用户要自己数"今天第几次了"
      if (d.persisted && !d.persisted.ok && d.persisted.fail_run >= d.persisted.fail_threshold) {
        mark += ` · 今天已连续失败 ${d.persisted.fail_run} 次（构成故障）`;
      }
      // 写库有残缺（按天汇总 / 状态快照没写进去）时必须显形，不能装作"已记录"
      if (d.persisted && d.persisted.warn) mark += ` · ⚠ ${d.persisted.warn}`;
      // 先重渲染表格再弹提示，只调 renderRows 不重拉全量。
      if (d.persisted) await renderRows();
      // 上色按判定结果而非传输是否成功（期望 200 实得 500 仍算失败）。
      const judged = d.verdict ? d.verdict.ok : d.persisted ? d.persisted.ok : res.ok;
      // elapsed_ms 是这次测试实际等了多久。
      banner(
        `${site.name} · HTTP ${res.status ?? "—"} · ${res.ttfb ?? "—"}ms · ${where} · ${
          d.elapsed_ms ?? "—"
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
    // 两阶段语义：本轮只能拿到上一轮的结果，两个数字分开报。
    const collected = d.collect?.collected || 0;
    const started = (d.dispatch?.gpStarted || []).filter((x) => x.id).length;
    banner(`已执行一轮 · 落库 ${collected} 条 · 发起 ${started} 个（结果下一轮出）`, "info");
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
/** 预设选项必须与 admin.html 的 option 一致，[0] 是内置默认值。 */
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

/** 写「预设 + 自定义」下拉：非预设值切到自定义并填入输入框。 */
function writeMagicLike(selId, customId, v) {
  const val = v || MAGIC_PRESETS[0];
  const isPreset = MAGIC_PRESETS.includes(val);
  qs(selId).value = isPreset ? val : MAGIC_CUSTOM;
  qs(customId).value = isPreset ? "" : val;
  qs(customId).hidden = qs(selId).value !== MAGIC_CUSTOM;
}

/** `#s-magic`：对全部站点的可用性探测生效 */
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
  // 回填 gp_limit：取值只由下拉 option 定义，越界会显示空白。
  const limitSel = qs("#s-limit");
  const limitVal = String(s.gp_limit ?? "");
  if (limitVal && ![...limitSel.options].some((o) => o.value === limitVal)) {
    limitSel.add(new Option(`${limitVal} · 非预设档`, limitVal));
  }
  if (limitVal) limitSel.value = limitVal;
  qs("#s-gptimeout").value = s.gp_timeout_sec || "";
  qs("#s-warn").value = s.ssl_warn_days || "";
  qs("#s-slow").value = s.slow_ms ?? "";
  qs("#s-ipver").value = s.gp_ip_version || "4";
  qs("#s-budget").value = s.subreq_budget || "";
  qs("#s-keep").value = s.check_keep_days || "";
  qs("#s-recent").value = s.recent_limit || "";
  qs("#s-incident").value = s.incident_limit || "";
  qs("#s-gp-token").value = "";
  qs("#s-gp-token-hint").textContent = s.has_globalping_token
    ? `已配置：${s.globalping_token_masked}（留空则保留）`
    : "未配置（额度 250 次/小时；配置后 500 次/小时）";
  renderProbeInfo();
}

/** 倒计时文案（用于额度退避截止时间）。relTime 会把未来时间夹成"0 秒前"。 */
function fmtEta(iso) {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (!Number.isFinite(s)) return "—";
  if (s <= 0) return "即将恢复";
  return s < 60 ? `${s} 秒后` : `${Math.ceil(s / 60)} 分钟后`;
}

/**
 * 设置面板的探针状态行：最近一次成功 / 失败 / 是否在 429 退避窗口内。
 * 站点显示「探针连续 N 轮无结论」时，这一行能立刻分清是 GP 挂了、凭据错了，还是额度用光。
 * （额度估算不在这里 —— 它按站点与间隔算，挪到列表底部常驻，见 renderQuota）
 */
function renderProbeInfo() {
  const el = qs("#s-probe");
  if (!el) return;
  const p = PROBE || {};
  let text;
  let warn = false;
  if (p.blocked_until) {
    text = `探针状态：额度退避中，${fmtEta(p.blocked_until)}后恢复`;
    warn = true;
  } else if (p.last_error) {
    text = `探针状态：最近一次发起失败（${relTime(p.last_error_ts)}）｜${p.last_error}`;
    warn = true;
  } else if (p.last_ok_ts) {
    text = `探针状态：最近一次发起成功 ${relTime(p.last_ok_ts)}`;
  } else {
    text = "探针状态：还没有发起过测量";
  }
  el.textContent = text;
  el.style.color = warn ? "hsl(var(--destructive))" : "";
}

/**
 * Globalping 额度账：按当前**启用站点 × 各自监测间隔 × 每次探测点数**折算消耗，
 * 再和额度（配了 Token 500 点/小时，否则 250）比，算出「这套配置能连续跑多久」。
 *
 * 单位说明：Globalping 的额度按探测点数计费（一次测量 limit 点 = limit 点额度），
 * 所以「每小时消耗 = Σ(60 / 间隔分钟) × limit」。这也是本项目最容易踩的坑：
 * 默认 1 分钟间隔 + 3 点，匿名额度只够 1 个站点。
 *
 * @param limitOverride 设置面板里刚改动、尚未保存的 gp_limit（不写回 SETTINGS，取消即失效）
 */
function quotaStats(limitOverride) {
  const s = SETTINGS || {};
  const limit = Number(limitOverride ?? s.gp_limit) || 3;
  const token = Boolean(s.has_globalping_token);
  const cap = token ? 500 : 250;

  let n = 0;
  let need = 0;
  for (const site of SITES) {
    if (site.enabled === 0 || site.enabled === false) continue;
    // 实际间隔不能低于 2 分钟：两阶段模型（本轮发起、下轮收取）下，1 分钟档位
    // 真实落库间隔约 120s。按 1 分钟算额度会**高估**消耗，让用户以为额度不够用。
    const iv = Math.max(2, Number(site.interval_min) || 5);
    n++;
    need += (60 / iv) * limit;
  }

  const perSite = n ? need / n : 0;
  return {
    n,
    need: Math.round(need),
    limit,
    cap,
    token,
    // 额度被耗尽所需分钟数。need > cap 时必然 < 60，即「一小时里只跑得动一段」
    minutes: need > 0 ? (60 * cap) / need : Infinity,
    // 这套额度长期能养活的站点数（按当前平均消耗）
    fit: perSite > 0 ? Math.floor(cap / perSite) : 0,
  };
}

/** 把额度账写成一句话，贴在站点列表底部（常驻，不必打开设置面板）。 */
function renderQuota(limitOverride) {
  const el = qs("#quota");
  if (!el) return;
  const q = quotaStats(limitOverride);
  const fmt = (x) => Math.round(x).toLocaleString("zh-CN");

  if (!q.n) {
    el.textContent = "Globalping 额度：暂无启用中的站点，不会消耗额度。";
    el.style.color = "";
    return;
  }

  const capText = q.token
    ? `额度 ${q.cap} 点/小时（已配置 Token）`
    : `额度 ${q.cap} 点/小时（未配置 Token，配置后可翻倍到 500）`;
  const head = `Globalping 额度：${q.n} 个站点、每次 ${q.limit} 点，合计约 ${fmt(
    q.need
  )} 点/小时；${capText}`;

  if (q.need <= q.cap) {
    const pct = Math.round((q.need / q.cap) * 100);
    const spare = q.fit - q.n;
    const tail =
      spare > 0
        ? `，还能再加约 ${spare} 个站点（按当前平均消耗算）`
        : "，已接近上限，再加站点就会开始排队";
    el.textContent = `${head} → 占 ${pct}%，可以一直按设定间隔跑${tail}。`;
    // ≥90% 就提前标红：等真的撞上 429 再提示，站点已经黄了一片
    el.style.color = pct >= 90 ? "hsl(var(--destructive))" : "";
    return;
  }

  // 超额：额度会在 X 分钟后耗尽，之后整段时间被拉长 —— 这才是用户问的「能跑多久」
  const mins = Math.max(1, Math.round(q.minutes));
  const factor = (q.need / q.cap).toFixed(1);
  const fitText =
    q.fit >= 1
      ? `这套额度长期只够 ${q.fit} 个同配置站点`
      : "单站就已超出，建议调大间隔或把每次点数改成 1";
  el.textContent =
    `${head} → 约 ${mins} 分钟就会耗尽，之后要等额度窗口重置；` +
    `期间实际监测间隔会被拉长到约 ${factor} 倍（${fitText}）。`;
  el.style.color = "hsl(var(--destructive))";
}

qs("#settings-open").addEventListener("click", openSettings);

// 改「每次探测点数」时当场重算额度（不必先保存再看结果）。
// 不写回 SETTINGS：取消对话框后，列表底部那行仍按已保存的值显示。
qs("#s-limit").addEventListener("change", () => {
  const v = qs("#s-limit").value;
  renderProbeInfo();
  renderQuota(v);
});

// 关掉设置面板（含「取消」）：丢掉未保存的 gp_limit，底部额度行回到已保存的口径
setdlg.addEventListener("close", () => {
  renderProbeInfo();
  renderQuota();
});

/** 「清除 Token」是删除已配置 Token 的唯一入口。 */
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
  // 只处理 save 提交，submitter 为空也按保存走。
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
    slow_ms: qs("#s-slow").value.trim(),
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
/**
 * 名称 → id 的自动推导。
 *
 * ⚠️ 纯中文名（「我的博客」）经下面这串替换会得到**空串**，而空 id 在提交时会被
 * `if (!body.id || !body.url) return;` 静默吞掉：用户点了保存，弹窗不关、没有报错、
 * 什么也没发生。所以中文名必须退化成一个随机 id，而不是留空。
 */
function slugifyId(name) {
  const slug = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  if (slug) return slug;
  // 退路：site-xxxxxxxx（8 位十六进制，足够避免同一批次内碰撞）
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `site-${rand}`;
}

qs("#f-name").addEventListener("input", (e) => {
  const idEl = qs("#f-id");
  if (idEl.readOnly || idEl.dataset.touched) return;
  // 名字还是空的就先别写 id：否则用户刚敲第一个字母就会拿到一个随机后缀
  if (!e.target.value.trim()) {
    idEl.value = "";
    return;
  }
  idEl.value = slugifyId(e.target.value);
});
qs("#f-id").addEventListener("input", (e) => {
  e.target.dataset.touched = "1";
});

async function bootstrap() {
  // 一次 /admin 同时拿到登录态与全部数据；401 时直接返回。
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
// 变量在 Cloudflare 侧是秒级生效的，不需要等部署，所以刷新就能进。
qs("#setup-reload").addEventListener("click", () => location.reload());

bootstrap();
// 每 2 分钟重拉数据，而不只重渲染 DOM。
setInterval(() => {
  if (document.hidden || !AUTHED) return;
  loadAll().catch(() => {});
}, 120000);

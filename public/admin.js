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
let AUTHED = false;
let PWD_SOURCE = "none"; // none | env —— 密码只来自环境变量 ADMIN_PASSWORD
let SETTINGS = null;     // /admin 一次性带回的设置，用于设置面板预填
let SSL_MAP = {};        // /admin 一次性带回的证书结果（site → 记录）
let PWD_WARNED = false;  // 「未设密码」提示本次会话只弹一次（loadAll 会被反复调用）

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
 * 「未设置管理员密码」提醒。
 * 每次会话只弹一次 —— loadAll() 在每次增删改后都会跑，不设闸门就会反复弹。
 */
function warnNoPassword() {
  if (PWD_SOURCE !== "none" || PWD_WARNED) return;
  PWD_WARNED = true;
  banner("未设置管理员密码，任何人可改配置（需 Secret 变量 ADMIN_PASSWORD）", "warn");
}

/* ── 请求封装：401 一律弹出登录 ─────────────────────────── */

async function api(path, opts = {}) {
  const headers = { accept: "application/json", ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(API + path, {
    ...opts,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) {
    showLogin();
    const e = new Error("未登录或会话已过期");
    e.needLogin = true;
    throw e;
  }
  let d;
  try {
    d = await r.json();
  } catch {
    d = { ok: false, error: `HTTP ${r.status}` };
  }
  return d;
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

function sslCell(ssl) {
  if (!ssl || !ssl.checked_ts) return `<span class="muted">未检测</span>`;
  if (ssl.error) return `<span class="ssl ssl-warn">未知</span>`;
  const d = ssl.days_left;
  let cls = "ssl-ok";
  if (ssl.authorized === 0) cls = "ssl-bad";
  else if (d !== null && d <= 14) cls = "ssl-warn";
  const text = d === null ? "有效" : d < 0 ? "已过期" : `${d} 天`;
  return `<span class="ssl ${cls}" title="${escapeHtml(ssl.issuer || "")} · ${escapeHtml(
    ssl.protocol || ""
  )} · 到期 ${escapeHtml(ssl.expires_at || "")}">${text}</span>`;
}

/** 后端标签。后端现在是站点级必选项，直接显示解析结果 */
function backendLabel(s) {
  return s.resolved_kind || "cf";
}

async function renderRows() {
  const sslMap = SSL_MAP;

  const list = visibleSites();
  const title = FILTER || "全部";
  qs("#sites-title").innerHTML = `站点 <span class="muted" style="font-weight:400;font-size:12px">${escapeHtml(
    title
  )} · ${list.length} 个</span>`;

  if (!list.length) {
    qs("#rows").innerHTML = `<tr><td colspan="6" class="empty">${
      SITES.length ? "该分类下还没有站点" : "还没有站点，点右上角「添加站点」"
    }</td></tr>`;
    return;
  }

  qs("#rows").innerHTML = list
    .map((s) => {
      const st = s.last_ok === 1 ? "正常" : s.last_ok === 0 ? "故障" : "未检查";
      const cls = s.last_ok === 1 ? "b-up" : s.last_ok === 0 ? "b-down" : "b-unknown";
      const g = groupOf(s);

      return `<tr data-id="${escapeHtml(s.id)}" data-group="${escapeHtml(g)}">
        <td>
          <div style="font-weight:500">${escapeHtml(s.name)}${
        s.enabled ? "" : ' <span class="muted" style="font-size:11px">已暂停</span>'
      }</div>
        </td>
        <td><span class="mono" style="font-size:12px">${escapeHtml(s.url)}</span></td>
        <td class="muted" style="font-size:12px">${backendLabel(s)}<div style="font-size:11px;opacity:.65">${fmtInterval(
          s.interval_min
        )}</div></td>
        <td>${sslCell(sslMap[s.id])}</td>
        <td><span class="badge ${cls}">${st}</span><div class="muted" style="font-size:11px">${relTime(
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
 * ⚠️ 401 时**必须让 `needLogin` 继续往上抛**，不要在这里吞掉：
 *    `api()` 已经弹出了登录框，而 bootstrap 要靠这个异常来判断"没登录"。
 *    一旦在此 return，bootstrap 会以为加载成功、继续执行 hideLogin()，
 *    把刚弹出的登录框又藏回去 —— 表现为后台一片空白且无法登录。
 */
async function loadAll() {
  const d = await api("/admin");
  if (!d.ok) {
    banner(d.error || "加载失败", "error");
    return;
  }

  SITES = sortSites(d.sites || []);
  CATS = d.categories || [];
  SSL_MAP = d.ssl || {}; // 已有证书结果（只读），渲染不再单独发 /api/ssl
  if (d.settings) SETTINGS = d.settings; // 供设置面板预填，打开时不必先等网络
  if (d.password_source) PWD_SOURCE = d.password_source;
  applyBrandTitle(SETTINGS);

  renderCats();
  await renderRows();

  // 「X 站点 · Y 分类」的常驻绿色横幅已按需求移除；
  // 「未设密码」也改成一闪而过的顶部提示（每次会话只弹一次，见 warnNoPassword）。
  warnNoPassword();
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
      if (!err.needLogin) banner("删除失败：" + err.message, "error");
    }
  }
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
  if (e.submitter?.value !== "save") return;
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
    errEl.textContent = err.needLogin ? "会话已过期，请重新登录" : "保存失败：" + err.message;
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
    if (!err.needLogin) banner("分类排序失败：" + err.message, "error");
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

/* ── 站点表单 ──────────────────────────────────────────── */

const dlg = qs("#dlg");

/** 表单里最终选定的分类名 */
const currentGroupValue = () => qs("#f-group").value || UNGROUPED;

function openForm(site) {
  qs("#dlg-title").textContent = site ? "编辑站点" : "添加站点";
  qs("#f-id").value = site?.id || "";
  qs("#f-id").readOnly = Boolean(site);
  qs("#f-name").value = site?.name || "";
  qs("#f-url").value = site?.url || "";
  // 新建时预填当前筛选的分类，少点一次
  fillGroupSelect(
    site?.group_name || (FILTER && FILTER !== UNGROUPED ? FILTER : UNGROUPED)
  );
  // probe_kind 是必选项（表单里没有空选项）；服务端也会归一化，这里只做预设
  qs("#f-kind").value = site?.probe_kind === "globalping" ? "globalping" : "cf";
  qs("#f-codes").value = site?.expect_codes || "";
  qs("#f-keyword").value = site?.keyword || "";
  qs("#f-threshold").value = site?.fail_threshold ?? 3;
  qs("#f-interval").value = String(site?.interval_min ?? 5);
  qs("#f-sort").value = site?.sort ?? 0;
  qs("#f-enabled").value = String(site?.enabled ?? 1);
  qs("#dlg-err").hidden = true;
  dlg.showModal();
}

qs("#form").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") return;
  e.preventDefault();

  const body = {
    id: qs("#f-id").value.trim(),
    name: qs("#f-name").value.trim(),
    url: qs("#f-url").value.trim(),
    group_name: currentGroupValue(),
    probe_kind: qs("#f-kind").value || null,
    expect_codes: qs("#f-codes").value.trim(),
    keyword: qs("#f-keyword").value.trim() || null,
    fail_threshold: Number(qs("#f-threshold").value || 3),
    interval_min: Number(qs("#f-interval").value || 5),
    sort: Number(qs("#f-sort").value || 0),
    enabled: qs("#f-enabled").value === "1",
  };
  if (!body.id || !body.url) return;

  try {
    const d = await post("/sites", body);
    if (!d.ok) throw new Error(d.error || "保存失败");
    dlg.close();
    banner("已保存", "info");
    await loadAll();
  } catch (err) {
    const el = qs("#dlg-err");
    el.textContent = err.needLogin ? "会话已过期，请重新登录" : "保存失败：" + err.message;
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
      if (!err.needLogin) banner("删除失败：" + err.message, "error");
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
      const kind = site?.resolved_kind || "cf";
      const d = await post("/test", { kind, site: site.id });
      const res = (d.results || [])[0] || {};
      const where = d.egress?.colo ? `机房 ${d.egress.colo}` : res.probe || "";
      // 文案压成一条紧凑的短句：toast 是单个胶囊，字段用 · 分隔比用中文更省宽度
      const mark = d.persisted ? (d.persisted.ok ? " · 已记录" : ` · 未记录：${d.persisted.reason || "失败"}`) : "";
      // 顺序：先重渲染表格（让「状态 / 最近检查」立刻反映这次结果），再弹提示 ——
      // 这样用户看到的是"表已更新"而不是先闪一条提示再等表格刷新。
      // 这里只调 renderRows 而不是 loadAll：后者会重拉一次全量数据，
      // 让这条刚弹出的结果提示白等一个 RTT。
      if (d.persisted) await renderRows();
      banner(
        `${site.name} · HTTP ${res.status ?? "—"} · ${res.ttfb ?? "—"}ms · ${where} · ${
          d.roundTripMs ?? "—"
        }ms${mark}`,
        res.ok ? "info" : "error"
      );
    } catch (err) {
      if (!err.needLogin) banner("测试失败：" + err.message, "error");
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
    if (!e.needLogin) banner("执行失败：" + e.message, "error");
  } finally {
    b.disabled = false;
    b.innerHTML = old;
  }
});

/* ── 设置 ──────────────────────────────────────────────── */

const setdlg = qs("#setdlg");

/** 位置筛选下拉里的「自定义…」哨兵值 */
const MAGIC_CUSTOM = "__custom__";
/** 预设选项（与 admin.html 里的 <option> 一致） */
const MAGIC_PRESETS = [
  "CN+datacenter-network",
  "CN+eyeball-network",
  "east-asia",
  "western-europe",
  "north-america",
];

/** 读位置筛选：下拉选中预设就取预设值，选中「自定义」则取输入框 */
function readMagic() {
  const v = qs("#s-magic").value;
  return v === MAGIC_CUSTOM ? qs("#s-magic-custom").value.trim() : v;
}

/** 写位置筛选：预设值→选中对应项；非预设值→切到「自定义」并填入输入框 */
function writeMagic(v) {
  const val = v || "";
  const isPreset = MAGIC_PRESETS.includes(val);
  qs("#s-magic").value = isPreset ? val : val ? MAGIC_CUSTOM : "";
  qs("#s-magic-custom").value = isPreset ? "" : val;
  qs("#s-magic-custom").hidden = qs("#s-magic").value !== MAGIC_CUSTOM;
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
    if (!e.needLogin) banner("读取设置失败：" + e.message, "error");
  }
}

/** 把设置值填进弹窗表单（数据可能来自 /admin 预取，也可能来自 /settings 新拉） */
function fillSettingsForm(s) {
  qs("#s-title").value = s.site_title || "";
  qs("#s-theme").value = s.default_theme || "auto";
  qs("#s-utc").value = s.utc_offset_min ?? "";
  qs("#s-hint").value = s.cf_hint || "";
  qs("#s-timeout").value = s.timeout_ms || "";
  writeMagic(s.gp_magic || "");
  qs("#s-limit").value = s.gp_limit || "";
  qs("#s-sslmagic").value = s.gp_ssl_magic || "";
  qs("#s-per-tick").value = s.ssl_per_tick || "";
  qs("#s-warn").value = s.ssl_warn_days || "";
  qs("#s-ipver").value = s.gp_ip_version || "4";
  qs("#s-budget").value = s.subreq_budget || "";
  qs("#s-keep").value = s.check_keep_days || "";
  qs("#s-webhook").value = s.alert_webhook || "";
  qs("#s-gp-token").value = "";
  qs("#s-gp-token-hint").textContent = s.has_globalping_token
    ? `已配置：${s.globalping_token_masked}（留空则保留）`
    : "未配置（额度 250 次/小时；配置后 500 次/小时）";

  // 密码只来自环境变量：这里只用于决定是否弹「未设置」提醒
  PWD_SOURCE = s.password_source || "none";
  warnNoPassword();
}

qs("#settings-open").addEventListener("click", openSettings);

// 位置筛选选到「自定义…」时展开输入框
qs("#s-magic").addEventListener("change", () => {
  const custom = qs("#s-magic").value === MAGIC_CUSTOM;
  qs("#s-magic-custom").hidden = !custom;
  if (custom) qs("#s-magic-custom").focus();
});

qs("#setform").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") return;
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
    cf_hint: qs("#s-hint").value,
    timeout_ms: qs("#s-timeout").value.trim(),
    gp_magic: readMagic(),
    gp_limit: qs("#s-limit").value.trim(),
    gp_ssl_magic: qs("#s-sslmagic").value.trim(),
    ssl_per_tick: qs("#s-per-tick").value.trim(),
    ssl_warn_days: qs("#s-warn").value.trim(),
    gp_ip_version: qs("#s-ipver").value,
    subreq_budget: qs("#s-budget").value.trim(),
    check_keep_days: qs("#s-keep").value.trim(),
    alert_webhook: qs("#s-webhook").value.trim(),
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
    errEl.textContent = err.needLogin ? "会话已过期，请重新登录" : "保存失败：" + err.message;
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
    if (e.needLogin) return; // 登录框已由 api() 弹出，交给用户输入
    banner("加载失败：" + e.message, "error");
  }
}

bootstrap();
setInterval(() => {
  if (!document.hidden && AUTHED) renderRows();
}, 120000);

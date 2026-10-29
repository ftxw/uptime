/** 站点管理后台。零依赖，风格与前台共用 app.css。 */

const API = "/api";
const qs = (s) => document.querySelector(s);

let SITES = [];
let CATS = [];
let CAT = "";        // 当前分类，"" = 全部
let Q = "";          // 搜索词
let STATE = "";      // 状态筛选
let AUTHD = false;
let SETTINGS = null;
let PROBE = null;
let DRAG_SITE = null;
let DRAG_CAT = null;
let CAT_EDITING = null;

const UNGROUPED = "未分组";
const groupOf = (s) => (s && s.group_name && String(s.group_name).trim()) || UNGROUPED;
const siteById = (id) => SITES.find((s) => s.id === id);
const STATE_LABEL = { up: "正常", down: "故障", degraded: "降级", unknown: "未检查" };

const ICON = {
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  del: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  test: '<polygon points="6 3 20 12 6 21 6 3"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
};
const svg = (k, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;

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

const fmtInterval = (min) => {
  const n = Number(min) || 5;
  return n >= 60 ? `${n / 60} 小时` : `${n} 分钟`;
};

/* ── 提示 ───────────────────────────────────────────────── */

const TOAST_MS = { info: 3000, warn: 5000, error: 6000 };

function banner(msg, kind) {
  const host = qs("#toast-host");
  if (!host || !msg) return;
  const el = document.createElement("div");
  el.className = "alert alert-" + (kind || "info") + " toast";
  el.textContent = msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 320);
  }, TOAST_MS[kind] || TOAST_MS.info);
}

const isMasked = (e) => Boolean(e && (e.needLogin || e.needSetup));

/* ── 请求 ───────────────────────────────────────────────── */

async function api(path, opts = {}) {
  const headers = { accept: "application/json", ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(API + path, {
    ...opts,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let d = null;
  try {
    d = await r.json();
  } catch {
    d = null;
  }
  if (r.status === 401) {
    showLogin();
    const e = new Error((d && d.error) || "未登录或会话已过期");
    e.needLogin = true;
    throw e;
  }
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

/* ── 登录 ───────────────────────────────────────────────── */

function showLogin() {
  AUTHD = false;
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  qs("#login-mask").hidden = false;
  qs("#main").hidden = true;
  setTimeout(() => qs("#login-pwd")?.focus(), 50);
}

function hideLogin() {
  AUTHD = true;
  qs("#login-mask").hidden = true;
  qs("#main").hidden = false;
}

function showSetup() {
  AUTHD = false;
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  qs("#setup-mask").hidden = false;
  qs("#main").hidden = true;
}

qs("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = qs("#login-btn");
  const err = qs("#login-err");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "登录中…";
  try {
    const r = await fetch(`${API}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: qs("#login-pwd").value }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "登录失败");
    qs("#login-pwd").value = "";
    hideLogin();
    await loadAll();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "登录";
  }
});

qs("#logout").addEventListener("click", async () => {
  // all:true 让服务端递增会话纪元，作废所有已签发的会话
  await post("/logout", { all: true }).catch(() => {});
  SITES = [];
  CATS = [];
  showLogin();
});

qs("#setup-reload").addEventListener("click", () => location.reload());

/* ── 概览条 ─────────────────────────────────────────────── */

function renderOverview() {
  const el = qs("#overview");
  if (!SITES.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const enabled = SITES.filter((s) => s.enabled);
  const n = (st) => enabled.filter((s) => s.state === st).length;
  // 额度按 60/间隔 * 点数 累加（1 分钟档实际约 2 分钟，按 2 计）
  const limit = Number(SETTINGS?.gp_limit) || 3;
  const cap = SETTINGS?.has_globalping_token ? 500 : 250;
  let need = 0;
  for (const s of enabled) need += (60 / Math.max(2, Number(s.interval_min) || 5)) * limit;
  const pct = Math.min(999, Math.round((need / cap) * 100));

  el.innerHTML = `
    <div class="adm-stat">
      <span class="k">站点</span>
      <span class="v">${enabled.length}<span class="of">/${SITES.length}</span></span>
    </div>
    <div class="adm-stat">
      <span class="k">正常</span>
      <span class="v ok">${n("up")}</span>
    </div>
    <div class="adm-stat">
      <span class="k">故障</span>
      <span class="v bad">${n("down")}</span>
    </div>
    <div class="adm-stat">
      <span class="k">降级</span>
      <span class="v warn">${n("degraded")}</span>
    </div>
    <div class="adm-stat adm-quota" title="按启用站点与间隔估算的 Globalping 额度占用">
      <span class="k">额度占用</span>
      <span class="v ${pct >= 90 ? "bad" : pct >= 70 ? "warn" : ""}">${pct}%<span class="of">${Math.round(need)}/${cap}</span></span>
    </div>`;
}

/* ── 分类条 ─────────────────────────────────────────────── */

const cmps = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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

function renderCats() {
  const el = qs("#cats");
  const counts = new Map();
  for (const s of SITES) {
    const g = groupOf(s);
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const ungroupedExplicit = CATS.some((c) => c.name === UNGROUPED);
  const items = [{ key: "", name: "全部", count: SITES.length, system: true }];
  for (const c of CATS) items.push({ key: c.name, name: c.name, count: counts.get(c.name) || 0 });
  for (const [g, cnt] of counts) {
    if (g === UNGROUPED) continue;
    if (!CATS.some((c) => c.name === g)) items.push({ key: g, name: g, count: cnt });
  }
  if (!ungroupedExplicit) {
    items.push({ key: UNGROUPED, name: UNGROUPED, count: counts.get(UNGROUPED) || 0, system: true });
  }

  el.innerHTML =
    items
      .map(
        (it) => `<div class="chip${CAT === it.key ? " on" : ""}${it.system ? " chip-fixed" : ""}"
          role="listitem" data-cat="${escapeHtml(it.key)}" ${it.system ? "" : 'draggable="true"'}
          tabindex="0">
          <span class="nm">${escapeHtml(it.name)}</span>
          <span class="n">${it.count}</span>
          ${
            it.system
              ? ""
              : `<span class="ops">
                   <button data-act="cat-edit" data-name="${escapeHtml(it.key)}" title="重命名">${svg("pen")}</button>
                   <button data-act="cat-del" data-name="${escapeHtml(it.key)}" title="删除">${svg("x")}</button>
                 </span>`
          }
        </div>`
      )
      .join("") +
    `<button class="chip chip-add" id="cat-add" title="新建分类">${svg("plus")}分类</button>`;

  // 重新绑定（innerHTML 后节点是新的）
  el.querySelectorAll(".chip-add").forEach((b) => b.addEventListener("click", () => openCatForm(null)));
}

/* ── 站点列表 ───────────────────────────────────────────── */

function visibleSites() {
  const q = Q.trim().toLowerCase();
  return SITES.filter((s) => {
    if (CAT && groupOf(s) !== CAT) return false;
    if (STATE === "paused" && s.enabled) return false;
    if (STATE && STATE !== "paused" && (!s.enabled || s.state !== STATE)) return false;
    if (!q) return true;
    return (
      String(s.name).toLowerCase().includes(q) ||
      String(s.url).toLowerCase().includes(q) ||
      String(s.id).toLowerCase().includes(q)
    );
  });
}

function sslText(s) {
  if (!s.ssl_checked_ts) return { text: "未检测", cls: "" };
  if (s.ssl_error) return { text: "未知", cls: "warn" };
  const d = s.ssl_days_left;
  if (d === null || d === undefined) return { text: "有效", cls: "ok" };
  if (d < 0) return { text: "已过期", cls: "bad" };
  if (s.ssl_authorized === 0) return { text: "无效", cls: "bad" };
  const warn = Number(SETTINGS?.ssl_warn_days ?? 14);
  return { text: `${d} 天`, cls: d <= warn ? "warn" : "ok" };
}

function siteRow(s) {
  const st = !s.enabled ? "paused" : s.state || "unknown";
  const label = st === "paused" ? "已暂停" : STATE_LABEL[st] || "未检查";
  const ssl = sslText(s);
  const drag = CAT ? ' draggable="true"' : "";
  const reason = s.degrade_reason
    ? `<span class="adm-reason">${escapeHtml(s.degrade_reason)}</span>`
    : "";

  return `<div class="adm-row st-${st}" data-id="${escapeHtml(s.id)}"${drag}>
    <div class="adm-status" title="${label}"><i></i></div>
    <div class="adm-main">
      <div class="adm-name">
        <span class="nm">${escapeHtml(s.name)}</span>
        <span class="badge b-${st === "paused" ? "unknown" : st}">${label}</span>
        ${reason}
      </div>
      <div class="adm-meta">
        <a class="url" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer"
           title="${escapeHtml(s.url)}">${escapeHtml(s.url)}</a>
        <span class="sep">·</span>
        <span>${fmtInterval(s.interval_min)}</span>
        ${s.ssl_checked_ts ? `<span class="sep">·</span><span class="ssl ${ssl.cls}" title="${escapeHtml(s.ssl_issuer || "")}">证书 ${ssl.text}</span>` : ""}
        ${s.last_ts ? `<span class="sep">·</span><span title="${escapeHtml(s.last_source || "")}">${relTime(s.last_ts)}</span>` : ""}
        ${s.hide_url ? `<span class="sep">·</span><span class="muted">地址已隐藏</span>` : ""}
      </div>
    </div>
    <div class="adm-actions">
      <button class="icon-btn" data-act="test" data-id="${escapeHtml(s.id)}" title="立即测试">${svg("test")}</button>
      <button class="icon-btn" data-act="edit" data-id="${escapeHtml(s.id)}" title="编辑">${svg("edit")}</button>
      <button class="icon-btn danger" data-act="del" data-id="${escapeHtml(s.id)}" title="删除">${svg("del")}</button>
    </div>
  </div>`;
}

function renderList() {
  const el = qs("#list");
  const list = visibleSites();

  if (!list.length) {
    const first = !SITES.length;
    el.innerHTML = `<div class="card glass empty-lg">
      ${first ? `<p class="t">还没有站点</p><p class="s">点右上角「添加站点」开始监测。</p>`
             : `<p class="t">没有匹配的站点</p><p class="s">试试换个关键词或清除筛选。</p>`}
    </div>`;
  } else {
    el.innerHTML = list.map(siteRow).join("");
  }

  qs("#foot").textContent = CAT
    ? `在「${CAT}」内可拖拽调整顺序`
    : "选择分类后可拖拽调整站点顺序";
}

/* ── 数据加载 ───────────────────────────────────────────── */

async function loadAll() {
  const d = await api("/admin");
  if (!d.ok) throw new Error((d.error || "加载失败") + (d.hint ? `（${d.hint}）` : ""));
  CATS = d.categories || [];
  SETTINGS = d.settings || SETTINGS;
  PROBE = d.probe || null;
  SITES = sortSites(d.sites || []);
  if (CAT && !CATS.some((c) => c.name === CAT) && CAT !== UNGROUPED) CAT = "";

  const t = SETTINGS && SETTINGS.site_title;
  if (t) {
    document.title = `${t} · 管理`;
    const b = document.getElementById("brand-name");
    if (b) b.textContent = t;
  }

  renderOverview();
  renderCats();
  renderList();
}

/* ── 筛选交互 ───────────────────────────────────────────── */

qs("#q").addEventListener("input", (e) => {
  Q = e.target.value;
  renderList();
});

qs("#state-filter").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-state]");
  if (!b) return;
  STATE = b.dataset.state;
  qs("#state-filter")
    .querySelectorAll("button")
    .forEach((x) => x.classList.toggle("on", x === b));
  renderList();
});

qs("#cats").addEventListener("click", async (e) => {
  const actBtn = e.target.closest("button[data-act]");
  if (actBtn) {
    e.stopPropagation();
    return handleCatAction(actBtn);
  }
  const chip = e.target.closest(".chip[data-cat]");
  if (!chip) return;
  CAT = chip.dataset.cat || "";
  renderCats();
  renderList();
});

qs("#cats").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  if (e.target.closest("button")) return;
  const chip = e.target.closest(".chip[data-cat]");
  if (!chip) return;
  e.preventDefault();
  CAT = chip.dataset.cat || "";
  renderCats();
  renderList();
});

/* ── 分类操作 ───────────────────────────────────────────── */

async function handleCatAction(btn) {
  const act = btn.dataset.act;
  const name = btn.dataset.name;
  if (act === "cat-edit") return openCatForm(name);
  if (act !== "cat-del") return;

  const n = SITES.filter((s) => groupOf(s) === name).length;
  if (!confirm(`删除分类「${name}」？\n其中 ${n} 个站点会移到「${UNGROUPED}」，站点本身不删除。`)) return;
  try {
    const d = await post("/categories", { action: "delete", name });
    if (!d.ok) throw new Error(d.error || "删除失败");
    if (CAT === name) CAT = "";
    banner(`已删除「${name}」`, "info");
    await loadAll();
  } catch (err) {
    if (!isMasked(err)) banner("删除失败：" + err.message, "error");
  }
}

const catdlg = qs("#catdlg");

function openCatForm(name) {
  CAT_EDITING = name || null;
  qs("#catdlg-title").textContent = name ? "重命名分类" : "新建分类";
  qs("#c-name").value = name || "";
  qs("#c-name-hint").textContent = name ? "重命名会同步更新该分类下的所有站点" : "只影响分组展示";
  qs("#catdlg-err").hidden = true;
  catdlg.showModal();
  setTimeout(() => {
    const i = qs("#c-name");
    i.focus();
    i.select();
  }, 50);
}

qs("#catform").addEventListener("submit", async (e) => {
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
  if (CAT_EDITING && name === CAT_EDITING) return catdlg.close();

  const btn = qs("#cat-save");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    const d = CAT_EDITING
      ? await post("/categories", { action: "rename", name: CAT_EDITING, new_name: name })
      : await post("/categories", { action: "create", name });
    if (!d.ok) throw new Error(d.error || "保存失败");
    if (CAT_EDITING && CAT === CAT_EDITING) CAT = name;
    else CAT = name;
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

/* 分类拖拽排序 */
qs("#cats").addEventListener("dragstart", (e) => {
  const item = e.target.closest('.chip[draggable="true"]');
  if (!item) return;
  DRAG_CAT = item.dataset.cat;
  try {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", DRAG_CAT);
  } catch {}
  item.classList.add("dragging");
});

qs("#cats").addEventListener("dragend", () => {
  DRAG_CAT = null;
  qs("#cats")
    .querySelectorAll(".chip")
    .forEach((el) => el.classList.remove("dragging", "drag-over"));
});

qs("#cats").addEventListener("dragover", (e) => {
  if (!DRAG_CAT) return;
  const item = e.target.closest('.chip[draggable="true"]');
  if (!item) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  qs("#cats")
    .querySelectorAll(".chip.drag-over")
    .forEach((el) => el.classList.remove("drag-over"));
  item.classList.add("drag-over");
});

qs("#cats").addEventListener("drop", (e) => {
  if (!DRAG_CAT) return;
  const item = e.target.closest('.chip[draggable="true"]');
  if (!item) return;
  e.preventDefault();
  const src = DRAG_CAT;
  const target = item.dataset.cat;
  DRAG_CAT = null;
  if (!target || target === src) return;

  const names = [...qs("#cats").querySelectorAll(".chip[data-cat]")]
    .map((el) => el.dataset.cat)
    .filter(Boolean);
  const si = names.indexOf(src);
  if (si < 0) return;
  names.splice(si, 1);
  const di = names.indexOf(target);
  names.splice(di < 0 ? names.length : di, 0, src);

  const explicit = new Set(CATS.map((c) => c.name));
  const only = names.filter((n) => explicit.has(n));
  if (!only.length) return;
  post("/categories", { action: "reorder", names: only })
    .then((d) => {
      if (!d.ok) throw new Error(d.error || "排序失败");
      return loadAll();
    })
    .catch((err) => {
      if (!isMasked(err)) banner("排序失败：" + err.message, "error");
      loadAll().catch(() => {});
    });
});

/* ── 站点拖拽排序 ───────────────────────────────────────── */

qs("#list").addEventListener("dragstart", (e) => {
  const row = e.target.closest('.adm-row[draggable="true"]');
  if (!row) return;
  DRAG_SITE = row.dataset.id;
  try {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", DRAG_SITE);
  } catch {}
  row.classList.add("dragging");
});

qs("#list").addEventListener("dragend", () => {
  DRAG_SITE = null;
  qs("#list")
    .querySelectorAll(".adm-row")
    .forEach((el) => el.classList.remove("dragging", "drag-over"));
});

qs("#list").addEventListener("dragover", (e) => {
  if (!DRAG_SITE) return;
  const row = e.target.closest('.adm-row[draggable="true"]');
  if (!row) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  qs("#list")
    .querySelectorAll(".adm-row.drag-over")
    .forEach((el) => el.classList.remove("drag-over"));
  row.classList.add("drag-over");
});

qs("#list").addEventListener("drop", (e) => {
  if (!DRAG_SITE) return;
  const row = e.target.closest('.adm-row[draggable="true"]');
  if (!row) return;
  e.preventDefault();
  const src = DRAG_SITE;
  const target = row.dataset.id;
  DRAG_SITE = null;
  qs("#list")
    .querySelectorAll(".adm-row")
    .forEach((el) => el.classList.remove("dragging", "drag-over"));
  if (!target || target === src) return;

  const ids = [...qs("#list").querySelectorAll(".adm-row")].map((el) => el.dataset.id);
  const si = ids.indexOf(src);
  if (si < 0) return;
  ids.splice(si, 1);
  const di = ids.indexOf(target);
  ids.splice(di < 0 ? ids.length : di, 0, src);

  post("/sites", { action: "reorder", ids })
    .then((d) => {
      if (!d.ok) throw new Error(d.error || "排序失败");
      return loadAll();
    })
    .catch((err) => {
      if (!isMasked(err)) banner("排序失败：" + err.message, "error");
      loadAll().catch(() => {});
    });
});

/* ── 站点表单 ───────────────────────────────────────────── */

const dlg = qs("#dlg");

function fillGroupSelect(current) {
  const sel = qs("#f-group");
  const names = CATS.map((c) => c.name);
  if (!names.includes(UNGROUPED)) names.unshift(UNGROUPED);
  if (current && !names.includes(current)) names.push(current);
  sel.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  if (current) sel.value = current;
}

function fillIntervalSelect(current) {
  const sel = qs("#f-interval");
  const want = String(current ?? 5);
  if (![...sel.options].some((o) => o.value === want)) {
    const o = document.createElement("option");
    o.value = want;
    o.textContent = fmtInterval(want);
    sel.appendChild(o);
  }
  sel.value = want;
}

function slugifyId(name) {
  const slug = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  if (slug) return slug;
  // 纯中文名会得到空串，必须退回随机 id，否则保存会被静默丢弃
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `site-${rand}`;
}

function openForm(site) {
  qs("#dlg-title").textContent = site ? "编辑站点" : "添加站点";
  qs("#f-id").value = site?.id || "";
  qs("#f-id").readOnly = Boolean(site);
  delete qs("#f-id").dataset.touched;
  qs("#f-name").value = site?.name || "";
  qs("#f-url").value = site?.url || "";
  qs("#f-hideurl").checked = Boolean(site?.hide_url);
  fillGroupSelect(site?.group_name || (CAT && CAT !== UNGROUPED ? CAT : UNGROUPED));
  qs("#f-codes").value = site?.expect_codes || "";
  qs("#f-threshold").value = site?.fail_threshold ?? 3;
  fillIntervalSelect(site?.interval_min ?? 5);
  qs("#f-enabled").value = String(site?.enabled ?? 1);
  qs("#dlg-err").hidden = true;
  // 编辑时展开"更多选项"，否则用户看不到隐藏状态
  qs(".adv").open = Boolean(site);
  dlg.showModal();
  setTimeout(() => qs(site ? "#f-name" : "#f-url").focus(), 50);
}

qs("#form").addEventListener("submit", async (e) => {
  if (e.submitter && e.submitter.value !== "save") return;
  e.preventDefault();

  const errEl = qs("#dlg-err");
  errEl.hidden = true;

  const name = qs("#f-name").value.trim();
  let id = qs("#f-id").value.trim();
  const url = qs("#f-url").value.trim();

  if (!url) {
    errEl.textContent = "请填写监控地址";
    errEl.hidden = false;
    return;
  }
  if (!name) {
    errEl.textContent = "请填写显示名称";
    errEl.hidden = false;
    return;
  }
  // 没手动改过 id 就按名称生成
  if (!id) id = slugifyId(name);

  const body = {
    id,
    name,
    url,
    group_name: qs("#f-group").value || UNGROUPED,
    expect_codes: qs("#f-codes").value.trim(),
    hide_url: qs("#f-hideurl").checked,
    fail_threshold: Number(qs("#f-threshold").value || 3),
    interval_min: Number(qs("#f-interval").value || 5),
    enabled: qs("#f-enabled").value === "1",
  };
  const prev = siteById(id);
  if (prev) body.sort = Number(prev.sort) || 0;

  const btn = e.submitter || qs('#form button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    const d = await post("/sites", body);
    if (!d.ok) throw new Error(d.error || "保存失败");
    if (d.upserted === 0) throw new Error("服务端没有写入（标识或地址为空）");
    dlg.close();
    banner("已保存", "info");
    await loadAll();
  } catch (err) {
    errEl.textContent = isMasked(err) ? err.message : "保存失败：" + err.message;
    errEl.hidden = false;
  } finally {
    if (btn) btn.disabled = false;
  }
});

qs("#add").addEventListener("click", () => openForm(null));

qs("#f-name").addEventListener("input", (e) => {
  const idEl = qs("#f-id");
  if (idEl.readOnly || idEl.dataset.touched) return;
  if (!e.target.value.trim()) {
    idEl.value = "";
    return;
  }
  idEl.value = slugifyId(e.target.value);
});

qs("#f-id").addEventListener("input", (e) => {
  e.target.dataset.touched = "1";
});

/* ── 站点操作 ───────────────────────────────────────────── */

qs("#list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  const site = siteById(id);
  if (!site) return;

  if (act === "edit") return openForm(site);

  if (act === "del") {
    if (!confirm(`删除「${site.name}」？\n探测明细、证书与状态会一并删除，不可恢复。`)) return;
    try {
      const d = await del(`/sites?id=${encodeURIComponent(id)}`);
      if (!d.ok) throw new Error(d.error || "删除失败");
      banner("已删除", "info");
      await loadAll();
    } catch (err) {
      if (!isMasked(err)) banner("删除失败：" + err.message, "error");
    }
    return;
  }

  if (act === "test") {
    btn.disabled = true;
    try {
      const d = await post("/test", { site: id });
      if (!d.ok) throw new Error(d.error || "测试失败");
      const r = (d.results || [])[0] || {};
      const ok = d.verdict ? d.verdict.ok : r.ok;
      let msg = `${site.name} · HTTP ${r.status ?? "—"} · ${r.ttfb ?? "—"}ms · ${d.elapsed_ms ?? "—"}ms`;
      if (d.persisted) {
        msg += d.persisted.ok ? " · 已记录" : ` · 未记录：${d.persisted.reason || "失败"}`;
        if (!d.persisted.ok && d.persisted.fail_run >= d.persisted.fail_threshold) {
          msg += ` · 今天已连续失败 ${d.persisted.fail_run} 次`;
        }
        if (d.persisted.warn) msg += ` · ⚠ ${d.persisted.warn}`;
      }
      banner(msg, ok ? "info" : "error");
      await loadAll();
    } catch (err) {
      if (!isMasked(err)) banner("测试失败：" + err.message, "error");
    } finally {
      btn.disabled = false;
    }
  }
});

qs("#checkall").addEventListener("click", async () => {
  const b = qs("#checkall");
  const old = b.innerHTML;
  b.disabled = true;
  b.textContent = "检查中…";
  try {
    const d = await post("/run", {});
    const collected = d.collect?.collected || 0;
    const started = (d.dispatch?.gpStarted || []).filter((x) => x.id).length;
    banner(`已发起 ${started} 个探测，收取 ${collected} 条（结果下一轮出）`, "info");
    await loadAll();
  } catch (e) {
    if (!isMasked(e)) banner("执行失败：" + e.message, "error");
  } finally {
    b.disabled = false;
    b.innerHTML = old;
  }
});

/* ── 设置 ───────────────────────────────────────────────── */

const setdlg = qs("#setdlg");
const MAGIC_CUSTOM = "__custom__";
const MAGIC_PRESETS = [
  "CN+datacenter-network",
  "CN",
  "CN+eyeball-network",
  "east-asia",
  "western-europe",
  "north-america",
];

function readMagic() {
  const sel = qs("#s-magic");
  return sel.value === MAGIC_CUSTOM ? qs("#s-magic-custom").value.trim() : sel.value;
}

function writeMagic(v) {
  const val = v || MAGIC_PRESETS[0];
  const isPreset = MAGIC_PRESETS.includes(val);
  qs("#s-magic").value = isPreset ? val : MAGIC_CUSTOM;
  qs("#s-magic-custom").value = isPreset ? "" : val;
  qs("#s-magic-custom").hidden = isPreset;
}

function fmtEta(iso) {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (!Number.isFinite(s)) return "—";
  if (s <= 0) return "即将恢复";
  return s < 60 ? `${s} 秒后` : `${Math.ceil(s / 60)} 分钟后`;
}

function renderProbeInfo() {
  const el = qs("#s-probe");
  if (!el) return;
  const p = PROBE || {};
  let text;
  let warn = false;
  if (p.blocked_until) {
    text = `探针：额度退避中，${fmtEta(p.blocked_until)}恢复`;
    warn = true;
  } else if (p.last_error) {
    text = `探针：最近一次失败（${relTime(p.last_error_ts)}）｜${p.last_error}`;
    warn = true;
  } else if (p.last_ok_ts) {
    text = `探针：正常，最近成功 ${relTime(p.last_ok_ts)}`;
  } else {
    text = "探针：尚未发起过测量";
  }
  el.textContent = text;
  el.style.color = warn ? "hsl(var(--destructive))" : "";
}

function fillSettingsForm(s) {
  qs("#s-title").value = s.site_title || "";
  qs("#s-theme").value = s.default_theme || "auto";
  const utc = String(s.utc_offset_min ?? 480);
  const sel = qs("#s-utc");
  if (![...sel.options].some((o) => o.value === utc)) {
    sel.add(new Option(`UTC${Number(utc) >= 0 ? "+" : ""}${Number(utc) / 60}`, utc));
  }
  sel.value = utc;
  writeMagic(s.gp_magic || "");
  const limitSel = qs("#s-limit");
  const limitVal = String(s.gp_limit ?? "");
  if (limitVal && ![...limitSel.options].some((o) => o.value === limitVal)) {
    limitSel.add(new Option(`${limitVal} 点`, limitVal));
  }
  if (limitVal) limitSel.value = limitVal;
  qs("#s-warn").value = s.ssl_warn_days ?? "";
  qs("#s-slow").value = s.slow_ms ?? "";
  qs("#s-gp-token").value = "";
  qs("#s-gp-token-hint").textContent = s.has_globalping_token
    ? `已配置：${s.globalping_token_masked}`
    : "未配置（额度 250 点/小时，配置后 500）";
  renderProbeInfo();
}

async function openSettings() {
  qs("#set-err").hidden = true;
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
    if (!d.ok) throw new Error(d.error || "读取失败");
    SETTINGS = d.settings || {};
    fillSettingsForm(SETTINGS);
    setdlg.showModal();
  } catch (e) {
    if (!isMasked(e)) banner("读取设置失败：" + e.message, "error");
  }
}

qs("#s-magic").addEventListener("change", () => {
  const custom = qs("#s-magic").value === MAGIC_CUSTOM;
  qs("#s-magic-custom").hidden = !custom;
  if (custom) qs("#s-magic-custom").focus();
});

qs("#s-gp-token-clear").addEventListener("click", async () => {
  if (!confirm("清除已保存的 Globalping Token？\n额度会回落到 250 点/小时。")) return;
  try {
    const r = await post("/settings", { clear_globalping_token: true });
    if (!r.ok) throw new Error(r.error || "清除失败");
    banner("Token 已清除", "info");
    await loadAll();
    if (setdlg.open) fillSettingsForm(SETTINGS);
  } catch (e) {
    if (!isMasked(e)) banner("清除失败：" + e.message, "error");
  }
});

qs("#setform").addEventListener("submit", async (e) => {
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
    utc_offset_min: qs("#s-utc").value,
    gp_magic: readMagic(),
    gp_limit: qs("#s-limit").value,
    ssl_warn_days: qs("#s-warn").value.trim(),
    slow_ms: qs("#s-slow").value.trim(),
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

/* ── 主题 / 启动 ─────────────────────────────────────────── */

qs("#settings-open").addEventListener("click", openSettings);

qs("#theme").addEventListener("click", () => {
  const dark = document.documentElement.classList.toggle("dark");
  try {
    localStorage.setItem("theme", dark ? "dark" : "light");
  } catch {}
});

for (const b of document.querySelectorAll("[data-close]")) {
  b.addEventListener("click", () => b.closest("dialog")?.close());
}

async function bootstrap() {
  try {
    await loadAll();
    hideLogin();
  } catch (e) {
    if (e.needLogin || e.needSetup) return;
    banner("加载失败：" + e.message, "error");
  }
}

bootstrap();

// 后台每 2 分钟刷新一次；只看当前可见页
setInterval(() => {
  if (document.hidden || !AUTHD) return;
  loadAll().catch(() => {});
}, 120000);

/**
 * 数据层：所有 SQL 集中在此。
 */

import { SCHEMA_STMTS } from "./schema.js";

export const UNGROUPED = "未分组";

/** D1 单条语句最多 100 个绑定参数，留余量按 90 分片。 */
const BIND_CHUNK = 90;

/** 一次 batch 的语句条数上限。 */
export const BATCH_CHUNK = 50;

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 统一的分钟精度时间戳：YYYY-MM-DDTHH:MMZ（无秒无毫秒）。 */
export function minuteIso(t = Date.now()) {
  const ms = typeof t === "number" ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return minuteIso();
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString().slice(0, 16) + "Z";
}

/** 证书剩余天数，读时现算。 */
export const sslDaysLeftSql = (alias = "") =>
  `CAST(julianday(${alias}expires_at) - julianday('now') AS INTEGER)`;

/** 分类 = 显式分类表 ∪ 站点上出现过的 group_name，各带站点数。 */
export async function buildCategories(d) {
  const [cats, used] = await Promise.all([
    d.prepare("SELECT name, sort FROM categories ORDER BY sort, name").all(),
    d
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(group_name), ''), '${UNGROUPED}') AS g, COUNT(*) AS n ` +
          "FROM sites GROUP BY g"
      )
      .all(),
  ]);

  const counts = {};
  for (const r of used.results || []) counts[r.g] = Number(r.n);

  const explicit = new Set((cats.results || []).map((c) => c.name));
  const order = [];
  const seen = new Set();
  for (const c of cats.results || []) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      order.push(c.name);
    }
  }
  for (const r of used.results || []) {
    if (!seen.has(r.g)) {
      seen.add(r.g);
      order.push(r.g);
    }
  }

  return order.map((n) => ({
    name: n,
    count: counts[n] || 0,
    explicit: explicit.has(n),
  }));
}

export async function cleanupOldChecks(env, keepDays = 30) {
  const d = await db(env);
  const cutoff = minuteIso(Date.now() - keepDays * 86400_000);
  const r = await d.prepare("DELETE FROM checks WHERE ts < ?").bind(cutoff).run();
  // 按天汇总保留 100 天（色条上限 90 天 + 余量）。
  const dayCutoff = minuteIso(Date.now() - 100 * 86400_000).slice(0, 10);
  await d.prepare("DELETE FROM checks_daily WHERE day < ?").bind(dayCutoff).run().catch(() => {});
  await d
    .prepare("DELETE FROM rounds WHERE ts < ?")
    .bind(minuteIso(Date.now() - 7 * 86400_000))
    .run()
    .catch(() => {});
  return Number(r?.meta?.changes ?? r?.changes ?? 0);
}

const D1_MISSING =
  "D1 绑定缺失：env.DB 不存在。检查 wrangler.toml 的 [[d1_databases]] 是否已随本次部署生效" +
  "（database_id 为空串时 wrangler 会跳过该绑定）。";

export async function db(env) {
  if (!env || !env.DB) throw new Error(D1_MISSING);
  return env.DB;
}

/* ── 库结构自举 ── */

const SCHEMA_FLAG = "schema_ready";

/** 就绪标记按 D1 绑定记：不同绑定就是不同的库。 */
const schemaReady = new WeakMap();

/**
 * 确保库结构就位。
 * @returns {Promise<{created: boolean}>}
 */
export function ensureSchema(env) {
  const d = env && env.DB;
  if (!d) return Promise.reject(new Error(D1_MISSING));

  const hit = schemaReady.get(d);
  if (hit) return hit;

  const p = applySchema(d);
  schemaReady.set(d, p);
  // 失败不缓存，避免一次抖动让 isolate 余生都返回同一错误。
  p.catch(() => {
    if (schemaReady.get(d) === p) schemaReady.delete(d);
  });
  return p;
}

async function applySchema(d) {
  const flag = await d
    .prepare("SELECT value FROM meta WHERE key = ?")
    .bind(SCHEMA_FLAG)
    .first()
    .catch(() => null);
  if (flag && flag.value === "1") return { created: false };

  for (const stmt of SCHEMA_STMTS) await d.prepare(stmt).run();
  await d
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, '1') " +
        "ON CONFLICT(key) DO UPDATE SET value = '1'"
    )
    .bind(SCHEMA_FLAG)
    .run();
  return { created: true };
}

/* ── 设置 ── */

const SETTINGS_TTL_MS = 30_000;
let settingsCache = null; // { binding, expires, data }

function invalidateSettings() {
  settingsCache = null;
}

export async function loadSettings(env) {
  const d = await db(env);
  const now = Date.now();
  if (settingsCache && settingsCache.binding === d && settingsCache.expires > now) {
    return { ...settingsCache.data };
  }
  const out = {};
  const { results } = await d.prepare("SELECT key, value FROM meta").all();
  for (const r of results || []) out[r.key] = r.value;
  settingsCache = { binding: d, expires: now + SETTINGS_TTL_MS, data: out };
  return { ...out };
}

export async function saveSetting(env, key, value) {
  const d = await db(env);
  invalidateSettings();
  if (value === null || value === undefined || value === "") {
    await d.prepare("DELETE FROM meta WHERE key = ?").bind(key).run();
  } else {
    await d
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .bind(key, String(value))
      .run();
  }
}

/** 批量写设置：一次原子 batch。 */
export async function saveSettings(env, entries) {
  if (!entries || !entries.length) return 0;
  const d = await db(env);
  invalidateSettings();
  const upsert = d.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const del = d.prepare("DELETE FROM meta WHERE key = ?");
  const stmts = entries.map(([k, v]) =>
    v === null || v === undefined || v === "" ? del.bind(k) : upsert.bind(k, String(v))
  );
  await d.batch(stmts);
  return stmts.length;
}

/* ── 站点与明细 ── */

/** 删除站点的全部痕迹，一次原子 batch。 */
export async function deleteSite(env, id) {
  const d = await db(env);
  const tables = ["checks", "checks_daily", "ssl", "state", "pending", "sites"];
  await d.batch(
    tables.map((t) =>
      d.prepare(`DELETE FROM ${t} WHERE ${t === "sites" ? "id" : "site"} = ?`).bind(id)
    )
  );
}

/** 探测用：只取启用的站点。 */
export async function loadSites(env) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT * FROM sites WHERE enabled = 1 ORDER BY sort, id").all();
  return results || [];
}

export async function insertChecks(env, rows) {
  const d = await db(env);
  if (!rows.length) return { stored: 0 };
  const stmt = d.prepare(
    `INSERT INTO checks (ts, site, source, probe, ok, status, ttfb_ms, total_ms, error)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const stmts = rows.map((r) =>
    stmt.bind(
      r.ts,
      r.site,
      r.source,
      r.probe ?? null,
      r.ok ? 1 : 0,
      r.status ?? 0,
      r.ttfb_ms ?? 0,
      r.total_ms ?? 0,
      r.error || null
    )
  );
  for (const part of chunk(stmts, BATCH_CHUNK)) await d.batch(part);
  return { stored: stmts.length };
}

/* ── 状态 ── */

const STATE_UPSERT =
  `INSERT INTO state (site, consecutive_fail, void_streak, last_checked_ts,
     last_ok, last_status, last_ttfb_ms, last_total_ms, last_source, last_probe, last_ts, last_error)
   VALUES (?,?,0,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(site) DO UPDATE SET
     consecutive_fail = excluded.consecutive_fail,
     void_streak      = 0,
     last_checked_ts  = excluded.last_checked_ts,
     last_ok          = excluded.last_ok,
     last_status      = excluded.last_status,
     last_ttfb_ms     = excluded.last_ttfb_ms,
     last_total_ms    = excluded.last_total_ms,
     last_source      = excluded.last_source,
     last_probe       = excluded.last_probe,
     last_ts          = excluded.last_ts,
     last_error       = excluded.last_error`;

const VOID_BUMP =
  `INSERT INTO state (site, void_streak) VALUES (?, 1)
   ON CONFLICT(site) DO UPDATE SET void_streak = MIN(void_streak + 1, 999)`;

const DAY_UPSERT =
  `INSERT INTO checks_daily (site, day, n, ok, max_fail_run) VALUES (?,?,1,?,?)
   ON CONFLICT(site, day) DO UPDATE SET
     n = n + 1,
     ok = ok + excluded.ok,
     max_fail_run = MAX(max_fail_run, excluded.max_fail_run)`;

function lastResultFields(info, nowIso) {
  return [
    info.ok ? 1 : 0,
    Number.isFinite(Number(info.status)) ? Number(info.status) : 0,
    Number.isFinite(Number(info.ttfb)) ? Number(info.ttfb) : null,
    Number.isFinite(Number(info.total)) ? Number(info.total) : null,
    info.source ?? null,
    info.probe ?? null,
    nowIso,
    info.reason ?? null,
  ];
}

/** 更新连续失败计数、结果快照与按天汇总；无结论的站点 void_streak +1。 */
export async function bumpState(env, perSite, voidSites = [], checkedAt) {
  const d = await db(env);
  const ids = Object.keys(perSite);
  const voids = (voidSites || []).filter((s) => s && !perSite[s]);
  if (!ids.length && !voids.length) return;

  const prev = ids.length ? await selectPrevState(d, ids) : {};
  const nowIso = checkedAt || minuteIso();
  const offsetMs = dayOffsetMs(env);
  const batch = [];

  for (const site of ids) {
    const info = perSite[site];
    const p = prev[site];
    const before = Number(p?.consecutive_fail || 0);
    const fail = info.ok ? 0 : before + 1;
    const ts = typeof info.checkedAt === "string" ? info.checkedAt : nowIso;
    const day = dayKey(ts, offsetMs);

    batch.push(d.prepare(STATE_UPSERT).bind(site, fail, ts, ...lastResultFields(info, ts)));

    // 跨日重新计数，与色条口径一致。
    const sameDay = p?.last_checked_ts ? dayKey(p.last_checked_ts, offsetMs) === day : false;
    const runToday = info.ok ? 0 : sameDay ? fail : 1;
    batch.push(d.prepare(DAY_UPSERT).bind(site, day, info.ok ? 1 : 0, runToday));
  }

  for (const site of voids) batch.push(d.prepare(VOID_BUMP).bind(site));

  for (const part of chunk(batch, BATCH_CHUNK)) await d.batch(part);
}

function dayOffsetMs(env) {
  const n = Number(env?.UTC_OFFSET_MIN);
  const min = Number.isFinite(n) ? n : 480;
  return min * 60000;
}

function dayKey(iso, offsetMs) {
  return new Date(Date.parse(iso) + offsetMs).toISOString().slice(0, 10);
}

async function selectPrevState(d, ids) {
  const prev = {};
  for (const part of chunk(ids, BIND_CHUNK)) {
    const ph = part.map(() => "?").join(",");
    const r = await d
      .prepare(`SELECT site, consecutive_fail, last_checked_ts FROM state WHERE site IN (${ph})`)
      .bind(...part)
      .all();
    for (const row of r.results || []) prev[row.site] = row;
  }
  return prev;
}

/** 按站点批量删除（只允许 pending / state）。 */
export async function deleteBySites(env, table, ids) {
  if (!ids.length) return 0;
  const d = await db(env);
  if (table !== "pending" && table !== "state") {
    throw new Error(`deleteBySites: 不支持的表 ${table}`);
  }
  let n = 0;
  for (const part of chunk(ids, BIND_CHUNK)) {
    const ph = part.map(() => "?").join(",");
    const r = await d
      .prepare(`DELETE FROM ${table} WHERE site IN (${ph})`)
      .bind(...part)
      .run();
    n += Number(r?.meta?.changes ?? r?.changes ?? 0);
  }
  return n;
}

/** 只更新最后一次结果快照，不动 consecutive_fail / last_checked_ts（手动测试用）。 */
export async function upsertLastResult(env, row) {
  const d = await db(env);
  await d
    .prepare(
      `INSERT INTO state (site, consecutive_fail, void_streak, last_ok, last_status, last_ttfb_ms,
                          last_total_ms, last_source, last_probe, last_ts, last_error)
       VALUES (?, 0, 0, ?,?,?,?,?,?,?,?)
       ON CONFLICT(site) DO UPDATE SET
         last_ok      = excluded.last_ok,
         last_status  = excluded.last_status,
         last_ttfb_ms = excluded.last_ttfb_ms,
         last_total_ms= excluded.last_total_ms,
         last_source  = excluded.last_source,
         last_probe   = excluded.last_probe,
         last_ts      = excluded.last_ts,
         last_error   = excluded.last_error,
         void_streak  = 0`
    )
    .bind(
      row.site,
      row.ok ? 1 : 0,
      row.status ?? 0,
      row.ttfb_ms ?? null,
      row.total_ms ?? null,
      row.source ?? null,
      row.probe ?? null,
      row.ts,
      row.error ?? null
    )
    .run();
}

/** 手动测试写按天汇总；必须在 insertChecks 之后调用。 */
export async function bumpDailyManual(env, site, ok, ts) {
  const d = await db(env);
  const offsetMs = dayOffsetMs(env);
  const at = ts || minuteIso();
  const today = dayKey(at, offsetMs);
  const dayStart = new Date(Date.parse(`${today}T00:00:00.000Z`) - offsetMs).toISOString();

  let run = 0;
  if (!ok) {
    const r = await d
      .prepare(
        `SELECT COUNT(*) AS n FROM checks INDEXED BY idx_checks_site_ts
         WHERE site = ?1 AND ts >= ?2 AND ok = 0
           AND ts > COALESCE(
             (SELECT MAX(ts) FROM checks WHERE site = ?1 AND ts >= ?2 AND ok = 1),
             ?2
           )`
      )
      .bind(site, dayStart)
      .first();
    run = Math.max(1, Number(r?.n || 0));
  }

  await d.prepare(DAY_UPSERT).bind(site, today, ok ? 1 : 0, run).run();
  return { run };
}

/* ── 证书 ── */

const SSL_UPSERT =
  `INSERT INTO ssl
     (site, checked_ts, authorized, protocol, issuer, subject, key_type, expires_at, error)
   VALUES (?,?,?,?,?,?,?,?,?)
   ON CONFLICT(site) DO UPDATE SET
     checked_ts=excluded.checked_ts, authorized=excluded.authorized,
     protocol=excluded.protocol, issuer=excluded.issuer,
     subject=excluded.subject, key_type=excluded.key_type,
     expires_at=excluded.expires_at,
     error=excluded.error`;

/** 自动探测用：同一站点最多每 6 小时落库一次。 */
const SSL_UPSERT_THROTTLED = `${SSL_UPSERT} WHERE ssl.checked_ts IS NULL OR ssl.checked_ts < ?`;
const SSL_REFRESH_MS = 6 * 3600_000;

function sslParams(siteId, r, ts) {
  return [
    siteId,
    ts,
    r.authorized === null || r.authorized === undefined ? null : Number(r.authorized) ? 1 : 0,
    r.protocol ?? null,
    r.issuer ?? null,
    r.subject ?? null,
    r.key_type ?? null,
    r.expires_at ?? null,
    r.error ?? null,
  ];
}

/** 批量写多站点证书（一次往返）；entries: [[siteId, tlsInfo], ...] */
export async function saveSslBatch(env, entries) {
  if (!entries || !entries.length) return 0;
  const d = await db(env);
  const ts = minuteIso();
  const cutoff = minuteIso(Date.now() - SSL_REFRESH_MS);
  const stmt = d.prepare(SSL_UPSERT_THROTTLED);
  const stmts = entries.map(([siteId, r]) => stmt.bind(...sslParams(siteId, r, ts), cutoff));
  for (const part of chunk(stmts, BATCH_CHUNK)) await d.batch(part);
  return stmts.length;
}

/** 单个站点（后台手动测试）：跳过 6 小时节流。 */
export async function saveSsl(env, siteId, r) {
  const d = await db(env);
  await d.prepare(SSL_UPSERT).bind(...sslParams(siteId, r, minuteIso())).run();
}

/** 清掉站点已不存在的孤儿行。 */
export async function cleanupOrphans(env) {
  const d = await db(env);
  const stmts = ["state", "ssl", "pending", "checks_daily"].map((t) =>
    d.prepare(`DELETE FROM ${t} WHERE site NOT IN (SELECT id FROM sites)`)
  );
  const res = await d.batch(stmts);
  return res.reduce((a, r) => a + Number(r?.meta?.changes ?? r?.changes ?? 0), 0);
}

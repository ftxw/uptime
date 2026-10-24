/**
 * 数据层：所有 SQL 集中在此，路由层不出现裸 SQL。
 */

import { SCHEMA_STMTS, SCHEMA_VERSION } from "./schema.js";
import { MIGRATIONS } from "./migrations.js";

/** 「未分组」的唯一来源 —— SQL 兜底、分组归并、新建默认值都引用它，避免出现幽灵分类。 */
export const UNGROUPED = "未分组";

/** D1 单条语句最多 100 个绑定参数；留余量按 90 分片。 */
const BIND_CHUNK = 90;

/** 一次 batch 的语句条数软上限：控制单次往返耗时与失败范围。 */
export const BATCH_CHUNK = 50;

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 证书剩余天数的唯一算法：读时现算，绝不落库（相对时间一存就过期）。 */
export const sslDaysLeftSql = (alias = "") =>
  `CAST(julianday(${alias}expires_at) - julianday('now') AS INTEGER)`;

/** ssl 表显式列清单（含现算的 days_left） */
export const SSL_COLUMNS_SQL = (alias = "") =>
  `${alias}site, ${alias}checked_ts, ${alias}authorized, ${alias}protocol, ` +
  `${alias}issuer, ${alias}subject, ${alias}key_type, ${alias}expires_at, ` +
  `${sslDaysLeftSql(alias)} AS days_left, ${alias}error`;

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
  // 只在站点上出现、未进分类表的排到末尾
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
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString();
  const r = await d.prepare("DELETE FROM checks WHERE ts < ?").bind(cutoff).run();
  return Number(r?.meta?.changes ?? r?.changes ?? 0);
}

/** D1 绑定缺失的统一文案（db / ensureSchema 共用） */
const D1_MISSING =
  "D1 绑定缺失：env.DB 不存在。检查 wrangler.toml 的 [[d1_databases]] 是否已随本次部署生效" +
  "（database_id 为空串时 wrangler 会跳过该绑定）。";

/** 取 D1 绑定。显式判空，否则报错会出现在下游 .prepare() 上，极难定位。 */
export async function db(env) {
  if (!env || !env.DB) throw new Error(D1_MISSING);
  return env.DB;
}

/* ── 库结构自举 ──────────────────────────────────────────────────────── */

const SCHEMA_KEY = "schema_v";

/**
 * 就绪标记，按 D1 绑定记。存 Promise 而非布尔：并发请求共享同一次建表，
 * 而绑定不同就是不同的库，不能共用一个全局标记。
 */
const schemaReady = new WeakMap();

/**
 * 确保库结构就位。
 *
 * 必须在运行时做：建表原先只在 `npm run deploy` 的 setup 脚本里，而控制台连
 * GitHub 部署时该脚本不会执行 —— Worker 部署成功但每个接口都报 no such table。
 *
 * 代价：每个 isolate 生命周期内多一次单行 D1 读，建表只在库缺结构时发生一次。
 *
 * @returns {Promise<{version:number, migrated:boolean, statements:number, from:number}>}
 *          `from` 是动作之前的版本：-1 = 全新库，0 = 有表但无版本标记的旧库。
 */
export function ensureSchema(env) {
  const d = env && env.DB;
  if (!d) return Promise.reject(new Error(D1_MISSING));

  const hit = schemaReady.get(d);
  if (hit) return hit;

  const p = applySchema(env);
  schemaReady.set(d, p);

  // 失败不缓存：D1 抖动下一刻可能就好了，缓存失败会让 isolate 余生都返回同一错误。
  p.catch(() => {
    if (schemaReady.get(d) === p) schemaReady.delete(d);
  });

  return p;
}

async function applySchema(env) {
  const d = await db(env);
  const have = await readSchemaVersion(d);

  // >= 而非 ===：代码回滚时不该把库版本往回写，否则下次升级会重跑全部迁移。
  if (have >= SCHEMA_VERSION) {
    return { version: have, migrated: false, statements: 0, from: have };
  }

  // 全量 DDL 全是 IF NOT EXISTS，对「七张表缺一张」的旧库同样安全。
  let statements = 0;
  for (const stmt of SCHEMA_STMTS) {
    await d.prepare(stmt).run();
    statements++;
  }

  // have === -1 是全新库，全量 DDL 已建出最新结构，再跑迁移只会撞 duplicate column。
  if (have >= 0) {
    for (const m of MIGRATIONS) {
      if (m.v <= have) continue;
      for (const stmt of m.stmts) {
        try {
          await d.prepare(stmt).run();
        } catch (e) {
          // 列已补过就吞掉；其它错误必须抛，否则会把"迁移失败"伪装成成功。
          if (!/duplicate column name|already exists/i.test(String((e && e.message) || e))) {
            throw e;
          }
        }
        statements++;
      }
    }
  }

  await d
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .bind(SCHEMA_KEY, String(SCHEMA_VERSION))
    .run();

  return { version: SCHEMA_VERSION, migrated: true, statements, from: have };
}

/**
 * 读库里的结构版本：-1 = 无 meta 表（全新库），0 = 有表无版本（旧库），N = 已建。
 * 三者必须区分：全新库跑迁移会撞 duplicate column，旧库跳过迁移会缺列。
 */
async function readSchemaVersion(d) {
  try {
    const r = await d.prepare("SELECT value FROM meta WHERE key = ?").bind(SCHEMA_KEY).first();
    const n = Number(r?.value);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return -1;
  }
}

export async function loadSettings(env) {
  const d = await db(env);
  const out = {};
  const { results } = await d.prepare("SELECT key, value FROM meta").all();
  for (const r of results || []) out[r.key] = r.value;
  return out;
}

export async function saveSetting(env, key, value) {
  const d = await db(env);
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

/** 批量写设置：一次原子 batch，避免 N 次往返和中途失败留下"改了一半"。 */
export async function saveSettings(env, entries) {
  if (!entries || !entries.length) return 0;
  const d = await db(env);
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

/** 删除站点的全部痕迹（一次原子 batch；早先漏了 checks，会让 24h 可用率分母虚高）。 */
export async function deleteSite(env, id) {
  const d = await db(env);
  const tables = ["checks", "ssl", "state", "pending", "sites"];
  await d.batch(
    tables.map((t) =>
      d.prepare(`DELETE FROM ${t} WHERE ${t === "sites" ? "id" : "site"} = ?`).bind(id)
    )
  );
}

/** 探测用：只取启用的站点。后台要看全部时走 buildAdminPayload。 */
export async function loadSites(env) {
  const d = await db(env);
  const { results } = await d
    .prepare("SELECT * FROM sites WHERE enabled = 1 ORDER BY sort, id")
    .all();
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

/** state 的 upsert：一次写完连续失败计数与最后一次结果快照。 */
const STATE_UPSERT =
  `INSERT INTO state (site, consecutive_fail, last_checked_ts,
     last_ok, last_status, last_ttfb_ms, last_total_ms, last_source, last_probe, last_ts, last_error)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(site) DO UPDATE SET
     consecutive_fail = excluded.consecutive_fail,
     last_checked_ts  = excluded.last_checked_ts,
     last_ok          = excluded.last_ok,
     last_status      = excluded.last_status,
     last_ttfb_ms     = excluded.last_ttfb_ms,
     last_total_ms    = excluded.last_total_ms,
     last_source      = excluded.last_source,
     last_probe       = excluded.last_probe,
     last_ts          = excluded.last_ts,
     last_error       = excluded.last_error`;

/** perSite 的 info → 落库数值（缺字段给安全默认值） */
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

/**
 * 更新连续失败计数 + 最后一次结果快照。
 * 必须批量（否则一轮 N 站就是 2N 次往返），且每条都要 .bind() 后入 batch。
 */
export async function bumpState(env, perSite) {
  const d = await db(env);
  const ids = Object.keys(perSite);
  if (!ids.length) return;

  const prev = await selectPrevState(d, ids);
  const nowIso = new Date().toISOString();
  const batch = [];

  for (const site of ids) {
    const info = perSite[site];
    const before = Number(prev[site]?.consecutive_fail || 0);
    const fail = info.ok ? 0 : before + 1;

    batch.push(
      d.prepare(STATE_UPSERT).bind(site, fail, nowIso, ...lastResultFields(info, nowIso))
    );
  }

  for (const part of chunk(batch, BATCH_CHUNK)) await d.batch(part);
}

/** 批量取上一轮的连续失败计数（受 100 参数上限约束，需分片）。 */
async function selectPrevState(d, ids) {
  const prev = {};
  for (const part of chunk(ids, BIND_CHUNK)) {
    const ph = part.map(() => "?").join(",");
    const r = await d
      .prepare(`SELECT site, consecutive_fail FROM state WHERE site IN (${ph})`)
      .bind(...part)
      .all();
    for (const row of r.results || []) prev[row.site] = row;
  }
  return prev;
}

/** 按站点批量删除（分片 IN，避开 100 参数上限）。表名只允许内部表。 */
export async function deleteBySites(env, table, ids) {
  if (!ids.length) return 0;
  const d = await db(env);
  const allowed = new Set(["pending", "state"]);
  if (!allowed.has(table)) throw new Error(`deleteBySites: 不支持的表 ${table}`);
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

/**
 * 只更新最后一次结果快照，不动 consecutive_fail / last_checked_ts。
 * 用于后台手动测试：要能在图表看到，但不能推动调度或累加失败。
 */
export async function upsertLastResult(env, row) {
  const d = await db(env);
  await d
    .prepare(
      `INSERT INTO state (site, consecutive_fail, last_ok, last_status, last_ttfb_ms,
                          last_total_ms, last_source, last_probe, last_ts, last_error)
       VALUES (?, 0, ?,?,?,?,?,?,?,?)
       ON CONFLICT(site) DO UPDATE SET
         last_ok      = excluded.last_ok,
         last_status  = excluded.last_status,
         last_ttfb_ms = excluded.last_ttfb_ms,
         last_total_ms= excluded.last_total_ms,
         last_source  = excluded.last_source,
         last_probe   = excluded.last_probe,
         last_ts      = excluded.last_ts,
         last_error   = excluded.last_error`
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

/** 证书整体覆盖写：证书是一次握手的完整快照，拼旧值反而会半新半旧。 */
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

function sslParams(siteId, r, ts) {
  return [
    siteId,
    ts,
    r.authorized ?? null,
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
  const ts = new Date().toISOString();
  const stmt = d.prepare(SSL_UPSERT);
  const stmts = entries.map(([siteId, r]) => stmt.bind(...sslParams(siteId, r, ts)));
  for (const part of chunk(stmts, BATCH_CHUNK)) await d.batch(part);
  return stmts.length;
}

/** 单个站点的证书结果（后台手动测试等单点场景） */
export async function saveSsl(env, siteId, r) {
  const d = await db(env);
  await d.prepare(SSL_UPSERT).bind(...sslParams(siteId, r, new Date().toISOString())).run();
}

/** 清掉站点已不存在的孤儿行（用 NOT IN 子查询，不占绑定参数）。 */
export async function cleanupOrphans(env) {
  const d = await db(env);
  const stmts = ["state", "ssl", "pending"].map((t) =>
    d.prepare(`DELETE FROM ${t} WHERE site NOT IN (SELECT id FROM sites)`)
  );
  const res = await d.batch(stmts);
  return res.reduce((a, r) => a + Number(r?.meta?.changes ?? r?.changes ?? 0), 0);
}

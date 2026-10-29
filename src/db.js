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
  // 按天汇总每站每天只有 1 行，保留期给足 400 天（色条最多 90 天），
  // 免得改小 check_keep_days 后历史色条也跟着消失。
  const dayCutoff = new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 10);
  await d
    .prepare("DELETE FROM checks_daily WHERE day < ?")
    .bind(dayCutoff)
    .run()
    .catch(() => {});
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
  let backfill = null;
  if (have >= 0) {
    let tokens = null; // 只有语句里真带占位符才去读 meta，否则白多一次读
    for (const m of MIGRATIONS) {
      if (m.v <= have) continue;
      for (const raw of m.stmts) {
        let stmt = raw;
        if (raw.includes("{{")) {
          tokens = tokens || (await migrationTokens(d));
          stmt = raw.replace(/\{\{(\w+)\}\}/g, (all, k) => tokens[k] ?? all);
        }
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
    // v2 的按天汇总回填。失败不能阻断自举：结构已经就位，色条先空白也比整站 500 好。
    if (have < 2) {
      backfill = await backfillDaily(d).catch((e) => ({ error: String((e && e.message) || e) }));
    }
  }

  await d
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .bind(SCHEMA_KEY, String(SCHEMA_VERSION))
    .run();

  return { version: SCHEMA_VERSION, migrated: true, statements, from: have, backfill };
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

/** 迁移语句里的占位符取值（迁移是静态声明，拿不到运行时设置，只能在这里补）。 */
async function migrationTokens(d) {
  let offsetMin = 480;
  try {
    const r = await d.prepare("SELECT value FROM meta WHERE key = 'utc_offset_min'").first();
    const n = Number(r?.value);
    if (Number.isFinite(n) && r?.value !== null && r?.value !== undefined && r?.value !== "") {
      offsetMin = n;
    }
  } catch {
    /* 读不到就用默认值：回填的历史格子可能偏一格，新数据不受影响 */
  }
  return {
    DAY_MOD: `${offsetMin < 0 ? "-" : "+"}${Math.abs(offsetMin)} minutes`,
    SINCE_31D: new Date(Date.now() - 31 * 86400_000).toISOString(),
  };
}

/**
 * 回填上限：超过这个行数就不做历史回填，只让新数据开始累积。
 * 理由 —— 这条 SQL 要扫 6 遍明细（读约 6 倍行数），10 万行 ≈ 60 万行读，
 * 占免费日额度 12%；不限的话一个 20 站的库升级当天就会把读额度打穿，
 * 结果是整库拒绝查询（监控与后台一起挂），比「历史色条变灰」严重得多。
 */
const BACKFILL_MAX_ROWS = 100_000;

/** v1 → v2：把明细分组成按天汇总。连续段用 gaps-and-islands，跨天切断。 */
const backfillSql = (dayMod) => `WITH base AS (
   SELECT site, ts, ok, date(ts, '${dayMod}') AS d FROM checks WHERE ts > '{{SINCE_31D}}'
 ),
 grp AS (SELECT site, d, ok, SUM(ok) OVER (PARTITION BY site, d ORDER BY ts) AS g FROM base),
 runs AS (SELECT site, d, COUNT(*) AS run FROM grp WHERE ok = 0 GROUP BY site, d, g),
 mx AS (SELECT site, d, MAX(run) AS m FROM runs GROUP BY site, d),
 agg AS (SELECT site, d, COUNT(*) AS n, SUM(ok) AS ok FROM base GROUP BY site, d)
 INSERT OR REPLACE INTO checks_daily (site, day, n, ok, max_fail_run)
 SELECT agg.site, agg.d, agg.n, agg.ok, COALESCE(mx.m, 0)
 FROM agg LEFT JOIN mx ON mx.site = agg.site AND mx.d = agg.d`;

/** 返回 { rows, done }: rows 是明细行数，done=false 表示因规模超限被跳过。 */
async function backfillDaily(d) {
  const t = await migrationTokens(d);
  const c = await d.prepare("SELECT COUNT(*) AS n FROM checks WHERE ts > ?").bind(t.SINCE_31D).first();
  const rows = Number(c?.n || 0);
  if (!rows) return { rows: 0, done: true };
  if (rows > BACKFILL_MAX_ROWS) return { rows, done: false };
  await d.prepare(backfillSql(t.DAY_MOD).replace("{{SINCE_31D}}", t.SINCE_31D)).run();
  return { rows, done: true };
}

/**
 * meta 表全量读的 isolate 级缓存。
 *
 * 为什么要有：`fetch` 每一步（认证、缓存 key、读接口）都要 loadSettings，
 * 于是**即便边缘缓存命中，也照样打一次 D1** —— 被别人刷 overview 就等于刷 D1 读额度。
 * 设置是「读极多、写极少」的数据，在本 isolate 内缓存 30 秒完全不影响语义：
 * 写侧（saveSetting/saveSettings）会主动清缓存，本实例立刻看到新值；
 * 其它机房最迟 30 秒跟上，而它们本来就要靠 config_version 换 key。
 *
 * 不带 env 差异：一个 isolate 只服务一个 Worker，缓存按 D1 绑定的对象身份区分。
 */
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
  // 返回副本：调用方（effectiveEnv / 登录失败计数）会就地改对象，不能污染缓存。
  return { ...out };
}

export async function saveSetting(env, key, value) {
  const d = await db(env);
  // 写前先失效：避免并发请求在本函数的 await 窗口里读到旧值并回填缓存。
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

/** 批量写设置：一次原子 batch，避免 N 次往返和中途失败留下"改了一半"。 */
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
  // 写失败也保留失效：下次读回源即可，绝不把旧值留在缓存里。
  await d.batch(stmts);
  return stmts.length;
}

/** 删除站点的全部痕迹（一次原子 batch；早先漏了 checks，会让 24h 可用率分母虚高）。 */
export async function deleteSite(env, id) {
  const d = await db(env);
  // checks_daily 同样要清：漏了它，按天汇总会一直留在库里（读侧看不到，但白占空间，
  // 而且同名 id 重建后会把旧数据当成本站点的历史）。
  const tables = ["checks", "checks_daily", "ssl", "state", "pending", "sites"];
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

/**
 * 「这一轮没拿到结论」的计数 +1。不碰 last_* 与 consecutive_fail ——
 * 我们确实不知道站点当前状态，改写任何结果字段都等于编造数据。
 */
const VOID_BUMP =
  `INSERT INTO state (site, void_streak) VALUES (?, 1)
   ON CONFLICT(site) DO UPDATE SET void_streak = MIN(void_streak + 1, 999)`;

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
 * 更新连续失败计数 + 最后一次结果快照 + 当天的按天汇总，并给「本轮无结论」的站点 +
 * 一次 void_streak。
 *
 * @param perSite  { [siteId]: info } 本轮真正拿到结论的站点
 * @param voidSites string[] 本轮发起了测量但拿不到结论的站点（探针全灭 / 平台故障 / 收取失败）
 *
 * 必须批量（否则一轮 N 站就是 2N 次往返），且每条都要 .bind() 后入 batch。
 */
export async function bumpState(env, perSite, voidSites = [], checkedAt) {
  const d = await db(env);
  const ids = Object.keys(perSite);
  const voids = (voidSites || []).filter((s) => s && !perSite[s]);
  if (!ids.length && !voids.length) return;

  // 上一轮的连续失败计数：用于算「当天连续段」与新的 consecutive_fail。
  const prev = ids.length ? await selectPrevState(d, ids) : {};
  // checkedAt 由调用方给：collectGlobalping 要在同一轮里把「谁在本轮被检查过」回传给 dueSites，
  // 两边若各取一次 now，差几毫秒就够让刚测过的 1 分钟站点被误判为到期。
  const nowIso = checkedAt || new Date().toISOString();
  const offsetMs = dayOffsetMs(env);
  const today = dayKey(nowIso, offsetMs);
  const batch = [];

  for (const site of ids) {
    const info = perSite[site];
    const p = prev[site];
    const before = Number(p?.consecutive_fail || 0);
    const fail = info.ok ? 0 : before + 1;

    batch.push(d.prepare(STATE_UPSERT).bind(site, fail, nowIso, ...lastResultFields(info, nowIso)));

    // 当天连续段：跨过日界就从头数（宁可少标红），否则沿用全局连续数 ——
    // 这样色条与圆点用的是同一个定义，不会出现「圆点红、色条黄」。
    const sameDay = p?.last_checked_ts ? dayKey(p.last_checked_ts, offsetMs) === today : false;
    const runToday = info.ok ? 0 : sameDay ? fail : 1;
    batch.push(d.prepare(DAY_UPSERT).bind(site, today, info.ok ? 1 : 0, runToday));
  }

  // 无结论的站点：只累加 void_streak，不写 checks_daily（那天没有「检查结果」可统计）。
  for (const site of voids) batch.push(d.prepare(VOID_BUMP).bind(site));

  for (const part of chunk(batch, BATCH_CHUNK)) await d.batch(part);
}

/** 当天的按天汇总：次数与成功数累加，连续失败段取当天最大。 */
const DAY_UPSERT =
  `INSERT INTO checks_daily (site, day, n, ok, max_fail_run) VALUES (?,?,1,?,?)
   ON CONFLICT(site, day) DO UPDATE SET
     n = n + 1,
     ok = ok + excluded.ok,
     max_fail_run = MAX(max_fail_run, excluded.max_fail_run)`;

/** 日界：与 SQL 的 date(ts, '+480 minutes') 必须用同一偏移，否则格子会错位一格。 */
function dayOffsetMs(env) {
  const n = Number(env?.UTC_OFFSET_MIN);
  const min = Number.isFinite(n) ? n : 480;
  return min * 60000;
}

function dayKey(iso, offsetMs) {
  return new Date(Date.parse(iso) + offsetMs).toISOString().slice(0, 10);
}

/** 批量取上一轮的连续失败计数与上次检查时间（受 100 参数上限约束，需分片）。 */
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
         -- 手动测出结论就证明「探针链路是通的」，之前攒下的无结论计数当即清零。
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

/**
 * 手动测试也要进「按天汇总」，否则同一个站点会有两套口径：
 * 24h 可用率包含手动测试，而 30 天色条不包含 —— 手动测失败会让可用率掉，色条却不变。
 *
 * 只写 checks_daily，不动 consecutive_fail / last_checked_ts（那是调度用的）。
 */
/**
 * 手动测试写「按天汇总」。
 *
 * 与 bumpState 的区别只有一处、但很要紧：**连续失败段不能用全局 consecutive_fail**。
 * 那列只随自动探测递增（upsertLastResult 刻意不碰它），所以在一个暂时正常的站点上
 * 连点 5 次「测」全失败，每次都算出 `0 + 1 = 1`，永远到不了 fail_threshold（默认 3）——
 * 色条一直是黄的，而「最近检查」里明明是 5 条失败。这正是两套口径。
 *
 * 改成直接数「今天最后一次成功之后连续失败了几条」：
 *   run = SELECT COUNT(*) FROM checks WHERE 今天 AND ok=0 AND ts > 今天最后一次成功的 ts
 * 一条按 (site, ts) 索引的查询就能算出来，且**与自动探测的 checks 明细同源**，
 * 所以「今天手动测了几次、红不红」和详情页列表永远对得上。
 *
 * 前提：本函数必须在 insertChecks **之后**调用（本次结果已落库，数得进去）。
 *
 * @param ts 本次记录的 ts（与写入 checks 的那条一致，避免两处各取一次 now 而跨日界）
 * @returns {{ run: number }} 写入的当天连续失败段
 */
export async function bumpDailyManual(env, site, ok, ts) {
  const d = await db(env);
  const offsetMs = dayOffsetMs(env);
  const at = ts || new Date().toISOString();
  const today = dayKey(at, offsetMs);
  // 当天 00:00 对应的 UTC 时刻：dayKey 反推，不另起一套日期算法。
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
    // 至少算 1：即便这条记录因跨日/索引边界没被数进去，也不能记成"当天没失败过"。
    run = Math.max(1, Number(r?.n || 0));
  }

  await d.prepare(DAY_UPSERT).bind(site, today, ok ? 1 : 0, run).run();
  return { run };
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

/**
 * 自动探测用：同一站点的证书最多每 6 小时落库一次。
 * 证书是分钟级几乎不变的数据，每次探测都写等于白白消耗写额度（每分钟 1 条 × 每站）。
 * 条件放在 UPSERT 的 WHERE 里，不满足时 UPDATE 影响 0 行 —— 不产生写入、也不用额外读。
 */
const SSL_UPSERT_THROTTLED = `${SSL_UPSERT} WHERE ssl.checked_ts IS NULL OR ssl.checked_ts < ?`;
const SSL_REFRESH_MS = 6 * 3600_000;

function sslParams(siteId, r, ts) {
  return [
    siteId,
    ts,
    // 归一化成 0/1：布尔值不是所有 SQLite 绑定层都接受，一旦绑不上，
    // 证书写入会被上层 catch 吞掉，表现为「证书永远不更新」。
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
  const ts = new Date().toISOString();
  const cutoff = new Date(Date.now() - SSL_REFRESH_MS).toISOString();
  const stmt = d.prepare(SSL_UPSERT_THROTTLED);
  const stmts = entries.map(([siteId, r]) => stmt.bind(...sslParams(siteId, r, ts), cutoff));
  for (const part of chunk(stmts, BATCH_CHUNK)) await d.batch(part);
  return stmts.length;
}

/** 单个站点的证书结果（后台手动测试）：用户主动要看，跳过 6 小时节流。 */
export async function saveSsl(env, siteId, r) {
  const d = await db(env);
  await d.prepare(SSL_UPSERT).bind(...sslParams(siteId, r, new Date().toISOString())).run();
}

/** 清掉站点已不存在的孤儿行（用 NOT IN 子查询，不占绑定参数）。 */
export async function cleanupOrphans(env) {
  const d = await db(env);
  const stmts = ["state", "ssl", "pending", "checks_daily"].map((t) =>
    d.prepare(`DELETE FROM ${t} WHERE site NOT IN (SELECT id FROM sites)`)
  );
  const res = await d.batch(stmts);
  return res.reduce((a, r) => a + Number(r?.meta?.changes ?? r?.changes ?? 0), 0);
}

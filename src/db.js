/**
 * 数据层：所有 SQL 集中在这里，路由层不再出现裸 SQL。
 *
 * 好处：① 表结构变化只改这一个文件；② 路由层读起来是"做什么"而不是"怎么查"；
 *      ③ 便于单独审视每条查询是否走索引。
 */

/**
 * 「未分组」的唯一真源。
 *
 * 这个字符串同时出现在 SQL 的分组兜底、分组名归并、以及新建站点的默认值里，
 * 必须统一从这里引用 —— 分散成字面量时，只要有一处写得不一样就会凭空多出一个
 * 「既不是显式分类、也不是未分组」的幽灵分类，而且很难在界面上发现。
 */
export const UNGROUPED = "未分组";

/**
 * D1 硬上限：**单条语句最多 100 个绑定参数**（官方 limits 页）。
 * 站点数一旦过百，任何 `IN (?,?,...)` 都会直接报错 —— 留 10 个余量，按 90 分片。
 *
 * 为什么必须留余量而不是正好 100：以后若在这条语句里再加一个固定参数
 * （比如 `AND enabled = ?`），正好 100 的写法会在同一批站点数下突然越界。
 */
export const BIND_CHUNK = 90;

/**
 * `d.batch()` 里语句条数的软上限。
 *
 * batch 本身不限制长度，但它是**一次**往返里排队的语句集合：条数越多，单次耗时越长。
 * 站点很多时按 50 条一组发，既避免单次超时，也把失败范围限制在一组内。
 */
export const BATCH_CHUNK = 50;

/** 把数组按固定长度切片成若干组 */
export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 「证书还剩几天」的**唯一算法** —— 读的时候现算，绝不落库。
 *
 * 为什么：days_left 是相对时间，写进库里那一刻就开始过期，而证书每天才复核一次。
 * 原先把它存成列，于是「今天到期」的证书要等到第二天的检测跑完才会变红，
 * 中间那 24 小时页面一直显示"剩余 1 天"—— 监控工具在证书这件事上恰好不可信。
 * 现在统一用 expires_at 现算：只要 expires_at 是真的，剩余天数永远是真的。
 *
 * 用 julianday 而不是在 JS 里算：overview / site / admin 三条读路径都走 SQL，
 * 放同一句表达式里才不会出现"某个页面用的是旧值"。
 *
 * @param {string} alias 表别名（含结尾的点），如 "ss."
 */
export const sslDaysLeftSql = (alias = "") =>
  `CAST(julianday(${alias}expires_at) - julianday('now') AS INTEGER)`;

/** ssl 表的显式列清单（含现算的 days_left）—— 供 `SELECT *` 的路径替换用 */
export const SSL_COLUMNS_SQL = (alias = "") =>
  `${alias}site, ${alias}checked_ts, ${alias}authorized, ${alias}protocol, ` +
  `${alias}issuer, ${alias}subject, ${alias}key_type, ${alias}expires_at, ` +
  `${sslDaysLeftSql(alias)} AS days_left, ${alias}error`;

/**
 * 分类列表 = 显式分类 ∪ 站点上出现的 group_name（并集，各带站点计数）。
 * 抽出来是因为 /api/categories 与 /api/admin 都要用，避免两处逻辑漂移。
 */
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
  // 先按 categories 里定义的顺序（这就是后台拖拽出来的顺序）
  for (const c of cats.results || []) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      order.push(c.name);
    }
  }
  // 再把只在站点上出现、但没进分类表的补到末尾
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

/**
 * 清理过期的探测明细。
 *
 * checks 每轮都在写入，不清理会无限膨胀；而展示侧只需要最近 30 天（色条的最长窗口），
 * 更老的记录没有任何用处。表越大，按范围扫描越慢，所以必须定期删。
 *
 * 每天只在一个时点跑一次 —— cron 是每分钟一轮（1440 轮/天），没必要每轮都多一次 DELETE。
 */
export async function cleanupOldChecks(env, keepDays = 30) {
  const d = await db(env);
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString();
  const r = await d.prepare("DELETE FROM checks WHERE ts < ?").bind(cutoff).run();
  return Number(r?.meta?.changes ?? r?.changes ?? 0);
}

/**
 * 取 D1 绑定。
 *
 * ⚠️ 这里必须显式判空：`env.DB` 缺失时若直接返回 undefined，报错会发生在
 *    下游某个 `.prepare()` 上（`Cannot read properties of undefined`），
 *    信息量等于零 —— 排查的人会一路怀疑 SQL、怀疑参数，而真正的原因是
 *    **绑定没生效**（`wrangler.toml` 的 `[[d1_databases]]` 没部署上去、
 *    或 `database_id` 还是空串被 wrangler 跳过了）。
 */
export async function db(env) {
  if (!env || !env.DB) {
    throw new Error(
      "D1 绑定缺失：env.DB 不存在。检查 wrangler.toml 的 [[d1_databases]] 是否已随本次部署生效" +
        "（database_id 为空串时 wrangler 会跳过该绑定）。"
    );
  }
  return env.DB;
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

/**
 * 批量写设置（一次往返）。
 *
 * 保存后台设置原先是「18 个键 → 18 次 `saveSetting()` → 18 个完整 D1 往返」，
 * 跨国链路上就是十几秒的纯等待，而且中途失败会留下「改了一半」的设置。
 * `d.batch()` 是原子的，一次落库要么全成要么全不成。
 *
 * entries: [[key, value], ...]；value 为空串/null/undefined 表示删除该键。
 */
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
  // ⚠️ batch 里每条都必须 .bind() 过 —— 未绑定的语句 D1 会直接报错
  await d.batch(stmts);
  return stmts.length;
}

/**
 * 删除站点的全部痕迹（一次批量、原子）。
 *
 * ① 原先 4 条 DELETE 是**逐条** `run()`：中途失败会留下「state 还在、sites 没了」
 *    这种半删状态，而 `d.batch()` 天然是原子的。
 * ② 原先**漏了 checks**：被删站点的历史行会在保留期内继续计入首页
 *    「24h 可用率」的分子分母，而「监控总数」已经不含它了 —— 两个数字互相矛盾，
 *    且删得越多偏得越远。
 */
export async function deleteSite(env, id) {
  const d = await db(env);
  const tables = ["checks", "ssl", "state", "pending", "sites"];
  await d.batch(tables.map((t) => d.prepare(`DELETE FROM ${t} WHERE ${t === "sites" ? "id" : "site"} = ?`).bind(id)));
}

/** 探测用：只取启用的站点。后台要显示全部（含禁用）时走 buildAdminPayload。 */
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
  // 分组发送：单条语句只有 9 个参数（远低于 100 的绑定上限），
  // 但 batch 的长度没有上限，站点多时一次塞进去会让单次往返变长、失败范围也变大。
  for (const part of chunk(stmts, BATCH_CHUNK)) await d.batch(part);
  return { stored: stmts.length };
}

/**
 * state 的 upsert 语句 —— 一次写完「连续失败计数」与「最后一次结果快照」。
 *
 * 一次测量同时更新两样东西，所以只需要一次 batch：
 *   ① consecutive_fail —— 跨轮次累积，必须落库（不能靠查 checks 现算）
 *   ② last_* —— 最后一次结果的快照，让首页/后台不必为「每站最新一条」去扫 checks
 */
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

/** perSite 里的 info 字段 → 落库需要的数值（缺字段一律给安全默认值） */
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
 * 更新连续失败计数 / 告警标志 + 最后一次结果快照，返回需要告警的站点。
 *
 * ⚠️ 必须**批量**：若每站点各发一次 SELECT + UPSERT，一轮 N 个站点就是 2N 次 D1 往返，
 *    而 Workers 上每次往返都是真实的网络开销 —— 这是定时任务整体耗时的主要来源。
 *    现在压到「1 次 SELECT + 1 次 batch」。
 *
 * ⚠️ 每条语句都必须 .bind() 后进 batch：.bind() 只构造语句、不发起请求，
 *    漏了会静默丢失整个写入（不会报错，也不写任何数据）。
 */
export async function bumpState(env, perSite) {
  const d = await db(env);
  const ids = Object.keys(perSite);
  if (!ids.length) return;

  // ⚠️ 必须分片：`IN (?,?,…)` 的绑定参数上限是 100，站点过百就直接报错。
  //    报错发生在 UPDATE 之前 —— 于是「checks 写进去了、state 一个没更新、
  //    告警一条没发」，页面继续显示旧状态，而且没有任何地方会把这件事说出来。
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

/**
 * 批量取回「上一轮的连续失败计数」，按 BIND_CHUNK 分片查询。
 *
 * 抽成函数是因为它需要分片，而分片逻辑不该散在调用点 ——
 * 否则以后再加一个「按 id 批量读」的地方，很容易又写回一次 `IN (${N个?})`。
 */
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

/**
 * 按站点批量删除（同样受 100 个绑定参数限制）。
 *
 * 用于收完 Globalping 结果后清 pending：逐条 DELETE × N 会多出 N 次 D1 往返，
 * 而一次 IN 又不允许超过 100 个参数 —— 折中是分片 IN。
 */
export async function deleteBySites(env, table, ids) {
  if (!ids.length) return 0;
  const d = await db(env);
  // 表名来自代码常量（只有 pending / state 这类内部表），不接受外部输入
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
 * 只更新「最后一次结果快照」，**不动** consecutive_fail / last_checked_ts。
 *
 * 用于后台手动「测」：手动测试要能在图表中看到（所以要更新 last_*），
 * 但不应该①把自动调度的下次检查时间往后推 ②累加失败计数触发误告警。
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

/** 写入 SSL 结果 */
export async function saveSsl(env, siteId, r) {
  const d = await db(env);
  await d
    .prepare(
      `INSERT INTO ssl
         (site, checked_ts, authorized, protocol, issuer, subject, key_type, expires_at, days_left, error)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(site) DO UPDATE SET
         checked_ts=excluded.checked_ts, authorized=excluded.authorized,
         protocol=excluded.protocol, issuer=excluded.issuer,
         subject=excluded.subject, key_type=excluded.key_type,
         expires_at=excluded.expires_at, days_left=excluded.days_left,
         error=excluded.error`
    )
    .bind(
      siteId,
      new Date().toISOString(),
      r.authorized ?? null,
      r.protocol ?? null,
      r.issuer ?? null,
      r.subject ?? null,
      r.key_type ?? null,
      r.expires_at ?? null,
      // ⚠️ 刻意恒写 NULL：`days_left` 是相对时间，落库即过期（见 sslDaysLeftSql 注释）。
      //    列保留只为兼容旧库（不删列，避免一次无谓的表重建），读侧一律现算。
      null,
      r.error ?? null
    )
    .run();
}

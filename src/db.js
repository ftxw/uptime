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

export async function db(env) {
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
  const batch = rows.map((r) =>
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
  await d.batch(batch);
  return { stored: batch.length };
}

/**
 * state 的 upsert 语句 —— 一次写完「计数」与「最后一次结果快照」。
 *
 * last_ok_ts / last_alert_ts 用 COALESCE(excluded.X, state.X) 是刻意的：
 * 传入 NULL 表示"本次没有新的成功/告警"，应当**保留原值**而不是清空。
 */
const STATE_UPSERT =
  `INSERT INTO state (site, consecutive_fail, last_ok_ts, last_checked_ts, last_alert_ts,
     last_ok, last_status, last_ttfb_ms, last_total_ms, last_source, last_probe, last_ts, last_error)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(site) DO UPDATE SET
     consecutive_fail = excluded.consecutive_fail,
     last_ok_ts       = COALESCE(excluded.last_ok_ts, state.last_ok_ts),
     last_checked_ts  = excluded.last_checked_ts,
     last_alert_ts    = COALESCE(excluded.last_alert_ts, state.last_alert_ts),
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
 * 更新连续失败计数 + 最后一次结果快照，返回需要告警的站点。
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
  if (!ids.length) return [];

  const ph = ids.map(() => "?").join(",");
  const cur = await d
    .prepare(`SELECT site, consecutive_fail FROM state WHERE site IN (${ph})`)
    .bind(...ids)
    .all();
  const prevFail = {};
  for (const r of cur.results || []) prevFail[r.site] = Number(r.consecutive_fail || 0);

  const nowIso = new Date().toISOString();
  const toAlert = [];
  const batch = [];

  for (const site of ids) {
    const info = perSite[site];
    const before = prevFail[site] || 0;
    const fail = info.ok ? 0 : before + 1;

    batch.push(
      d
        .prepare(STATE_UPSERT)
        .bind(site, fail, info.ok ? nowIso : null, nowIso, null, ...lastResultFields(info, nowIso))
    );

    if (info.ok && before >= info.threshold) {
      toAlert.push({ site, kind: "recovered", failCount: before, info });
    } else if (!info.ok && fail === info.threshold) {
      toAlert.push({ site, kind: "down", failCount: fail, info });
    }
  }

  await d.batch(batch);
  return toAlert;
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
      r.days_left ?? null,
      r.error ?? null
    )
    .run();
}

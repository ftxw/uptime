/**
 * 数据层：所有 SQL 集中在这里，路由层不再出现裸 SQL。
 *
 * 好处：① 表结构变化只改这一个文件；② 路由层读起来是"做什么"而不是"怎么查"；
 *      ③ 便于单独审视每条查询是否走索引。
 */

/**
 * 分类列表 = 显式分类 ∪ 站点上出现的 group_name（并集，各带站点计数）。
 * 抽出来是因为 /api/categories 与 /api/admin 都要用，避免两处逻辑漂移。
 */
export async function buildCategories(d) {
  const [cats, used] = await Promise.all([
    d.prepare("SELECT name, sort FROM categories ORDER BY sort, name").all(),
    d
      .prepare(
        "SELECT COALESCE(NULLIF(TRIM(group_name), ''), '未分组') AS g, COUNT(*) AS n " +
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
 * 为什么必须有：checks 每 5 分钟写入一次、且原本**从不清理**，会无限膨胀。
 * 而展示侧只需要 30 天（30 天色条的最长窗口），更老的数据完全没有用处。
 * 不清理的后果是：表越来越大 → 那条「按 site 分组取最新一行」的窗口函数查询
 * 虽然走索引，但仍要全索引扫描，耗时会随数据量线性增长。
 *
 * 只在每天的一个固定时点跑一次（cron 是每 5 分钟一轮，288 轮/天），
 * 避免每轮都多一次 DELETE 开销。
 */
export async function cleanupOldChecks(env, keepDays = 30) {
  const d = await db(env);
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString();
  const r = await d.prepare("DELETE FROM checks WHERE ts < ?").bind(cutoff).run();
  return Number(r?.meta?.changes ?? r?.changes ?? 0);
}

export async function db(env) {
  return env && env.DB;
}

export async function loadSettings(env) {
  const out = {};
  try {
    const d = await db(env);
    const { results } = await d.prepare("SELECT key, value FROM meta").all();
    for (const r of results || []) out[r.key] = r.value;
  } catch {}
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

/** 更新连续失败计数，必要时返回需要告警的站点 */
export async function bumpState(env, perSite) {
  const d = await db(env);
  const toAlert = [];
  for (const [site, info] of Object.entries(perSite)) {
    const cur = await d
      .prepare("SELECT * FROM state WHERE site = ?")
      .bind(site)
      .first();
    const fail = info.ok ? 0 : Number(cur?.consecutive_fail || 0) + 1;
    const nowIso = new Date().toISOString();
    await d
      .prepare(
        `INSERT INTO state (site, consecutive_fail, last_ok_ts, last_checked_ts, last_alert_ts)
         VALUES (?,?,?,?,?)
         ON CONFLICT(site) DO UPDATE SET
           consecutive_fail = excluded.consecutive_fail,
           last_ok_ts = COALESCE(excluded.last_ok_ts, state.last_ok_ts),
           last_checked_ts = excluded.last_checked_ts,
           last_alert_ts = COALESCE(excluded.last_alert_ts, state.last_alert_ts)`
      )
      .bind(site, fail, info.ok ? nowIso : null, nowIso, null)
      .run(); // ⚠️ 必须 .run()：.bind() 只构造语句、不执行，且不会报错（静默丢失）

    // 恢复通知
    if (info.ok && Number(cur?.consecutive_fail || 0) >= info.threshold) {
      toAlert.push({ site, kind: "recovered", failCount: cur.consecutive_fail, info });
    } else if (!info.ok && fail === info.threshold) {
      toAlert.push({ site, kind: "down", failCount: fail, info });
    }
  }
  return toAlert;
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

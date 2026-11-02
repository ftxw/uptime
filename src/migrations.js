/**
 * 增量迁移：给旧库补结构（新库直接按 schema.sql 建）。
 * 改结构时：schema.sql + 版本号 +1 + 这里追加 { v, stmts } + npm run schema。
 * 语句必须幂等，且只能做「不重建表」的操作。
 * v2 的数据回填按行数决定是否执行，见 db.js 的 backfillDaily。
 */
export const MIGRATIONS = [
  {
    v: 2,
    stmts: ["DROP INDEX IF EXISTS idx_checks_ok_ts_site"],
  },
  {
    // 探针「无结论」计数。旧库补列后全部为 0，等价于「目前没有观察到静默」。
    v: 3,
    stmts: ["ALTER TABLE state ADD COLUMN void_streak INTEGER NOT NULL DEFAULT 0"],
  },
  {
    // 计划的下一次发起时刻。旧库补列后为 NULL，dueSites 会按 last_checked_ts 补算一次，
    // 所以升级当轮不会把所有站点一起重发。
    v: 4,
    stmts: ["ALTER TABLE state ADD COLUMN next_due_ts TEXT"],
  },
  {
    // 两条读路径的索引（纯新增，IF NOT EXISTS，重复执行安全）：
    // ① (site, ts DESC, ok)：24h 聚合从「按站点回表扫 576 行」变成 index-only；
    // ② checks_daily(day)：色条/统计的 WHERE day >= ? 不再全表扫。
    v: 5,
    stmts: [
      "CREATE INDEX IF NOT EXISTS idx_checks_site_ts_ok ON checks(site, ts DESC, ok)",
      "CREATE INDEX IF NOT EXISTS idx_daily_day ON checks_daily(day)",
    ],
  },
];

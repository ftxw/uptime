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
];

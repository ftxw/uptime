/**
 * 增量迁移：给已存在的旧库补结构。
 *
 * schema.sql 全是 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`，
 * 对「表在但索引不对」「表在但没有数据」无效，旧库靠这里补。
 * 全新库不跑迁移（全量 DDL 已是最新结构）。
 *
 * 加一条：schema.sql 改结构 + 版本号 +1 + 这里追加 `{ v, stmts }` + npm run schema。
 * 语句必须幂等，且只写「不重建表」的安全操作 —— SQLite 删列/改列要重建整表，
 * 一次失败就是全站 500，不适合在请求路径上自动做。
 *
 * ⚠️ v2 的数据回填不在这个数组里：它按库里实际行数决定跑不跑（见 db.js 的
 * backfillDaily），静态语句没有这个判断能力。
 */
export const MIGRATIONS = [
  {
    v: 2,
    stmts: ["DROP INDEX IF EXISTS idx_checks_ok_ts_site"],
  },
];

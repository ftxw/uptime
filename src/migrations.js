/**
 * 增量迁移：给已存在的旧库补结构。
 *
 * schema.sql 全是 `CREATE TABLE IF NOT EXISTS`，对「表已存在但少一列」无效；
 * 旧库靠这里补列。全新库不需要，ensureSchema 只在库已有 meta 表时才跑。
 *
 * 加一条：schema.sql 改结构 + 版本号 +1 + 这里追加 `{ v, stmts }` + npm run schema。
 * 语句必须幂等（duplicate column 会被吞掉）；只写 ADD COLUMN 这类安全操作 ——
 * SQLite 删列要重建表，不适合在请求路径上自动做。
 */
export const MIGRATIONS = [
  // 暂无。改造时删掉的三列（probe_kind / keyword / alerted / days_left / created_ts）
  // 旧库里留着也不影响运行：代码不再读写它们。
];

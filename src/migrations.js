/**
 * 增量迁移：给**已经存在**的旧库补结构。
 *
 * 为什么需要它：schema.sql 里的建表语句全是 `CREATE TABLE IF NOT EXISTS`，
 * 对「表已存在但少一列」这种情况**什么都不做**。于是给一个跑了一段时间的库加字段时，
 * 新库建得出来、旧库却会在运行时报 `no such column`。
 *
 * 全新库不需要这些 —— 它直接按 schema.sql 的完整定义建表，所以 `ensureSchema`
 * 只在「库里已经有 meta 表」时才跑迁移。
 *
 * 怎么加一条：
 *   1. `schema.sql` 里改结构，并把顶部的 `-- schema-version:` 加 1
 *   2. 在这里追加 `{ v: 新版本号, stmts: ["ALTER TABLE ...", ...] }`
 *   3. `npm run schema` 重新生成 src/schema.js
 *
 * 注意：
 *   - 每条语句都必须**幂等**。重复执行会撞 `duplicate column name`，
 *     `ensureSchema` 会吞掉这类错误（说明这一列已经补过了），其它错误照常抛。
 *   - 只写 `ALTER TABLE ... ADD COLUMN` 这类安全操作。SQLite 删列/改类型要重建表，
 *     不适合在请求路径上自动做 —— 那种变更应当人工处理。
 *   - 列上加 NOT NULL 必须同时给 DEFAULT，否则已有行无法填充。
 */
export const MIGRATIONS = [
  // 目前是 v1：改造时只删了列（probe_kind / keyword / alerted），没有加列。
  // 旧库里多出来的列不影响运行 —— 代码不再读写它们，也不需要 DROP。
];

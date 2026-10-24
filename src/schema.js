/**
 * ⚠️ 生成文件，请勿手工编辑。
 *
 * 来源：schema.sql（改表结构请改那边，然后跑 `npm run schema`）
 * 生成器：scripts/gen-schema.mjs
 *
 * 为什么不在运行时直接读 schema.sql：Worker 的包里没有文件系统，
 * 而 Wrangler 的 module rules 实测不会把 .sql 内联进产物。生成 JS 数组是
 * 零构建配置依赖、且 dev / deploy 行为一致的方案。
 *
 * `SCHEMA_STMTS` 已按 SQL 语法切好（跳过注释、正确处理字符串内的分号），
 * 每条都是可单独 `.run()` 的完整语句，顺序即依赖顺序（先建表、后建索引）。
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_STMTS = [
  "CREATE TABLE IF NOT EXISTS sites (\n  id             TEXT PRIMARY KEY,\n  name           TEXT NOT NULL,\n  url            TEXT NOT NULL,\n  group_name     TEXT,\n  expect_codes   TEXT,\n  hide_url       INTEGER NOT NULL DEFAULT 0,\n  fail_threshold INTEGER NOT NULL DEFAULT 3,\n  interval_min   INTEGER NOT NULL DEFAULT 5,\n  enabled        INTEGER NOT NULL DEFAULT 1,\n  sort           INTEGER NOT NULL DEFAULT 0,\n  created_ts     TEXT\n)",
  "CREATE TABLE IF NOT EXISTS checks (\n  site     TEXT NOT NULL,\n  ts       TEXT NOT NULL,\n  source   TEXT,\n  probe    TEXT,\n  ok       INTEGER NOT NULL,\n  status   INTEGER,\n  ttfb_ms  INTEGER,\n  total_ms INTEGER,\n  error    TEXT\n)",
  "CREATE INDEX IF NOT EXISTS idx_checks_site_ts ON checks(site, ts DESC)",
  "CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts DESC)",
  "CREATE INDEX IF NOT EXISTS idx_checks_ok_ts_site ON checks(ok, ts, site)",
  "CREATE TABLE IF NOT EXISTS state (\n  site             TEXT PRIMARY KEY,\n  consecutive_fail INTEGER NOT NULL DEFAULT 0,\n  last_checked_ts  TEXT,\n  last_ok          INTEGER,\n  last_status      INTEGER,\n  last_ttfb_ms     INTEGER,\n  last_total_ms    INTEGER,\n  last_source      TEXT,\n  last_probe       TEXT,\n  last_ts          TEXT,\n  last_error       TEXT\n)",
  "CREATE TABLE IF NOT EXISTS pending (\n  site           TEXT PRIMARY KEY,\n  measurement_id TEXT NOT NULL,\n  source         TEXT,\n  created_ts     TEXT\n)",
  "CREATE TABLE IF NOT EXISTS ssl (\n  site       TEXT PRIMARY KEY,\n  checked_ts TEXT,\n  authorized INTEGER,\n  protocol   TEXT,\n  issuer     TEXT,\n  subject    TEXT,\n  key_type   TEXT,\n  expires_at TEXT,\n  days_left  INTEGER,\n  error      TEXT\n)",
  "CREATE TABLE IF NOT EXISTS categories (\n  name       TEXT PRIMARY KEY,\n  sort       INTEGER NOT NULL DEFAULT 0,\n  created_ts TEXT\n)",
  "CREATE TABLE IF NOT EXISTS meta (\n  key   TEXT PRIMARY KEY,\n  value TEXT\n)",
];

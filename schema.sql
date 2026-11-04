-- 结构唯一真源。改完跑 `npm run schema` 生成 src/schema.js。
-- 所有语句都是 IF NOT EXISTS，Worker 首次请求时自动建表。

CREATE TABLE IF NOT EXISTS sites (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  url            TEXT NOT NULL,
  group_name     TEXT,                -- 所属分类；空 = 未分组
  expect_codes   TEXT,                -- "200,301"；空 = 接受 2xx/3xx
  hide_url       INTEGER NOT NULL DEFAULT 0,  -- 1 = 前台下发 url:null
  fail_threshold INTEGER NOT NULL DEFAULT 3,  -- 连续失败几次判故障
  interval_min   INTEGER NOT NULL DEFAULT 5,
  enabled        INTEGER NOT NULL DEFAULT 1,
  sort           INTEGER NOT NULL DEFAULT 0
);

-- 探测明细，按 check_keep_days 清理。ts 为分钟精度。
CREATE TABLE IF NOT EXISTS checks (
  site     TEXT NOT NULL,
  ts       TEXT NOT NULL,
  source   TEXT,                      -- 'gp:CN+datacenter-network'
  probe    TEXT,                      -- city/asn
  ok       INTEGER NOT NULL,
  status   INTEGER,
  ttfb_ms  INTEGER,
  total_ms INTEGER,
  error    TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_site_ts ON checks(site, ts DESC);
CREATE INDEX IF NOT EXISTS idx_checks_ts_site_ok ON checks(ts DESC, site, ok);
CREATE INDEX IF NOT EXISTS idx_checks_site_ts_ok ON checks(site, ts DESC, ok);

-- 按天物化汇总，色条与按天统计的唯一数据源。
CREATE TABLE IF NOT EXISTS checks_daily (
  site         TEXT NOT NULL,
  day          TEXT NOT NULL,        -- YYYY-MM-DD，按 utc_offset_min 划分
  n            INTEGER NOT NULL DEFAULT 0,
  ok           INTEGER NOT NULL DEFAULT 0,
  max_fail_run INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_day ON checks_daily(day);

-- 运行态。last_* 是最后一次结果的反范式缓存。
-- last_checked_ts 记上一次发起，是排期的唯一来源（见 index.js 的 isDue）。
CREATE TABLE IF NOT EXISTS state (
  site             TEXT PRIMARY KEY,
  consecutive_fail INTEGER NOT NULL DEFAULT 0,
  void_streak      INTEGER NOT NULL DEFAULT 0,  -- 连续「拿不到结论」的轮数
  last_checked_ts  TEXT,
  last_ok          INTEGER,
  last_status      INTEGER,
  last_ttfb_ms     INTEGER,
  last_total_ms    INTEGER,
  last_source      TEXT,
  last_probe       TEXT,
  last_ts          TEXT,
  last_error       TEXT
);

-- 两阶段探测的待收结果：本轮发起，下轮收取。
CREATE TABLE IF NOT EXISTS pending (
  site           TEXT PRIMARY KEY,
  measurement_id TEXT NOT NULL,
  source         TEXT,
  created_ts     TEXT
);

-- 证书随同一次测量写入；剩余天数不落库，读时现算。
CREATE TABLE IF NOT EXISTS ssl (
  site       TEXT PRIMARY KEY,
  checked_ts TEXT,
  authorized INTEGER,
  protocol   TEXT,
  issuer     TEXT,
  subject    TEXT,
  key_type   TEXT,
  expires_at TEXT,
  error      TEXT
);

-- 显式分类表，支持空分类与排序；站点归属仍存 sites.group_name。
CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY,
  sort INTEGER NOT NULL DEFAULT 0
);

-- 后台可改的设置与内部量（config_version / session_secret 等）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 每轮 cron 的调度事实，保留 7 天。时间戳保留毫秒（delay_ms 依赖它）。
CREATE TABLE IF NOT EXISTS rounds (
  ts          TEXT PRIMARY KEY,
  sched_ts    TEXT,
  delay_ms    INTEGER,
  dur_ms      INTEGER,
  due_n       INTEGER,
  started_n   INTEGER,
  failed_n    INTEGER,
  collected_n INTEGER,
  skipped_n   INTEGER,
  err         TEXT
);

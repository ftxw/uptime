-- uptime 数据模型：sites / checks / state / pending / ssl / categories / meta
--
-- 本文件是结构唯一真源，但 Worker 读不到它。`scripts/gen-schema.mjs` 生成
-- `src/schema.js` 供代码 import，那份是生成物不要手改。
--
-- 改结构时：版本号 +1，并在 src/migrations.js 补一条增量迁移（旧库才需要）。
-- schema-version: 1

CREATE TABLE IF NOT EXISTS sites (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  url            TEXT NOT NULL,
  group_name     TEXT,                -- 所属分类；空 = 未分组
  expect_codes   TEXT,                -- "200,301"；空 = 接受 2xx/3xx
  -- 1 = 前台不下发 url，也不渲染「打开站点」按钮（站点仍在监测，只是地址不公开）
  hide_url       INTEGER NOT NULL DEFAULT 0,
  fail_threshold INTEGER NOT NULL DEFAULT 3,  -- 连续失败几次判故障
  interval_min   INTEGER NOT NULL DEFAULT 5,  -- 期望检查间隔（分钟）
  enabled        INTEGER NOT NULL DEFAULT 1,
  sort           INTEGER NOT NULL DEFAULT 0
);

-- 探测明细，按 check_keep_days 清理。
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
-- 查询只有两种形态：「按站点取一段」与「按站点取最新」，故以 (site, ts) 为主力索引。
CREATE INDEX IF NOT EXISTS idx_checks_site_ts ON checks(site, ts DESC);
CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts DESC);
-- 取失败行专用：ok 放最左，让这类查询只读稀疏的失败行而非整段时间。
CREATE INDEX IF NOT EXISTS idx_checks_ok_ts_site ON checks(ok, ts, site);

-- 运行态。last_* 是最后一次结果的反范式缓存，避免每次展示都对 checks 跑窗口函数。
-- last_checked_ts 供调度（只记自动探测）；last_ts 供展示（含手动测试）。
CREATE TABLE IF NOT EXISTS state (
  site             TEXT PRIMARY KEY,
  consecutive_fail INTEGER NOT NULL DEFAULT 0,
  last_checked_ts  TEXT,
  last_ok          INTEGER,  -- 1 正常 / 0 故障
  last_status      INTEGER,
  last_ttfb_ms     INTEGER,
  last_total_ms    INTEGER,
  last_source      TEXT,
  last_probe       TEXT,
  last_ts          TEXT,
  last_error       TEXT
);

-- 两阶段探测的待收结果：每个站点 2 个子请求（本轮发起、下轮收取），不轮询。
CREATE TABLE IF NOT EXISTS pending (
  site           TEXT PRIMARY KEY,
  measurement_id TEXT NOT NULL,
  source         TEXT,
  created_ts     TEXT
);

-- 证书随可用性探测顺带写入（Globalping 结果里带 tls），零额外额度。
-- 剩余天数不落库：相对时间一存就过期，读侧用 julianday 现算（db.sslDaysLeftSql）。
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

-- 显式分类表：支持空分类与自定义排序，站点归属仍存 sites.group_name。
CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY,
  sort INTEGER NOT NULL DEFAULT 0
);

-- 后台可改的设置与内部量（config_version / session_secret 等）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

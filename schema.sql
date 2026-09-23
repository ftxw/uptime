-- uptime-v2 数据模型
--
-- 表名不再带 v2_ 前缀 —— 那个前缀只是为了和早期 v1 的 sites/checks 共存，
-- 现在 v1 表已废弃，前缀只会让每条 SQL 都变长、变难读。

-- ── 监测目标 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  url            TEXT NOT NULL,
  group_name     TEXT,                -- 所属分类；NULL/空 = 未分组
  probe_kind     TEXT,                -- 'cf' | 'globalping'；NULL = 继承全局默认
  cf_hint        TEXT,                -- CF 探测区域组，如 apac / apac-ne / apac-se
  gp_magic       TEXT,                -- Globalping 位置筛选，如 CN+datacenter-network
  expect_codes   TEXT,                -- 逗号分隔，如 "200,301"；空 = 接受 2xx/3xx
  keyword        TEXT,                -- 正文关键字校验（防"200 但内容是错误页"）
  fail_threshold INTEGER NOT NULL DEFAULT 3,  -- 连续失败多少次才判故障/告警
  interval_min   INTEGER NOT NULL DEFAULT 5,  -- 期望检查间隔（分钟）
  enabled        INTEGER NOT NULL DEFAULT 1,
  sort           INTEGER NOT NULL DEFAULT 0,
  created_ts     TEXT
);

-- ── 探测结果明细 ──────────────────────────────────────────
-- 保留 30 天（30 天色条的最长窗口），由 cron 每天清理一次。
CREATE TABLE IF NOT EXISTS checks (
  site     TEXT NOT NULL,
  ts       TEXT NOT NULL,
  source   TEXT,                      -- 'cf:apac' / 'gp:CN+datacenter-network'
  probe    TEXT,                      -- 具体探针：机房代码(colo) 或 city/asn
  ok       INTEGER NOT NULL,
  status   INTEGER,
  ttfb_ms  INTEGER,
  total_ms INTEGER,
  error    TEXT
);
-- 几乎所有查询都是「按站点取一段时间」或「按站点取最新一条」，
-- 所以 (site, ts DESC) 是主力索引；单独的 ts 用于清理与全局统计。
CREATE INDEX IF NOT EXISTS idx_checks_site_ts ON checks(site, ts DESC);
CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts DESC);

-- ── 每站点运行态 ──────────────────────────────────────────
-- 单独一张表是因为「连续失败计数」必须跨轮次累积，不能靠查 checks 现算。
CREATE TABLE IF NOT EXISTS state (
  site             TEXT PRIMARY KEY,
  consecutive_fail INTEGER NOT NULL DEFAULT 0,
  last_checked_ts  TEXT,
  last_ok_ts       TEXT,
  last_alert_ts    TEXT
);

-- ── Globalping 两阶段探测的待收结果 ──────────────────────
-- 为什么不轮询等待：Workers 免费计划每次调用最多 50 个子请求，轮询几下就吃光额度。
-- 两阶段把每个站点压到 2 个子请求（本轮发起、下轮收取）。
CREATE TABLE IF NOT EXISTS pending (
  site           TEXT PRIMARY KEY,
  measurement_id TEXT NOT NULL,
  source         TEXT,
  created_ts     TEXT
);

-- ── SSL 证书 ──────────────────────────────────────────────
-- 单独存且低频查：Worker 的 fetch 不暴露对端证书，而 Globalping 的 HTTP 结果带完整
-- 证书链信息。所以证书统一走 Globalping，每站点每天查一次即可（证书不会 5 分钟变一次）。
CREATE TABLE IF NOT EXISTS ssl (
  site       TEXT PRIMARY KEY,
  checked_ts TEXT,
  authorized INTEGER,
  protocol   TEXT,
  issuer     TEXT,
  subject    TEXT,
  key_type   TEXT,
  expires_at TEXT,
  days_left  INTEGER,
  error      TEXT
);

-- ── 分类 ──────────────────────────────────────────────────
-- 站点归属存在 sites.group_name；这里额外维护"显式分类表"，
-- 是为了支持 ① 空分类（还没站点也先建好）② 分类自身的显示顺序。
CREATE TABLE IF NOT EXISTS categories (
  name       TEXT PRIMARY KEY,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_ts TEXT
);

-- ── 全局键值配置 ──────────────────────────────────────────
-- 两类用途：① 后台可改的站点设置 ② 内部量（config_version / session_secret 等）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

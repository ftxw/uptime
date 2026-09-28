-- uptime 数据模型
--
-- 七张表：sites 站点配置 · checks 探测明细 · state 运行态 · pending 待收结果
--        ssl 证书 · categories 分类 · meta 全局键值

-- ── 监测目标 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  url            TEXT NOT NULL,
  group_name     TEXT,                -- 所属分类；NULL/空 = 未分组
  probe_kind     TEXT,                -- 'cf' | 'globalping'；NULL = 继承全局默认
  -- 位置（CF 区域组 / Globalping 筛选）是**全局设置**，不在这里。
  -- 一个站点只解析出唯一后端，站点级放两份位置必然只有一份生效，是死配置。
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

-- 专门给「取一段时间内的失败」用。
-- 失败是稀疏的（正常情况下百万行里只有个位数），把 ok 放在最左列后，
-- 这类查询只读匹配到的失败行，而不是整段时间的全部检查；
-- 30 天可用率色条判断「当天有没有真的连续故障」就靠它，成本与失败次数成正比。
-- 末列带 site 是为了让单站点查询（详情页）也能走索引而不回表。
CREATE INDEX IF NOT EXISTS idx_checks_ok_ts_site ON checks(ok, ts, site);

-- ── 每站点运行态 ──────────────────────────────────────────
-- 单独一张表是因为「连续失败计数」必须跨轮次累积，不能靠查 checks 现算。
--
-- last_* 这几列是**最后一次探测结果的反范式缓存**：
-- 展示侧（首页概览、后台列表）几乎每次都要「每个站点的最新一条」。
-- 反范式到 state 后，读侧变成纯主键 LEFT JOIN，代价 O(站点数)，与历史数据量无关；
-- 若改成对 checks 跑窗口函数 ROW_NUMBER() OVER (PARTITION BY site ORDER BY ts DESC)，
-- 那就是全表分区排序，站点数与保留天数一涨，每次请求都要扫几万行。
-- 写入侧在同一个 INSERT ... ON CONFLICT 里顺手带上，成本可忽略。
--
-- ⚠️ last_checked_ts 与 last_ts 是两个不同语义：
--    last_checked_ts  调度用：上次「自动探测」完成的时刻，决定下次是否到期
--    last_ts          展示用：最后一次结果的时刻（**含**后台手动「测」）
--    手动测试刻意不更新前者（否则会把自动调度往后推），但会更新后者以便图表能看到。
CREATE TABLE IF NOT EXISTS state (
  site             TEXT PRIMARY KEY,
  consecutive_fail INTEGER NOT NULL DEFAULT 0,
  last_checked_ts  TEXT,
  last_ok_ts       TEXT,
  last_alert_ts    TEXT,
  -- ↓ 最后一次探测结果的快照（含手动测试）
  last_ok          INTEGER,  -- 1 正常 / 0 故障
  last_status      INTEGER,
  last_ttfb_ms     INTEGER,
  last_total_ms    INTEGER,
  last_source      TEXT,     -- 'cf:apac' / 'gp:CN+datacenter-network'
  last_probe       TEXT,     -- 机房代码(colo) 或 city/asn
  last_ts          TEXT,
  last_error       TEXT
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

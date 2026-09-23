/**
 * uptime-v2 —— 站点监测编排层
 *
 * 核心设计：
 *   ① 探测后端可插拔（cf / globalping / auto），按站点配置选择，可自动降级
 *   ② CF 探测走 Durable Object + locationHint（cron 也能锁区域）
 *   ③ Globalping 走「两阶段」：本轮发起测量、下一轮收取结果
 *      —— 因为 Workers 免费计划每次调用最多 50 个子请求，
 *         轮询等待几下就吃光了；两阶段把每站点压到 2 个子请求
 */

import { db, loadSettings, saveSetting, loadSites, insertChecks, bumpState, buildCategories, cleanupOldChecks, saveSsl } from "./db.js";
import { Prober } from "./prober.js";
import {
  REGION_GROUPS,
  siteOf,
  judge,
  normalizeUrl,
  zhError,
  SSL_WARN_DAYS,
  runAllDirect,
  gpCreate,
  gpCollect,
  gpSslCheck,
} from "./probe.js";
import {
  constantTimeEqual,
  hashPassword,
  verifyPasswordHash,
  issueSession,
  verifySession,
  getSessionToken,
  buildSessionCookie,
  clearSessionCookie,
  createRateLimiter,
  randomHex,
  sleep,
} from "./auth.js";

export { Prober };

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/**
 * 只读接口的默认缓存策略。
 *
 * 为什么必须加：实测从西安访问本 Worker，TLS 之后 Worker+D1 还要 ~200ms，
 * 而数据本来 5 分钟才更新一次 —— 完全没必要每次都回源。
 * 加 s-maxage 后 CF 边缘会缓存，命中时省掉 Worker 执行 + D1 查询。
 *
 * stale-while-revalidate 让边缘先返回旧值再后台刷新，用户永远不等。
 */
const READ_CACHE = "public, s-maxage=30, stale-while-revalidate=120";

/** 默认输出紧凑 JSON（省流量）；调试时加 &pretty=1 才缩进 */
const json = (o, status = 200, cache = "no-store", pretty = false) =>
  new Response(pretty ? JSON.stringify(o, null, 2) : JSON.stringify(o), {
    status,
    headers: { ...JSON_HEADERS, "Cache-Control": cache },
  });

/**
 * 用 Cache API 做边缘缓存。
 *
 * ⚠️ 实测结论：**光加 `Cache-Control: public, s-maxage=...` 不会让 CF 缓存 Worker 响应**
 *    —— 响应头里根本不会出现 `cf-cache-status`，因为 Worker 路由下 Worker 就是源站，
 *    边缘缓存不会自动介入。必须显式用 Cache API。
 *
 * 收益：命中时跳过 Worker 执行 + D1 查询。实测暖连接下单次请求 0.39s，
 *      其中约 0.19s 是 Worker+D1，缓存命中后这部分直接省掉。
 * 注意：`caches.default` 是**机房本地**缓存，不是全局 CDN 缓存。
 */
async function withEdgeCache(request, ctx, ttl, producer, keyUrl) {
  const key = new Request(keyUrl || request.url, { method: "GET" });
  const cache = caches.default;
  try {
    const hit = await cache.match(key);
    if (hit) {
      const text = await hit.text();
      return new Response(text, {
        status: 200,
        headers: {
          ...JSON_HEADERS,
          "Cache-Control": `public, s-maxage=${ttl}`,
          "x-edge-cache": "HIT",
        },
      });
    }
  } catch {}

  const res = await producer();
  const text = await res.text();
  const headers = {
    ...JSON_HEADERS,
    "Cache-Control": `public, s-maxage=${ttl}`,
  };
  // ⚠️ 这里必须 await 而不是 ctx.waitUntil：
  //    写接口的 purgeOverview() 会 delete 同一个 key。若 PUT 是异步的，
  //    就可能出现「delete 先执行（当时 key 还不存在）→ PUT 随后落地」，
  //    于是后台改完分类/顺序后前台仍读到旧值，最坏要等 TTL 过期。
  //    实测正是踩到这个竞态。PUT 是机房本地操作，同步等待的成本可忽略。
  try {
    await cache.put(key, new Response(text, { status: 200, headers }));
  } catch {}
  return new Response(text, { status: 200, headers: { ...headers, "x-edge-cache": "MISS" } });
}

/** 读当前配置版本 —— 用于拼 overview / site 详情的缓存 key */
async function configVersion(env) {
  try {
    const d = await db(env);
    const r = await d
      .prepare("SELECT value FROM meta WHERE key = 'config_version'")
      .first();
    return r && r.value ? String(r.value) : "0";
  } catch {
    return "0";
  }
}

/** 写操作后递增配置版本 —— 让所有机房的旧缓存 key 立即失效 */
async function bumpConfigVersion(env) {
  try {
    const d = await db(env);
    await d
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('config_version', '1') " +
          "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
      )
      .run();
  } catch {}
}

/**
 * 写操作后清掉 overview 的边缘缓存。
 * 为什么需要：overview 走 Cache API 缓存了 30 秒。后台改完分类 / 顺序 / 站点后若不清，
 * 前台最长 30 秒仍显示旧数据 —— 与「保存后立即生效」不符。
 * 注意 caches.default 是**机房本地**缓存，这里只清当前机房的副本，其他机房靠 TTL 自然过期。
 */
async function purgeOverview(request) {
  try {
    const u = new URL(request.url);
    await Promise.all(
      [`${u.origin}/api/overview`, `${u.origin}/?api=overview`].map((k) =>
        caches.default.delete(new Request(k, { method: "GET" }))
      )
    );
  } catch {}
}

/**
 * 后台站点列表：站点配置 + 最近一次检查 + 分类。
 *
 * 抽出来是为了给 /api/admin 聚合接口复用 —— 后台一次请求就能拿到全部数据，
 * 不必再串行发 /sites + /categories 两次往返（跨国链路上每次往返约 0.2s）。
 */
async function buildAdminPayload(env) {
  const d = await db(env);

  // 站点 + 最近一次检查 + 已有证书结果：三条 SQL 并行（各一次 D1 往返）
  const [sitesRes, lastsRes, cats, sslRes] = await Promise.all([
    d.prepare("SELECT * FROM sites ORDER BY sort, id").all(),
    d
      .prepare(
        `WITH last AS (
           SELECT site, ok, status, ttfb_ms, source, probe, ts,
                  ROW_NUMBER() OVER (PARTITION BY site ORDER BY ts DESC) rn
           FROM checks
         )
         SELECT site, ok, status, ttfb_ms, source, probe, ts FROM last WHERE rn = 1`
      )
      .all(),
    buildCategories(d),
    // ⚠️ 只读已有证书结果，绝不在渲染路径上触发检测。
    //    SSL 检测走 Globalping，单站点约 13 个子请求、耗时数秒 —— 若放在这里，
    //    每次打开后台、每次轮询都会触发，既拖慢加载也白白消耗额度。
    //    检测由 cron（每轮 SSL_PER_TICK 个）与用户手动点「刷新证书」负责。
    d.prepare("SELECT * FROM ssl").all(),
  ]);

  const lastMap = Object.fromEntries((lastsRes.results || []).map((r) => [r.site, r]));
  const sslMap = Object.fromEntries((sslRes.results || []).map((r) => [r.site, r]));
  const sites = (sitesRes.results || []).map((s) => ({
    ...s,
    resolved_kind: resolveKind(s, env),
    cf_hint_resolved: cfHintOf(s, env),
    last_ok: lastMap[s.id]?.ok ?? null,
    last_status: lastMap[s.id]?.status ?? null,
    last_ttfb: lastMap[s.id]?.ttfb_ms ?? null,
    last_source: lastMap[s.id]?.source ?? null,
    last_probe: lastMap[s.id]?.probe ?? null,
    last_ts: lastMap[s.id]?.ts ?? null,
  }));

  return {
    sites,
    categories: cats,
    ssl: sslMap,
    default_kind: (env && env.PROBE_MODE) || "auto",
    has_globalping_token: Boolean(env && env.GLOBALPING_TOKEN),
  };
}

/** 每天是否到了该清理的时点（UTC 03:00–03:05 这一轮） */
function isCleanupWindow(now = new Date()) {
  return now.getUTCHours() === 3 && now.getUTCMinutes() < 5;
}

/** 每个站点解析出该用哪个后端（含 auto 降级） */
function resolveKind(site, env) {
  const mode = (site.probe_kind || (env && env.PROBE_MODE) || "auto").toLowerCase();
  const hasGp = Boolean(env && env.GLOBALPING_TOKEN);
  // 显式指定 globalping 就照做 —— 匿名也能跑（额度 250 次/小时）
  if (mode === "globalping") return "globalping";
  if (mode === "cf") return "cf";
  // auto：配了 token 优先 globalping（额度更高），没配则回落 CF
  return hasGp ? "globalping" : "cf";
}

function cfHintOf(site, env) {
  const h = site.cf_hint || (env && env.CF_HINT) || "apac";
  return REGION_GROUPS.includes(h) ? h : "apac";
}

/**
 * 三态判定：up / down / degraded（overview 与 site 详情共用，避免两处逻辑漂移）
 *
 * 降级规则对齐参考项目 ftxw/uptime-monitor 的 lib/checker.ts：
 *   证书无效 或 剩余 ≤ SSL_WARN_DAYS（默认 14）天 或 响应时间 > 超时上限的一半
 * 注意 down 不参与降级判定 —— 故障比降级更严重。
 */
function stateOf(s, env) {
  const ssl = s.ssl_checked_ts
    ? {
        valid:
          s.ssl_authorized === 1 &&
          (s.ssl_days_left === null || s.ssl_days_left > 0),
        authorized: s.ssl_authorized === 1,
        protocol: s.ssl_protocol,
        issuer: s.ssl_issuer,
        subject: s.ssl_subject,
        key_type: s.ssl_key_type,
        expires_at: s.ssl_expires_at,
        days_remaining: s.ssl_days_left,
        checked_ts: s.ssl_checked_ts,
        error: s.ssl_error,
      }
    : null;

  let state = s.last_ok === 1 ? "up" : s.last_ok === 0 ? "down" : "unknown";
  let degrade_reason = null;

  if (state !== "down") {
    const timeoutMs = Number((env && env.TIMEOUT_MS) || 8000);
    const warnDays = Number((env && env.SSL_WARN_DAYS) || SSL_WARN_DAYS);
    if (ssl && !ssl.error && ssl.valid === false) {
      state = "degraded";
      degrade_reason = "证书无效";
    } else if (
      ssl &&
      ssl.days_remaining !== null &&
      ssl.days_remaining !== undefined &&
      ssl.days_remaining <= warnDays
    ) {
      state = "degraded";
      degrade_reason = `证书剩余 ${ssl.days_remaining} 天`;
    } else if ((s.last_ttfb || 0) > timeoutMs * 0.5) {
      state = "degraded";
      degrade_reason = `响应偏慢 ${s.last_ttfb}ms`;
    }
  }
  return { state, degrade_reason, ssl };
}

/** 时间序列的桶宽：窗口越长桶越粗，保证返回点数在 60~200 之间（图表够用又不臃肿） */
function bucketFor(hours) {
  if (hours <= 6) return { sec: 300, label: "5 分钟" };
  if (hours <= 24) return { sec: 900, label: "15 分钟" };
  if (hours <= 72) return { sec: 3600, label: "1 小时" };
  if (hours <= 168) return { sec: 7200, label: "2 小时" };
  return { sec: 43200, label: "12 小时" };
}

/* ────────────────────────────── 存储层 ────────────────────────────── */

/* ────────────────────────── 站点设置（存 D1，后台可改）────────────────────────── */

/**
 * 所有可配置项都存 meta 表，读写走这里。
 * 优先级：**D1 设置 > 环境变量（wrangler.toml / secret） > 代码默认值**。
 * 这样后台改完立即生效，不必重新部署；而 wrangler.toml 里的值仍可作为初始默认。
 */
const SETTING_KEYS = [
  "default_theme",     // auto | light | dark —— 前台默认主题
  "site_title",        // 前台标题
  "probe_mode",        // auto | cf | globalping
  "cf_hint",           // CF 默认区域组
  "gp_magic",          // Globalping 默认位置筛选
  "gp_ssl_magic",      // SSL 检测用的筛选（与站点筛选解耦）
  "gp_limit",          // 每次测量的探测点数（每个算 1 次额度）
  "gp_ip_version",     // Globalping 使用的 IP 版本：4 | 6
  "timeout_ms",        // 单次探测超时
  "ssl_per_tick",      // 每轮 cron 补充检测几个站点的 SSL
  "ssl_warn_days",     // 证书剩余 ≤ N 天判为降级
  "subreq_budget",     // 单次调用的子请求预算（免费层上限 50，留余量）
  "check_keep_days",   // 探测明细保留天数（过期由 cron 每天清理一次）
  "alert_webhook",     // 告警 Webhook
  "globalping_token",  // Globalping token（只在后台可写，读取时脱敏）
];

/** 只读内部状态，不对外暴露 */
const INTERNAL_KEYS = ["admin_password", "session_secret", "config_version"];

/**
 * 把 D1 设置合并进 env —— 现有代码全部读 env.XXX，这样一处覆盖、全链路生效，
 * 不必在每个调用点都改成读设置。
 */
async function effectiveEnv(env, S) {
  const s = S || (await loadSettings(env));
  const pick = (k, fallback) => (s[k] !== undefined && s[k] !== "" ? s[k] : env[k] || fallback);
  return Object.assign({}, env, {
    GLOBALPING_TOKEN: pick("globalping_token", ""),
    PROBE_MODE: pick("probe_mode", "auto"),
    CF_HINT: pick("cf_hint", "apac"),
    GP_MAGIC: pick("gp_magic", "CN+datacenter-network"),
    GP_SSL_MAGIC: pick("gp_ssl_magic", "CN+datacenter-network"),
    GP_LIMIT: pick("gp_limit", "1"),
    GP_IP_VERSION: pick("gp_ip_version", "4"),
    TIMEOUT_MS: pick("timeout_ms", "8000"),
    SSL_PER_TICK: pick("ssl_per_tick", "2"),
    SSL_WARN_DAYS: pick("ssl_warn_days", "14"),
    SUBREQ_BUDGET: pick("subreq_budget", "30"),
    CHECK_KEEP_DAYS: pick("check_keep_days", "30"),
    ALERT_WEBHOOK: pick("alert_webhook", ""),
  });
}

/** 会话签名密钥：优先生效环境变量，否则用 D1 里的随机值（首次访问时生成） */
async function sessionSecret(env, S) {
  if (env.ADMIN_SECRET) return env.ADMIN_SECRET;
  const s = S || (await loadSettings(env));
  if (s.session_secret) return s.session_secret;
  const hex = randomHex(32);
  await saveSetting(env, "session_secret", hex);
  return hex;
}

/** token 脱敏展示：只留前 4 后 4 */
function maskToken(v) {
  const t = String(v || "");
  if (!t) return "";
  if (t.length <= 10) return "****";
  return `${t.slice(0, 4)}****${t.slice(-4)}`;
}

const loginLimiter = createRateLimiter(5, 60_000);

/**
 * 登录失败的第二道闸门（存 D1）。
 *
 * 为什么内存限速不够：本 Worker 流量很低，CF 很可能**每个请求都新建 isolate**，
 * 内存里的 Map 随之清空 —— 实测连续 6 次错误密码都没被拦住。
 * 所以把「窗口内失败次数」落进 D1，跨 isolate / 跨机房都算数。
 *
 * 代价：只在**失败**时写 D1（2 行），成功登录时清一次，日常零开销。
 * 选全局计数而不是按 IP：个人后台单管理员场景下够用，
 * 且攻击者换 IP 也绕不过；窗口只有 60 秒，不至于把管理员自己长时间锁在门外。
 */
const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW_MS = 60_000;

function loginBlocked(raw) {
  const start = Number(raw.login_fail_window || 0);
  const count = Number(raw.login_fail_count || 0);
  if (!start || Date.now() - start >= LOGIN_WINDOW_MS) return false;
  return count >= LOGIN_MAX_FAILS;
}

async function recordLoginFail(env, raw) {
  const now = Date.now();
  const start = Number(raw.login_fail_window || 0);
  const fresh = !start || now - start >= LOGIN_WINDOW_MS;
  const count = fresh ? 1 : Number(raw.login_fail_count || 0) + 1;
  await Promise.all([
    saveSetting(env, "login_fail_window", String(fresh ? now : start)),
    saveSetting(env, "login_fail_count", String(count)),
  ]);
}

async function clearLoginFail(env) {
  await Promise.all([
    saveSetting(env, "login_fail_window", ""),
    saveSetting(env, "login_fail_count", ""),
  ]);
}

/** 会话有效期：30 天（内部工具，频繁登录反而促使人用弱密码） */
const SESSION_TTL = 30 * 86400;

/** 设置项 → 环境变量名（用于把「最终生效值」回显给后台表单） */
const ENV_FOR = {
  probe_mode: "PROBE_MODE",
  cf_hint: "CF_HINT",
  gp_magic: "GP_MAGIC",
  gp_ssl_magic: "GP_SSL_MAGIC",
  gp_limit: "GP_LIMIT",
  gp_ip_version: "GP_IP_VERSION",
  timeout_ms: "TIMEOUT_MS",
  ssl_per_tick: "SSL_PER_TICK",
  ssl_warn_days: "SSL_WARN_DAYS",
  subreq_budget: "SUBREQ_BUDGET",
  check_keep_days: "CHECK_KEEP_DAYS",
  alert_webhook: "ALERT_WEBHOOK",
  globalping_token: "GLOBALPING_TOKEN",
};

/** 取某个设置项的「最终生效值」（此时 env 已经是被合并过的） */
function effectiveSettingValue(env, raw, k) {
  if (k === "default_theme") return raw.default_theme || "auto";
  if (k === "site_title") return raw.site_title || "站点状态";
  const ek = ENV_FOR[k];
  return ek ? env[ek] || "" : "";
}

/**
 * 设置的对外表示。token **永不回传明文**，只给掩码 + 是否存在。
 * /api/settings 与 /api/admin 共用，避免两处脱敏逻辑漂移（漏一处就是明文泄露）。
 */
function publicSettings(env, raw) {
  const s = {};
  for (const k of SETTING_KEYS) s[k] = effectiveSettingValue(env, raw, k);
  s.globalping_token = "";
  s.globalping_token_masked = maskToken(env.GLOBALPING_TOKEN);
  s.has_globalping_token = Boolean(env.GLOBALPING_TOKEN);
  s.password_source = env.ADMIN_PASSWORD ? "env" : raw.admin_password ? "db" : "none";
  return s;
}

async function sendAlerts(env, alerts) {
  const hook = env && env.ALERT_WEBHOOK;
  if (!hook || !alerts.length) return null;
  const lines = alerts.map(
    (a) =>
      `[${a.kind === "down" ? "故障" : "恢复"}] ${a.site} — 连续 ${a.failCount} 次${
        a.kind === "down" ? "失败" : "正常"
      }${a.info.status ? ` · 状态码 ${a.info.status}` : ""}${
        a.info.reason ? ` · ${a.info.reason}` : ""
      }`
  );
  try {
    const r = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: lines.join("\n"),
        alerts: alerts.map((a) => ({ ...a, info: undefined })),
      }),
    });
    const stamp = new Date().toISOString();
    const d = await db(env);
    for (const a of alerts) {
      await d
        .prepare("UPDATE state SET last_alert_ts = ? WHERE site = ?")
        .bind(stamp, a.site)
        .run();
    }
    return { sent: alerts.length, status: r.status };
  } catch (e) {
    return { sent: 0, error: String((e && e.message) || e) };
  }
}

/* ────────────────────────── 两阶段调度 ────────────────────────── */

/**
 * 调 CF 探测后端：按 hint 分组，一组一次 DO 调用
 * 用完即 kill —— DO 常驻内存会持续计 duration 费（免费额度 13,000 GB-s/天）
 */
async function probeViaCf(env, hint, list, timeoutMs) {
  const stub = env.PROBER.get(env.PROBER.idFromName(`prober-${hint}`), {
    locationHint: hint,
  });
  let out = null;
  try {
    out = await stub.run(
      list.map((s) => ({ url: s.url, keyword: s.keyword || null })),
      timeoutMs
    );
  } finally {
    try {
      await stub.kill();
    } catch {
      // kill 通过抛错终止实例，报错是预期行为
    }
  }
  return {
    colo: (out.egress && out.egress.colo) || hint,
    egress: out.egress,
    results: out.results,
    wall: out.wall,
  };
}

/** 阶段一：收取上一轮发起的 Globalping 测量 */
async function collectGlobalping(env) {
  const d = await db(env);
  const { results: pending } = await d.prepare("SELECT * FROM pending").all();
  if (!pending || !pending.length) return { collected: 0, rows: [] };

  const sites = await loadSites(env);
  const byId = Object.fromEntries(sites.map((s) => [s.id, s]));
  const rows = [];
  const perSite = {};
  const doneIds = [];

  for (const p of pending) {
    let out;
    try {
      out = await gpCollect(env, p);
    } catch (e) {
      // 收取失败就丢弃，避免 pending 永久占位
      doneIds.push(p.site);
      continue;
    }
    if (!out.done) continue; // 还没跑完，留到下一轮
    doneIds.push(p.site);
    const site = byId[p.site];
    if (!site) continue;
    const good = out.results.filter((r) => r.ok);
    const probeLabel = good.map((r) => r.probe).join(",") || null;
    const best =
      good.sort((a, b) => (a.ttfb || 1e9) - (b.ttfb || 1e9))[0] || out.results[0];
    const v = judge(site, best);
    rows.push({
      ts: new Date().toISOString(),
      site: p.site,
      source: p.source,
      probe: probeLabel,
      ok: v.ok,
      status: best?.status ?? 0,
      ttfb_ms: best?.ttfb ?? 0,
      total_ms: best?.total ?? 0,
      error: v.reason,
    });
    perSite[p.site] = {
      ok: v.ok,
      status: best?.status ?? 0,
      reason: v.reason,
      threshold: Number(site.fail_threshold || 3),
      source: p.source,
      probe: probeLabel,
    };
  }

  if (rows.length) await insertChecks(env, rows);
  for (const s of doneIds) {
    await d.prepare("DELETE FROM pending WHERE site = ?").bind(s).run();
  }
  const alerts = await bumpState(env, perSite);
  const alertResult = await sendAlerts(env, alerts);
  return { collected: rows.length, rows, alerts, alertResult };
}

/** 阶段二：发起本轮测量（Globalping 两阶段 / CF 即时） */
async function dispatch(env, sites) {
  const budget = Number((env && env.SUBREQ_BUDGET) || 30);
  const timeoutMs = Number((env && env.TIMEOUT_MS) || 8000);
  const d = await db(env);
  let used = 0;
  const started = [];
  const skipped = [];

  // 已挂起的站点本轮不再重复发起
  const { results: pend } = await d.prepare("SELECT site FROM pending").all();
  const pendingSet = new Set((pend || []).map((p) => p.site));

  // ── CF 后端：一个 DO 调用就能带一批，最省子请求
  const cfSites = [];
  const gpSites = [];
  for (const s of sites) {
    if (pendingSet.has(s.id)) continue;
    (resolveKind(s, env) === "globalping" ? gpSites : cfSites).push(s);
  }

  const cfResult = {};
  if (cfSites.length) {
    // 按 hint 分组，一组一次 DO 调用
    const groups = {};
    for (const s of cfSites) {
      const h = cfHintOf(s, env);
      (groups[h] = groups[h] || []).push(s);
    }
    for (const [hint, list] of Object.entries(groups)) {
      if (used + 1 > budget) {
        skipped.push(...list.map((s) => s.id));
        continue;
      }
      used += 1;
      try {
        const out = await probeViaCf(env, hint, list, timeoutMs);
        list.forEach((s, i) => {
          cfResult[s.id] = { result: out.results[i], colo: out.colo, hint };
        });
        started.push({ hint, sites: list.map((s) => s.id), colo: out.colo, wall: out.wall });
      } catch (e) {
        list.forEach((s) => {
          cfResult[s.id] = { error: String((e && e.message) || e), hint };
        });
      }
    }
  }

  // ── Globalping 后端：每站点 1 次 create
  const gpStarted = [];
  const gpFailed = [];
  for (const s of gpSites) {
    if (used + 1 > budget) {
      skipped.push(s.id);
      continue;
    }
    used += 1;
    try {
      const { id, source, quota } = await gpCreate(env, s);
      await d
        .prepare(
          "INSERT OR REPLACE INTO pending (site, measurement_id, source, created_ts) VALUES (?,?,?,?)"
        )
        .bind(s.id, id, source, new Date().toISOString())
        .run();
      gpStarted.push({ site: s.id, id, source, quota });
    } catch (e) {
      const msg = String((e && e.message) || e);
      gpStarted.push({ site: s.id, error: msg });
      gpFailed.push({ site: s, err: msg });
    }
  }

  // ── 自动降级：Globalping 发起失败 → 改走 CF（按 hint 分组，省子请求）
  // 典型失败：位置筛选过窄导致 no_probes_found、额度耗尽、API 抖动
  const fellBack = [];
  if (gpFailed.length) {
    const groups = {};
    for (const { site } of gpFailed) {
      const h = cfHintOf(site, env);
      (groups[h] = groups[h] || []).push(site);
    }
    for (const [hint, list] of Object.entries(groups)) {
      if (used + 1 > budget) {
        skipped.push(...list.map((s) => s.id));
        continue;
      }
      used += 1;
      try {
        const out = await probeViaCf(env, hint, list, timeoutMs);
        list.forEach((s, i) => {
          cfResult[s.id] = { result: out.results[i], colo: out.colo, hint, fallback: true };
        });
        fellBack.push({ hint, sites: list.map((s) => s.id), colo: out.colo });
      } catch (e) {
        list.forEach((s) => {
          cfResult[s.id] = {
            error: String((e && e.message) || e),
            hint,
            fallback: true,
          };
        });
      }
    }
  }

  return { used, started, gpStarted, fellBack, skipped, cfResult };
}

/** 把 CF 后端的即时结果落库并更新状态 */
async function persistCf(env, sites, cfResult) {
  const rows = [];
  const perSite = {};
  for (const s of sites) {
    const hit = cfResult[s.id];
    if (!hit) continue;
    if (hit.error) {
      rows.push({
        ts: new Date().toISOString(),
        site: s.id,
        source: hit.fallback ? `cf:fallback-${hit.hint}` : `cf:${hit.hint}`,
        probe: null,
        ok: false,
        status: 0,
        ttfb_ms: 0,
        total_ms: 0,
        error: hit.error,
      });
      perSite[s.id] = {
        ok: false,
        reason: hit.error,
        threshold: Number(s.fail_threshold || 3),
      };
      continue;
    }
    const r = hit.result;
    const v = judge(s, r);
    const src = hit.fallback ? `cf:fallback-${hit.hint}` : `cf:${hit.hint}`;
    rows.push({
      ts: new Date().toISOString(),
      site: s.id,
      source: src,
      probe: hit.colo,
      ok: v.ok,
      status: r.status ?? 0,
      ttfb_ms: r.ttfb ?? 0,
      total_ms: r.total ?? 0,
      error: v.reason,
    });
    perSite[s.id] = {
      ok: v.ok,
      status: r.status ?? 0,
      reason: v.reason,
      threshold: Number(s.fail_threshold || 3),
      source: src,
      probe: hit.colo,
    };
  }
  if (rows.length) await insertChecks(env, rows);
  const alerts = await bumpState(env, perSite);
  const alertResult = await sendAlerts(env, alerts);
  return { persisted: rows.length, rows, alerts, alertResult };
}

/**
 * 刷新过期/缺失的 SSL 信息。
 *
 * ⚠️ 额度与子请求都要小心：gpSslCheck 是「发起 + 轮询」的同步写法，
 *    单站点最多消耗 ~13 个子请求，而 Workers 免费层每次调用上限 50。
 *    所以定时任务里每轮只处理 limit 个（默认 2 个），
 *    10 个站点大约半小时内轮完一遍 —— 对"证书每天查一次"完全够。
 */
async function refreshSslStale(env, sites, { force = false, maxAgeH = 24, limit = 2 } = {}) {
  const d = await db(env);
  const done = [];
  for (const s of sites) {
    if (done.length >= limit) break;
    const cur = await d.prepare("SELECT * FROM ssl WHERE site = ?").bind(s.id).first();
    const fresh =
      cur && cur.checked_ts &&
      Date.now() - new Date(cur.checked_ts).getTime() < maxAgeH * 3600 * 1000;
    if (fresh && !force) continue;
    let r;
    try {
      r = await gpSslCheck(env, s);
    } catch (e) {
      r = { error: String((e && e.message) || e) };
    }
    await saveSsl(env, s.id, r);
    done.push({ site: s.id, ...r });
  }
  return done;
}

/* ────────────────────────────── 路由 ────────────────────────────── */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 接口统一走 /api/<name>；静态资源占根路径，两者互不干扰。
    const m = url.pathname.match(/^\/api\/([a-zA-Z_]+)\/?$/);
    const api = m ? m[1] : "";
    const pretty = url.searchParams.get("pretty") === "1";

    /* ── 站点设置 + 认证闸门 ──────────────────────────────────────────
       设置存 D1 且优先级高于环境变量；合并回 env 后，下游所有 `env.XXX` 读取
       自动变成「D1 设置 → 环境变量 → 代码默认」，不必在每个调用点改成读设置。 */
    const rawSettings = await loadSettings(env);
    const pwdConfigured = Boolean(rawSettings.admin_password || env.ADMIN_PASSWORD);

    let authed = false;
    if (!pwdConfigured) {
      // 还没设置过密码 → 不启用认证（否则首次部署根本进不去后台）。
      // 前端会显示醒目警告提醒尽快设置；一旦设置密码即开始强制登录。
      authed = true;
    } else {
      const token = getSessionToken(request.headers.get("cookie"));
      if (token) {
        authed = Boolean(await verifySession(token, await sessionSecret(env, rawSettings)));
      }
    }

    env = await effectiveEnv(env, rawSettings);

    // 公开接口：前台只读展示 + 登录/会话探测。其余（含所有写接口）都要求已登录。
    // 公开接口：前台只读展示 + 登录/登出。其余（含所有写接口）都要求已登录。
    const PUBLIC_APIS = new Set(["overview", "site", "login", "logout"]);
    if (pwdConfigured && !PUBLIC_APIS.has(api) && !authed) {
      return json(
        { ok: false, error: "未登录或会话已过期", need_login: true },
        401,
        "no-store",
        pretty
      );
    }

    // 任何写操作：① 递增配置版本（所有机房的 overview 旧缓存 key 立即失效）
    //            ② 顺手清掉本机房副本
    // 只做 ② 不够 —— Cache API 是机房本地缓存，请求落到别的机房仍会命中旧值。
    // 实测「改完分类顺序前台没变」就是这个原因，所以必须以 ① 为准。
    if (request.method !== "GET" && request.method !== "HEAD") {
      await Promise.all([bumpConfigVersion(env), purgeOverview(request)]);
    }

    try {
      /* ── 登录 / 登出 ─────────────────────────────────────── */

      if (api === "login") {
        if (request.method !== "POST") {
          return json({ ok: false, error: "仅支持 POST" }, 405, "no-store", pretty);
        }
        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        // 第一道：内存限速（isolate 复用时零成本）
        if (!loginLimiter.check(ip)) {
          return json(
            { ok: false, error: "尝试过于频繁，请 1 分钟后再试" },
            429,
            "no-store",
            pretty
          );
        }
        // 第二道：D1 全局限速（低流量下每个请求可能是新 isolate，内存层拦不住）
        if (loginBlocked(rawSettings)) {
          return json(
            { ok: false, error: `失败次数过多，请 ${LOGIN_WINDOW_MS / 1000} 秒后再试` },
            429,
            "no-store",
            pretty
          );
        }

        const body = await request.json().catch(() => ({}));
        const input = String(body.password || "");

        let pass = false;
        if (env.ADMIN_PASSWORD) {
          // 环境变量（secret）优先 —— 也算"救援密码"：D1 里密码忘了还能用它进来
          pass = constantTimeEqual(input, env.ADMIN_PASSWORD);
        } else if (rawSettings.admin_password) {
          pass = await verifyPasswordHash(input, rawSettings.admin_password);
        }

        if (!pass) {
          await recordLoginFail(env, rawSettings);
          await sleep(300); // 固定延迟抬高爆破成本（等待不计 CPU）
          return json({ ok: false, error: "密码错误" }, 401, "no-store", pretty);
        }

        // 登录成功 → 清掉失败计数（有记录才清，避免无谓的 D1 写）
        if (rawSettings.login_fail_count || rawSettings.login_fail_window) {
          await clearLoginFail(env);
        }
        loginLimiter.reset(ip);
        const token = await issueSession(await sessionSecret(env, rawSettings), SESSION_TTL);
        return new Response(JSON.stringify({ ok: true, expires_in_days: 30 }), {
          status: 200,
          headers: {
            ...JSON_HEADERS,
            "Cache-Control": "no-store",
            "Set-Cookie": buildSessionCookie(token, SESSION_TTL, true),
          },
        });
      }

      if (api === "logout") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            ...JSON_HEADERS,
            "Cache-Control": "no-store",
            "Set-Cookie": clearSessionCookie(true),
          },
        });
      }

      /* ── 站点设置 ────────────────────────────────────────── */

      if (api === "settings") {
        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const saved = [];

          for (const k of SETTING_KEYS) {
            if (!(k in body)) continue;
            const v = body[k];
            // token 传 __KEEP__ 或空 → 视为「不修改」，避免每次保存都把已配置的 token 清掉
            if (k === "globalping_token" && (v === "__KEEP__" || v === null || v === undefined)) {
              continue;
            }
            await saveSetting(env, k, v === null ? "" : String(v).trim());
            saved.push(k);
          }

          if (body.clear_globalping_token) {
            await saveSetting(env, "globalping_token", "");
            saved.push("globalping_token:cleared");
          }

          let newCookie = null;
          if (body.new_password) {
            const pwd = String(body.new_password);
            if (pwd.length < 6) {
              return json({ ok: false, error: "密码至少 6 位" }, 400, "no-store", pretty);
            }
            await saveSetting(env, "admin_password", await hashPassword(pwd));
            // 重置会话密钥 → 所有旧会话立即失效；紧接着给当前浏览器签发新会话，免得把自己踢出去
            await saveSetting(env, "session_secret", randomHex(32));
            const fresh = await loadSettings(env);
            const token = await issueSession(await sessionSecret(env, fresh), SESSION_TTL);
            newCookie = buildSessionCookie(token, SESSION_TTL, true);
            saved.push("admin_password");
          }

          if (body.remove_password) {
            await saveSetting(env, "admin_password", "");
            saved.push("admin_password:removed");
          }

          await bumpConfigVersion(env);
          const headers = { ...JSON_HEADERS, "Cache-Control": "no-store" };
          if (newCookie) headers["Set-Cookie"] = newCookie;
          return new Response(JSON.stringify({ ok: true, saved }), { status: 200, headers });
        }

        // GET：回显设置。token 永不回传明文，只给掩码 + 是否存在
        return json(
          {
            ok: true,
            authed,
            password_configured: pwdConfigured,
            settings: publicSettings(env, rawSettings),
          },
          200,
          "no-store",
          pretty
        );
      }

      // ── 前台一次性取全量：统计卡 + 分组 + 每站点 30 天色条 + SSL ──
      // 刻意做成"单接口返回全部"，避免前端对 N 个站点发 N 个请求
      if (api === "overview") {
        // 缓存 key 带上配置版本：后台一改配置版本就 +1，所有机房的旧 key 立即不再命中
        const ver = await configVersion(env);
        const keyUrl = `${url.origin}/api/overview?days=${Number(
          url.searchParams.get("days") || 30
        )}&pretty=${pretty ? 1 : 0}&v=${ver}`;
        return await withEdgeCache(request, ctx, 30, async () => {
          const d = await db(env);
          const days = Number(url.searchParams.get("days") || 30);
          const since30 = new Date(Date.now() - days * 86400000).toISOString();
          const since24 = new Date(Date.now() - 86400000).toISOString();

          const [siteRows, dayRows, h24, u24] = await Promise.all([
            d
              .prepare(
                `WITH last AS (
                   SELECT site, ok, status, ttfb_ms, source, probe, ts, error,
                          ROW_NUMBER() OVER (PARTITION BY site ORDER BY ts DESC) rn
                   FROM checks
                 )
                 SELECT s.id, s.name, s.url, s.group_name, s.probe_kind, s.cf_hint,
                        s.gp_magic, s.fail_threshold, s.expect_codes, s.keyword,
                        COALESCE(st.consecutive_fail, 0) AS consecutive_fail,
                        l.ok AS last_ok, l.status AS last_status,
                        l.ttfb_ms AS last_ttfb, l.source AS last_source,
                        l.probe AS last_probe, l.ts AS last_ts, l.error AS last_error,
                        ss.authorized AS ssl_authorized, ss.protocol AS ssl_protocol,
                        ss.issuer AS ssl_issuer, ss.expires_at AS ssl_expires_at,
                        ss.days_left AS ssl_days_left, ss.checked_ts AS ssl_checked_ts,
                        ss.error AS ssl_error
                 FROM sites s
                 LEFT JOIN state st ON st.site = s.id
                 LEFT JOIN last l ON l.site = s.id AND l.rn = 1
                 LEFT JOIN ssl ss ON ss.site = s.id
                 -- 分类顺序由 categories.sort 决定，而不是 group_name 的字面排序。
                 -- 否则"生产环境"会被排到"测试环境"后面（中文码点顺序），与直觉相反。
                 LEFT JOIN categories cat
                        ON cat.name = COALESCE(NULLIF(TRIM(s.group_name), ''), '未分组')
                 WHERE s.enabled = 1
                 ORDER BY COALESCE(cat.sort, 100000), s.group_name, s.sort, s.id`
              )
              .all(),
            d
              .prepare(
                `SELECT site, date(ts, '+8 hours') AS d,
                        COUNT(*) AS n, SUM(ok) AS ok
                 FROM checks WHERE ts > ?
                 GROUP BY site, d`
              )
              .bind(since30)
              .all(),
            d
              .prepare(
                `SELECT COUNT(*) AS n, SUM(ok) AS ok FROM checks WHERE ts > ?`
              )
              .bind(since24)
              .first(),
            // 每站点近 24h 可用率（前台要显示"可用率"一列）
            d
              .prepare(
                `SELECT site, COUNT(*) AS n, SUM(ok) AS ok
                 FROM checks WHERE ts > ? GROUP BY site`
              )
              .bind(since24)
              .all(),
          ]);

          // 30 天日期轴（北京时间）。与原项目一致：最左是今天，最右是最早。
          const axis = [];
          for (let i = 0; i < days; i++) {
            const t = new Date(Date.now() - i * 86400000 + 8 * 3600 * 1000);
            axis.push(t.toISOString().slice(0, 10));
          }
          const bySite = {};
          for (const r of dayRows.results || []) {
            (bySite[r.site] = bySite[r.site] || {})[r.d] = r;
          }

          const u24map = {};
          for (const r of u24.results || []) {
            u24map[r.site] = r.n ? Math.round((Number(r.ok) / Number(r.n)) * 1000) / 10 : null;
          }

          const groups = {};
          const seen = new Set();
          for (const s of siteRows.results || []) {
            const map = bySite[s.id] || {};
            const bars = axis.map((dkey) => {
              const c = map[dkey];
              if (!c || !c.n) return { d: dkey, st: "none" };
              if (c.ok >= c.n) return { d: dkey, st: "up" };
              if (c.ok === 0) return { d: dkey, st: "down" };
              return { d: dkey, st: "recovered" };
            });

            // 三态判定：up / down / degraded（规则见 stateOf）
            const { state, degrade_reason: degradeReason, ssl } = stateOf(s, env);

            const g = s.group_name || "未分组";
            (groups[g] = groups[g] || []).push({
              id: s.id,
              name: s.name,
              url: s.url,
              probe_kind: resolveKind(s, env),
              cf_hint: cfHintOf(s, env),
              state,
              degrade_reason: degradeReason,
              last_ok: s.last_ok,
              last_status: s.last_status,
              last_ttfb: s.last_ttfb,
              last_source: s.last_source,
              last_probe: s.last_probe,
              last_ts: s.last_ts,
              last_error: s.last_error,
              consecutive_fail: s.consecutive_fail,
              uptime_24h: u24map[s.id] ?? null,
              interval_min: s.interval_min || 5,
              ssl,
              bars,
            });
            seen.add(s.id);
          }

          let up = 0;
          let down = 0;
          let degraded = 0;
          let incidents = 0;
          for (const g of Object.values(groups)) {
            for (const m of g) {
              if (m.state === "up") up++;
              else if (m.state === "down") down++;
              else if (m.state === "degraded") degraded++;
              if (Number(m.consecutive_fail) > 0) incidents++;
            }
          }
          const total = seen.size;
          const uptime =
            h24 && h24.n ? Math.round((Number(h24.ok) / Number(h24.n)) * 1000) / 10 : 100;

          return json(
            {
              ok: true,
              now: new Date().toISOString(),
              // 前台需要的展示类设置（改完靠 config_version 换缓存 key 立即生效）
              settings: {
                default_theme: rawSettings.default_theme || "auto",
                site_title: rawSettings.site_title || "站点状态",
              },
              stats: {
                total,
                up,
                down,
                degraded,
                incidents,
                uptime_24h: uptime,
              },
              groups: Object.entries(groups).map(([name, monitors]) => ({ name, monitors })),
            },
            200,
            READ_CACHE,
            pretty
          );
        }, keyUrl);
      }

      // ── 单站点详情（二级页面数据源）──
      // 一次返回：配置 + 状态 + SSL + 窗口统计 + 延迟序列 + 最近检查 + 故障事件 + 30 天色条。
      // 刻意做成单接口 —— 详情页只用 1 个请求，避免对同一站点发 4~5 个。
      if (api === "site") {
        const id = url.searchParams.get("id");
        if (!id) return json({ ok: false, error: "缺少 id 参数" }, 400, "no-store", pretty);

        const hoursFor = Math.max(1, Math.min(Number(url.searchParams.get("hours") || 24), 720));
        const verS = await configVersion(env);
        const keyUrl = `${url.origin}/api/site?id=${encodeURIComponent(id)}&hours=${hoursFor}&pretty=${
          pretty ? 1 : 0
        }&v=${verS}`;

        return await withEdgeCache(request, ctx, 30, async () => {
          const d = await db(env);
          const hours = Math.max(1, Math.min(Number(url.searchParams.get("hours") || 24), 720));
          const recentN = Math.max(5, Math.min(Number(url.searchParams.get("recent") || 50), 200));
          const days = Math.max(1, Math.min(Number(url.searchParams.get("days") || 30), 90));
          const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
          const sinceD = new Date(Date.now() - days * 86400000).toISOString();
          const bkt = bucketFor(hours);

          const [meta, agg, p95, seriesRows, recentRows, changeRows, dayRows] =
            await Promise.all([
              // ① 配置 + 状态 + 最近一次 + SSL
              d
                .prepare(
                  `WITH last AS (
                     SELECT ok, status, ttfb_ms, total_ms, source, probe, ts, error
                     FROM checks WHERE site = ?1 ORDER BY ts DESC LIMIT 1
                   )
                   SELECT s.id, s.name, s.url, s.group_name, s.probe_kind, s.cf_hint, s.gp_magic,
                          s.fail_threshold, s.interval_min, s.expect_codes, s.keyword,
                          s.enabled, s.sort,
                          COALESCE(st.consecutive_fail, 0) AS consecutive_fail,
                          st.last_checked_ts, st.last_ok_ts,
                          l.ok AS last_ok, l.status AS last_status, l.ttfb_ms AS last_ttfb,
                          l.total_ms AS last_total,
                          l.source AS last_source, l.probe AS last_probe,
                          l.ts AS last_ts, l.error AS last_error,
                          ss.authorized AS ssl_authorized, ss.protocol AS ssl_protocol,
                          ss.issuer AS ssl_issuer, ss.subject AS ssl_subject,
                          ss.key_type AS ssl_key_type, ss.expires_at AS ssl_expires_at,
                          ss.days_left AS ssl_days_left, ss.checked_ts AS ssl_checked_ts,
                          ss.error AS ssl_error
                   FROM sites s
                   LEFT JOIN state st ON st.site = s.id
                   LEFT JOIN last l ON 1=1
                   LEFT JOIN ssl ss ON ss.site = s.id
                   WHERE s.id = ?1`
                )
                .bind(id)
                .first(),
              // ② 窗口聚合
              d
                .prepare(
                  `SELECT COUNT(*) AS n, SUM(ok) AS okl,
                          MIN(ttfb_ms) AS mn, MAX(ttfb_ms) AS mx,
                          CAST(AVG(CASE WHEN ok=1 THEN ttfb_ms END) AS INTEGER) AS av,
                          CAST(AVG(total_ms) AS INTEGER) AS av_total
                   FROM checks WHERE site = ?1 AND ts > ?2`
                )
                .bind(id, since)
                .first(),
              // ③ P95 —— SQLite 无 percentile 函数，用「排序 + 偏移」取近似
              d
                .prepare(
                  `SELECT ttfb_ms AS p95 FROM checks
                   WHERE site = ?1 AND ts > ?2 AND ok = 1
                   ORDER BY ttfb_ms
                   LIMIT 1 OFFSET (
                     SELECT CAST(COUNT(*) * 0.95 AS INTEGER) FROM checks
                     WHERE site = ?1 AND ts > ?2 AND ok = 1
                   )`
                )
                .bind(id, since)
                .first(),
              // ④ 延迟时间序列（按桶聚合，桶宽随窗口自适应）
              d
                .prepare(
                  `SELECT CAST(strftime('%s', substr(ts,1,19)) / ?2 AS INTEGER) AS b,
                          COUNT(*) AS n, SUM(ok) AS okl,
                          CAST(AVG(CASE WHEN ok=1 THEN ttfb_ms END) AS INTEGER) AS av,
                          MIN(CASE WHEN ok=1 THEN ttfb_ms END) AS mn,
                          MAX(CASE WHEN ok=1 THEN ttfb_ms END) AS mx
                   FROM checks WHERE site = ?1 AND ts > ?3
                   GROUP BY b ORDER BY b`
                )
                .bind(id, bkt.sec, since)
                .all(),
              // ⑤ 最近 N 条原始检查
              d
                .prepare(
                  `SELECT ts, ok, status, ttfb_ms, total_ms, source, probe, error
                   FROM checks WHERE site = ?1 ORDER BY ts DESC LIMIT ?2`
                )
                .bind(id, recentN)
                .all(),
              // ⑥ 状态变化点 —— 只在 ok 翻转处返回，结果集极小，
              //    比取回整段序列在 Worker 里扫要省得多（30 天也能用）
              d
                .prepare(
                  `WITH x AS (
                     SELECT ts, ok, error, LAG(ok) OVER (ORDER BY ts) AS prev
                     FROM checks WHERE site = ?1 AND ts > ?2
                   )
                   SELECT ts, ok, error FROM x
                   WHERE prev IS NULL OR ok <> prev
                   ORDER BY ts`
                )
                .bind(id, since)
                .all(),
              // ⑦ 按天聚合（+8 小时对齐北京时间，与首页一致）
              d
                .prepare(
                  `SELECT date(ts, '+8 hours') AS d, COUNT(*) AS n, SUM(ok) AS ok
                   FROM checks WHERE site = ?1 AND ts > ?2
                   GROUP BY d`
                )
                .bind(id, sinceD)
                .all(),
            ]);

          if (!meta) {
            return json({ ok: false, error: `站点不存在：${id}` }, 404, "no-store", pretty);
          }

          const { state, degrade_reason, ssl } = stateOf(meta, env);
          const n = Number(agg?.n || 0);
          const okl = Number(agg?.okl || 0);
          const intervalMin = Number(meta.interval_min || 5);

          // 序列 → 前端图表点集（v 为成功请求的平均延迟，全失败桶为 null）
          const series = (seriesRows.results || []).map((r) => ({
            t: new Date(Number(r.b) * bkt.sec * 1000).toISOString(),
            n: Number(r.n || 0),
            ok: Number(r.okl || 0),
            v: r.av === null || r.av === undefined ? null : Number(r.av),
            min: r.mn,
            max: r.mx,
          }));

          // 故障事件：把「状态变化点」两两配对成段
          const failThreshold = Number(meta.fail_threshold || 3);
          const incidents = [];
          let open = null;
          for (const c of changeRows.results || []) {
            if (Number(c.ok) === 0) {
              if (!open) open = { start: c.ts, error: c.error || null };
            } else if (open) {
              incidents.push({ ...open, end: c.ts });
              open = null;
            }
          }
          if (open) incidents.push({ ...open, end: null }); // 仍在故障中

          const evts = incidents
            .map((e) => {
              const t0 = new Date(e.start).getTime();
              const t1 = e.end ? new Date(e.end).getTime() : Date.now();
              const duration_s = Math.max(0, Math.round((t1 - t0) / 1000));
              return {
                start: e.start,
                end: e.end,
                ongoing: !e.end,
                duration_s,
                error: e.error,
                // 用时长估算段内检查次数，与告警口径（连续 N 次失败）对齐
                checks_est: Math.max(1, Math.round(duration_s / (intervalMin * 60)) + 1),
              };
            })
            // 未达 fail_threshold 的单次抖动不算故障事件（与告警判定一致）
            .filter((e) => e.ongoing || e.checks_est >= failThreshold)
            .reverse();

          // 30 天色条（最左最新 → 最右最早，与首页一致）
          const dayMap = {};
          for (const r of dayRows.results || []) dayMap[r.d] = r;
          const bars = [];
          for (let i = 0; i < days; i++) {
            const dkey = new Date(Date.now() - i * 86400000 + 8 * 3600 * 1000)
              .toISOString()
              .slice(0, 10);
            const c = dayMap[dkey];
            bars.push({
              d: dkey,
              st:
                !c || !Number(c.n)
                  ? "none"
                  : Number(c.ok) >= Number(c.n)
                  ? "up"
                  : Number(c.ok) === 0
                  ? "down"
                  : "recovered",
              n: c ? Number(c.n) : 0,
              ok: c ? Number(c.ok) : 0,
            });
          }

          return json(
            {
              ok: true,
              now: new Date().toISOString(),
              // 详情页也要页头品牌名一致，所以一并带上展示类设置
              settings: {
                site_title: rawSettings.site_title || "站点状态",
                default_theme: rawSettings.default_theme || "auto",
              },
              site: {
                id: meta.id,
                name: meta.name,
                url: meta.url,
                group_name: meta.group_name || "未分组",
                probe_kind: resolveKind(meta, env),
                cf_hint: cfHintOf(meta, env),
                gp_magic: meta.gp_magic || null,
                expect_codes: meta.expect_codes || null,
                keyword: meta.keyword || null,
                fail_threshold: failThreshold,
                interval_min: intervalMin,
                enabled: meta.enabled,
                sort: meta.sort,
              },
              state,
              degrade_reason,
              consecutive_fail: Number(meta.consecutive_fail || 0),
              last: {
                ok: meta.last_ok,
                status: meta.last_status,
                ttfb: meta.last_ttfb,
                total: meta.last_total,
                source: meta.last_source,
                probe: meta.last_probe,
                ts: meta.last_ts,
                error: meta.last_error,
              },
              ssl,
              window: {
                hours,
                since,
                bucket_sec: bkt.sec,
                bucket_label: bkt.label,
                checks: n,
                ok: okl,
                failures: n - okl,
                uptime: n ? Math.round((okl / n) * 1000) / 10 : null,
              },
              latency: {
                avg: agg?.av ?? null,
                avg_total: agg?.av_total ?? null,
                min: agg?.mn ?? null,
                max: agg?.mx ?? null,
                p95: p95?.p95 ?? null,
              },
              series,
              recent: (recentRows.results || []).map((r) => ({
                ts: r.ts,
                ok: r.ok,
                status: r.status,
                ttfb: r.ttfb_ms,
                total: r.total_ms,
                source: r.source,
                probe: r.probe,
                error: r.error,
              })),
              incidents: evts,
              bars,
            },
            200,
            READ_CACHE,
            pretty
          );
        }, keyUrl);
      }

      // ── SSL 检测 ──
      // 统一走 Globalping（CF 直连拿不到证书）；低频，每站点每天一次即可
      // ── 分类管理 ──
      // 站点的分类归属存在 sites.group_name；这里维护显式分类表（支持空分类 + 顺序）。
      // 重命名 / 删除都会连带更新所有站点的 group_name，保证不会出现"孤儿分类"。
      if (api === "categories") {
        const d = await db(env);

        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const action = String(body.action || "").toLowerCase();
          const name = String(body.name || "").trim();
          // reorder 操作的是 names 数组，不需要单个 name
          if (action !== "reorder" && !name) {
            return json({ ok: false, error: "分类名不能为空" }, 400, "no-store", pretty);
          }
          const now = new Date().toISOString();

          if (action === "create") {
            const exists = await d
              .prepare("SELECT name FROM categories WHERE name = ?")
              .bind(name)
              .first();
            if (exists) {
              return json({ ok: false, error: `分类「${name}」已存在` }, 409, "no-store", pretty);
            }
            const mx = await d
              .prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories")
              .first();
            await d
              .prepare("INSERT INTO categories (name, sort, created_ts) VALUES (?,?,?)")
              .bind(name, Number(mx?.s || 1), now)
              .run();
            return json({ ok: true, action, name }, 200, "no-store", pretty);
          }

          if (action === "rename") {
            const nn = String(body.new_name || "").trim();
            if (!nn) {
              return json({ ok: false, error: "新名称不能为空" }, 400, "no-store", pretty);
            }
            if (nn === name) return json({ ok: true, action, name }, 200, "no-store", pretty);
            // 目标名已存在 → 直接合并过去，避免留下重复分类
            await d.batch([
              d
                .prepare("INSERT OR IGNORE INTO categories (name, sort, created_ts) VALUES (?,?,?)")
                .bind(nn, 9999, now),
              d.prepare("UPDATE sites SET group_name = ? WHERE group_name = ?").bind(nn, name),
              d.prepare("DELETE FROM categories WHERE name = ?").bind(name),
            ]);
            return json({ ok: true, action, name, new_name: nn }, 200, "no-store", pretty);
          }

          if (action === "delete") {
            // 站点不跟着删，统一落到「未分组」—— 删分类不该顺带删监控
            await d.batch([
              d.prepare("UPDATE sites SET group_name = ? WHERE group_name = ?").bind("未分组", name),
              d.prepare("DELETE FROM categories WHERE name = ?").bind(name),
            ]);
            return json({ ok: true, action, name }, 200, "no-store", pretty);
          }

          if (action === "reorder") {
            const names = Array.isArray(body.names) ? body.names.map(String) : [];
            if (!names.length) {
              return json({ ok: false, error: "names 不能为空" }, 400, "no-store", pretty);
            }
            await d.batch(
              names.map((n, i) =>
                d
                  .prepare("INSERT INTO categories (name, sort, created_ts) VALUES (?,?,?) " +
                    "ON CONFLICT(name) DO UPDATE SET sort = excluded.sort")
                  .bind(n, i + 1, now)
              )
            );
            return json({ ok: true, action, order: names }, 200, "no-store", pretty);
          }

          return json({ ok: false, error: `未知 action：${action}` }, 400, "no-store", pretty);
        }

        // GET：显式分类 ∪ 站点上出现的 group_name（并集，各带站点计数）
        return json({ ok: true, categories: await buildCategories(d) }, 200, "no-store", pretty);
      }

      // ── 排序：一次性提交完整顺序，按下标重写 sort ──
      // 为什么整批提交而不是逐条移动：拖拽一次可能跨多行，
      // 整批提交只有 1 个请求、且天然原子（D1 batch 在同一事务里执行）。
      if (api === "sort") {
        if (request.method !== "POST") {
          return json({ ok: false, error: "仅支持 POST" }, 405, "no-store", pretty);
        }
        const d = await db(env);
        const body = await request.json().catch(() => ({}));
        const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) {
          return json({ ok: false, error: "ids 不能为空" }, 400, "no-store", pretty);
        }
        await d.batch(
          ids.map((id, i) => d.prepare("UPDATE sites SET sort = ? WHERE id = ?").bind(i + 1, id))
        );
        return json({ ok: true, updated: ids.length }, 200, "no-store", pretty);
      }

      if (api === "sites") {
        const d = await db(env);
        if (request.method === "DELETE") {
          const id = url.searchParams.get("id");
          if (!id) return json({ ok: false, error: "缺少 id" }, 400);
          await d.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
          await d.prepare("DELETE FROM ssl WHERE site = ?").bind(id).run();
          await d.prepare("DELETE FROM state WHERE site = ?").bind(id).run();
          await d.prepare("DELETE FROM pending WHERE site = ?").bind(id).run();
          return json({ ok: true, deleted: id });
        }
        if (request.method === "POST") {
          const body = await request.json();
          const list = Array.isArray(body) ? body : [body];
          for (const s of list) {
            if (!s.id || !s.url) continue;
            await d
              .prepare(
                `INSERT INTO sites (id,name,url,group_name,expect_codes,keyword,probe_kind,cf_hint,gp_magic,fail_threshold,interval_min,enabled,sort)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(id) DO UPDATE SET
                   name=excluded.name, url=excluded.url,
                   group_name=excluded.group_name,
                   expect_codes=excluded.expect_codes, keyword=excluded.keyword,
                   probe_kind=excluded.probe_kind, cf_hint=excluded.cf_hint,
                   gp_magic=excluded.gp_magic, fail_threshold=excluded.fail_threshold,
                   interval_min=excluded.interval_min, enabled=excluded.enabled,
                   sort=excluded.sort`
              )
              .bind(
                s.id,
                s.name ?? s.id,
                normalizeUrl(s.url),
                s.group_name ?? "默认分组",
                s.expect_codes ?? "",
                s.keyword ?? null,
                s.probe_kind ?? null,
                s.cf_hint ?? null,
                s.gp_magic ?? null,
                Number(s.fail_threshold ?? 3),
                Number(s.interval_min ?? 5),
                s.enabled === false ? 0 : 1,
                Number(s.sort ?? 0)
              )
              .run();
          }
          return json({ ok: true, upserted: list.length });
        }
        // GET 不支持：读取一律走 /api/admin（一次返回站点+状态+分类+设置）
        return json({ ok: false, error: "请用 /api/admin" }, 405, "no-store", pretty);
      }

      /* ── 后台聚合接口：一次请求拿全（站点 + 最近状态 + 分类 + 设置）──
         为什么要有：后台原先串行发 /session → /sites → /categories 三次请求，
         跨国链路上每次往返 ~0.2s，加上首屏 HTML 就是 4 个 RTT。合并成 1 次后
         首屏只需「HTML + /admin」两个请求，后台打开速度接近减半。 */
      if (api === "admin") {
        const payload = await buildAdminPayload(env);
        return json(
          {
            ok: true,
            ...payload,
            // 复用请求开头已读到的 rawSettings，不再多查一次 D1
            settings: publicSettings(env, rawSettings),
            password_source: rawSettings.admin_password
              ? "db"
              : env.ADMIN_PASSWORD
              ? "env"
              : "none",
          },
          200,
          "no-store",
          pretty
        );
      }

      // 手动跑一轮（调试用）：?api=run&limit=3
      if (api === "run") {
        const sites = await loadSites(env);
        const limit = Number(url.searchParams.get("limit") || sites.length);
        const picked = sites.slice(0, limit);
        const collect = await collectGlobalping(env);
        const disp = await dispatch(env, picked);
        const persisted = await persistCf(env, picked, disp.cfResult);
        return json({ ok: true, collect, dispatch: disp, persisted });
      }

      // 单个后端的即时测试：?api=test&kind=cf|globalping&target=...&hint=|magic=
      if (api === "test") {
        const kind = url.searchParams.get("kind") || "cf";
        const target = url.searchParams.get("target") || "https://www.baidu.com";
        const timeoutMs = Number((env && env.TIMEOUT_MS) || 8000);
        if (kind === "cf") {
          const hint = url.searchParams.get("hint") || cfHintOf({}, env);
          const multi = url.searchParams.get("targets");
          const list = multi
            ? multi.split(",").map((u) => u.trim()).filter(Boolean).map((u) => ({ url: u, keyword: null }))
            : [{ url: target, keyword: url.searchParams.get("keyword") || null }];
          const t0 = Date.now();
          const out = await probeViaCf(env, hint, list, timeoutMs);
          return json({
            ok: true, kind: "cf", hint,
            count: list.length,
            egress: out.egress, wall: out.wall, roundTripMs: Date.now() - t0,
            results: out.results,
          });
        }
        const site = { url: target, gp_magic: url.searchParams.get("magic") || null };
        const { id, source, quota } = await gpCreate(env, site);
        let finished = null;
        for (let i = 0; i < 12 && !finished; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          const out = await gpCollect(env, { measurement_id: id });
          if (out.done) finished = out;
        }
        return json({ ok: true, kind: "globalping", source, quota, results: finished?.results || [] });
      }

      // 未知接口一律 404 —— 不再兜底返回 200 的服务信息，
      // 否则删掉的接口会一直"看起来还在"，掩盖调用方的错误。
      return json(
        {
          ok: false,
          error: `未知接口：${api || url.pathname}`,
          endpoints: [
            "GET  /api/overview  前台：统计 + 分组 + 30 天色条 + SSL（公开，边缘缓存）",
            "GET  /api/site?id=&hours=  详情页：窗口统计 + 序列 + 故障（公开）",
            "GET  /api/admin     后台：站点 + 状态 + 分类 + 证书 + 设置（需登录）",
            "POST /api/login  /api/logout",
            "GET/POST /api/settings",
            "GET/POST/DELETE /api/categories",
            "POST /api/sites（写）；POST /api/sort（排序）",
            "POST /api/run  手动跑一轮（调试）；GET /api/test  测单个后端（调试）",
          ],
        },
        404,
        "no-store",
        pretty
      );
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    const sites = await loadSites(env);
    // 先收取上一轮 Globalping 的结果，再发起本轮
    const collected = await collectGlobalping(env);
    const disp = await dispatch(env, sites);
    const persisted = await persistCf(env, sites, disp.cfResult);

    // SSL 低频补充：每轮只处理少量站点，避免子请求超限（详见 refreshSslStale 注释）
    let ssl = [];
    try {
      ssl = await refreshSslStale(env, sites, {
        maxAgeH: 24,
        limit: Number((env && env.SSL_PER_TICK) || 2),
      });
    } catch (e) {
      ssl = [{ error: String((e && e.message) || e) }];
    }

    // 每天一次的过期明细清理（保留 30 天）
    let cleaned = 0;
    if (isCleanupWindow()) {
      try {
        cleaned = await cleanupOldChecks(env, Number(env?.CHECK_KEEP_DAYS || 30));
      } catch (e) {
        cleaned = -1; // -1 表示失败，便于在日志里区分"删了 0 条"和"没跑成"
      }
    }

    console.log(
      JSON.stringify({
        cron: controller.cron,
        sites: sites.length,
        collected: collected.collected,
        dispatched: disp.started,
        gpStarted: disp.gpStarted,
        skipped: disp.skipped,
        subrequestsUsed: disp.used,
        persisted: persisted.persisted,
        alerts: persisted.alerts.length + collected.alerts.length,
        ssl,
        cleaned, // 0 = 不在清理时点或无过期数据；-1 = 清理失败
      })
    );
  },
};

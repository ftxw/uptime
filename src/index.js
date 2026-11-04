/** uptime —— 站点监测编排层。探测走 Globalping 两阶段（本轮发起、下轮收取），一次测量同时产出延迟、状态码与证书。 */

import {
  db,
  loadSettings,
  saveSetting,
  saveSettings,
  deleteSite,
  loadSites,
  insertChecks,
  bumpState,
  buildCategories,
  cleanupOldChecks,
  cleanupOrphans,
  saveSsl,
  saveSslBatch,
  upsertLastResult,
  bumpDailyManual,
  deleteBySites,
  sslDaysLeftSql,
  BATCH_CHUNK,
  chunk,
  UNGROUPED,
  ensureSchema,
  minuteIso,
} from "./db.js";
import { SCHEMA_STMTS } from "./schema.js";
import {
  judge,
  normalizeUrl,
  gpCreate,
  gpCollect,
  gpDecide,
} from "./probe.js";
import {
  constantTimeEqual,
  issueSession,
  verifySession,
  getSessionToken,
  buildSessionCookie,
  clearSessionCookie,
  createRateLimiter,
  randomHex,
  sha256Hex,
  sleep,
} from "./auth.js";
import { SETTING_META, SETTING_KEYS, defOf, validMagic, gpLimitNum } from "./settings.js";
// 「谁在哪跑的」统一口径 —— 三个前端共用这一个格式化函数（原因见模块注释）
import { formatOrigin } from "./origin.js";


const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** 只读接口的边缘缓存 TTL（秒）。刷新按钮带 no-cache，会绕过它。 */
const READ_TTL_SEC = 300;
const READ_CACHE = `public, max-age=0, s-maxage=${READ_TTL_SEC}, stale-while-revalidate=120`;

/** 会改配置的写接口才递增 config_version；test / run 只产生探测记录，不算。 */
const WRITE_APIS = new Set(["settings", "sites", "categories"]);

/** 默认输出紧凑 JSON（省流量）；调试时加 &pretty=1 才缩进 */
const json = (o, status = 200, cache = "no-store", pretty = false) =>
  new Response(pretty ? JSON.stringify(o, null, 2) : JSON.stringify(o), {
    status,
    headers: { ...JSON_HEADERS, "Cache-Control": cache },
  });

/** 把 D1 报错翻译成可执行的下一步。 */
function dbErrorHint(msg) {
  const m = String(msg || "");
  if (/D1\s*绑定缺失/.test(m))
    return "wrangler.toml 的 [[d1_databases]] 没生效（database_id 为空时会被跳过）。跑 npm run deploy 自动建库。";
  if (/no such table/i.test(m))
    return "库里没有表，且自动建表失败。先看 /api/health?pretty=1 的 db_bound；手工兜底：wrangler d1 execute <库名> --remote --file=schema.sql。";
  if (/no such column/i.test(m))
    return "库结构与 schema.sql 不一致。IF NOT EXISTS 不会给旧表补列，按提示 ALTER TABLE 或换库名重建。";
  if (/no such (function|module)/i.test(m)) return "SQLite 版本能力不足，检查 wrangler.toml 的 compatibility_date。";
  return null;
}

/** 部署自检要核对的表，从 SCHEMA_STMTS 推导，避免手工清单漂移。 */
const EXPECTED_TABLES = SCHEMA_STMTS.map(
  (s) => (s.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i) || [])[1]
).filter(Boolean);

/** dbErrorHint 的响应体片段（映射不到时返回空对象，不塞 null） */
const hintOf = (e) => {
  const h = dbErrorHint(String((e && e.message) || e));
  return h ? { hint: h } : {};
};

/** 部署自检。默认只查绑定；?deep=1 且已登录才查表结构与探针健康。 */
async function buildHealth(env, pwdConfigured, pretty, schema, opts = {}) {
  const deep = Boolean(opts.deep && opts.authed);
  const out = {
    ok: true,
    db_bound: Boolean(env && env.DB),
    db_ready: false,
    deep,
    password_set: Boolean(pwdConfigured),
    schema: {
      // created = 本次新建；ready = 已就位；failed = 建表失败
      applied: schema && schema.ok ? (schema.created ? "created" : "ready") : "failed",
    },
    tables: [],
    missing_tables: [],
  };

  if (schema && !schema.ok) {
    out.schema.error = schema.error;
    const h = dbErrorHint(schema.error);
    if (h) out.schema.hint = h;
  }

  if (!out.db_bound) {
    out.ok = false;
    out.hint = dbErrorHint("D1 绑定缺失");
    return json(out, 500, "no-store", pretty);
  }

  // 浅检查到此为止
  if (!deep) {
    out.db_ready = Boolean(schema && schema.ok);
    out.hint = "完整检查需要登录后访问 /api/health?deep=1";
    return json(out, out.ok ? 200 : 500, "no-store", pretty);
  }

  try {
    const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const have = new Set(
      (r.results || [])
        .map((x) => x.name)
        .filter((n) => n && !String(n).startsWith("_cf_"))
    );
    out.tables = EXPECTED_TABLES.filter((t) => have.has(t));
    out.missing_tables = EXPECTED_TABLES.filter((t) => !have.has(t));
    out.db_ready = out.missing_tables.length === 0;
    if (!out.db_ready) {
      out.ok = false;
      out.hint = dbErrorHint("no such table");
    }
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.message) || e);
    out.hint = "D1 绑定存在但查询失败：库被删除 / 无权限 / 额度耗尽。";
  }

  // 探针健康：区分"站点挂了"和"我们没测到"。
  try {
    if (out.db_ready) {
      const r = await env.DB.prepare(
        "SELECT key, value FROM meta WHERE key LIKE 'gp\\_%' ESCAPE '\\'"
      ).all();
      out.probe = probeHealthOf(Object.fromEntries((r.results || []).map((x) => [x.key, x.value])));
    }
  } catch (e) {
    out.probe = { error: String((e && e.message) || e) };
  }

  return json(out, out.ok ? 200 : 500, "no-store", pretty);
}

/** 读 meta 里的 JSON 值：脏数据不该把 /api/health 一起弄挂。 */
function parseJsonOrNull(v) {
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** 探针健康快照，直接吃已读到的 meta。 */
function probeHealthOf(raw) {
  const blocked = Number(raw?.gp_blocked_until || 0);
  const okAt = raw?.gp_last_ok_ts ? Date.parse(raw.gp_last_ok_ts) : 0;
  const errAt = raw?.gp_last_error_ts ? Date.parse(raw.gp_last_error_ts) : 0;
  const lastAt = Math.max(okAt || 0, errAt || 0);
  return {
    last_checked_ts: lastAt ? minuteIso(lastAt) : null,
    last_ok_ts: raw?.gp_last_ok_ts || null,
    last_error: raw?.gp_last_error || null,
    last_error_ts: raw?.gp_last_error_ts || null,
    blocked_until: blocked > Date.now() ? minuteIso(blocked) : null,
    quota: parseJsonOrNull(raw?.gp_quota),
  };
}

/** 同源校验（防 CSRF）：SameSite=Lax 允许顶层 GET 带 cookie，不能只靠它。 */
function sameOriginOk(request, url) {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host === url.host;
    } catch {
      return false;
    }
  }
  const sfs = request.headers.get("sec-fetch-site");
  if (sfs) return sfs === "same-origin" || sfs === "none";
  // 两者都没有 ⇒ 无法判定来源，一律拒绝（fail closed）
  return false;
}

/** 有副作用的接口一律要求 POST，避免 GET 被导航/预取/爬虫意外触发 */
function requirePost(request, pretty) {
  if (request.method === "POST") return null;
  return json({ ok: false, error: "仅支持 POST" }, 405, "no-store", pretty);
}

/** 用 Cache API 做边缘缓存：只加 Cache-Control 不会让 CF 缓存 Worker 响应。 */
async function withEdgeCache(request, ctx, ttl, producer, keyUrl) {
  const key = new Request(keyUrl || request.url, { method: "GET" });
  const cache = caches.default;

  // 客户端要求绕过缓存（刷新按钮）时直接回源
  const cc = String(request.headers.get("cache-control") || "").toLowerCase();
  const pragma = String(request.headers.get("pragma") || "").toLowerCase();
  const bypass = cc.includes("no-store") || cc.includes("no-cache") || pragma === "no-cache";
  if (bypass) {
    const fresh = await producer();
    return new Response(await fresh.text(), {
      status: fresh.status,
      headers: { ...JSON_HEADERS, "Cache-Control": "no-store", "x-edge-cache": "BYPASS" },
    });
  }
  try {
    const hit = await cache.match(key);
    if (hit) {
      const text = await hit.text();
      return new Response(text, {
        status: 200,
        headers: {
          ...JSON_HEADERS,
          "Cache-Control": `public, max-age=0, s-maxage=${ttl}`,
          "x-edge-cache": "HIT",
        },
      });
    }
  } catch {}

  const res = await producer();
  const status = res.status;
  const text = await res.text();

  /** 只缓存 200，并原样返回原始状态码。 */
  const cacheable = status === 200 && !res.headers.get("set-cookie");
  const headers = cacheable
    ? { ...JSON_HEADERS, "Cache-Control": `public, max-age=0, s-maxage=${ttl}` }
    : {
        ...JSON_HEADERS,
        "Cache-Control": res.headers.get("cache-control") || "no-store",
      };

  if (cacheable) {
    try {
      await cache.put(key, new Response(text, { status: 200, headers }));
    } catch {}
  }
  return new Response(text, {
    status,
    headers: { ...headers, "x-edge-cache": cacheable ? "MISS" : "BYPASS" },
  });
}

/** 读配置版本用于缓存 key，从已读到的设置里取，不额外查 D1。 */
function configVersionOf(rawSettings) {
  const v = rawSettings && rawSettings.config_version;
  return v ? String(v) : "0";
}

/** 写操作后只递增 config_version 让缓存 key 失效，不逐条 delete 缓存。 */
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

/** 后台聚合：站点 + 最近状态 + 证书一次 JOIN，分类另取。 */
async function buildAdminPayload(env) {
  const d = await db(env);

  // 「最新一条」读 state 快照，不对 checks 做分区排序（后者随保留天数线性变慢）。
  const [rowsRes, cats] = await Promise.all([
    d
      .prepare(
        `SELECT s.*,
                st.last_ok      AS last_ok,
                st.last_status  AS last_status,
                st.last_ttfb_ms AS last_ttfb,
                st.last_source  AS last_source,
                st.last_probe   AS last_probe,
                st.last_ts      AS last_ts,
                st.last_error   AS last_error,
                st.consecutive_fail AS state_fail,
                st.void_streak      AS state_void,
                ss.checked_ts AS ssl_checked_ts,
                ss.authorized AS ssl_authorized,
                ss.protocol   AS ssl_protocol,
                ss.issuer     AS ssl_issuer,
                ss.subject    AS ssl_subject,
                ss.key_type   AS ssl_key_type,
                ss.expires_at AS ssl_expires_at,
                ${sslDaysLeftSql("ss.")} AS ssl_days_left,
                ss.error      AS ssl_error
         FROM sites s
         LEFT JOIN state st ON st.site = s.id
         -- 只读已有证书结果，绝不在渲染路径上触发检测。
         LEFT JOIN ssl ss ON ss.site = s.id
         ORDER BY s.sort, s.id`
      )
      .all(),
    buildCategories(d),
  ]);

  const lastMap = Object.fromEntries(
    (rowsRes.results || []).map((r) => [
      r.id,
      {
        site: r.id,
        ok: r.last_ok,
        status: r.last_status,
        ttfb_ms: r.last_ttfb,
        source: r.last_source,
        probe: r.last_probe,
        ts: r.last_ts,
        consecutive_fail: Number(r.state_fail || 0),
        void_streak: Number(r.state_void || 0),
      },
    ])
  );
  const sslMap = Object.fromEntries(
    (rowsRes.results || []).map((r) => [
      r.id,
      {
        site: r.id,
        checked_ts: r.ssl_checked_ts,
        authorized: r.ssl_authorized,
        protocol: r.ssl_protocol,
        issuer: r.ssl_issuer,
        subject: r.ssl_subject,
        key_type: r.ssl_key_type,
        expires_at: r.ssl_expires_at,
        days_left: r.ssl_days_left,
        error: r.ssl_error,
      },
    ])
  );
  const sites = (rowsRes.results || []).map((s) => {
    const ssl = sslMap[s.id] || null;
    const merged = {
      ...s,
      last_ok: lastMap[s.id]?.ok ?? null,
      last_status: lastMap[s.id]?.status ?? null,
      last_ttfb: lastMap[s.id]?.ttfb_ms ?? null,
      last_source: lastMap[s.id]?.source ?? null,
      last_probe: lastMap[s.id]?.probe ?? null,
      origin: originOf(s, lastMap[s.id]?.source, lastMap[s.id]?.probe, env),
      last_ts: lastMap[s.id]?.ts ?? null,
      // 这两个字段供 stateOf 判定「确认中」与「探针无结论」，缺了前后台会各说各话
      consecutive_fail: lastMap[s.id]?.consecutive_fail ?? 0,
      void_streak: lastMap[s.id]?.void_streak ?? 0,
      // 摊平成 ssl_* 前缀，与 overview 的 SQL 别名保持同形
      ssl_checked_ts: ssl?.checked_ts ?? null,
      ssl_authorized: ssl?.authorized ?? null,
      ssl_protocol: ssl?.protocol ?? null,
      ssl_issuer: ssl?.issuer ?? null,
      ssl_subject: ssl?.subject ?? null,
      ssl_key_type: ssl?.key_type ?? null,
      ssl_expires_at: ssl?.expires_at ?? null,
      ssl_days_left: ssl?.days_left ?? null,
      ssl_error: ssl?.error ?? null,
    };
    const { state, degrade_reason } = stateOf(merged, env);
    return { ...merged, state, degrade_reason };
  });

  return {
    sites,
    categories: cats,
    has_globalping_token: Boolean(env && env.GLOBALPING_TOKEN),
  };
}

/** 是否该清理过期明细：按「上次成功清理时间」判断，固定时刻窗口漏跑就漏一天。 */
const CLEANUP_INTERVAL_MS = 20 * 3600 * 1000;
function shouldCleanup(rawSettings) {
  const last = Number(rawSettings.last_cleanup_ts || 0);
  return !last || Date.now() - last >= CLEANUP_INTERVAL_MS;
}

/** 记录清理结果，让"清理卡住"可见，而不是等 D1 写满才发现。 */
async function noteCleanup(env, ok) {
  await saveSettings(env, [
    ["last_cleanup_ok", ok ? "1" : "0"],
    ["last_cleanup_err_ts", ok ? "" : minuteIso()],
  ]).catch(() => {});
}

/** Globalping 位置筛选：同样是全局设置。null 表示用 probe.js 的内置默认 */
function gpMagicOf(env) {
  return (env && env.GP_MAGIC) || null;
}

/** 来源标签：有记录时用最近一次实际跑的探针，探针会换城市，如实显示才能解释延迟变化。 */
function originOf(site, lastSource, lastProbe, env) {
  const real = formatOrigin(lastSource, lastProbe);
  if (real) return real;
  return formatOrigin(`gp:${gpMagicOf(env) || defOf("gp_magic")}`, null);
}

/** 证书降级阈值（天）。走 clampInt：环境变量写成 "14 天" 会让裸 Number() 得到 NaN。 */
function sslWarnDays(env) {
  return clampInt(
    env?.SSL_WARN_DAYS ?? defOf("ssl_warn_days"),
    0,
    90,
    Number(defOf("ssl_warn_days"))
  );
}

/** 「响应偏慢」的绝对阈值（毫秒），0 = 关闭该项降级。 */
function slowMs(env) {
  return clampInt(env?.SLOW_MS ?? defOf("slow_ms"), 0, 60000, Number(defOf("slow_ms")));
}

/** 连续几轮拿不到结论就降级（1 分钟 cron 下 3 轮 ≈ 3 分钟；5 分钟间隔的站点 ≈ 15 分钟）。 */
const VOID_DEGRADE_AFTER = 3;

/** 三态判定：降级 = 证书无效 / 剩余天数不足 / 响应超过 slow_ms / 探针连续无结论；down 不参与降级。 */
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

  // 连续失败未达阈值标黄（疑似），达到才标红
  const threshold = Math.max(1, Number(s.fail_threshold || 3));
  // 手动测失败时 consecutive_fail 仍为 0，按 1 次算
  const streak = state === "down" ? Math.max(1, Number(s.consecutive_fail || 0)) : 0;
  const pending = state === "down" && streak < threshold;

  // 探针连续无结论也要降级，否则 GP 挂掉时所有站点会永远绿着
  const voidStreak = Number(s.void_streak || 0);

  if (state !== "down" && voidStreak >= VOID_DEGRADE_AFTER) {
    state = "degraded";
    degrade_reason = `探针连续 ${voidStreak} 轮无结论`;
  } else if (pending) {
    state = "degraded";
    degrade_reason = `疑似故障（确认中 ${streak}/${threshold}）`;
  } else if (state !== "down") {
    // 只保留一个降级原因，故障中的站点不再叠加证书与延迟
    const slow = slowMs(env);
    const warnDays = sslWarnDays(env);
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
    } else if (slow > 0 && (s.last_ttfb || 0) > slow) {
      state = "degraded";
      degrade_reason = `响应偏慢 ${s.last_ttfb}ms`;
    }
  }
  return { state, degrade_reason, ssl };
}

/**
 * 趋势图：24 小时窗口，n 个槽用 n+1 个边界点绘制（两端都要精确）。
 * 窗口右端取最后一次检查；槽宽 = max(监测间隔, 跨度/24)；空槽保留为断口。
 */
const TREND_HOURS = 24;
/** 满窗口时每个槽的宽度（秒）。数据不足 24 小时时由 跨度/槽数 现算。 */
const TREND_BUCKET_SEC = 3600;

/** 色条最多能要几天 = min(90, 明细保留天数)，超出的格子必然永远是空的。 */
function maxDays(env) {
  const keep = clampInt(
    env?.CHECK_KEEP_DAYS ?? SETTING_META.check_keep_days.def,
    1,
    365,
    Number(SETTING_META.check_keep_days.def)
  );
  return Math.max(1, Math.min(90, keep));
}

/* ────────────────────────────── 存储层 ────────────────────────────── */

/* ────────────────────────── 站点设置（存 D1，后台可改）────────────────────────── */
/* 设置项清单、环境变量映射与默认值都在 src/settings.js —— 那里是唯一来源 */

/** 不对外暴露的内部状态键，后台读写接口都碰不到。 */

/** 把 D1 设置合并进 env，一处覆盖、全链路生效。 */
async function effectiveEnv(env, S) {
  const s = S || (await loadSettings(env));
  const merged = Object.assign({}, env);
  for (const [k, m] of Object.entries(SETTING_META)) {
    if (!m.env) continue; // 纯展示项（主题/标题）不写进 env，读侧直接从 meta 取
    merged[m.env] = s[k] !== undefined && s[k] !== "" ? s[k] : env[m.env] || m.def;
  }
  return merged;
}

/** 「一天」从哪一刻起算：色条格子与按天汇总的唯一时区来源（写入侧见 db.js 的 dayKey）。 */
function dayOffsetMs(env) {
  const min = clampInt(
    env?.UTC_OFFSET_MIN ?? SETTING_META.utc_offset_min.def,
    -720,
    840,
    SETTING_META.utc_offset_min.def
  );
  return min * 60000;
}

/** 按 key 规范化取值，写入前拦截非法值。 */
function normalizeSetting(k, v) {
  const def = SETTING_META[k]?.def ?? "";
  const num = (min, max) =>
    String(clampInt(v === undefined || v === null || v === "" ? def : v, min, max, def));
  switch (k) {
    case "ssl_warn_days":
      return num(0, 90);
    case "slow_ms":
      return num(0, 60000);
    case "subreq_budget":
      return num(1, 35);
    case "check_keep_days":
      return num(1, 365);
    case "recent_limit":
      return num(5, 200);
    case "incident_limit":
      return num(1, 100);
    case "utc_offset_min":
      return num(-720, 840);
    case "gp_timeout_sec":
      return num(5, 30);
    case "gp_ip_version":
      return v === "6" ? "6" : SETTING_META.gp_ip_version.def;
    case "gp_limit":
      return String(gpLimitNum(v));
    case "gp_magic":
      return validMagic(v) || defOf(k);
    case "default_theme":
      return ["auto", "light", "dark"].includes(v) ? v : SETTING_META.default_theme.def;
    case "site_title":
      return v.slice(0, 60);
    case "globalping_token":
      return String(v ?? "").slice(0, 128);
    default:
      return String(v ?? "").slice(0, 200);
  }
}

/** 会话签名密钥：优先 ADMIN_SECRET，否则用 D1 随机值。 */
async function sessionSecret(env, S) {
  if (env.ADMIN_SECRET) return env.ADMIN_SECRET;
  const s = S || (await loadSettings(env));
  if (s.session_secret) return s.session_secret;

  const d = await db(env);
  const mine = randomHex(32);
  await d
    .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('session_secret', ?)")
    .bind(mine)
    .run();
  const row = await d
    .prepare("SELECT value FROM meta WHERE key = 'session_secret'")
    .first();
  return String(row?.value || mine);
}

/** 会话纪元：递增即作废所有已签发会话。 */
function sessionEpoch(S) {
  const n = Number(S && S.session_epoch);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** 递增会话纪元（登出所有设备）。返回新纪元，失败返回 null */
async function bumpSessionEpoch(env) {
  try {
    const d = await db(env);
    await d
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('session_epoch', '1') " +
          "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
      )
      .run();
    const row = await d
      .prepare("SELECT value FROM meta WHERE key = 'session_epoch'")
      .first();
    return Number(row?.value || 1);
  } catch {
    return null;
  }
}

/** token 脱敏展示：只留前 4 后 4 */
function maskToken(v) {
  const t = String(v || "");
  if (!t) return "";
  if (t.length <= 10) return "****";
  return `${t.slice(0, 4)}****${t.slice(-4)}`;
}

const loginLimiter = createRateLimiter(5, 60_000);
/** 即时测试的频率闸门（每 10 秒一次）。只防后台手滑连点，不做安全承诺。 */
const testLimiter = createRateLimiter(1, 10_000);

/* ─────────────────────── 入参校验 ─────────────────────── */

/** 服务端必须自己校验：绕过页面直接调接口时，前端的 Number/trim 完全不存在。 */

/** 钳到整数区间；非数字返回默认值（而不是 NaN 落库） */
function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 0/1 开关列：接受布尔、数字 1、字符串 "1"，其余一律 0。 */
function boolInt(v) {
  return v === true || v === 1 || v === "1" ? 1 : 0;
}

/** 解析查询参数里的整数：searchParams 缺省返回 null 而 Number(null) 是 0，不能用 clampInt 代替。 */
function queryInt(raw, dflt, min, max) {
  if (raw === null || raw === undefined) return dflt;
  const s = String(raw).trim();
  if (s === "") return dflt;
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt;
}

/** 站点 ID 白名单 [A-Za-z0-9._-]{1,64}：id 会进 URL，黑名单永远漏。 */
const SITE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** 正则放行 . 与 ..，必须单独排除（路径语义有歧义）。 */
function validSiteId(id) {
  if (typeof id !== "string") return false;
  const v = id.trim();
  if (v === "." || v === "..") return false;
  return SITE_ID_RE.test(v);
}

/** 只接受 http/https —— 阻断 javascript: / data: 等 scheme 落到 href 上被执行 */
function validHttpUrl(u) {
  // 长度上限：超长 URL 会落库并被每一轮 cron 读出来做探测，2KB 已是浏览器与
  // 常见反代的实际上限（Nginx 默认 8K 请求行，但没人会用它做监控目标）。
  if (String(u).length > 2048) return false;
  try {
    const p = new URL(String(u));
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
}

/** expect_codes 形如 "200,301"：只允许数字与逗号 */
function validExpectCodes(v) {
  const s = String(v ?? "").trim();
  if (!s) return true; // 空 = 接受 2xx/3xx，合法
  // 格式合法不代表长度合理："200,200,200..." 可以写到 MB 级。
  // 64 字符 ≈ 16 个状态码，远超实际需要。
  if (s.length > 64) return false;
  return /^\d{3}(,\d{3})*$/.test(s);
}

/** 登录失败计数，存 meta.login_fail：{ "<ip 哈希前16位>": [ts,...] }。 */
const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_KEYS = 64;

function parseLoginFails(raw) {
  try {
    const m = JSON.parse(raw?.login_fail || "{}");
    if (!m || typeof m !== "object" || Array.isArray(m)) return {};
    const out = {};
    for (const [k, v] of Object.entries(m)) {
      if (!Array.isArray(v)) continue;
      const arr = v.map(Number).filter((n) => Number.isFinite(n));
      if (arr.length) out[k] = arr;
    }
    return out;
  } catch {
    return {};
  }
}

const recentFails = (arr, now) => (arr || []).filter((t) => now - t < LOGIN_WINDOW_MS);

function loginBlocked(raw, key) {
  const now = Date.now();
  return recentFails(parseLoginFails(raw)[key], now).length >= LOGIN_MAX_FAILS;
}

async function recordLoginFail(env, raw, key) {
  const now = Date.now();
  const map = parseLoginFails(raw);
  const arr = recentFails(map[key], now);
  arr.push(now);
  map[key] = arr;

  // 只保留最近活跃的 N 个来源
  const keep = Object.keys(map)
    .filter((k) => recentFails(map[k], now).length > 0)
    .sort((a, b) => Math.max(...recentFails(map[b], now)) - Math.max(...recentFails(map[a], now)))
    .slice(0, LOGIN_MAX_KEYS);

  const pruned = {};
  for (const k of keep) pruned[k] = recentFails(map[k], now);
  await saveSetting(env, "login_fail", JSON.stringify(pruned));
}

async function clearLoginFail(env, raw, key) {
  const map = parseLoginFails(raw);
  if (!map[key]) return;
  delete map[key];
  await saveSetting(env, "login_fail", Object.keys(map).length ? JSON.stringify(map) : "");
}

/** 会话有效期 30 天 */
const SESSION_TTL = 30 * 86400;

/** 设置项的最终生效值，用于回显后台表单。 */
function effectiveSettingValue(env, raw, k) {
  const m = SETTING_META[k];
  if (!m) return raw[k] ?? "";
  return m.env ? env[m.env] || m.def : raw[k] || m.def;
}

/** 设置的对外表示：token 永不回传明文，只给掩码与是否存在。 */
function publicSettings(env, raw) {
  const s = {};
  for (const k of SETTING_KEYS) s[k] = effectiveSettingValue(env, raw, k);
  s.globalping_token = "";
  s.globalping_token_masked = maskToken(env.GLOBALPING_TOKEN);
  s.has_globalping_token = Boolean(env.GLOBALPING_TOKEN);
  return s;
}

/**
 * 会话校验。抽出来是因为 /api/health 也要用（它跑在 loadSettings 之前）。
 * rawSettings 为 null 时自己读一次设置 —— 只有 health 走那条路。
 */
async function isAuthed(request, env, rawSettings, pwdConfigured) {
  if (!(pwdConfigured ?? Boolean(env.ADMIN_PASSWORD))) return false;
  const token = getSessionToken(request.headers.get("cookie"));
  if (!token) return false;
  try {
    const S = rawSettings || (await loadSettings(env));
    return Boolean(await verifySession(token, await sessionSecret(env, S), sessionEpoch(S)));
  } catch {
    return false;
  }
}

/* ────────────────────────── 两阶段调度 ────────────────────────── */

/** pending 最长存活时间。created_ts 只到分钟，故留足余量。 */
const PENDING_TTL_MS = 300_000;

/**
 * 阶段一：收取上一轮发起的测量。
 * @param sitesIn 调用方已有的站点清单，不传则自己查
 */
async function collectGlobalping(env, sitesIn) {
  const d = await db(env);
  const { results: pending } = await d.prepare("SELECT * FROM pending").all();
  // 空数组分支的返回结构必须与下方完整分支一致，否则调用方取字段会 TypeError
  if (!pending || !pending.length)
    return {
      collected: 0,
      fetched: 0,
      dropped: [],
      voided: 0,
      voidSites: [],
      sslWritten: 0,
      // 收取侧 429 的退避截止时间；null = 本轮没被限流
      blockedUntil: null,
      // 本轮没被收走的 pending（还在跑 / 被限流而跳过）—— 供 dispatch 复用，省一次查询。
      remaining: [],
      // 发起 → 回收的最大滞后（毫秒）；空轮没有样本，给 0
      collectLagMs: 0,
    };

  const sites = sitesIn || (await loadSites(env));
  const byId = Object.fromEntries(sites.map((s) => [s.id, s]));
  const rows = [];
  const perSite = {};
  const doneIds = [];
  const sslWrites = [];
  const dropped = []; // 被丢弃且没写检查记录的 pending
  const voidSet = new Set(); // 拿不到结论的站点
  let fetched = 0; // 本次收取的子请求数
  let blockedUntil = null; // 收取侧 429 的退避截止
  const remaining = []; // 仍在跑的 pending，交给 dispatch 复用
  const collectAt = Date.now();
  let collectLagMs = 0; // 发起 → 回收的最大滞后

  for (const p of pending) {
    // 超时或时间无法解析的 pending 直接丢弃
    const born = Date.parse(p.created_ts);
    if (!Number.isFinite(born) || Date.now() - born > PENDING_TTL_MS) {
      dropped.push({
        site: p.site,
        id: p.measurement_id,
        why: "ttl",
        age_ms: Number.isFinite(born) ? Date.now() - born : null,
      });
      doneIds.push(p.site);
      if (byId[p.site]) voidSet.add(p.site);
      continue;
    }

    let out;
    try {
      fetched++;
      out = await gpCollect(env, p);
    } catch (e) {
      // 收取失败就丢弃，避免 pending 永久占位。同样不记检查记录（不知道站点当时的状态）
      dropped.push({
        site: p.site,
        id: p.measurement_id,
        why: "throw",
        error: String((e && e.message) || e),
      });
      doneIds.push(p.site);
      if (byId[p.site]) voidSet.add(p.site);
      continue;
    }
    if (!out.done) {
      remaining.push(p.site); // 还没跑完，留到下一轮
      continue;
    }
    doneIds.push(p.site);

    // 结果不可用：丢弃 pending 但不写检查记录，否则把「没拿到数据」谎报成故障。
    if (out.broken) {
      dropped.push({
        site: p.site,
        id: p.measurement_id,
        why: out.rateLimited ? "rate-limit" : "broken",
        error: out.error,
      });
      if (byId[p.site]) voidSet.add(p.site);
      // 记录退避截止时间
      if (out.rateLimited) {
        blockedUntil = Math.max(blockedUntil || 0, Date.now() + Number(out.retryAfterMs || 60_000));
      }
      continue;
    }

    const site = byId[p.site];
    if (!site) continue;

    // ── 多探针判定（口径与理由见 probe.js 的 gpDecide）──
    const dec = gpDecide(site, out.results);
    if (dec.void) {
      // 平台故障 / 无结果 / 单票失败都没有结论，一律不写检查记录。
      dropped.push({
        site: p.site,
        id: p.measurement_id,
        why: "vote-" + dec.why,
        status: out.status ?? null,
        ok_votes: dec.okCount ?? null,
        total: dec.total ?? null,
        platform_faults: dec.platformFaults ?? 0,
      });
      if (byId[p.site]) voidSet.add(p.site);
      continue;
    }

    const r0 = dec.pick;
    // 全通不标注，有分歧或失败才标 (1/3)
    const probeLabel =
      dec.ok && dec.unanimous
        ? r0.probe || null
        : `${r0.probe || "?"} (${dec.okCount}/${dec.total})`;

    // 用发起时刻而非回收时刻：后者随测量耗时摆动
    const firedAt = minuteIso(Number.isFinite(born) ? born : collectAt);
    if (Number.isFinite(born)) collectLagMs = Math.max(collectLagMs, collectAt - born);

    rows.push({
      ts: firedAt,
      site: p.site,
      source: p.source,
      probe: probeLabel,
      ok: dec.ok,
      status: r0.status ?? 0,
      ttfb_ms: r0.ttfb ?? 0,
      total_ms: r0.total ?? 0,
      error: dec.reason,
    });
    perSite[p.site] = {
      ok: dec.ok,
      status: r0.status ?? 0,
      ttfb: r0.ttfb ?? 0,
      total: r0.total ?? 0,
      reason: dec.reason,
      threshold: Number(site.fail_threshold || 3),
      source: p.source,
      probe: probeLabel,
      checkedAt: firedAt,
    };
    if (r0.tls) sslWrites.push([p.site, r0.tls]);
  }

  if (rows.length) await insertChecks(env, rows);
  // 分片 IN 一次删完（deleteBySites 内部按 90 个参数分片）
  if (doneIds.length) await deleteBySites(env, "pending", doneIds);
  await bumpState(env, perSite, [...voidSet]);
  // 只在握手成功时写证书；失败时保持原值（连不上不代表证书变了）
  if (sslWrites.length) await saveSslBatch(env, sslWrites).catch(() => {});
  return {
    collected: rows.length,
    fetched,
    dropped,
    voided: voidSet.size,
    voidSites: [...voidSet],
    sslWritten: sslWrites.length,
    blockedUntil,
    remaining,
    // 本轮「发起 → 回收」的最大滞后：≈1 轮属正常，突然 ≥2 轮说明有测量慢到跨轮
    collectLagMs,
  };
}

/**
 * 是否到期：距上次发起已满设定分钟数。
 * 只比「分」，秒一律截掉；now 补 1 秒是因为 cron 在 :59.4 就触发。
 */
function isDue(last, intervalMin, nowMs) {
  const ivMin = Math.max(1, Math.round(Number(intervalMin || 5)));
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!last) return true;
  const ms = typeof last === "number" ? last : Date.parse(last);
  if (!Number.isFinite(ms)) return true;
  if (ms > now) return true; // 时钟错乱 / 未来时刻：别让站点停摆

  const lastMin = Math.floor(ms / 60_000);
  const nowMin = Math.floor((now + 1_000) / 60_000);
  return nowMin - lastMin >= ivMin;
}

/** 挑出本轮到期的站点：只看 state.last_checked_ts，不读任何「排期状态」。 */
async function dueSites(env, sites) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT site, last_checked_ts FROM state").all();
  const lastOf = new Map((results || []).map((r) => [r.site, r.last_checked_ts]));
  const now = Date.now();
  return sites.filter((s) => isDue(lastOf.get(s.id), s.interval_min, now));
}

/** 记录本轮调度事实，失败不影响主流程。 */
async function logRound(env, row) {
  try {
    const d = await db(env);
    await d
      .prepare(
        "INSERT OR REPLACE INTO rounds " +
          "(ts, sched_ts, delay_ms, dur_ms, due_n, started_n, failed_n, collected_n, skipped_n, err) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        row.ts,
        row.sched_ts ?? null,
        row.delay_ms ?? null,
        row.dur_ms ?? null,
        row.due_n ?? 0,
        row.started_n ?? 0,
        row.failed_n ?? 0,
        row.collected_n ?? 0,
        row.skipped_n ?? 0,
        row.err ?? null
      )
      .run();
  } catch {
    // 观测失败不能变成新的故障点
  }
}

/**
 * 阶段二：发起本轮测量。
 */
async function dispatch(env, sites, opts = {}) {
  const budget = Number((env && env.SUBREQ_BUDGET) || 30);
  const d = await db(env);
  let used = Math.max(0, Number(opts.alreadyUsed) || 0);
  const raw = opts.raw || {};
  const alreadyVoid = new Set(opts.voided || []);
  const skipped = [];
  const failures = []; // 发起失败明细，随 rounds.err 落库
  const voidSites = [];

  // 已在 pending 里的站点跳过；调用方给过就用给的
  let pendingSites = Array.isArray(opts.pendingSites) ? opts.pendingSites : null;
  if (!pendingSites) {
    const { results: pend } = await d.prepare("SELECT site FROM pending").all();
    pendingSites = (pend || []).map((p) => p.site);
  }
  const pendingSet = new Set(pendingSites);

  // 429 退避窗口内一个都不发
  let blockedUntil = Math.max(
    Number(raw.gp_blocked_until || 0) || 0,
    Number(opts.blockedUntil || 0) || 0
  );
  const blocked = blockedUntil > Date.now();

  const gpStarted = [];
  const started = []; // 成功发起的 [site, 发起时刻]
  let scheduleError = null;
  let quota = null;
  let lastError = null;
  let okCount = 0;
  let failCount = 0;

  const noteVoid = (id) => {
    if (alreadyVoid.has(id)) return;
    alreadyVoid.add(id);
    voidSites.push(id);
  };

  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    if (pendingSet.has(s.id)) continue;
    if (blocked) {
      // 退避中：计为无结论，退避结束下一轮补上
      skipped.push(s.id);
      noteVoid(s.id);
      continue;
    }
    if (used + 1 > budget) {
      // 子请求预算不足
      skipped.push(s.id);
      continue;
    }
    used += 1;
    try {
      const { id, source, quota: q } = await gpCreate(env, s);
      const startedAt = minuteIso();
      await d
        .prepare(
          "INSERT OR REPLACE INTO pending (site, measurement_id, source, created_ts) VALUES (?,?,?,?)"
        )
        .bind(s.id, id, source, startedAt)
        .run();
      // 发起即视为已检查
      started.push([s.id, startedAt]);
      gpStarted.push({ site: s.id, id, source, quota: q });
      okCount++;
      if (q && (q.limit || q.remaining)) quota = q;
    } catch (e) {
      const msg = String((e && e.message) || e);
      gpStarted.push({ site: s.id, error: msg });
      failCount++;
      lastError = msg;
      noteVoid(s.id);
      failures.push({
        site: s.id,
        code: (e && e.code) || (e && e.gp && e.gp.status) || "error",
        at: minuteIso(),
        ...(e && e.gp ? { gp: e.gp } : {}),
        msg: msg.slice(0, 160),
      });

      // 429：停止本轮后续发起并记退避
      if (e && e.code === "rate_limit") {
        blockedUntil = Math.max(blockedUntil, Date.now() + Number(e.retryAfterMs || 60_000));
        for (let j = i + 1; j < sites.length; j++) {
          if (pendingSet.has(sites[j].id)) continue;
          skipped.push(sites[j].id);
          noteVoid(sites[j].id);
        }
        break;
      }
    }
  }

  // 探针健康快照，只在本轮真尝试过时写
  const entries = [];
  const nowIso = minuteIso();
  if (okCount) entries.push(["gp_last_ok_ts", nowIso]);
  if (lastError) {
    entries.push(["gp_last_error", lastError.slice(0, 240)]);
    entries.push(["gp_last_error_ts", nowIso]);
  } else if (okCount) {
    entries.push(["gp_last_error", ""]); // 恢复正常，清掉上一条错误
  }
  if (quota) entries.push(["gp_quota", JSON.stringify(quota)]);
  if (blockedUntil > Date.now()) entries.push(["gp_blocked_until", String(blockedUntil)]);
  else if (raw.gp_blocked_until) entries.push(["gp_blocked_until", ""]);
  if (entries.length) await saveSettings(env, entries).catch(() => {});

  // 写「上次发起时刻」；发起失败的不动，下一轮重试
  if (started.length) {
    await d
      .batch(
        started.map(([site, ts]) =>
          d
            .prepare(
              "INSERT INTO state (site, last_checked_ts) VALUES (?, ?) " +
                "ON CONFLICT(site) DO UPDATE SET last_checked_ts = excluded.last_checked_ts"
            )
            .bind(site, ts)
        )
      )
      .catch((e) => {
        scheduleError = String((e && e.message) || e);
      });
  }

  if (voidSites.length) await bumpState(env, {}, voidSites);

  return {
    used,
    gpStarted,
    skipped,
    failures,
    failed: failCount,
    voided: voidSites.length,
    blocked_until: blockedUntil > Date.now() ? blockedUntil : null,
    quota,
    // 非 null = last_checked_ts 没写进去，下一轮会重试
    scheduleError,
  };
}

/**
 * 手动测试落库。不推动调度、不累加 consecutive_fail。
 * 必须串行：bumpDailyManual 依赖明细已写入。
 */
async function persistManualTest(env, site, { source, probe, result }) {
  const v = judge(site, result);
  const ts = minuteIso();
  const row = {
    ts,
    site: site.id,
    source,
    probe: probe || null,
    ok: v.ok,
    status: result?.status ?? 0,
    ttfb_ms: result?.ttfb ?? 0,
    total_ms: result?.total ?? 0,
    error: v.reason,
  };
  await insertChecks(env, [row]);

  // 状态快照；不碰 consecutive_fail 与 last_checked_ts
  let voidStreakReset = true;
  await upsertLastResult(env, row).catch(() => {
    voidStreakReset = false;
  });

  // 按天汇总，与自动探测同一口径
  let daily = { run: 0 };
  let dailyError = null;
  try {
    daily = await bumpDailyManual(env, site.id, v.ok, ts);
  } catch (e) {
    dailyError = String((e && e.message) || e);
  }

  // 证书：只在握手成功时写
  if (result?.tls) await saveSsl(env, site.id, result.tls).catch(() => {});

  return {
    ok: v.ok,
    reason: v.reason,
    // 「今天已经连续失败 N 次」：达到站点阈值时前端可以立刻提示"已构成故障"，
    // 不必等下一轮自动探测才发现色条变红。
    fail_run: daily.run,
    fail_threshold: Number(site.fail_threshold || 3),
    warn: dailyError ? `按天汇总未写入：${dailyError}` : !voidStreakReset ? "状态快照未更新" : null,
  };
}

/* ────────────────────────────── 路由 ────────────────────────────── */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 接口统一走 /api/<name>；静态资源占根路径，两者互不干扰。
    const m = url.pathname.match(/^\/api\/([a-zA-Z_]+)\/?$/);
    const api = m ? m[1] : "";
    const pretty = url.searchParams.get("pretty") === "1";

    /** 库结构自举：放在所有分支之前，包括 /api/health。 */
    let schemaState;
    try {
      schemaState = { ok: true, ...(await ensureSchema(env)) };
    } catch (e) {
      schemaState = { ok: false, error: String((e && e.message) || e) };
    }

    // 部署自检必须先于设置加载与认证闸门：库没建表时 loadSettings 会先抛异常，
    // 那时任何分支都到不了，自检也就失去意义。它只读 sqlite_master，不碰业务表。
    if (api === "health") {
      return await buildHealth(env, env.ADMIN_PASSWORD, pretty, schemaState, {
        deep: url.searchParams.get("deep") === "1",
        authed: await isAuthed(request, env, null, null),
      });
    }

    // 结构没就位就没什么可做的：在这里一次性返回结构化错误，
    // 比让下游每个查询各自抛一次、最后被兜底成一句「加载失败」清楚得多。
    if (!schemaState.ok) {
      return json(
        { ok: false, error: schemaState.error, ...hintOf({ message: schemaState.error }) },
        500,
        "no-store",
        pretty
      );
    }

    // 设置存 D1，合并回 env 后下游直接读 env.XXX
    let rawSettings;
    try {
      rawSettings = await loadSettings(env);
    } catch (e) {
      return json(
        { ok: false, error: String((e && e.message) || e), ...hintOf(e) },
        500,
        "no-store",
        pretty
      );
    }
    // 密码只认环境变量 ADMIN_PASSWORD，不支持后台改
    const pwdConfigured = Boolean(env.ADMIN_PASSWORD);

    const authed = await isAuthed(request, env, rawSettings, pwdConfigured);

    env = await effectiveEnv(env, rawSettings);

    // 公开接口：前台只读展示 + 登录/登出。其余（含所有写接口）都要求已登录。
    const PUBLIC_APIS = new Set(["overview", "site", "login", "logout"]);

    /** 认证 fail-closed：没配 ADMIN_PASSWORD 时后台一律不提供服务。 */
    if (!PUBLIC_APIS.has(api)) {
      if (!pwdConfigured) {
        return json(
          { ok: false, error: "未设置管理员密码，后台已停用", need_setup: true },
          403,
          "no-store",
          pretty
        );
      }
      if (!authed) {
        return json(
          { ok: false, error: "未登录或会话已过期", need_login: true },
          401,
          "no-store",
          pretty
        );
      }
    }

    // 跨站写请求一律拒（放在认证之后，先回答有没有权限）
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOriginOk(request, url)) {
      return json(
        { ok: false, error: "跨站请求被拒绝（同源校验失败）" },
        403,
        "no-store",
        pretty
      );
    }

    // 只有真会改配置的写接口才递增配置版本
    const isWrite = request.method !== "GET" && request.method !== "HEAD";
    if (isWrite && WRITE_APIS.has(api)) {
      await bumpConfigVersion(env);
    }

    try {
      /* ── 登录 / 登出 ─────────────────────────────────────── */

      if (api === "login") {
        if (request.method !== "POST") {
          return json({ ok: false, error: "仅支持 POST" }, 405, "no-store", pretty);
        }
        // 未配密码：直接说清原因，不计失败
        if (!pwdConfigured) {
          return json(
            { ok: false, error: "未设置管理员密码，后台已停用", need_setup: true },
            403,
            "no-store",
            pretty
          );
        }
        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        // 失败计数按来源 IP 分桶，只存哈希前 16 位
        const ipKey = (await sha256Hex(ip)).slice(0, 16);
        // 第一道：内存限速（isolate 复用时零成本）
        if (!loginLimiter.check(ip)) {
          return json(
            { ok: false, error: "尝试过于频繁，请 1 分钟后再试" },
            429,
            "no-store",
            pretty
          );
        }
        // 第二道：D1 按 IP 限速（低流量下每个请求可能是新 isolate，内存层拦不住）
        if (loginBlocked(rawSettings, ipKey)) {
          return json(
            { ok: false, error: `失败次数过多，请 ${LOGIN_WINDOW_MS / 1000} 秒后再试` },
            429,
            "no-store",
            pretty
          );
        }

        const body = await request.json().catch(() => ({}));
        const input = String(body.password || "");
        // 限制长度：常量时间比较会逐字节遍历
        if (input.length > 256) {
          return json({ ok: false, error: "密码长度非法" }, 400, "no-store", pretty);
        }

        // 空密码永不匹配
        const expected = env.ADMIN_PASSWORD || "";
        const pass = expected.length > 0 && constantTimeEqual(input, expected);

        if (!pass) {
          await recordLoginFail(env, rawSettings, ipKey);
          await sleep(300); // 固定延迟抬高爆破成本（等待不计 CPU）
          return json({ ok: false, error: "密码错误" }, 401, "no-store", pretty);
        }

        // 登录成功 → 清掉本 IP 的失败计数
        if (rawSettings.login_fail) await clearLoginFail(env, rawSettings, ipKey).catch(() => {});
        loginLimiter.reset(ip);
        const token = await issueSession(
          await sessionSecret(env, rawSettings),
          SESSION_TTL,
          Date.now(),
          sessionEpoch(rawSettings)
        );
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
        const bodyP = request.json().catch(() => ({}));
        const body = await bodyP;
        /** 登出；body.all=true 时作废所有会话（需已登录）。 */
        let revoked = false;
        if (body.all === true && authed) {
          const ep = await bumpSessionEpoch(env);
          revoked = ep !== null;
          // 配了 ADMIN_SECRET 时不轮换（写了也没人读）
          if (revoked && !env.ADMIN_SECRET) {
            await saveSetting(env, "session_secret", randomHex(32)).catch(() => {});
          }
        }
        return new Response(JSON.stringify({ ok: true, revoked }), {
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
          // 收集后一次 batch 落库
          const entries = [];

          for (const k of SETTING_KEYS) {
            if (!(k in body)) continue;
            const v = body[k];
            // __KEEP__ 或空 = 不修改
            if (k === "globalping_token" && (v === "__KEEP__" || v === null || v === undefined)) {
              continue;
            }
            entries.push([k, normalizeSetting(k, String(v ?? "").trim())]);
            saved.push(k);
          }

          if (body.clear_globalping_token) {
            entries.push(["globalping_token", ""]);
            saved.push("globalping_token:cleared");
          }

          await saveSettings(env, entries);

          // 密码不在这里改
          return json({ ok: true, saved }, 200, "no-store", pretty);
        }

        // GET：回显设置。token 永不回传明文，只给掩码 + 是否存在
        return json({ ok: true, settings: publicSettings(env, rawSettings) }, 200, "no-store", pretty);
      }

      // ── 前台一次性取全量：统计 + 分组 + 色条 + SSL ──
      if (api === "overview") {
        // days 必须钳制：每个取值都是独立缓存条目
        const maxD = maxDays(env);
        const days = queryInt(url.searchParams.get("days"), Math.min(30, maxD), 1, maxD);
        // 缓存 key 带配置版本，改配置即失效
        const ver = configVersionOf(rawSettings);
        const keyUrl = `${url.origin}/api/overview?days=${days}&pretty=${pretty ? 1 : 0}&v=${ver}`;
        return await withEdgeCache(request, ctx, READ_TTL_SEC, async () => {
          const d = await db(env);

          // 日期轴：左新右旧，按 utc_offset_min 切日（需与写入侧 dayKey 一致）。
          const axis = [];
          for (let i = 0; i < days; i++) {
            const t = new Date(Date.now() - i * 86400000 + dayOffsetMs(env));
            axis.push(t.toISOString().slice(0, 10));
          }
          // 可用率口径：最近 24 小时（滚动），与详情页趋势图同一个窗口。
          const since24 = new Date(Date.now() - 86400000).toISOString();

          // 站点/状态/证书/分类一次 JOIN；24h 聚合走覆盖索引
          const siteRows = await d
            .prepare(
              `SELECT s.id, s.name, s.url, s.group_name,
                      s.fail_threshold, s.expect_codes, s.hide_url, s.interval_min,
                      COALESCE(st.consecutive_fail, 0) AS consecutive_fail,
                      COALESCE(st.void_streak, 0) AS void_streak,
                      st.last_ok, st.last_status, st.last_ttfb_ms AS last_ttfb,
                      st.last_source, st.last_probe, st.last_ts, st.last_error,
                      ss.authorized AS ssl_authorized, ss.protocol AS ssl_protocol,
                      ss.issuer AS ssl_issuer, ss.expires_at AS ssl_expires_at,
                      ${sslDaysLeftSql("ss.")} AS ssl_days_left,
                      ss.checked_ts AS ssl_checked_ts,
                      ss.error AS ssl_error,
                      COALESCE(u.n, 0) AS u_n,
                      COALESCE(u.ok, 0) AS u_ok
               FROM sites s
               LEFT JOIN state st ON st.site = s.id
               LEFT JOIN ssl ss ON ss.site = s.id
               -- 按 categories.sort 排序；按字面排中文会乱
              LEFT JOIN categories cat
                     ON cat.name = COALESCE(NULLIF(TRIM(s.group_name), ''), ?1)
               LEFT JOIN (
                 SELECT site, COUNT(*) AS n, SUM(ok) AS ok
                 FROM checks INDEXED BY idx_checks_ts_site_ok
                 WHERE ts > ?2
                 GROUP BY site
               ) u ON u.site = s.id
               WHERE s.enabled = 1
               ORDER BY COALESCE(cat.sort, 100000), s.group_name, s.sort, s.id`
            )
            .bind(UNGROUPED, since24)
            .all();

          // 30 天色条
          const dayRows = await d
            .prepare(`SELECT site, day, n, ok, max_fail_run FROM checks_daily WHERE day >= ?`)
            .bind(axis[axis.length - 1])
            .all();
          const bySite = {};
          for (const r of dayRows.results || []) {
            (bySite[r.site] = bySite[r.site] || {})[r.day] = r;
          }

          // 每站点 24h 可用率 + 全局分子/分母
          const u24map = {};
          let n24 = 0;
          let ok24 = 0;
          for (const r of siteRows.results || []) {
            const un = Number(r.u_n || 0);
            const uok = Number(r.u_ok || 0);
            u24map[r.id] = un ? Math.round((uok / un) * 1000) / 10 : null;
            n24 += un;
            ok24 += uok;
          }

          const groups = {};
          const seen = new Set();
          for (const s of siteRows.results || []) {
            const map = bySite[s.id] || {};
            const uptime24 = u24map[s.id] ?? null;
            // 有连续失败段标红，零星抖动标黄
            const thr = Number(s.fail_threshold || 3);
            const bars = axis.map((dkey) => {
              const c = map[dkey];
              if (!c || !c.n) return { d: dkey, st: "none" };
              if (c.ok >= c.n) return { d: dkey, st: "up" };
              return { d: dkey, st: Number(c.max_fail_run || 0) >= thr ? "fault" : "blip" };
            });

            // 三态判定：up / down / degraded（规则见 stateOf）
            const { state, degrade_reason: degradeReason, ssl } = stateOf(s, env);

            const g = s.group_name || UNGROUPED;
            (groups[g] = groups[g] || []).push({
              id: s.id,
              name: s.name,
              // 隐藏地址的站点根本不下发 url：公开接口 + 边缘缓存，前端藏等于没藏。
              url: s.hide_url ? null : s.url,
              hide_url: !!s.hide_url,
              state,
              degrade_reason: degradeReason,
              last_ok: s.last_ok,
              last_status: s.last_status,
              last_ttfb: s.last_ttfb,
              last_source: s.last_source,
              last_probe: s.last_probe,
              // 服务端统一口径（见 originOf / origin.js）；前端不再各自拼 source/probe
              origin: originOf(s, s.last_source, s.last_probe, env),
              last_ts: s.last_ts,
              last_error: s.last_error,
              consecutive_fail: s.consecutive_fail,
              uptime_24h: uptime24,
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
          // 无数据给 null，不给 100
          const uptime = n24 ? Math.round((ok24 / n24) * 1000) / 10 : null;

          return json(
            {
              ok: true,
              now: minuteIso(),
              // 前台需要的展示类设置（改完靠 config_version 换缓存 key 立即生效）
              settings: {
                default_theme: rawSettings.default_theme || defOf("default_theme"),
                site_title: rawSettings.site_title || defOf("site_title"),
                // 页脚文案要按实际配置写
                ssl_warn_days: sslWarnDays(env),
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

      // ── 单站点详情 ──
      if (api === "site") {
        const id = url.searchParams.get("id");
        if (!id) return json({ ok: false, error: "缺少 id 参数" }, 400, "no-store", pretty);
        if (!validSiteId(id)) {
          return json({ ok: false, error: "站点不存在" }, 404, "no-store", pretty);
        }

        const maxD = maxDays(env);
        // 这几个参数进缓存 key，只允许登录后覆盖
        const canTune = authed;
        const daysFor = canTune
          ? queryInt(url.searchParams.get("days"), Math.min(30, maxD), 1, maxD)
          : Math.min(30, maxD);
        // 「最近检查」条数：后台设置 recent_limit，登录后 ?recent= 可临时覆盖
        const recentN = canTune
          ? clampInt(
              url.searchParams.get("recent") || env.RECENT_LIMIT || defOf("recent_limit"),
              5,
              200,
              Number(defOf("recent_limit"))
            )
          : clampInt(env.RECENT_LIMIT || defOf("recent_limit"), 5, 200, Number(defOf("recent_limit")));
        // 「故障记录」显示条数
        const incidentN = clampInt(
          env.INCIDENT_LIMIT || defOf("incident_limit"),
          1,
          100,
          Number(defOf("incident_limit"))
        );
        const verS = configVersionOf(rawSettings);
        const keyUrl = `${url.origin}/api/site?id=${encodeURIComponent(
          id
        )}&days=${daysFor}&recent=${recentN}&incident=${incidentN}&pretty=${
          pretty ? 1 : 0
        }&v=${verS}`;

        return await withEdgeCache(request, ctx, READ_TTL_SEC, async () => {
          const d = await db(env);
          const days = daysFor;
          const oldestDay = new Date(Date.now() - (days - 1) * 86400000 + dayOffsetMs(env))
            .toISOString()
            .slice(0, 10);

          // 元信息。MIN(ts) 走 (site, ts) 索引最左端，不扫行。
          const meta = await d
            .prepare(
              `SELECT s.id, s.name, s.url, s.group_name,
                      s.fail_threshold, s.interval_min, s.expect_codes,
                      s.hide_url, s.enabled, s.sort,
                      COALESCE(st.consecutive_fail, 0) AS consecutive_fail,
                      COALESCE(st.void_streak, 0) AS void_streak,
                      st.last_checked_ts,
                      st.last_ok, st.last_status,
                      st.last_ttfb_ms AS last_ttfb, st.last_total_ms AS last_total,
                      st.last_source, st.last_probe, st.last_ts, st.last_error,
                      ss.authorized AS ssl_authorized, ss.protocol AS ssl_protocol,
                      ss.issuer AS ssl_issuer, ss.subject AS ssl_subject,
                      ss.key_type AS ssl_key_type, ss.expires_at AS ssl_expires_at,
                      ${sslDaysLeftSql("ss.")} AS ssl_days_left,
                      ss.checked_ts AS ssl_checked_ts,
                      ss.error AS ssl_error,
                      (SELECT MIN(ts) FROM checks WHERE site = ?1) AS first_check,
                      (SELECT MAX(ts) FROM checks WHERE site = ?1) AS last_check
               FROM sites s
               LEFT JOIN state st ON st.site = s.id
               LEFT JOIN ssl ss ON ss.site = s.id
               WHERE s.id = ?1`
            )
            .bind(id)
            .first();

          if (!meta) {
            return json({ ok: false, error: `站点不存在：${id}` }, 404, "no-store", pretty);
          }

          // 窗口右端取最后一次检查，左端再往前 24h
          const nowSec = Math.floor(Date.now() / 1000);
          const firstSec = meta.first_check ? Math.floor(Date.parse(meta.first_check) / 1000) : 0;
          const lastSec = meta.last_check ? Math.floor(Date.parse(meta.last_check) / 1000) : 0;
          const endSec = lastSec > 0 ? Math.min(nowSec, lastSec) : nowSec;
          const startSec =
            firstSec > 0
              ? Math.max(endSec - TREND_HOURS * TREND_BUCKET_SEC, firstSec)
              : endSec - TREND_HOURS * TREND_BUCKET_SEC;
          // 0 表示只有一条记录（或没有），此时不虚构时间轴
          const realSpanSec = Math.max(0, endSec - startSec);
          const spanSec = Math.max(60, realSpanSec);
          // 槽宽 = max(监测间隔, 跨度/24)：限制槽数，同时避免大量空槽
          const ivSec = Math.max(60, Math.round(Number(meta.interval_min || 5) * 60));
          const bucketSec = Math.max(ivSec, Math.ceil(spanSec / TREND_HOURS));
          const nBuckets = Math.max(1, Math.min(TREND_HOURS, Math.ceil(spanSec / bucketSec)));
          const since = new Date(startSec * 1000).toISOString();

          // 三段 UNION ALL：序列分桶 / 最近 N 条 / 状态翻转点。列类型按首段定，聚合列显式 CAST。
          const [trend, dayRows] = await Promise.all([
            d
              .prepare(
                `WITH win AS (
                   SELECT ts, ok, ttfb_ms, total_ms, source, probe, error
                   FROM checks INDEXED BY idx_checks_site_ts
                   WHERE site = ?1 AND ts >= ?2
                 ),
                 bucketed AS (
                   SELECT MIN(?4, CAST((?5 - strftime('%s', ts)) / ?3 AS INTEGER)) AS b,
                          COUNT(*) AS n, SUM(ok) AS okl,
                          AVG(CASE WHEN ok=1 THEN ttfb_ms END) AS av,
                          MAX(CASE WHEN ok=1 THEN ttfb_ms END) AS mx,
                          SUM(CASE WHEN ok=1 THEN ttfb_ms END) AS tsum
                   FROM win
                   GROUP BY b ORDER BY b DESC
                 ),
                 recent AS (
                   SELECT ts, ok, status, ttfb_ms, total_ms, source, probe, error
                   FROM checks INDEXED BY idx_checks_site_ts
                   WHERE site = ?1 ORDER BY ts DESC LIMIT ?6
                 ),
                 flips AS (
                   SELECT ts, ok, error, LAG(ok) OVER (ORDER BY ts) AS prev FROM win
                 )
                 SELECT 'bucket' AS kind,
                        CAST(b AS INTEGER) AS b,
                        CAST(n AS INTEGER) AS n,
                        CAST(okl AS INTEGER) AS okl,
                        av, mx,
                        CAST(tsum AS INTEGER) AS tsum,
                        -- 与首段类型对齐
                        CAST(NULL AS TEXT) AS ts, NULL AS ok, NULL AS status,
                        NULL AS ttfb_ms, NULL AS total_ms,
                        CAST(NULL AS TEXT) AS source, CAST(NULL AS TEXT) AS probe,
                        CAST(NULL AS TEXT) AS error, NULL AS prev
                 FROM bucketed
                 UNION ALL
                 SELECT 'recent', 0, 0, 0, NULL, NULL, 0,
                        CAST(ts AS TEXT), ok, status, ttfb_ms, total_ms,
                        CAST(source AS TEXT), CAST(probe AS TEXT), CAST(error AS TEXT), NULL
                 FROM recent
                 UNION ALL
                 SELECT 'change', 0, 0, 0, NULL, NULL, 0,
                        CAST(ts AS TEXT), ok, NULL, NULL, NULL,
                        NULL, NULL, CAST(error AS TEXT), prev
                 FROM flips
                 WHERE prev IS NULL OR ok <> prev`
              )
              .bind(id, since, bucketSec, nBuckets - 1, endSec, recentN)
              .all(),
            // 按天汇总走物化表 checks_daily，不扫明细
            d
              .prepare(
                `SELECT day, n, ok, max_fail_run
                 FROM checks_daily WHERE site = ?1 AND day >= ?2`
              )
              .bind(id, oldestDay)
              .all(),
          ]);

          // 拆回三个形状
          const trendRows = trend.results || [];
          const seriesRows = { results: trendRows.filter((r) => r.kind === "bucket") };
          const recentRows = {
            results: trendRows
              .filter((r) => r.kind === "recent")
              .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)),
          };
          const changeRows = {
            results: trendRows
              .filter((r) => r.kind === "change")
              .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)),
          };

          const { state, degrade_reason, ssl } = stateOf(meta, env);

          // 槽 → 边界点：n 个槽对应 n+1 个点，值取右侧槽，空槽保留为断口
          const byB = new Map();
          for (const r of seriesRows.results || []) byB.set(Number(r.b), r);

          let n = 0;
          let okl = 0;
          let tsum = 0;
          for (const r of seriesRows.results || []) {
            n += Number(r.n || 0);
            okl += Number(r.okl || 0);
            tsum += Number(r.tsum || 0);
          }

          // 端点用精确时间，末点必须和 window.last_check_ts 一致
          const startMs = startSec * 1000;
          const endMs =
            lastSec > 0
              ? Math.min(Date.now(), Date.parse(meta.last_check))
              : nowSec * 1000;
          const stepMs = realSpanSec > 0 ? (endMs - startMs) / nBuckets : 0;
          const mkPoint = (tMs, r) => ({
            t: new Date(tMs).toISOString(),
            n: r ? Number(r.n || 0) : 0,
            ok: r ? Number(r.okl || 0) : 0,
            // v = 该槽成功请求的平均延迟；整槽全失败或空槽为 null（前端断线）
            v: r && r.av != null ? Number(r.av) : null,
            max: r && r.mx != null ? Number(r.mx) : null,
          });

          const series = [];
          if (lastSec > 0) {
            if (realSpanSec <= 0) {
              // 只有一条记录：只画一个点，不虚构跨度
              series.push(mkPoint(endMs, byB.get(0)));
            } else {
              for (let i = 0; i <= nBuckets; i++) {
                // 最后一个边界右边没有槽，沿用 b=0
                const b = i === nBuckets ? 0 : nBuckets - 1 - i;
                series.push(mkPoint(Math.round(startMs + i * stepMs), byB.get(b)));
              }
            }
          }
          // 无记录时 series 为空，前端显示「暂无数据」
          // 均值 = Σ成功 ttfb / 成功次数
          const avgTtfb = okl ? Math.round(tsum / okl) : null;

          const intervalMin = Number(meta.interval_min || 5);

          // 故障段：连续失败条数 ≥ fail_threshold
          const failThreshold = Number(meta.fail_threshold || 3);
          const evtsAll = [];
          {
            const rows = (changeRows.results || [])
              .slice()
              .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
            let run = null;
            // 不按 run.n 过滤：它只数到翻转点，真实次数由下面按区间查 checks 得出
            const push = () => {
              if (run) evtsAll.push(run);
              run = null;
            };
            for (const c of rows) {
              if (Number(c.ok) === 0) {
                if (!run) run = { start: c.ts, end: null, error: c.error || null, n: 0, open: false };
                run.n += 1;
                if (!run.error && c.error) run.error = c.error;
              } else if (run) {
                run.end = c.ts;
                push();
              }
            }
            // 仍在故障中：end 留空，下面按「至少 1 次」兜住
            if (run) push();
          }

          // 一次取回窗口内所有失败行时间戳，段升序且互不相交，双指针计数
          const failTs = (
            (
              await d
                .prepare(
                  `SELECT ts FROM checks INDEXED BY idx_checks_site_ts_ok
                   WHERE site = ?1 AND ts >= ?2 AND ok = 0 ORDER BY ts`
                )
                .bind(id, since)
                .all()
            ).results || []
          ).map((r) => r.ts);

          const endNow = minuteIso();
          let fi = 0;
          const evts = evtsAll.map((e) => {
            const endIso = e.end || endNow;
            while (fi < failTs.length && failTs[fi] < e.start) fi++;
            let j = fi;
            while (j < failTs.length && failTs[j] <= endIso) j++;
            const nFail = Math.max(1, j - fi || Number(e.n) || 1);
            fi = j;
            const t0 = Date.parse(e.start);
            const t1 = Date.parse(endIso);
            return {
              start: e.start,
              end: e.end,
              ongoing: !e.end,
              duration_s: Math.max(0, Math.round((t1 - t0) / 1000)),
              error: e.error,
              checks: nFail,
              reached: nFail >= failThreshold,
            };
          });

          const shown = evts
            // 未达阈值的单次抖动不算故障
            .filter((e) => e.ongoing || e.reached)
            .reverse()
            .slice(0, incidentN);

          // 色条：最左最新 → 最右最早
          // 与「故障记录」同口径：连续失败 ≥ fail_threshold 才算红，零星抖动为黄
          const dayMap = {};
          for (const r of dayRows.results || []) dayMap[r.day] = r;
          const bars = [];
          for (let i = 0; i < days; i++) {
            const dkey = new Date(Date.now() - i * 86400000 + dayOffsetMs(env))
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
                  : Number(c.max_fail_run || 0) >= failThreshold
                  ? "fault"
                  : "blip",
              n: c ? Number(c.n) : 0,
              ok: c ? Number(c.ok) : 0,
            });
          }

          return json(
            {
              ok: true,
              now: minuteIso(),
              settings: {
                site_title: rawSettings.site_title || defOf("site_title"),
                default_theme: rawSettings.default_theme || defOf("default_theme"),
              },
              site: {
                id: meta.id,
                name: meta.name,
                // 隐藏地址的站点不下发 url
                url: meta.hide_url ? null : meta.url,
                hide_url: !!meta.hide_url,
                group_name: meta.group_name || UNGROUPED,
                gp_magic: gpMagicOf(env),
                expect_codes: meta.expect_codes || null,
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
              // 只下发前端真正显示的数：响应要过边缘缓存，按体积计费
              window: {
                hours: TREND_HOURS,
                span_sec: spanSec,
                points: series.length,
                last_check_ts: meta.last_check || null,
                checks: n,
                failures: n - okl,
                uptime: n ? Math.round((okl / n) * 1000) / 10 : null,
                incident_hours: Math.max(1, Math.round(spanSec / 3600)),
              },
              latency: {
                avg: avgTtfb,
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
                origin: formatOrigin(r.source, r.probe),
                error: r.error,
              })),
              incidents: shown,
              bars,
            },
            200,
            READ_CACHE,
            pretty
          );
        }, keyUrl);
      }

      // ── 分类管理 ──
      // 站点的分类归属存在 sites.group_name；这里维护显式分类表（支持空分类 + 顺序）
      if (api === "categories") {
        const d = await db(env);

        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const action = String(body.action || "").toLowerCase();
          const name = String(body.name || "").trim();
          if (action !== "reorder" && !name) {
            return json({ ok: false, error: "分类名不能为空" }, 400, "no-store", pretty);
          }
          // 与 sites.group_name 的 64 字符上限一致
          if (action !== "reorder" && name.length > 64) {
            return json({ ok: false, error: "分类名最多 64 个字符" }, 400, "no-store", pretty);
          }
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
              .prepare("INSERT INTO categories (name, sort) VALUES (?,?)")
              .bind(name, Number(mx?.s || 1))
              .run();
            return json({ ok: true, action, name }, 200, "no-store", pretty);
          }

          if (action === "rename") {
            const nn = String(body.new_name || "").trim();
            if (!nn) {
              return json({ ok: false, error: "新名称不能为空" }, 400, "no-store", pretty);
            }
            if (nn.length > 64) {
              return json({ ok: false, error: "分类名最多 64 个字符" }, 400, "no-store", pretty);
            }
            if (nn === name) return json({ ok: true, action, name }, 200, "no-store", pretty);
            // 目标名已存在则合并过去
            await d.batch([
              d
                .prepare("INSERT OR IGNORE INTO categories (name, sort) VALUES (?,?)")
                .bind(nn, 9999),
              d.prepare("UPDATE sites SET group_name = ? WHERE group_name = ?").bind(nn, name),
              d.prepare("DELETE FROM categories WHERE name = ?").bind(name),
            ]);
            return json({ ok: true, action, name, new_name: nn }, 200, "no-store", pretty);
          }

          if (action === "delete") {
            // 站点落到「未分组」，删分类不删监控
            await d.batch([
              d
                .prepare("UPDATE sites SET group_name = ? WHERE group_name = ?")
                .bind(UNGROUPED, name),
              d.prepare("DELETE FROM categories WHERE name = ?").bind(name),
            ]);
            return json({ ok: true, action, name }, 200, "no-store", pretty);
          }

          if (action === "reorder") {
            const names = Array.isArray(body.names) ? body.names.map(String) : [];
            if (!names.length) {
              return json({ ok: false, error: "names 不能为空" }, 400, "no-store", pretty);
            }
            // reorder 也会 upsert 分类名，长度同样要拦
            if (names.some((n) => n.length > 64)) {
              return json({ ok: false, error: "分类名最多 64 个字符" }, 400, "no-store", pretty);
            }
            await d.batch(
              names.map((n, i) =>
                d
                  .prepare("INSERT INTO categories (name, sort) VALUES (?,?) " +
                    "ON CONFLICT(name) DO UPDATE SET sort = excluded.sort")
                  .bind(n, i + 1)
              )
            );
            return json({ ok: true, action, order: names }, 200, "no-store", pretty);
          }

          return json({ ok: false, error: `未知 action：${action}` }, 400, "no-store", pretty);
        }

        // GET：显式分类 ∪ 站点上出现的 group_name
        return json({ ok: true, categories: await buildCategories(d) }, 200, "no-store", pretty);
      }

      if (api === "sites") {
        const d = await db(env);
        if (request.method === "DELETE") {
          const id = url.searchParams.get("id");
          if (!id) return json({ ok: false, error: "缺少 id" }, 400);
          await deleteSite(env, id);
          return json({ ok: true, deleted: id });
        }
        if (request.method === "POST") {
          const parsed = await request.json().catch(() => null);
          if (!parsed || typeof parsed !== "object") {
            return json(
              { ok: false, error: "请求体不是合法的 JSON 对象" },
              400,
              "no-store",
              pretty
            );
          }
          // 站点排序：只传顺序，按下标写 sort
          if (!Array.isArray(parsed) && parsed.action === "reorder") {
            const ids = Array.isArray(parsed.ids) ? parsed.ids.map(String).filter(Boolean) : [];
            if (!ids.length) {
              return json({ ok: false, error: "ids 不能为空" }, 400, "no-store", pretty);
            }
            // 上限只是挡畸形请求
            if (ids.length > 500) {
              return json(
                { ok: false, error: "一次最多重排 500 个站点" },
                400,
                "no-store",
                pretty
              );
            }
            await d.batch(
              ids.map((id, i) =>
                d.prepare("UPDATE sites SET sort = ? WHERE id = ?").bind(i + 1, id)
              )
            );
            return json({ ok: true, action: "reorder", order: ids }, 200, "no-store", pretty);
          }

          const list = Array.isArray(parsed) ? parsed : [parsed];
          let upserted = 0; // 真实写入条数，空 id/url 会被跳过
          const stmt = d.prepare(
            `INSERT INTO sites (id,name,url,group_name,expect_codes,hide_url,fail_threshold,interval_min,enabled,sort)
                 VALUES (?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(id) DO UPDATE SET
                   name=excluded.name, url=excluded.url,
                   group_name=excluded.group_name,
                   expect_codes=excluded.expect_codes,
                   hide_url=excluded.hide_url,
                   fail_threshold=excluded.fail_threshold,
                   interval_min=excluded.interval_min, enabled=excluded.enabled,
                   sort=excluded.sort`
          );
          // 未指定 sort 的新站点排到队尾
          const stmts = [];
          let nextSort = null;
          for (const s of list) {
            if (!s.id || !s.url) continue;
            const id = String(s.id).trim();
            const url = normalizeUrl(String(s.url).trim());
            if (!validSiteId(id)) {
              return json(
                { ok: false, error: `站点 ID 非法（1–64 个字符，只能用字母、数字、点、下划线、连字符）：${String(s.id).slice(0, 40)}` },
                400,
                "no-store",
                pretty
              );
            }
            if (!validHttpUrl(url)) {
              return json(
                { ok: false, error: `站点地址必须是 http/https：${String(s.url).slice(0, 80)}` },
                400,
                "no-store",
                pretty
              );
            }
            if (!validExpectCodes(s.expect_codes)) {
              return json(
                { ok: false, error: `期望状态码格式应为 3 位数字、逗号分隔（如 200,301）` },
                400,
                "no-store",
                pretty
              );
            }
            // 顺序留给拖拽定：没给 sort 就分配队尾
            let sortValue;
            if (s.sort === undefined || s.sort === null || s.sort === "") {
              if (nextSort === null) {
                const mx = await d
                  .prepare("SELECT COALESCE(MAX(sort), 0) AS m FROM sites")
                  .first();
                nextSort = Number(mx?.m || 0);
              }
              sortValue = ++nextSort;
            } else {
              sortValue = clampInt(s.sort, 0, 100000, 0);
            }

            stmts.push(
              stmt.bind(
                id,
                String(s.name ?? id).trim().slice(0, 120) || id,
                url,
                String(s.group_name ?? UNGROUPED).trim().slice(0, 64) || UNGROUPED,
                String(s.expect_codes ?? "").trim(),
                boolInt(s.hide_url),
                // 阈值 1–20、间隔 1–1440 分钟
                clampInt(s.fail_threshold, 1, 20, 3),
                clampInt(s.interval_min, 1, 1440, 5),
                // 缺省启用；0 / false / "0" 都落成 0
                s.enabled == null ? 1 : boolInt(s.enabled),
                sortValue
              )
            );
            upserted++;
          }
          for (const part of chunk(stmts, BATCH_CHUNK)) await d.batch(part);
          return json({ ok: true, upserted });
        }
        // GET 不支持：读取走 /api/admin
        return json({ ok: false, error: "请用 /api/admin" }, 405, "no-store", pretty);
      }

      // 后台聚合接口：一次请求拿全
      if (api === "admin") {
        const payload = await buildAdminPayload(env);
        const settings = publicSettings(env, rawSettings);
        return json(
          // probe 直出「最近一次成功/失败/是否退避中」
          { ok: true, ...payload, settings, probe: probeHealthOf(rawSettings) },
          200,
          "no-store",
          pretty
        );
      }

      // 手动跑一轮（调试用）：?api=run&limit=3
      if (api === "run") {
        const m2 = requirePost(request, pretty);
        if (m2) return m2;
        const body = await request.json().catch(() => ({}));
        const sites = await loadSites(env);
        const raw = Number(body.limit ?? sites.length);
        const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, sites.length) : sites.length;
        const picked = sites.slice(0, limit);
        const collect = await collectGlobalping(env, sites);
        const disp = await dispatch(env, picked, {
          alreadyUsed: collect.fetched,
          raw: rawSettings,
          voided: collect.voidSites,
          pendingSites: collect.remaining,
          blockedUntil: collect.blockedUntil,
        });
        // rows / perSite 只在服务端内部用，不下发
        return json({
          ok: true,
          collect: { collected: collect.collected, fetched: collect.fetched, dropped: collect.dropped },
          dispatch: disp,
        });
      }

      // 即时测试：必须带 site=<id>，结果写入 checks
      if (api === "test") {
        const m2 = requirePost(request, pretty);
        if (m2) return m2;
        // 频率闸门：按 10 秒一次，内存级，只防手滑
        if (!testLimiter.check("global")) {
          return json(
            { ok: false, error: "测试过于频繁，请 10 秒后再试" },
            429,
            "no-store",
            pretty
          );
        }
        const body = await request.json().catch(() => ({}));
        const siteId = String(body.site || "");
        const d = await db(env);
        const site = siteId
          ? await d.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first()
          : null;
        // 只允许测已登记的站点，否则等于借额度探测任意地址
        if (!site) {
          testLimiter.reset("global"); // 请求无效，不占额度
          return json(
            {
              ok: false,
              error: siteId ? `站点不存在：${siteId}` : "缺少 site 参数（只支持测已登记的站点）",
            },
            siteId ? 404 : 400,
            "no-store",
            pretty
          );
        }
        const target = site.url;

        // 位置筛选统一取全局设置，不支持按请求覆盖
        const { id, source, quota } = await gpCreate(env, { url: target });

        // 等结果：自适应间隔 + 总时长上限
        const startedAt = Date.now();
        const waitBudgetMs = (Number(env.GP_TIMEOUT_SEC) || 15) * 1000 + 8000;
        let finished = null;
        let wait = 700;
        while (!finished && Date.now() - startedAt < waitBudgetMs) {
          await new Promise((r) => setTimeout(r, wait));
          wait = Math.min(2500, Math.round(wait * 1.5));
          const out = await gpCollect(env, { measurement_id: id });
          if (out.done) finished = out;
        }
        const elapsedMs = Date.now() - startedAt;
        // gpCollect 把「id 失效 / API 报错」判成 done+broken，这种不能落库
        if (finished?.broken) {
          return json(
            { ok: false, kind: "globalping", source, quota, error: finished.error },
            502,
            "no-store",
            pretty
          );
        }
        const results = finished?.results || [];
        // 判定走 gpDecide，与自动探测同一条判定链
        const dec = gpDecide(site || { expect_codes: "" }, results);
        if (dec.void) {
          // 无结论不落库：存成记录等于凭空造出一个 up 或 down
          const why =
            dec.why === "single-fail"
              ? "只剩 1 台有效探针且失败，不足以判定"
              : dec.why === "all-internal"
                ? "探针全部为 Globalping 平台自身故障"
                : "未收到任何探针结果";
          return json(
            {
              ok: false,
              kind: "globalping",
              source,
              quota,
              results,
              elapsed_ms: elapsedMs,
              error: `${why}，本次不记录`,
            },
            502,
            "no-store",
            pretty
          );
        }
        const best = dec.pick;
        // 票型：全通不标，分歧或有失败才标 `City/ASN (1/3)`
        const probeLabel =
          dec.ok && dec.unanimous
            ? best.probe || null
            : `${best.probe || "?"} (${dec.okCount}/${dec.total})`;
        let persisted = null;
        if (site) {
          persisted = await persistManualTest(env, site, {
            source,
            probe: probeLabel,
            result: best,
          });
        }
        return json({
          ok: true, kind: "globalping", source, quota, elapsed_ms: elapsedMs,
          origin: formatOrigin(source, probeLabel),
          // 下发判定所用代表值：后台若自行取 results[0]，可能拿到失败的那条探针
          verdict: {
            ok: dec.ok,
            reason: dec.reason ?? null,
            votes: `${dec.okCount}/${dec.total}`,
            status: best.status ?? 0,
            ttfb: best.ttfb ?? null,
            total: best.total ?? null,
            probe: probeLabel,
          },
          results, persisted,
        });
      }

      // 未知接口一律 404
      return json(
        {
          ok: false,
          error: `未知接口：${api || url.pathname}`,
          endpoints: [
            "GET  /api/health    部署自检：D1 绑定 / 表结构 / 密码（公开，排障先看这个）",
            "GET  /api/overview  前台：统计 + 分组 + 30 天色条 + SSL（公开，边缘缓存）",
            "GET  /api/site?id=  详情页：24h 窗口统计 + 24 点序列 + 故障（公开）",
            "GET  /api/admin     后台：站点 + 状态 + 分类 + 证书 + 设置（需登录）",
            "POST /api/login  /api/logout",
            "GET/POST /api/settings",
            "GET/POST/DELETE /api/categories",
            "POST /api/sites（写）",
            "POST /api/run  手动跑一轮（调试）；POST /api/test  测单个站点（调试）",
          ],
        },
        404,
        "no-store",
        pretty
      );
    } catch (e) {
      return json(
        { ok: false, error: String((e && e.message) || e), ...hintOf(e) },
        500,
        "no-store",
        pretty
      );
    }
  },

  async scheduled(controller, env, ctx) {
    // 唤醒时刻只用于记录投递延迟，排期不依赖它
    const wokeAt = Date.now();
    const nominal = Number(controller && controller.scheduledTime);
    const cronDelayMs =
      Number.isFinite(nominal) && nominal > 0 && nominal <= wokeAt ? wokeAt - nominal : null;
    // 分段容错：任何一段失败都不中断整轮
    const errors = [];
    const stage = async (name, fn, fallback) => {
      try {
        return await fn();
      } catch (e) {
        errors.push({ stage: name, error: String((e && e.message) || e) });
        return fallback;
      }
    };

    await stage("ensureSchema", () => ensureSchema(env), null);

    const settings = await stage("loadSettings", () => loadSettings(env), {});
    env = await effectiveEnv(env, settings);

    // ── 轮次互斥锁：55 秒租约，防止两轮重叠重复发起 ──
    const lockUntil = Number(settings.gp_round_lock_until || 0) || 0;
    if (lockUntil > Date.now()) {
      // 被租约挡住 = 上一轮跑了超过 55 秒，必须落库留证
      await logRound(env, {
        ts: new Date(wokeAt).toISOString(),
        sched_ts: Number.isFinite(nominal) && nominal > 0 ? new Date(nominal).toISOString() : null,
        delay_ms: cronDelayMs,
        dur_ms: Date.now() - wokeAt,
        err: `locked(${lockUntil - Date.now()}ms)`,
      });
      console.log(
        JSON.stringify({ cron: controller.cron, skipped: "locked", locked_for_ms: lockUntil - Date.now() })
      );
      return;
    }
    await stage(
      "roundLock",
      () => saveSetting(env, "gp_round_lock_until", String(Date.now() + 55_000)),
      null
    );

    const sites = await stage("loadSites", () => loadSites(env), []);

    // 先全量收取上一轮结果，不受间隔影响
    const collected = await stage("collectGlobalping", () => collectGlobalping(env, sites), {
      collected: 0,
      fetched: 0,
      dropped: [],
      voided: 0,
      voidSites: [],
      sslWritten: 0,
      blockedUntil: null,
      remaining: [],
      collectLagMs: 0,
    });

    // 再按监测间隔对「已到期」的发起新一轮；预算要减掉本轮收取已花掉的次数
    const due = await stage("dueSites", () => dueSites(env, sites), []);
    const disp = await stage(
      "dispatch",
      () =>
        dispatch(env, due, {
          alreadyUsed: collected.fetched,
          raw: settings,
          // 本轮收取已计过「无结论」的站点，不在发起失败时重复计数
          voided: collected.voidSites,
          // 复用收取阶段读到的 pending，省一次全表读
          pendingSites: collected.remaining,
          // 收取侧撞到 429 时，发起端本轮一起停
          blockedUntil: collected.blockedUntil,
        }),
      { used: 0, gpStarted: [], skipped: [], voided: 0, blocked_until: null, quota: null }
    );
    const subreqBudget = Number((env && env.SUBREQ_BUDGET) || 30);

    // 每天一次的过期明细清理，按「距上次成功清理」判断，避免卡钟点
    let cleaned = 0;
    let orphans = 0;
    if (shouldCleanup(settings)) {
      try {
        cleaned = await cleanupOldChecks(env, Number(env?.CHECK_KEEP_DAYS || 30));
        orphans = await cleanupOrphans(env);
        await saveSetting(env, "last_cleanup_ts", String(Date.now()));
        await noteCleanup(env, true);
      } catch (e) {
        cleaned = -1; // -1 = 失败，与「删了 0 条」区分
        await noteCleanup(env, false);
      }
    }

    // 释放轮次租约
    await stage("roundUnlock", () => saveSetting(env, "gp_round_lock_until", "0"), null);

    // 本轮调度事实落库。gpStarted 同时含成功项与失败项，按 error 拆分计数
    const startedOk = (disp.gpStarted || []).filter((x) => x && !x.error).length;
    for (const f of disp.failures || []) errors.push({ stage: "dispatch", ...f });
    // 收取阶段被判「无结论」的明细也要落库，否则漏一次检查事后无从归因
    for (const dr of (collected.dropped || []).slice(0, 5)) {
      errors.push({
        stage: "collect",
        site: dr.site,
        why: dr.why,
        ...(dr.status ? { status: dr.status } : {}),
        ...(dr.ok_votes != null ? { votes: `${dr.ok_votes}/${dr.total}` } : {}),
        ...(dr.error ? { error: String(dr.error).slice(0, 140) } : {}),
      });
    }
    await stage(
      "logRound",
      () =>
        logRound(env, {
          ts: new Date(wokeAt).toISOString(),
          sched_ts: Number.isFinite(nominal) && nominal > 0 ? new Date(nominal).toISOString() : null,
          delay_ms: cronDelayMs,
          dur_ms: Date.now() - wokeAt,
          due_n: due.length,
          started_n: startedOk,
          failed_n: Number(disp.failed || 0),
          collected_n: collected.collected || 0,
          skipped_n: (disp.skipped || []).length,
          err: errors.length ? JSON.stringify(errors) : null,
        }),
      null
    );

    console.log(
      JSON.stringify({
        cron: controller.cron,
        cronDelayMs,
        sites: sites.length,
        due: due.length,
        collected: collected.collected,
        collectLagMs: collected.collectLagMs || 0,
        gpDropped: collected.dropped,
        gpStarted: disp.gpStarted,
        gpVoided: disp.voided,
        gpFailed: disp.failed,
        gpBlockedUntil: disp.blocked_until,
        skipped: disp.skipped,
        subreqUsed: disp.used,
        subreqBudget,
        persisted: collected.collected,
        ssl: collected.sslWritten || 0,
        cleaned, // 0 = 未到清理时点或无过期数据；-1 = 清理失败
        orphans,
        scheduleError: disp.scheduleError || null,
        errors,
      })
    );
  },
};

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
  SSL_COLUMNS_SQL,
  BATCH_CHUNK,
  chunk,
  UNGROUPED,
  ensureSchema,
} from "./db.js";
import { SCHEMA_STMTS, SCHEMA_VERSION } from "./schema.js";
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

/**
 * 只读接口的边缘缓存 TTL（秒）。响应头与 cache.put 都从这里取，避免两处各写一个数。
 *
 * 300 而不是 30：前台每 60 秒轮询一次，30 秒的缓存几乎必然每次落空 ——
 * 等于把「每分钟一次全量窗口扫描」原封不动打到 D1。拉到 5 分钟后，单个机房
 * 每天只回源 288 次（原来 2,880 次），读额度直接降一个数量级。
 * 新鲜度不受影响：后台改配置会递增 config_version 换掉缓存 key，旧条目立即失效。
 */
const READ_TTL_SEC = 300;
const READ_CACHE = `public, s-maxage=${READ_TTL_SEC}, stale-while-revalidate=600`;

/**
 * 会改「配置」的写接口：只有它们（非 GET）才递增 config_version。
 *
 * test / run 刻意不在里面 —— 它们不改变任何配置，只是产生一条探测记录。
 * 把它们算进来的后果是：后台每点一次「测试」，全机房的 overview / site 缓存
 * 一起作废，下一批请求全部回源，只为刷新一行刚写进去的检查记录。
 */
const WRITE_APIS = new Set(["settings", "sites", "categories"]);

/** 默认输出紧凑 JSON（省流量）；调试时加 &pretty=1 才缩进 */
const json = (o, status = 200, cache = "no-store", pretty = false) =>
  new Response(pretty ? JSON.stringify(o, null, 2) : JSON.stringify(o), {
    status,
    headers: { ...JSON_HEADERS, "Cache-Control": cache },
  });

/** 把 D1 层报错翻译成可执行的下一步，否则前端只看到空体 500。 */
function dbErrorHint(msg) {
  const m = String(msg || "");
  if (/D1\s*绑定缺失/.test(m))
    return "wrangler.toml 的 [[d1_databases]] 没随部署生效（database_id 为空串时 wrangler 会跳过绑定）。跑 npm run deploy 会自动建库并写回 database_id。";
  if (/no such table/i.test(m))
    return "D1 里没有表，且 Worker 的自动建表也没成功（正常情况下第一次请求就会自己补上结构）。先打开 /api/health?pretty=1 看 db_bound 与 missing_tables：绑定缺失会显示 db_bound:false；绑定正常却仍缺表，多半是 D1 写额度用尽或库已被删除。手工兜底：npx wrangler d1 execute <库名> --remote --file=schema.sql。";
  if (/no such column/i.test(m))
    return "D1 表结构与 schema.sql 不一致（缺列）。schema.sql 全是 IF NOT EXISTS，不会给旧表补列：按提示 ALTER TABLE 补列，或换库名重建（会丢数据）。";
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

/**
 * 部署自检：只回答「装好了没有」，不返回业务数据；必须公开，否则最需要它时用不了。
 *
 * 但它跑在认证之前、每次请求都要触达 D1（建表检查 + sqlite_master + meta 里的 gp_*），
 * 于是「公开」就意味着任何人刷它都在花你的 D1 读额度。
 * 折中：默认只做**最便宜**的一段（绑定是否在、结构版本、密码是否配），
 * `?deep=1` 且已登录时才做完整检查（缺哪张表、探针健康、回填结果）。
 */
async function buildHealth(env, pwdConfigured, pretty, schema, opts = {}) {
  const deep = Boolean(opts.deep && opts.authed);
  const out = {
    ok: true,
    db_bound: Boolean(env && env.DB),
    db_ready: false,
    deep,
    password_set: Boolean(pwdConfigured),
    schema: {
      expected_version: SCHEMA_VERSION,
      // 本次自动补结构的结果：none 已是最新 / created 新建 / migrated 补了结构。
      auto_applied:
        schema && schema.ok
          ? !schema.migrated
            ? "none"
            : schema.from < 0
              ? "created"
              : "repaired"
          : "failed",
    },
    tables: [],
    missing_tables: [],
  };

  if (deep && schema && schema.ok && schema.migrated) {
    out.schema.statements = schema.statements;
    // -1 = 全新库，0 = 旧库无版本标记，N = 从 N 升上来
    out.schema.from_version = schema.from;
    // v2 的数据回填结果：done=true 已回填 / false 因明细过多跳过（历史色条会是空的）
    if (schema.backfill) out.schema.backfill = schema.backfill;
  }
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

  // 浅检查到此为止：只确认「库能连上」。
  if (!deep) {
    // db_ready 不做判断（那要多一次 sqlite_master 查询）；用 schema.ok 近似表达。
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

  // 探针健康：站点页面只能告诉你"这一轮有没有结论"，回答不了"是我们瞎了还是站点挂了"。
  // 这里把 Globalping 侧的最后一次成功/失败与退避窗口摊开，部署自检时一眼能分清。
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

/**
 * 探针健康快照。直接吃已经读到的 meta（rawSettings），零额外 D1 读。
 * 三件事必须能分开看：最后一次成功、最后一次失败、是否在 429 退避窗口内。
 */
function probeHealthOf(raw) {
  const blocked = Number(raw?.gp_blocked_until || 0);
  // 「最近一次尝试」= 成功与失败两个时间戳里较晚的那个（不再单独存一列，省一次写）
  const okAt = raw?.gp_last_ok_ts ? Date.parse(raw.gp_last_ok_ts) : 0;
  const errAt = raw?.gp_last_error_ts ? Date.parse(raw.gp_last_error_ts) : 0;
  const lastAt = Math.max(okAt || 0, errAt || 0);
  return {
    last_checked_ts: lastAt ? new Date(lastAt).toISOString() : null,
    last_ok_ts: raw?.gp_last_ok_ts || null,
    last_error: raw?.gp_last_error || null,
    last_error_ts: raw?.gp_last_error_ts || null,
    // 只在仍处于退避窗口内时给时间：过期了还给，会让人以为还在等
    blocked_until: blocked > Date.now() ? new Date(blocked).toISOString() : null,
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
  const status = res.status;
  const text = await res.text();

  /** 只缓存 200，并原样返回原始状态码，否则 404 会被缓存成 200。 */
  const cacheable = status === 200 && !res.headers.get("set-cookie");
  const headers = cacheable
    ? { ...JSON_HEADERS, "Cache-Control": `public, s-maxage=${ttl}` }
    : {
        ...JSON_HEADERS,
        "Cache-Control": res.headers.get("cache-control") || "no-store",
      };

  if (cacheable) {
    // 用 await 而非 ctx.waitUntil：PUT 是本地同步操作，异步会跨请求边界留时序残影。
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

/** 后台站点列表：站点 + 最近状态 + 分类，供 /api/admin 聚合复用。 */
async function buildAdminPayload(env) {
  const d = await db(env);

  // 站点 + 最近状态 + 证书：合并成**一条**查询（一次往返，三张主键小表 LEFT JOIN）。
  //
  // 早先是 Promise.all 四条（sites / state / ssl / buildCategories）。D1 的语句本来就是
  // 请求级归并的，并发 await 换不来并行往返；而 buildCategories 的两条查询与这里无关，
  // 保留成自带的一条 Promise.all（两条小表扫描），调用点只有一处。
  //
  // 「每个站点的最新一条」仍然读 state：落库时已同步写了结果快照，
  // 不是对 checks 做 ROW_NUMBER() 分区排序（那样耗时随保留天数线性增长）。
  //
  // 注意别名：state 里叫 last_ttfb_ms / consecutive_fail / void_streak，
  // 与 s.* 不重名；ssl 的列统一加 ssl_ 前缀，避免和将来 sites 新增列撞名。
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
      // 「谁在哪跑的」由服务端统一算好（见 originOf / origin.js）—— 后台表格 / 前台首页 /
      // 详情页三个前端共用同一口径，避免各自拼串导致同一次检查有三种写法。
      origin: originOf(s, lastMap[s.id]?.source, lastMap[s.id]?.probe, env),
      last_ts: lastMap[s.id]?.ts ?? null,
      // 「确认中」要按连续失败次数判定（见 stateOf），后台表格与前台首页必须同一口径。
      // 这一列在 state 表里，不在 sites 表 —— 不加就会让后台永远算不出 pending，
      // 于是首页是黄、后台是红，同一时刻两个页面说两套话。
      consecutive_fail: lastMap[s.id]?.consecutive_fail ?? 0,
      // 「探针连续几轮没拿到结论」—— 与 consecutive_fail 一样由 stateOf 消费，
      // 后台列表与首页必须同一口径（否则一边黄"探针无结论"、一边绿"正常"）。
      void_streak: lastMap[s.id]?.void_streak ?? 0,
      // stateOf() 读的是 ssl_* 前缀的扁平字段（与 overview 的 SQL 别名同形），
      // 这里把 ssl 表的列重命名摊平后再交给它，避免后台自算一套三态逻辑。
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
    // 后台列表也要显示「降级」—— 只回 last_ok 的话，"证书快过期 / 响应偏慢"的站点
    // 在这里会显示成绿色「正常」，而后台恰恰是最该看见降级的地方。
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

/**
 * 清理标记应当更新的方式：**只在本次清理确实跑成功之后**才写。
 *
 * 早先是「读到该清理 → 清理 → 无论成败都写时间戳」之外的另一半 —— 这里要保证的是
 * 与 dueSites 共享同一次 settings 快照：清理只改 last_cleanup_ts，而 R2 那些配置读的
 * 是同一份对象，两边不互相影响。
 *
 * 真正修的问题：清理失败时 cleaned = -1，但 last_cleanup_ts 没有被写，下一轮 cron 会重试 ——
 * 这是对的，保持不变。此处只补一个「上一轮清理失败的可见性」：失败后记进 meta，
 * 让 /api/health 与后台能看出"清理卡住了、checks 在膨胀"，而不是等 D1 写满才发现。
 */
async function noteCleanup(env, ok) {
  await saveSettings(env, [
    ["last_cleanup_ok", ok ? "1" : "0"],
    ["last_cleanup_err_ts", ok ? "" : new Date().toISOString()],
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

/**
 * 证书剩余天数低于多少判降级。**必须走 clampInt**：
 * 后台表单有 normalizeSetting 兜底，但环境变量绕过它 —— 控制台里写成 "30天" / "14 天"
 * 时 Number() 得到 NaN，而 `days_remaining <= NaN` 恒为 false，
 * 结果是「证书快过期了但页面永远不降级」，而且没有任何报错。默认 14 天。
 */
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

  // 未达确认次数先标黄（Kuma 的 PENDING 语义）：1..thr-1 次是「疑似故障」，≥thr 才红。
  const threshold = Math.max(1, Number(s.fail_threshold || 3));
  // 手动测过且失败时 consecutive_fail 仍为 0，按 1 次算，否则会直接标红。
  const streak = state === "down" ? Math.max(1, Number(s.consecutive_fail || 0)) : 0;
  const pending = state === "down" && streak < threshold;

  // 探针连续多轮拿不到结论（全灭 / 平台故障 / 收取失败）：站点还在显示"正常"，
  // 但那只是最后一轮的老结论。必须降级 —— 否则 Globalping 挂掉时，
  // 所有站点会永远绿着、"X 分钟前"越变越大，监控静默失效而没人知道。
  const voidStreak = Number(s.void_streak || 0);

  if (state !== "down" && voidStreak >= VOID_DEGRADE_AFTER) {
    state = "degraded";
    degrade_reason = `探针连续 ${voidStreak} 轮无结论`;
  } else if (pending) {
    state = "degraded";
    degrade_reason = `疑似故障（确认中 ${streak}/${threshold}）`;
  } else if (state !== "down") {
    // degrade_reason 只有一个字符串，确认中/故障的站点不再叠加证书与延迟提示。
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
 * 趋势图：窗口上限 24 小时，**每小时一个聚合值，用 25 个点画出 24 段**。
 *
 * 为什么是 25 个点而不是 24：n 个 1 小时的槽有 n+1 个边界。只要两端都要精确 ——
 * 首点 = 窗口左边界、末点 = 最后一次检查 —— 就必须有 n+1 个点。用 24 个点的话，
 * 必然有一个边界空着：要么首点晚一小时（把最左那小时并进第二点），
 * 要么末点早一小时（把最右那小时挂在左边点上）。
 *
 * 三条规则：
 *  ① 窗口右端 = 最后一次检查（不是 now），左端 = 再往前 24 小时（不超过首条记录）。
 *     用 now 收尾会让最后一条记录"缩"在右侧留白里，看着像数据停了。
 *  ② 每个点站在槽的边界上，值取它**右边**那个槽的聚合值；最后一个边界沿用最右槽，
 *     于是最右 1 小时是平的 —— 那正是这一段的数据。
 *  ③ 槽宽 = max(监测间隔, 跨度/24)，槽数 ≤ 24：
 *     · 跨度/24 保证槽数上限（满窗口时正好 24 个 1 小时槽）；
 *     · 不小于监测间隔保证槽里通常有记录，不会出现一串空槽；
 *     · 数据不足 24 小时时槽宽变小、槽数变少，整段区间被平分。
 *
 * 槽序号从右端往回数（b=0 是最新一槽）：正向数时最后一条记录恰好落在窗口右端，
 * (ts-start)/槽宽 会等于槽数，只能夹进最后一槽 —— 那一槽白吃两倍宽度，
 * 最后一段的间隔会变成 1.5 倍。
 *
 * 空槽**保留**（n=0、v=null）：时间轴长度恒定，停测显示成断口，
 * 而不是把两侧的数据点直接连起来假装这段时间有数据。
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

/**
 * 按 key 规范化取值。必须在写入侧拦：这些值直接进探测参数与降级判定，
 * 一个非法值（如 gp_timeout_sec="abc"）会让所有站点表现为全线故障。
 */
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
      // 上限 35：免费层每次调用硬上限 50 个子请求，而一轮 cron 的 D1 往返另有 15~20 次。
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
      // Globalping 硬约束：整数秒 5–30，越界直接 422
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
    default:
      return v;
  }
}

/** 会话签名密钥：优先 ADMIN_SECRET，否则用 D1 随机值；首次生成靠「先到先得」避免并发覆盖。 */
async function sessionSecret(env, S) {
  // 环境变量优先：让"轮换密钥 = 作废所有会话"这件事在部署侧可控
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

/** 会话纪元：吊销所有已签发会话的唯一手段，与密钥来源无关；随 loadSettings 读出，零额外往返。 */
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
  return /^\d{3}(,\d{3})*$/.test(s);
}

/**
 * 登录失败第二道闸门（存 D1）：低流量下 CF 可能每请求新建 isolate，内存限速拦不住。
 *
 * ⚠️ 必须按来源 IP 分桶。早先是全局计数，于是任何人都能用 8 次错误密码
 * 把管理员永久锁在门外 —— 攻击者要的正是这个，代价几乎为零（真 DoS）。
 * 按 IP 分桶后，被锁的只有攻击者自己；管理员换个网络照样能进。
 *
 * 存储：meta.login_fail 一个 JSON 列 `{ "<ip 哈希前 16 位>": [ts,...] }`。
 * 只占 1 行、只写 1 行，且只保留最近 LOGIN_WINDOW_MS 内有失败记录的来源。
 */
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

  // 只留住最近活跃的 N 个来源：刷 IP 也无法让这一行无界膨胀。
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

/** 会话有效期：30 天（内部工具，频繁登录反而促使人用弱密码） */
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

/** pending 最长存活时间：永不收尾的 pending 会让该站点永久静默停摆。 */
const PENDING_TTL_MS = 180_000;

/**
 * 阶段一：收取上一轮发起的 Globalping 测量
 * @param sitesIn 调用方已经取到的启用站点清单。scheduled 里刚 loadSites 过一次，
 *                不传的话这里要再查一遍 —— 每分钟白多一次 D1 往返、多读 N 行。
 */
async function collectGlobalping(env, sitesIn) {
  const d = await db(env);
  const { results: pending } = await d.prepare("SELECT * FROM pending").all();
  // ⚠️ 返回值结构必须与下面的完整分支保持一致（尤其是 dropped / sslWritten / fetched）——
  //    调用方会无条件读 collected.dropped 与 collected.fetched，少了字段就会抛 TypeError，
  //    导致整轮 cron 在打完日志前失败。
  if (!pending || !pending.length)
    return {
      collected: 0,
      fetched: 0,
      rows: [],
      dropped: [],
      perSite: {},
      voided: 0,
      voidSites: [],
      sslWritten: 0,
      // 收取侧撞到的 429 退避截止时间（毫秒时间戳）；null = 本轮没被限流。
      blockedUntil: null,
      // 本轮没被收走的 pending（还在跑 / 被限流而跳过）—— 供 dispatch 复用，省一次查询。
      remaining: [],
      lastChecked: {},
    };

  const sites = sitesIn || (await loadSites(env));
  const byId = Object.fromEntries(sites.map((s) => [s.id, s]));
  const rows = [];
  const perSite = {};
  const doneIds = [];
  // 证书随同一次测量回来 —— 攒起来最后一起写，避免每个站点一次独立往返
  const sslWrites = [];
  // 被丢弃、且没有写检查记录的 pending。正常恒为空，非空即代表有异常需要排查。
  const dropped = [];
  // 本轮「发起了测量但拿不到结论」的站点：要累加 void_streak，让静默失效变成可见的降级。
  // 只统计仍然存在的启用站点 —— 已删除站点的 pending 会在 cleanupOrphans 里清掉。
  const voidSet = new Set();
  // 本轮真正发出去的收取请求数（= 出网子请求消耗）。
  // 返回给 dispatch 当作"已用额度"的起点 —— 否则预算只管发起、不管收取，
  // 实际出网量会是预算的两倍，站点一多就撞免费层每次调用 50 个子请求的硬上限。
  let fetched = 0;
  // 收取侧 429：与 gpCreate 共用同一个 gp_blocked_until，避免"发起退避了、收取还在每分钟打"。
  let blockedUntil = null;
  // 还在跑 / 因限流本轮没打的 pending：交给 dispatch，省掉它自己再查一次 pending 表。
  const remaining = [];
  // 本轮更新过的 last_checked_ts（bumpState 里写的就是这个值）
  const lastChecked = {};

  for (const p of pending) {
    // ── 兜底：存活过久的 pending 一律丢弃 ──
    // 拿不到可解析的 created_ts 也一并丢弃：既然无法给它定上界，就当作可能永久占位处理，
    // 代价只是多探一次，好过站点悄悄停摆。
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
      // 限流是平台层面的问题，不是这个站点坏了：记下退避截止时间，让本轮的发起到下一轮都别再撞。
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
        ok_votes: dec.okCount ?? null,
        total: dec.total ?? null,
        platform_faults: dec.platformFaults ?? 0,
      });
      if (byId[p.site]) voidSet.add(p.site);
      continue;
    }

    const r0 = dec.pick;
    // 票型标注：全通是常态，标了只是噪音（会让每行都变长）；出现分歧（如 1/3）
    // 或有失败时才标 —— 那个数字恰是判断"链路在抖 vs 站点真挂了"的关键线索。
    const probeLabel =
      dec.ok && dec.unanimous
        ? r0.probe || null
        : `${r0.probe || "?"} (${dec.okCount}/${dec.total})`;

    rows.push({
      ts: new Date().toISOString(),
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
    };
    if (r0.tls) sslWrites.push([p.site, r0.tls]);
  }

  if (rows.length) await insertChecks(env, rows);
  // 一条 IN 清完所有已收取的 pending：单条 DELETE × N 会多出 N 次 D1 往返。
  // 用 deleteBySites 而不是内联拼 IN —— 它会按 90 分片（D1 单查询绑定参数上限 100）。
  if (doneIds.length) await deleteBySites(env, "pending", doneIds);
  // 记录本轮写进 state 的时间戳：bumpState 内部用的是 `new Date().toISOString()`，
  // 这里必须取同一个值，否则「刚检查过的站点」会被判成本轮还没检查、下一轮重复发起。
  const checkedAt = new Date().toISOString();
  await bumpState(env, perSite, [...voidSet], checkedAt);
  for (const id of Object.keys(perSite)) lastChecked[id] = checkedAt;
  // 证书写入口：只有握手成功（tls 非空）才写，失败时保持上一次已知的证书状态 ——
  // 探针连不上不代表证书变了，把它写成"无证书"会让首页突然显示"证书未检测"。
  // 一次 batch 落库：逐站 await 会变成 N 次串行 D1 往返（20 站就是十几秒）。
  if (sslWrites.length) await saveSslBatch(env, sslWrites).catch(() => {});
  return {
    collected: rows.length,
    fetched,
    rows,
    dropped,
    perSite,
    // 本轮被判「无结论」的站点（与 dropped 大体一致，但已按"站点仍存在"过滤）
    voided: voidSet.size,
    voidSites: [...voidSet],
    sslWritten: sslWrites.length,
    blockedUntil,
    remaining,
    // 本轮写进 state 的 last_checked_ts（每站点一条）。dueSites 直接用它判到期，
    // 省掉再一次 `SELECT ... FROM state` 全表读。
    lastChecked,
  };
}

/** cron 每分钟触发，下面两处修正都基于「调度器最多每分钟醒一次」。 */
const CRON_PERIOD_MS = 60_000;

/** 判定到期的提前量：last_checked_ts 在写库之后才更新，比 check 自身时间戳晚几秒。 */
const DUE_GRACE_MS = 15_000;

/**
 * 挑出本轮该检查的站点：按各站点 interval_min 判断是否到期。
 *
 * @param lastChecked 可选：{ [site]: iso }。collectGlobalping 刚写过 state（bumpState 的
 *                    upsert 里就带着 last_checked_ts），调用方把它传进来就能省掉
 *                    本轮对 state 的第二次全表读。不传则自己查（/api/run 等入口）。
 */
async function dueSites(env, sites, lastChecked) {
  let lastMap = lastChecked;
  if (!lastMap) {
    const d = await db(env);
    const { results } = await d.prepare("SELECT site, last_checked_ts FROM state").all();
    lastMap = Object.fromEntries((results || []).map((r) => [r.site, r.last_checked_ts]));
  }
  const now = Date.now();
  return sites.filter((s) => {
    const last = lastMap[s.id];
    if (!last) return true;
    const ivMs = Math.max(1, Number(s.interval_min || 5)) * 60_000;

    // 两阶段结果晚一轮落地，所以提前一个周期发起，让结果落在 interval 上。
    const lead = CRON_PERIOD_MS;

    const dueAt = Math.max(0, ivMs - lead) - DUE_GRACE_MS;
    return now - new Date(last).getTime() >= dueAt;
  });
}

/**
 * 阶段二：发起本轮测量。
 *
 * @param opts.alreadyUsed 本轮收取已花掉的子请求数（预算要减掉）
 * @param opts.raw         meta 原始设置，用来读 gp_blocked_until（429 退避窗口）
 * @param opts.voided      本轮已经因「无结论」计过数的站点 —— 避免同一轮对同一站点重复 +1
 * @param opts.pendingSites 本轮收取后仍未收完的站点（由 collectGlobalping 带回）。
 *                          传了就不再查 pending 表；不传（/api/run 等独立入口）才回退去查。
 * @param opts.blockedUntil 本轮收取侧撞到的 429 退避截止时间，与 gpCreate 共用同一条
 */
async function dispatch(env, sites, opts = {}) {
  const budget = Number((env && env.SUBREQ_BUDGET) || 30);
  const d = await db(env);
  let used = Math.max(0, Number(opts.alreadyUsed) || 0);
  const raw = opts.raw || {};
  const alreadyVoid = new Set(opts.voided || []);
  const skipped = [];
  const voidSites = [];

  // 已挂起的站点本轮不再重复发起：上一轮的测量还没收，重发等于白花额度。
  // 调用方已经读过 pending 时就复用那份结果 —— 每分钟一轮的 cron 里，省掉一次全表读。
  let pendingSites = Array.isArray(opts.pendingSites) ? opts.pendingSites : null;
  if (!pendingSites) {
    const { results: pend } = await d.prepare("SELECT site FROM pending").all();
    pendingSites = (pend || []).map((p) => p.site);
  }
  const pendingSet = new Set(pendingSites);

  // 429 退避窗口：窗口内一个都不发。否则每分钟都撞一次 429，日志刷满、结果一条没有。
  let blockedUntil = Math.max(
    Number(raw.gp_blocked_until || 0) || 0,
    Number(opts.blockedUntil || 0) || 0
  );
  const blocked = blockedUntil > Date.now();

  const gpStarted = [];
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
      // 额度窗口内本轮不发起：这些站点这一轮同样没有任何结果，必须计入无结论，
      // 否则额度耗尽时整页会一直显示"正常"，而实际上已经没人在测了。
      skipped.push(s.id);
      noteVoid(s.id);
      continue;
    }
    if (used + 1 > budget) {
      skipped.push(s.id);
      continue;
    }
    used += 1;
    try {
      const { id, source, quota: q } = await gpCreate(env, s);
      await d
        .prepare(
          "INSERT OR REPLACE INTO pending (site, measurement_id, source, created_ts) VALUES (?,?,?,?)"
        )
        .bind(s.id, id, source, new Date().toISOString())
        .run();
      gpStarted.push({ site: s.id, id, source, quota: q });
      okCount++;
      if (q && (q.limit || q.remaining)) quota = q;
    } catch (e) {
      // 发起失败不写 checks（我们对站点当时的可达性一无所知），下一轮重试
      const msg = String((e && e.message) || e);
      gpStarted.push({ site: s.id, error: msg });
      failCount++;
      lastError = msg;
      noteVoid(s.id);

      // 额度用尽：立刻停止本轮后续发起（同一份额度，再试必然还是 429），
      // 并把退避截止时间写进 meta，让下一分钟的 cron 直接跳过。
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

  // 探针健康：不写的话，出问题时只能翻 cron 日志（而日志默认只留 3 天）。
  // 只在「本轮真的尝试过」时写，空转的 cron 一分钟一行都不写。
  const entries = [];
  const nowIso = new Date().toISOString();
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
  // 一次 batch：几行 meta 不该变成几次往返
  if (entries.length) await saveSettings(env, entries).catch(() => {});

  if (voidSites.length) await bumpState(env, {}, voidSites);

  return {
    used,
    gpStarted,
    skipped,
    failed: failCount,
    voided: voidSites.length,
    blocked_until: blockedUntil > Date.now() ? blockedUntil : null,
    quota,
  };
}

/**
 * 手动测试结果也落库，但不调 bumpState（不推动调度、不累加失败）。
 *
 * 顺序有意义：**先写 checks 明细，再写 checks_daily**。bumpDailyManual 靠「今天最后一次成功
 * 之后连续失败了几条」来算当天的连续段，明细不在库里就会数漏。原先四处 Promise.all
 * 并发 + 全部 .catch(()=>{})，既可能读到旧数据、又会在写失败时静默——现在串行，
 * 并把失败原因带回给前端。
 */
async function persistManualTest(env, site, { source, probe, result }) {
  const v = judge(site, result);
  const ts = new Date().toISOString();
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
  // ① 明细：后续两步都依赖它（色条要靠它数连续段）
  await insertChecks(env, [row]);

  // ② 状态快照：让首页/后台立刻反映这次手动测试。
  //    刻意不碰 consecutive_fail 与 last_checked_ts（那是调度用的）。
  let voidStreakReset = true;
  await upsertLastResult(env, row).catch(() => {
    voidStreakReset = false;
  });

  // ③ 按天汇总：否则「24h 可用率」含手动测试、而 30 天色条不含，
  //    手动测失败会让可用率掉一截、色条却一点都不变 —— 同一个站点两套口径。
  //    失败不再静默：写不进去时把原因回给前端，而不是让色条莫名其妙不动。
  let daily = { run: 0 };
  let dailyError = null;
  try {
    daily = await bumpDailyManual(env, site.id, v.ok, ts);
  } catch (e) {
    dailyError = String((e && e.message) || e);
  }

  // ④ 证书：这次测量本来就把 tls 抓回来了，不写等于让后台的证书列停留在旧值
  //    （手动测往往是"我就想看看现在怎么样"）。与自动探测同一约定：只有握手成功才写。
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

    /* ── 站点设置 + 认证闸门 ──────────────────────────────────────────
       设置存 D1 且优先级高于环境变量；合并回 env 后，下游所有 `env.XXX` 读取
       自动变成「D1 设置 → 环境变量 → 代码默认」，不必在每个调用点改成读设置。 */
    // 这一步在 try 之外必须自己兜住：异常逃出 fetch 只会得到空体 500。
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
    // 密码只认环境变量 ADMIN_PASSWORD（wrangler secret / Dashboard Variables）。
    // 不做后台可改密码：那样就得在 D1 里存哈希、还要处理"改了密码如何作废旧会话"，
    // 而密码本就属于部署期配置，放环境变量更简单也更容易审计。
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

    // 跨站写请求一律拒 —— 放在 认证之后：先回答"你有没有权限"（401 / 403），
    // 再回答"这个请求从哪来"。反过来的话，明明是没登录，却收到"跨站请求被拒绝"，
    // 排查起来会被带偏。也放在下面的 bumpConfigVersion 之前，避免无谓的 D1 写。
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOriginOk(request, url)) {
      return json(
        { ok: false, error: "跨站请求被拒绝（同源校验失败）" },
        403,
        "no-store",
        pretty
      );
    }

    // 只有真会改配置的写接口才递增配置版本，否则登录失败也会清空全机房缓存。
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
        // 未配密码 → 说清原因就收工。不要落到下面的"密码错误"分支：
        // 那会记一次登录失败（多试几次还会把 IP 拉黑），而真正的问题在部署配置，
        // 跟用户输什么完全无关。
        if (!pwdConfigured) {
          return json(
            { ok: false, error: "未设置管理员密码，后台已停用", need_setup: true },
            403,
            "no-store",
            pretty
          );
        }
        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        // 失败计数按来源 IP 分桶（不落明文地址，只存哈希前 16 位）。
        // 全局计数会让任何人用 8 次错误密码把管理员锁在门外，见 loginBlocked 的注释。
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
        // 限制长度：constantTimeEqual 会逐字节遍历，超大 body 足以烧穿 CPU 配额。
        if (input.length > 256) {
          return json({ ok: false, error: "密码长度非法" }, 400, "no-store", pretty);
        }

        // 兜底：走到这里说明 pwdConfigured 为真（上面已拦下未配置的情况），
        // 仍保留 `expected.length > 0` —— 空密码永不匹配，避免任何意外路径放行空串。
        const expected = env.ADMIN_PASSWORD || "";
        const pass = expected.length > 0 && constantTimeEqual(input, expected);

        if (!pass) {
          await recordLoginFail(env, rawSettings, ipKey);
          await sleep(300); // 固定延迟抬高爆破成本（等待不计 CPU）
          return json({ ok: false, error: "密码错误" }, 401, "no-store", pretty);
        }

        // 登录成功 → 清掉本 IP 的失败计数（有记录才写，避免无谓的 D1 写）。
        // 顺带删除旧版全局计数键 —— 升级前留下的行留着也会被旧部署读到。
        if (rawSettings.login_fail || rawSettings.login_fail_window || rawSettings.login_fail_count) {
          await clearLoginFail(env, rawSettings, ipKey).catch(() => {});
          if (rawSettings.login_fail_window || rawSettings.login_fail_count) {
            await saveSettings(env, [
              ["login_fail_window", ""],
              ["login_fail_count", ""],
            ]).catch(() => {});
          }
        }
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
        /** 登出并作废所有会话：会话无状态，只能让旧签名验不过 + 纪元 +1。 */
        let revoked = false;
        // 「登出所有设备」要求已登录，否则任何人可反复踢掉管理员。
        if (body.all === true && authed) {
          const ep = await bumpSessionEpoch(env);
          revoked = ep !== null;
          // 只在真的会被读取时才轮换（省一次 D1 写；配了 ADMIN_SECRET 时写了也没人看）
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
          // 先把所有键规范化收集起来，最后一次 batch 落库（原先每个键一次 D1 往返）
          const entries = [];

          for (const k of SETTING_KEYS) {
            if (!(k in body)) continue;
            const v = body[k];
            // token 传 __KEEP__ 或空 → 视为「不修改」，避免每次保存都把已配置的 token 清掉
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

          // 密码不在这里改 —— 它只来自环境变量 ADMIN_PASSWORD，
          // 改密码 = 改 Cloudflare 上的变量/secret 后重新部署，不需要（也不该）走后台。
          // 配置版本由入口处的 WRITE_APIS 统一递增，这里不再重复 bump 一次。
          return json({ ok: true, saved }, 200, "no-store", pretty);
        }

        // GET：回显设置。token 永不回传明文，只给掩码 + 是否存在
        return json({ ok: true, settings: publicSettings(env, rawSettings) }, 200, "no-store", pretty);
      }

      // ── 前台一次性取全量：统计卡 + 分组 + 每站点 30 天色条 + SSL ──
      // 刻意做成"单接口返回全部"，避免前端对 N 个站点发 N 个请求
      if (api === "overview") {
        // days 必须钳制：公开接口，每个不同 days 都是独立缓存条目，可用于灌满边缘缓存。
        const maxD = maxDays(env);
        const days = queryInt(url.searchParams.get("days"), Math.min(30, maxD), 1, maxD);
        // 缓存 key 带上配置版本：后台一改配置版本就 +1，所有机房的旧 key 立即不再命中
        const ver = configVersionOf(rawSettings);
        const keyUrl = `${url.origin}/api/overview?days=${days}&pretty=${pretty ? 1 : 0}&v=${ver}`;
        return await withEdgeCache(request, ctx, READ_TTL_SEC, async () => {
          const d = await db(env);

          // 30 天日期轴。最左是今天，最右是最早；"今天"按 utc_offset_min 起算，
          // 必须与写入侧 dayKey 用同一个偏移，否则格子会错位一格。
          const axis = [];
          for (let i = 0; i < days; i++) {
            const t = new Date(Date.now() - i * 86400000 + dayOffsetMs(env));
            axis.push(t.toISOString().slice(0, 10));
          }
          // 可用率口径：最近 24 小时（滚动），与详情页趋势图同一个窗口。
          const since24 = new Date(Date.now() - 86400000).toISOString();

          // 三条查询合并成**一条**：站点/状态/证书/分类 + 30 天色条 + 24h 可用率。
          //
          // 为什么不再用 Promise.all：D1 的语句是请求级归并的，并发 await 换不来并行往返，
          // 但任一 .prepare() 抛错时其余的会成为 unhandled rejection。合并之后一次往返，
          // 颜色条与 24h 聚合都变成「按站点对齐」的子查询，代价更好估。
          //
          // 注意 24h 聚合改成走 idx_checks_site_ts（site, ts）：早先是
          // `INDEXED BY idx_checks_ts_site_ok WHERE ts > ? GROUP BY site`，
          // 一次要扫「全部站点在窗口内的全部行」再做分组；现在每个站点只读自己的窗口，
          // 单站代价与站点数无关，站点多了也不会变成一条长查询。
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
                      (SELECT COUNT(*) FROM checks INDEXED BY idx_checks_site_ts
                        WHERE site = s.id AND ts > ?2) AS u_n,
                      (SELECT SUM(ok) FROM checks INDEXED BY idx_checks_site_ts
                        WHERE site = s.id AND ts > ?2) AS u_ok
               FROM sites s
               LEFT JOIN state st ON st.site = s.id
               LEFT JOIN ssl ss ON ss.site = s.id
               -- 分类顺序由 categories.sort 决定，而不是 group_name 的字面排序。
               -- 否则"生产环境"会被排到"测试环境"后面（中文码点顺序），与直觉相反。
              LEFT JOIN categories cat
                     ON cat.name = COALESCE(NULLIF(TRIM(s.group_name), ''), ?1)
               WHERE s.enabled = 1
               ORDER BY COALESCE(cat.sort, 100000), s.group_name, s.sort, s.id`
            )
            .bind(UNGROUPED, since24)
            .all();

          // 30 天色条：每站每格 1 行，仍是一次小范围读（与明细量无关）。
          const dayRows = await d
            .prepare(`SELECT site, day, n, ok, max_fail_run FROM checks_daily WHERE day >= ?`)
            .bind(axis[axis.length - 1])
            .all();
          // 24h 聚合已经并入上面的 siteRows —— 这里只做形状适配，下游不必改。
          const u24 = {
            results: (siteRows.results || [])
              .filter((r) => r.u_n !== null && r.u_n !== undefined)
              .map((r) => ({ site: r.id, n: r.u_n, ok: r.u_ok })),
          };

          const bySite = {};
          for (const r of dayRows.results || []) {
            (bySite[r.site] = bySite[r.site] || {})[r.day] = r;
          }

          // 每站点「最近 24 小时」可用率 + 全局分子/分母。
          // 只累计 enabled 站点（siteRows 已过滤）—— 已暂停站点的历史明细
          // 不能进分母，否则统计卡会和下面的列表对不上。
          const enabledIds = new Set((siteRows.results || []).map((s) => s.id));
          const u24map = {};
          let n24 = 0;
          let ok24 = 0;
          for (const r of u24.results || []) {
            if (!enabledIds.has(r.site)) continue;
            const un = Number(r.n || 0);
            const uok = Number(r.ok || 0);
            u24map[r.site] = un ? Math.round((uok / un) * 1000) / 10 : null;
            n24 += un;
            ok24 += uok;
          }

          const groups = {};
          const seen = new Set();
          for (const s of siteRows.results || []) {
            const map = bySite[s.id] || {};
            const uptime24 = u24map[s.id] ?? null;
            // 色条颜色与「故障记录」同一口径：当天出现「连续失败 ≥ fail_threshold」
            // 的段才标红（fault）；只有零星抖动的天标黄（blip）。
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
          // 一条数据都没有时给 null（前端显示 --），不要给 100：
          // 刚部署、还没跑过一轮的实例，第一屏就是「24 小时可用率 100%」，
          // 那是编出来的满分，和详情页的「暂无数据」自相矛盾。
          const uptime = n24 ? Math.round((ok24 / n24) * 1000) / 10 : null;

          return json(
            {
              ok: true,
              now: new Date().toISOString(),
              // 前台需要的展示类设置（改完靠 config_version 换缓存 key 立即生效）
              settings: {
                default_theme: rawSettings.default_theme || defOf("default_theme"),
                site_title: rawSettings.site_title || defOf("site_title"),
                // 降级阈值必须回显给前台页脚：页脚文案要按实际配置写，
                // 否则后台把 ssl_warn_days 改成别的值后，页面还在说 "≤14 天"。
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

      // ── 单站点详情（二级页面数据源）──
      // 一次返回：配置 + 状态 + SSL + 窗口统计 + 延迟序列 + 最近检查 + 故障事件 + 30 天色条。
      // 刻意做成单接口 —— 详情页只用 1 个请求，避免对同一站点发 4~5 个。
      if (api === "site") {
        const id = url.searchParams.get("id");
        if (!id) return json({ ok: false, error: "缺少 id 参数" }, 400, "no-store", pretty);
        // 先校验再查库：这个接口公开无鉴权，`?id=<随机串>` 每次都要跑一次 D1 查询。
        // 格式不合法就直接 404 —— 不花钱、也不给"拿噪声 id 烧额度"留口子。
        if (!validSiteId(id)) {
          return json({ ok: false, error: "站点不存在" }, 404, "no-store", pretty);
        }

        // 色条天数（前台只用得到 30）。先在缓存 key 之外算好，
        // 避免"key 里的值"与"实际查询用的值"两处各算一遍后分叉。
        // 上限与明细保留天数联动（见 maxDays），否则会画出永远空着的格子。
        const maxD = maxDays(env);
        /**
         * days / recent / incident 都会被编进缓存 key，而这是**公开**接口：
         * 三个参数各自由调用方指定，组合起来就能让每个请求都 MISS、每次都打一次 D1，
         * 顺手把边缘缓存撑满（单个站点就是 90×196×100 种 key）。
         * 所以只有已登录的管理员才允许覆盖，匿名访客固定拿默认值 ——
         * 前台本来也从不传这三个参数。
         */
        const canTune = authed;
        const daysFor = canTune
          ? queryInt(url.searchParams.get("days"), Math.min(30, maxD), 1, maxD)
          : Math.min(30, maxD);
        // 「最近检查」条数：后台设置 recent_limit（默认 20），登录后 ?recent= 可临时覆盖
        const recentN = canTune
          ? clampInt(
              url.searchParams.get("recent") || env.RECENT_LIMIT || defOf("recent_limit"),
              5,
              200,
              Number(defOf("recent_limit"))
            )
          : clampInt(env.RECENT_LIMIT || defOf("recent_limit"), 5, 200, Number(defOf("recent_limit")));
        // 「故障记录」显示条数：纯展示上限，后台可改（默认 10）
        const incidentN = clampInt(
          env.INCIDENT_LIMIT || defOf("incident_limit"),
          1,
          100,
          Number(defOf("incident_limit"))
        );
        const verS = configVersionOf(rawSettings);
        // ⚠️ days / recent / incident 都必须进缓存 key：它们决定返回体的内容与长度，
        //    不进 key 的话先请求 ?recent=5（或 ?days=7）会把默认响应的缓存污染成 5 条 / 7 天（或反之）。
        //    hours 不再进 key：趋势已固定为最近 24 小时（见 TREND_HOURS）。
        const keyUrl = `${url.origin}/api/site?id=${encodeURIComponent(
          id
        )}&days=${daysFor}&recent=${recentN}&incident=${incidentN}&pretty=${
          pretty ? 1 : 0
        }&v=${verS}`;

        return await withEdgeCache(request, ctx, READ_TTL_SEC, async () => {
          const d = await db(env);
          // 复用上面那份（与缓存 key 同源），不再各自重算
          const days = daysFor;
          // 色条最早那一格（最右）：与下面 dkey 的生成方式同一个偏移
          const oldestDay = new Date(Date.now() - (days - 1) * 86400000 + dayOffsetMs(env))
            .toISOString()
            .slice(0, 10);

          // ── 先单独取元信息（含「首条检查时间」子查询）──
          // 两个理由：① 站点不存在时直接 404，不必白跑后面 4 条查询；
          //          ② 窗口起点由首条检查时间决定，而序列查询的桶宽又依赖窗口宽度，
          //             必须先把窗口算出来才能 bind。
          // MIN(ts) 走 (site, ts) 索引最左端，是一次 O(1) 查找，不扫行。
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

          // ── 趋势窗口：右端 = 最后一次真实检查，左端 = 再往前 24 小时（不超过首条记录）──
          // 用 now 做右端会出一个很隐蔽的错位：桶的横坐标取的是桶起点，于是"15:58 的检查"
          // 被画在 15:00，曲线看起来像"数据停在一小时前"，而右边还空着一截。
          // 改成以最后一条记录收尾，最后一个节点必然落在最后一次监测上。
          const nowSec = Math.floor(Date.now() / 1000);
          const firstSec = meta.first_check ? Math.floor(Date.parse(meta.first_check) / 1000) : 0;
          const lastSec = meta.last_check ? Math.floor(Date.parse(meta.last_check) / 1000) : 0;
          // 没有记录时退化成 now（前端显示"暂无数据"），有记录则严格收在最后一条上
          const endSec = lastSec > 0 ? Math.min(nowSec, lastSec) : nowSec;
          const startSec =
            firstSec > 0
              ? Math.max(endSec - TREND_HOURS * TREND_BUCKET_SEC, firstSec) // 老站点仍按 24h
              : endSec - TREND_HOURS * TREND_BUCKET_SEC; // 一条记录都没有
          // 真实跨度：0 表示只有一条记录（或一条都没有），此时不该虚构时间轴
          const realSpanSec = Math.max(0, endSec - startSec);
          const spanSec = Math.max(60, realSpanSec);
          // 槽宽：满足两个约束
          //  ① 不超过「跨度 / 24」→ 槽数 ≤ 24（左端随后正好落在窗口起点）；
          //  ② 不小于该站点的监测间隔 → 每个槽里通常都有记录，不会出现一串"节点没数据"的空格。
          //     （间隔 5 分钟 + 只有 40 分钟数据时，若按 span/24 切是 100 秒/槽，
          //       8 条记录会散落在 24 个槽里，16 个槽是空的 —— 那条曲线看着就是断的。）
          const ivSec = Math.max(60, Math.round(Number(meta.interval_min || 5) * 60));
          const bucketSec = Math.max(ivSec, Math.ceil(spanSec / TREND_HOURS));
          const nBuckets = Math.max(1, Math.min(TREND_HOURS, Math.ceil(spanSec / bucketSec)));
          const since = new Date(startSec * 1000).toISOString();

          // 三条查询合成一次往返（dayRows 是另一张表，单独一条小查询）。
          //
          // 原先 Promise.all 四条并排写：D1 不会因为并发 await 而并行往返，反而在任一
          // .prepare() 抛错时留下 unhandled rejection；而 ②③④ 本来就是同一个
          // `WHERE site = ?` 的索引扫 —— 合进一条 CTE 里只对 checks 走一遍，
          // 比分开写少一次 flush、也少一份窗口过滤。
          //
          // ② 延迟按槽聚合，**槽从窗口右端（最后一次检查）往回数**：
          //    正向数时最后一条记录恰好落在窗口右端，(ts-start)/bucketSec 正好等于槽数，
          //    只能夹进最后一槽 —— 那一槽白吃两倍宽度，图上最后一段的间隔会变成 1.5 倍。
          // ③ 最近 N 条原始检查：按 (site, ts) 索引倒序取，只读 N 行。
          // ④ 状态变化点：只在 ok 翻转处返回，结果集极小。
          // 三条查询合成一次往返（dayRows 是另一张表，单独一条小查询）。
          //
          // 原先 Promise.all 四条并排写：D1 不会因为并发 await 而并行往返，反而在任一
          // .prepare() 抛错时留下 unhandled rejection。而 ①②③ 本来就是同一个
          // `WHERE site = ?` 的索引扫，合进一条语句只对 checks 走一遍。
          //
          // ① 延迟按槽聚合，**槽从窗口右端（最后一次检查）往回数**：正向数时最后一条
          //    记录恰好落在窗口右端，(ts-start)/bucketSec 正好等于槽数，只能夹进最后一槽 ——
          //    那一槽白吃两倍宽度，图上最后一段的间隔会变成 1.5 倍。
          // ② 最近 N 条原始检查：按 (site, ts) 索引倒序取，只读 N 行。
          // ③ 状态变化点：只在 ok 翻转处返回，结果集极小。
          //
          // ⚠️ 三段的列类型必须完全一致（UNION ALL 取第一段的类型做整个结果的列亲和性）：
          //    第一段是聚合，n/okl 等必须显式 CAST，否则最近记录里的 ts/error 会被当成数值。
          const [trend, dayRows] = await Promise.all([
            d
              .prepare(
                `WITH win AS (
                   SELECT ts, ok, ttfb_ms, total_ms, source, probe, error
                   FROM checks INDEXED BY idx_checks_site_ts
                   WHERE site = ?1 AND ts >= ?2
                 ),
                 bucketed AS (
                   SELECT MIN(?4, CAST((?5 - strftime('%s', substr(ts,1,19))) / ?3 AS INTEGER)) AS b,
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
                        -- 与首段类型对齐：统一用 TEXT 兜住所有字符串列
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
            // 按天汇总来自物化表 checks_daily，不再扫明细（30 天从 4 万行降到 30 行）。
            d
              .prepare(
                `SELECT day, n, ok, max_fail_run
                 FROM checks_daily WHERE site = ?1 AND day >= ?2`
              )
              .bind(id, oldestDay)
              .all(),
          ]);

          // 把合并结果拆回三个形状，下游一行代码都不用改。
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

          // ── 槽 → 边界点：nBuckets 个 1 小时槽 → nBuckets + 1 个点 ──
          // 点站在槽的边界上，值取它右边那个槽；最后一个点（窗口右端）沿用最右槽，
          // 所以最右 1 小时是平的 —— 那正是这一段的数据，不是补出来的。
          // 空槽保留成 n=0 / v=null：时间轴长度恒定，停测画成断口，
          // 而不是把两侧的数据点直接连起来假装这段时间测过。
          // 窗口合计仍按槽累加（每个槽只算一次，与点数无关）。
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

          // 端点用**精确时间**（带毫秒）：末点必须和 window.last_check_ts 完全一致，
          // 否则前端写「截至 HH:MM:SS」与末点会差几百毫秒。
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
            // v = 该槽成功请求的平均延迟；整槽全失败或空槽为 null（前端在此断线）
            v: r && r.av != null ? Number(r.av) : null,
            max: r && r.mx != null ? Number(r.mx) : null,
          });

          const series = [];
          if (lastSec > 0) {
            if (realSpanSec <= 0) {
              // 只有一条记录：就画一个点。为了凑时间轴而虚构 24 小时的跨度，
              // 会让一个点孤零零贴在左边或右边，反而像数据丢了。
              series.push(mkPoint(endMs, byB.get(0)));
            } else {
              for (let i = 0; i <= nBuckets; i++) {
                // i 从左端往右；槽从左到右是 b = nBuckets-1 … 0。
                // 最后一个边界右边没有槽了，沿用最右槽（b=0），所以最右 1 小时是平的
                // —— 那正是这一段的数据，不是补出来的。
                const b = i === nBuckets ? 0 : nBuckets - 1 - i;
                series.push(mkPoint(Math.round(startMs + i * stepMs), byB.get(b)));
              }
            }
          }
          // 一条记录都没有时 series 为空，前端显示「暂无数据」——
          // 不下发一排 n=0 的假点，那只会让人以为"测过但全挂了"。
          // 均值 = Σ(成功请求的 ttfb) / 成功次数 —— 精确，不是"各槽均值的平均"
          const avgTtfb = okl ? Math.round(tsum / okl) : null;

          const intervalMin = Number(meta.interval_min || 5);

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

          /*
           * 故障事件 = 连续失败 ≥ fail_threshold 的一段。
           *
           * 早先是「把状态变化点两两配对」再用时长倒推次数：
           *   checks_est = duration_s / (intervalMin * 60)
           * 问题在于 duration_s 本身就是「失败到恢复之间的时间」，一次 5 分钟间隔的
           * 单点失败会被算成 round(300/300)=1 或更少，再和阈值比就永远不够 ——
           * 于是「故障记录」在默认阈值 3 下**几乎永远为空**，而色条却是红的。
           *
           * 现在直接数真实记录：在窗口内按 ts 扫描，连续 ok=0 的条数 ≥ 阈值就算一段。
           * 只读 changeRows 那份 CTE 的结果不够（它只含翻转点，丢掉了中间行），
           * 所以这里用「窗口内失败行 + 前后最近的翻转点」重建：失败段起点取该段第一条失败，
           * 终点取其后第一条成功；次数直接用 checks 计数（而不是时长估算）。
           */
          const evtsAll = [];
          {
            // 取窗口内所有失败行（按 ts 升序）与所有成功行的 ts，用于切段
            const rows = (changeRows.results || [])
              .slice()
              .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
            // changeRows 只有翻转点，但「一段失败」至少有一个翻转点作为起点；
            // 结束点要么是下一个翻转点（成功），要么仍在进行中。
            let run = null; // { start, end, error, n }
            // ⚠️ 这里**不能**按 run.n 过滤：run.n 只数到翻转点，中间的连续失败行
            // 不在 changeRows 里（它只含翻转点）。真实次数要等下面按区间查 checks 才知道，
            // 所以这里先把所有段都留下来，过滤放到拿到真实计数之后。
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
            // 仍在故障中（没有后续成功点）：end 留空，由下面的 nFail 计算兜住"至少 1 次"。
            if (run) push();
          }

          // 上面的 n 是「翻转点条数」，不等于真实失败次数 —— 中间的连续失败行不会出现在
          // changeRows 里。所以再按段区间数一次真实记录，判定与展示都用这个数。
          const evts = await Promise.all(
            evtsAll.map(async (e) => {
              const endIso = e.end || new Date().toISOString();
              const c = await d
                .prepare(
                  `SELECT COUNT(*) AS n FROM checks INDEXED BY idx_checks_site_ts
                   WHERE site = ?1 AND ts >= ?2 AND ts <= ?3 AND ok = 0`
                )
                .bind(id, e.start, endIso)
                .first();
              const nFail = Math.max(1, Number(c?.n || e.n || 1));
              const t0 = Date.parse(e.start);
              const t1 = Date.parse(endIso);
              return {
                start: e.start,
                end: e.end,
                ongoing: !e.end,
                duration_s: Math.max(0, Math.round((t1 - t0) / 1000)),
                error: e.error,
                // 真实失败次数（不是按时长估的）
                checks: nFail,
                // 兼容旧字段：前端之前只读 checks_est，保留同一个值的语义
                checks_est: nFail,
                reached: nFail >= failThreshold,
              };
            })
          );

          const shown = evts
            // 未达阈值的单次抖动不算故障事件（与色条 red/yellow 的判据同一个）
            .filter((e) => e.ongoing || e.reached)
            // 上面的遍历是按时间正序，这里翻成最新在前，再按设置只留最近 N 条
            .reverse()
            .slice(0, incidentN);

          // 30 天色条（最左最新 → 最右最早，与首页一致）
          // 颜色语义与「故障记录」一致：只有出现「连续失败 ≥ fail_threshold」的段才算
          // 真故障（红，fault）；只有零星抖动的天是黄（blip），不再一律涂红。
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
              now: new Date().toISOString(),
              // 详情页也要页头品牌名一致，所以一并带上展示类设置
              settings: {
                site_title: rawSettings.site_title || defOf("site_title"),
                default_theme: rawSettings.default_theme || defOf("default_theme"),
              },
              site: {
                id: meta.id,
                name: meta.name,
                // 与 /api/overview 同一口径：隐藏地址的站点不下发 url（见那边的注释）
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
              // 只下发前端真正显示的几个数（KPI 卡「可用率」+ 图下方那行说明）。
              // since / bucket_sec / ok 从没被读过 —— 每多下发一个字段，缓存条目就大一分，
              // 而这份响应是要经过边缘缓存、按请求体量计费的。
              window: {
                hours: TREND_HOURS,
                // 实际跨度：满 24 小时就是 86400；不满则等于「首条记录 → 最后一次检查」
                span_sec: spanSec,
                // 实际点数 = 槽数 + 1（要含两端边界，满窗口时正好 25）
                points: series.length,
                // 窗口右端 = 最后一次检查。前端据此写「截至 HH:MM:SS」，
                // 让"曲线为什么停在那里"有解释（而不是让人以为数据丢了）。
                last_check_ts: meta.last_check || null,
                checks: n,
                failures: n - okl,
                uptime: n ? Math.round((okl / n) * 1000) / 10 : null,
                // 「故障记录」实际扫描的窗口（小时），与趋势窗口同源，前台据此写「最近 X」
                incident_hours: Math.max(1, Math.round(spanSec / 3600)),
              },
              // p95 / avg_total / min / max 已删：详情页只显示 latency.avg（「平均响应」卡片）。
              // 其中 p95 是这里最贵的查询（排序 + OFFSET + 子查询把同一次过滤重数一遍），
              // 30 天窗口下等于两次全表扫描，换一个前端从不显示的数字。
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
            if (nn === name) return json({ ok: true, action, name }, 200, "no-store", pretty);
            // 目标名已存在 → 直接合并过去，避免留下重复分类
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
            // 站点不跟着删，统一落到「未分组」—— 删分类不该顺带删监控
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

        // GET：显式分类 ∪ 站点上出现的 group_name（并集，各带站点计数）
        return json({ ok: true, categories: await buildCategories(d) }, 200, "no-store", pretty);
      }

      if (api === "sites") {
        const d = await db(env);
        if (request.method === "DELETE") {
          const id = url.searchParams.get("id");
          if (!id) return json({ ok: false, error: "缺少 id" }, 400);
          // 一张表一条，但一次 batch（原子）：见 db.deleteSite 的注释
          await deleteSite(env, id);
          return json({ ok: true, deleted: id });
        }
        if (request.method === "POST") {
          // request.json() 失败必须 .catch，否则非法 JSON 会被兜成 500。
          const parsed = await request.json().catch(() => null);
          if (!parsed || typeof parsed !== "object") {
            return json(
              { ok: false, error: "请求体不是合法的 JSON 对象" },
              400,
              "no-store",
              pretty
            );
          }
          // 站点排序：只传顺序，按下标写 sort。
          if (!Array.isArray(parsed) && parsed.action === "reorder") {
            const ids = Array.isArray(parsed.ids) ? parsed.ids.map(String).filter(Boolean) : [];
            if (!ids.length) {
              return json({ ok: false, error: "ids 不能为空" }, 400, "no-store", pretty);
            }
            // 上限只是挡畸形请求（正常一次就几十条，且 D1 batch 也不能无限长）
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
          let upserted = 0; // 真实写入条数 —— 不是 list.length（空 id/url 的会被跳过）
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
          // 未指定 sort 的新站点排到队尾，取一次全局最大值递增分配。
          const stmts = [];
          let nextSort = null;
          for (const s of list) {
            if (!s.id || !s.url) continue;
            const id = String(s.id).trim();
            const url = normalizeUrl(String(s.url).trim());
            // ── 服务端校验：非法直接拒绝，不要静默写坏数据
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
            // 顺序要留给拖拽来定：没给 sort 就分配队尾，给了（编辑回带）就用原值。
            // sort 只在同一分类内比较，所以全局取最大值不影响别的分类。
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
                // 阈值 1–20、间隔 1–1440 分钟（≤1 天）：防负数/超大值污染调度
                clampInt(s.fail_threshold, 1, 20, 3),
                clampInt(s.interval_min, 1, 1440, 5),
                s.enabled === false ? 0 : 1,
                sortValue
              )
            );
            upserted++;
          }
          for (const part of chunk(stmts, BATCH_CHUNK)) await d.batch(part);
          return json({ ok: true, upserted });
        }
        // GET 不支持：读取一律走 /api/admin（一次返回站点+状态+分类+设置）
        return json({ ok: false, error: "请用 /api/admin" }, 405, "no-store", pretty);
      }

      /** 后台聚合接口：一次请求拿全，省掉三次串行往返。 */
      if (api === "admin") {
        const payload = await buildAdminPayload(env);
        // 复用请求开头已读到的 rawSettings，不再多查一次 D1
        const settings = publicSettings(env, rawSettings);
        return json(
          // probe 直出「探针最近一次成功/失败/是否在退避」，后台据此提示额度问题：
          // 站点显示"探针无结论"时，这里能立刻分清是 GP 挂了还是额度用光了。
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
        // rows / perSite 只在服务端内部用，不下发给浏览器：
        // 后台只需要「收了几条、发起了几个」，把整份明细塞进响应纯属浪费。
        return json({
          ok: true,
          collect: { collected: collect.collected, fetched: collect.fetched, dropped: collect.dropped },
          dispatch: disp,
        });
      }

      // 即时测试：必须带 site=<id>（结果写入 checks）。不允许指定任意 target。
      if (api === "test") {
        const m2 = requirePost(request, pretty);
        if (m2) return m2;
        // 频率闸门：后台连续点「测」会把额度打空，也会占住同步等待时间。
        // 按站点 10 秒一次，内存级即可（多 isolate 不共享，这里只防手滑，不防攻击）。
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
        // 只允许测「已登记的站点」：不带 site 时一律拒绝。
        //
        // 早先 `site?.url || body.target || "https://www.baidu.com"` 意味着任何登录者都能
        // 让这个 Worker 消耗你的 Globalping 额度去探测**任意地址**（第三方站点、内网、
        // 甚至当作 SSRF 跳板），而且还同步等最多 20 多秒。这条路径线上用户根本不需要 ——
        // 想调试就用 /api/run?limit=1，或直接看 cron 日志。
        if (!site) {
          testLimiter.reset("global"); // 请求本身无效，别占额度
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

        // 位置筛选统一取全局设置，不再支持按请求覆盖 ——
        // 否则"测出来的结果"和"真实探测"可能用的不是同一个筛选，失去参考价值。
        const { id, source, quota } = await gpCreate(env, { url: target });

        /** 等结果：自适应间隔 + 总时长上限，固定间隔既慢又没有上界。 */
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
        // 后台 toast 要显示「这次测试实际等了多久」—— 它本身就是排查信息
        // （同一个站点等 3 秒 vs 25 秒，含义完全不同）。
        const elapsedMs = Date.now() - startedAt;
        // 结果不可用（id 失效 / API 报错）→ 明确报错并不落库。
        // gpCollect 把这种响应判成 done+broken（见其返回契约），照旧往下走会把
        // "压根没拿到数据"存成一条假的失败记录，反而污染页面。
        if (finished?.broken) {
          return json(
            { ok: false, kind: "globalping", source, quota, error: finished.error },
            502,
            "no-store",
            pretty
          );
        }
        const results = finished?.results || [];
        // 判定必须走 gpDecide，与自动探测同一条判定链。
        const dec = gpDecide(site || { expect_codes: "" }, results);
        if (dec.void) {
          // 无结论（探针全部是平台自身故障 / 一条结果都没收到 / 只剩 1 台且失败）→
          // 明确报错且不落库。与 broken 分支同一约定：把"没拿到结论"存成一条记录，
          // 等于凭空造出一个 up 或 down，直接污染可用率。
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
        // 票型标注规则与 collectGlobalping 一致：全通是常态（不标），
        // 分歧或有失败才标 `City/ASN (1/3)`
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
          // 与后台表格 / 前台同一口径的来源标签（见 origin.js）
          origin: formatOrigin(source, probeLabel),
          // 判定结论与票型 —— 后台据此用"判定成功"而不是"传输成功"上色
          verdict: { ok: dec.ok, reason: dec.reason ?? null, votes: `${dec.okCount}/${dec.total}` },
          results, persisted,
        });
      }

      // 未知接口一律 404 —— 返回 200 + 服务信息会让删掉的接口"看起来还在"，
      // 掩盖调用方的错误。
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
    /** 分段容错：每段单独 try/catch，任何一段失败都不中断整轮。 */
    const errors = [];
    const stage = async (name, fn, fallback) => {
      try {
        return await fn();
      } catch (e) {
        errors.push({ stage: name, error: String((e && e.message) || e) });
        return fallback;
      }
    };

    // 必须先建表补结构，再读设置。
    await stage("ensureSchema", () => ensureSchema(env), null);

    // cron 是独立入口，必须先合并后台设置再往下走。
    const settings = await stage("loadSettings", () => loadSettings(env), {});
    env = await effectiveEnv(env, settings);

    const sites = await stage("loadSites", () => loadSites(env), []);

    // 先收取上一轮 Globalping 的结果 —— 必须全量收，不受间隔影响：
    // 那些测量已经发出去了，不收就白花了额度。
    const collected = await stage("collectGlobalping", () => collectGlobalping(env, sites), {
      collected: 0,
      fetched: 0,
      rows: [],
      dropped: [],
      perSite: {},
      voided: 0,
      voidSites: [],
      sslWritten: 0,
      blockedUntil: null,
      remaining: [],
      lastChecked: {},
    });

    // 再按各站点的监测间隔，只对「已到期」的发起新一轮。
    // 预算要减掉本轮收取已经花掉的次数（见 dispatch 的注释）。
    // 到期判断复用本轮刚写进 state 的时间戳，跳过再一次 `SELECT ... FROM state`。
    // 全新实例 state 为空 → lastChecked 也是空对象，所有站点都会被判「无记录 → 到期」，
    // 与查库结果一致，所以可以无条件传。
    const due = await stage("dueSites", () => dueSites(env, sites, collected.lastChecked), []);
    const disp = await stage(
      "dispatch",
      () =>
        dispatch(env, due, {
          alreadyUsed: collected.fetched,
          raw: settings,
          // 同一轮里「收取没结论」已经计过数的站点，不要在发起失败时再 +1
          voided: collected.voidSites,
          // 收取阶段已经读过 pending 全表：传下去，dispatch 不再查一次。
          // 注意 remaining 只含「本轮没被收走的」，其余 pending 已在 collect 里删掉 —— 语义与
          // 「dispatch 自己去 SELECT * FROM pending」完全等价，但少一次 D1 往返。
          pendingSites: collected.remaining,
          // 收取侧撞到 429 时，发起端本轮也一起停 —— 否则两边各撞各的。
          blockedUntil: collected.blockedUntil,
        }),
      { used: 0, gpStarted: [], skipped: [], voided: 0, blocked_until: null, quota: null }
    );
    const subreqBudget = Number((env && env.SUBREQ_BUDGET) || 30);

    // 这里不再递增 config_version，否则每分钟都让前台缓存全失效。
    void collected; // 结果只用于日志汇总

    // 每天一次的过期明细清理（保留 N 天）。
    // 按「距上次成功清理的时间」判断而不是卡某个钟点 —— 后者只要那一轮 cron
    // 失败或漂移，当天就再也不清理了，checks 会一路膨胀。按时间间隔判断自带自愈。
    let cleaned = 0;
    let orphans = 0;
    if (shouldCleanup(settings)) {
      try {
        cleaned = await cleanupOldChecks(env, Number(env?.CHECK_KEEP_DAYS || 30));
        // 顺带清掉「站点已删除」的遗留行（state / ssl / pending）。
        // 级联删除是后加的，改造前删掉的站点会留下孤儿行；它们不影响正确性
        // （读侧都由 sites 驱动），只是白占空间、让行数对不上。
        orphans = await cleanupOrphans(env);
        await saveSetting(env, "last_cleanup_ts", String(Date.now()));
        await noteCleanup(env, true);
      } catch (e) {
        cleaned = -1; // -1 表示失败，便于在日志里区分"删了 0 条"和"没跑成"
        await noteCleanup(env, false);
      }
    }

    console.log(
      JSON.stringify({
        cron: controller.cron,
        sites: sites.length,
        due: due.length, // 本轮按间隔筛选后实际该查的站点数
        collected: collected.collected,
        // 丢弃且未记检查记录的 pending（ttl / broken / throw）。正常恒为 []；
        // 非空说明 Globalping 那边有异常，且该站点本轮没有产出检查记录。
        gpDropped: collected.dropped,
        gpStarted: disp.gpStarted,
        // 本轮「没拿到结论」而被计数的站点数：> 0 说明这一轮它们没有产出检查记录
        gpVoided: disp.voided,
        // 发起失败的站点数（凭据错 / 参数非法 / 429）。与 gpStarted 里的 error 一起看。
        gpFailed: disp.failed,
        // 非空说明正处于 429 退避窗口，此轮起一个都没发
        gpBlockedUntil: disp.blocked_until,
        skipped: disp.skipped,
        // 出网子请求：本轮已用（收取 + 发起）/ 预算。
        // 站点多时会贴着预算跑，此时 skipped 非空属正常节流（下一轮补上）；
        // 若 skipped 长期非空，说明要么站点太多、要么间隔太密，需要二选一。
        subreqUsed: disp.used,
        subreqBudget,
        persisted: collected.collected,
        // 本轮顺带更新的证书数量（与探测同一次请求，不额外消耗额度）
        ssl: collected.sslWritten || 0,
        cleaned, // 0 = 不在清理时点或无过期数据；-1 = 清理失败
        orphans, // 本次清掉的孤儿行数（站点已删除的 state/ssl/pending）
        // 分段错误：正常恒为 []。非空说明本轮有阶段失败，但其余阶段仍照常跑完了。
        errors,
      })
    );
  },
};

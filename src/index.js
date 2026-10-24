/**
 * uptime —— 站点监测编排层
 *
 * 核心设计：
 *   ① 探测走 Globalping「两阶段」：本轮发起测量、下一轮收取结果
 *      —— 因为 Workers 免费计划每次调用最多 50 个子请求，
 *         轮询等待几下就吃光了；两阶段把每站点压到 2 个子请求
 *   ② 一次测量同时产出延迟 / 状态码 / 证书，所以 SSL 不单独发请求
 *   ③ 展示侧读的是 state（最后结果快照）+ day 聚合，不扫 checks 明细
 */

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
  saveSsl,
  upsertLastResult,
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
  sleep,
} from "./auth.js";
import { SETTING_META, SETTING_KEYS, defOf, validMagic, gpLimitNum } from "./settings.js";
// 「谁在哪跑的」统一口径 —— 三个前端共用这一个格式化函数（原因见模块注释）
import { formatOrigin } from "./origin.js";


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

/**
 * 会真正写库的接口 —— 只有它们（非 GET 时）才递增 config_version。
 *
 * 这份名单存在的意义：config_version 是**全机房缓存的总开关**（key 里带它），
 * 一变则所有 overview/site 缓存条目同时失效。所以它只该在"配置变了"时动，
 * 不该被登录失败、未知接口、跨站被拒这类"什么也没写"的请求推动。
 * 名单外的写接口（目前只有 login / logout）改了也不影响公开数据：
 * 前者只发 cookie，后者只动会话纪元与密钥。
 *
 * 注意 test / run 也在名单里：它们会往 checks 写记录，属于"公开数据变了"。
 */
const WRITE_APIS = new Set(["settings", "sites", "categories", "test", "run"]);

/** 默认输出紧凑 JSON（省流量）；调试时加 &pretty=1 才缩进 */
const json = (o, status = 200, cache = "no-store", pretty = false) =>
  new Response(pretty ? JSON.stringify(o, null, 2) : JSON.stringify(o), {
    status,
    headers: { ...JSON_HEADERS, "Cache-Control": cache },
  });

/**
 * 把「D1 层面的报错」翻译成可执行的下一步。
 *
 * 为什么需要：这类故障在浏览器里只表现为 `500 ()` —— 响应体是空的（异常逃出了
 * fetch 处理器），前端拿不到任何文案，用户看到的就是一句「加载失败」。
 * 而它们的成因高度集中，几乎都是"库没准备好"或"绑定没生效"，一条指引就能解决。
 *
 * 只在 5xx 兜底处调用；映射不到时返回 null，不硬编一条泛泛的提示。
 */
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

/**
 * 部署自检要核对的表。
 *
 * 从 `SCHEMA_STMTS` 直接推导，而不是再手工维护一份清单 —— 原来写死七个表名时，
 * 加表要改两处（schema.sql + 这里），漏改的后果是自检少报一张表，
 * 于是「库缺表」这件事反而被自检漏掉了。现在只有 schema.sql 一个真源。
 */
const EXPECTED_TABLES = SCHEMA_STMTS.map(
  (s) => (s.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i) || [])[1]
).filter(Boolean);

/** dbErrorHint 的响应体片段（映射不到时返回空对象，不塞 null） */
const hintOf = (e) => {
  const h = dbErrorHint(String((e && e.message) || e));
  return h ? { hint: h } : {};
};

/**
 * 部署自检：只回答「这个 Worker 装好了没有」，**不返回任何业务数据**。
 *
 * 为什么必须是公开接口：出问题时最先坏的可能就是登录（密码没配、D1 没表），
 * 要求先登录再自检等于在最需要它的时候用不了。
 *
 * 为什么放在设置加载**之前**：`loadSettings` 本身就要读 D1 —— 库没建表时它先抛，
 * 后面的任何分支都到不了。自检必须绕开这一步。
 *
 * 只暴露"哪张表在不在""密码配没配"这类结构信息，不含站点、地址、token。
 */
async function buildHealth(env, pwdConfigured, pretty, schema) {
  const out = {
    ok: true,
    db_bound: Boolean(env && env.DB),
    db_ready: false,
    password_set: Boolean(pwdConfigured),
    schema: {
      expected_version: SCHEMA_VERSION,
      // 本次请求里自动补结构的结果：
      //   none      本来就已经是最新结构（正常状态，绝大多数时候看到的就是它）
      //   created   这个库原本一张表都没有，本次把它建起来了
      //   repaired  库已存在（旧库/缺表），本次补齐了结构与迁移
      //   failed    自动建表失败，原因见 schema.error
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

  if (schema && schema.ok && schema.migrated) {
    out.schema.statements = schema.statements;
    // -1 = 全新库，0 = 旧库无版本标记，N = 从 N 升上来
    out.schema.from_version = schema.from;
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

  return json(out, out.ok ? 200 : 500, "no-store", pretty);
}

/**
 * 同源校验（防 CSRF）。
 *
 * Cookie 已是 SameSite=Lax，这本身就挡掉了绝大多数跨站写；但 Lax **允许顶层 GET 导航带 cookie**，
 * 所以只要存在"会改状态的 GET"，就仍然有空子可钻。为了不依赖"记得每个端点都写成 POST"，
 * 这里对所有**非安全方法**统一加一道显式校验。
 *   优先看 Origin（最可靠）；缺失时退回 Sec-Fetch-Site。两者都没有时**拒绝** ——
 *   全部现代浏览器都会带上这两个头，放行只会白白留一个可绕过的口子。
 */
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
  const status = res.status;
  const text = await res.text();

  /**
   * ⚠️ 只缓存 200，并把**原始状态码**原样返回。
   *
   * 原先不论源响应是什么状态，都 `new Response(text, { status: 200 })` 再 PUT 进缓存：
   *   · `/api/site?id=不存在` 的 404 变成 200 —— 前端 `r.ok` 为真，走成功分支去读
   *     `data.site.name`，拿到 undefined 后渲染出一个空白详情页，控制台没有任何错误；
   *   · 更糟的是这个 404 被缓存了 30 秒：期间**任何**请求都拿到"200 + 站点不存在"。
   * 非 200 一律不写缓存（`no-store`），状态码与源响应保持一致。
   */
  const cacheable = status === 200 && !res.headers.get("set-cookie");
  const headers = cacheable
    ? { ...JSON_HEADERS, "Cache-Control": `public, s-maxage=${ttl}` }
    : {
        ...JSON_HEADERS,
        "Cache-Control": res.headers.get("cache-control") || "no-store",
      };

  if (cacheable) {
    // ⚠️ 用 await 而不是 ctx.waitUntil：PUT 是机房本地的同步操作，耗时可忽略；
    //    而异步 PUT 会让写入跨越请求边界（响应已返回、PUT 才落地），
    //    在 config_version 递增这类时序里留下难以复现的残影。
    //    顺带说明：缓存**失效**不依赖任何 append/delete 动作，
    //    全靠 key 里带 config_version（写操作一改版本号，旧 key 就再也不会被命中）。
    try {
      await cache.put(key, new Response(text, { status: 200, headers }));
    } catch {}
  }
  return new Response(text, {
    status,
    headers: { ...headers, "x-edge-cache": cacheable ? "MISS" : "BYPASS" },
  });
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

/**
 * 写操作后让缓存失效。
 *
 * ⚠️ 这里**只**递增 config_version，不再手动 delete 缓存条目 —— 原因：
 *    overview / site 的缓存 key 形如 `...?days=..&pretty=..&v=<config_version>`，
 *    版本号一变，所有旧 key 立刻不再命中，等于**全机房同时失效**；
 *    而 `caches.default.delete()` 是**机房本地**的，只能清当前这一台，
 *    其他机房仍会命中旧值（实测「改完分类顺序前台没变」正是这个原因）。
 *
 *    早先还有一个 `purgeOverview()` 在 delete「不带查询串的 /api/overview」——
 *    而写入用的 key 始终带 `?days=&pretty=&v=`，两者**永远不相等**，
 *    那行代码从头到尾都是空的。已删掉，避免后人以为"已经清过缓存了"。
 */
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
    // 「每个站点的最新一条」直接读 state —— 落库时就同步维护了结果快照，
    // 所以这里是主键小表扫描，代价与 checks 的历史数据量无关。
    // （若改成对 checks 做 ROW_NUMBER() 分区排序，耗时随站点数与保留天数线性增长。）
    d
      .prepare(
        `SELECT site, last_ok AS ok, last_status AS status, last_ttfb_ms AS ttfb_ms,
                last_source AS source, last_probe AS probe, last_ts AS ts
         FROM state`
      )
      .all(),
    buildCategories(d),
    // ⚠️ 只读已有证书结果，绝不在渲染路径上触发检测。
    //    证书由 cron 的每次探测顺带写入（见 collectGlobalping 的 sslWrites），
    //    这里只做一次 LEFT JOIN 式的读取，不产生任何出网请求。
    //
    // days_left 用现算表达式取（库里的值是 NULL，见 db.sslDaysLeftSql）：
    // 后台表格、首页、详情页三条读路径必须用同一个算法，否则同一天会在三个页面
    // 显示三个剩余天数。
    d.prepare(`SELECT ${SSL_COLUMNS_SQL()} FROM ssl`).all(),
  ]);

  const lastMap = Object.fromEntries((lastsRes.results || []).map((r) => [r.site, r]));
  const sslMap = Object.fromEntries((sslRes.results || []).map((r) => [r.site, r]));
  const sites = (sitesRes.results || []).map((s) => {
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
      // stateOf() 读的是 ssl_* 前缀的**扁平**字段（与 overview 的 SQL 别名同形），
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

/**
 * 是否该清理过期明细。
 *
 * 只用「上次成功清理的时间」判断，不用固定的 UTC 时刻窗口 ——
 * 后者只要那一轮 cron 没跑成就漏一整天，且没有补救机制。
 * 周期设 20 小时（略短于 24）：正常一天一次，漏了也能在下个窗口自动补。
 */
const CLEANUP_INTERVAL_MS = 20 * 3600 * 1000;
function shouldCleanup(rawSettings) {
  const last = Number(rawSettings.last_cleanup_ts || 0);
  return !last || Date.now() - last >= CLEANUP_INTERVAL_MS;
}

/** Globalping 位置筛选：同样是全局设置。null 表示用 probe.js 的内置默认 */
function gpMagicOf(env) {
  return (env && env.GP_MAGIC) || null;
}

/**
 * 站点的来源标签（首页 / 详情页 / 后台共用，格式见 origin.js）。
 *
 * 有检查记录时用**最近一次实际跑的那台**（last_source/last_probe）——
 * 探针每次可能换城市，如实显示才能解释"延迟为什么变了"。
 * 从未检查过的站点则用配置推一个（`GP:CN`），免得首页那一行留一块空白。
 */
function originOf(site, lastSource, lastProbe, env) {
  const real = formatOrigin(lastSource, lastProbe);
  if (real) return real;
  return formatOrigin(`gp:${gpMagicOf(env) || defOf("gp_magic")}`, null);
}

/**
 * 「响应偏慢」判定的基线（毫秒）。
 *
 * 直接用探针端超时（gp_timeout_sec，默认 15s）作为基线：超过一半即 7.5s 判"偏慢"。
 * 不另设一个数字，是因为"多慢算慢"必须和"多久算失败"同一把尺子 ——
 * 两个独立配置迟早会配成"慢阈值 > 超时阈值"这种自相矛盾的状态。
 */
function slowBaseMs(env) {
  const sec = Number((env && env.GP_TIMEOUT_SEC) || defOf("gp_timeout_sec"));
  return (Number.isFinite(sec) && sec > 0 ? sec : 15) * 1000;
}

/**
 * 三态判定：up / down / degraded（overview 与 site 详情共用，避免两处逻辑漂移）
 *
 * 降级规则对齐参考项目 ftxw/uptime-monitor 的 lib/checker.ts：
 *   证书无效 或 剩余 ≤ SSL_WARN_DAYS（默认 14）天 或 响应时间 > 该后端超时上限的一半
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
    const baseMs = slowBaseMs(env);
    const warnDays = Number(env.SSL_WARN_DAYS);
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
    } else if ((s.last_ttfb || 0) > baseMs * 0.5) {
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
/* 设置项清单、环境变量映射与默认值都在 src/settings.js —— 那里是唯一来源 */

/**
 * 不对外暴露的内部状态键（不在 SETTING_KEYS 里，后台读写接口都碰不到）：
 *   session_secret     会话签名密钥，首次需要时随机生成并落库
 *   config_version     配置版本号，用于让边缘缓存立即失效
 *   login_fail_window / login_fail_count   登录失败计数（全局限速）
 */

/**
 * 把 D1 设置合并进 env —— 现有代码全部读 env.XXX，这样一处覆盖、全链路生效，
 * 不必在每个调用点都改成读设置。
 */
async function effectiveEnv(env, S) {
  const s = S || (await loadSettings(env));
  const merged = Object.assign({}, env);
  for (const [k, m] of Object.entries(SETTING_META)) {
    if (!m.env) continue; // 纯展示项（主题/标题）不写进 env，读侧直接从 meta 取
    merged[m.env] = s[k] !== undefined && s[k] !== "" ? s[k] : env[m.env] || m.def;
  }
  return merged;
}

/**
 * 「一天」从哪一刻起算 —— 30 天色条与按天聚合的唯一时区来源。
 *
 * 必须可配的原因：色条是"某天的成功/失败占比"，而"某天"完全取决于时区。
 * 写死在一个值上，换时区的部署就必须改代码；而 SQL 与 JS 两侧又必须算出**同一个**
 * 边界，否则首帧会在两个日期间漂移。所以统一从这里取。
 *
 * @returns {number} 毫秒偏移。供 JS 侧生成日期轴用；SQL 侧走 dayMod()
 */
function dayOffsetMs(env) {
  const min = clampInt(
    env?.UTC_OFFSET_MIN ?? SETTING_META.utc_offset_min.def,
    -720,
    840,
    SETTING_META.utc_offset_min.def
  );
  return min * 60000;
}
/** SQLite date() 的修饰符，如 '+480 minutes' */
function dayMod(env) {
  const min = Math.round(dayOffsetMs(env) / 60000);
  return `${min < 0 ? "-" : "+"}${Math.abs(min)} minutes`;
}

/**
 * 按天算出「最长的一段连续失败有多长（次数）」。
 *
 * 为什么需要：30 天可用率色条原先只看当天的失败**次数** —— 只要有失败就标成
 * 「当天有故障」。但一次没到 fail_threshold 的失败（下一拍就恢复）本就不是故障
 * （见「故障记录」卡片的口径），却被涂成红色，同一件事在同一个页面上有两种说法。
 * 现在色条改用与告警 / 故障记录**同一个定义**：当天出现过「连续失败 ≥ fail_threshold」
 * 的段才算故障（`fault`），其余只有 `blip`（有抖动，不标红）。
 *
 * 连续性只能靠时间戳间隔判断：同一站点的探测是等间隔的，两次失败的时间差接近一个
 * 间隔就说明它们相邻（中间没有成功过）。容差取 1.3 倍间隔 —— 既容忍调度抖动
 * （cron 相位、Globalping 两阶段带来的 ±秒级偏移），又保证 < 2 倍间隔，从而**不会**
 * 把"中间夹着一次成功"的两次失败并成一段。
 *
 * 跨天的段在按天分组时会被切开，属保守处理：宁可少标红，不多标红。
 * 代价上这是"只读失败行"，配合 idx_checks_ok_ts_site 索引，读取量与该段时间的
 * 失败次数成正比，而不是与总检查数成正比。
 *
 * @param {Array<{d: string, ts: string}>} rows 失败检查，需按 ts 升序（同一天的行连续）
 * @param {number} intervalMin 该站点的期望检查间隔（分钟）
 * @returns {Object<string, number>} 天 → 当天最长连续失败次数
 */
function maxFailRunPerDay(rows, intervalMin) {
  const tol = Math.max(1, Number(intervalMin) || 5) * 60 * 1.3; // 秒，见上方容差说明
  const out = {};
  let day = null;
  let prevS = null;
  let run = 0;
  for (const r of rows || []) {
    if (r.d !== day) {
      day = r.d;
      prevS = null;
      run = 0;
    }
    const s = Date.parse(r.ts) / 1000;
    run = prevS !== null && s - prevS <= tol ? run + 1 : 1;
    prevS = s;
    if (out[day] === undefined || run > out[day]) out[day] = run;
  }
  return out;
}

/**
 * 按 key 做取值的类型/范围规范化。
 *
 * 为什么必须在写入侧拦：这些值会直接参与探测参数（超时、IP 版本、位置筛选）和降级判定。
 * 一个 gp_timeout_sec = "abc" 会让 Number(...) 得到 NaN，进而使判定条件恒假、
 * 或让所有请求立即超时 —— 表现为"整站全线故障"，极难联想到是某个设置项写坏了。
 */
function normalizeSetting(k, v) {
  const def = SETTING_META[k]?.def ?? "";
  const num = (min, max) =>
    String(clampInt(v === undefined || v === null || v === "" ? def : v, min, max, def));
  switch (k) {
    case "ssl_warn_days":
      return num(0, 90);
    case "subreq_budget":
      // ⚠️ 上限 35 而不是 45：这是「本轮出网子请求」的额度，而 Workers 免费层
      //    每次调用硬上限是 50，且 **D1 往返也算子请求**（不在这里计数）。
      //    一轮 cron 的 D1 往返实测 15~20 次（loadSettings / loadSites / collect /
      //    dispatch / bumpState / saveSsl / bumpConfigVersion …），所以
      //    35 + 20 = 55 已经到临界；设到 45 就是"配置合法但一定跑不通"。
      return num(1, 35);
    case "check_keep_days":
      return num(1, 365);
    case "recent_limit":
      // 上限 200 与 /api/site 的 recent 参数钳制保持一致 —— 再大对页面没有意义，
      // 只会让详情页的返回体变大
      return num(5, 200);
    case "incident_limit":
      return num(1, 100);
    case "utc_offset_min":
      return num(-720, 840);
    case "gp_timeout_sec":
      // Globalping API 的硬约束：整数秒，5–30。越界它直接 422，
      // 所以在写入侧就拦下，别把非法值存进 meta 再让 cron 每轮去撞
      return num(5, 30);
    case "gp_ip_version":
      return v === "6" ? "6" : SETTING_META.gp_ip_version.def;
    // ⚠️ 下面四项原先**完全没有校验**（落到 default 分支原样存库），而它们直接决定
    //    每一次 Globalping 请求的请求体：一个 `gp_limit=abc` 让所有 GP 站点 422、
    //    一个带空格的 magic 让所有 GP 站点 no_probes_found。
    //    失败面是"全部 GP 站点一起失败"，而站点本身完全正常 —— 这正是最容易被误判成
    //    "站点挂了"的一类故障，所以必须在写入侧就拦死。
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

/**
 * 会话签名密钥：优先生效环境变量 `ADMIN_SECRET`，否则用 D1 里的随机值（首次访问时生成）。
 *
 * ⚠️ 首次生成必须用「先到先得」而不是「读不到就写」：
 *    原写法是典型的 read-modify-write，两个并发请求（或多机房的两个 isolate）
 *    会各自生成一份并各自 `saveSetting`，**后写的覆盖先写的** ——
 *    于是先签发出去的 token 在下一个请求上就验签失败。
 *    表现是「刚登录成功，下一次请求又要求登录，刷新一下又好了」，
 *    只在首次部署/首次访问时出现，事后完全无法复现。
 *
 *    现在 `INSERT OR IGNORE` 让第一个写入者胜出，其余请求随后从这个位置读回
 *    **同一个**值，从而保证全机房签出、验签用的是同一把钥匙。
 */
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

/**
 * 会话纪元：吊销所有已签发会话的**唯一可靠手段**（与密钥来源无关）。
 *
 * 存在 D1 的 meta 里，随 loadSettings 一起读出来（每个请求本来就要读一次设置，
 * 所以这是零额外往返）。「登出所有设备」把它 +1，旧 token 的 ep 立刻对不上。
 */
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

/* ─────────────────────── 入参校验 ─────────────────────── */

/**
 * 服务端必须自己校验，不能只信任前端。
 * 前端那些 Number()/trim() 只是为了让表单好用 —— 绕过页面直接调接口时它们完全不存在，
 * 届时 fail_threshold = -1、interval_min = 0、url = javascript:... 都会原样落库。
 */

/** 钳到整数区间；非数字返回默认值（而不是 NaN 落库） */
function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 0/1 开关列（默认关）：接受布尔、数字 1、字符串 "1"，其余一律 0。
 *
 * 不用 `clampInt` 代替：那个函数的默认值语义是"取不到就给 dflt"，
 * 而这里"取到任何非法值"和"压根没传"都应当收敛到 0（关），不能因为
 * 传了个 "yes" 就悄悄保持原值 —— 这是隐私开关，宁可关掉。
 */
function boolInt(v) {
  return v === true || v === 1 || v === "1" ? 1 : 0;
}

/**
 * 解析 URL 查询参数里的整数（**不能用 clampInt 代替**）。
 *
 * ⚠️ 两个真实踩过的坑：
 *  1. `url.searchParams.get("x")` 缺省返回 **null**，而 `Number(null) === 0`
 *     且 0 是有限数 —— 走 clampInt 会被当成"传了 0"钳成 min，而不是落到默认值。
 *     后果是 /api/overview 不带 days 时 days=1：首页 30 天色条只剩今天一格，
 *     被 CSS 的 flex:1 拉满整行，看上去就是「运行历史变成一根长条」。
 *  2. `Number("abc")` 是 NaN，若让它漏下去，`new Date(NaN).toISOString()`
 *     会直接抛异常 → 接口 500（`/api/site?days=abc` 原先就是这样）。
 *
 * 所以：缺失（null / undefined / 空白）与非法值都回落到 dflt，其余钳到 [min,max]。
 */
function queryInt(raw, dflt, min, max) {
  if (raw === null || raw === undefined) return dflt;
  const s = String(raw).trim();
  if (s === "") return dflt;
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt;
}

/**
 * 站点 id 会拼进 URL（/monitor?id=）也用作主键。
 * SQL 是参数化的，不存在注入风险；真正要拦的是**会拆掉 URL 结构**的字符
 * （/ ? # % 与控制字符、空白），其余（含中文）放行，避免把已有的中文 id 站点变成无法编辑。
 */
/**
 * 站点 ID 的合法字符集：`[A-Za-z0-9._-]`，1–64 字符。
 *
 * 为什么是**白名单**而不是黑名单：id 要进 URL（`/monitor?id=<id>`）。
 * 黑名单（原来的"不含 / ? # % < > \ " 与空白"）看着够用，实则永远漏 ——
 * 中文、全角符号、`&`、`+`、`=` 在 query 里都会被重新编码，
 * 于是"后台里看到的 id"与"URL 里的 id"不是同一个字符串，排查时极易误判。
 * 白名单同时消掉了 `..`/首尾点这类在路径语义上有歧义的值。
 *
 * ⚠️ 前端 `#f-id` 的 `pattern` 必须与这里**逐字符一致**：两处不同的字符集就是
 *    "前端放行、后端 400"（或反过来）的第三种口径，用户只会觉得"这站点存不进去"。
 */
const SITE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function validSiteId(id) {
  return typeof id === "string" && SITE_ID_RE.test(id.trim());
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

/**
 * 取某个设置项的「最终生效值」，用于回显到后台表单。
 *
 * env 此时已被 effectiveEnv 合并过：有环境变量的项从 env 读，
 * 纯展示项（没有 env 变量）直接从 meta 读；两者都没有就回落到 SETTING_META 的默认值。
 */
function effectiveSettingValue(env, raw, k) {
  const m = SETTING_META[k];
  if (!m) return raw[k] ?? "";
  return m.env ? env[m.env] || m.def : raw[k] || m.def;
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
  return s;
}

/* ────────────────────────── 两阶段调度 ────────────────────────── */

/**
 * pending 行的最长存活时间（兜底）。
 *
 * 为什么必须有：`dispatch` 里 `if (pendingSet.has(s.id)) continue` 会让**已有 pending 的
 * 站点不再被发起探测**，所以一条永不收尾的 pending 就等于该站点**永久静默停摆** ——
 * 页面上还在显示旧状态，实际早已不再检测，且不会有任何告警。
 *
 * 取值依据：正常测量一定在 ~40s 内进入 finished/failed（探针侧最多 30s + 收尾 ≥10s），
 * 而 cron 每分钟醒一次 —— 3 分钟远大于任何正常情况，不会误杀在途测量；
 * 又短到让异常在一两个监测周期内自愈。
 * gpCollect 已经直接把"响应缺 status"判为 broken（见其返回契约），这里只是最后一道兜底。
 */
const PENDING_TTL_MS = 180_000;

/** 阶段一：收取上一轮发起的 Globalping 测量 */
async function collectGlobalping(env) {
  const d = await db(env);
  const { results: pending } = await d.prepare("SELECT * FROM pending").all();
  // ⚠️ 返回值结构必须与下面的完整分支保持一致（尤其是 dropped / sslWritten）——
  //    调用方会无条件读 collected.dropped，少了这个字段就会抛 TypeError，
  //    导致整轮 cron 在打完日志前失败。
  if (!pending || !pending.length) return { collected: 0, rows: [], dropped: [], perSite: {} };

  const sites = await loadSites(env);
  const byId = Object.fromEntries(sites.map((s) => [s.id, s]));
  const rows = [];
  const perSite = {};
  const doneIds = [];
  // 证书随同一次测量回来 —— 攒起来最后一起写，避免每个站点一次独立往返
  const sslWrites = [];
  // 被丢弃、且**没有**写检查记录的 pending。正常恒为空，非空即代表有异常需要排查。
  const dropped = [];

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
      continue;
    }

    let out;
    try {
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
      continue;
    }
    if (!out.done) continue; // 还没跑完，留到下一轮
    doneIds.push(p.site);

    // 结果不可用（measurement id 失效 / API 返回错误体）：丢弃 pending，但**不写检查记录**。
    // 为什么不能记成一次失败：我们对站点当时的可达性一无所知，记失败会凭空造出一次"故障"，
    // 攒到阈值还会发告警 —— 那是把"我们没拿到数据"谎报成"站点挂了"。
    // 丢弃 pending 让下一轮能重新发起，比让它永久占位（站点静默停摆）安全得多。
    if (out.broken) {
      dropped.push({ site: p.site, id: p.measurement_id, why: "broken", error: out.error });
      continue;
    }

    const site = byId[p.site];
    if (!site) continue;

    // ── 多探针多数表决（口径与理由见 probe.js 的 gpDecide）──
    const dec = gpDecide(site, out.results);
    if (dec.void) {
      // 平票 / 全是平台自身故障 / 一条结果都没有 —— 三种情况都**没有结论**。
      // 与上面的 broken 分支同一条约定：不写检查记录。
      // 记成失败会凭空造出一次"故障"、把 consecutive_fail 推上去、攒够阈值就发告警；
      // 而事实是我们对站点当时的可达性一无所知。pending 已删，下一轮会自动重发。
      dropped.push({
        site: p.site,
        id: p.measurement_id,
        why: "vote-" + dec.why,
        ok_votes: dec.okCount ?? null,
        total: dec.total ?? null,
        platform_faults: dec.platformFaults ?? 0,
      });
      continue;
    }

    const r0 = dec.pick;
    // 票型只在**非全票**时标注：全票是常态，标了只是噪音（会让每行都变长）；
    // 而一旦出现分歧（如 2/3），这个数字恰是判断"链路在抖 vs 站点真挂了"的关键线索。
    const probeLabel = dec.unanimous
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
  await bumpState(env, perSite);
  // 证书写入口：只有握手成功（tls 非空）才写，失败时保持上一次已知的证书状态 ——
  // 探针连不上不代表证书变了，把它写成"无证书"会让首页突然显示"证书未检测"。
  for (const [siteId, tls] of sslWrites) {
    await saveSsl(env, siteId, tls).catch(() => {});
  }
  return { collected: rows.length, rows, dropped, perSite, sslWritten: sslWrites.length };
}

/**
 * cron 周期，必须与 wrangler.toml 的 `* * * * *` 一致。
 * 下面两处修正都建立在「调度器最多每分钟醒一次」这个前提上。
 */
const CRON_PERIOD_MS = 60_000;

/**
 * 判定「到期」时允许的提前量。
 *
 * 为什么必须有：last_checked_ts 是在探测**写库之后**（bumpState）才更新的，
 * 比 check 自身的时间戳晚几百毫秒到几秒。而 cron 是按分钟触发的 ——
 * 于是「间隔 = 1 分钟」的站点在下一分钟醒来时，now - last_checked 只有 59.x 秒，
 * 差一点点不到 60 秒，被判成「未到期」，白等一整分钟（1 分钟间隔实际变 2 分钟）。
 * 给一个远小于 cron 周期的宽容量即可消除；因为 cron 与监测间隔都是整分钟对齐的，
 * 这么小的提前量不会把探测挪到别的 tick 上。
 */
const DUE_GRACE_MS = 15_000;

/**
 * 挑出「本轮该检查」的站点。
 *
 * 为什么需要这一步：cron 每分钟触发（见 wrangler.toml），但每个站点的监测间隔
 * 是独立配置的（1 / 5 / 10 / 30 / 60 分钟）。必须按「距上次检查是否已达间隔」
 * 筛选，否则 1 分钟和 1 小时的站点会被一视同仁地每分钟都查 ——
 * 既浪费子请求与 DO 额度，也让间隔设置彻底失去意义。
 *
 * last_checked_ts 由 bumpState 在每次检查**完成后**写入，所以它表示
 * 「上次真正完成检查的时刻」，对 CF 与 Globalping 两种后端语义一致。
 * 从未检查过的站点（无记录）直接纳入，保证新增站点立刻被探测一次。
 */
async function dueSites(env, sites) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT site, last_checked_ts FROM state").all();
  const lastMap = Object.fromEntries((results || []).map((r) => [r.site, r.last_checked_ts]));
  const now = Date.now();
  return sites.filter((s) => {
    const last = lastMap[s.id];
    if (!last) return true;
    const ivMs = Math.max(1, Number(s.interval_min || 5)) * 60_000;

    // Globalping 是两阶段：本轮发起、下一轮才收得到结果，探测本身就跨一个 cron 周期。
    // 若仍按「距上次**收到结果**满 interval 才发起」，结果落地会整整晚一轮
    // （1 分钟间隔 → 2 分钟）。所以提前一个周期把测量发出去，让**结果**落在 interval 上；
    // 由于 collectGlobalping 先于 dueSites 执行，刚收完结果的站点在同一轮就会被重新发起，
    // 形成「下一轮收上一轮的结果」的流水线。CF 后端同步返回，不存在这段延迟。
    // 两阶段要多等一轮才拿到结果，所以提前一个周期发起，保证实际间隔接近配置值
    const lead = CRON_PERIOD_MS;

    const dueAt = Math.max(0, ivMs - lead) - DUE_GRACE_MS;
    return now - new Date(last).getTime() >= dueAt;
  });
}

/**
 * 阶段二：发起本轮测量
 *
 * `subreq_budget` 是**本轮所有出网子请求**的额度 —— 免费层每次调用硬上限 50，
 * 而每个站点要 1 次发起 + 1 次收取，所以站点数越接近 20 越要盯着这个值。
 * 额度不够时**跳过**（记进 `skipped`），而不是硬发出去把整轮 cron 打成失败 ——
 * 跳过的站点下一轮会自然补上（dueSites 靠 last_checked_ts 判断，本轮没写就不算已查）。
 */
async function dispatch(env, sites) {
  const budget = Number((env && env.SUBREQ_BUDGET) || 30);
  const d = await db(env);
  let used = 0;
  const skipped = [];

  // 已挂起的站点本轮不再重复发起：上一轮的测量还没收，重发等于白花额度
  const { results: pend } = await d.prepare("SELECT site FROM pending").all();
  const pendingSet = new Set((pend || []).map((p) => p.site));

  const gpStarted = [];
  for (const s of sites) {
    if (pendingSet.has(s.id)) continue;
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
      // 发起失败不写 checks（我们对站点当时的可达性一无所知），下一轮重试
      gpStarted.push({ site: s.id, error: String((e && e.message) || e) });
    }
  }

  return { used, gpStarted, skipped };
}

/**
 * 手动测试（后台「测」按钮）的结果也要落库 ——
 * 否则它不会出现在详情页的折线和「最近检查」里，与自动探测的数据割裂。
 *
 * ⚠️ 只写 checks，**刻意不调 bumpState**，原因是两个副作用都不该由一次调试点击引起：
 *    ① bumpState 会更新 state.last_checked_ts，而 dueSites() 正是靠它判断"是否到期"，
 *       于是手动测一次就会把该站点的下次计划检查往后推 interval_min；
 *    ② 会累加 consecutive_fail 并可能在达到阈值时真的发出告警。
 *    手动测试是排查手段，不应该改变调度与告警状态。
 *    因此「连续失败次数」只由 cron 的自动探测累积；手动结果仅作为数据点展示。
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
  await Promise.all([
    insertChecks(env, [row]),
    // 同步刷新 state 的「最后一次结果快照」，让首页/后台立刻反映这次手动测试。
    // upsertLastResult 刻意不碰 consecutive_fail 与 last_checked_ts。
    upsertLastResult(env, row).catch(() => {}),
  ]);
  return { ok: v.ok, reason: v.reason };
}

/* ────────────────────────────── 路由 ────────────────────────────── */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 接口统一走 /api/<name>；静态资源占根路径，两者互不干扰。
    const m = url.pathname.match(/^\/api\/([a-zA-Z_]+)\/?$/);
    const api = m ? m[1] : "";
    const pretty = url.searchParams.get("pretty") === "1";

    /* ── 库结构自举：不等任何人跑命令 ──────────────────────────────────
       放在**所有分支之前**，包括 /api/health —— 因为「库没建表」是最常见的
       首次部署故障，而自检恰恰是最该在这种时候修好问题、而不是只报告问题的地方。

       为什么必须在运行时做：建表原先只发生在 `npm run deploy` 里的
       `scripts/setup-d1.mjs`。但凡部署方式不是「本地跑那条命令」（Cloudflare
       控制台连 GitHub 自动构建、CI、Dashboard 里改代码），建表就被跳过了 ——
       Worker 部署成功、页面能打开，而每个接口都回 `no such table: meta`。
       部署路径有好几条，只有 Worker 自己补能覆盖全部。

       幂等且只跑一次：isolate 内用 Promise 缓存，库侧用 meta.schema_v 版本号。
       正常状态下每个 isolate 只多一次单行 D1 读。 */
    let schemaState;
    try {
      schemaState = { ok: true, ...(await ensureSchema(env)) };
    } catch (e) {
      schemaState = { ok: false, error: String((e && e.message) || e) };
    }

    // 部署自检必须**先于**设置加载与认证闸门：库没建表时 loadSettings 会先抛异常，
    // 那时任何分支都到不了，自检也就失去意义。它只读 sqlite_master，不碰业务表。
    if (api === "health") {
      return await buildHealth(env, env.ADMIN_PASSWORD, pretty, schemaState);
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
    // ⚠️ 这一步在 try 之外，必须自己兜住：D1 没建表 / 绑定没生效时它会第一个抛，
    //    而异常一旦逃出 fetch 处理器，Cloudflare 只回一个空体 500 ——
    //    浏览器里看到的就是 `Failed to load resource: 500 ()`，前端拿不到任何文案，
    //    用户完全无从判断是"库没建"还是"代码有 bug"。所以在这里就地转成可读 JSON。
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
    // 密码**只认环境变量** ADMIN_PASSWORD（wrangler secret / Dashboard Variables）。
    // 不做后台可改密码：那样就得在 D1 里存哈希、还要处理"改了密码如何作废旧会话"，
    // 而密码本就属于部署期配置，放环境变量更简单也更容易审计。
    const pwdConfigured = Boolean(env.ADMIN_PASSWORD);

    let authed = false;
    if (pwdConfigured) {
      const token = getSessionToken(request.headers.get("cookie"));
      if (token) {
        authed = Boolean(
          await verifySession(
            token,
            await sessionSecret(env, rawSettings),
            sessionEpoch(rawSettings)
          )
        );
      }
    }

    env = await effectiveEnv(env, rawSettings);

    // 公开接口：前台只读展示 + 登录/登出。其余（含所有写接口）都要求已登录。
    const PUBLIC_APIS = new Set(["overview", "site", "login", "logout"]);

    /* ── 认证闸门：**fail-closed** ────────────────────────────────────
       没配 ADMIN_PASSWORD 时后台**一律不提供服务**，而不是"不启用认证"。
       早先的写法是"未配置就 authed = true"—— 后果是任何猜到 /admin 的人都能
       改配置、读到告警 Webhook 与 Globalping Token，一个 URL 就是全部权限，
       而页面上只是顶部闪一条 5 秒的提示，很容易被忽略。

       现在的行为：/admin 这个 HTML 照常能打开（静态资源由 Assets 直接返回，
       不经 Worker，拦不住也没必要拦 —— 页面里只有空壳，没有任何数据），
       但它拿不到任何数据，前端会停在"未设置密码"的说明页。

       用 403 + need_setup 而不是 401：此时弹登录框毫无意义（密码未配置，
       输什么都进不去），前端据此直接切到说明页，而不是让用户白试一遍密码。 */
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

    // 跨站写请求一律拒 —— 放在 **认证之后**：先回答"你有没有权限"（401 / 403），
    // 再回答"这个请求从哪来"。反过来的话，明明是没登录，却收到"跨站请求被拒绝"，
    // 排查起来会被带偏。也放在下面的 bumpConfigVersion **之前**，避免无谓的 D1 写。
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOriginOk(request, url)) {
      return json(
        { ok: false, error: "跨站请求被拒绝（同源校验失败）" },
        403,
        "no-store",
        pretty
      );
    }

    // 只有"真会改配置"的写接口才递增配置版本。
    //
    // 原先是「任何非 GET 都 bump」，于是：
    //   · 登录失败一次 → 递增一次 → 全机房 overview/site 缓存全部作废（key 里带版本号），
    //     谁能拿到一个后台地址，就能用错误密码把缓存无限打穿，同时白耗一次 D1 写；
    //   · 拼错接口名、跨站被拒、方法不允许……全部照样 bump。
    // 更根本的是"配置版本"被当成了"数据新鲜度"的开关：cron 每分钟写检查记录，
    // 若也跟着 bump，缓存条目寿命只剩一分钟、永远命中不了（见 scheduled 里的说明）。
    // 数据新鲜度交给 TTL（READ_CACHE 的 s-maxage），配置变更才用版本号。
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
        // 未配密码 → 说清原因就收工。**不要**落到下面的"密码错误"分支：
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

        // 兜底：走到这里说明 pwdConfigured 为真（上面已拦下未配置的情况），
        // 仍保留 `expected.length > 0` —— 空密码永不匹配，避免任何意外路径放行空串。
        const expected = env.ADMIN_PASSWORD || "";
        const pass = expected.length > 0 && constantTimeEqual(input, expected);

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
        /**
         * 「登出并作废所有会话」。
         *
         * 会话是无状态签名 token，服务端不留表 —— 吊销只能靠"让旧签名验不过"。
         * 这里有两件事，**都要做**：
         *   ① 递增 session_epoch（写进 token 载荷）—— 与密钥来源无关，永远有效；
         *   ② 顺手轮换 D1 里的 session_secret —— 仅在未配 ADMIN_SECRET 时才有意义，
         *      配了的话 sessionSecret() 根本不读这一项。
         *
         * 为什么不能只做 ②：`ADMIN_SECRET` 存在时 sessionSecret() 直接返回环境变量，
         * 轮换 D1 那份对验签毫无影响 —— 于是这个按钮"提示成功、别的设备照旧能用"。
         * 这正是上一轮 P0-7 记的问题，也是引入 ① 的原因。
         */
        let revoked = false;
        // ⚠️ 「登出所有设备」要求**已登录**。
        //    /api/logout 必须留在公开接口里（清自己的 cookie 不需要权限），但"吊销全部会话"
        //    是个有副作用的操作：不加这道判断，任何能构造同源 POST 的人都能反复把管理员
        //    的所有设备踢下线 —— 一个按需触发的拒绝服务。
        //    未登录时只清 cookie，revoked 如实返回 false。
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
        // ⚠️ days 必须钳制（这是公开接口，不需要登录）。
        //    改之前它直接 `Number(...)` 就用了，实测放大效应：
        //      days=30    →  1.7 KB / 1.7s
        //      days=36500 →  1.13 MB / 4.6s（30 万次迭代的日期轴 + 全量扫描）
        //    更糟的是缓存 key 里带 days —— 每个不同的值都是**独立的缓存条目**，
        //    等于给了任何人一个「用任意 days 灌满边缘缓存 + 拉高 D1 扫描量」的入口。
        //    上限 90 与 /api/site 的 days 一致（前台 30 天色条只用得到 30 天）。
        const days = queryInt(url.searchParams.get("days"), 30, 1, 90);
        // 缓存 key 带上配置版本：后台一改配置版本就 +1，所有机房的旧 key 立即不再命中
        const ver = await configVersion(env);
        const keyUrl = `${url.origin}/api/overview?days=${days}&pretty=${pretty ? 1 : 0}&v=${ver}`;
        return await withEdgeCache(request, ctx, 30, async () => {
          const d = await db(env);
          const since30 = new Date(Date.now() - days * 86400000).toISOString();
          const since24 = new Date(Date.now() - 86400000).toISOString();

          const [siteRows, dayRows, h24, u24, failRows] = await Promise.all([
            // ⚠️ 刻意**不用**窗口函数取"每个站点的最新一条"（那是对 checks 全表分区排序）。
            //    最后一行的结果快照由落库路径同步写进 state（见 STATE_UPSERT），
            //    这里只是主键 LEFT JOIN —— 代价与历史数据量无关。
            d
              .prepare(
                `SELECT s.id, s.name, s.url, s.group_name,
                        s.fail_threshold, s.expect_codes, s.hide_url, s.interval_min,
                        COALESCE(st.consecutive_fail, 0) AS consecutive_fail,
                        st.last_ok, st.last_status, st.last_ttfb_ms AS last_ttfb,
                        st.last_source, st.last_probe, st.last_ts, st.last_error,
                        ss.authorized AS ssl_authorized, ss.protocol AS ssl_protocol,
                        ss.issuer AS ssl_issuer, ss.expires_at AS ssl_expires_at,
                        ${sslDaysLeftSql("ss.")} AS ssl_days_left,
                        ss.checked_ts AS ssl_checked_ts,
                        ss.error AS ssl_error
                 FROM sites s
                 LEFT JOIN state st ON st.site = s.id
                 LEFT JOIN ssl ss ON ss.site = s.id
                 -- 分类顺序由 categories.sort 决定，而不是 group_name 的字面排序。
                 -- 否则"生产环境"会被排到"测试环境"后面（中文码点顺序），与直觉相反。
                LEFT JOIN categories cat
                       ON cat.name = COALESCE(NULLIF(TRIM(s.group_name), ''), ?)
                 WHERE s.enabled = 1
                 ORDER BY COALESCE(cat.sort, 100000), s.group_name, s.sort, s.id`
              )
              .bind(UNGROUPED)
              .all(),
            d
              .prepare(
                `SELECT site, date(ts, '${dayMod(env)}') AS d,
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
            // 失败明细的时间戳（30 天、全站点）—— 判断"某天是否真的连续故障"。
            // 走 idx_checks_ok_ts_site，读失败行而非全部检查；正常情况只有个位数。
            d
              .prepare(
                `SELECT site, date(ts, '${dayMod(env)}') AS d, ts
                 FROM checks WHERE ts > ? AND ok = 0
                 ORDER BY site, ts`
              )
              .bind(since30)
              .all(),
          ]);

          // 30 天日期轴。最左是今天，最右是最早；"今天"按 utc_offset_min 起算，
          // 必须与上面 SQL 的 date(ts, dayMod) 用同一个偏移，否则会因跨 UTC 日而错位。
          const axis = [];
          for (let i = 0; i < days; i++) {
            const t = new Date(Date.now() - i * 86400000 + dayOffsetMs(env));
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

          // 失败行按站点归堆（SQL 已按 site, ts 排好，故站点内 ts 仍是有序的）
          const failBySite = {};
          for (const r of failRows.results || []) (failBySite[r.site] = failBySite[r.site] || []).push(r);

          const groups = {};
          const seen = new Set();
          for (const s of siteRows.results || []) {
            const map = bySite[s.id] || {};
            // 色条颜色与「故障记录」同一口径：当天出现「连续失败 ≥ fail_threshold」
            // 的段才标红（fault）；只有零星抖动的天标黄（blip）。
            const runMap = maxFailRunPerDay(failBySite[s.id], s.interval_min);
            const thr = Number(s.fail_threshold || 3);
            const bars = axis.map((dkey) => {
              const c = map[dkey];
              if (!c || !c.n) return { d: dkey, st: "none" };
              if (c.ok >= c.n) return { d: dkey, st: "up" };
              return { d: dkey, st: Number(runMap[dkey] || 0) >= thr ? "fault" : "blip" };
            });

            // 三态判定：up / down / degraded（规则见 stateOf）
            const { state, degrade_reason: degradeReason, ssl } = stateOf(s, env);

            const g = s.group_name || UNGROUPED;
            (groups[g] = groups[g] || []).push({
              id: s.id,
              name: s.name,
              // ⚠️ 隐藏地址的站点**根本不下发 url**，而不是"下发了但前端不显示"：
              //    这是公开接口（无需登录，还被边缘缓存 30s），
              //    只在前端藏起来等于没藏 —— 右键查看源码、或直接请求 /api/overview
              //    就能拿到地址。hide_url 单独回传，让前端能区分
              //    「站点刻意隐藏地址」与「url 意外为空（那是 bug）」。
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
                default_theme: rawSettings.default_theme || defOf("default_theme"),
                site_title: rawSettings.site_title || defOf("site_title"),
                // 降级阈值必须回显给前台页脚：页脚文案要按实际配置写，
                // 否则后台把 ssl_warn_days 改成别的值后，页面还在说 "≤14 天"。
                ssl_warn_days: Number(env.SSL_WARN_DAYS),
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

        const hoursFor = queryInt(url.searchParams.get("hours"), 24, 1, 720);
        // 色条天数（前台只用得到 30）。与 hoursFor 一样先在缓存 key 之外算好，
        // 避免"key 里的值"与"实际查询用的值"两处各算一遍后分叉。
        const daysFor = queryInt(url.searchParams.get("days"), 30, 1, 90);
        // 「最近检查」条数：后台设置 recent_limit（默认 20），?recent= 可临时覆盖
        const recentN = clampInt(
          url.searchParams.get("recent") || env.RECENT_LIMIT || defOf("recent_limit"),
          5,
          200,
          Number(defOf("recent_limit"))
        );
        // 「故障记录」显示条数：纯展示上限，后台可改（默认 10）
        const incidentN = clampInt(
          env.INCIDENT_LIMIT || defOf("incident_limit"),
          1,
          100,
          Number(defOf("incident_limit"))
        );
        const verS = await configVersion(env);
        // ⚠️ hours / days / recent / incident 都必须进缓存 key：它们决定**返回体的内容与长度**，
        //    不进 key 的话先请求 ?recent=5（或 ?days=7）会把默认响应的缓存污染成 5 条 / 7 天（或反之）。
        const keyUrl = `${url.origin}/api/site?id=${encodeURIComponent(
          id
        )}&hours=${hoursFor}&days=${daysFor}&recent=${recentN}&incident=${incidentN}&pretty=${
          pretty ? 1 : 0
        }&v=${verS}`;

        return await withEdgeCache(request, ctx, 30, async () => {
          const d = await db(env);
          // 复用上面那份（与缓存 key 同源），不再各自重算
          const hours = hoursFor;
          const days = daysFor;
          const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
          const sinceD = new Date(Date.now() - days * 86400000).toISOString();
          const bkt = bucketFor(hours);

          const [meta, agg, seriesRows, recentRows, changeRows, dayRows, failRows] =
            await Promise.all([
              // ① 配置 + 状态 + 最近一次 + SSL
              //
              // ⚠️ 「最后一次结果」只从 `state` 读，**不再**去 checks 里另取一条。
              //    原先这里有一段 `WITH last AS (SELECT ... FROM checks ORDER BY ts DESC LIMIT 1)`，
              //    与首页读的 state.last_* 是两份数据。正常情况下它们一致，但
              //    「insertChecks 成功、bumpState 失败」（A1 那类）/「明细被保留策略删掉」
              //    / 「手动测试只写了一半」时，同一站点会在首页显示"正常 · 2 分钟前"、
              //    在详情页显示"从未检查"。监控工具里两个页面说两套话，用户只会不再相信任何一个。
              //    代价上也没必要：state 是主键查询，而那段 CTE 每次都要在 (site, ts) 上倒序取行。
              d
                .prepare(
                  `SELECT s.id, s.name, s.url, s.group_name,
                          s.fail_threshold, s.interval_min, s.expect_codes,
                          s.hide_url, s.enabled, s.sort,
                          COALESCE(st.consecutive_fail, 0) AS consecutive_fail,
                          st.last_checked_ts,
                          st.last_ok, st.last_status,
                          st.last_ttfb_ms AS last_ttfb, st.last_total_ms AS last_total,
                          st.last_source, st.last_probe, st.last_ts, st.last_error,
                          ss.authorized AS ssl_authorized, ss.protocol AS ssl_protocol,
                          ss.issuer AS ssl_issuer, ss.subject AS ssl_subject,
                          ss.key_type AS ssl_key_type, ss.expires_at AS ssl_expires_at,
                          ${sslDaysLeftSql("ss.")} AS ssl_days_left,
                          ss.checked_ts AS ssl_checked_ts,
                          ss.error AS ssl_error
                   FROM sites s
                   LEFT JOIN state st ON st.site = s.id
                   LEFT JOIN ssl ss ON ss.site = s.id
                   WHERE s.id = ?1`
                )
                .bind(id)
                .first(),
              // ② 窗口聚合
              //
              // ⚠️ 只要前端真正显示的那几个数：次数 / 成功数 / 成功请求的平均延迟。
              //    原先还带了 MIN/MAX，但页面上的"最高"是趋势图**某一点**里的
              //    max（按桶聚合出来的），不是窗口极值 —— 窗口 mn/mx 从没被读过。
              d
                .prepare(
                  `SELECT COUNT(*) AS n, SUM(ok) AS okl,
                          CAST(AVG(CASE WHEN ok=1 THEN ttfb_ms END) AS INTEGER) AS av
                   FROM checks WHERE site = ?1 AND ts > ?2`
                )
                .bind(id, since)
                .first(),
              // ③ 延迟时间序列（按桶聚合，桶宽随窗口自适应）
              d
                .prepare(
                  `SELECT CAST(strftime('%s', substr(ts,1,19)) / ?2 AS INTEGER) AS b,
                          COUNT(*) AS n, SUM(ok) AS okl,
                          CAST(AVG(CASE WHEN ok=1 THEN ttfb_ms END) AS INTEGER) AS av,
                          MAX(CASE WHEN ok=1 THEN ttfb_ms END) AS mx
                   FROM checks WHERE site = ?1 AND ts > ?3
                   GROUP BY b ORDER BY b`
                )
                .bind(id, bkt.sec, since)
                .all(),
              // ④ 最近 N 条原始检查
              d
                .prepare(
                  `SELECT ts, ok, status, ttfb_ms, total_ms, source, probe, error
                   FROM checks WHERE site = ?1 ORDER BY ts DESC LIMIT ?2`
                )
                .bind(id, recentN)
                .all(),
              // ⑤ 状态变化点 —— 只在 ok 翻转处返回，结果集极小，
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
              // ⑥ 按天聚合。偏移必须取 utc_offset_min，与首页色条口径一致
              d
                .prepare(
                  `SELECT date(ts, '${dayMod(env)}') AS d, COUNT(*) AS n, SUM(ok) AS ok
                   FROM checks WHERE site = ?1 AND ts > ?2
                   GROUP BY d`
                )
                .bind(id, sinceD)
                .all(),
              // ⑦ 失败明细的**时间戳**（30 天窗口）—— 只为判断「某天有没有真的连续故障」。
              //    走 idx_checks_ok_ts_site，读的是失败行而不是全部检查。
              d
                .prepare(
                  `SELECT date(ts, '${dayMod(env)}') AS d, ts
                   FROM checks WHERE site = ?1 AND ts > ?2 AND ok = 0
                   ORDER BY ts`
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
                // 用时长估算段内的失败次数，与告警口径（连续 N 次失败）对齐。
                // start = 首个失败点、end = 其后第一个成功点，所以
                //   duration ≈ 失败次数 × 间隔
                // ⚠️ 不要再 +1：那会把「1 次失败」估成 2 次，使阈值判定整体少一次，
                //    连单次抖动都会被当成故障事件（与告警不一致）。
                checks_est: Math.max(1, Math.round(duration_s / (intervalMin * 60))),
              };
            })
            // 未达 fail_threshold 的单次抖动不算故障事件（与告警判定一致）
            .filter((e) => e.ongoing || e.checks_est >= failThreshold)
            // 上面的遍历是按时间正序，这里翻成最新在前，再按设置只留最近 N 条
            .reverse()
            .slice(0, incidentN);

          // 30 天色条（最左最新 → 最右最早，与首页一致）
          // 颜色语义与「故障记录」一致：只有出现「连续失败 ≥ fail_threshold」的段才算
          // 真故障（红，fault）；只有零星抖动的天是黄（blip），不再一律涂红。
          const runMap = maxFailRunPerDay(failRows.results, intervalMin);
          const dayMap = {};
          for (const r of dayRows.results || []) dayMap[r.d] = r;
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
                  : Number(runMap[dkey] || 0) >= failThreshold
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
              // 只下发前端真正显示的三个数（KPI 卡「可用率」+ 图下方那行说明）。
              // since / bucket_sec / ok 从没被读过 —— 每多下发一个字段，缓存条目就大一分，
              // 而这份响应是要经过边缘缓存、按请求体量计费的。
              window: {
                hours,
                bucket_label: bkt.label,
                checks: n,
                failures: n - okl,
                uptime: n ? Math.round((okl / n) * 1000) / 10 : null,
              },
              // p95 / avg_total / min / max 已删：详情页只显示 latency.avg（「平均响应」卡片）。
              // 其中 p95 是这里最贵的查询（排序 + OFFSET + 子查询把同一次过滤重数一遍），
              // 30 天窗口下等于两次全表扫描，换一个前端从不显示的数字。
              latency: {
                avg: agg?.av ?? null,
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

      if (api === "sites") {
        const d = await db(env);
        if (request.method === "DELETE") {
          const id = url.searchParams.get("id");
          if (!id) return json({ ok: false, error: "缺少 id" }, 400);
          // 一张表一条，但**一次 batch**（原子）：见 db.deleteSite 的注释
          await deleteSite(env, id);
          return json({ ok: true, deleted: id });
        }
        if (request.method === "POST") {
          // `.catch()` 不能少：其它写端点（login / run / test）都有，唯独这里漏了 ——
          // body 不是合法 JSON 时 request.json() 直接抛，被最外层 catch 兜成 **500**。
          // 注意不能 `.catch(() => ({}))` —— 那会把"解析失败"伪装成"写了一个空对象"，
          // 返回 200 + upserted:1 的假成功。这里显式区分"解析失败"与"内容为空"。
          const parsed = await request.json().catch(() => null);
          if (!parsed || typeof parsed !== "object") {
            return json(
              { ok: false, error: "请求体不是合法的 JSON 对象" },
              400,
              "no-store",
              pretty
            );
          }
          // 站点排序：`{ action: "reorder", ids: [...] }` —— 只传顺序，按下标写 sort。
          // 与分类的 reorder 同一约定（那边传 names），区别是这里用 UPDATE 而非 upsert：
          // 分类是「目录」，可以凭空建出来；站点必须先存在 —— 传错的 id 应当静默无效，
          // 绝不能因为一次排序请求凭空造出一个只有 id 的空站点。
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
            `INSERT INTO sites (id,name,url,group_name,expect_codes,hide_url,fail_threshold,interval_min,enabled,sort,created_ts)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(id) DO UPDATE SET
                   name=excluded.name, url=excluded.url,
                   group_name=excluded.group_name,
                   expect_codes=excluded.expect_codes,
                   hide_url=excluded.hide_url,
                   fail_threshold=excluded.fail_threshold,
                   interval_min=excluded.interval_min, enabled=excluded.enabled,
                   sort=excluded.sort`
          );
          // 未指定 sort 的（= 新建站点）排到队尾：取一次全局最大值，循环里递增分配。
          // 一次查询而不是每条查一次 —— Free 计划子请求预算很紧，且 D1 也计入。
          // 编辑已有站点时前端会把原 sort 带回来，所以走不到这里，位置不会被打乱。
          // 循环里只 `.bind()` 不 `.run()`：每条 run 都是一次完整 D1 往返，
          // 导入 50 个站点就是 50 次。先全收集，再分组 batch。
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
            // sort 只在**同一分类内**比较，所以全局取最大值不影响别的分类。
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
                sortValue,
                new Date().toISOString()
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

      /* ── 后台聚合接口：一次请求拿全（站点 + 最近状态 + 分类 + 设置）──
         为什么要有：后台原先串行发 /session → /sites → /categories 三次请求，
         跨国链路上每次往返 ~0.2s，加上首屏 HTML 就是 4 个 RTT。合并成 1 次后
         首屏只需「HTML + /admin」两个请求，后台打开速度接近减半。 */
      if (api === "admin") {
        const payload = await buildAdminPayload(env);
        // 复用请求开头已读到的 rawSettings，不再多查一次 D1
        const settings = publicSettings(env, rawSettings);
        return json({ ok: true, ...payload, settings }, 200, "no-store", pretty);
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
        const collect = await collectGlobalping(env);
        const disp = await dispatch(env, picked);
        return json({ ok: true, collect, dispatch: disp });
      }

      // 即时测试：?api=test&[site=<id>|target=...]
      //   带 site=<id> 时，结果会**写入 checks**（这样「测」出来的点会出现在
      //   详情页折线与「最近检查」里）；不带则纯调试、不落库。
      //   ⚠️ 判定一律走 gpDecide，与自动探测同一条链。
      if (api === "test") {
        const m2 = requirePost(request, pretty);
        if (m2) return m2;
        const body = await request.json().catch(() => ({}));
        const siteId = String(body.site || "");
        const d = await db(env);
        const site = siteId
          ? await d.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first()
          : null;
        // 带 site 时一律用站点自身的 url —— 避免前端传错 target 导致
        // "存进 A 站点名下的其实是 B 的探测结果"
        const target = site?.url || String(body.target || "") || "https://www.baidu.com";

        // 位置筛选统一取全局设置，不再支持按请求覆盖 ——
        // 否则"测出来的结果"和"真实探测"可能用的不是同一个筛选，失去参考价值。
        const { id, source, quota } = await gpCreate(env, { url: target });
        let finished = null;
        for (let i = 0; i < 12 && !finished; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          const out = await gpCollect(env, { measurement_id: id });
          if (out.done) finished = out;
        }
        // 结果不可用（id 失效 / API 报错）→ 明确报错并**不落库**。
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
        // ⚠️ 判定必须走 gpDecide（多数表决），与自动探测**用同一条判定链**。
        //    早先这里写的是"取成功结果里最快的那条"，于是同一个站点
        //    「后台点『测』」与「等 cron」会得出不同结论（一个取中位数、一个取最快值），
        //    手动测试作为排查手段就此失去参考价值 —— 它测的应当就是生产那条链。
        //    纯调试（不带 site）时没有 expect_codes 可判，
        //    用一个宽容的虚拟站点，只要求 HTTP 层跑通。
        const dec = gpDecide(site || { expect_codes: "" }, results);
        if (dec.void) {
          // 无结论（平票 / 探针全部是平台自身故障 / 一条结果都没收到）→ 明确报错且**不落库**。
          // 与 broken 分支同一约定：把"没拿到结论"存成一条记录，等于凭空造出一个
          // up 或 down，直接污染可用率。
          const why =
            dec.why === "tie"
              ? "探针平票，无法形成多数派"
              : dec.why === "all-internal"
                ? "探针全部为 Globalping 平台自身故障"
                : "未收到任何探针结果";
          return json(
            { ok: false, kind: "globalping", source, quota, results, error: `${why}，本次不记录` },
            502,
            "no-store",
            pretty
          );
        }
        const best = dec.pick;
        // 票型标注规则与 collectGlobalping 一致：全票是常态（不标），分歧才标 `City/ASN (2/3)`
        const probeLabel = dec.unanimous
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
          ok: true, kind: "globalping", source, quota,
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
            "GET  /api/site?id=&hours=  详情页：窗口统计 + 序列 + 故障（公开）",
            "GET  /api/admin     后台：站点 + 状态 + 分类 + 证书 + 设置（需登录）",
            "POST /api/login  /api/logout",
            "GET/POST /api/settings",
            "GET/POST/DELETE /api/categories",
            "POST /api/sites（写）",
            "POST /api/run  手动跑一轮（调试）；POST /api/test  测单个后端（调试）",
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
    /**
     * 分段容错：每一段单独 try/catch，任何一段失败都**不中断**整轮。
     *
     * 原先整轮是一个大 try 都没有的线性流程 —— 于是 `bumpState` 里任何一次抛错
     * （A1 的绑定参数上限、D1 抖动、SQL 变更）都会让后面的 SSL 补检、缓存失效、
     * 过期清理、以及最后那行 console.log **全部不执行**：
     * 这一轮的检查已经写进 checks，但 state 一个没更新、告警一条没发、
     * 日志里连"出过错"这件事都看不到。监控系统自己静默失败，比它监控的站点挂了更糟。
     *
     * 现在每段失败都记进 `errors`，并照常走完剩余阶段、打出日志。
     */
    const errors = [];
    const stage = async (name, fn, fallback) => {
      try {
        return await fn();
      } catch (e) {
        errors.push({ stage: name, error: String((e && e.message) || e) });
        return fallback;
      }
    };

    // ⚠️ 必须**先**建表/补结构，再读设置。
    //    cron 是完全独立的入口：部署完之后若还没有任何人访问过站点，
    //    第一个跑到这里的可能就是定时任务 —— 此时库可能一张表都没有。
    //    失败不中断：后面的 stage 各自会记一次错，日志里能看出这一轮发生了什么。
    await stage("ensureSchema", () => ensureSchema(env), null);

    // ⚠️ 必须先合并后台设置再往下走。
    //    fetch 路径有 `env = await effectiveEnv(...)`，但 cron 是独立入口 ——
    //    漏掉这一步的话，后台里改的区域组 / 筛选 / 超时 / 告警 / 保留天数
    //    对定时探测**全部无效**（只会用到环境变量或代码默认值），
    //    而页面上却显示"已保存、立即生效"，属于静默失效。
    //    合并一次即可：下面所有函数都读 env。
    const settings = await stage("loadSettings", () => loadSettings(env), {});
    env = await effectiveEnv(env, settings);

    const sites = await stage("loadSites", () => loadSites(env), []);

    // 先收取上一轮 Globalping 的结果 —— 必须全量收，不受间隔影响：
    // 那些测量已经发出去了，不收就白花了额度。
    const collected = await stage("collectGlobalping", () => collectGlobalping(env), {
      collected: 0,
      rows: [],
      dropped: [],
      perSite: {},
      sslWritten: 0,
    });

    // 再按各站点的监测间隔，只对「已到期」的发起新一轮
    const due = await stage("dueSites", () => dueSites(env, sites), []);
    const disp = await stage("dispatch", () => dispatch(env, due), {
      used: 0,
      gpStarted: [],
      skipped: [],
    });
    const subreqBudget = Number((env && env.SUBREQ_BUDGET) || 30);

    // ⚠️ 这里**不再**递增 config_version。
    //
    // 曾经是「本轮写了任何数据就 bump 一次」，本意是让自动探测的结果立刻能被前台看到。
    // 但缓存 key 里带版本号 ⇒ 版本号一变，上一分钟的缓存条目全部作废：
    //   · 探测每分钟都在写，于是缓存**永远命中不了**（每个条目活不过 60 秒），
    //     只剩下"防并发"的作用，而首页每次回源要跑 5 条重查询；
    //   · 每分钟多一次 meta 写，一天 1440 次。
    // 数据新鲜度本来就有 TTL 兜着（READ_CACHE = s-maxage 30），最坏晚 30 秒 ——
    // 对一个"5 分钟才探一次"的监控来说完全够。版本号只留给**配置变更**用
    // （见 fetch 入口的 WRITE_APIS 白名单），那才是一天变几次、且必须立即全机房失效的东西。
    void collected; // 结果只用于日志汇总

    // 每天一次的过期明细清理（保留 N 天）。
    // 按「距上次成功清理的时间」判断而不是卡某个钟点 —— 后者只要那一轮 cron
    // 失败或漂移，当天就再也不清理了，checks 会一路膨胀。按时间间隔判断自带自愈。
    let cleaned = 0;
    if (shouldCleanup(settings)) {
      try {
        cleaned = await cleanupOldChecks(env, Number(env?.CHECK_KEEP_DAYS || 30));
        await saveSetting(env, "last_cleanup_ts", String(Date.now()));
      } catch (e) {
        cleaned = -1; // -1 表示失败，便于在日志里区分"删了 0 条"和"没跑成"
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
        skipped: disp.skipped,
        // 子请求：探测已用 / 本轮总预算。每站 1 次发起 + 1 次收取，站点多时贴预算
        // 属正常；真要超了会看到 skipped 非空（那说明该调小站点数或调大预算）。
        subreqUsed: disp.used,
        subreqBudget,
        persisted: collected.collected,
        // 本轮顺带更新的证书数量（与探测同一次请求，不额外消耗额度）
        ssl: collected.sslWritten || 0,
        cleaned, // 0 = 不在清理时点或无过期数据；-1 = 清理失败
        // 分段错误：正常恒为 []。非空说明本轮有阶段失败，但其余阶段仍照常跑完了。
        errors,
      })
    );
  },
};

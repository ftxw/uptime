/**
 * uptime —— 站点监测编排层
 *
 * 核心设计：
 *   ① 探测后端可插拔（cf / globalping / auto），按站点配置选择，可自动降级
 *   ② CF 探测走 Durable Object + locationHint（cron 也能锁区域）
 *   ③ Globalping 走「两阶段」：本轮发起测量、下一轮收取结果
 *      —— 因为 Workers 免费计划每次调用最多 50 个子请求，
 *         轮询等待几下就吃光了；两阶段把每站点压到 2 个子请求
 */

import {
  db,
  loadSettings,
  saveSetting,
  loadSites,
  insertChecks,
  bumpState,
  buildCategories,
  cleanupOldChecks,
  saveSsl,
  upsertLastResult,
  UNGROUPED,
} from "./db.js";
import { Prober } from "./prober.js";
import {
  REGION_GROUPS,
  judge,
  normalizeUrl,
  zhError,
  gpCreate,
  gpCollect,
  gpSslCheck,
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
import { SETTING_META, SETTING_KEYS, defOf } from "./settings.js";
// 「谁在哪跑的」统一口径 —— 三个前端共用这一个格式化函数（原因见模块注释）
import { formatOrigin } from "./origin.js";

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
  const text = await res.text();
  const headers = {
    ...JSON_HEADERS,
    "Cache-Control": `public, s-maxage=${ttl}`,
  };
  // ⚠️ 用 await 而不是 ctx.waitUntil：PUT 是机房本地的同步操作，耗时可忽略；
  //    而异步 PUT 会让写入跨越请求边界（响应已返回、PUT 才落地），
  //    在 config_version 递增这类时序里留下难以复现的残影。
  //    顺带说明：缓存**失效**不依赖任何 append/delete 动作，
  //    全靠 key 里带 config_version（写操作一改版本号，旧 key 就再也不会被命中）。
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
    //    SSL 检测走 Globalping，**单站点最坏 14 个子请求**、耗时数秒 —— 若放在这里，
    //    每次打开后台、每次轮询都会触发，既拖慢加载也白白消耗额度。
    //    检测由 cron（每轮 SSL_PER_TICK 个）与用户手动点「刷新证书」负责。
    d.prepare("SELECT * FROM ssl").all(),
  ]);

  const lastMap = Object.fromEntries((lastsRes.results || []).map((r) => [r.site, r]));
  const sslMap = Object.fromEntries((sslRes.results || []).map((r) => [r.site, r]));
  const sites = (sitesRes.results || []).map((s) => {
    const ssl = sslMap[s.id] || null;
    const merged = {
      ...s,
      resolved_kind: resolveKind(s),
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
    ssl: sslMap,
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

/**
 * 每个站点用哪个探测后端。
 *
 * 后端是**站点级必选项**（后台表单只给 cf / globalping 两个选项，没有 auto），
 * 所以这里不需要任何"全局默认"参与决策。空值只可能来自早期数据 ——
 * 一律回落到 cf：免费、无外部依赖、不消耗 Globalping 额度。
 */
function resolveKind(site) {
  return site.probe_kind === "globalping" ? "globalping" : "cf";
}

/**
 * CF 探测区域组：**全局设置**（后台「设置 → 探测」或 env.CF_HINT）。
 *
 * 为什么不做成站点级：一个站点只会解析出唯一后端（见 resolveKind），
 * 所以站点级的「CF 区域组」与「Globalping 筛选」永远只有一个会生效，
 * 另一个是死配置 —— 放着只会让人误以为可以分别控制。
 */
function cfHintOf(env) {
  const h = env.CF_HINT || defOf("cf_hint");
  return REGION_GROUPS.includes(h) ? h : defOf("cf_hint");
}

/** Globalping 位置筛选：同样是全局设置。null 表示用 probe.js 的内置默认 */
function gpMagicOf(env) {
  return (env && env.GP_MAGIC) || null;
}

/**
 * 站点的来源标签（首页 / 详情页 / 后台共用，格式见 origin.js）。
 *
 * 有检查记录时用**最近一次实际跑的那台**（last_source/last_probe）——
 * 这样降级路径（Globalping 发起失败自动改走 CF 边缘）会如实显示成 `CF:…（降级）`，
 * 而不是照抄配置写成 GP。
 * 从未检查过的站点则用后端配置推一个（`GP:CN` / `CF:APAC`），
 * 免得首页那一行留一块空白 —— 那时"配置是哪个后端"就是唯一已知的事实。
 */
function originOf(site, lastSource, lastProbe, env) {
  const real = formatOrigin(lastSource, lastProbe);
  if (real) return real;
  const kind = resolveKind(site);
  return formatOrigin(
    kind === "globalping"
      ? `gp:${gpMagicOf(env) || defOf("gp_magic")}`
      : `cf:${cfHintOf(env)}`,
    null
  );
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

/** 会话签名密钥：优先生效环境变量，否则用 D1 里的随机值（首次访问时生成） */
/**
 * 按 key 做取值的类型/范围规范化。
 *
 * 为什么必须在写入侧拦：这些值会直接参与探测参数（超时、IP 版本、位置筛选）和降级判定。
 * 一个 timeout_ms = "abc" 会让 Number(...) 得到 NaN，进而使"响应时间 > 超时一半"恒假、
 * 或让所有请求立即超时 —— 表现为"整站全线故障"，极难联想到是某个设置项写坏了。
 */
function normalizeSetting(k, v) {
  const def = SETTING_META[k]?.def ?? "";
  const num = (min, max) =>
    String(clampInt(v === undefined || v === null || v === "" ? def : v, min, max, def));
  switch (k) {
    case "timeout_ms":
      return num(1000, 30000);
    case "ssl_per_tick":
      return num(0, 10);
    case "ssl_warn_days":
      return num(0, 90);
    case "subreq_budget":
      return num(1, 45);
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
    case "gp_limit":
      return num(1, 10);
    case "gp_ip_version":
      return v === "6" ? "6" : SETTING_META.gp_ip_version.def;
    case "default_theme":
      return ["auto", "light", "dark"].includes(v) ? v : SETTING_META.default_theme.def;
    case "alert_webhook":
      // 只放行 http(s)：避免 Worker 的 fetch 被引导到 file:// 或非 HTTP 协议
      return !v || validHttpUrl(v) ? v : "";
    case "site_title":
      return v.slice(0, 60);
    default:
      return v;
  }
}

async function sessionSecret(env, S) {
  // 环境变量优先：让"轮换密钥 = 作废所有会话"这件事在部署侧可控
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
 * 站点 id 会拼进 URL（/monitor?id=）也用作主键。
 * SQL 是参数化的，不存在注入风险；真正要拦的是**会拆掉 URL 结构**的字符
 * （/ ? # % 与控制字符、空白），其余（含中文）放行，避免把已有的中文 id 站点变成无法编辑。
 */
function validSiteId(id) {
  if (typeof id !== "string") return false;
  const s = id.trim();
  return s.length > 0 && s.length <= 64 && !/[\s/?#%<>\\"]|[\x00-\x1f]/.test(s);
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

async function sendAlerts(env, alerts) {
  const hook = env && env.ALERT_WEBHOOK;
  if (!hook || !alerts.length) return null;
  const lines = alerts.map((a) => {
    // ⚠️ `failCount` 的两个语义完全不同，不能套同一个模板：
    //    故障时 = 这次累计到的**失败**次数；
    //    恢复时 = 恢复**之前**连续失败的次数（bumpState 里 `failCount: before`）。
    //    旧文案统一写成"连续 N 次正常"，于是恢复通知会谎报成功次数
    //    （"连续 3 次正常"其实那 3 次全是失败）。
    const head =
      a.kind === "down"
        ? `[故障] ${a.site} — 连续 ${a.failCount} 次失败`
        : `[恢复] ${a.site} — 连续 ${a.failCount} 次失败后恢复`;
    return `${head}${a.info.status ? ` · 状态码 ${a.info.status}` : ""}${
      a.info.reason ? ` · ${a.info.reason}` : ""
    }`;
  });
  try {
    const r = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: lines.join("\n"),
        alerts: alerts.map((a) => ({ ...a, info: undefined })),
      }),
    });
    // 早先这里还会逐条 `UPDATE state SET last_alert_ts = ?`：
    //   ① 告警每条一次 D1 往返（N 次网络开销），而告警路径本就在时间敏感处；
    //   ② 那个字段**从来没有读者**（STATE_UPSERT 每次都会把它 COALESCE 成 null），
    //      纯属写了个寂寞。删掉既省往返也不损失任何可见行为。
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
  // ⚠️ 返回值结构必须与下面的完整分支保持一致（尤其是 alerts / dropped）——
  //    调用方会无条件读 collected.alerts.length，少了这个字段就会抛 TypeError，
  //    导致整轮 cron 在打完日志前失败。
  if (!pending || !pending.length) return { collected: 0, rows: [], alerts: [], dropped: [] };

  const sites = await loadSites(env);
  const byId = Object.fromEntries(sites.map((s) => [s.id, s]));
  const rows = [];
  const perSite = {};
  const doneIds = [];
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
      ttfb: best?.ttfb ?? 0,
      total: best?.total ?? 0,
      reason: v.reason,
      threshold: Number(site.fail_threshold || 3),
      source: p.source,
      probe: probeLabel,
    };
  }

  if (rows.length) await insertChecks(env, rows);
  // 一条 IN 清完所有已收取的 pending：单条 DELETE × N 会多出 N 次 D1 往返
  if (doneIds.length) {
    const ph = doneIds.map(() => "?").join(",");
    await d.prepare(`DELETE FROM pending WHERE site IN (${ph})`).bind(...doneIds).run();
  }
  const alerts = await bumpState(env, perSite);
  const alertResult = await sendAlerts(env, alerts);
  return { collected: rows.length, rows, alerts, alertResult, dropped };
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
    const lead = resolveKind(s) === "globalping" ? CRON_PERIOD_MS : 0;

    const dueAt = Math.max(0, ivMs - lead) - DUE_GRACE_MS;
    return now - new Date(last).getTime() >= dueAt;
  });
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
    (resolveKind(s) === "globalping" ? gpSites : cfSites).push(s);
  }

  const cfResult = {};
  if (cfSites.length) {
    // 按 hint 分组，一组一次 DO 调用
    const groups = {};
    for (const s of cfSites) {
      const h = cfHintOf(env);
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
      const h = cfHintOf(env);
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
      const src0 = hit.fallback ? `cf:fallback-${hit.hint}` : `cf:${hit.hint}`;
      rows.push({
        ts: new Date().toISOString(),
        site: s.id,
        source: src0,
        probe: null,
        ok: false,
        status: 0,
        ttfb_ms: 0,
        total_ms: 0,
        error: hit.error,
      });
      perSite[s.id] = {
        ok: false,
        status: 0,
        ttfb: 0,
        total: 0,
        reason: hit.error,
        threshold: Number(s.fail_threshold || 3),
        source: src0,
        probe: null,
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
      ttfb: r.ttfb ?? 0,
      total: r.total ?? 0,
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

/**
 * 刷新过期/缺失的 SSL 信息。
 *
 * ⚠️ 额度与子请求都要小心：gpSslCheck 是「发起 + 轮询」的同步写法，
 *    单站点最坏 14 个子请求（1 次发起 + 25s 窗口内每 2s 轮询一次），
 *    而 Workers 免费层每次调用上限 50。
 *    所以定时任务里每轮只处理 limit 个（默认 2 个），
 *    10 个站点大约半小时内轮完一遍 —— 对"证书每天查一次"完全够。
 */
async function refreshSslStale(env, sites, { force = false, maxAgeH = 24, limit = 2 } = {}) {
  if (!sites.length || limit <= 0) return [];
  const d = await db(env);

  // ⚠️ 必须**一次**把新鲜度取回来再筛选：cron 每分钟跑一轮，
  //    而真正过期的通常只有少数几个 —— 逐站点 SELECT 会用 N 次往返换 2 个结果。
  const { results } = await d.prepare("SELECT site, checked_ts FROM ssl").all();
  const checkedTs = new Map((results || []).map((r) => [r.site, r.checked_ts]));
  const cutoffMs = maxAgeH * 3600 * 1000;

  const stale = [];
  for (const s of sites) {
    const ts = checkedTs.get(s.id);
    const fresh = ts && Date.now() - new Date(ts).getTime() < cutoffMs;
    if (fresh && !force) continue;
    stale.push(s);
    if (stale.length >= limit) break;
  }
  if (!stale.length) return []; // 全都新鲜 → 本次只有上面那 1 次查询，零额度消耗

  const done = [];
  for (const s of stale) {
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
    // 密码**只认环境变量** ADMIN_PASSWORD（wrangler secret / Dashboard Variables）。
    // 不做后台可改密码：那样就得在 D1 里存哈希、还要处理"改了密码如何作废旧会话"，
    // 而密码本就属于部署期配置，放环境变量更简单也更容易审计。
    const pwdConfigured = Boolean(env.ADMIN_PASSWORD);

    let authed = false;
    if (pwdConfigured) {
      const token = getSessionToken(request.headers.get("cookie"));
      if (token) {
        authed = Boolean(await verifySession(token, await sessionSecret(env, rawSettings)));
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

    // 任何写操作：递增配置版本 —— overview / site 的缓存 key 里带版本号，
    // 它一变所有机房的旧 key 立刻失效（比只清本机房副本可靠，见 bumpConfigVersion 注释）。
    if (request.method !== "GET" && request.method !== "HEAD") {
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
        const bodyP = request.json().catch(() => ({}));
        const body = await bodyP;
        // 「登出并作废所有会话」：轮换 session_secret 使全部已签发 token 立即验签失败。
        // 会话是无状态签名 token，服务端不留其他状态 —— 所以这是唯一能真正吊销的手段。
        // 场景：怀疑 token 泄露、或改了 ADMIN_PASSWORD 想踢掉旧会话
        //      （只改密码**不会**让旧 token 失效，这是无状态会话的固有代价）。
        let revoked = false;
        if (body.all === true) {
          try {
            await saveSetting(env, "session_secret", randomHex(32));
            revoked = true;
          } catch {}
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

          for (const k of SETTING_KEYS) {
            if (!(k in body)) continue;
            const v = body[k];
            // token 传 __KEEP__ 或空 → 视为「不修改」，避免每次保存都把已配置的 token 清掉
            if (k === "globalping_token" && (v === "__KEEP__" || v === null || v === undefined)) {
              continue;
            }
            await saveSetting(env, k, normalizeSetting(k, String(v ?? "").trim()));
            saved.push(k);
          }

          if (body.clear_globalping_token) {
            await saveSetting(env, "globalping_token", "");
            saved.push("globalping_token:cleared");
          }

          // 密码不在这里改 —— 它只来自环境变量 ADMIN_PASSWORD，
          // 改密码 = 改 Cloudflare 上的变量/secret 后重新部署，不需要（也不该）走后台。
          await bumpConfigVersion(env);
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
        const rawDays = Number(url.searchParams.get("days"));
        const days = Number.isFinite(rawDays)
          ? Math.max(1, Math.min(Math.trunc(rawDays), 90))
          : 30;
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
                `SELECT s.id, s.name, s.url, s.group_name, s.probe_kind,
                        s.fail_threshold, s.expect_codes, s.keyword, s.interval_min,
                        COALESCE(st.consecutive_fail, 0) AS consecutive_fail,
                        st.last_ok, st.last_status, st.last_ttfb_ms AS last_ttfb,
                        st.last_source, st.last_probe, st.last_ts, st.last_error,
                        ss.authorized AS ssl_authorized, ss.protocol AS ssl_protocol,
                        ss.issuer AS ssl_issuer, ss.expires_at AS ssl_expires_at,
                        ss.days_left AS ssl_days_left, ss.checked_ts AS ssl_checked_ts,
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
              url: s.url,
              probe_kind: resolveKind(s),
              cf_hint: cfHintOf(env),
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

        const hoursFor = Math.max(1, Math.min(Number(url.searchParams.get("hours") || 24), 720));
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
        // ⚠️ recent / incident 必须进缓存 key：它们决定返回体的行数，
        //    不进 key 的话先请求 ?recent=5 会把默认条数的响应污染成 5 条（或反之）。
        const keyUrl = `${url.origin}/api/site?id=${encodeURIComponent(
          id
        )}&hours=${hoursFor}&recent=${recentN}&incident=${incidentN}&pretty=${
          pretty ? 1 : 0
        }&v=${verS}`;

        return await withEdgeCache(request, ctx, 30, async () => {
          const d = await db(env);
          const hours = Math.max(1, Math.min(Number(url.searchParams.get("hours") || 24), 720));
          const days = Math.max(1, Math.min(Number(url.searchParams.get("days") || 30), 90));
          const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
          const sinceD = new Date(Date.now() - days * 86400000).toISOString();
          const bkt = bucketFor(hours);

          const [meta, agg, p95, seriesRows, recentRows, changeRows, dayRows, failRows] =
            await Promise.all([
              // ① 配置 + 状态 + 最近一次 + SSL
              d
                .prepare(
                  `WITH last AS (
                     SELECT ok, status, ttfb_ms, total_ms, source, probe, ts, error
                     FROM checks WHERE site = ?1 ORDER BY ts DESC LIMIT 1
                   )
                   SELECT s.id, s.name, s.url, s.group_name, s.probe_kind,
                          s.fail_threshold, s.interval_min, s.expect_codes, s.keyword,
                          s.enabled, s.sort,
                          COALESCE(st.consecutive_fail, 0) AS consecutive_fail,
                          st.last_checked_ts,
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
              // ⑦ 按天聚合。偏移必须取 utc_offset_min，与首页色条口径一致
              d
                .prepare(
                  `SELECT date(ts, '${dayMod(env)}') AS d, COUNT(*) AS n, SUM(ok) AS ok
                   FROM checks WHERE site = ?1 AND ts > ?2
                   GROUP BY d`
                )
                .bind(id, sinceD)
                .all(),
              // ⑧ 失败明细的**时间戳**（30 天窗口）—— 只为判断「某天有没有真的连续故障」。
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
                url: meta.url,
                group_name: meta.group_name || UNGROUPED,
                probe_kind: resolveKind(meta),
                cf_hint: cfHintOf(env),
                gp_magic: gpMagicOf(env),
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
          await d.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
          await d.prepare("DELETE FROM ssl WHERE site = ?").bind(id).run();
          await d.prepare("DELETE FROM state WHERE site = ?").bind(id).run();
          await d.prepare("DELETE FROM pending WHERE site = ?").bind(id).run();
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
          const list = Array.isArray(parsed) ? parsed : [parsed];
          const warnings = [];
          let upserted = 0; // 真实写入条数 —— 不是 list.length（空 id/url 的会被跳过）
          const stmt = d.prepare(
            `INSERT INTO sites (id,name,url,group_name,expect_codes,keyword,probe_kind,fail_threshold,interval_min,enabled,sort,created_ts)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(id) DO UPDATE SET
                   name=excluded.name, url=excluded.url,
                   group_name=excluded.group_name,
                   expect_codes=excluded.expect_codes, keyword=excluded.keyword,
                   probe_kind=excluded.probe_kind, fail_threshold=excluded.fail_threshold,
                   interval_min=excluded.interval_min, enabled=excluded.enabled,
                   sort=excluded.sort`
          );
          for (const s of list) {
            if (!s.id || !s.url) continue;
            const id = String(s.id).trim();
            const url = normalizeUrl(String(s.url).trim());
            // ── 服务端校验：非法直接拒绝，不要静默写坏数据
            if (!validSiteId(id)) {
              return json(
                { ok: false, error: `站点 ID 非法（需 1–64 字符，且不含 / ? # % 与空白）：${String(s.id).slice(0, 40)}` },
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
            const kind =
              s.probe_kind === "globalping" ? "globalping" : s.probe_kind === "cf" ? "cf" : null;
            // Globalping 后端**不返回响应正文**，`gpCollect` 产出的结果里也没有
            // `keywordHit` 字段 —— 于是 judge() 的 `r.keywordHit === false` 永远不成立，
            // 关键字校验对 GP 站点是彻底的静默空转。存下来只会让人误以为它在生效，
            // 所以这里直接不落库，并回一条 warning 让前端提示用户。
            const keyword =
              kind === "globalping" || !s.keyword ? null : String(s.keyword).slice(0, 200);
            if (kind === "globalping" && s.keyword) {
              warnings.push(`站点 ${id}：Globalping 后端不返回正文，「正文关键字」已忽略`);
            }
            await stmt
              .bind(
                id,
                String(s.name ?? id).trim().slice(0, 120) || id,
                url,
                String(s.group_name ?? UNGROUPED).trim().slice(0, 64) || UNGROUPED,
                String(s.expect_codes ?? "").trim(),
                keyword,
                kind,
                // 阈值 1–20、间隔 1–1440 分钟（≤1 天）：防负数/超大值污染调度
                clampInt(s.fail_threshold, 1, 20, 3),
                clampInt(s.interval_min, 1, 1440, 5),
                s.enabled === false ? 0 : 1,
                clampInt(s.sort, 0, 100000, 0),
                new Date().toISOString()
              )
              .run();
            upserted++;
          }
          return json({
            ok: true,
            upserted,
            ...(warnings.length ? { warning: warnings.join("；") } : {}),
          });
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
        const persisted = await persistCf(env, picked, disp.cfResult);
        return json({ ok: true, collect, dispatch: disp, persisted });
      }

      // 单个后端的即时测试：?api=test&kind=cf|globalping&target=...&hint=|magic=
      // 单个后端的即时测试：?api=test&kind=cf|globalping&[site=<id>|target=...]
      //   带 site=<id> 时，结果会**写入 checks**（这样「测」出来的点会出现在
      //   详情页折线与「最近检查」里）；不带则纯调试、不落库。
      if (api === "test") {
        const m2 = requirePost(request, pretty);
        if (m2) return m2;
        const body = await request.json().catch(() => ({}));
        const kind = String(body.kind || "cf");
        const siteId = String(body.site || "");
        const d = await db(env);
        const site = siteId
          ? await d.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first()
          : null;
        // 带 site 时一律用站点自身的 url —— 避免前端传错 target 导致
        // "存进 A 站点名下的其实是 B 的探测结果"
        const target = site?.url || String(body.target || "") || "https://www.baidu.com";
        const timeoutMs = Number(env.TIMEOUT_MS || 8000);

        if (kind === "cf") {
          const hint = String(body.hint || "") || cfHintOf(env);
          const multi = String(body.targets || "");
          const list = multi
            ? multi.split(",").map((u) => u.trim()).filter(Boolean).map((u) => ({ url: u, keyword: null }))
            : [{ url: target, keyword: site?.keyword || String(body.keyword || "") || null }];
          const t0 = Date.now();
          const out = await probeViaCf(env, hint, list, timeoutMs);
          let persisted = null;
          if (site) {
            persisted = await persistManualTest(env, site, {
              source: `cf:${hint}`,
              probe: out.colo,
              result: out.results?.[0],
            });
          }
          return json({
            ok: true, kind: "cf", hint,
            count: list.length,
            // 与后台表格 / 前台同一口径的来源标签（见 origin.js）
            origin: formatOrigin(`cf:${hint}`, out.colo),
            egress: out.egress, wall: out.wall, roundTripMs: Date.now() - t0,
            results: out.results,
            persisted,
          });
        }

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
        // 与 collectGlobalping 同口径：取成功结果里最快的那条为代表
        const good = results.filter((r) => r.ok);
        const best = good.sort((a, b) => (a.ttfb || 1e9) - (b.ttfb || 1e9))[0] || results[0];
        // 多探测点（gp_limit>1）时用逗号连接 —— 落库与标签取自同一个值，
        // 免得"提示里显示的"和"checks 表里存的"对不上
        const probeLabel = good.map((r) => r.probe).join(",") || null;
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
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    // ⚠️ 必须先合并后台设置再往下走。
    //    fetch 路径有 `env = await effectiveEnv(...)`，但 cron 是独立入口 ——
    //    漏掉这一步的话，后台里改的区域组 / 筛选 / 超时 / 告警 / 保留天数
    //    对定时探测**全部无效**（只会用到环境变量或代码默认值），
    //    而页面上却显示"已保存、立即生效"，属于静默失效。
    //    合并一次即可：下面所有函数都读 env。
    const settings = await loadSettings(env);
    env = await effectiveEnv(env, settings);

    const sites = await loadSites(env);

    // 先收取上一轮 Globalping 的结果 —— 必须全量收，不受间隔影响：
    // 那些测量已经发出去了，不收就白花了额度。
    const collected = await collectGlobalping(env);

    // 再按各站点的监测间隔，只对「已到期」的发起新一轮
    const due = await dueSites(env, sites);
    const disp = await dispatch(env, due);
    const persisted = await persistCf(env, due, disp.cfResult);

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

/**
 * 探测后端（可插拔）
 *
 * 设计目标：同一个监测目标可以选不同的探测后端，且相互之间可自动降级。
 *
 *   kind = 'cf'         → Cloudflare Durable Object + locationHint（粗粒度区域组）
 *   kind = 'globalping' → Globalping 探针网络（可细到 city / asn / 家庭宽带）
 *   kind = 'auto'       → 配了 GLOBALPING_TOKEN 就走 globalping，否则回落 cf
 *
 * ⚠️ CF 侧位置能力的实测边界（2026-09-22 验证，11 个区域组全部命中且可复现）：
 *   locationHint 只接受粗粒度区域组，APAC 能得到的是：
 *     apac      → HKG（中国香港）
 *     apac-se   → HKG
 *     apac-ne   → ICN（首尔）
 *   东京 / 新加坡 拿不到 —— 想要更细只能用 Placement Hints(`region="aws:ap-northeast-1"`)，
 *   但官方明确 Placement 只对 fetch handler 生效，对 scheduled(cron) 无效。
 */

import { defOf } from "./settings.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** locationHint 合法值（官方 region group） */
export const REGION_GROUPS = [
  "wnam", "enam", "sam", "weur", "eeur",
  "apac", "apac-ne", "apac-se",
  "oc", "afr", "me",
];

export function normalizeUrl(u) {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/**
 * 判断是否是 IP 字面量。
 * `URL.hostname` 会剥掉 IPv6 的方括号，所以出现 `:` 就可以确定是 IPv6。
 */
function isIpAddress(hostname) {
  if (hostname.includes(":")) return true;
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

/** 把常见底层错误翻成中文（对齐参考项目的 UX） */
const ERR_ZH = [
  ["ENOTFOUND", "无法解析域名"],
  ["ECONNREFUSED", "连接被拒绝"],
  ["ETIMEDOUT", "连接超时"],
  ["ECONNRESET", "连接被重置"],
  ["certificate", "证书校验失败"],
  ["CERT_", "证书校验失败"],
  ["AbortError", "请求超时"],
  ["fetch failed", "请求失败"],
];

export function zhError(raw) {
  const s = String(raw || "");
  for (const [k, v] of ERR_ZH) {
    if (s.includes(k)) return v;
  }
  return s || "未知错误";
}

/** 单次直连探测（在 DO 里跑，出口即 DO 所在机房） */
async function probeDirect(url, timeoutMs, keyword) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => {
    try {
      ac.abort();
    } catch {}
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "*/*" },
      signal: ac.signal,
    });
    const ttfb = Date.now() - started;
    let keywordHit = null;
    let bytes = 0;

    // 与 UptimeFlare 同思路：只在真有关键字要校验时才读 body。
    // 读 body 会白费带宽与 CPU 时间，而 TTFB 才是监测关心的值。
    if (keyword) {
      try {
        const buf = await res.arrayBuffer();
        bytes = buf.byteLength;
        const text = new TextDecoder("utf-8").decode(buf);
        keywordHit = text.includes(keyword);
      } catch {
        keywordHit = false;
      }
    } else {
      // 不读正文，但要显式释放，避免连接悬着（见 UptimeFlare issue #166）
      try {
        await res.body?.cancel();
      } catch {}
    }

    clearTimeout(timer);
    return {
      url,
      ok: true,
      status: res.status,
      ttfb,
      total: Date.now() - started,
      bytes,
      keywordHit,
    };
  } catch (err) {
    clearTimeout(timer);
    const elapsed = Date.now() - started;
    return {
      url,
      ok: false,
      status: 0,
      error: zhError((err && err.name) || err),
      ttfb: elapsed,
      total: elapsed,
      bytes: 0,
    };
  }
}

/**
 * 批量探测
 * items 可以是字符串数组，也可以是 [{url, keyword}] —— 后者用于关键字校验
 *
 * ⚠️ 并发上限 5：Cloudflare Workers 单次调用最多 6 个并发出网连接
 *    （UptimeFlare 源码注释：Max concurrent connection is 6 limited by Cloudflare Workers）
 *    超过的部分不会并行，只会排队 —— 反而让 TTFB 失真。
 */
const CONCURRENCY = 5;

export async function runAllDirect(items, timeoutMs) {
  const list = items.map((it) =>
    typeof it === "string" ? { url: normalizeUrl(it), keyword: null } : it
  );
  const out = [];
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const batch = list.slice(i, i + CONCURRENCY);
    out.push(
      ...(await Promise.all(
        batch.map((it) => probeDirect(normalizeUrl(it.url), timeoutMs, it.keyword))
      ))
    );
  }
  return out;
}

/**
 * 判定一次探测是否算"正常"
 * 规则：状态码 ∈ expect_codes（为空则接受 200-399）；有关键字则必须命中
 *
 * 注意：这里只判断 up / down 两态。第三态 **degraded（降级）** 在 /api/overview 里
 * 结合 SSL 与响应时间实时算出 —— 因为 SSL 是每天一查的数据，不该塞进 5 分钟一次的检查行里。
 * 降级规则：证书无效 或 剩余 ≤ ssl_warn_days 天 或 响应时间 > 超时上限的一半。
 * （阈值本身是后台「设置 → 探测」里的「证书降级阈值」，这里是默认 14 天的口径说明。）
 */
export function judge(site, r) {
  if (!r || r.ok === false) return { ok: false, reason: r?.error || "请求失败" };
  const codes = String(site.expect_codes || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const okCode = codes.length
    ? codes.includes(r.status)
    : r.status >= 200 && r.status < 400;
  if (!okCode) return { ok: false, reason: `状态码 ${r.status} 不在期望集合` };
  if (site.keyword && r.keywordHit === false) {
    return { ok: false, reason: `正文未包含关键字 "${site.keyword}"` };
  }
  return { ok: true, reason: null };
}

/**
 * 探针端墙钟超时（整数秒）。
 *
 * ⚠️ 这是**给远端探针的规定**，不是"我们愿意等多久"。
 *    Globalping 的探测跑在第三方机器上，我们本地没有任何句柄能中断它
 *    —— 不像 CF 直连那条路可以用 AbortController 说掐就掐。
 *    所以 `timeout_ms`（CF 用）与这个值**互不相通，也不该互相折算**：
 *    把 8000ms 折成 8 秒传过来，只会让"本来第 9~14 秒才握得上手"的测量被提前判死，
 *    实测中国家宽链路的失败**恰好在 15001ms** 被平台切断，压到 8s 就是主动制造失败。
 *    反过来调大同样无用：抓到的失败是 `tls: null`（握手一个字节都没回来），
 *    等 15s 和等 30s 是同一个结果，只是白占调度窗口。
 *
 * 取值必须落在 5–30（API 硬约束，越界直接 422），所以在读取侧就钳死。
 */
function gpTimeoutSec(env) {
  const dflt = Number(defOf("gp_timeout_sec"));
  const n = Number((env && env.GP_TIMEOUT_SEC) || dflt);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(30, Math.max(5, Math.round(n)));
}

/**
 * Globalping：发起一次测量，返回 measurement id（不等待结果）
 * 真正的探测由 Globalping 的探针执行 —— 所以调度器在哪里完全不影响探测点位置。
 * ⚠️ 额度按「探测点个数」计费（实测 X-Request-Cost === limit），limit 越小越省。
 *    默认 3 是为了让「多数表决」成立，成本换准确率，可在后台改。
 */
export async function gpCreate(env, site) {
  const token = env && env.GLOBALPING_TOKEN;
  const u = new URL(normalizeUrl(site.url));
  // 位置筛选是**全局设置**（后台「设置 → 探测」）。
  // 不做成站点级的原因：一个站点只用一个后端，站点级的 CF 区域组/GP 筛选
  // 必然只有一个是活的，另一个是死配置。
  const magic = env.GP_MAGIC || defOf("gp_magic");
  const limit = Number(env.GP_LIMIT || defOf("gp_limit"));
  const timeoutSec = gpTimeoutSec(env);
  const protocol = u.protocol === "http:" ? "HTTP" : "HTTPS";
  const port = u.port ? Number(u.port) : protocol === "HTTP" ? 80 : 443;

  // ipVersion 只在 target 是域名时传 —— Globalping 只允许域名场景设置它（因为它控制 DNS 解析）
  const ipVersion = String((env && env.GP_IP_VERSION) ?? "4");
  const ipOpt = isIpAddress(u.hostname) || !ipVersion ? {} : { ipVersion: Number(ipVersion) };

  const res = await fetch("https://api.globalping.io/v1/measurements", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      type: "http",
      target: u.hostname, // ⚠️ 不能带 scheme
      locations: [{ magic }],
      limit,
      // 顶层字段，不是 measurementOptions 的子键（那里 additionalProperties:false，错位 422）
      timeout: timeoutSec,
      measurementOptions: {
        protocol,
        port,
        request: {
          method: "GET",
          // 保留原 URL 的路径与查询串 —— 否则 /health 这类检查会被测成首页
          path: u.pathname || "/",
          ...(u.search ? { query: u.search } : {}),
        },
        ...ipOpt,
      },
    }),
  });
  const data = await res.json();
  if (!data || !data.id) {
    throw new Error(
      "globalping create failed: " + JSON.stringify(data).slice(0, 200)
    );
  }
  return {
    id: data.id,
    source: `gp:${magic}`.slice(0, 80),
    quota: {
      limit: res.headers.get("x-ratelimit-limit"),
      remaining: res.headers.get("x-ratelimit-remaining"),
    },
  };
}

/**
 * 收取 Globalping 测量结果，转成统一结构。
 *
 * 返回契约（调用方**必须**按这三种分支处理，尤其是 broken）：
 *   { done: false }                       —— 还在跑，pending 留到下一轮
 *   { done: true, broken: true, error }   —— 结果不可用，调用方应**丢弃 pending 且不记检查记录**
 *   { done: true, results, status }       —— 正常结果
 *
 * broken 分支存在的原因：原来只判断 `status !== "finished" && !== "failed"` 就一律当成
 * "还在跑"。可测量 id 失效 / API 返回错误体时响应里**压根没有 status**，于是会永远返回
 * done:false → pending 行永不删除 → 而 dispatch 里 `if (pendingSet.has(s.id)) continue`
 * 会让该站点**永久不再被发起探测**，静默停摆且没有任何告警。
 */
/**
 * Globalping 单探针的测量状态 → 人能看懂的原因。
 *
 * 为什么不能直接透传 `result.status`：它只会给 `"failed"` / `"offline"` 这类单词，
 * 落进 `checks.error` 就是一条 **`failed`** —— 排查时完全分不清是
 * 「探针超时」还是「站点真的挂了」，而这两件事的处理方式正相反。
 *
 * 真正的原因在 `result.rawOutput` 里，实测抓到过两种截然不同的失败：
 *   `Request timed out during the TLS handshake.` —— DNS/TCP 都通，TLS 握手被概率性丢弃
 *   `read ECONNRESET`                            —— 连接已被建立后被对端重置
 * 所以这里做一次关键词翻译。**顺序有意义**：更具体的模式必须排在泛化的前面
 * （`timed out during the TLS handshake` 含 `timed out`）。
 */
const GP_RAW_ZH = [
  ["timed out during the TLS handshake", "TLS 握手超时（链路丢包）"],
  ["timed out during the TCP handshake", "TCP 握手超时"],
  ["read ECONNRESET", "连接被重置"],
  ["ECONNRESET", "连接被重置"],
  ["ECONNREFUSED", "连接被拒绝"],
  ["EHOSTUNREACH", "主机不可达"],
  ["ENETUNREACH", "网络不可达"],
  ["getaddrinfo", "域名解析失败"],
  ["certificate", "证书校验失败"],
  ["ETIMEDOUT", "连接超时"],
  ["timed out", "探针等待超时"],
];

export function gpResultReason(rr) {
  const s = String((rr && rr.status) || "");
  if (s === "finished") return null;
  const raw = String((rr && rr.rawOutput) || "").toLowerCase();
  for (const [k, v] of GP_RAW_ZH) {
    if (raw.includes(k.toLowerCase())) return v;
  }
  if (s === "offline") return "探针离线";
  if (s === "failed") return "探针未能在时限内完成测量";
  return s || "未知状态";
}

export async function gpCollect(env, pending) {
  const token = env && env.GLOBALPING_TOKEN;
  const res = await fetch(
    `https://api.globalping.io/v1/measurements/${pending.measurement_id}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} }
  );
  const d = await res.json();
  if (!d || typeof d.status !== "string") {
    return {
      done: true,
      broken: true,
      results: [],
      error: "响应缺少 status：" + JSON.stringify(d).slice(0, 120),
    };
  }
  if (d.status !== "finished" && d.status !== "failed") {
    return { done: false, results: [] };
  }
  const results = (d.results || []).map((r) => {
    const p = r.probe || {};
    const rr = r.result || {};
    const t = rr.timings || {};
    return {
      url: `https://${d.target || ""}/`,
      ok: rr.status === "finished",
      status: rr.statusCode || 0,
      ttfb: t.firstByte ?? 0,
      total: t.total ?? 0,
      bytes: 0,
      error: gpResultReason(rr),
      probe: `${p.city || "?"}/${p.asn || "?"}`,
      // 平台自己的归因：target = 目标站 / resolver = 解析 / internal = 平台自身故障。
      // 必须原样带出来 —— 表决时要靠它把"平台故障"从"站点故障"里摘出去。
      failureSource: rr.failureSource || null,
    };
  });
  return { done: true, results, status: d.status };
}

/**
 * 多探针多数表决 —— Globalping 结果的**唯一判定口径**。
 *
 * 为什么要表决，而不是像原来那样"挑一个最好的"：
 *   GP 把测量派给哪台探针由平台决定，且对同一 magic 有**首选项粘性** ——
 *   实测 3 轮里 Nanning/4837 三次都在，另外两席每轮都换。单点采样时，
 *   那一台机器所在链路的一次抖动会被 100% 记成「站点失败」。
 *   实测中国家宽筛选下单点失败率约 25%，配上 fail_threshold=3 就是
 *   每天 4~5 次误告警，而目标站点本身完全正常。
 *   多探针下失败是**不同步**的（同一次测量里实测出现过 2 成功 1 失败），
 *   所以表决能把这种瞬时抖动过滤掉。
 *
 * 三条必须说清的规则：
 *  ① `failureSource === "internal"` 的探针**不参与表决**：那是 Globalping 平台自己
 *     出问题，它压根没测到站点。拿它投票等于把"我们没拿到数据"谎报成"站点挂了"
 *     —— 与 gpCollect 的 broken 分支是同一条约定。
 *  ② **平票即作废**（调用方不得写检查记录）：没有多数派就没有结论。宁可这一轮
 *     没数据，也不能凭空造一个 up/down 出来；pending 已删，下一轮会自动重发。
 *  ③ 代表值取多数派内的**中位数** —— 多探针的意义就是去掉"最好"与"最坏"两个
 *     偶然值，中位数才是典型体验。取最快会让页面长期显得比实际更快。
 *
 * @returns {{void:true, why:string}} 无结论
 *        | {{void:false, ok:boolean, pick:object, reason:string?, ...}} 有结论
 */
export function gpDecide(site, results) {
  const all = Array.isArray(results) ? results : [];
  if (!all.length) return { void: true, why: "no-results" };

  const usable = all.filter((r) => r.failureSource !== "internal");
  const platformFaults = all.length - usable.length;
  if (!usable.length) return { void: true, why: "all-internal", platformFaults };

  // 每条探针各自跑 judge：这样「HTTP 层通但状态码不在期望集合」（如 500）
  // 也进入表决，而不是只看代表那条的状态码。
  const votes = usable.map((r) => ({ r, v: judge(site, r) }));
  const yes = votes.filter((x) => x.v.ok);
  const no = votes.filter((x) => !x.v.ok);
  const total = votes.length;

  if (yes.length === no.length) {
    return { void: true, why: "tie", platformFaults, okCount: yes.length, total };
  }

  const ok = yes.length > no.length;
  const majority = ok ? yes : no;
  const sorted = majority.slice().sort((a, b) => (a.r.ttfb || 0) - (b.r.ttfb || 0));
  const pick = sorted[Math.floor((sorted.length - 1) / 2)];

  return {
    void: false,
    ok,
    pick: pick.r,
    reason: pick.v.reason,
    okCount: yes.length,
    total,
    platformFaults,
    // 全票时不标注票型 —— 那是常态，标了只是噪音
    unanimous: yes.length === total || no.length === total,
  };
}

/* ─────────────────────────── SSL 检测 ─────────────────────────── */

/**
 * SSL 检测的两个时间常量。
 *
 * `GP_SSL_PROBE_TIMEOUT_SEC` 会作为**顶层** `timeout` 传给 Globalping —— 它是探针端的
 * 墙钟超时（整数秒，允许 5–30；省略时平台按测量参数自行推算、上限 30s）。
 * ⚠️ 它不在 `measurementOptions` 里，`measurementOptions.request` 只认
 *    host/path/query/method/headers（且 additionalProperties: false），
 *    所以**必须和 type/target/locations/limit 平级**，塞进 measurementOptions 会被 422 拒掉。
 *
 * 为什么显式压到 10s（而不是吃平台的 30s 默认值）：
 *   ① 官方要求调用方在客户端超时上再留 ≥10s 给探针↔API 通信与测量收尾。不压探针侧的话，
 *      最坏要等 30+10=40s 才敢判超时；而这段时间是本 Worker **同步轮询**掉的，每 2s 一次
 *      子请求，窗口每多 2s 就多一个子请求（SSL_PER_TICK 默认 2 个站点共用 subreq_budget 30）。
 *   ② 正常站点从国内机房探针做一次 TLS 握手 + GET 快得多 —— 实测北京探针打 baidu.com 是
 *      total 68ms / firstByte 16ms，绝大多数情况第一次轮询（2s）就拿到 finished。
 *      压到 10s 对正常站点没有任何影响；真超过 10s 的站点本就该判为证书检测失败。
 */
const GP_SSL_PROBE_TIMEOUT_SEC = 10;

/** 探针↔API 通信 + 测量收尾的余量。官方口径要求 ≥10s，这里给 15s。 */
const GP_SSL_FINALIZE_GRACE_MS = 15_000;

/**
 * 查一个站点的 SSL 证书。
 *
 * 为什么用 Globalping 而不是自己 fetch：
 *   Cloudflare Workers 的 `fetch()` **不暴露对端证书**，拿不到有效期/颁发者。
 *   而 Globalping 的 HTTP 测量结果里带完整 tls 对象：
 *     { authorized, protocol, cipherName, createdAt, expiresAt,
 *       issuer:{C,O,CN}, subject:{CN,alt}, keyType, keyBits }
 *
 * 低频调用：证书不会 5 分钟变一次，每站点每天查一次足够。
 * 这里用「发起 + 轮询」的同步写法（不像可用性检测走两阶段），
 * 因为它是每日一次的低频任务，多几个子请求无所谓，换来实现更简单。
 *
 * ⚠️ `maxSubreq` 是本站点**允许消耗的子请求上限**，由调用方按本轮剩余预算传入。
 *    同步轮询意味着这段开销是"不可中断地花出去"的 —— 不设上限时，
 *    2 个站点最坏就能吃掉 28 个子请求，与探测预算叠加后直接顶穿免费层的 50 上限，
 *    结果是**整轮 cron 报 Too many subrequests、当轮什么都不做**（静默失败）。
 *    返回值里的 `subreq` 是实际消耗，调用方据此继续扣减。
 */
export async function gpSslCheck(env, site, { maxSubreq = null } = {}) {
  const token = env && env.GLOBALPING_TOKEN;
  const u = new URL(normalizeUrl(site.url));
  if (u.protocol !== "https:") {
    return { error: "非 HTTPS 站点，跳过证书检测", subreq: 0 };
  }
  // ⚠️ 刻意**不用可用性探测的筛选**（GP_MAGIC）：
  // 可用性探测的筛选可能很窄（例如 CN+xian+eyeball-network），窄到没有探针；
  // 而 SSL 检测只需要任意一个能建立 TLS 的探针即可，用窄条件会让证书检测连带失败。
  // 所以这里只认自己的 GP_SSL_MAGIC（后台「SSL 检测筛选」下拉）。
  const magic = env.GP_SSL_MAGIC || defOf("gp_ssl_magic");
  const H = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  let subreq = 0;
  // 发起前先结算：一次都花不出去就别发，免得"发起成功但收不了"，反而留下一条空结果。
  if (maxSubreq !== null && subreq >= maxSubreq) {
    return { error: "本轮子请求预算不足，证书检测顺延到下一轮", subreq };
  }
  subreq++;

  const created = await (
    await fetch("https://api.globalping.io/v1/measurements", {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        type: "http",
        target: u.hostname,
        locations: [{ magic }],
        limit: 1,
        // 顶层字段，不是 measurementOptions 的子键（见 GP_SSL_PROBE_TIMEOUT_SEC 注释）
        timeout: GP_SSL_PROBE_TIMEOUT_SEC,
        measurementOptions: {
          protocol: "HTTPS",
          port: u.port ? Number(u.port) : 443,
          // 用 GET 而不是 HEAD：实测 HEAD 时 Globalping 返回的 tls 对象不完整
          // （缺 issuer / protocol），GET 才是完整的证书信息
          request: { method: "GET", path: u.pathname || "/" },
        },
      }),
    })
  ).json();

  if (!created || !created.id) {
    return {
      error: "globalping create failed: " + JSON.stringify(created).slice(0, 150),
      subreq,
    };
  }

  // 窗口 = 探针侧超时 + 收尾余量 = 25s。不再拍一个凭空的 25s，而是由两个可解释的量推出来：
  // 探针最多跑 GP_SSL_PROBE_TIMEOUT_SEC 秒，之后平台还要收尾，窗口必须比两者之和大，
  // 否则慢测量会在结果就绪前被判超时。
  // 健康站点实测第 1 次轮询（2s）就 finished —— 所以"最坏 14 个子请求"只在异常站点上发生。
  const deadline = Date.now() + GP_SSL_PROBE_TIMEOUT_SEC * 1000 + GP_SSL_FINALIZE_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    // 每次轮询前结算预算：花完了就停手并如实说明，别把额度偷偷花在预算之外。
    if (maxSubreq !== null && subreq >= maxSubreq) {
      return { error: "本轮子请求预算不足，证书检测顺延到下一轮", subreq };
    }
    subreq++;
    const d = await (
      await fetch(`https://api.globalping.io/v1/measurements/${created.id}`, { headers: H })
    ).json();
    // 响应体里没有 status（测量 id 失效、API 返回错误体）→ 立刻失败并带上原文，
    // 不要傻等到 deadline：那种情况下再怎么轮询都等不到 finished。
    if (!d || typeof d.status !== "string") {
      return { error: "globalping 查询失败：" + JSON.stringify(d).slice(0, 120), subreq };
    }
    if (d.status !== "finished" && d.status !== "failed") continue;

    const r0 = (d.results || [])[0] || {};
    const rr = r0.result || {};
    const tls = rr.tls;
    if (!tls) {
      return { error: `无 TLS 信息（探测状态 ${rr.status || d.status}）`, subreq };
    }
    const daysLeft = tls.expiresAt
      ? Math.floor((new Date(tls.expiresAt).getTime() - Date.now()) / 86400000)
      : null;
    return {
      authorized: tls.authorized ? 1 : 0,
      protocol: tls.protocol || null,
      issuer: [tls.issuer?.O, tls.issuer?.CN].filter(Boolean).join(" / ") || null,
      subject: tls.subject?.CN || null,
      key_type: tls.keyType ? `${tls.keyType} ${tls.keyBits || ""}`.trim() : null,
      expires_at: tls.expiresAt || null,
      days_left: daysLeft,
      probe: `${r0.probe?.city || "?"}/${r0.probe?.asn || "?"}`,
      subreq,
    };
  }
  return {
    error: `SSL 检测超时（探针 ${GP_SSL_PROBE_TIMEOUT_SEC}s + 收尾 ${
      GP_SSL_FINALIZE_GRACE_MS / 1000
    }s 内未返回结果）`,
    subreq,
  };
}


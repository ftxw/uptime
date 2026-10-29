/**
 * 探测层：全部经 Globalping 中国探针执行。
 *
 * 不用 CF 边缘探测：它测的是「Cloudflare 机房 -> 站点」，与大陆用户的访问路径
 * 不是一回事，用它判断国内站点快慢方向就错了。
 *
 * 一次 http 测量同时带回延迟（timings.total）、状态码、证书（tls），三项共用一份额度。
 */

import { defOf, validMagic, gpLimitNum } from "./settings.js";

export function normalizeUrl(u) {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/** 判断 IP 字面量。URL.hostname 会剥掉 IPv6 方括号，故含 `:` 即为 IPv6。 */
function isIpAddress(hostname) {
  if (hostname.includes(":")) return true;
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

/**
 * 判定一次探测是否「正常」：状态码 ∈ expect_codes（空则接受 200-399）。
 * 只判 up/down；degraded 由 index.js 的 stateOf 结合证书与慢阈值算出。
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
  return { ok: true, reason: null };
}

/**
 * 探针端墙钟超时（秒，5–30）。这是给远端探针的规定，不是我们愿意等多久：
 * 中国家宽链路的失败实测恰在 15001ms 被平台切断，压到 8s 等于主动造失败；
 * 调大也没用（失败时 tls 为 null，握手一个字节都没回来）。
 */
function gpTimeoutSec(env) {
  const dflt = Number(defOf("gp_timeout_sec"));
  const n = Number((env && env.GP_TIMEOUT_SEC) || dflt);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(30, Math.max(5, Math.round(n)));
}

/**
 * Retry-After 可能是秒数也可能是 HTTP 日期。统一换成毫秒，并夹到 [30s, 1h]：
 * 平台偶尔回一个很小的值，照着它重试等于继续撞墙；回一个超大值又会让站点停摆一整天。
 */
function retryAfterMs(raw) {
  const s = String(raw ?? "").trim();
  let ms = NaN;
  if (/^\d+$/.test(s)) ms = Number(s) * 1000;
  else if (s) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) ms = t - Date.now();
  }
  if (!Number.isFinite(ms)) ms = 60_000;
  return Math.min(3_600_000, Math.max(30_000, Math.round(ms)));
}

/**
 * 发起一次测量，返回 measurement id（不等待结果）。
 * 额度按探测点数计费（X-Request-Cost === limit），默认 3 是为了有多张票互相兜底。
 */
export async function gpCreate(env, site) {
  const token = env && env.GLOBALPING_TOKEN;
  const u = new URL(normalizeUrl(site.url));
  // 位置筛选是全局设置。必须再做一次校验：环境变量绕过后台写入侧的规范化，
  // 写错同样会把所有 GP 站点一次打死。
  const magic = validMagic(env.GP_MAGIC) || defOf("gp_magic");
  const limit = gpLimitNum(env.GP_LIMIT);
  const timeoutSec = gpTimeoutSec(env);
  const protocol = u.protocol === "http:" ? "HTTP" : "HTTPS";
  const port = u.port ? Number(u.port) : protocol === "HTTP" ? 80 : 443;

  // ipVersion 只对域名生效（它控制 DNS 解析）。归一化成 4/6：环境变量写成 "ipv4"
  // 会得到 NaN → JSON null → 全部站点 422。
  const ipOpt = isIpAddress(u.hostname)
    ? {}
    : { ipVersion: String(env?.GP_IP_VERSION) === "6" ? 6 : 4 };

  const res = await fetch("https://api.globalping.io/v1/measurements", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      type: "http",
      target: u.hostname, // 不能带 scheme
      locations: [{ magic }],
      limit,
      // 顶层字段，放进 measurementOptions 会 422
      timeout: timeoutSec,
      measurementOptions: {
        protocol,
        port,
        request: {
          method: "GET",
          path: u.pathname || "/",
          ...(u.search ? { query: u.search } : {}),
        },
        ...ipOpt,
      },
    }),
  });
  const data = await res.json().catch(() => null);

  // 429 = 额度用尽。必须带 Retry-After 给调度层做退避，否则接下来每分钟都会
  // 再撞一次 429：日志被刷满、站点却一条记录都产不出来（看上去还是一片绿）。
  if (res.status === 429) {
    const ra = retryAfterMs(res.headers.get("retry-after"));
    const err = new Error(`Globalping 额度用尽（429），${Math.round(ra / 1000)} 秒后重试`);
    err.code = "rate_limit";
    err.retryAfterMs = ra;
    throw err;
  }
  // 其它非 2xx（401 token 失效 / 422 参数不合法 / 5xx）必须显式失败：
  // 原先一律报 "create failed"，把"token 配错了"和"平台抖了一下"混成一类，没法修。
  if (!res.ok) {
    const err = new Error(
      `globalping create failed: HTTP ${res.status} ` + JSON.stringify(data).slice(0, 160)
    );
    err.code = "http";
    err.status = res.status;
    throw err;
  }
  if (!data || !data.id) {
    throw new Error("globalping create failed: " + JSON.stringify(data).slice(0, 200));
  }
  return {
    id: data.id,
    source: `gp:${magic}`.slice(0, 80),
    quota: {
      limit: res.headers.get("x-ratelimit-limit"),
      remaining: res.headers.get("x-ratelimit-remaining"),
      // 实际计费的点数：与 limit 相等时说明"3 个探测点 = 3 点额度"，
      // 用它反推"每小时还能测几次"比猜准。
      cost: res.headers.get("x-request-cost"),
      ts: Date.now(),
    },
  };
}

/**
 * 单探针状态 → 可读原因。不能直接透传 status（只有 failed/offline 这类单词，
 * 分不清「探针超时」和「站点真挂」）；真正原因在 rawOutput 里。
 * 顺序有意义：更具体的模式必须排在泛化模式前面。
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

function gpResultReason(rr) {
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

/**
 * 从测量结果里取证书 —— SSL 监测的唯一来源。
 * 握手失败时 tls 为 null，此时返回 null 而不是「证书无效」：
 * 探针没连上，我们对证书一无所知，谎报会让网络抖动变成假降级。
 */
function tlsOf(rr) {
  const t = rr && rr.tls;
  if (!t || !t.expiresAt) return null;
  const exp = Date.parse(t.expiresAt);
  if (!Number.isFinite(exp)) return null;
  const issuer = t.issuer || {};
  const subject = t.subject || {};
  return {
    authorized: t.authorized === true ? 1 : 0,
    protocol: t.protocol || null,
    issuer: [issuer.O, issuer.CN].filter(Boolean).join(" ") || null,
    subject: subject.CN || subject.alt || null,
    key_type: t.cipherName || null,
    expires_at: new Date(exp).toISOString(),
  };
}

/**
 * 收取测量结果。三种返回必须分别处理：
 *   { done: false }                     还在跑，pending 留到下一轮
 *   { done: true, broken: true }        结果不可用，丢弃 pending 且不记检查
 *   { done: true, results, status }     正常
 *
 * broken 分支不可省：id 失效或 API 返回错误体时响应里没有 status，若当成"还在跑"
 * 就会永远 done:false → pending 永不删除 → dispatch 跳过该站点，静默停摆。
 *
 * 必须显式看 res.ok / res.status —— 这是与 gpCreate 对齐的部分。早先直接 res.json()，
 * 结果查询接口一旦限流，每分钟重试一次、直到 PENDING_TTL 到点，日志刷满却没人知道是额度问题：
 *  · 5xx / 网关 HTML 错误页 → json() 抛 SyntaxError，被上层记成 "throw"，看着像代码 bug；
 *  · 429 → 不触发 gp_blocked_until 退避（发起端退避了，收取端还在打）。
 * 现在把 HTTP 层的失败统一成 broken，并把 Retry-After 交给调度层（见 scheduled 的 noteBlocked）。
 */
export async function gpCollect(env, pending) {
  const token = env && env.GLOBALPING_TOKEN;
  const res = await fetch(
    `https://api.globalping.io/v1/measurements/${pending.measurement_id}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} }
  );

  // 429 先处理：它带 Retry-After，要留给调度层做退避，而不是当成"这条结果坏了"丢掉。
  if (res.status === 429) {
    const ra = retryAfterMs(res.headers.get("retry-after"));
    return {
      done: true,
      broken: true,
      rateLimited: true,
      retryAfterMs: ra,
      results: [],
      error: `收取被限流（429），${Math.round(ra / 1000)} 秒后重试`,
    };
  }
  if (!res.ok) {
    return {
      done: true,
      broken: true,
      results: [],
      error: `收取失败：HTTP ${res.status}`,
    };
  }

  const d = await res.json().catch(() => null);
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
      ok: rr.status === "finished",
      status: rr.statusCode || 0,
      ttfb: t.firstByte ?? 0,
      total: t.total ?? 0,
      error: gpResultReason(rr),
      probe: `${p.city || "?"}/${p.asn || "?"}`,
      // 平台归因：target 目标站 / resolver 解析 / internal 平台自身故障。
      // 表决时靠它把平台故障从站点故障里摘出去。
      failureSource: rr.failureSource || null,
      tls: tlsOf(rr),
    };
  });
  return { done: true, results, status: d.status };
}

/**
 * 多探针判定 —— 唯一判定口径。
 *
 * 只要有一台成功，站点就是可达的；全灭才判故障。这不是投票：
 * 投票回答「大多数用户能访问吗」，我们要回答「站点是不是挂了」。
 *
 * 实测依据：单点失败率约 25%，「≥2 失败即故障」单轮误判 ≈15.6%，
 * 全灭才判故障只有 ≈1.56%，低一个数量级；站点真挂时 3 台会同时失败，检出能力不减。
 *
 *  ① failureSource === "internal" 的探针不参与判定（平台没测到站点，不能当失败票）。
 *  ② 全失败且有效票只有 1 张时作废（下一轮重发）——但只在本来派了多台时。
 *     探测点数设为 1 是用户选定的采样方式，必须如实判失败，否则该配置永不转红。
 *  ③ 代表值取成功票的中位数：失败票 ttfb 为 0，混进来会拉低响应时间。
 *  ④ 不推断「部分不可达」：1/3 成功仍记 up，票型只在有分歧时标注。
 */
export function gpDecide(site, results) {
  const all = Array.isArray(results) ? results : [];
  if (!all.length) return { void: true, why: "no-results" };

  const usable = all.filter((r) => r.failureSource !== "internal");
  const platformFaults = all.length - usable.length;
  if (!usable.length) return { void: true, why: "all-internal", platformFaults };

  // 每条探针各自 judge：状态码不在期望集合（如 500）也参与判定。
  const votes = usable.map((r) => ({ r, v: judge(site, r) }));
  const yes = votes.filter((x) => x.v.ok);
  const no = votes.filter((x) => !x.v.ok);
  const total = votes.length;

  const ok = yes.length > 0;

  // 见规则 ②：all.length 是原始结果数（含被 internal 摘掉的）。
  if (!ok && total < 2 && all.length >= 2) {
    return { void: true, why: "single-fail", platformFaults, okCount: 0, total };
  }

  const pool = ok ? yes : no;
  const sorted = pool.slice().sort((a, b) => (a.r.ttfb || 0) - (b.r.ttfb || 0));
  const pick = sorted[Math.floor((sorted.length - 1) / 2)];

  return {
    void: false,
    ok,
    pick: pick.r,
    reason: pick.v.reason,
    okCount: yes.length,
    total,
    platformFaults,
    unanimous: yes.length === total || no.length === total,
  };
}

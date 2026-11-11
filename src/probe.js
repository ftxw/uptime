/** 探测层：走 Globalping 探针，一次 http 测量带回延迟、状态码与证书。 */

import { defOf, validMagic, gpLimitNum } from "./settings.js";

/** Globalping 要求非浏览器客户端自报标识，缺 UA 会被边缘风控优先拦。 */
const UA = "Uptime-Monitor/1.0 (+https://github.com/ftxw/uptime)";

/**
 * 出网请求统一超时：Globalping 不响应时不该把整轮 cron 挂死到 55 秒租约耗尽。
 * 老运行时没有 AbortSignal.timeout 时优雅退回「不设超时」，不能因此让探测全挂。
 */
function timeoutSignal(ms) {
  try {
    return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 同一 measurement id 的 ETag。官方 client guidelines 明确要求收取状态用
 * ETag / If-None-Match：/api/test 的轮询和跨轮重试会反复 GET 同一个 id，
 * 命中 304 就不必再下载整份（含 rawOutput）的结果体。
 */
const etags = new Map();
function rememberEtag(id, tag) {
  if (!tag) return;
  if (etags.size > 200) etags.clear();
  etags.set(id, tag);
}

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

/** 判定一次探测是否正常：状态码 ∈ expect_codes（空则接受 200-399）。只判 up/down。 */
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

/** 探针端超时（秒，Globalping 限 5–30）。国内链路实测 15s 左右才被判失败。 */
function gpTimeoutSec(env) {
  const dflt = Number(defOf("gp_timeout_sec"));
  const n = Number((env && env.GP_TIMEOUT_SEC) || dflt);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(30, Math.max(5, Math.round(n)));
}

/** Retry-After（秒数或 HTTP 日期）→ 毫秒，夹到 [30s, 1h]。 */
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

/** 发起一次测量，返回 measurement id（不等待结果）。额度按探测点数计费。 */
export async function gpCreate(env, site, opts = {}) {
  const token = env && env.GLOBALPING_TOKEN;
  const u = new URL(normalizeUrl(site.url));
  // 位置筛选是全局设置，这里再校验一次（环境变量可绕过后台规范化）
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
    signal: timeoutSignal(12_000),
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      type: "http",
      target: u.hostname, // 不能带 scheme
      locations: [{ magic }],
      limit,
      // 交互式即时测试用：让平台边跑边回部分结果，减少轮询次数。
      // 顶层字段（与 measurementOptions 平级），默认 false，cron 不开启。
      ...(opts.inProgressUpdates ? { inProgressUpdates: true } : {}),
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
    // 原样挂上响应头字段，由调度层随 rounds.err 落库归因
    err.gp = {
      status: 429,
      retryAfter: res.headers.get("retry-after"),
      limit: res.headers.get("x-ratelimit-limit"),
      remaining: res.headers.get("x-ratelimit-remaining"),
      reset: res.headers.get("x-ratelimit-reset"),
      cost: res.headers.get("x-request-cost"),
      body: data ? JSON.stringify(data).slice(0, 240) : null,
    };
    throw err;
  }
  // 非 2xx 显式失败：区分凭据错误与平台抖动
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
      // 本次扣掉的点数（= 探测点数）
      cost: res.headers.get("x-request-cost"),
      ts: Date.now(),
    },
  };
}

/** 探针原始原因 → 可读文案。更具体的模式必须排在前面。 */
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

/** 从测量结果里取证书。握手失败时 tls 为 null，返回 null 而不是「证书无效」。 */
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
    // 列名叫 key_type，就只存密钥算法（RSA / ECDSA…）。cipherName 是加密套件
    // （TLS_AES_256_GCM_SHA384 之类），以前塞进来会把两者混为一谈。
    key_type: t.keyType || t.key_type || t.publicKeyAlgorithm || null,
    expires_at: new Date(exp).toISOString(),
  };
}

/** 收取结果：{done:false} 仍在跑 / {done:true,broken:true} 丢弃 / 正常结果。429 回传 retryAfterMs。 */
export async function gpCollect(env, pending) {
  const token = env && env.GLOBALPING_TOKEN;
  const mid = encodeURIComponent(String(pending.measurement_id));
  const etag = etags.get(mid);
  const res = await fetch(`https://api.globalping.io/v1/measurements/${mid}`, {
    signal: timeoutSignal(12_000),
    headers: {
      "User-Agent": UA,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(etag ? { "If-None-Match": etag } : {}),
    },
  });
  rememberEtag(mid, res.headers.get("etag"));

  // 内容没变（测量还在跑）：等价于 done:false，继续等下一拍，别重复解析同一份结果。
  if (res.status === 304) return { done: false, results: [], notModified: true };

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
    // 带上响应体前 160 字：403/404 的正文才能区分为「被边缘拦」还是「测量不存在」
    const body = await res.text().catch(() => "");
    return {
      done: true,
      broken: true,
      results: [],
      error: `收取失败：HTTP ${res.status} ${body.slice(0, 160)}`.trim(),
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

/** 多探针判定：一台成功即判可达，全灭才判故障。internal 故障票不参与，代表值取中位数。 */
export function gpDecide(site, results) {
  const all = Array.isArray(results) ? results : [];
  if (!all.length) return { void: true, why: "no-results" };

  const usable = all.filter((r) => r.failureSource !== "internal");
  const platformFaults = all.length - usable.length;
  if (!usable.length) return { void: true, why: "all-internal", platformFaults };

  const votes = usable.map((r) => ({ r, v: judge(site, r) }));
  const yes = votes.filter((x) => x.v.ok);
  const no = votes.filter((x) => !x.v.ok);
  const total = votes.length;

  const ok = yes.length > 0;

  // 只剩 1 票且失败（原始结果 ≥2）：作废重测
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

/**
 * 大陆探测臂 —— 共享核心模块
 *
 * 放在 cloud-functions/ **之外**是有原因的：平台的文件路由会把 cloud-functions/
 * 下的每个 .js 都注册成一条路由，放在那里会多出一条 /_core 之类的无用路由
 * （原实现在三个接口里各复制了一份鉴权函数，就是被这条限制逼的 —— 见 git 历史）。
 * 放在外面由打包器按相对路径带入，路由表就只剩真正的接口。
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** 桌面版 Chrome UA —— 与 CF 侧探测保持一致，减少目标站 WAF 因 UA 差异产生的噪声。 */
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const DEFAULT_TIMEOUT = 8000;
export const MIN_TIMEOUT = 1000;
/** TLS 握手比一次普通 GET 慢，下限单独给一个更高的值。 */
export const MIN_TLS_TIMEOUT = 2000;
export const MAX_TIMEOUT = 15000;

/* ───────────────────────────── 鉴权（fail-closed） ───────────────────────── */

/**
 * 统一鉴权。放行返回 null，拦截返回 Response。
 *
 * ⚠️ fail-closed：令牌没配 = 接口**整体停用**（503）。默认放行等于把探测臂
 *    变成一个任何人都能用的开放代理 —— 它能替你从境内打任意 URL。
 *
 * 比较用「先 SHA-256 再 timingSafeEqual」：
 *   直接用 timingSafeEqual 比原始串，长度不等时会抛异常；加长度前置判断又会引入
 *   一条基于长度的提前 return。先压成定长 32 字节摘要后再比，既永不抛异常、
 *   也没有任何提前返回，比较本身严格常量时间。
 */
export function requireAuth(context) {
  const secret = context.env.PROBE_TOKEN;
  if (!secret) {
    return Response.json(
      {
        ok: false,
        error: "PROBE_TOKEN 未配置，接口已停用",
        hint: "请执行 edgeone makers env set PROBE_TOKEN <随机串> 后重新部署",
      },
      { status: 503 }
    );
  }
  const got = context.request.headers.get("x-probe-token") || "";
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(String(secret)).digest();
  if (!timingSafeEqual(a, b)) {
    return Response.json({ ok: false, error: "鉴权失败" }, { status: 401 });
  }
  return null;
}

/* ───────────────────────────── 出口自检（带缓存） ───────────────────────── */

/**
 * 出口信息的缓存时长。
 *
 * 为什么必须缓存：/api/probe 与 /api/ssl 是**每分钟**被调用的热路径，出口自检要出网，
 * 不能每次都打。6 小时足够 —— 而且只配了一个地域（见 edgeone.json），出口不会变。
 * 缓存挂在模块级变量上：Cloud Function 实例会被平台复用，同一份部署的相邻调用
 * 几乎必然命中同一实例；即便换实例，最坏也只是多查一次，不影响正确性。
 */
const EGRESS_TTL_MS = 6 * 3600 * 1000;
let egressCache = null;

/** 带超时的取文本。任何出网都必须有超时，否则一个卡住的外部请求会拖垮整个接口。 */
async function fetchText(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    try {
      ac.abort();
    } catch {}
  }, timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": UA, Accept: "application/json,text/plain,*/*" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 出口 IP + 归属国家。
 *
 * ⚠️ **平台自报的 `server.region` 不足以证明出口在哪** —— 上一版就是因为同时配了
 *    大陆与海外两个地域，平台按调用方位置做路由，CF 从境外调用就被路由去了境外，
 *    测量数据全部作废（实测 source 记成了 `cn:ap-singapore`）。
 *    所以这里用**出网 IP 的真实归属**做交叉验证，两个来源不一致就说明配置有问题。
 *
 * 取不到归属（服务抖动/限流）时返回 country: null —— **宁可说"不知道"，也不猜**。
 * 由调用方决定 null 该如何对待，主项目那边会把它显示成「未知」而不是「境外」。
 */
export async function getEgress() {
  const now = Date.now();
  if (egressCache && now - egressCache.at < EGRESS_TTL_MS) return egressCache.data;

  const data = { ip: null, country: null, city: null, checkedAt: new Date().toISOString() };

  // ipapi.co 一次给出 IP + 国家/城市，省一次往返
  try {
    const raw = await fetchText("https://ipapi.co/json/", 4000);
    if (raw) {
      const j = JSON.parse(raw);
      if (j && typeof j.ip === "string") {
        data.ip = j.ip;
        data.country = typeof j.country_code === "string" ? j.country_code.toUpperCase() : null;
        data.city = typeof j.city === "string" ? j.city : null;
      }
    }
  } catch {
    // 落到下面的兜底
  }

  // 兜底：Cloudflare trace（CF 自家、稳定，只给 IP）
  if (!data.ip) {
    const text = await fetchText("https://www.cloudflare.com/cdn-cgi/trace", 3000);
    const line = text && text.split("\n").find((l) => l.startsWith("ip="));
    if (line) data.ip = line.slice(3).trim() || null;
  }

  // 只有真拿到 IP 才缓存，否则接下来 6 小时都是空的
  if (data.ip) egressCache = { at: now, data };
  return data;
}

/**
 * 判断出口是否落在期望的国家。
 * 归属未知时返回 "unknown" 而不是 "mismatch" —— 两者含义完全不同，不能混。
 */
export function verdictOf(egress, expectCountry) {
  const want = String(expectCountry || "").trim().toUpperCase();
  if (!want) return "unchecked";
  if (!egress || !egress.country) return "unknown";
  return egress.country === want ? "match" : "mismatch";
}

/* ───────────────────────────── 小工具 ───────────────────────── */

export function clampTimeout(v, min = MIN_TIMEOUT) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT;
  return Math.min(MAX_TIMEOUT, Math.max(min, Math.round(n)));
}

/**
 * 缺 scheme 时补 https://；已带任意 scheme 的原样返回。
 * 只匹配 http(s):// 不够：`ftp://x.com` 会被补成 `https://ftp://x.com`，
 * 而 new URL 能把它解析出来（host 变成 ftp、protocol 仍算 https），于是绕过
 * protocol 校验、白打一次 DNS，把「参数写错」伪装成误导性的网络故障。
 */
export function normalizeUrl(u) {
  const s = String(u ?? "").trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

/** 只接受 http/https，否则直接判失败、不发无意义的出站请求。 */
export function parseTarget(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed;
}

/** 统一的失败结构，保证返回给 CF 的字段集合永远一致。 */
export function failResult(url, errorCode, error, elapsed = 0) {
  return {
    url,
    ok: false,
    status: 0,
    ttfb: elapsed,
    total: elapsed,
    bytes: 0,
    keywordHit: null,
    errorCode,
    error,
  };
}

/**
 * 信号量池：把并发压在 limit 之上。
 * Node 的 fetch 没有浏览器那样的并发上限，但一次性把 50 条全发出去会瞬间打满
 * 本函数的出网额度、也会把 TTFB 测歪（排队时间被算进首字节时间里）。
 */
export async function runPool(items, worker, limit) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

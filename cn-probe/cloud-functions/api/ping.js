/**
 * GET /api/ping —— 探测臂存活 & 出口自检。
 *
 * 为什么存在：CF 侧调度器在正式发起探测前要先探活；人工排查时也需要一个
 *            能一次回答「这条跨境控制链路通不通」的极轻接口。
 * 给谁用：    CF（香港/新加坡边缘）→ 本接口；以及后台 / 自检页。
 *
 * 关键取舍：
 *   1. 返回值里的 egressIp 是本函数**出网出口 IP**，靠一次出网回显取得。
 *      它比任何文档都更能说明「这个地域的大陆出口到底是不是境内」。
 *   2. 出口 IP 走模块级缓存（5 分钟）。Cloud Function 实例会被平台复用，
 *      同一份部署的相邻调用几乎必然是同一实例 —— 不缓存就会每次调用都多打一次外网，
 *      白白消耗出网额度、还拉长 ping 的响应时间。
 *   3. 回显失败不影响接口本身：出口 IP 是加分项，不是存活判据。
 *
 * 鉴权：与 /api/probe、/api/ssl 完全一致（fail-closed），ping 也不例外 ——
 *       否则「探测臂是否在线、出口在哪」会变成任何人可读的情报。
 *
 * ⚠️ 鉴权函数在三个文件里**内联复制**，没有抽公共模块：
 *    平台的文件路由会把 cloud-functions/ 下每个 .js 都注册成一条路由
 *    （官方 File-system Routing 表里 hello-makers.js → /hello-makers），
 *    因此 _auth.js 会被暴露成一条多余路由。复制 20 行的成本，换零路由泄漏。
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** 桌面版 Chrome UA —— 与 CF 侧探测保持一致，减少目标站 WAF 因 UA 差异产生的噪声。 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * 统一鉴权（fail-closed）。放行返回 null，拦截返回 Response。
 *
 * 比较用「先 SHA-256 再 timingSafeEqual」：
 *   - 直接用 timingSafeEqual 比原始串，长度不等时会抛异常；加长度前置判断又会引入
 *     一条基于长度的提前 return。把两侧先压成定长 32 字节摘要后再比，
 *     既永不抛异常、也没有任何提前返回，比较本身严格常量时间。
 */
function requireAuth(context) {
  const secret = context.env.PROBE_TOKEN;
  // 令牌没配 = 接口整体停用。默认放行等于把探测臂变成一个任人可用的开放代理。
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

/* ───────────────────── 出口 IP 回显（带 5 分钟缓存） ───────────────────── */

let egressCache = { ip: null, at: 0 };
const EGRESS_TTL_MS = 5 * 60 * 1000;

/** 带超时的文本 GET。所有出网都必须有超时，否则一个卡住的回显会拖垮整个 ping。 */
async function fetchText(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    try {
      ac.abort();
    } catch {}
  }, timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 主源：Cloudflare trace，一行 `ip=`，体积极小、无需 JSON 解析。 */
async function traceIp() {
  const text = await fetchText("https://www.cloudflare.com/cdn-cgi/trace", 3000);
  if (!text) return null;
  const line = text.split("\n").find((l) => l.startsWith("ip="));
  return line ? line.slice(3).trim() || null : null;
}

/** 回落源：api.ipify.org，纯文本回显 IP。 */
async function ipifyIp() {
  const text = await fetchText("https://api.ipify.org", 3000);
  return text ? text.trim() || null : null;
}

async function getEgressIp() {
  const now = Date.now();
  if (egressCache.ip && now - egressCache.at < EGRESS_TTL_MS) return egressCache.ip;
  const ip = (await traceIp()) || (await ipifyIp());
  if (ip) egressCache = { ip, at: now };
  // 取不到就返回 null，但接口照常成功 —— 出口 IP 缺失不该让探活失败。
  return ip ?? null;
}

/* ─────────────────────────────── 处理函数 ─────────────────────────────── */

export async function onRequestGet(context) {
  const denied = requireAuth(context);
  if (denied) return denied;

  const egressIp = await getEgressIp();

  return Response.json({
    ok: true,
    service: "cn-probe",
    region: context.server?.region ?? null,
    requestId: context.server?.requestId ?? null,
    ts: new Date().toISOString(),
    egressIp,
  });
}

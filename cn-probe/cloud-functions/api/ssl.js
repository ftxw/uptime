/**
 * POST /api/ssl —— 从大陆出口直连读取 TLS 证书。
 *
 * 为什么存在：Cloudflare Workers 的 fetch() **不暴露对端证书**，拿不到有效期 / 颁发者 /
 *            指纹。证书必须由一个能自行完成 TLS 握手的执行体代取 —— 这里用 node:tls 直连。
 * 给谁用：    CF 侧每日一次的证书检测；请求头 x-probe-token 鉴权（口径与 ping / probe 一致）。
 *
 * 关键取舍：
 *   1. rejectUnauthorized:false —— 我们要的恰恰是「读到无效证书这件事本身」。
 *      默认校验会让自签 / 过期 / 域名不匹配的站点直接握手失败，一个字段都拿不到；
 *      关掉校验后如实上报 authorized，有效性判定仍归 CF 侧。
 *   2. 只处理 https:，http: 直接跳过 —— 明文连接没有证书可读。
 *   3. 单条失败只给简短中文原因（连接超时 / 证书读取失败），其余字段一律 null，
 *      保证返回给 CF 的字段集合恒定，前端不必做 undefined 判断。
 *
 * ⚠️ 鉴权函数在此文件内联复制（原因见 ping.js 顶部注释）。
 */

import { createHash, timingSafeEqual } from "node:crypto";
import tls from "node:tls";

const MAX_ITEMS = 50;
const CONCURRENCY = 8;
const DEFAULT_TIMEOUT = 8000;
const MIN_TIMEOUT = 2000;
const MAX_TIMEOUT = 15000;

/** 统一鉴权（fail-closed）。放行返回 null，拦截返回 Response。 */
function requireAuth(context) {
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

/* ─────────────────────────────── 工具函数 ─────────────────────────────── */

/** 夹到 [2000, 15000]，非法值回落默认 8000。 */
function clampTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT;
  return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, Math.round(n)));
}

/** 缺 scheme 时补 https://；已带任意 scheme 的原样返回，真伪交由 fetchCert 的 protocol 校验。 */
function normalizeUrl(u) {
  const s = String(u ?? "").trim();
  // 同 probe.js：只认 http(s):// 会让 "ftp://x.com" 被补成 "https://ftp://x.com"，
  // host 解析成 "ftp" 后 protocol 校验通过，反而对一个错误 host 发起 TLS 握手。
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

/** 解析 OpenSSL 的 `valid_to`（形如 `Nov 15 12:00:00 2026 GMT`）→ epoch ms，失败为 null。 */
function parseValidTo(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * 直连取证书。永不 reject —— 失败也以 { error } 形式 resolve，
 * 让每条探测互不影响。
 */
function fetchCert(url, timeoutMs) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve({ error: "URL 无效" });
    }
    // 明文没有证书可读，直接跳过。
    if (parsed.protocol !== "https:") {
      return resolve({ error: "非 HTTPS 站点，跳过证书检测" });
    }

    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 443;

    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      // destroy 而非 end：这里已经不需要优雅关闭，destroy 能保证句柄立即释放，
      // 避免异常站点把 socket 挂在半开状态耗尽实例资源。
      try {
        socket.destroy();
      } catch {}
      resolve(payload);
    };

    const socket = tls.connect({
      host,
      port,
      // SNI：IP 字面量不能作 servername，Node 会直接报错；域名才有意义。
      servername: host,
      // 见文件头：故意关掉校验，以读到「无效证书」本身。
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });

    socket.once("secureConnect", () => {
      try {
        const cert = socket.getPeerCertificate(true) || {};
        const expiresAt = parseValidTo(cert.valid_to);
        finish({
          authorized: socket.authorized === true,
          protocol: socket.getProtocol() || null,
          issuer: [cert.issuer?.O, cert.issuer?.CN].filter(Boolean).join(" / ") || null,
          subject: cert.subject?.CN || null,
          // Node 的 getPeerCertificate 不直接给 keyType，只能尽力推断：
          // asn1Curve 有值基本是 EC，否则按 RSA + 位数。
          key_type: cert.asn1Curve
            ? `EC ${cert.bits || ""}`.trim()
            : cert.bits
              ? `RSA ${cert.bits}`
              : null,
          expires_at: expiresAt == null ? null : new Date(expiresAt).toISOString(),
          days_left:
            expiresAt == null ? null : Math.floor((expiresAt - Date.now()) / 86400000),
          fingerprint256: cert.fingerprint256 || null,
          error: null,
        });
      } catch {
        finish({ error: "证书读取失败" });
      }
    });

    // timeout 与 error 都要接住，否则半开连接会让进程悬挂到 120s 上限。
    socket.once("timeout", () => finish({ error: "连接超时" }));
    socket.once("error", () => finish({ error: "证书读取失败" }));
  });
}

/** 简单信号量池：避免一次性对 50 个站点发起 TLS 握手。 */
async function runPool(items, worker, limit) {
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

/* ─────────────────────────────── 处理函数 ─────────────────────────────── */

export async function onRequestPost(context) {
  const denied = requireAuth(context);
  if (denied) return denied;

  let body = null;
  try {
    body = await context.request.json();
  } catch {
    body = null;
  }

  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return Response.json({ ok: false, error: "items 不能为空" }, { status: 400 });
  }
  if (items.length > MAX_ITEMS) {
    return Response.json({ ok: false, error: "items 最多 50 条" }, { status: 400 });
  }

  const results = await runPool(
    items,
    async (raw) => {
      const item = typeof raw === "string" ? { url: raw } : raw || {};
      const url = normalizeUrl(item.url);
      const r = await fetchCert(url, clampTimeout(item.timeoutMs));
      // 用 null 模板兜底再展开：无论成败，每条的 key 集合都完整。
      return {
        url,
        authorized: null,
        protocol: null,
        issuer: null,
        subject: null,
        key_type: null,
        expires_at: null,
        days_left: null,
        fingerprint256: null,
        error: null,
        ...r,
      };
    },
    CONCURRENCY
  );

  return Response.json({
    ok: true,
    region: context.server?.region ?? null,
    ts: new Date().toISOString(),
    results,
  });
}

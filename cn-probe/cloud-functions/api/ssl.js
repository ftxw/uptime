/**
 * POST /api/ssl —— 从大陆出口直连读取 TLS 证书。
 *
 * ## 为什么需要它
 * Cloudflare Workers 的 `fetch()` **不暴露对端证书**，拿不到有效期 / 颁发者 /
 * 指纹。证书必须由一个能自行完成 TLS 握手的执行体代取 —— 这里用 `node:tls` 直连。
 *
 * ## 关键取舍
 *   1. `rejectUnauthorized: false` —— 我们要的恰恰是「读到无效证书这件事本身」。
 *      默认校验会让自签 / 过期 / 域名不匹配的站点直接握手失败，一个字段都拿不到；
 *      关掉校验后如实上报 `authorized`，有效性判定仍归主项目。
 *   2. 只处理 https:，http: 直接跳过 —— 明文连接没有证书可读。
 *   3. 单条失败只给简短原因，其余字段一律 null，**保证字段集合恒定**，
 *      主项目不必做 undefined 判断。
 */

import tls from "node:tls";
import {
  requireAuth,
  clampTimeout,
  normalizeUrl,
  runPool,
  MIN_TLS_TIMEOUT,
} from "../lib/core.js";

const MAX_ITEMS = 50;
const CONCURRENCY = 8;

/** 解析 OpenSSL 的 `valid_to`（形如 `Nov 15 12:00:00 2026 GMT`）→ epoch ms，失败为 null。 */
function parseValidTo(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * 直连取证书。**永不 reject** —— 失败也以 `{ error }` resolve，让每条探测互不影响。
 */
function fetchCert(url, timeoutMs) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve({ error: "URL 无效" });
    }
    if (parsed.protocol !== "https:") {
      return resolve({ error: "非 HTTPS 站点，跳过证书检测" });
    }

    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 443;

    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      // destroy 而非 end：这里不需要优雅关闭，destroy 能保证句柄立即释放，
      // 避免异常站点把 socket 挂在半开状态耗尽实例资源。
      try {
        socket.destroy();
      } catch {}
      resolve(payload);
    };

    const socket = tls.connect({
      host,
      port,
      // SNI：IP 字面量不能作 servername（Node 会直接报错），域名才有意义
      servername: host,
      // 见文件头：故意关掉校验，以读到「无效证书」本身
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
          // getPeerCertificate 不直接给 keyType，只能尽力推断：
          // asn1Curve 有值基本是 EC，否则按 RSA + 位数
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

    // timeout 与 error 都要接住，否则半开连接会让函数悬挂到 120s 上限
    socket.once("timeout", () => finish({ error: "连接超时" }));
    socket.once("error", () => finish({ error: "证书读取失败" }));
  });
}

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
    return Response.json({ ok: false, error: `items 最多 ${MAX_ITEMS} 条` }, { status: 400 });
  }

  const results = await runPool(
    items,
    async (raw) => {
      const item = typeof raw === "string" ? { url: raw } : raw || {};
      const url = normalizeUrl(item.url);
      const r = await fetchCert(url, clampTimeout(item.timeoutMs, MIN_TLS_TIMEOUT));
      // 用 null 模板兜底再展开：无论成败，每条的 key 集合都完整
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

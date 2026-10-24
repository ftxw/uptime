/**
 * 认证：常量时间比较 + HMAC-SHA256 自包含会话 + 内存限速。
 *
 * 密码只来自环境变量 ADMIN_PASSWORD（部署期配置，不入库、不提供后台改密）。
 * 会话是签名 token，服务端不留状态；签名密钥取 ADMIN_SECRET，未设则在 D1 里
 * 生成随机值持久化，保证多机房一致、重启不踢会话。
 */

const encoder = new TextEncoder();

/** 常量时间比较：长度不同也走满全程，绝不提前返回（否则会泄漏匹配了多少位）。 */
export function constantTimeEqual(a, b) {
  const ab = encoder.encode(String(a ?? ""));
  const bb = encoder.encode(String(b ?? ""));
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export function randomHex(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

/* ───────────────────────── 会话 ───────────────────────── */

function b64urlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 缓存的 HMAC key。实际只有一个 secret，故只留最近一份；失败清空以便重试。 */
let cachedKey = null;

function hmacKey(secret) {
  if (!cachedKey || cachedKey.secret !== secret) {
    cachedKey = {
      secret,
      key: crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      ),
    };
  }
  const cur = cachedKey;
  return Promise.resolve(cur.key).catch((e) => {
    if (cachedKey === cur) cachedKey = null;
    throw e;
  });
}

async function hmacBytes(secret, data) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

async function signSession(payload, secret) {
  const p = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = await hmacBytes(secret, p);
  return `${p}.${b64urlEncode(sig)}`;
}

/**
 * 签发管理员会话（默认 30 天）。
 * `epoch` 是会话纪元：登出所有设备时 +1，旧 token 立即失效。
 * 它与签名密钥解耦，所以即使 ADMIN_SECRET 来自环境变量（只读）也能吊销。
 */
export async function issueSession(secret, maxAgeSec, now = Date.now(), epoch = 0) {
  const iat = Math.floor(now / 1000);
  return signSession({ sub: "admin", iat, exp: iat + maxAgeSec, ep: epoch }, secret);
}

/**
 * 验签失败/过期/格式非法/纪元不匹配一律返回 null（不区分原因）。
 * `ep` 缺失按 0 处理，这样加纪元时不会把所有现存会话一起踢掉。
 */
export async function verifySession(token, secret, epoch = 0) {
  if (typeof token !== "string" || token.length === 0) return null;
  const idx = token.indexOf(".");
  if (idx <= 0 || idx === token.length - 1) return null;
  const p = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = b64urlEncode(await hmacBytes(secret, p));
  if (!constantTimeEqual(sig, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number") return null;
  if (payload.exp * 1000 < Date.now()) return null;
  if (Number(payload.ep || 0) !== Number(epoch || 0)) return null;
  return payload;
}

/* ───────────────────────── Cookie ───────────────────────── */

const SESSION_COOKIE = "uptime_admin";

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function getSessionToken(cookieHeader) {
  return parseCookies(cookieHeader)[SESSION_COOKIE] ?? null;
}

export function buildSessionCookie(token, maxAge, secure = true) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure = true) {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/* ───────────────────────── 限速（best-effort）───────────────────────── */

/**
 * 内存限速：不使用 KV/D1（既烧额度，最终一致也数不准）。
 * isolate 重启即清空、多 PoP 不共享，只作纵深防御的一层。
 */
export function createRateLimiter(maxPerMinute, windowMs = 60_000) {
  const buckets = new Map();
  const SWEEP_AT = 500;

  return {
    check(key) {
      const now = Date.now();
      const b = buckets.get(key);
      if (!b || now - b.start >= windowMs) {
        if (buckets.size >= SWEEP_AT) {
          buckets.forEach((v, k) => {
            if (now - v.start >= windowMs) buckets.delete(k);
          });
        }
        buckets.set(key, { count: 1, start: now });
        return true;
      }
      if (b.count >= maxPerMinute) return false;
      b.count++;
      return true;
    },
    reset(key) {
      if (key === undefined) buckets.clear();
      else buckets.delete(key);
    },
  };
}

/** 固定延迟（登录失败后用）。等待不计 CPU，但抬高爆破成本。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

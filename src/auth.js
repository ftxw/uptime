/**
 * 认证：常量时间比较 + PBKDF2 密码哈希 + HMAC-SHA256 签名会话 + 内存限速。
 *
 * ⚠️ PBKDF2 轮数为什么是 5000 而不是十万级 —— 别照搬参考项目：
 *   参考项目 HaoNav 跑在 EdgeOne Edge Functions（CPU 预算 200 ms），用了 210k 轮（≈23 ms）；
 *   本 Worker 跑在 **Cloudflare Workers 免费版，CPU 限制 10 ms/次执行**，
 *   直接搬过来会超限。5000 轮在本机 V8 约 0.7 ms，留了足够余量。
 *   ⛔ 改轮数前先确认执行环境的 CPU 预算 —— 这是「抗离线爆破」与「CPU 上限」的直接交换。
 *
 * 会话是**自包含签名 token**，服务端不留状态（不写 D1/KV）：
 *   token = base64url(JSON payload) . base64url(HMAC-SHA256(secret, payload))
 *   改密码时会把 session_secret 一并重置 → 所有旧会话立即失效。
 */

const encoder = new TextEncoder();

/* ───────────────────────── 常量时间比较 ───────────────────────── */

/**
 * 常量时间比较：**长度不同也必须遍历固定长度，绝不能提前 return**。
 * 提前 return 会泄漏「前多少位匹配」，配合大量请求可逐位还原密码。
 */
export function constantTimeEqual(a, b) {
  const ab = encoder.encode(String(a ?? ""));
  const bb = encoder.encode(String(b ?? ""));
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length; // 长度差异折进 diff，而不是直接返回 false
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/* ───────────────────────── 十六进制工具 ───────────────────────── */

function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function fromHex(s) {
  if (typeof s !== "string" || s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) return null;
    out[i] = b;
  }
  return out;
}

export function randomHex(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

/* ───────────────────────── 密码哈希（PBKDF2-SHA256）───────────────────────── */

/** 存储格式：`pbkdf2$<iters>$<saltHex>$<hashHex>` —— 含轮数与盐，便于将来平滑升级 */
export const PBKDF2_ITERATIONS = 5000;

async function derivePbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password ?? ""),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
  return toHex(new Uint8Array(bits));
}

/** 生成密码哈希。盐随机 → 同一密码每次结果都不同 */
export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hex = await derivePbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${toHex(salt)}$${hex}`;
}

/** 校验哈希；格式非法一律 false（fail-closed） */
export async function verifyPasswordHash(input, stored) {
  if (typeof stored !== "string" || stored.length === 0) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  // 上界防止有人把轮数写成天文数字导致 CPU 超限
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 100000) return false;
  const salt = fromHex(parts[2]);
  const expected = fromHex(parts[3]);
  if (!salt || salt.length < 8 || !expected || expected.length !== 32) return false;
  const actual = await derivePbkdf2(input ?? "", salt, iterations);
  return constantTimeEqual(actual, parts[3].toLowerCase());
}

/* ───────────────────────── 会话（HMAC 签名 token）───────────────────────── */

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

async function hmacBytes(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

async function signSession(payload, secret) {
  const p = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = await hmacBytes(secret, p);
  return `${p}.${b64urlEncode(sig)}`;
}

/** 签发管理员会话（默认 30 天） */
export async function issueSession(secret, maxAgeSec, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  return signSession({ sub: "admin", iat, exp: iat + maxAgeSec }, secret);
}

/** 验签失败 / 过期 / 格式非法一律返回 null（不区分原因，避免信息泄漏） */
export async function verifySession(token, secret) {
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
  return payload;
}

/* ───────────────────────── Cookie 工具 ───────────────────────── */

export const SESSION_COOKIE = "uptime_admin";

export function parseCookies(header) {
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

/* ───────────────────────── 内存限速（best-effort）───────────────────────── */

/**
 * ⚠️ 不要用 KV/D1 做登录计数：既烧额度，且 KV 最终一致本来也数不准。
 *    内存 Map 是 best-effort —— isolate 重启会清空、多 PoP 不共享，
 *    所以它只是**纵深防御的一层**，真正的闸门是密码强度 + 平台侧 WAF。
 * 惰性清理：桶数超阈值时顺手扫一遍过期的，避免无上界增长。
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

/** 固定延迟（登录失败后调用）。等待不计 CPU，但抬高爆破成本。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/db.js
async function buildCategories(d) {
  const [cats, used] = await Promise.all([
    d.prepare("SELECT name, sort FROM categories ORDER BY sort, name").all(),
    d.prepare(
      "SELECT COALESCE(NULLIF(TRIM(group_name), ''), '\u672A\u5206\u7EC4') AS g, COUNT(*) AS n FROM sites GROUP BY g"
    ).all()
  ]);
  const counts = {};
  for (const r of used.results || []) counts[r.g] = Number(r.n);
  const explicit = new Set((cats.results || []).map((c) => c.name));
  const order = [];
  const seen = /* @__PURE__ */ new Set();
  for (const c of cats.results || []) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      order.push(c.name);
    }
  }
  for (const r of used.results || []) {
    if (!seen.has(r.g)) {
      seen.add(r.g);
      order.push(r.g);
    }
  }
  return order.map((n) => ({
    name: n,
    count: counts[n] || 0,
    explicit: explicit.has(n)
  }));
}
__name(buildCategories, "buildCategories");
async function cleanupOldChecks(env, keepDays = 30) {
  const d = await db(env);
  const cutoff = new Date(Date.now() - keepDays * 864e5).toISOString();
  const r = await d.prepare("DELETE FROM checks WHERE ts < ?").bind(cutoff).run();
  return Number(r?.meta?.changes ?? r?.changes ?? 0);
}
__name(cleanupOldChecks, "cleanupOldChecks");
async function db(env) {
  return env && env.DB;
}
__name(db, "db");
async function loadSettings(env) {
  const out = {};
  try {
    const d = await db(env);
    const { results } = await d.prepare("SELECT key, value FROM meta").all();
    for (const r of results || []) out[r.key] = r.value;
  } catch {
  }
  return out;
}
__name(loadSettings, "loadSettings");
async function saveSetting(env, key, value) {
  const d = await db(env);
  if (value === null || value === void 0 || value === "") {
    await d.prepare("DELETE FROM meta WHERE key = ?").bind(key).run();
  } else {
    await d.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(key, String(value)).run();
  }
}
__name(saveSetting, "saveSetting");
async function loadSites(env) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT * FROM sites WHERE enabled = 1 ORDER BY sort, id").all();
  return results || [];
}
__name(loadSites, "loadSites");
async function insertChecks(env, rows) {
  const d = await db(env);
  if (!rows.length) return { stored: 0 };
  const stmt = d.prepare(
    `INSERT INTO checks (ts, site, source, probe, ok, status, ttfb_ms, total_ms, error)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const batch = rows.map(
    (r) => stmt.bind(
      r.ts,
      r.site,
      r.source,
      r.probe ?? null,
      r.ok ? 1 : 0,
      r.status ?? 0,
      r.ttfb_ms ?? 0,
      r.total_ms ?? 0,
      r.error || null
    )
  );
  await d.batch(batch);
  return { stored: batch.length };
}
__name(insertChecks, "insertChecks");
async function bumpState(env, perSite) {
  const d = await db(env);
  const toAlert = [];
  for (const [site, info] of Object.entries(perSite)) {
    const cur = await d.prepare("SELECT * FROM state WHERE site = ?").bind(site).first();
    const fail = info.ok ? 0 : Number(cur?.consecutive_fail || 0) + 1;
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    await d.prepare(
      `INSERT INTO state (site, consecutive_fail, last_ok_ts, last_checked_ts, last_alert_ts)
         VALUES (?,?,?,?,?)
         ON CONFLICT(site) DO UPDATE SET
           consecutive_fail = excluded.consecutive_fail,
           last_ok_ts = COALESCE(excluded.last_ok_ts, state.last_ok_ts),
           last_checked_ts = excluded.last_checked_ts,
           last_alert_ts = COALESCE(excluded.last_alert_ts, state.last_alert_ts)`
    ).bind(site, fail, info.ok ? nowIso : null, nowIso, null);
    if (info.ok && Number(cur?.consecutive_fail || 0) >= info.threshold) {
      toAlert.push({ site, kind: "recovered", failCount: cur.consecutive_fail, info });
    } else if (!info.ok && fail === info.threshold) {
      toAlert.push({ site, kind: "down", failCount: fail, info });
    }
  }
  return toAlert;
}
__name(bumpState, "bumpState");
async function saveSsl(env, siteId, r) {
  const d = await db(env);
  await d.prepare(
    `INSERT INTO ssl
         (site, checked_ts, authorized, protocol, issuer, subject, key_type, expires_at, days_left, error)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(site) DO UPDATE SET
         checked_ts=excluded.checked_ts, authorized=excluded.authorized,
         protocol=excluded.protocol, issuer=excluded.issuer,
         subject=excluded.subject, key_type=excluded.key_type,
         expires_at=excluded.expires_at, days_left=excluded.days_left,
         error=excluded.error`
  ).bind(
    siteId,
    (/* @__PURE__ */ new Date()).toISOString(),
    r.authorized ?? null,
    r.protocol ?? null,
    r.issuer ?? null,
    r.subject ?? null,
    r.key_type ?? null,
    r.expires_at ?? null,
    r.days_left ?? null,
    r.error ?? null
  ).run();
}
__name(saveSsl, "saveSsl");

// src/prober.js
import { DurableObject } from "cloudflare:workers";

// src/probe.js
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var REGION_GROUPS = [
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "apac-ne",
  "apac-se",
  "oc",
  "afr",
  "me"
];
function normalizeUrl(u) {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}
__name(normalizeUrl, "normalizeUrl");
function isIpAddress(hostname) {
  if (hostname.includes(":")) return true;
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}
__name(isIpAddress, "isIpAddress");
var ERR_ZH = [
  ["ENOTFOUND", "\u65E0\u6CD5\u89E3\u6790\u57DF\u540D"],
  ["ECONNREFUSED", "\u8FDE\u63A5\u88AB\u62D2\u7EDD"],
  ["ETIMEDOUT", "\u8FDE\u63A5\u8D85\u65F6"],
  ["ECONNRESET", "\u8FDE\u63A5\u88AB\u91CD\u7F6E"],
  ["certificate", "\u8BC1\u4E66\u6821\u9A8C\u5931\u8D25"],
  ["CERT_", "\u8BC1\u4E66\u6821\u9A8C\u5931\u8D25"],
  ["AbortError", "\u8BF7\u6C42\u8D85\u65F6"],
  ["fetch failed", "\u8BF7\u6C42\u5931\u8D25"]
];
function zhError(raw) {
  const s = String(raw || "");
  for (const [k, v] of ERR_ZH) {
    if (s.includes(k)) return v;
  }
  return s || "\u672A\u77E5\u9519\u8BEF";
}
__name(zhError, "zhError");
async function probeDirect(url, timeoutMs, keyword) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => {
    try {
      ac.abort();
    } catch {
    }
  }, timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "*/*" },
      signal: ac.signal
    });
    const ttfb = Date.now() - started;
    let keywordHit = null;
    let bytes = 0;
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
      try {
        await res.body?.cancel();
      } catch {
      }
    }
    clearTimeout(timer);
    return {
      url,
      ok: true,
      status: res.status,
      ttfb,
      total: Date.now() - started,
      bytes,
      keywordHit
    };
  } catch (err) {
    clearTimeout(timer);
    const elapsed = Date.now() - started;
    return {
      url,
      ok: false,
      status: 0,
      error: zhError(err && err.name || err),
      ttfb: elapsed,
      total: elapsed,
      bytes: 0
    };
  }
}
__name(probeDirect, "probeDirect");
var CONCURRENCY = 5;
async function runAllDirect(items, timeoutMs) {
  const list = items.map(
    (it) => typeof it === "string" ? { url: normalizeUrl(it), keyword: null } : it
  );
  const out = [];
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const batch = list.slice(i, i + CONCURRENCY);
    out.push(
      ...await Promise.all(
        batch.map((it) => probeDirect(normalizeUrl(it.url), timeoutMs, it.keyword))
      )
    );
  }
  return out;
}
__name(runAllDirect, "runAllDirect");
var SSL_WARN_DAYS = 14;
function judge(site, r) {
  if (!r || r.ok === false) return { ok: false, reason: r?.error || "\u8BF7\u6C42\u5931\u8D25" };
  const codes = String(site.expect_codes || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const okCode = codes.length ? codes.includes(r.status) : r.status >= 200 && r.status < 400;
  if (!okCode) return { ok: false, reason: `\u72B6\u6001\u7801 ${r.status} \u4E0D\u5728\u671F\u671B\u96C6\u5408` };
  if (site.keyword && r.keywordHit === false) {
    return { ok: false, reason: `\u6B63\u6587\u672A\u5305\u542B\u5173\u952E\u5B57 "${site.keyword}"` };
  }
  return { ok: true, reason: null };
}
__name(judge, "judge");
async function gpCreate(env, site) {
  const token = env && env.GLOBALPING_TOKEN;
  const u = new URL(normalizeUrl(site.url));
  const magic = site.gp_magic || env && env.GP_MAGIC || "CN+datacenter-network";
  const limit = Number(env && env.GP_LIMIT || 1);
  const protocol = u.protocol === "http:" ? "HTTP" : "HTTPS";
  const port = u.port ? Number(u.port) : protocol === "HTTP" ? 80 : 443;
  const ipVersion = String((env && env.GP_IP_VERSION) ?? "4");
  const ipOpt = isIpAddress(u.hostname) || !ipVersion ? {} : { ipVersion: Number(ipVersion) };
  const res = await fetch("https://api.globalping.io/v1/measurements", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...token ? { Authorization: `Bearer ${token}` } : {}
    },
    body: JSON.stringify({
      type: "http",
      target: u.hostname,
      // ⚠️ 不能带 scheme
      locations: [{ magic }],
      limit,
      measurementOptions: {
        protocol,
        port,
        request: {
          method: "GET",
          // 保留原 URL 的路径与查询串 —— 否则 /health 这类检查会被测成首页
          path: u.pathname || "/",
          ...u.search ? { query: u.search } : {}
        },
        ...ipOpt
      }
    })
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
      remaining: res.headers.get("x-ratelimit-remaining")
    }
  };
}
__name(gpCreate, "gpCreate");
async function gpCollect(env, pending) {
  const token = env && env.GLOBALPING_TOKEN;
  const res = await fetch(
    `https://api.globalping.io/v1/measurements/${pending.measurement_id}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} }
  );
  const d = await res.json();
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
      error: rr.status !== "finished" ? String(rr.status) : null,
      probe: `${p.city || "?"}/${p.asn || "?"}`
    };
  });
  return { done: true, results, status: d.status };
}
__name(gpCollect, "gpCollect");
async function gpSslCheck(env, site) {
  const token = env && env.GLOBALPING_TOKEN;
  const u = new URL(normalizeUrl(site.url));
  if (u.protocol !== "https:") {
    return { error: "\u975E HTTPS \u7AD9\u70B9\uFF0C\u8DF3\u8FC7\u8BC1\u4E66\u68C0\u6D4B" };
  }
  const magic = env && env.GP_SSL_MAGIC || env && env.GP_MAGIC || "CN+datacenter-network";
  const H = {
    "Content-Type": "application/json",
    ...token ? { Authorization: `Bearer ${token}` } : {}
  };
  const created = await (await fetch("https://api.globalping.io/v1/measurements", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      type: "http",
      target: u.hostname,
      locations: [{ magic }],
      limit: 1,
      measurementOptions: {
        protocol: "HTTPS",
        port: u.port ? Number(u.port) : 443,
        // 用 GET 而不是 HEAD：实测 HEAD 时 Globalping 返回的 tls 对象不完整
        // （缺 issuer / protocol），GET 才是完整的证书信息
        request: { method: "GET", path: u.pathname || "/" }
      }
    })
  })).json();
  if (!created || !created.id) {
    return { error: "globalping create failed: " + JSON.stringify(created).slice(0, 150) };
  }
  const deadline = Date.now() + 25e3;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2e3));
    const d = await (await fetch(`https://api.globalping.io/v1/measurements/${created.id}`, { headers: H })).json();
    if (d.status !== "finished" && d.status !== "failed") continue;
    const r0 = (d.results || [])[0] || {};
    const rr = r0.result || {};
    const tls = rr.tls;
    if (!tls) {
      return { error: `\u65E0 TLS \u4FE1\u606F\uFF08\u63A2\u6D4B\u72B6\u6001 ${rr.status || d.status}\uFF09` };
    }
    const daysLeft = tls.expiresAt ? Math.floor((new Date(tls.expiresAt).getTime() - Date.now()) / 864e5) : null;
    return {
      authorized: tls.authorized ? 1 : 0,
      protocol: tls.protocol || null,
      issuer: [tls.issuer?.O, tls.issuer?.CN].filter(Boolean).join(" / ") || null,
      subject: tls.subject?.CN || null,
      key_type: tls.keyType ? `${tls.keyType} ${tls.keyBits || ""}`.trim() : null,
      expires_at: tls.expiresAt || null,
      days_left: daysLeft,
      probe: `${r0.probe?.city || "?"}/${r0.probe?.asn || "?"}`
    };
  }
  return { error: "SSL \u68C0\u6D4B\u8D85\u65F6" };
}
__name(gpSslCheck, "gpSslCheck");

// src/prober.js
var UA2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var Prober = class extends DurableObject {
  static {
    __name(this, "Prober");
  }
  /**
   * 自报执行位置。
   * 用 Cloudflare 自家的 cdn-cgi/trace 读 colo= 比 IP 地理定位可信 ——
   * DO 的出口是 Cloudflare 自己的 IPv6 段，第三方 IP 库常误判成美国。
   */
  async egress() {
    const out = { colo: null, ip: null, geo: null };
    try {
      const r = await fetch("https://www.cloudflare.com/cdn-cgi/trace");
      const text = await r.text();
      const colo = text.match(/^colo=(\S+)/m);
      if (colo) out.colo = colo[1];
      const ip = text.match(/^ip=(\S+)/m);
      if (ip) out.ip = ip[1];
    } catch (e) {
      out.traceError = String(e && e.message || e);
    }
    try {
      const r2 = await fetch("https://myip.ipip.net", {
        headers: { "User-Agent": UA2 }
      });
      if (r2.ok) out.geo = (await r2.text()).trim().replace(/\s+/g, " ").slice(0, 120);
    } catch {
    }
    return out;
  }
  /** 执行一批探测，返回 { egress, results, wall }。items 可为 url 字符串或 {url, keyword} */
  async run(items, timeoutMs) {
    const started = Date.now();
    const egress = await this.egress();
    const results = await runAllDirect(items, timeoutMs);
    return { egress, results, wall: Date.now() - started };
  }
  /**
   * 主动终止 DO 实例，避免它常驻内存持续计 duration 费
   * （免费额度 13,000 GB-s/天。DO 只要活跃/不可休眠就按 wall-clock 计费）
   *
   * ⚠️ 这是 hack：借助「在 blockConcurrencyWhile 里抛错会终止实例」这一运行时行为，
   *    并非文档承诺的 API。UptimeFlare 用的是同一手法，注释同样标为副作用。
   *    终止不影响 DO 的位置 —— 位置是持久化的，下次 get() 仍在原机房，只是要冷启动。
   */
  async kill() {
    this.ctx.blockConcurrencyWhile(async () => {
      throw "killed";
    });
  }
};

// src/auth.js
var encoder = new TextEncoder();
function constantTimeEqual(a, b) {
  const ab = encoder.encode(String(a ?? ""));
  const bb = encoder.encode(String(b ?? ""));
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
__name(constantTimeEqual, "constantTimeEqual");
function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}
__name(toHex, "toHex");
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
__name(fromHex, "fromHex");
function randomHex(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}
__name(randomHex, "randomHex");
var PBKDF2_ITERATIONS = 5e3;
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
__name(derivePbkdf2, "derivePbkdf2");
async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hex = await derivePbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${toHex(salt)}$${hex}`;
}
__name(hashPassword, "hashPassword");
async function verifyPasswordHash(input, stored) {
  if (typeof stored !== "string" || stored.length === 0) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1e3 || iterations > 1e5) return false;
  const salt = fromHex(parts[2]);
  const expected = fromHex(parts[3]);
  if (!salt || salt.length < 8 || !expected || expected.length !== 32) return false;
  const actual = await derivePbkdf2(input ?? "", salt, iterations);
  return constantTimeEqual(actual, parts[3].toLowerCase());
}
__name(verifyPasswordHash, "verifyPasswordHash");
function b64urlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(b64urlEncode, "b64urlEncode");
function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - s.length % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
__name(b64urlToBytes, "b64urlToBytes");
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
__name(hmacBytes, "hmacBytes");
async function signSession(payload, secret) {
  const p = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = await hmacBytes(secret, p);
  return `${p}.${b64urlEncode(sig)}`;
}
__name(signSession, "signSession");
async function issueSession(secret, maxAgeSec, now = Date.now()) {
  const iat = Math.floor(now / 1e3);
  return signSession({ sub: "admin", iat, exp: iat + maxAgeSec }, secret);
}
__name(issueSession, "issueSession");
async function verifySession(token, secret) {
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
  if (payload.exp * 1e3 < Date.now()) return null;
  return payload;
}
__name(verifySession, "verifySession");
var SESSION_COOKIE = "uptime_admin";
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
__name(parseCookies, "parseCookies");
function getSessionToken(cookieHeader) {
  return parseCookies(cookieHeader)[SESSION_COOKIE] ?? null;
}
__name(getSessionToken, "getSessionToken");
function buildSessionCookie(token, maxAge, secure = true) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
__name(buildSessionCookie, "buildSessionCookie");
function clearSessionCookie(secure = true) {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
__name(clearSessionCookie, "clearSessionCookie");
function createRateLimiter(maxPerMinute, windowMs = 6e4) {
  const buckets = /* @__PURE__ */ new Map();
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
      if (key === void 0) buckets.clear();
      else buckets.delete(key);
    }
  };
}
__name(createRateLimiter, "createRateLimiter");
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
__name(sleep, "sleep");

// src/index.js
var JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
var READ_CACHE = "public, s-maxage=30, stale-while-revalidate=120";
var json = /* @__PURE__ */ __name((o, status = 200, cache = "no-store", pretty = false) => new Response(pretty ? JSON.stringify(o, null, 2) : JSON.stringify(o), {
  status,
  headers: { ...JSON_HEADERS, "Cache-Control": cache }
}), "json");
async function withEdgeCache(request, ctx, ttl, producer, keyUrl) {
  const key = new Request(keyUrl || request.url, { method: "GET" });
  const cache = caches.default;
  try {
    const hit = await cache.match(key);
    if (hit) {
      const text2 = await hit.text();
      return new Response(text2, {
        status: 200,
        headers: {
          ...JSON_HEADERS,
          "Cache-Control": `public, s-maxage=${ttl}`,
          "x-edge-cache": "HIT"
        }
      });
    }
  } catch {
  }
  const res = await producer();
  const text = await res.text();
  const headers = {
    ...JSON_HEADERS,
    "Cache-Control": `public, s-maxage=${ttl}`
  };
  try {
    await cache.put(key, new Response(text, { status: 200, headers }));
  } catch {
  }
  return new Response(text, { status: 200, headers: { ...headers, "x-edge-cache": "MISS" } });
}
__name(withEdgeCache, "withEdgeCache");
async function configVersion(env) {
  try {
    const d = await db(env);
    const r = await d.prepare("SELECT value FROM meta WHERE key = 'config_version'").first();
    return r && r.value ? String(r.value) : "0";
  } catch {
    return "0";
  }
}
__name(configVersion, "configVersion");
async function bumpConfigVersion(env) {
  try {
    const d = await db(env);
    await d.prepare(
      "INSERT INTO meta (key, value) VALUES ('config_version', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
    ).run();
  } catch {
  }
}
__name(bumpConfigVersion, "bumpConfigVersion");
async function purgeOverview(request) {
  try {
    const u = new URL(request.url);
    await Promise.all(
      [`${u.origin}/api/overview`, `${u.origin}/?api=overview`].map(
        (k) => caches.default.delete(new Request(k, { method: "GET" }))
      )
    );
  } catch {
  }
}
__name(purgeOverview, "purgeOverview");
async function buildAdminPayload(env) {
  const d = await db(env);
  const [sitesRes, lastsRes, cats, sslRes] = await Promise.all([
    d.prepare("SELECT * FROM sites ORDER BY sort, id").all(),
    d.prepare(
      `WITH last AS (
           SELECT site, ok, status, ttfb_ms, source, probe, ts,
                  ROW_NUMBER() OVER (PARTITION BY site ORDER BY ts DESC) rn
           FROM checks
         )
         SELECT site, ok, status, ttfb_ms, source, probe, ts FROM last WHERE rn = 1`
    ).all(),
    buildCategories(d),
    // ⚠️ 只读已有证书结果，绝不在渲染路径上触发检测。
    //    SSL 检测走 Globalping，单站点约 13 个子请求、耗时数秒 —— 若放在这里，
    //    每次打开后台、每次轮询都会触发，既拖慢加载也白白消耗额度。
    //    检测由 cron（每轮 SSL_PER_TICK 个）与用户手动点「刷新证书」负责。
    d.prepare("SELECT * FROM ssl").all()
  ]);
  const lastMap = Object.fromEntries((lastsRes.results || []).map((r) => [r.site, r]));
  const sslMap = Object.fromEntries((sslRes.results || []).map((r) => [r.site, r]));
  const sites = (sitesRes.results || []).map((s) => ({
    ...s,
    resolved_kind: resolveKind(s, env),
    cf_hint_resolved: cfHintOf(s, env),
    last_ok: lastMap[s.id]?.ok ?? null,
    last_status: lastMap[s.id]?.status ?? null,
    last_ttfb: lastMap[s.id]?.ttfb_ms ?? null,
    last_source: lastMap[s.id]?.source ?? null,
    last_probe: lastMap[s.id]?.probe ?? null,
    last_ts: lastMap[s.id]?.ts ?? null
  }));
  return {
    sites,
    categories: cats,
    ssl: sslMap,
    default_kind: env && env.PROBE_MODE || "auto",
    has_globalping_token: Boolean(env && env.GLOBALPING_TOKEN)
  };
}
__name(buildAdminPayload, "buildAdminPayload");
function isCleanupWindow(now = /* @__PURE__ */ new Date()) {
  return now.getUTCHours() === 3 && now.getUTCMinutes() < 5;
}
__name(isCleanupWindow, "isCleanupWindow");
function resolveKind(site, env) {
  const mode = (site.probe_kind || env && env.PROBE_MODE || "auto").toLowerCase();
  const hasGp = Boolean(env && env.GLOBALPING_TOKEN);
  if (mode === "globalping") return "globalping";
  if (mode === "cf") return "cf";
  return hasGp ? "globalping" : "cf";
}
__name(resolveKind, "resolveKind");
function cfHintOf(site, env) {
  const h = site.cf_hint || env && env.CF_HINT || "apac";
  return REGION_GROUPS.includes(h) ? h : "apac";
}
__name(cfHintOf, "cfHintOf");
function stateOf(s, env) {
  const ssl = s.ssl_checked_ts ? {
    valid: s.ssl_authorized === 1 && (s.ssl_days_left === null || s.ssl_days_left > 0),
    authorized: s.ssl_authorized === 1,
    protocol: s.ssl_protocol,
    issuer: s.ssl_issuer,
    subject: s.ssl_subject,
    key_type: s.ssl_key_type,
    expires_at: s.ssl_expires_at,
    days_remaining: s.ssl_days_left,
    checked_ts: s.ssl_checked_ts,
    error: s.ssl_error
  } : null;
  let state = s.last_ok === 1 ? "up" : s.last_ok === 0 ? "down" : "unknown";
  let degrade_reason = null;
  if (state !== "down") {
    const timeoutMs = Number(env && env.TIMEOUT_MS || 8e3);
    const warnDays = Number(env && env.SSL_WARN_DAYS || SSL_WARN_DAYS);
    if (ssl && !ssl.error && ssl.valid === false) {
      state = "degraded";
      degrade_reason = "\u8BC1\u4E66\u65E0\u6548";
    } else if (ssl && ssl.days_remaining !== null && ssl.days_remaining !== void 0 && ssl.days_remaining <= warnDays) {
      state = "degraded";
      degrade_reason = `\u8BC1\u4E66\u5269\u4F59 ${ssl.days_remaining} \u5929`;
    } else if ((s.last_ttfb || 0) > timeoutMs * 0.5) {
      state = "degraded";
      degrade_reason = `\u54CD\u5E94\u504F\u6162 ${s.last_ttfb}ms`;
    }
  }
  return { state, degrade_reason, ssl };
}
__name(stateOf, "stateOf");
function bucketFor(hours) {
  if (hours <= 6) return { sec: 300, label: "5 \u5206\u949F" };
  if (hours <= 24) return { sec: 900, label: "15 \u5206\u949F" };
  if (hours <= 72) return { sec: 3600, label: "1 \u5C0F\u65F6" };
  if (hours <= 168) return { sec: 7200, label: "2 \u5C0F\u65F6" };
  return { sec: 43200, label: "12 \u5C0F\u65F6" };
}
__name(bucketFor, "bucketFor");
var SETTING_KEYS = [
  "default_theme",
  // auto | light | dark —— 前台默认主题
  "site_title",
  // 前台标题
  "probe_mode",
  // auto | cf | globalping
  "cf_hint",
  // CF 默认区域组
  "gp_magic",
  // Globalping 默认位置筛选
  "gp_ssl_magic",
  // SSL 检测用的筛选（与站点筛选解耦）
  "gp_limit",
  // 每次测量的探测点数（每个算 1 次额度）
  "gp_ip_version",
  // Globalping 使用的 IP 版本：4 | 6
  "timeout_ms",
  // 单次探测超时
  "ssl_per_tick",
  // 每轮 cron 补充检测几个站点的 SSL
  "ssl_warn_days",
  // 证书剩余 ≤ N 天判为降级
  "subreq_budget",
  // 单次调用的子请求预算（免费层上限 50，留余量）
  "check_keep_days",
  // 探测明细保留天数（过期由 cron 每天清理一次）
  "alert_webhook",
  // 告警 Webhook
  "globalping_token"
  // Globalping token（只在后台可写，读取时脱敏）
];
async function effectiveEnv(env, S) {
  const s = S || await loadSettings(env);
  const pick = /* @__PURE__ */ __name((k, fallback) => s[k] !== void 0 && s[k] !== "" ? s[k] : env[k] || fallback, "pick");
  return Object.assign({}, env, {
    GLOBALPING_TOKEN: pick("globalping_token", ""),
    PROBE_MODE: pick("probe_mode", "auto"),
    CF_HINT: pick("cf_hint", "apac"),
    GP_MAGIC: pick("gp_magic", "CN+datacenter-network"),
    GP_SSL_MAGIC: pick("gp_ssl_magic", "CN+datacenter-network"),
    GP_LIMIT: pick("gp_limit", "1"),
    GP_IP_VERSION: pick("gp_ip_version", "4"),
    TIMEOUT_MS: pick("timeout_ms", "8000"),
    SSL_PER_TICK: pick("ssl_per_tick", "2"),
    SSL_WARN_DAYS: pick("ssl_warn_days", "14"),
    SUBREQ_BUDGET: pick("subreq_budget", "30"),
    CHECK_KEEP_DAYS: pick("check_keep_days", "30"),
    ALERT_WEBHOOK: pick("alert_webhook", "")
  });
}
__name(effectiveEnv, "effectiveEnv");
async function sessionSecret(env, S) {
  if (env.ADMIN_SECRET) return env.ADMIN_SECRET;
  const s = S || await loadSettings(env);
  if (s.session_secret) return s.session_secret;
  const hex = randomHex(32);
  await saveSetting(env, "session_secret", hex);
  return hex;
}
__name(sessionSecret, "sessionSecret");
function maskToken(v) {
  const t = String(v || "");
  if (!t) return "";
  if (t.length <= 10) return "****";
  return `${t.slice(0, 4)}****${t.slice(-4)}`;
}
__name(maskToken, "maskToken");
var loginLimiter = createRateLimiter(5, 6e4);
var LOGIN_MAX_FAILS = 8;
var LOGIN_WINDOW_MS = 6e4;
function loginBlocked(raw) {
  const start = Number(raw.login_fail_window || 0);
  const count = Number(raw.login_fail_count || 0);
  if (!start || Date.now() - start >= LOGIN_WINDOW_MS) return false;
  return count >= LOGIN_MAX_FAILS;
}
__name(loginBlocked, "loginBlocked");
async function recordLoginFail(env, raw) {
  const now = Date.now();
  const start = Number(raw.login_fail_window || 0);
  const fresh = !start || now - start >= LOGIN_WINDOW_MS;
  const count = fresh ? 1 : Number(raw.login_fail_count || 0) + 1;
  await Promise.all([
    saveSetting(env, "login_fail_window", String(fresh ? now : start)),
    saveSetting(env, "login_fail_count", String(count))
  ]);
}
__name(recordLoginFail, "recordLoginFail");
async function clearLoginFail(env) {
  await Promise.all([
    saveSetting(env, "login_fail_window", ""),
    saveSetting(env, "login_fail_count", "")
  ]);
}
__name(clearLoginFail, "clearLoginFail");
var SESSION_TTL = 30 * 86400;
var ENV_FOR = {
  probe_mode: "PROBE_MODE",
  cf_hint: "CF_HINT",
  gp_magic: "GP_MAGIC",
  gp_ssl_magic: "GP_SSL_MAGIC",
  gp_limit: "GP_LIMIT",
  gp_ip_version: "GP_IP_VERSION",
  timeout_ms: "TIMEOUT_MS",
  ssl_per_tick: "SSL_PER_TICK",
  ssl_warn_days: "SSL_WARN_DAYS",
  subreq_budget: "SUBREQ_BUDGET",
  check_keep_days: "CHECK_KEEP_DAYS",
  alert_webhook: "ALERT_WEBHOOK",
  globalping_token: "GLOBALPING_TOKEN"
};
function effectiveSettingValue(env, raw, k) {
  if (k === "default_theme") return raw.default_theme || "auto";
  if (k === "site_title") return raw.site_title || "\u7AD9\u70B9\u72B6\u6001";
  const ek = ENV_FOR[k];
  return ek ? env[ek] || "" : "";
}
__name(effectiveSettingValue, "effectiveSettingValue");
function publicSettings(env, raw) {
  const s = {};
  for (const k of SETTING_KEYS) s[k] = effectiveSettingValue(env, raw, k);
  s.globalping_token = "";
  s.globalping_token_masked = maskToken(env.GLOBALPING_TOKEN);
  s.has_globalping_token = Boolean(env.GLOBALPING_TOKEN);
  s.password_source = env.ADMIN_PASSWORD ? "env" : raw.admin_password ? "db" : "none";
  return s;
}
__name(publicSettings, "publicSettings");
async function sendAlerts(env, alerts) {
  const hook = env && env.ALERT_WEBHOOK;
  if (!hook || !alerts.length) return null;
  const lines = alerts.map(
    (a) => `[${a.kind === "down" ? "\u6545\u969C" : "\u6062\u590D"}] ${a.site} \u2014 \u8FDE\u7EED ${a.failCount} \u6B21${a.kind === "down" ? "\u5931\u8D25" : "\u6B63\u5E38"}${a.info.status ? ` \xB7 \u72B6\u6001\u7801 ${a.info.status}` : ""}${a.info.reason ? ` \xB7 ${a.info.reason}` : ""}`
  );
  try {
    const r = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: lines.join("\n"),
        alerts: alerts.map((a) => ({ ...a, info: void 0 }))
      })
    });
    const stamp = (/* @__PURE__ */ new Date()).toISOString();
    const d = await db(env);
    for (const a of alerts) {
      await d.prepare("UPDATE state SET last_alert_ts = ? WHERE site = ?").bind(stamp, a.site).run();
    }
    return { sent: alerts.length, status: r.status };
  } catch (e) {
    return { sent: 0, error: String(e && e.message || e) };
  }
}
__name(sendAlerts, "sendAlerts");
async function probeViaCf(env, hint, list, timeoutMs) {
  const stub = env.PROBER.get(env.PROBER.idFromName(`prober-${hint}`), {
    locationHint: hint
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
    }
  }
  return {
    colo: out.egress && out.egress.colo || hint,
    egress: out.egress,
    results: out.results,
    wall: out.wall
  };
}
__name(probeViaCf, "probeViaCf");
async function collectGlobalping(env) {
  const d = await db(env);
  const { results: pending } = await d.prepare("SELECT * FROM pending").all();
  if (!pending || !pending.length) return { collected: 0, rows: [] };
  const sites = await loadSites(env);
  const byId = Object.fromEntries(sites.map((s) => [s.id, s]));
  const rows = [];
  const perSite = {};
  const doneIds = [];
  for (const p of pending) {
    let out;
    try {
      out = await gpCollect(env, p);
    } catch (e) {
      doneIds.push(p.site);
      continue;
    }
    if (!out.done) continue;
    doneIds.push(p.site);
    const site = byId[p.site];
    if (!site) continue;
    const good = out.results.filter((r) => r.ok);
    const probeLabel = good.map((r) => r.probe).join(",") || null;
    const best = good.sort((a, b) => (a.ttfb || 1e9) - (b.ttfb || 1e9))[0] || out.results[0];
    const v = judge(site, best);
    rows.push({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      site: p.site,
      source: p.source,
      probe: probeLabel,
      ok: v.ok,
      status: best?.status ?? 0,
      ttfb_ms: best?.ttfb ?? 0,
      total_ms: best?.total ?? 0,
      error: v.reason
    });
    perSite[p.site] = {
      ok: v.ok,
      status: best?.status ?? 0,
      reason: v.reason,
      threshold: Number(site.fail_threshold || 3),
      source: p.source,
      probe: probeLabel
    };
  }
  if (rows.length) await insertChecks(env, rows);
  for (const s of doneIds) {
    await d.prepare("DELETE FROM pending WHERE site = ?").bind(s).run();
  }
  const alerts = await bumpState(env, perSite);
  const alertResult = await sendAlerts(env, alerts);
  return { collected: rows.length, rows, alerts, alertResult };
}
__name(collectGlobalping, "collectGlobalping");
async function dispatch(env, sites) {
  const budget = Number(env && env.SUBREQ_BUDGET || 30);
  const timeoutMs = Number(env && env.TIMEOUT_MS || 8e3);
  const d = await db(env);
  let used = 0;
  const started = [];
  const skipped = [];
  const { results: pend } = await d.prepare("SELECT site FROM pending").all();
  const pendingSet = new Set((pend || []).map((p) => p.site));
  const cfSites = [];
  const gpSites = [];
  for (const s of sites) {
    if (pendingSet.has(s.id)) continue;
    (resolveKind(s, env) === "globalping" ? gpSites : cfSites).push(s);
  }
  const cfResult = {};
  if (cfSites.length) {
    const groups = {};
    for (const s of cfSites) {
      const h = cfHintOf(s, env);
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
          cfResult[s.id] = { error: String(e && e.message || e), hint };
        });
      }
    }
  }
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
      await d.prepare(
        "INSERT OR REPLACE INTO pending (site, measurement_id, source, created_ts) VALUES (?,?,?,?)"
      ).bind(s.id, id, source, (/* @__PURE__ */ new Date()).toISOString()).run();
      gpStarted.push({ site: s.id, id, source, quota });
    } catch (e) {
      const msg = String(e && e.message || e);
      gpStarted.push({ site: s.id, error: msg });
      gpFailed.push({ site: s, err: msg });
    }
  }
  const fellBack = [];
  if (gpFailed.length) {
    const groups = {};
    for (const { site } of gpFailed) {
      const h = cfHintOf(site, env);
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
            error: String(e && e.message || e),
            hint,
            fallback: true
          };
        });
      }
    }
  }
  return { used, started, gpStarted, fellBack, skipped, cfResult };
}
__name(dispatch, "dispatch");
async function persistCf(env, sites, cfResult) {
  const rows = [];
  const perSite = {};
  for (const s of sites) {
    const hit = cfResult[s.id];
    if (!hit) continue;
    if (hit.error) {
      rows.push({
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        site: s.id,
        source: hit.fallback ? `cf:fallback-${hit.hint}` : `cf:${hit.hint}`,
        probe: null,
        ok: false,
        status: 0,
        ttfb_ms: 0,
        total_ms: 0,
        error: hit.error
      });
      perSite[s.id] = {
        ok: false,
        reason: hit.error,
        threshold: Number(s.fail_threshold || 3)
      };
      continue;
    }
    const r = hit.result;
    const v = judge(s, r);
    const src = hit.fallback ? `cf:fallback-${hit.hint}` : `cf:${hit.hint}`;
    rows.push({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      site: s.id,
      source: src,
      probe: hit.colo,
      ok: v.ok,
      status: r.status ?? 0,
      ttfb_ms: r.ttfb ?? 0,
      total_ms: r.total ?? 0,
      error: v.reason
    });
    perSite[s.id] = {
      ok: v.ok,
      status: r.status ?? 0,
      reason: v.reason,
      threshold: Number(s.fail_threshold || 3),
      source: src,
      probe: hit.colo
    };
  }
  if (rows.length) await insertChecks(env, rows);
  const alerts = await bumpState(env, perSite);
  const alertResult = await sendAlerts(env, alerts);
  return { persisted: rows.length, rows, alerts, alertResult };
}
__name(persistCf, "persistCf");
async function refreshSslStale(env, sites, { force = false, maxAgeH = 24, limit = 2 } = {}) {
  const d = await db(env);
  const done = [];
  for (const s of sites) {
    if (done.length >= limit) break;
    const cur = await d.prepare("SELECT * FROM ssl WHERE site = ?").bind(s.id).first();
    const fresh = cur && cur.checked_ts && Date.now() - new Date(cur.checked_ts).getTime() < maxAgeH * 3600 * 1e3;
    if (fresh && !force) continue;
    let r;
    try {
      r = await gpSslCheck(env, s);
    } catch (e) {
      r = { error: String(e && e.message || e) };
    }
    await saveSsl(env, s.id, r);
    done.push({ site: s.id, ...r });
  }
  return done;
}
__name(refreshSslStale, "refreshSslStale");
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/([a-zA-Z_]+)\/?$/);
    const api = m ? m[1] : "";
    const pretty = url.searchParams.get("pretty") === "1";
    const rawSettings = await loadSettings(env);
    const pwdConfigured = Boolean(rawSettings.admin_password || env.ADMIN_PASSWORD);
    let authed = false;
    if (!pwdConfigured) {
      authed = true;
    } else {
      const token = getSessionToken(request.headers.get("cookie"));
      if (token) {
        authed = Boolean(await verifySession(token, await sessionSecret(env, rawSettings)));
      }
    }
    env = await effectiveEnv(env, rawSettings);
    const PUBLIC_APIS = /* @__PURE__ */ new Set(["overview", "site", "login", "logout"]);
    if (pwdConfigured && !PUBLIC_APIS.has(api) && !authed) {
      return json(
        { ok: false, error: "\u672A\u767B\u5F55\u6216\u4F1A\u8BDD\u5DF2\u8FC7\u671F", need_login: true },
        401,
        "no-store",
        pretty
      );
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      await Promise.all([bumpConfigVersion(env), purgeOverview(request)]);
    }
    try {
      if (api === "login") {
        if (request.method !== "POST") {
          return json({ ok: false, error: "\u4EC5\u652F\u6301 POST" }, 405, "no-store", pretty);
        }
        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        if (!loginLimiter.check(ip)) {
          return json(
            { ok: false, error: "\u5C1D\u8BD5\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7 1 \u5206\u949F\u540E\u518D\u8BD5" },
            429,
            "no-store",
            pretty
          );
        }
        if (loginBlocked(rawSettings)) {
          return json(
            { ok: false, error: `\u5931\u8D25\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7 ${LOGIN_WINDOW_MS / 1e3} \u79D2\u540E\u518D\u8BD5` },
            429,
            "no-store",
            pretty
          );
        }
        const body = await request.json().catch(() => ({}));
        const input = String(body.password || "");
        let pass = false;
        if (env.ADMIN_PASSWORD) {
          pass = constantTimeEqual(input, env.ADMIN_PASSWORD);
        } else if (rawSettings.admin_password) {
          pass = await verifyPasswordHash(input, rawSettings.admin_password);
        }
        if (!pass) {
          await recordLoginFail(env, rawSettings);
          await sleep(300);
          return json({ ok: false, error: "\u5BC6\u7801\u9519\u8BEF" }, 401, "no-store", pretty);
        }
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
            "Set-Cookie": buildSessionCookie(token, SESSION_TTL, true)
          }
        });
      }
      if (api === "logout") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            ...JSON_HEADERS,
            "Cache-Control": "no-store",
            "Set-Cookie": clearSessionCookie(true)
          }
        });
      }
      if (api === "settings") {
        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const saved = [];
          for (const k of SETTING_KEYS) {
            if (!(k in body)) continue;
            const v = body[k];
            if (k === "globalping_token" && (v === "__KEEP__" || v === null || v === void 0)) {
              continue;
            }
            await saveSetting(env, k, v === null ? "" : String(v).trim());
            saved.push(k);
          }
          if (body.clear_globalping_token) {
            await saveSetting(env, "globalping_token", "");
            saved.push("globalping_token:cleared");
          }
          let newCookie = null;
          if (body.new_password) {
            const pwd = String(body.new_password);
            if (pwd.length < 6) {
              return json({ ok: false, error: "\u5BC6\u7801\u81F3\u5C11 6 \u4F4D" }, 400, "no-store", pretty);
            }
            await saveSetting(env, "admin_password", await hashPassword(pwd));
            await saveSetting(env, "session_secret", randomHex(32));
            const fresh = await loadSettings(env);
            const token = await issueSession(await sessionSecret(env, fresh), SESSION_TTL);
            newCookie = buildSessionCookie(token, SESSION_TTL, true);
            saved.push("admin_password");
          }
          if (body.remove_password) {
            await saveSetting(env, "admin_password", "");
            saved.push("admin_password:removed");
          }
          await bumpConfigVersion(env);
          const headers = { ...JSON_HEADERS, "Cache-Control": "no-store" };
          if (newCookie) headers["Set-Cookie"] = newCookie;
          return new Response(JSON.stringify({ ok: true, saved }), { status: 200, headers });
        }
        return json(
          {
            ok: true,
            authed,
            password_configured: pwdConfigured,
            settings: publicSettings(env, rawSettings)
          },
          200,
          "no-store",
          pretty
        );
      }
      if (api === "overview") {
        const ver = await configVersion(env);
        const keyUrl = `${url.origin}/api/overview?days=${Number(
          url.searchParams.get("days") || 30
        )}&pretty=${pretty ? 1 : 0}&v=${ver}`;
        return await withEdgeCache(request, ctx, 30, async () => {
          const d = await db(env);
          const days = Number(url.searchParams.get("days") || 30);
          const since30 = new Date(Date.now() - days * 864e5).toISOString();
          const since24 = new Date(Date.now() - 864e5).toISOString();
          const [siteRows, dayRows, h24, u24] = await Promise.all([
            d.prepare(
              `WITH last AS (
                   SELECT site, ok, status, ttfb_ms, source, probe, ts, error,
                          ROW_NUMBER() OVER (PARTITION BY site ORDER BY ts DESC) rn
                   FROM checks
                 )
                 SELECT s.id, s.name, s.url, s.group_name, s.probe_kind, s.cf_hint,
                        s.gp_magic, s.fail_threshold, s.expect_codes, s.keyword,
                        COALESCE(st.consecutive_fail, 0) AS consecutive_fail,
                        l.ok AS last_ok, l.status AS last_status,
                        l.ttfb_ms AS last_ttfb, l.source AS last_source,
                        l.probe AS last_probe, l.ts AS last_ts, l.error AS last_error,
                        ss.authorized AS ssl_authorized, ss.protocol AS ssl_protocol,
                        ss.issuer AS ssl_issuer, ss.expires_at AS ssl_expires_at,
                        ss.days_left AS ssl_days_left, ss.checked_ts AS ssl_checked_ts,
                        ss.error AS ssl_error
                 FROM sites s
                 LEFT JOIN state st ON st.site = s.id
                 LEFT JOIN last l ON l.site = s.id AND l.rn = 1
                 LEFT JOIN ssl ss ON ss.site = s.id
                 -- \u5206\u7C7B\u987A\u5E8F\u7531 categories.sort \u51B3\u5B9A\uFF0C\u800C\u4E0D\u662F group_name \u7684\u5B57\u9762\u6392\u5E8F\u3002
                 -- \u5426\u5219"\u751F\u4EA7\u73AF\u5883"\u4F1A\u88AB\u6392\u5230"\u6D4B\u8BD5\u73AF\u5883"\u540E\u9762\uFF08\u4E2D\u6587\u7801\u70B9\u987A\u5E8F\uFF09\uFF0C\u4E0E\u76F4\u89C9\u76F8\u53CD\u3002
                 LEFT JOIN categories cat
                        ON cat.name = COALESCE(NULLIF(TRIM(s.group_name), ''), '\u672A\u5206\u7EC4')
                 WHERE s.enabled = 1
                 ORDER BY COALESCE(cat.sort, 100000), s.group_name, s.sort, s.id`
            ).all(),
            d.prepare(
              `SELECT site, date(ts, '+8 hours') AS d,
                        COUNT(*) AS n, SUM(ok) AS ok
                 FROM checks WHERE ts > ?
                 GROUP BY site, d`
            ).bind(since30).all(),
            d.prepare(
              `SELECT COUNT(*) AS n, SUM(ok) AS ok FROM checks WHERE ts > ?`
            ).bind(since24).first(),
            // 每站点近 24h 可用率（前台要显示"可用率"一列）
            d.prepare(
              `SELECT site, COUNT(*) AS n, SUM(ok) AS ok
                 FROM checks WHERE ts > ? GROUP BY site`
            ).bind(since24).all()
          ]);
          const axis = [];
          for (let i = 0; i < days; i++) {
            const t = new Date(Date.now() - i * 864e5 + 8 * 3600 * 1e3);
            axis.push(t.toISOString().slice(0, 10));
          }
          const bySite = {};
          for (const r of dayRows.results || []) {
            (bySite[r.site] = bySite[r.site] || {})[r.d] = r;
          }
          const u24map = {};
          for (const r of u24.results || []) {
            u24map[r.site] = r.n ? Math.round(Number(r.ok) / Number(r.n) * 1e3) / 10 : null;
          }
          const groups = {};
          const seen = /* @__PURE__ */ new Set();
          for (const s of siteRows.results || []) {
            const map = bySite[s.id] || {};
            const bars = axis.map((dkey) => {
              const c = map[dkey];
              if (!c || !c.n) return { d: dkey, st: "none" };
              if (c.ok >= c.n) return { d: dkey, st: "up" };
              if (c.ok === 0) return { d: dkey, st: "down" };
              return { d: dkey, st: "recovered" };
            });
            const { state, degrade_reason: degradeReason, ssl } = stateOf(s, env);
            const g = s.group_name || "\u672A\u5206\u7EC4";
            (groups[g] = groups[g] || []).push({
              id: s.id,
              name: s.name,
              url: s.url,
              probe_kind: resolveKind(s, env),
              cf_hint: cfHintOf(s, env),
              state,
              degrade_reason: degradeReason,
              last_ok: s.last_ok,
              last_status: s.last_status,
              last_ttfb: s.last_ttfb,
              last_source: s.last_source,
              last_probe: s.last_probe,
              last_ts: s.last_ts,
              last_error: s.last_error,
              consecutive_fail: s.consecutive_fail,
              uptime_24h: u24map[s.id] ?? null,
              interval_min: s.interval_min || 5,
              ssl,
              bars
            });
            seen.add(s.id);
          }
          let up = 0;
          let down = 0;
          let degraded = 0;
          let incidents = 0;
          for (const g of Object.values(groups)) {
            for (const m2 of g) {
              if (m2.state === "up") up++;
              else if (m2.state === "down") down++;
              else if (m2.state === "degraded") degraded++;
              if (Number(m2.consecutive_fail) > 0) incidents++;
            }
          }
          const total = seen.size;
          const uptime = h24 && h24.n ? Math.round(Number(h24.ok) / Number(h24.n) * 1e3) / 10 : 100;
          return json(
            {
              ok: true,
              now: (/* @__PURE__ */ new Date()).toISOString(),
              // 前台需要的展示类设置（改完靠 config_version 换缓存 key 立即生效）
              settings: {
                default_theme: rawSettings.default_theme || "auto",
                site_title: rawSettings.site_title || "\u7AD9\u70B9\u72B6\u6001"
              },
              stats: {
                total,
                up,
                down,
                degraded,
                incidents,
                uptime_24h: uptime
              },
              groups: Object.entries(groups).map(([name, monitors]) => ({ name, monitors }))
            },
            200,
            READ_CACHE,
            pretty
          );
        }, keyUrl);
      }
      if (api === "site") {
        const id = url.searchParams.get("id");
        if (!id) return json({ ok: false, error: "\u7F3A\u5C11 id \u53C2\u6570" }, 400, "no-store", pretty);
        const hoursFor = Math.max(1, Math.min(Number(url.searchParams.get("hours") || 24), 720));
        const verS = await configVersion(env);
        const keyUrl = `${url.origin}/api/site?id=${encodeURIComponent(id)}&hours=${hoursFor}&pretty=${pretty ? 1 : 0}&v=${verS}`;
        return await withEdgeCache(request, ctx, 30, async () => {
          const d = await db(env);
          const hours = Math.max(1, Math.min(Number(url.searchParams.get("hours") || 24), 720));
          const recentN = Math.max(5, Math.min(Number(url.searchParams.get("recent") || 50), 200));
          const days = Math.max(1, Math.min(Number(url.searchParams.get("days") || 30), 90));
          const since = new Date(Date.now() - hours * 3600 * 1e3).toISOString();
          const sinceD = new Date(Date.now() - days * 864e5).toISOString();
          const bkt = bucketFor(hours);
          const [meta, agg, p95, seriesRows, recentRows, changeRows, dayRows] = await Promise.all([
            // ① 配置 + 状态 + 最近一次 + SSL
            d.prepare(
              `WITH last AS (
                     SELECT ok, status, ttfb_ms, total_ms, source, probe, ts, error
                     FROM checks WHERE site = ?1 ORDER BY ts DESC LIMIT 1
                   )
                   SELECT s.id, s.name, s.url, s.group_name, s.probe_kind, s.cf_hint, s.gp_magic,
                          s.fail_threshold, s.interval_min, s.expect_codes, s.keyword,
                          s.enabled, s.sort,
                          COALESCE(st.consecutive_fail, 0) AS consecutive_fail,
                          st.last_checked_ts, st.last_ok_ts,
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
            ).bind(id).first(),
            // ② 窗口聚合
            d.prepare(
              `SELECT COUNT(*) AS n, SUM(ok) AS okl,
                          MIN(ttfb_ms) AS mn, MAX(ttfb_ms) AS mx,
                          CAST(AVG(CASE WHEN ok=1 THEN ttfb_ms END) AS INTEGER) AS av,
                          CAST(AVG(total_ms) AS INTEGER) AS av_total
                   FROM checks WHERE site = ?1 AND ts > ?2`
            ).bind(id, since).first(),
            // ③ P95 —— SQLite 无 percentile 函数，用「排序 + 偏移」取近似
            d.prepare(
              `SELECT ttfb_ms AS p95 FROM checks
                   WHERE site = ?1 AND ts > ?2 AND ok = 1
                   ORDER BY ttfb_ms
                   LIMIT 1 OFFSET (
                     SELECT CAST(COUNT(*) * 0.95 AS INTEGER) FROM checks
                     WHERE site = ?1 AND ts > ?2 AND ok = 1
                   )`
            ).bind(id, since).first(),
            // ④ 延迟时间序列（按桶聚合，桶宽随窗口自适应）
            d.prepare(
              `SELECT CAST(strftime('%s', substr(ts,1,19)) / ?2 AS INTEGER) AS b,
                          COUNT(*) AS n, SUM(ok) AS okl,
                          CAST(AVG(CASE WHEN ok=1 THEN ttfb_ms END) AS INTEGER) AS av,
                          MIN(CASE WHEN ok=1 THEN ttfb_ms END) AS mn,
                          MAX(CASE WHEN ok=1 THEN ttfb_ms END) AS mx
                   FROM checks WHERE site = ?1 AND ts > ?3
                   GROUP BY b ORDER BY b`
            ).bind(id, bkt.sec, since).all(),
            // ⑤ 最近 N 条原始检查
            d.prepare(
              `SELECT ts, ok, status, ttfb_ms, total_ms, source, probe, error
                   FROM checks WHERE site = ?1 ORDER BY ts DESC LIMIT ?2`
            ).bind(id, recentN).all(),
            // ⑥ 状态变化点 —— 只在 ok 翻转处返回，结果集极小，
            //    比取回整段序列在 Worker 里扫要省得多（30 天也能用）
            d.prepare(
              `WITH x AS (
                     SELECT ts, ok, error, LAG(ok) OVER (ORDER BY ts) AS prev
                     FROM checks WHERE site = ?1 AND ts > ?2
                   )
                   SELECT ts, ok, error FROM x
                   WHERE prev IS NULL OR ok <> prev
                   ORDER BY ts`
            ).bind(id, since).all(),
            // ⑦ 按天聚合（+8 小时对齐北京时间，与首页一致）
            d.prepare(
              `SELECT date(ts, '+8 hours') AS d, COUNT(*) AS n, SUM(ok) AS ok
                   FROM checks WHERE site = ?1 AND ts > ?2
                   GROUP BY d`
            ).bind(id, sinceD).all()
          ]);
          if (!meta) {
            return json({ ok: false, error: `\u7AD9\u70B9\u4E0D\u5B58\u5728\uFF1A${id}` }, 404, "no-store", pretty);
          }
          const { state, degrade_reason, ssl } = stateOf(meta, env);
          const n = Number(agg?.n || 0);
          const okl = Number(agg?.okl || 0);
          const intervalMin = Number(meta.interval_min || 5);
          const series = (seriesRows.results || []).map((r) => ({
            t: new Date(Number(r.b) * bkt.sec * 1e3).toISOString(),
            n: Number(r.n || 0),
            ok: Number(r.okl || 0),
            v: r.av === null || r.av === void 0 ? null : Number(r.av),
            min: r.mn,
            max: r.mx
          }));
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
          if (open) incidents.push({ ...open, end: null });
          const evts = incidents.map((e) => {
            const t0 = new Date(e.start).getTime();
            const t1 = e.end ? new Date(e.end).getTime() : Date.now();
            const duration_s = Math.max(0, Math.round((t1 - t0) / 1e3));
            return {
              start: e.start,
              end: e.end,
              ongoing: !e.end,
              duration_s,
              error: e.error,
              // 用时长估算段内检查次数，与告警口径（连续 N 次失败）对齐
              checks_est: Math.max(1, Math.round(duration_s / (intervalMin * 60)) + 1)
            };
          }).filter((e) => e.ongoing || e.checks_est >= failThreshold).reverse();
          const dayMap = {};
          for (const r of dayRows.results || []) dayMap[r.d] = r;
          const bars = [];
          for (let i = 0; i < days; i++) {
            const dkey = new Date(Date.now() - i * 864e5 + 8 * 3600 * 1e3).toISOString().slice(0, 10);
            const c = dayMap[dkey];
            bars.push({
              d: dkey,
              st: !c || !Number(c.n) ? "none" : Number(c.ok) >= Number(c.n) ? "up" : Number(c.ok) === 0 ? "down" : "recovered",
              n: c ? Number(c.n) : 0,
              ok: c ? Number(c.ok) : 0
            });
          }
          return json(
            {
              ok: true,
              now: (/* @__PURE__ */ new Date()).toISOString(),
              // 详情页也要页头品牌名一致，所以一并带上展示类设置
              settings: {
                site_title: rawSettings.site_title || "\u7AD9\u70B9\u72B6\u6001",
                default_theme: rawSettings.default_theme || "auto"
              },
              site: {
                id: meta.id,
                name: meta.name,
                url: meta.url,
                group_name: meta.group_name || "\u672A\u5206\u7EC4",
                probe_kind: resolveKind(meta, env),
                cf_hint: cfHintOf(meta, env),
                gp_magic: meta.gp_magic || null,
                expect_codes: meta.expect_codes || null,
                keyword: meta.keyword || null,
                fail_threshold: failThreshold,
                interval_min: intervalMin,
                enabled: meta.enabled,
                sort: meta.sort
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
                error: meta.last_error
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
                uptime: n ? Math.round(okl / n * 1e3) / 10 : null
              },
              latency: {
                avg: agg?.av ?? null,
                avg_total: agg?.av_total ?? null,
                min: agg?.mn ?? null,
                max: agg?.mx ?? null,
                p95: p95?.p95 ?? null
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
                error: r.error
              })),
              incidents: evts,
              bars
            },
            200,
            READ_CACHE,
            pretty
          );
        }, keyUrl);
      }
      if (api === "categories") {
        const d = await db(env);
        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const action = String(body.action || "").toLowerCase();
          const name = String(body.name || "").trim();
          if (action !== "reorder" && !name) {
            return json({ ok: false, error: "\u5206\u7C7B\u540D\u4E0D\u80FD\u4E3A\u7A7A" }, 400, "no-store", pretty);
          }
          const now = (/* @__PURE__ */ new Date()).toISOString();
          if (action === "create") {
            const exists = await d.prepare("SELECT name FROM categories WHERE name = ?").bind(name).first();
            if (exists) {
              return json({ ok: false, error: `\u5206\u7C7B\u300C${name}\u300D\u5DF2\u5B58\u5728` }, 409, "no-store", pretty);
            }
            const mx = await d.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories").first();
            await d.prepare("INSERT INTO categories (name, sort, created_ts) VALUES (?,?,?)").bind(name, Number(mx?.s || 1), now).run();
            return json({ ok: true, action, name }, 200, "no-store", pretty);
          }
          if (action === "rename") {
            const nn = String(body.new_name || "").trim();
            if (!nn) {
              return json({ ok: false, error: "\u65B0\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A" }, 400, "no-store", pretty);
            }
            if (nn === name) return json({ ok: true, action, name }, 200, "no-store", pretty);
            await d.batch([
              d.prepare("INSERT OR IGNORE INTO categories (name, sort, created_ts) VALUES (?,?,?)").bind(nn, 9999, now),
              d.prepare("UPDATE sites SET group_name = ? WHERE group_name = ?").bind(nn, name),
              d.prepare("DELETE FROM categories WHERE name = ?").bind(name)
            ]);
            return json({ ok: true, action, name, new_name: nn }, 200, "no-store", pretty);
          }
          if (action === "delete") {
            await d.batch([
              d.prepare("UPDATE sites SET group_name = ? WHERE group_name = ?").bind("\u672A\u5206\u7EC4", name),
              d.prepare("DELETE FROM categories WHERE name = ?").bind(name)
            ]);
            return json({ ok: true, action, name }, 200, "no-store", pretty);
          }
          if (action === "reorder") {
            const names = Array.isArray(body.names) ? body.names.map(String) : [];
            if (!names.length) {
              return json({ ok: false, error: "names \u4E0D\u80FD\u4E3A\u7A7A" }, 400, "no-store", pretty);
            }
            await d.batch(
              names.map(
                (n, i) => d.prepare("INSERT INTO categories (name, sort, created_ts) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET sort = excluded.sort").bind(n, i + 1, now)
              )
            );
            return json({ ok: true, action, order: names }, 200, "no-store", pretty);
          }
          return json({ ok: false, error: `\u672A\u77E5 action\uFF1A${action}` }, 400, "no-store", pretty);
        }
        return json({ ok: true, categories: await buildCategories(d) }, 200, "no-store", pretty);
      }
      if (api === "sort") {
        if (request.method !== "POST") {
          return json({ ok: false, error: "\u4EC5\u652F\u6301 POST" }, 405, "no-store", pretty);
        }
        const d = await db(env);
        const body = await request.json().catch(() => ({}));
        const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) {
          return json({ ok: false, error: "ids \u4E0D\u80FD\u4E3A\u7A7A" }, 400, "no-store", pretty);
        }
        await d.batch(
          ids.map((id, i) => d.prepare("UPDATE sites SET sort = ? WHERE id = ?").bind(i + 1, id))
        );
        return json({ ok: true, updated: ids.length }, 200, "no-store", pretty);
      }
      if (api === "sites") {
        const d = await db(env);
        if (request.method === "DELETE") {
          const id = url.searchParams.get("id");
          if (!id) return json({ ok: false, error: "\u7F3A\u5C11 id" }, 400);
          await d.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
          await d.prepare("DELETE FROM ssl WHERE site = ?").bind(id).run();
          await d.prepare("DELETE FROM state WHERE site = ?").bind(id).run();
          await d.prepare("DELETE FROM pending WHERE site = ?").bind(id).run();
          return json({ ok: true, deleted: id });
        }
        if (request.method === "POST") {
          const body = await request.json();
          const list = Array.isArray(body) ? body : [body];
          for (const s of list) {
            if (!s.id || !s.url) continue;
            await d.prepare(
              `INSERT INTO sites (id,name,url,group_name,expect_codes,keyword,probe_kind,cf_hint,gp_magic,fail_threshold,interval_min,enabled,sort)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(id) DO UPDATE SET
                   name=excluded.name, url=excluded.url,
                   group_name=excluded.group_name,
                   expect_codes=excluded.expect_codes, keyword=excluded.keyword,
                   probe_kind=excluded.probe_kind, cf_hint=excluded.cf_hint,
                   gp_magic=excluded.gp_magic, fail_threshold=excluded.fail_threshold,
                   interval_min=excluded.interval_min, enabled=excluded.enabled,
                   sort=excluded.sort`
            ).bind(
              s.id,
              s.name ?? s.id,
              normalizeUrl(s.url),
              s.group_name ?? "\u9ED8\u8BA4\u5206\u7EC4",
              s.expect_codes ?? "",
              s.keyword ?? null,
              s.probe_kind ?? null,
              s.cf_hint ?? null,
              s.gp_magic ?? null,
              Number(s.fail_threshold ?? 3),
              Number(s.interval_min ?? 5),
              s.enabled === false ? 0 : 1,
              Number(s.sort ?? 0)
            ).run();
          }
          return json({ ok: true, upserted: list.length });
        }
        return json({ ok: false, error: "\u8BF7\u7528 /api/admin" }, 405, "no-store", pretty);
      }
      if (api === "admin") {
        const payload = await buildAdminPayload(env);
        return json(
          {
            ok: true,
            ...payload,
            // 复用请求开头已读到的 rawSettings，不再多查一次 D1
            settings: publicSettings(env, rawSettings),
            password_source: rawSettings.admin_password ? "db" : env.ADMIN_PASSWORD ? "env" : "none"
          },
          200,
          "no-store",
          pretty
        );
      }
      if (api === "run") {
        const sites = await loadSites(env);
        const limit = Number(url.searchParams.get("limit") || sites.length);
        const picked = sites.slice(0, limit);
        const collect = await collectGlobalping(env);
        const disp = await dispatch(env, picked);
        const persisted = await persistCf(env, picked, disp.cfResult);
        return json({ ok: true, collect, dispatch: disp, persisted });
      }
      if (api === "test") {
        const kind = url.searchParams.get("kind") || "cf";
        const target = url.searchParams.get("target") || "https://www.baidu.com";
        const timeoutMs = Number(env && env.TIMEOUT_MS || 8e3);
        if (kind === "cf") {
          const hint = url.searchParams.get("hint") || cfHintOf({}, env);
          const multi = url.searchParams.get("targets");
          const list = multi ? multi.split(",").map((u) => u.trim()).filter(Boolean).map((u) => ({ url: u, keyword: null })) : [{ url: target, keyword: url.searchParams.get("keyword") || null }];
          const t0 = Date.now();
          const out = await probeViaCf(env, hint, list, timeoutMs);
          return json({
            ok: true,
            kind: "cf",
            hint,
            count: list.length,
            egress: out.egress,
            wall: out.wall,
            roundTripMs: Date.now() - t0,
            results: out.results
          });
        }
        const site = { url: target, gp_magic: url.searchParams.get("magic") || null };
        const { id, source, quota } = await gpCreate(env, site);
        let finished = null;
        for (let i = 0; i < 12 && !finished; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          const out = await gpCollect(env, { measurement_id: id });
          if (out.done) finished = out;
        }
        return json({ ok: true, kind: "globalping", source, quota, results: finished?.results || [] });
      }
      return json(
        {
          ok: false,
          error: `\u672A\u77E5\u63A5\u53E3\uFF1A${api || url.pathname}`,
          endpoints: [
            "GET  /api/overview  \u524D\u53F0\uFF1A\u7EDF\u8BA1 + \u5206\u7EC4 + 30 \u5929\u8272\u6761 + SSL\uFF08\u516C\u5F00\uFF0C\u8FB9\u7F18\u7F13\u5B58\uFF09",
            "GET  /api/site?id=&hours=  \u8BE6\u60C5\u9875\uFF1A\u7A97\u53E3\u7EDF\u8BA1 + \u5E8F\u5217 + \u6545\u969C\uFF08\u516C\u5F00\uFF09",
            "GET  /api/admin     \u540E\u53F0\uFF1A\u7AD9\u70B9 + \u72B6\u6001 + \u5206\u7C7B + \u8BC1\u4E66 + \u8BBE\u7F6E\uFF08\u9700\u767B\u5F55\uFF09",
            "POST /api/login  /api/logout",
            "GET/POST /api/settings",
            "GET/POST/DELETE /api/categories",
            "POST /api/sites\uFF08\u5199\uFF09\uFF1BPOST /api/sort\uFF08\u6392\u5E8F\uFF09",
            "POST /api/run  \u624B\u52A8\u8DD1\u4E00\u8F6E\uFF08\u8C03\u8BD5\uFF09\uFF1BGET /api/test  \u6D4B\u5355\u4E2A\u540E\u7AEF\uFF08\u8C03\u8BD5\uFF09"
          ]
        },
        404,
        "no-store",
        pretty
      );
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    const sites = await loadSites(env);
    const collected = await collectGlobalping(env);
    const disp = await dispatch(env, sites);
    const persisted = await persistCf(env, sites, disp.cfResult);
    let ssl = [];
    try {
      ssl = await refreshSslStale(env, sites, {
        maxAgeH: 24,
        limit: Number(env && env.SSL_PER_TICK || 2)
      });
    } catch (e) {
      ssl = [{ error: String(e && e.message || e) }];
    }
    let cleaned = 0;
    if (isCleanupWindow()) {
      try {
        cleaned = await cleanupOldChecks(env, Number(env?.CHECK_KEEP_DAYS || 30));
      } catch (e) {
        cleaned = -1;
      }
    }
    console.log(
      JSON.stringify({
        cron: controller.cron,
        sites: sites.length,
        collected: collected.collected,
        dispatched: disp.started,
        gpStarted: disp.gpStarted,
        skipped: disp.skipped,
        subrequestsUsed: disp.used,
        persisted: persisted.persisted,
        alerts: persisted.alerts.length + collected.alerts.length,
        ssl,
        cleaned
        // 0 = 不在清理时点或无过期数据；-1 = 清理失败
      })
    );
  }
};
export {
  Prober,
  index_default as default
};
//# sourceMappingURL=index.js.map

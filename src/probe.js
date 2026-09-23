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

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** locationHint 合法值（官方 region group） */
export const REGION_GROUPS = [
  "wnam", "enam", "sam", "weur", "eeur",
  "apac", "apac-ne", "apac-se",
  "oc", "afr", "me",
];

export const siteOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return String(u);
  }
};

export function normalizeUrl(u) {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/** Globalping 的 target 不能带 scheme，要单独剥出来 */
export function hostOf(u) {
  try {
    return new URL(normalizeUrl(u)).hostname;
  } catch {
    return String(u).replace(/^https?:\/\//, "").split("/")[0];
  }
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
 * 降级规则对齐参考项目：证书无效 或 剩余 ≤14 天 或 响应时间 > 超时上限的一半。
 */
export const SSL_WARN_DAYS = 14;
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
 * Globalping：发起一次测量，返回 measurement id（不等待结果）
 * 真正的探测由 Globalping 的探针执行 —— 所以调度器在哪里完全不影响探测点位置。
 * ⚠️ 额度按「探测点个数」计费，limit 越小越省（默认 1）
 */
export async function gpCreate(env, site) {
  const token = env && env.GLOBALPING_TOKEN;
  const u = new URL(normalizeUrl(site.url));
  // 位置筛选是**全局设置**（后台「设置 → 探测」）。
  // 不做成站点级的原因：一个站点只用一个后端，站点级的 CF 区域组/GP 筛选
  // 必然只有一个是活的，另一个是死配置。
  const magic = (env && env.GP_MAGIC) || "CN+datacenter-network";
  const limit = Number((env && env.GP_LIMIT) || 1);
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

/** 收取 Globalping 测量结果，转成统一结构 */
export async function gpCollect(env, pending) {
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
      probe: `${p.city || "?"}/${p.asn || "?"}`,
    };
  });
  return { done: true, results, status: d.status };
}

/* ─────────────────────────── SSL 检测 ─────────────────────────── */

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
 */
export async function gpSslCheck(env, site) {
  const token = env && env.GLOBALPING_TOKEN;
  const u = new URL(normalizeUrl(site.url));
  if (u.protocol !== "https:") {
    return { error: "非 HTTPS 站点，跳过证书检测" };
  }
  // ⚠️ 刻意**不用可用性探测的筛选**（GP_MAGIC）：
  // 可用性探测的筛选可能很窄（例如 CN+xian+eyeball-network），窄到没有探针；
  // 而 SSL 检测只需要任意一个能建立 TLS 的探针即可，用窄条件会让证书检测连带失败。
  const magic =
    (env && env.GP_SSL_MAGIC) || (env && env.GP_MAGIC) || "CN+datacenter-network";
  const H = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const created = await (
    await fetch("https://api.globalping.io/v1/measurements", {
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
          request: { method: "GET", path: u.pathname || "/" },
        },
      }),
    })
  ).json();

  if (!created || !created.id) {
    return { error: "globalping create failed: " + JSON.stringify(created).slice(0, 150) };
  }

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const d = await (
      await fetch(`https://api.globalping.io/v1/measurements/${created.id}`, { headers: H })
    ).json();
    if (d.status !== "finished" && d.status !== "failed") continue;

    const r0 = (d.results || [])[0] || {};
    const rr = r0.result || {};
    const tls = rr.tls;
    if (!tls) {
      return { error: `无 TLS 信息（探测状态 ${rr.status || d.status}）` };
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
    };
  }
  return { error: "SSL 检测超时" };
}


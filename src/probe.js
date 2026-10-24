/**
 * 探测层：全部经 Globalping 中国探针执行。
 *
 * 为什么只剩这一个后端：CF 边缘探测虽然免费且无外部依赖，但它测的是
 * 「Cloudflare 机房 -> 站点」的链路，与大陆用户的真实访问路径不是一回事 ——
 * 用它给出的延迟判断国内站点快慢，方向本身就是错的。既然目标是
 * 「尽量接近大陆访问的实际延迟」，就只能让探测从大陆发起。
 *
 * 一次 http 测量同时带回三样东西，三个监测需求共用 1 份额度：
 *   timings.total -> 延迟     statusCode -> 可用性     tls.* -> 证书
 */

import { defOf, validMagic, gpLimitNum } from "./settings.js";

export function normalizeUrl(u) {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
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

/**
 * 判定一次探测是否算"正常"
 * 规则：状态码 ∈ expect_codes（为空则接受 200-399）；有关键字则必须命中
 *
 * 注意：这里只判断 up / down 两态。第三态 **degraded（降级）** 在 /api/overview 里
 * 结合 SSL 与响应时间实时算出 —— 因为 SSL 是每天一查的数据，不该塞进 5 分钟一次的检查行里。
 * 降级规则：证书无效 或 剩余 ≤ ssl_warn_days 天 或 响应时间 > 超时上限的一半。
 * （阈值本身是后台「设置 → 探测」里的「证书降级阈值」，这里是默认 14 天的口径说明。）
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
 * 探针端墙钟超时（整数秒）。
 *
 * ⚠️ 这是**给远端探针的规定**，不是"我们愿意等多久"。
 *    Globalping 的探测跑在第三方机器上，我们本地没有任何句柄能中断它。
 *    实测中国家宽链路的失败**恰好在 15001ms** 被平台切断，压到 8s 就是主动制造失败。
 *    反过来调大同样无用：抓到的失败是 `tls: null`（握手一个字节都没回来），
 *    等 15s 和等 30s 是同一个结果，只是白占调度窗口。
 *
 * 取值必须落在 5–30（API 硬约束，越界直接 422），所以在读取侧就钳死。
 */
function gpTimeoutSec(env) {
  const dflt = Number(defOf("gp_timeout_sec"));
  const n = Number((env && env.GP_TIMEOUT_SEC) || dflt);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(30, Math.max(5, Math.round(n)));
}

/**
 * Globalping：发起一次测量，返回 measurement id（不等待结果）
 * 真正的探测由 Globalping 的探针执行 —— 所以调度器在哪里完全不影响探测点位置。
 * ⚠️ 额度按「探测点个数」计费（实测 X-Request-Cost === limit），limit 越小越省。
 *    默认 3 是为了让「多数表决」成立，成本换准确率，可在后台改。
 */
export async function gpCreate(env, site) {
  const token = env && env.GLOBALPING_TOKEN;
  const u = new URL(normalizeUrl(site.url));
  // 位置筛选是**全局设置**（后台「设置 → 探测」），不在站点上各存一份 ——
  // 所有站点共用同一条 Globalping 链路，站点级副本只会产生"N 份配置、只有一份生效"的错觉。
  // ⚠️ 这里**必须**再做一次校验，不能只依赖后台写入侧（normalizeSetting）：
  //    环境变量（wrangler.toml / Dashboard）是绕过 D1 规范化直接读的，
  //    一个写错的环境变量同样会把「所有 GP 站点」一次打死。
  const magic = validMagic(env.GP_MAGIC) || defOf("gp_magic");
  const limit = gpLimitNum(env.GP_LIMIT);
  const timeoutSec = gpTimeoutSec(env);
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
      // 顶层字段，不是 measurementOptions 的子键（那里 additionalProperties:false，错位 422）
      timeout: timeoutSec,
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

/**
 * 收取 Globalping 测量结果，转成统一结构。
 *
 * 返回契约（调用方**必须**按这三种分支处理，尤其是 broken）：
 *   { done: false }                       —— 还在跑，pending 留到下一轮
 *   { done: true, broken: true, error }   —— 结果不可用，调用方应**丢弃 pending 且不记检查记录**
 *   { done: true, results, status }       —— 正常结果
 *
 * broken 分支存在的原因：原来只判断 `status !== "finished" && !== "failed"` 就一律当成
 * "还在跑"。可测量 id 失效 / API 返回错误体时响应里**压根没有 status**，于是会永远返回
 * done:false → pending 行永不删除 → 而 dispatch 里 `if (pendingSet.has(s.id)) continue`
 * 会让该站点**永久不再被发起探测**，静默停摆且没有任何告警。
 */
/**
 * Globalping 单探针的测量状态 → 人能看懂的原因。
 *
 * 为什么不能直接透传 `result.status`：它只会给 `"failed"` / `"offline"` 这类单词，
 * 落进 `checks.error` 就是一条 **`failed`** —— 排查时完全分不清是
 * 「探针超时」还是「站点真的挂了」，而这两件事的处理方式正相反。
 *
 * 真正的原因在 `result.rawOutput` 里，实测抓到过两种截然不同的失败：
 *   `Request timed out during the TLS handshake.` —— DNS/TCP 都通，TLS 握手被概率性丢弃
 *   `read ECONNRESET`                            —— 连接已被建立后被对端重置
 * 所以这里做一次关键词翻译。**顺序有意义**：更具体的模式必须排在泛化的前面
 * （`timed out during the TLS handshake` 含 `timed out`）。
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

export function gpResultReason(rr) {
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
 * 从一次 http 测量里顺带取出证书信息 —— 这是 SSL 监测的**唯一数据来源**。
 *
 * Globalping 的 result.tls 只在 HTTPS 且握手成功时存在：
 *   { authorized, protocol, cipherName, createdAt, expiresAt, issuer:{...}, subject:{...} }
 * 证书不会 5 分钟变一次，但既然每次都免费带着，就没必要再单发一次检测请求
 * （原来那套独立检测每站点要 14 个子请求、还要自己算新鲜度和重试节奏）。
 *
 * 握手失败时 tls 为 null —— 此时返回 null，**不要**写成「证书无效」：
 * 探针没连上，我们对证书状态一无所知，谎报会让一个网络抖动变成假的降级。
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
    // 颁发者取 O（组织）优先，回落 CN；拼成一行，前端直接当 tooltip 用
    issuer: [issuer.O, issuer.CN].filter(Boolean).join(" ") || null,
    subject: subject.CN || subject.alt || null,
    key_type: t.cipherName || null,
    expires_at: new Date(exp).toISOString(),
  };
}

export async function gpCollect(env, pending) {
  const token = env && env.GLOBALPING_TOKEN;
  const res = await fetch(
    `https://api.globalping.io/v1/measurements/${pending.measurement_id}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} }
  );
  const d = await res.json();
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
      url: `https://${d.target || ""}/`,
      ok: rr.status === "finished",
      status: rr.statusCode || 0,
      ttfb: t.firstByte ?? 0,
      total: t.total ?? 0,
      bytes: 0,
      error: gpResultReason(rr),
      probe: `${p.city || "?"}/${p.asn || "?"}`,
      // 平台自己的归因：target = 目标站 / resolver = 解析 / internal = 平台自身故障。
      // 必须原样带出来 —— 表决时要靠它把"平台故障"从"站点故障"里摘出去。
      failureSource: rr.failureSource || null,
      // 证书随测量一起回来，落库时写入 ssl 表
      tls: tlsOf(rr),
    };
  });
  return { done: true, results, status: d.status };
}

/**
 * 多探针多数表决 —— Globalping 结果的**唯一判定口径**。
 *
 * 为什么要表决，而不是像原来那样"挑一个最好的"：
 *   GP 把测量派给哪台探针由平台决定，且对同一 magic 有**首选项粘性** ——
 *   实测 3 轮里 Nanning/4837 三次都在，另外两席每轮都换。单点采样时，
 *   那一台机器所在链路的一次抖动会被 100% 记成「站点失败」。
 *   实测中国家宽筛选下单点失败率约 25%，配上 fail_threshold=3 就是
 *   每天 4~5 次误告警，而目标站点本身完全正常。
 *   多探针下失败是**不同步**的（同一次测量里实测出现过 2 成功 1 失败），
 *   所以表决能把这种瞬时抖动过滤掉。
 *
 * 三条必须说清的规则：
 *  ① `failureSource === "internal"` 的探针**不参与表决**：那是 Globalping 平台自己
 *     出问题，它压根没测到站点。拿它投票等于把"我们没拿到数据"谎报成"站点挂了"
 *     —— 与 gpCollect 的 broken 分支是同一条约定。
 *  ② **平票即作废**（调用方不得写检查记录）：没有多数派就没有结论。宁可这一轮
 *     没数据，也不能凭空造一个 up/down 出来；pending 已删，下一轮会自动重发。
 *  ③ 代表值取多数派内的**中位数** —— 多探针的意义就是去掉"最好"与"最坏"两个
 *     偶然值，中位数才是典型体验。取最快会让页面长期显得比实际更快。
 *
 * @returns {{void:true, why:string}} 无结论
 *        | {{void:false, ok:boolean, pick:object, reason:string?, ...}} 有结论
 */
export function gpDecide(site, results) {
  const all = Array.isArray(results) ? results : [];
  if (!all.length) return { void: true, why: "no-results" };

  const usable = all.filter((r) => r.failureSource !== "internal");
  const platformFaults = all.length - usable.length;
  if (!usable.length) return { void: true, why: "all-internal", platformFaults };

  // 每条探针各自跑 judge：这样「HTTP 层通但状态码不在期望集合」（如 500）
  // 也进入表决，而不是只看代表那条的状态码。
  const votes = usable.map((r) => ({ r, v: judge(site, r) }));
  const yes = votes.filter((x) => x.v.ok);
  const no = votes.filter((x) => !x.v.ok);
  const total = votes.length;

  if (yes.length === no.length) {
    return { void: true, why: "tie", platformFaults, okCount: yes.length, total };
  }

  const ok = yes.length > no.length;
  const majority = ok ? yes : no;
  const sorted = majority.slice().sort((a, b) => (a.r.ttfb || 0) - (b.r.ttfb || 0));
  const pick = sorted[Math.floor((sorted.length - 1) / 2)];

  return {
    void: false,
    ok,
    pick: pick.r,
    reason: pick.v.reason,
    okCount: yes.length,
    total,
    platformFaults,
    // 全票时不标注票型 —— 那是常态，标了只是噪音
    unanimous: yes.length === total || no.length === total,
  };
}

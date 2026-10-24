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
 * 判定一次探测是否算"正常"：状态码 ∈ expect_codes（为空则接受 200-399）。
 *
 * 只判断 up / down 两态。第三态 **degraded（降级）** 由 index.js 的 stateOf 结合证书
 * 与响应时间实时算出 —— 它依赖 SSL（随探测顺带采）与慢阈值，都不属于「这一次请求通不通」。
 * 降级规则：证书无效 或 剩余 ≤ ssl_warn_days 天 或 响应时间 > 超时上限的一半。
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
 *    默认 3 是为了有多张票互相兜底（任一成功即视为可达，全灭才判故障），
 *    成本换准确率，可在后台改。
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
  //
  // ⚠️ 必须在读取侧归一化成 4 / 6，不能直接 `Number(...)`：
  //    和 magic / limit 一样，这一项也可能是**环境变量**写进来的（绕过后台的
  //    normalizeSetting）。`GP_IP_VERSION=ipv4` 会得到 NaN，JSON 序列化成 null，
  //    Globalping 直接 422 —— 表现是「所有站点一起探测失败」，而站点本身完全正常。
  const ipOpt = isIpAddress(u.hostname) ? {} : { ipVersion: String(env?.GP_IP_VERSION) === "6" ? 6 : 4 };

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
      ok: rr.status === "finished",
      status: rr.statusCode || 0,
      ttfb: t.firstByte ?? 0,
      total: t.total ?? 0,
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
 * 多探针判定 —— Globalping 结果的**唯一判定口径**。
 *
 * 核心规则：**只要有一台探针成功，站点就是可达的**；只有所有探针都失败才判故障。
 * 这不是「少数服从多数」—— 投票要回答的是「大多数用户能访问吗」，而我们要回答的是
 * 「站点是不是挂了」。用多数表决回答后者，会把「2 台探针同时赶上链路抖动」错报成故障。
 *
 * 为什么放弃多数表决（实测口径）：
 *   中国家宽筛选下单点失败率约 25%，3 台探针各自独立抖动。若用「≥2 失败即判故障」，
 *   单轮误判率 = 3×0.25²×0.75 + 0.25³ ≈ 15.6%，配上 fail_threshold=3 仍约每天 1 次误报。
 *   而「全灭才判故障」的单轮误判率只有 0.25³ ≈ 1.56%，低一个数量级。
 *   站点真挂时 3 台会同时失败，检出能力一点没丢 —— 多数表决在这两者之间做了错误的取舍。
 *   （对照：UptimeRobot 单区域模式同样是「主引擎 + 2 个远程地点全失败才 Down」；
 *     Better Stack 用 3/4 = 75%，是因为它自有探针在优质机房，单点失败率远低于 25%。）
 *
 * 四条必须说清的规则：
 *  ① `failureSource === "internal"` 的探针**不参与判定**：那是 Globalping 平台自己
 *     出问题，它压根没测到站点。拿它当失败票等于把"我们没拿到数据"谎报成"站点挂了"
 *     —— 与 gpCollect 的 broken 分支是同一条约定。
 *  ② **全失败时要求至少 2 票，但「单点采样」除外**：本来派了多台、却因平台故障只剩 1 票
 *     可用时，那 1 票失败就判死等于退回单点采样，而单台探针自己的链路问题恰恰是最常见的
 *     假故障来源 —— 这种情况**作废**（不写检查记录），下一轮自动重发。
 *     但后台把「探测点数」设成 1 时，1 票就是用户选定的采样方式，必须**如实判失败**：
 *     否则这个配置下每轮都作废，`consecutive_fail` 永远是 0，站点挂了也不会变红。
 *  ③ 代表值取**成功票内的中位数**：失败票的 ttfb 是 0，混进来会把响应时间拉垮。
 *     多探针的意义是去掉"最好"与"最坏"两个偶然值，取最快会让页面长期显得比实际更快。
 *  ④ 不推断"部分不可达"：1/3 成功仍记 up。想追这个信号就看详情页的票型标注
 *     （`City/ASN (1/3)`）—— 它只在出现分歧时才写，全通是常态不标。
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
  // 也参与判定，而不是只看代表那条的状态码。
  const votes = usable.map((r) => ({ r, v: judge(site, r) }));
  const yes = votes.filter((x) => x.v.ok);
  const no = votes.filter((x) => !x.v.ok);
  const total = votes.length;

  // 一票成功即视为可达 —— 见上方规则说明。
  const ok = yes.length > 0;

  // 全失败、有效票又只有 1 张时不下结论 —— 但仅当**本来派了不止一台**
  // （`all.length` 是原始结果数，含被 internal 摘掉的那些）。
  // 探测点数 = 1 时 all.length 也是 1，那是用户选定的采样方式，必须如实判失败，
  // 否则该配置下故障永远检测不出来（见规则 ②）。
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
    // 全成功 / 全失败才算「票型一致」。全失败时调用方仍会标票型（`(0/3)` 有用：
    // 它把"3 台都挂了"和"只剩 2 台有效、都挂了"区分开），所以这里只对成功有意义。
    unanimous: yes.length === total || no.length === total,
  };
}

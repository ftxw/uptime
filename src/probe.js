/**
 * 探测后端（可插拔）
 *
 * 设计目标：同一个监测目标可以选不同的探测后端，且相互之间可自动降级。
 *
 *   kind = 'cf'         → Cloudflare Durable Object + locationHint（粗粒度区域组）
 *   kind = 'globalping' → Globalping 探针网络（可细到 city / asn / 家庭宽带）
 *   kind = 'cn'         → 自建大陆探测臂（EdgeOne Makers，出口在中国大陆）—— 境内打境内
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

import { defOf } from "./settings.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** locationHint 合法值（官方 region group） */
export const REGION_GROUPS = [
  "wnam", "enam", "sam", "weur", "eeur",
  "apac", "apac-ne", "apac-se",
  "oc", "afr", "me",
];

/**
 * 补 scheme 的归一化。
 *
 * ⚠️ 正则**必须**保留 `://`，不能放宽成 `^[a-z][a-z0-9+.-]*:`。
 *    否则 `localhost:8080` / `example.com:8443` 这类「主机:端口」会被误判成 scheme
 *    而原样返回 —— 那是更常见、更不能坏的输入（探测内网/自建端口）。
 *    保留 `://` 后，它依旧会被补成 `https://localhost:8080`，行为不变。
 *
 * 为什么要放宽到「任意 scheme」而不是只认 http(s)：
 *    `ftp://x.com` 不匹配 `^https?://` → 被补成 `https://ftp://x.com`，
 *    而 `new URL()` 能解析成功（host 变成 `ftp`、protocol 仍是 https），
 *    于是白打一次 DNS 并报出误导性的 ENOTFOUND —— 把「参数写错」伪装成「网络故障」。
 *    改为「只要带任意 scheme 就原样返回」，真伪交给后续的 protocol 校验去拒。
 */
export function normalizeUrl(u) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(u ?? "").trim())
    ? String(u ?? "").trim()
    : `https://${String(u ?? "").trim()}`;
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
  if (site.keyword && r.keywordHit === false) {
    return { ok: false, reason: `正文未包含关键字 "${site.keyword}"` };
  }
  return { ok: true, reason: null };
}

/**
 * 探针端墙钟超时（整数秒）。
 *
 * ⚠️ 这是**给远端探针的规定**，不是"我们愿意等多久"。
 *    Globalping 的探测跑在第三方机器上，我们本地没有任何句柄能中断它
 *    —— 不像 CF 直连那条路可以用 AbortController 说掐就掐。
 *    所以 `timeout_ms`（CF 用）与这个值**互不相通，也不该互相折算**：
 *    把 8000ms 折成 8 秒传过来，只会让"本来第 9~14 秒才握得上手"的测量被提前判死，
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
 * 把位置筛选「放宽」一档：同一地理范围，但不限网络类型。
 * 返回 null 表示"已经没有更宽的档位"（原筛选本来就��限网络类型）。
 *
 * Globalping 的 magic 语法是 `<位置>+<网络类型>`，去掉 `+<网络类型>` 后缀
 * 就是"这个位置的全部探针"。以 CN 为例（数字来自后台设置项的说明）：
 *   CN+datacenter-network → 40 个云机房探针
 *   CN+eyeball-network    → 26 个家庭宽带探针
 *   CN                    → 两者合计 66 个
 *
 * ✅ 仍然是**同一个国家、不跨区**，符合"只在相同地区换点位"的取舍原则，
 *    而且探针池更大，`no_probes_found`（筛选过窄导致无可用探针）的概率更低。
 *
 * ⚠️ 刻意**不**把兜底做成"换网络类型"（云机房 → 家庭宽带）。近 30 天实测：
 *      CN+datacenter-network  9218 次 / 99.7% / 平均总耗时 335ms
 *      CN+eyeball-network       13 次 / 76.9% / 平均总耗时 1816ms / 最坏撞满 15s
 *    拿 76.9% 的东西当兜底，等于"兜底比主力更差"，会凭空推高 consecutive_fail、
 *    攒够阈值发假告警。放宽网络类型的收益远小于它引入的噪声。
 */
export function widenMagic(magic) {
  const s = String(magic || "").trim();
  if (!s) return null;
  const i = s.indexOf("+");
  if (i <= 0) return null; // 没有 + 后缀，或以 + 开头（非法）→ 无更宽的档位
  const wide = s.slice(0, i).trim();
  return wide && wide !== s ? wide : null;
}

/**
 * Globalping：发起一次测量，返回 measurement id（不等待结果）
 * 真正的探测由 Globalping 的探针执行 —— 所以调度器在哪里完全不影响探测点位置。
 * ⚠️ 额度按「探测点个数」计费（实测 X-Request-Cost === limit），limit 越小越省。
 *    默认 3 是为了让「多数表决」成立，成本换准确率，可在后台改。
 *
 * @param magicOverride 覆盖全局位置筛选。用于「同地区不同点位」的分层兜底：
 *   正常传空走后台设置的 `GP_MAGIC`；放宽重试时传同国家不限网络类型的值。
 *   不设成"站点级位置"，原因见下面 magic 那行注释。
 */
export async function gpCreate(env, site, magicOverride) {
  const token = env && env.GLOBALPING_TOKEN;
  const u = new URL(normalizeUrl(site.url));
  // 位置筛选是**全局设置**（后台「设置 → 探测」）。
  // 不做成站点级的原因：一个站点只用一个后端，站点级的 CF 区域组/GP 筛选
  // 必然只有一个是活的，另一个是死配置。
  const magic = magicOverride || env.GP_MAGIC || defOf("gp_magic");
  const limit = Number(env.GP_LIMIT || defOf("gp_limit"));
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

/* ─────────────────────────── SSL 检测 ─────────────────────────── */

/**
 * SSL 检测的两个时间常量。
 *
 * `GP_SSL_PROBE_TIMEOUT_SEC` 会作为**顶层** `timeout` 传给 Globalping —— 它是探针端的
 * 墙钟超时（整数秒，允许 5–30；省略时平台按测量参数自行推算、上限 30s）。
 * ⚠️ 它不在 `measurementOptions` 里，`measurementOptions.request` 只认
 *    host/path/query/method/headers（且 additionalProperties: false），
 *    所以**必须和 type/target/locations/limit 平级**，塞进 measurementOptions 会被 422 拒掉。
 *
 * 为什么显式压到 10s（而不是吃平台的 30s 默认值）：
 *   ① 官方要求调用方在客户端超时上再留 ≥10s 给探针↔API 通信与测量收尾。不压探针侧的话，
 *      最坏要等 30+10=40s 才敢判超时；而这段时间是本 Worker **同步轮询**掉的，每 2s 一次
 *      子请求，窗口每多 2s 就多一个子请求（SSL_PER_TICK 默认 2 个站点共用 subreq_budget 30）。
 *   ② 正常站点从国内机房探针做一次 TLS 握手 + GET 快得多 —— 实测北京探针打 baidu.com 是
 *      total 68ms / firstByte 16ms，绝大多数情况第一次轮询（2s）就拿到 finished。
 *      压到 10s 对正常站点没有任何影响；真超过 10s 的站点本就该判为证书检测失败。
 */
const GP_SSL_PROBE_TIMEOUT_SEC = 10;

/** 探针↔API 通信 + 测量收尾的余量。官方口径要求 ≥10s，这里给 15s。 */
const GP_SSL_FINALIZE_GRACE_MS = 15_000;

/**
 * SSL 检测派出的探针数。
 *
 * 为什么不能是 1：Globalping 对同一 (magic, target) 组合有**首选项粘性** ——
 * 反复测量会被反复派给同一台机器。只要那台机器到目标的 TLS 握手链路本身有问题
 * （跨境丢包、对端限速），该站点的证书检测就会**每天稳定失败一次**：
 * 前台/后台长期显示「检测失败」，而该站点的可用率却完全正常（可用性探测 limit=3，
 * 有另外两台兜底，所以看不出问题）—— 这是最难排查的一类现象。
 *
 * 代价只有 Globalping 的额度点数（按探针个数计费），**不增加子请求次数**：
 * 无论派几台，都还是一次 POST 发起 + 若干次 GET 轮询，而证书每站点每天才查一次。
 */
const GP_SSL_LIMIT = 3;

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
 *
 * ⚠️ `maxSubreq` 是本站点**允许消耗的子请求上限**，由调用方按本轮剩余预算传入。
 *    同步轮询意味着这段开销是"不可中断地花出去"的 —— 不设上限时，
 *    2 个站点最坏就能吃掉 28 个子请求，与探测预算叠加后直接顶穿免费层的 50 上限，
 *    结果是**整轮 cron 报 Too many subrequests、当轮什么都不做**（静默失败）。
 *    返回值里的 `subreq` 是实际消耗，调用方据此继续扣减。
 */
export async function gpSslCheck(env, site, { maxSubreq = null } = {}) {
  const token = env && env.GLOBALPING_TOKEN;
  const u = new URL(normalizeUrl(site.url));
  if (u.protocol !== "https:") {
    return { error: "非 HTTPS 站点，跳过证书检测", subreq: 0 };
  }
  // ⚠️ 刻意**不用可用性探测的筛选**（GP_MAGIC）：
  // 可用性探测的筛选可能很窄（例如 CN+xian+eyeball-network），窄到没有探针；
  // 而 SSL 检测只需要任意一个能建立 TLS 的探针即可，用窄条件会让证书检测连带失败。
  // 所以这里只认自己的 GP_SSL_MAGIC（后台「SSL 检测筛选」下拉）。
  const magic = env.GP_SSL_MAGIC || defOf("gp_ssl_magic");
  const H = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  let subreq = 0;
  // 发起前先结算：一次都花不出去就别发，免得"发起成功但收不了"，反而留下一条空结果。
  if (maxSubreq !== null && subreq >= maxSubreq) {
    return { error: "本轮子请求预算不足，证书检测顺延到下一轮", subreq };
  }
  subreq++;

  const created = await (
    await fetch("https://api.globalping.io/v1/measurements", {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        type: "http",
        target: u.hostname,
        locations: [{ magic }],
        // 多派几台：任意一台拿到证书即可（见 GP_SSL_LIMIT 注释）
        limit: GP_SSL_LIMIT,
        // 顶层字段，不是 measurementOptions 的子键（见 GP_SSL_PROBE_TIMEOUT_SEC 注释）
        timeout: GP_SSL_PROBE_TIMEOUT_SEC,
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
    return {
      error: "globalping create failed: " + JSON.stringify(created).slice(0, 150),
      subreq,
    };
  }

  // 窗口 = 探针侧超时 + 收尾余量 = 25s。不再拍一个凭空的 25s，而是由两个可解释的量推出来：
  // 探针最多跑 GP_SSL_PROBE_TIMEOUT_SEC 秒，之后平台还要收尾，窗口必须比两者之和大，
  // 否则慢测量会在结果就绪前被判超时。
  // 健康站点实测第 1 次轮询（2s）就 finished —— 所以"最坏 14 个子请求"只在异常站点上发生。
  const deadline = Date.now() + GP_SSL_PROBE_TIMEOUT_SEC * 1000 + GP_SSL_FINALIZE_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    // 每次轮询前结算预算：花完了就停手并如实说明，别把额度偷偷花在预算之外。
    if (maxSubreq !== null && subreq >= maxSubreq) {
      return { error: "本轮子请求预算不足，证书检测顺延到下一轮", subreq };
    }
    subreq++;
    const d = await (
      await fetch(`https://api.globalping.io/v1/measurements/${created.id}`, { headers: H })
    ).json();
    // 响应体里没有 status（测量 id 失效、API 返回错误体）→ 立刻失败并带上原文，
    // 不要傻等到 deadline：那种情况下再怎么轮询都等不到 finished。
    if (!d || typeof d.status !== "string") {
      return { error: "globalping 查询失败：" + JSON.stringify(d).slice(0, 120), subreq };
    }
    if (d.status !== "finished" && d.status !== "failed") continue;

    const rows = (d.results || []).map((r) => ({ r, rr: r.result || {} }));
    // 多探针下**任一台拿到证书即可** —— 挑第一个带 tls 的，而不是死盯 results[0]。
    // 原来只读第 0 条：多探针时第一台失败就整站判失败，白白浪费了另外两台的容错。
    const hit = rows.find((x) => x.rr.tls);
    if (!hit) {
      // 全都没拿到：把**人类可读**的原因带出去。gpResultReason 会把 rawOutput 翻成
      // 「TLS 握手超时（链路丢包）」这类结论；不加这一步，库里只有一句
      // 「无 TLS 信息（探测状态 failed）」，分不清是握手超时、连接被重置还是探针离线 ——
      // 而这三者的处理方式（调筛选 / 换探针 / 重试）完全不同。
      const first = rows[0] || { r: {}, rr: {} };
      const why = gpResultReason(first.rr) || `探测状态 ${first.rr.status || d.status}`;
      const p = first.r.probe || {};
      const at = p.city || p.asn ? `${p.city || "?"}/${p.asn || "?"}` : "未知探针";
      return {
        error: `未取到证书（${why}；首个探针 ${at}${
          rows.length > 1 ? `，共 ${rows.length} 台探针均未返回证书` : ""
        }）`,
        subreq,
      };
    }
    const r0 = hit.r;
    const tls = hit.rr.tls;
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
      subreq,
    };
  }
  return {
    error: `SSL 检测超时（探针 ${GP_SSL_PROBE_TIMEOUT_SEC}s + 收尾 ${
      GP_SSL_FINALIZE_GRACE_MS / 1000
    }s 内未返回结果）`,
    subreq,
  };
}

/* ─────────────────────── 大陆探测臂（kind = 'cn'）─────────────────────── */

/**
 * 大陆探测臂是**另一个已部署的 EdgeOne Makers 项目**（跑在 ap-guangzhou，出口是腾讯云段），
 * 通过 HTTPS 暴露 /api/probe、/api/ssl、/api/ping 三个接口。
 *
 * 它与 Globalping 的本质区别：
 *   · 探测点是**我们自己的**，境内打境内，ttfb 才是站点性能而不是国际链路噪声；
 *   · 批量接口 —— N 个站点一次调用就测完，CF 侧只花 1 个子请求
 *     （Globalping 是每站点 2 个子请求），站点越多省得越多；
 *   · 探测端**刻意不做判定**（results[].ok 只表示 HTTP 层跑通），判定口径唯一留在本仓库，
 *     否则「后台手点测」与「自动探测」会用两套规则得出不同结论（同 gpCollect 的立场）。
 *
 * ⚠️ 端点鉴权有两种形态，代码必须同时支持：
 *   ① 裸域名形态（绑了自定义域名的正式形态）：base 无 query，直接请求，无需 cookie。
 *   ② 预览令牌形态（当前测试形态）：base 带 `?eo_token=&eo_time=`，直接请求会 401；
 *      必须先请求一次抓 `Set-Cookie`，再带 `Cookie` 头请求**去掉 query 的干净 URL**。
 *      eo_token 3 小时轮换一次，所以形态 ② 只用于打通链路，长期应换成绑域名（形态 ①）。
 */

/**
 * 解析 `env.CN_PROBES`（逗号分隔）→ 去空、去重、去非法的 base URL 数组。
 *
 * 去重键**忽略 query**：同一个端点重新部署后 eo_token 会轮换，若按整串比较，
 * 同一台机器会被当成两个端点探测两次（白花子请求 + 投票被重复计权）。
 * 但 base 本身**保留 query** —— 那是预览令牌形态的鉴权入口，丢了就换不到 cookie。
 */
export function cnEndpoints(env) {
  const raw = String((env && env.CN_PROBES) || "");
  const seen = new Set();
  const out = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    let u;
    try {
      u = new URL(s);
    } catch {
      continue; // 非法 URL 直接丢弃，不让它进探测列表
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    // pathname 去掉尾部多余的 '/'，避免拼出 `//api/probe`；query 原样保留
    const path = u.pathname.replace(/\/+$/, "");
    const key = u.origin + path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u.origin + path + u.search);
  }
  return out;
}

/**
 * 探测臂 cookie 缓存（模块级 Map，key = base）。
 *
 * 预览令牌形态下，每个 cold isolate 第一次请求都要先换一次 cookie；缓存直接按 base 存，
 * 避免每轮 cron 都多打一次换 cookie 的请求。
 * TTL 取 2.5h（令牌本身 3h）—— 留半小时余量，宁可早换，不要用过期令牌换 401。
 */
const CN_COOKIE_TTL_MS = 2.5 * 3600 * 1000;
const cnCookieCache = new Map();

/** base 是否带鉴权 query（预览令牌形态）—— 裸域名形态没有 query */
function cnHasQuery(base) {
  try {
    return new URL(base).search !== "";
  } catch {
    return false;
  }
}

/** 读 Set-Cookie。Workers 与 Node(undici) 都支持 getSetCookie()，回退到单值读取。 */
function cnReadSetCookie(res) {
  const h = res.headers;
  if (typeof h.getSetCookie === "function") {
    try {
      return h.getSetCookie() || [];
    } catch {
      // 某些运行时 getSetCookie 会抛，退回单值读取
    }
  }
  const raw = h.get("set-cookie");
  return raw ? [raw] : [];
}

/** 单次带硬超时的 fetch —— 这层只防「端点整个卡死」拖垮整轮 cron */
async function cnFetch(url, init, hardMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    try {
      ac.abort();
    } catch {}
  }, hardMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 预览令牌形态下换取 cookie（命中缓存则零请求）。
 * @returns {{cookie: string|null, fetched: boolean}} fetched 用于子请求计数
 */
async function cnEnsureCookie(base, path, hardMs) {
  const c = cnCookieCache.get(base);
  if (c && c.exp > Date.now()) return { cookie: c.cookie, fetched: false };

  const u = new URL(base);
  u.pathname = path; // 保留 query（query 就是令牌入口）
  const res = await cnFetch(u.toString(), { method: "GET", redirect: "manual" }, hardMs);
  const cookies = cnReadSetCookie(res)
    .map((s) => s.split(";")[0].trim())
    .filter(Boolean);
  if (!cookies.length) return { cookie: null, fetched: true };
  const cookie = cookies.join("; ");
  cnCookieCache.set(base, { cookie, exp: Date.now() + CN_COOKIE_TTL_MS });
  return { cookie, fetched: true };
}

/**
 * 对探测臂发起一次带鉴权的 POST，自动适配两种端点形态（见本节顶部说明）。
 * @returns {{res: Response, data: any, text: string, subreq: number}}
 */
async function cnRequest(env, base, path, payload, hardMs) {
  const token = env && env.CN_TOKEN;
  const headers = {
    "content-type": "application/json",
    ...(token ? { "x-probe-token": String(token) } : {}),
  };

  let subreq = 0;
  let cookie = null;
  if (cnHasQuery(base)) {
    const got = await cnEnsureCookie(base, path, hardMs);
    if (got.fetched) subreq += 1; // 只有真的打了一次换 cookie 请求才计数
    cookie = got.cookie;
  }

  const once = async (ck) => {
    const u = new URL(base);
    u.pathname = path;
    // 有 cookie 就必须走**干净 URL**（带 query 会被再次 302）；
    // 裸域名形态本来就没有 query，这里不动。
    if (ck) u.search = "";
    const res = await cnFetch(
      u.toString(),
      {
        method: "POST",
        headers: { ...headers, ...(ck ? { cookie: ck } : {}) },
        body: JSON.stringify(payload),
        // manual：预览令牌形态会返回 302 → Location 指向干净 URL，不跟随，自己按 cookie 重发
        redirect: "manual",
      },
      hardMs
    );
    let text = "";
    try {
      text = await res.text();
    } catch {}
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {}
    }
    return { res, data, text };
  };

  let r = await once(cookie);
  subreq += 1;
  // cookie 过期/失效（401 或又被 302）→ 清缓存重换一次再试一次
  if (cookie && (r.res.status === 401 || r.res.status === 302)) {
    cnCookieCache.delete(base);
    const got = await cnEnsureCookie(base, path, hardMs);
    if (got.fetched) subreq += 1;
    if (got.cookie) {
      r = await once(got.cookie);
      subreq += 1;
    }
  }
  return { ...r, subreq };
}

/**
 * 批量可用性探测：对**每个端点**发 **1 次** POST /api/probe（一次带上所有站点）。
 *
 * ⚠️ 是「每端点一次」，不是「每站点一次」—— 这是 CN 相对 Globalping 最大的成本优势：
 *    GP 每站点 2 个子请求，CN 批量后 N 个站点只花 1 个。
 *
 * 单个端点失败**绝不能让整体失败**：记为端点级错误继续下一个，由调用方决定怎么表决。
 * @returns {{endpoints: Array<{base, region?, ok:boolean, results?, error?}>}}
 */
export async function cnProbe(env, sites, timeoutMs) {
  const eps = cnEndpoints(env);
  const dflt = Number(defOf("cn_timeout_ms"));
  const raw = Number((env && env.CN_TIMEOUT_MS) || timeoutMs || dflt);
  const perMs = Number.isFinite(raw) && raw > 0 ? raw : dflt || 8000;
  // 硬超时再叠 5s：探测臂已按 perMs 内部超时，这层只防「端点整个卡住」
  const hardMs = perMs + 5000;

  const items = sites.map((s) => ({
    url: s.url,
    ...(s.keyword ? { keyword: s.keyword } : {}),
    timeoutMs: perMs,
  }));

  const endpoints = [];
  for (const base of eps) {
    try {
      const { res, data, text, subreq } = await cnRequest(
        env,
        base,
        "/api/probe",
        { items },
        hardMs
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${String(text || "").slice(0, 120)}`);
      if (!data || !Array.isArray(data.results)) throw new Error("响应缺少 results 数组");
      endpoints.push({
        base,
        region: data.region || null,
        ok: true,
        results: data.results,
        wallMs: data.wallMs ?? null,
        subreq,
      });
    } catch (e) {
      // 单个端点失败**绝不能**拖垮整轮 —— 记端点级错误，继续下一个
      endpoints.push({ base, ok: false, error: String((e && e.message) || e) });
    }
  }
  return { endpoints };
}

/** 把探测臂的 /api/ssl 单条结果转成 gpSslCheck 的同形结构（saveSsl 两边共用） */
function cnSslShape(r, region) {
  if (r.error) return { error: String(r.error) };
  return {
    // ⚠️ saveSsl / stateOf 认的是 1/0（`ssl_authorized === 1`），探测臂给的是布尔，这里转一次
    authorized: r.authorized === true ? 1 : r.authorized === false ? 0 : null,
    protocol: r.protocol ?? null,
    issuer: r.issuer ?? null,
    subject: r.subject ?? null,
    key_type: r.key_type ?? null,
    expires_at: r.expires_at ?? null,
    days_left: typeof r.days_left === "number" ? r.days_left : null,
    probe: region || null,
  };
}

/**
 * 批量查证书：对每个端点发 1 次 POST /api/ssl（一次带上所有站点）。
 *
 * ⚠️ 返回结构用 `byUrl` 映射而不是「像 gpSslCheck 那样返回单站结果」——
 *    CN 是批量接口，一次调用覆盖多个站点，只能按 url 归集。
 *    每条 value 的字段与 gpSslCheck 同形，调用方的 saveSsl 无需改动。
 * 多端点时**取第一个成功返回的结果**（某个 url 已取到就不再被后续端点覆盖）。
 *
 * @returns {{byUrl: Object<string, object>, subreq: number}}
 */
export async function cnSsl(env, sites) {
  const eps = cnEndpoints(env);
  const dflt = Number(defOf("cn_timeout_ms"));
  const perMs = Number.isFinite(dflt) && dflt > 0 ? dflt : 8000;
  const hardMs = perMs + 5000;

  const items = sites.map((s) => ({ url: normalizeUrl(s.url), timeoutMs: perMs }));
  const byUrl = {};
  let subreq = 0;
  let lastErr = null;

  for (const base of eps) {
    if (items.every((it) => byUrl[it.url])) break; // 已全取到 → 不必再问后面的端点
    try {
      const { res, data, text, subreq: used } = await cnRequest(
        env,
        base,
        "/api/ssl",
        { items },
        hardMs
      );
      subreq += used;
      if (!res.ok) throw new Error(`HTTP ${res.status} ${String(text || "").slice(0, 120)}`);
      if (!data || !Array.isArray(data.results)) throw new Error("响应缺少 results 数组");
      for (const it of items) {
        if (byUrl[it.url]) continue;
        const r = data.results.find((x) => x.url === it.url);
        if (!r) continue;
        byUrl[it.url] = cnSslShape(r, data.region || null);
      }
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }

  // 一个端点都没成功 → 给每个站点一条可解释的错误（调用方照常 saveSsl，
  // 与 gpSslCheck 失败时也返回 error 的行为一致：证书失败会按 failRetryH 更快重试）
  if (!Object.keys(byUrl).length && lastErr) {
    for (const it of items) byUrl[it.url] = { error: `证书检测失败：${lastErr}` };
  }
  return { byUrl, subreq };
}



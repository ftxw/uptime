/**
 * POST /api/probe —— 批量探测执行体（大陆出口）。
 *
 * ## 它存在的理由
 * Cloudflare 在中国大陆没有可落地的计算节点，CF 探测本质是「境外打境内」：
 * 线上实测 cf 后端平均 TTFB 557ms、失败率 1.2%（且 100% 是超时），
 * 跨境链路的抖动把真实延迟淹没。这个接口提供「境内打境内」的测量，
 * 数值才是站点性能而不是国际链路噪声。
 *
 * ## 三条不可让步的取舍
 *   1. **只测 HTTP 层是否跑通**（ok = fetch 是否拿到了响应），**不做 up/down 判定**。
 *      判定口径必须全局只有一处 —— 主项目的 judge()。否则「后台手点测」与
 *      「自动探测」会用两套规则得出不同结论。
 *   2. 失败时原样带回底层错误（errorCode / error），**不翻中文**：
 *      主项目已有统一的 zhError() 负责翻译，两边都翻会让口径漂移。
 *   3. **TTFB 在 fetch resolve 那一刻取**，绝不等 body —— 等 body 会把
 *      「首字节时间」测成「总时间」。没配 keyword 时显式 cancel() 释放连接。
 *
 * 热路径上**不做出口自检出网**：出口信息走 6 小时缓存（见 lib/core.js）。
 */

import {
  requireAuth,
  clampTimeout,
  normalizeUrl,
  parseTarget,
  failResult,
  runPool,
  getEgress,
  verdictOf,
} from "../lib/core.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_ITEMS = 50;
const CONCURRENCY = 8;

/** 单条探测。item 允许 { url, keyword, timeoutMs }，也兼容裸字符串。 */
async function probeOne(raw) {
  const item = typeof raw === "string" ? { url: raw } : raw || {};
  const url = normalizeUrl(item.url);

  // 补完前缀仍不是合法 http(s)（如 ftp:、空串）→ 直接判失败，不发无意义的出站请求。
  if (!parseTarget(url)) return failResult(url, "INVALID_URL", "非 http(s) URL");

  const timeoutMs = clampTimeout(item.timeoutMs);
  const keyword = item.keyword || null;
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
      // manual：3xx 也不跟随，把跳转本身当成一次可测量的响应
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "*/*" },
      signal: ac.signal,
    });

    const ttfb = Date.now() - started;

    let keywordHit = null;
    let bytes = 0;
    if (keyword) {
      try {
        const buf = await res.arrayBuffer();
        bytes = buf.byteLength;
        keywordHit = new TextDecoder("utf-8").decode(buf).includes(keyword);
      } catch {
        keywordHit = false;
      }
    } else {
      // 不读正文，但必须显式释放，否则连接悬着会拖住并发额度与后续请求
      try {
        await res.body?.cancel();
      } catch {}
    }

    return {
      url,
      // 仅表示 HTTP 层跑通；up/down 由主项目 judge() 判定
      ok: true,
      status: res.status,
      ttfb,
      total: Date.now() - started,
      bytes,
      keywordHit,
      errorCode: null,
      error: null,
    };
  } catch (err) {
    const elapsed = Date.now() - started;
    return {
      url,
      ok: false,
      status: 0,
      ttfb: elapsed,
      total: elapsed,
      bytes: 0,
      keywordHit: null,
      // 原样带回：errorCode 供机器分类，error 供主项目 zhError() 翻译
      errorCode: err?.cause?.code || err?.name || String(err),
      error: String(err?.cause?.message || err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
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

  const wallStart = Date.now();
  const results = await runPool(items, probeOne, CONCURRENCY);

  // 出口信息走 6 小时缓存，正常情况下不会产生额外出网
  const egress = await getEgress();
  const expect = String(context.env.EXPECT_EGRESS_COUNTRY || "CN").toUpperCase();

  return Response.json({
    ok: true,
    region: context.server?.region ?? null,
    egress,
    egressVerdict: verdictOf(egress, expect),
    ts: new Date().toISOString(),
    wallMs: Date.now() - wallStart,
    results,
  });
}

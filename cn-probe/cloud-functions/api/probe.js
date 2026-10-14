/**
 * POST /api/probe —— 批量探测执行体（大陆出口）。
 *
 * 为什么存在：Cloudflare 在中国大陆没有可落地的计算节点，CF 探测本质是「境外打境内」，
 *            跨境链路抖动会把真实延迟淹没。本接口提供「境内打境内」的测量，
 *            数值才是站点性能而不是国际链路噪声。
 * 给谁用：    CF 侧调度器（DO Alarm / cron）通过 HTTPS 调用；
 *            请求头 x-probe-token 鉴权（口径与 ping / ssl 一致）。
 *
 * 关键取舍：
 *   1. 这里**只测 HTTP 层是否跑通**（ok = fetch 是否拿到了响应），**不做 up/down 判定**。
 *      判定口径必须全局只有一处 —— CF 侧的 judge()。否则「后台手点测」与「自动探测」
 *      会用两套规则得出不同结论。
 *   2. 失败时原样带回底层错误（errorCode / error），**不翻中文**：
 *      CF 侧已有统一的 zhError() 负责翻译，两边都翻会让口径漂移。
 *   3. 只在传了 keyword 时才读正文；否则显式 cancel() 释放连接。
 *      读正文会白费带宽、并让 TTFB 失真 —— 这是本探测函数最核心的取舍。
 *
 * ⚠️ 鉴权函数在此文件内联复制（原因见 ping.js 顶部注释）。
 */

import { createHash, timingSafeEqual } from "node:crypto";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_ITEMS = 50;
const CONCURRENCY = 8;
const DEFAULT_TIMEOUT = 8000;
const MIN_TIMEOUT = 1000;
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

/** 把每条的超时夹到 [1000, 15000]，非法值回落默认 8000。 */
function clampTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT;
  return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, Math.round(n)));
}

/** 缺 scheme 时补 https://；已带任意 scheme 的原样返回，真伪交由调用方的 protocol 校验。 */
function normalizeUrl(u) {
  const s = String(u ?? "").trim();
  // 只匹配 http(s):// 不够：比如 "ftp://x.com" 会被补成 "https://ftp://x.com"，
  // 而 new URL 能把它的 host 解析成 "ftp"、protocol 仍算 https，于是绕过 protocol 校验、
  // 白打一次 DNS，把「参数写错」伪装成误导性的网络故障。所以只要带任意 scheme 就原样返回。
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

/** 统一的失败结构，保证返回给 CF 的字段集合永远一致。 */
function failResult(url, errorCode, error, elapsed = 0) {
  return {
    url,
    ok: false,
    status: 0,
    ttfb: elapsed,
    total: elapsed,
    bytes: 0,
    keywordHit: null,
    errorCode,
    error,
  };
}

/** 单条探测。item 允许是 { url, keyword, timeoutMs }，也兼容裸字符串。 */
async function probeOne(raw) {
  const item = typeof raw === "string" ? { url: raw } : raw || {};
  const url = normalizeUrl(item.url);

  // 补完前缀仍不是合法 http(s)（如 ftp:、空串）→ 直接记失败，不发无意义的出站请求。
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return failResult(url, "INVALID_URL", "非 http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return failResult(url, "INVALID_URL", "非 http(s) URL");
  }

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
      // manual：3xx 也不跟随，把跳转本身当成一次可测量的响应。
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "*/*" },
      signal: ac.signal,
    });

    // TTFB 在 fetch resolve 的那一刻取 —— 绝不等 body。等 body 会把「首字节时间」测成「总时间」。
    const ttfb = Date.now() - started;

    let keywordHit = null;
    let bytes = 0;
    if (keyword) {
      // 只有真有关键字要校验时才读正文。
      try {
        const buf = await res.arrayBuffer();
        bytes = buf.byteLength;
        keywordHit = new TextDecoder("utf-8").decode(buf).includes(keyword);
      } catch {
        keywordHit = false;
      }
    } else {
      // 不读正文，但必须显式释放，否则连接会悬着、拖住并发额度与后续请求。
      try {
        await res.body?.cancel();
      } catch {}
    }

    return {
      url,
      ok: true, // 仅表示 HTTP 层跑通；up/down 由 CF 侧 judge() 判定
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
      // 原样带回：errorCode 供机器分类，error 供 CF 侧 zhError() 翻译。
      errorCode: err?.cause?.code || err?.name || String(err),
      error: String(err?.cause?.message || err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 简单信号量池：把并发压在 CONCURRENCY 之上，避免一次性把 50 条全发出去。 */
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

  const wallStart = Date.now();
  const results = await runPool(items, probeOne, CONCURRENCY);

  return Response.json({
    ok: true,
    region: context.server?.region ?? null,
    ts: new Date().toISOString(),
    wallMs: Date.now() - wallStart,
    results,
  });
}

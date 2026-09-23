/**
 * Prober —— 位置可控的 CF 探测执行体
 *
 * 为什么需要 Durable Object：
 *   官方原文「Placement only affects the execution of fetch event handlers.
 *   It does not affect RPC methods or named entrypoints.」
 *   cron 触发的是 scheduled handler，所以 Placement（含 Smart 与 Hints）对它完全无效。
 *   而 DO 有自己的位置，且**创建后不再迁移** —— cron 只要调到它，探测就固定在 DO 机房执行。
 *
 * 位置由 locationHint 决定（粗粒度区域组）。实测映射见 probe.js 顶部注释。
 */

import { DurableObject } from "cloudflare:workers";
import { runAllDirect } from "./probe.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class Prober extends DurableObject {
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
      out.traceError = String((e && e.message) || e);
    }
    try {
      const r2 = await fetch("https://myip.ipip.net", {
        headers: { "User-Agent": UA },
      });
      if (r2.ok) out.geo = (await r2.text()).trim().replace(/\s+/g, " ").slice(0, 120);
    } catch {}
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
}

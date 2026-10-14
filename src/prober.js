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

/**
 * 出口信息的缓存时长。
 *
 * 为什么缓存：`egress()` 每轮都要发出网请求，而 cron 是**每分钟**一次。
 * 更关键的是 DO 实例每轮结束就被 `kill()` 干掉（见下方），所以**内存缓存毫无意义**，
 * 必须落到 DO storage 才能跨实例存活。
 *
 * 缓存 6 小时不会给出过期信息：位置是**持久的** —— 同一个 locationHint 永远
 * 落在同一机房，colo 本身就不会变。收益是每分钟省一次出网请求，以及某次 trace
 * 抖动时页面上的 colo 不会突然变空。
 */
const EGRESS_TTL_MS = 6 * 3600 * 1000;

export class Prober extends DurableObject {
  /**
   * 自报执行位置。
   *
   * 只用 Cloudflare 自家的 `cdn-cgi/trace`：它给出的 `colo=` 是**权威值**，
   * 也是唯一真正被消费的字段 —— `probeViaCf` 把它写进 checks 表的 `probe` 列，
   * 前台 / 详情页 / 后台显示的"机房 SJC"就是它。
   *
   * ⚠️ 这里**曾经**还额外请求第三方 ipip.net，取一个"人类可读的地理描述"
   *    （形如「当前 IP：x.x.x.x 来自于：中国 北京 联通」）。现已删除，三个理由：
   *      ① **没有任何消费方** —— `geo` 只在 `/api/test` 的 JSON 里透出，
   *         前台与后台从不渲染它（admin.js / admin.html 均无引用）；
   *      ② **它本身最不可信** —— DO 出口是 Cloudflare 自己的 IPv6 段，
   *         第三方 IP 库常把香港 / 东京机房误判成美国（这正是本函数
   *         一开始就写明要用 cdn-cgi/trace 的理由）；
   *      ③ **成本不对等** —— 多一次出网请求 + 从 CF 机房到国内服务的往返延迟
   *         + 把出口 IP 交给第三方，换来的信息量还不如一个 colo 三字码。
   */
  async egress() {
    try {
      const cached = await this.ctx.storage.get("egress");
      if (cached && cached.at && Date.now() - cached.at < EGRESS_TTL_MS && cached.data) {
        return cached.data;
      }
    } catch {
      // storage 读失败不该影响探测本身 —— 退回实时查询
    }

    const out = { colo: null, ip: null };
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

    // 只在拿到 colo 时才写缓存 —— 这一轮查询失败不值得固化，
    // 否则接下来 6 小时 colo 都是空的。
    if (out.colo) {
      try {
        await this.ctx.storage.put("egress", { at: Date.now(), data: out });
      } catch {
        // 写缓存失败不影响探测
      }
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
}

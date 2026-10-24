/**
 * 「这次检查是谁、在哪跑的」的**唯一展示口径** —— 首页 / 详情页 / 后台共用。
 *
 * 为什么放在服务端算，而不是各前端自己拼：
 *   同一份数据要在三个前端渲染（app.js / monitor.js / admin.js），而它们是三个互相
 *   独立的普通脚本（没有打包器、没有共享模块）。拼接逻辑抄三份必然漂移 ——
 *   事实上改造前就是三种写法，同一个事实：
 *     · 首页    `Globalping · Beijing/45090`
 *     · 详情页  `gp:CN+datacenter-network · Beijing/45090`（直接吐原始 source）
 *     · 后台    `机房 SJC`
 *   所以由服务端算好一个字符串下发，前端只负责转义与渲染。
 *
 * 输出形态：`GP:范围 · 落点`
 *   gp:CN+datacenter-network + Beijing/9808  →  GP:CN · Beijing/9808
 *   gp:CN+changsha+4837      + Changsha/4134 →  GP:CN · Changsha/4134
 *
 * 范围取自 `source` 里 magic 表达式的**第一段**（`CN`、`east-asia`）；
 * `+` 之后是网络类型标签（datacenter-network / eyeball-network），不是地点，所以丢掉。
 * 落点取自 `probe`（`City/ASN`，9808 是运营商编号），原样保留 ——
 * 它是排查"换没换点、是哪家运营商"的原始依据。
 */
export function formatOrigin(source, probe) {
  const s = String(source || "");
  if (!s) return "";
  const p = String(probe || "").trim();
  // 未知来源（未来可能新增后端）：原样保留，不吞信息
  if (!s.startsWith("gp:")) return p ? `${s} · ${p}` : s;

  const scope = s
    .slice(3)
    .split("+")[0]
    .trim()
    .toUpperCase();

  const head = `GP:${scope}`;
  return p ? `${head} · ${p}` : head;
}

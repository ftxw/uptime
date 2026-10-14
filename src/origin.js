/**
 * 「这次检查是谁、在哪跑的」的**唯一展示口径** —— 首页 / 详情页 / 后台共用。
 *
 * 为什么放在服务端算，而不是各前端自己拼：
 *   同一份数据要在三个前端渲染（app.js / monitor.js / admin.js），而它们是三个互相
 *   独立的普通脚本（没有打包器、没有共享模块）。拼接逻辑抄三份必然漂移 ——
 *   事实上改造前就是三种写法，同一个事实：
 *     · 首页    `Globalping · Beijing/45090` / `CF · APAC · SJC`
 *     · 详情页  `gp:CN+datacenter-network · Beijing/45090`（直接吐原始 source）
 *     · 后台    `机房 SJC`
 *   所以由服务端算好一个字符串下发，前端只负责转义与渲染。
 *
 * 输出形态：`PROVIDER:范围 · 落点`
 *   gp:CN+datacenter-network + Beijing/9808  →  GP:CN · Beijing/9808
 *   gp:CN+changsha+4837      + Changsha/4134 →  GP:CN · Changsha/4134
 *   gp:east-asia             + Shanghai/9808 →  GP:EAST-ASIA · Shanghai/9808
 *   cf:apac                  + SJC           →  CF:APAC · SJC
 *   cf:fallback-apac         + SJC           →  CF:APAC · SJC（降级）
 *   cn:ap-guangzhou          + ap-guangzhou   →  CN:AP-GUANGZHOU · ap-guangzhou
 *   cn:                      + （无落点）     →  CN
 *
 * 范围取自 `source`（落库时写入的完整来源串）：
 *   `gp:` 后面是位置的 magic 表达式，**第一段**就是本次探测的地理范围
 *        （`CN`、`east-asia`）；`+` 之后是网络类型标签
 *        （datacenter-network / eyeball-network），不是地点，所以丢掉。
 *   `cf:` 后面是 locationHint 区域组（apac / wnam / …）。
 *        `fallback-` 前缀表示「Globalping 发起失败后自动降级到 CF 边缘探测」
 *        （见 index.js 的 dispatch）—— 这点必须显式标出来，否则会被读成
 *        "这个站点配的就是 CF"，把降级路径彻底藏起来。
 *        CN 未配端点时也走同一条 `cf:fallback-*` 降级路径，故同样带「（降级）」。
 *   `cn:` 后面是探测臂的区域（如 `ap-guangzhou`，取自探测臂响应的 region）。
 *        从未检查过、或探测臂没回 region 时它是**空串** —— 此时 head 只输出 `CN`，
 *        不要输出 `CN:`（那个冒号看着像信息被截断了）。
 *   scope 一律大写：与 `CN` / `SJC` 这类代码型标识的观感一致，
 *   也让 `CF:APAC` 能对齐 `GP:CN` 的形态。
 *
 * 落点取自 `probe`：原样保留。
 *   gp 是 `City/ASN`（如 `Beijing/9808`，9808 是运营商编号），
 *   cf 是 Cloudflare 的 colo 三字码（SJC/HKG…）。
 *   刻意不做二次裁剪 —— 这两个值本身就是排查"换没换点、是哪家运营商"的原始依据。
 */
export function formatOrigin(source, probe) {
  const s = String(source || "");
  if (!s) return "";
  const isGp = s.startsWith("gp:");
  const isCf = s.startsWith("cf:");
  const isCn = s.startsWith("cn:");
  const p = String(probe || "").trim();
  // 未知来源（未来可能新增后端）：原样保留，不吞信息
  if (!isGp && !isCf && !isCn) return p ? `${s} · ${p}` : s;

  const rest = s.slice(3);
  const degraded = isCf && rest.startsWith("fallback-");
  const scope = (degraded ? rest.slice("fallback-".length) : rest)
    .split("+")[0]
    .trim()
    .toUpperCase();

  const label = isGp ? "GP" : isCf ? "CF" : "CN";
  // scope 为空时（如从未检查过的 cn 站点用 `cn:`）head 只输出 `CN`，不带空冒号
  const head = scope ? `${label}:${scope}` : label;
  return (p ? `${head} · ${p}` : head) + (degraded ? "（降级）" : "");
}

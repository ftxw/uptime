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
 *   cn:                      + 境内            →  EdgeOne 境内
 *   cn:                      + 东京（境外）     →  EdgeOne 东京（境外） ⚠️
 *   cn:                      + 成都?           →  EdgeOne 成都? ⚠️
 *   cn:                      + （无落点）        →  EdgeOne
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
 *   `cn:` 后面**不再带区域**，probe 存的是**带可信度标注的结论**
 *        「境内」/「东京（境外）」/「成都?」/空（未知）。
 *
 * ## cn 支为什么要分三态
 * 踩过的坑：平台自报的城市**曾经**被直接当事实写进 source，渲染成
 * `CN:AP-SINGAPORE · ap-singapore` —— 而那次探测实际上根本没在境内跑
 * （加速区域为「全球可用区（含大陆）」时平台按**调用方位置**做地理路由，
 * CF 在境外 → 请求被路由去了境外）。结果是拿境外的测量当境内数据用了很久。
 *
 * 但反过来改成「一律不显示城市」同样是错的：界面看上去一切正常，
 * **排查时看不出探测臂跑错了地域**，绕了远路。
 *
 * 所以落点改成**带可信度标注的结论**（index.js 的 cnWhereOf 产出）：
 *   `境内`        实测出口在境内，可用
 *   `东京（境外）`  自报城市是真的，但出口在境外 —— 这次测量不能当大陆数据
 *   `成都?`        出口归属没验成，城市名仅来自平台自报，存疑
 * gp / cf 两支的落点原样保留（前者来自 Globalping 响应，后者由 DO 自己读
 * cdn-cgi/trace），它们本来就可信。
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

  // cn：落点标签由 index.js 的 cnWhereOf() 产出，形如
  //   `境内` / `东京（境外）` / `成都?` / `境外?`
  // 三态分别回答三个不同的问题，不能混为一谈：
  //   境内      → 出口在境内，数据可用
  //   X（境外） → 地域真实但出口在境外，**这次测量不能当大陆数据用**
  //   X?        → 出口归属没验成，城市名只是平台自报，存疑
  // 刻意保留后两种形态：此前一律渲染成「EdgeOne」虽然不撒谎，但也让人看不出
  // 「探测臂跑错了地域」——排查绕远路正是因为界面看上去一切正常。
  if (isCn) {
    if (!p) return "EdgeOne";
    if (p === "境内") return "EdgeOne 境内";
    const warn = p.endsWith("（境外）") || p.endsWith("?");
    return `EdgeOne ${p}${warn ? " ⚠️" : ""}`;
  }

  const rest = s.slice(3);
  const degraded = isCf && rest.startsWith("fallback-");
  const scope = (degraded ? rest.slice("fallback-".length) : rest)
    .split("+")[0]
    .trim()
    .toUpperCase();

  const label = isGp ? "GP" : "CF";
  const head = scope ? `${label}:${scope}` : label;
  return (p ? `${head} · ${p}` : head) + (degraded ? "（降级）" : "");
}

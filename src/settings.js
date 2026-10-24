/**
 * 运行参数的元信息与**唯一默认值来源**。
 *
 * 每一项都在这里说清三件事：
 *   key —— meta 表里的键，也是后台「设置」表单的字段名
 *   env —— 对应的环境变量名（"" 表示这一项只存在于 meta，不读环境变量）
 *   def —— 兜底默认值
 *
 * 取值优先级：**D1 meta（后台设置） > 环境变量 > def**。
 *
 * 为什么必须集中成一张表：默认值一旦散落在多处（常量、兜底表达式、probe.js 的参数构造），
 * 必然发生漂移 —— 比如 env 缺失时取值 14、写入校验却允许别的值，最终行为无法解释。
 * 同时这也是「所有设置都可配置」的清单：想加一项，只改这里 + 后台表单。
 *
 * 本模块不依赖任何东西，被 index.js 与 probe.js 共用，不存在循环引用。
 */
export const SETTING_META = {
  default_theme:    { env: "",                 def: "auto" },                  // auto | light | dark
  site_title:       { env: "",                 def: "站点状态" },
  gp_magic:         { env: "GP_MAGIC",         def: "CN+datacenter-network" }, // Globalping 位置筛选
  gp_limit:         { env: "GP_LIMIT",         def: "3" },                     // 每次测量的探测点数（**额度按此计费**；三档 1/3/5，见后台下拉）
  gp_timeout_sec:   { env: "GP_TIMEOUT_SEC",   def: "15" },                    // 探针端墙钟超时（整数秒，5–30）
  gp_ip_version:    { env: "GP_IP_VERSION",    def: "4" },
  ssl_warn_days:    { env: "SSL_WARN_DAYS",    def: "14" },                    // 剩余 ≤ N 天判为降级
  subreq_budget:    { env: "SUBREQ_BUDGET",    def: "30" },                    // 本轮出网子请求额度（D1 另计，见 normalizeSetting 说明）
  check_keep_days:  { env: "CHECK_KEEP_DAYS",  def: "30" },                    // 探测明细保留天数
  recent_limit:     { env: "RECENT_LIMIT",     def: "20" },                    // 详情页「最近检查」最多显示几条
  incident_limit:   { env: "INCIDENT_LIMIT",   def: "10" },                    // 详情页「故障记录」最多显示几条
  utc_offset_min:   { env: "UTC_OFFSET_MIN",   def: "480" },                   // 展示时区，480 = UTC+8
  globalping_token: { env: "GLOBALPING_TOKEN", def: "" },                      // 后台只写、不放回滚
};

/** 后台可改的全部设置项。/api/settings 的读写白名单与回显清单都从这里派生。 */
export const SETTING_KEYS = Object.keys(SETTING_META);

/** 某项设置的内置默认值 */
export const defOf = (k) => SETTING_META[k]?.def ?? "";

/**
 * Globalping 位置筛选（magic）的合法形状。
 *
 * 允许：字母数字、`+`（多条件与）、`-`（取反）、`*`（通配）、`_` `:` `,` `.`。
 * 禁止：空白、引号、花括号 —— 这些一旦落进 magic，Globalping 直接 422，
 * 而 422 发生在**每一次**发起测量时，表现为「所有 GP 站点全部探测失败」，
 * 但站点本身完全正常，排查方向极易被带偏。
 */
const MAGIC_RE = /^[A-Za-z0-9+*_.:,-]{1,64}$/;

/** 合法的 magic 返回规范化后的字符串，否则返回 null */
export function validMagic(v) {
  const s = String(v ?? "").trim();
  return MAGIC_RE.test(s) ? s : null;
}

/**
 * 探测点数：Globalping 只接受 1 / 3 / 5（其它值 422），且**额度按探测点数计费**。
 * 非法值一律回落到默认 3 —— 不能让它变成 NaN 塞进请求体（JSON 里会序列化成 null）。
 */
export function gpLimitNum(v) {
  const n = Number(v);
  return n === 1 || n === 3 || n === 5 ? n : Number(defOf("gp_limit"));
}

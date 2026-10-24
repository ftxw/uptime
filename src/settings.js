/**
 * 运行参数的元信息与默认值唯一来源。
 *
 * key = meta 表键名兼后台表单字段；env = 对应环境变量（空则只存 meta）；def = 兜底值。
 * 取值优先级：D1 meta（后台设置） > 环境变量 > def。
 */
export const SETTING_META = {
  default_theme:    { env: "",                 def: "auto" },                  // auto | light | dark
  site_title:       { env: "",                 def: "站点状态" },
  gp_magic:         { env: "GP_MAGIC",         def: "CN+datacenter-network" }, // Globalping 位置筛选
  gp_limit:         { env: "GP_LIMIT",         def: "3" },                     // 每次测量的探测点数（额度按此计费；三档 1/3/5，见后台下拉）
  gp_timeout_sec:   { env: "GP_TIMEOUT_SEC",   def: "15" },                    // 探针端墙钟超时（整数秒，5–30）
  gp_ip_version:    { env: "GP_IP_VERSION",    def: "4" },
  ssl_warn_days:    { env: "SSL_WARN_DAYS",    def: "14" },                    // 剩余 ≤ N 天判为降级
  slow_ms:          { env: "SLOW_MS",          def: "2000" },                   // 响应时间 > N 毫秒判为降级；0 = 关闭
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
 * magic 的合法形状。含空白/引号会让 Globalping 每次发起都 422，
 * 表现为「全部 GP 站点失败」而站点本身正常，极易误判。
 */
const MAGIC_RE = /^[A-Za-z0-9+*_.:,-]{1,64}$/;

/** 合法则返回规范化字符串，否则 null */
export function validMagic(v) {
  const s = String(v ?? "").trim();
  return MAGIC_RE.test(s) ? s : null;
}

/** Globalping 只接受 1/3/5；非法值回落默认，避免 NaN 进请求体。 */
export function gpLimitNum(v) {
  const n = Number(v);
  return n === 1 || n === 3 || n === 5 ? n : Number(defOf("gp_limit"));
}

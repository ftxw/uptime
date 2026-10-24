/**
 * 「这次检查跑在哪」的唯一展示口径，首页 / 详情页 / 后台共用。
 * 由服务端算好字符串下发，避免三个互不共享的前端各拼一份。
 *
 * 输出 `GP:范围 · 落点`：范围取 source 里 magic 的第一段（+ 之后是网络类型标签，
 * 不是地点）；落点原样保留 City/ASN，用于排查换了哪个点、哪家运营商。
 */
export function formatOrigin(source, probe) {
  const s = String(source || "");
  if (!s) return "";
  const p = String(probe || "").trim();
  // 未知来源原样保留，不吞信息
  if (!s.startsWith("gp:")) return p ? `${s} · ${p}` : s;

  const scope = s
    .slice(3)
    .split("+")[0]
    .trim()
    .toUpperCase();

  const head = `GP:${scope}`;
  return p ? `${head} · ${p}` : head;
}

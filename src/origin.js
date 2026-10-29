/**
 * 来源标签，三个前端共用。输出 `GP:范围 · City/ASN`；
 * 范围取 magic 第一段（+ 之后是网络类型，不是地点）。
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

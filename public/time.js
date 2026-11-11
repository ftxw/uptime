/* 时间格式化：三个页面共用。存储层是分钟级 UTC 字符串。
   绝对时间按后台配置的 utc_offset_min 展示 —— 服务端色条的「一天」也是按这个偏移切分的，
   两边必须用同一口径，否则 UTC+8 的色条会配上访客本地（例如 UTC-5）的时间戳。 */
window.T = (() => {
  const pad2 = (n) => String(n).padStart(2, "0");
  let offsetMin = null; // null = 尚未拿到后台设置，先沿用浏览器本地时区

  /** 后台下发 utc_offset_min 后由 common.js 调用。 */
  function setOffset(min) {
    const n = Number(min);
    offsetMin = Number.isFinite(n) ? Math.min(840, Math.max(-720, Math.trunc(n))) : null;
  }

  /** 取「墙上时间」各字段：配置了偏移就平移到该时区再按 UTC 读，否则用本地 getter。 */
  function parts(t) {
    const d = new Date(t);
    if (offsetMin === null) {
      return {
        y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate(),
        h: d.getHours(), min: d.getMinutes(),
      };
    }
    const s = new Date(d.getTime() + offsetMin * 60_000);
    return {
      y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, day: s.getUTCDate(),
      h: s.getUTCHours(), min: s.getUTCMinutes(),
    };
  }

  function relTime(iso, empty = "—") {
    if (!iso) return empty;
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return "刚刚";
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
  }

  function fmtFull(t) {
    if (!t) return "--";
    const p = parts(t);
    return `${p.y}-${pad2(p.m)}-${pad2(p.day)} ${pad2(p.h)}:${pad2(p.min)}`;
  }

  function fmtClock(t) {
    if (!t) return "--";
    const p = parts(t);
    return `${pad2(p.h)}:${pad2(p.min)}`;
  }

  function fmtAxis(t, hours) {
    const p = parts(t);
    const hm = `${pad2(p.h)}:${pad2(p.min)}`;
    return hours <= 24 ? hm : `${pad2(p.m)}-${pad2(p.day)} ${hm}`;
  }

  return { pad2, relTime, fmtFull, fmtClock, fmtAxis, setOffset };
})();

/* 时间格式化：三个页面共用。存储层是分钟级 UTC 字符串，这里统一转本地时区展示。 */
window.T = (() => {
  const pad2 = (n) => String(n).padStart(2, "0");

  function relTime(iso, empty = "—") {
    if (!iso) return empty;
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return "刚刚";
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
  }

  function fmtFull(iso) {
    if (!iso) return "--";
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
      d.getHours()
    )}:${pad2(d.getMinutes())}`;
  }

  function fmtClock(iso) {
    if (!iso) return "--";
    const d = new Date(iso);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function fmtAxis(t, hours) {
    const d = new Date(t);
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return hours <= 24 ? hm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
  }

  return { pad2, relTime, fmtFull, fmtClock, fmtAxis };
})();

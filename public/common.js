/* 三个页面共用的展示工具。挂到 window.U，保留现有脚本的全局调用方式。 */
(function () {
  const ICONS = {
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1 1 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  };

  const svg = (n, cls = "") =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ""}</svg>`;

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  const STATE_LABEL = { up: "正常", down: "故障", degraded: "降级", unknown: "未知" };
  const fmtInterval = (min) => {
    const n = Number(min) || 5;
    return n >= 60 ? `${n / 60} 小时` : `${n} 分钟`;
  };

  /** 后台下发 utc_offset_min 后调用，让所有绝对时间按配置时区展示（与色条日界同源）。 */
  function setTimezoneOffset(min) {
    if (window.T && typeof window.T.setOffset === "function") window.T.setOffset(min);
  }

  /** 后台设置「前台默认主题」时同步到当前页面；用户手动切过则尊重其选择。 */
  function applyThemeDefault(theme) {
    if (!theme) return;
    try {
      localStorage.setItem("theme-default", theme);
      if (localStorage.getItem("theme")) return;
      const dark =
        theme === "dark"
          ? true
          : theme === "light"
            ? false
            : matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    } catch (e) {}
  }

  window.U = {
    ICONS,
    svg,
    escapeHtml,
    STATE_LABEL,
    fmtInterval,
    setTimezoneOffset,
    applyThemeDefault,
  };
})();

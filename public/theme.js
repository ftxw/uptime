/* 主题初始化：必须在样式表之前同步执行，避免首屏闪白（FOUC）。
   优先级：用户手动选择 > 后台设置的默认主题（由前台写入 theme-default） > 跟随系统。
   外置成独立文件是为了能启用 CSP 的 script-src 'self'。 */
(function () {
  try {
    var t = localStorage.getItem("theme") || localStorage.getItem("theme-default");
    if (!t || t === "auto") {
      t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    var dark = t === "dark";
    document.documentElement.classList.toggle("dark", dark);
    // meta 里的 "light dark" 只跟随系统，手动/后台指定深色时必须显式覆盖，
    // 否则原生 select、滚动条、输入框仍是浅色。
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  } catch (e) {}
})();

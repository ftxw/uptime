/* 详情页骨架屏：数据到达前把卡片撑到接近最终高度，避免 CLS。
   与真实卡片用同一套 class，行高一致；有缓存时不会显示。
   外置成独立文件是为了能启用 CSP 的 script-src 'self'。 */
(function () {
  var D = document;
  var sk = function (t, cls) {
    return '<span class="' + (cls ? cls + " " : "") + 'sk">' + t + "</span>";
  };
  var put = function (id, html) {
    var el = D.getElementById(id);
    if (el) el.innerHTML = html;
  };
  var card = function (inner, extra) {
    return '<div class="card glass ' + extra + ' skel" aria-hidden="true">' + inner + "</div>";
  };
  var body = function (lines) {
    return '<div style="min-width:0">' + lines + "</div>";
  };

  // 4 张指标卡（顺序与 renderKpis 完全一致：可用率 / 检查间隔 / SSL 证书 / 平均响应）
  put(
    "kpis",
    ["可用率", "检查间隔", "SSL 证书", "平均响应"].map(function (label) {
      return card(
        '<div class="stat-icon i-muted"></div>' +
          body('<p class="stat-label">' + sk(label) + '</p><p class="stat-value">' + sk("000 ms") + "</p>"),
        "stat"
      );
    }).join("")
  );

  // 图表：整块灰底（高度由 .chart-wrap 的 min-height:260px 兜住）
  put("chart", '<div class="chart-skel" aria-hidden="true"></div>');

  // 色条：一条灰条，与"无数据"时同款，高度同为 34px
  put("bar", '<span class="skel" aria-hidden="true"></span>');

  // 最近检查：占位行结构与真实行完全一致（badge + 状态码 + 耗时 + 备注 + 时间）。
  // 20 行是刻意写死的：骨架只负责把卡片撑到接近最终高度，不必与 recent_limit 精确相等。
  put("recent", Array(21).join(
    '<div class="lst-row skel" aria-hidden="true">' + sk("正常", "badge") +
      sk("200") + sk("155 ms") + sk("cfapi · H2", "grow") + sk("2026-01-01 00:00") + "</div>"
  ));

  // 故障记录：占位一行。绝大多数站点此刻没有故障，真为空时卡片只会比占位矮约 10px
  put("incidents", '<div class="inc-row skel" aria-hidden="true">' + sk("已恢复", "badge") +
    '<div class="grow" style="min-width:0">' + sk("HTTP 500") +
    '<div style="margin-top:3px">' + sk("2026-01-01 00:00 → 00:00 · 历时 1 分 0 秒") +
    "</div></div></div>");
})();

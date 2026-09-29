/* Service Worker —— CF 单平台下"秒开"的关键一环
   第二次访问起，外壳从本地缓存直接返回，完全不走网络。
   这是唯一能绕开 CF 首访 ~1s 网络成本的办法。 */

// ⚠️ 版本号由 scripts/bump-sw.mjs 在部署前按 public/ 内容哈希自动重写，**不要手改**。
//    原先是人工 +1，漏一次就会出现「部署了新代码但界面没变」（缓存优先）。
//    现在只要 public/ 下任一文件内容变了，哈希就变 → 缓存名变 → activate 清掉旧缓存。
const VERSION = "v-8f898e8aedde";
const SHELL = `/shell-${VERSION}`;
const PRECACHE = [
  "/",
  "/monitor",
  "/admin",
  "/app.css",
  "/app.js",
  "/monitor.js",
  "/admin.js",
  "/favicon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) =>
        Promise.all(
          // ⚠️ 必须显式 `cache: "reload"`，不能用 c.add(u)：
          //    add() 走的仍是浏览器 HTTP 缓存，而 /*.css 带 `max-age=300`
          //    （见 public/_headers）—— 新 SW 会把**旧的 CSS** 当成新内容预缓存进来，
          //    之后无论按多少次 F5 都刷不掉，只有硬刷才会绕过 HTTP 缓存。
          //    实测（tmp/swf5.mjs）：连按 6 次普通刷新 CSS 都是旧的，硬刷才变。
          PRECACHE.map((u) =>
            fetch(u, { cache: "reload" })
              .then((r) => (r && r.ok ? c.put(u, r) : null))
              .catch(() => null)
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)));

      // 接管已打开的页面。这一步同时是「发版后一次 F5 即新版」的关键：
      // 本次导航是由**旧 SW** 应答的（新 SW 要等这次导航结束之后才装好并接管），
      // 所以用户第一眼看到的必然还是旧页面；claim() 把控制权换成新 SW，
      // 页面那边监听到 controllerchange 就地重载一次 —— 一次刷新即新版。
      //
      // ⚠️ 不要改回由 SW 侧调 clients.navigate()：实测（tmp/swf5.mjs）它被正常调用、
      //    不抛错也不 reject，但**不会真的产生导航**，页面稳稳定格在旧版 —— 白费功夫。
      //    重载交给页面自己（index / admin / monitor 三处的 controllerchange 监听）。
      await self.clients.claim();
    })()
  );
});

/**
 * 「缓存优先 + 后台更新」（stale-while-revalidate）—— HTML 外壳与静态资源共用。
 *
 * 必须是缓存优先：网络优先会让**每次进后台都白等一次跨国往返**（HTML 外壳 ~0.7s），
 * 而 HTML 内容其实很少变。缓存优先下有缓存就立即出内容（0 网络等待），
 * 同时后台拉新版写入缓存，下次访问就是新的 —— 配合上面的内容哈希，
 * 代码一变版本号就变，不存在滞后。
 *
 * ⚠️ path 必须传 **pathname**（`/app.css`），不能传绝对 URL：
 *    PRECACHE 是按路径写入的，用绝对 URL 去 match 永远命中不了，
 *    结果就是每次都走网络、"秒开"失效（这是一个真实的踩坑）。
 *    离线且无缓存时才真的等网络。
 *
 * ⚠️ 后台那次 fetch 必须带 `cache: "no-cache"`：默认模式会**直接读浏览器 HTTP 缓存**，
 *    于是"后台更新"只是把 HTTP 缓存里的旧副本又写回 SW 缓存（/*.css 有 5 分钟新鲜期，
 *    这会让 CSS 的更新连按 F5 都刷不出来）。no-cache 会强制向服务器重校验：
 *    内容没变就是一次 304（很小），变了才拿新内容。
 */
async function shellFrom(path) {
  const c = await caches.open(SHELL);
  const hit = await c.match(path);
  if (hit) {
    // 命中就返回，同时后台刷新缓存（不阻塞本次响应）
    fetch(path, { cache: "no-cache" })
      .then((r) => {
        if (r && r.ok) c.put(path, r.clone());
      })
      .catch(() => {});
    return hit;
  }
  try {
    const r = await fetch(path, { cache: "no-cache" });
    if (r && r.ok) c.put(path, r.clone());
    return r;
  } catch (e) {
    return new Response("离线且无缓存", { status: 503 });
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 接口：网络优先，失败退回缓存（离线也能看到上次数据）
  //
  // ⚠️ 只缓存**前台公开的只读接口**。受保护接口（sites / settings / ssl / run …）
  //    绝不能进缓存：既不该把后台配置留在缓存里，也不该让 401 被缓存后反复回放。
  const CACHEABLE_API = /^\/api\/(overview|site)$/;
  if (url.pathname.startsWith("/api/")) {
    if (!CACHEABLE_API.test(url.pathname)) {
      e.respondWith(
        fetch(req).catch(
          () =>
            new Response(JSON.stringify({ ok: false, error: "网络不可用" }), {
              status: 503,
              headers: { "content-type": "application/json" },
            })
        )
      );
      return;
    }
    e.respondWith(
      fetch(req)
        .then((r) => {
          if (r && r.ok) {
            const copy = r.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return r;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 三个 HTML 外壳（/、/admin、/monitor）走「缓存优先 + 后台更新」。
  // /monitor?id=xxx 与 /monitor?id=yyy 的 HTML 完全一样，所以按 pathname 取，忽略 query。
  const HTML_SHELL = ["/", "/admin", "/monitor"];
  if (HTML_SHELL.includes(url.pathname)) {
    e.respondWith(shellFrom(url.pathname));
    return;
  }

  // 其余静态资源：同样「缓存优先 + 后台更新」，且必须按 pathname 命中 precache
  e.respondWith(shellFrom(url.pathname));
});

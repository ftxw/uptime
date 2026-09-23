/* Service Worker —— CF 单平台下"秒开"的关键一环
   第二次访问起，外壳从本地缓存直接返回，完全不走网络。
   这是唯一能绕开 CF 首访 ~1s 网络成本的办法。 */

// ⚠️ 改动 /public 下的 HTML / JS / CSS 后**必须把这个版本号 +1**：
//    缓存名带版本号，activate 时会把旧缓存整个删掉。
//    不升的话静态资源是"缓存优先"，回访用户第一次导航仍会拿到旧文件，
//    表现是"部署了新代码但界面没变"（要刷新第二次才生效）。
const VERSION = "v6";
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
        // 逐个 add：某个文件缺失不至于让整次安装失败
        Promise.all(PRECACHE.map((u) => c.add(u).catch(() => null)))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** 静态资源（JS/CSS/图标）：缓存优先 + 后台更新 —— 这是"二次访问秒开"的来源 */
function shellFrom(path) {
  return caches.match(path).then((hit) => {
    const fetching = fetch(path)
      .then((r) => {
        if (r && r.ok) {
          const copy = r.clone();
          caches.open(SHELL).then((c) => c.put(path, copy));
        }
        return r;
      })
      .catch(() => hit);
    return hit || fetching;
  });
}

/**
 * HTML 外壳：**缓存优先 + 后台更新**（stale-while-revalidate）。
 *
 * 早先这里是「网络优先」，理由是"部署后刷新要看到新页面"。但实测这一条让
 * **每次进后台都白等一次跨国往返**（HTML 外壳 ~0.7s），而 HTML 内容其实很少变。
 * 改成缓存优先后：有缓存就立即出页面（0 网络等待），同时后台拉新版写入缓存，
 * 下次访问就是新的 —— 部署的更新最多滞后一次访问，代价可接受。
 * 离线且无缓存时才真的等网络。
 */
async function shellFrom(path) {
  const c = await caches.open(SHELL);
  const hit = await c.match(path);
  if (hit) {
    // 命中就返回，同时后台刷新缓存（不阻塞本次响应）
    fetch(path)
      .then((r) => {
        if (r && r.ok) c.put(path, r.clone());
      })
      .catch(() => {});
    return hit;
  }
  try {
    const r = await fetch(path);
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

  // 其余静态资源：缓存优先 + 后台更新（stale-while-revalidate）
  e.respondWith(shellFrom(req.url));
});

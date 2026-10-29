# 改动说明（对应上一轮评审）

分支：`fix/review-2026-10`，工作目录 `uptime/`。共改 9 个文件，+829 / −227。
未改动：`schema.sql`、`src/schema.js`、`src/migrations.js`（没有动表结构，`npm run check:schema` 通过）。

---

## 一、修掉的 Bug

### 1. 中文站点名 → ID 空串 → 保存静默失败（评审第 13 条）
**问题**：`"我的博客"` 经 `replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")` 得到空串，提交时 `if (!body.id || !body.url) return;` 直接吞掉——点了保存没反应，也没报错。

**改法**（`public/admin.js`）：
- 抽出 `slugifyId()`：slug 为空时退回 `site-<8位随机hex>`；
- 名字清空时不写 id，避免刚敲第一个字母就得到随机后缀；
- 提交处缺字段时写进 `#dlg-err` 并阻止提交；
- 服务端 `upserted === 0` 时不再提示"已保存"，改为报错。

**验证**：浏览器输入 `我的博客` → id 自动填 `site-71688ee5` → 保存成功，D1 里 `name` 的中文编码正确（`E68891E79A84...`）。

### 2. 证书降级阈值写错一次就静默失效（第 7 条）
**问题**：`Number(env.SSL_WARN_DAYS)` 没有兜底。环境变量写成 `30天`/`14 天` → `NaN` → `days_remaining <= NaN` 恒为 false，证书降级整条链路失效且无任何提示。

**改法**：新增 `sslWarnDays(env)`，走 `clampInt(…, 0, 90, 14)`；`stateOf` 与 `/api/overview` 回显页脚共用同一个函数。

### 3. 连续手动测失败，色条永远不红（第 11 条）
**问题**：`bumpDailyManual` 用自动探测的 `consecutive_fail` 推当天连续段。手动测试不改那列，所以每次都是 `0+1=1`，达不到 `fail_threshold`——详情页 5 条失败、色条仍是黄的。

**改法**（`src/db.js`）：改成数真实记录——「今天最后一次成功之后连续失败了几条」，一条走 `idx_checks_site_ts` 的查询就能算出来。`persistManualTest` 改为**串行**（明细 → 状态快照 → 按天汇总 → 证书），并把写失败通过 `persisted.warn` 回给前端。

**验证**：SQL 层面模拟连续 5 次失败 → `run` 依次为 1,2,3,4,5；成功后再失败 → 回到 1。

### 4. Globalping 收取侧不退避（第 2 条）
**问题**：`gpCreate` 撞 429 会写 `gp_blocked_until`，但 `gpCollect` 连 `res.ok` 都不看。

**改法**（`src/probe.js`）：`gpCollect` 显式处理 429（回传 `rateLimited` + `retryAfterMs`）与其它非 2xx（转成 `broken`）；`collectGlobalping` 把 `blockedUntil` 带回，`dispatch` 与发起侧共用同一个退避窗口。

### 5. 故障记录几乎永远为空（评审第 23 条，改动时实测发现）
**问题**：`checks_est = duration_s / (interval*60)` 用时长倒推次数。5 分钟间隔的单次失败算出来是 0~1，再和 `fail_threshold=3` 比，**默认配置下永远不显示**；而色条却是红的。

**改法**（`src/index.js`）：按翻转点切段后，用 `COUNT(*)` 数该区间内真实的失败记录，`reached = nFail >= failThreshold` 才展示。同时保留 `checks_est` 字段兼容旧前端。

**验证**：造 4 次连续失败 → 返回 `{checks: 4, reached: true}`，页面显示「4 次失败」；单次失败正确不显示。

---

## 二、性能与额度

| 改动 | 说明 |
|---|---|
| `overview` 三条查询 → 一条 | 24h 聚合从「全站窗口扫描 + GROUP BY」改为按 `site` 走 `idx_checks_site_ts` 的标量子查询；色条仍在内存里拼 |
| `buildAdminPayload` 四条 → 一条 | sites / state / ssl 一次 JOIN，`buildCategories` 保留（两条小表扫描） |
| `/api/site` 四条 → 两条 | 序列桶聚合 + 最近 N 条 + 状态翻转点合成一条 `UNION ALL`；跨段列类型显式 `CAST`，避免 SQLite 按首段定亲和性 |
| cron 省 2–3 次往返 | `collectGlobalping` 把 `remaining`（未收走的 pending）与 `lastChecked` 传下去，`dispatch`/`dueSites` 不再各查一次全表 |
| `loadSettings` 加 30s isolate 缓存 | 写侧 `saveSetting`/`saveSettings` 主动失效。**现在边缘缓存命中时不再打 D1** |
| `/api/health` 浅检查 | 默认只回绑定与版本；`?deep=1` 且已登录才查 `sqlite_master` / 探针健康 / 回填结果 |
| 手动测试加 10 秒频率闸门 | 防后台连点把额度打空 |

> `Promise.all` 保留了两处（`buildCategories` 内部、`/api/site` 的 trend+dayRows、`persistManualTest` 已串行）。理由：这两处都是「互不依赖的两条查询」，不再有 unhandled rejection 风险，且合并会显著牺牲可读性。评审第 1 条的意图（去掉"以为在并行"的误导）已经通过注释说明。

---

## 三、安全

- **`/api/test` 不再接受任意 target**：必须带 `site=<id>`，否则 400/404。原来任何登录者都能借你的额度探测任意地址。
- **`/api/site` 的 `days`/`recent` 匿名不可覆盖**：只有已登录才生效，匿名固定默认值。原先是 90×196×100 ≈ 176 万种缓存 key，可被刷爆。
- **`/api/health` 深检查需要登录**（见上表）。
- **`_headers` 对 `/admin.html`、`/admin.js` 加 `X-Robots-Tag`**。

---

## 四、前端 / 样式

- **色条**：每格加 `title` + `aria-label` + `tabindex="0"`；补 `pointerdown`（触屏）与 `focusin`（键盘）触发 tooltip。
- **折线图**：去掉 `preserveAspectRatio="none"`（原来宽屏会被横向拉伸）；y 轴顶刻度补 `ms`；整槽全失败的槽在基线画红杠，与"没测"的断线区分开。
- **后台表格**：`≤760px` 改为卡片行，编辑/删除不再需要横滑；`.tbl-wrap` 保留作为兜底。
- **对话框**：`max-height: 86dvh` + `.dialog-body` 内部滚动（`min-height:0` 必须给，否则 flex 子项不收缩），并锁背景滚动——解决 iOS 键盘盖住「保存」。
- **后台分组排序**：`sortSites` 改为先按 `CATS` 的下标排，再按名字。原来右侧分组按 Unicode 排、左侧按拖拽顺序排，拖完看起来"只改了左边"。
- **文案**：1 分钟档位标注「实际约 2 分钟」，额度估算按 `max(iv, 2)` 计，避免高估消耗。
- **手动测试 toast**：达到阈值时提示「今天已连续失败 N 次（构成故障）」，写库有残缺时显示 `⚠` 原因。

---

## 五、跑过的验证

在本地 `wrangler dev --local` + 真实 D1 + **真实 Globalping 调用**下：

1. `/api/health` 浅/深两种模式（未登录 → `tables: []` + 提示；登录后 → 8 张表齐全）
2. 中文站点名建站 → id 自动生成 → 保存成功 → D1 名字编码正确
3. cron 两轮：第一轮 3 个站点全部发起（`gpStarted` 带真实 measurement id、额度 250→241）；第二轮 `due: 0` / `collected: 3`（证明 `dueSites` 复用了刚写的时间戳，没有重复发起）→ 3 条 checks 落库、2 条证书写入
4. `/api/overview`：`up 2 / degraded 1`，延迟、SSL 剩余天数、色条、`origin` 标签（`GP:CN · Beijing/45090`、分歧时 `(0/3)`）均正确
5. `/api/site`：序列 6 点、最近检查 10 条、故障记录显示真实次数
6. `/api/test` 不带 site → 400；`/api/site?recent=200` 匿名 → 仍返回默认 20 条
7. 390px 视口下三个页面布局正常，后台表格已转卡片

---

## 六、没有动的部分

评审里列出的这些，我判断期望收益为负或不值得为一个自托管小工具引入：

- `globalping_token` 加密存 `meta`、`login_fail` 改 HMAC / 拆表 —— 会动到表结构与部署流程；
- `checks_hourly` 物化、故障事件独立建表 —— 需要新表 + 数据回填；
- Durable Object / 推送 —— 换技术栈；
- `index.js` 拆模块、前端抽 `ui.js` —— 纯重构，与本次修复混在一个 PR 里会让 review 变难；
- CSP —— 需要给三个内联脚本算哈希，属于独立的一次改动。

如果你想继续，建议按这个顺序单独做：ID 加密/拆表 → `checks_hourly` → 路由拆模块 → CSP。

# uptime

站点可用性监控。**Cloudflare Workers + D1 + Durable Object**，零 npm 依赖、零构建步骤，
`npx wrangler deploy` 直接上线。

- 前台：总览页（分组 + 30 天色条 + 证书剩余天数）、单站点详情页（延迟趋势、故障记录）
- 后台：左右两栏管理（左分类、右站点），分类与站点都可拖拽排序，需管理员密码登录
- 双探测后端：Cloudflare Durable Object（区域可控）或 Globalping（真实网络视角）

---

## 部署

D1 数据库的**创建、绑定、建表都由 `scripts/setup-d1.mjs` 自动完成**——
不需要手工 `d1 create`、不需要复制 `database_id`、不需要单独跑建表。
脚本是幂等的：库已存在就复用，多次执行不会产生副作用。

**域名不由脚本绑定**，你在 Cloudflare 控制台自己绑（见第 1 步）。这样换域名不必改仓库、
也不必重新部署。

需要你自己做的只有两件事：**绑域名**、**设管理员密码**。

### 1. 授权 + 绑定域名

```bash
npx wrangler login          # 首次需授权 Cloudflare 账号
```

`wrangler.toml` 里**刻意不写 `[[routes]]`**：域名不跟着配置走，避免每次部署都用配置去
覆写 DNS 与证书。绑定一次性敲定后长期有效：

> **Workers & Pages → 选中本项目 Worker → Settings → Domains & Routes → Add → Custom domain**

> 同理，预览环境的域名也在这个界面的 `uptime-preview` Worker 上绑。
>
> ⚠️ 不要只依赖 `workers.dev` 域名 —— 实测在中国大陆不可达。
> 之所以保留了 `workers_dev = true`：绑域名之前总得有个能自检的地址。

### 2. 设置管理员密码

密码**只来自环境变量** `ADMIN_PASSWORD`，后台没有改密码的入口（改密码 = 改这里）。

强烈建议在**部署前**就设好，这样部署完成即有保护，不存在「后台暂时开放」的窗口期：

```bash
npx wrangler secret put ADMIN_PASSWORD
```

用 GitHub 自动部署（Workers Builds）的话在 Dashboard 配一次：

> **Workers & Pages → 选中本项目 → Settings → Variables and Secrets → 添加**
> 名称填 `ADMIN_PASSWORD`，**类型必须选 Secret**（不是 Text），保存。
> 之后每次部署都会自动注入，无需重复配置。

> ### ⚠️ 为什么必须选 Secret —— 实测踩过的坑
> `wrangler deploy` 会把「版本的全部明文变量」按本地配置重写，所以
> **只在控制台填的明文（Text）变量，会在下一次部署时被整个清掉**
> （以 `wrangler.toml` 为准，`[vars]` 里没有的就视为"已删除"）。
>
> 症状很有迷惑性：变量明明填了，但 Worker 运行时读不到，后台一直提示
> 「尚未设置管理员密码」——看起来像代码 bug，其实是变量被部署清空了。
>
> | 类型 | 设置方式 | 重部署后是否保留 |
> |---|---|---|
> | Secret | 控制台或 `wrangler secret put` | ✅ 永远保留 |
> | 明文 Variables | 仅控制台填 | ❌ 会被清掉 |
> | 明文 Variables | 写进 `wrangler.toml` 的 `[vars]` | ✅ 随部署生效 |
>
> 本项目已在 `wrangler.toml` 里设了 **`keep_vars = true`**，让 wrangler 不去动
> 控制台上的变量；但**敏感值仍然推荐用 Secret**（值不会明文可见，也不进代码库）。

> 不设也能用，但**任何人都能进 `/admin` 改配置**，页面顶部会显示醒目警告。
>
> **为什么不做成后台可改**：那样就得在 D1 里存密码哈希，还要额外处理「改密码如何
> 作废旧会话」。而密码本质是部署期配置，放环境变量更简单、也更容易审计。
> 改密码的代价就是重新设置一次变量，不需要重新部署。

### 3-A. 命令行部署（一条命令）

生产：

```bash
npm run deploy
```

预览（独立 Worker + 独立数据库，改坏也碰不到生产）：

```bash
npm run deploy:preview
```

两个命令做的事完全一样，只是目标不同：

1. 列出账号下的 D1，按目标找 `uptime-db`（预览是 `uptime-db-preview`）
2. **没有就创建**，并把 `database_name` 与 `database_id` **写回 `wrangler.toml`**（即自动绑定）；
   已有则校验配置与实际是否一致，不一致就修正
3. 执行 `schema.sql` 建表
4. **校验表结构与 `schema.sql` 一致**，不一致就中止部署

然后才执行 `wrangler deploy`。全过程幂等，反复跑不会重复建库。

> 第 4 步是必要的：`schema.sql` 全部是 `IF NOT EXISTS`，对「已存在但结构较旧」的表
> **不会补列**。没有这道校验的话，改过表结构后部署照样通过，直到运行时才报
> `no such column`。本项目不做增量迁移 —— 结构变了就换库名重建（见下方）。

预览环境（`npm run deploy:preview`）与生产的差异，都是刻意的隔离：

| | 生产 | 预览 |
|---|---|---|
| Worker | `uptime` | `uptime-preview` |
| D1 | `uptime-db` | `uptime-db-preview`（**独立库**） |
| 定时任务 | 每分钟 | **不跑**（`crons = []`） |

> 预览**必须**有自己的库，否则预览上的任何写操作都会直接落到生产数据上，等于没隔离。
> 预览**必须**关掉 cron —— wrangler 的命名环境会继承顶层 `[triggers]`，不清空的话
> 两个 Worker 会每分钟各探测一遍，白白双倍消耗额度，还要多占一个 cron 名额
> （免费计划每账号上限 5 个）。
>
> 两个环境的域名同样都在控制台手动绑定，配置里不写 `[[routes]]`。

> 只想做数据库准备、不部署：`npm run setup` / `npm run setup:preview`
>
> 换库名：`D1_NAME=my-db npm run deploy`；换 D1 主区域：`D1_LOCATION=wnam npm run deploy`。

### 3-B. 连接 GitHub，推送即部署

在 Cloudflare Dashboard 操作（只需配一次）：

1. **Workers & Pages** → **Create** → 切到 **Import from Git** 标签
2. 授权 GitHub，选中本仓库（若没看到，点 *Configure GitHub app* 调整仓库可见范围）
3. 构建配置：

   | 项 | 值 |
   |---|---|
   | Framework preset | **None** |
   | Build command | 留空（本项目无构建步骤） |
   | **Deploy command** | **`npm run deploy`** |
   | Root directory | `/`（若本项目在仓库子目录里，填子目录名） |

4. 保存即触发首次部署；此后**每次 `git push` 到 `main` 都会自动部署**

> ⚠️ Deploy command 要填 `npm run deploy`，**不要**填 `npx wrangler deploy`——
> 前者会先跑 D1 准备脚本，后者会跳过，新环境上会因为没有 `database_id` 而失败。
>
> 生产分支默认 `main`。不同则在 Settings → Builds 改 *Production branch*。
> CI 环境由 Cloudflare 自动注入 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`，不需要配密钥。

### 4. 首次访问

访问 `https://<你的域名>/admin` 登录后台（第 2 步设了 `ADMIN_PASSWORD` 就在这里输入；
没设过则直接进入，页面顶部会提示尽快设置）。

> **忘了密码**：直接重设环境变量即可 ——
> ```bash
> npx wrangler secret put ADMIN_PASSWORD
> ```
> 或去 Dashboard 的 Variables and Secrets 改。设完立即生效，不需要重新部署。

### 5. 加监控站点

后台「站点 → ＋添加站点」，填名称和地址即可。分类从下拉里选（只能选已有分类，
新建/改名/删除统一在左侧「分类」栏操作）。
探测后端按站点选（`cf` / `globalping`，**必选**），**位置则由「设置 → 探测」统一配置**。

---

## 配置：都在这里改

**运行参数全部在后台「设置」里改，改完即时生效，不需要重新部署。**
`wrangler.toml` 里没有任何 `[vars]`（只有 `keep_vars = true` 与 D1 / Durable Object 等绑定）。

优先级：**后台设置（存 D1）> 环境变量 / secret > 代码内置默认**

| 分组 | 设置项 | 默认 | 说明 |
|---|---|---|---|
| 外观 | 站点标题 | 站点状态 | 前台标题与页头品牌名 |
| | 前台默认主题 | 跟随系统 | 跟随系统 / 浅色 / 深色（用户手动切换优先） |
| | 展示时区 · UTC 偏移 | 480 分钟 | 即 UTC+8。决定 30 天色条「一天」从哪一刻起算，服务端口径一致 |
| 探测 | CF 区域组 | apac | **全局**。`apac`香港、`apac-ne`首尔、`apac-se`新加坡等 |
| | Globalping 筛选 | CN+datacenter-network | **全局**。国内云机房；也可填 `CN+eyeball-network`（家庭宽带），或选「自定义…」 |
| | 每次探测点数 | 1 | ⚠️ 每个探针算 1 次额度 |
| | IP 版本 | 4 | 4 / 6 |
| | 探测超时 | 8000 ms | |
| 证书 | SSL 检测筛选 | CN+datacenter-network | 与站点筛选解耦，避免窄筛选找不到探针 |
| | 每轮补检数 | 2 | 单站点约消耗 13 个子请求，别调大 |
| | 降级阈值 | 14 天 | 剩余 ≤ 该值判为「降级」 |
| 高级 | 子请求预算 | 30 | 免费层上限 50，需给 D1 查询留余量 |
| | 明细保留天数 | 30 | 过期记录由 cron 每天自动清理 |
| 告警 | Webhook 地址 | 空 | 可直接对接飞书 / 钉钉 / Server 酱 |

> **为什么位置（CF 区域组 / Globalping 筛选）是全局而不是每站点一份**：
> 一个站点只会解析出唯一后端，所以两份位置必然只有一份生效 ——
> 另一份是死配置，放出来只会让人误以为能分别控制。

### 敏感值（都用环境变量）

| 名称 | 说明 |
|---|---|
| `ADMIN_PASSWORD` | **必设**。后台唯一的登录凭据；不设则后台完全开放 |
| `GLOBALPING_TOKEN` | 可选。Globalping 额度 250 → 500 次/小时 |
| `ALERT_WEBHOOK` | 可选。告警地址（也能在后台「设置 → 告警」里填） |

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put GLOBALPING_TOKEN
npx wrangler secret put ALERT_WEBHOOK
```

用 GitHub 自动部署时，改在 Dashboard：**项目 → Settings → Variables and Secrets**（类型选 Secret）。

> `ADMIN_SECRET` 用于固定会话签名密钥（不设也行，会在 D1 里自动生成随机值）。

---

## 接口

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/overview` | 公开 | 统计 + 分组 + 30 天色条 + SSL，边缘缓存 30s |
| GET | `/api/site?id=&hours=` | 公开 | 详情页：窗口统计 + 延迟序列 + 故障记录 |
| GET | `/api/admin` | 登录 | 站点 + 状态 + 分类 + 证书 + 设置（**一次拿全**） |
| POST | `/api/login` `/api/logout` | 公开 | |
| GET/POST | `/api/settings` | 登录 | |
| GET/POST/DELETE | `/api/categories` | 登录 | |
| POST | `/api/sites`（写） | 登录 | |
| POST | `/api/run`、`/api/test` | 登录 | 调试：手动跑一轮 / 测单个后端 |

Token 类设置**只写不读**——读取接口只返回掩码（`glp_****ghij`）和是否存在。

---

## 结构

```
src/
  index.js    路由（鉴权、接口）
  db.js       数据层：所有 SQL 集中在此
  probe.js    探测：CF Durable Object / Globalping 两后端
  prober.js   Durable Object 实现
  auth.js     常量时间比较 + HMAC 签名会话（密码只比环境变量，不存哈希）
public/
  index.html / app.js        前台总览
  monitor.html / monitor.js  站点详情（图表为原生 SVG，无图表库）
  admin.html / admin.js      后台
  app.css / sw.js            样式 / Service Worker
scripts/
  setup-d1.mjs  自动准备 D1：建库 + 写绑定 + 建表（幂等）
                  production / preview / local 三个目标
  bump-sw.mjs   按 public/ 内容哈希自动重写 sw.js 版本号（部署前跑）
schema.sql      建表语句（全部 IF NOT EXISTS，可重复执行）
wrangler.toml   只有绑定配置（D1 / DO / 静态资源），**不含域名**；运行参数一律在后台「设置」里改
```

数据表：`sites` `checks` `state` `pending` `ssl` `categories` `meta`

---

## 几点设计取舍

- **探测为什么分两阶段**：Workers 免费计划每次调用最多 50 个子请求，轮询等结果会吃光额度。
  Globalping 改为「本轮发起、下轮收取」，每站点压到 2 个子请求。
- **后台为什么要聚合接口**：实测从国内访问 CF 边缘，单个请求 TTFB 中位约 780ms（静态文件、
  走缓存、不进 Worker 也是这个数）——瓶颈在链路，不在数据库。所以优化方向是**减少请求数**，
  后台从串行 3 个请求合并成 1 个 `/api/admin`。
- **密码为什么不做成后台可改**：那样就得在 D1 存哈希、还要处理「改密码如何作废旧会话」。
  密码本质是部署期配置，放环境变量更简单、更容易审计，也省掉一类状态。
  登录仍用常量时间比较，且 `ADMIN_PASSWORD` 为空时 fail-closed。
- **位置为什么是全局而非每站点**：一个站点只解析出唯一后端，两份位置必然只有一份生效。
- **登录限速在 D1 上计数**：低流量下 Workers 经常每次请求都新建 isolate，内存 Map 形同虚设。
- **域名为什么不写进 `wrangler.toml`**：`routes` 是声明式的，一旦写进来，每次部署都会按配置
  重建 DNS 与证书；而控制台手动加的域名是独立持有的路由资源，不在配置里就不会被 wrangler 动。
  交给人工绑定后，换域名不必改仓库、也不必重新部署。
- **所有非 GET 请求为什么要校验同源**：Cookie 是 `SameSite=Lax`，它挡不住"会改状态的 GET 导航"。
  与其依赖"每个写接口都记得写成 POST"，不如统一加一道校验（`Origin` → `Sec-Fetch-Site` → 拒绝）。

---

## 本地开发

```bash
npm install     # 装 wrangler（唯一 devDependency）
npm run dev
```

默认 `http://localhost:8787`。`npm run dev` 会先在本机的 D1 副本上建表再启动，直接可用。

> `npm install` 建议不要跳过：`scripts/setup-d1.mjs` 优先用本地的 wrangler，
> 只有本地没装时才退回 `npx`，而 npx 缓存损坏过（缺 `ws` 模块）。

### 命令一览

| 命令 | 作用 |
|---|---|
| `npm run dev` | 本地起服务（先给本机 D1 副本建表） |
| `npm run deploy` | 准备生产库 + 部署生产 |
| `npm run deploy:preview` | 准备预览库 + 部署预览 |
| `npm run setup` | 只准备生产库，不部署 |
| `npm run setup:preview` | 只准备预览库，不部署 |
| `npm run sw:bump` | 单独重写 Service Worker 版本号 |

四个部署/准备类命令都会自动完成「建库 → 写绑定 → 建表 → 校验结构」，
区别只在于目标是生产还是预览、以及最后是否执行 `wrangler deploy`。

其它常用：

```bash
npx wrangler secret put ADMIN_PASSWORD      # 设/改管理员密码
npx wrangler d1 execute uptime-db --remote --command "SELECT COUNT(*) FROM sites"
npx wrangler tail                            # 看实时日志
```

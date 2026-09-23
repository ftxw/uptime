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
脚本是幂等的：库已存在就复用，表已存在就跳过（`schema.sql` 全部 `IF NOT EXISTS`）。

需要你自己做的只有两件事：**改域名**、**设管理员密码**。

### 1. 授权 + 改域名

```bash
npx wrangler login          # 首次需授权 Cloudflare 账号
```

打开 `wrangler.toml`，把 `[[routes]]` 换成你的域名：

```toml
[[routes]]
pattern = "uptime.example.com"
custom_domain = true
```

> `custom_domain = true` 会自动建 DNS 记录并签发证书，域名 DNS 需托管在 Cloudflare。
> ⚠️ 不要用 `workers.dev` 域名——实测在中国大陆不可达。

### 2. 设置管理员密码（推荐）

密码可以**在部署前用环境变量设好**，这样部署完成即有保护，不存在「后台暂时开放」的窗口期：

```bash
npx wrangler secret put ADMIN_PASSWORD
```

用 GitHub 自动部署（Workers Builds）的话在 Dashboard 配一次：

> **Workers & Pages → 选中本项目 → Settings → Variables and Secrets → 添加**
> 名称填 `ADMIN_PASSWORD`，类型选 **Secret**（不是 Text），保存。
> 之后每次部署都会自动注入，无需重复配置。

> 不设也能用，但**首次访问 `/admin` 时没有密码，任何人在你设置之前都能改配置** ——
> 那种「先开放、再进后台设」的方式只适合自己马上就去配的场景。
>
> 环境变量的优先级**高于**后台设置的密码。设了它之后，后台「设置 → 安全」里的
> 密码输入框会变灰并提示「此处设置暂不生效」。

### 3-A. 命令行部署（一条命令）

```bash
npm run deploy
```

它会依次做三件事：

1. 列出账号下的 D1，找 `site-monitor-db`
2. **没有就创建**，并把 `database_name` 与 `database_id` **写回 `wrangler.toml`**（即自动绑定）；
   已有则校验配置与实际是否一致，不一致就修正
3. 执行 `schema.sql` 建表

然后才执行 `wrangler deploy`。全过程幂等，反复跑不会重复建库、不会丢数据。

> 只想做数据库准备、不部署：`npm run setup`
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
没设过则直接进入，页面会提示尽快设置）。

> **忘了密码**：用环境变量覆盖一个最快 —— `npx wrangler secret put ADMIN_PASSWORD`
> （环境变量优先级更高，设完立即生效）。后台里改不了已经忘记的旧密码，
> 因为根本登不进去。

### 5. 加监控站点

后台「站点 → ＋添加站点」，填名称和地址即可。分类可下拉选择，也可选「＋ 新建分类…」顺手建一个。

---

## 配置：都在这里改

**运行参数全部在后台「设置」里改，改完即时生效，不需要重新部署。**
`wrangler.toml` 里没有任何 `[vars]`，只有 D1 与 Durable Object 的绑定。

优先级：**后台设置（存 D1）> 环境变量 / secret > 代码内置默认**

| 分组 | 设置项 | 默认 | 说明 |
|---|---|---|---|
| 外观 | 站点标题 | 站点状态 | 前台标题与页头品牌名 |
| | 前台默认主题 | 跟随系统 | 跟随系统 / 浅色 / 深色（用户手动切换优先） |
| 探测 | 默认后端 | auto | `auto`＝配了 token 走 Globalping，否则回落 CF |
| | CF 区域组 | apac | `apac`香港、`apac-ne`首尔、`apac-se`新加坡等 |
| | Globalping 筛选 | CN+datacenter-network | 国内云机房；也可填 `CN+eyeball-network`（家庭宽带） |
| | 每次探测点数 | 1 | ⚠️ 每个探针算 1 次额度 |
| | IP 版本 | 4 | 4 / 6 |
| | 探测超时 | 8000 ms | |
| 证书 | SSL 检测筛选 | CN+datacenter-network | 与站点筛选解耦，避免窄筛选找不到探针 |
| | 每轮补检数 | 2 | 单站点约消耗 13 个子请求，别调大 |
| | 降级阈值 | 14 天 | 剩余 ≤ 该值判为「降级」 |
| 高级 | 子请求预算 | 30 | 免费层上限 50，需给 D1 查询留余量 |
| | 明细保留天数 | 30 | 过期记录由 cron 每天自动清理 |
| 告警 | Webhook 地址 | 空 | 可直接对接飞书 / 钉钉 / Server 酱 |
| 安全 | 管理员密码 | 未设置 | 设置后后台要求登录，30 天免登录 |

### 敏感值

三项都可以在后台填，只有想用环境变量固定它们时才需要配 secret：

| 名称 | 用环境变量配的理由 |
|---|---|
| `ADMIN_PASSWORD` | **推荐**。部署即生效，无「后台暂未设密码」的开放窗口；也是忘记密码时的唯一救法 |
| `GLOBALPING_TOKEN` | Globalping 额度 250 → 500 次/小时 |
| `ALERT_WEBHOOK` | 告警地址；想避免配置泄露到数据库时用它 |

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put GLOBALPING_TOKEN
npx wrangler secret put ALERT_WEBHOOK
```

用 GitHub 自动部署时，改在 Dashboard：**项目 → Settings → Variables and Secrets**（类型选 Secret）。

> 环境变量的优先级高于后台设置。所以设了 `ADMIN_PASSWORD` 后，
> 后台的密码框会变灰并提示「此处设置暂不生效」。
>
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
| POST | `/api/sites`（写） `/api/sort`（排序） | 登录 | |
| POST | `/api/run`、GET `/api/test` | 登录 | 调试：手动跑一轮 / 测单个后端 |

Token 类设置**只写不读**——读取接口只返回掩码（`glp_****ghij`）和是否存在。

---

## 结构

```
src/
  index.js    路由（鉴权、接口）
  db.js       数据层：所有 SQL 集中在此
  probe.js    探测：CF Durable Object / Globalping 两后端
  prober.js   Durable Object 实现
  auth.js     PBKDF2 密码哈希 + HMAC 签名会话
public/
  index.html / app.js        前台总览
  monitor.html / monitor.js  站点详情（图表为原生 SVG，无图表库）
  admin.html / admin.js      后台
  app.css / sw.js            样式 / Service Worker
scripts/
  setup-d1.mjs  部署前自动建库 + 绑定 + 建表（幂等）
schema.sql      建表语句（全部 IF NOT EXISTS）
wrangler.toml   只有绑定配置；运行参数一律在后台「设置」里改
```

数据表：`sites` `checks` `state` `pending` `ssl` `categories` `meta`

---

## 几点设计取舍

- **探测为什么分两阶段**：Workers 免费计划每次调用最多 50 个子请求，轮询等结果会吃光额度。
  Globalping 改为「本轮发起、下轮收取」，每站点压到 2 个子请求。
- **后台为什么要聚合接口**：实测从国内访问 CF 边缘，单个请求 TTFB 中位约 780ms（静态文件、
  走缓存、不进 Worker 也是这个数）——瓶颈在链路，不在数据库。所以优化方向是**减少请求数**，
  后台从串行 3 个请求合并成 1 个 `/api/admin`。
- **密码哈希只用了 5000 轮 PBKDF2**：Workers 免费版 CPU 上限 10ms/次。参考项目跑在
  EdgeOne（200ms 预算）用 21 万轮，直接照搬会超限。
- **登录限速在 D1 上计数**：低流量下 Workers 经常每次请求都新建 isolate，内存 Map 形同虚设。

---

## 本地开发

```bash
npm install     # 可选：只为装 wrangler。跳过则下面命令改用 npx wrangler ...
npm run dev     # 等价于 wrangler dev
```

默认 `http://localhost:8787`。本地用的是 D1 的本地副本，首次需建表：

```bash
npm run db:init:local
```

其他命令：`npm run deploy`（部署）、`npm run db:init`（对线上库建表）。

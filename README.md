# uptime

站点可用性监控。**Cloudflare Workers + D1 + Durable Object**，零 npm 依赖、零构建步骤，
`npx wrangler deploy` 直接上线。

- 前台：总览页（分组 + 30 天色条 + 证书剩余天数）、单站点详情页（延迟趋势、故障记录）
- 后台：左右两栏管理（左分类、右站点），分类与站点都可拖拽排序，需管理员密码登录
- 双探测后端：Cloudflare Durable Object（区域可控）或 Globalping（真实网络视角）

---

## 部署

两种部署方式，选一种即可：**A. 命令行手动部署**、**B. 连接 GitHub 后推送即部署**。
两种方式部署的是同一个 Worker，可以随时切换。

### 0. 一次性准备

```bash
npx wrangler login     # 首次使用需授权 Cloudflare 账号
```

> 项目**运行时零依赖**（Worker 只跑源码，没有第三方库）。`package.json` 里唯一的
> 依赖是 `wrangler` 本身（devDependency），只是为了让命令行和 CI 用同一个确定版本。
> 不装也能跑——`npx wrangler ...` 会自动取用。

### 1. 建 D1 数据库并初始化表

```bash
# 建库，输出里会给出 database_id
npx wrangler d1 create site-monitor-db

# 把上一步得到的 database_id 填进 wrangler.toml 的 [[d1_databases]]
#   database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

# 建表（幂等：重复执行不会报错、也不会动已有数据，升级时可放心重跑）
npx wrangler d1 execute site-monitor-db --remote --file=./schema.sql
```

> ⚠️ 这一步**只需做一次**。换用 GitHub 自动部署时，CI 不会替你建表。

### 2. 改域名

`wrangler.toml` 里的 `[[routes]]` 换成你自己的域名：

```toml
[[routes]]
pattern = "uptime.example.com"
custom_domain = true
```

> `custom_domain = true` 会自动建 DNS 记录并签发证书，域名的 DNS 需托管在 Cloudflare。
> ⚠️ 不要用 `workers.dev` 域名——实测在中国大陆不可达。

### 3-A. 命令行部署

```bash
npx wrangler deploy
```

### 3-B. 连接 GitHub，推送即部署

在 Cloudflare Dashboard 操作（只需配一次）：

1. **Workers & Pages** → **Create** → 切到 **Import from Git** 标签
2. 授权 GitHub，选中本仓库（若没看到，点 *Configure GitHub app* 调整仓库可见范围）
3. 构建配置填这几项：

   | 项 | 值 |
   |---|---|
   | Framework preset | **None** |
   | Build command | 留空（本项目无构建步骤） |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | `/`（若仓库里本项目在子目录，填子目录名） |

4. 保存后即触发首次部署；此后**每次 `git push` 到 `main` 都会自动部署**

> 生产分支默认是 `main`。若你的默认分支不同，在 Settings → Builds 里改 *Production branch*。
>
> CI 环境由 Cloudflare 自动注入 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`，
> 不需要手动配置密钥。

### 4. 打开后台设密码

访问 `https://<你的域名>/admin`。**首次进入没有密码，任何人都能改配置**，
所以第一件事是在「设置 → 安全」里设管理员密码。设完之后后台就要求登录了。

> 如果忘了密码：用环境变量设一个救援密码，它会覆盖后台设的密码。
> ```bash
> npx wrangler secret put ADMIN_PASSWORD
> ```

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

### 敏感值（可选，用 secret）

后台里也能填 Globalping token 和告警地址；**只有想用环境变量覆盖时才需要 secret**：

```bash
npx wrangler secret put GLOBALPING_TOKEN   # Globalping 额度 250 → 500 次/小时
npx wrangler secret put ALERT_WEBHOOK      # 告警地址
npx wrangler secret put ADMIN_PASSWORD     # 救援密码（优先级高于后台设的密码）
```

`ADMIN_SECRET` 用于固定会话签名密钥，不设也没关系——默认会在 D1 里生成一个随机值。

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
schema.sql   建表语句
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

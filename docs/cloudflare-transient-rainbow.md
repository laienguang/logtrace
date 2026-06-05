# Cloudflare 埋点数据看板 — 实施方案

## Context

当前仓库是 Cloudflare Worker + D1 的官方 `comments` 模板（[src/index.ts](src/index.ts)、[migrations/0001_create_comments_table.sql](migrations/0001_create_comments_table.sql)），除了 D1 binding `DB` 和已分配的 `database_id` 之外，没有任何业务代码。目标是把它改造成一个端到端的埋点数据看板：

- **接收**：暴露 HTTP `/collect` 接口，任意来源（Web/服务端/移动端/小程序）都能 POST 上报
- **存储**：D1 单表存原始事件 + 少量索引（事件量 < 10w/天，D1 完全够用，且明细/过滤查询比 Analytics Engine 灵活）
- **查询**：Worker 提供 dashboard API（趋势图、实时流、明细分页）
- **展示**：单页看板，支持实时事件流（最近 N 分钟）、PV/UV/事件计数趋势图、事件明细 + 过滤
- **鉴权**：Google OAuth (OIDC) 登录，签名 cookie 维持会话，邮箱白名单；`/collect` 保持公开
- **不在范围内**：客户端 SDK（用户已明确）；用户体系；漏斗 / 留存 / 自定义 SQL（后期可加）

整体架构：单个 Worker 承担 ingest + dashboard API + 静态资源 + OAuth 回调；存储用 D1；鉴权在 Worker 里自己实现 Google OIDC 登录 → 签发 HMAC session cookie；前端用 React + Vite + ECharts，构建产物通过 Workers Assets 挂载。

---

## 1. 数据模型（D1）

新增 migration `migrations/0001_init.sql`，并删除 `comments` 相关代码与旧 migration（模板示例无业务价值）。两张表：

```sql
CREATE TABLE apps (
  app_id      TEXT UNIQUE NOT NULL,          -- app_<10位hex>，稳定不变，用于 events.app_id 引用与所有 API 过滤
  app_key     TEXT PRIMARY KEY,              -- ak_xxx，调用方放在 X-App-Key（鉴权用）
  app_secret  TEXT NOT NULL,                 -- sk_xxx，明文存（看板里可再次查看）
  name        TEXT NOT NULL,                 -- "主站"、"App Android" 之类，纯显示标签，可随意改
  status      TEXT NOT NULL DEFAULT 'active',-- active | revoked
  created_at  INTEGER NOT NULL,
  created_by  TEXT                           -- 创建人的 Google 邮箱（来自 session）
);
CREATE INDEX idx_apps_app_id ON apps(app_id);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,           -- 自增
  event_name  TEXT    NOT NULL,              -- 例如 page_view / click / custom_xxx
  distinct_id TEXT,                          -- 匿名 ID：客户端首次访问生成的 UUID，存 cookie / localStorage，登录前后都存在
  user_id     TEXT,                          -- 业务用户 ID：登录后由调用方在上报时带上；未登录为 NULL
  session_id  TEXT,                          -- 一次访问会话 ID
  client_ts   INTEGER,                       -- 客户端时间 (ms)
  server_ts   INTEGER NOT NULL,              -- 服务端入库时间 (ms)，所有查询都基于这个
  url         TEXT,
  referrer    TEXT,
  ua          TEXT,
  ip_country  TEXT,                          -- 由 request.cf.country 写入，不存 IP 本身
  app_id      TEXT NOT NULL,                 -- = 鉴权命中的 apps.app_id，服务端写入，调用方不能伪造；稳定 ID，rename 也不影响
  props       TEXT                           -- 自定义属性 JSON 字符串，单条 ≤ 4KB
);

CREATE INDEX idx_events_server_ts        ON events(server_ts);
CREATE INDEX idx_events_name_server_ts   ON events(event_name, server_ts);
CREATE INDEX idx_events_did_server_ts    ON events(distinct_id, server_ts);
CREATE INDEX idx_events_uid_server_ts    ON events(user_id, server_ts) WHERE user_id IS NOT NULL;
CREATE INDEX idx_events_appid_server_ts  ON events(app_id, server_ts);
```

要点：
- **`app_id` vs `app_key` vs `name`** 三者职责清晰：
  - `app_id` —— 稳定永不可改的内部引用，所有过滤/聚合都基于它；用户在 UI 里能看到、能复制（用于外部系统集成），但**不会**手动输入
  - `app_key` / `app_secret` —— 鉴权凭证，可随时 rotate（轮换不影响 app_id 与历史事件）
  - `name` —— 纯显示，随便改，不会破坏 events 关联
- **`distinct_id` vs `user_id` 分开**：前者是匿名设备/浏览器维度（永远有值），后者是业务账号维度（登录后才有）；UV 默认按 `distinct_id`，「登录用户数」按 `COUNT(DISTINCT user_id) WHERE user_id IS NOT NULL`
- 不在本服务里做 alias 映射表（匿名 → 实名），上报方自己决定两个字段；后续真有需求再加 `identities` 表
- 所有时间相关查询统一走 `server_ts`，避免客户端时钟漂移
- `props` 走 JSON 字符串，SQLite 的 `json_extract()` 足够看板用
- 留存期：先不做归档；后续可加 cron 删除 90 天前数据，或导出到 R2

---

## 2. Worker 路由（[src/index.ts](src/index.ts) 重写）

替换现有的 `comments` 单文件实现，目录结构：

```
src/
  index.ts            路由分发 + CORS
  routes/
    collect.ts        POST /collect — 摄入
    eventsApi.ts      GET  /api/events           明细 + 过滤
                      GET  /api/events/stream    实时流（since=ts）
                      GET  /api/events/names     去重事件名（过滤器下拉用）
    metricsApi.ts     GET  /api/metrics/timeseries  PV/UV/count
    appsApi.ts        GET    /api/apps         列出应用
                      POST   /api/apps         新建应用（自动生成 ak_/sk_）
                      PATCH  /api/apps/:key    改名、revoke / 恢复
                      DELETE /api/apps/:key    硬删除（仅允许已 revoked 的）
    auth.ts           GET  /auth/google      重定向到 Google consent
                      GET  /auth/callback    交换 code、校验 id_token、签发 session cookie
                      POST /auth/logout      清 cookie
  db.ts               D1 prepared statement 封装
  session.ts          HS256 签发/校验 session JWT（用 SESSION_SECRET）
```

路径划分与鉴权：

| 路径 | 鉴权 | 备注 |
| --- | --- | --- |
| `POST /collect`        | `X-App-Key` + `X-App-Secret` 头匹配 `apps` 表中 active 行 | CORS `*`，载荷有上限；apps 表 60s 缓存 |
| `GET /auth/*`          | 无 | OAuth 流程自身 |
| `GET /api/*`           | session cookie | 中间件校验 HS256 JWT cookie，无效返回 401 |
| `GET /` 等 HTML 路径   | session cookie | 无 session 时 302 到 `/auth/google` |
| `GET /assets/*` 等静态 | 无 | JS/CSS/字体放行，避免登录页加载不出来 |

### 2.1 `/collect` 关键行为

- 支持单条 `{event, ...}` 和批量 `{events: [...]}`
- **鉴权**：请求头 `X-App-Key` + `X-App-Secret` → 查 `apps` 表，要求行存在且 `status='active'`；secret 用 `crypto.subtle.timingSafeEqual` 做常数时间比较；不匹配返回 `403`
  - 鉴权结果（命中的 `apps.app_id`）服务端写入 `events.app_id`，调用方上报 body 里若传了 `app`/`app_id` 字段一律忽略
  - app 行的内存 LRU 缓存 60s，避免每次上报都打 D1
- 服务端补字段：`server_ts = Date.now()`，`ip_country = request.cf?.country`，`ua = request.headers.get('user-agent')`
- 校验：`event_name` 必填且 ≤ 64 字符；`props` 序列化后 ≤ 4KB；单批 ≤ 50 条
- 写入：单条用 `prepare().bind().run()`；批量用 `D1.batch()` 一次提交（D1 单 statement 最多 ~100 binding，注意拆批）
- CORS：`Access-Control-Allow-Origin: *`，允许跨域上报
- 返回 `204` + CORS 头；任何解析错误返回 `400` 但不阻塞调用方

> 注意：`app_secret` 在浏览器场景必然半公开（前端 JS 能看到），本方案明确接受这点 —— secret 的作用是「可单独吊销 + 区分租户」，不是真防伪造。被滥用时在「应用管理」里 revoke 即可。

### 2.2 Dashboard API

所有 API 凡是涉及 app 过滤的查询参数统一改用 `?app_id=<app_xxx>`（不再用 `?app=<name>`）。事件响应除了 `app_id` 还会附带 `app_name`（由 Worker 端用 apps map 解析当前 name 注入；apps 列表内存缓存 30s）。

- `GET /api/metrics/timeseries?metric=pv|uv|users|count&event=&app_id=&from=&to=&granularity=hour|day`
  - PV = `COUNT(*)`；UV = `COUNT(DISTINCT distinct_id)`；users = `COUNT(DISTINCT user_id) WHERE user_id IS NOT NULL`（登录用户数）；count 支持按 `event_name` 过滤
  - 用 `(server_ts / bucket_ms) * bucket_ms` 做时间桶，`GROUP BY` 之
- `GET /api/events/stream?since=<server_ts>&app_id=&event=&limit=100`
  - 看板每 3–5s 轮询；返回 `server_ts > since` 的事件，按 `server_ts DESC`
  - 响应每条事件附 `app_name`
- `GET /api/events?event=&app_id=&distinct_id=&user_id=&from=&to=&limit=&cursor=`
  - 游标分页（按 `server_ts, id` 复合游标），便于翻页/导出
  - 响应每条事件附 `app_name`
- `GET /api/events/names`
  - `SELECT DISTINCT event_name FROM events WHERE server_ts > now-7d`，给过滤下拉用

---

## 3. 看板前端

新增 `web/` 子目录（Vite + React + TypeScript + ECharts），构建到 `web/dist`。技术选择理由：
- React + Vite：生态成熟，shadcn/ui 拼装快
- ECharts：中文场景默认选择，趋势图/明细表/实时流都现成
- 不引入复杂状态管理：fetch + SWR 足矣

页面结构：

**0. 登录页 `/login`**（未登录用户唯一可见的页面）
- 居中卡片：logo + 标题「logtrace」+ 副标题「埋点数据看板」+ 一颗大的 **「使用 Google 登录」** 按钮（带 Google 多色 G 图标）
- 按钮点击 = `window.location.href = '/auth/google?next=<encoded next>'`
- URL 上若有 `?error=` 参数（来自回调失败时的回跳）则在按钮上方红字展示，例如 `email_not_allowed: xxx@gmail.com 不在白名单`
- URL 上若有 `?next=` 参数则透传给 `/auth/google`，登录完成后回到用户原本想看的页面

**1–4. 已登录主体**（tab 切换）
1. **概览**：今日 PV / UV / 登录用户数 / 事件数 卡片 + 7 天趋势折线图（`/api/metrics/timeseries`），顶部可按 `app` 过滤
2. **实时**：最近 5 分钟事件流表格，3s 轮询 `/api/events/stream`，可按 `app` / `event_name` 过滤
3. **明细**：过滤器（app、事件名、distinct_id、user_id、时间范围）+ 分页表格（`/api/events`），单行可展开看 `props` JSON
4. **应用管理**：列表展示 `app_id`（mono 字体，可复制，**首要标识**）、`name`（行内可编辑）、`app_key`（可复制）、`app_secret`（点查看，可复制）、状态、创建者、创建时间、操作；顶部「新建」按钮弹窗只输入 name，提交后展示三件套（app_id / app_key / app_secret）；可改名、可吊销/恢复、可**删除**（删除按钮仅在 revoked 状态下出现，弹窗要求输入应用名才能确认）

顶栏全局过滤：下拉显示 `name`，绑定值是 `app_id`，传给所有 tab 的 API 调用。

路由：SPA 用 `window.location.pathname` 判断 —— `/login` 走登录页组件，其他全部走主体（tab 切换走 hash）。无需引入 React Router。

挂载方式：[wrangler.json](wrangler.json) 增加 `assets` 配置：

```jsonc
"assets": {
  "directory": "./web/dist",
  "binding": "ASSETS",
  "not_found_handling": "single-page-application"
}
```

Worker 入口里：`/api/*` 和 `/collect` 路由命中后返回，其余 `request` 透传给 `env.ASSETS.fetch(request)`，由 Workers Assets 负责 SPA fallback。

---

## 4. Google OAuth 登录

不依赖 Cloudflare Access，自己在 Worker 里跑 OIDC 流程。

### 4.1 GCP 控制台一次性配置

1. console.cloud.google.com → 新建 / 选一个项目
2. APIs & Services → OAuth consent screen：User Type 选 External，Scopes 勾 `openid email profile`
3. Credentials → Create Credentials → OAuth client ID → Web application
   - Authorized redirect URI：
     - 开发：`http://localhost:8282/auth/callback`
     - 线上：`https://<worker-domain>/auth/callback`
4. 记下 `Client ID` 和 `Client Secret`

### 4.2 Worker 端流程

`GET /auth/google`：
- 生成随机 `state`，写入 HttpOnly cookie `oauth_state`（5 分钟有效）
- 302 跳到 `https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=...&response_type=code&scope=openid%20email%20profile&state=<state>&prompt=select_account`

`GET /auth/callback?code=&state=`：
1. 比对 `state` 与 cookie；不符直接 400
2. POST `https://oauth2.googleapis.com/token` 用 code 换 `id_token`
3. 校验 `id_token`：拉 `https://www.googleapis.com/oauth2/v3/certs`（JWKS，结果缓存到 [KV 或] 内存 `caches.default`，避免每次请求都拉），校验 `iss`、`aud=client_id`、`exp`、签名
4. 取 `email`，与环境变量 `ALLOWED_EMAILS`（逗号分隔的具体邮箱）或 `ALLOWED_EMAIL_DOMAIN`（如 `yourcompany.com`）比对；不在白名单 → **302 回 `/login?error=email_not_allowed&email=<email>`**，让登录页展示原因（不再返回裸 403）
5. 用 `SESSION_SECRET` HS256 签 `{sub: email, exp: now+24h}`，Set-Cookie：
   `session=<jwt>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`
6. 302 回 `/`

中间件（所有 `/api/*` 与 HTML 请求都走）：
- 读 `session` cookie，HS256 验签 + `exp` 校验
- API 路径失败 → `401`
- HTML 路径失败 → 302 到 **`/login?next=<orig>`**（不再直接跳 Google），让用户先看到落地页
- 例外：HTML 请求路径本身就是 `/login` 时不做鉴权（避免回环），直接透传给 `env.ASSETS.fetch` 由 SPA 渲染
- 前端 [api.ts](web/src/api.ts) 收到 401 时同样 redirect 到 `/login?next=<current>`，而不是 `/auth/google`

`POST /auth/logout`：清 cookie，302 回登录页。

### 4.3 配置项

`wrangler.json` 的 `vars` 放非敏感：
```jsonc
"vars": {
  "GOOGLE_CLIENT_ID": "xxx.apps.googleusercontent.com",
  "ALLOWED_EMAIL_DOMAIN": "yourcompany.com",      // 二选一
  "ALLOWED_EMAILS": "you@gmail.com,teammate@gmail.com"
}
```

敏感的用 `wrangler secret put`：
- `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET`（随机 32 字节 base64）

本地开发：放 `.dev.vars`（已被 `.gitignore` 默认覆盖）。

---

## 5. 关键文件清单

需要新增 / 修改：

- `migrations/0001_create_comments_table.sql` — **删除**
- `migrations/0001_create_events_table.sql` — 新建（schema 见上）
- [src/index.ts](src/index.ts) — 改写为路由分发
- [src/renderHtml.ts](src/renderHtml.ts) — **删除**
- `src/routes/collect.ts`、`src/routes/eventsApi.ts`、`src/routes/metricsApi.ts`、`src/routes/appsApi.ts`、`src/routes/auth.ts` — 新建
- `src/db.ts`、`src/session.ts`、`src/apps.ts`（apps 表查询 + 缓存） — 新建
- `web/` — Vite 项目（独立 `package.json`、`vite.config.ts`）
  - 新增 `web/src/Login.tsx`（登录落地页，Google 按钮 + 错误提示）
  - [web/src/App.tsx](web/src/App.tsx) 增加 `pathname === '/login'` 分支
  - [web/src/api.ts](web/src/api.ts) 401 跳转目标改为 `/login`
- [package.json](package.json) — 顶层 scripts 增加 `build:web`（`cd web && vite build`），`predeploy` 串联 `build:web` + migrations apply
- [wrangler.json](wrangler.json) — 增加 `assets` binding，`vars` 放 `GOOGLE_CLIENT_ID` / `ALLOWED_EMAILS` 等
- 控制台 / CLI：`wrangler secret put GOOGLE_CLIENT_SECRET`、`wrangler secret put SESSION_SECRET`
- `worker-configuration.d.ts` — `npm run cf-typegen` 重生

---

## 6. 验证步骤

1. **本地起 DB**：`pnpm seedLocalD1`（已有脚本，会跑 migrations 到本地）
2. **本地起 Worker**：`pnpm dev`（[package.json](package.json) 的 `dev` 脚本改为 `wrangler dev --port 8282`；本地用 `.dev.vars` 注入 secrets）
3. **建第一个 app**：先登录看板 → 应用管理 tab → 新建 `main-site` → 复制 ak_/sk_
4. **造数据**：
   ```bash
   for i in 1 2 3; do
     curl -X POST http://localhost:8282/collect \
       -H 'content-type: application/json' \
       -H 'x-app-key: ak_xxx' \
       -H 'x-app-secret: sk_xxx' \
       -d "{\"event_name\":\"page_view\",\"distinct_id\":\"anon-$i\",\"user_id\":\"u-$i\",\"url\":\"/home\"}"
   done
   ```
5. **看 SQL**：`npx wrangler d1 execute logtrace --local --command "SELECT COUNT(*), event_name FROM events GROUP BY event_name"`
6. **打开看板**：浏览器访问 `http://localhost:8282/` → 应 302 到 `/login`（看到带 Google 按钮的落地页）→ 点按钮跳 Google → 登录 → 回跳 → 看到四个 tab 与数据
   - 单独验证登录页：直接访问 `/login` 即使未登录也能正常渲染（不回环）
   - 单独验证错误提示：临时把 `ALLOWED_EMAILS` 改成别的邮箱重启 → 登录完成后应回到 `/login?error=email_not_allowed&email=...` 并红字显示
7. **鉴权边界自查**：
   - `curl http://localhost:8282/api/events` 不带 cookie → 401
   - `curl -X POST http://localhost:8282/collect -d '{...}'` 不带 ak/sk → 403
   - 带 revoked 状态的 app → 403
   - 带正确 ak/sk → 204，且入库 `events.app = apps.name`
   - body 里手动塞 `"app":"伪造"` → 入库的 `events.app` 仍是 apps 表里的 name
   - `curl -H 'accept: text/html' http://localhost:8282/` 未登录 → 302 `Location: /login?next=%2F`
   - `curl -H 'accept: text/html' http://localhost:8282/login` 未登录 → 200（不回环）
   - 用白名单外的 Google 邮箱登录 → 回调阶段 302 回 `/login?error=email_not_allowed&email=<email>`
8. **远程部署**：
   - GCP 控制台 Authorized redirect URI 增加线上 `https://<worker-domain>/auth/callback`
   - `wrangler secret put GOOGLE_CLIENT_SECRET` / `SESSION_SECRET`
   - `pnpm deploy`
   - 重复步骤 6、7 在线上验证一遍

---

## 6.5 引入 app_id + 删除功能（本次新增）

**两个相关问题一起解决**：
1. **rename 割裂历史**：`events.app` 存的是字符串 name，改名后老数据被孤立。引入稳定的 `app_id` 作为引用键。
2. **revoked 应用堆积**：之前只能 revoke，长期累积。提供 hard delete，但要求先 revoke。

**Schema 改动** ——`migrations/0002_introduce_app_id.sql`：
```sql
-- 1. apps 加 app_id（先允许 NULL）
ALTER TABLE apps ADD COLUMN app_id TEXT;
-- 2. 给老行生成 app_id（每行 random hex）
UPDATE apps SET app_id = printf('app_%016x', abs(random())) WHERE app_id IS NULL;
-- 3. 给 events 加 app_id，从 apps.name 反查回填
ALTER TABLE events ADD COLUMN app_id TEXT;
UPDATE events SET app_id = (SELECT app_id FROM apps WHERE apps.name = events.app);
-- 4. 把没匹配上的（apps 表里已 rename 或已删的）打成 "app_orphan"
UPDATE events SET app_id = 'app_orphan' WHERE app_id IS NULL;
-- 5. 索引 + 加约束（SQLite 不支持直接改 NOT NULL，新建索引足够；约束在应用层保证）
CREATE UNIQUE INDEX idx_apps_app_id ON apps(app_id);
CREATE INDEX idx_events_appid_server_ts ON events(app_id, server_ts);
-- 6. 旧 events.app 列保留以防回滚；新 ingest 不再写它
```

> 之前 0001 migration 还没在远程跑过，且本地数据是测试用，**实际操作就直接重写 0001_init.sql 为新 schema 并 `wrangler d1 execute DB --local --command "DROP TABLE events; DROP TABLE apps;" && pnpm seedLocalD1`**，不走 0002。线上首次部署也用 0001 新版。

**Worker 改动**：
- [src/apps.ts](src/apps.ts) `generateKey` 之外加 `generateAppId()` → `app_<16位hex>`；`AppRecord` 加 `app_id`
- [src/routes/collect.ts](src/routes/collect.ts) 写入改为 `events.app_id = app.app_id`
- [src/routes/eventsApi.ts](src/routes/eventsApi.ts) `metricsApi.ts` 过滤参数从 `app` 改为 `app_id`；查询结果用一个新工具函数 `attachAppName(rows, env)` 注入 `app_name`（内部用 30s 缓存的 `Map<app_id, name>`）。删除是级联的所以 `app_name` 一定能解析到，无需处理 null 情况。
- [src/routes/appsApi.ts](src/routes/appsApi.ts):
  - 创建时生成 `app_id`，响应 body 多返回 `app_id`
  - `PATCH /api/apps/:key` 只允许改 `name` 和 `status`（不允许改 `app_id`）
  - 新增 `GET /api/apps/:key` 单查（含 `event_count`，便于删除确认弹窗展示「这会删除 N 条历史事件」）
  - 新增 `DELETE /api/apps/:key`：**级联删除事件**
    - 读行 → 不存在 404 → `status !== 'revoked'` 返回 400 `{error: "must revoke first"}`
    - 用 `env.DB.batch([...])` 原子执行两条：`DELETE FROM events WHERE app_id = ?` 与 `DELETE FROM apps WHERE app_key = ?`
    - `invalidateApp(appKey)` 清缓存；返回 `204`
- 路由 key 维度仍用 `app_key`（地址友好且就是当前 PK）；不需要专门按 `app_id` 路由

**前端改动**：
- [web/src/tabs/Apps.tsx](web/src/tabs/Apps.tsx):
  - 表头插一列「app_id」放在最左侧（mono 字体 + 复制按钮）
  - revoked 行加红字「删除」按钮 → 点击后先 `GET /api/apps/:key` 拿 `event_count` → 弹窗：「此操作**会同时删除该应用所有 N 条历史事件**，不可撤销。输入应用名 `<name>` 以确认」，输入框，「确认删除」按钮在文本完全匹配前 disabled
- [web/src/App.tsx](web/src/App.tsx) 顶栏过滤：`<option value={app.app_id}>{app.name}</option>`，state `appFilter` 改名为 `appIdFilter`，所有 tab props 改成 `appId`
- 所有 tab 里的 `app=` query 参数改成 `app_id=`
- 事件表格的「app」列展示 `app_name`（API 返回的解析结果），鼠标悬停 tooltip 显示 `app_id`

**冒烟测试**：
```bash
TOKEN=...
# 创建 app 返回三件套
curl -s -b "session=$TOKEN" -X POST -H 'content-type: application/json' \
  -d '{"name":"main-site"}' http://localhost:8282/api/apps | jq
# 期望返回 {app_id: "app_xxxx", app_key: "ak_xxx", app_secret: "sk_xxx", ...}

# 上报后 events.app_id = 那个 app_id
curl -X POST http://localhost:8282/collect -H 'x-app-key: ak_xxx' -H 'x-app-secret: sk_xxx' \
  -d '{"event_name":"page_view","distinct_id":"d1"}'
npx wrangler d1 execute DB --local --command "SELECT app_id, event_name FROM events"

# 改名后旧事件还能按 app_id 查到（rename 不割裂历史）
curl -s -b "session=$TOKEN" -X PATCH -H 'content-type: application/json' \
  -d '{"name":"main-site-v2"}' http://localhost:8282/api/apps/ak_xxx
curl -s -b "session=$TOKEN" "http://localhost:8282/api/events?app_id=app_xxxx&limit=5"
# 响应里 app_name 应是新名 "main-site-v2"

# 删除要求先 revoke
curl -s -b "session=$TOKEN" -X DELETE -w "%{http_code}\n" http://localhost:8282/api/apps/ak_xxx
# 400 must revoke first
curl -s -b "session=$TOKEN" -X PATCH -d '{"status":"revoked"}' -H 'content-type: application/json' http://localhost:8282/api/apps/ak_xxx
curl -s -b "session=$TOKEN" -X DELETE -w "%{http_code}\n" http://localhost:8282/api/apps/ak_xxx
# 204

# 用被删 app 的 ak/sk 上报 → 403（缓存已清）
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8282/collect \
  -H 'x-app-key: ak_xxx' -H 'x-app-secret: sk_xxx' -d '{"event_name":"x"}'

# 历史事件也被级联清空
curl -s -b "session=$TOKEN" "http://localhost:8282/api/events?app_id=app_xxxx&limit=5" | jq .items
# []
npx wrangler d1 execute DB --local --command "SELECT COUNT(*) FROM events WHERE app_id = 'app_xxxx'"
# 0
```

---

## 7. 后续可扩展（不在本次范围）

- 漏斗 / 留存：在 D1 之上跑分析查询，或导出到 R2 + DuckDB
- 报警：定时 Worker 跑阈值检查，Webhook 推到企微/Slack
- 数据归档：cron 把 > 90 天数据导出到 R2 parquet，D1 里清理
- 多项目隔离已通过 `apps` 表实现

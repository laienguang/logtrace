# logtrace

`logtrace` 是一个基于 Cloudflare Workers + D1 的轻量埋点数据看板，提供：

- `POST /collect` 公开事件上报接口
- Google OAuth 登录和 session cookie 鉴权
- 趋势图、实时流、明细查询、应用管理
- React + Vite 前端，通过 Workers Assets 托管

## 技术栈

- Worker 路由与 API：`src/`
- D1 schema 与 migration：`migrations/`
- 前端看板：`web/`
- 配置入口：`wrangler.json`

## 环境变量

`wrangler.json` 里的 `vars` 放非敏感配置：

```json
{
  "GOOGLE_CLIENT_ID": "xxx.apps.googleusercontent.com",
  "ALLOWED_EMAILS": "",
  "ALLOWED_EMAIL_DOMAIN": ""
}
```

说明：

- 当前默认允许所有完成 Google OAuth 的账号登录
- 只有当你显式配置 `ALLOWED_EMAILS` 或 `ALLOWED_EMAIL_DOMAIN` 时，才会启用邮箱限制

敏感值放 secret 或本地 `.dev.vars`：

```bash
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put SESSION_SECRET
```

本地开发时可在 `.dev.vars` 中配置：

```env
GOOGLE_CLIENT_SECRET=...
SESSION_SECRET=...
```

## 本地开发

1. 安装依赖

```bash
npm install
npm --prefix web install
```

2. 初始化本地 D1

```bash
npm run seedLocalD1
```

如果你刚改了 migration 或重构了表结构，可以先重置本地库再重新应用 migration：

```bash
wrangler d1 execute DB --local --command "DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS apps; DROP TABLE IF EXISTS users;"
npm run seedLocalD1
```

3. 启动开发环境

```bash
npm run dev
```

默认端口为 [http://localhost:8282](http://localhost:8282)。

## Google OAuth 配置

在 Google Cloud Console 中创建 Web Application 类型的 OAuth Client，并配置回调地址：

- 开发环境：`http://localhost:8282/auth/callback`
- 线上环境：`https://<your-worker-domain>/auth/callback`

Scope 需要包含：

- `openid`
- `email`
- `profile`

当前默认登录策略：

- 所有 Google 账号都可登录
- 如需限制范围，可配置：
  - `ALLOWED_EMAILS`
  - `ALLOWED_EMAIL_DOMAIN`

## 常用脚本

- `npm run dev`：本地初始化 D1、构建前端并启动 Worker
- `npm run build:web`：构建前端
- `npm run check`：TypeScript + Worker dry run 检查
- `npm run deploy`：部署到 Cloudflare

## 快速验证

1. 登录后在“应用管理”里创建一个 app，拿到 `app_key` 和 `app_secret`
2. 用下面的命令上报测试事件：

```bash
curl -X POST http://localhost:8282/collect \
  -H 'content-type: application/json' \
  -H 'x-app-key: ak_xxx' \
  -H 'x-app-secret: sk_xxx' \
  -d '{"event_name":"page_view","distinct_id":"anon-1","user_id":"google-user-1","url":"/home"}'
```

3. 打开 [http://localhost:8282/](http://localhost:8282/) 检查概览、实时、明细和应用管理页面

## 部署

首次部署前请确认：

- `wrangler.json` 中的 `database_id` 已更新
- 已执行 `wrangler secret put GOOGLE_CLIENT_SECRET`
- 已执行 `wrangler secret put SESSION_SECRET`
- Google OAuth 回调地址已加入线上域名

然后运行：

```bash
npm run deploy
```

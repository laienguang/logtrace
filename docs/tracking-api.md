# 埋点 API 文档

本文档面向接入方，说明如何向 `logtrace` 上报事件数据。

## 概览

- 上报地址：`POST /collect`
- 鉴权方式：请求头 `X-App-Key` + `X-App-Secret`
- 数据格式：`application/json`
- 支持模式：单条事件、批量事件
- CORS：已开启，浏览器可直接跨域上报

示例线上地址：

```text
https://<your-worker-domain>/collect
```

示例本地地址：

```text
http://localhost:8282/collect
```

## 1. 获取上报凭证

上报前需要先在看板的“应用管理”中创建一个应用，会得到：

- `app_id`：稳定应用标识，事件最终归属到这个字段
- `app_key`：上报请求头 `X-App-Key`
- `app_secret`：上报请求头 `X-App-Secret`

说明：

- 接入方不用自己传 `app_id`
- 即使请求体里传了 `app` 或 `app_id`，服务端也不会采用
- 服务端会根据 `app_key` / `app_secret` 鉴权结果，把事件写入对应的 `app_id`

## 2. 请求头

所有埋点请求都需要带：

```http
Content-Type: application/json
X-App-Key: ak_xxx
X-App-Secret: sk_xxx
```

## 3. 单条事件上报

### 请求

```http
POST /collect
Content-Type: application/json
X-App-Key: ak_xxx
X-App-Secret: sk_xxx
```

```json
{
  "event_name": "page_view",
  "distinct_id": "anon_001",
  "session_id": "sess_abc",
  "client_ts": 1760000000000,
  "url": "/home",
  "referrer": "https://google.com",
  "props": {
    "title": "首页",
    "utm_source": "google"
  }
}
```

### 返回

成功时返回：

```http
204 No Content
```

## 4. 批量事件上报

### 请求

```json
{
  "events": [
    {
      "event_name": "page_view",
      "distinct_id": "anon_001",
      "url": "/home"
    },
    {
      "event_name": "click",
      "distinct_id": "anon_001",
      "props": {
        "target": "buy-button"
      }
    }
  ]
}
```

### 说明

- 单批最多 `50` 条事件
- 批量中只要有一条不合法，整批会返回错误
- 成功时同样返回 `204 No Content`

## 5. 字段说明

### 顶层字段

单条模式直接传事件对象；批量模式传：

```json
{
  "events": []
}
```

### 事件字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `event_name` | `string` | 是 | 事件名，最大 64 字符 |
| `distinct_id` | `string` | 否 | 匿名设备或浏览器标识，建议始终传 |
| `session_id` | `string` | 否 | 一次访问会话 ID |
| `client_ts` | `number` | 否 | 客户端事件时间，单位毫秒 |
| `url` | `string` | 否 | 当前页面 URL，最大 2048 字符 |
| `referrer` | `string` | 否 | 来源页面 URL，最大 2048 字符 |
| `props` | `object` / `array` / JSON 值 | 否 | 自定义属性，序列化后最大 4KB |

### 字段处理规则

- `distinct_id`、`session_id` 仅接受字符串
- 这两个字符串会先做 `trim()`，空字符串会按 `null` 入库
- 这两个字段最大保留 256 字符，超出会被截断
- `client_ts` 只有在类型为数字时才会入库，否则记为 `null`
- `props` 会被服务端 `JSON.stringify()` 后存储

## 6. 服务端自动补充字段

以下字段不需要接入方传，服务端会自动写入：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `server_ts` | 服务端时间 | 事件实际入库时间，毫秒 |
| `ua` | `User-Agent` 请求头 | 终端 UA |
| `ip_country` | `request.cf.country` | Cloudflare 识别出的国家/地区 |
| `app_id` | 应用凭证鉴权结果 | 由 `X-App-Key` / `X-App-Secret` 决定 |
| `user_id` | 应用凭证鉴权结果 | 根据 `X-App-Key` / `X-App-Secret` 从 `apps.user_id` 自动解析，客户端不可伪造 |

## 7. 用户标识说明

埋点接入方需要关心的标识只有两个：

- `distinct_id`：匿名设备/浏览器标识，建议客户端首次访问时生成并长期复用
- `session_id`：单次访问会话标识

`app_id` 由服务端根据 `X-App-Key` / `X-App-Secret` 鉴权结果自动判定，请求体里传也会被忽略。

## 8. 返回码

| 状态码 | 含义 | 说明 |
| --- | --- | --- |
| `204` | 成功 | 已成功入库 |
| `400` | 请求错误 | JSON 非法、缺字段、字段超限等 |
| `403` | 鉴权失败 | 缺少凭证、凭证错误、应用已被吊销 |
| `405` | 方法错误 | `/collect` 只支持 `POST` 和 `OPTIONS` |

## 9. 错误响应示例

### 缺少凭证

```json
{
  "error": "missing credentials"
}
```

### 凭证错误或应用已禁用

```json
{
  "error": "invalid credentials"
}
```

### 请求体不是合法 JSON

```json
{
  "error": "invalid json"
}
```

### 未传任何事件

```json
{
  "error": "no events"
}
```

### 批量过大

```json
{
  "error": "batch too large"
}
```

### 缺少事件名

```json
{
  "error": "event_name required"
}
```

### 事件名过长

```json
{
  "error": "event_name too long"
}
```

### 属性无法序列化

```json
{
  "error": "invalid props"
}
```

### 属性过大

```json
{
  "error": "props too large"
}
```

## 10. cURL 示例

### 单条上报

```bash
curl -X POST http://localhost:8282/collect \
  -H 'content-type: application/json' \
  -H 'x-app-key: ak_xxx' \
  -H 'x-app-secret: sk_xxx' \
  -d '{
    "event_name":"page_view",
    "distinct_id":"anon-1",
    "session_id":"s-1",
    "url":"/home",
    "props":{"title":"Home"}
  }'
```

### 批量上报

```bash
curl -X POST http://localhost:8282/collect \
  -H 'content-type: application/json' \
  -H 'x-app-key: ak_xxx' \
  -H 'x-app-secret: sk_xxx' \
  -d '{
    "events":[
      {"event_name":"page_view","distinct_id":"anon-1","url":"/home"},
      {"event_name":"click","distinct_id":"anon-1","props":{"target":"buy"}}
    ]
  }'
```

## 11. JavaScript 示例

### 浏览器

```js
await fetch("https://<your-worker-domain>/collect", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-app-key": "ak_xxx",
    "x-app-secret": "sk_xxx"
  },
  body: JSON.stringify({
    event_name: "page_view",
    distinct_id: "anon_001",
    session_id: "sess_abc",
    client_ts: Date.now(),
    url: window.location.pathname,
    referrer: document.referrer,
    props: {
      title: document.title
    }
  })
});
```

### Node.js

```js
await fetch("https://<your-worker-domain>/collect", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-app-key": process.env.APP_KEY,
    "x-app-secret": process.env.APP_SECRET
  },
  body: JSON.stringify({
    event_name: "job_finished",
    distinct_id: "server-worker-1",
    props: {
      job_id: "job_001",
      duration_ms: 420
    }
  })
});
```

## 12. 接入建议

- `distinct_id` 建议在客户端首次访问时生成，并长期复用
- `session_id` 建议按单次访问或单次打开 App 维度生成
- 查询与统计以服务端时间 `server_ts` 为准，不建议依赖客户端时间做最终分析
- 浏览器场景中 `app_secret` 无法完全保密，如发现被滥用，请在看板中吊销并重新生成应用凭证

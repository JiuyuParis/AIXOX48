# pocket48-scraper

**口袋48（SNH48 GROUP）成员房间消息数据捞取微服务。**

从官方 APP 私有接口捞取成员的历史消息（文本 / 图片 / 语音 / 礼物回复 / 回复粉丝等全部类型），支持**全量回溯**与**增量更新**，通过语言无关的 RESTful API 供其他服务（虚拟偶像网页、数据分析、导出）消费。

> **纯 Node.js 内置能力实现**（node:sqlite + node:http + WebAssembly），**零 npm 依赖**，无需 `npm install`，拿到即跑。
> 技术栈：Node.js ≥ 20（推荐 22，内置 SQLite）。

---

## 目录

- [一、功能特性](#一功能特性)
- [二、快速开始](#二快速开始)
- [三、架构设计](#三架构设计)
- [四、核心概念](#四核心概念)
- [五、API 参考](#五api-参考)
- [六、消息类型详解](#六消息类型详解)
- [七、数据库 Schema](#七数据库-schema)
- [八、配置参考](#八配置参考)
- [九、全量回溯任务详解](#九全量回溯任务详解)
- [十、登录与 Token 生命周期](#十登录与-token-生命周期)
- [十一、故障排查（FAQ）](#十一故障排查faq)
- [十二、扩展指南](#十二扩展指南)
- [十三、真实运行参考](#十三真实运行参考)
- [十四、合规声明](#十四合规声明)

---

## 一、功能特性

| 能力 | 说明 |
|---|---|
| 历史消息捞取 | 全量回溯：从最新一路翻页到官方保留的最早数据（实测约 1 年） |
| 增量更新 | 定时轮询（默认 5 分钟），只拉新消息，遇到已入库水位自动停止 |
| 全量入库 | 所有消息类型完整存储（含原始 JSON），类型注册表 + 泛型兜底，新类型零改动入库 |
| 消息结构化 | 每种类型解析为 AI 友好的统一结构（text / content / mediaUrls / replyTo / sender） |
| 成员管理 | 搜索 → 关注 → 登记；随时添加 / 移除，只对已登记成员同步 |
| 异步任务 | 全量回溯为后台任务，幂等、可续跑、实时进度可查 |
| 数据导出 | JSONL / CSV 导出，数据不锁死在 SQLite |
| 风控友好 | 固定翻页间隔（1.2s）、单飞锁防并发、token 每日刷新 |

---

## 二、快速开始

### 环境要求

- Node.js ≥ 20（Node 22 内置 `node:sqlite`，无需任何第三方包）
- 一个口袋48注册手机号（用于短信验证码登录）

### 启动

```bash
cd pocket48-scraper
node src/index.js
```

启动日志应显示：数据库就绪 → 登录态已加载（或提示未登录）→ HTTP 服务启动 → 调度器启动。

### 第一步：健康检查

```bash
curl http://127.0.0.1:4100/health
```

### 第二步：登录（token 已存在则跳过）

```bash
# 1) 发送验证码
curl -X POST http://127.0.0.1:4100/api/v1/auth/sms \
  -H "Content-Type: application/json" \
  -d '{"mobile":"你的手机号"}'

# 2) 用收到的验证码登录（成功后 token 持久化到 data/token.json）
curl -X POST http://127.0.0.1:4100/api/v1/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"mobile":"你的手机号","code":"验证码"}'
```

### 第三步：添加成员

```bash
curl -X POST http://127.0.0.1:4100/api/v1/members \
  -H "Content-Type: application/json" \
  -d '{"keyword":"李婷"}'
```

服务会：搜索成员 → 获取频道 ID → 关注 → 登记入库。响应返回成员记录（`server_id` / `channel_id`）。

### 第四步：全量回溯（拉历史）

```bash
# 异步后台任务：自动翻页直到拉到官方最早数据
curl -X POST http://127.0.0.1:4100/api/v1/members/29266435/backfill

# 查询进度
curl http://127.0.0.1:4100/api/v1/members/29266435/backfill
```

### 第五步：查询消息

```bash
# 结构化消息（AI 友好），按类型过滤、时间范围、分页
curl "http://127.0.0.1:4100/api/v1/members/29266435/messages?limit=10&type=TEXT"
```

---

## 三、架构设计

```
口袋48官方接口 (https://pocketapi.48.cn)
    │  POST + JSON 请求头（appInfo + User-Agent + pa 签名 + token）
    ▼
┌──────────────────────────────────────────────────┐
│              pocket48-scraper (Node.js 22)      │
│                                                  │
│  HTTP 层    api/routes.js        路由/参数/错误码   │
│  ──────────────────────────────────────────────   │
│  核心逻辑   core/message-crawler.js  拉取引擎      │
│            core/sync-scheduler.js   增量调度器     │
│            core/parser.js           消息解析器     │
│  ──────────────────────────────────────────────   │
│  接入层     core/client.js  签名/登录/接口封装      │
│            sdk/rust-wasm.js + 2.wasm  pa 签名     │
│  ──────────────────────────────────────────────   │
│  存储层     db/database.js    SQLite DAO (WAL)    │
│            data/pocket48.db                     │
└──────────────────────────────────────────────────┘
    │  RESTful API (JSON)
    ▼
   其他服务（虚拟偶像网页 / 数据分析 / 导出）
```

**分层原则**：接入层隔离官方接口细节，核心层实现业务逻辑，存储层隔离数据库实现，HTTP 层提供语言无关契约。任何一层替换不影响其他层。

**数据流（增量同步一轮）**：

```
调度器触发 → 读成员水位(last_msg_time) → 调消息接口 nextTime=0 拉最新页
  → 过滤出比水位新的消息 → 批量入库（主键去重）
  → 本页最旧时间 ≤ 水位？→ 是：停止本轮
  → 否：用返回的 nextTime 继续往前翻（最多 maxIncrementalPages 页）
  → 更新成员水位与 last_sync_at
```

---

## 四、核心概念

### 1. nextTime 游标（翻页机制）

官方消息接口 `POST /im/api/v1/team/message/list/homeowner` 接受 `{ channelId, serverId, nextTime, limit }`：

- `nextTime = 0`：从**最新**消息开始返回一页（单页最多 50 条，新到旧排列）
- 响应中的 `nextTime`：**下一页游标**（= 本页最旧消息的时间戳），用它请求即返回**更早**的一页
- 不断用返回的 `nextTime` 请求，即可一路回溯到官方最早数据

### 2. 水位（watermark）

`members.last_msg_time` = 该成员**已入库消息的最大 msgTime**。增量同步时以此作为过滤边界，只入库 `msgTime > 水位` 的消息，遇到"本页最旧时间 ≤ 水位"即停止——保证不重复、不漏拉。

### 3. 增量 vs 全量回溯

| 模式 | 起始游标 | 入库过滤 | 停止条件 |
|---|---|---|---|
| 增量（incremental） | 最新 | `msgTime > last_msg_time` | 遇到水位 / 页数上限 |
| 全量回溯（backfill） | 最新 | 全部（`msgTime > 0`） | 官方无更早数据（no_more_data / cursor_stopped）/ 页数上限 |

### 4. 单飞去重

同一成员同一时刻只有一个同步任务在跑（内存锁）。调度器与手动触发并发时会跳过重复触发，不会打重复请求。

### 5. 去重

消息以 `msg_id_server`（服务端全局唯一 ID）为主键，`INSERT OR IGNORE` 批量写入，天然幂等。重复回溯 / 重复增量不会产生重复数据。

---

## 五、API 参考

> 所有接口返回 JSON。成功：`{ "success": true, ... }`；失败：`{ "success": false, "code": "...", "message": "..." }`。
> 统一 CORS 头已开启（`Access-Control-Allow-Origin: *`），浏览器前端可直接调用。

### 通用错误码

| code | HTTP | 含义 | 处理 |
|---|---|---|---|
| `BAD_MOBILE` / `BAD_CODE` / `BAD_KEYWORD` | 400 | 参数格式错误 | 检查入参 |
| `NO_TOKEN` | 401 | 未登录 | 走 `/api/v1/auth/sms` + `/api/v1/auth/verify` |
| `TOKEN_EXPIRED` | 401 | token 已失效 | 重新验证码登录 |
| `MEMBER_NOT_FOUND` | 404/500 | 成员未登记 / 搜索无结果 | 先搜索并添加成员 |
| `NOT_FOUND` | 404 | 路径或资源不存在 | 检查 URL / serverId |
| `NO_TASK` | 404 | 该成员无回溯任务 | 先 POST 启动 |
| `P48_xxx` | 500 | 口袋48官方接口错误 | 查看 message（如"频道不存在"=成员已退团/暂休） |
| `INTERNAL` | 500 | 服务内部错误 | 查看服务日志 |

### 5.1 系统

#### GET /health

服务健康检查 + 全局统计 + 调度状态 + 登录状态。

```bash
curl http://127.0.0.1:4100/health
```

```json
{
  "success": true,
  "status": "ok",
  "uptime": 3600,
  "now": 1789400000000,
  "totalMessages": 39923,
  "totalMembers": 1,
  "scheduler": {
    "enabled": true,
    "running": false,
    "runs": 12,
    "lastRunAt": 1789400000000,
    "lastRunSummary": [],
    "intervalMs": 300000
  },
  "auth": { "loggedIn": true }
}
```

### 5.2 登录认证

#### POST /api/v1/auth/sms — 发送登录验证码

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `mobile` | string | 是 | 口袋48注册手机号（11 位） |

```bash
curl -X POST http://127.0.0.1:4100/api/v1/auth/sms \
  -H "Content-Type: application/json" -d '{"mobile":"你的手机号"}'
```

```json
{ "success": true, "message": "验证码已发送到 130****2335" }
```

#### POST /api/v1/auth/verify — 验证码登录

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `mobile` | string | 是 | 手机号 |
| `code` | string | 是 | 短信验证码（4-6 位） |

成功后 token 持久化到 `data/token.json`。

```json
{ "success": true, "userId": 184352981, "nickname": "xxx" }
```

#### GET /api/v1/auth/status — 登录状态

```json
{ "success": true, "loggedIn": true, "mobile": "130****2335", "loginTime": 1789397829780 }
```

### 5.3 成员管理

#### POST /api/v1/members/search — 搜索成员（不关注）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `keyword` | string | 是 | 成员姓名 / 昵称关键词 |

返回候选列表（一个名字可能对应多个房间，取第一个添加）：

```json
{
  "success": true,
  "keyword": "李婷",
  "results": [
    {
      "serverId": 29266435,
      "serverOwner": 161808465,
      "name": "李婷",
      "roomName": "🤓",
      "avatar": "https://source.48.cn/...",
      "teamId": 1001,
      "serverType": 1
    }
  ]
}
```

#### POST /api/v1/members — 添加成员

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `keyword` | string | 是 | 成员关键词（取搜索结果第一个） |

内部流程：搜索 → jump 获取 channelId → 关注成员 → 登记入库。幂等（重复添加同一成员会更新而非报错）。

```json
{
  "success": true,
  "member": {
    "server_id": 29266435,
    "server_owner": 161808465,
    "channel_id": 36393209,
    "name": "🤓",
    "default_name": "李婷",
    "followed": 1,
    "last_msg_time": 0,
    "last_sync_at": 0
  }
}
```

#### GET /api/v1/members — 成员列表（含统计）

```json
{
  "success": true,
  "count": 1,
  "members": [
    {
      "server_id": 29266435,
      "name": "🤓",
      "default_name": "李婷",
      "last_msg_time": 1789401106440,
      "stats": {
        "total": 39923,
        "byType": [{ "msg_type": "TEXT", "count": 20818 }, { "msg_type": "GIFTREPLY", "count": 8524 }],
        "minTime": 1786400000000,
        "maxTime": 1789400000000
      }
    }
  ]
}
```

#### DELETE /api/v1/members/:serverId — 移除成员

停止对该成员的同步与任务，**历史数据保留**（不删除 messages）。

```json
{ "success": true, "removed": "🤓" }
```

### 5.4 同步

#### POST /api/v1/members/:serverId/sync — 手动同步（同步阻塞）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `mode` | string | 否 | `incremental`（默认，增量）/ `backfill`（全量，受 maxPages 限制） |
| `pages` | number | 否 | 本次最多翻页数（backfill 模式下默认 500） |

> 注意：这是**同步接口**，长时间全量会阻塞请求。**推荐使用下面的异步 backfill 任务接口**。

```json
{
  "success": true,
  "mode": "incremental",
  "serverId": 29266435,
  "memberName": "🤓",
  "added": 0,
  "pages": 1,
  "stopReason": "reached_watermark",
  "newLastMsgTime": 1789401106440
}
```

#### POST /api/v1/members/:serverId/backfill — 启动全量回溯后台任务（推荐）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `maxPages` | number | 否 | 总页数上限（默认 1000000；通常无需设置，自动拉到底） |

- **异步**：立即返回任务状态，后台自动分轮翻页
- **幂等**：任务运行中重复 POST 返回同一任务，不重复启动
- **可续跑**：任务因页数上限结束后再次 POST，从上次位置继续累计
- **拉到底判定**：官方无更早数据时任务自动完成（stopReason = `no_more_data` / `cursor_stopped`）

```json
{
  "success": true,
  "taskId": 29266435,
  "task": {
    "serverId": 29266435,
    "memberName": "🤓",
    "status": "running",
    "pagesDone": 60,
    "added": 0,
    "maxTotalPages": 1000000,
    "startTime": 1789400000000,
    "endTime": 0,
    "stopReason": "running",
    "error": null,
    "lastPageAt": 1789400000000
  }
}
```

#### GET /api/v1/members/:serverId/backfill — 查询任务进度

返回同上的 task 对象。任务字段含义见[第九章](#九全量回溯任务详解)。

#### GET /api/v1/backfill/tasks — 全部任务列表

```json
{ "success": true, "tasks": [ { "serverId": 29266435, "status": "done", "pagesDone": 800, "added": 34923 } ] }
```

### 5.5 消息查询与统计

#### GET /api/v1/members/:serverId/messages — 查询结构化消息

| Query 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `after` | number | 0 | 只返回 msgTime > after（毫秒时间戳） |
| `before` | number | 0 | 只返回 msgTime < before |
| `type` | string | 无 | 按消息类型过滤（TEXT / IMAGE / REPLY / ...） |
| `limit` | number | 50 | 返回条数（最大 200） |
| `offset` | number | 0 | 分页偏移 |

返回按 msgTime **倒序**（新到旧）。每条为解析后的结构化消息（见[第六章](#六消息类型详解)）：

```json
{
  "success": true,
  "serverId": 29266435,
  "total": 39923,
  "returned": 1,
  "messages": [
    {
      "msgIdServer": 7394119727,
      "msgIdClient": "b1ff5bdd-...",
      "msgTime": 1789397485943,
      "msgType": "TEXT",
      "contentType": "text",
      "text": "顺便看看有什么可以生公跳",
      "content": { "text": "顺便看看有什么可以生公跳" },
      "mediaUrls": [],
      "replyTo": null,
      "sender": { "userId": 161808465, "nickName": "听这个听听呀", "roleId": 3 }
    }
  ]
}
```

#### GET /api/v1/members/:serverId/stats — 消息统计

```json
{
  "success": true,
  "serverId": 29266435,
  "memberName": "🤓",
  "stats": {
    "total": 39923,
    "byType": [{ "msg_type": "TEXT", "count": 20818 }],
    "minTime": 1786400000000,
    "maxTime": 1789400000000
  }
}
```

#### GET /api/v1/members/:serverId/export — 导出

| Query 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `format` | string | jsonl | `jsonl`（原始行）或 `csv`（msg_id_server,msg_time,msg_type,bodys） |
| `type` | string | 无 | 按类型过滤导出 |

```bash
curl "http://127.0.0.1:4100/api/v1/members/29266435/export?format=jsonl" -o liting.jsonl
```

---

## 六、消息类型详解

所有类型**全量入库**（原始 JSON 保留在 `raw_json`），以下为解析后的 `content` / `mediaUrls` / `replyTo` 结构。

| msgType | 含义 | contentType | 关键字段 |
|---|---|---|---|
| `TEXT` | 文本消息 | text | `content.text` |
| `IMAGE` | 图片 | image | `content.url`（NOS 图片地址）+ `w/h/size/ext` |
| `REPLY` | 回复粉丝消息 | reply | `content.text`（回复内容）+ `replyTo.text/name/messageId`（被回复的原文与作者） |
| `GIFTREPLY` | 礼物感谢回复 | gift | `content.text/replyText` + `replyTo.*` |
| `AUDIO_GIFT_REPLY` | 语音礼物回复 | voice | `content.voiceUrl`（aac 音频地址）+ `replyTo.*` |
| `AUDIO` | 语音（含翻牌语音） | voice | `content.url` |
| `VIDEO` | 视频 | video | `content.url` + `cover` |
| `LIVEPUSH` | 直播推送 | live | `content.liveId/title/cover` |
| `FLIPCARD` | 翻牌（文字） | flipcard | `content.content` 等 |
| `DELETE` | 消息删除通知 | delete | 原始内容 |
| `RED_PACKET_2026` 等新类型 | 未知 | other | 泛型兜底，`content` 为原始 JSON |

**发送者信息**（统一在 `sender` 字段）：

```json
"sender": {
  "userId": 161808465,
  "nickName": "听这个听听呀",
  "avatar": "/avatar/...",
  "roleId": 3,
  "vip": false,
  "teamLogo": "/mediasource/..."
}
```

- `roleId: 3` = **成员本人**（偶像），其他 = 粉丝 / 管理员 / 系统
- 做"虚拟偶像"时，用 `sender.roleId === 3` 过滤出偶像本人的发言作为人格语料

**新增消息类型**：编辑 `src/core/parser.js` 的 `parsers` 注册表，加一个解析函数即可，无需改表结构、无需改主流程。未注册类型自动走泛型兜底。

---

## 七、数据库 Schema

文件：`data/pocket48.db`（SQLite，WAL 模式，读写不互锁）。

### members（成员管理）

| 字段 | 类型 | 说明 |
|---|---|---|
| `server_id` | INTEGER PK | 成员房间服务 ID |
| `server_owner` | INTEGER | 成员用户 ID（关注/跳转用） |
| `channel_id` | INTEGER | IM 频道 ID（拉消息用） |
| `name` | TEXT | 房间显示名 |
| `default_name` | TEXT | 成员本名 |
| `avatar` | TEXT | 头像 URL |
| `team_id` / `team_name` / `group_name` | INTEGER/TEXT | 队伍与分团信息 |
| `followed` | INTEGER | 是否已关注（0/1） |
| `last_msg_time` | INTEGER | **增量水位**：已同步最大消息时间 |
| `last_sync_at` | INTEGER | 最近一次同步完成时间 |
| `created_at` / `updated_at` | INTEGER | 创建 / 更新时间 |

### messages（消息）

| 字段 | 类型 | 说明 |
|---|---|---|
| `msg_id_server` | INTEGER PK | 服务端全局唯一消息 ID（去重键） |
| `server_id` | INTEGER | 所属成员房间（外键逻辑关联） |
| `channel_id` | INTEGER | 频道 ID |
| `msg_type` | TEXT | 消息类型 |
| `bodys` | TEXT | 消息内容（原始 JSON / 文本） |
| `ext_info` | TEXT | 扩展信息（用户信息等，原始 JSON） |
| `msg_time` | INTEGER | 消息时间（毫秒） |
| `raw_json` | TEXT | 原始消息完整 JSON（无损重建） |
| `created_at` | INTEGER | 入库时间 |

**索引**：`(server_id, msg_time)` 复合索引（按成员+时间查询）、`msg_time` 单索引、`msg_type` 单索引。

**迁移**：所有 SQL 集中在 `src/db/database.js`（DAO 层）。更换 PostgreSQL / MySQL 只改这一个文件，上层无感知。

---

## 八、配置参考

文件：`src/config.js`（可用环境变量 `PORT` / `DB_FILE` / `TOKEN_FILE` 覆盖）。

| 配置项 | 默认 | 说明 | 建议 |
|---|---|---|---|
| `server.port` | 4100 | HTTP 端口 | 按需 |
| `crawler.pageSize` | 50 | 官方单页上限（实测 50，勿改大） | 保持 50 |
| `crawler.requestIntervalMs` | 1200 | 翻页间隔（毫秒） | 风控保护，勿低于 800 |
| `crawler.maxPagesPerRun` | 500 | 同步接口单次全量上限 | 保持 |
| `crawler.maxIncrementalPages` | 20 | 增量单轮页数上限 | 活跃成员可调大 |
| `crawler.backfillDefaultMaxPages` | 1000000 | 回溯任务默认总页数上限 | 100 万页=5000 万条，绝对保护 |
| `scheduler.syncIntervalMs` | 300000 | 增量调度周期（毫秒） | 5 分钟适中 |
| `scheduler.tokenRefreshHours` | 20 | token 刷新提醒阈值 | 保持 |

---

## 九、全量回溯任务详解

### 任务生命周期

```
POST backfill → status=running → 自动分轮翻页（每轮 100 页）→ 拉到底或达上限
  → status=done（stopReason=no_more_data / cursor_stopped / max_total_pages）
  → 或 status=error（stopReason 保持，error 记录原因）
```

### 字段含义

| 字段 | 说明 |
|---|---|
| `status` | `running` / `done` / `error` |
| `pagesDone` | 已完成页数（实时更新，每页刷新） |
| `added` | 本任务累计实际新增消息条数（去重后） |
| `maxTotalPages` | 总页数上限 |
| `stopReason` | `running` / `no_more_data`（官方无更早数据）/ `cursor_stopped`（游标停走）/ `max_total_pages`（达上限）/ `error` |
| `lastPageAt` | 最近一次请求时间（判断任务是否卡死） |
| `startTime` / `endTime` | 起止时间 |

### 行为细节

- **幂等**：`running` 中重复 POST 返回同一任务，不重复启动
- **续跑**：`done`（`max_total_pages` 截断）后再 POST，从已累计进度继续（拉取仍从最新开始，主键去重兜底）
- **拉到底**：`no_more_data` / `cursor_stopped` 后再 POST 会返回原任务并提示"已拉取到官方最早数据"
- **与调度器共存**：回溯与增量共用单飞锁，冲突时回溯任务等待 3 秒重试

### 耗时估算

官方每页 50 条、间隔 1.2s → **约 24 条/秒**。

| 历史数据量 | 页数 | 耗时 |
|---|---|---|
| 1 万条（约 3 个月活跃） | 200 页 | ~4 分钟 |
| 4 万条（约 1 年，官方上限） | 800 页 | ~16 分钟 |
| 多年数据（官方已丢弃，无法补齐） | — | — |

> 官方接口只保留约 1 年历史，更早数据已从服务端删除，无法回溯（msg48 的多年数据是它自建站以来持续累积的）。

---

## 十、登录与 Token 生命周期

1. **获取**：`/api/v1/auth/sms` 发码 → `/api/v1/auth/verify` 登录，token 保存至 `data/token.json`（含手机号、token、登录时间）
2. **使用**：所有业务接口自动附带 `token` 请求头
3. **有效期**：约 24 小时（官方策略，实测）
4. **失效**：接口返回 401 / `TOKEN_EXPIRED`，服务自动清除失效 token 并提示重新登录
5. **多账号**：当前设计为单账号。如需账号池轮换，扩展 `tokenStore` 为多账号映射即可（DAO 层已隔离）

---

## 十一、故障排查（FAQ）

### 1. 消息为空 / 拉不到

- **成员已退团 / 暂休**：官方对该房间返回"频道不存在"或空数据（例：王奕进入暂休名单后房间为空）。换活跃成员测试。
- **新注册账号未关注**：消息接口只返回已关注房间的数据。`/api/v1/members` 添加成员时已自动关注；若手动测试请先调用关注接口。
- **水位问题**：增量拉不到时检查 `last_msg_time`；若需重拉历史用 `mode: backfill`。

### 2. 返回 401 / TOKEN_EXPIRED

token 过期。重新执行 `/api/v1/auth/sms` + `/api/v1/auth/verify`。

### 3. 返回"频道不存在"（P48_500）

channelId 无效或成员房间不可见。重新执行搜索 + 添加成员（会刷新 channel_id）。

### 4. 服务启动失败

- 确认 Node ≥ 20（`node -v`）
- 确认 `src/sdk/2.wasm` 与 `rust-wasm.js` 存在（签名组件）
- 端口被占用：改 `PORT` 环境变量或释放端口

### 5. Windows PowerShell 中文乱码

PowerShell 5.1 的 `Invoke-RestMethod -Body` 传中文会乱码（`keyword` 变 `??`）。解决：

```powershell
# 用 UTF-8 字节数组
$body = [System.Text.Encoding]::UTF8.GetBytes('{"keyword":"李婷"}')
Invoke-RestMethod -Uri "..." -Method Post -ContentType "application/json; charset=utf-8" -Body $body
# 或直接用 curl.exe（默认 UTF-8）
```

### 6. 任务一直 running 但进度不动

检查 `lastPageAt` 是否在更新；若超过 1 分钟未更新，可能被增量同步占用（自动等待）或网络异常，查看服务日志。

### 7. 想清空重来

删除 `data/pocket48.db`（含 `-wal` / `-shm`）后重启服务即可重建空库（members 需重新添加）。

---

## 十二、扩展指南

### 新增消息类型

```js
// src/core/parser.js 的 parsers 注册表
function parseNewType(raw) {
  const b = JSON.parse(raw.bodys);
  return {
    contentType: 'custom',
    text: b.someText || '[新类型]',
    content: b,
    mediaUrls: b.url ? [b.url] : [],
    replyTo: null
  };
}
const parsers = { ..., NEW_TYPE: parseNewType };
```

### 新增成员

```bash
curl -X POST http://127.0.0.1:4100/api/v1/members -H "Content-Type: application/json" -d '{"keyword":"成员名"}'
curl -X POST http://127.0.0.1:4100/api/v1/members/<server_id>/backfill
```

### 扩展存储（如换 PostgreSQL）

只改 `src/db/database.js`：将 `node:sqlite` 调用替换为 PG 连接池，保持 DAO 方法签名不变。

### 多账号 / 账号池

扩展 `src/core/client.js` 的 `tokenStore` 为数组，按成员或轮询分配账号。

### 前端直接调用

API 已带 CORS 头，浏览器可直接 fetch。虚拟偶像网页只需调用 `/api/v1/members/:id/messages` 取语料、`/health` 做状态探测。

---

## 十三、真实运行参考

以李婷（SNH48 Team SII）为实测样例：

| 指标 | 值 |
|---|---|
| serverId / channelId | 29266435 / 36393209 |
| 全量回溯 | 800 页，新增 34,923 条，耗时约 16 分钟 |
| 库内总量 | 39,923 条 |
| 时间覆盖 | 2025-10-05 ~ 至今（约 11.4 个月，官方保留上限） |
| 消息类型 | 13 种（TEXT 20,818 / GIFTREPLY 8,524 / REPLY 3,850 / IMAGE 3,159 / AUDIO_GIFT_REPLY 1,904 / AUDIO 831 / LIVEPUSH 226 / VIDEO 223 / FLIPCARD 184 / RED_PACKET_2026 124 / EXPRESSIMAGE 30 / SHARE_POSTS 42 / AUDIO_REPLY 8） |
| 增量运行 | 调度器每 5 分钟自动拉新，长期运行稳定 |

---

## 十四、合规声明

本服务调用的是口袋48 APP 私有接口（未经官方授权），仅供**个人学习研究**使用。

- 请控制请求频率，遵守平台规则（默认间隔 1.2s/页，勿调小）
- 数据仅用于个人学习，请勿用于商业用途或公开传播
- 官方可能随时调整接口 / 加密方式，导致服务失效；失效时按[第十一章](#十一故障排查faq)排查或重新逆向

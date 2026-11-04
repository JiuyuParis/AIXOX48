# AIXOX48 项目交接文档（Handoff）

> 用途：新会话/新 AI 快速接管本项目。**开工前先读本文件 + pocket48-scraper/README.md。**

## 一、项目目标

做一个 Web 程序：从口袋48 APP 捞取指定成员的历史消息（文本/图像/语音/回复），喂给 AI 大模型，做出"虚拟版小偶像"聊天网页（对话框式）。

**当前进度**：第一阶段（数据捞取微服务）已完成并验证；第二阶段（AI 接入 + 网页）未开始。

## 二、已完成：数据捞取微服务（pocket48-scraper）

- 位置：`E:\project\AIXOX48\pocket48-scraper`
- 启动：`node src/index.js`（端口 4100，零 npm 依赖，Node 22 内置 sqlite+http）
- 文档：`pocket48-scraper/README.md`（完整 API 一览 + 架构 + 配置）

### 关键事实（已验证，勿重复验证）

| 项 | 值 |
|---|---|
| 接口域名 | `https://pocketapi.48.cn`（POST + JSON，2021年后新网关，老域名已死） |
| 签名 | 请求头 `pa`（rust-wasm 动态生成，已提取在 `src/sdk/`，复用 48tools） |
| 请求头 | `appInfo`(随机设备) + `User-Agent: PocketFans201807/6.0.16 (iPhone; iOS 13.5.1...)` + `token` + `pa` |
| 登录 | 官方短信验证码：`POST /user/api/v1/sms/send2` + `POST /user/api/v1/login/app/mobile/code` |
| 消息接口 | `POST /im/api/v1/team/message/list/homeowner`，body `{channelId, serverId, nextTime, limit}` |
| 分页 | 单页上限 **50 条**；`nextTime=0` 从最新开始，返回的 `nextTime` 是下一页游标（往前翻） |
| 历史深度 | 官方只保留约 **1 年**（李婷拉到底 = 2025-10-05 起） |
| 增量机制 | 从最新拉，遇到已入库水位（last_msg_time）即停；调度器每 5 分钟一轮 |
| 风控规避 | 翻页间隔 1.2s、单飞锁、token 约 24h 有效（失效 API 返回 401） |
| 关注前置 | 新号需先 `friendships/friends/add` 关注成员才能拉消息（王奕空消息=暂休名单，非技术问题） |

### 账号与成员

- 口袋48账号：手机号 **13800000000**（专用测试号，验证码登录，无密码）
- token 文件：`pocket48-scraper/data/token.json`（失效需重新验证码登录）
- 已管理成员：
  - 李婷（SNH48 Team SII）：serverId=**29266435**，channelId=**36393209**，serverOwner=161808465
  - 已入库 **39,923 条**（2025-10-05 ~ 至今），13 种消息类型

### 消息类型（全量入库，原始 JSON 保留）

TEXT / GIFTREPLY / REPLY（回复粉丝）/ IMAGE / AUDIO_GIFT_REPLY（语音礼物回复）/ AUDIO / FLIPCARD / LIVEPUSH / RED_PACKET_2026 / VIDEO / EXPRESSIMAGE / SHARE_POSTS / AUDIO_REPLY
（新类型自动泛型兜底入库，需精细解析时在 `src/core/parser.js` 注册表加 parser）

### 核心 API（HTTP）

```
POST /api/v1/members          {keyword}        添加成员（搜索+关注+登记）
GET  /api/v1/members                           成员列表+统计
POST /api/v1/members/:id/sync {mode:incremental|backfill, pages}
POST /api/v1/members/:id/backfill {maxPages?}  全量回溯异步任务（幂等/可查进度）
GET  /api/v1/members/:id/backfill              任务进度
GET  /api/v1/members/:id/messages ?after&before&type&limit&offset  结构化消息（AI 友好）
GET  /api/v1/members/:id/stats                 统计
GET  /api/v1/members/:id/export ?format=jsonl|csv
POST /api/v1/auth/sms | /api/v1/auth/verify    登录
GET  /health                                   健康检查
```

消息结构化输出字段：`msgIdServer, msgTime, msgType, contentType, text, content, mediaUrls, replyTo{sender}, sender{userId,nickName,roleId}`（roleId=3 为成员本人）。

## 三、第二阶段需求（用户原始需求，待细化）

1. **数据利用**：将已捞消息喂给 AI 大模型，让大模型成为"虚拟版小偶像"（需要人格设定/记忆/回复风格）
2. **网页**：对话框式聊天界面，与虚拟小偶像对话
3. 用户暂未定：用哪家大模型 API、网页技术栈、是否要做多成员切换

## 四、用户偏好（已确认的硬约束）

- 后端用 **Node.js**（用户问过为何不用 Java，已确认 Node；理由：wasm 签名直接复用 + 开源生态全 JS）
- **零 npm 依赖**方案（node:sqlite + node:http），用户认可
- 消息存储：**全量入库**（所有类型都存，可扩展）
- 只拉**几个成员**（不是全团），架构要支持随时添加/移除
- 架构要**可扩展**（DAO 隔离、类型注册表、语言无关 RESTful 契约）
- 避免重复造轮子，优先复用开源（48tools、idol-grab-utils 等）

## 五、已知边界与风险

- 官方接口未授权，仅供个人学习；请求频率已被控制（1.2s/页）
- 官方保留 1 年历史 → msg48 的多年数据（李婷 22.8 万条）无法一次性补齐，只能从现在起每天增量累积
- 服务长期运行建议 pm2 或 Windows 计划任务托管（当前由会话后台托管，会话结束会停）
- 服务重启后 backfill 任务状态（内存 Map）丢失，数据不受影响，可重新启动任务续跑

## 六、项目目录

```
E:\project\AIXOX48\
├── pocket48-scraper\        # 数据捞取微服务（已交付）
├── research\                # 调研材料（开源仓库 clone、抓包 bundle 分析）
│   ├── idol-grab-utils\     # 开源参考（老接口，已死）
│   ├── 48tools\             # 开源参考（新接口，签名来源）
│   ├── SNH48G-API\          # 老接口文档（已死）
│   └── pocket48-test\       # 早期连通性测试脚本
└── 新阶段产物建议放项目根目录或新建子目录
```

## 七、建议的下一步行动

1. 选型：AI 模型 API（豆包/OpenAI 兼容/通义等）、网页技术栈（Vue3+FastAPI 或 Node 直出）
2. 设计"虚拟偶像"人格层：用成员 TEXT 消息做风格微调/提示词工程 + 记忆检索（RAG：按时间/关键词检索历史消息作为上下文）
3. 网页：对话框 UI + 消息历史 + 成员切换
4. 部署：scraper 用 pm2 常驻；新服务与 scraper 通过 HTTP 通信

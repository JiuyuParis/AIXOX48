# 阶段 B 交接文档 · 虚拟偶像对话网页

> 本文档供新开对话使用：阶段 A「人格引擎」已完成并验收，现在要做**阶段 B：对话网页**。
> 读完本文档 + `virtual-idol/README.md` 即可直接开工。

---

## 一、项目背景

**AIXOX48**：把 SNH48 Team SII 成员李婷在口袋48房间的历史消息（38,468 条），做成一个"虚拟版李婷"对话系统。

- **阶段 A（已完成✅）**：消息喂 AI + 命令行级人格引擎。能在终端和"李婷"聊天，语气/性格/事实记忆已验收。
- **阶段 B（本次要做）**：对话网页。浏览器里打开就能聊，SSE 流式，跨会话记忆，架构预留多成员。

### 李婷身份
- serverId = `29266435`
- serverOwner/userId = `161808465`
- 房间名：「听这个听听呀」
- 粉丝称呼：听听 / 婷 / 婷婷 / 姐 / 老婷
- 关键人设：宠物猫"噜噜"（要改名玄武）、常点外卖（米村拌饭/刘文祥麻辣烫）、声动星河潜力新人、被粉丝调侃"媚粉"、修图不要太假、旧手机放转转回收

---

## 二、当前已完成（阶段 A 产物）

### 服务（已在跑）
- 目录：`E:\project\AIXOX48\virtual-idol`
- 端口：**4200**
- 入口：`node src/index.js`
- 技术栈：Node.js 22 原生 http（零依赖）+ SQLite（WAL）+ 内存 Float32Array 向量库

### 已就绪的 API（网页直接对接）
Base URL：`http://127.0.0.1:4200`

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST | `/api/v1/chat` | **对话（SSE 流式）**，body `{message, conversationId?}` |
| GET | `/api/v1/persona` | 查看人格画像 |
| GET | `/api/v1/conversations` | 会话列表 |
| GET | `/api/v1/conversations/:id` | 会话历史 |
| POST | `/api/v1/conversations/:id/summarize` | 生成跨会话记忆摘要 |

**SSE 事件序列**（前端要处理）：
- `meta`：`{conversationId, isNew, examplesCount, selfMemCount, vectorUsed}`
- `delta`：`{text}` — 逐字推送
- `done`：`{full, chars}`
- `error`：`{message}`

curl 示例：
```bash
curl -N http://127.0.0.1:4200/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你好李婷我是新粉丝"}'
```

### 数据/产物
- 32,043 条本人消息 → `data/liting_texts.jsonl`
- 人格画像 → `data/persona.json`（26 条 lifeFacts + 14 条 examples，**可调**）
- 向量库 → `data/embeddings.bin`（23,527 条 × 2048 维，约 184MB，启动时整体进内存）
- 对话 SQLite → `data/virtual_idol.db`，三张表：
  - `conversations`（会话，含 `member_server_id` 预留多成员）
  - `chat_messages`（消息，role=user/assistant）
  - `conversation_memory`（跨会话摘要）

### 模型
- 对话模型：火山方舟 `doubao-seed-2-1-pro-260915`
- Embedding：`doubao-embedding-vision-251215`（**多模态端点** `/embeddings/multimodal`，一次一条，dim=2048）
- API key 在 `virtual-idol/config.local.json`（已 gitignore）

---

## 三、阶段 B 需求（用户已明确）

1. **对话框 UI**：浏览器打开就能聊，SSE 流式渲染（打字机效果）
2. **跨会话记忆**：网页要体现"她记得你之前聊过什么"——后端已实现（`/summarize` + 新会话自动注入），前端要做会话列表/切换
3. **架构预留多成员**：现在只做李婷，但代码要方便以后加其他成员
4. **单成员李婷**：第一版只做李婷，不做切换器也行，但结构要留好

### 用户偏好（必须遵守）
- **最重要**：语气/性格要像真人。阶段 A 已调过几轮，不要轻易改后端 prompt，除非用户提
- 技术栈用户让我自选，但**先让他审查再动手**（阶段 B 开始时先出方案）
- "重要工作方向和细节要先询问我再干，切勿盲目干"
- 零依赖已放宽为非强约束

---

## 四、关键坑（别重复踩）

1. **Embedding 不是 OpenAI 兼容**：必须走 `/embeddings/multimodal`，input 是 `[{type:"text", text:"..."}]`，一次只向量化一条。网页阶段一般不用碰这个。
2. **Windows + PowerShell 引号转义**：node 内联 `-e "..."` 频繁失败，**一律写临时 .mjs 文件再执行**。
3. **改后端代码要重启**：persona 和向量库启动时加载进内存。杀进程：
   ```powershell
   Get-NetTCPConnection -LocalPort 4200 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
   ```
4. **`node:sqlite` 是实验特性**：有 warning 但能用，别去消 warning。
5. **RAG 双路分流已做**：TEXT→"你的记忆"，REPLY→"风格示例"。网页阶段不要动这个逻辑。
6. **SSE 流式**：用 `fetch + ReadableStream` 或 `EventSource`（POST 用 fetch 流解析），不要用普通 axios。
7. **API key 曾在对话出现**，建议用户在方舟轮换过。

---

## 五、阶段 B 开工建议顺序

1. **先出方案给用户审查**：技术栈（纯静态 HTML+JS 直连？还是加个前端框架？后端要不要加静态文件服务？）
2. **后端加静态文件服务**：在现有 4200 服务里加 `GET /` 返回网页 HTML（或单独起个前端 dev server）
3. **前端页面**：
   - 左侧会话列表（调 `/api/v1/conversations`）
   - 中间聊天区（SSE 流式渲染）
   - 输入框 + 发送
   - "新会话"按钮
   - 可选：结束后自动调 `/summarize`（或用户手动点"记住这次聊天"）
4. **多成员预留**：HTML 里成员选择器先隐藏/注释，config 层已留 `member_server_id`
5. **联调**：和后端 SSE 跑通，测跨会话记忆（聊完一段 → 新会话 → 她记得你）

---

## 六、相关文档

- `virtual-idol/README.md` — 完整技术文档（API、目录、调优指南）
- `PROJECT_HANDOFF.md`（项目根）— 项目最初交接
- `pocket48-scraper/README.md` — 上游爬虫（数据已抓完，阶段 B 不用动）

---

## 七、验收标准（阶段 B）

- [ ] 浏览器打开能和"李婷"聊天，流式打字效果
- [ ] 能看到历史会话列表，切换会话能看到旧消息
- [ ] 聊完一段，新开会话她能自然记得上一段聊过的内容
- [ ] 代码结构预留多成员
- [ ] 用户主观觉得"像真人"（延续阶段 A 标准）

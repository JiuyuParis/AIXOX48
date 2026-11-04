# virtual-idol · 虚拟偶像对话引擎（李婷）

> AIXOX48 项目第二阶段：从口袋48 抓取的历史消息中学习 SNH48 Team SII 成员**李婷**的语气、性格与真实经历，生成一个"虚拟版李婷"对话服务。
>
> **阶段 A（人格引擎）与阶段 B（对话网页）均已完成并验收**。浏览器打开 `http://127.0.0.1:4200/` 即可和她聊天；终端可用 `node cli/chat.mjs` 试聊；全部能力通过 HTTP API 暴露，可二次开发。

---

## 一、项目介绍

### 1.1 这是什么

把李婷在口袋48房间里说过的 **38,468 条**历史消息，转化成一个能**以她的口吻**和粉丝聊天的 AI 服务。

- 重点不是"问答正确"，而是 **"像不像她"**——短句、口语化、亲切但带点直接、叫粉丝"宝宝"、会接梗、会引用她真实经历过的事。
- 本质是 **RAG（检索增强生成）**：用户每次提问，先从她 3.2 万条真实历史消息里检索相关内容，注入到系统提示词中，再交给大模型生成回复。

### 1.2 项目背景（AIXOX48 全景）

```
pocket48-scraper（上游，端口 4100）
   └─ 抓取口袋48 房间消息（李婷本人 38,468 条）→ pocket48.db
        │
        ▼
virtual-idol（本仓库，端口 4200）
   ├─ 阶段 A：离线管线构建人格画像 + 向量库 → 命令行人格引擎（已验收）
   └─ 阶段 B：对话网页（SSE 流式 / 会话管理 / 跨会话记忆 / 移动端适配）（已验收）
```

### 1.3 能力边界

| ✅ 能做好 | ⚠️ 已知短板 |
|---|---|
| 短句、口语化回复（历史平均 9 字，中位数 8 字） | 纯表情/单字回复（"👍🏻""gun"）——LLM 天性，不是 bug |
| 亲切、会叫粉丝"宝宝"、主动接话 | 实时性事实（今天日程、当天吃了啥）——历史数据只覆盖近一年 |
| 引用她真实经历（"刷朋友圈看到小学同学结婚"） | 涉及她真实生活但历史未覆盖的事，可能说"不知道" |
| 接梗、适度怼粉、不圆场 | 上下文超过 20 条后较早的对话会被裁剪（历史截断） |

### 1.4 数据来源

- 上游：`pocket48-scraper`（端口 4100，SQLite），已抓取李婷本人消息 **38,468 条**（其中本人文字消息 32,043 条入库）
- 李婷身份：`serverId = 29266435`，`serverOwner/userId = 161808465`，房间名「听这个听听呀」
- 粉丝称呼：听听 / 婷 / 婷婷 / 姐 / 老婷
- 关键人设关键词：宠物猫"噜噜"（曾说要改名"玄武"）、常点外卖（米村拌饭/刘文祥麻辣烫）、声动星河潜力新人、被粉丝调侃"媚粉"、修图不要太假、旧手机放转转回收

---

## 二、快速开始（5 分钟上手）

### 2.1 环境要求

- **Node.js 22+**（用到实验特性 `node:sqlite`，启动时有 ExperimentalWarning，**属正常，别去消除**）
- **火山方舟账号**：已开通对话模型 `doubao-seed-2-1-pro-260915` + Embedding 模型 `doubao-embedding-vision-251215`
- （仅首次构建数据时需要）上游 `pocket48-scraper/data/pocket48.db` 存在

### 2.2 配置密钥

```powershell
cd E:\project\AIXOX48\virtual-idol
# 首次：把 config.local.json 里的 apiKey 填成你的方舟 API key
```

密钥加载优先级：**环境变量 > config.local.json > 内置默认值**。缺失 apiKey 时服务会打印 `[config] 缺少 ARK_API_KEY` 但仍启动（对话会失败）。

### 2.3 启动服务

```powershell
cd E:\project\AIXOX48\virtual-idol
node src/index.js
```

启动输出：

```
[virtual-idol] 服务已启动: http://127.0.0.1:4200
[virtual-idol] 偶像: 李婷 (SNH48 Team SII)
[virtual-idol] 对话模型: doubao-seed-2-1-pro-260915 | 向量模型: doubao-embedding-vision-251215
[virtual-idol] 健康检查: http://127.0.0.1:4200/health
```

> 服务监听所有网卡（`0.0.0.0`），**同一局域网内的手机/其他设备可直接用 `http://<电脑IP>:4200/` 访问**（如 `http://192.168.1.101:4200/`）。

### 2.4 三种使用方式

| 方式 | 入口 | 适用 |
|---|---|---|
| **网页** | 浏览器打开 `http://127.0.0.1:4200/` | 日常聊天、体验流式打字与跨会话记忆 |
| **CLI 终端** | `node cli/chat.mjs` | 调试、快速验证人格语气 |
| **HTTP API** | `http://127.0.0.1:4200/api/v1/*` | 二次开发、接入其他系统 |

---

## 三、技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 对话模型 | 火山方舟 `doubao-seed-2-1-pro-260915` | SSE 流式生成，temperature 0.85 |
| Embedding 模型 | 火山方舟 `doubao-embedding-vision-251215` | 多模态端点 `/embeddings/multimodal`，dim=2048，一次只向量化一条 |
| 运行时 | Node.js 22+ | 原生 `node:sqlite`（实验特性，有 warning 可用） |
| HTTP | 原生 `node:http`（**零 npm 依赖**） | SSE 流式响应 + 静态页面托管 |
| 存储 | SQLite（WAL 模式）+ 内存 `Float32Array` 向量库 | 对话/记忆入库；向量启动时整体加载进内存（约 184MB） |
| 前端 | 原生 HTML + CSS + JavaScript（零框架零构建） | 由 4200 服务直接托管 |

> **⚠️ Embedding 关键坑**：`doubao-embedding-vision-251215` **不是** OpenAI 兼容的 `/embeddings` 端点，必须走 `/embeddings/multimodal`，input 格式为 `[{type:"text", text:"..."}]` 数组，**一次请求只向量化一条文本**。本仓库的 `chat.js` 已封装并发池（默认并发 8）。

---

## 四、系统架构

### 4.1 分层结构

```
┌────────────────────────────────────────────────────────────┐
│  展示层：public/（网页） + cli/（终端）                     │
└──────────────────────────┬─────────────────────────────────┘
                           │ HTTP / SSE
┌──────────────────────────▼─────────────────────────────────┐
│  API 层：src/api/routes.js                                 │
│    /health /persona /conversations /chat /静态页面          │
└──────────────────────────┬─────────────────────────────────┘
┌──────────────────────────▼─────────────────────────────────┐
│  核心层 src/core/                                          │
│    chat.js      ← 方舟 SSE 对话 + embedding 并发池          │
│    prompt.js    ← system prompt 组装（人格+记忆+示例+规则）  │
│    retriever.js ← 消息加载 + 向量余弦检索 + 关键词兜底        │
│    memory.js    ← 会话摘要生成 + 跨会话记忆读取              │
└──────────────────────────┬─────────────────────────────────┘
┌──────────────────────────▼─────────────────────────────────┐
│  数据层                                                    │
│    db/database.js ← SQLite 三表（会话/消息/记忆）            │
│    data/          ← persona.json / 向量库 / 消息 / 统计      │
└────────────────────────────────────────────────────────────┘
```

### 4.2 一次对话的完整流程（`POST /api/v1/chat`）

```
粉丝消息
   │
   ▼
 1. 取/建会话 ── 不传 conversationId 则新建（SQLite conversations 表）
   │
 2. 向量化用户问题 ── embedText() 走 multimodal 端点（懒加载向量库）
   │
 3. 检索 ── retriever.search()：
   │      ├─ 向量语义检索 top-8（余弦相似度，向量已预归一化）
   │      └─ 命中 <2 条时关键词 LIKE 兜底（提取 2~6 字中文词）
   │
 4. 按类型分流（RAG 双路，见 4.3）
   │      ├─ TEXT（她主动发的）→ selfMemories：「你以前说过的话」
   │      └─ REPLY（她回粉丝的）→ examples：「你平时怎么回复粉丝」
   │
 5. 跨会话记忆 ── 仅新会话注入最近 5 条历史摘要（recentMemories）
   │
 6. 组装 messages ── buildSystemPrompt() + 会话内最近 20 条历史 + 用户消息
   │
 7. 流式调用模型 ── chatStream()，temperature 0.85，maxTokens 600
   │
 8. SSE 推送 ── meta → delta（逐字）→ 存消息 → done
```

### 4.3 核心设计：RAG 双路分流

这是阶段 A 最后一轮的关键修复。早期把检索到的消息**全部**当风格示例注入，模型不知道哪条是"她自己的经历"，导致问"小学同学结婚"她答"不知道"。

现在按消息类型分流：

- **TEXT 类型**（她主动发的动态）→ 注入为「你以前在房间里说过的话（这是你自己的经历和记忆，回答相关问题时自然引用，不要假装不知道）」
- **REPLY 类型**（她回粉丝的）→ 注入为「你平时怎么回复粉丝（模仿这个语气，这是你本人的原话）」

效果：问事实时她"记得"，问风格时她"像她"。**网页阶段不要动这个逻辑**。

### 4.4 检索器双通道（retriever.js）

| 通道 | 机制 | 触发条件 |
|---|---|---|
| 向量语义检索（主力） | 2048 维 Float32Array 全量内存余弦（预归一化，点积即相似度） | 向量库已加载且结果 ≥2 条 |
| 关键词 LIKE（兜底） | 抽取查询中的 2~6 字中文词，命中数优先、时间近次之；`GIFTREPLY` 类型（模板致谢）不参与 | 向量未就绪或向量结果 <2 条 |

向量库**懒加载**：服务启动时不读 184MB 向量文件，第一次对话时才 `loadVectors()`。因此刚启动时 `/health` 的 `vectorReady` 为 `false` 属正常。

### 4.5 跨会话记忆机制（memory.js）

```
会话聊完 ── 调 /api/v1/conversations/:id/summarize（或 CLI /summary）
   │ 模型把整段会话（最多 40 条）压缩成 ≤100 字第三人称摘要
   │ （temperature 0.3，maxTokens 200，只保留身份线索/话题/承诺）
   ▼
存 conversation_memory 表（upsert）
   │
   ▼
下次新建会话 ── 自动注入最近 5 条历史摘要到 system prompt
   │
   ▼
模型回答时可自然提及（"上次你说…"），但不机械复述
```

> 网页端通过每个会话的"总结"按钮手动触发；CLI 用 `/summary`。

### 4.6 多成员扩展预留

当前单成员（李婷），架构已预留多成员：

| 位置 | 预留 |
|---|---|
| `config.idol.serverId` | 成员房间 ID 配置 |
| `conversations.member_server_id` 列 | 会话按成员隔离 |
| `src/db/database.js` 的 `listConversations(memberServerId)` | 按成员查会话 |
| 前端 `app.js` 的 `MEMBERS` 注册表 | 加一行 `{serverId, name, team}` 即可注册新成员 |
| `index.html` 的 `.member-select` | 成员切换器（当前 `hidden`） |
| `persona.json` | 目前单人，未来可扩展为 `personas/<serverId>.json` |

---

## 五、目录结构（完整）

```
virtual-idol/
├── README.md                    ← 本文档
├── config.local.json            ← 本地敏感配置（API key，已 gitignore）
├── .gitignore
│
├── public/                      ← 阶段 B 对话网页（由 4200 静态托管）
│   ├── index.html               ← 页面骨架（含隐藏的多成员选择器）
│   ├── style.css                ← 柠檬黄应援色浅色偶像风（含移动端媒体查询）
│   └── app.js                   ← SSE 流式渲染/会话管理/总结/删除/移动端抽屉
│
├── src/                         ← 服务端
│   ├── index.js                 ← 服务入口：http 服务器，端口 4200，启动预热消息
│   ├── config.js                ← 配置加载（config.local.json + 环境变量覆盖）
│   ├── api/
│   │   └── routes.js            ← 全部 HTTP 路由 + 静态文件托管 + SSE 协议
│   ├── core/
│   │   ├── chat.js              ← 方舟 chat/completions SSE 客户端 + embedding 并发池
│   │   ├── prompt.js            ← system prompt 组装（人格+记忆+示例+聊天规则）
│   │   ├── retriever.js         ← 消息加载 + 向量余弦检索 + 关键词 LIKE 兜底
│   │   └── memory.js            ← 会话摘要生成 + 跨会话记忆读取
│   └── db/
│       └── database.js          ← SQLite 三表 + 会话/消息/记忆增删查
│
├── cli/
│   └── chat.mjs                 ← 终端试聊（/new /history /summary /persona /help /exit）
│
├── scripts/                     ← 离线管线（一次性跑过，可重跑，见第十二节）
│   ├── extract-messages.mjs     ← ① 从 scraper SQLite 抽消息 → liting_texts.jsonl
│   ├── analyze-stats.mjs        ← ② 纯确定性语言特征统计 → liting_stats.json
│   ├── prepare-samples.mjs      ← ③ 抽样人格样本 + 留出评测集
│   ├── build-persona.mjs        ← ④ LLM 提炼人格画像 → persona.json
│   ├── build-vectors.mjs        ← ⑤ 批量向量化 → embeddings.bin + meta
│   ├── pick-examples.mjs        ← 辅助：精选代表性对话对 → persona.json.examples
│   ├── evaluate.mjs             ← ⑥ 自动评测（生成+裁判打分）→ eval_report.json
│   └── test-retrieval.mjs       ← 辅助：手动验证向量检索命中
│
└── data/                        ← 数据与产物（运行时 + 离线构建）
    ├── liting_texts.jsonl        ← 32,043 条本人文字消息（4.4MB）
    ├── liting_stats.json         ← 语言特征统计（2.2MB，27 个统计键）
    ├── persona.json              ← 人格画像（人工可改，改完重启）
    ├── persona_samples.jsonl     ← 人格提炼输入样本（31KB）
    ├── eval_pairs.jsonl          ← 120 条留出评测对（12KB）
    ├── eval_report.json          ← 历次评测分数（9KB）
    ├── embeddings.bin            ← 23,527 条 2048 维向量（188MB）
    ├── embeddings.meta.jsonl     ← 每条向量对应的消息元数据（875KB）
    └── virtual_idol.db           ← 对话 SQLite（WAL；另有 -shm/-wal 伴随文件）
```

---

## 六、数据与产物详解

### 6.1 数据文件总表

| 文件 | 内容 | 大小 | 是否可改 |
|---|---|---|---|
| `persona.json` | 人格画像（见 6.2） | 7KB | ✅ **主要调优点**，改完重启生效 |
| `liting_texts.jsonl` | 每行一条：`{msgId, msgTime, type, text, fanText, fanName}` | 4.4MB | 由 extract 脚本生成，一般不动 |
| `liting_stats.json` | 语言特征统计（见 6.3） | 2.2MB | 由 analyze-stats 生成，可查不可改 |
| `persona_samples.jsonl` | 人格提炼输入（抽样 TEXT + REPLY 对话对） | 31KB | 由 prepare-samples 生成 |
| `eval_pairs.jsonl` | 120 条「粉丝原话→李婷真实回复」留出集 | 12KB | **评测基准，勿动** |
| `eval_report.json` | 历次评测分数 | 9KB | 由 evaluate 自动写 |
| `embeddings.bin` + `embeddings.meta.jsonl` | 向量库（Float32 扁平数组 + 元数据） | 188MB + 875KB | 改了文本数据需重跑 `build-vectors.mjs`（约 7 分钟） |
| `virtual_idol.db` | 运行时数据（会话/消息/记忆） | 几 KB~数 MB | 运行时自动写 |

### 6.2 人格画像 `persona.json` 字段详解

| 字段 | 内容 | 作用 |
|---|---|---|
| `identity` | 成员身份、房间名、粉丝称呼 | 告诉模型"你是谁" |
| `personality` | 性格总述（随性松弛、冷幽默、无偶像包袱、情绪平缓） | 整体基调 |
| `speechStyle` | 10 条说话风格（短句、句尾少标点、文言反差、"非也""何意味"等） | 语气约束 |
| `catchphrases` | 15 个口头禅/习惯词（噜噜、翻牌、不知道、下班…） | 高频词汇倾向 |
| `emojiHabits` | 表情习惯（小黄脸为主，单条 ≤3 个） | 表情使用约束 |
| `lifeFacts` | 26 条真实生活经历（养猫噜噜、点外卖、公演排练…） | 事实记忆来源 |
| `topics` | 10 个常聊主题分类 | 话题引导 |
| `examples` | 14 条精选「粉丝原话→真实回复」对话对 | 风格 few-shot |
| `version` | 构建日期 | 版本记录 |

### 6.3 语言特征统计 `liting_stats.json`（27 个键）

| 类别 | 键 | 说明 |
|---|---|---|
| 总量 | `total` / `totalChars` | 32,043 条 / 288,864 字 |
| 类型 | `byType` | TEXT / GIFTREPLY / REPLY 分布 |
| 长度 | `lenAvg` / `lenMedian` / `lenMax` / `lenBuckets` / `topLen50` | 平均 9 字、中位 8 字、最长 300 字 |
| 用词 | `wordFreq` / `topWords` | 高频词（哈喽、我来啦…） |
| 语气词 | `particleFreq` / `topParticles` | 哈、呀、啦、么、呢… |
| 表情 | `emojiFreq` / `topEmoji` | 高频 emoji（🍊😉😘…） |
| 标点 | `exclaimPct` / `questionPct` / `ellipsisPct` / `tildePct` | 感叹/疑问/省略/波浪号占比 |
| 起止 | `startsWith` / `endsWith` / `topStarts` / `topEnds` | 消息开头/结尾习惯 |
| 时段 | `hourFreq` / `hourTop` | 活跃时段（22时、0时、17时…） |
| 其他 | `selfRef` / `topSelfRef` / `replyLenRatio` | 自称习惯、回复长度比 |

> **小坑**：该文件含大小写重复键（如 `iphone`/`iPhone`），PowerShell 的 `ConvertFrom-Json` 会报"重复键"错误，Node 的 `JSON.parse` 不受影响（后者键覆盖）。查看请用 Node 或 VS Code。

### 6.4 SQLite 三表结构（`virtual_idol.db`）

```sql
conversations (
  id TEXT PRIMARY KEY,              -- UUID
  member_server_id INTEGER NOT NULL, -- 成员房间（多成员预留）
  title TEXT DEFAULT '新会话',       -- 首条用户消息自动生成（前 20 字）
  created_at INTEGER NOT NULL,      -- 毫秒时间戳
  updated_at INTEGER NOT NULL
);

chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,    -- 外键→conversations.id
  role TEXT NOT NULL,               -- user / assistant
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- 索引：idx_chat_conv(conversation_id, id)

conversation_memory (
  conversation_id TEXT PRIMARY KEY, -- 一个会话最多一条摘要（upsert）
  summary TEXT NOT NULL,            -- ≤100 字第三人称摘要
  token_count INTEGER DEFAULT 0,
  created_at / updated_at INTEGER
);
```

WAL 模式：读写在 `-wal` 文件缓冲，读写并发友好。`virtual_idol.db-wal`（当前约 2.2MB）是正常伴随文件。

---

## 七、配置

### 7.1 `config.local.json`（本地，已 gitignore）

```json
{
  "ark": {
    "apiKey": "ark-xxxxxxxx",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "chatModel": "doubao-seed-2-1-pro-260915",
    "embeddingModel": "doubao-embedding-vision-251215"
  },
  "server": { "port": 4200 },
  "idol": {
    "serverId": 29266435,
    "serverOwner": 161808465,
    "name": "李婷",
    "team": "SNH48 Team SII"
  }
}
```

### 7.2 环境变量覆盖（优先级高于文件）

| 变量 | 作用 |
|---|---|
| `ARK_API_KEY` | 方舟 API key |
| `ARK_BASE_URL` | 方舟 API 地址（默认官方） |
| `ARK_CHAT_MODEL` | 对话模型 |
| `ARK_EMBEDDING_MODEL` | Embedding 模型 |
| `PORT` | 服务端口（默认 4200） |
| `IDOL_BASE` | 仅 CLI 用：服务地址（默认 `http://127.0.0.1:4200`） |

### 7.3 安全提醒

> ⚠️ API key 曾在对话中出现，**建议在方舟控制台轮换**。key 只存在于 `config.local.json`（已 gitignore），不要提交到仓库、不要写入日志。

---

## 八、HTTP API 完整参考

Base URL：`http://127.0.0.1:4200`

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/` | 对话网页（静态托管） |
| GET | `/style.css` `/app.js` | 网页静态资源 |
| GET | `/health` | 健康检查 |
| GET | `/api/v1/persona` | 查看人格画像 |
| GET | `/api/v1/conversations` | 会话列表（最近 50 个） |
| GET | `/api/v1/conversations/:id` | 会话详情 + 消息历史（最多 100 条） |
| DELETE | `/api/v1/conversations/:id` | 删除会话（连带消息与记忆摘要） |
| POST | `/api/v1/conversations/:id/summarize` | 生成该会话的跨会话记忆摘要 |
| POST | `/api/v1/chat` | 对话（SSE 流式） |

### 8.1 `GET /health` — 健康检查

```json
{
  "ok": true,
  "service": "virtual-idol",
  "time": "2026-09-19T15:23:54.735Z",
  "idol": "李婷",
  "persona": true,
  "historyMessages": 32043,
  "vectorReady": true,
  "vectorDim": 2048,
  "chatModel": "doubao-seed-2-1-pro-260915",
  "embeddingModel": "doubao-embedding-vision-251215"
}
```

> `vectorReady` 首次对话时才懒加载向量库，刚启动为 `false` 属正常。

### 8.2 `POST /api/v1/chat` — 对话（SSE 流式）

**请求体**：

```json
{ "message": "你好呀", "conversationId": "可选，不传则新建" }
```

参数说明：
- `message`：必填，用户消息，最长 500 字（超出截断）
- `conversationId`：可选；不传或传不存在的 id 会新建会话（404 只在传了 id 但找不到时返回）

**响应**：`text/event-stream; charset=utf-8`，事件序列见第九节。

**curl 示例（Linux/macOS）**：

```bash
curl -N http://127.0.0.1:4200/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"你好李婷我是新粉丝"}'
```

### 8.3 `GET /api/v1/persona` — 人格画像

返回完整 `persona.json`（含 identity/personality/speechStyle/catchphrases/emojiHabits/lifeFacts/topics/examples/version）。

### 8.4 `GET /api/v1/conversations` — 会话列表

返回当前成员最近 50 个会话，按 `updated_at` 倒序。每条：

```json
{
  "id": "682c33b1-...",
  "member_server_id": 29266435,
  "title": "你好，李婷",
  "created_at": 1789829506511,
  "updated_at": 1789829828094,
  "msg_count": 12,
  "has_memory": 1
}
```

- `title`：首条用户消息自动生成（前 20 字）；旧数据可能为"新会话"
- `msg_count`：消息条数（含 user 与 assistant）
- `has_memory`：1 = 已生成跨会话记忆摘要，0 = 未总结

### 8.5 `GET /api/v1/conversations/:id` — 会话详情

```json
{
  "conversation": { "id": "...", "title": "...", ... },
  "messages": [ { "role": "user", "content": "你好", "created_at": 1789829506511 }, ... ]
}
```

消息按时间正序，最多 100 条。会话不存在返回 `404 {"error":"会话不存在"}`。

### 8.6 `DELETE /api/v1/conversations/:id` — 删除会话

级联删除：该会话的 `chat_messages` + `conversation_memory` + `conversations` 记录。返回 `{"ok":true}`。删除后新会话不再注入它的记忆。

### 8.7 `POST /api/v1/conversations/:id/summarize` — 生成跨会话记忆

把该会话最近 40 条消息压缩成 ≤100 字第三人称摘要，写入 `conversation_memory`（upsert）。返回：

```json
{ "summary": "这位粉丝是新粉，夸她唱歌好听…" }
```

会话为空时返回空摘要；LLM 调用失败返回 `502`。**新会话开始时自动注入最近 5 条摘要**（见 4.5）。

---

## 九、SSE 流式协议（前端对接规范）

`POST /api/v1/chat` 返回 `text/event-stream`，每条事件格式：

```
event: <事件名>
data: <JSON>

```

**事件序列**：

| 事件 | data | 说明 |
|---|---|---|
| `meta` | `{conversationId, isNew, examplesCount, selfMemCount, vectorUsed}` | 对话开始；`isNew` 为 true 表示新建会话；`selfMemCount`=检索到的她的往事条数，`examplesCount`=风格示例条数 |
| `delta` | `{text}` | 模型增量输出，逐字/逐词推送，前端直接追加 |
| `done` | `{full, chars}` | 流结束；`full` 为完整回复，`chars` 为字数；出错时带 `error` 字段 |
| `error` | `{message}` | 出错中断 |

**前端对接要点**：

1. 必须用 `fetch + ReadableStream`（POST 请求），**不要用 `EventSource`**（EventSource 只支持 GET）
2. 用 `TextDecoder('utf-8', {stream:true})` 解码，避免中文跨 chunk 截断成乱码
3. 按 `\n\n` 切分事件块，缓冲未完整块
4. `delta` 事件按 `{text}` 累加渲染即"打字机效果"
5. 浏览器请求发完 body 后**不要关闭写端**（某些 HTTP 客户端如 PowerShell `Invoke-WebRequest` 会触发后端 abort，导致回复被截断成短句——见 15.4）

---

## 十、前端网页（阶段 B）

### 10.1 功能清单

- ✅ SSE 流式打字效果（逐字渲染 + 光标动画）
- ✅ 左侧会话列表（标题/相对时间/消息数/记忆状态）
- ✅ 会话切换、历史回显
- ✅ 首条用户消息自动生成会话标题
- ✅ "总结"按钮 → 生成跨会话记忆（成功后显示"已记忆"徽标）
- ✅ "删除"按钮 → 确认后删除会话（连带消息与记忆）
- ✅ meta 提示条（"她记得 X 条往事 · 参考 Y 条风格示例"）
- ✅ "李婷正在输入…"三点动画
- ✅ 移动端适配（≤720px：抽屉式会话列表 + 遮罩 + 汉堡按钮）
- ✅ 多成员预留（隐藏成员选择器 + `MEMBERS` 注册表）
- ✅ Enter 发送 / Shift+Enter 换行；输入中防重复发送

### 10.2 前端文件职责

| 文件 | 职责 |
|---|---|
| `index.html` | 骨架：侧边栏（品牌/新会话/会话列表）+ 聊天区（header/消息/输入） |
| `style.css` | 柠檬黄（`#FFE14D`）应援色体系；CSS 变量集中配色；`@media (max-width:720px)` 抽屉布局 |
| `app.js` | 状态机（currentConvId/sending）+ SSE 解析 + 渲染 + API 封装 + 抽屉交互 |

### 10.3 移动端适配说明

- 断点：`max-width: 720px`
- 移动端侧边栏改为 `position: fixed` 抽屉（`width: min(80vw, 300px)`），默认 `translateX(-100%)` 隐藏
- 聊天区全屏；左上角"☰"汉堡按钮滑出抽屉；点击遮罩或选择会话自动收起
- 点汉堡按钮 → `body.sidebar-open`；遮罩监听排除汉堡按钮本身（否则闪开闪关）
- 回到桌面宽度自动清除抽屉状态（resize 监听）
- iOS 输入框 `font-size:16px` 防聚焦缩放

---

## 十一、CLI 终端工具

```powershell
cd E:\project\AIXOX48\virtual-idol
node cli\chat.mjs [会话ID]
```

可选参数：传入会话 ID 可续聊指定会话。

| 命令 | 作用 |
|---|---|
| 直接输入 | 发消息聊天（SSE 流式显示） |
| `/new` | 开新会话 |
| `/history` | 查看当前会话历史 |
| `/summary` | 当前会话生成记忆摘要 |
| `/persona` | 查看当前人格画像（前 2500 字） |
| `/help` | 帮助 |
| `/exit` / `/quit` | 退出 |

---

## 十二、离线管线脚本（一般不用重跑）

按顺序执行（首次跑过一次即可；数据变更后可重跑）：

```powershell
cd E:\project\AIXOX48\virtual-idol\scripts

node extract-messages.mjs     # ① 从 scraper SQLite 抽消息 → liting_texts.jsonl
node analyze-stats.mjs        # ② 纯确定性语言特征统计 → liting_stats.json（不调模型）
node prepare-samples.mjs      # ③ 抽样人格样本 + 留出评测集
node build-persona.mjs        # ④ LLM 提炼人格 → persona.json（输入 ③ 的样本 + ② 的统计）
node build-vectors.mjs        # ⑤ 批量向量化 → embeddings.bin + meta（约 7 分钟，并发 8）
node evaluate.mjs 30          # ⑥ 跑 N 条评测打分（可选）
```

辅助脚本：

- `pick-examples.mjs`：从历史精选代表性对话对，写入 `persona.json` 的 `examples`
- `test-retrieval.mjs`：手动验证向量检索命中（如问"小学同学有结婚的嘛"能否命中）

**注意**：脚本 `③→④→⑤→⑥` 有依赖顺序；改动 `liting_texts.jsonl` 后需重跑 `⑤` 才能让检索用到新数据。

---

## 十三、人格调优指南

**语气不满意时，按这个顺序改**：

1. **改 `data/persona.json`**（最安全，第一优先）
   - `speechStyle`：说话风格描述（如"偶尔使用'非也''何意味'制造反差感"）
   - `catchphrases`：口头禅
   - `lifeFacts`：她做过的事（事实记忆来源）
   - `examples`：代表性对话对（风格 few-shot，`pick-examples.mjs` 可辅助）
2. **改 `src/core/prompt.js` 的 `buildSystemPrompt`**
   - 【聊天规则】段落：语气/温度/规则
   - **关键历史经验：不要把"怼粉/不给面子"写太重**，会矫枉过正成冷漠；要写"亲切、像朋友、会叫宝宝、会主动接话"
3. **重启服务**生效（persona 启动时加载进内存）

**回答不上历史事实时**：

- 先用 `scripts/test-retrieval.mjs` 验证向量检索是否命中
- 命中但模型没用 → 检查 prompt 里【你以前说过的话】注入是否生效
- 没命中 → 可能语义差距大，考虑把事实加进 `persona.json` 的 `lifeFacts`

---

## 十四、评测体系

### 14.1 评测原理

- 留出集 `eval_pairs.jsonl`：120 条「粉丝原话 → 李婷真实回复」（**不进入任何 prompt**，避免污染）
- `evaluate.mjs N`：对前 N 条粉丝原话，用当前人格 + 检索体系生成模型回复 → 交给同一豆包模型当裁判打分（0~10）→ 写入 `eval_report.json`
- 裁判会给出分项评语（如"真实走跳脱玩梗路线，模仿是正经答复，风格偏差较大"）

### 14.2 评测历史

| 版本 | 平均分 | 关键改动 |
|---|---|---|
| v1 基线 | 2.43/10 | 关键词 RAG |
| v2 prompt 强化 | 3.50/10 | 禁思考输出、精选示例、短句约束 |
| v3 向量 RAG | 3.07/10 | 语义检索上线 |
| v3.1 分流+调暖 | 用户验收通过 | TEXT/REPLY 分流、语气调暖、事实引用规则 |

> 评测用同一豆包模型当裁判，分数有 ±0.5 噪声；**以真人主观试聊感受为准**。最近一次报告（2026-09-19）：30 条，avg 3.07，persona v2026-09-16。

---

## 十五、运维与排障

### 15.1 重启服务

```powershell
Get-NetTCPConnection -LocalPort 4200 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
cd E:\project\AIXOX48\virtual-idol
node src/index.js
```

> persona 和向量库启动时加载进内存，**改了后端代码/`persona.json`/`prompt.js` 必须重启**；改 `public/` 前端文件无需重启（每次请求读盘）。

### 15.2 已知坑清单（重要）

1. **Embedding 不是 OpenAI 兼容**：必须走 `/embeddings/multimodal`，input 是 `[{type:"text", text:"..."}]`，一次只向量化一条。
2. **Windows + PowerShell 引号转义**：node 内联 `-e "..."` 频繁失败，**一律写临时 `.mjs` 文件再执行**。
3. **`node:sqlite` 是实验特性**：启动有 ExperimentalWarning，能用，**别去消 warning**。
4. **RAG 双路分流已调好**：TEXT→"你的记忆"，REPLY→"风格示例"，网页阶段不要动。
5. **SSE 流式**：用 `fetch + ReadableStream` 或流式解析，不要用普通 axios 一次性拿响应。
6. **`liting_stats.json` 含大小写重复键**：PowerShell `ConvertFrom-Json` 会报错，Node 解析正常。
7. **API key 曾在对话中出现**：建议在方舟控制台轮换。

### 15.3 常见症状 → 处理

| 症状 | 处理 |
|---|---|
| `/health` 返回 `vectorReady:false` | 正常，首次对话才懒加载向量库 |
| 对话返回 502 / "方舟 API ..." | 检查 API key 是否有效、额度是否充足 |
| 网页打不开 | 服务未启动；或访问 IP 与本机不同网段 |
| 手机访问不了 | 确认手机与电脑同一局域网；Windows 防火墙放行 4200 端口 |
| 改了 persona 没生效 | 未重启服务（见 15.1） |

### 15.4 联调工具注意事项

- **不要用 PowerShell `Invoke-WebRequest` 测 SSE 对话**：它发完请求体后可能触发后端 `req.on('close')` abort，导致模型流被截断（表现为只回"？"这类短句），**误判为模型问题**。用 Node `fetch` 脚本或浏览器验证。
- curl 在 Windows PowerShell 中传中文 body 会乱码（`{"error":"请求体不是合法 JSON"}`），用 Node 脚本或 `curl.exe` 配合 UTF-8 文件。

---

## 十六、项目阶段历史

| 阶段 | 内容 | 状态 |
|---|---|---|
| 阶段 A | 离线管线 + 人格引擎（CLI/API） | ✅ 已验收 |
| 阶段 B | 对话网页（SSE 流式/会话/记忆/删除/移动端） | ✅ 已验收 |
| 未来 | 多成员切换、单条消息删除、记忆管理页 | 待规划 |

---

## 附：相关文档

- `E:\project\AIXOX48\PHASE_B_HANDOFF.md` — 阶段 B 交接文档（架构、需求、坑）
- `E:\project\AIXOX48\PROJECT_HANDOFF.md` — 项目最初交接
- `E:\project\AIXOX48\pocket48-scraper\README.md` — 上游爬虫（数据已抓完，一般不动）

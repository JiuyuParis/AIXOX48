// HTTP API 路由：对话（SSE 流式）、会话管理、人格查看、静态页面托管
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConversation, getConversation, listConversations, addChatMessage, getChatMessages, deleteConversation } from '../db/database.js';
import { loadPersona, buildSystemPrompt, buildMessages } from '../core/prompt.js';
import { chatStream, embedText } from '../core/chat.js';
import { search, loadMessages, loadVectors, vectorReady, vectorDimOf } from '../core/retriever.js';
import { recentMemories, summarizeConversation } from '../core/memory.js';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// 静态文件托管（阶段 B 网页）：GET / → index.html，/xxx.ext → public/xxx
async function serveStatic(res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1).replace(/^public\//, '');
  if (!file || file.includes('..') || file.includes(':') || file.includes('\\')) return false;
  const abs = join(PUBLIC_DIR, file);
  try {
    const buf = await readFile(abs);
    const type = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function handleRequest(req, res, url) {
  const p = url.pathname;

  // ---- 健康检查 ----
  if (p === '/health' && req.method === 'GET') {
    const msgs = loadMessages();
    return json(res, 200, {
      ok: true, service: 'virtual-idol', time: new Date().toISOString(),
      idol: config.idol.name, persona: !!loadPersona().personality,
      historyMessages: msgs.length, vectorReady: vectorReady(), vectorDim: vectorDimOf(),
      chatModel: config.ark.chatModel, embeddingModel: config.ark.embeddingModel,
    });
  }

  // ---- 人格设定 ----
  if (p === '/api/v1/persona' && req.method === 'GET') {
    return json(res, 200, loadPersona());
  }

  // ---- 会话列表 ----
  if (p === '/api/v1/conversations' && req.method === 'GET') {
    return json(res, 200, listConversations(config.idol.serverId));
  }

  // ---- 会话历史 ----
  const convMatch = p.match(/^\/api\/v1\/conversations\/([\w-]+)$/);
  if (convMatch && req.method === 'GET') {
    const c = getConversation(convMatch[1]);
    if (!c) return json(res, 404, { error: '会话不存在' });
    return json(res, 200, { conversation: c, messages: getChatMessages(c.id, 100) });
  }

  // ---- 会话记忆摘要 ----
  const sumMatch = p.match(/^\/api\/v1\/conversations\/([\w-]+)\/summarize$/);
  if (sumMatch && req.method === 'POST') {
    const c = getConversation(sumMatch[1]);
    if (!c) return json(res, 404, { error: '会话不存在' });
    try {
      const summary = await summarizeConversation(c.id, config.idol.name);
      return json(res, 200, { summary });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  // ---- 删除会话（连带消息与记忆摘要）----
  if (convMatch && req.method === 'DELETE') {
    const c = getConversation(convMatch[1]);
    if (!c) return json(res, 404, { error: '会话不存在' });
    deleteConversation(convMatch[1]);
    return json(res, 200, { ok: true });
  }

  // ---- 对话（SSE 流式）----
  if (p === '/api/v1/chat' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let input;
    try { input = JSON.parse(body); } catch { return json(res, 400, { error: '请求体不是合法 JSON' }); }

    const { message, conversationId } = input;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return json(res, 400, { error: '缺少 message' });
    }

    let conv = conversationId ? getConversation(conversationId) : null;
    if (conversationId && !conv) return json(res, 404, { error: '会话不存在' });
    const isNew = !conv;
    if (!conv) conv = createConversation(config.idol.serverId);

    const userMsg = message.trim().slice(0, 500);

    // 检索历史：按类型分流
    //  - TEXT（她主动发的动态）→ selfMemories：作为"你记得的事"注入
    //  - REPLY（她回粉丝的）→ examples：作为风格示例
    let examples = [];
    let selfMemories = [];
    try {
      loadMessages();
      const vecReady = loadVectors();
      let qVec = null;
      if (vecReady) {
        try { qVec = await embedText(userMsg); } catch { qVec = null; }
      }
      const hits = search(qVec, userMsg, 8);
      for (const h of hits) {
        if (h.msg.type === 'REPLY' && h.msg.fanText) {
          examples.push({ fanText: h.msg.fanText, text: h.msg.text, score: h.score });
        } else if (h.msg.type === 'TEXT' && h.msg.text) {
          selfMemories.push({ text: h.msg.text, msgTime: h.msg.msgTime, score: h.score });
        }
      }
    } catch (e) {
      console.warn('[chat] 检索失败，降级为无示例:', e.message);
    }

    // 跨会话记忆：仅新会话注入旧记忆
    let memories = [];
    if (isNew) {
      memories = recentMemories(5).map(m => ({ summary: m.summary }));
    }

    const history = getChatMessages(conv.id, 20).map(m => ({ role: m.role, content: m.content }));
    const system = buildSystemPrompt({ examples, memories, selfMemories, idolName: config.idol.name });
    const messages = buildMessages({ system, history, userMessage: userMsg });

    // 保存用户消息
    addChatMessage(conv.id, 'user', userMsg);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    sendSSE(res, 'meta', { conversationId: conv.id, isNew, examplesCount: examples.length, selfMemCount: selfMemories.length, vectorUsed: !!loadVectors() });

    let full = '';
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      await chatStream({
        messages,
        temperature: 0.85,
        maxTokens: 600,
        signal: controller.signal,
        onDelta: (text) => {
          full += text;
          sendSSE(res, 'delta', { text });
        },
      });
    } catch (e) {
      console.error('[chat] 生成失败:', e.message);
      sendSSE(res, 'error', { message: e.message });
      sendSSE(res, 'done', { full, error: e.message });
      return res.end();
    }
    // 保存回复
    if (full.trim()) addChatMessage(conv.id, 'assistant', full.trim());
    sendSSE(res, 'done', { full, chars: full.length });
    return res.end();
  }

  // ---- 静态页面（阶段 B 网页，最后兜底前）----
  if (req.method === 'GET' && (p === '/' || MIME[extname(p).toLowerCase()] || p.startsWith('/public/'))) {
    if (await serveStatic(res, p)) return;
  }

  return json(res, 404, { error: 'Not Found' });
}

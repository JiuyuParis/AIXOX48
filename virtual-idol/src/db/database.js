// virtual-idol 对话数据库（SQLite）
// 表：conversations（会话）/ chat_messages（对话消息）/ conversation_memory（会话长期记忆）
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, '..', '..', 'data', 'virtual_idol.db');
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    member_server_id INTEGER NOT NULL,     -- 成员房间（预留多成员）
    title TEXT DEFAULT '新会话',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,                    -- user / assistant
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_conv ON chat_messages(conversation_id, id);

  CREATE TABLE IF NOT EXISTS conversation_memory (
    conversation_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    token_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

export function createConversation(memberServerId) {
  const id = randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO conversations (id, member_server_id, title, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(id, memberServerId, '新会话', now, now);
  return getConversation(id);
}

export function getConversation(id) {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) || null;
}

export function listConversations(memberServerId, limit = 50) {
  return db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS msg_count,
      (CASE WHEN cm.summary IS NOT NULL AND cm.summary != '' THEN 1 ELSE 0 END) AS has_memory
    FROM conversations c
    LEFT JOIN conversation_memory cm ON cm.conversation_id = c.id
    WHERE c.member_server_id = ? ORDER BY c.updated_at DESC LIMIT ?
  `).all(memberServerId, limit);
}

export function updateConversationTitle(id, title) {
  db.prepare('UPDATE conversations SET title=?, updated_at=? WHERE id=?').run(title, Date.now(), id);
}

export function deleteConversation(id) {
  db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(id);
  db.prepare('DELETE FROM conversation_memory WHERE conversation_id = ?').run(id);
  const r = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  return Number(r.changes) > 0;
}

export function touchConversation(id) {
  db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(Date.now(), id);
}

export function addChatMessage(conversationId, role, content) {
  const now = Date.now();
  const r = db.prepare('INSERT INTO chat_messages (conversation_id, role, content, created_at) VALUES (?,?,?,?)')
    .run(conversationId, role, content, now);
  // 首条用户消息自动成为会话标题（网页会话列表友好）
  if (role === 'user' && content && content.trim()) {
    const conv = getConversation(conversationId);
    if (conv && conv.title === '新会话') {
      updateConversationTitle(conversationId, content.trim().slice(0, 20));
    }
  }
  touchConversation(conversationId);
  return { id: Number(r.lastInsertRowid), role, content, createdAt: now };
}

export function getChatMessages(conversationId, limit = 50) {
  return db.prepare(`
    SELECT role, content, created_at FROM chat_messages
    WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
  `).all(conversationId, limit).reverse();
}

// 会话长期记忆（跨会话摘要）
export function saveConversationMemory(conversationId, summary) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO conversation_memory (conversation_id, summary, token_count, created_at, updated_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(conversation_id) DO UPDATE SET summary=excluded.summary, token_count=excluded.token_count, updated_at=excluded.updated_at
  `).run(conversationId, summary, summary.length, now, now);
}

export function getConversationMemory(conversationId) {
  const r = db.prepare('SELECT summary FROM conversation_memory WHERE conversation_id = ?').get(conversationId);
  return r ? r.summary : null;
}

export function getAllMemorySummaries(limit = 20) {
  return db.prepare('SELECT conversation_id, summary, updated_at FROM conversation_memory ORDER BY updated_at DESC LIMIT ?').all(limit);
}

export { db };

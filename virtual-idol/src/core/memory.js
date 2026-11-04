// 跨会话记忆：会话摘要生成 + 注入
import { chatStream } from './chat.js';
import { getChatMessages, saveConversationMemory, getAllMemorySummaries, getConversationMemory } from '../db/database.js';

/**
 * 压缩一个会话为记忆摘要（供后续会话引用）
 * @returns {Promise<string>} summary
 */
export async function summarizeConversation(conversationId, idolName = '李婷') {
  const msgs = getChatMessages(conversationId, 40);
  if (!msgs.length) return '';
  const transcript = msgs.map(m => `${m.role === 'user' ? '粉丝' : idolName}：${m.content}`).join('\n');
  const summary = await chatStream({
    messages: [
      { role: 'system', content: '你是记忆压缩助手。把一段粉丝与偶像的对话压缩成不超过 100 字的第三人称摘要，只保留：粉丝身份线索（怎么称呼、关系）、聊过的重要话题、偶像答应过/提到过的事。不要遗漏承诺和约定。' },
      { role: 'user', content: transcript },
    ],
    temperature: 0.3,
    maxTokens: 200,
  });
  const clean = summary.trim();
  if (clean) saveConversationMemory(conversationId, clean);
  return clean;
}

/**
 * 取最近 N 个会话的记忆摘要（用于新会话注入）
 */
export function recentMemories(limit = 5) {
  return getAllMemorySummaries(limit);
}

export { getConversationMemory };

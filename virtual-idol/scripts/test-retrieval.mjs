// 验证：用户问"小学同学有结婚的嘛"，向量检索能命中吗
import { embedText } from '../src/core/chat.js';
import { loadMessages, loadVectors, vectorSearch } from '../src/core/retriever.js';

loadMessages();
const ready = loadVectors();
console.log('向量库就绪:', ready);

const q = '你的小学同学有结婚的嘛？小学同学结婚了吗';
const v = await embedText(q);
const hits = vectorSearch(v, 10);
console.log('\n=== top10 向量检索 ===');
for (const h of hits) {
  console.log(`[${h.score}] ${h.msg.type}: ${h.msg.text.slice(0, 80)}${h.msg.fanText ? '  (粉丝问:' + h.msg.fanText + ')' : ''}`);
}

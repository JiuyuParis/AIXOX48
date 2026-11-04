// 离线管线 ①：从 scraper SQLite 提取李婷本人文本消息 → data/liting_texts.jsonl
// 输出字段：msgId, msgTime(毫秒), type, text(李婷说的话), fanText(粉丝原话, REPLY/GIFTREPLY 有), fanName
import { DatabaseSync } from 'node:sqlite';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outFile = join(__dirname, '..', 'data', 'liting_texts.jsonl');

const db = new DatabaseSync(config.paths.scraperDb, { readOnly: true });
const ownerId = config.idol.serverOwner;

// 解析 bodys 提取文本
function parseBody(type, bodysRaw) {
  const b = typeof bodysRaw === 'string' ? bodysRaw : String(bodysRaw || '');
  if (type === 'TEXT') return { text: b, fanText: null, fanName: null };
  let obj = null;
  try { obj = JSON.parse(b); } catch { return { text: b, fanText: null, fanName: null }; }
  if (type === 'REPLY' && obj.replyInfo) {
    return { text: obj.replyInfo.text || '', fanText: obj.replyInfo.replyText || '', fanName: obj.replyInfo.replyName || '' };
  }
  if (type === 'GIFTREPLY' && obj.giftReplyInfo) {
    return { text: obj.giftReplyInfo.text || '', fanText: obj.giftReplyInfo.replyText || '', fanName: obj.giftReplyInfo.replyName || '' };
  }
  // 兜底
  return { text: (obj.text || obj.body || ''), fanText: null, fanName: null };
}

const rows = db.prepare(`
  SELECT m.msg_id_server AS msgId, m.msg_type AS type, m.bodys, m.ext_info, m.msg_time AS msgTime
  FROM messages m
  WHERE m.msg_type IN ('TEXT','REPLY','GIFTREPLY')
  ORDER BY m.msg_time ASC
`).all();

mkdirSync(dirname(outFile), { recursive: true });
const out = createWriteStream(outFile, { encoding: 'utf8' });

let selfCount = 0, textCount = 0, chars = 0, replyPairs = 0;
for (const r of rows) {
  let isSelf = false;
  try {
    const ei = JSON.parse(r.ext_info || '{}');
    isSelf = String(ei.user?.userId) === String(ownerId);
  } catch { isSelf = false; }
  if (!isSelf) continue;
  selfCount++;
  const { text, fanText, fanName } = parseBody(r.type, r.bodys);
  if (!text || !text.trim()) continue;
  const rec = {
    msgId: r.msgId, msgTime: r.msgTime, type: r.type,
    text: text.trim(), fanText: fanText?.trim() || null, fanName: fanName?.trim() || null,
  };
  out.write(JSON.stringify(rec) + '\n');
  textCount++;
  chars += text.trim().length;
  if (fanText) replyPairs++;
}
out.end();
await new Promise(res => out.on('close', res));
db.close();

console.log('本人消息总数:', selfCount);
console.log('含文本消息数:', textCount, '总字符:', chars);
console.log('带粉丝原话的对话对(REPLY/GIFTREPLY):', replyPairs);
console.log('输出:', outFile);

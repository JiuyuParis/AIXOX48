// 精选代表性对话对：覆盖各种真实回复类型，写入 persona.json 的 examples 字段
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const msgs = readFileSync(join(dataDir, 'liting_texts.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map(l => JSON.parse(l));

const replyPairs = msgs.filter(m => m.type === 'REPLY' && m.fanText);

// 类型筛选
const pick = {
  // 单字/极短怼粉
  ultraShort: replyPairs.filter(m => m.text.length <= 3 && m.text !== m.fanText).slice(0, 6),
  // 纯表情回复（emoji 占比高）
  pureEmoji: replyPairs.filter(m => /[👍🏻🙏🏻🫠😃🤔🥰😡🤓😗❤️]/u.test(m.text) && m.text.length <= 4).slice(0, 4),
  // 跳脱/无厘头（回复明显不按常理）
  absurd: replyPairs.filter(m => m.text.length >= 3 && m.text.length <= 16 && !m.text.includes('谢谢')).slice(0, 10),
  // 关心/安抚粉丝
  caring: replyPairs.filter(m => /(别|没事|加油|抱抱|好好|注意|心疼|乖乖|早点|睡觉)/.test(m.text) && m.text.length <= 16).slice(0, 5),
};

for (const [k, arr] of Object.entries(pick)) {
  console.log(`\n===== ${k} (${arr.length}) =====`);
  for (const m of arr) console.log(`粉丝[${m.fanName||'?'}]说: ${m.fanText}  ||  李婷回: ${m.text}`);
}

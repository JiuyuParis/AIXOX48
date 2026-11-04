// 离线管线 ③：准备样本
//  - data/persona_samples.jsonl  人格提炼输入（抽样 TEXT + REPLY 对话对，时间均匀）
//  - data/eval_pairs.jsonl       像不像评测留出集（REPLY 对话对，不进入任何 prompt）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const msgs = readFileSync(join(dataDir, 'liting_texts.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map(l => JSON.parse(l));

// 按月分桶，均匀抽样
const byMonth = {};
for (const m of msgs) {
  const mk = new Date(m.msgTime).toISOString().slice(0, 7);
  (byMonth[mk] = byMonth[mk] || []).push(m);
}
const months = Object.keys(byMonth).sort();
console.log('月份分布:', months.map(k => `${k}:${byMonth[k].length}`).join(' '));

// 每天 T 条均匀抽样函数
function sampleEven(arr, n) {
  const step = Math.max(1, Math.floor(arr.length / n));
  const out = [];
  for (let i = 0; i < arr.length && out.length < n; i += step) out.push(arr[i]);
  return out;
}

// 1) persona 样本：TEXT 每桶抽 ~12 条，REPLY 每桶抽 ~12 对（质量优先：回复有信息量的）
const textMsgs = msgs.filter(m => m.type === 'TEXT');
const replyMsgs = msgs.filter(m => m.type === 'REPLY' && m.fanText && m.text.length >= 2);

const personaText = [];
const personaReply = [];
for (const mk of months) {
  personaText.push(...sampleEven(byMonth[mk].filter(m => m.type === 'TEXT'), 12));
  personaReply.push(...sampleEven(byMonth[mk].filter(m => m.type === 'REPLY' && m.fanText && m.text.length >= 2), 12));
}

// 2) 评测留出集：REPLY 对话对随机 120 条（加固定种子，可复现）
let seed = 20260916;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const evalPool = [...new Map(replyMsgs.map(m => [m.msgId, m])).values()]; // 按 msgId 去重
const evalPairs = [];
const used = new Set();
while (evalPairs.length < 120 && used.size < evalPool.length) {
  const i = Math.floor(rnd() * evalPool.length);
  if (used.has(i)) continue;
  used.add(i);
  evalPairs.push({ fanText: evalPool[i].fanText, realReply: evalPool[i].text, msgTime: evalPool[i].msgTime });
}

writeFileSync(join(dataDir, 'persona_samples.jsonl'), personaText.concat(personaReply).map(m => JSON.stringify({
  type: m.type, time: new Date(m.msgTime).toISOString(), text: m.text, fanText: m.fanText || null,
})).join('\n'), 'utf8');
writeFileSync(join(dataDir, 'eval_pairs.jsonl'), evalPairs.map(m => JSON.stringify(m)).join('\n'), 'utf8');

console.log('persona_samples:', personaText.length + personaReply.length, '(TEXT', personaText.length, '+ REPLY', personaReply.length, ')');
console.log('eval_pairs:', evalPairs.length);

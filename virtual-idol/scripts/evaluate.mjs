// 离线管线 ⑥：像不像评测
// 输入：eval_pairs.jsonl（留出集：120 对 粉丝原话→李婷真实回复）
// 步骤：对每条粉丝原话，用当前人格+检索体系生成模型回复 → 交裁判模型打分 → data/eval_report.json
// 用法：node scripts/evaluate.mjs [条数，默认30]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatStream, embedText } from '../src/core/chat.js';
import { loadPersona, buildSystemPrompt, buildMessages } from '../src/core/prompt.js';
import { search, loadMessages, loadVectors } from '../src/core/retriever.js';
import { config } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const N = Number(process.argv[2] || 30);

const pairs = readFileSync(join(dataDir, 'eval_pairs.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(0, N);
console.log(`评测 ${pairs.length} 条…`);

loadMessages();
const vecReady = loadVectors();
const persona = loadPersona();
const results = [];

for (let i = 0; i < pairs.length; i++) {
  const { fanText, realReply } = pairs[i];
  let qVec = null;
  if (vecReady) { try { qVec = await embedText(fanText); } catch { qVec = null; } }
  const hits = search(qVec, fanText, 4);
  const examples = hits
    .filter(h => h.msg.fanText && h.msg.fanText !== fanText) // 避免泄题
    .map(h => ({ fanText: h.msg.fanText, text: h.msg.text }));
  const system = buildSystemPrompt({ persona, examples });
  const messages = buildMessages({ system, userMessage: fanText });
  let modelReply = '';
  try {
    modelReply = (await chatStream({ messages, temperature: 0.9, maxTokens: 300 })).trim();
  } catch (e) {
    console.error(`[${i}] 生成失败:`, e.message);
    modelReply = '[生成失败]';
  }
  results.push({ fanText, realReply, modelReply });
  process.stdout.write(`\r${i + 1}/${pairs.length}`);
}

// 裁判打分：分批把对比交给裁判模型
console.log('\n裁判打分中…');
const scored = [];
const judgeBatchSize = 10;
for (let i = 0; i < results.length; i += judgeBatchSize) {
  const batch = results.slice(i, i + judgeBatchSize);
  const listText = batch.map((r, j) => `${i + j + 1}. 粉丝说「${r.fanText}」\n   李婷真实回复：「${r.realReply}」\n   模型模仿回复：「${r.modelReply}」`).join('\n\n');
  const judge = await chatStream({
    messages: [
      { role: 'system', content: `你是严格的口味评审。比较"李婷真实回复"和"AI模仿回复"，判断模仿的像不像（语气、长度、风格、用词习惯）。逐条输出 JSON 数组：[{"no":序号,"score":1到10整数,"comment":"一句话点评"}]. 只输出 JSON。` },
      { role: 'user', content: listText },
    ],
    temperature: 0.3,
    maxTokens: 1200,
  });
  try {
    const cleaned = judge.replace(/```json|```/g, '').trim();
    const arr = JSON.parse(cleaned);
    for (const s of arr) {
      const r = results[s.no - 1];
      if (r) scored.push({ ...r, score: s.score, judgeComment: s.comment });
    }
  } catch {
    console.warn('裁判输出解析失败，跳过本批', judge.slice(0, 200));
  }
}

const avg = scored.length ? +(scored.reduce((s, r) => s + r.score, 0) / scored.length).toFixed(2) : 0;
const report = {
  model: config.ark.chatModel,
  personaVersion: persona.version,
  vectorUsed: vecReady,
  date: new Date().toISOString(),
  count: scored.length,
  avgScore: avg,
  items: scored,
};
writeFileSync(join(dataDir, 'eval_report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`\n评测完成: ${scored.length} 条, 平均分 ${avg}/10`);
console.log('报告: data/eval_report.json');

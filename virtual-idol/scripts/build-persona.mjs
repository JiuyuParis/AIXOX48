// 离线管线 ④：人格提炼 → data/persona.json
// 输入：persona_samples.jsonl（抽样真实消息）+ liting_stats.json（语言特征统计）
// 输出：persona.json（人格设定，供 prompt 组装；可人工修改后 /reload）
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatStream } from '../src/core/chat.js';
import { config } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');

const stats = JSON.parse(readFileSync(join(dataDir, 'liting_stats.json'), 'utf8'));
const samples = readFileSync(join(dataDir, 'persona_samples.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map(l => JSON.parse(l));

const statText = `
【语言特征统计（真实数据）】
- 消息总数 ${stats.total}，平均长度 ${stats.lenAvg} 字，中位数 ${stats.lenMedian} 字，最长 ${stats.lenMax} 字
- 长度分布: ${JSON.stringify(stats.lenBuckets)}
- 类型: TEXT ${stats.byType.TEXT} / REPLY(回粉丝) ${stats.byType.REPLY} / GIFTREPLY(谢礼物) ${stats.byType.GIFTREPLY}
- 句式结尾: 感叹 ${stats.exclaimPct}% / 疑问 ${stats.questionPct}% / 省略号 ${stats.ellipsisPct}% / 波浪号~ ${stats.tildePct}%
- 高频词 top20: ${stats.topWords.slice(0, 20).map(x => x.w).join(' ')}
- 语气词 top15: ${stats.topParticles.slice(0, 15).map(x => `${x.w}(${x.c})`).join(' ')}
- Emoji top15: ${stats.topEmoji.slice(0, 15).map(x => `${x.w}(${x.c})`).join(' ')}
- 常见开头: ${stats.topStarts.slice(0, 8).map(x => x.w).join(' ')}
- 常见结尾: ${stats.topEnds.slice(0, 8).map(x => x.w).join(' ')}
- 回粉丝: 平均回复 ${stats.replyLenRatio.avgReplyLen} 字，短回复(≤12字)占比 ${stats.replyLenRatio.shortReplyPct}%
- 最活跃时段: ${stats.hourTop.map(x => x.h + '时').join(' ')}`;

const sampleText = samples.map(s => {
  if (s.type === 'REPLY' && s.fanText) return `[粉丝说] ${s.fanText}\n[李婷回] ${s.text}`;
  return `[李婷说] ${s.text}`;
}).join('\n');

const userPrompt = `以下是 ${config.idol.name}（SNH48 Team SII 成员，口袋48房间「听这个听听呀」，粉丝昵称：听听/婷/姐）近一年的真实房间消息抽样与语言统计。

${statText}

【真实消息抽样（${samples.length} 条）】
${sampleText}

请基于以上真实材料，提炼一份用于让大模型扮演她的人格设定。要求：
1. 只写从材料中能看出来的事实，不要编造她的经历、喜好、关系。
2. lifeFacts 列她真实做过的事/生活细节（如养猫、公演、排练、点外卖等，从消息里能推断的），每条一句话。
3. speechStyle 给 8~12 条具体可执行的说话风格规则（语气、句式、长度、用词习惯）。
4. catchphrases 列出她反复用的口头禅/高频词（如 噜噜、翻牌 等）。
5. personality 用 3~5 句话概括性格（从语气推断：懒散/直接/爱怼人/撒娇等，必须有依据）。
6. 严格输出 JSON，格式：
{
  "identity": "一句话身份介绍",
  "personality": "性格描述",
  "speechStyle": ["规则1", ...],
  "catchphrases": ["口头禅1", ...],
  "emojiHabits": "表情符号使用习惯描述",
  "lifeFacts": ["事实1", ...],
  "topics": ["常聊话题1", ...]
}`;

const reply = await chatStream({
  messages: [
    { role: 'system', content: '你是人格分析专家，输出严格 JSON，不要输出任何 JSON 之外的内容。' },
    { role: 'user', content: userPrompt },
  ],
  temperature: 0.4,
  maxTokens: 2000,
});

// 提取 JSON（模型可能包 ```json）
let persona;
try {
  const cleaned = reply.replace(/```json|```/g, '').trim();
  persona = JSON.parse(cleaned);
} catch {
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('无法解析模型输出为 JSON: ' + reply.slice(0, 300));
  persona = JSON.parse(m[0]);
}

persona.version = new Date().toISOString().slice(0, 10);
persona._meta = { samples: samples.length, builtFrom: 'liting_texts.jsonl + liting_stats.json' };

writeFileSync(join(dataDir, 'persona.json'), JSON.stringify(persona, null, 2), 'utf8');
console.log('persona.json 已生成:');
console.log(JSON.stringify(persona, null, 2));

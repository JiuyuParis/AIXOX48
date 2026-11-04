// System Prompt 组装：人格设定 + 真实历史示例(few-shot) + 跨会话记忆 + 会话内历史
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', '..', 'data');

let personaCache = null;
/** 加载 persona.json（人格设定，离线构建产物） */
export function loadPersona() {
  if (personaCache) return personaCache;
  const f = join(dataDir, 'persona.json');
  if (!existsSync(f)) {
    personaCache = { identity: '', personality: '', speechStyle: [], catchphrases: [], emojiHabits: '', lifeFacts: [], topics: [] };
    return personaCache;
  }
  personaCache = JSON.parse(readFileSync(f, 'utf8'));
  return personaCache;
}

export function reloadPersona() { personaCache = null; return loadPersona(); }

/**
 * 构建 system prompt
 * @param {object} opts { persona, examples, memories, selfMemories, idolName }
 *  examples: [{fanText, text}] 真实历史对话对（检索到的，REPLY 类，风格示例）
 *  memories: [{summary}] 跨会话记忆摘要（这个粉丝）
 *  selfMemories: [{text, msgTime}] 她自己历史动态（检索到的 TEXT 类，作为"你记得的事"）
 */
export function buildSystemPrompt({ persona = loadPersona(), examples = [], memories = [], selfMemories = [], idolName = config.idol.name } = {}) {
  const p = persona;
  const parts = [];

  parts.push(`你是${idolName}本人，SNH48 Team SII 成员，正在自己的口袋48房间「听这个听听呀」里和粉丝聊天。粉丝是你的粉丝/朋友，用平时你在房间里的方式回应他们。你不是 AI 助手，不要暴露自己是 AI，不要用"作为AI"之类的表述。`);

  if (p.identity) parts.push(`【身份】${p.identity}`);
  if (p.personality) parts.push(`【性格】${p.personality}`);
  if (p.speechStyle?.length) parts.push(`【说话风格】\n${p.speechStyle.map(s => '- ' + s).join('\n')}`);
  if (p.catchphrases?.length) parts.push(`【口头禅/习惯】\n${p.catchphrases.map(s => '- ' + s).join('\n')}`);
  if (p.emojiHabits) parts.push(`【表情符号习惯】${p.emojiHabits}`);
  if (p.lifeFacts?.length) parts.push(`【你做过的事/生活近况（按历史消息整理）】\n${p.lifeFacts.map(s => '- ' + s).join('\n')}`);

  if (memories.length) {
    parts.push(`【你记得这个粉丝】这位粉丝以前和你聊过（回答时可自然提及，不要机械复述）：\n${memories.map(m => '- ' + (m.summary || m)).join('\n')}`);
  }

  // 她自己的历史动态（记忆）：明确告诉模型这是"你以前说过的话"
  const selfMems = selfMemories.slice(0, 8).map(m => `- ${m.text}`);
  if (selfMems.length) {
    parts.push(`【你以前在房间里说过的话（这是你自己的经历和记忆，回答相关问题时自然引用，不要假装不知道）】\n${selfMems.join('\n')}`);
  }

  // 常驻风格示例（精选）+ 检索到的对话对
  const fixedExamples = (p.examples || []).map(e => ({ fanText: e.fanText, text: e.text }));
  const allExamples = fixedExamples.concat(examples.filter(e => e.fanText)).slice(0, 12);
  if (allExamples.length) {
    const ex = allExamples.map((e, i) => `示例${i + 1}：粉丝说「${e.fanText}」→ 你当时真实回复「${e.text}」`).join('\n');
    parts.push(`【你平时怎么回复粉丝（模仿这个语气，这是你本人的原话）】\n${ex}`);
  }

  parts.push(`【聊天规则】
- 像平时一样说话：短句、口语化、自然、亲切，像和朋友聊天。别写长篇大论，别用书面语、别用"首先/其次/总之"这种结构。
- 对粉丝要有温度：会叫粉丝"宝宝"、会主动接话、会撒娇、会分享日常，不是冷冰冰的。可以调侃但要有亲近感。
- 不要句句加 emoji：大多数回复不带 emoji，最多 1 个；有时纯文字，有时像她一样只回一个表情（如 👍🏻）。
- 回复要短而直接：她常常很短（"不知道""并没有""下次吃"），但短不等于冷漠——可以带着语气和态度。
- 先看上面【你以前说过的话】里有没有相关的：如果粉丝问的事你以前提到过，就自然地把那段经历/事实用进回答里，不要说"不知道""没联系"；只有真的完全没提到过的事才说不知道。
- 不确定/不知道时用"不知道""不清楚""应该吧""忘了"这类模糊回应；粉丝猜对了她会认同甚至惊讶（"！！！还真是""对"）。可以顺着粉丝的话接。
- 永远以${idolName}第一人称回复。
- 只输出${idolName}的回复内容本身。禁止输出任何思考过程、规则说明、创作思路、剧本提示、解释或"回复：""她说："之类的前缀。输出里不要出现"接梗""回应""粉丝""规则"等字眼。`);

  return parts.join('\n\n');
}

/**
 * 组装发给模型的 messages
 * @param {object} opts { system, history, userMessage }
 * history: [{role:'user'|'assistant', content}] 当前会话最近消息
 */
export function buildMessages({ system, history = [], userMessage }) {
  const msgs = [{ role: 'system', content: system }];
  for (const h of history) {
    if (h.role !== 'user' && h.role !== 'assistant') continue;
    msgs.push({ role: h.role, content: String(h.content).slice(0, 1000) });
  }
  msgs.push({ role: 'user', content: userMessage });
  return msgs;
}

// 离线管线 ②：李婷语言特征统计 → data/liting_stats.json + 控制台报告
// 纯确定性统计，不调模型。为 persona.json 的人格提炼提供事实基础。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const msgs = readFileSync(join(dataDir, 'liting_texts.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map(l => JSON.parse(l));

// 停用词（简单）
const STOP = new Set(['的','了','我','你','他','她','它','我们','你们','他们','她们','是','在','有','和','就','都','也','还','又','很','好','不','没','这','那','什么','怎么','为什么','一下','一个','真的','觉得','可以','知道','今天','明天','昨天','现在','然后','但是','因为','所以','如果','还是','就是','自己','大家','有点','一点','一下','起来','过来','下去','你们','咱们','说','想','要','去','来','看','吃','买','到','个','只','张','条','时候','东西','事情','没有','不会','不能','不要','不是','对吧','吗','吧','啊','呀','啦','哦','哈','呢','嘛','诶','嗯','哦哦','哈哈','嘻嘻','嘿嘿','呵呵','哈哈哈哈','哈哈哈','～','~','！','？','。','，','、','的','了','么','什么','怎么','咋','啥','谁','哪','这','那','你','我','他','她']);
const PUNCT = new Set(['。','，','！','？','、','；','：','…','～','~','.','!','?',',','"','\'','（','）','(',')','[',']','{','}',' ','\n','\t','/','-','—']);

function isEmoji(ch) {
  const cp = ch.codePointAt(0);
  return (cp >= 0x1F000 && cp <= 0x1FAFF) || (cp >= 0x2600 && cp <= 0x27BF)
    || (cp >= 0xFE00 && cp <= 0xFE0F) || cp === 0xFE0F || cp === 0x20E3
    || (cp >= 0x2B00 && cp <= 0x2BFF);
}

const stats = {
  total: msgs.length,
  totalChars: msgs.reduce((s, m) => s + m.text.length, 0),
  byType: {},
  lenAvg: 0, lenMedian: 0, lenMax: 0,
  lenBuckets: { '<=5':0, '6-15':0, '16-30':0, '31-60':0, '>60':0 },
  wordFreq: {},      // 高频词
  particleFreq: {},  // 语气词/口头禅
  emojiFreq: {},
  exclaimPct: 0, questionPct: 0, ellipsisPct: 0, tildePct: 0,
  startsWith: {}, endsWith: {},
  hourFreq: {},
  selfRef: {},       // 自称/被称呼
  replyLenRatio: { pairs: 0, shortReply: 0, avgFanLen: 0, avgReplyLen: 0 },
  topLen50: [],
};

const PARTICLES = ['呢','吧','啊','呀','啦','哦','哈','嘛','诶','嗯','耶','嘻嘻','哈哈','嘿嘿','嘿嘿嘿','哈哈哈哈哈','哈哈哈','么','嘞','咯','唉','欸','呕','喔','噗'];
const SELF_REF = ['我','姐','本小姐','听听','婷','婷婷','宝宝','本人'];

const lens = [];
for (const m of msgs) {
  const t = m.text;
  lens.push(t.length);
  stats.byType[m.type] = (stats.byType[m.type] || 0) + 1;
  const h = new Date(m.msgTime).getHours();
  stats.hourFreq[h] = (stats.hourFreq[h] || 0) + 1;

  if (t.length <= 5) stats.lenBuckets['<=5']++;
  else if (t.length <= 15) stats.lenBuckets['6-15']++;
  else if (t.length <= 30) stats.lenBuckets['16-30']++;
  else if (t.length <= 60) stats.lenBuckets['31-60']++;
  else stats.lenBuckets['>60']++;

  if (t.endsWith('！') || t.endsWith('!')) stats.exclaimPct++;
  if (t.endsWith('？') || t.endsWith('?')) stats.questionPct++;
  if (t.includes('…') || t.includes('...')) stats.ellipsisPct++;
  if (t.includes('～') || t.includes('~')) stats.tildePct++;

  // 风格统计仅针对日常说话（TEXT/REPLY），剔除 GIFTREPLY 模板消息的污染
  const isDaily = m.type !== 'GIFTREPLY';
  if (!isDaily) continue;
  // 分词（按标点/空白切，中文按字符聚 2-gram 与单字）
  const cleaned = t.replace(/[\u3000-\u303F\uFF00-\uFFEF\u2000-\u206F\s\d]+/g, ' ');
  const tokens = cleaned.split(' ').filter(x => x && x.length > 0);
  for (const tok of tokens) {
    if (tok.length >= 2 && !STOP.has(tok)) stats.wordFreq[tok] = (stats.wordFreq[tok] || 0) + 1;
  }
  // 2-gram 高频词（中文；过滤含 ASCII 字母/数字的片段，避免英文子串）
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    const bad = PUNCT.has(g[0]) || PUNCT.has(g[1]) || isEmoji(g[0]) || isEmoji(g[1]) || /[A-Za-z0-9]/.test(g) || STOP.has(g);
    if (!bad) stats.wordFreq[g] = (stats.wordFreq[g] || 0) + 1;
  }

  // 语气词
  for (const p of PARTICLES) {
    if (t.includes(p)) stats.particleFreq[p] = (stats.particleFreq[p] || 0) + 1;
  }
  // emoji
  for (const ch of t) {
    if (isEmoji(ch)) stats.emojiFreq[ch] = (stats.emojiFreq[ch] || 0) + 1;
  }
  // 开头/结尾
  const head = t.replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 4);
  const tail = t.replace(/[^\p{L}\p{N}]+$/u, '').slice(-4);
  if (head) stats.startsWith[head] = (stats.startsWith[head] || 0) + 1;
  if (tail) stats.endsWith[tail] = (stats.endsWith[tail] || 0) + 1;
  // 自称
  for (const s of SELF_REF) if (t.includes(s)) stats.selfRef[s] = (stats.selfRef[s] || 0) + 1;

  // 对话对
  if (m.fanText) {
    stats.replyLenRatio.pairs++;
    stats.replyLenRatio.avgFanLen += m.fanText.length;
    stats.replyLenRatio.avgReplyLen += m.text.length;
    if (m.text.length <= 12) stats.replyLenRatio.shortReply++;
  }
}

lens.sort((a, b) => a - b);
stats.lenAvg = +(msgs.reduce((s, m) => s + m.text.length, 0) / msgs.length).toFixed(1);
stats.lenMedian = lens[Math.floor(lens.length / 2)];
stats.lenMax = lens[lens.length - 1];
stats.exclaimPct = +(stats.exclaimPct / msgs.length * 100).toFixed(1);
stats.questionPct = +(stats.questionPct / msgs.length * 100).toFixed(1);
stats.ellipsisPct = +(stats.ellipsisPct / msgs.length * 100).toFixed(1);
stats.tildePct = +(stats.tildePct / msgs.length * 100).toFixed(1);
const rl = stats.replyLenRatio;
rl.avgFanLen = +(rl.avgFanLen / rl.pairs).toFixed(1);
rl.avgReplyLen = +(rl.avgReplyLen / rl.pairs).toFixed(1);
rl.shortReplyPct = +(rl.shortReply / rl.pairs * 100).toFixed(1);

const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
stats.topWords = top(stats.wordFreq, 40).map(([k, v]) => ({ w: k, c: v }));
stats.topParticles = top(stats.particleFreq, 20).map(([k, v]) => ({ w: k, c: v }));
stats.topEmoji = top(stats.emojiFreq, 20).map(([k, v]) => ({ w: k, c: v }));
stats.topStarts = top(stats.startsWith, 20).map(([k, v]) => ({ w: k, c: v }));
stats.topEnds = top(stats.endsWith, 20).map(([k, v]) => ({ w: k, c: v }));
stats.topSelfRef = top(stats.selfRef, 10).map(([k, v]) => ({ w: k, c: v }));
stats.hourTop = top(stats.hourFreq, 6).map(([k, v]) => ({ h: +k, c: v }));

writeFileSync(join(dataDir, 'liting_stats.json'), JSON.stringify(stats, null, 2), 'utf8');

// 打印报告
console.log('=== 李婷语言特征统计 ===');
console.log('消息总数:', stats.total, '| 总字符:', stats.totalChars, '| 平均长度:', stats.lenAvg, '| 中位数:', stats.lenMedian, '| 最长:', stats.lenMax);
console.log('长度分布:', JSON.stringify(stats.lenBuckets));
console.log('类型分布:', JSON.stringify(stats.byType));
console.log('句式: 感叹', stats.exclaimPct + '%', '| 疑问', stats.questionPct + '%', '| 省略号', stats.ellipsisPct + '%', '| 波浪号~', stats.tildePct + '%');
console.log('\n高频词 top20:', stats.topWords.slice(0, 20).map(x => x.w + '(' + x.c + ')').join(' '));
console.log('\n语气词 top15:', stats.topParticles.slice(0, 15).map(x => x.w + '(' + x.c + ')').join(' '));
console.log('\nEmoji top15:', stats.topEmoji.slice(0, 15).map(x => x.w + '(' + x.c + ')').join(' '));
console.log('\n常见开头 top10:', stats.topStarts.slice(0, 10).map(x => x.w + '(' + x.c + ')').join(' '));
console.log('\n常见结尾 top10:', stats.topEnds.slice(0, 10).map(x => x.w + '(' + x.c + ')').join(' '));
console.log('\n自称/称呼 top8:', stats.topSelfRef.map(x => x.w + '(' + x.c + ')').join(' '));
console.log('\n对话对统计: 共', rl.pairs, '| 粉丝问平均', rl.avgFanLen, '字 | 李婷答平均', rl.avgReplyLen, '字 | 短回复(<=12字)占比', rl.shortReplyPct + '%');
console.log('\n最活跃时段:', stats.hourTop.map(x => x.h + '时(' + x.c + ')').join(' '));
console.log('\n已输出: data/liting_stats.json');

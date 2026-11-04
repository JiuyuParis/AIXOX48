// 历史消息检索器（RAG 核心）
// 双通道：向量余弦（主力，语义相似）+ 关键词 LIKE（兜底，确定性）
// 数据源：data/liting_texts.jsonl（李婷本人消息）+ data/embeddings.bin/.meta.jsonl（向量，待模型开通后生成）
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', '..', 'data');

// ---- 历史消息内存加载（一次加载，常驻）----
let messages = null;
export function loadMessages() {
  if (messages) return messages;
  const f = join(dataDir, 'liting_texts.jsonl');
  if (!existsSync(f)) { messages = []; return messages; }
  messages = readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return messages;
}

// ---- 向量库（可选加载）----
let vectors = null;   // Float32Array
let vectorMeta = null;
let vectorDim = 0;

export function loadVectors() {
  if (vectors) return vectors !== null;
  const bin = join(dataDir, 'embeddings.bin');
  const meta = join(dataDir, 'embeddings.meta.jsonl');
  if (!existsSync(bin) || !existsSync(meta)) return false;
  const metaLines = readFileSync(meta, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const buf = readFileSync(bin);
  vectorDim = metaLines[0].dim;
  vectorMeta = metaLines;
  vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return true;
}

export function vectorReady() { return vectors !== null; }
export function vectorDimOf() { return vectorDim; }

// 余弦相似度（预归一化向量）
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // 输入均为归一化向量
}

// 向量语义检索 top-k，返回 {msg, score}
export function vectorSearch(queryVec, k = 6, filter = null) {
  if (!vectors || !vectorMeta) return [];
  const n = vectorMeta.length;
  const scored = [];
  for (let i = 0; i < n; i++) {
    const offset = i * vectorDim;
    const v = vectors.subarray(offset, offset + vectorDim);
    const s = cosine(queryVec, v);
    scored.push({ i, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const out = [];
  for (const { i, s } of scored) {
    if (out.length >= k) break;
    const meta = vectorMeta[i];
    const msg = messages[meta.msgIndex];
    if (!msg) continue;
    if (filter && !filter(msg)) continue;
    out.push({ msg, score: +s.toFixed(4) });
  }
  return out;
}

// 关键词检索：抽取查询中的中文词 → 消息文本 LIKE 匹配 → 按时间倒序
// 返回 top-k 最近的相关消息
export function keywordSearch(query, k = 6) {
  const msgs = loadMessages();
  if (!msgs.length) return [];
  // 提取 2~4 字中文词（去掉常见停用）
  const words = new Set();
  const cleaned = query.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ');
  for (const w of cleaned.split(/\s+/)) {
    if (!w) continue;
    if (/^[\u4e00-\u9fa5]{2,6}$/.test(w)) words.add(w);
  }
  // 单字不检索（噪音大）；无中文词则跳过关键词通道
  if (!words.size) return [];
  const results = [];
  for (const m of msgs) {
    if (m.type === 'GIFTREPLY') continue; // 模板致谢不参与关键词检索
    const text = m.text || '';
    let hit = 0;
    for (const w of words) if (text.includes(w)) hit++;
    if (hit > 0) results.push({ msg: m, hit, score: hit });
  }
  // 命中数优先，其次时间近
  results.sort((a, b) => b.hit - a.hit || b.msg.msgTime - a.msg.msgTime);
  return results.slice(0, k).map(r => ({ msg: r.msg, score: r.score }));
}

// 统一入口：向量优先，关键词兜底
export function search(queryVec, queryText, k = 6) {
  if (queryVec && vectors) {
    const r = vectorSearch(queryVec, k);
    if (r.length >= 2) return r;
  }
  return keywordSearch(queryText, k);
}

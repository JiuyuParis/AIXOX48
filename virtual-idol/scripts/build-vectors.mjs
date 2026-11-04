// 离线管线 ⑤：历史消息向量化 → data/embeddings.bin + embeddings.meta.jsonl
// 输入：liting_texts.jsonl（李婷本人消息）
// 输出：embeddings.bin（Float32 扁平）/ embeddings.meta.jsonl（每行 {msgIndex, dim, textLen}）
// 说明：只向量化日常说话（TEXT/REPLY，剔除 GIFTREPLY 模板），控制体积；可加 --all 全量
import { readFileSync, writeFileSync, createWriteStream, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedTexts } from '../src/core/chat.js';
import { config } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const all = process.argv.includes('--all');

const msgs = readFileSync(join(dataDir, 'liting_texts.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map((l, i) => ({ ...JSON.parse(l), _index: i }));

const targets = all ? msgs : msgs.filter(m => m.type !== 'GIFTREPLY');
console.log(`向量化目标: ${targets.length} 条（TEXT+REPLY，${all ? '全量' : '剔除礼物致谢模板'}）`);

// 构造文本：REPLY 带粉丝原话（更有语义）；前面拼上类型提示
const texts = targets.map(m => {
  const core = m.fanText ? `粉丝问：${m.fanText} 我回答：${m.text}` : m.text;
  return core;
});

const dims = new Set();
const meta = [];
const outPath = join(dataDir, 'embeddings.bin');
const metaPath = join(dataDir, 'embeddings.meta.jsonl');
mkdirSync(dataDir, { recursive: true });
const binStream = createWriteStream(outPath);

const CHUNK = 200;
for (let i = 0; i < texts.length; i += CHUNK) {
  const chunk = texts.slice(i, i + CHUNK);
  const vecs = await embedTexts(chunk, 8);
  for (let j = 0; j < vecs.length; j++) {
    const v = vecs[j];
    dims.add(v.length);
    // 归一化（余弦检索）
    let norm = 0;
    for (let k = 0; k < v.length; k++) norm += v[k] * v[k];
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < v.length; k++) v[k] /= norm;
    binStream.write(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    meta.push({ msgIndex: targets[i + j]._index, dim: v.length, len: chunk[j].length });
  }
  process.stdout.write(`\r已向量化 ${Math.min(i + CHUNK, texts.length)}/${texts.length}`);
}

await new Promise(res => binStream.end(res));
const dim = [...dims][0];
writeFileSync(metaPath, meta.map(m => JSON.stringify(m)).join('\n'), 'utf8');
console.log(`\n完成: ${meta.length} 条向量, dim=${dim}, 文件: ${outPath} (${(meta.length * dim * 4 / 1024 / 1024).toFixed(1)}MB) + meta`);
console.log('模型:', config.ark.embeddingModel);

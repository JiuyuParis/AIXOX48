// 火山方舟（OpenAI 兼容）客户端：对话 SSE + Embedding
import { config } from '../config.js';

function authHeaders() {
  return {
    'Authorization': `Bearer ${config.ark.apiKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * 流式对话：调方舟 chat/completions，逐 delta 回调
 * @param {object} opts { model, messages, temperature?, maxTokens?, onDelta(text), signal }
 */
export async function chatStream(opts) {
  const { model = config.ark.chatModel, messages, temperature = 0.8, maxTokens = 800, onDelta, signal } = opts;
  const resp = await fetch(`${config.ark.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    signal,
    body: JSON.stringify({
      model, messages, temperature, max_tokens: maxTokens, stream: true,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`方舟 API ${resp.status}: ${err.slice(0, 500)}`);
  }
  if (!resp.body) throw new Error('方舟 API 无响应流');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop(); // 保留不完整行
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          if (onDelta) onDelta(delta);
        }
      } catch { /* 忽略解析失败的行 */ }
    }
  }
  return full;
}

/**
 * 批量文本向量化（multimodal embeddings 接口，一次一条，内部并发）
 * @param {string[]} texts
 * @param {number} concurrency 并发数
 * @returns {Promise<Float32Array[]>} 与 texts 等长同序
 */
export async function embedTexts(texts, concurrency = 8) {
  const model = config.ark.embeddingModel;
  const results = new Array(texts.length);
  let idx = 0;
  const worker = async () => {
    while (idx < texts.length) {
      const i = idx++;
      const text = texts[i];
      const r = await fetch(`${config.ark.baseUrl}/embeddings/multimodal`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          model,
          input: [{ type: 'text', text: String(text).slice(0, 2000) }],
        }),
      });
      if (!r.ok) {
        const err = await r.text().catch(() => '');
        throw new Error(`Embedding ${r.status}: ${err.slice(0, 300)}`);
      }
      const j = await r.json();
      results[i] = new Float32Array(j.data.embedding);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
  return results;
}

/** 单条文本向量化 */
export async function embedText(text) {
  const [v] = await embedTexts([text], 1);
  return v;
}

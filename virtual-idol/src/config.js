// 配置加载：config.local.json（本地敏感配置） + 环境变量覆盖
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const localPath = join(__dirname, '..', 'config.local.json');

let local = {};
try {
  local = JSON.parse(readFileSync(localPath, 'utf8'));
} catch (e) {
  console.warn('[config] 未找到或无法读取 config.local.json，使用环境变量:', e.message);
}

const env = process.env;

export const config = {
  ark: {
    apiKey: env.ARK_API_KEY || local.ark?.apiKey || '',
    baseUrl: env.ARK_BASE_URL || local.ark?.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3',
    chatModel: env.ARK_CHAT_MODEL || local.ark?.chatModel || 'doubao-seed-2-1-pro-260915',
    embeddingModel: env.ARK_EMBEDDING_MODEL || local.ark?.embeddingModel || 'doubao-embedding-vision-251215',
  },
  server: {
    port: Number(env.PORT || local.server?.port || 4200),
  },
  idol: {
    serverId: local.idol?.serverId ?? 29266435,
    serverOwner: local.idol?.serverOwner ?? 161808465,
    name: local.idol?.name || '李婷',
    team: local.idol?.team || '',
  },
  paths: {
    // 相对本文件所在目录（src/）的上级
    dataDir: join(__dirname, '..', 'data'),
    scraperDb: join(__dirname, '..', '..', 'pocket48-scraper', 'data', 'pocket48.db'),
  },
};

if (!config.ark.apiKey) {
  console.error('[config] 缺少 ARK_API_KEY：请在 config.local.json 的 ark.apiKey 或环境变量中配置');
}

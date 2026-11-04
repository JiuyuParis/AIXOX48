/**
 * pocket48-scraper 配置
 * 所有可调参数集中在这里，改配置即可扩展，不需要改代码
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');

export default {
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT) || 4100
  },

  pocket48: {
    apiBase: 'https://pocketapi.48.cn',
    // 请求头模板（模拟 iOS 客户端，来自 48tools 逆向）
    userAgent: 'PocketFans201807/6.0.16 (iPhone; iOS 13.5.1; Scale/2.00)',
    appVersion: '7.0.4',
    appBuild: '23011601',
    osVersion: '16.3.1',
    deviceName: 'iPhone XR'
  },

  db: {
    file: process.env.DB_FILE || path.join(DATA_DIR, 'pocket48.db'),
    tokenFile: process.env.TOKEN_FILE || path.join(DATA_DIR, 'token.json')
  },

  crawler: {
    // 官方接口每页最多 50 条（实测）
    pageSize: 50,
    // 翻页间隔（毫秒），防风控，模拟真人阅读
    requestIntervalMs: 1200,
    // 全量回溯单次运行的最大页数上限（保护，防失控）
    maxPagesPerRun: 500,
    // 全量回溯后台任务默认总页数上限（100万页 = 5000万条，绝对保护；成员级历史通常几千页）
    backfillDefaultMaxPages: 1000000,
    // 增量同步：每次最多拉多少页（一般几页内就能追上最新）
    maxIncrementalPages: 20
  },

  scheduler: {
    // 增量同步周期（毫秒），默认 5 分钟
    syncIntervalMs: 5 * 60 * 1000,
    // token 过期前多久自动刷新提醒（48tools 实测 token 约 24h 有效）
    tokenRefreshHours: 20
  }
};

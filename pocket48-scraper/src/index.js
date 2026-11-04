/**
 * pocket48-scraper 服务入口
 * 数据捞取微服务：口袋48成员消息（历史回溯 + 增量更新），供其他服务消费
 *
 * 启动: node src/index.js
 * 环境变量: PORT（端口，默认4100）
 */
import config from './config.js';
import db from './db/database.js';
import client from './core/client.js';
import scheduler from './core/sync-scheduler.js';
import { createServer } from './api/routes.js';

async function main() {
  // 1. 初始化数据库
  db.open();
  console.log(`[boot] 数据库就绪: ${config.db.file}`);

  // 2. 预载 token
  const token = client.tokenStore.get();
  if (token?.token) {
    console.log(`[boot] 已加载登录态: ${token.mobile?.slice(0, 3)}****${token.mobile?.slice(7)} (登录于 ${new Date(token.loginTime).toLocaleString()})`);
  } else {
    console.log('[boot] ⚠️ 未登录。请通过 POST /api/v1/auth/sms + /api/v1/auth/verify 完成登录后使用');
  }

  // 3. 启动 HTTP 服务
  const server = createServer();
  server.listen(config.server.port, config.server.host, () => {
    console.log(`[boot] pocket48-scraper 已启动: http://${config.server.host}:${config.server.port}`);
    console.log(`[boot] 健康检查: http://${config.server.host}:${config.server.port}/health`);
  });

  // 4. 启动增量调度器（已登录才自动跑；未登录会记录错误但不崩溃）
  scheduler.start();

  // 5. 优雅退出
  const shutdown = () => {
    console.log('\n[boot] 正在关闭...');
    scheduler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => {
  console.error('[boot] 启动失败:', e);
  process.exit(1);
});

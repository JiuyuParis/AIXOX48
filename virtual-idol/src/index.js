// virtual-idol 服务入口：虚拟偶像人格引擎（端口 4200）
import http from 'node:http';
import { URL } from 'node:url';
import { config } from './config.js';
import { handleRequest } from './api/routes.js';
import { loadMessages } from './core/retriever.js';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    await handleRequest(req, res, url);
  } catch (e) {
    console.error('[server] 未处理异常:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    } else {
      res.end();
    }
  }
});

// 启动时预热历史消息（不依赖模型，肯定可加载）
loadMessages();

server.listen(config.server.port, () => {
  console.log(`[virtual-idol] 服务已启动: http://127.0.0.1:${config.server.port}`);
  console.log(`[virtual-idol] 偶像: ${config.idol.name} (${config.idol.team || '未知团'})`);
  console.log(`[virtual-idol] 对话模型: ${config.ark.chatModel} | 向量模型: ${config.ark.embeddingModel}`);
  console.log(`[virtual-idol] 健康检查: http://127.0.0.1:${config.server.port}/health`);
});

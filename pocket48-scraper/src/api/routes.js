/**
 * HTTP API 路由层（node:http 零依赖实现）
 * 供其他服务（虚拟偶像网页等）调用，语言无关的 RESTful 契约
 */
import http from 'node:http';
import { URL } from 'node:url';
import config from '../config.js';
import client from '../core/client.js';
import crawler from '../core/message-crawler.js';
import scheduler from '../core/sync-scheduler.js';
import db from '../db/database.js';

/* ---------- 工具 ---------- */

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { success: false, code, message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function parseIntParam(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/* ---------- 路由表 ---------- */

const routes = [];

function route(method, pattern, handler) {
  // pattern: '/api/v1/members/:serverId/sync' → 编译为正则
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[a-zA-Z0-9_]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  }) + '$');
  routes.push({ method, regex, keys, handler });
}

/* ===== 系统 ===== */
route('GET', '/health', async (req, res) => {
  const stats = db.getGlobalStats();
  sendJson(res, 200, {
    success: true,
    status: 'ok',
    uptime: process.uptime(),
    now: Date.now(),
    ...stats,
    scheduler: scheduler.status(),
    auth: { loggedIn: !!client.tokenStore.get()?.token }
  });
});

/* ===== 登录认证 ===== */
route('POST', '/api/v1/auth/sms', async (req, res) => {
  const body = await readBody(req);
  const mobile = String(body.mobile || '');
  if (!/^\d{11}$/.test(mobile)) return sendError(res, 400, 'BAD_MOBILE', '手机号格式不正确');
  await client.sendSms(mobile);
  sendJson(res, 200, { success: true, message: `验证码已发送到 ${mobile.slice(0, 3)}****${mobile.slice(7)}` });
});

route('POST', '/api/v1/auth/verify', async (req, res) => {
  const body = await readBody(req);
  const mobile = String(body.mobile || '');
  const code = String(body.code || '').trim();
  if (!/^\d{11}$/.test(mobile)) return sendError(res, 400, 'BAD_MOBILE', '手机号格式不正确');
  if (!/^\d{4,6}$/.test(code)) return sendError(res, 400, 'BAD_CODE', '验证码格式不正确');
  const info = await client.loginByCode(mobile, code);
  sendJson(res, 200, { success: true, userId: info.userId, nickname: info.nickname });
});

route('GET', '/api/v1/auth/status', async (req, res) => {
  const t = client.tokenStore.get();
  if (!t?.token) return sendJson(res, 200, { success: true, loggedIn: false });
  sendJson(res, 200, {
    success: true,
    loggedIn: true,
    mobile: t.mobile ? t.mobile.slice(0, 3) + '****' + t.mobile.slice(7) : null,
    loginTime: t.loginTime
  });
});

/* ===== 成员管理 ===== */
route('POST', '/api/v1/members/search', async (req, res) => {
  const body = await readBody(req);
  const keyword = String(body.keyword || '').trim();
  if (!keyword) return sendError(res, 400, 'BAD_KEYWORD', '请输入关键词');
  const results = await client.searchMember(keyword);
  sendJson(res, 200, { success: true, keyword, results });
});

route('POST', '/api/v1/members', async (req, res) => {
  const body = await readBody(req);
  const keyword = String(body.keyword || '').trim();
  if (!keyword) return sendError(res, 400, 'BAD_KEYWORD', '请输入成员关键词');
  const member = await crawler.addMember(keyword);
  sendJson(res, 200, { success: true, member });
});

route('GET', '/api/v1/members', async (req, res) => {
  const members = db.listMembers().map(m => {
    const stats = db.getMessageStats(m.server_id);
    return { ...m, stats };
  });
  sendJson(res, 200, { success: true, count: members.length, members });
});

route('DELETE', '/api/v1/members/:serverId', async (req, res, params) => {
  const serverId = Number(params.serverId);
  const m = db.getMember(serverId);
  if (!m) return sendError(res, 404, 'NOT_FOUND', '成员未登记');
  db.removeMember(serverId);
  sendJson(res, 200, { success: true, removed: m.name });
});

/* ===== 同步 ===== */
route('POST', '/api/v1/members/:serverId/sync', async (req, res, params) => {
  const body = await readBody(req);
  const serverId = Number(params.serverId);
  const mode = body.mode === 'backfill' ? 'backfill' : 'incremental';
  const pages = body.pages ? parseIntParam(body.pages, config.crawler.maxPagesPerRun) : null;
  const member = db.getMember(serverId);
  if (!member) return sendError(res, 404, 'NOT_FOUND', '成员未登记');

  const result = mode === 'backfill'
    ? await crawler.backfillSync(serverId, pages || config.crawler.maxPagesPerRun)
    : await crawler.incrementalSync(serverId);

  sendJson(res, 200, { success: true, mode, serverId, memberName: member.name, ...result });
});

/* ===== 全量回溯（异步后台任务） ===== */
route('POST', '/api/v1/members/:serverId/backfill', async (req, res, params) => {
  const body = await readBody(req);
  const serverId = Number(params.serverId);
  const member = db.getMember(serverId);
  if (!member) return sendError(res, 404, 'NOT_FOUND', '成员未登记');
  const maxPages = body.maxPages ? parseIntParam(body.maxPages, config.crawler.backfillDefaultMaxPages) : config.crawler.backfillDefaultMaxPages;
  const task = crawler.startBackfillTask(serverId, maxPages);
  sendJson(res, 200, { success: true, taskId: serverId, task });
});

route('GET', '/api/v1/members/:serverId/backfill', async (req, res, params) => {
  const serverId = Number(params.serverId);
  const task = crawler.getBackfillTask(serverId);
  if (!task) return sendError(res, 404, 'NO_TASK', '该成员没有全量回溯任务（可 POST 启动）');
  sendJson(res, 200, { success: true, task });
});

route('GET', '/api/v1/backfill/tasks', async (req, res) => {
  sendJson(res, 200, { success: true, tasks: crawler.listBackfillTasks() });
});

/* ===== 消息查询 ===== */
route('GET', '/api/v1/members/:serverId/messages', async (req, res, params) => {
  const url = new URL(req.url, 'http://x');
  const serverId = Number(params.serverId);
  if (!db.getMember(serverId)) return sendError(res, 404, 'NOT_FOUND', '成员未登记');
  const opts = {
    after: parseIntParam(url.searchParams.get('after'), 0),
    before: parseIntParam(url.searchParams.get('before'), 0),
    type: url.searchParams.get('type') || null,
    limit: Math.min(parseIntParam(url.searchParams.get('limit'), 50), 200),
    offset: parseIntParam(url.searchParams.get('offset'), 0)
  };
  const messages = crawler.getParsedMessages(serverId, opts);
  const total = db.countMessages(serverId, opts.type);
  sendJson(res, 200, { success: true, serverId, total, returned: messages.length, messages });
});

route('GET', '/api/v1/members/:serverId/stats', async (req, res, params) => {
  const serverId = Number(params.serverId);
  if (!db.getMember(serverId)) return sendError(res, 404, 'NOT_FOUND', '成员未登记');
  const member = db.getMember(serverId);
  const stats = db.getMessageStats(serverId);
  sendJson(res, 200, { success: true, serverId, memberName: member.name, stats });
});

/* ===== 导出 ===== */
route('GET', '/api/v1/members/:serverId/export', async (req, res, params) => {
  const url = new URL(req.url, 'http://x');
  const serverId = Number(params.serverId);
  const member = db.getMember(serverId);
  if (!member) return sendError(res, 404, 'NOT_FOUND', '成员未登记');
  const format = url.searchParams.get('format') || 'jsonl';
  const type = url.searchParams.get('type') || null;

  const rows = db.queryMessages(serverId, { limit: 1000000, type });
  if (format === 'csv') {
    const lines = ['msg_id_server,msg_time,msg_type,bodys'];
    for (const r of rows) {
      const escaped = String(r.bodys).replace(/"/g, '""');
      lines.push(`${r.msg_id_server},${r.msg_time},${r.msg_type},"${escaped}"`);
    }
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': `attachment; filename="${member.default_name || member.name}_messages.csv"`
    });
    res.end(lines.join('\n'));
  } else {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': `attachment; filename="${member.default_name || member.name}_messages.jsonl"`
    });
    for (const r of rows) res.write(JSON.stringify(r) + '\n');
    res.end();
  }
});

/* ---------- 请求分发 ---------- */

export function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = path.match(r.regex);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        await r.handler(req, res, params);
      } catch (e) {
        console.error(`[api] ${req.method} ${path} 错误:`, e.message);
        const status = e.code === 'NO_TOKEN' ? 401 : e.code === 'TOKEN_EXPIRED' ? 401 : 500;
        sendError(res, status, e.code || 'INTERNAL', e.message);
      }
      return;
    }
    sendError(res, 404, 'NOT_FOUND', `路径 ${req.method} ${path} 未找到`);
  });
}

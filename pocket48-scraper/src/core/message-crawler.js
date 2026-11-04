/**
 * 消息拉取引擎
 * - addMember: 搜索成员 → 获取 channelId → 关注 → 登记入库
 * - syncMember: 增量同步 / 全量回溯（统一实现，用 startTime 区分）
 * - 单飞去重：同一成员不会并发同步
 * - 频率控制：每页间隔 requestIntervalMs，模拟真人阅读
 */
import config from '../config.js';
import client from './client.js';
import db from '../db/database.js';
import { parseMessage } from './parser.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 同步中标记（单飞）：serverId -> Promise
const syncing = new Map();

/** 把原始消息映射为入库记录 */
function mapRaw(msgs, serverId, channelId) {
  return msgs.map(m => ({
    msg_id_server: Number(m.msgIdServer),
    server_id: serverId,
    channel_id: channelId,
    msg_type: m.msgType,
    bodys: String(m.bodys ?? ''),
    ext_info: String(m.extInfo ?? ''),
    msg_time: Number(m.msgTime),
    raw_json: JSON.stringify(m)
  }));
}

/** 按关键词添加成员（搜索→channelId→关注→入库） */
async function addMember(keyword) {
  const results = await client.searchMember(keyword);
  if (!results.length) throw new client.ApiError('MEMBER_NOT_FOUND', `未找到成员: ${keyword}`);
  const picked = results[0];

  const jump = await client.jumpToServer(picked.serverOwner);
  let followed = 0;
  try {
    await client.followMember(picked.serverOwner);
    followed = 1;
  } catch (e) {
    console.warn(`[addMember] 关注失败(可忽略): ${e.message}`);
  }

  db.upsertMember({
    server_id: picked.serverId,
    server_owner: picked.serverOwner,
    channel_id: jump.channelId,
    name: picked.roomName || picked.name,
    default_name: picked.name,
    avatar: picked.avatar,
    team_id: picked.teamId,
    followed,
    created_at: Date.now()
  });
  const member = db.getMember(picked.serverId);
  console.log(`[addMember] ✅ 已添加: ${member.name} (serverId=${member.server_id}, channelId=${member.channel_id})`);
  return member;
}

/**
 * 同步成员消息
 * @param {number} serverId
 * @param {object} opts
 *   - startTime: 入库过滤边界（增量传 last_msg_time；全量回溯传 0）
 *   - startNextTime: 起始翻页游标（0=从最新开始；全量回溯续跑时传上一轮末的游标）
 *   - maxPages: 本次最多翻多少页
 *   - onProgress: 逐页进度回调 ({pages, added, nextTime, oldestTime})
 * @returns {Promise<{added:number, pages:number, stopReason:string, newLastMsgTime:number}>}
 */
async function syncMember(serverId, { startTime = 0, startNextTime = 0, maxPages = config.crawler.maxIncrementalPages, onProgress = null } = {}) {
  const member = db.getMember(serverId);
  if (!member) throw new client.ApiError('MEMBER_NOT_FOUND', `成员未登记: ${serverId}`);

  // 单飞：防止调度器/手动触发重叠
  if (syncing.has(serverId)) {
    console.log(`[sync] ${member.name} 正在同步中，跳过本次触发`);
    return { skipped: true };
  }

  const task = (async () => {
    const { channel_id: channelId, server_id } = member;
    const pageSize = config.crawler.pageSize;
    const interval = config.crawler.requestIntervalMs;

    let nextTime = startNextTime; // 0 = 从最新开始
    let added = 0;
    let pages = 0;
    let stopReason = 'max_pages';
    let lastSeenNextTime = null;

    while (pages < maxPages) {
      const content = await client.getHomeownerMessage(channelId, server_id, nextTime, pageSize);
      const msgs = content?.message || [];
      pages++;

      if (!msgs.length) { stopReason = 'no_more_data'; break; }

      // 增量过滤：只入库比 startTime 新的消息
      const newMsgs = msgs.filter(m => Number(m.msgTime) > startTime);
      if (newMsgs.length) {
        added += db.insertMessages(mapRaw(newMsgs, server_id, channelId));
      }

      const oldestTime = Number(msgs[msgs.length - 1].msgTime);
      // 本页最旧消息已不新于边界 → 已到已入库区域，停止
      if (oldestTime <= startTime) { stopReason = 'reached_watermark'; break; }

      const nt = content.nextTime;
      // 游标不再前进（已翻到最早）→ 停止
      if (!nt || nt === lastSeenNextTime) { stopReason = 'cursor_stopped'; break; }
      lastSeenNextTime = nt;
      nextTime = nt;

      onProgress?.({ pages, added, nextTime, oldestTime });
      await sleep(interval);
    }

    // 最后补一次进度回调（本页数据已入库）
    onProgress?.({ pages, added, nextTime, oldestTime: 0, final: true });

    // 更新成员的同步水位
    const newLastMsgTime = db.getMaxMsgTime(server_id);
    db.updateMemberSyncState(server_id, newLastMsgTime, Date.now());

    console.log(`[sync] ${member.name}: 新增 ${added} 条 (${pages} 页, ${stopReason}), 水位=${newLastMsgTime}`);
    return { added, pages, stopReason, newLastMsgTime };
  })();

  syncing.set(serverId, task);
  try {
    return await task;
  } finally {
    syncing.delete(serverId);
  }
}

/** 增量同步（调度器用）：只拉最新，遇到已入库水位即停 */
async function incrementalSync(serverId) {
  const member = db.getMember(serverId);
  if (!member) return null;
  return syncMember(serverId, {
    startTime: member.last_msg_time || 0,
    maxPages: config.crawler.maxIncrementalPages
  });
}

/** 全量回溯：从最新一路翻到最早（或页数上限） */
async function backfillSync(serverId, maxPages = config.crawler.maxPagesPerRun) {
  return syncMember(serverId, { startTime: 0, maxPages });
}

/* ============ 全量回溯后台任务 ============ */
// serverId -> 任务状态
const backfillTasks = new Map();

/**
 * 启动/续跑全量回溯后台任务
 * 自动分轮翻页直到：拉到底（官方无更早数据）或达到 maxTotalPages
 * @param {number} serverId
 * @param {number} [maxTotalPages] 总页数上限（默认配置值，拉到底保护）
 */
function startBackfillTask(serverId, maxTotalPages = config.crawler.backfillDefaultMaxPages) {
  const member = db.getMember(serverId);
  if (!member) throw new client.ApiError('MEMBER_NOT_FOUND', `成员未登记: ${serverId}`);

  const existing = backfillTasks.get(serverId);
  // 已在运行/排队 → 幂等返回
  if (existing && (existing.status === 'running' || existing.status === 'queued')) return existing;
  // 已拉到底 → 无需再跑
  if (existing?.status === 'done' && (existing.stopReason === 'no_more_data' || existing.stopReason === 'cursor_stopped')) {
    existing.message = '已拉取到官方最早数据，无需继续';
    return existing;
  }

  const task = {
    serverId,
    memberName: member.name,
    status: 'running',
    pagesDone: existing?.pagesDone || 0,   // 已完成的页数（续跑累计）
    added: existing?.added || 0,           // 已新增消息数（续跑累计）
    maxTotalPages,
    startTime: existing?.startTime || Date.now(),
    endTime: 0,
    stopReason: 'running',
    error: null,
    lastPageAt: Date.now()
  };
  backfillTasks.set(serverId, task);
  console.log(`[backfill] ${task.memberName}: 后台任务启动, 目标 ${maxTotalPages} 页`);

  // 后台异步执行（不阻塞调用方）
  (async () => {
    try {
      const CHUNK = 100; // 每轮页数（一轮约 2 分钟）
      let cursor = 0;    // 跨轮翻页游标：第一轮从最新开始，之后接力上一轮末的游标
      while (task.status === 'running') {
        if (task.pagesDone >= task.maxTotalPages) { task.stopReason = 'max_total_pages'; break; }

        const roundBasePages = task.pagesDone;
        const roundBaseAdded = task.added;
        const r = await syncMember(serverId, {
          startTime: 0,
          startNextTime: cursor,
          maxPages: Math.min(CHUNK, task.maxTotalPages - task.pagesDone),
          onProgress: (p) => {
            task.pagesDone = roundBasePages + p.pages;
            task.added = roundBaseAdded + p.added;
            task.lastPageAt = Date.now();
            if (p.nextTime) cursor = p.nextTime; // 接力游标：下一轮从当前位置继续往前
          }
        });
        task.lastPageAt = Date.now();
        // 注意：pagesDone/added 已由 onProgress 回调实时更新，这里不再累加，避免重复计数

        if (r.skipped) { await sleep(3000); continue; }            // 被增量同步占用，等待重试
        if (r.stopReason === 'no_more_data' || r.stopReason === 'cursor_stopped') {
          task.stopReason = r.stopReason;                          // 官方无更早数据，拉到底
          break;
        }
        if (r.stopReason === 'max_pages') {
          if (task.pagesDone >= task.maxTotalPages) { task.stopReason = 'max_total_pages'; break; }
          continue;                                                // 本轮拉满但未到底，继续下一轮
        }
        break;
      }
      task.status = 'done';
      task.endTime = Date.now();
      console.log(`[backfill] ${task.memberName}: 任务完成 → ${task.added} 条 / ${task.pagesDone} 页 / ${task.stopReason}`);
    } catch (e) {
      task.status = 'error';
      task.error = e.message;
      task.endTime = Date.now();
      console.error(`[backfill] ${task.memberName}: 任务异常 → ${e.message}`);
    }
  })();

  return task;
}

/** 查询全量回溯任务状态 */
function getBackfillTask(serverId) {
  return backfillTasks.get(serverId) || null;
}

/** 全部回溯任务列表 */
function listBackfillTasks() {
  return [...backfillTasks.values()].map(t => ({
    serverId: t.serverId, memberName: t.memberName, status: t.status,
    pagesDone: t.pagesDone, added: t.added, stopReason: t.stopReason,
    startTime: t.startTime, endTime: t.endTime, error: t.error
  }));
}

/** 同步所有已登记成员（增量） */
async function syncAllIncremental() {
  const members = db.listMembers();
  const results = [];
  for (const m of members) {
    try {
      results.push(await incrementalSync(m.server_id));
    } catch (e) {
      console.error(`[syncAll] ${m.name} 同步失败: ${e.message}`);
      results.push({ serverId: m.server_id, error: e.message });
    }
    await sleep(300);
  }
  return results;
}

/** 解析并返回消息（供 API 层使用） */
function getParsedMessages(serverId, opts) {
  const rows = db.queryMessages(serverId, opts);
  return rows.map(r => parseMessage(JSON.parse(r.raw_json)));
}

export default {
  addMember, syncMember, incrementalSync, backfillSync, syncAllIncremental, getParsedMessages, mapRaw,
  startBackfillTask, getBackfillTask, listBackfillTasks
};

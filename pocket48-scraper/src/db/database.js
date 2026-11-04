/**
 * 数据库层（DAO）
 * 使用 Node 22 内置 node:sqlite，零 npm 依赖
 * 所有 SQL 集中在此层：将来换 PostgreSQL/MySQL 只改这个文件
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import config, { DATA_DIR } from '../config.js';

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  server_id      INTEGER PRIMARY KEY,   -- 成员房间服务ID
  server_owner   INTEGER NOT NULL,      -- 成员用户ID（用于关注/跳转）
  channel_id     INTEGER NOT NULL,      -- IM 频道ID（拉消息用）
  name           TEXT NOT NULL,         -- 房间显示名
  default_name   TEXT DEFAULT '',       -- 成员本名
  avatar         TEXT DEFAULT '',       -- 头像
  team_id        INTEGER DEFAULT 0,
  team_name      TEXT DEFAULT '',
  group_name     TEXT DEFAULT '',       -- 分团（SNH48/GNZ48...）
  followed       INTEGER DEFAULT 0,     -- 是否已关注
  last_msg_time  INTEGER DEFAULT 0,     -- 已同步到的最大消息时间（增量游标）
  last_sync_at   INTEGER DEFAULT 0,     -- 最近一次同步完成时间
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  msg_id_server  INTEGER PRIMARY KEY,   -- 服务端消息ID（全局唯一，天然去重）
  server_id      INTEGER NOT NULL,      -- 所属成员房间
  channel_id     INTEGER NOT NULL,
  msg_type       TEXT NOT NULL,         -- TEXT/IMAGE/REPLY/GIFTREPLY/AUDIO_GIFT_REPLY...
  bodys          TEXT NOT NULL,         -- 消息内容（原始 JSON/文本）
  ext_info       TEXT DEFAULT '',       -- 扩展信息（用户信息等，原始 JSON）
  msg_time       INTEGER NOT NULL,      -- 消息时间（毫秒时间戳）
  raw_json       TEXT NOT NULL,         -- 原始消息完整 JSON（可扩展性：任何新类型都能无损重建）
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_server_time ON messages(server_id, msg_time);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(msg_time);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(msg_type);
`;

function open() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(config.db.file);
  // WAL 模式：读写不互锁，增量写入不阻塞查询
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

function close() {
  if (db) { db.close(); db = null; }
}

/* ============ members ============ */
function upsertMember(m) {
  const d = open();
  d.prepare(`
    INSERT INTO members (server_id, server_owner, channel_id, name, default_name, avatar, team_id, team_name, group_name, followed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET
      server_owner=excluded.server_owner,
      channel_id=excluded.channel_id,
      name=excluded.name,
      default_name=excluded.default_name,
      avatar=excluded.avatar,
      team_id=excluded.team_id,
      team_name=excluded.team_name,
      group_name=excluded.group_name,
      followed=excluded.followed,
      updated_at=?
  `).run(
    m.server_id, m.server_owner, m.channel_id, m.name, m.default_name || '', m.avatar || '',
    m.team_id || 0, m.team_name || '', m.group_name || '', m.followed ? 1 : 0,
    Date.now(), Date.now()
  );
}

function getMember(serverId) {
  const d = open();
  return d.prepare('SELECT * FROM members WHERE server_id = ?').get(serverId) || null;
}

function listMembers() {
  const d = open();
  return d.prepare('SELECT * FROM members ORDER BY created_at ASC').all();
}

function removeMember(serverId) {
  const d = open();
  d.prepare('DELETE FROM members WHERE server_id = ?').run(serverId);
}

function updateMemberSyncState(serverId, lastMsgTime, lastSyncAt) {
  const d = open();
  d.prepare('UPDATE members SET last_msg_time = ?, last_sync_at = ?, updated_at = ? WHERE server_id = ?')
    .run(lastMsgTime, lastSyncAt, Date.now(), serverId);
}

/* ============ messages ============ */
/**
 * 批量写入消息（INSERT OR IGNORE 天然去重：msg_id_server 主键冲突即跳过）
 * @returns {number} 实际新增条数
 */
function insertMessages(msgs) {
  const d = open();
  const stmt = d.prepare(`
    INSERT OR IGNORE INTO messages (msg_id_server, server_id, channel_id, msg_type, bodys, ext_info, msg_time, raw_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  let added = 0;
  d.exec('BEGIN');
  try {
    for (const m of msgs) {
      const r = stmt.run(m.msg_id_server, m.server_id, m.channel_id, m.msg_type, m.bodys, m.ext_info, m.msg_time, m.raw_json, now);
      if (r.changes > 0) added++;
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return added;
}

/** 查询成员消息：支持时间范围、类型过滤、分页 */
function queryMessages(serverId, { after = 0, before = 0, type = null, limit = 50, offset = 0 } = {}) {
  const d = open();
  const conds = ['server_id = ?'];
  const params = [serverId];
  if (after > 0) { conds.push('msg_time > ?'); params.push(after); }
  if (before > 0) { conds.push('msg_time < ?'); params.push(before); }
  if (type) { conds.push('msg_type = ?'); params.push(type); }
  params.push(limit, offset);
  return d.prepare(`
    SELECT * FROM messages
    WHERE ${conds.join(' AND ')}
    ORDER BY msg_time DESC
    LIMIT ? OFFSET ?
  `).all(...params);
}

function countMessages(serverId, type = null) {
  const d = open();
  if (type) {
    return d.prepare('SELECT COUNT(*) AS c FROM messages WHERE server_id = ? AND msg_type = ?').get(serverId, type).c;
  }
  return d.prepare('SELECT COUNT(*) AS c FROM messages WHERE server_id = ?').get(serverId).c;
}

function getMessageStats(serverId) {
  const d = open();
  const total = d.prepare('SELECT COUNT(*) AS c FROM messages WHERE server_id = ?').get(serverId).c;
  const byType = d.prepare('SELECT msg_type, COUNT(*) AS count FROM messages WHERE server_id = ? GROUP BY msg_type').all(serverId);
  const range = d.prepare('SELECT MIN(msg_time) AS min, MAX(msg_time) AS max FROM messages WHERE server_id = ?').get(serverId);
  return { total, byType, minTime: range.min, maxTime: range.max };
}

function getGlobalStats() {
  const d = open();
  return {
    totalMessages: d.prepare('SELECT COUNT(*) AS c FROM messages').get().c,
    totalMembers: d.prepare('SELECT COUNT(*) AS c FROM members').get().c
  };
}

/** 获取某成员已入库的最大 msg_time */
function getMaxMsgTime(serverId) {
  const d = open();
  return d.prepare('SELECT MAX(msg_time) AS m FROM messages WHERE server_id = ?').get(serverId).m || 0;
}

export default {
  open, close,
  upsertMember, getMember, listMembers, removeMember, updateMemberSyncState,
  insertMessages, queryMessages, countMessages, getMessageStats, getGlobalStats, getMaxMsgTime
};

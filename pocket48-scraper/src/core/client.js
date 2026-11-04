/**
 * 口袋48 API 客户端
 * - 签名：复用 48tools 逆向的 rust-wasm（pa 头，动态生成）
 * - token：持久化到 data/token.json，登录走官方短信验证码
 * - 所有接口 POST + JSON，头带 appInfo/User-Agent/pa/token
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import config from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let signer = null; // { pa(), init() }

/** 生成随机字符串（设备ID组件） */
function rStr(len) {
  const s = 'QWERTYUIOPASDFGHJKLZXCVBNM1234567890';
  let r = '';
  for (let i = 0; i < len; i++) r += s[Math.floor(Math.random() * s.length)];
  return r;
}

function makeDeviceId() {
  return `${rStr(8)}-${rStr(4)}-${rStr(4)}-${rStr(4)}-${rStr(12)}`;
}

function buildAppInfo() {
  return JSON.stringify({
    vendor: 'apple',
    deviceId: makeDeviceId(),
    appVersion: config.pocket48.appVersion,
    appBuild: config.pocket48.appBuild,
    osVersion: config.pocket48.osVersion,
    osType: 'ios',
    deviceName: config.pocket48.deviceName,
    os: 'ios'
  });
}

/** 初始化签名模块（幂等） */
async function ensureSigner() {
  if (signer) return signer;
  const wasmPath = path.join(__dirname, '..', 'sdk', '2.wasm');
  const jsPath = path.join(__dirname, '..', 'sdk', 'rust-wasm.js');
  const wasmBytes = fs.readFileSync(wasmPath);
  const mod = await import(pathToFileURL(jsPath).href);
  await mod.default(wasmBytes);
  signer = { pa: () => mod.__x6c2adf8__() };
  return signer;
}

/* ============ Token 管理 ============ */
const tokenStore = {
  data: null,
  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(config.db.tokenFile, 'utf-8'));
    } catch {
      this.data = null;
    }
    return this.data;
  },
  save(mobile, token) {
    this.data = { mobile, token, loginTime: Date.now() };
    fs.mkdirSync(path.dirname(config.db.tokenFile), { recursive: true });
    fs.writeFileSync(config.db.tokenFile, JSON.stringify(this.data, null, 2), 'utf-8');
    return this.data;
  },
  get() {
    if (!this.data) this.load();
    return this.data;
  },
  clear() {
    this.data = null;
    try { fs.unlinkSync(config.db.tokenFile); } catch { /* ignore */ }
  }
};

/* ============ 核心请求 ============ */
/**
 * 发起接口请求
 * @param {string} apiPath  e.g. /im/api/v1/team/message/list/homeowner
 * @param {object} body
 * @param {boolean} needToken 是否必须带 token
 */
async function request(apiPath, body = {}, { needToken = false, retry = 1 } = {}) {
  await ensureSigner();
  const headers = {
    'Content-Type': 'application/json;charset=utf-8',
    'appInfo': buildAppInfo(),
    'User-Agent': config.pocket48.userAgent,
    'Accept-Language': 'zh-Hans-AW;q=1',
    'Host': 'pocketapi.48.cn',
    'pa': signer.pa()
  };
  if (needToken) {
    const t = tokenStore.get();
    if (!t?.token) throw new ApiError('NO_TOKEN', '未登录：请先通过 /api/v1/auth/sms + /api/v1/auth/verify 登录');
    headers.token = t.token;
  }

  const res = await fetch(`${config.pocket48.apiBase}${apiPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { status: res.status, success: false, message: text.slice(0, 200) }; }

  // token 失效处理
  if (needToken && data.status === 401) {
    if (retry > 0) {
      // 清掉失效 token，提示重新登录
      tokenStore.clear();
      throw new ApiError('TOKEN_EXPIRED', '登录已过期，请重新登录（POST /api/v1/auth/sms + /api/v1/auth/verify）');
    }
  }
  if (data.status !== 200 || data.success === false) {
    const err = new ApiError(`P48_${data.status}`, data.message || '接口错误');
    err.raw = data;
    throw err;
  }
  return data;
}

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/* ============ 接口封装 ============ */

/** 发送登录验证码 */
async function sendSms(mobile) {
  return request('/user/api/v1/sms/send2', { mobile, area: '86' });
}

/** 验证码登录，返回并保存 token */
async function loginByCode(mobile, code) {
  const data = await request('/user/api/v1/login/app/mobile/code', { mobile, code });
  const token = data?.content?.token;
  if (!token) throw new ApiError('LOGIN_FAIL', '登录响应中无 token');
  tokenStore.save(mobile, token);
  return data.content;
}

/** 搜索成员（按昵称/本名） */
async function searchMember(keyword) {
  const data = await request('/im/api/v1/im/server/search', { searchContent: keyword }, { needToken: true });
  const list = data?.content?.serverApiList || [];
  return list.map(s => ({
    serverId: s.serverId,
    serverOwner: s.serverOwner,
    name: s.serverDefaultName || s.serverName,
    roomName: s.serverName,
    avatar: s.serverDefaultIcon || s.serverIcon,
    teamId: s.teamId,
    serverType: s.serverType
  }));
}

/** 跳转进入成员房间，拿 channelId */
async function jumpToServer(starId) {
  const data = await request('/im/api/v1/im/server/jump', { starId, targetType: 1 }, { needToken: true });
  const c = data.content;
  return {
    serverId: c.serverId,
    channelId: c.channelId,
    ownerId: c.jumpServerInfo?.serverOwner,
    ownerName: c.jumpServerInfo?.serverOwnerName
  };
}

/** 关注成员 */
async function followMember(toSourceId) {
  return request('/user/api/v2/friendships/friends/add', { toSourceId, toType: 1 }, { needToken: true });
}

/** 拉取房间消息（核心接口） */
async function getHomeownerMessage(channelId, serverId, nextTime = 0, limit = 50) {
  const data = await request('/im/api/v1/team/message/list/homeowner',
    { channelId, serverId, nextTime, limit }, { needToken: true });
  return data.content; // { message: [], nextTime }
}

/** 房间信息 */
async function getRoomInfo(channelId) {
  const data = await request('/im/api/v1/im/team/room/info', { channelId: String(channelId) }, { needToken: true });
  return data.content;
}

/** 当前账号信息 */
async function getAccountInfo() {
  const data = await request('/user/api/v1/user/info/reload', { from: 'appstart' }, { needToken: true });
  return data.content;
}

export default {
  ensureSigner, request, ApiError,
  tokenStore,
  sendSms, loginByCode,
  searchMember, jumpToServer, followMember,
  getHomeownerMessage, getRoomInfo, getAccountInfo
};

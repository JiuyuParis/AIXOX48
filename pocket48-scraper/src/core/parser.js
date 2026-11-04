/**
 * 消息解析器（类型注册表模式）
 * 每种消息类型一个解析函数，输出统一的、AI 友好的结构化格式。
 * 新增消息类型 = 在 parsers 注册表加一个函数，无需改表结构/改主流程。
 */

function safeParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

function extractSender(extInfo) {
  const e = safeParse(extInfo);
  const u = e?.user || {};
  return {
    userId: u.userId || null,
    nickName: u.nickName || '',
    avatar: u.avatar || '',
    roleId: u.roleId || null, // 3=xox(成员), 1=普通用户, 2=?
    vip: !!u.vip,
    teamLogo: u.teamLogo || ''
  };
}

/* ============ 各类型解析器 ============ */

function parseText(raw) {
  return {
    contentType: 'text',
    text: String(raw.bodys || ''),
    content: { text: String(raw.bodys || '') },
    mediaUrls: [],
    replyTo: null
  };
}

function parseImage(raw) {
  const b = safeParse(raw.bodys) || {};
  const url = b.url || '';
  return {
    contentType: 'image',
    text: '[图片]',
    content: { url, width: b.w, height: b.h, size: b.size, ext: b.ext },
    mediaUrls: url ? [url] : [],
    replyTo: null
  };
}

function parseReply(raw) {
  const b = safeParse(raw.bodys) || {};
  const ri = b.replyInfo || {};
  return {
    contentType: 'reply',
    text: ri.text || '[回复]',
    content: { text: ri.text || '', replyText: ri.replyText || '', replyName: ri.replyName || '' },
    mediaUrls: [],
    replyTo: { messageId: ri.replyMessageId || null, text: ri.replyText || '', name: ri.replyName || '' }
  };
}

function parseGiftReply(raw) {
  const b = safeParse(raw.bodys) || {};
  const gi = b.giftReplyInfo || {};
  return {
    contentType: 'gift',
    text: gi.text || '[礼物回复]',
    content: { text: gi.text || '', replyText: gi.replyText || '', replyName: gi.replyName || '' },
    mediaUrls: [],
    replyTo: { messageId: gi.replyMessageId || null, text: gi.replyText || '', name: gi.replyName || '' }
  };
}

function parseAudioGiftReply(raw) {
  const b = safeParse(raw.bodys) || {};
  const gi = b.giftReplyInfo || {};
  const voiceUrl = gi.voiceUrl || '';
  return {
    contentType: 'voice',
    text: gi.replyText || '[语音礼物回复]',
    content: { text: gi.text || '', replyText: gi.replyText || '', voiceUrl },
    mediaUrls: voiceUrl ? [voiceUrl] : [],
    replyTo: { messageId: gi.replyMessageId || null, text: gi.replyText || '', name: gi.replyName || '' }
  };
}

function parseAudio(raw) {
  // 翻牌语音/语音消息：bodys 可能是 url 或 JSON
  const b = safeParse(raw.bodys);
  let url = '';
  if (typeof b === 'string') url = b;
  else if (b?.url) url = b.url;
  else if (b?.voiceUrl) url = b.voiceUrl;
  else if (typeof raw.bodys === 'string' && /^https?:/.test(raw.bodys)) url = raw.bodys;
  return {
    contentType: 'voice',
    text: '[语音]',
    content: { url },
    mediaUrls: url ? [url] : [],
    replyTo: null
  };
}

function parseVideo(raw) {
  const b = safeParse(raw.bodys) || {};
  const url = b.url || b.coverUrl || '';
  return {
    contentType: 'video',
    text: '[视频]',
    content: { url, cover: b.coverUrl || '', title: b.title || '' },
    mediaUrls: url ? [url] : [],
    replyTo: null
  };
}

function parseLivePush(raw) {
  const b = safeParse(raw.bodys) || {};
  const li = b.livePushInfo || {};
  return {
    contentType: 'live',
    text: `[直播] ${li.liveTitle || ''}`.trim(),
    content: { liveId: li.liveId, title: li.liveTitle || '', cover: li.liveCover || '', shortPath: li.shortPath || '' },
    mediaUrls: li.liveCover ? [li.liveCover] : [],
    replyTo: null
  };
}

function parseFlipCard(raw) {
  const b = safeParse(raw.bodys) || {};
  return {
    contentType: 'flipcard',
    text: b.content || b.text || '[翻牌]',
    content: b,
    mediaUrls: b.image ? [b.image] : [],
    replyTo: null
  };
}

function parseDelete(raw) {
  const b = safeParse(raw.bodys) || {};
  return {
    contentType: 'delete',
    text: '[消息已删除]',
    content: b,
    mediaUrls: [],
    replyTo: null
  };
}

function parseGeneric(raw) {
  return {
    contentType: 'other',
    text: String(raw.bodys || '').slice(0, 200),
    content: safeParse(raw.bodys) || { raw: String(raw.bodys || '') },
    mediaUrls: [],
    replyTo: null
  };
}

/* ============ 注册表 ============ */
const parsers = {
  TEXT: parseText,
  IMAGE: parseImage,
  REPLY: parseReply,
  GIFTREPLY: parseGiftReply,
  AUDIO_GIFT_REPLY: parseAudioGiftReply,
  AUDIO: parseAudio,
  AUDIO_GIFT: parseAudio,
  FLIPCARD_AUDIO: parseAudio,
  VIDEO: parseVideo,
  FLIPCARD_VIDEO: parseVideo,
  LIVEPUSH: parseLivePush,
  FLIPCARD: parseFlipCard,
  DELETE: parseDelete
};

/**
 * 把原始消息解析为统一结构
 * @param {object} raw 口袋48原始消息对象
 */
export function parseMessage(raw) {
  const parser = parsers[raw.msgType] || parseGeneric;
  const p = parser(raw);
  return {
    msgIdServer: Number(raw.msgIdServer),
    msgIdClient: raw.msgIdClient || '',
    msgTime: Number(raw.msgTime),
    msgType: raw.msgType,
    ...p,
    sender: extractSender(raw.extInfo),
    raw: raw  // 完整原始数据保留，供无损重建
  };
}

/** 判断消息发送者是否为成员本人（roleId 3 = 偶像） */
export function isOwnerMessage(parsed, memberOwnerId) {
  return parsed.sender?.userId === memberOwnerId;
}

export default { parseMessage, isOwnerMessage };

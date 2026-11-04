/* ============================================================
   AIXOX48 · 虚拟偶像对话网页 — 前端逻辑
   SSE 流式渲染 / 会话管理 / 手动记忆总结
   多成员预留：在 MEMBERS 里注册新成员即可
   ============================================================ */
'use strict';

/* ---------- 多成员预留：成员注册表 ----------
   未来扩展：加一行 { serverId, name, team, room }，
   取消 index.html 中 .member-select 的 hidden 即可切换。 */
const MEMBERS = {
  29266435: { name: '李婷', team: 'SNH48 Team SII', room: '听这个听听呀' },
};
const CURRENT_MEMBER = 29266435;

/* ---------- DOM ---------- */
const el = {
  convList: document.getElementById('conv-list'),
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  newChat: document.getElementById('new-chat'),
  chatTitle: document.getElementById('chat-title'),
  chatStatus: document.getElementById('chat-status'),
  typing: document.getElementById('typing'),
  memberSelect: document.getElementById('member-select'),
  menuBtn: document.getElementById('menu-btn'),
};

/* ---------- 移动端抽屉（会话列表） ---------- */
function openSidebar() { document.body.classList.add('sidebar-open'); }
function closeSidebar() { document.body.classList.remove('sidebar-open'); }
function toggleSidebar() { document.body.classList.toggle('sidebar-open'); }

/* ---------- 状态 ---------- */
const state = {
  currentConvId: null,   // null = 新会话（发第一条消息时由后端创建）
  conversations: [],
  sending: false,
  activeMsgEl: null,     // 正在流式渲染的回复气泡
};

/* ---------- 工具 ---------- */
async function api(path, options) {
  const resp = await fetch(path, options);
  if (!resp.ok) {
    let msg = `请求失败 (${resp.status})`;
    try { const j = await resp.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return resp.json();
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 会话列表 ---------- */
async function loadConversations() {
  try {
    state.conversations = await api('/api/v1/conversations');
  } catch (e) {
    state.conversations = [];
  }
  renderConversations();
}

function renderConversations() {
  el.convList.innerHTML = '';
  if (!state.conversations.length) {
    el.convList.innerHTML = '<div class="conv-empty">还没有聊天记录<br>点"新会话"开始吧</div>';
    return;
  }
  for (const c of state.conversations) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === state.currentConvId ? ' active' : '');
    item.dataset.id = c.id;

    const hasMemory = c.has_memory === 1;

    item.innerHTML = `
      <div class="conv-body">
        <div class="conv-title">${esc(c.title && c.title !== '新会话' ? c.title : '未命名会话')}</div>
        <div class="conv-meta">${fmtTime(c.updated_at)} · ${c.msg_count} 条</div>
      </div>
      <div class="conv-right">
        <button class="del-btn" data-act="del" title="删除这个会话">删除</button>
        ${hasMemory
          ? '<span class="memory-badge has">已记忆</span>'
          : `<button class="summary-btn" data-act="summary">总结</button>`}
      </div>`;

    item.addEventListener('click', (ev) => {
      if (ev.target.dataset.act === 'summary' || ev.target.dataset.act === 'del') return; // 交给按钮自己的处理器
      switchConversation(c.id);
    });

    const btn = item.querySelector('.summary-btn');
    if (btn) {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await summarizeConversation(c.id, btn);
      });
    }

    const delBtn = item.querySelector('.del-btn');
    delBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await deleteConversationById(c.id);
    });

    el.convList.appendChild(item);
  }
}

/* 删除会话：确认 → DELETE → 若删的是当前会话则回到新会话 */
async function deleteConversationById(id) {
  if (state.sending) { appendError('李婷正在回复中，稍等一下～'); return; }
  const conv = state.conversations.find((c) => c.id === id);
  const name = (conv && conv.title && conv.title !== '新会话') ? conv.title : '这个会话';
  if (!window.confirm(`确定删除「${name}」吗？\n聊天记录和记忆摘要都会被删除，无法恢复。`)) return;
  try {
    await api(`/api/v1/conversations/${id}`, { method: 'DELETE' });
  } catch (e) {
    appendError('删除失败：' + e.message);
    return;
  }
  if (state.currentConvId === id) {
    state.currentConvId = null;
    state.activeMsgEl = null;
    el.chatTitle.textContent = '新会话';
    el.chatStatus.textContent = '';
    el.messages.innerHTML = `
      <div class="welcome">
        <div class="welcome-badge">婷</div>
        <p>嗨，我是李婷～<br>在这里和我聊天吧，我会记得你说过的话。</p>
      </div>`;
  }
  await loadConversations();
}

/* ---------- 会话操作 ---------- */
function switchConversation(id) {
  if (state.sending) { appendError('李婷正在回复中，稍等一下～'); return; }
  state.currentConvId = id;
  state.activeMsgEl = null;
  setTyping(false);
  closeSidebar();
  renderConversations();

  const conv = state.conversations.find((c) => c.id === id);
  el.chatTitle.textContent = (conv && conv.title) || '会话';
  el.chatStatus.textContent = '';
  el.messages.innerHTML = '<div class="meta-note">正在加载历史…</div>';

  api(`/api/v1/conversations/${id}`)
    .then(({ conversation, messages }) => {
      renderHistory(conversation, messages);
    })
    .catch((e) => {
      el.messages.innerHTML = `<div class="error-note">加载失败：${esc(e.message)}</div>`;
    });
}

function renderHistory(conversation, messages) {
  el.chatTitle.textContent = conversation.title || '会话';
  el.messages.innerHTML = '';
  if (!messages.length) {
    el.messages.innerHTML = '<div class="welcome"><div class="welcome-badge">婷</div><p>这个会话还是空的，说点什么吧～</p></div>';
    return;
  }
  for (const m of messages) {
    appendMessage(m.role === 'user' ? 'user' : 'bot', m.content, false);
  }
  scrollBottom();
}

function newConversation() {
  if (state.sending) { appendError('李婷正在回复中，稍等一下～'); return; }
  state.currentConvId = null;
  state.activeMsgEl = null;
  setTyping(false);
  closeSidebar();
  el.chatTitle.textContent = '新会话';
  el.chatStatus.textContent = '';
  el.messages.innerHTML = `
    <div class="welcome">
      <div class="welcome-badge">婷</div>
      <p>嗨，我是李婷～<br>在这里和我聊天吧，我会记得你说过的话。</p>
    </div>`;
  el.input.value = '';
  el.input.focus();
  renderConversations();
}

/* ---------- 消息渲染 ---------- */
function appendMessage(role, text, streaming) {
  const msg = document.createElement('div');
  msg.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  msg.innerHTML = `
    <div class="avatar">${role === 'user' ? '我' : '婷'}</div>
    <div class="bubble"></div>`;
  const bubble = msg.querySelector('.bubble');
  // 显式创建文本节点：空 textContent 可能不产生节点，导致流式文本被写进光标
  const textNode = document.createTextNode(text);
  bubble.appendChild(textNode);

  if (streaming && role === 'bot') {
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    bubble.appendChild(cursor);
    state.activeMsgEl = { msg, textNode, cursor };
  }
  el.messages.appendChild(msg);
  scrollBottom();
  return { msg, textNode };
}

function appendMetaNote(text) {
  const note = document.createElement('div');
  note.className = 'meta-note';
  note.textContent = text;
  el.messages.appendChild(note);
  scrollBottom();
}

function appendError(text) {
  const note = document.createElement('div');
  note.className = 'error-note';
  note.textContent = text;
  el.messages.appendChild(note);
  scrollBottom();
}

function scrollBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

function setTyping(on) {
  el.typing.hidden = !on;
  if (on) el.messages.scrollTop = el.messages.scrollHeight;
}

/* ---------- SSE 流式对话 ---------- */
async function sendMessage() {
  const text = el.input.value.trim();
  if (!text || state.sending) return;

  state.sending = true;
  el.send.disabled = true;
  el.input.value = '';
  setTyping(true);

  appendMessage('user', text, false);
  const botMsg = appendMessage('bot', '', true);

  const payload = { message: text };
  if (state.currentConvId) payload.conversationId = state.currentConvId;

  let newConvCreated = false;
  let convIdForList = state.currentConvId;

  try {
    const resp = await fetch('/api/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok || !resp.body) {
      let msg = `请求失败 (${resp.status})`;
      try { const j = await resp.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
      throw new Error(msg);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8'); // stream:true 处理中文跨 chunk 截断
    let buf = '';

    const handleBlock = (block) => {
      let event = 'message', data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (!data) return;
      let obj;
      try { obj = JSON.parse(data); } catch { return; }

      if (event === 'meta') {
        newConvCreated = obj.isNew;
        if (obj.isNew) convIdForList = obj.conversationId;
        state.currentConvId = obj.conversationId;
        const t = text.length > 20 ? text.slice(0, 20) + '…' : text;
        el.chatTitle.textContent = t;
        if (obj.selfMemCount > 0 || obj.examplesCount > 0) {
          const parts = [];
          if (obj.selfMemCount > 0) parts.push(`她记得 ${obj.selfMemCount} 条往事`);
          if (obj.examplesCount > 0) parts.push(`参考 ${obj.examplesCount} 条风格示例`);
          appendMetaNote(parts.join(' · '));
        }
      } else if (event === 'delta') {
        botMsg.textNode.textContent += obj.text || '';
        scrollBottom();
      } else if (event === 'done') {
        if (obj.error) appendError('生成中断：' + obj.error);
      } else if (event === 'error') {
        appendError(obj.message || '出错了');
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        handleBlock(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
    }
    if (buf.trim()) handleBlock(buf);
  } catch (e) {
    botMsg.textNode.textContent = '';
    appendError(e.message || '连接失败，请确认服务已启动');
  } finally {
    // 收起光标、状态
    if (state.activeMsgEl) {
      const cur = state.activeMsgEl.cursor;
      if (cur) cur.remove();
      state.activeMsgEl = null;
    }
    state.sending = false;
    el.send.disabled = false;
    el.chatStatus.textContent = '';
    setTyping(false);
    el.input.focus();
    // 刷新会话列表（标题/时间/条数），并定位当前会话
    await loadConversations();
    if (convIdForList) {
      const item = el.convList.querySelector(`.conv-item[data-id="${convIdForList}"]`);
      if (item) item.classList.add('active');
    }
  }
}

/* ---------- 手动总结（跨会话记忆） ---------- */
async function summarizeConversation(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '总结中…'; }
  try {
    const { summary } = await api(`/api/v1/conversations/${id}/summarize`, { method: 'POST' });
    if (!summary) {
      appendError('这个会话还没有内容可总结');
    } else {
      appendMetaNote('已记住这段聊天：' + summary);
      await loadConversations();
    }
  } catch (e) {
    appendError('总结失败：' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '总结'; }
  }
}

/* ---------- 事件绑定 ---------- */
el.menuBtn.addEventListener('click', toggleSidebar);
// 移动端：点击遮罩（非侧边栏区域）关闭抽屉
document.addEventListener('click', (ev) => {
  if (!document.body.classList.contains('sidebar-open')) return;
  if (ev.target.closest('#menu-btn')) return; // 汉堡按钮自己负责开关
  if (!ev.target.closest('#sidebar')) closeSidebar();
});
// 回到桌面宽度时清除抽屉状态
window.addEventListener('resize', () => {
  if (window.innerWidth > 720) closeSidebar();
});
el.send.addEventListener('click', sendMessage);
el.newChat.addEventListener('click', newConversation);
el.input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    sendMessage();
  }
});
el.input.addEventListener('input', () => {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 120) + 'px';
});

/* ---------- 成员选择器（预留） ---------- */
(function initMembers() {
  el.memberSelect.innerHTML = '';
  for (const [sid, m] of Object.entries(MEMBERS)) {
    const opt = document.createElement('option');
    opt.value = sid;
    opt.textContent = `${m.name} · ${m.team}`;
    el.memberSelect.appendChild(opt);
  }
  el.memberSelect.value = String(CURRENT_MEMBER);
})();

/* ---------- 启动 ---------- */
loadConversations();
el.input.focus();

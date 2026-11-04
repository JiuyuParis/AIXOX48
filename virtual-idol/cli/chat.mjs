// CLI 终端试聊：node cli/chat.mjs [会话ID]
// 命令：/new 新会话  /history 查看当前会话 /summary 生成记忆摘要 /persona 查看人格 /help 帮助 /exit 退出
import { createInterface } from 'node:readline';

const BASE = process.env.IDOL_BASE || 'http://127.0.0.1:4200';

const rl = createInterface({ input: process.stdin, output: process.stdout });
let convId = process.argv[2] || null;

function prompt() {
  process.stdout.write('\n你> ');
}

function ask() {
  rl.question('', async (line) => {
    const input = line.trim();
    if (!input) return ask();

    if (input === '/exit' || input === '/quit') { console.log('再见~'); process.exit(0); }
    if (input === '/new') { convId = null; console.log('[新会话已开始]'); return ask(); }
    if (input === '/help') {
      console.log('命令: /new 新会话 /history 历史 /summary 记忆摘要 /persona 人格 /help 帮助 /exit 退出');
      return ask();
    }
    if (input === '/history') {
      if (!convId) { console.log('(尚无会话)'); return ask(); }
      try {
        const r = await fetch(`${BASE}/api/v1/conversations/${convId}`);
        const j = await r.json();
        for (const m of j.messages || []) console.log(`${m.role === 'user' ? '你' : '李婷'}: ${m.content}`);
      } catch (e) { console.log('获取历史失败:', e.message); }
      return ask();
    }
    if (input === '/persona') {
      try {
        const r = await fetch(`${BASE}/api/v1/persona`);
        const j = await r.json();
        console.log(JSON.stringify(j, null, 2).slice(0, 2500));
      } catch (e) { console.log('获取人格失败:', e.message); }
      return ask();
    }
    if (input === '/summary') {
      if (!convId) { console.log('(尚无会话)'); return ask(); }
      console.log('生成记忆摘要中…');
      try {
        const r = await fetch(`${BASE}/api/v1/conversations/${convId}/summarize`, { method: 'POST' });
        const j = await r.json();
        console.log('摘要:', j.summary || j.error);
      } catch (e) { console.log('失败:', e.message); }
      return ask();
    }

    // 正常对话（SSE 流式）
    try {
      const resp = await fetch(`${BASE}/api/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: input, conversationId: convId }),
      });
      if (!resp.ok) { console.log('请求失败:', resp.status, await resp.text().slice(0, 300)); return ask(); }
      if (!resp.body) { console.log('无响应流'); return ask(); }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      process.stdout.write('李婷> ');
      let done = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop();
        for (const ev of events) {
          const lines = ev.split('\n');
          let event = '', data = '';
          for (const l of lines) {
            if (l.startsWith('event:')) event = l.slice(6).trim();
            if (l.startsWith('data:')) data += l.slice(5).trim();
          }
          if (!data) continue;
          try {
            const j = JSON.parse(data);
            if (event === 'meta') { convId = j.conversationId; if (j.isNew) console.log(`\n[新会话 ${j.conversationId.slice(0, 8)} | 示例 ${j.examplesCount} 条 | 向量 ${j.vectorUsed}]`); }
            else if (event === 'delta') process.stdout.write(j.text);
            else if (event === 'error') console.log(`\n[错误] ${j.message}`);
            else if (event === 'done' && j.error) console.log(`\n[生成失败] ${j.error}`);
          } catch { /* 忽略 */ }
        }
        done = d;
      }
      process.stdout.write('\n');
    } catch (e) {
      console.log('\n对话失败（服务未启动？）:', e.message);
    }
    ask();
  });
}

console.log('=== 虚拟李婷 · 终端试聊 ===');
console.log(`服务: ${BASE} | 会话: ${convId || '（新会话）'} | 输入 /help 看命令`);
ask();

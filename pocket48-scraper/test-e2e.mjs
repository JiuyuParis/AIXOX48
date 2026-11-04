// 端到端测试：添加成员 → 增量同步 → 查询 → 统计 → 全量回溯
const BASE = 'http://127.0.0.1:4100';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('===== 1. 添加成员: 李婷 =====');
const added = await api('POST', '/api/v1/members', { keyword: '李婷' });
console.log('成员:', JSON.stringify(added.member));

console.log('\n===== 2. 增量同步（首次=拉最新） =====');
const sync1 = await api('POST', `/api/v1/members/${added.member.server_id}/sync`, { mode: 'incremental' });
console.log('结果:', JSON.stringify(sync1));

console.log('\n===== 3. 查询消息（前5条结构化） =====');
const msgs = await api('GET', `/api/v1/members/${added.member.server_id}/messages?limit=5`);
console.log('总数:', msgs.total);
for (const m of msgs.messages) {
  console.log(`  [${m.msgType}] ${m.text.slice(0, 40)} | 发送者:${m.sender.nickName} | 时间:${new Date(m.msgTime).toLocaleString()}`);
}

console.log('\n===== 4. 成员列表 =====');
const members = await api('GET', '/api/v1/members');
for (const m of members.members) {
  console.log(`  ${m.name} (serverId=${m.server_id}): 共 ${m.stats.total} 条, 类型:`, JSON.stringify(m.stats.byType));
}

console.log('\n===== 5. 全量回溯（拉历史，先限制5页验证） =====');
const backfill = await api('POST', `/api/v1/members/${added.member.server_id}/sync`, { mode: 'backfill', pages: 5 });
console.log('结果:', JSON.stringify(backfill));

console.log('\n===== 6. 增量同步（再次运行=应新增0条） =====');
const sync2 = await api('POST', `/api/v1/members/${added.member.server_id}/sync`, { mode: 'incremental' });
console.log('结果:', JSON.stringify(sync2));

console.log('\n===== 7. 统计 =====');
const stats = await api('GET', `/api/v1/members/${added.member.server_id}/stats`);
console.log('统计:', JSON.stringify(stats.stats));

console.log('\n===== 8. 健康检查 =====');
const health = await api('GET', '/health');
console.log('全局:', `成员${health.totalMembers}个, 消息${health.totalMessages}条`);

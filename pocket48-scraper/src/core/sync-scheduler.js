/**
 * 增量更新调度器
 * 定期对已登记成员做增量同步（默认 5 分钟一轮）
 * 可启停、可查询状态
 */
import config from '../config.js';
import db from '../db/database.js';
import crawler from './message-crawler.js';

class SyncScheduler {
  constructor() {
    this.timer = null;
    this.running = false;
    this.lastRunAt = 0;
    this.lastRunSummary = [];
    this.runs = 0;
  }

  start() {
    if (this.timer) return;
    const interval = config.scheduler.syncIntervalMs;
    console.log(`[scheduler] 增量同步调度已启动，周期 ${Math.round(interval / 1000)} 秒`);
    this.timer = setInterval(() => this.runOnce(), interval);
    this.timer.unref?.(); // 不阻塞进程退出
    // 启动后立即跑一轮
    this.runOnce();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    console.log('[scheduler] 增量同步调度已停止');
  }

  async runOnce() {
    if (this.running) { console.log('[scheduler] 上一轮尚未结束，跳过'); return; }
    this.running = true;
    const members = db.listMembers();
    console.log(`[scheduler] 开始增量同步：${members.length} 个成员`);
    try {
      const summary = await crawler.syncAllIncremental();
      this.lastRunSummary = summary;
      this.lastRunAt = Date.now();
      this.runs++;
      const totalAdded = summary.reduce((s, r) => s + (r.added || 0), 0);
      console.log(`[scheduler] 本轮完成：新增 ${totalAdded} 条`);
    } catch (e) {
      console.error('[scheduler] 本轮同步异常:', e.message);
    } finally {
      this.running = false;
    }
  }

  status() {
    return {
      enabled: !!this.timer,
      running: this.running,
      runs: this.runs,
      lastRunAt: this.lastRunAt,
      lastRunSummary: this.lastRunSummary,
      intervalMs: config.scheduler.syncIntervalMs
    };
  }
}

export default new SyncScheduler();

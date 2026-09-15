// 定时同步调度：每 60s 检查一次，命中 hourly / daily 规则则触发同步
"use strict";
const sync = require("./sync.cjs");
const db = require("./db.cjs");

let timer = null;
let lastHourlyAt = 0;
let lastDailyAt = ""; // "YYYY-MM-DD"
let paused = false;

/** 触发时间持久化到 meta 表：重启后不重置，避免启动即同步/当天 daily 重复补跑 */
function rememberLast(kind, value) {
  try {
    db.setMeta(`sched_last_${kind}`, String(value));
  } catch {
    /* 持久化失败仅意味着重启后可能多跑一次，不影响正确性 */
  }
}

function setPaused(v) {
  paused = !!v;
}

function isPaused() {
  return paused;
}

/** 命中判断 + 触发，返回是否触发 */
function shouldRun(cfg) {
  if (!cfg.schedule) return false;
  const now = Date.now();

  // 每小时
  if (cfg.schedule.hourly) {
    const interval = Math.max(1, cfg.schedule.hourlyInterval || 1);
    // 系统时间回拨（NTP 校正/手动调慢）时重置基准，避免差值虚大导致立即误触发
    if (now < lastHourlyAt) lastHourlyAt = now;
    if (now - lastHourlyAt >= interval * 60 * 60 * 1000) {
      lastHourlyAt = now;
      rememberLast("hourly", now);
      return true;
    }
  }

  // 每天固定时间
  if (cfg.schedule.daily && cfg.schedule.dailyTime) {
    const [h, m] = cfg.schedule.dailyTime.split(":").map((x) => parseInt(x, 10));
    if (!Number.isNaN(h) && !Number.isNaN(m)) {
      const d = new Date(now);
      const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      // 追赶式补跑：错过设定时刻（睡眠/关机/卡顿）后，当天内首次 tick 仍会补跑一次
      if (today !== lastDailyAt && d.getHours() * 60 + d.getMinutes() >= h * 60 + m) {
        lastDailyAt = today;
        rememberLast("daily", today);
        return true;
      }
    }
  }
  return false;
}

function getConfig() {
  // 延迟 require 避免循环依赖
  const config = require("./sync-config.cjs");
  return config.loadConfig();
}

function tick() {
  try {
    if (paused) return;
    // 同步/恢复进行中先跳过：shouldRun 一旦命中就会推进记账，先调它会把这次
    // daily/hourly 触发静默丢弃（daily 当天不再补跑）。先挡 running/restoring，让命中
    // 条件在下一 tick 依然成立，结束后自然补跑。未配置 WebDAV 时触发的 run 即自动备份。
    const p = sync.progress();
    if (p.running || p.restoring) return;
    const cfg = getConfig();
    if (shouldRun(cfg)) {
      sync.run(cfg).catch(() => {});
    }
  } catch {
    /* 调度异常静默，下一轮重试 */
  }
}

function start() {
  if (timer) return;
  // 恢复上次触发时间：重启后接着原节奏调度，而不是立刻补跑
  try {
    const h = Number(db.getMeta("sched_last_hourly"));
    if (Number.isFinite(h) && h > 0) lastHourlyAt = h;
    const d = db.getMeta("sched_last_daily");
    if (d) lastDailyAt = d;
  } catch {
    /* 读取失败按默认值（首次启动视为从未触发） */
  }
  timer = setInterval(tick, 60 * 1000);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, setPaused, isPaused, shouldRun };

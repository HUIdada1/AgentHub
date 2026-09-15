// 定时跨设备同步调度：每 60s 检查一次，命中 hourly / daily 规则则触发 WebDAV 同步
// 触发时间记账存 remote-state.json（本项目没有 meta 表），重启后接着原节奏，不启动即同步
"use strict";
const remotesync = require("./remotesync.cjs");

let timer = null;
let paused = false;

function setPaused(v) {
  paused = !!v;
}

function isPaused() {
  return paused;
}

/** 命中判断 + 触发，返回是否触发 */
function shouldRun(cfg, rstate) {
  const s = cfg.schedule;
  if (!s) return false;
  const now = Date.now();

  // 每小时（固定 1 小时间隔；系统时间回拨时重置基准，避免差值虚大立即误触发）
  if (s.hourly) {
    const last = rstate.sched.lastHourlyAt || 0;
    if (now < last) rstate.sched.lastHourlyAt = now;
    else if (now - last >= 60 * 60 * 1000) {
      rstate.sched.lastHourlyAt = now;
      return true;
    }
  }

  // 每天固定时间：错过设定时刻（睡眠/关机）后，当天内首次 tick 仍会补跑一次
  if (s.daily && s.dailyTime) {
    const [h, m] = String(s.dailyTime).split(":").map((x) => parseInt(x, 10));
    if (!Number.isNaN(h) && !Number.isNaN(m)) {
      const d = new Date(now);
      const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (rstate.sched.lastDailyDate !== today && d.getHours() * 60 + d.getMinutes() >= h * 60 + m) {
        rstate.sched.lastDailyDate = today;
        return true;
      }
    }
  }
  return false;
}

function tick() {
  try {
    if (paused) return;
    // 同步进行中先跳过且不推进记账，让命中条件在下一 tick 依然成立，结束后自然补跑
    if (remotesync.isRunning()) return;
    const config = require("./config.cjs"); // 延迟 require 避免循环依赖
    const cfg = config.loadConfig();
    if (!remotesync.configured(cfg)) return; // 没配 WebDAV 不触发
    const rstate = remotesync.loadRemoteState();
    if (shouldRun(cfg, rstate)) {
      remotesync.saveRemoteState(rstate); // 先记账再触发，触发后立刻崩溃也不会当天/当小时反复补跑
      remotesync.run(cfg).catch(() => {});
    }
  } catch {
    /* 调度异常静默，下一轮重试 */
  }
}

function start() {
  if (timer) return;
  // 首 tick 延后 90s：给启动留时间，也避免开机自启后网络未就绪就白跑
  timer = setTimeout(() => {
    tick();
    timer = setInterval(tick, 60 * 1000);
  }, 90 * 1000);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = { start, stop, setPaused, isPaused, shouldRun };

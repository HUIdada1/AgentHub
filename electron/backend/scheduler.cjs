/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 定时跨设备同步与技能健康全自动巡检调度：每 60s 检查一次
// 1. 跨设备 WebDAV 同步（命中 hourly / daily 规则触发）
// 2. 技能仓库全自动健康巡检（命中 dailyCheck 规则触发各渠道自动检测与修复）
"use strict";
const remotesync = require("./remotesync.cjs");
const skillsDailyCheck = require("./skills-daily-check.cjs");

let timer = null;
let paused = false;
let lastDailyCheckDate = "";

function setPaused(v) {
  paused = !!v;
}

function isPaused() {
  return paused;
}

/** 命中判断 + 触发，返回是否触发。hourly/daily 同一 tick 同时命中只触发一次（两条记账一起推进） */
function shouldRun(cfg, rstate) {
  const s = cfg.schedule;
  if (!s) return false;
  const now = Date.now();
  let hit = false;

  // 每小时（固定 1 小时间隔；系统时间回拨时重置基准，避免差值虚大立即误触发）
  if (s.hourly) {
    const last = rstate.sched.lastHourlyAt || 0;
    if (now < last) rstate.sched.lastHourlyAt = now;
    else if (now - last >= 60 * 60 * 1000) {
      rstate.sched.lastHourlyAt = now;
      hit = true;
    }
  }

  // 每天固定时间：错过设定时刻（睡眠/关机）后，当天内首次 tick 仍会补跑一次。
  if (s.daily && s.dailyTime) {
    const [h, m] = String(s.dailyTime).split(":").map((x) => parseInt(x, 10));
    if (!Number.isNaN(h) && !Number.isNaN(m)) {
      const d = new Date(now);
      const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (rstate.sched.lastDailyDate !== today && d.getHours() * 60 + d.getMinutes() >= h * 60 + m) {
        rstate.sched.lastDailyDate = today;
        hit = true;
      }
    }
  }
  return hit;
}

function tick() {
  try {
    if (paused) return;
    const config = require("./config.cjs"); // 延迟 require 避免循环依赖
    const cfg = config.loadConfig();

    // 1. 技能仓库：每日全自动健康检测与流程优化
    if (cfg.schedule && cfg.schedule.dailyCheck !== false) {
      const checkTime = cfg.schedule.dailyCheckTime || "09:00";
      const [h, m] = String(checkTime).split(":").map((x) => parseInt(x, 10));
      if (!Number.isNaN(h) && !Number.isNaN(m)) {
        const d = new Date();
        const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
        if (lastDailyCheckDate !== today && d.getHours() * 60 + d.getMinutes() >= h * 60 + m) {
          lastDailyCheckDate = today;
          try {
            skillsDailyCheck.runDailyCheck(cfg);
          } catch {
            /* 巡检异常静默 */
          }
        }
      }
    }

    // 2. 跨设备 WebDAV 同步
    if (!remotesync.isRunning() && remotesync.configured(cfg)) {
      const rstate = remotesync.loadRemoteState();
      if (shouldRun(cfg, rstate)) {
        remotesync.saveRemoteState(rstate);
        remotesync.run(cfg).catch(() => {});
      }
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

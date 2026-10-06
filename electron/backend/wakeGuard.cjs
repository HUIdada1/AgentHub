// 休眠唤醒守卫（wake guard）：避免「唤醒瞬间所有逾期定时任务集中爆发」
//
// ## 问题（2026-10-06 实测定位）
// 机器 03:38:42 进入 Modern Standby，09:04:08 唤醒。定时器在睡眠期间**不触发、不累积**，
// 唤醒后立刻到期 → 同一时刻涌入：
//   · checkinAutoTick 的全渠道签到（16 账号串行 + 800~2000ms 抖动 ≈ 20~30 秒）
//   · credits.startScheduler 的全量额度刷新（30 分钟链逾期）
//   · memory scheduler 的 extract/summarize/tag（30 分钟链逾期）
// 叠加 Chromium 会话/GPU 恢复，用户感知为「启动/唤醒后卡了一会」。
//
// 实测排除：各操作的同步成本都极小（JSON.parse 1.4ms / stringify 3.4ms /
// 全 16 账号 DPAPI 解密 0.7ms），所以「卡」不是某个重活，而是**多任务在唤醒瞬间收敛**。
//
// ## 对策
//   A. 唤醒后 15 秒「静默窗」：周期任务一律跳过本轮（下一轮自然重试）
//   C. 签到额外要求「应用已连续唤醒 ≥ 30 秒」才允许触发
//
// ## ⚠ 已知局限（如实记录）
// A/C 依赖 Electron `powerMonitor` 的 `resume` 事件。Windows **Modern Standby**（S0 低功耗待机）
// 是否派发 PBT_APMRESUMEAUTOMATIC 尚无定论——若该事件不派发，本守卫不会生效。
// 故本模块**把 suspend/resume 事件写进 crash.log**，供下次实际睡眠后在日志中核实；
// 若证实不派发，应补「时间跳跃检测」（tick 间隔远大于预期间隔即视为刚唤醒）作为兜底。
//
// 本模块不依赖 electron 之外的东西；`start()` 未调用时，所有判定退化为「不拦截」，
// 使纯 Node 环境（自测/脚本）行为与改动前一致。
"use strict";

/** A：唤醒后的静默窗时长 */
const QUIET_MS = 15000;
/** C：签到要求的最小「连续唤醒」时长 */
const CHECKIN_MIN_AWAKE_MS = 30000;

/** 进程启动时刻：从未收到 resume 时，以它作为「清醒起点」 */
const STARTED_AT = Date.now();

/** 最近一次 resume 的时刻（0 = 从未收到过） */
let lastResumeAt = 0;
/** 最近一次 suspend 的时刻（0 = 从未收到过） */
let lastSuspendAt = 0;
let started = false;
/** 事件留痕用（可注入，默认丢弃） */
let logFn = null;

/** 记录一次唤醒（真实 powerMonitor 回调与自测都会走这里） */
function noteResume(at) {
  lastResumeAt = Number(at) || Date.now();
}

/** 记录一次休眠 */
function noteSuspend(at) {
  lastSuspendAt = Number(at) || Date.now();
}

/** 「连续唤醒」起点：有 resume 则从 resume 算，否则从进程启动算 */
function awakeSince() {
  return lastResumeAt || STARTED_AT;
}

/** 已连续唤醒多少毫秒 */
function awakeMs(now) {
  return (Number(now) || Date.now()) - awakeSince();
}

/** A：是否处于唤醒后的静默窗内 */
function inQuietWindow(now) {
  if (!lastResumeAt) return false; // 从未 resume → 不是刚唤醒
  return (Number(now) || Date.now()) - lastResumeAt < QUIET_MS;
}

/**
 * C：签到是否允许触发。
 * 与 inQuietWindow 分开的原因：静默窗只有 15 秒，而签到批量可能持续 20~30 秒且带抖动，
 * 唤醒后 15 秒就开跑仍会与「Chromium 恢复 + 用户刚开始操作」重叠，故签到门槛更高（30 秒）。
 */
function checkinAllowed(now) {
  if (inQuietWindow(now)) return false;
  return awakeMs(now) >= CHECKIN_MIN_AWAKE_MS;
}

/** 周期任务（额度刷新 / 记忆中枢）是否允许触发：只受静默窗约束 */
function periodicAllowed(now) {
  return !inQuietWindow(now);
}

/**
 * 注册 powerMonitor 监听。
 * @param {object} opts { powerMonitor, log }  log(kind, detail) 可选，用于留痕
 * @returns {{ok:boolean, message?:string}}
 */
function start(opts) {
  if (started) return { ok: true, message: "已在监听" };
  const pm = opts && opts.powerMonitor;
  if (!pm || typeof pm.on !== "function") return { ok: false, message: "powerMonitor 不可用（非 Electron 环境？）" };
  logFn = typeof (opts && opts.log) === "function" ? opts.log : null;
  const note = (kind, detail) => {
    if (logFn) {
      try { logFn(kind, detail); } catch { /* 留痕失败不影响主流程 */ }
    }
  };
  try {
    // resume 后要重排的任务由各自 tick 自行判断（本模块只提供时间基准）
    pm.on("resume", () => {
      noteResume();
      note("power-resume", `唤醒：静默窗 ${QUIET_MS}ms，签到门槛 ${CHECKIN_MIN_AWAKE_MS}ms`);
    });
    pm.on("suspend", () => {
      noteSuspend();
      note("power-suspend", "进入休眠/待机");
    });
    // 锁屏/解锁不属于睡眠，但解锁时刻用户即将操作：不设静默窗，只留痕便于排查
    if (typeof pm.on === "function") {
      try {
        pm.on("unlock-screen", () => note("power-unlock", "解锁屏幕"));
      } catch { /* 平台不支持则忽略 */ }
    }
    started = true;
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `监听注册失败：${(e && e.message) || e}` };
  }
}

function stop() {
  started = false;
  logFn = null;
}

module.exports = {
  QUIET_MS,
  CHECKIN_MIN_AWAKE_MS,
  start,
  stop,
  noteResume,
  noteSuspend,
  awakeMs,
  awakeSince,
  inQuietWindow,
  checkinAllowed,
  periodicAllowed,
  /** 自测用：观察内部状态（lastResumeAt/lastSuspendAt/started） */
  __state: () => ({ lastResumeAt, lastSuspendAt, started, startedAt: STARTED_AT }),
};
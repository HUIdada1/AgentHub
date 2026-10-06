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
//   B. **时间跳跃检测（兜底）**：周期任务每次 tick 上报「距上次 tick 的实际间隔」；
//      若该间隔远大于自身预期间隔，说明期间定时器被冻结过（睡眠/挂起），**推定刚唤醒**，
//      同样置静默窗并跳过本轮。B 不依赖任何电源事件，**是 A/C 的唯一可靠兜底**。
//   C. 签到额外要求「应用已连续唤醒 ≥ 30 秒」才允许触发
//
// ## A 是否真的生效：已实测（2026-10-06，tools/probe-power-resume.cjs）
// 先前的疑问是「Windows **Modern Standby**（S0 低功耗待机）是否派发 PBT_APMRESUMEAUTOMATIC」，
// 若不派发则仅靠 A/C 会**静默失效**。用独立探针实测本机（主动睡眠 2 分 40 秒），三条证据对齐：
//
//   探针 event:lock-screen  07:24:13Z (15:24:13 本地)  ↔  系统 Kernel-Power 506 进入 Modern Standby
//   探针 event:suspend      07:24:13Z                  ↔  同上
//   探针 event:resume       07:26:53Z (15:26:53 本地)  ↔  系统 Kernel-Power 507 退出（15:26:51）
//   探针 heartbeat-gap      墙钟跳跃 157s               ↔  实际睡眠 158s
//   （resume 回调比系统事件晚约 2 秒，属正常派发延迟）
//
// ⇒ **本机 Modern Standby 确实派发 suspend 与 resume，A（与 C）生效。**
//
// 但 B 仍然保留，理由不是「A 可能失效」这一条，而是 B 覆盖更广的冻结情形：
//   · 其它平台/发行版/电源策略下 resume 未必派发；
//   · 进程被 OS 挂起（PLM/AppContainer 冻结）后未收到 resume 就开始跑；
//   · 主进程被长时间同步阻塞（等价的「定时器冻结」）后补偿跑。
// 即：A 精确但依赖事件，B 粗糙但不依赖任何外部信号，两者互补才叫双保险。
//
// suspend/resume 仍写进 crash.log（便于事后核对 A 是否在用户机器上生效）；
// 需要重新实测时用 tools/probe-power-resume.cjs。
//
// ## 两种信号的阈值取法
//   A：（事件驱动）唤醒后固定 15 秒静默窗——精确，但只在事件派发时有效
//   B：（间隔驱动）实际间隔 > max(90s, 预期间隔 + 60s) 即判为跳跃——宁可偶尔多跳一轮，
//      因为「多跳一轮」的代价只是延后一个周期（各任务按自身 lastRun 判到期，不会漏做），
//      而漏判的代价是唤醒瞬间多任务收敛、用户可感知卡顿。假阳性无害，故取偏敏感口径。
//      注：短睡（如实测的 2 分 40 秒）只会被 60s 周期任务（签到/记忆中枢）判为跳跃；
//      30min 周期的额度刷新阈值是 31min，短睡不触发——而它的逾期恰恰要靠 A 兜住，
//      这正说明 A 与 B 缺一不可。
//
// 本模块不依赖 electron 之外的东西；`start()` 未调用时，所有判定退化为「不拦截」，
// 使纯 Node 环境（自测/脚本）行为与改动前一致。
"use strict";

/** A：唤醒后的静默窗时长 */
const QUIET_MS = 15000;
/** C：签到要求的最小「连续唤醒」时长 */
const CHECKIN_MIN_AWAKE_MS = 30000;
/** B：时间跳跃判定的绝对下限（预期间隔很短时的兜底阈值） */
const JUMP_MIN_MS = 90000;
/** B：时间跳跃判定相对预期间隔的宽限（超过预期间隔这么多即判为跳跃） */
const JUMP_SLACK_MS = 60000;

/** 进程启动时刻：从未收到 resume 时，以它作为「清醒起点」 */
const STARTED_AT = Date.now();

/** 最近一次 resume 的时刻（0 = 从未收到过） */
let lastResumeAt = 0;
/** 最近一次 suspend 的时刻（0 = 从未收到过） */
let lastSuspendAt = 0;
let started = false;
/** 事件留痕用（可注入，默认丢弃） */
let logFn = null;
/** B：各周期任务的上次 tick 时刻（key → 毫秒时间戳） */
const lastTickAt = new Map();

/** 记录一次唤醒（真实 powerMonitor 回调与自测都会走这里） */
function noteResume(at) {
  lastResumeAt = Number(at) || Date.now();
}

/** 记录一次休眠 */
function noteSuspend(at) {
  lastSuspendAt = Number(at) || Date.now();
}

/**
 * B：时间跳跃检测（不依赖电源事件的兜底）。
 *
 * 周期任务在**每次 tick 的最开头**调用本函数，把「距上次 tick 的实际间隔」交给守卫：
 * 若间隔远大于自身预期间隔，说明期间定时器被冻结（睡眠/挂起），推定刚唤醒 →
 * 置静默窗（等价于收到一次 resume），使**本轮被 A/C 拦下**，下一轮自然恢复。
 *
 * ⚠ 调用顺序要求：必须在 A/C 的判定**之前**调用，否则本轮不会被拦。
 *
 * @param {string} key 任务标识（各任务独立计时）
 * @param {number} expectedMs 该任务的预期间隔（毫秒）
 * @param {number} [now] 当前时刻（自测可注入，默认 Date.now()）
 * @returns {{jump:boolean, gapMs:number}} jump=true 表示检测到跳跃
 */
function noteTick(key, expectedMs, now) {
  const t = Number(now) || Date.now();
  const k = String(key || "default");
  const last = lastTickAt.get(k) || 0;
  lastTickAt.set(k, t);
  if (!last) return { jump: false, gapMs: 0 }; // 首次 tick 无参照，不判跳跃（含启动后首轮）
  const gapMs = t - last;
  const expected = Math.max(1000, Number(expectedMs) || 0);
  // 双条件取大：既覆盖短周期（绝对下限 90s），也覆盖长周期（预期间隔 + 60s 宽限）
  const threshold = Math.max(JUMP_MIN_MS, expected + JUMP_SLACK_MS);
  if (gapMs > threshold) {
    lastResumeAt = t; // 与真实 resume 同效：进入静默窗 + 重置「连续唤醒」计时
    if (logFn) {
      try {
        logFn(
          "power-resume-inferred",
          `未收到 resume 事件，但「${k}」的 tick 间隔 ${Math.round(gapMs / 1000)}s ≫ 预期 ${Math.round(expected / 1000)}s（阈值 ${Math.round(threshold / 1000)}s）→ 推定刚唤醒，本轮跳过`
        );
      } catch { /* 留痕失败不影响判定 */ }
    }
    return { jump: true, gapMs };
  }
  return { jump: false, gapMs };
}

/** 自测用：清空 B 的 tick 计时（不影响 A/C 状态） */
function resetTicks() {
  lastTickAt.clear();
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
  JUMP_MIN_MS,
  JUMP_SLACK_MS,
  start,
  stop,
  noteResume,
  noteSuspend,
  noteTick,
  resetTicks,
  awakeMs,
  awakeSince,
  inQuietWindow,
  checkinAllowed,
  periodicAllowed,
  /** 自测用：观察内部状态（lastResumeAt/lastSuspendAt/started/tick 数） */
  __state: () => ({ lastResumeAt, lastSuspendAt, started, startedAt: STARTED_AT, ticks: lastTickAt.size }),
};

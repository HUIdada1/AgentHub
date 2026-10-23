/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-23
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 *  ============================================================
 */
// 提示词库 · 定时同步调度
//
// 骨架严格照 electron/backend/proxy/poolsched.cjs —— 那是本仓最成熟的一份（踩过的坑都写在注释里）：
//   1) 60s tick，与其它三个调度器同频；
//   2) **持久化记账**：重启后接着原节奏，绝不「一启动就同步一次」；
//   3) **时间回拨保护**：用户改系统时间/时区后，差值虚大会导致立即误触发；
//   4) **忙时跳过且不推进记账**：与其它板块撞车时白丢一个周期是最亏的；
//   5) **失败回滚记账**：失败不能吞掉整个周期；且 sync.run() 在 busy/被拒时是 **throw**
//      而不是返回 ok:false，所以回滚必须同时挂到 catch 上；
//   6) **周期钳制** 1~24 小时：脏配置不得传到调度判断；
//   7) 未配置 WebDAV 不触发。
"use strict";
const config = require("../config.cjs");
const webdav = require("../webdav.cjs");
const sync = require("./sync.cjs");

let timer = null;
let firstTick = null;

/** 周期配置：非法值回默认 4，钳制到 1~24（配置侧已归一化，这里是第二道兜底） */
function schedCfg() {
  const p = (config.loadConfig().prompts) || {};
  return {
    auto: p.syncAuto !== false,
    intervalHours: Math.min(24, Math.max(1, Math.floor(Number(p.syncIntervalHours) || 4))),
  };
}

function tick() {
  try {
    const c = schedCfg();
    if (!c.auto) return;                                   // 用户关了自动同步
    if (webdav.syncBusyTag()) return;                      // 其它模块同步中：不推进记账，结束后下轮补跑
    if (!sync.configured()) return;                        // 没配 WebDAV 不触发
    if (sync.isRunning()) return;                          // 自己正在跑：同上，不推进记账

    const state = sync.loadState();
    const now = Date.now();
    const last = Number(state.sched && state.sched.lastHourlyAt) || 0;
    // 时间回拨保护：把基准拉回现在，避免「差值虚大」立刻误触发
    if (last && now < last) {
      state.sched = { ...(state.sched || {}), lastHourlyAt: now };
      sync.saveState(state);
      return;
    }
    // 首次运行（记账为 0）：把基准设为现在，等满一个周期再跑 —— 避免刚装好就上传
    if (!last) {
      state.sched = { ...(state.sched || {}), lastHourlyAt: now };
      sync.saveState(state);
      return;
    }
    if (now - last < c.intervalHours * 3600 * 1000) return;

    // 先记账再触发：触发后立刻崩溃也不会在同一周期内反复补跑
    state.sched = { ...(state.sched || {}), lastHourlyAt: now };
    sync.saveState(state);

    const rollback = () => {
      // 回滚到「差 60s 就到期」：下一 tick（60s 后）会重新命中并重试
      const s2 = sync.loadState();
      s2.sched = { ...(s2.sched || {}), lastHourlyAt: now - c.intervalHours * 3600 * 1000 + 60 * 1000 };
      sync.saveState(s2);
    };
    // sync.run() 在被拒（tryBeginSync 失败）与已在运行时是 throw，不是 ok:false，
    // 所以回滚必须同时挂 catch，否则这两条路径会把整个周期静默吞掉
    sync.run().then((r) => {
      if (r && r.ok !== false) return;
      rollback();
    }).catch(rollback);
  } catch {
    /* 调度异常静默，下一轮重试 */
  }
}

function start() {
  if (timer) return;
  // 首 tick 延后 90s：给启动留时间，也避免开机自启后网络未就绪就白跑（与 scheduler.cjs 同口径）
  firstTick = setTimeout(() => {
    tick();
    timer = setInterval(tick, 60 * 1000);
  }, 90 * 1000);
}

function stop() {
  if (firstTick) { clearTimeout(firstTick); firstTick = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick, schedCfg };

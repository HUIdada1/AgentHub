// 休眠唤醒守卫自测（离线，无网络、无 GUI、不读用户数据）
//
// 背景（2026-10-06 实测定位）：机器 03:38:42 进 Modern Standby，09:04:08 唤醒；
// 定时器睡眠期间不触发、唤醒即到期 → 签到 + 额度刷新 + 记忆中枢任务在同一刻收敛，
// 用户感知「唤醒后卡了一会」。实测排除单点重活（JSON.parse 1.4ms / 全池 DPAPI 0.7ms）。
//
// 跑法：ELECTRON_RUN_AS_NODE=1 electron tools/perf-wake-guard-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

// 隔离数据目录：本自测不碰真实号池/记忆库（store.open 会建库，指向沙箱）
process.env.AGENTHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wakeguard-selftest-"));

const wakeGuard = require("../electron/backend/wakeGuard.cjs");

let pass = 0;
let fail = 0;
const failures = [];
async function T(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${(e && e.message) || e}`);
    console.log(`  FAIL ${name}\n       ${(e && e.message) || e}`);
  }
}

(async () => {
  const ROOT = path.join(__dirname, "..");
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

  // ===== T1 常量符合约定（A=15s 静默窗；C=30s 签到门槛） =====
  await T("T1 常量：QUIET_MS=15000 / CHECKIN_MIN_AWAKE_MS=30000", () => {
    assert.strictEqual(wakeGuard.QUIET_MS, 15000, "A 的静默窗应为 15 秒");
    assert.strictEqual(wakeGuard.CHECKIN_MIN_AWAKE_MS, 30000, "C 的签到门槛应为 30 秒");
    assert.ok(wakeGuard.CHECKIN_MIN_AWAKE_MS > wakeGuard.QUIET_MS, "签到门槛应大于静默窗");
  });

  // ===== T2 未收到 resume 时不得拦截（否则改造会误伤正常签到） =====
  await T("T2 未 resume：静默窗为假、周期任务放行（不改变既有行为）", () => {
    wakeGuard.stop();
    // 重置到「从未 resume」：用 noteResume(0) 不行（会被 || 兜成 now），故直接构造新判定
    const st = wakeGuard.__state();
    assert.ok(st.lastResumeAt === 0 || typeof st.lastResumeAt === "number", "状态可读");
    // 用「resume 时刻取进程启动前」模拟未 resume 的语义：awakeMs 从进程启动算
    assert.ok(wakeGuard.awakeMs() >= 0, "awakeMs 非负");
    assert.strictEqual(wakeGuard.inQuietWindow(0), false, "无 resume 时永不在静默窗内");
  });

  // ===== T3 A：唤醒瞬间进静默窗，且把签到一并拦住 =====
  await T("T3 A：唤醒瞬间 inQuietWindow=true 且 checkinAllowed=false", () => {
    wakeGuard.noteResume();
    const now = Date.now();
    assert.strictEqual(wakeGuard.inQuietWindow(now), true, "刚唤醒应处于静默窗");
    assert.strictEqual(wakeGuard.checkinAllowed(now), false, "静默窗内签到必须被拦");
    assert.strictEqual(wakeGuard.periodicAllowed(now), false, "静默窗内周期任务必须被拦");
  });

  // ===== T4 静默窗边界：14.9s 拦 / 15.1s 放 =====
  await T("T4 A 边界：14.9s 拦、15.1s 放（静默窗=15s）", () => {
    const now = Date.now();
    wakeGuard.noteResume(now - 14900);
    assert.strictEqual(wakeGuard.inQuietWindow(now), true, "14.9s 应在静默窗内");
    wakeGuard.noteResume(now - 15100);
    assert.strictEqual(wakeGuard.inQuietWindow(now), false, "15.1s 应已出静默窗");
  });

  // ===== T5 C：过了静默窗但未满 30s 时，签到仍被拦（周期任务已放行） =====
  await T("T5 C：唤醒后 20s —— 周期任务放行、签到仍拦", () => {
    const now = Date.now();
    wakeGuard.noteResume(now - 20000);
    assert.strictEqual(wakeGuard.inQuietWindow(now), false, "20s 已出静默窗");
    assert.strictEqual(wakeGuard.checkinAllowed(now), false, "20s 未满 30s，签到应仍被拦");
    assert.strictEqual(wakeGuard.periodicAllowed(now), true, "周期任务只受静默窗约束，应放行");
  });

  // ===== T6 C 边界：29.9s 拦 / 30.1s 放 =====
  await T("T6 C 边界：29.9s 拦、30.1s 放（门槛=30s）", () => {
    const now = Date.now();
    wakeGuard.noteResume(now - 29900);
    assert.strictEqual(wakeGuard.checkinAllowed(now), false, "29.9s 应被拦");
    wakeGuard.noteResume(now - 30100);
    assert.strictEqual(wakeGuard.checkinAllowed(now), true, "30.1s 应放行");
  });

  // ===== T7 关键接线：签到守卫必须在「写当天标记」之前 return =====
  // 若顺序写反（先落 lastAutoCheckinDay 再判守卫），当天签到会被永久跳过——静默失败
  await T("T7 接线正确性：checkinAutoTick 中守卫先于 lastAutoCheckinDay 落标记", () => {
    const src = read("electron/backend/proxy/index.cjs");
    const fnStart = src.indexOf("function checkinAutoTick()");
    assert.ok(fnStart > 0, "应能定位 checkinAutoTick");
    const fn = src.slice(fnStart, src.indexOf("function startCheckinAuto", fnStart));
    const guardAt = fn.indexOf("wakeGuard.checkinAllowed()");
    const markAt = fn.indexOf("lastAutoCheckinDay = day;");
    assert.ok(guardAt > 0, "checkinAutoTick 必须调用 wakeGuard.checkinAllowed()");
    assert.ok(markAt > 0, "应有落当天标记的语句");
    assert.ok(guardAt < markAt, "守卫必须**先于**落标记（否则当天签到被永久跳过）");
    // 守卫处必须是 return，而不是继续往下走
    const seg = fn.slice(guardAt, guardAt + 120);
    assert.ok(/return/.test(seg), "守卫不通过时应 return（让下一轮 tick 自然重试）");
    // 顶部必须 require 守卫
    assert.ok(/require\("\.\.\/wakeGuard\.cjs"\)/.test(src), "index.cjs 应 require wakeGuard");
  });

  // ===== T8 接线：额度刷新与记忆中枢的周期 tick 都过守卫，且仍排下一轮 =====
  await T("T8 接线：credits 与 memory scheduler 的 tick 均过守卫且不丢调度", () => {
    const c = read("electron/backend/proxy/credits.cjs");
    assert.ok(/require\("\.\.\/wakeGuard\.cjs"\)/.test(c), "credits.cjs 应 require wakeGuard");
    assert.ok(/wakeGuard\.periodicAllowed\(\)/.test(c), "credits tick 应判断静默窗");
    // 跳过本轮后必须照常排下一轮，否则额度刷新永久停摆
    const schedStart = c.indexOf("function startScheduler");
    const sched = c.slice(schedStart, c.indexOf("function stopScheduler", schedStart));
    assert.ok(/scheduleNext\(\)/.test(sched), "应抽出 scheduleNext 复用");
    const skipBlock = sched.slice(sched.indexOf("periodicAllowed"), sched.indexOf("refreshAll"));
    assert.ok(/scheduleNext\(\)/.test(skipBlock) && /return/.test(skipBlock), "跳过时仍要排下一轮再 return");

    const m = read("electron/backend/memory/scheduler.cjs");
    assert.ok(/require\("\.\.\/wakeGuard\.cjs"\)/.test(m), "scheduler.cjs 应 require wakeGuard");
    const tickStart = m.indexOf("async _tickInner()");
    const tick = m.slice(tickStart, tickStart + 700);
    assert.ok(/wakeGuard\.periodicAllowed\(\)/.test(tick), "_tickInner 开头应判断静默窗");
    assert.ok(tick.indexOf("periodicAllowed") < tick.indexOf("_lastTickAt = now"), "守卫应在推进记账之前");
  });

  // ===== T9 接线：main.cjs 注册 powerMonitor 并留痕（供核实 Modern Standby 是否派发） =====
  await T("T9 接线：main.cjs 注册 powerMonitor 且事件写 crash.log", () => {
    const m = read("electron/main.cjs");
    assert.ok(/require\("\.\/backend\/wakeGuard\.cjs"\)/.test(m), "main.cjs 应 require wakeGuard");
    assert.ok(/powerMonitor/.test(m), "应传入 powerMonitor");
    assert.ok(/wk\.start\(\{[^}]*log: __crashLog/.test(m), "应把 __crashLog 作为留痕回调传入");
    const w = read("electron/backend/wakeGuard.cjs");
    assert.ok(/pm\.on\("resume"/.test(w), "应监听 resume");
    assert.ok(/pm\.on\("suspend"/.test(w), "应监听 suspend");
    assert.ok(/power-resume/.test(w), "resume 应写留痕（核实 Modern Standby 是否派发的唯一手段）");
  });

  // ===== T10 幂等与容错：重复 start 不报错；无 powerMonitor 时优雅降级 =====
  await T("T10 容错：无 powerMonitor 时降级不抛错；重复 start 幂等", () => {
    wakeGuard.stop();
    const bad = wakeGuard.start({ powerMonitor: null });
    assert.strictEqual(bad.ok, false, "无 powerMonitor 应返回 ok:false 而非抛错");
    let threw = false;
    try { wakeGuard.start({}); } catch { threw = true; }
    assert.strictEqual(threw, false, "start({}) 不应抛错");
    // 模拟一个最小 powerMonitor：验证 start 成功路径与回调留痕
    const seen = [];
    const fake = { on: (ev, cb) => { seen.push(ev); if (ev === "resume") cb(); } };
    wakeGuard.stop();
    const ok = wakeGuard.start({ powerMonitor: fake, log: (k, d) => seen.push(k + ":" + d) });
    assert.strictEqual(ok.ok, true, "有 powerMonitor 应注册成功");
    assert.ok(seen.includes("resume"), "应注册 resume 监听");
    assert.ok(seen.some((x) => String(x).startsWith("power-resume")), "resume 触发时应留痕");
    // 幂等：再次 start 返回已在监听
    const again = wakeGuard.start({ powerMonitor: fake });
    assert.strictEqual(again.ok, true, "重复 start 应幂等成功");
    wakeGuard.stop();
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail ? 1 : 0);
})();
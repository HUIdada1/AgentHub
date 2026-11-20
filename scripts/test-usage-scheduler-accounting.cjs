/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-20
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 用量统计 · 定时调度记账自测
// 跑法：node scripts/test-usage-scheduler-accounting.cjs
//      （需要 node:sqlite，老版本 node 用 ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe 跑）
//
// 背景（缺陷）：旧口径是「触发前先把 sched_last_* 记账推进到当前时刻，本轮失败被 .catch(()=>{}) 静默吞掉」。
// 于是定时远程同步只要那一拍正好撞上「同步/恢复进行中」「其他模块占着远端锁」，这一轮就整小时白等，
// 日志里连一行痕迹都没有 —— 用户视角就是「设了每小时自动同步却死活不跑」。
// 正确语义：成功才推进记账；撞车退回约 60s 后补跑；真失败保持下一周期再试（不搞重试风暴）；三种都要留日志。
//
// 本自测全程假 sync（不起 WebDAV、不联网）+ 临时 SQLite，不碰真实 ~/.Dosage_sync、不起窗口。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ===== 沙箱：先改掉用量库与配置路径，再加载 db/调度器（二者运行时取 config.*，改属性即生效）=====
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-usage-sched-"));
const syncConfig = require("../electron/backend/sync-config.cjs");
syncConfig.dbPath = () => path.join(TMP, "dosage-sync.sqlite");
syncConfig.dataDir = () => TMP;
syncConfig.configPath = () => path.join(TMP, "config.json");

const db = require("../electron/backend/db.cjs");
const sync = require("../electron/backend/sync.cjs");
const sched = require("../electron/backend/usage-scheduler.cjs");

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const LOCAL_HOUR = 30 * MIN; // 与 usage-scheduler 的 LOCAL_INTERVAL_MS 同口径

let pass = 0;
let failed = 0;
function ok(cond, name, got) {
  if (cond) {
    pass++;
    console.log("  \u2713", name);
  } else {
    failed++;
    console.log("  \u2717", name, got !== undefined ? `→ ${JSON.stringify(got)}` : "");
  }
}
/** 记账落点与期望值的容差判定（tick 内部用 Date.now()，与测试取时差几毫秒到几十毫秒） */
function near(actual, expected, tolMs, name, got) {
  ok(Math.abs(Number(actual) - expected) <= tolMs, name, got === undefined ? { actual, expected } : got);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 用量配置：每小时档 1 小时、已配 WebDAV；useShared=false 免得去读框架配置 =====
fs.writeFileSync(
  syncConfig.configPath(),
  JSON.stringify({
    deviceName: "自测机",
    webdav: { endpoint: "https://dav.test/dav", username: "u", password: "p", root: "/dosage-sync", preset: "", useShared: false },
    localBackup: { dir: TMP },
    sources: [],
    sourceVisibility: { order: [], hidden: [], initialized: true },
    schedule: { hourly: true, hourlyInterval: 1, daily: false, dailyTime: "23:30" },
    totalMode: "full",
    billing: { enabled: false, displayCurrency: "CNY", usdToCny: 7.2, importProxy: "", sources: {} },
  }),
  "utf8"
);

// ===== 假 sync：只记录调用与返回，不发任何网络请求 =====
const calls = { local: 0, remote: 0, full: 0 };
let localResult = { ok: true };
let remoteResult = { ok: true };
let remoteThrow = null;
sync.isBusy = () => false;
sync.runLocal = async () => {
  calls.local++;
  if (typeof localResult === "function") return localResult();
  return localResult;
};
sync.runRemote = async () => {
  calls.remote++;
  if (remoteThrow) throw remoteThrow;
  return remoteResult;
};
sync.run = async () => {
  calls.full++;
  return { ok: true };
};

/** 把两份记账摆到「早已到期」，再重启调度器让它从 meta 读回这个基准 */
function armExpired() {
  const now = Date.now();
  db.setMeta("sched_last_local", String(now - 2 * LOCAL_HOUR));
  db.setMeta("sched_last_hourly", String(now - 2 * HOUR));
  sched.stop();
  sched.start();
  return now;
}
const metaLocal = () => Number(db.getMeta("sched_last_local"));
const metaHourly = () => Number(db.getMeta("sched_last_hourly"));

(async () => {
  console.log("\n[1] 到点且成功：两份记账推进到现在");
  {
    const now = armExpired();
    calls.local = 0;
    calls.remote = 0;
    localResult = { ok: true };
    remoteResult = { ok: true };
    remoteThrow = null;
    sched.tick();
    await sleep(60);
    ok(calls.local === 1 && calls.remote === 1, "本地统计与远程同步各跑一轮", calls);
    near(metaLocal(), Date.now(), 5000, "sched_last_local 推进到现在");
    near(metaHourly(), Date.now(), 5000, "sched_last_hourly 推进到现在");
  }

  console.log("\n[2] 成功一轮后的下一拍：不到期不重复跑");
  {
    calls.local = 0;
    calls.remote = 0;
    sched.tick();
    await sleep(40);
    ok(calls.local === 0 && calls.remote === 0, "刚跑完不再立刻补跑", calls);
  }

  console.log("\n[3] 远程撞车（被其他模块的远端锁挡住）：记账退回，约 60s 后补跑");
  {
    const now = armExpired();
    calls.remote = 0;
    remoteThrow = new Error("其他模块的远端同步正在进行，本轮已跳过");
    sched.tick();
    await sleep(60);
    ok(calls.remote === 1, "确实发起了一轮远程同步", calls);
    const back = metaHourly();
    near(back, now - HOUR + MIN, 5000, "远程记账退回到「差 60s 到期」，而不是停在 now", { back, want: now - HOUR + MIN });
    const logs = db.getLogs({ limit: 10 }).rows;
    ok(logs.some((l) => /让位/.test(l.message) && /后补跑/.test(l.message)), "同步日志留下了「本轮让位、稍后补跑」的记录", logs.slice(0, 2).map((l) => l.message));
    remoteThrow = null;

    // 退回后的到期时刻 = 触发时刻 + 60s：先证明没到期不重复触发，再证明一到点就补跑
    calls.remote = 0;
    sched.tick();
    await sleep(40);
    ok(calls.remote === 0, "退回的 60s 之内不重复触发（不会一秒内连环重试）", calls);

    db.setMeta("sched_last_hourly", String(Date.now() - HOUR - 1000));
    sched.stop();
    sched.start(); // 重新从 meta 读回基准
    calls.remote = 0;
    sched.tick();
    await sleep(60);
    ok(calls.remote === 1, "过了退回的到期时刻，下一拍立刻补跑（不必再等一整小时）", calls);
  }

  console.log("\n[4] 远程真失败（网络错误）：记账不退回，避免每分钟撞一次远端");
  {
    const now = armExpired();
    calls.remote = 0;
    remoteResult = { ok: false, error: "连接 WebDAV 超时" };
    sched.tick();
    await sleep(60);
    ok(calls.remote === 1, "跑了一轮并识别到 ok:false 也是失败", calls);
    near(metaHourly(), now, 5000, "远程记账停在本次触发时刻（下一周期再试）", metaHourly());
    const logs = db.getLogs({ limit: 10 }).rows;
    ok(logs.some((l) => /定时远程同步失败，下一个周期再试/.test(l.message)), "失败原因进了同步日志（不再是静默 catch）", logs.slice(0, 2).map((l) => l.message));
    remoteResult = { ok: true };
  }

  console.log("\n[5] 本地统计撞车同样退回；未到期的一路不动记账");
  {
    const now = armExpired();
    calls.local = 0;
    localResult = { ok: false, error: "本地统计进行中" };
    sched.tick();
    await sleep(60);
    ok(calls.local === 1, "本地统计跑了一轮", calls);
    near(metaLocal(), now - LOCAL_HOUR + MIN, 5000, "本地记账同样退回约 60s 后重试", metaLocal());
    localResult = { ok: true };
  }

  console.log("\n[6] 手动「立即同步」跑完要推进定时记账（否则 1 分钟后再白跑一轮）");
  {
    const now = armExpired();
    calls.local = 0;
    calls.remote = 0;
    sched.tick();
    await sleep(60);
    ok(calls.local === 1 && calls.remote === 1, "基准：先跑成功一轮", calls);

    // 模拟用户在 20 分钟后手动点「立即同步」并成功
    const at = Date.now() + 20 * MIN;
    sched.noteFullSync(at, true);
    ok(Math.abs(metaLocal() - at) < 1000, "手动整轮同步后本地记账推到该时刻", metaLocal());
    ok(Math.abs(metaHourly() - at) < 1000, "手动整轮同步后远程记账推到该时刻（不会再 1 分钟后自动跑一遍）", metaHourly());

    // 强制本机备份没碰远端：不能占用远程节奏，否则一次备份顶掉一小时自动同步
    const at2 = Date.now() + 40 * MIN;
    sched.noteFullSync(at2, false);
    ok(Math.abs(metaLocal() - at2) < 1000, "备份模式推进本地记账", metaLocal());
    ok(metaHourly() < at2 - MIN, "备份模式不动远程记账", { hourly: metaHourly(), at2 });
  }

  sched.stop();
  try { db.close(); } catch { /* 关库失败不影响结论 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用不影响结论 */ }

  console.log(`\n${failed ? "FAIL" : "OK"} 定时调度记账自测：${pass} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  sched.stop();
  try { db.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.error(`\nFAIL 自测异常中断：${(e && e.stack) || e}`);
  process.exit(1);
});

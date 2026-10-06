// 探针：Modern Standby 睡眠/唤醒时，Electron powerMonitor 是否派发 suspend/resume？
//
// 为什么需要单独探针（而不是给应用打补丁）：
//   perf/resume-task-stagger 的守卫依赖 powerMonitor 的 resume 事件（A）与 tick 间隔（B）。
//   本探针隔离回答「该平台到底派不派发 resume」，不碰任何业务逻辑与应用数据。
//
// ⚠ 分离进程的两条硬约束（2026-10-06 踩坑后补上，两者缺一都会周期性弹窗报错）：
//   ① **绝不写 stdout/stderr**：分离进程继承的是父 shell 的管道，父进程一退出管道即断裂，
//      再写就是 EPIPE: broken pipe。初版在 emit() 里带了 console.log，于是每 20 秒的心跳
//      都抛一次 EPIPE → 周期性弹出「主进程 JavaScript 错误」对话框。
//      本版只写文件。（启动时也不再依赖任何继承句柄。）
//   ② **必须自行兜住未捕获异常**：Electron 对主进程的 uncaughtException 默认弹对话框；
//      探针是诊断工具，任何异常都应记进日志文件而非打扰用户。
//
// ⚠ 必须使用独立 userData（不指向 %APPDATA%\AgentHub）：
//   否则与运行中的主进程争抢 lockfile/Cookies → 弹出一连串 Electron 锁冲突错误窗口。
//
// 判定方法（两条证据缺一不可）：
//   ① 心跳出现「墙钟跳跃」（定时器排 20s、实际数小时才醒）→ 证明机器确实睡过
//   ② 事件流里有无 event:suspend / event:resume            → 证明 Electron 是否派发
//
// 用法：electron tools/probe-power-resume.cjs
// 输出：%TEMP%\power-resume-probe.jsonl（逐行 JSON，可随时读）
//
// ## 实测结论（2026-10-06，本机 Windows + Modern Standby）
// 主动睡眠 2 分 40 秒，三条证据对齐，**suspend 与 resume 都被派发**：
//   event:lock-screen 07:24:13Z ↔ Kernel-Power 506 进入 Modern Standby（15:24:13 本地）
//   event:suspend     07:24:13Z ↔ 同上
//   event:resume      07:26:53Z ↔ Kernel-Power 507 退出（15:26:51 本地，回调晚约 2 秒）
//   heartbeat-gap     墙钟跳跃 157s ↔ 实际睡眠 158s
// ⇒ 唤醒守卫的 A（15s 静默窗）与 C（30s 签到门槛）在本机生效；B 作为不依赖事件的兜底保留。
// 换机/换平台/换电源策略时可用本探针重新实测（结论不具跨平台普适性）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, powerMonitor } = require("electron");

// 独立临时 userData：与运行中的 AgentHub 完全隔离
app.setName("AgentHubPowerProbe");
app.setPath("userData", path.join(os.tmpdir(), "power-probe-ud"));

const OUT = path.join(os.tmpdir(), "power-resume-probe.jsonl");

/** 只写文件，**绝不写 stdout/stderr**（见文件头约束①） */
function emit(kind, detail) {
  const rec = {
    t: new Date().toISOString(),
    tMs: Date.now(),
    uptimeMs: Math.round(process.uptime() * 1000),
    kind,
    detail: String(detail == null ? "" : detail).slice(0, 300),
  };
  try {
    fs.appendFileSync(OUT, JSON.stringify(rec) + "\n", "utf8");
    return true;
  } catch {
    return false; // 磁盘问题也不能让探针崩溃
  }
}

function describe(e) {
  if (!e) return "unknown";
  const msg = String((e && e.message) || e);
  const st = e && e.stack ? String(e.stack).split("\n").slice(0, 3).join(" | ") : "";
  return st ? `${msg} :: ${st}` : msg;
}

// 约束②：兜住所有异常——探针绝不应该弹对话框（Electron 默认会弹）
process.on("uncaughtException", (e) => { emit("probe-uncaught", describe(e)); });
process.on("unhandledRejection", (r) => { emit("probe-unhandled", describe(r)); });
process.on("exit", (code) => { emit("probe-exit", `code=${code} uptime=${Math.round(process.uptime())}s`); });

app.whenReady().then(() => {
  // 覆盖所有电源/会话事件，便于判断「是否只有 suspend/resume 不派发」
  const events = ["suspend", "resume", "lock-screen", "unlock-screen", "on-ac", "on-battery", "shutdown", "user-did-become-active", "user-did-resign-active"];
  const registered = [];
  for (const ev of events) {
    try {
      powerMonitor.on(ev, () => emit("event:" + ev));
      registered.push(ev);
    } catch { /* 平台不支持的事件忽略 */ }
  }
  emit("probe-start", `electron=${process.versions.electron} node=${process.versions.node} registered=${registered.join(",")}`);

  // 心跳：定时器排 20s。若墙钟跳跃 ≫ 20s，说明机器睡过（「确实睡了」的独立证据）
  let expect = Date.now() + 20000;
  setInterval(() => {
    const now = Date.now();
    const jump = now - expect;
    if (jump > 60000) emit("heartbeat-gap", `墙钟跳跃 ${Math.round(jump / 1000)}s（定时器排 20s）→ 机器确实睡过`);
    else emit("heartbeat", `跳变 ${jump}ms`);
    expect = now + 20000;
  }, 20000);

  // 运行 12 小时足够覆盖一次手动睡醒；到点自行退出并留痕
  setTimeout(() => {
    emit("probe-timeout", "12 小时到，探针退出");
    app.exit(0);
  }, 12 * 3600 * 1000);
}).catch((e) => { emit("probe-error", describe(e)); try { app.exit(1); } catch { process.exit(1); } });
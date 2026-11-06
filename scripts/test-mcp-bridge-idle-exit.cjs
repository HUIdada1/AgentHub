/**
 * MCP 桥空闲看门狗自测：桌面端没了就自行退出，别锁着安装目录
 * 运行：node scripts/test-mcp-bridge-idle-exit.cjs
 * 纯本地：临时 runtime 文件 + 真实桥子进程，不启动 AgentHub。
 *
 * 背景：桌面端退出后会删除 memory-runtime.json，桥已经没有可服务的对象，却仍以
 * AgentHub.exe 的镜像常驻。Windows 不允许删除/替换正在运行的 exe，于是自动更新时
 * NSIS 卸载旧文件失败（"Failed to uninstall old application files … : 2"），
 * 用户只能手动去任务管理器结束进程。看门狗让桥在「runtime 连续缺失超过阈值」或
 * 「父进程已退出」时自行退出。
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BRIDGE = path.join(__dirname, "..", "tools", "mcp-memory-server.cjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-mcp-idle-"));
const RUNTIME = path.join(TMP, "memory-runtime.json");

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeRuntime() {
  fs.writeFileSync(RUNTIME, JSON.stringify({ port: 1, token: "t", pid: process.pid, startedAt: Date.now() }));
}

function startBridge(env = {}) {
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      AGENTHUB_MEMORY_RUNTIME: RUNTIME,
      AGENTHUB_BRIDGE_IDLE_EXIT_MS: "300",
      AGENTHUB_BRIDGE_IDLE_CHECK_MS: "100",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rec = { child, stderr: "" };
  child.stderr.on("data", (c) => { rec.stderr += c; });
  return rec;
}

/** 等子进程退出；返回 { exited, code } */
function waitExit(child, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ exited: false }), ms);
    child.once("exit", (code) => { clearTimeout(t); resolve({ exited: true, code }); });
  });
}

(async () => {
  try {
    // ① runtime 在：看门狗不得误杀
    writeRuntime();
    const a = startBridge();
    const alive = await waitExit(a.child, 1200);
    ok(alive.exited === false, "runtime 可用时桥保持存活（不误杀）");
    a.child.kill();

    // ② runtime 消失：阈值后自行退出，退出码 0
    writeRuntime();
    const b = startBridge();
    await sleep(300); // 先让它看到一个健康的 runtime
    fs.rmSync(RUNTIME, { force: true });
    const gone = await waitExit(b.child, 6000);
    ok(gone.exited === true, "runtime 消失后桥自行退出");
    ok(gone.code === 0, `退出码为 0（实得 ${gone.code}）`);

    // ③ 显式关闭看门狗：同样的场景下进程应继续存活
    writeRuntime();
    const c = startBridge({ AGENTHUB_BRIDGE_IDLE_EXIT_MS: "0" });
    await sleep(300);
    fs.rmSync(RUNTIME, { force: true });
    const still = await waitExit(c.child, 1500);
    ok(still.exited === false, "AGENTHUB_BRIDGE_IDLE_EXIT_MS=0 时看门狗关闭，桥不退出");
    c.child.kill();
  } catch (e) {
    failed++;
    console.log(`  \u2717 运行异常：${e && e.message}`);
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n${pass} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();

/**
 * 记忆中枢 · IPC 管道与 mock 一致性自动化校验
 * 纯 Node.js，零 GUI
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");

function extractMatches(file, regex) {
  const content = fs.readFileSync(file, "utf8");
  const set = new Set();
  let m;
  while ((m = regex.exec(content)) !== null) {
    set.add(m[1]);
  }
  return set;
}

function runCheck(isAssert = false) {
  console.log("=== [m-plumbing] IPC 管道与 Mock 一致性校验 ===");
  let pass = 0;
  let fail = 0;

  function assertCheck(name, cond, details) {
    if (cond) {
      pass++;
      console.log(`  ✓ ${name}`);
      return true;
    }
    fail++;
    console.log(`  ✗ ${name} ${details ? " -> " + details : ""}`);
    return false;
  }

  const backendFile = path.join(ROOT, "electron/backend/memory/index.cjs");
  const preloadFile = path.join(ROOT, "electron/preload.cjs");
  const ipcFile = path.join(ROOT, "src/api/ipc.ts");
  const mockFile = path.join(ROOT, "src/api/mock.ts");

  // A: backend memory handlers
  const backendCmds = extractMatches(backendFile, /ipcMain\.handle\s*\(\s*["'](memory_[a-z0-9_]+)["']/g);
  // B: preload allowed commands
  const preloadCmds = extractMatches(preloadFile, /["'](memory_[a-z0-9_]+)["']/g);
  // C: frontend ipc calls
  const ipcCmds = extractMatches(ipcFile, /call\s*<[^>]+>\s*\(\s*["'](memory_[a-z0-9_]+)["']/g);
  // D: mock cases
  const mockCmds = extractMatches(mockFile, /case\s*["'](memory_[a-z0-9_]+)["']/g);

  console.log(`  统计: Backend(${backendCmds.size}), Preload(${preloadCmds.size}), FrontendIPC(${ipcCmds.size}), Mock(${mockCmds.size})`);

  // 1. Backend == Preload
  const backendMissingInPreload = [...backendCmds].filter((c) => !preloadCmds.has(c));
  const preloadMissingInBackend = [...preloadCmds].filter((c) => !backendCmds.has(c));
  assertCheck(
    "Backend 与 Preload 白名单双向严格对齐",
    backendMissingInPreload.length === 0 && preloadMissingInBackend.length === 0,
    `Backend多出: [${backendMissingInPreload.join(", ")}], Preload多出: [${preloadMissingInBackend.join(", ")}]`
  );

  // 2. Frontend IPC ⊆ Backend
  const frontendMissingInBackend = [...ipcCmds].filter((c) => !backendCmds.has(c));
  assertCheck(
    "前端调用的 memory_* 均在 Backend 注册",
    frontendMissingInBackend.length === 0,
    `未注册命令: [${frontendMissingInBackend.join(", ")}]`
  );

  // 3. Frontend IPC ⊆ Mock
  const frontendMissingInMock = [...ipcCmds].filter((c) => !mockCmds.has(c));
  assertCheck(
    "前端调用的 memory_* 均在 Mock 实现",
    frontendMissingInMock.length === 0,
    `Mock缺失命令: [${frontendMissingInMock.join(", ")}]`
  );

  // 4. Mock default 分支安全检查
  const mockContent = fs.readFileSync(mockFile, "utf8");
  const defaultThrowsMemory = /default:\s*[\s\S]*?startsWith\s*\(\s*["']memory_["']\s*\)[\s\S]*?throw/m.test(mockContent);
  assertCheck(
    "Mock default 分支对 memory_* 抛出明确异常而非静默返回 null",
    defaultThrowsMemory,
    "mock.ts default 分支未拦截 memory_ 前缀"
  );

  if (isAssert && fail > 0) {
    process.exit(1);
  }
  return { pass, fail };
}

if (require.main === module) {
  const isAssert = process.argv.includes("--assert");
  runCheck(isAssert);
}

module.exports = { runCheck };

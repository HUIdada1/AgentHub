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
/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐晖 (MUHUIX)
 * https://github.com/MUHUIX/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · 桥的 runtime 定位自测：tools/mcp-memory-server.cjs 靠候选目录找 memory-runtime.json，
// 而桌面端把它写在 Electron 的 userData 下——目录名大小写随运行方式变（源码运行小写 agenthub、
// 安装版大写 AgentHub，Linux 的 config 根目录还会跟随 XDG_CONFIG_HOME）。本自测在沙箱 HOME 里
// 逐个摆出这些布局，用假本地服务验证桥确实找到文件并握手成功；再验证一个都没有时报错且点名查过的路径。
// 用法：node tools/memory-runtime-path-selftest.cjs（纯 Node，不需要 Electron，也不需要桌面端在跑）
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const BRIDGE = path.join(__dirname, "mcp-memory-server.cjs");
const TOKEN = "selftest-token-0123456789abcdef";
const OFFLINE_HINT = "AgentHub 未运行";

let pass = 0;
let failCount = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return true; }
  failCount++;
  failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  return false;
}

/** 假本地服务：桥把 MCP 调用转成对它的 POST /call；记录收到的 bearer 与工具名供断言 */
function startStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* 非法请求体：下方断言会看到空 tool */ }
      const auth = req.headers.authorization || "";
      seen.push({ auth, tool: body.tool || "" });
      const ok = auth === `Bearer ${TOKEN}`;
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ok ? { ok: true, result: "stub-ok" } : { ok: false, message: "unauthorized" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port }));
  });
}

/** 按 MCP stdio 协议驱动桥：initialize → tools/call memory_status，返回结果文本与 stderr */
function callBridge(env, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* 已关闭 */ }
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ ...payload, stderr: err });
    };
    const timer = setTimeout(() => finish({ ok: false, text: `超时（stdout ${out.length} 字节）` }), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { err += c; });
    child.stdout.on("data", (chunk) => {
      out += chunk;
      let idx;
      while ((idx = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, idx);
        out = out.slice(idx + 1);
        let msg = null;
        try { msg = JSON.parse(line); } catch { continue; } // stdout 只应有 JSON：解析不了的行等于协议污染（下面的断言会超时失败）
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_status", arguments: {} } }) + "\n");
        } else if (msg.id === 2) {
          const content = (msg.result && msg.result.content) || [];
          finish({ ok: true, isError: !!(msg.result && msg.result.isError), text: (content[0] && content[0].text) || "" });
        }
      }
    });
    child.on("error", (e) => finish({ ok: false, text: `进程错误：${e.message}` }));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "runtime-path-selftest", version: "1" } } }) + "\n");
  });
}

function main() {
  return startStub().then(async (stub) => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-bridge-path-"));
    const home = path.join(sandbox, "home");
    const xdg = path.join(sandbox, "xdg");
    const appData = path.join(sandbox, "AppData", "Roaming");
    const customData = path.join(sandbox, "custom-data");

    // 沙箱：HOME/USERPROFILE/APPDATA 全部指进临时目录，桥的候选路径因此只落在沙箱内；
    // 三个"显式指定"变量必须清掉，否则真实机器的取值会替某个用例作答
    function reset() {
      fs.rmSync(sandbox, { recursive: true, force: true });
      for (const d of [home, xdg, appData, customData]) fs.mkdirSync(d, { recursive: true });
      const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appData, ELECTRON_RUN_AS_NODE: "1" };
      delete env.AGENTHUB_MEMORY_RUNTIME;
      delete env.AGENTHUB_DATA_DIR;
      delete env.XDG_CONFIG_HOME;
      return env;
    }

    function writeRuntime(dir) {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "memory-runtime.json");
      // pid 用本进程（必然存活）：过 pid 存活校验，与桌面端真实写入的字段一致
      fs.writeFileSync(file, JSON.stringify({ port: stub.port, token: TOKEN, pid: process.pid, startedAt: Date.now() }, null, 2), "utf8");
      return file;
    }

    const cases = [
      { name: "源码运行：~/.config/agenthub（小写）", dir: path.join(home, ".config", "agenthub"), env: {}, found: true },
      { name: "安装版：~/.config/AgentHub（大写）", dir: path.join(home, ".config", "AgentHub"), env: {}, found: true },
      { name: "XDG_CONFIG_HOME 覆盖：$XDG_CONFIG_HOME/agenthub", dir: path.join(xdg, "agenthub"), env: () => ({ XDG_CONFIG_HOME: xdg }), found: true },
      { name: "macOS 源码运行：~/Library/Application Support/agenthub", dir: path.join(home, "Library", "Application Support", "agenthub"), env: {}, found: true },
      { name: "Windows：%APPDATA%\\agenthub（小写）", dir: path.join(appData, "agenthub"), env: {}, found: true },
      { name: "Windows：%APPDATA%\\AgentHub（大写）", dir: path.join(appData, "AgentHub"), env: {}, found: true },
      { name: "AGENTHUB_DATA_DIR 显式指定", dir: customData, env: () => ({ AGENTHUB_DATA_DIR: customData }), found: true },
      { name: "盘上没有任何 runtime 文件", dir: null, env: {}, found: false },
    ];

    for (const c of cases) {
      console.log(`[${c.name}]`);
      const env = reset();
      if (c.env && typeof c.env === "function") Object.assign(env, c.env());
      if (c.dir) writeRuntime(c.dir);
      const before = stub.seen.length;
      const res = await callBridge(env);
      const calls = stub.seen.slice(before);
      if (c.found) {
        check("桥找到 runtime 并握手成功", res.ok && res.isError === false && res.text === "stub-ok", JSON.stringify({ ok: res.ok, isError: res.isError, text: res.text }));
        check("假本地服务收到带正确 token 的调用", calls.length === 1 && calls[0].auth === `Bearer ${TOKEN}` && calls[0].tool === "memory_status", JSON.stringify(calls));
        const used = path.join(c.dir, "memory-runtime.json");
        // 桥报的是「命中的候选路径」，而候选表里大小写两种写法都在。Windows / macOS 的文件
        // 系统大小写不敏感，大小写不同的两个候选指向同一个文件——此时桥会报排在前面那个
        // （小写），与用例写入时用的大写目录字面不同却完全正确。所以比 realpath，不比字面量。
        const logged = (res.stderr.match(/已采用 runtime：(.+?)（port /) || [])[1] || "";
        // realpathSync.native 才走系统调用拿磁盘上的真实大小写（非 native 版只做字面归一）
        const real = (p) => (fs.realpathSync.native || fs.realpathSync)(p);
        let sameFile = false;
        try { sameFile = !!logged && real(logged) === real(used); } catch { sameFile = false; }
        check("stderr 记下实际采用的 runtime 文件", sameFile, `桥报的是 ${logged || "(无)"}，用例写的是 ${used}`);
      } else {
        check("无 runtime 时返回未运行而非崩溃", res.ok && res.isError === true && res.text.includes(OFFLINE_HINT), JSON.stringify({ ok: res.ok, isError: res.isError, text: res.text }));
        check("stderr 点名查找过的候选路径", res.stderr.includes(path.join(".config", "agenthub", "memory-runtime.json")) && res.stderr.includes("AgentHub"), res.stderr.trim().split("\n").slice(-1)[0] || "(stderr 为空)");
        check("未命中时不误调本地服务", calls.length === 0, JSON.stringify(calls));
      }
    }

    fs.rmSync(sandbox, { recursive: true, force: true });
    await new Promise((resolve) => stub.server.close(resolve));

    console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
    if (failCount) {
      console.log("失败项：");
      for (const f of failures) console.log("  - " + f);
    }
    process.exit(failCount ? 1 : 0);
  });
}

main().catch((e) => {
  console.error("自测崩溃：", (e && e.stack) || e);
  process.exit(2);
});

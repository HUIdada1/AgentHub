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
 * Copyright (c) 2026 沐晖 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · MCP stdio 桥（手写 JSON-RPC 2.0，零依赖）。
// 启动方式（修正清单 B1）：AgentHub.exe + 本文件物理路径 + ELECTRON_RUN_AS_NODE=1。
// 本文件不 require electron、不读写记忆文件：只把 MCP 调用转成对主进程本地 HTTP API 的请求。
// 协议细节（可行性复核 §2.3）：换行分隔 JSON、日志只走 stderr、stdin 关闭即退出、
// 写 stdout 串行排队、大响应等 drain。
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PROTOCOL_FALLBACK = "2024-11-05";
const SERVER_INFO = { name: "agenthub-memory", version: "1.0.0" };

function log(...args) {
  try { process.stderr.write(`[agenthub-memory] ${args.join(" ")}\n`); } catch { /* stderr 不可用时静默 */ }
}

// 桌面端的 userData 目录名有两种大小写，桥都得找：源码运行（npm run dev）时 Electron 取
// package.json 的 name（小写 agenthub）——main.cjs 的 app.setName("AgentHub") 晚于同文件靠前的
// crashReporter.start()，userData 已按小写定死；安装版取 productName（大写 AgentHub）。
// Linux 的 config 根目录还可能被 XDG_CONFIG_HOME 改掉，故两种根目录都列
const CONFIG_DIR_NAMES = ["agenthub", "AgentHub"];

function runtimeFileCandidates() {
  const out = [];
  const push = (file) => { if (file && !out.includes(file)) out.push(file); };
  if (process.env.AGENTHUB_MEMORY_RUNTIME) push(process.env.AGENTHUB_MEMORY_RUNTIME);
  // 与 electron/backend/config.cjs 的 dataDir() 同源：显式指定时它就是桌面端的落盘目录
  if (process.env.AGENTHUB_DATA_DIR) push(path.join(process.env.AGENTHUB_DATA_DIR, "memory-runtime.json"));
  const appDataDirs = [
    process.env.APPDATA, // Windows
    path.join(os.homedir(), "AppData", "Roaming"), // Windows（APPDATA 缺失时的兜底）
    path.join(os.homedir(), "Library", "Application Support"), // macOS
    process.env.XDG_CONFIG_HOME, // Linux（Electron 的 appData 取这个）
    path.join(os.homedir(), ".config"), // Linux
  ];
  for (const dir of appDataDirs) {
    if (!dir) continue;
    for (const name of CONFIG_DIR_NAMES) push(path.join(dir, name, "memory-runtime.json"));
  }
  push(path.join(os.homedir(), ".agenthub", "memory-runtime.json")); // 通用备用路径
  return out;
}

let loggedMiss = false;
let lastLoggedFile = "";

function readRuntime() {
  const files = runtimeFileCandidates();
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data || !data.port || !data.token) continue;
      // 校验 pid 存活：崩溃残留的 stale runtime 会让桥把 token 打到被复用的无关端口上
      if (data.pid) {
        try { process.kill(data.pid, 0); } catch { continue; }
      }
      // 采用的是哪个候选文件只留痕一次（换了文件再留一次）：多台电脑/多个 userData 并存时
      // 桥连到哪一份是排查这类问题的第一现场
      if (lastLoggedFile !== file) {
        lastLoggedFile = file;
        log(`已采用 runtime：${file}（port ${data.port}）`);
      }
      return { ...data, file };
    } catch { /* 换下一个候选 */ }
  }
  // 一个都没命中时把查过的路径点名一次：否则「桌面端明明在跑却报未运行」只能靠猜
  if (!loggedMiss) {
    loggedMiss = true;
    log(`未找到可用的 memory-runtime.json，已查找：${files.join(" | ")}`);
  }
  return null;
}

const OFFLINE_MESSAGE = "AgentHub 未运行：请先启动 AgentHub 桌面端（记忆中枢随主进程提供本地服务）";

function callLocal(tool, args, isRetry = false) {
  return new Promise((resolve, reject) => {
    const rt = readRuntime();
    if (!rt) return reject(new Error(OFFLINE_MESSAGE));
    const safeAgent = String(process.env.AGENTHUB_AGENT || "mcp-bridge").slice(0, 64).replace(/[^A-Za-z0-9_.-]/g, "_") || "mcp-bridge";
    const body = JSON.stringify({ tool, args, agent: safeAgent });
    const req = http.request({
      host: "127.0.0.1",
      port: rt.port,
      path: "/call",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${rt.token}`,
      },
      timeout: 120000,
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        if (res.statusCode === 401) {
          if (!isRetry) {
            return resolve(callLocal(tool, args, true));
          }
          return reject(new Error("本地服务鉴权失败，请重启 AgentHub 后重试"));
        }
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return reject(new Error("本地服务返回了非 JSON 响应")); }
        if (!parsed.ok) return reject(new Error(parsed.message || "本地服务返回失败"));
        resolve(parsed.result);
      });
    });
    req.on("timeout", () => { req.destroy(new Error("本地服务响应超时")); });
    req.on("error", (e) => {
      if (e && (e.code === "ECONNREFUSED" || e.code === "ECONNRESET")) {
        if (!isRetry) {
          return setTimeout(() => resolve(callLocal(tool, args, true)), 300);
        }
        reject(new Error(OFFLINE_MESSAGE));
      } else {
        reject(e);
      }
    });
    req.write(body);
    req.end();
  });
}

// ---------- stdio 传输 ----------

let buffer = "";
let writeChain = Promise.resolve();

function send(payload) {
  const line = JSON.stringify(payload) + "\n";
  writeChain = writeChain.then(() => new Promise((resolve) => {
    const ok = process.stdout.write(line);
    if (ok) resolve();
    else process.stdout.once("drain", resolve);
  })).catch(() => {});
  return writeChain;
}

function reply(id, result) { return send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message) { return send({ jsonrpc: "2.0", id, error: { code, message } }); }

const TOOL_SCHEMA = [
  { name: "memory_core", description: "取核心记忆：用户画像 + 项目汇总（会话开局调用一次）", inputSchema: { type: "object", properties: { project: { type: "string" } } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory_digest", description: "取全局索引概览（≤200 行）", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory_search", description: "检索记忆，返回摘要索引行（默认排除已失效）", inputSchema: { type: "object", properties: { query: { type: "string" }, project: { type: "string" }, agent: { type: "string" }, layer: { type: "string" }, limit: { type: "number" }, includeSuperseded: { type: "boolean" } }, required: ["query"] }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory_get", description: "按 id 取全文（截断）+ 相关记忆", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory_timeline", description: "取事实演化链", inputSchema: { type: "object", properties: { id: { type: "string" }, topic: { type: "string" } } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory_write", description: "写入记忆（归类自动判定，可声明 supersedes）", inputSchema: { type: "object", properties: { content: { type: "string" }, title: { type: "string" }, type: { type: "string" }, project: { type: "string" }, tags: { type: "array", items: { type: "string" } }, importance: { type: "number" }, supersedes: { type: "array", items: { type: "string" } }, cwd: { type: "string" } }, required: ["content"] }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory_update", description: "更新记忆内容", inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, body: { type: "string" }, tags: { type: "array", items: { type: "string" } }, importance: { type: "number" } }, required: ["id"] }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory_recent", description: "取最近 N 天记忆", inputSchema: { type: "object", properties: { project: { type: "string" }, agent: { type: "string" }, days: { type: "number" } } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory_projects", description: "列出项目", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "memory_forget", description: "删除记忆（进回收站，可恢复）", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
  { name: "memory_status", description: "状态自检", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];

const INSTRUCTIONS = [
  "本服务提供 AgentHub「记忆中枢」的本机项目记忆读写。",
  "会话开始或需要背景时先调 memory_core；用户提到「之前/上次/怎么定的」时先 memory_search，再按需 memory_get 精读。",
  "完成任务或做出重要决策后调 memory_write 记录，注明项目与标签。",
  "不要一次性读取全部记忆：memory_search 返回摘要，精读用 memory_get。",
  "与团队记忆（TD）分工：本服务管本机项目记忆，团队/组织级历史请用 tdai 的记忆工具。",
].join(" ").slice(0, 512);

// 桌面端退出后 memory-runtime.json 会被删除，桥这一刻已经没有可服务的对象，却仍以
// AgentHub.exe 的镜像常驻——Windows 不允许删除/替换正在运行的 exe，于是自动更新时
// NSIS 卸载旧文件必然失败（实测弹窗 "Failed to uninstall old application files … : 2"）。
// 看门狗：父进程消失，或 runtime 连续缺失超过阈值，桥就自行退出，把安装目录让出来。
// 阈值可用环境变量覆盖；AGENTHUB_BRIDGE_IDLE_EXIT_MS=0 表示显式关闭看门狗。
const IDLE_EXIT_MS = Math.max(0, Number(process.env.AGENTHUB_BRIDGE_IDLE_EXIT_MS ?? 120000) || 0);
const IDLE_CHECK_MS = Math.max(50, Number(process.env.AGENTHUB_BRIDGE_IDLE_CHECK_MS ?? 15000) || 15000);
let pendingCalls = 0;
let noRuntimeSince = 0;

function parentAlive() {
  const ppid = process.ppid;
  if (!ppid || ppid <= 0) return true;
  try { process.kill(ppid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
}

// MCP 的 structuredContent 必须是 JSON 对象（spec 2025-06-18 §Structured Content）。
// 本地 /call 里有工具直接返回数组（如 memory_recent = 记忆索引行数组），原样透传会让
// 按规范校验的客户端把整条 tools/call 判为非法响应——连 content 里的文本一起丢弃，
// 表现为「工具报错但数据其实是好的」。统一包一层对象，数组/标量都变成合法结果。
function toStructuredContent(result) {
  if (result && typeof result === "object" && !Array.isArray(result)) return result;
  return { result };
}

async function handleMessage(msg) {
  const { id, method, params } = msg || {};
  if (method === "initialize") {
    // 协议版本只回自己支持的：无条件回显客户端任意版本会让对端以为服务端
    // 支持未来版本的新特性（实际并不支持），调用时行为错位
    const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
    const want = params && params.protocolVersion;
    const protocolVersion = SUPPORTED.includes(want) ? want : PROTOCOL_FALLBACK;
    return reply(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return undefined;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOL_SCHEMA });
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (!TOOL_SCHEMA.some((t) => t.name === name)) {
      return reply(id, { content: [{ type: "text", text: `未知工具：${name}` }], isError: true });
    }
    pendingCalls++;
    try {
      const result = await callLocal(name, args);
      const text = typeof result === "string" ? result : (result && result.text) || JSON.stringify(result, null, 2);
      return reply(id, { content: [{ type: "text", text }], structuredContent: toStructuredContent(result), isError: false });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: String(e && e.message || e) }], isError: true });
    } finally {
      pendingCalls--;
    }
  }
  if (id !== undefined && id !== null) {
    return replyError(id, -32601, `不支持的方法：${method}`);
  }
  return undefined;
}

function onLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { log("丢弃无法解析的行"); return; }
  Promise.resolve(handleMessage(msg)).catch((e) => log("处理失败", String(e && e.message || e)));
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  // 缓冲上限：对端只发数据不发换行就能让桥内存无限增长，超阈值直接退出
  if (buffer.length > 8 * 1024 * 1024) {
    log("单行消息超过 8MB，桥主动退出");
    process.exit(2);
  }
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    onLine(line);
  }
});

function shutdown(code) {
  writeChain.finally(() => process.exit(code));
}
process.stdin.on("end", () => {
  log("stdin 关闭，退出");
  shutdown(0);
});
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("uncaughtException", (e) => log("未捕获异常", String(e && e.stack || e)));

function startIdleWatchdog() {
  if (!(IDLE_EXIT_MS > 0)) return;
  const timer = setInterval(() => {
    if (pendingCalls > 0) return; // 有请求在飞，绝不在服务中途退出
    if (!parentAlive()) {
      log("父进程已退出，桥自行退出以释放安装目录的文件锁");
      shutdown(0);
      return;
    }
    if (readRuntime()) { noRuntimeSince = 0; return; }
    if (!noRuntimeSince) noRuntimeSince = Date.now();
    const idle = Date.now() - noRuntimeSince;
    if (idle >= IDLE_EXIT_MS) {
      log(`记忆服务已 ${Math.round(idle / 1000)}s 不可用，桥自行退出以释放安装目录的文件锁`);
      shutdown(0);
    }
  }, IDLE_CHECK_MS);
  timer.unref(); // 看门狗不因自己而阻止进程退出
}

startIdleWatchdog();

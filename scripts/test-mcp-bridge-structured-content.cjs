/**
 * MCP 桥 structuredContent 形状回归自测：工具返回数组时也必须给合法对象
 * 运行：node scripts/test-mcp-bridge-structured-content.cjs
 * 纯本地：桩 HTTP 服务替代 AgentHub 主进程，桥按 AGENTHUB_MEMORY_RUNTIME 连过去，
 * 不启动桌面端、不读写真实记忆。
 *
 * 背景：本地 /call 的 memory_recent 返回的是数组（记忆索引行），桥在 tools/call 里
 * 把它原样塞进 structuredContent。MCP 规范（2025-06-18 §Structured Content）要求
 * 该字段是 JSON object，客户端若按规范校验会判整条响应非法并丢弃 content 里的文本：
 * 实测 DSH 报 "Invalid result for tools/call: expected record, received array"，
 * 工具看起来报错，其实后端数据完全正常。
 * 修复口径：对象原样透传；数组/标量包成 { result }。
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const BRIDGE = path.join(__dirname, "..", "tools", "mcp-memory-server.cjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-mcp-sc-"));
const RUNTIME = path.join(TMP, "memory-runtime.json");

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`); }
}

let currentResult = null;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    // 与 AgentHub 主进程 /call 同形：{ ok, result }
    res.end(JSON.stringify({ ok: true, result: currentResult }));
  });
});

/** 起一次桥、走一遍 initialize + tools/call，返回 tools/call 的 result */
function callBridge(result, tool) {
  currentResult = result;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        // 纯 node 下这两个变量无副作用；Electron-as-node 下必须保留 1 才能当 node 跑
        ELECTRON_RUN_AS_NODE: "1",
        AGENTHUB_MEMORY_RUNTIME: RUNTIME,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const waiters = new Map();
    let stderr = "";
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const waiter = waiters.get(msg.id);
      if (waiter) { waiters.delete(msg.id); waiter(msg); }
    });
    child.stderr.on("data", (c) => { stderr += c; });

    const timer = setTimeout(() => {
      finish(new Error(`桥响应超时；stderr=${stderr.trim()}`));
    }, 15000);

    function finish(err) {
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* 已关闭 */ }
      try { child.kill(); } catch { /* 已退出 */ }
      if (err) reject(err);
    }

    function waitFor(id) {
      return new Promise((res, rej) => {
        waiters.set(id, res);
        const t = setTimeout(() => rej(new Error(`等待 id=${id} 超时；stderr=${stderr.trim()}`)), 8000);
        waiters.set(id, (m) => { clearTimeout(t); res(m); });
      });
    }

    (async () => {
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "selftest", version: "0" } },
      }) + "\n");
      await waitFor(1);
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: tool, arguments: {} },
      }) + "\n");
      const msg = await waitFor(2);
      finish(null);
      if (!msg.result) throw new Error(`没有 result 字段：${JSON.stringify(msg).slice(0, 300)}`);
      resolve(msg.result);
    })().catch((e) => { finish(e); reject(e); });
  });
}

(async () => {
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  fs.writeFileSync(RUNTIME, JSON.stringify({
    port: server.address().port,
    token: "selftest-token",
    pid: process.pid, // 桥会校验 pid 存活，用本进程最稳
    startedAt: Date.now(),
  }));

  try {
    // ① 数组：memory_recent 的真实形状
    const rows = [{ id: "mem_x", title: "第一条" }, { id: "mem_y", title: "第二条" }];
    const r1 = await callBridge(rows, "memory_recent");
    ok(r1.structuredContent && typeof r1.structuredContent === "object" && !Array.isArray(r1.structuredContent),
      "数组结果：structuredContent 是对象而非数组");
    ok(Array.isArray(r1.structuredContent && r1.structuredContent.result)
      && r1.structuredContent.result.length === 2,
      "数组结果：原始数组完整保留在 result 字段");
    ok(r1.isError === false, "数组结果：isError=false");
    let echoed = null;
    try { echoed = JSON.parse(r1.content[0].text); } catch { /* 下面断言失败 */ }
    ok(Array.isArray(echoed) && echoed.length === 2, "数组结果：content 里仍带完整 JSON 文本（不丢数据）");

    // ② 对象：其它工具的真实形状，必须原样透传（不能多包一层）
    const obj = { text: "摘要", count: 3, tookMs: 1 };
    const r2 = await callBridge(obj, "memory_search");
    ok(r2.structuredContent && r2.structuredContent.text === "摘要" && r2.structuredContent.count === 3,
      "对象结果：structuredContent 原样透传");
    ok(!("result" in r2.structuredContent), "对象结果：没有被多包一层 result");

    // ③ 标量：兜底也不许出现非对象
    const r3 = await callBridge("纯文本结果", "memory_digest");
    ok(r3.structuredContent && typeof r3.structuredContent === "object" && !Array.isArray(r3.structuredContent),
      "字符串结果：structuredContent 仍是对象");
    ok(r3.structuredContent.result === "纯文本结果", "字符串结果：原值保留在 result 字段");
  } catch (e) {
    failed++;
    console.log(`  \u2717 运行异常：${e && e.message}`);
  } finally {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n${pass} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();

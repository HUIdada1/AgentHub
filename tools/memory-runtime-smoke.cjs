/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 运行时端到端自测：在真实 Electron 运行时里装配模块（IPC 注册 + 本地桥 + 调度器），
// 然后按前端会走的路径逐条调用 IPC，验证「注册齐全 / 桥可握手 / 返回结构对得上」。
// 用法：electron.exe tools/memory-runtime-smoke.cjs（普通模式，需要 Electron 运行时）
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

let app = null;
let ipcMain = null;
try {
  ({ app, ipcMain } = require("electron"));
} catch {
  app = null;
}
if (!app || !ipcMain) {
  // 本自测要真初始化主进程模块（含 electron.app 路径），不能带 ELECTRON_RUN_AS_NODE
  console.error("本自测必须在真实 Electron 运行时里跑：./node_modules/electron/dist/electron.exe tools/memory-runtime-smoke.cjs（不要加 ELECTRON_RUN_AS_NODE）");
  process.exit(2);
}

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

// 主进程侧收集注册过的命令，模拟渲染层调用（与 ipc.cjs 的 handle 包装同构）
const handlers = new Map();
const fakeIpcMain = {
  handle(name, fn) {
    handlers.set(name, fn);
  },
};

async function invoke(cmd, args) {
  const fn = handlers.get(cmd);
  if (!fn) throw new Error(`IPC 未注册：${cmd}`);
  return fn({}, args || {});
}

async function main() {
  const rootDir = path.join(os.tmpdir(), `agenthub-memory-runtime-${Date.now()}`);
  fs.rmSync(rootDir, { recursive: true, force: true });

  // 让框架配置把记忆根目录指到临时目录（避免污染真实用户目录）
  const configMod = require("../electron/backend/config.cjs");
  const original = configMod.loadConfig;
  configMod.loadConfig = () => {
    const cfg = original();
    cfg.memory = { enabled: true, rootDir };
    return cfg;
  };

  const memory = require("../electron/backend/memory/index.cjs");

  console.log("[1] 模块装配与 IPC 注册");
  memory.register(fakeIpcMain);
  const booted = await memory.boot();
  check("boot 返回启用", booted && booted.enabled === true, JSON.stringify(booted));
  check("IPC 命令数 ≥ 90", handlers.size >= 90, String(handlers.size));

  // preload 白名单与后端 handler 必须一一对应（错一个前端就报「未授权的 IPC 命令」）
  const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.cjs"), "utf8");
  const whitelist = [...preload.matchAll(/"(memory_[a-z_]+)"/g)].map((m) => m[1]);
  const missingHandlers = whitelist.filter((c) => !handlers.has(c));
  const missingWhitelist = [...handlers.keys()].filter((c) => !whitelist.includes(c));
  check("白名单命令全部有实现", missingHandlers.length === 0, missingHandlers.join(","));
  check("实现命令全部进白名单", missingWhitelist.length === 0, missingWhitelist.join(","));

  console.log("[2] 状态与统计");
  const st = await invoke("memory_status");
  check("状态返回启用与根目录", st.ok && st.enabled && st.root === rootDir, JSON.stringify({ enabled: st.enabled, root: st.root }));
  check("本地桥已起且端口 > 0", st.bridge.running === true && st.bridge.port > 0, JSON.stringify(st.bridge));
  const stats = await invoke("memory_stats");
  check("统计返回数字字段", typeof stats.total === "number" && typeof stats.projects === "number", JSON.stringify(stats));

  console.log("[3] 本地桥真实握手（拉子进程跑 tools/mcp-memory-server.cjs）");
  const bridge = path.join(__dirname, "..", "tools", "mcp-memory-server.cjs");
  const handshake = await new Promise((resolve) => {
    const child = spawn(process.execPath, [bridge], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AGENTHUB_MEMORY_RUNTIME: path.join(configMod.dataDir(), "memory-runtime.json") },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let buf = "";
    let toolCount = 0;
    let writeOk = false;
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* 已关闭 */ }
      try { child.kill(); } catch { /* 已退出 */ }
      resolve(payload);
    };
    const timer = setTimeout(() => finish({ ok: false, message: `超时（工具 ${toolCount} 个，写入 ${writeOk ? "成功" : "未完成"}）` }), 20000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === "h1") {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "h2", method: "tools/list" }) + "\n");
        } else if (msg.id === "h2") {
          toolCount = (msg.result && msg.result.tools || []).length;
          child.stdin.write(JSON.stringify({
            jsonrpc: "2.0", id: "h3", method: "tools/call",
            params: { name: "memory_write", arguments: { title: "桥写入验证", content: "这条记忆由 MCP 桥经本地 HTTP API 写入，用于验证端到端链路。", project: "端点验证", tags: ["桥"] } },
          }) + "\n");
        } else if (msg.id === "h3") {
          const text = (msg.result && msg.result.content && msg.result.content[0] && msg.result.content[0].text) || "";
          writeOk = msg.result && msg.result.isError === false && text.includes("mem_");
          finish({ ok: toolCount > 0 && writeOk, toolCount, writeOk, sample: text.slice(0, 80) });
        }
      }
    });
    child.on("error", (e) => finish({ ok: false, message: `进程错误：${e.message}` }));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "h1", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "runtime-smoke", version: "1" } } }) + "\n");
  });
  check("桥进程可启动并完成握手", handshake.ok === true, JSON.stringify(handshake));
  check("桥返回 11 个工具", handshake.toolCount === 11, String(handshake.toolCount));
  check("桥经本地 API 写入成功", handshake.writeOk === true, JSON.stringify(handshake.sample));
  const afterBridge = await invoke("memory_stats");
  check("桥写入落到索引", afterBridge.total >= 1, JSON.stringify({ total: afterBridge.total }));

  console.log("[4] 前端会走的关键 IPC 路径");
  const list = await invoke("memory_list", { pageSize: 10 });
  check("memory_list 返回 rows/total", Array.isArray(list.rows) && typeof list.total === "number", JSON.stringify({ rows: list.rows.length, total: list.total }));
  const search = await invoke("memory_search", { query: "桥写入" });
  check("memory_search 命中并带耗时", search.results.length > 0 && typeof search.tookMs === "number", JSON.stringify({ n: search.results.length }));
  const id = (list.rows[0] || {}).id;
  const detail = await invoke("memory_get", { id });
  check("memory_get 返回正文与相关记忆", detail.memory && typeof detail.memory.body === "string" && Array.isArray(detail.related), JSON.stringify({ title: detail.memory?.title }));
  const heat = await invoke("memory_heatmap", { days: 30 });
  check("memory_heatmap 有今日计数", heat.days.length > 0 && heat.days[heat.days.length - 1].count >= 1, JSON.stringify(heat.days.slice(-1)));
  const cfgEnv = await invoke("memory_config_get");
  check("memory_config_get 返回 schema 与 diff", !!cfgEnv.schema && Array.isArray(cfgEnv.diff), JSON.stringify({ schemaKeys: Object.keys(cfgEnv.schema).length }));
  const saved = await invoke("memory_config_save", { entries: { "search.finalTopK": 6 } });
  check("memory_config_save 校验通过并落盘", saved.ok === true, JSON.stringify(saved));
  const bad = await invoke("memory_config_save", { entries: { "search.finalTopK": 9999 } });
  check("越界值被 schema 拦住", bad.ok === false && String(bad.message).includes("不能大于"), JSON.stringify(bad));
  const idx = await invoke("memory_index_status");
  check("索引状态一致", idx.consistent === true, JSON.stringify({ rows: idx.rows, fts: idx.fts }));
  const digest = await invoke("memory_digest", {});
  check("digest 有内容且行数受限", digest.text.length > 0 && digest.lines <= 200, JSON.stringify({ lines: digest.lines }));
  const agentsList = await invoke("memory_agents_list");
  check("Agent 列表含内置四个", agentsList.agents.length >= 4, String(agentsList.agents.length));
  check("Agent 列表带回启动命令行", !!agentsList.command && typeof agentsList.command.command === "string", JSON.stringify(agentsList.command));
  const snippet = await invoke("memory_agent_snippet", { id: "codex" });
  check("codex 片段走 TOML 分支", snippet.toml.includes("[mcp_servers.agenthub-memory]"), snippet.toml.slice(0, 60));
  const zcodeSnippet = await invoke("memory_agent_snippet", { id: "zcode" });
  check("zcode 片段走 JSON+mcp.servers 分支", zcodeSnippet.json.includes('"mcp"'), zcodeSnippet.json.slice(0, 60));
  const tools = await invoke("memory_agents_tools");
  check("工具能力表含 11 个工具", tools.tools.length === 11, String(tools.tools.length));
  const prov = await invoke("memory_provider_list");
  check("供应商列表初始为空数组", Array.isArray(prov.providers), JSON.stringify(prov.providers.length));
  const auto = await invoke("memory_auto_status");
  check("自动化状态含 9 个任务", auto.tasks.length === 9, String(auto.tasks.length));
  const sourcesRes = await invoke("memory_import_sources");
  check("导入来源 6 个并带游标字段", sourcesRes.sources.length === 6 && "cursor" in sourcesRes.sources[0], String(sourcesRes.sources.length));
  const dedupSt = await invoke("memory_dedup_status");
  check("去重状态含自动删除永久关闭标记", dedupSt.autoDeleteDisabled === true, JSON.stringify(dedupSt));
  const syncSt = await invoke("memory_sync_status");
  check("同步状态带 configured 与阶段", "configured" in syncSt && !!syncSt.stageLabel, JSON.stringify(syncSt.stageLabel));
  const conflicts = await invoke("memory_conflicts_list");
  check("冲突列表可读（空或数组）", Array.isArray(conflicts.conflicts), String(conflicts.conflicts.length));
  const rootGet = await invoke("memory_root_get");
  check("根目录读取正确", rootGet.root === rootDir, rootGet.root);
  const costs = await invoke("memory_costs_estimate");
  check("成本预估表齐全", Object.keys(costs.estimates).length >= 9, String(Object.keys(costs.estimates).length));
  const reports = await invoke("memory_reports_list");
  check("报告列表可读", Array.isArray(reports.reports));

  console.log("[5] 隐私与失败路径");
  await invoke("memory_config_save", { entries: { "privacy.pause": true } });
  const blocked = await invoke("memory_write", { title: "隐私模式", body: "不该写入" });
  check("隐私模式拒绝写入", blocked.ok === false && String(blocked.message).includes("隐私模式"), JSON.stringify(blocked));
  await invoke("memory_config_save", { entries: { "privacy.pause": false } });
  const unknown = await invoke("memory_get", { id: "mem_不存在" });
  check("取不存在的记忆返回失败而非抛异常", unknown.ok === false, JSON.stringify(unknown));

  // shutdown 已改为异步（先 drain 在途任务再关库），调用必须 await 契约才成立
  await memory.shutdown();
  check("shutdown 后状态归零", memory.status().enabled === false);
  fs.rmSync(rootDir, { recursive: true, force: true });
  configMod.loadConfig = original;

  console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
  if (failCount) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  app.exit(failCount ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error("运行时自测崩溃：", (e && e.stack) || e);
    app.exit(2);
  }),
);

/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 连接三级校验：配置态（文件里有没有）→ 握手态（真拉起桥发 initialize+tools/list）
// → 真实调用态（桥有没有回传心跳）。三级全过才是绿色"已连接"（§5.4）。
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const agents = require("./agents.cjs");
const inject = require("./inject.cjs");

// MCP 桥物理路径候选（修正清单 B1：args 指向物理 JS，走 ELECTRON_RUN_AS_NODE）
function bridgeCandidates(appPath, resourcesPath) {
  const out = [];
  if (resourcesPath) out.push(path.join(resourcesPath, "mcp", "mcp-memory-server.cjs"));
  if (appPath) out.push(path.join(path.dirname(appPath), "resources", "mcp", "mcp-memory-server.cjs"));
  // 开发环境：源码树
  out.push(path.resolve(__dirname, "..", "..", "..", "tools", "mcp-memory-server.cjs"));
  return out;
}

function resolveBridge(appPath, resourcesPath) {
  for (const c of bridgeCandidates(appPath, resourcesPath)) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function resolveHostExe(appPath) {
  if (appPath && fs.existsSync(appPath) && /\.exe$/i.test(appPath)) return appPath;
  // 开发环境（electron.exe 起 dev）：退回主程序 exe 的常见安装位置探测
  const candidates = [
    appPath,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "AgentHub", "AgentHub.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "AgentHub", "AgentHub.exe"),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return appPath || null;
}

// 注入预览/实际写入用的命令行（含路径可达性预检结果）。
// opts.agentId：写入具体 Agent 配置时必须带上，桥用它上报心跳归属（三级校验按 adapter.id 匹配）。
function connectionCommand(opts) {
  const host = resolveHostExe(opts.appPath);
  const bridge = resolveBridge(opts.appPath, opts.resourcesPath);
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  if (opts.agentId) env.AGENTHUB_AGENT = opts.agentId;
  return {
    command: host,
    args: bridge ? [bridge] : [],
    env,
    hostExists: !!(host && fs.existsSync(host)),
    bridgeExists: !!(bridge && fs.existsSync(bridge)),
    candidates: bridgeCandidates(opts.appPath, opts.resourcesPath),
  };
}

function renderSnippet(adapter, cmd, format) {
  const fmt = format || "json";
  // 只有 command/args/env 可以进用户配置，hostExists 等内部预检字段不外泄
  const pub = { command: cmd.command, args: cmd.args, env: cmd.env };
  if (fmt === "toml" || adapter.format === "toml-mcp_servers") {
    const envPairs = Object.entries(pub.env || {}).map(([k, v]) => `${k} = ${inject.tomlString(v)}`).join(", ");
    return [
      `[mcp_servers.${inject.SERVER_KEY}]`,
      `command = ${inject.tomlString(pub.command)}`,
      `args = [${pub.args.map(inject.tomlString).join(", ")}]`,
      `env = { ${envPairs} }`,
      `startup_timeout_sec = 20`,
    ].join("\n");
  }
  if (fmt === "cli") {
    return `${pub.command} ${pub.args.join(" ")}`;
  }
  if (adapter.id === "zcode") {
    return JSON.stringify({ mcp: { servers: { [inject.SERVER_KEY]: { type: "stdio", ...pub, enabled: true } } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { [inject.SERVER_KEY]: { type: "stdio", ...pub } } }, null, 2);
}

// ---------- 三级校验 ----------

function verifyConfig(adapter) {
  const result = { level: "config", ok: false, message: "", detail: {} };
  if (!adapter.configExists) {
    result.message = "配置文件不存在";
    return result;
  }
  if (adapter.format === "toml-mcp_servers") {
    if (!inject.tomlHasEntry(adapter)) {
      result.message = "配置文件中没有 agenthub-memory 条目";
      return result;
    }
    result.ok = true;
    result.message = "已配置";
    return result;
  }
  const has = inject.jsonHasEntry(adapter);
  if (!has || !has.present) {
    result.message = "配置文件中没有 agenthub-memory 条目";
    return result;
  }
  if (has.disabled) {
    result.message = "条目存在但 enabled=false";
    return result;
  }
  result.ok = true;
  result.message = "已配置";
  result.detail.entry = has;
  return result;
}

function handshake(cmd, timeoutMs) {
  return new Promise((resolve) => {
    if (!cmd.hostExists || !cmd.bridgeExists) {
      return resolve({ ok: false, message: "启动路径不可达（exe 或桥脚本缺失）" });
    }
    const t0 = Date.now();
    let child;
    try {
      child = spawn(cmd.command, cmd.args, {
        env: { ...process.env, ...cmd.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, message: `桥启动失败：${e.message}` });
    }
    let buffer = "";
    let stdoutMeta = "{}";
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 进程可能已退出 */ }
      resolve(payload);
    };
    const timer = setTimeout(() => finish({ ok: false, message: "握手超时（20 秒）" }), timeoutMs || 20000);
    child.on("error", (e) => { clearTimeout(timer); finish({ ok: false, message: `桥进程错误：${e.message}` }); });
    // 子进程秒退时立刻返回，不必等满 20 秒超时
    child.on("exit", (code) => { if (!settled) finish({ ok: false, message: `桥进程退出（code ${code}）` }); });
    if (child.stdin) child.stdin.on("error", () => { /* 子进程先退出时的 EPIPE，按失败处理即可 */ });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === "h1" && msg.result) {
          stdoutMeta = msg.result.serverInfo ? JSON.stringify(msg.result.serverInfo) : "{}";
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "h2", method: "tools/list" }) + "\n");
        } else if (msg.id === "h2") {
          clearTimeout(timer);
          const count = msg.result && Array.isArray(msg.result.tools) ? msg.result.tools.length : 0;
          if (!count) finish({ ok: false, message: "握手成功但工具清单为空" });
          else finish({ ok: true, latencyMs: Date.now() - t0, tools: count, serverInfo: safeParse(stdoutMeta) });
        }
      }
    });
    try {
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: "h1", method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agenthub-verify", version: "1.0.0" } },
      }) + "\n");
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, message: `桥进程不可写：${e.message}` });
    }
  });
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

async function verifyAgent(adapter, opts) {
  const cmd = connectionCommand(opts || {});
  const config = verifyConfig(adapter);
  const beat = opts && opts.beats ? opts.beats.find((b) => b.agent === adapter.id) : null;
  const real = beat && beat.last_call
    ? { ok: true, lastCall: beat.last_call, calls: beat.calls, lastTool: beat.last_tool, writes: beat.writes, searches: beat.searches, errors: beat.errors }
    : { ok: false, message: "尚未观察到真实调用" };
  const hs = opts && opts.skipHandshake ? { ok: false, message: "未执行握手（配置态与真实态已足够）" } : await handshake(cmd, opts && opts.timeoutMs);

  let level = "none";
  if (config.ok && hs.ok && real.ok) level = "verified";
  else if (config.ok && hs.ok) level = "handshaked";
  else if (config.ok) level = "configured";
  else if (adapter.configExists) level = "detected";
  return {
    agent: adapter.id,
    name: adapter.name,
    level,
    config,
    handshake: hs,
    real,
    command: cmd,
    configPath: adapter.configPath,
    instructionPath: adapter.instruction && adapter.instruction.path,
    instructionInjected: adapter.instruction && adapter.instruction.path ? inject.hasBlock(adapter.instruction.path) : false,
  };
}

async function verifyAll(opts) {
  const cfgAgents = opts && opts.cfg ? opts.cfg : {};
  const list = agents.list(cfgAgents).filter((a) => a.enabled);
  const beats = opts && opts.beats ? opts.beats : [];
  const out = [];
  for (const a of list) {
    out.push(await verifyAgent(a, { ...(opts || {}), beats }));
  }
  return out;
}

module.exports = { verifyAgent, verifyAll, verifyConfig, handshake, connectionCommand, renderSnippet, resolveBridge, resolveHostExe, bridgeCandidates };

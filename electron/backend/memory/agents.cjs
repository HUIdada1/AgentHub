/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · Agent 适配器注册表：各工具的配置路径、容器键、格式与指令文件。
// 路径全部实测过（可行性复核 §3.1）；实现用「候选列表 + 探测第一个存在的」，不硬编码单一路径。
"use strict";

const path = require("path");
const os = require("os");
const { existsSync } = require("fs");

const HOME = os.homedir();
const SERVER_KEY = "agenthub-memory";

// format: json-mcpServers（{mcpServers:{}}）
//       | json-mcp.servers（{mcp:{servers:{}}}）
//       | toml-mcp_servers（[mcp_servers.x]）
const ADAPTERS = [
  {
    id: "zcode",
    name: "ZCode",
    configCandidates: [path.join(HOME, ".zcode", "cli", "config.json")],
    format: "json-mcp.servers",
    container: ["mcp", "servers"],
    hasEnabledField: true,
    instructionCandidates: [path.join(HOME, ".zcode", "AGENTS.md")],
    snippetHint: "写入 ~/.zcode/cli/config.json 的 mcp.servers",
  },
  {
    id: "codex",
    name: "Codex CLI",
    configCandidates: [path.join(HOME, ".codex", "config.toml")],
    format: "toml-mcp_servers",
    table: "mcp_servers",
    instructionCandidates: [path.join(HOME, ".codex", "AGENTS.md")],
    snippetHint: "写入 ~/.codex/config.toml 的 [mcp_servers.agenthub-memory]",
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    configCandidates: [path.join(HOME, ".workbuddy-ai", "mcp.json")],
    format: "json-mcpServers",
    container: ["mcpServers"],
    instructionCandidates: [path.join(HOME, ".workbuddy-ai", "AGENTS.md")],
    instructionMissingHint: "该文件实测不存在，注入时会新建并带上最小头部",
    snippetHint: "写入 ~/.workbuddy-ai/mcp.json 的 mcpServers",
  },
  {
    id: "claude",
    name: "Claude Code",
    configCandidates: [path.join(HOME, ".claude.json")],
    format: "json-mcpServers",
    container: ["mcpServers"],
    instructionCandidates: [path.join(HOME, ".claude", "CLAUDE.md")],
    note: "Claude Code 不直接读 AGENTS.md，受控块写 CLAUDE.md",
    snippetHint: "写入 ~/.claude.json 的 mcpServers",
  },
  {
    id: "cursor",
    name: "Cursor",
    configCandidates: [path.join(HOME, ".cursor", "mcp.json")],
    format: "json-mcpServers",
    container: ["mcpServers"],
    instructionCandidates: [path.join(HOME, ".cursor", "rules", "agenthub-memory.mdc")],
    optional: true,
    note: ".mdc 必须有 YAML frontmatter，否则被静默忽略",
    snippetHint: "写入 ~/.cursor/mcp.json（规则文件需 .mdc frontmatter）",
  },
  {
    id: "agents",
    name: "通用（~/.agents）",
    configCandidates: [path.join(HOME, ".agents", "mcp.json")],
    format: "json-mcpServers",
    container: ["mcpServers"],
    instructionCandidates: [path.join(HOME, ".agents", "AGENTS.md")],
    optional: true,
    snippetHint: "跨工具兜底路径",
  },
];

function firstExisting(candidates) {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function resolveConfig(adapter) {
  const existing = firstExisting(adapter.configCandidates);
  return existing || adapter.configCandidates[0];
}

function resolveInstruction(adapter) {
  const existing = firstExisting(adapter.instructionCandidates);
  return { path: existing || adapter.instructionCandidates[0], exists: !!existing };
}

function list(cfg) {
  const enabled = new Set((cfg && cfg.enabled) || ADAPTERS.map((a) => a.id));
  const custom = (cfg && cfg.custom) || [];
  return ADAPTERS.map((a) => ({
    ...a,
    enabled: enabled.has(a.id),
    configPath: resolveConfig(a),
    configExists: existsSync(resolveConfig(a)),
    instruction: resolveInstruction(a),
  })).concat(custom.map((c) => ({
    id: c.id,
    name: c.name || c.id,
    configCandidates: [c.path],
    format: c.format || "json-mcpServers",
    container: ["mcpServers"],
    custom: true,
    enabled: true,
    configPath: c.path,
    configExists: existsSync(c.path),
    instruction: { path: c.instructionPath || "", exists: c.instructionPath ? existsSync(c.instructionPath) : false },
    snippetHint: `自定义：${c.format || "json-mcpServers"}`,
  })));
}

function byId(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}

module.exports = { ADAPTERS, SERVER_KEY, list, byId, resolveConfig, resolveInstruction, firstExisting };

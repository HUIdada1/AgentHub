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

// 记忆中枢 · Agent 适配器注册表：各工具的配置路径、容器键、格式与指令文件。
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
    id: "dsh",
    name: "DeepSeek Harness",
    // DSH 不读取任何 mcp.json（官方 app.asar 全文检索 "mcp.json" 0 命中，issue #170 取证）。
    // 官方 MCP 接入走 profile 的 cordis.patch.yml patch 层：insert @deepseek-ai/dsh-mcp-client
    // （本机 profiles/desktop 实样与 asar 内 218 处 cordis.patch 引用交叉验证）。
    // 候选按桌面端优先排序；注入/校验实际覆盖 ~/.dsh/profiles/ 下全部已存在 profile
    configCandidates: [
      path.join(HOME, ".dsh", "profiles", "desktop", "cordis.patch.yml"),
      path.join(HOME, ".dsh", "profiles", "web", "cordis.patch.yml"),
      path.join(HOME, ".dsh", "profiles", "headless", "cordis.patch.yml"),
    ],
    format: "yml-cordis-patch",
    instructionCandidates: [
      path.join(HOME, ".dsh", "AGENTS.md"),
      path.join(HOME, ".dsh", "CLAUDE.md"),
    ],
    snippetHint: "写入 ~/.dsh/profiles/<profile>/cordis.patch.yml 的 agenthub-memory 受控块",
    note: "DSH 不读取 mcp.json，经 cordis.patch.yml 接入（issue #170）",
  },
  {
    id: "trae-solo",
    name: "Trae Solo",
    configCandidates: [
      path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "TRAE SOLO", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "TRAE SOLO CN", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      path.join(HOME, "Library", "Application Support", "TRAE SOLO", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      path.join(HOME, ".config", "TRAE SOLO", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      path.join(HOME, ".trae-solo", "mcp.json"),
      path.join(HOME, ".trae", "mcp.json"),
    ],
    format: "json-mcpServers",
    container: ["mcpServers"],
    instructionCandidates: [
      path.join(HOME, ".trae-solo", "AGENTS.md"),
      path.join(HOME, ".trae", "AGENTS.md"),
    ],
    snippetHint: "写入 ~/.trae-solo/mcp.json 或 TRAE SOLO 用户目录",
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
  {
    // Qoder 双区：本项为**国际版** ~/.qoder；CN 版是下一项 ~/.qoder-cn
    // （与用量同步模块的目录口径一致，见 electron/backend/adapter-qoder*.cjs；
    //  注意与反代渠道的 id 命名不同——那边 qoder 指 CN 版）。
    // 路径与字段依据官方文档（非推测）：docs.qoder.com/zh/cli/mcp-reference
    //   「用户级 ~/.qoder/settings.json → mcpServers，对所有项目可用」；
    //   指令文件为 AGENTS.md（CLI 静态记忆，见 /zh/cli/memory）。
    // 注意：settings.json 同时承载 CLI 其它设置，注入必须走受控块合并，不可整体覆写。
    id: "qoder",
    name: "Qoder",
    configCandidates: [path.join(HOME, ".qoder", "settings.json")],
    format: "json-mcpServers",
    container: ["mcpServers"],
    instructionCandidates: [path.join(HOME, ".qoder", "AGENTS.md")],
    instructionMissingHint: "首次注入会新建该文件并带最小头部",
    snippetHint: "写入 ~/.qoder/settings.json 的 mcpServers（用户级作用域）",
  },
  {
    id: "qoder-cn",
    name: "Qoder CN",
    configCandidates: [path.join(HOME, ".qoder-cn", "settings.json")],
    format: "json-mcpServers",
    container: ["mcpServers"],
    instructionCandidates: [path.join(HOME, ".qoder-cn", "AGENTS.md")],
    instructionMissingHint: "首次注入会新建该文件并带最小头部",
    snippetHint: "写入 ~/.qoder-cn/settings.json 的 mcpServers（用户级作用域）",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    configCandidates: [
      path.join(HOME, ".gemini", "config", "mcp_config.json"),
      path.join(HOME, ".gemini", "antigravity", "mcp_config.json"),
      path.join(HOME, ".gemini", "antigravity-ide", "mcp_config.json"),
      path.join(HOME, ".gemini", "mcp_config.json"),
    ],
    format: "json-mcpServers",
    container: ["mcpServers"],
    instructionCandidates: [
      path.join(HOME, ".gemini", "config", "GEMINI.md"),
      path.join(HOME, ".gemini", "GEMINI.md"),
      path.join(HOME, ".gemini", "antigravity", "GEMINI.md"),
      path.join(HOME, ".gemini", "config", "AGENTS.md"),
    ],
    instructionMissingHint: "首次注入会新建该文件并带最小头部",
    snippetHint: "写入 ~/.gemini/config/mcp_config.json 的 mcpServers",
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

/** cordis 格式：profiles 下任一 cordis.patch.yml 存在即「有配置文件可注入」 */
function anyCordisPatchExists(adapter) {
  const first = adapter.configCandidates && adapter.configCandidates[0];
  if (!first) return false;
  const profilesDir = path.dirname(path.dirname(first));
  try {
    for (const d of require("fs").readdirSync(profilesDir, { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(path.join(profilesDir, d.name, "cordis.patch.yml"))) return true;
    }
  } catch { /* profiles 目录不存在 */ }
  return false;
}

function list(cfg) {
  const enabled = new Set((cfg && cfg.enabled) || ADAPTERS.map((a) => a.id));
  const custom = (cfg && cfg.custom) || [];
  return ADAPTERS.map((a) => ({
    ...a,
    enabled: enabled.has(a.id),
    configPath: resolveConfig(a),
    // cordis 格式的「已配置」判定不绑定单一候选：profiles 下任一 patch 文件存在即算
    configExists: a.format === "yml-cordis-patch"
      ? anyCordisPatchExists(a)
      : existsSync(resolveConfig(a)),
    instruction: resolveInstruction(a),
  })).concat(custom.map((c) => {
    // 容器按 format 推导，不再硬编码 ["mcpServers"]：自定义 toml 适配器若沿用 JSON 容器
    // 结构，注入会写坏配置文件（toml 路径认 table 不认 container）
    const fmt = c.format || "json-mcpServers";
    const container = fmt === "json-mcp.servers" ? ["mcp", "servers"] : ["mcpServers"];
    return {
      id: c.id,
      name: c.name || c.id,
      configCandidates: [c.path],
      format: fmt,
      container,
      ...(fmt === "toml-mcp_servers" ? { table: "mcp_servers" } : {}),
      custom: true,
      enabled: true,
      configPath: c.path,
      configExists: existsSync(c.path),
      instruction: { path: c.instructionPath || "", exists: c.instructionPath ? existsSync(c.instructionPath) : false },
      snippetHint: `自定义：${fmt}`,
    };
  }));
}

function byId(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}

module.exports = { ADAPTERS, SERVER_KEY, list, byId, resolveConfig, resolveInstruction, firstExisting };

/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 配置注入与受控块管理：写 Agent 的 MCP 配置条目 + 指令块，全部幂等且可一键卸载。
// 三条铁律（可行性复核 R3）：写前备份；只动自己的块/条目；TOML 只做文本级行增删，绝不全量解析。
"use strict";

const fs = require("fs");
const path = require("path");

const BLOCK_BEGIN = "<!-- agenthub-memory:begin -->";
const BLOCK_END = "<!-- agenthub-memory:end -->";
const SERVER_KEY = "agenthub-memory";

const INSTRUCTION_BLOCK = `${BLOCK_BEGIN}
## 记忆仓库（AgentHub · 本机项目记忆）
- 适用：**本机项目**的上下文、决策、踩坑、代码约定（存在本地磁盘，随项目走）。
- 会话开始或需要了解背景时，先调用 \`memory_core\`。
- 用户提到「之前/上次/这个项目怎么定的」时，先 \`memory_search\`，基于结果回答并标注来源。
- 完成任务或做出重要决策后，调用 \`memory_write\` 记录（附项目与标签）。
- 不要一次性读取全部记忆（\`memory_search\` 返回摘要，精读用 \`memory_get\`）。
- **与团队记忆（TD）的分工**：本工具管**本机项目记忆**；涉及**团队/组织级**的历史与规范，
  请用 TD 的 \`tdai.memory_search\`。两者不要混用同一问题。
${BLOCK_END}`;

function backupFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const bak = `${file}.bak.${Date.now()}`;
    fs.copyFileSync(file, bak);
    return bak;
  } catch {
    return null;
  }
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  fs.renameSync(tmp, file);
}

// ---------- 指令受控块（AGENTS.md / CLAUDE.md） ----------

function injectBlock(file, block, { createHeader = "# 全局规则\n\n" } = {}) {
  let text = "";
  let created = false;
  if (fs.existsSync(file)) {
    text = fs.readFileSync(file, "utf8");
  } else {
    text = createHeader;
    created = true;
  }
  const bak = backupFile(file);
  const begin = text.indexOf(BLOCK_BEGIN);
  if (begin >= 0) {
    const end = text.indexOf(BLOCK_END, begin);
    if (end >= 0) {
      const next = text.slice(0, begin) + block + text.slice(end + BLOCK_END.length);
      writeAtomic(file, next.replace(/\n{3,}/g, "\n\n"));
      return { ok: true, action: "replaced", file, backup: bak };
    }
  }
  const sep = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  writeAtomic(file, `${text}${sep}${block}\n`);
  return { ok: true, action: created ? "created" : "appended", file, backup: bak };
}

function removeBlock(file) {
  if (!fs.existsSync(file)) return { ok: true, action: "noop", file };
  const text = fs.readFileSync(file, "utf8");
  const begin = text.indexOf(BLOCK_BEGIN);
  if (begin < 0) return { ok: true, action: "noop", file };
  const end = text.indexOf(BLOCK_END, begin);
  if (end < 0) return { ok: false, action: "error", file, message: "受控块起始标记存在但结束标记缺失，请手动处理" };
  const bak = backupFile(file);
  const before = text.slice(0, begin).replace(/\n+$/, "\n");
  const after = text.slice(end + BLOCK_END.length).replace(/^\n+/, "");
  writeAtomic(file, before + after);
  return { ok: true, action: "removed", file, backup: bak };
}

function hasBlock(file) {
  try { return fs.readFileSync(file, "utf8").includes(BLOCK_BEGIN); } catch { return false; }
}

// ---------- MCP 配置条目 ----------

function jsonEntry(command, args, env) {
  return { type: "stdio", command, args, env, enabled: true };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function injectJsonConfig(adapter, command, args, env) {
  const file = adapter.configPath;
  const existing = readJson(file);
  if (existing === null && fs.existsSync(file)) {
    return { ok: false, message: `配置文件无法解析为 JSON，已拒绝写入：${file}` };
  }
  const bak = backupFile(file);
  const data = existing && typeof existing === "object" ? existing : {};
  let node = data;
  for (const key of adapter.container.slice(0, -1)) {
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key];
  }
  const leaf = adapter.container[adapter.container.length - 1];
  if (typeof node[leaf] !== "object" || node[leaf] === null) node[leaf] = {};
  const entry = jsonEntry(command, args, env);
  if (!adapter.hasEnabledField) delete entry.enabled;
  node[leaf][SERVER_KEY] = entry;
  writeAtomic(file, JSON.stringify(data, null, 2));
  return { ok: true, action: "injected", file, backup: bak, entry };
}

function uninjectJsonConfig(adapter) {
  const file = adapter.configPath;
  const data = readJson(file);
  if (!data) return { ok: true, action: "noop", file };
  let node = data;
  for (const key of adapter.container) {
    if (!node || typeof node[key] !== "object") return { ok: true, action: "noop", file };
    node = node[key];
  }
  if (!node[SERVER_KEY]) return { ok: true, action: "noop", file };
  const bak = backupFile(file);
  if (adapter.hasEnabledField) {
    // zcode 实测：条目带 enabled，卸载改 false 保留用户可能自填的 env
    node[SERVER_KEY].enabled = false;
  } else {
    delete node[SERVER_KEY];
  }
  writeAtomic(file, JSON.stringify(data, null, 2));
  return { ok: true, action: "uninjected", file, backup: bak };
}

// ---------- TOML（只做文本级行增删，绝不全量解析） ----------

function injectTomlConfig(adapter, command, args, env) {
  const file = adapter.configPath;
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const bak = backupFile(file);
  const header = `[${adapter.table}.${SERVER_KEY}]`;
  const envPairs = Object.entries(env || {}).map(([k, v]) => `${k} = ${tomlString(v)}`).join(", ");
  const block = [
    header,
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    ...(envPairs ? [`env = { ${envPairs} }`] : []),
    `startup_timeout_sec = 20`,
    `default_tools_approval_mode = "auto"`,
  ].join("\n");
  const range = tomlBlockRange(text, header);
  let next;
  if (range) {
    next = text.slice(0, range.start) + block + "\n" + text.slice(range.end);
  } else {
    // 一律追加到文末：父表 [mcp_servers] 若已存在（实测 codex 就是），
    // 子表写在哪里都合法；文末追加对用户已有内容零扰动，也就不需要担心重复写父表
    const sep = text && !text.endsWith("\n") ? "\n" : "";
    next = text + `${sep}\n${block}\n`;
  }
  writeAtomic(file, next.replace(/\n{3,}/g, "\n\n"));
  return { ok: true, action: "injected", file, backup: bak };
}

function uninjectTomlConfig(adapter) {
  const file = adapter.configPath;
  if (!fs.existsSync(file)) return { ok: true, action: "noop", file };
  const text = fs.readFileSync(file, "utf8");
  const header = `[${adapter.table}.${SERVER_KEY}]`;
  const range = tomlBlockRange(text, header);
  if (!range) return { ok: true, action: "noop", file };
  const bak = backupFile(file);
  // 连同紧邻的前导空行一起删掉，避免留下连续空行
  let start = range.start;
  while (start > 0 && text[start - 1] === "\n") start--;
  const next = (text.slice(0, start) + text.slice(range.end)).replace(/\n{3,}/g, "\n\n");
  writeAtomic(file, next);
  return { ok: true, action: "uninjected", file, backup: bak };
}

// 从 header 行起，到下一个以 [ 开头的行（不含）为止
function tomlBlockRange(text, header, opts = {}) {
  const lines = text.split("\n");
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (opts.exact ? t === header : (t === header || t.startsWith(header + "."))) { startIdx = i; break; }
  }
  if (startIdx < 0) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("[")) { endIdx = i; break; }
  }
  const offsets = [];
  let acc = 0;
  for (const l of lines) { offsets.push(acc); acc += l.length + 1; }
  return { start: offsets[startIdx], end: endIdx === lines.length ? text.length : offsets[endIdx], startLine: startIdx + 1, endLine: endIdx };
}

function tomlString(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function tomlHasEntry(adapter) {
  try {
    return !!tomlBlockRange(fs.readFileSync(adapter.configPath, "utf8"), `[${adapter.table}.${SERVER_KEY}]`);
  } catch { return false; }
}

function jsonHasEntry(adapter) {
  const data = readJson(adapter.configPath);
  if (!data) return false;
  let node = data;
  for (const key of adapter.container) {
    if (!node || typeof node[key] !== "object") return false;
    node = node[key];
  }
  const entry = node[SERVER_KEY];
  if (!entry) return false;
  if (adapter.hasEnabledField && entry.enabled === false) return { present: true, disabled: true };
  return { present: true, disabled: false };
}

module.exports = {
  BLOCK_BEGIN, BLOCK_END, SERVER_KEY, INSTRUCTION_BLOCK,
  injectBlock, removeBlock, hasBlock,
  injectJsonConfig, uninjectJsonConfig, injectTomlConfig, uninjectTomlConfig,
  tomlHasEntry, jsonHasEntry, backupFile, writeAtomic, tomlBlockRange, tomlString,
};

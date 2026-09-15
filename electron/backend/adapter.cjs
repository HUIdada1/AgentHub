// 工具适配器：内置注册表 + 用户自定义条目 + 电脑扫描发现
// 一个适配器 = { id, name, icon, enabled, paths[] }，id 是引用键（manifest/冲突/报告都记它），创建后不可改
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 内置工具：id/图标/默认候选路径定在这，config.json 只覆盖用户可改的部分（name/paths/enabled）
const TOOL_REGISTRY = [
  { id: "zcode", name: "ZCode", icon: "ph-terminal-window", defaultPaths: [".zcode/skills"] },
  { id: "codex", name: "Codex CLI", icon: "ph-command", defaultPaths: [".codex/skills"] },
  { id: "claude", name: "Claude Code", icon: "ph-sparkle", defaultPaths: [".claude/skills"] },
  { id: "antigravity", name: "Antigravity", icon: "ph-airplane-tilt", defaultPaths: [".gemini/antigravity/skills", ".gemini/config/skills"] },
  { id: "agents", name: "通用 ~/.agents", icon: "ph-package", defaultPaths: [".agents/skills"] },
];

// 社区常见 agent 技能目录探测表：只只读探测，用户确认添加才写进配置。
// 路径支持 ~（用户目录）与 %APPDATA% / %LOCALAPPDATA% 前缀。路径是"社区常见"，不保证都准，命中即建议、用户可改
const KNOWN_AGENTS = [
  { suggestId: "cursor", name: "Cursor", icon: "ph-robot", hitPaths: [".cursor/skills", "%APPDATA%/Cursor/User/skills"] },
  { suggestId: "qoder", name: "Qoder", icon: "ph-command", hitPaths: [".qoder/skills"] },
  { suggestId: "roo", name: "Roo Code", icon: "ph-robot", hitPaths: [".roo/skills", ".roo-code/skills"] },
  { suggestId: "kilocode", name: "Kilo Code", icon: "ph-code", hitPaths: [".kilocode/skills"] },
  { suggestId: "gemini", name: "Gemini CLI", icon: "ph-sparkle", hitPaths: [".gemini/skills"] },
  { suggestId: "windsurf", name: "Windsurf", icon: "ph-sparkle", hitPaths: [".windsurf/skills"] },
  { suggestId: "opencode", name: "OpenCode", icon: "ph-command", hitPaths: [".opencode/skills"] },
  { suggestId: "trae", name: "Trae", icon: "ph-airplane-tilt", hitPaths: [".trae/skills"] },
  { suggestId: "augment", name: "Augment Code", icon: "ph-brain", hitPaths: [".augment/skills"] },
];

const ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// 自测脚本用 AGENT_SKILLS_FAKE_HOME 把 home 指到临时目录，绝不碰用户真实 home
function fakeHome() {
  return process.env.AGENT_SKILLS_FAKE_HOME || os.homedir();
}

// 候选路径展开：~ → 用户目录；%APPDATA%/%LOCALAPPDATA% → 系统数据目录；相对路径按用户目录算
function expandPath(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  const home = fakeHome();
  const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppdata = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  if (s.startsWith("%APPDATA%")) return path.join(appdata, s.slice(9));
  if (s.startsWith("%LOCALAPPDATA%")) return path.join(localAppdata, s.slice(15));
  if (s.startsWith("~")) return path.join(home, s.slice(1));
  return path.isAbsolute(s) ? s : path.join(home, s);
}

function isBuiltinId(id) {
  return TOOL_REGISTRY.some((b) => b.id === id);
}

// 名称转 id：英文数字连字符保留，其余压成 -；压没了就给 agent
function slugifyId(name) {
  const s = String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const clean = s.replace(/[^a-z0-9_-]/g, "");
  if (clean && /^[a-z0-9]/.test(clean) && ID_REGEX.test(clean)) return clean;
  return "agent";
}

// 生成不撞号的可用 id：与内置注册表和现有工具都不重复，撞了就加 -2/-3
function freshId(cfg, want) {
  const base = slugifyId(want);
  const taken = new Set(Object.keys(cfg.tools || {}));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const cand = `${base}-${i}`;
    if (!taken.has(cand)) return cand;
  }
  return `${base}-${Date.now()}`;
}

// 融合出完整条目：内置的拿注册表默认再叠 config 覆盖；注册表里没有的按自定义条目解析
function toolEntry(cfg, id) {
  const meta = TOOL_REGISTRY.find((b) => b.id === id);
  const t = (cfg.tools || {})[id];
  if (meta) {
    const paths = t && Array.isArray(t.paths) && t.paths.length ? t.paths : meta.defaultPaths;
    return {
      id, builtin: true, deletable: false,
      name: (t && t.name) || meta.name,
      icon: (t && t.icon) || meta.icon,
      enabled: !t || t.enabled !== false,
      paths,
    };
  }
  return {
    id, builtin: false, deletable: true,
    name: (t && t.name) || id,
    icon: (t && t.icon) || "ph-robot",
    enabled: !t || t.enabled !== false,
    paths: (t && Array.isArray(t.paths)) ? t.paths : [],
  };
}

// 全部工具 id：内置在前，用户自定义的跟在后
function toolIds(cfg) {
  const ids = TOOL_REGISTRY.map((b) => b.id);
  for (const k of Object.keys(cfg.tools || {})) {
    if (!ids.includes(k)) ids.push(k);
  }
  return ids;
}

// 候选路径按顺序找，全都没有就返回 dir: null（调用方自己看着办）
function resolveToolDir(cfg, toolId) {
  const e = toolEntry(cfg, toolId);
  if (e.enabled === false) return null;
  for (const rel of e.paths) {
    const p = expandPath(rel);
    if (p && fs.existsSync(p)) return { id: e.id, name: e.name, icon: e.icon, dir: p, candidatePaths: e.paths };
  }
  return { id: e.id, name: e.name, icon: e.icon, dir: null, candidatePaths: e.paths };
}

function resolveScanTargets(cfg) {
  const out = [];
  for (const id of toolIds(cfg)) {
    const r = resolveToolDir(cfg, id);
    if (r && r.dir) out.push(r);
  }
  for (const abs of cfg.customDirs || []) {
    const p = expandPath(abs);
    if (p && fs.existsSync(p)) out.push({ id: "custom", name: "自定义目录", icon: "ph-folder-open", dir: p });
  }
  return out;
}

// 设置页用：包含没启用/没找到的，好让界面上能看出来
function listTools(cfg) {
  const rows = [];
  for (const id of toolIds(cfg)) {
    const e = toolEntry(cfg, id);
    const r = resolveToolDir(cfg, id);
    rows.push({
      id: e.id,
      name: e.name,
      icon: e.icon,
      builtin: e.builtin,
      deletable: e.deletable,
      enabled: e.enabled,
      dir: r && r.dir ? r.dir : null,
      candidatePaths: e.paths,
    });
  }
  return rows;
}

// 目录下子目录数（Windows 上 junction 的 dirent.isDirectory() 是 false，天然不计），仅探测展示用
function countSkillDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

// 电脑扫描发现：只读探测第三方 agent 技能目录，不写任何东西。已注册的 id 与其命中路径都过滤掉
function probeAgents(cfg) {
  const registeredIds = new Set(toolIds(cfg));
  const registeredDirs = new Set();
  for (const id of toolIds(cfg)) {
    const e = toolEntry(cfg, id);
    for (const p of e.paths) {
      const abs = expandPath(p).toLowerCase();
      if (abs) registeredDirs.add(abs);
    }
  }
  for (const abs of (cfg.customDirs || [])) {
    const p = expandPath(abs);
    if (p) registeredDirs.add(p.toLowerCase());
  }
  const detected = [];
  for (const k of KNOWN_AGENTS) {
    const hitDirs = k.hitPaths.map(expandPath).filter((p) => p && fs.existsSync(p));
    if (!hitDirs.length) continue;
    if (registeredIds.has(k.suggestId)) continue;
    const fresh = hitDirs.filter((d) => !registeredDirs.has(d.toLowerCase()));
    if (!fresh.length) continue;
    detected.push({
      suggestId: freshId(cfg, k.suggestId),
      name: k.name,
      icon: k.icon,
      hitDirs: fresh.map((d) => path.resolve(d)),
      skillCount: countSkillDirs(fresh[0]),
    });
  }
  return detected;
}

module.exports = { TOOL_REGISTRY, KNOWN_AGENTS, isBuiltinId, slugifyId, freshId, expandPath, toolEntry, resolveToolDir, resolveScanTargets, listTools, probeAgents };
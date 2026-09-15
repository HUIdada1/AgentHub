// 扫描：SKILL.md 解析、体检、内容树哈希
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// 只认 name/description/metadata.version，别的字段不动它。
// description 支持 YAML 块标量（| 或 >），anthropic 官方技能很多这么写
function parseSkillMd(dir) {
  const file = path.join(dir, "SKILL.md");
  const raw = fs.readFileSync(file, "utf-8");
  const info = { name: "", description: "", version: "", extra: {} };
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { ok: false, info, reason: "no-frontmatter", raw };
  const lines = m[1].split(/\r?\n/);
  let currentKey = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const nested = line.match(/^\s+(\S+):\s*(.*)$/);
    if (nested && currentKey === "metadata") {
      if (nested[1] === "version") info.version = stripQuotes(nested[2]);
      continue;
    }
    const top = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!top) continue;
    currentKey = top[1];
    let val = stripQuotes(top[2]);
    if (/^[|>][+-]?\d*$/.test(top[2].trim())) {
      const parts = [];
      let j = i + 1;
      while (j < lines.length && /^\s+\S/.test(lines[j])) {
        parts.push(lines[j].trim());
        j++;
      }
      val = parts.join(top[2].trim()[0] === "|" ? "\n" : " ");
      i = j - 1;
    }
    if (top[1] === "name") info.name = val;
    else if (top[1] === "description") info.description = val;
    else if (top[1] === "metadata") continue;
    else info.extra[top[1]] = val;
  }
  return { ok: true, info, raw };
}

function stripQuotes(v) {
  const s = String(v || "").trim();
  return s.length >= 2 && (s.startsWith('"') || s.startsWith("'")) && s.endsWith(s[0]) ? s.slice(1, -1) : s;
}

// 内容树哈希：文件按相对路径排序，文本统一成 LF 再算（忽略 mtime 和换行差异）。
// 前 8K 有 0x00 视为二进制，原样算
function treeHash(dir) {
  const files = [];
  collect(dir, "", files);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = crypto.createHash("sha256");
  h.update(`files:${files.length}\n`);
  for (const f of files) {
    h.update(f.rel.replace(/\\/g, "/")).update("\0");
    const buf = fs.readFileSync(f.abs);
    h.update(isBinary(buf) ? buf : Buffer.from(buf.toString("utf-8").replace(/\r\n/g, "\n"), "utf-8"));
    h.update("\0");
  }
  return h.digest("hex");
}

function collect(absDir, relBase, out) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    const rel = relBase ? relBase + "/" + e.name : e.name;
    if (e.isDirectory()) collect(abs, rel, out);
    else if (e.isFile()) out.push({ rel, abs });
  }
}

function isBinary(buf) {
  const head = buf.subarray(0, 8192);
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return true;
  return false;
}

function healthCheck(dir) {
  const issues = [];
  const skillFile = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    issues.push({ level: "bad", text: "缺少 SKILL.md" });
    return issues;
  }
  let parsed;
  try {
    parsed = parseSkillMd(dir);
  } catch {
    issues.push({ level: "bad", text: "SKILL.md 读取失败（编码或权限）" });
    return issues;
  }
  if (!parsed.ok) issues.push({ level: "warn", text: "无 YAML frontmatter，工具可能无法识别" });
  if (parsed.ok && !parsed.info.name) issues.push({ level: "warn", text: "frontmatter 缺 name 字段" });
  if (parsed.ok && !parsed.info.description) issues.push({ level: "bad", text: "缺 description，Agent 无法触发该技能" });
  else if (parsed.ok && parsed.info.description.length > 1024) issues.push({ level: "warn", text: "description 超长（>1024 字符），可能被截断" });
  return issues;
}

// 工具自带的系统技能目录：目录里放了 .xxx-system-skills.marker 标记文件（如 Codex 的 .system）。
// 由工具自己维护：永不收纳进中央库、不参与挂载与孤儿判定，展示层默认隐藏、仅搜索时可见
const SYSTEM_MARKER = /^\..+-system-skills\.marker$/;

function isSystemDir(abs) {
  let names;
  try {
    names = fs.readdirSync(abs);
  } catch {
    return false;
  }
  return names.some((n) => SYSTEM_MARKER.test(n));
}

// 构造一个技能条目：普通技能与系统技能共用，origin 由调用方标注
function buildSkillEntry(abs, st) {
  const hasSkillMd = fs.existsSync(path.join(abs, "SKILL.md"));
  let info = { name: "", description: "", version: "" };
  try {
    info = parseSkillMd(abs).info;
  } catch {}
  return {
    name: path.basename(abs),
    dir: abs,
    skillName: info.name || path.basename(abs),
    description: info.description || "",
    version: info.version || "",
    treeHash: hasSkillMd || fs.readdirSync(abs).length ? treeHash(abs) : "",
    health: healthCheck(abs),
    mtimeMs: st.mtimeMs,
    fileCount: countFiles(abs),
  };
}

// 扫系统目录下的一层子技能（如 .system 里的 skill-creator、imagegen）
function scanSystemDir(abs, toolId, out) {
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(abs, e.name);
    let st;
    try {
      st = fs.lstatSync(sub);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    out.push({ ...buildSkillEntry(sub, st), tool: toolId, origin: "system" });
  }
}

// 扫一个工具目录。junction 子目录不算技能本体，单独归到 mounts 里给同步层用。
// 注意顺序：Windows 上 junction 的 dirent.isDirectory() 是 false，先按 isDirectory 过滤
// 会把链接整个跳过，必须 lstat 后先判 isSymbolicLink
function scanDir(dir, toolId) {
  const skills = [];
  const mounts = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { skills, mounts };
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      // 指向中央仓库的是正常挂载，指向别处或已失效的也记下来，别让它隐身
      let target = "";
      try {
        target = fs.readlinkSync(abs);
      } catch {}
      mounts.push({ tool: toolId, name: e.name, path: abs, target, valid: fs.existsSync(target) });
      continue;
    }
    if (!st.isDirectory()) continue;
    if (isSystemDir(abs)) {
      scanSystemDir(abs, toolId, skills);
      continue;
    }
    skills.push({ ...buildSkillEntry(abs, st), tool: toolId, origin: "user" });
  }
  return { skills, mounts };
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile()) n++;
      else if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(dir);
  return n;
}

function scanAll(cfg, adapter) {
  const targets = adapter.resolveScanTargets(cfg);
  const result = { targets: [], skills: [], mounts: [] };
  for (const t of targets) {
    const r = scanDir(t.dir, t.id);
    // 技能数按用户自装口径统计，系统自带的默认不算
    result.targets.push({ ...t, skillCount: r.skills.filter((s) => s.origin !== "system").length, mountCount: r.mounts.length });
    result.skills.push(...r.skills);
    result.mounts.push(...r.mounts);
  }
  return result;
}

module.exports = { parseSkillMd, treeHash, healthCheck, scanDir, scanAll, isSystemDir, isBinary, collectFiles: collect };

/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 存储层：MD 事实源读写、frontmatter 子集解析、daily 分节、原子写、回收站、写队列。
// 规矩：① 原子写四步（tmp 同目录 → fsync → rm → rename）；② 写操作全部经写队列串行；
// ③ MD 是唯一事实源，索引失败不回滚 MD（修正清单 A2：daily 一文件多节，其余一文件一记忆）。
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { writeJsonAtomic, sleepSync } = require("./config.cjs");

const SECTION_HEAD = /^## (\d{2}:\d{2})(?::(\d{2}))?\s*·\s*(.+?)\s*$/;
const SECTION_ANCHOR = /^<!--\s*mem:([A-Za-z0-9_-]+)\s*-->$/;
const SECTION_META = /^>\s*(.+)$/;

// ---------- frontmatter 子集（只按半角冒号+空格切键；值含特殊字符一律加引号写出） ----------

function escapeYamlString(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function yamlScalar(v) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (/[:#\[\]{}"'\n]/.test(s) || /^\s|\s$/.test(s) || s === "" ) return escapeYamlString(s);
  return s;
}

function serializeFrontmatter(obj) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map(yamlScalar).join(", ")}]`);
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function parseYamlValue(raw) {
  let s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitCsvRespectQuotes(inner).map((x) => parseYamlValue(x));
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "true") return true;
  if (s === "false") return false;
  return s;
}

function splitCsvRespectQuotes(s) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inQ = !inQ;
    if (c === "," && !inQ) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm: {}, body: text, hasFm: false };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    fm[kv[1]] = parseYamlValue(kv[2]);
  }
  return { fm, body: text.slice(m[0].length), hasFm: true };
}

// ---------- daily 分节解析 ----------

const META_KEYS = new Set(["importance", "tags", "session", "supersededBy"]);

function parseSectionMeta(line) {
  const m = SECTION_META.exec(line);
  if (!m) return null;
  const out = {};
  for (const part of m[1].split("·")) {
    const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/.exec(part);
    // 只认已知键：正文里随手写的引用行（如 "> TODO: 补充"）不能被当成节元数据吞掉
    if (kv && META_KEYS.has(kv[1])) out[kv[1]] = kv[2];
  }
  return Object.keys(out).length ? out : null;
}

// 把 daily 文件正文拆成节列表：[{ id, time, title, meta, body, raw }]
/** 节头必须"前有空行 + 后两行内有锚点/元数据"，正文里手写的 ## 12:30 · 标题 才不会被误当节头 */
function isSectionHead(lines, idx) {
  const head = SECTION_HEAD.exec(lines[idx]);
  if (!head) return null;
  const prev = idx === 0 ? "" : (lines[idx - 1] || "").trim();
  if (idx > 0 && prev !== "") return null;
  const next1 = (lines[idx + 1] || "").trim();
  const next2 = (lines[idx + 2] || "").trim();
  const hasAnchor = SECTION_ANCHOR.test(next1) || SECTION_ANCHOR.test(next2);
  const hasMeta = !!parseSectionMeta(next1) || !!parseSectionMeta(next2);
  if (!hasAnchor && !hasMeta) return null;
  return head;
}

function parseDailySections(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  const preambleLines = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = isSectionHead(lines, i);
    if (head) {
      if (cur) sections.push(cur);
      cur = { time: head[1] + (head[2] ? ":" + head[2] : ""), title: head[3].trim(), id: null, meta: {}, bodyLines: [], raw: [line] };
      continue;
    }
    // 第一个节头之前的内容是用户手写的前言：必须随解析结果带出，否则下次 append 整体重写时被抹掉
    if (!cur) { preambleLines.push(line); continue; }
    cur.raw.push(line);
    // 节头后的两行是元数据区：先锚点（<!-- mem:id -->），再引用行（> importance: …）；
    // 两者都只能出现在正文开始之前，且各自最多一次
    if (!cur.bodyLines.length) {
      if (!cur.id) {
        const anchor = SECTION_ANCHOR.exec(line.trim());
        if (anchor) { cur.id = anchor[1]; continue; }
      }
      if (!cur.metaLineUsed) {
        const meta = parseSectionMeta(line);
        if (meta) { cur.meta = meta; cur.metaLineUsed = true; continue; }
      }
      if (!line.trim()) continue; // 元数据区与正文之间的空行
    }
    cur.bodyLines.push(line);
  }
  if (cur) sections.push(cur);
  for (const s of sections) s.body = s.bodyLines.join("\n").trim();
  sections.preamble = preambleLines.join("\n").trim();
  return sections;
}

function renderDailyFile(fm, sections) {
  const parts = [serializeFrontmatter(fm), ""];
  // 前言原样回写（用户手写在文件顶部的笔记）
  if (sections.preamble) parts.push(sections.preamble, "");
  for (const s of sections) {
    const safeTitle = String(s.title == null ? "" : s.title).replace(/[\r\n]+/g, " ").trim();
    parts.push(`## ${s.time} · ${safeTitle}`);
    if (s.id) parts.push(`<!-- mem:${s.id} -->`);
    const metaBits = [];
    const oneLine = (v) => String(v == null ? "" : v).replace(/[\r\n·]+/g, " ").trim();
    if (s.meta && s.meta.importance) metaBits.push(`importance: ${oneLine(s.meta.importance)}`);
    if (s.meta && s.meta.tags) metaBits.push(`tags: ${oneLine(Array.isArray(s.meta.tags) ? s.meta.tags.join(", ") : s.meta.tags)}`);
    if (s.meta && s.meta.session) metaBits.push(`session: ${oneLine(s.meta.session)}`);
    if (s.meta && s.meta.supersededBy) metaBits.push(`supersededBy: ${oneLine(s.meta.supersededBy)}`);
    if (metaBits.length) parts.push(`> ${metaBits.join(" · ")}`);
    parts.push("", s.body || "", "");
  }
  // 不做全局空行压缩：节体内代码块的连续空行是内容的一部分，压掉会让
  // 写入侧 hash（原始 body）与重建侧 hash（被压的 body）在 trim/none 口径下分叉
  return parts.join("\n");
}

// ---------- 工具 ----------

function newId(date) {
  const d = date || new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = crypto.randomBytes(3).toString("hex");
  return `mem_${ymd}_${rand}`;
}

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// L1 去重归一化（§25.2.1）：时间戳字段剔除在调用侧完成（这里只处理文本）
function normalizeForHash(text) {
  return String(text || "")
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n").map((l) => l.replace(/[ \t]+$/g, "").replace(/\t/g, "    ")).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ ]{2,}/g, " ")
    .normalize("NFKC")
    .trim();
}

// 内容指纹的唯一口径：标题 + 正文 + 标签（写入、重建索引、导入判重全部走这里，
// 口径分叉过一次——重建后的 hash 与写入时的不同，导致 L1 去重整体失效）
function contentHash({ title, body, tags, level = "full" }) {
  // 写入侧给的是内存原值，重建侧给的是解析回来的文本（可能带首尾空行、标签串首尾空格）：
  // 这里先做「标题/正文 trim + 标签逐个 trim 去空」的对齐，两条路径才能算出同一个指纹
  const t = String(title == null ? "" : title).trim();
  const b = String(body == null ? "" : body).trim();
  const list = Array.isArray(tags) ? tags : String(tags == null ? "" : tags).split(/[,，]/);
  // 标签排序归一：同内容换标签顺序不该是两个指纹（否则 [a,b]/[b,a] 绕过 L1）
  const tg = list.map((x) => String(x).trim()).filter(Boolean).sort().join(",");
  const raw = `${t}\n${b}\n${tg}`;
  if (level === "none") return sha256(raw);
  if (level === "trim") return sha256(raw.replace(/\r\n?/g, "\n").trim());
  return sha256(normalizeForHash(raw));
}

function estimateTokens(text) {
  const s = String(text || "");
  let cjk = 0, other = 0;
  for (const ch of s) {
    const x = ch.codePointAt(0);
    if ((x >= 0x3400 && x <= 0x9fff) || (x >= 0xf900 && x <= 0xfaff)) cjk++;
    else other++;
  }
  return Math.round(cjk + other * 0.25);
}

// ---------- 存储层 ----------

class MemoryStore {
  constructor(rootDir) {
    this.root = rootDir;
    this._locks = new Map();
    // root 本身也可能是符号链接：以真实路径作为越界判定的锚
    try {
      this._rootReal = fs.realpathSync(rootDir);
    } catch {
      this._rootReal = path.resolve(rootDir);
    }
  }

  abs(rel) {
    const rootResolved = path.resolve(this.root);
    const p = path.resolve(rootResolved, String(rel == null ? "" : rel));
    const relToRoot = path.relative(rootResolved, p);
    // 只拦真正的越界段：startsWith("..") 会误伤 "..foo" 这类合法文件名
    if (relToRoot === ".." || relToRoot.startsWith(".." + path.sep) || path.isAbsolute(relToRoot)) throw new Error(`路径越界：${rel}`);
    // junction/符号链接逃逸：root 内的链接指向外部时词法检查拦不住。
    // 在「词法 root 范围内」找最近存在的祖先做真实路径比对；
    // root 本身还没建（首次写入前）时不可能藏链接，词法检查已够，直接放行
    let anchor = p;
    while (true) {
      try {
        anchor = fs.realpathSync(anchor);
        break;
      } catch {
        if (anchor === rootResolved || path.dirname(anchor) === anchor) { anchor = null; break; }
        anchor = path.dirname(anchor);
      }
    }
    if (anchor) {
      const relReal = path.relative(this._rootReal, anchor);
      if (relReal === ".." || relReal.startsWith(".." + path.sep) || path.isAbsolute(relReal)) throw new Error(`路径越界（符号链接）：${rel}`);
    }
    return p;
  }

  exists(rel) {
    try { fs.accessSync(this.abs(rel)); return true; } catch { return false; }
  }

  read(rel) {
    try { return fs.readFileSync(this.abs(rel), "utf8"); } catch { return null; }
  }

  // 文件级串行锁：同一 rel 路径的写操作排队
  async withLock(rel, fn) {
    const key = path.resolve(this.root, rel);
    const prev = this._locks.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const chained = prev.then(() => mine);
    this._locks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this._locks.get(key) === chained) this._locks.delete(key);
    }
  }

  writeAtomic(rel, content, { backup = false, backupKeep = 5, atomic = true } = {}) {
    const target = this.abs(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!atomic) {
      // storage.atomicWrite=false：直接覆盖（目标盘不支持 rename 语义时的兜底开关）
      fs.writeFileSync(target, content, "utf8");
      return;
    }
    if (backup && fs.existsSync(target)) {
      const bak = `${target}.bak.${Date.now()}`;
      try { fs.copyFileSync(target, bak); } catch { /* 备份失败不阻塞写 */ }
      this._pruneBackups(target, backupKeep);
    }
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, content, "utf8");
    const fd = fs.openSync(tmp, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }

    // Windows 覆盖改名会 EPERM：先把原文件挪成 .old（不删），改名成功再清理；
    // 中途失败可回滚，避免「目标已删但改名失败」这种真空丢数据
    const staging = `${target}.old.${process.pid}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (fs.existsSync(target)) {
          if (fs.existsSync(staging)) fs.rmSync(staging, { force: true });
          fs.renameSync(target, staging);
        }
        fs.renameSync(tmp, target);
        if (fs.existsSync(staging)) fs.rmSync(staging, { force: true });
        return;
      } catch (e) {
        if (fs.existsSync(staging) && !fs.existsSync(target)) {
          try { fs.renameSync(staging, target); } catch { /* 回滚失败则把异常交给调用方 */ }
        }
        if (attempt === 2) {
          try { fs.rmSync(tmp, { force: true }); } catch { /* 清理临时文件 */ }
          throw e;
        }
        // Windows EBUSY/EPERM 退避：Atomics.wait 睡眠不烧 CPU；两次仍失败就交给调用方
        // （观察者如杀软实时扫描/Obsidian 占用通常在下一次写入就恢复，不必在这里长等）
        sleepSync([50, 150][Math.min(attempt, 1)]);
      }
    }
  }

  _pruneBackups(target, keep) {
    try {
      const dir = path.dirname(target);
      const base = path.basename(target) + ".bak.";
      const list = fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort();
      while (list.length > keep) {
        fs.rmSync(path.join(dir, list.shift()), { force: true });
      }
    } catch { /* 清理失败无碍 */ }
  }

  /** 物理删除（purge 路径专用：只有用户显式要求「彻底删除」时才走） */
  removeFile(rel) {
    const target = this.abs(rel);
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target, { force: true });
    return true;
  }

  moveToTrash(rel) {
    if (!this.exists(rel)) return false;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const dest = `.trash/${stamp}.md`;
    const src = this.abs(rel);
    const dstAbs = this.abs(dest);
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    fs.renameSync(src, dstAbs);
    // sidecar 记原路径：路径本身可能含 "__"，不能靠文件名反解
    try {
      fs.writeFileSync(`${dstAbs}.meta.json`, JSON.stringify({ originPath: rel, trashedAt: Date.now() }), "utf8");
    } catch { /* 元数据写失败时退回文件名反解 */ }
    return dest;
  }

  trashMeta(name) {
    try {
      const raw = fs.readFileSync(this.abs(`.trash/${name}.meta.json`), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.originPath) return parsed;
    } catch { /* 旧格式：没有 sidecar */ }
    const m = /^\d+-[a-z0-9]{4}\.md$/.test(name) ? null : /^(\d+)-(.+)$/.exec(name);
    return m ? { originPath: m[2].replace(/__/g, "/"), trashedAt: Number(m[1]) } : null;
  }

  restoreFromTrash(trashName, destRel) {
    const src = this.abs(`.trash/${trashName}`);
    if (!fs.existsSync(src)) return false;
    const rel = destRel || (this.trashMeta(trashName) || {}).originPath;
    if (!rel) return false;
    this.writeAtomic(rel, fs.readFileSync(src, "utf8"));
    fs.rmSync(src, { force: true });
    try { fs.rmSync(`${src}.meta.json`, { force: true }); } catch { /* 无 sidecar */ }
    return true;
  }

  listTrash() {
    const dir = this.abs(".trash");
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return []; }
    return files
      .filter((f) => !f.endsWith(".meta.json"))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        const meta = this.trashMeta(f);
        return {
          name: f,
          trashedAt: (meta && meta.trashedAt) || st.mtimeMs,
          originPath: (meta && meta.originPath) || f,
          size: st.size,
        };
      })
      .sort((a, b) => b.trashedAt - a.trashedAt);
  }

  purgeTrash(keepDays) {
    const dir = this.abs(".trash");
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return 0; }
    const cutoff = Date.now() - keepDays * 86400000;
    let removed = 0;
    for (const f of files) {
      if (f.endsWith(".meta.json")) continue;
      const meta = this.trashMeta(f);
      const at = (meta && meta.trashedAt) || 0;
      if (at && at < cutoff) {
        try {
          fs.rmSync(path.join(dir, f), { force: true });
          fs.rmSync(path.join(dir, `${f}.meta.json`), { force: true });
          removed++;
        } catch { /* 忽略单文件失败 */ }
      }
    }
    return removed;
  }

  // ---------- 结构化读写 ----------

  readStandalone(rel) {
    const text = this.read(rel);
    if (text == null) return null;
    const { fm, body } = parseFrontmatter(text);
    return { fm, body: body.trim(), raw: text };
  }

  writeStandalone(rel, fm, body, opts) {
    const content = serializeFrontmatter(fm) + "\n\n" + (body || "").trim() + "\n";
    this.writeAtomic(rel, content, opts);
  }

  appendDaily(rel, fileFm, section, opts) {
    const existing = this.read(rel);
    if (existing == null) {
      const content = renderDailyFile(fileFm, [section]);
      this.writeAtomic(rel, content, opts);
      return;
    }
    const { fm } = parseFrontmatter(existing);
    const sections = parseDailySections(parseFrontmatter(existing).body);
    sections.push(section);
    this.writeAtomic(rel, renderDailyFile({ ...fileFm, ...fm }, sections), opts);
  }

  updateDailySection(rel, sectionId, updater, opts) {
    const existing = this.read(rel);
    if (existing == null) return false;
    const { fm, body } = parseFrontmatter(existing);
    const sections = parseDailySections(body);
    const idx = sections.findIndex((s) => s.id === sectionId);
    if (idx < 0) return false;
    const next = updater(sections[idx]);
    if (next === null) sections.splice(idx, 1);
    else sections[idx] = next;
    this.writeAtomic(rel, renderDailyFile(fm, sections), opts);
    return true;
  }

  ensureTree() {
    for (const d of ["projects", "general", "profile", "notes", ".trash", "reports", "index", "config", "_import"]) {
      fs.mkdirSync(this.abs(d), { recursive: true });
    }
  }

  // 遍历全部记忆 MD（排除内部目录）；返回相对路径列表
  walkMemoryFiles() {
    const out = [];
    const skipDirs = new Set([".trash", "index", "reports", "config", "_import", ".history"]);
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (skipDirs.has(e.name)) continue;
          walk(full);
        } else if (e.isFile() && e.name.endsWith(".md") && !/\.bak(\.\d+)?$/.test(e.name) && !/\.old\.\d+$/.test(e.name)) {
          out.push(path.relative(this.root, full).replace(/\\/g, "/"));
        }
      }
    };
    for (const top of ["projects", "general", "profile", "notes"]) walk(this.abs(top));
    return out;
  }
}

module.exports = {
  MemoryStore, newId, sha256, normalizeForHash, estimateTokens, contentHash, sleepSync,
  parseFrontmatter, serializeFrontmatter, parseDailySections, renderDailyFile,
};

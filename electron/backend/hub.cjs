// 中央仓库：manifest 读写、收纳、回收站
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const config = require("./config.cjs");
const scanner = require("./scanner.cjs");

function manifestFile() {
  return path.join(config.hubDir(), "manifest.json");
}

function skillsDir() {
  return path.join(config.ensureHub(), "skills");
}

function trashDir() {
  return path.join(config.ensureHub(), ".trash");
}

function reportsDir() {
  return path.join(config.ensureHub(), "reports");
}

function loadManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile(), "utf-8"));
    if (!m.deleted || typeof m.deleted !== "object") m.deleted = {}; // 删除墓碑：防技能跨设备"复活"
    return m;
  } catch {
    return { version: 1, skills: {}, deleted: {}, updatedAt: null };
  }
}

function saveManifest(m) {
  m.updatedAt = new Date().toISOString();
  fs.writeFileSync(manifestFile(), JSON.stringify(m, null, 2), "utf-8");
}

function importSkill(entry) {
  const m = loadManifest();
  const dest = path.join(skillsDir(), entry.name);
  if (fs.existsSync(dest)) {
    const old = m.skills[entry.name];
    if (old && old.treeHash === entry.treeHash) {
      mergeSources(old, entry);
      saveManifest(m);
      return { action: "source-added", name: entry.name };
    }
    return { action: "conflict", name: entry.name, message: "中央已存在同名不同内容的技能" };
  }
  fs.cpSync(entry.dir, dest, { recursive: true });
  // 落账用中央副本实算哈希：entry 带的是扫描时的源侧哈希，两者有差（比如目录里有链接）
  // 时 manifest 记旧值，下轮同步会把同内容副本永久误判成冲突
  const realHash = scanner.treeHash(dest);
  m.skills[entry.name] = {
    name: entry.name,
    version: entry.version || "",
    description: entry.description || "",
    treeHash: realHash,
    skillName: entry.skillName || entry.name,
    sources: entry.sources.map((s) => ({ tool: s.tool, originalName: s.name, firstSeen: new Date().toISOString() })),
    mounts: [],
    mergeHistory: [{ at: new Date().toISOString(), action: "import", detail: `收纳自 ${entry.sources.map((s) => s.tool + ":" + s.name).join(", ")}` }],
    health: entry.health || [],
  };
  saveManifest(m);
  return { action: "imported", name: entry.name, treeHash: realHash };
}

function mergeSources(oldEntry, entry) {
  for (const s of entry.sources) {
    if (!oldEntry.sources.some((x) => x.tool === s.tool && x.originalName === s.name)) {
      oldEntry.sources.push({ tool: s.tool, originalName: s.name, firstSeen: new Date().toISOString() });
    }
  }
}

function setMount(name, tool, mountPath, type, enabled) {
  const m = loadManifest();
  const s = m.skills[name];
  if (!s) return;
  s.mounts = (s.mounts || []).filter((x) => !(x.tool === tool && x.name === mountNameOf(mountPath)));
  s.mounts.push({ tool, name: mountNameOf(mountPath), path: mountPath, type, enabled: enabled !== false });
  saveManifest(m);
}

function removeMount(name, mountPath) {
  const m = loadManifest();
  const s = m.skills[name];
  if (!s) return;
  s.mounts = (s.mounts || []).filter((x) => x.path !== mountPath);
  saveManifest(m);
}

function mountNameOf(mountPath) {
  return path.basename(mountPath);
}

// 删除/覆盖都走这里，先进 .trash
function toTrash(absPath, tag) {
  const trash = trashDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(trash, `${stamp}-${tag || path.basename(absPath)}`);
  try {
    fs.renameSync(absPath, dest);
  } catch (e) {
    // 中央仓库和工具目录常不在一个盘，rename 跨盘抛 EXDEV，改复制+删除
    if (e.code !== "EXDEV") throw e;
    fs.cpSync(absPath, dest, { recursive: true });
    fs.rmSync(absPath, { recursive: true, force: true });
  }
  return dest;
}

function listTrash() {
  const trash = trashDir();
  const items = [];
  for (const name of fs.readdirSync(trash)) {
    const p = path.join(trash, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    items.push({ name, path: p, trashedAt: st.mtimeMs, sizeBytes: dirSize(p) });
  }
  items.sort((a, b) => b.trashedAt - a.trashedAt);
  return items;
}

function restoreFromTrash(trashName, destParent) {
  trashName = path.basename(String(trashName || "")); // 只认 .trash 直属条目，挡 ../
  if (!trashName) return { ok: false, message: "名称为空" };
  const src = path.join(trashDir(), trashName);
  const base = destParent || skillsDir();
  // 剥掉回收站命名里的时间戳前缀
  const original = trashName.replace(/^\d{4}-\d{2}-\d{2}T[0-9-]+Z-/, "");
  const dest = path.join(base, original);
  if (fs.existsSync(dest)) return { ok: false, message: `目标已存在：${dest}` };
  fs.renameSync(src, dest);
  // 还原即撤销删除，墓碑一并清掉，不然跨设备同步时会被当删除传播
  if (original && base === skillsDir()) {
    const m = loadManifest();
    if (m.deleted[original]) {
      delete m.deleted[original];
      saveManifest(m);
    }
  }
  return { ok: true, dest };
}

function purgeTrash(days) {
  const limit = Date.now() - (days || 7) * 24 * 3600 * 1000;
  let purged = 0;
  for (const item of listTrash()) {
    if (item.trashedAt < limit) {
      fs.rmSync(item.path, { recursive: true, force: true });
      purged++;
    }
  }
  return purged;
}

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isFile()) {
        try { n += fs.statSync(abs).size; } catch {}
      } else if (e.isDirectory()) walk(abs);
    }
  };
  walk(p);
  return n;
}

// 删中央技能：真身进回收站，manifest 移除并记墓碑（跨设备同步时据此删除远端、防止其他设备把技能"复活"回来）
function removeSkill(name) {
  name = path.basename(String(name || "")); // 技能名就是目录名，带路径一律拒收
  if (!name) return { ok: false, message: "非法技能名" };
  const dir = path.join(skillsDir(), name);
  if (!fs.existsSync(dir)) return { ok: false, message: "技能不存在" };
  const m = loadManifest();
  const entry = m.skills[name];
  const trashPath = toTrash(dir, name);
  delete m.skills[name];
  m.deleted[name] = {
    treeHash: (entry && entry.treeHash) || "",
    deletedAt: new Date().toISOString(),
    by: config.loadConfig().webdav.deviceId || "",
  };
  saveManifest(m);
  return { ok: true, trashPath };
}

// 中央巡检：skills\ 里有目录、manifest 没记账的条目（AI 绕过软件直接塞进来的）。
// 只读不动文件；纳管动作在 syncer.adoptHubSkill
function hubExtra() {
  const m = loadManifest();
  const rows = [];
  let entries;
  try {
    entries = fs.readdirSync(skillsDir(), { withFileTypes: true });
  } catch {
    return rows;
  }
  for (const e of entries) {
    if (m.skills[e.name] || m.deleted[e.name]) continue;
    const abs = path.join(skillsDir(), e.name);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    rows.push({
      name: e.name,
      isLink: st.isSymbolicLink(),
      hasSkillMd: fs.existsSync(path.join(abs, "SKILL.md")),
      mtimeMs: st.mtimeMs,
      health: scanner.healthCheck(abs),
    });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : 1));
  return rows;
}

module.exports = {
  hubDir: config.hubDir, ensureHub: config.ensureHub,
  skillsDir, trashDir, reportsDir,
  manifestFile, loadManifest, saveManifest,
  importSkill, setMount, removeMount,
  toTrash, listTrash, restoreFromTrash, purgeTrash, removeSkill, dirSize, hubExtra,
};

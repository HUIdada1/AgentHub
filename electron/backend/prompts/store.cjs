/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-23
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 *  ============================================================
 */
// 提示词库（第三板块）· 本地库存储层
//
// 为什么事实源是「MD 文件 + manifest 台账」而不是 sqlite：
//   1) 提示词是文本资产，用户随时能用记事本打开、能被 git 管理；
//   2) 与技能仓库（目录 + manifest）和记忆中枢（MD + 索引）两条已验证路径同构；
//   3) 同步时可按条比对哈希，天然规避「整包读入内存」的 OOM 风险。
//
// 目录布局（库根目录由 config.promptsLibDir() 提供，默认 ~/AgentHub/prompts）：
//   manifest.json          索引台账（只放轻量元信息 + 墓碑，不放版本历史）
//   items/<id>.md          frontmatter + 正文（当前版本，事实源）
//   versions/<id>.json     该条目的历史版本（含每版正文）
//   .trash/<id>.md         回收站
//   reports/prompts-*.md   同步报告
//   remote-state.json      跨设备同步的三方合并基线与调度记账
//
// 为什么版本历史不放 manifest：一条 20 个版本的提示词会让台账膨胀到 MB 级，
// 而台账每次列表/统计都要读，独立成文件后按需读取。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = require("../config.cjs");

// ===== 路径 =====

function libDir() {
  return config.promptsLibDir();
}

function manifestFile() {
  return path.join(libDir(), "manifest.json");
}

function itemsDir() {
  return path.join(libDir(), "items");
}

function versionsDir() {
  return path.join(libDir(), "versions");
}

function trashDir() {
  return path.join(libDir(), ".trash");
}

function reportsDir() {
  return path.join(libDir(), "reports");
}

function remoteStateFile() {
  return path.join(libDir(), "remote-state.json");
}

/** 导出目录：放在库根目录下的 exports/，用户点「打开目录」就能看到产物 */
function exportsDir() {
  return path.join(libDir(), "exports");
}

function ensureLib() {
  for (const d of [libDir(), itemsDir(), versionsDir(), trashDir(), reportsDir()]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return libDir();
}

// ===== 基础工具 =====

function hashText(text) {
  return crypto.createHash("sha256").update(String(text == null ? "" : text), "utf8").digest("hex");
}

function readJson(file, def) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return def;
  }
}

/** 原子写：先写带 pid 的临时文件再 rename。
 *  固定名临时文件会让两个写入者互相把对方的 .tmp rename 走（本仓既有约定）。 */
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/** 备份损坏文件（台账/历史损坏时先留证再重建，别让用户的数据无声消失） */
function backupBroken(file) {
  try {
    if (!fs.existsSync(file)) return "";
    const bak = `${file}.bak.${Date.now()}`;
    fs.copyFileSync(file, bak);
    return bak;
  } catch {
    return "";
  }
}

// ===== frontmatter 编解码 =====
//
// 格式刻意做成「简单 key: value」+「复杂值走单行 JSON」：
// 前者保证 md 用记事本打开也看得懂，后者避免自己写一个 YAML 解析器（引号/换行/缩进全是坑）。

const FM_KEYS_SIMPLE = ["id", "name", "description", "category", "source", "originRef", "version", "createdAt", "updatedAt", "hash", "lastUsedAt", "useCount", "deletedAt"];
const FM_KEYS_JSON = ["variables", "tags", "lineage", "originMeta"];
const FM_KEYS_BOOL = ["favorite", "pinned"];

function encodeValue(key, v) {
  if (FM_KEYS_JSON.includes(key)) return JSON.stringify(v == null ? (key === "tags" ? [] : key === "variables" ? [] : null) : v);
  if (FM_KEYS_BOOL.includes(key)) return v ? "true" : "false";
  if (v == null) return "";
  return String(v).replace(/\r?\n/g, " "); // 单行字段里不允许换行，否则 frontmatter 结构会断
}

function decodeValue(key, raw) {
  const v = String(raw == null ? "" : raw).trim();
  if (FM_KEYS_JSON.includes(key)) {
    if (!v) return key === "tags" || key === "variables" ? [] : null;
    try {
      return JSON.parse(v);
    } catch {
      return key === "tags" || key === "variables" ? [] : null;
    }
  }
  if (FM_KEYS_BOOL.includes(key)) return v === "true";
  if (["version", "createdAt", "updatedAt", "useCount", "lastUsedAt", "deletedAt"].includes(key)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return v;
}

/** 组装 md：frontmatter 只放「当前版本」的元信息，历史版本在 versions/<id>.json */
function buildMd(item) {
  const keys = [...FM_KEYS_SIMPLE, ...FM_KEYS_BOOL, ...FM_KEYS_JSON];
  const lines = ["---"];
  for (const k of keys) {
    if (item[k] === undefined) continue;
    lines.push(`${k}: ${encodeValue(k, item[k])}`);
  }
  lines.push("---");
  lines.push("");
  return lines.join("\n") + String(item.body == null ? "" : item.body);
}

/** 解析 md：容错优先——frontmatter 缺失/损坏时把整份当正文，绝不因为元信息坏了就丢掉用户的提示词 */
function parseMd(text) {
  const s = String(text == null ? "" : text);
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(s);
  if (!m) return { meta: {}, body: s };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (!k) continue;
    meta[k] = decodeValue(k, line.slice(i + 1));
  }
  return { meta, body: s.slice(m[0].length) };
}

// ===== 台账 =====

function emptyManifest() {
  return { version: 1, items: {}, deleted: {}, updatedAt: 0 };
}

function loadManifest() {
  ensureLib();
  const raw = readJson(manifestFile(), null);
  if (!raw || typeof raw !== "object") return emptyManifest();
  return {
    version: 1,
    items: raw.items && typeof raw.items === "object" ? raw.items : {},
    deleted: raw.deleted && typeof raw.deleted === "object" ? raw.deleted : {},
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

function saveManifest(m) {
  m.updatedAt = Date.now();
  writeJsonAtomic(manifestFile(), m);
}

// ===== 版本历史 =====

function versionsFile(id) {
  return path.join(versionsDir(), `${id}.json`);
}

function loadVersions(id) {
  const raw = readJson(versionsFile(id), null);
  return raw && Array.isArray(raw.versions) ? raw.versions : [];
}

function saveVersions(id, versions) {
  writeJsonAtomic(versionsFile(id), { version: 1, id, versions });
}

/** 版本裁剪：超出上限时丢最旧；**同步自动合并产生的版本优先保留**（它们是「被放弃的另一份」，
 *  丢了就等于自动合并吃掉了用户的内容） */
function pruneVersions(versions, keep) {
  const limit = Math.max(1, Number(keep) || 20);
  const list = Array.isArray(versions) ? versions.slice() : [];
  if (list.length <= limit) return list;
  const mergeOnes = list.filter((v) => v && v.by === "sync-merge");
  const normal = list.filter((v) => !v || v.by !== "sync-merge");
  const keepNormal = Math.max(0, limit - mergeOnes.length);
  const keptNormal = normal.slice(Math.max(0, normal.length - keepNormal));
  const out = [...keptNormal, ...mergeOnes].sort((a, b) => (Number(a.version) || 0) - (Number(b.version) || 0));
  return out;
}

// ===== 条目读写 =====

function itemFile(id) {
  return path.join(itemsDir(), `${id}.md`);
}

function trashFile(id) {
  return path.join(trashDir(), `${id}.md`);
}

function newId() {
  return "p_" + crypto.randomBytes(8).toString("hex");
}

/** 从磁盘读一条（不含版本历史） */
function readItemFile(file, idHint) {
  const text = fs.readFileSync(file, "utf8");
  const { meta, body } = parseMd(text);
  const id = meta.id || idHint || path.basename(file, ".md");
  return normalizeItem({
    ...meta,
    id,
    body,
    hash: meta.hash || hashText(body),
  });
}

/** 条目字段收敛：任何来源（磁盘 / 导入 / 前端）都过这一关，保证下游拿到的形状稳定 */
function normalizeItem(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const body = String(o.body == null ? "" : o.body);
  const now = Date.now();
  const tags = Array.isArray(o.tags) ? o.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const variables = Array.isArray(o.variables) ? o.variables.filter((v) => v && v.name) : [];
  const source = ["local", "optimized", "online", "imported"].includes(o.source) ? o.source : "local";
  return {
    id: String(o.id || newId()),
    name: String(o.name || "未命名提示词").slice(0, 200),
    description: String(o.description || "").slice(0, 500),
    body,
    variables,
    category: String(o.category || "").trim() || "未分类",
    tags: [...new Set(tags)],
    source,
    originRef: o.originRef ? String(o.originRef) : undefined,
    originMeta: o.originMeta && typeof o.originMeta === "object" ? o.originMeta : undefined,
    lineage: o.lineage && typeof o.lineage === "object" ? o.lineage : undefined,
    version: Math.max(1, Math.floor(Number(o.version) || 1)),
    favorite: o.favorite === true,
    pinned: o.pinned === true,
    useCount: Math.max(0, Math.floor(Number(o.useCount) || 0)),
    lastUsedAt: Number(o.lastUsedAt) || 0,
    hash: hashText(body),
    createdAt: Number(o.createdAt) || now,
    updatedAt: Number(o.updatedAt) || now,
    deletedAt: o.deletedAt ? Number(o.deletedAt) : undefined,
  };
}

/** 列表：台账为准，文件缺失的条目自动跳过（并在返回值里带上 missing 计数，让前端能提示） */
function listItems(opts = {}) {
  ensureLib();
  const includeTrash = opts.includeTrash === true;
  const m = loadManifest();
  const out = [];
  let missing = 0;
  for (const id of Object.keys(m.items)) {
    const meta = m.items[id];
    if (!meta) continue;
    const inTrash = !!meta.deletedAt;
    if (inTrash && !includeTrash) continue;
    const file = inTrash ? trashFile(id) : itemFile(id);
    try {
      if (!fs.existsSync(file)) {
        missing++;
        continue;
      }
      const item = readItemFile(file, id);
      // 回收站条目的 md 里没有 deletedAt（frontmatter 只描述「当前版本」），
      // 删除状态的事实源是台账；读回来必须补上，否则界面分不清「在回收站」还是「正常」
      if (inTrash) item.deletedAt = meta.deletedAt;
      out.push(item);
    } catch {
      missing++;
    }
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { items: out, missing };
}

function getItem(id) {
  ensureLib();
  const m = loadManifest();
  const meta = m.items[id];
  const file = meta && meta.deletedAt ? trashFile(id) : itemFile(id);
  if (!fs.existsSync(file)) return null;
  const item = readItemFile(file, id);
  // 同上：删除状态以台账为准
  if (meta && meta.deletedAt) item.deletedAt = meta.deletedAt;
  return item;
}

/** 台账里登记一条（只存轻量元信息，正文与版本各自落文件） */
function manifestEntry(item) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    category: item.category,
    tags: item.tags,
    source: item.source,
    version: item.version,
    hash: item.hash,
    favorite: item.favorite,
    pinned: item.pinned,
    useCount: item.useCount,
    lastUsedAt: item.lastUsedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt,
  };
}

/**
 * 保存条目（新建或更新）。
 * expectedHash 是乐观锁：调用方带着「我读到的 hash」提交，若磁盘已变则拒绝，
 * 避免两个窗口同时编辑时后写的静默覆盖先写的。
 */
function saveItem(rawItem, expectedHash) {
  ensureLib();
  const m = loadManifest();
  const cfg = config.loadConfig();
  const keep = (cfg.prompts && cfg.prompts.versionKeep) || 20;
  const maxBytes = ((cfg.prompts && cfg.prompts.itemMaxKB) || 1024) * 1024;

  const exists = !!m.items[rawItem && rawItem.id];
  const prev = exists ? getItem(rawItem.id) : null;

  // 字段合并：只覆盖「显式提供」的键。
  // 为什么不能整条替换：前端或外部脚本只改正文时不会带上分类/标签/收藏，
  // 整条替换会把它们悄悄清成默认值（用户视角是「改个错别字，标签全没了」）。
  // 显式传 [] 或 "" 仍按用户的清空意图处理——只有 undefined 才算「没提供」。
  const provided = {};
  for (const [k, v] of Object.entries(rawItem || {})) {
    if (v !== undefined) provided[k] = v;
  }
  const base = prev ? { ...prev, ...provided } : provided;
  delete base.deletedAt; // 保存即视为「回到正常状态」，不能把回收站标记一起写回去

  const item = normalizeItem({ ...base, createdAt: prev ? prev.createdAt : undefined });
  if (Buffer.byteLength(item.body, "utf8") > maxBytes) {
    return { ok: false, code: "too_large", message: `单条正文超过上限（${Math.round(maxBytes / 1024)}KB）` };
  }
  if (!item.body.trim()) return { ok: false, code: "empty_body", message: "正文不能为空" };

  if (exists) {
    if (expectedHash && prev && prev.hash !== expectedHash) {
      return { ok: false, code: "conflict", message: "内容已被修改", hash: prev.hash };
    }
    const changed = !prev || prev.hash !== item.hash;
    let versions = loadVersions(item.id);
    if (changed) {
      // 正文变了才 +1 版本；只改名称/标签不产生新版本（否则版本列表会被无意义的记录塞满）
      item.version = (prev ? prev.version : 0) + 1;
      versions.push({ version: item.version, body: item.body, at: Date.now(), note: "" });
      versions = pruneVersions(versions, keep);
      item.version = versions.length ? versions[versions.length - 1].version : item.version;
    } else {
      item.version = prev ? prev.version : item.version;
    }
    saveVersions(item.id, versions);
  } else {
    item.version = 1;
    saveVersions(item.id, [{ version: 1, body: item.body, at: Date.now(), note: "创建" }]);
  }

  item.updatedAt = Date.now();
  item.hash = hashText(item.body);
  writeTextAtomic(itemFile(item.id), buildMd(item));
  m.items[item.id] = manifestEntry(item);
  delete m.deleted[item.id]; // 重新保存 = 撤销墓碑，否则同步会把这条当"已删除"再删一次
  saveManifest(m);
  return { ok: true, id: item.id, hash: item.hash, item };
}

/** 只更新元信息（收藏 / 使用次数 / 改名等），不产生新版本 */
function patchItem(id, patch) {
  ensureLib();
  const item = getItem(id);
  if (!item) return { ok: false, message: "条目不存在" };
  const next = normalizeItem({ ...item, ...(patch || {}), body: item.body, hash: item.hash });
  next.version = item.version;
  next.updatedAt = Date.now();
  writeTextAtomic(itemFile(id), buildMd(next));
  const m = loadManifest();
  m.items[id] = manifestEntry(next);
  saveManifest(m);
  return { ok: true, item: next };
}

function deleteItem(id) {
  ensureLib();
  const m = loadManifest();
  if (!m.items[id]) return { ok: false, message: "条目不存在" };
  const src = itemFile(id);
  if (fs.existsSync(src)) {
    fs.renameSync(src, trashFile(id));
  }
  m.items[id].deletedAt = Date.now();
  saveManifest(m);
  return { ok: true };
}

function restoreItem(id) {
  ensureLib();
  const m = loadManifest();
  if (!m.items[id]) return { ok: false, message: "条目不存在" };
  const src = trashFile(id);
  if (fs.existsSync(src)) fs.renameSync(src, itemFile(id));
  delete m.items[id].deletedAt;
  m.items[id].updatedAt = Date.now();
  saveManifest(m);
  return { ok: true };
}

/** 彻底删除：写墓碑（同步靠它把删除传播到别的设备，否则下次同步会「复活」这条） */
function purgeItem(id) {
  ensureLib();
  const m = loadManifest();
  const meta = m.items[id];
  for (const f of [itemFile(id), trashFile(id), versionsFile(id)]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* 删不掉不拦流程，下次重建台账时会再清 */ }
  }
  delete m.items[id];
  m.deleted[id] = { at: Date.now(), hash: meta ? meta.hash : "" };
  saveManifest(m);
  return { ok: true };
}

function emptyTrash() {
  ensureLib();
  const m = loadManifest();
  let count = 0;
  for (const id of Object.keys(m.items)) {
    if (m.items[id] && m.items[id].deletedAt) {
      const meta = m.items[id];
      for (const f of [trashFile(id), versionsFile(id)]) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch { /* 忽略 */ }
      }
      delete m.items[id];
      m.deleted[id] = { at: Date.now(), hash: meta.hash || "" };
      count++;
    }
  }
  saveManifest(m);
  return { ok: true, count };
}

/** 回收站过期清理：trashDays=0 表示不自动清理（用户可能想长期留着） */
function cleanTrash() {
  const cfg = config.loadConfig();
  const days = (cfg.prompts && cfg.prompts.trashDays) || 0;
  if (days <= 0) return { ok: true, count: 0 };
  const deadline = Date.now() - days * 24 * 3600 * 1000;
  const m = loadManifest();
  let count = 0;
  for (const id of Object.keys(m.items)) {
    const meta = m.items[id];
    if (!meta || !meta.deletedAt) continue;
    if (meta.deletedAt < deadline) {
      for (const f of [trashFile(id), versionsFile(id)]) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch { /* 忽略 */ }
      }
      delete m.items[id];
      m.deleted[id] = { at: Date.now(), hash: meta.hash || "" };
      count++;
    }
  }
  if (count) saveManifest(m);
  return { ok: true, count };
}

// ===== 台账与文件对账 =====

/**
 * 重建台账：以 items/ 目录里的文件为准。
 * 触发场景：manifest.json 损坏/被删、用户手工往 items/ 里丢文件、跨设备同步中断。
 * 语义：磁盘是事实源，台账是可重建的索引。
 */
function rebuild() {
  ensureLib();
  const m = loadManifest();
  const found = {};
  let restored = 0;
  let orphans = 0;
  const missing = [];

  for (const f of fs.readdirSync(itemsDir())) {
    if (!f.endsWith(".md")) continue;
    try {
      const item = readItemFile(path.join(itemsDir(), f), path.basename(f, ".md"));
      found[item.id] = item;
      if (!m.items[item.id]) {
        restored++;
        m.items[item.id] = manifestEntry(item);
      } else {
        // 文件比台账新 → 以文件为准（用户可能手工改过 md）
        m.items[item.id] = manifestEntry(item);
      }
    } catch {
      orphans++;
    }
  }
  for (const id of Object.keys(m.items)) {
    if (m.items[id] && m.items[id].deletedAt) continue;
    if (!found[id]) missing.push(id);
  }
  // 台账有记录但文件不存在：**不自动删记录**（可能是同步还没拉下来），只报给调用方
  saveManifest(m);
  return { ok: true, count: Object.keys(m.items).length, restored, unreadable: orphans, missing };
}

/** 孤儿文件清单（有文件、台账无记录）——用于界面上提示「发现 N 个未纳管的提示词」 */
function listOrphans() {
  ensureLib();
  const m = loadManifest();
  const out = [];
  for (const f of fs.readdirSync(itemsDir())) {
    if (!f.endsWith(".md")) continue;
    const id = path.basename(f, ".md");
    if (!m.items[id]) out.push({ id, file: f });
  }
  return out;
}

// ===== 统计与索引 =====

function stats() {
  ensureLib();
  const { items } = listItems({ includeTrash: true });
  const now = Date.now();
  const dayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const weekStart = dayStart - 6 * 24 * 3600 * 1000;
  let total = 0, today = 0, week = 0, optimized = 0, favorited = 0, trash = 0;
  for (const it of items) {
    if (it.deletedAt) { trash++; continue; }
    total++;
    if ((it.createdAt || 0) >= dayStart) today++;
    if ((it.createdAt || 0) >= weekStart) week++;
    if (it.source === "optimized") optimized++;
    if (it.favorite) favorited++;
  }
  let lastSyncAt = 0;
  try {
    const rs = readJson(remoteStateFile(), null);
    if (rs && rs.lastSyncAt) lastSyncAt = Number(rs.lastSyncAt) || 0;
  } catch { /* 未同步过 */ }
  return { total, today, week, optimized, favorited, trash, conflicts: 0, lastSyncAt };
}

/** 分类与标签索引：从条目聚合，供左栏树与标签云使用 */
function metaIndex() {
  const { items } = listItems({ includeTrash: false });
  const cats = new Set();
  const tags = new Set();
  for (const it of items) {
    if (it.category) cats.add(it.category);
    for (const t of it.tags || []) tags.add(t);
  }
  return { categories: [...cats].sort(), tags: [...tags].sort() };
}

// ===== 导入 / 导出 =====

function exportItems(ids, format) {
  ensureLib();
  const dir = exportsDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const tag = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  const all = listItems({ includeTrash: false }).items;
  const picked = Array.isArray(ids) && ids.length ? all.filter((it) => ids.includes(it.id)) : all;

  if (format === "json") {
    const file = path.join(dir, `prompts-${tag}.json`);
    writeJsonAtomic(file, { version: 1, exportedAt: Date.now(), items: picked });
    return { ok: true, path: file, count: picked.length };
  }
  // md：多条时打包成一个带分隔线的文件（单条时就是它本身，便于直接复制）
  const file = path.join(dir, `prompts-${tag}.md`);
  const chunks = picked.map((it) => buildMd(it));
  writeTextAtomic(file, chunks.join("\n\n<!-- ==== 下一条 ==== -->\n\n"));
  return { ok: true, path: file, count: picked.length };
}

/** 导入：只做「解析 + 落库」，冲突策略由调用方指定。
 *  onConflict: new=新建副本 | overwrite=覆盖同 id | skip=跳过 */
function importItems(data, format, onConflict) {
  ensureLib();
  let incoming = [];
  const text = String(data == null ? "" : data);
  if (format === "json") {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, message: "JSON 解析失败：" + (e && e.message) };
    }
    const arr = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.items) ? parsed.items : null;
    if (!arr) return { ok: false, message: "JSON 里没有 items 数组" };
    incoming = arr;
  } else {
    // md：按分隔注释切分，每段各自解析 frontmatter；没有 frontmatter 的段按「整份正文」导入
    const parts = text.split(/\n?<!--\s*====\s*下一条\s*====\s*-->\n?/);
    incoming = parts
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const { meta, body } = parseMd(p);
        return { ...meta, body };
      });
  }

  const m = loadManifest();
  let imported = 0, overwritten = 0, skipped = 0;
  for (const raw of incoming) {
    const item = normalizeItem({ ...raw, id: undefined }); // 一律分配新 id，避免导入撞掉本地条目
    const sameName = Object.keys(m.items).find((id) => m.items[id] && m.items[id].name === item.name && !m.items[id].deletedAt);
    if (sameName) {
      if (onConflict === "skip") { skipped++; continue; }
      if (onConflict === "overwrite") {
        const prev = getItem(sameName);
        saveItem({ ...item, id: sameName, createdAt: prev ? prev.createdAt : undefined, version: prev ? prev.version : 1 });
        overwritten++;
        continue;
      }
    }
    saveItem({ ...item, source: item.source === "local" ? "imported" : item.source });
    imported++;
  }
  return { ok: true, imported, overwritten, skipped };
}

module.exports = {
  // 路径
  libDir, ensureLib, manifestFile, itemsDir, versionsDir, trashDir, reportsDir, remoteStateFile, exportsDir,
  itemFile, trashFile, versionsFile,
  // 工具
  hashText, readJson, writeJsonAtomic, writeTextAtomic, backupBroken, newId, normalizeItem,
  // 台账
  loadManifest, saveManifest, manifestEntry,
  // 版本
  loadVersions, saveVersions, pruneVersions,
  // 条目
  listItems, getItem, saveItem, patchItem, deleteItem, restoreItem, purgeItem, emptyTrash, cleanTrash,
  // 对账
  rebuild, listOrphans,
  // 统计
  stats, metaIndex,
  // 导入导出
  exportItems, importItems,
  // md 编解码（同步模块也要用）
  buildMd, parseMd,
};

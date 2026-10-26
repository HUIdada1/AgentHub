/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-26
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 *  ============================================================
 */
// 提示词库 · 线上目录（精选目录，不是社区）
//
// 定位（方案 §6.1）：纯客户端的静态目录，三层内容来源
//   1) 内置基线：随安装包分发（resources/catalog/），首启无网也能用；
//   2) 远程增量：CDN 上的同名分片，按 hash 只下变更的那几片；
//   3) 用户导入：用户自己选的 JSON，落到本地缓存，版权责任在用户。
//
// 明确不做：账号体系、云端收藏、投稿、评论、热度排行。
// 理由：AgentHub 没有服务端，任何需要「用户身份」的能力都得先建后端，不是这一期的事。
//
// 缓存目录：<userData>/prompts/catalog/
//   ⚠️ 绝不能放进 config.promptsLibDir()（那是用户的库根，rebuild/listOrphans 会把里面的
//   .md 当条目重建）；也绝不能放进 promptsLocalDir()。目录缓存是应用资产，不是用户资产。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = require("../config.cjs");
const store = require("./store.cjs");

// 远程目录：jsDelivr 主（国内可达性好）→ raw.githubusercontent 备。
// 两条都不通就静默用本地，不弹错——目录是「有更好，没有也能用」的东西。
const REMOTE_BASES = [
  "https://cdn.jsdelivr.net/gh/HUIdada1/agenthub-prompts@main/catalog",
  "https://raw.githubusercontent.com/HUIdada1/agenthub-prompts/main/catalog",
];
const FETCH_TIMEOUT_MS = 8000;
const INDEX_FILE = "index.json";
const IMPORT_FILE = "imported.json";

// ===== 路径 =====

/** 内置基线目录：打包后在 resources/catalog，开发时在项目根的 resources/catalog */
function builtinDir() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "catalog"));
  // __dirname = <root>/electron/backend/prompts → 上三级是项目根
  candidates.push(path.join(__dirname, "..", "..", "..", "resources", "catalog"));
  for (const dir of candidates) {
    try { if (fs.existsSync(path.join(dir, INDEX_FILE))) return dir; } catch { /* 无权限就当没有 */ }
  }
  return candidates[candidates.length - 1];
}

/** 缓存目录：应用资产，不参与同步、不进库根 */
function cacheDir() {
  return path.join(config.dataDir(), "prompts", "catalog");
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在或不可写，后面读会自然失败 */ }
  return dir;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

function hashOf(text) {
  return crypto.createHash("sha1").update(String(text || ""), "utf8").digest("hex").slice(0, 12);
}

// ===== 载入（内存缓存 + 失效）=====

let cache = null;

function resetCache() { cache = null; }

/** 载入目录：缓存优先，缺失的片回落到内置基线。任一侧缺失都不该让整个目录不可用。 */
function load() {
  if (cache) return cache;
  const cacheRoot = cacheDir();
  const builtin = builtinDir();

  const cachedIndex = readJson(path.join(cacheRoot, INDEX_FILE));
  const builtinIndex = readJson(path.join(builtin, INDEX_FILE));
  const index = cachedIndex && Array.isArray(cachedIndex.shards) ? cachedIndex : builtinIndex;
  if (!index) {
    cache = { index: null, items: [], templates: [], categories: [], source: "none", imported: [] };
    return cache;
  }

  const items = [];
  const seen = new Set();
  const shards = Array.isArray(index.shards) ? index.shards : [];
  let fromCache = !!cachedIndex;
  for (const shard of shards) {
    if (!shard || !shard.file) continue;
    let data = readJson(path.join(cacheRoot, shard.file));
    if (!data || !Array.isArray(data.items)) {
      data = readJson(path.join(builtin, shard.file));
      fromCache = false;
    }
    if (!data || !Array.isArray(data.items)) continue;
    for (const it of data.items) {
      if (!it || !it.id || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push(normalizeItem(it));
    }
  }

  const imported = readJson(path.join(cacheRoot, IMPORT_FILE));
  const importedItems = imported && Array.isArray(imported.items)
    ? imported.items.map(normalizeItem).filter((x) => x.id && !seen.has(x.id))
    : [];

  cache = {
    index,
    items: items.concat(importedItems),
    templates: Array.isArray(index.templates) ? index.templates : [],
    categories: Array.isArray(index.categories) ? index.categories : [],
    source: fromCache ? "cache" : "builtin",
    imported: importedItems.length,
  };
  return cache;
}

/** 字段归一：目录是外部数据，缺字段/类型不对都不能让页面炸 */
function normalizeItem(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const variables = Array.isArray(o.variables)
    ? o.variables
      .filter((v) => v && String(v.name || "").trim())
      .map((v) => ({
        name: String(v.name).trim(),
        label: v.label ? String(v.label) : undefined,
        def: v.def == null ? undefined : String(v.def),
        required: v.required === true,
      }))
    : [];
  return {
    id: String(o.id || "").trim(),
    title: String(o.title || "未命名").slice(0, 80),
    summary: String(o.summary || "").slice(0, 160),
    body: String(o.body || ""),
    variables,
    category: String(o.category || ""),
    subcategory: o.subcategory ? String(o.subcategory) : undefined,
    tags: Array.isArray(o.tags) ? o.tags.map((t) => String(t)).filter(Boolean).slice(0, 8) : [],
    lang: ["zh", "en", "multi"].includes(o.lang) ? o.lang : "zh",
    templateId: o.templateId ? String(o.templateId) : undefined,
    models: Array.isArray(o.models) ? o.models.map((m) => String(m)).slice(0, 5) : undefined,
    author: o.author ? String(o.author) : undefined,
    license: String(o.license || "未标注"),
    sourceUrl: o.sourceUrl ? String(o.sourceUrl) : undefined,
    version: Number.isFinite(Number(o.version)) ? Number(o.version) : 1,
    updatedAt: Number.isFinite(Number(o.updatedAt)) ? Number(o.updatedAt) : 0,
  };
}

// ===== 查询 =====

/** 列表：卡片只需要标题/摘要/标签/变量数，正文不下发（60 条正文约 19KB，没必要每屏都传） */
function list(args = {}) {
  const d = load();
  const category = String(args.category || "");
  const subcategory = String(args.subcategory || "");
  const templateId = String(args.templateId || "");
  const q = String(args.q || "").trim().toLowerCase();
  const page = Math.max(1, Math.round(Number(args.page) || 1));
  const pageSize = Math.min(200, Math.max(1, Math.round(Number(args.pageSize) || 60)));

  let rows = d.items;
  if (category) rows = rows.filter((i) => i.category === category);
  if (subcategory) rows = rows.filter((i) => i.subcategory === subcategory);
  if (templateId) rows = rows.filter((i) => i.templateId === templateId);
  if (q) {
    rows = rows.filter((i) =>
      i.title.toLowerCase().includes(q)
      || i.summary.toLowerCase().includes(q)
      || i.tags.some((t) => t.toLowerCase().includes(q))
      // 正文也搜：用户常常记得「那句话」而不是标题
      || i.body.toLowerCase().includes(q));
  }

  const total = rows.length;
  const start = (page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize).map((i) => ({
    id: i.id,
    title: i.title,
    summary: i.summary,
    category: i.category,
    subcategory: i.subcategory,
    tags: i.tags,
    templateId: i.templateId,
    lang: i.lang,
    license: i.license,
    version: i.version,
    updatedAt: i.updatedAt,
    variableCount: i.variables.length,
    variableNames: i.variables.slice(0, 3).map((v) => v.name),
  }));

  // 分类计数按「当前筛选后的全集」算，不受分页影响
  const counts = {};
  for (const i of d.items) counts[i.category] = (counts[i.category] || 0) + 1;

  return { ok: true, items: slice, total, page, pageSize, counts };
}

function get(id) {
  const d = load();
  const item = d.items.find((i) => i.id === String(id || ""));
  if (!item) return { ok: false, message: "目录里没有这一条（可能已被新版目录移除）" };
  return { ok: true, item };
}

/** 目录概况：版本、条数、来源、上次检查时间。页面状态条用它。 */
function stats() {
  const d = load();
  const meta = readJson(path.join(cacheDir(), "meta.json")) || {};
  return {
    ok: true,
    stats: {
      version: Number(d.index && d.index.version) || 0,
      updatedAt: Number(d.index && d.index.updatedAtMs) || 0,
      count: d.items.length,
      imported: d.imported,
      categories: d.categories.length,
      templates: d.templates.length,
      source: d.source,
      lastCheckAt: Number(meta.lastCheckAt) || 0,
      lastError: String(meta.lastError || ""),
      remote: REMOTE_BASES[0],
    },
  };
}

function index() {
  const d = load();
  return {
    ok: true,
    categories: d.categories,
    templates: d.templates.map((t) => ({
      ...t,
      itemIds: Array.isArray(t.itemIds) ? t.itemIds : [],
    })),
    version: Number(d.index && d.index.version) || 0,
    source: d.source,
  };
}

// ===== 远程更新 =====

async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch { /* 已中止 */ } }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 逐通道尝试：前一个失败自动换下一个，全失败抛最后一个错误 */
async function fetchFirst(relPath) {
  let lastError = null;
  for (const base of REMOTE_BASES) {
    try {
      return await fetchText(`${base}/${relPath}`);
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error("远程目录不可达");
}

/**
 * 检查并拉取更新。
 * 只下 hash 变了的片：目录会长大，每次全量重下既慢又费流量。
 * @returns { ok, updated, version, count, message }
 */
async function refresh() {
  const cacheRoot = ensureDir(cacheDir());
  const localIndex = readJson(path.join(cacheRoot, INDEX_FILE)) || load().index;
  let remoteIndex;
  try {
    const text = await fetchFirst(INDEX_FILE);
    remoteIndex = JSON.parse(text);
  } catch (e) {
    const message = `检查更新失败：${(e && e.message) || e}`;
    writeJson(path.join(cacheRoot, "meta.json"), { lastCheckAt: Date.now(), lastError: message });
    return { ok: false, updated: false, message };
  }

  const remoteVersion = Number(remoteIndex && remoteIndex.version) || 0;
  const localVersion = Number(localIndex && localIndex.version) || 0;
  if (remoteVersion <= localVersion) {
    writeJson(path.join(cacheRoot, "meta.json"), { lastCheckAt: Date.now(), lastError: "" });
    return { ok: true, updated: false, version: localVersion, count: load().items.length, message: "已是最新目录" };
  }

  const localShards = {};
  for (const s of (localIndex && localIndex.shards) || []) {
    if (s && s.file) localShards[s.file] = readJson(path.join(cacheRoot, s.file));
  }

  const downloaded = [];
  const failed = [];
  for (const shard of remoteIndex.shards || []) {
    if (!shard || !shard.file) continue;
    const local = localShards[shard.file];
    const localHash = local ? hashOf(JSON.stringify(local)) : "";
    if (shard.hash && localHash && shard.hash === localHash) continue;
    try {
      const text = await fetchFirst(shard.file);
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.items)) throw new Error("分片格式不对");
      writeJson(path.join(cacheRoot, shard.file), data);
      downloaded.push(shard.file);
    } catch (e) {
      failed.push(`${shard.file}: ${(e && e.message) || e}`);
    }
  }

  // index 最后写：中途失败时本地仍是「旧 index + 部分新分片」，
  // 下次 refresh 会按 hash 继续补齐，不会出现「index 说新、片是旧」的错位。
  writeJson(path.join(cacheRoot, INDEX_FILE), remoteIndex);
  writeJson(path.join(cacheRoot, "meta.json"), { lastCheckAt: Date.now(), lastError: failed.join("；") });
  resetCache();

  return {
    ok: true,
    updated: true,
    version: remoteVersion,
    count: load().items.length,
    downloaded: downloaded.length,
    failed: failed.length,
    message: failed.length
      ? `已更新到 v${remoteVersion}，${failed.length} 个分片失败，可再点一次检查更新补齐`
      : `已更新到 v${remoteVersion}`,
  };
}

// ===== 用户导入 =====

/**
 * 导入外部数据集。接受三种形状：
 *   1) { items: [...] }（本目录的分片格式）
 *   2) [ {...}, {...} ]（裸数组）
 *   3) { prompts: [...] }（部分开源项目的数据格式）
 * 导入的条目只落本地缓存，不打包、不分发 —— 版权责任在用户。
 */
function importData(raw, fileName) {
  let rows = null;
  if (Array.isArray(raw)) rows = raw;
  else if (raw && Array.isArray(raw.items)) rows = raw.items;
  else if (raw && Array.isArray(raw.prompts)) rows = raw.prompts;
  if (!rows) return { ok: false, message: "文件格式不对：需要 {items:[...]}、{prompts:[...]} 或数组" };

  const cacheRoot = ensureDir(cacheDir());
  const existing = readJson(path.join(cacheRoot, IMPORT_FILE)) || { version: 1, items: [] };
  const seen = new Set((existing.items || []).map((i) => i && i.id));
  const added = [];
  let skipped = 0;

  for (const r of rows) {
    if (!r || typeof r !== "object") { skipped++; continue; }
    const base = normalizeItem({
      ...r,
      // 导入条目一律打上来源标记，界面上要和官方目录区分开
      license: r.license || `用户导入${fileName ? `（${fileName}）` : ""}`,
      sourceUrl: r.sourceUrl || "",
    });
    if (!base.id || !base.body.trim()) { skipped++; continue; }
    // id 冲突时加后缀，不覆盖已导入的
    let id = base.id;
    let n = 2;
    while (seen.has(id)) { id = `${base.id}-${n++}`; }
    seen.add(id);
    added.push({ ...base, id });
  }

  if (!added.length) return { ok: false, message: `没有可导入的条目（跳过 ${skipped} 条）` };

  writeJson(path.join(cacheRoot, IMPORT_FILE), {
    version: 1,
    items: [...(existing.items || []), ...added],
  });
  resetCache();
  return { ok: true, imported: added.length, skipped, total: load().items.length };
}

/** 清空导入层（不动远程缓存与内置基线） */
function clearImported() {
  const file = path.join(cacheDir(), IMPORT_FILE);
  try { fs.rmSync(file, { force: true }); } catch { /* 本来就没有 */ }
  resetCache();
  return { ok: true, total: load().items.length };
}

/** 丢弃远程缓存，回到内置基线 */
function reset() {
  const cacheRoot = cacheDir();
  try {
    for (const name of fs.readdirSync(cacheRoot)) {
      if (name === IMPORT_FILE) continue; // 用户导入的不清：那是他自己的数据
      try { fs.rmSync(path.join(cacheRoot, name), { force: true }); } catch { /* 单个文件失败不影响其它 */ }
    }
  } catch { /* 目录不存在 */ }
  resetCache();
  return { ok: true, total: load().items.length };
}

module.exports = {
  builtinDir, cacheDir, load, list, get, stats, index,
  refresh, importData, clearImported, reset, resetCache,
};

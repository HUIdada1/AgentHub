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

/** 先写 .tmp 再改名：中途崩了也不会留下半个 JSON。
 *  Windows 上改名覆盖已存在文件会被占用方（杀软、索引器、同步盘）顶掉并抛 EPERM/EEXIST，
 *  所以失败时删掉目标重试一次。删目标看着吓人，但能走到这一步说明目录可写、改名几乎必然成功；
 *  真到第二次仍失败，.tmp 里也留着完整的新内容，而 imported.json 写的本就是
 *  「旧条目 + 新条目」的合并结果 —— 重跑一次导入就能拿回全部条目。 */
function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(file, { force: true }); } catch { /* 目标本来就不在，无需删 */ }
    fs.renameSync(tmp, file);
  }
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
  // 只有「带 shards 的缓存 index」才算数：缺 shards 的缓存文件读进来会让 items 恒为空，
  // 却被当成「已更新」的来源标记（见下方 source）。
  const cachedUsable = !!cachedIndex && Array.isArray(cachedIndex.shards);
  let index = cachedUsable ? cachedIndex : builtinIndex;
  if (!index) {
    cache = { index: null, items: [], templates: [], categories: [], source: "none", imported: [] };
    return cache;
  }

  const items = [];
  const seen = new Set();
  let cachedShards = 0; // 真正从缓存读到的分片数
  for (const shard of (Array.isArray(index.shards) ? index.shards : [])) {
    if (!shard || !shard.file) continue;
    let data = cachedUsable ? readJson(path.join(cacheRoot, shard.file)) : null;
    if (data && Array.isArray(data.items)) {
      cachedShards++;
    } else {
      data = readJson(path.join(builtin, shard.file));
    }
    if (!data || !Array.isArray(data.items)) continue;
    for (const it of data.items) {
      if (!it || !it.id || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push(normalizeItem(it));
    }
  }

  // 没有任何分片真的落到缓存时，连 index 一起退回内置：
  // 远程更新会「先写分片、最后写 index」，一旦分片全下载失败就会留下「缓存 index v5 + 内容 v1」，
  // 状态条会写成「内置目录 v5」而列表是安装包里的 v1 —— 内容与版本号必须同源。
  if (cachedShards === 0 && builtinIndex) index = builtinIndex;

  const imported = readJson(path.join(cacheRoot, IMPORT_FILE));
  const importedItems = imported && Array.isArray(imported.items)
    ? imported.items.map(normalizeItem).filter((x) => x.id && !seen.has(x.id))
    : [];

  cache = {
    index,
    items: items.concat(importedItems),
    templates: Array.isArray(index.templates) ? index.templates : [],
    categories: Array.isArray(index.categories) ? index.categories : [],
    // source 只反映「内容实际读到了哪里」：缓存 index 存在 ≠ 内容来自缓存。
    // 分片一片都没读到缓存却报 cache，状态条就会写「已更新到 vX」，用户看到的却是内置旧目录。
    source: cachedShards > 0 ? "cache" : "builtin",
    imported: importedItems.length,
  };
  return cache;
}

/** 字段归一：目录是外部数据，缺字段/类型不对都不能让页面炸 */
function normalizeItem(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  // 变量按名去重：前端用 :key="v.name" 渲染变量 chips，重名会让 Vue 报重复 key，
  // 同名变量本身也没有意义（正文里的 {{同名}} 只会有一份配置）
  const variables = [];
  const seenVar = new Set();
  for (const v of (Array.isArray(o.variables) ? o.variables : [])) {
    const name = String((v && v.name) || "").trim();
    if (!name || seenVar.has(name)) continue;
    seenVar.add(name);
    variables.push({
      name,
      label: v.label ? String(v.label) : undefined,
      def: v.def == null ? undefined : String(v.def),
      required: v.required === true,
    });
  }
  // 标签同样去重（前端的 :key="t" 依赖它唯一）；顺带 trim，避免「写作 」与「写作」算两条
  const tags = [];
  const seenTag = new Set();
  for (const t of (Array.isArray(o.tags) ? o.tags : [])) {
    const name = String(t == null ? "" : t).trim();
    if (!name || seenTag.has(name)) continue;
    seenTag.add(name);
    tags.push(name);
    if (tags.length >= 8) break;
  }
  return {
    id: String(o.id || "").trim(),
    title: String(o.title || "未命名").slice(0, 80),
    summary: String(o.summary || "").slice(0, 160),
    body: String(o.body || ""),
    variables,
    category: String(o.category || ""),
    subcategory: o.subcategory ? String(o.subcategory) : undefined,
    tags,
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

  // 先算「只看搜索与模板」的基础集，列表与 counts 都从它派生 —— 两套筛选条件只写一遍
  let base = d.items;
  if (templateId) base = base.filter((i) => i.templateId === templateId);
  if (q) {
    base = base.filter((i) =>
      i.title.toLowerCase().includes(q)
      || i.summary.toLowerCase().includes(q)
      || i.tags.some((t) => t.toLowerCase().includes(q))
      // 正文也搜：用户常常记得「那句话」而不是标题
      || i.body.toLowerCase().includes(q));
  }

  // counts = 每个分类在「当前 q + 模板筛选下、但不看分类」时的条数。
  // 为什么不按当前分类过滤后再算：左栏数字要能回答「点进去有几条」。
  // 若 counts 跟着分类走，切分类时所有数字都要跳一次、其余分类还全变成 0；
  // 若 counts 完全忽略筛选，又会出现「左栏写 5 条、点进去只有 1 条」的错觉。
  // 忽略分类（二级分类同属左栏下钻维度，一并忽略）、跟随搜索与模板，
  // 才能做到：切分类数字不动、搜索时数字跟着变、点进去条数对得上。
  const counts = {};
  for (const i of base) counts[i.category] = (counts[i.category] || 0) + 1;

  let rows = base;
  if (category) rows = rows.filter((i) => i.category === category);
  if (subcategory) rows = rows.filter((i) => i.subcategory === subcategory);

  // 分片顺序不是稳定契约（远程更新会重排、导入条目追加在末尾），不下定序键的话
  // 同一个 page 在两次刷新之间会重复/漏项。id 唯一，拿它做兜底键凑成全序。
  rows = rows.slice().sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const total = rows.length;
  // 页码越界回落到最后一页，而不是返回空数组：筛选把结果集缩小后旧页码必然越界，
  // 返回空会让用户看到「空列表 + 第 7/2 页」这种自相矛盾的界面。回落最后一页后，
  // 前端拿响应里的 page 覆盖本地页码即可自愈；total 为 0 时落在第 1 页。
  const safePage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
  const start = (safePage - 1) * pageSize;
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

  return { ok: true, items: slice, total, page: safePage, pageSize, counts };
}

function get(id) {
  const d = load();
  const item = d.items.find((i) => i.id === String(id || ""));
  // 两种成因都要说：新版目录可能删条目；导入时 id 冲突会自动加 -2/-3 后缀，
  // 用户手上那个 id 因此可能压根不存在（粘贴/缓存旧列表都会踩到）。
  if (!item) return { ok: false, message: "目录里没有这一条（可能已被新版目录移除；导入条目 id 冲突时会加 -2、-3 后缀，请以列表里显示的 id 为准）" };
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
    // itemIds 是 index.json 里的策展顺序（模板作者挑的案例及其先后），不是列表展示顺序 ——
    // list() 现在按 updatedAt desc + id asc 定序，两边不要互相推断。
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

  // index 最后写，而且**只有分片全下成功才写**：中途失败时本地保持「旧 index + 部分新分片」，
  // 下次 refresh 会按 hash 继续补齐。若失败也写 index，本地版本号会先跳到新值，
  // 下次 refresh 第一句就判「remoteVersion <= localVersion → 已是最新」，
  // 失败的那几片永远补不回来——那句「可再点一次检查更新补齐」就成了空话。
  writeJson(path.join(cacheRoot, "meta.json"), { lastCheckAt: Date.now(), lastError: failed.join("；") });
  if (failed.length) {
    resetCache();
    return {
      ok: true,
      updated: false,
      version: localVersion,
      count: load().items.length,
      downloaded: downloaded.length,
      failed: failed.length,
      message: `更新未完成：${failed.length} 个分片下载失败（已下 ${downloaded.length} 个），目录仍是 v${localVersion}，可再点一次「检查更新」补齐`,
    };
  }
  writeJson(path.join(cacheRoot, INDEX_FILE), remoteIndex);
  resetCache();

  return {
    ok: true,
    updated: true,
    version: remoteVersion,
    count: load().items.length,
    downloaded: downloaded.length,
    failed: 0,
    message: `已更新到 v${remoteVersion}`,
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

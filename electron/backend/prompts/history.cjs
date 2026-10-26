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
// 提示词库 · 优化历史（本机记录，不参与同步）
//
// 为什么留在本机：优化历史是「我刚才试了什么」的临时线索，同步到别的设备没有价值，
// 还会把库的同步包撑大。它落在 <userData>/prompts/history.json。
//
// 容量策略（三重，防单文件无限膨胀）：
//   1) 条数上限 historyLimit（默认 50，FIFO）
//   2) 单条原文/结果各截断 16KB（截断打标记，该条禁止回填——避免把残缺文本写回编辑器）
//   3) 文件总量 2MB（超出继续按最旧裁剪）
"use strict";
const path = require("node:path");
const config = require("../config.cjs");
const store = require("./store.cjs");

const PER_FIELD_LIMIT = 16 * 1024; // 单条原文/结果各自的截断长度
const FILE_LIMIT = 2 * 1024 * 1024; // history.json 总量上限

function historyFile() {
  return path.join(config.promptsLocalDir(), "history.json");
}

function truncate(text, limit = PER_FIELD_LIMIT) {
  const s = String(text == null ? "" : text);
  if (Buffer.byteLength(s, "utf8") <= limit) return { text: s, truncated: false };
  // 按字符逐步收敛，避免把多字节字符从中间截断
  let cut = s.slice(0, limit);
  while (Buffer.byteLength(cut, "utf8") > limit && cut.length > 0) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

function load() {
  const raw = store.readJson(historyFile(), null);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) {
    // 文件存在但解析失败 = 损坏：先留证再重建，不让用户的历史无声消失（也不阻塞新记录写入）
    try {
      const fs = require("node:fs");
      if (fs.existsSync(historyFile())) store.backupBroken(historyFile());
    } catch { /* 备份失败不拦流程 */ }
    return { version: 1, items: [] };
  }
  return { version: 1, items: raw.items.filter((x) => x && typeof x === "object") };
}

function save(data) {
  const limit = (config.loadConfig().prompts || {}).historyLimit || 50;
  let items = data.items.slice(0, Math.max(1, limit));

  // 总量收敛：逐条累加字节数，超限就从最旧的丢
  const keep = [];
  let bytes = 0;
  for (const it of items) {
    const size = Buffer.byteLength(JSON.stringify(it), "utf8");
    if (bytes + size > FILE_LIMIT && keep.length > 0) break;
    keep.push(it);
    bytes += size;
  }
  store.writeJsonAtomic(historyFile(), { version: 1, items: keep });
}

/** 追加一条记录（成功与失败都记：失败留痕才能区分是模型问题还是网络问题） */
function add(entry) {
  const data = load();
  const input = truncate(entry.inputText);
  const output = truncate(entry.outputText);
  const item = {
    id: store.newId(),
    at: Date.now(),
    styleId: String(entry.styleId || ""),
    styleName: String(entry.styleName || ""), // 快照风格名：风格后来被删也能正确显示
    model: String(entry.model || ""),
    inputText: input.text,
    outputText: output.text,
    inputTruncated: input.truncated,
    outputTruncated: output.truncated,
    elapsedMs: Math.max(0, Math.round(Number(entry.elapsedMs) || 0)),
    tokens: entry.tokens && typeof entry.tokens === "object" ? entry.tokens : undefined,
    savedToLibrary: entry.savedToLibrary ? String(entry.savedToLibrary) : undefined,
    applied: entry.applied === true,
    // 多角度补全的假设清单：正文里已被剥离，但「当时模型替用户猜了什么」是回溯的一部分，
    // 不存就会在历史里彻底丢失（回填时也拿不到）。
    assumptions: Array.isArray(entry.assumptions) && entry.assumptions.length
      ? entry.assumptions.map((x) => String(x).slice(0, 300)).slice(0, 10)
      : undefined,
    error: entry.error ? String(entry.error).slice(0, 500) : undefined,
  };
  data.items.unshift(item); // 新的在前
  save(data);
  return item;
}

function list() {
  return load().items;
}

function remove(id) {
  const data = load();
  data.items = data.items.filter((x) => x.id !== id);
  save(data);
  return { ok: true };
}

function clear() {
  save({ version: 1, items: [] });
  return { ok: true };
}

/** 标记某条历史「已存入我的库」（存库后回写，便于历史列表显示状态） */
function markSaved(historyId, libraryId) {
  const data = load();
  const it = data.items.find((x) => x.id === historyId);
  if (!it) return { ok: false, message: "记录不存在" };
  it.savedToLibrary = libraryId;
  it.applied = true;
  save(data);
  return { ok: true };
}

module.exports = { add, list, remove, clear, markSaved, historyFile, PER_FIELD_LIMIT, FILE_LIMIT };

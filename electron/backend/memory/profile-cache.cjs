/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除声明。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const PROFILE_NAMES = ["persona", "preferences", "tech", "habits"];

function getCachePath(dataDir) {
  return path.join(dataDir, "memory-profile-cache.json");
}

function loadCache(dataDir) {
  try {
    const p = getCachePath(dataDir);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function saveCache(dataDir, sections = {}, meta = {}) {
  try {
    const p = getCachePath(dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const prev = loadCache(dataDir) || { sections: {} };
    const mergedSections = { ...(prev.sections || {}) };
    for (const name of PROFILE_NAMES) {
      if (typeof sections[name] === "string" && sections[name].trim()) {
        mergedSections[name] = sections[name];
      }
    }
    const data = {
      version: 1,
      updatedAt: meta.updatedAt || Date.now(),
      tokens: meta.tokens || prev.tokens || 0,
      sections: mergedSections,
    };
    fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 从 store 读取现有 4 个画像分区并同步到持久缓存 */
function syncStoreToCache(store, dataDir) {
  if (!store || !dataDir) return false;
  const sections = {};
  for (const n of PROFILE_NAMES) {
    const text = store.read(`profile/${n}.md`);
    if (text && text.trim()) sections[n] = text;
  }
  if (Object.keys(sections).length > 0) {
    return saveCache(dataDir, sections, { updatedAt: Date.now() });
  }
  return false;
}

/** 如果本地仓库中的画像分区缺失或为空，自动从持久缓存中还原自愈落盘 */
function restoreIfMissing(store, dataDir, reindexCallback) {
  if (!store || !dataDir) return { restored: [] };
  const cache = loadCache(dataDir);
  if (!cache || !cache.sections) return { restored: [] };
  const restored = [];
  for (const n of PROFILE_NAMES) {
    const rel = `profile/${n}.md`;
    const cur = store.read(rel);
    // 如果本地不存在或为空，但缓存里有内容
    if ((!cur || !cur.trim()) && cache.sections[n] && cache.sections[n].trim()) {
      store.writeAtomic(rel, cache.sections[n], { backup: true });
      if (typeof reindexCallback === "function") {
        try { reindexCallback(rel); } catch {}
      }
      restored.push(n);
    }
  }
  return { restored };
}

module.exports = {
  PROFILE_NAMES,
  getCachePath,
  loadCache,
  saveCache,
  syncStoreToCache,
  restoreIfMissing,
};

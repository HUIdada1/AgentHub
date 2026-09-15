// 去重：L1 内容哈希直接合并，L2 名称归一只进冲突队列，L3 相似度纯提示
"use strict";

// taste-skill -> taste，gpt-tasteskill -> gpt-taste
function normalizeName(name) {
  let n = String(name || "").toLowerCase().replace(/[\s_]+/g, "-");
  n = n.replace(/-?skills?$/, "");
  n = n.replace(/-v\d+$/, "");
  return n;
}

function dedupe(scanned, cfg) {
  const unique = [];
  const duplicates = [];
  const conflicts = [];
  const byHash = new Map();
  const byNorm = new Map();

  // L1：同哈希合并（改名副本也算），代表取先扫到的那个
  for (const e of scanned.skills) {
    const hit = byHash.get(e.treeHash);
    if (hit) {
      hit.sources.push({ tool: e.tool, name: e.name, dir: e.dir });
      duplicates.push({ kept: { name: hit.name, tool: hit.tool }, removed: { name: e.name, tool: e.tool }, rule: "L1", basis: "内容树哈希一致" });
      continue;
    }
    const entry = { ...e, sources: [{ tool: e.tool, name: e.name, dir: e.dir }] };
    byHash.set(e.treeHash, entry);
    unique.push(entry);
  }

  // L2：归一同名但内容不同，不自动合并，人工裁决
  for (const e of unique) {
    const key = normalizeName(e.skillName || e.name);
    if (!key) continue;
    if (byNorm.has(key)) {
      conflicts.push({ key, variants: [byNorm.get(key), e], rule: "L2", basis: "名称归一相同、内容不同" });
    } else {
      byNorm.set(key, e);
    }
  }

  // L3 默认关着，开了也只是提示
  const hints = [];
  if (cfg.l3 && cfg.l3.enabled) {
    const th = cfg.l3.threshold || 0.85;
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const sim = cosine(similarText(unique[i]), similarText(unique[j]));
        if (sim >= th) hints.push({ a: unique[i].name, b: unique[j].name, sim: Number(sim.toFixed(3)) });
      }
    }
  }

  return { unique, duplicates, conflicts, hints };
}

function similarText(e) {
  return ((e.skillName || e.name) + " " + (e.description || "")).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ").trim();
}

function cosine(a, b) {
  const va = new Map(), vb = new Map();
  for (const w of a.split(" ")) if (w) va.set(w, (va.get(w) || 0) + 1);
  for (const w of b.split(" ")) if (w) vb.set(w, (vb.get(w) || 0) + 1);
  let dot = 0, na = 0, nb = 0;
  for (const [w, x] of va) { na += x * x; const y = vb.get(w); if (y) dot += x * y; }
  for (const [, x] of vb) nb += x * x;
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

module.exports = { normalizeName, dedupe, cosine };

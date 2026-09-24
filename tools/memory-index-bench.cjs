// 记忆索引基准测试：对比 trigram 与自建 bigram 预分词，实测增删改查速度 + 准确性 + 体积
// 运行：node tools/memory-index-bench.cjs   （本机 Node 22 内置 node:sqlite，带 FTS5）
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ===== 确定性随机（可复现） =====
let seed = 20260924;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];

// ===== 中文语料词表（模拟真实记忆文本） =====
const CN = ["记忆","仓库","索引","检索","同步","冲突","裁决","压缩","打包","上传","下载","方案","设计","架构","性能","准确","速度","分词","权重","排序","缓存","并发","写入","读取","删除","更新","新增","查询","项目","归类","模糊","匹配","远程","地址","分支","提交","部署","构建","编译","测试","接口","协议","配置","注入","连接","状态","校验","握手","心跳","画像","人格","偏好","习惯","蒸馏","摘要","标签","重要","时间","衰减","扩散","激活","图谱","节点","边","孤立","诊断","报告","备份","迁移","配额","体积","增长","隐私","脱敏","敏感","加密","权限","安全"];
const TECH = ["FTS5","BM25","SQLite","MCP","WebDAV","Markdown","Electron","Vue","TypeScript","JSON-RPC","WAL","trigram","bigram","token","index","cache","query","rank"];
const AGENTS = ["zcode","codex","workbuddy","claude","manual"];

function sentence(minW, maxW) {
  const n = minW + Math.floor(rnd() * (maxW - minW + 1));
  let s = "";
  for (let i = 0; i < n; i++) s += pick(rnd() < 0.82 ? CN : TECH);
  return s;
}

function makeCorpus(N) {
  const docs = [];
  for (let i = 0; i < N; i++) {
    const title = sentence(3, 8);
    const summary = sentence(10, 24);
    const body = sentence(60, 160) + " " + sentence(20, 60) + " " + pick(TECH) + " " + sentence(10, 30);
    const tags = [pick(CN), pick(CN), pick(TECH)].join(",");
    docs.push({
      id: "mem_" + String(i).padStart(6, "0"),
      title, summary, body, tags,
      project: "proj-" + (i % 40),
      agent: pick(AGENTS),
      created: 1758000000000 + i * 60000,
      importance: 1 + (i % 5),
      path: `projects/p${i % 40}/l1/a/2026-09-24-${i}.md`,
    });
  }
  return docs;
}

// ===== 分词器 =====
const isCJK = (c) => {
  const x = c.codePointAt(0);
  return (x >= 0x3400 && x <= 0x9fff) || (x >= 0xf900 && x <= 0xfaff) || (x >= 0x3040 && x <= 0x30ff) || (x >= 0xac00 && x <= 0xd7af);
};
/** 中文 bigram（可选 unigram）+ 英文数字词，空格分隔后交给 unicode61 建索引 */
function tokenize(text, withUnigram) {
  const s = String(text || "");
  const out = [];
  let i = 0, n = s.length;
  while (i < n) {
    const c = s[i];
    if (isCJK(c)) {
      let j = i;
      while (j < n && isCJK(s[j])) j++;
      const run = s.slice(i, j);
      if (withUnigram) for (const ch of run) out.push(ch);
      for (let k = 0; k + 1 < run.length; k++) out.push(run.slice(k, k + 2));
      i = j;
    } else if (/[A-Za-z0-9_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(s[j])) j++;
      out.push(s.slice(i, j).toLowerCase());
      i = j;
    } else i++;
  }
  return out.join(" ");
}
/** 查询转 FTS5 短语：tokens 相邻 = 原始子串，保证 CJK 子串语义 */
function phrase(q, withUnigram) {
  const t = tokenize(q, withUnigram).split(" ").filter(Boolean);
  if (!t.length) return null;
  return '"' + t.join(" ") + '"';
}

const ms = (t0) => performance.now() - t0;
const fmt = (v, d = 2) => Number(v).toFixed(d);

function buildTrigram(docs, dbPath) {
  fs.rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE mem(id TEXT PRIMARY KEY, project TEXT, agent TEXT, created INTEGER, importance INTEGER, path TEXT, summary TEXT)");
  db.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(id UNINDEXED, title, summary, body, tags, tokenize='trigram')");
  const insM = db.prepare("INSERT INTO mem VALUES(?,?,?,?,?,?,?)");
  const insF = db.prepare("INSERT INTO mem_fts(id,title,summary,body,tags) VALUES(?,?,?,?,?)");
  const t0 = performance.now();
  db.exec("BEGIN");
  for (const d of docs) {
    insM.run(d.id, d.project, d.agent, d.created, d.importance, d.path, d.summary);
    insF.run(d.id, d.title, d.summary, d.body, d.tags);
  }
  db.exec("COMMIT");
  return { db, buildMs: ms(t0) };
}

function buildBigram(docs, dbPath, withUnigram) {
  fs.rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE mem(id TEXT PRIMARY KEY, project TEXT, agent TEXT, created INTEGER, importance INTEGER, path TEXT, summary TEXT)");
  db.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(id UNINDEXED, t_title, t_summary, t_body, t_tags, tokenize='unicode61')");
  const insM = db.prepare("INSERT INTO mem VALUES(?,?,?,?,?,?,?)");
  const insF = db.prepare("INSERT INTO mem_fts(id,t_title,t_summary,t_body,t_tags) VALUES(?,?,?,?,?)");
  const t0 = performance.now();
  db.exec("BEGIN");
  for (const d of docs) {
    insM.run(d.id, d.project, d.agent, d.created, d.importance, d.path, d.summary);
    insF.run(d.id, tokenize(d.title, withUnigram), tokenize(d.summary, withUnigram), tokenize(d.body, withUnigram), tokenize(d.tags, withUnigram));
  }
  db.exec("COMMIT");
  return { db, buildMs: ms(t0) };
}

/** 暴力求 ground truth：子串匹配（模拟"真实包含该查询"的文档集合） */
function groundTruth(docs, q) {
  const needle = q.toLowerCase();
  const out = new Set();
  for (const d of docs) {
    if ((d.title + d.summary + d.body + d.tags).toLowerCase().includes(needle)) out.add(d.id);
  }
  return out;
}

function benchQueries(db, docs, queries, mode, withUnigram, K = 10) {
  const stmt = mode === "trigram"
    ? db.prepare("SELECT id, bm25(mem_fts, 0, 4.0, 2.0, 1.0, 3.0) AS score FROM mem_fts WHERE mem_fts MATCH ? ORDER BY score LIMIT ?")
    : db.prepare("SELECT id, bm25(mem_fts, 0, 4.0, 2.0, 1.0, 3.0) AS score FROM mem_fts WHERE mem_fts MATCH ? ORDER BY score LIMIT ?");
  let latSum = 0, latN = 0, recallSum = 0, recallN = 0, empty = 0;
  const perClass = {};
  for (const q of queries) {
    const expr = mode === "trigram" ? `"${q}"` : phrase(q, withUnigram);
    if (!expr) continue;
    const t0 = performance.now();
    let rows;
    try { rows = stmt.all(expr, K); } catch { rows = []; }
    const dt = ms(t0);
    latSum += dt; latN++;
    const gt = groundTruth(docs, q);
    const hit = rows.filter((r) => gt.has(r.id)).length;
    const rec = gt.size ? hit / Math.min(gt.size, K) : 1;
    if (!rows.length) empty++;
    recallSum += rec; recallN++;
    const cls = q.length <= 2 ? "中文2字" : q.length === 3 ? "中文3字" : q.length === 4 ? "中文4字" : /^[\x00-\x7f]+$/.test(q) ? "英文" : "中文长";
    (perClass[cls] ||= { n: 0, lat: 0, rec: 0, empty: 0 });
    perClass[cls].n++; perClass[cls].lat += dt; perClass[cls].rec += rec; if (!rows.length) perClass[cls].empty++;
  }
  return { avgLat: latSum / latN, avgRecall: recallSum / recallN, empty, n: latN, perClass };
}

function crudBench(db, docs, mode, withUnigram, ops = 2000) {
  const upM = db.prepare("UPDATE mem SET summary=? WHERE id=?");
  const upF = mode === "trigram"
    ? db.prepare("UPDATE mem_fts SET title=?, summary=?, body=?, tags=? WHERE id=?")
    : db.prepare("UPDATE mem_fts SET t_title=?, t_summary=?, t_body=?, t_tags=? WHERE id=?");
  const delM = db.prepare("DELETE FROM mem WHERE id=?");
  const delF = db.prepare("DELETE FROM mem_fts WHERE id=?");
  const insM = db.prepare("INSERT INTO mem VALUES(?,?,?,?,?,?,?)");
  const insF = mode === "trigram"
    ? db.prepare("INSERT INTO mem_fts(id,title,summary,body,tags) VALUES(?,?,?,?,?)")
    : db.prepare("INSERT INTO mem_fts(id,t_title,t_summary,t_body,t_tags) VALUES(?,?,?,?,?)");

  const sample = docs.slice(0, ops);
  // 更新
  let t0 = performance.now();
  db.exec("BEGIN");
  for (const d of sample) {
    upM.run(d.summary + "改", d.id);
    if (mode === "trigram") upF.run(d.title, d.summary + "改", d.body, d.tags, d.id);
    else upF.run(tokenize(d.title, withUnigram), tokenize(d.summary + "改", withUnigram), tokenize(d.body, withUnigram), tokenize(d.tags, withUnigram), d.id);
  }
  db.exec("COMMIT");
  const upd = ms(t0) / ops;
  // 删除
  t0 = performance.now();
  db.exec("BEGIN");
  for (const d of sample) { delM.run(d.id); delF.run(d.id); }
  db.exec("COMMIT");
  const del = ms(t0) / ops;
  // 新增
  t0 = performance.now();
  db.exec("BEGIN");
  for (const d of sample) {
    insM.run(d.id, d.project, d.agent, d.created, d.importance, d.path, d.summary);
    if (mode === "trigram") insF.run(d.id, d.title, d.summary, d.body, d.tags);
    else insF.run(d.id, tokenize(d.title, withUnigram), tokenize(d.summary, withUnigram), tokenize(d.body, withUnigram), tokenize(d.tags, withUnigram));
  }
  db.exec("COMMIT");
  const ins = ms(t0) / ops;
  return { ins, upd, del };
}

// ===== 主流程 =====
const N = 8000;
const docs = makeCorpus(N);
console.log(`语料：${N} 条记忆\n`);

// 查询集：2/3/4 字中文 + 英文
const queries = ["记忆","索引","配置","同步","冲突","裁决","性能","准确","画像","蒸馏",
  "记忆仓","索引检","连接状","时间衰","隐私脱","压缩打",
  "记忆仓库","索引检索","冲突裁决","性能准确","连接状态","时间衰减","隐私脱敏",
  "索引检索同步","记忆仓库索引","冲突裁决方案","性能准确速度",
  "FTS5","BM25","SQLite","WebDAV","MCP","Markdown","trigram","bigram"];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "membench-"));
const results = [];

for (const variant of [
  { name: "trigram", mode: "trigram", unigram: false },
  { name: "bigram(预分词)", mode: "bigram", unigram: false },
  { name: "bigram+unigram(预分词)", mode: "bigram", unigram: true },
]) {
  const dbPath = path.join(tmp, variant.name.replace(/[^\w]/g, "_") + ".sqlite");
  const built = variant.mode === "trigram" ? buildTrigram(docs, dbPath) : buildBigram(docs, dbPath, variant.unigram);
  const q = benchQueries(built.db, docs, queries, variant.mode, variant.unigram);
  const crud = crudBench(built.db, docs, variant.mode, variant.unigram);
  built.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  built.db.close();
  const size = fs.statSync(dbPath).size;
  results.push({ variant, built, q, crud, size });
}

// ===== 输出 =====
console.log("=".repeat(78));
console.log("一、构建与体积");
console.log("=".repeat(78));
console.log("方案".padEnd(26) + "建索引(ms)".padEnd(14) + "索引体积(MB)".padEnd(16) + "单条写入(ms)");
for (const r of results) {
  console.log(r.variant.name.padEnd(24) + fmt(r.built.buildMs, 0).padEnd(16) + fmt(r.size / 1048576, 1).padEnd(18) + fmt(r.crud.ins, 3));
}

console.log("\n" + "=".repeat(78));
console.log("二、增删改（每条平均耗时 ms，批量事务内）");
console.log("=".repeat(78));
console.log("方案".padEnd(26) + "新增".padEnd(12) + "更新".padEnd(12) + "删除");
for (const r of results) {
  console.log(r.variant.name.padEnd(24) + fmt(r.crud.ins, 3).padEnd(14) + fmt(r.crud.upd, 3).padEnd(14) + fmt(r.crud.del, 3));
}

console.log("\n" + "=".repeat(78));
console.log("三、查询准确性（recall@10 vs 子串真值）与延迟");
console.log("=".repeat(78));
for (const r of results) {
  console.log(`\n【${r.variant.name}】平均延迟 ${fmt(r.q.avgLat, 2)}ms · 平均召回 ${fmt(r.q.avgRecall * 100, 1)}% · 空结果 ${r.q.empty}/${r.q.n} 条查询`);
  console.log("  查询类型".padEnd(14) + "条数".padEnd(8) + "平均延迟(ms)".padEnd(16) + "平均召回".padEnd(12) + "空结果");
  for (const [cls, s] of Object.entries(r.q.perClass)) {
    console.log("  " + cls.padEnd(12) + String(s.n).padEnd(8) + fmt(s.lat / s.n, 2).padEnd(18) + (fmt((s.rec / s.n) * 100, 1) + "%").padEnd(14) + s.empty);
  }
}

console.log("\n" + "=".repeat(78));
console.log("四、典型查询逐条对比（top1 是否命中 / 返回条数）");
console.log("=".repeat(78));
const probe = ["记忆","索引","冲突","记忆仓库","FTS5"];
console.log("查询".padEnd(14) + results.map((r) => r.variant.name.padEnd(26)).join(""));
for (const p of probe) {
  let line = p.padEnd(12);
  for (const r of results) {
    const expr = r.variant.mode === "trigram" ? `"${p}"` : phrase(p, r.variant.unigram);
    const db2 = new DatabaseSync(path.join(tmp, r.variant.name.replace(/[^\w]/g, "_") + ".sqlite"));
    let rows = [];
    try { rows = db2.prepare("SELECT id FROM mem_fts WHERE mem_fts MATCH ? LIMIT 10").all(expr); } catch { rows = []; }
    const gt = groundTruth(docs, p);
    const hit = rows.filter((x) => gt.has(x.id)).length;
    line += `${rows.length}条/命中${hit}`.padEnd(26);
    db2.close();
  }
  console.log(line);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n完成。");

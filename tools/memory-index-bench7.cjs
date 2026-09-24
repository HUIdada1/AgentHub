/**
 * 基准测试七：真实分布下的检索性能 + 三种优化对比
 *  - 数据用 Zipf 长尾分布（贴近真实语料：少数词高频，多数词低频）
 *  - 优化A：两阶段检索（子查询先截断候选集，再算 bm25 排序）
 *  - 优化B：BM25 列权重是否影响排序开销
 *  - 优化C：MATCH 的 AND/NEAR 语义 vs 单列短语
 *  - 优化D：加 project/时间 预过滤（元数据先缩小范围）
 */
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs"), os = require("os"), path = require("path");

const isCJK = (c) => { const x = c.codePointAt(0); return (x >= 0x3400 && x <= 0x9fff) || (x >= 0xf900 && x <= 0xfaff); };
function tokenize(t) {
  const s = String(t || ""); const out = []; let i = 0, n = s.length;
  while (i < n) {
    const c = s[i];
    if (isCJK(c)) { let j = i; while (j < n && isCJK(s[j])) j++; const r = s.slice(i, j); for (let k = 0; k + 1 < r.length; k++) out.push(r.slice(k, k + 2)); i = j; }
    else if (/[A-Za-z0-9_]/.test(c)) { let j = i; while (j < n && /[A-Za-z0-9_]/.test(s[j])) j++; out.push(s.slice(i, j).toLowerCase()); i = j; }
    else i++;
  }
  return out.join(" ");
}
const phrase = (q) => { const t = tokenize(q).split(" ").filter(Boolean); return t.length ? '"' + t.join(" ") + '"' : null; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b7-"));
const P = path.join(tmp, "m.sqlite");
const db = new DatabaseSync(P);
db.exec("PRAGMA journal_mode=WAL"); db.exec("PRAGMA synchronous=NORMAL"); db.exec("PRAGMA mmap_size=268435456");
db.exec(`CREATE TABLE mem(
  id TEXT PRIMARY KEY, path TEXT, project TEXT, agent TEXT, type TEXT, layer TEXT,
  created INTEGER, updated INTEGER, importance INTEGER, hash TEXT, size INTEGER,
  t_title TEXT, t_summary TEXT, t_body TEXT, t_tags TEXT)`);
db.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(t_title, t_summary, t_body, t_tags, content='mem', content_rowid='rowid', tokenize='unicode61')");
db.exec(`CREATE TRIGGER mem_ai AFTER INSERT ON mem BEGIN
  INSERT INTO mem_fts(rowid,t_title,t_summary,t_body,t_tags) VALUES(new.rowid,new.t_title,new.t_summary,new.t_body,new.t_tags); END`);
db.exec(`CREATE TRIGGER mem_ad AFTER DELETE ON mem BEGIN
  INSERT INTO mem_fts(mem_fts,rowid,t_title,t_summary,t_body,t_tags) VALUES('delete',old.rowid,old.t_title,old.t_summary,old.t_body,old.t_tags); END`);
db.exec(`CREATE TRIGGER mem_au AFTER UPDATE ON mem BEGIN
  INSERT INTO mem_fts(mem_fts,rowid,t_title,t_summary,t_body,t_tags) VALUES('delete',old.rowid,old.t_title,old.t_summary,old.t_body,old.t_tags);
  INSERT INTO mem_fts(rowid,t_title,t_summary,t_body,t_tags) VALUES(new.rowid,new.t_title,new.t_summary,new.t_body,new.t_tags); END`);
db.exec("CREATE INDEX idx_project ON mem(project); CREATE INDEX idx_created ON mem(created DESC)");

// ===== Zipf 长尾词表：模拟真实语料 =====
// 真实记忆里，「记忆/项目」这类通用词极高频，「裁决/蒸馏」这类词极低频
const VOCAB = [
  // 高频
  { w: "记忆", f: 1 }, { w: "项目", f: 1.2 }, { w: "文件", f: 1.4 }, { w: "代码", f: 1.6 }, { w: "问题", f: 1.8 },
  { w: "时间", f: 2.0 }, { w: "内容", f: 2.2 }, { w: "使用", f: 2.4 }, { w: "需要", f: 2.6 }, { w: "可以", f: 2.8 },
  // 中频
  { w: "索引", f: 5 }, { w: "检索", f: 6 }, { w: "同步", f: 7 }, { w: "冲突", f: 8 }, { w: "归档", f: 9 },
  { w: "压缩", f: 10 }, { w: "打包", f: 12 }, { w: "上传", f: 14 }, { w: "下载", f: 16 }, { w: "备份", f: 18 },
  { w: "方案", f: 20 }, { w: "架构", f: 22 }, { w: "性能", f: 25 }, { w: "准确", f: 28 }, { w: "速度", f: 30 },
  { w: "分词", f: 35 }, { w: "权重", f: 40 }, { w: "排序", f: 45 }, { w: "缓存", f: 50 }, { w: "并发", f: 55 },
  // 低频（专业知识词）
  { w: "裁决", f: 200 }, { w: "蒸馏", f: 250 }, { w: "人格", f: 300 }, { w: "画像", f: 350 }, { w: "图谱", f: 400 },
  { w: "墓碑", f: 500 }, { w: "渐进披露", f: 600 }, { w: "三元组", f: 700 }, { w: "时间衰减", f: 800 }, { w: "向量化", f: 900 },
];
// 按 f 反比构造抽取权重
const pool = [];
for (const v of VOCAB) { const k = Math.max(1, Math.round(1000 / v.f)); for (let i = 0; i < k; i++) pool.push(v.w); }

let seed = 777; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = () => pool[Math.floor(rnd() * pool.length)];
const sent = (a, b) => { let s = ""; const n = a + Math.floor(rnd() * (b - a + 1)); for (let i = 0; i < n; i++) s += pick(); return s; };

const N = 20000;
const ins = db.prepare("INSERT INTO mem(id,path,project,agent,type,layer,created,updated,importance,hash,size,t_title,t_summary,t_body,t_tags) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
db.exec("BEGIN");
for (let i = 0; i < N; i++) {
  const title = sent(2, 6), summary = sent(6, 18), body = sent(40, 120), tags = pick() + "," + pick();
  ins.run("mem_" + i, `projects/p${i % 50}/l1/a/x-${i}.md`, "proj-" + (i % 50), ["zcode", "codex", "workbuddy"][i % 3],
    "daily", "l1", 1758000000000 + i * 60000, 1758000000000 + i * 60000, 1 + (i % 5), "h" + i, body.length,
    tokenize(title), tokenize(summary), tokenize(body), tokenize(tags));
}
db.exec("COMMIT");
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
console.log("【语料】" + N + " 条，Zipf 长尾分布，体积 " + (fs.statSync(P).size / 1048576).toFixed(1) + "MB\n");

const cnt = db.prepare("SELECT count(*) c FROM mem_fts WHERE mem_fts MATCH ?");
console.log("各词命中基数（真实分布）：");
for (const v of VOCAB) {
  const p = phrase(v.w); const c = cnt.get(p).c;
  console.log("  " + v.w.padEnd(10) + String(c).padStart(6) + " 条  (" + (c / N * 100).toFixed(1) + "%)");
}

// ===== 优化对比 =====
const q1 = db.prepare(`SELECT m.id, m.project, m.agent, m.created, bm25(mem_fts,6.0,3.0,1.0,4.0) AS score
  FROM mem_fts JOIN mem m ON m.rowid=mem_fts.rowid WHERE mem_fts MATCH ? ORDER BY score LIMIT ?`);

// 优化A：两阶段。先取 rowid 候选（带 LIMIT），再 JOIN 算分
const q2 = db.prepare(`SELECT m.id, m.project, m.agent, m.created, bm25(mem_fts,6.0,3.0,1.0,4.0) AS score
  FROM (SELECT rowid FROM mem_fts WHERE mem_fts MATCH ? LIMIT 2000) c
  JOIN mem_fts ON mem_fts.rowid = c.rowid
  JOIN mem m ON m.rowid = c.rowid
  ORDER BY score LIMIT ?`);

// 优化D：元数据预过滤（project + 时间）再算分
const q3 = db.prepare(`SELECT m.id, m.project, m.agent, m.created, bm25(mem_fts,6.0,3.0,1.0,4.0) AS score
  FROM mem_fts JOIN mem m ON m.rowid=mem_fts.rowid
  WHERE mem_fts MATCH ? AND m.project = ? ORDER BY score LIMIT ?`);

// 优化E：不排序，只取命中（用于计数/预览）
const q4 = db.prepare(`SELECT m.id FROM mem_fts JOIN mem m ON m.rowid=mem_fts.rowid WHERE mem_fts MATCH ? LIMIT ?`);

const bench = (fn, q, R) => { fn(q); const a = performance.now(); for (let i = 0; i < R; i++) fn(q); return (performance.now() - a) / R; };

console.log("\n=== 优化对比（稳态，LIMIT 10）===");
console.log("词".padEnd(12) + "命中".padEnd(8) + "基线(全量排序)".padEnd(18) + "两阶段".padEnd(12) + "无排序".padEnd(12) + "元数据过滤");
for (const w of ["记忆", "项目", "索引", "冲突", "裁决", "人格", "墓碑", "向量化"]) {
  const p = phrase(w); const hits = cnt.get(p).c;
  const base = bench(x => q1.all(x, 10), p, 30);
  const two = bench(x => q2.all(x, 10), p, 30);
  const nosort = bench(x => q4.all(x, 10), p, 30);
  const filt = bench(x => q3.all(x, "proj-3", 10), p, 30);
  console.log(w.padEnd(10) + String(hits).padEnd(9) + base.toFixed(2).padEnd(20) + two.toFixed(2).padEnd(14) + nosort.toFixed(2).padEnd(14) + filt.toFixed(2));
}

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n✅ 优化对比完成");

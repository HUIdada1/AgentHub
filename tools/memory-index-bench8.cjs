/**
 * 基准测试八：两阶段检索的正确性验证与参数标定
 *  核心问题：先截断候选集（LIMIT K）再算 bm25 排序，会不会丢掉真正 top10？
 *  方法：与「全量排序」的 top10 结果做逐位对比，测不同 K 值下的命中一致率
 *  另测：FTS5 的 highlight()/snippet() 开销（渐进式披露要用）
 *       以及 rank 消歧义：ORDER BY rank 是否需要显式 bm25
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b8-"));
const P = path.join(tmp, "m.sqlite");
const db = new DatabaseSync(P);
db.exec("PRAGMA journal_mode=WAL"); db.exec("PRAGMA synchronous=NORMAL"); db.exec("PRAGMA mmap_size=268435456");
db.exec(`CREATE TABLE mem(
  id TEXT PRIMARY KEY, path TEXT, project TEXT, agent TEXT, type TEXT, layer TEXT,
  created INTEGER, updated INTEGER, importance INTEGER, hash TEXT, size INTEGER,
  t_title TEXT, t_summary TEXT, t_body TEXT, t_tags TEXT,
  raw_summary TEXT)`);
db.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(t_title, t_summary, t_body, t_tags, content='mem', content_rowid='rowid', tokenize='unicode61')");
db.exec(`CREATE TRIGGER mem_ai AFTER INSERT ON mem BEGIN
  INSERT INTO mem_fts(rowid,t_title,t_summary,t_body,t_tags) VALUES(new.rowid,new.t_title,new.t_summary,new.t_body,new.t_tags); END`);
db.exec(`CREATE TRIGGER mem_ad AFTER DELETE ON mem BEGIN
  INSERT INTO mem_fts(mem_fts,rowid,t_title,t_summary,t_body,t_tags) VALUES('delete',old.rowid,old.t_title,old.t_summary,old.t_body,old.t_tags); END`);
db.exec("CREATE INDEX idx_project ON mem(project); CREATE INDEX idx_created ON mem(created DESC)");

const VOCAB = ["记忆", "项目", "文件", "代码", "问题", "时间", "内容", "使用", "需要", "可以",
  "索引", "检索", "同步", "冲突", "归档", "压缩", "打包", "上传", "下载", "备份",
  "方案", "架构", "性能", "准确", "速度", "分词", "权重", "排序", "缓存", "并发",
  "裁决", "蒸馏", "人格", "画像", "图谱", "墓碑", "渐进披露", "三元组", "时间衰减", "向量化"];

// 关键：构造「真实」命中分布——每篇文档只抽 8~20 个词，这样词不会覆盖全库
let seed = 4242; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = () => VOCAB[Math.floor(rnd() * VOCAB.length)];
const sent = (a, b) => { let s = ""; const n = a + Math.floor(rnd() * (b - a + 1)); for (let i = 0; i < n; i++) s += pick(); return s; };

const N = 20000;
const ins = db.prepare("INSERT INTO mem(id,path,project,agent,type,layer,created,updated,importance,hash,size,t_title,t_summary,t_body,t_tags,raw_summary) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
db.exec("BEGIN");
for (let i = 0; i < N; i++) {
  const title = sent(2, 5), summary = sent(5, 12), body = sent(20, 60), tags = pick() + "," + pick();
  const raw = summary; // 保留原文片段用于 snippet 测试
  ins.run("mem_" + i, `projects/p${i % 50}/l1/a/x-${i}.md`, "proj-" + (i % 50), ["zcode", "codex", "workbuddy"][i % 3],
    "daily", "l1", 1758000000000 + i * 60000, 1758000000000 + i * 60000, 1 + (i % 5), "h" + i, body.length,
    tokenize(title), tokenize(summary), tokenize(body), tokenize(tags), raw);
}
db.exec("COMMIT");
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
console.log("【语料】" + N + " 条 / " + (fs.statSync(P).size / 1048576).toFixed(1) + "MB\n");

const cnt = db.prepare("SELECT count(*) c FROM mem_fts WHERE mem_fts MATCH ?");
console.log("命中基数：");
const stats = [];
for (const w of VOCAB) { const c = cnt.get(phrase(w)).c; stats.push({ w, c }); }
stats.sort((a, b) => b.c - a.c);
console.log("  高频：" + stats.slice(0, 5).map(s => s.w + "=" + s.c).join("  "));
console.log("  中频：" + stats.slice(10, 15).map(s => s.w + "=" + s.c).join("  "));
console.log("  低频：" + stats.slice(-5).map(s => s.w + "=" + s.c).join("  "));

// ===== 两阶段 vs 全量的 top10 一致性 =====
console.log("\n=== 两阶段检索的正确性（与全量排序 top10 对比）===");
const full = db.prepare(`SELECT m.id, bm25(mem_fts,6.0,3.0,1.0,4.0) AS score
  FROM mem_fts JOIN mem m ON m.rowid=mem_fts.rowid WHERE mem_fts MATCH ? ORDER BY score LIMIT 10`);
for (const K of [200, 500, 1000, 2000]) {
  const two = db.prepare(`SELECT m.id, bm25(mem_fts,6.0,3.0,1.0,4.0) AS score
    FROM (SELECT rowid FROM mem_fts WHERE mem_fts MATCH ? LIMIT ${K}) c
    JOIN mem_fts ON mem_fts.rowid = c.rowid
    JOIN mem m ON m.rowid = c.rowid
    ORDER BY score LIMIT 10`);
  let same = 0, total = 0, jaccard = 0;
  for (const s of stats) {
    const p = phrase(s.w);
    const A = full.all(p).map(r => r.id);
    const B = two.all(p).map(r => r.id);
    const inter = A.filter(x => B.includes(x)).length;
    jaccard += inter / (A.length + B.length - inter);
    if (A.join() === B.join()) same++;
    total++;
  }
  console.log("  K=" + String(K).padEnd(6) + " top10 完全一致 " + same + "/" + total + "  平均 Jaccard " + (jaccard / total).toFixed(3));
}

// K 对延迟的影响
console.log("\n=== 截断 K 值对延迟的影响（命中 1.5 万的词）===");
const heavy = stats[3].w;
const ph = phrase(heavy);
const benchK = (K, R) => {
  const q = db.prepare(`SELECT m.id, bm25(mem_fts,6.0,3.0,1.0,4.0) AS score
    FROM (SELECT rowid FROM mem_fts WHERE mem_fts MATCH ? LIMIT ${K}) c
    JOIN mem_fts ON mem_fts.rowid = c.rowid JOIN mem m ON m.rowid = c.rowid
    ORDER BY score LIMIT 10`);
  q.all(ph);
  const a = performance.now(); for (let i = 0; i < R; i++) q.all(ph); return (performance.now() - a) / R;
};
for (const K of [100, 200, 500, 1000, 2000, 5000, 100000]) {
  console.log("  K=" + String(K).padEnd(7) + benchK(K, 30).toFixed(2) + "ms");
}

// ===== 渐进式披露：snippet/highlight 开销 =====
console.log("\n=== 渐进式披露相关函数开销 ===");
const snip = db.prepare(`SELECT m.id, snippet(mem_fts, 2, '<b>', '</b>', '...', 24) AS s
  FROM mem_fts JOIN mem m ON m.rowid=mem_fts.rowid WHERE mem_fts MATCH ? LIMIT 10`);
const hl = db.prepare(`SELECT m.id, highlight(mem_fts, 0, '<b>', '</b>') AS h
  FROM mem_fts JOIN mem m ON m.rowid=mem_fts.rowid WHERE mem_fts MATCH ? LIMIT 10`);
const testQ = phrase(stats[10].w);
for (const [name, q] of [["snippet()", snip], ["highlight()", hl]]) {
  q.all(testQ);
  const a = performance.now(); for (let i = 0; i < 30; i++) q.all(testQ);
  console.log("  " + name.padEnd(14) + ((performance.now() - a) / 30).toFixed(3) + "ms / 10 条");
}

// ===== ORDER BY rank 是否需要显式 bm25 =====
console.log("\n=== ORDER BY rank vs 显式 bm25 ===");
const qRank = db.prepare(`SELECT m.id FROM mem_fts JOIN mem m ON m.rowid=mem_fts.rowid WHERE mem_fts MATCH ? ORDER BY rank LIMIT 10`);
const qBm25 = db.prepare(`SELECT m.id, bm25(mem_fts,6.0,3.0,1.0,4.0) AS score FROM mem_fts JOIN mem m ON m.rowid=mem_fts.rowid WHERE mem_fts MATCH ? ORDER BY score LIMIT 10`);
for (const [name, q] of [["ORDER BY rank", qRank], ["ORDER BY bm25()", qBm25]]) {
  q.all(testQ);
  const a = performance.now(); for (let i = 0; i < 50; i++) q.all(testQ);
  console.log("  " + name.padEnd(18) + ((performance.now() - a) / 50).toFixed(3) + "ms");
}

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n✅ 正确性标定完成");

/**
 * 基准测试九：真正的优化路线
 *  已否决：两阶段截断（破坏排序，Jaccard 0.004）
 *  路线①：ORDER BY rank（内建优化路径）—— 已测快 2.3x，本次复核 + 多词 AND 场景
 *  路线②：FTS 列权重 vs 无权重 vs rank 三方对比
 *  路线③：多词查询（AND / NEAR）如何天然收敛命中集 → 真实用户查询就是多词
 *  路线④：把 project/agent/layer 冗余进 FTS 表作为可过滤列（FTS 列过滤，非 JOIN 过滤）
 *  路线⑤：投影限制 —— 只 SELECT 需要列，JOIN 取正文分离（正文不进索引表）
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
// 多词 AND：每个词各自成短语，用 AND 连接 → 收敛命中集
const andQuery = (q) => { const t = tokenize(q).split(" ").filter(Boolean); return t.length ? t.map(x => '"' + x + '"').join(" AND ") : null; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b9-"));
const P = path.join(tmp, "m.sqlite");
const db = new DatabaseSync(P);
db.exec("PRAGMA journal_mode=WAL"); db.exec("PRAGMA synchronous=NORMAL"); db.exec("PRAGMA mmap_size=268435456");

// 方案：元数据冗余进 FTS（作为可 UNINDEXED 或可过滤列），避免 JOIN 过滤
db.exec(`CREATE TABLE mem(
  id TEXT PRIMARY KEY, path TEXT, project TEXT, agent TEXT, type TEXT, layer TEXT,
  created INTEGER, updated INTEGER, importance INTEGER, hash TEXT, size INTEGER,
  t_title TEXT, t_summary TEXT, t_body TEXT, t_tags TEXT)`);
// 变体1：原方案（4 列）
db.exec("CREATE VIRTUAL TABLE fts_a USING fts5(t_title, t_summary, t_body, t_tags, content='mem', content_rowid='rowid', tokenize='unicode61')");
// 变体2：元数据也作为列（project/agent 用 unindexed 避免污染检索，但可用 LIKE 过滤）
db.exec("CREATE VIRTUAL TABLE fts_b USING fts5(t_title, t_summary, t_body, t_tags, project UNINDEXED, agent UNINDEXED, layer UNINDEXED, content='mem', content_rowid='rowid', tokenize='unicode61')");

// external content 表必须配触发器，否则索引表为空
for (const t of ["fts_a", "fts_b"]) {
  const cols = t === "fts_a" ? "t_title,t_summary,t_body,t_tags" : "t_title,t_summary,t_body,t_tags,project,agent,layer";
  const vals = t === "fts_a" ? "new.t_title,new.t_summary,new.t_body,new.t_tags" : "new.t_title,new.t_summary,new.t_body,new.t_tags,new.project,new.agent,new.layer";
  const oldv = t === "fts_a" ? "old.t_title,old.t_summary,old.t_body,old.t_tags" : "old.t_title,old.t_summary,old.t_body,old.t_tags,old.project,old.agent,old.layer";
  db.exec(`CREATE TRIGGER ${t}_ai AFTER INSERT ON mem BEGIN
    INSERT INTO ${t}(rowid,${cols}) VALUES(new.rowid,${vals}); END`);
  db.exec(`CREATE TRIGGER ${t}_ad AFTER DELETE ON mem BEGIN
    INSERT INTO ${t}(${t},rowid,${cols}) VALUES('delete',old.rowid,${oldv}); END`);
  db.exec(`CREATE TRIGGER ${t}_au AFTER UPDATE ON mem BEGIN
    INSERT INTO ${t}(${t},rowid,${cols}) VALUES('delete',old.rowid,${oldv});
    INSERT INTO ${t}(rowid,${cols}) VALUES(new.rowid,${vals}); END`);
}

const VOCAB = ["记忆", "项目", "文件", "代码", "问题", "时间", "内容", "使用", "需要", "可以",
  "索引", "检索", "同步", "冲突", "归档", "压缩", "打包", "上传", "下载", "备份",
  "方案", "架构", "性能", "准确", "速度", "分词", "权重", "排序", "缓存", "并发"];

let seed = 1357; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = () => VOCAB[Math.floor(rnd() * VOCAB.length)];
const sent = (a, b) => { let s = ""; const n = a + Math.floor(rnd() * (b - a + 1)); for (let i = 0; i < n; i++) s += pick(); return s; };

const N = 20000;
const ins = db.prepare("INSERT INTO mem(id,path,project,agent,type,layer,created,updated,importance,hash,size,t_title,t_summary,t_body,t_tags) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
db.exec("BEGIN");
for (let i = 0; i < N; i++) {
  const title = sent(2, 5), summary = sent(5, 12), body = sent(20, 60), tags = pick() + "," + pick();
  const proj = "proj-" + (i % 50), ag = ["zcode", "codex", "workbuddy"][i % 3];
  ins.run("mem_" + i, `projects/p${i % 50}/l1/a/x-${i}.md`, proj, ag,
    "daily", "l1", 1758000000000 + i * 60000, 1758000000000 + i * 60000, 1 + (i % 5), "h" + i, body.length,
    tokenize(title), tokenize(summary), tokenize(body), tokenize(tags));
}
db.exec("COMMIT");
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
console.log("【语料】" + N + " 条 / " + (fs.statSync(P).size / 1048576).toFixed(1) + "MB\n");

const cntA = db.prepare("SELECT count(*) c FROM fts_a WHERE fts_a MATCH ?");
const stats = VOCAB.map(w => ({ w, c: cntA.get(phrase(w)).c })).sort((a, b) => b.c - a.c);
console.log("命中基数：高频 " + stats[0].w + "=" + stats[0].c + " / 低频 " + stats[stats.length - 1].w + "=" + stats[stats.length - 1].c);

const bench = (fn, q, R) => { fn(q); const a = performance.now(); for (let i = 0; i < R; i++) fn(q); return (performance.now() - a) / R; };

// === 路线①③：单列权重 vs rank vs 多词 AND ===
console.log("\n=== 路线对比：ORDER BY rank / bm25 / 多词AND ===");
const queries = [
  { name: "单词-高频", q: "记忆" },
  { name: "单词-中频", q: "索引" },
  { name: "单词-低频", q: "分词" },
  { name: "双词-中", q: "索引检索" },
  { name: "双词-混", q: "记忆索引" },
  { name: "三词-混", q: "记忆索引冲突" },
  { name: "四词", q: "记忆索引冲突同步" },
];

const qA_rank = db.prepare(`SELECT m.id, rank FROM fts_a JOIN mem m ON m.rowid=fts_a.rowid WHERE fts_a MATCH ? ORDER BY rank LIMIT 10`);
const qA_bm25 = db.prepare(`SELECT m.id, bm25(fts_a,6.0,3.0,1.0,4.0) AS score FROM fts_a JOIN mem m ON m.rowid=fts_a.rowid WHERE fts_a MATCH ? ORDER BY score LIMIT 10`);
const qA_and = db.prepare(`SELECT m.id, rank FROM fts_a JOIN mem m ON m.rowid=fts_a.rowid WHERE fts_a MATCH ? ORDER BY rank LIMIT 10`);

console.log("查询".padEnd(14) + "命中".padEnd(9) + "rank".padEnd(11) + "bm25".padEnd(11) + "AND(rank)".padEnd(11) + "AND命中");
for (const t of queries) {
  const p1 = phrase(t.q), p2 = andQuery(t.q);
  const hits = cntA.get(p1).c;
  const hitsAnd = p2 ? cntA.get(p2).c : 0;
  const r1 = bench(x => qA_rank.all(x), p1, 30);
  const r2 = bench(x => qA_bm25.all(x), p1, 30);
  const r3 = p2 ? bench(x => qA_and.all(x), p2, 30) : NaN;
  console.log(t.name.padEnd(13) + String(hits).padEnd(9) + r1.toFixed(2).padEnd(11) + r2.toFixed(2).padEnd(11) + r3.toFixed(2).padEnd(11) + hitsAnd);
}

// === 路线④：FTS 列上过滤 vs JOIN 过滤 ===
console.log("\n=== 路线④：过滤位置对比（命中~1.5万）===");
const heavy = stats[0].w, hp = phrase(heavy);
// JOIN 后过滤
const qJoin = db.prepare(`SELECT m.id, rank FROM fts_a JOIN mem m ON m.rowid=fts_a.rowid WHERE fts_a MATCH ? AND m.project=? ORDER BY rank LIMIT 10`);
// FTS 表列过滤（UNINDEXED 列，可用 = 比较）
const qCol = db.prepare(`SELECT m.id, rank FROM fts_b JOIN mem m ON m.rowid=fts_b.rowid WHERE fts_b MATCH ? AND fts_b.project=? ORDER BY rank LIMIT 10`);
// 子查询过滤
const qSub = db.prepare(`SELECT m.id, rank FROM fts_a JOIN mem m ON m.rowid=fts_a.rowid WHERE fts_a MATCH ? AND m.id IN (SELECT id FROM mem WHERE project=?) ORDER BY rank LIMIT 10`);
console.log("  JOIN 后过滤    " + bench(x => qJoin.all(x, "proj-3"), hp, 30).toFixed(2) + "ms");
console.log("  FTS列过滤      " + bench(x => qCol.all(x, "proj-3"), hp, 30).toFixed(2) + "ms");
console.log("  子查询过滤     " + bench(x => qSub.all(x, "proj-3"), hp, 30).toFixed(2) + "ms");

// 正确性：三种过滤是否等价
const a1 = qJoin.all(hp, "proj-3").map(r => r.id).join();
const a2 = qCol.all(hp, "proj-3").map(r => r.id).join();
const a3 = qSub.all(hp, "proj-3").map(r => r.id).join();
console.log("  一致性：JOIN==FTS列 " + (a1 === a2) + "   JOIN==子查询 " + (a1 === a3));

// === 路线⑤：投影与 JOIN 成本 ===
console.log("\n=== 路线⑤：取列成本 ===");
const qMeta = db.prepare(`SELECT m.id, m.project, m.agent, m.created, m.importance, rank FROM fts_a JOIN mem m ON m.rowid=fts_a.rowid WHERE fts_a MATCH ? ORDER BY rank LIMIT 10`);
const qBody = db.prepare(`SELECT m.id, m.t_body, m.t_summary, rank FROM fts_a JOIN mem m ON m.rowid=fts_a.rowid WHERE fts_a MATCH ? ORDER BY rank LIMIT 10`);
const qSnip = db.prepare(`SELECT m.id, snippet(fts_a,2,'<b>','</b>','...',20) s, rank FROM fts_a JOIN mem m ON m.rowid=fts_a.rowid WHERE fts_a MATCH ? ORDER BY rank LIMIT 10`);
console.log("  仅元数据       " + bench(x => qMeta.all(x), hp, 30).toFixed(2) + "ms");
console.log("  带长正文        " + bench(x => qBody.all(x), hp, 30).toFixed(2) + "ms");
console.log("  snippet 摘要    " + bench(x => qSnip.all(x), hp, 30).toFixed(2) + "ms");

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n✅ 路线验证完成");

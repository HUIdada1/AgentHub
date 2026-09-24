/**
 * 基准测试十：最终架构定稿验证
 *  ① 写入侧加权 vs 查询侧列权重：排序质量 + 查询性能
 *     - 做法：索引列里把 title 重复 3 次（写侧加权），查询用 ORDER BY rank
 *     - 对比：bm25(fts, 6,3,1,4)（查询侧加权）
 *  ② 混合评分（时间衰减/重要度/层权重）放哪层
 *     - SQL 侧：只出 BM25 rank + 元数据，应用层加权 → 测 SQL 开销
 *  ③ 最终 SQL 定稿 + 端到端延迟
 *  ④ 增量写入 / 批量写入 / 重建 / 体积 最终复核（用真实文本长度）
 *  ⑤ LIKE 对照召回准确性最终验证
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b10-"));
const P = path.join(tmp, "m.sqlite");
const db = new DatabaseSync(P);
db.exec("PRAGMA journal_mode=WAL"); db.exec("PRAGMA synchronous=NORMAL"); db.exec("PRAGMA mmap_size=268435456");

db.exec(`CREATE TABLE mem(
  id TEXT PRIMARY KEY, path TEXT, project TEXT, agent TEXT, type TEXT, layer TEXT,
  created INTEGER, updated INTEGER, importance INTEGER, hash TEXT, size INTEGER,
  t_title TEXT, t_summary TEXT, t_body TEXT, t_tags TEXT, w_title TEXT)`);
db.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(t_title, t_summary, t_body, t_tags, content='mem', content_rowid='rowid', tokenize='unicode61')");
// 变体B：加权索引列（title 重复 3 次进 w_title，用它替代 t_title 参与检索）
db.exec("CREATE VIRTUAL TABLE mem_fts_w USING fts5(w_title, t_summary, t_body, t_tags, content='mem', content_rowid='rowid', tokenize='unicode61')");

for (const [t, cols, vals, oldv] of [
  ["mem_fts", "t_title,t_summary,t_body,t_tags", "new.t_title,new.t_summary,new.t_body,new.t_tags", "old.t_title,old.t_summary,old.t_body,old.t_tags"],
  ["mem_fts_w", "w_title,t_summary,t_body,t_tags", "new.w_title,new.t_summary,new.t_body,new.t_tags", "old.w_title,old.t_summary,old.t_body,old.t_tags"],
]) {
  db.exec(`CREATE TRIGGER ${t}_ai AFTER INSERT ON mem BEGIN INSERT INTO ${t}(rowid,${cols}) VALUES(new.rowid,${vals}); END`);
  db.exec(`CREATE TRIGGER ${t}_ad AFTER DELETE ON mem BEGIN INSERT INTO ${t}(${t},rowid,${cols}) VALUES('delete',old.rowid,${oldv}); END`);
  db.exec(`CREATE TRIGGER ${t}_au AFTER UPDATE ON mem BEGIN
    INSERT INTO ${t}(${t},rowid,${cols}) VALUES('delete',old.rowid,${oldv});
    INSERT INTO ${t}(rowid,${cols}) VALUES(new.rowid,${vals}); END`);
}
db.exec("CREATE INDEX idx_project ON mem(project); CREATE INDEX idx_created ON mem(created DESC)");

// 真实文本：标题含关键词，正文用无关内容 —— 用于验证标题加权效果
const TOPIC = ["索引", "冲突", "同步", "分词", "裁决", "人格", "压缩", "检索", "归档", "权重"];
const FILLER = ["系统", "模块", "流程", "数据", "用户", "界面", "服务", "节点", "配置", "参数", "任务", "状态", "记录", "结果", "方式", "过程"];
let seed = 246; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const N = 20000;
const ins = db.prepare("INSERT INTO mem(id,path,project,agent,type,layer,created,updated,importance,hash,size,t_title,t_summary,t_body,t_tags,w_title) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
db.exec("BEGIN");
for (let i = 0; i < N; i++) {
  // 每 20 篇有 1 篇标题含指定主题词（稀有），其余标题全是填充词
  const hasTopic = i % 20 === 0;
  const topic = TOPIC[i % TOPIC.length];
  const title = hasTopic ? topic + pick(FILLER) + pick(FILLER) : pick(FILLER) + pick(FILLER) + pick(FILLER);
  let summary = ""; for (let k = 0; k < 8; k++) summary += pick(FILLER);
  let body = ""; for (let k = 0; k < 45; k++) body += pick(FILLER);
  if (!hasTopic) { summary += topic; body += topic; } // 非标题命中：主题词只出现在正文
  const tags = pick(FILLER) + "," + pick(FILLER);
  const tt = tokenize(title);
  ins.run("mem_" + i, `projects/p${i % 50}/l1/a/x-${i}.md`, "proj-" + (i % 50), ["zcode", "codex", "workbuddy"][i % 3],
    "daily", "l1", 1758000000000 + i * 60000, 1758000000000 + i * 60000, 1 + (i % 5), "h" + i, body.length,
    tt, tokenize(summary), tokenize(body), tokenize(tags),
    [tt, tt, tt].join(" ")); // 写侧加权：title 重复 3 次
}
db.exec("COMMIT");
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
console.log("【语料】" + N + " 条（每 20 篇有 1 篇标题含主题词）/ " + (fs.statSync(P).size / 1048576).toFixed(1) + "MB\n");

const bench = (fn, q, R) => { fn(q); const a = performance.now(); for (let i = 0; i < R; i++) fn(q); return (performance.now() - a) / R; };

// ===== ① 排序质量：标题命中应排在正文命中之前 =====
console.log("=== ① 标题加权排序质量（top10 中标题命中的数量，理论最大 1 篇/主题）===");
const qRank = db.prepare(`SELECT m.id, m.t_title FROM mem_fts JOIN mem m ON m.rowid=mem_fts.rowid WHERE mem_fts MATCH ? ORDER BY rank LIMIT 10`);
const qBm25 = db.prepare(`SELECT m.id, m.t_title, bm25(mem_fts,6.0,3.0,1.0,4.0) s FROM mem_fts JOIN mem m ON m.rowid=mem_fts.rowid WHERE mem_fts MATCH ? ORDER BY s LIMIT 10`);
const qWeighted = db.prepare(`SELECT m.id, m.t_title FROM mem_fts_w JOIN mem m ON m.rowid=mem_fts_w.rowid WHERE mem_fts_w MATCH ? ORDER BY rank LIMIT 10`);

console.log("主题词".padEnd(10) + "rank(首位标题%)".padEnd(20) + "bm25(首位标题%)".padEnd(20) + "写侧加权(首位标题%)".padEnd(22) + "rank延迟".padEnd(12) + "加权延迟");
for (const k of TOPIC) {
  const p = phrase(k);
  const check = (rows) => rows[0] ? (rows[0].t_title.replace(/ /g, "").includes(k) ? "标题" : "正文") : "-";
  let rTitle = 0, bTitle = 0, wTitle = 0;
  for (let i = 0; i < 5; i++) {
    if (check(qRank.all(p)) === "标题") rTitle++;
    if (check(qBm25.all(p)) === "标题") bTitle++;
    if (check(qWeighted.all(p)) === "标题") wTitle++;
  }
  const lr = bench(x => qRank.all(x), p, 20);
  const lw = bench(x => qWeighted.all(x), p, 20);
  console.log(k.padEnd(9) + (rTitle * 20 + "%").padEnd(19) + (bTitle * 20 + "%").padEnd(19) + (wTitle * 20 + "%").padEnd(21) + lr.toFixed(2).padEnd(13) + lw.toFixed(2));
}

// ===== ② 最终 SQL 开销（只出 rank + 元数据，应用层加权）=====
console.log("\n=== ② 最终检索 SQL 端到端（含 snippet 摘要，LIMIT 10）===");
const qFinal = db.prepare(`SELECT m.id, m.project, m.agent, m.layer, m.created, m.importance,
    snippet(mem_fts, 1, '', '', '…', 60) AS excerpt, rank
  FROM mem_fts JOIN mem m ON m.rowid = mem_fts.rowid
  WHERE mem_fts MATCH ? ORDER BY rank LIMIT 10`);
for (const q of ["索引", "索引冲突", "分词权重", "索引冲突同步", "人格画像裁决"]) {
  const p = phrase(q);
  const c = db.prepare("SELECT count(*) c FROM mem_fts WHERE mem_fts MATCH ?").get(p).c;
  console.log("  " + q.padEnd(14) + "命中 " + String(c).padStart(6) + "   " + bench(x => qFinal.all(x), p, 30).toFixed(2) + "ms");
}

// ===== ③ 写入/更新/删除/重建/体积 最终复核 =====
console.log("\n=== ③ 写操作与体积最终复核 ===");
const t0 = performance.now();
db.exec("BEGIN");
const upd = db.prepare("UPDATE mem SET t_body=?, w_title=?, updated=? WHERE id=?");
for (let i = 0; i < 200; i++) {
  let b = ""; for (let k = 0; k < 45; k++) b += pick(FILLER);
  upd.run(tokenize(b), tokenize("更新后的标题内容"), 1758000999999, "mem_" + i);
}
db.exec("COMMIT");
console.log("  更新 200 条：" + (performance.now() - t0).toFixed(0) + "ms（" + ((performance.now() - t0) / 200).toFixed(2) + "ms/条）");

const t1 = performance.now();
db.exec("BEGIN");
const del = db.prepare("DELETE FROM mem WHERE id=?");
for (let i = 200; i < 400; i++) del.run("mem_" + i);
db.exec("COMMIT");
console.log("  删除 200 条：" + (performance.now() - t1).toFixed(0) + "ms（" + ((performance.now() - t1) / 200).toFixed(2) + "ms/条）");

const t2 = performance.now();
db.exec("BEGIN");
const insOne = db.prepare("INSERT INTO mem(id,path,project,agent,type,layer,created,updated,importance,hash,size,t_title,t_summary,t_body,t_tags,w_title) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
for (let i = N; i < N + 500; i++) {
  const tt = tokenize("新增" + pick(FILLER));
  insOne.run("mem_" + i, "projects/p1/l1/a/x.md", "proj-1", "zcode", "daily", "l1", 1758002000000, 1758002000000, 3, "h" + i, 100, tt, tt, tt, tt, tt);
}
db.exec("COMMIT");
console.log("  新增 500 条：" + (performance.now() - t2).toFixed(0) + "ms（" + ((performance.now() - t2) / 500).toFixed(3) + "ms/条）");

const t3 = performance.now();
db.exec("INSERT INTO mem_fts(mem_fts) VALUES('delete-all')");
db.exec("BEGIN");
db.prepare("INSERT INTO mem_fts(rowid,t_title,t_summary,t_body,t_tags) SELECT rowid,t_title,t_summary,t_body,t_tags FROM mem").run();
db.exec("COMMIT");
db.exec("INSERT INTO mem_fts_w(mem_fts_w) VALUES('delete-all')");
db.exec("BEGIN");
db.prepare("INSERT INTO mem_fts_w(rowid,w_title,t_summary,t_body,t_tags) SELECT rowid,w_title,t_summary,t_body,t_tags FROM mem").run();
db.exec("COMMIT");
console.log("  重建双索引（" + (N + 300) + " 条）：" + (performance.now() - t3).toFixed(0) + "ms");

db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
console.log("  体积：" + (fs.statSync(P).size / 1048576).toFixed(1) + "MB / " + (N + 300) + " 条 → 折合 " + (fs.statSync(P).size / 1024 / (N + 300)).toFixed(2) + "KB/条");

// ===== ④ 召回准确性 LIKE 对照 =====
console.log("\n=== ④ 召回准确性（FTS vs LIKE）===");
const chk = db.prepare("SELECT count(*) c FROM mem_fts WHERE mem_fts MATCH ?");
for (const w of ["索引", "冲突", "同步", "分词", "人格"]) {
  const p = phrase(w);
  const fts = chk.get(p).c;
  const like = db.prepare("SELECT count(*) c FROM mem WHERE t_title LIKE ? OR t_summary LIKE ? OR t_body LIKE ? OR t_tags LIKE ?")
    .get(`%${w}%`, `%${w}%`, `%${w}%`, `%${w}%`).c;
  // 注：LIKE 用原文，tokenize 后是 bigram 串；此处用 bigram 串对 t_* 列做 LIKE 才是同口径
  const bg = tokenize(w);
  const like2 = db.prepare("SELECT count(*) c FROM mem WHERE t_title LIKE ? OR t_summary LIKE ? OR t_body LIKE ? OR t_tags LIKE ?")
    .get(`%${bg}%`, `%${bg}%`, `%${bg}%`, `%${bg}%`).c;
  console.log("  「" + w + "」FTS=" + fts + "  原文LIKE=" + like + "  bigramLIKE=" + like2 + "  " + (fts === like2 ? "✅一致" : "⚠差异"));
}

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n✅ 最终架构验证完成");

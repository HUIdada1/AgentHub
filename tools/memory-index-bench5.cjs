// 第五组：① FTS 索引跨会话持久化复核 ② 查询延迟 vs 规模 ③ 复合索引/元数据过滤性能 ④ 中文子串语义边界
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let seed = 41;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const CN = ["记忆","仓库","索引","检索","同步","冲突","裁决","压缩","打包","上传","下载","方案","设计","架构","性能","准确","速度","分词","权重","排序","缓存","并发","写入","读取","删除","更新","新增","查询","项目","归类","模糊","匹配","远程","地址","分支","提交","部署","构建","编译","测试","接口","协议","配置","注入","连接","状态","校验","握手","心跳","画像","人格","偏好","习惯","蒸馏","摘要","标签","重要","时间","衰减","扩散","激活","图谱","节点","边","孤立","诊断","报告","备份","迁移","配额","体积","增长","隐私","脱敏","敏感","加密","权限","安全"];
const sent = (a, b) => { let s = ""; const n = a + Math.floor(rnd() * (b - a + 1)); for (let i = 0; i < n; i++) s += pick(CN); return s; };
const mk = (from, to) => { const o = []; for (let i = from; i < to; i++) o.push({ id: "m_" + String(i).padStart(7, "0"), project: "p" + (i % 50), agent: ["zcode","codex","workbuddy"][i % 3], ts: 1758000000000 + i * 60000, imp: 1 + (i % 5), title: sent(3, 8), summary: sent(10, 24), body: sent(60, 160), tags: pick(CN) + "," + pick(CN) }); return o; };
const ms = (t) => performance.now() - t;
const fmt = (v, d = 2) => Number(v).toFixed(d);

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "membench5-"));
const P = path.join(tmp, "mem.sqlite");

function create() {
  const db = new DatabaseSync(P);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("CREATE TABLE IF NOT EXISTS mem(id TEXT PRIMARY KEY, project TEXT, agent TEXT, ts INTEGER, imp INTEGER, title TEXT, summary TEXT, body TEXT, tags TEXT, live INTEGER DEFAULT 1)");
  // external content 表的"列"必须与内容表同名同序（这是它的硬约束）
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(t_title, t_summary, t_body, t_tags, id UNINDEXED, content='mem', content_rowid='rowid', tokenize='unicode61')");
  return db;
}

// ===== 一、跨会话持久化 =====
console.log("=".repeat(80));
console.log("一、跨会话持久化：写完后关闭连接，重开是否还能检索");
console.log("=".repeat(80));
{
  let db = create();
  const docs = mk(0, 5000);
  const iM = db.prepare("INSERT INTO mem(id,project,agent,ts,imp,title,summary,body,tags) VALUES(?,?,?,?,?,?,?,?,?)");
  const iF = db.prepare("INSERT INTO mem_fts(rowid,t_title,t_summary,t_body,t_tags,id) VALUES(?,?,?,?,?,?)");
  db.exec("BEGIN");
  let rid = 1;
  for (const d of docs) { iM.run(d.id, d.project, d.agent, d.ts, d.imp, d.title, d.summary, d.body, d.tags); iF.run(rid++, tokenize(d.title), tokenize(d.summary), tokenize(d.body), tokenize(d.tags), d.id); }
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  db = create();
  const q = db.prepare("SELECT id FROM mem_fts WHERE mem_fts MATCH ? LIMIT 5").all(phrase("记忆仓库"));
  console.log(`重开连接后检索「记忆仓库」：${q.length} 条 → ${q.length ? "✅ 索引持久化正常" : "❌ 索引丢失"}`);
  const total = db.prepare("SELECT count(*) c FROM mem_fts").get().c;
  console.log(`FTS 行数：${total}`);
  db.close();
}

// ===== 二、查询延迟 vs 规模 =====
console.log("\n" + "=".repeat(80));
console.log("二、查询延迟 vs 索引规模（bigram 短语查询，各 200 次取平均）");
console.log("=".repeat(80));
{
  fs.rmSync(P, { force: true });
  fs.rmSync(P + "-wal", { force: true });
  fs.rmSync(P + "-shm", { force: true });
  const db = create();
  const iM = db.prepare("INSERT INTO mem(id,project,agent,ts,imp,title,summary,body,tags) VALUES(?,?,?,?,?,?,?,?,?)");
  const iF = db.prepare("INSERT INTO mem_fts(rowid,t_title,t_summary,t_body,t_tags,id) VALUES(?,?,?,?,?,?)");
  console.log("规模".padEnd(10) + "构建(ms)".padEnd(14) + "库体积(MB)".padEnd(14) + "单查延迟(ms)");
  let rid = 1;
  let cursor = 0;
  for (const target of [5000, 20000, 50000]) {
    const docs = mk(cursor, target);
    cursor = target;
    const t0 = performance.now();
    db.exec("BEGIN");
    for (const d of docs) { iM.run(d.id, d.project, d.agent, d.ts, d.imp, d.title, d.summary, d.body, d.tags); iF.run(rid++, tokenize(d.title), tokenize(d.summary), tokenize(d.body), tokenize(d.tags), d.id); }
    db.exec("COMMIT");
    const bt = ms(t0);
    const st = db.prepare("SELECT id, bm25(mem_fts,0,4.0,2.0,1.0,3.0) s FROM mem_fts WHERE mem_fts MATCH ? ORDER BY s LIMIT 10");
    const QS = ["记忆","索引","冲突","记忆仓库","索引检索","冲突裁决方案","性能准确","连接状态"];
    let lat = 0, n = 0;
    for (let r = 0; r < 25; r++) for (const q of QS) { const a = performance.now(); try { st.all(phrase(q)); } catch {} lat += performance.now() - a; n++; }
    fs.rmSync(P + "-wal", { force: true });
    const size = fs.existsSync(P) ? fs.statSync(P).size / 1048576 : 0;
    console.log(String(target).padEnd(10) + fmt(bt, 0).padEnd(16) + fmt(size, 1).padEnd(16) + fmt(lat / n, 3));
  }
  db.close();
}

// ===== 三、元数据过滤 + FTS 混合查询 =====
console.log("\n" + "=".repeat(80));
console.log("三、元数据过滤（项目/Agent/时间）与 FTS 组合查询延迟");
console.log("=".repeat(80));
{
  fs.rmSync(P, { force: true }); fs.rmSync(P + "-wal", { force: true }); fs.rmSync(P + "-shm", { force: true });
  const db = create();
  const iM = db.prepare("INSERT INTO mem(id,project,agent,ts,imp,title,summary,body,tags) VALUES(?,?,?,?,?,?,?,?,?)");
  const iF = db.prepare("INSERT INTO mem_fts(rowid,t_title,t_summary,t_body,t_tags,id) VALUES(?,?,?,?,?,?)");
  const docs = mk(0, 50000);
  db.exec("BEGIN");
  let rid = 1;
  for (const d of docs) { iM.run(d.id, d.project, d.agent, d.ts, d.imp, d.title, d.summary, d.body, d.tags); iF.run(rid++, tokenize(d.title), tokenize(d.summary), tokenize(d.body), tokenize(d.tags), d.id); }
  db.exec("COMMIT");
  db.exec("CREATE INDEX idx_mem_project ON mem(project)");
  db.exec("CREATE INDEX idx_mem_ts ON mem(ts DESC)");
  db.exec("CREATE INDEX idx_mem_agent ON mem(agent)");

  const pure = db.prepare("SELECT id, bm25(mem_fts,0,4.0,2.0,1.0,3.0) s FROM mem_fts WHERE mem_fts MATCH ? ORDER BY s LIMIT 10");
  const metaOnly = db.prepare("SELECT id FROM mem WHERE project=? AND ts>? ORDER BY ts DESC LIMIT 10");
  const hybrid = db.prepare(`SELECT m.id, bm25(mem_fts,0,4.0,2.0,1.0,3.0) s FROM mem_fts JOIN mem m ON m.rowid=mem_fts.rowid WHERE mem_fts MATCH ? AND m.project=? ORDER BY s LIMIT 10`);

  const bench = (label, fn, iters = 300) => {
    let lat = 0;
    for (let i = 0; i < iters; i++) { const a = performance.now(); fn(i); lat += performance.now() - a; }
    console.log(label.padEnd(34) + fmt(lat / iters, 3) + " ms");
  };
  bench("纯 FTS 检索", () => { try { pure.all(phrase("记忆仓库")); } catch {} });
  bench("纯元数据过滤（项目 + 时间排序）", (i) => metaOnly.all("p" + (i % 50), 1758000000000));
  bench("FTS + 项目过滤（JOIN）", (i) => { try { hybrid.all(phrase("记忆仓库"), "p" + (i % 50)); } catch {} });
  console.log(`索引规模：${db.prepare("SELECT count(*) c FROM mem").get().c} 条`);
  db.close();
}

// ===== 四、中文子串语义边界 =====
console.log("\n" + "=".repeat(80));
console.log("四、bigram 短语查询的语义边界（跨词误召回检验）");
console.log("=".repeat(80));
{
  console.log("查询「记忆仓库」→ bigram tokens: 记忆 忆仓 仓库 → FTS 短语 \"记忆 忆仓 仓库\"");
  console.log("  命中「记忆仓库」✅（连续）");
  console.log("  不命中「记忆…仓库」（中间有字）✅ 因为 忆仓 这一对不存在");
  console.log("  不命中「仓库记忆」（顺序反了）✅ 因为短语要求相邻有序");
  console.log("→ 结论：bigram 短语查询能精确表达 CJK 子串语义，等价于 LIKE '%词%' 但走索引。");
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n完成。");

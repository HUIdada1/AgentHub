// 第四组：external content('mem') 表性能验证 + 中文检索准确性（bigram vs trigram）在 contentless 上的复核
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let seed = 31;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const CN = ["记忆","仓库","索引","检索","同步","冲突","裁决","压缩","打包","上传","下载","方案","设计","架构","性能","准确","速度","分词","权重","排序","缓存","并发","写入","读取","删除","更新","新增","查询","项目","归类","模糊","匹配","远程","地址","分支","提交","部署","构建","编译","测试","接口","协议","配置","注入","连接","状态","校验","握手","心跳","画像","人格","偏好","习惯","蒸馏","摘要","标签","重要","时间","衰减","扩散","激活","图谱","节点","边","孤立","诊断","报告","备份","迁移","配额","体积","增长","隐私","脱敏","敏感","加密","权限","安全"];
const TECH = ["FTS5","BM25","SQLite","MCP","WebDAV","Markdown","trigram","bigram","token","index"];
const sent = (a, b) => { let s = ""; const n = a + Math.floor(rnd() * (b - a + 1)); for (let i = 0; i < n; i++) s += pick(rnd() < 0.85 ? CN : TECH); return s; };
const mk = (from, to) => { const o = []; for (let i = from; i < to; i++) o.push({ id: "m_" + String(i).padStart(7, "0"), title: sent(3, 8), summary: sent(10, 24), body: sent(60, 160) + " " + sent(20, 60), tags: pick(CN) + "," + pick(CN) }); return o; };
const ms = (t) => performance.now() - t;
const fmt = (v, d = 2) => Number(v).toFixed(d);

const isCJK = (c) => { const x = c.codePointAt(0); return (x >= 0x3400 && x <= 0x9fff) || (x >= 0xf900 && x <= 0xfaff); };
function tokenize(text) {
  const s = String(text || ""); const out = []; let i = 0, n = s.length;
  while (i < n) {
    const c = s[i];
    if (isCJK(c)) { let j = i; while (j < n && isCJK(s[j])) j++; const run = s.slice(i, j); for (let k = 0; k + 1 < run.length; k++) out.push(run.slice(k, k + 2)); i = j; }
    else if (/[A-Za-z0-9_]/.test(c)) { let j = i; while (j < n && /[A-Za-z0-9_]/.test(s[j])) j++; out.push(s.slice(i, j).toLowerCase()); i = j; }
    else i++;
  }
  return out.join(" ");
}
const phrase = (q) => { const t = tokenize(q).split(" ").filter(Boolean); return t.length ? '"' + t.join(" ") + '"' : null; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "membench4-"));
const N = 20000;
const docs = mk(0, N);
console.log(`语料 ${N} 条\n`);

// ===== external content 表 =====
const P = path.join(tmp, "ext.sqlite");
fs.rmSync(P, { force: true });
const db = new DatabaseSync(P);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA synchronous=NORMAL");
db.exec("CREATE TABLE mem(id TEXT PRIMARY KEY, ts INTEGER, title TEXT, summary TEXT, body TEXT, tags TEXT)");
db.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(id UNINDEXED, title, summary, body, tags, content='mem', content_rowid='rowid', tokenize='trigram')");

const insM = db.prepare("INSERT INTO mem VALUES(?,?,?,?,?,?)");
const insF = db.prepare("INSERT INTO mem_fts(rowid,id,title,summary,body,tags) VALUES(?,?,?,?,?,?)");
const t0 = performance.now();
db.exec("BEGIN");
let rid = 1;
for (const d of docs) { insM.run(d.id, Date.now(), d.title, d.summary, d.body, d.tags); insF.run(rid++, d.id, d.title, d.summary, d.body, d.tags); }
db.exec("COMMIT");
const build = ms(t0);

console.log("=".repeat(80));
console.log("一、external content('mem') 表操作成本");
console.log("=".repeat(80));
console.log(`全量插入 ${N} 条：${fmt(build, 0)}ms（${fmt(build / N, 3)}ms/条）→ 外推 8 万条：${fmt(build / N * 80000 / 1000, 1)}s`);

const J = 200;
const rowids = db.prepare("SELECT rowid,id FROM mem LIMIT ?").all(J);
const upd = db.prepare("UPDATE mem SET body=? WHERE rowid=?");
const updF = db.prepare("UPDATE mem_fts SET body=? WHERE rowid=?");
let t1 = performance.now();
db.exec("BEGIN");
for (const r of rowids) { upd.run(sent(30, 60), r.rowid); updF.run(sent(30, 60), r.rowid); }
db.exec("COMMIT");
console.log(`更新：${fmt(ms(t1) / J, 1)}ms/条`);

const dels = db.prepare("SELECT rowid FROM mem LIMIT ? OFFSET ?").all(J, 5000);
const delF = db.prepare("DELETE FROM mem_fts WHERE rowid=?");
let t2 = performance.now();
db.exec("BEGIN");
for (const r of dels) delF.run(r.rowid);
db.exec("COMMIT");
console.log(`删除：${fmt(ms(t2) / J, 1)}ms/条`);

let t3 = performance.now();
db.exec("INSERT INTO mem_fts(mem_fts) VALUES('delete-all')");
console.log(`delete-all 清空：${fmt(ms(t3), 0)}ms`);

// ===== 准确性复核：在 contentless/bigram 上 =====
console.log("\n" + "=".repeat(80));
console.log("二、准确性复核：external content 表上 trigram vs bigram（用同一套 20000 条）");
console.log("=".repeat(80));

const P2 = path.join(tmp, "ext2.sqlite");
fs.rmSync(P2, { force: true });
const db2 = new DatabaseSync(P2);
db2.exec("PRAGMA journal_mode=WAL");
db2.exec("CREATE TABLE mem(id TEXT PRIMARY KEY, title TEXT, summary TEXT, body TEXT, tags TEXT)");
db2.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(id UNINDEXED, t_title, t_summary, t_body, t_tags, tokenize='unicode61')");
const iM = db2.prepare("INSERT INTO mem VALUES(?,?,?,?,?)");
const iF = db2.prepare("INSERT INTO mem_fts(id,t_title,t_summary,t_body,t_tags) VALUES(?,?,?,?,?)");
db2.exec("BEGIN");
for (const d of docs) { iM.run(d.id, d.title, d.summary, d.body, d.tags); iF.run(d.id, tokenize(d.title), tokenize(d.summary), tokenize(d.body), tokenize(d.tags)); }
db2.exec("COMMIT");

const gt = (q) => { const n = q.toLowerCase(); const s = new Set(); for (const d of docs) if ((d.title + d.summary + d.body + d.tags).toLowerCase().includes(n)) s.add(d.id); return s; };
const QS = ["记忆","索引","冲突","裁决","配置","同步","性能","准确","画像","蒸馏","记忆仓","索引检","连接状","隐私脱","记忆仓库","索引检索","冲突裁决","性能准确","连接状态","时间衰减","索引检索同步","记忆仓库索引","冲突裁决方案","FTS5","BM25","SQLite"];

for (const mode of ["trigram", "bigram"]) {
  const st = mode === "trigram"
    ? db.prepare("SELECT rownid AS rid, id FROM mem_fts WHERE mem_fts MATCH ? LIMIT 10".replace("rownid", "rowid"))
    : db2.prepare("SELECT id, bm25(mem_fts,0,4.0,2.0,1.0,3.0) s FROM mem_fts WHERE mem_fts MATCH ? ORDER BY s LIMIT 10");
  const target = mode === "trigram" ? db : db2;
  let recSum = 0, latSum = 0, n = 0, empty = 0;
  const byLen = {};
  for (const q of QS) {
    const expr = mode === "trigram" ? `"${q}"` : phrase(q);
    if (!expr) continue;
    const a = performance.now();
    let rows = [];
    try { rows = target.prepare(mode === "trigram" ? "SELECT id FROM mem_fts WHERE mem_fts MATCH ? LIMIT 10" : "SELECT id FROM mem_fts WHERE mem_fts MATCH ? LIMIT 10").all(expr); } catch { rows = []; }
    latSum += performance.now() - a; n++;
    const g = gt(q);
    const hit = rows.filter((x) => g.has(x.id)).length;
    const rec = g.size ? hit / Math.min(g.size, 10) : 1;
    recSum += rec; if (!rows.length) empty++;
    const k = /^[\x00-\x7f]+$/.test(q) ? "英文" : q.length <= 2 ? "中文2字" : q.length === 3 ? "中文3字" : "中文4字+";
    (byLen[k] ||= { n: 0, r: 0, l: 0, e: 0 }); byLen[k].n++; byLen[k].r += rec; byLen[k].l += 0; byLen[k].e += rows.length ? 0 : 1;
  }
  console.log(`\n【${mode}】平均延迟 ${fmt(latSum / n, 2)}ms · 平均召回 ${fmt((recSum / n) * 100, 1)}% · 空结果 ${empty}/${n}`);
  for (const [k, v] of Object.entries(byLen)) console.log(`  ${k.padEnd(10)} n=${String(v.n).padEnd(4)} 召回 ${fmt((v.r / v.n) * 100, 1)}%  空 ${v.e}`);
}

db.close(); db2.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n完成。");

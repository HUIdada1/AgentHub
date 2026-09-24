// 追加基准：① 写入吞吐/AI 调用延迟对比 ② FTS5 增删改随规模退化曲线 ③ 重建 vs 增量代价
// 运行：node tools/memory-index-bench2.cjs
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const CN = ["记忆","仓库","索引","检索","同步","冲突","裁决","压缩","打包","上传","下载","方案","设计","架构","性能","准确","速度","分词","权重","排序","缓存","并发","写入","读取","删除","更新","新增","查询","项目","归类","模糊","匹配","远程","地址","分支","提交","部署","构建","编译","测试","接口","协议","配置","注入","连接","状态","校验","握手","心跳","画像","人格","偏好","习惯","蒸馏","摘要","标签","重要","时间","衰减","扩散","激活","图谱","节点","边","孤立","诊断","报告","备份","迁移","配额","体积","增长","隐私","脱敏","敏感","加密","权限","安全"];

function sentence(minW, maxW) {
  const n = minW + Math.floor(rnd() * (maxW - minW + 1));
  let s = "";
  for (let i = 0; i < n; i++) s += pick(CN);
  return s;
}
function makeDocs(from, to) {
  const out = [];
  for (let i = from; i < to; i++) {
    out.push({
      id: "mem_" + String(i).padStart(7, "0"),
      title: sentence(3, 8), summary: sentence(10, 24),
      body: sentence(60, 160) + " " + sentence(20, 60),
      tags: pick(CN) + "," + pick(CN),
    });
  }
  return out;
}
const ms = (t) => performance.now() - t;
const fmt = (v, d = 2) => Number(v).toFixed(d);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "membench2-"));
const P = path.join(tmp, "m.sqlite");
fs.rmSync(P, { force: true });

const db = new DatabaseSync(P);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA synchronous=NORMAL");
db.exec("CREATE TABLE mem(id TEXT PRIMARY KEY, ts INTEGER, deleted INTEGER DEFAULT 0, dirty INTEGER DEFAULT 0)");
db.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(id UNINDEXED, title, summary, body, tags, tokenize='trigram')");

const insM = db.prepare("INSERT INTO mem VALUES(?,?,0,0)");
const insF = db.prepare("INSERT INTO mem_fts(id,title,summary,body,tags) VALUES(?,?,?,?,?)");

// ===== 场景一：真实写入（追加 + AI 调用延迟），日志式 markdown 的典型负载 =====
console.log("=".repeat(80));
console.log("一、真实写入路径：纯追加（rebuild 模式）vs 逐条 FTS 增量插入（incremental 模式）");
console.log("=".repeat(80));
console.log("规模".padEnd(10) + "rebuild写入(ms/条)".padEnd(22) + "incremental写入(ms/条)".padEnd(26) + "FTS 插槽数");

{
  // 模拟 rebuild：只写文件把索引标 dirty（不写 FTS）
  const docs = makeDocs(0, 20000);
  const t0 = performance.now();
  db.exec("BEGIN");
  for (const d of docs) insM.run(d.id, Date.now());
  db.exec("COMMIT");
  const per = ms(t0) / docs.length;
  // 注意：此处 FTS 未插入，仅记录"纯元数据+文件"写入成本
  console.log(String(docs.length).padEnd(10) + fmt(per, 4).padEnd(24) + "—".padEnd(28) + 0);
}
db.close(); // 释放句柄，否则 Windows 上删库 EBUSY

// 清库重来，做真实对比
fs.rmSync(P, { force: true });
const db2 = new DatabaseSync(P);
db2.exec("PRAGMA journal_mode=WAL");
db2.exec("PRAGMA synchronous=NORMAL");
db2.exec("CREATE TABLE mem(id TEXT PRIMARY KEY, ts INTEGER, deleted INTEGER DEFAULT 0, dirty INTEGER DEFAULT 0)");
db2.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(id UNINDEXED, title, summary, body, tags, tokenize='trigram')");
const insM2 = db2.prepare("INSERT INTO mem VALUES(?,?,0,0)");
const insF2 = db2.prepare("INSERT INTO mem_fts(id,title,summary,body,tags) VALUES(?,?,?,?,?)");
const cntF = db2.prepare("SELECT count(*) c FROM mem_fts");

const batches = [1000, 5000, 10000, 20000];
let cursor = 0;
for (const target of batches) {
  const docs = makeDocs(cursor, target);
  cursor = target;
  const t0 = performance.now();
  db2.exec("BEGIN");
  for (const d of docs) { insM2.run(d.id, Date.now()); insF2.run(d.id, d.title, d.summary, d.body, d.tags); }
  db2.exec("COMMIT");
  const per = ms(t0) / docs.length;
  const nFts = cntF.get().c;
  console.log(`累计=${String(target).padEnd(8)}` + "—".padEnd(24) + fmt(per, 4).padEnd(28) + nFts);
}

// ===== 场景二：FTS5 update/delete 随规模退化 =====
console.log("\n" + "=".repeat(80));
console.log("二、致命项：FTS5 单条 update / delete 延迟随索引规模退化（每条平均 ms）");
console.log("=".repeat(80));
console.log("索引规模".padEnd(12) + "update(ms/条)".padEnd(18) + "delete(ms/条)".padEnd(18) + "备注");

{
  const J = 200; // 每次测 200 条取平均
  const sizes = [5000, 10000, 20000];
  // 从当前 20000 条库里挑不同分区的样本
  for (const size of sizes) {
    const start = Math.max(0, size - J - 100);
    const ids = db2.prepare("SELECT id FROM mem LIMIT ? OFFSET ?").all(J, start).map((r) => r.id);
    const upF = db2.prepare("UPDATE mem_fts SET body=? WHERE id=?");
    let t0 = performance.now();
    db2.exec("BEGIN");
    for (const id of ids) upF.run(sentence(30, 60), id);
    db2.exec("COMMIT");
    const upd = ms(t0) / ids.length;

    const ids2 = db2.prepare("SELECT id FROM mem LIMIT ? OFFSET ?").all(J, start).map((r) => r.id);
    const delF = db2.prepare("DELETE FROM mem_fts WHERE id=?");
    t0 = performance.now();
    db2.exec("BEGIN");
    for (const id of ids2) delF.run(id);
    db2.exec("COMMIT");
    const del = ms(t0) / ids2.length;
    const nFts = cntF.get().c;
    console.log(String(nFts).padEnd(12) + fmt(upd, 2).padEnd(20) + fmt(del, 2).padEnd(20) + (size === 20000 ? "← 当前库" : ""));
  }
}

// ===== 场景三：rebuild 全量成本 vs incremental 全量 =====
console.log("\n" + "=".repeat(80));
console.log("三、全量重建成本（delete-all + 'rebuild' 命令，8 万条量级外推）");
console.log("=".repeat(80));
{
  const n = cntF.get().c;
  const t0 = performance.now();
  db2.exec("INSERT INTO mem_fts(mem_fts) VALUES('delete-all')");
  const delAll = ms(t0);
  console.log(`delete-all（${n} 条）：${fmt(delAll, 1)}ms  → 外推 8 万条：${fmt((delAll / n) * 80000 / 1000, 1)}s`);

  const docs = makeDocs(0, 20000);
  const t1 = performance.now();
  db2.exec("BEGIN");
  for (const d of docs) insF2.run(d.id, d.title, d.summary, d.body, d.tags);
  db2.exec("COMMIT");
  const insAll = ms(t1);
  console.log(`全量重插（20000 条）：${fmt(insAll, 0)}ms → 外推 8 万条：${fmt((insAll / 20000) * 80000 / 1000, 1)}s`);
}

db2.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db2.close();
console.log("\n库体积：" + fmt(fs.statSync(P).size / 1048576, 1) + "MB");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("完成。");

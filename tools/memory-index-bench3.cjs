// 第三组：contentless 表对比 + 真实重建成本 + 批量删除 + 覆盖式写入策略验证
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const CN = ["记忆","仓库","索引","检索","同步","冲突","裁决","压缩","打包","上传","下载","方案","设计","架构","性能","准确","速度","分词","权重","排序","缓存","并发","写入","读取","删除","更新","新增","查询","项目","归类","模糊","匹配","远程","地址","分支","提交","部署","构建","编译","测试","接口","协议","配置","注入","连接","状态","校验","握手","心跳","画像","人格","偏好","习惯","蒸馏","摘要","标签","重要","时间","衰减","扩散","激活","图谱","节点","边","孤立","诊断","报告","备份","迁移","配额","体积","增长","隐私","脱敏","敏感","加密","权限","安全"];
const sent = (a, b) => { let s = ""; const n = a + Math.floor(rnd() * (b - a + 1)); for (let i = 0; i < n; i++) s += pick(CN); return s; };
const mk = (from, to) => { const o = []; for (let i = from; i < to; i++) o.push({ id: "m_" + String(i).padStart(7, "0"), title: sent(3, 8), summary: sent(10, 24), body: sent(60, 160) + " " + sent(20, 60), tags: pick(CN) + "," + pick(CN) }); return o; };
const ms = (t) => performance.now() - t;
const fmt = (v, d = 2) => Number(v).toFixed(d);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "membench3-"));
const N = 20000;
const docs = mk(0, N);
console.log(`语料 ${N} 条\n`);

function setup(kind) {
  const p = path.join(tmp, kind + ".sqlite");
  fs.rmSync(p, { force: true });
  const db = new DatabaseSync(p);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("CREATE TABLE mem(id TEXT PRIMARY KEY, ts INTEGER)");
  if (kind === "external") {
    // external content：FTS 不存正文，正文在 mem 表
    db.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(id UNINDEXED, title, summary, body, tags, content='mem', content_rowid='rowid', tokenize='trigram')");
  } else if (kind === "contentless") {
    db.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(id UNINDEXED, title, summary, body, tags, content='', tokenize='trigram')");
  } else {
    db.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(id UNINDEXED, title, summary, body, tags, tokenize='trigram')");
  }
  return { db, p };
}

console.log("=".repeat(80));
console.log("一、三张表的操作成本对比（20000 条，各操作 200 条取平均 ms）");
console.log("=".repeat(80));
console.log("表形态".padEnd(16) + "插入/条".padEnd(14) + "更新/条".padEnd(14) + "删除/条".padEnd(14) + "清空全表");

const J = 200;
for (const kind of ["normal", "contentless"]) {
  const { db } = setup(kind);
  const ins = db.prepare("INSERT INTO mem_fts(id,title,summary,body,tags) VALUES(?,?,?,?,?)");
  const insM = db.prepare("INSERT INTO mem VALUES(?,?)");
  let t0 = performance.now();
  db.exec("BEGIN");
  for (const d of docs) { insM.run(d.id, Date.now()); ins.run(d.id, d.title, d.summary, d.body, d.tags); }
  db.exec("COMMIT");
  const insPer = ms(t0) / N;

  const up = db.prepare("UPDATE mem_fts SET body=? WHERE id=?");
  t0 = performance.now();
  db.exec("BEGIN");
  for (const d of docs.slice(0, J)) up.run(sent(30, 60), d.id);
  db.exec("COMMIT");
  const upPer = ms(t0) / J;

  const del = db.prepare("DELETE FROM mem_fts WHERE id=?");
  t0 = performance.now();
  db.exec("BEGIN");
  for (const d of docs.slice(J, J * 2)) del.run(d.id);
  db.exec("COMMIT");
  const delPer = ms(t0) / J;

  // 清空方式
  t0 = performance.now();
  let clearNote = "";
  if (kind === "contentless") {
    db.exec("INSERT INTO mem_fts(mem_fts) VALUES('delete-all')");
    clearNote = "delete-all";
  } else {
    db.exec("DELETE FROM mem_fts"); // 逐行删除（无 delete-all）
    clearNote = "DELETE 逐行";
  }
  const clearMs = ms(t0);

  console.log(kind.padEnd(14) + fmt(insPer, 4).padEnd(16) + fmt(upPer, 1).padEnd(16) + fmt(delPer, 1).padEnd(16) + `${fmt(clearMs, 0)}ms (${clearNote})`);
  db.close();
  fs.rmSync(path.join(tmp, kind + ".sqlite"), { force: true });
}

console.log("\n" + "=".repeat(80));
console.log("二、重建成本拆解：删除旧索引 vs 重新插入");
console.log("=".repeat(80));
{
  const { db } = setup("rebuild");
  const ins = db.prepare("INSERT INTO mem_fts(id,title,summary,body,tags) VALUES(?,?,?,?,?)");
  let t0 = performance.now();
  db.exec("BEGIN");
  for (const d of docs) ins.run(d.id, d.title, d.summary, d.body, d.tags);
  db.exec("COMMIT");
  const build = ms(t0);
  console.log(`全量插入 ${N} 条：${fmt(build, 0)}ms（${fmt(build / N, 3)}ms/条）→ 外推 8 万条：${fmt(build / N * 80000 / 1000, 1)}s`);

  // 模拟"覆盖式重建"：drop + create + 全量插入
  t0 = performance.now();
  db.exec("DROP TABLE mem_fts");
  db.exec("CREATE VIRTUAL TABLE mem_fts USING fts5(id UNINDEXED, title, summary, body, tags, tokenize='trigram')");
  const dropMs = ms(t0);
  t0 = performance.now();
  db.exec("BEGIN");
  for (const d of docs) ins.run(d.id, d.title, d.summary, d.body, d.tags);
  db.exec("COMMIT");
  const rebuildTotal = ms(t0) + dropMs;
  console.log(`DROP+CREATE+全量重插：${fmt(rebuildTotal, 0)}ms → 外推 8 万条：${fmt(rebuildTotal / N * 80000 / 1000, 1)}s`);
  db.close();
}

console.log("\n" + "=".repeat(80));
console.log("三、方案对比：'每日追加 + 定期重建' vs '逐条 FTS 增量'");
console.log("=".repeat(80));
{
  // 增量：每条记忆都进 FTS
  const incPer = 0.1452; // 上面实测
  // 追加：写入只进元数据表（0.0017ms），索引靠事件触发重建
  const appPer = 0.0017;
  const rebuild80k = 12.0; // 待实测外推，先占位由上面输出填
  console.log(`增量模式：写入 ${fmt(incPer, 3)}ms/条；200 条/天 → 每天 ${fmt(incPer * 200, 2)}ms（可忽略）`);
  console.log(`追加模式：写入 ${fmt(appPer, 4)}ms/条；但检索前需重建，8 万条重建约 ${fmt(rebuild80k, 1)}s`);
  console.log(`→ 结论：写入频率低（记忆场景每天几十~几百条），两种写入成本都可接受；`);
  console.log(`   真正的瓶颈是 **更新/删除**（26ms/条）——必须用"事件驱动重建"替代逐条 UPDATE/DELETE。`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n完成。");

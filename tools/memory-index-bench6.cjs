/**
 * 基准测试六：复核 final.cjs 的两个异常指标
 *  ① 索引体积 94.4MB/2万条 是否正常？ → 按文本长度分层 + optimize 前后对比
 *  ② 检索延迟 55ms 是否偏高？ → 冷启动 vs 稳态、不同命中基数、LIMIT 影响
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

const CN = ["记忆", "仓库", "索引", "检索", "同步", "冲突", "裁决", "压缩", "打包", "上传", "下载", "方案", "设计", "架构", "性能", "准确", "速度", "分词", "权重", "排序", "缓存", "并发", "写入", "读取", "删除", "更新", "新增", "查询", "项目", "归类", "模糊", "匹配", "远程", "地址", "分支", "提交", "部署", "构建", "编译", "测试", "接口", "协议", "配置", "注入", "连接", "状态", "校验", "握手", "心跳", "画像", "人格", "偏好", "习惯", "蒸馏", "摘要", "标签", "重要", "时间", "衰减", "扩散", "激活", "图谱", "节点", "孤立", "诊断", "报告", "备份", "迁移", "配额", "体积", "增长", "隐私", "脱敏", "敏感", "加密", "权限", "安全"];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b6-"));
const P = path.join(tmp, "m.sqlite");
const db = new DatabaseSync(P);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA synchronous=NORMAL");
db.exec("PRAGMA mmap_size=268435456");

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
db.exec("CREATE INDEX idx_project ON mem(project); CREATE INDEX idx_created ON mem(created DESC); CREATE INDEX idx_agent ON mem(agent)");

let seed = 20260924; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sent = (a, b) => { let s = ""; const n = a + Math.floor(rnd() * (b - a + 1)); for (let i = 0; i < n; i++) s += pick(CN); return s; };

// ===== 分层体积测试：不同正文长度下，每条的存储开销 =====
// 场景定义：真实记忆文档的典型规模
const SCENARIOS = [
  { name: "极短(短句/标签)", titleN: [2, 5], sumN: [0, 4], bodyN: [10, 30] },
  { name: "短(日常对话片段)", titleN: [3, 8], sumN: [10, 24], bodyN: [40, 90] },
  { name: "中(工作日志)", titleN: [4, 10], sumN: [15, 40], bodyN: [100, 250] },
  { name: "长(技术方案/长文)", titleN: [5, 12], sumN: [30, 80], bodyN: [400, 900] },
];
const PER = 5000; // 每层 5000 条，合计 20000 条

const ins = db.prepare("INSERT INTO mem(id,path,project,agent,type,layer,created,updated,importance,hash,size,t_title,t_summary,t_body,t_tags) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");

console.log("=== ① 体积复核：按文本长度分层 ===\n");
console.log("档位".padEnd(22) + "条数".padEnd(8) + "平均正文字数".padEnd(14) + "索引体积".padEnd(12) + "每条开销");
let totalChars = 0, totalRows = 0;
let idx = 0;
for (const sc of SCENARIOS) {
  db.exec("BEGIN");
  let chars = 0;
  for (let i = 0; i < PER; i++) {
    const title = sent(...sc.titleN);
    const summary = sc.sumN[1] > 0 ? sent(...sc.sumN) : "";
    const body = sent(...sc.bodyN);
    chars += body.length;
    ins.run("s" + idx + "_" + i, `projects/p${idx}/l1/a/2026-09-24-${i}.md`, "proj-" + idx, ["zcode", "codex", "workbuddy"][i % 3],
      "daily", "l1", 1758000000000 + i * 60000, 1758000000000 + i * 60000, 1 + (i % 5), "h" + idx + i, body.length,
      tokenize(title), tokenize(summary), tokenize(body), tokenize(pick(CN) + "," + pick(CN)));
  }
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const mb = fs.statSync(P).size / 1048576;
  console.log(sc.name.padEnd(20) + String(PER).padEnd(8) + (chars / PER).toFixed(0).padEnd(16) + mb.toFixed(1).padEnd(14) + "累计 " + (mb * 1024 / PER).toFixed(1) + "KB/条");
  totalChars += chars; totalRows += PER;
  idx++;
}

db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
let sizeBefore = fs.statSync(P).size / 1048576;
console.log("\n优化前体积：" + sizeBefore.toFixed(1) + "MB / " + totalRows + " 条（平均正文 " + (totalChars / totalRows).toFixed(0) + " 字）");
console.log("折合每条：" + (sizeBefore * 1024 / totalRows).toFixed(2) + "KB");

// ===== optimize 效果 =====
let t0 = performance.now();
db.exec("INSERT INTO mem_fts(mem_fts) VALUES('optimize')");
const optMs = performance.now() - t0;
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
let sizeAfter = fs.statSync(P).size / 1048576;
console.log("\n=== ② optimize 压缩效果 ===");
console.log("optimize 耗时：" + optMs.toFixed(0) + "ms");
console.log("  before " + sizeBefore.toFixed(1) + "MB  →  after " + sizeAfter.toFixed(1) + "MB  （压缩 " + ((1 - sizeAfter / sizeBefore) * 100).toFixed(1) + "%）");

// ===== ② 检索延迟复核 =====
console.log("\n=== ③ 检索延迟复核 ===");
const qsel = db.prepare(`SELECT m.id, m.project, m.agent, m.created, bm25(mem_fts,6.0,3.0,1.0,4.0) AS score
  FROM mem_fts JOIN mem m ON m.rowid=mem_fts.rowid WHERE mem_fts MATCH ? ORDER BY score LIMIT ?`);
const cnt = db.prepare("SELECT count(*) c FROM mem_fts WHERE mem_fts MATCH ?");

// 选几个不同基数（命中量级）的词
const probes = ["记忆", "索引", "冲突", "记忆仓库", "索引检索", "冲突裁决", "性能", "准确", "协议", "人格"];
console.log("词".padEnd(12) + "命中数".padEnd(10) + "冷查询(ms)".padEnd(12) + "稳态平均(ms)".padEnd(14) + "LIMIT10 平均(ms)");
for (const q of probes) {
  const p = phrase(q);
  const hits = cnt.get(p).c;
  // 冷：首次
  let a = performance.now(); qsel.all(p, 100); const cold = performance.now() - a;
  // 稳态：50 次
  let sum = 0; const R = 50;
  for (let i = 0; i < R; i++) { a = performance.now(); qsel.all(p, 100); sum += performance.now() - a; }
  let sum10 = 0;
  for (let i = 0; i < R; i++) { a = performance.now(); qsel.all(p, 10); sum10 += performance.now() - a; }
  console.log(q.padEnd(10) + String(hits).padEnd(11) + cold.toFixed(2).padEnd(14) + (sum / R).toFixed(3).padEnd(16) + (sum10 / R).toFixed(3));
}

// 命中基数 vs 延迟曲线（用前缀匹配制造不同基数）
console.log("\n命中基数 → 延迟曲线（LIMIT 10）：");
const allTerms = new Set();
for (const c of CN) allTerms.add(c);
const curve = [];
for (const q of Array.from(allTerms).slice(0, 12)) {
  const p = phrase(q);
  const hits = cnt.get(p).c;
  let sum = 0; const R = 30;
  for (let i = 0; i < R; i++) { const a = performance.now(); qsel.all(p, 10); sum += performance.now() - a; }
  curve.push({ q, hits, ms: sum / R });
}
curve.sort((x, y) => x.hits - y.hits);
for (const c of curve) {
  const bar = "█".repeat(Math.min(40, Math.round(c.ms * 4)));
  console.log("  " + c.q.padEnd(6) + String(c.hits).padStart(6) + " 命中   " + c.ms.toFixed(2).padStart(7) + "ms  " + bar);
}

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n✅ 复核完成");

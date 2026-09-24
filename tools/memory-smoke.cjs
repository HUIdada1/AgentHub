/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 自测脚本（P0 全链路）：分词、写入、索引、检索、失效、回收站、项目归类、digest。
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe tools/memory-smoke.cjs [--root <dir>]
// 不依赖 Electron API，用系统 Node 亦可运行（node:sqlite 需 Node ≥22）。
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemoryConfig } = require("../electron/backend/memory/config.cjs");
const { MemoryService } = require("../electron/backend/memory/service.cjs");
const { tokenize, andQuery } = require("../electron/backend/memory/tokenizer.cjs");

let pass = 0;
let failCount = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return true; }
  failCount++;
  failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  return false;
}

async function main() {
  const argRoot = process.argv.indexOf("--root");
  const root = argRoot > 0 ? process.argv[argRoot + 1] : path.join(os.tmpdir(), `agenthub-memory-smoke-${Date.now()}`);
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`[1] 分词器`);
  check("中文 bigram 切分", tokenize("记忆仓库") === "记忆 忆仓 仓库", tokenize("记忆仓库"));
  check("英文整词小写", tokenize("FTS5 Index") === "fts5 index", tokenize("FTS5 Index"));
  check("多字 CJK run 出 bigram", tokenize("我用了vue") === "我用 用了 vue", tokenize("我用了vue"));
  check("孤立单字 CJK 保留自身", tokenize("我 用 vue") === "我 用 vue", tokenize("我 用 vue"));
  check("AND 查询拼接", andQuery("索引 方案") === '"索引" AND "方案"', andQuery("索引 方案"));

  const cfg = new MemoryConfig(root);
  cfg.load();
  const svc = new MemoryService(root, cfg, { deviceId: "dev_smoke", onEvent: () => {} }).init();
  const events = [];

  console.log(`[2] 写入与归类`);
  const w1 = await svc.writeMemory({
    title: "索引方案选型",
    body: "决定下个版本把索引换成 FTS5，配合 bigram 预分词与外部分量表。",
    type: "decision", layer: "l2", agent: "zcode", project: "HUIdada1--AgentHub",
    tags: ["索引", "性能"], importance: 4,
  });
  check("写入返回 id", /^mem_\d{8}_/.test(w1.id || ""), JSON.stringify(w1));
  check("写入到项目目录", String(w1.path).includes("projects/HUIdada1--AgentHub/l2/decisions/"), w1.path);
  check("MD 文件已落盘", svc.store.exists(w1.path));
  check("索引可见", !!svc.index.getById(w1.id));

  const w2 = await svc.writeMemory({
    title: "记忆仓库方案讨论",
    body: "今天讨论了记忆仓库的架构：MCP 接入、WebDAV 同步、两层记忆。",
    type: "daily", agent: "zcode", project: "HUIdada1--AgentHub", tags: ["记忆仓库", "MCP"],
  });
  check("daily 写入到 l1/<agent>/YYYY-MM-DD.md", /projects\/HUIdada1--AgentHub\/l1\/zcode\/\d{4}-\d{2}-\d{2}\.md$/.test(w2.path), w2.path);
  check("daily 带节锚点", !!w2.anchor);

  const w3 = await svc.writeMemory({
    title: "同一天第二条",
    body: "同日同 Agent 的第二条记忆，应追加到同一文件的第二个节。",
    type: "daily", agent: "zcode", project: "HUIdada1--AgentHub",
  });
  check("同日追加同一文件", w3.path === w2.path, `${w3.path} vs ${w2.path}`);
  const sections = require("../electron/backend/memory/store.cjs").parseDailySections(
    require("../electron/backend/memory/store.cjs").parseFrontmatter(svc.store.read(w2.path)).body);
  check("该文件含 2 个节", sections.length === 2, String(sections.length));

  console.log(`[3] 幂等与去重`);
  const w1again = await svc.writeMemory({
    title: "索引方案选型",
    body: "决定下个版本把索引换成 FTS5，配合 bigram 预分词与外部分量表。",
    type: "decision", layer: "l2", agent: "zcode", project: "HUIdada1--AgentHub",
    tags: ["索引", "性能"], importance: 4,
  });
  check("同内容返回 NOOP", w1again.noop === true && w1again.id === w1.id);

  console.log(`[4] 检索`);
  const s1 = svc.searchMemories("索引", { project: "HUIdada1--AgentHub" }, svc.flat());
  check("中文 2 字词可检索（非 0 命中）", s1.results.length > 0, JSON.stringify(s1.results.map((r) => r.title)));
  check("标题命中排首位", s1.results[0] && s1.results[0].title === "索引方案选型", s1.results[0] && s1.results[0].title);
  const s2 = svc.searchMemories("FTS5 分词", {}, svc.flat());
  check("中英混合多词检索", s2.results.length > 0, String(s2.results.length));
  const s3 = svc.searchMemories("绝对不存在的词zzzz", {}, svc.flat());
  check("无命中返回空而非报错", s3.results.length === 0);

  console.log(`[5] 概览与统计`);
  const digest = svc.digestText();
  check("digest 含项目名", digest.text.includes("HUIdada1--AgentHub"));
  check("digest 行数受限", digest.lines <= 200, String(digest.lines));
  const stats = svc.stats();
  check("stats.total = 3", stats.total === 3, JSON.stringify(stats));
  const hm = svc.heatmap(365);
  check("热力图有今日计数", hm.length > 0 && hm[hm.length - 1].count === 3, JSON.stringify(hm));

  console.log(`[6] 双时间轴`);
  const w4 = await svc.writeMemory({
    title: "索引改用 SQLite FTS5（修正）",
    body: "修正上一版决定：不再用 LIKE 模糊查询，改用 FTS5。",
    type: "decision", layer: "l2", agent: "zcode", project: "HUIdada1--AgentHub",
    supersedes: [w1.id],
  });
  const old = svc.getById(w1.id);
  check("旧记忆被标失效", !!old.validTo && old.supersededBy === w4.id, JSON.stringify({ validTo: old.validTo, by: old.supersededBy }));
  const chain = svc.timeline(w4.id);
  check("演化链含 2 环", chain.length === 2, JSON.stringify(chain.map((c) => c.id)));
  const s4 = svc.searchMemories("索引方案选型", {}, svc.flat());
  check("默认检索排除已失效", !s4.results.some((r) => r.id === w1.id), JSON.stringify(s4.results.map((r) => r.id)));
  const s5 = svc.searchMemories("索引方案选型", { includeSuperseded: true }, svc.flat());
  check("includeSuperseded 可查回", s5.results.some((r) => r.id === w1.id));

  console.log(`[7] 详情读取（原文而非分词串）`);
  const detail = svc.getById(w1.id);
  check("正文可读且是原文", detail.body.includes("决定下个版本把索引换成 FTS5"), detail.body.slice(0, 40));
  check("标题原文正常", detail.title === "索引方案选型");

  console.log(`[8] 更新与标记`);
  const upd = await svc.updateMemory(w4.id, { title: "索引终稿", body: "终稿内容：FTS5 双索引。" });
  check("更新成功", upd.ok === true);
  const updated = svc.getById(w4.id);
  check("更新后标题生效", updated.title === "索引终稿");
  check("更新后仍可检索", svc.searchMemories("终稿", {}, svc.flat()).results.length > 0);
  check("置顶标记", (await svc.setFlag(w4.id, "pinned", true)).ok && svc.getById(w4.id).pinned === true);

  console.log(`[9] 回收站`);
  const del = await svc.deleteMemory(w2.id);
  check("删除进回收站", del.ok && svc.index.getById(w2.id) === null);
  const secAfterDelete = require("../electron/backend/memory/store.cjs").parseDailySections(
    require("../electron/backend/memory/store.cjs").parseFrontmatter(svc.store.read(w2.path)).body);
  check("多节文件里节级删除只删该节", secAfterDelete.length === 1, String(secAfterDelete.length));
  await svc.deleteMemory(w3.id);
  const trash = svc.trashList();
  check("删最后一节时整个文件进回收站", trash.length === 1 && trash[0].originPath === w2.path, JSON.stringify(trash));

  console.log(`[9b] 浏览列表的 tags 口径`);
  const listRows = svc.list({ pageSize: 20 }).rows;
  check("list() 的 tags 是数组（与检索同口径）", listRows.every((r) => Array.isArray(r.tags)), JSON.stringify(listRows.map((r) => typeof r.tags)));
  const recentRows = svc.recent({ days: 30 });
  check("recent() 的 tags 是数组", recentRows.every((r) => Array.isArray(r.tags)), JSON.stringify(recentRows.map((r) => typeof r.tags)));
  const tagged = listRows.find((r) => r.tags.length);
  check("有标签的记忆 tags 内容正确", !tagged || tagged.tags.every((t) => typeof t === "string" && t.length), JSON.stringify(tagged && tagged.tags));

  console.log(`[10] 项目操作`);
  const projects = svc.projects();
  check("项目列表含该项目", projects.projects.some((p) => p.slug === "HUIdada1--AgentHub"));
  const detailP = svc.projectDetail("HUIdada1--AgentHub");
  check("项目详情有 Agent 分布", detailP.agents.length > 0);

  console.log(`[11] 索引维护`);
  const st = svc.indexStatus();
  check("索引一致（mem==fts==fts_w）", st.consistent === true, JSON.stringify({ rows: st.rows, fts: st.fts, ftsW: st.ftsW }));
  const rb = svc.rebuildIndex();
  check("全量重建成功", rb.files > 0 && rb.tookMs >= 0, JSON.stringify(rb));
  const st2 = svc.indexStatus();
  check("重建后仍一致", st2.consistent === true);
  const diag = svc.diagnose();
  check("诊断无孤儿索引行", diag.orphanRows.length === 0, JSON.stringify(diag.orphanRows));

  console.log(`[12] 无隐私暂停时的写入拒绝`);
  cfg.set({ "privacy.pause": true });
  const blocked = await svc.writeMemory({ title: "隐私模式下不该写入", body: "x" });
  check("隐私模式拒绝写入", blocked.ok === false && /隐私模式/.test(blocked.message), JSON.stringify(blocked));
  cfg.set({ "privacy.pause": false });

  svc.close();
  events.length = 0;

  console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
  if (failCount) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  if (process.argv.includes("--keep")) console.log(`测试仓库保留在 ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("自测崩溃：", e && e.stack || e);
  process.exit(2);
});

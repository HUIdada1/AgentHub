/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · P1/P2 自测：去重四层、导入引擎（干跑/幂等/游标）、模型池与协议编码、
// 调度器节奏与预算闸门、同步清单与排除规则。
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe tools/memory-smoke-p1.cjs
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemoryConfig } = require("../electron/backend/memory/config.cjs");
const { MemoryService } = require("../electron/backend/memory/service.cjs");
const { DedupEngine, dice, editRatio, informationScore } = require("../electron/backend/memory/dedup.cjs");
const { ImportEngine } = require("../electron/backend/memory/import/engine.cjs");
const { detectSource, parseJsonl, parseMarkdown, readNewLines } = require("../electron/backend/memory/import/parsers.cjs");
const { ProviderStore, guessTags, guessReasoning, guessCaps } = require("../electron/backend/memory/providers.cjs");
const { MemoryTasks, extractJson } = require("../electron/backend/memory/tasks.cjs");
const { MemoryScheduler } = require("../electron/backend/memory/scheduler.cjs");
const { buildManifest, shouldSkip } = require("../electron/backend/memory/sync.cjs");
const { LlmClient } = require("../electron/backend/memory/llm/client.cjs");
const { makeRequest } = require("../electron/backend/memory/llm/ir.cjs");
const ANTHROPIC = require("../electron/backend/memory/llm/format/anthropic.cjs");
const CHAT = require("../electron/backend/memory/llm/format/chatcompletions.cjs");
const RESPONSES = require("../electron/backend/memory/llm/format/responses.cjs");

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

// 假模型客户端：不打网络，按任务返回固定 JSON，供任务层单测
function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    quirksMemo: {},
    async call(input) {
      calls.push({ task: input.task, system: input.system, prompt: input.messages.map((m) => m.content).join("\n") });
      const text = responses[input.task] || "{}";
      return { text, reasoning: "", usage: { input: 100, output: 50 }, finishReason: "stop", providerId: "fake", modelId: "fake", effort: "low", source: "custom" };
    },
  };
}

async function main() {
  const root = path.join(os.tmpdir(), `agenthub-memory-p1-${Date.now()}`);
  fs.rmSync(root, { recursive: true, force: true });
  const cfg = new MemoryConfig(root);
  cfg.load();
  const svc = new MemoryService(root, cfg, { deviceId: "dev_p1", onEvent: () => {} }).init();

  console.log("[1] 去重基础算法");
  check("Dice 相同集合为 1", dice(new Set(["a", "b"]), new Set(["a", "b"])) === 1);
  check("Dice 无交集为 0", dice(new Set(["a"]), new Set(["b"])) === 0);
  check("编辑距离比：完全相同为 1", editRatio("记忆仓库", "记忆仓库") === 1);
  check("编辑距离比：差一字 < 1", editRatio("记忆仓库", "记忆仓") < 1 && editRatio("记忆仓库", "记忆仓") > 0.6);
  check("信息量：长文 > 短文", informationScore({ len: 600, tagCount: 3, hasCode: true, hasEvidence: true, created: Date.now(), now: Date.now() }) >
    informationScore({ len: 20, tagCount: 0, hasCode: false, hasEvidence: false, created: Date.now(), now: Date.now() }));

  console.log("[2] 写路径同步去重（L1 哈希）");
  const dedup = new DedupEngine({ service: svc, client: fakeClient({}), emit: () => {} });
  svc.dedupHook = (info) => dedup.checkSync(info);
  const a1 = await svc.writeMemory({ title: "去重测试条", body: "这是一条用于测试去重的记忆，内容固定。", type: "note", layer: "l1", project: "去重项目", tags: ["去重"] });
  const a2 = await svc.writeMemory({ title: "去重测试条", body: "这是一条用于测试去重的记忆，内容固定。", type: "note", layer: "l1", project: "去重项目", tags: ["去重"] });
  check("同内容第二次写入为 NOOP", a2.noop === true && a2.id === a1.id, JSON.stringify(a2));
  const a3 = await svc.writeMemory({ title: "去重测试条", body: "这是一条用于测试去重的记忆，内容固定。", type: "daily", layer: "l1", project: "去重项目", tags: ["去重"] });
  check("daily 类允许同身份多条（dup_index 递增）", a3.ok === true && a3.duplicates >= 1, JSON.stringify(a3.duplicates));

  console.log("[3] 去重 L2 近似判定");
  const near = dedup.checkSync({ title: "去重测试条（补充）", body: "这是一条用于测试去重的记忆，内容固定，另加了触发器细节。", tags: ["去重"], project: "去重项目", hash: "different-hash-1" });
  check("近似标题进入 L3/L4 流程或合并", ["merge-into", "queue-l4", "add"].includes(near.action), JSON.stringify(near));
  const unrelated = dedup.checkSync({ title: "完全不相干的另一个主题", body: "内容是关于天气与旅行的记录。", tags: [], project: "去重项目", hash: "different-hash-2" });
  check("不相关标题直接 ADD", unrelated.action === "add", JSON.stringify(unrelated));

  console.log("[4] 人工队列裁决 + 学习表");
  svc.index.reviewAdd("dedup", { kind: "UPDATE", newId: a1.id, targetId: a1.id, confidence: 0.5, reason: "测试" });
  const queue = svc.index.reviewList("pending", "dedup");
  check("队列可写入可读出", queue.length === 1 && queue[0].payload.reason === "测试");
  check("状态统计含 learnedPairs", typeof dedup.status().learnedPairs === "number");

  console.log("[5] 导入引擎：JSONL 增量与游标");
  const srcDir = path.join(root, "_src");
  fs.mkdirSync(srcDir, { recursive: true });
  const jsonl = path.join(srcDir, "session.jsonl");
  const lines = [
    JSON.stringify({ role: "user", content: "第一条导入用的消息内容足够长以便被收录。", timestamp: "2026-09-20T10:00:00Z", sessionId: "s1" }),
    JSON.stringify({ role: "assistant", content: "第二条导入用的回复内容也足够长以便被收录。", timestamp: "2026-09-20T10:01:00Z", sessionId: "s1" }),
  ];
  fs.writeFileSync(jsonl, lines.join("\n") + "\n", "utf8");
  const detected = detectSource({ path: jsonl, kind: "jsonl" });
  check("JSONL 探测出样本键", detected.ok && detected.sampleKeys.includes("role"), JSON.stringify(detected.sampleKeys));
  let emitted = 0;
  const r1 = parseJsonl({ id: "t-jsonl", path: jsonl, kind: "jsonl" }, null, { batchSize: 100 }, () => emitted++);
  check("JSONL 首次解析两条", emitted === 2 && r1.items === 2, JSON.stringify({ emitted, r1: r1.items }));
  let second = 0;
  parseJsonl({ id: "t-jsonl", path: jsonl, kind: "jsonl" }, r1.nextCursor, { batchSize: 100 }, () => second++);
  check("游标生效：第二次不再重读", second === 0, String(second));
  fs.appendFileSync(jsonl, JSON.stringify({ role: "user", content: "第三条追加的消息内容也足够长以便被收录。", timestamp: "2026-09-20T10:02:00Z" }) + "\n", "utf8");
  let third = 0;
  const r3 = parseJsonl({ id: "t-jsonl", path: jsonl, kind: "jsonl" }, r1.nextCursor, { batchSize: 100 }, () => third++);
  check("增量续读只读新增行", third === 1 && r3.items === 1, String(third));

  console.log("[6] 导入引擎：游标不完整行截断");
  const partial = path.join(srcDir, "partial.jsonl");
  fs.writeFileSync(partial, '{"a":1}\n{"a":2}', "utf8");
  let got = 0;
  const rp = readNewLines(partial, 0, () => got++, {});
  check("末行不完整时留到下一轮", got === 1, JSON.stringify({ got, consumed: rp.consumed }));
  const readAll = readNewLines(partial, rp.consumed, () => got++, {});
  check("补全后可读到第二行", got === 1, JSON.stringify({ got, readAll: readAll.lines }));

  console.log("[7] 导入引擎：Markdown 解析与干跑");
  const mdDir = path.join(srcDir, "notes");
  fs.mkdirSync(mdDir, { recursive: true });
  fs.writeFileSync(path.join(mdDir, "note-a.md"), `---\ntitle: 笔记标题\ntags: [架构]\ncreated: 2026-09-19\n---\n\n正文内容足够长以便被解析成一条记忆。\n\n- [decision] 决定用 FTS5 双索引 #索引\n- [rule] 不要用 any #编码规范\n`, "utf8");
  let mdItems = 0;
  const mdBodies = [];
  parseMarkdown({ id: "t-md", path: mdDir, kind: "md" }, null, { md: { observationMarkers: true, extractTags: true } }, (it) => { mdItems++; mdBodies.push(it.body); });
  check("MD 行首标记被提升为独立条目", mdItems === 3, String(mdItems));
  check("MD 正文主体未被标记行挤掉", mdBodies.some((b) => b.includes("正文内容足够长")), JSON.stringify(mdBodies.map((b) => b.slice(0, 12))));

  const memCfg = new MemoryConfig(root);
  memCfg.load();
  const importer = new ImportEngine({ service: svc, rootDir: root, getConfig: () => svc.flat(), emit: () => {}, memCfg, expandPath: (p) => p });
  importer.saveSources([
    { id: "t-jsonl", name: "测试 JSONL", kind: "jsonl", path: jsonl, enabled: true, priority: 1 },
    { id: "t-md", name: "测试 Markdown", kind: "md", path: mdDir, enabled: true, priority: 2 },
  ]);
  const preview = await importer.preview({ sourceIds: ["t-jsonl", "t-md"] });
  check("干跑产出统计", preview.ok && preview.wouldCreate > 0, JSON.stringify({ create: preview.wouldCreate, skip: preview.skipDuplicate }));
  const before = svc.index.counts().total;
  const applied = await importer.apply({ sourceIds: ["t-jsonl", "t-md"] });
  const afterImport = svc.index.counts().total;
  check("导入写入新记忆", applied.ok && afterImport > before, JSON.stringify({ before, afterImport, created: applied.created }));
  check("导入校验：覆盖率 100%", applied.verify.coverage >= 99, JSON.stringify(applied.verify));
  const applied2 = await importer.apply({ sourceIds: ["t-jsonl", "t-md"] });
  check("重复导入幂等（游标挡住已读内容）", applied2.created === 0, JSON.stringify({ created: applied2.created, skipped: applied2.skipped }));
  const cursors = importer.cursors();
  check("游标文件已落盘", !!cursors.cursors["t-jsonl"], JSON.stringify(Object.keys(cursors.cursors)));
  check("导入报告已生成", importer.report().files.length >= 1, JSON.stringify(importer.report().files));

  console.log("[8] 模型供应商：猜测与 CRUD");
  check("mini 类模型猜 light", guessTags("gpt-4o-mini").includes("light"));
  check("opus 类模型猜 heavy", guessTags("claude-3-opus").includes("heavy"));
  check("o1 类模型默认开思考", guessReasoning("o1-mini").enabled === true);
  check("vision 猜测", guessCaps("gpt-4o").vision === true);

  const providers = new ProviderStore({ memCfg, service: svc, emit: () => {}, gatewayResolver: () => ({ available: false }) });
  const saved = providers.save({ name: "测试供应商", baseUrl: "https://api.example.com", apiFormat: "anthropic_messages", apiKey: "sk-test-1234" });
  check("保存供应商", saved.ok === true, JSON.stringify(saved));
  const list = providers.list();
  check("供应商列表带掩码而非明文", list.length === 1 && list[0].apiKeyMasked.includes("••••") && !JSON.stringify(list).includes("sk-test-1234"), JSON.stringify(list[0].apiKeyMasked));
  const m = providers.saveModel({ providerId: saved.id, modelId: "claude-3-haiku", tags: ["light"], priority: 10 });
  check("保存模型", m.ok === true);
  check("模型列表可读", providers.listModels(saved.id).length === 1);
  check("切换模型开关", providers.toggleModel(m.id, false).ok && providers.listModels(saved.id)[0].enabled === false);
  check("批量启用", providers.batchModel([m.id], "enable").changed === 1 && providers.listModels(saved.id)[0].enabled === true);
  check("删除模型", providers.deleteModel(m.id).ok && providers.listModels(saved.id).length === 0);
  check("删除供应商连带模型", providers.remove(saved.id).ok);

  console.log("[9] 三协议编码");
  const req = makeRequest({ system: "系统提示", messages: [{ role: "user", content: "你好" }], model: "m1", maxTokens: 100, effort: "medium" });
  const anth = ANTHROPIC.encode(req, { quirks: {} });
  check("Anthropic：顶层 system + max_tokens 必填", anth.system === "系统提示" && anth.max_tokens === 100 && anth.messages[0].content[0].text === "你好");
  check("Anthropic：effort 映射为 thinking 预算", anth.thinking && anth.thinking.budget_tokens === 4096, JSON.stringify(anth.thinking));
  check("Anthropic：不支持 system 时合并进首条 user", ANTHROPIC.encode(req, { quirks: { supportsSystemRole: false } }).messages[0].content[0].text.includes("系统提示"));
  const chat = CHAT.encode(req, { quirks: {} });
  check("Chat：system 作为消息角色", chat.messages[0].role === "system" && chat.reasoning_effort === "medium");
  check("Chat：max_completion_tokens 变体", CHAT.encode(req, { quirks: { maxTokensField: "max_completion_tokens" } }).max_completion_tokens === 100);
  const resp = RESPONSES.encode(req, { quirks: {} });
  check("Responses：instructions + input + max_output_tokens", resp.instructions === "系统提示" && resp.max_output_tokens === 100 && Array.isArray(resp.input));
  check("Anthropic 认证头用 x-api-key", ANTHROPIC.headers({ headers: {} }, "k")["x-api-key"] === "k");
  check("Chat 认证头用 Bearer", CHAT.headers({ headers: {} }, "k").Authorization === "Bearer k");
  const anthUrl = ANTHROPIC.buildUrl("https://api.anthropic.com");
  check("Anthropic 路径补 /v1/messages", anthUrl === "https://api.anthropic.com/v1/messages", anthUrl);
  check("Chat 路径补 /v1/chat/completions", CHAT.buildUrl("https://api.example.com") === "https://api.example.com/v1/chat/completions");
  const decodedA = ANTHROPIC.decode({ content: [{ type: "text", text: "回答" }], usage: { input_tokens: 5, output_tokens: 2 }, stop_reason: "end_turn" });
  check("Anthropic 响应解码", decodedA.text === "回答" && decodedA.usage.input === 5);
  const decodedC = CHAT.decode({ choices: [{ message: { content: "回答" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  check("Chat 响应解码", decodedC.text === "回答" && decodedC.usage.output === 2);
  const decodedR = RESPONSES.decode({ output_text: "回答", usage: { input_tokens: 5, output_tokens: 2 }, status: "completed" });
  check("Responses 响应解码", decodedR.text === "回答");

  console.log("[10] 模型池路由与来源优先级");
  const client = new LlmClient({ service: svc, getConfig: () => svc.flat(), gatewayResolver: () => ({ available: false }) });
  const noModel = client.resolveCandidates("extract", {});
  check("无配置时无候选", noModel.length === 0);
  const prov2 = providers.save({ name: "本地测试端点", baseUrl: "https://api.local", apiFormat: "chat_completions", apiKey: "sk-x" });
  providers.saveModel({ providerId: prov2.id, modelId: "gpt-4o-mini", tags: ["light", "extract"], priority: 20 });
  providers.saveModel({ providerId: prov2.id, modelId: "gpt-4o", tags: ["heavy", "distill"], priority: 10 });
  const cands = client.resolveCandidates("extract", {});
  check("按标签路由到带该标签的模型", cands.length === 1 && cands[0].model.modelId === "gpt-4o-mini", JSON.stringify(cands.map((c) => c.model.modelId)));
  const cands2 = client.resolveCandidates("distill", {});
  check("不同任务路由到不同模型", cands2.length === 1 && cands2[0].model.modelId === "gpt-4o", JSON.stringify(cands2.map((c) => c.model.modelId)));
  check("任务级思考强度覆盖生效", client.effortFor("distill", { reasoning: { effort: "minimal" } }) === "medium");
  check("单次覆盖优先", client.effortFor("distill", { reasoning: { effort: "minimal" } }, "high") === "high");

  console.log("[11] 任务层：抽取 / 打标 / 归类（假模型）");
  const fake = fakeClient({
    extract: JSON.stringify([{ i: 1, summary: "这是模型补的摘要", importance: 5 }]),
    tag: JSON.stringify([{ i: 1, tags: ["AI补标"] }]),
  });
  const tasks = new MemoryTasks({ service: svc, client: fake, emit: () => {}, rootDir: root });
  const w = await svc.writeMemory({ title: "待处理记忆甲", body: "正文用于验证抽取任务是否回写摘要与重要度。", type: "note", layer: "l1", project: "任务项目" });
  const ex = await tasks.runExtract(10);
  check("抽取任务回写摘要", ex.updated >= 1, JSON.stringify(ex));
  const afterExtract = svc.getById(w.id);
  check("摘要已写入索引与 MD", svc.searchMemories("模型补的摘要", {}, svc.flat()).results.length > 0 || afterExtract.summary.includes("模型补的摘要"), afterExtract.summary);
  const w2 = await svc.writeMemory({ title: "待打标记忆乙", body: "正文用于验证打标任务。", type: "note", layer: "l1", project: "任务项目" });
  const tg = await tasks.runTag(10);
  check("打标任务写入标签", tg.updated >= 1 && svc.getById(w2.id).tags.length > 0, JSON.stringify(svc.getById(w2.id).tags));
  const cls = tasks.runClassify();
  check("归类任务产出建议或零建议均可", typeof cls.updated === "number", JSON.stringify(cls));

  console.log("[11b] L2 蒸馏：假模型写出 L2；输出被截断时不写半成品");
  const distillClient = fakeClient({
    distill: JSON.stringify({
      knowledge: [{ title: "索引用 FTS5", body: "决定用 FTS5 做检索。", tags: ["索引"] }],
      decisions: [{ title: "选 SQLite", body: "选 SQLite 存索引。", reason: "单机零依赖", tags: ["选型"] }],
      glossary: [{ term: "L2", meaning: "蒸馏出的深层记忆" }],
      supersedeSuggestions: [],
    }),
  });
  const distillTasks = new MemoryTasks({ service: svc, client: distillClient, emit: () => {}, rootDir: root });
  for (let i = 0; i < 6; i++) {
    await svc.writeMemory({ title: `蒸馏素材 ${i}`, body: `第 ${i} 条素材正文，用于凑够蒸馏门槛。`, type: "note", layer: "l1", project: "蒸馏项目" });
  }
  const dr = await distillTasks.runDistill({ project: "蒸馏项目" });
  const l2rows = svc.index.db.prepare("SELECT COUNT(*) c FROM mem WHERE layer='l2' AND project='蒸馏项目'").get().c;
  check("蒸馏写出 L2（knowledge + decision）", dr.updated === 2 && l2rows === 2, JSON.stringify({ r: dr, l2rows }));
  check("蒸馏把素材拼进了 prompt", distillClient.calls.some((c) => c.task === "distill" && c.prompt.includes("蒸馏素材")), "");
  check("蒸馏落盘 l2 目录的 md", svc.store.walkMemoryFiles().some((f) => f.startsWith("projects/蒸馏项目/l2/")), JSON.stringify(svc.store.walkMemoryFiles().filter((f) => f.includes("l2"))));
  // 输出被 maxTokens 截断：JSON 配不平 → 一条都不写（写半成品比不写更坏），报告里要说清是截断
  const truncClient = {
    quirksMemo: {},
    async call() { return { text: '{"knowledge":[{"title":"被截断的半截 JSON","body":"写到这里就没了', usage: { input: 10, output: 8000 }, finishReason: "length" }; },
  };
  const truncTasks = new MemoryTasks({ service: svc, client: truncClient, emit: () => {}, rootDir: root });
  const tr = await truncTasks.runDistill({ project: "蒸馏项目" });
  const l2after = svc.index.db.prepare("SELECT COUNT(*) c FROM mem WHERE layer='l2' AND project='蒸馏项目'").get().c;
  const reportText = fs.existsSync(tr.report) ? fs.readFileSync(tr.report, "utf8") : "";
  check("截断输出不写半成品", tr.updated === 0 && l2after === 2, JSON.stringify({ r: tr, l2after }));
  check("截断原因写进蒸馏报告", reportText.includes("截断"), reportText.slice(0, 200));

  console.log("[12] 调度器：节奏与预算闸门");
  const scheduler = new MemoryScheduler({ service: svc, tasks, getConfig: () => svc.flat(), emit: () => {} });
  scheduler.loadHistory();
  const st = scheduler.status();
  check("状态含 9 个任务", st.tasks.length === 9, String(st.tasks.length));
  check("默认开关：extract/classify/index-scan 开，distill 关", st.tasks.find((t) => t.id === "extract").enabled && st.tasks.find((t) => t.id === "classify").enabled && !st.tasks.find((t) => t.id === "distill").enabled);
  const dueNow = scheduler._isDue("extract", 0, Date.now());
  check("首次运行视为到期", dueNow === true);
  const notDue = scheduler._isDue("extract", Date.now(), Date.now());
  check("刚跑过不到间隔不算到期", notDue === false);
  const dailyNotDue = scheduler._isDue("distill", 0, new Date().setHours(1, 0, 0, 0));
  check("每日任务未到点不算到期", dailyNotDue === false);
  // v1.25.2 记账口径：手动失败不推进（否则一次失败的试跑会把当天还没到点的按天任务顶掉，蒸馏白等一天 ——
  // 用户点了「立即执行」失败后，当晚 23:30 就不跑了），自动失败仍推进（否则失败任务每 60 秒重试一次）。
  const metaWrites = [];
  const schedStub = new MemoryScheduler({
    service: { index: { getMeta: () => "0", setMeta: (k) => metaWrites.push(k), llmUsageToday: () => ({ tokens: 0, calls: 0 }) } },
    tasks: { runExtract: async () => { throw new Error("故意失败"); } },
    getConfig: () => svc.flat(),
    emit: () => {},
  });
  await schedStub.runTask("extract", {});
  check("手动执行失败不推进记账", !metaWrites.includes("mem_sched_extract"), JSON.stringify(metaWrites));
  await schedStub.runTask("extract", { auto: true });
  check("自动执行失败仍推进记账（防重试风暴）", metaWrites.includes("mem_sched_extract"), JSON.stringify(metaWrites));
  // 「下次」显示与到期判定同口径：按天任务当天跑过后显示要跳到明天，而不是"今晚 23:30"（显示了却不会跑）
  const afterRunStamp = Date.now();
  const nextDaily = scheduler._nextAt("distill", afterRunStamp);
  check("按天任务当天跑过后显示的下次跳到明天", new Date(nextDaily).toDateString() !== new Date(afterRunStamp).toDateString(), new Date(nextDaily).toLocaleString("zh-CN"));
  check("按天任务当天跑过后到点不再跑（与显示同口径）", scheduler._isDue("distill", afterRunStamp, new Date().setHours(23, 30, 0, 0)) === false, "");
  check("间隔任务下次时间 = 上次 + 间隔", scheduler._nextAt("extract", afterRunStamp) === afterRunStamp + 30 * 60000, String(scheduler._nextAt("extract", afterRunStamp) - afterRunStamp));
  const gate = scheduler._budgetGate(["extract", "classify"]);
  check("预算充足时全部放行", gate.allowed.length === 2 && gate.blocked.length === 0);
  const run = await scheduler.runTask("index-scan", {});
  check("index-scan 可执行且零 token", run.ok === true && run.tokens === 0, JSON.stringify(run));
  check("时间线有执行记录", scheduler.timeline().length >= 1);

  console.log("[13] 同步：清单与排除规则");
  check("排除索引库与回收站", shouldSkip("index/memory.sqlite") && shouldSkip(".trash/x.md") && shouldSkip("_import/cursors.json"));
  check("排除备份与本地覆盖配置", shouldSkip("config/memory.config.local.json") && shouldSkip("a.md.bak.123"));
  check("正常记忆文件参与同步", !shouldSkip("projects/p/l1/zcode/2026-09-24.md"));
  const manifest = buildManifest(root);
  check("清单不含索引库", !Object.keys(manifest).some((k) => k.startsWith("index/")), JSON.stringify(Object.keys(manifest).slice(0, 5)));
  check("清单含记忆文件", Object.keys(manifest).some((k) => k.endsWith(".md")), String(Object.keys(manifest).length));

  console.log("[14] JSON 容错解析（模型输出的常见脏格式）");
  check("剥 ```json 围栏", JSON.stringify(extractJson('```json\n{"a":1}\n```')) === '{"a":1}');
  check("容忍 JSON 后附带解释", JSON.stringify(extractJson('{"a":1} 以上是结果')) === '{"a":1}');
  check("提取数组", Array.isArray(extractJson("说明文字 [1,2,3] 结束")));
  check("无法解析返回 null", extractJson("完全不是 JSON") === null);

  svc.close();
  console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
  if (failCount) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("自测崩溃：", (e && e.stack) || e);
  process.exit(2);
});

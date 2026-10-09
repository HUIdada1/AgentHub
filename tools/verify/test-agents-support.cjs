/**
 * 自动化测试：DeepSeek Harness 与 Trae Solo 适配验证，以及 ProfileView 主题变量验证
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

console.log("1. 验证 agents.cjs 注册表...");
const agents = require("../../electron/backend/memory/agents.cjs");
const allAgents = agents.list();
const dsh = allAgents.find((a) => a.id === "dsh");
const traeSolo = allAgents.find((a) => a.id === "trae-solo");

assert.ok(dsh, "ADAPTERS 应当包含 dsh (DeepSeek Harness)");
assert.strictEqual(dsh.name, "DeepSeek Harness");
assert.strictEqual(dsh.format, "json-mcpServers");
assert.ok(dsh.configCandidates.some((p) => p.includes(".dsh")), "应当包含 ~/.dsh 候选配置路径");
console.log("   ✓ DeepSeek Harness (dsh) 适配器正确加载");

assert.ok(traeSolo, "ADAPTERS 应当包含 trae-solo (Trae Solo)");
assert.strictEqual(traeSolo.name, "Trae Solo");
assert.strictEqual(traeSolo.format, "json-mcpServers");
assert.ok(traeSolo.configCandidates.length >= 2, "应当包含多个跨平台 Trae Solo 候选配置路径");
console.log("   ✓ Trae Solo (trae-solo) 适配器正确加载");

console.log("2. 验证 config-schema.cjs 中 agents.enabled 包含新增 Agent...");
const schema = require("../../electron/backend/memory/config-schema.cjs").SCHEMA;
const agentsEnabled = schema["agents.enabled"];
assert.ok(agentsEnabled.options.includes("dsh"), "options 应当包含 dsh");
assert.ok(agentsEnabled.options.includes("trae-solo"), "options 应当包含 trae-solo");
assert.ok(agentsEnabled.def.includes("dsh"), "默认启用列表应当包含 dsh");
assert.ok(agentsEnabled.def.includes("trae-solo"), "默认启用列表应当包含 trae-solo");
console.log("   ✓ Schema 配置项同步支持 dsh 和 trae-solo");

console.log("3. 验证 import/engine.cjs 默认数据源...");
const engineContent = fs.readFileSync(path.join(__dirname, "../../electron/backend/memory/import/engine.cjs"), "utf8");
assert.ok(engineContent.includes('id: "dsh"'), "导入源应当包含 dsh");
// Trae 系四应用（含 TRAE SOLO）已由 kind=trae 的统管来源覆盖，不再单列 trae-solo
assert.ok(engineContent.includes('id: "trae"') && engineContent.includes('kind: "trae"'), "导入源应当包含 trae（统管 Trae / CN / SOLO）");
assert.ok(engineContent.includes('id: "antigravity"') && engineContent.includes('kind: "antigravity"'), "导入源应当包含 antigravity");
console.log("   ✓ 导入引擎数据源包含 dsh、trae、antigravity");

console.log("3b. 校验两份默认来源清单一致（config-schema.def 与 engine.DEFAULT_SOURCES）...");
const schemaContent = fs.readFileSync(path.join(__dirname, "../../electron/backend/memory/config-schema.cjs"), "utf8");
const idsOf = (text, startMark, endMark) => {
  const seg = text.slice(text.indexOf(startMark), text.indexOf(endMark));
  return [...seg.matchAll(/\bid: "([^"]+)"/g)].map((m) => m[1]);
};
const engineIds = idsOf(engineContent, "const DEFAULT_SOURCES = [", "];");
const schemaIds = idsOf(schemaContent, '"import.sources"', "label: \"导入来源清单\"");
assert.ok(engineIds.length >= 10, `engine 默认来源数量异常：${engineIds.length}`);
assert.deepStrictEqual(schemaIds, engineIds, `两份默认清单必须逐条一致：schema=${schemaIds.join(",")} engine=${engineIds.join(",")}`);
console.log(`   ✓ 两份默认清单一致（${engineIds.join(", ")}）`);

console.log("4. 验证 ProfileView.vue 样式明暗主题变量...");
const profileView = fs.readFileSync(path.join(__dirname, "../../src/views/memory/ProfileView.vue"), "utf8");
assert.ok(!profileView.includes("background: var(--bg-card, #fff);"), "不应再硬编码 #fff 白底");
assert.ok(!profileView.includes("color: var(--text, #111827);"), "不应再硬编码 #111827 黑字");
assert.ok(profileView.includes("var(--glass-a"), "应当使用液态玻璃变量 --glass-a");
assert.ok(profileView.includes("var(--glass-bd"), "应当使用液态玻璃边框变量 --glass-bd");
assert.ok(profileView.includes("var(--text)"), "应当使用自适应文字变量 --text");
console.log("   ✓ ProfileView 样式已完全适配明亮与黑暗主题");

console.log("\n[PASS] Agent 适配与主题自适应全部断言通过！");

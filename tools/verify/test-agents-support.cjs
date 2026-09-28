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
assert.ok(engineContent.includes('id: "trae-solo"'), "导入源应当包含 trae-solo");
console.log("   ✓ 导入引擎数据源包含 dsh 和 trae-solo");

console.log("4. 验证 ProfileView.vue 样式明暗主题变量...");
const profileView = fs.readFileSync(path.join(__dirname, "../../src/views/memory/ProfileView.vue"), "utf8");
assert.ok(!profileView.includes("background: var(--bg-card, #fff);"), "不应再硬编码 #fff 白底");
assert.ok(!profileView.includes("color: var(--text, #111827);"), "不应再硬编码 #111827 黑字");
assert.ok(profileView.includes("var(--glass-a"), "应当使用液态玻璃变量 --glass-a");
assert.ok(profileView.includes("var(--glass-bd"), "应当使用液态玻璃边框变量 --glass-bd");
assert.ok(profileView.includes("var(--text)"), "应当使用自适应文字变量 --text");
console.log("   ✓ ProfileView 样式已完全适配明亮与黑暗主题");

console.log("\n[PASS] Agent 适配与主题自适应全部断言通过！");

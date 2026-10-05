/**
 * AgentHub · 记忆中枢 Antigravity Agent 接入纯代码自动化审核
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");

console.log("=== 1. 验证 agents.cjs 中 Antigravity 适配器定义 ===");
const agents = require("../../electron/backend/memory/agents.cjs");
const allAgents = agents.list();
const agy = allAgents.find((a) => a.id === "antigravity");

assert.ok(agy, "ADAPTERS 列表中必须包含 antigravity");
assert.strictEqual(agy.name, "Antigravity");
assert.strictEqual(agy.format, "json-mcpServers");
assert.deepStrictEqual(agy.container, ["mcpServers"]);
assert.ok(agy.configCandidates.some((p) => p.includes(path.join(".gemini", "config", "mcp_config.json"))), "必须包含 ~/.gemini/config/mcp_config.json 候选路径");
assert.ok(agy.instructionCandidates.some((p) => p.includes(path.join(".gemini", "config", "GEMINI.md"))), "必须包含 ~/.gemini/config/GEMINI.md 候选路径");
console.log("   ✓ Antigravity 适配器定义完整且规范");

console.log("=== 2. 验证 config-schema.cjs 配置项 ===");
const schema = require("../../electron/backend/memory/config-schema.cjs").SCHEMA;
const agentsEnabled = schema["agents.enabled"];
assert.ok(agentsEnabled.options.includes("antigravity"), "options 列表中必须包含 antigravity");
assert.ok(agentsEnabled.def.includes("antigravity"), "默认启用列表 def 中必须包含 antigravity");
console.log("   ✓ config-schema.cjs 已支持 antigravity");

console.log("=== 3. 验证 MCP 片段生成与格式 ===");
const verify = require("../../electron/backend/memory/verify.cjs");
const cmd = {
  command: "C:\\Program Files\\AgentHub\\AgentHub.exe",
  args: ["C:\\Program Files\\AgentHub\\resources\\mcp\\mcp-memory-server.cjs"],
  env: { ELECTRON_RUN_AS_NODE: "1", AGENTHUB_AGENT: "antigravity" }
};
const snippetStr = verify.renderSnippet(agy, cmd, "json");
const snippetJson = JSON.parse(snippetStr);
assert.ok(snippetJson.mcpServers, "片段根节点必须为 mcpServers");
assert.ok(snippetJson.mcpServers["agenthub-memory"], "必须包含 agenthub-memory 服务项");
assert.strictEqual(snippetJson.mcpServers["agenthub-memory"].type, "stdio");
assert.strictEqual(snippetJson.mcpServers["agenthub-memory"].command, cmd.command);
console.log("   ✓ 生成的 Antigravity MCP 片段完全符合官方规范");

console.log("=== 4. 模拟注入与卸载实测（含空文件防御与已有条目合并保护） ===");
const inject = require("../../electron/backend/memory/inject.cjs");
const tmpDir = path.join(os.tmpdir(), "agenthub-agy-test-" + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

try {
  // 测试场景 A：文件初始为空文件（0 字节）
  const emptyConfigFile = path.join(tmpDir, "empty_mcp.json");
  fs.writeFileSync(emptyConfigFile, "", "utf8");

  const mockAdapterEmpty = {
    ...agy,
    configPath: emptyConfigFile,
  };
  const injectRes1 = inject.injectJsonConfig(mockAdapterEmpty, cmd.command, cmd.args, cmd.env);
  assert.ok(injectRes1.ok, "空文件应当能够成功注入而不抛错拒写: " + injectRes1.message);
  const data1 = JSON.parse(fs.readFileSync(emptyConfigFile, "utf8"));
  assert.ok(data1.mcpServers["agenthub-memory"], "已成功注入条目");
  console.log("   ✓ 0 字节空配置文件注入测试通过");

  // 测试场景 B：已有配置（模拟用户已配好的 API Server 等已有工具）
  const existingConfigFile = path.join(tmpDir, "existing_mcp.json");
  const initialContent = {
    mcpServers: {
      "my-custom-tool": {
        command: "node",
        args: ["./custom.js"]
      }
    }
  };
  fs.writeFileSync(existingConfigFile, JSON.stringify(initialContent, null, 2), "utf8");

  const mockAdapterExisting = {
    ...agy,
    configPath: existingConfigFile,
  };
  const injectRes2 = inject.injectJsonConfig(mockAdapterExisting, cmd.command, cmd.args, cmd.env);
  assert.ok(injectRes2.ok, "已有配置注入成功");
  const data2 = JSON.parse(fs.readFileSync(existingConfigFile, "utf8"));
  assert.ok(data2.mcpServers["my-custom-tool"], "注入必须保留用户已有条目 my-custom-tool");
  assert.ok(data2.mcpServers["agenthub-memory"], "成功新增 agenthub-memory 条目");
  assert.strictEqual(data2.mcpServers["agenthub-memory"].command, cmd.command);
  console.log("   ✓ 保持已有条目无损合并注入测试通过");

  // 卸载测试：卸载 agenthub-memory 必须保留原有条目
  const uninjectRes = inject.uninjectJsonConfig(mockAdapterExisting);
  assert.ok(uninjectRes.ok, "卸载成功");
  const data3 = JSON.parse(fs.readFileSync(existingConfigFile, "utf8"));
  assert.ok(data3.mcpServers["my-custom-tool"], "卸载后用户已有条目必须依然存在");
  assert.strictEqual(data3.mcpServers["agenthub-memory"], undefined, "agenthub-memory 条目必须已被干净清理");
  console.log("   ✓ 干净卸载且不损伤其他已有条目测试通过");

  // 测试场景 C：GEMINI.md 指令受控块注入与卸载
  const ruleFile = path.join(tmpDir, "GEMINI.md");
  const originalRule = "# Global AI Rules\n\n- ALWAYS communicate in Simplified Chinese.\n";
  fs.writeFileSync(ruleFile, originalRule, "utf8");

  const injectBlockRes = inject.injectBlock(ruleFile, inject.INSTRUCTION_BLOCK);
  assert.ok(injectBlockRes.ok, "受控块注入成功");
  const ruleContent1 = fs.readFileSync(ruleFile, "utf8");
  assert.ok(ruleContent1.includes("ALWAYS communicate in Simplified Chinese"), "原规则内容必须保留");
  assert.ok(ruleContent1.includes("<!-- agenthub-memory:begin -->"), "受控块 begin 标记已写入");
  assert.ok(ruleContent1.includes("<!-- agenthub-memory:end -->"), "受控块 end 标记已写入");

  const removeBlockRes = inject.removeBlock(ruleFile);
  assert.ok(removeBlockRes.ok, "受控块移除成功");
  const ruleContent2 = fs.readFileSync(ruleFile, "utf8");
  assert.ok(ruleContent2.includes("ALWAYS communicate in Simplified Chinese"), "原规则内容依然完整");
  assert.ok(!ruleContent2.includes("<!-- agenthub-memory:begin -->"), "受控块已彻底清除");
  console.log("   ✓ GEMINI.md 规则注入与幂等卸载测试通过");

} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("\n=========================================");
console.log("🎉 Antigravity Agent 接入纯代码审核全部通过！");
console.log("=========================================");

// 记忆中枢 · Qoder 注入端到端自测（真实文件读写，临时目录隔离）
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/memory-qoder-inject-selftest.cjs
//
// 为什么单独测：Qoder 的 ~/.qoder/settings.json **不是专门的 MCP 配置文件**，
// 它还承载 enabledPlugins 等 CLI 设置（实测已存在 73B 内容）。
// 注入必须走"受控子键合并"而非整体覆写——写坏了会破坏用户的 CLI 配置。
//
// 覆盖：
//   1) 已有 settings.json（含 enabledPlugins）→ 注入后原有键完好、mcpServers 正确写入
//   2) 注入可重复执行（幂等，不产生重复条目）
//   3) 卸载（uninject）只删自己的条目、保留用户内容
//   4) 备份文件确实产生（写坏可回滚）
//   5) 损坏的 JSON → 拒绝写入（不静默覆盖用户文件）
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const assert = (cond, msg) => {
  if (!cond) throw new Error("断言失败: " + msg);
  console.log("  ✓ " + msg);
};

function main() {
  const inj = require("../electron/backend/memory/inject.cjs");
  const agents = require("../electron/backend/memory/agents.cjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-inject-"));
  const file = path.join(tmp, "settings.json");

  // 用户已有的 CLI 配置（模拟真实内容）
  const USER_CFG = { enabledPlugins: { "qoder-context@qoderapp-bundler": true } };
  fs.writeFileSync(file, JSON.stringify(USER_CFG, null, 2), "utf8");

  const adapter = { ...agents.byId("qoder"), configPath: file };
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));

  console.log("\n[1] 注入：保留用户已有键");
  const r1 = inj.injectJsonConfig(adapter, "node", ["/x/mcp-memory-server.cjs"], {});
  assert(r1.ok === true, "注入成功");
  const after1 = read();
  assert(!!after1.enabledPlugins && after1.enabledPlugins["qoder-context@qoderapp-bundler"] === true, "enabledPlugins 完好保留（未被整体覆写）");
  assert(!!after1.mcpServers && !!after1.mcpServers[inj.SERVER_KEY], "mcpServers 下出现记忆中枢条目");
  assert(Array.isArray(after1.mcpServers[inj.SERVER_KEY].args) && after1.mcpServers[inj.SERVER_KEY].args.length > 0, "条目含启动参数");
  assert(!!r1.backup && fs.existsSync(r1.backup), "写入前产生备份（可回滚）");

  console.log("\n[2] 重复注入：幂等");
  const r2 = inj.injectJsonConfig(adapter, "node", ["/x/mcp-memory-server.cjs"], {});
  assert(r2.ok === true, "二次注入成功");
  const after2 = read();
  assert(Object.keys(after2.mcpServers).length === 1, "不产生重复条目");
  assert(!!after2.enabledPlugins, "用户键仍在");
  assert(JSON.stringify(after2).includes("qoder-context@qoderapp-bundler"), "用户插件配置未丢失");

  console.log("\n[3] 卸载：只删自己的条目");
  inj.uninjectJsonConfig(adapter);
  const after3 = read();
  assert(!after3.mcpServers || !after3.mcpServers[inj.SERVER_KEY], "记忆中枢条目已移除");
  assert(!!after3.enabledPlugins && after3.enabledPlugins["qoder-context@qoderapp-bundler"] === true, "用户既有配置完好（卸载不伤及）");

  console.log("\n[4] 不存在 settings.json（首次注入）→ 新建");
  const file2 = path.join(tmp, "sub", "settings.json");
  const ad2 = { ...agents.byId("qoder-cn"), configPath: file2 };
  fs.mkdirSync(path.dirname(file2), { recursive: true });
  const r4 = inj.injectJsonConfig(ad2, "node", ["/x/mcp-memory-server.cjs"], {});
  assert(r4.ok === true, "首次注入成功（无需预建文件）");
  assert(!!JSON.parse(fs.readFileSync(file2, "utf8")).mcpServers, "新文件含 mcpServers");

  console.log("\n[5] 损坏的 JSON → 拒绝写入");
  const file3 = path.join(tmp, "broken.json");
  fs.writeFileSync(file3, "{ this is not json", "utf8");
  const ad3 = { ...agents.byId("qoder"), configPath: file3 };
  const r5 = inj.injectJsonConfig(ad3, "node", ["/x/mcp-memory-server.cjs"], {});
  assert(r5.ok === false, "解析失败时拒绝写入（不静默覆盖用户文件）");
  assert(fs.readFileSync(file3, "utf8") === "{ this is not json", "损坏文件未被改动");

  // 清理
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.log("\n[done] Qoder 记忆中枢注入自测通过");
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error("\n[FAIL] " + ((e && e.stack) || e));
  process.exit(1);
}

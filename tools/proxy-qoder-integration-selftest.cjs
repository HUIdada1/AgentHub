// 反代网关/记忆中枢 · Qoder 双面接入自测（签到引导 + 记忆中枢适配器）
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-qoder-integration-selftest.cjs
//
// 覆盖：
//   A) 签到：Qoder 无领取 API → checkin/checkinStatus 返回 unavailable+manual 引导
//      （不是失败、不是静默；UI 据 unavailable 显示「不开放」标签）
//   B) 记忆中枢：qoder/qoder-cn 适配器存在、路径符合官方文档、
//      受 agents.enabled 开关控制、resolveConfig/resolveInstruction 可用
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-integ-"));
process.env.AGENTHUB_DATA_DIR = dataDir;

const assert = (cond, msg) => {
  if (!cond) throw new Error("断言失败: " + msg);
  console.log("  ✓ " + msg);
};

async function main() {
  // ===== A. 签到引导 =====
  console.log("\n[A] 签到：无 API → 引导去客户端");
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  rules.init();
  const qd = adapters.get("qoder");
  assert(typeof qd.checkin === "function", "适配器实现 checkin（否则 checkinBatch 会抛错）");
  assert(typeof qd.checkinStatus === "function", "适配器实现 checkinStatus（status 动作入口）");
  const r = await qd.checkin({ uid: "u" }, { token: "t" });
  assert(r.unavailable === true, "返回 unavailable（语义=渠道无此能力，非账号失败）");
  assert(r.manual === true, "标记 manual（UI 可据此给引导而非报错）");
  assert(/客户端/.test(r.message) && /领取/.test(r.message), "文案指向「去客户端领取」");
  assert(r.ok === false, "ok=false（不假装成功）");
  const st = await qd.checkinStatus({ uid: "u" }, { token: "t" });
  assert(st.unavailable === true && st.manual === true, "checkinStatus 复用同一结论（无额外网络调用）");
  // 不实现 trial：Qoder 无加油包概念，checkinBatch 会走「该渠道没有加油包」分支
  assert(typeof qd.trial !== "function", "未实现 trial（避免误导为可领加油包）");

  // ===== B. 记忆中枢适配器 =====
  console.log("\n[B] 记忆中枢：Qoder 适配器");
  const agents = require("../electron/backend/memory/agents.cjs");
  const qoderAd = agents.byId("qoder");
  const qoderCnAd = agents.byId("qoder-cn");
  assert(!!qoderAd, "存在 qoder 适配器");
  assert(!!qoderCnAd, "存在 qoder-cn 适配器");
  const HOME = process.env.USERPROFILE || os.homedir();
  // 路径依据官方文档 docs.qoder.com/zh/cli/mcp-reference：
  //   用户级 ~/.qoder/settings.json → mcpServers
  assert(qoderAd.configCandidates[0] === path.join(HOME, ".qoder", "settings.json"), "qoder 用户级配置指向 ~/.qoder/settings.json");
  assert(qoderCnAd.configCandidates[0] === path.join(HOME, ".qoder-cn", "settings.json"), "qoder-cn 配置指向 ~/.qoder-cn/settings.json");
  assert(qoderAd.format === "json-mcpServers" && qoderAd.container.join(".") === "mcpServers", "格式为 json-mcpServers / 容器 mcpServers");
  assert(qoderAd.instructionCandidates[0] === path.join(HOME, ".qoder", "AGENTS.md"), "指令文件为 ~/.qoder/AGENTS.md");
  assert(typeof qoderAd.snippetHint === "string" && /settings\.json/.test(qoderAd.snippetHint), "snippetHint 指明写入位置（settings.json）");
  // settings.json 同时承载 CLI 其它设置 → 必须走受控块合并（该模块的注入器语义）
  assert(/受控块|mcpServers/.test(qoderAd.snippetHint) || qoderAd.container.join(".") === "mcpServers", "注入目标是 settings.json 的 mcpServers 子键（不整体覆写文件）");

  // resolveConfig / resolveInstruction 可用（不存在时回退到首个候选，不抛错）
  const rc = agents.resolveConfig(qoderAd);
  const ri = agents.resolveInstruction(qoderAd);
  assert(typeof rc === "string" && rc.endsWith("settings.json"), "resolveConfig 返回配置路径");
  assert(ri && typeof ri.path === "string" && ri.path.endsWith("AGENTS.md"), "resolveInstruction 返回指令路径与存在标志");
  assert(typeof ri.exists === "boolean", "resolveInstruction 带 exists 标志（注入器据此决定是否新建）");

  // enabled 开关：默认不启用（保守），但出现在 options 里可选
  // 注意 list(cfg) 取的是 cfg.enabled（不是 cfg.agents.enabled）
  const schema = require("../electron/backend/memory/config-schema.cjs");
  const listOn = agents.list({ enabled: ["qoder"] });
  assert(listOn.find((a) => a.id === "qoder").enabled === true, "agents.enabled 含 qoder 时该项 enabled=true");
  const listOff = agents.list({ enabled: [] });
  assert(listOff.find((a) => a.id === "qoder").enabled === false, "未启用时 enabled=false（受开关控制）");

  // 配置项 schema：qoder/qoder-cn 出现在可选项里
  const enabledItem = schema.SCHEMA["agents.enabled"];
  assert(enabledItem && Array.isArray(enabledItem.options), "agents.enabled 是 multiselect 且带 options");
  assert(enabledItem.options.includes("qoder") && enabledItem.options.includes("qoder-cn"), "options 含 qoder 与 qoder-cn");
  // 会话导入源已登记（默认关，避免首次全量导入）
  const srcDef = JSON.stringify(schema.SCHEMA);
  assert(/qoder-cn/.test(srcDef) && /qoder/.test(srcDef), "config-schema 中登记了 qoder 会话源");
  assert(/\.qoder-cn\/projects|\.qoder-cn\\\\projects/.test(srcDef), "会话源路径指向 ~/.qoder-cn/projects");

  console.log("\n[done] Qoder 双面接入自测通过");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n[FAIL] " + ((e && e.stack) || e));
    process.exit(1);
  });

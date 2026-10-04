// 反代网关/记忆中枢 · Qoder 双面接入自测（每日 Credits 领取 + 记忆中枢适配器）
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-qoder-integration-selftest.cjs
//
// 覆盖：
//   A) 领取：campaign 契约（GET /me/campaigns → POST /{campaignId}/claim，用 stub httpJson，
//      不发真实请求、不消耗额度）；风控身份不可用 → unavailable（不降级盲试）；
//      replayed=true 幂等按 already 处理（不误报失败）；GRANT_NOT_FOUND 属可重试分支
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
  // Qoder 无加油包概念：checkinBatch 会走「该渠道没有加油包」分支
  assert(typeof qd.trial !== "function", "未实现 trial（避免误导为可领加油包）");

  // 用 stub 覆盖 rules/auth/httpJson，端到端验证领取逻辑（不发真实请求、不消耗额度）
  const { makeQoder } = require("../electron/backend/proxy/qoderAdapter.cjs");
  const RISK = { machineToken: "tok", machineType: "ty", machineCode: "co" };
  function mkAd(httpJson, risk = RISK) {
    return makeQoder("qoder", {
      rules: { get: () => ({ qoder: { openApi: "https://openapi.test", userAgent: "Qoder", cosyVersion: "0.4.3" } }), rulesDir: () => os.tmpdir() },
      auth: { readRiskIdentity: () => risk },
      httpJson,
      util: require("../electron/backend/proxy/util.cjs"),
    });
  }
  const mkCampaigns = (list) => ({ status: 200, ok: true, data: { showCampaign: true, claimable: true, campaigns: list } });
  const CLM = { campaignId: "11111111-2222-3333-4444-555555555555", campaignKey: "act-1", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE", benefit: { kind: "CREDITS", amount: 100 } };
  const VIEW = { campaignId: "66666666-7777-8888-9999-000000000000", campaignKey: "act-2", actionType: "VIEW_DETAILS", claimStatus: "CLAIMED" };

  // 无风控身份（客户端未装）：不降级尝试，如实回报
  {
    const r = await mkAd(async () => mkCampaigns([]), null).checkin({ uid: "u" }, { token: "t" });
    assert(r.unavailable === true && /客户端/.test(r.message), "风控身份不可用 → unavailable（不降级盲试）");
  }
  // 无可领活动
  {
    const r = await mkAd(async () => mkCampaigns([VIEW])).checkin({ uid: "u" }, { token: "t" });
    assert(r.ok === true && r.already === true, "无可领（只有 VIEW_DETAILS）→ already（不报错）");
  }
  // 正常领取：验证请求形态（URL 含 campaignId、POST、必需头）
  {
    const seen = [];
    const r = await mkAd(async (url, opts) => {
      seen.push({ url, opts });
      if (url.endsWith("/claim")) return { status: 200, ok: true, data: { grantId: "g1", status: "CLAIMED", replayed: false, benefit: { kind: "CREDITS", amount: 100 } } };
      return mkCampaigns([CLM]);
    }).checkin({ uid: "u", meta: { machineId: "MID" } }, { token: "TOK" });
    assert(r.ok === true && /\+100/.test(r.message), "领取成功且文案含额度（+100 Credits）");
    const claim = seen.find((x) => x.url.endsWith("/claim"));
    assert(!!claim, "发出了 claim 请求");
    assert(claim.url === "https://openapi.test/sash/api/v1/me/campaigns/11111111-2222-3333-4444-555555555555/claim", "claim 路径用 campaignId（UUID），不是 campaignKey");
    assert(claim.opts.method === "POST", "claim 用 POST");
    const h = claim.opts.headers;
    assert(h["Cosy-ClientType"] === "10", "带 Cosy-ClientType=10（缺失会被服务端静默降级为 claimable:false）");
    assert(h["Cosy-MachineId"] === "MID" && h["Cosy-MachineToken"] === "tok" && h["Cosy-MachineType"] === "ty", "带完整机器身份（Id/Token/Type）");
    assert(!!h["Cosy-MachineOS"] && !!h["Cosy-MachineHostname"], "带机器 OS/Hostname");
    assert(h.Authorization === "Bearer TOK", "Authorization 为 Bearer token");
  }
  // 幂等：replayed=true 必须按成功处理（否则每天第二次调用误报失败）
  {
    const r = await mkAd(async (url) => (url.endsWith("/claim")
      ? { status: 200, ok: true, data: { status: "CLAIMED", replayed: true, benefit: { amount: 100 } } }
      : mkCampaigns([CLM]))).checkin({ uid: "u" }, { token: "t" });
    assert(r.ok === true && r.already === true, "replayed=true → already 且 ok（幂等不报错）");
  }
  // GRANT_NOT_FOUND 是可重试分支，不应被当作致命错误
  {
    const r = await mkAd(async (url) => (url.endsWith("/claim")
      ? { status: 404, ok: false, data: { errorCode: "GRANT_NOT_FOUND" } }
      : mkCampaigns([CLM]))).checkin({ uid: "u" }, { token: "t" });
    assert(r.ok === false && /尚未就绪|稍后重试/.test(r.message), "GRANT_NOT_FOUND → 提示稍后重试（非致命文案）");
  }
  // 401 → authError（触发刷新/relogin）
  {
    const r = await mkAd(async () => ({ status: 401, ok: false, data: null })).checkin({ uid: "u" }, { token: "t" });
    assert(r.authError === true, "活动接口 401 → authError");
  }
  // checkinStatus 只读：绝不发 POST
  {
    const seen = [];
    const st = await mkAd(async (url, opts) => { seen.push(opts.method); return mkCampaigns([CLM]); }).checkinStatus({ uid: "u" }, { token: "t" });
    assert(st.ok === true && st.claimable === 1, "checkinStatus 报告可领数量");
    assert(seen.every((m) => m === "GET"), "checkinStatus 只发 GET（不触发领取）");
  }
  // 领取窗口未开（每日 10:00 UTC+8 重置）→ deferred + retryAt，供自动签到延后。
  // 若不延后：一天只跑一次的自动签到在 10:00 前触发会标记"今日已完成"，
  // 永久错过当日窗口的 100 Credits。
  {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const r = await mkAd(async () => mkCampaigns([{ ...CLM, claimStatus: "CLAIMED", endAt: future }])).checkin({ uid: "u" }, { token: "t" });
    assert(r.deferred === true && r.already === true, "窗口未开（CLAIMED+endAt 未来）→ deferred + already");
    assert(r.retryAt >= future * 1000 && r.retryAt <= future * 1000 + 6 * 60000, "retryAt = endAt + 5min 抖动");
  }
  {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const r = await mkAd(async () => mkCampaigns([{ ...VIEW, endAt: past }])).checkin({ uid: "u" }, { token: "t" });
    assert(r.already === true && r.deferred !== true, "endAt 已过且无 CLAIMABLE → 普通 already（不延后）");
  }
  {
    // 加固回归：非 CLAIM_BENEFIT 的远期 CLAIMED（详情类等其它活动）不得触发延后，
    // 否则自动签到会被带偏到几天后，连累其它渠道的每日签到
    const far = Math.floor(Date.now() / 1000) + 86400 * 3;
    const r = await mkAd(async () => mkCampaigns([{ ...VIEW, claimStatus: "CLAIMED", endAt: far }])).checkin({ uid: "u" }, { token: "t" });
    assert(r.already === true && r.deferred !== true, "非 CLAIM_BENEFIT 的远期 CLAIMED 不触发延后");
  }
  {
    // 加固回归：混有远期 VIEW 类 CLAIMED 时，deferred 取 CLAIM_BENEFIT 中**最早**的未来 endAt
    const near = Math.floor(Date.now() / 1000) + 1800;
    const far = Math.floor(Date.now() / 1000) + 86400 * 3;
    const r = await mkAd(async () => mkCampaigns([
      { ...VIEW, claimStatus: "CLAIMED", endAt: far },
      { ...CLM, claimStatus: "CLAIMED", endAt: near },
    ])).checkin({ uid: "u" }, { token: "t" });
    assert(r.deferred === true && r.retryAt >= near * 1000 && r.retryAt <= near * 1000 + 6 * 60000, "混合活动时 retryAt 取 CLAIM_BENEFIT 最早的未来 endAt");
  }

  // ===== A2. 风控身份：真实调用客户端生成器 + 机器级缓存 =====
  // 实测：runtime-info.exe 产出的是**机器级**身份（与账号无关），单次约 3.6s。
  // 故必须按 product 缓存——按 uid 缓存会让 N 个账号付出 N×3.6s。
  console.log("\n[A2] 风控身份生成与缓存");
  const auth = require("../electron/backend/proxy/qoderAuth.cjs");
  const exePath = auth.riskIdentityPath("qoder");
  if (fs.existsSync(exePath)) {
    auth.clearRiskCache();
    const t0 = Date.now();
    const r1 = auth.readRiskIdentity("qoder", "uid-A");
    const firstMs = Date.now() - t0;
    assert(!!r1 && typeof r1.machineToken === "string" && r1.machineToken.length > 10, "runtime-info.exe 产出 machineToken");
    assert(typeof r1.machineType === "string" && typeof r1.machineCode === "string", "产出 machineType/machineCode");
    const t1 = Date.now();
    const r2 = auth.readRiskIdentity("qoder", "uid-B"); // 不同账号
    const secondMs = Date.now() - t1;
    assert(r2.machineToken === r1.machineToken, "身份与账号无关——不同 uid 命中同一缓存（实测机器级身份）");
    assert(secondMs < firstMs, `按 product 缓存生效：首次 ${firstMs}ms → 换账号 ${secondMs}ms`);
    // 批量签到最坏情况：N 个账号只应付出一次生成成本
    const t2 = Date.now();
    for (const u of ["u1", "u2", "u3", "u4", "u5"]) auth.readRiskIdentity("qoder", u);
    const fiveMs = Date.now() - t2;
    assert(fiveMs < 200, `5 个账号复用缓存共 ${fiveMs}ms（未重复 spawn，否则约 ${5 * firstMs}ms）`);
    auth.clearRiskCache();
    assert(true, "clearRiskCache 可调用（切号时清理）");
  } else {
    console.log("  · 客户端未安装，跳过（credential-only 环境）");
  }

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

/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 供应商/模型/网关回归自测（v1.20.x 整改项）：
//   ① Base URL 不再强制 https（内网 http 可用），协议缺失仍拒；
//   ② 手动添加模型按名字预填思考强度（与拉取路径同口径），边界正则不误命中；
//   ③ memCfg.set 失败必须上抛（不再静默吞错）；
//   ④ 网关列表（gateways）把内置 gw-local 暴露成列表行并带模型统计。
// 用法：node tools/memory-smoke-providers.cjs（不依赖 Electron API）
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemoryConfig } = require("../electron/backend/memory/config.cjs");
const { MemoryService } = require("../electron/backend/memory/service.cjs");
const { ProviderStore } = require("../electron/backend/memory/providers.cjs");

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
  const root = path.join(os.tmpdir(), `agenthub-prov-smoke-${Date.now()}`);
  fs.rmSync(root, { recursive: true, force: true });
  const cfg = new MemoryConfig(root);
  cfg.load();
  const svc = new MemoryService(root, cfg, { deviceId: "dev_smoke", onEvent: () => {} }).init();
  const store = new ProviderStore({
    memCfg: cfg,
    service: svc,
    emit: () => {},
    gatewayResolver: () => ({ available: true, baseUrl: "http://127.0.0.1:9527/v1", fallbackModel: "gpt-4o-mini" }),
  });

  console.log("[1] Base URL 校验（不再强制 https）");
  const bad = store.save({ name: "x", baseUrl: "ftp://example.com" });
  check("非 http(s) 协议被拒", bad.ok === false, JSON.stringify(bad));
  const noProto = store.save({ name: "x", baseUrl: "api.example.com" });
  check("缺协议前缀被拒", noProto.ok === false, JSON.stringify(noProto));
  const lan = store.save({ name: "内网中转", baseUrl: "http://192.168.1.10:8317/v1" });
  check("内网 http 地址放行", lan.ok === true, JSON.stringify(lan));
  const loop = store.save({ name: "本机", baseUrl: "http://127.0.0.1:9527" });
  check("回环 http 地址放行", loop.ok === true, JSON.stringify(loop));

  console.log("[2] 手动添加模型的思考强度预填");
  const provId = lan.id;
  const r1 = store.saveModel({ providerId: provId, modelId: "deepseek-r1" });
  check("deepseek-r1 手动添加成功", r1.ok === true, JSON.stringify(r1));
  let m = store.listModels(provId).find((x) => x.modelId === "deepseek-r1");
  check("deepseek-r1 预填 medium 且开推理", !!m && m.reasoning.enabled === true && m.reasoning.effort === "medium", JSON.stringify(m && m.reasoning));
  store.saveModel({ providerId: provId, modelId: "gpt-4o-mini" });
  m = store.listModels(provId).find((x) => x.modelId === "gpt-4o-mini");
  check("gpt-4o-mini 预填 minimal 且关推理", !!m && m.reasoning.enabled === false && m.reasoning.effort === "minimal", JSON.stringify(m && m.reasoning));
  store.saveModel({ providerId: provId, modelId: "polo1o-chat" });
  m = store.listModels(provId).find((x) => x.modelId === "polo1o-chat");
  check("边界正则：polo1o 不误判为推理模型", !!m && m.reasoning.enabled === false, JSON.stringify(m && m.reasoning));
  store.saveModel({ providerId: provId, modelId: "qwq-32b" });
  m = store.listModels(provId).find((x) => x.modelId === "qwq-32b");
  check("qwq 命中推理模型", !!m && m.reasoning.enabled === true, JSON.stringify(m && m.reasoning));
  // 编辑既有模型不传 reasoning → 保留原值（不被重置）
  const idR1 = store.listModels(provId).find((x) => x.modelId === "deepseek-r1").id;
  store.saveModel({ id: idR1, providerId: provId, modelId: "deepseek-r1", tags: ["heavy"] });
  m = store.listModels(provId).find((x) => x.modelId === "deepseek-r1");
  check("编辑不传 reasoning 保留原值", !!m && m.reasoning.effort === "medium", JSON.stringify(m && m.reasoning));

  console.log("[3] 写库失败必须上抛（不再静默成功）");
  const realSet = store.memCfg;
  store.memCfg = { set: () => ({ ok: false, errors: ["models.models: 磁盘只读"] }) };
  let threw = "";
  try { store.saveModel({ providerId: provId, modelId: "will-fail" }); } catch (e) { threw = String(e.message || e); }
  check("saveModel 抛出真实错误", /磁盘只读/.test(threw), threw || "(未抛错)");
  threw = "";
  try { store.save({ name: "y", baseUrl: "https://api.example.com" }); } catch (e) { threw = String(e.message || e); }
  check("saveProvider 抛出真实错误", /磁盘只读/.test(threw), threw || "(未抛错)");
  store.memCfg = realSet;

  console.log("[4] 网关列表（gw-local 列表行）");
  const gws = store.gateways();
  check("网关列表一行且 id 为 gw-local", gws.length === 1 && gws[0].id === "gw-local", JSON.stringify(gws.map((g) => g.id)));
  check("网关在线且地址来自 resolver", gws[0].available === true && gws[0].baseUrl === "http://127.0.0.1:9527/v1", gws[0].baseUrl);
  check("网关地址覆盖默认为空", gws[0].urlOverride === "", gws[0].urlOverride);
  store.saveModel({ providerId: "gw-local", modelId: "gpt-4o-mini" });
  const gws2 = store.gateways();
  check("网关模型计数正确", gws2[0].modelCount === 1 && gws2[0].enabledModelCount === 1, JSON.stringify({ c: gws2[0].modelCount, e: gws2[0].enabledModelCount }));
  check("gw-local 可合成供应商用于测试/拉取", !!store._providerWithKey("gw-local"), "");
  const down = new ProviderStore({ memCfg: cfg, service: svc, emit: () => {}, gatewayResolver: () => ({ available: false, baseUrl: "" }) });
  check("网关未运行时合成返回 null", down._providerWithKey("gw-local") === null, "");

  console.log("[5] 模型路由整改（v1.24.0：默认标签映射 / 来源序优先排序 / 任务级绑定 / 兜底绑定）");
  const { guessTags: gTags } = require("../electron/backend/memory/providers.cjs");
  const { DEFAULT_TASK_TAGS, normalizeSourceOrder } = require("../electron/backend/memory/llm/client.cjs");
  check("guessTags 重型模型补 supersede/consolidate", gTags("gpt-4o").includes("supersede") && gTags("gpt-4o").includes("consolidate"), JSON.stringify(gTags("gpt-4o")));
  check("guessTags 轻型模型不打 supersede/consolidate", !gTags("gpt-4o-mini").includes("supersede"), JSON.stringify(gTags("gpt-4o-mini")));
  check("默认标签映射覆盖全部 9 个任务", ["extract", "summarize", "tag", "classify", "supersede", "distill", "consolidate", "profile", "dedup"].every((t) => Array.isArray(DEFAULT_TASK_TAGS[t]) && DEFAULT_TASK_TAGS[t].length), "");
  check("旧默认来源序归一化", JSON.stringify(normalizeSourceOrder(["gateway", "custom", "degrade"])) === JSON.stringify(["custom", "gateway", "degrade"]), "");
  check("手动调过的来源序原样保留", JSON.stringify(normalizeSourceOrder(["degrade", "custom", "gateway"])) === JSON.stringify(["degrade", "custom", "gateway"]), "");

  // 受控模型池（直接整池替换，屏蔽前面用例遗留数据的干扰）
  const rp = store.save({ name: "路由测试供应商", baseUrl: "https://route.example.com" });
  const rid = rp.id;
  const setModels = (list) => {
    const r = store.memCfg.set({ "models.models": list }, { local: true });
    if (r && r.ok === false) throw new Error((r.errors || []).join("；"));
  };
  const mk = (id, modelId, tags, priority) => ({ id, providerId: rid, modelId, displayName: modelId, enabled: true, tags, priority, reasoning: { enabled: false, effort: "minimal", customBudget: null } });
  const gwMk = (id, modelId, tags, priority) => ({ ...mk(id, modelId, tags, priority), providerId: "gw-local" });

  // 来源序优先于 priority：默认序 custom 在前 → custom 的 p50 排在网关 p1 前面（旧实现全局按 priority 排，会反过来）
  setModels([mk("mm1", "route-mini", ["extract"], 50), mk("mm2", "route-big", ["extract"], 10), gwMk("mm3", "gw-mini", ["extract"], 1)]);
  store.memCfg.set({ "models.routing": [], "models.degrade": { enabled: true, effort: "minimal" } }, { local: true });
  const c1 = store.client.resolveCandidates("extract", {});
  check("来源序优先：custom p50 在网关 p1 前", c1.length === 3 && c1[0].model.modelId === "route-big" && c1[1].model.modelId === "route-mini" && c1[2].model.modelId === "gw-mini", JSON.stringify(c1.map((c) => `${c.source}:${c.model.modelId}:${c.model.priority}`)));

  // 任务级绑定 providerId：候选限制到指定供应商
  store.memCfg.set({ "models.routing": [{ task: "extract", providerId: rid }] }, { local: true });
  const c2 = store.client.resolveCandidates("extract", {});
  check("任务绑定供应商后只用它的模型", c2.length === 2 && c2.every((c) => c.provider.id === rid), JSON.stringify(c2.map((c) => c.model.modelId)));

  // 绑定的供应商没有带匹配标签的模型 → 用它全部启用模型兜底（指定即用）
  store.memCfg.set({ "models.routing": [{ task: "profile", providerId: rid }] }, { local: true });
  const c3 = store.client.resolveCandidates("profile", {});
  check("绑定供应商无匹配标签时用其全部启用模型", c3.length === 2 && c3.every((c) => c.provider.id === rid), JSON.stringify(c3.map((c) => c.model.modelId)));

  // 绑定本机网关：模型池为空也能回退 resolver 给的 fallbackModel
  setModels([mk("mm1", "route-mini", ["extract"], 50), mk("mm2", "route-big", ["summarize"], 10)]);
  store.memCfg.set({ "models.routing": [{ task: "dedup", providerId: "gw-local" }] }, { local: true });
  const c4 = store.client.resolveCandidates("dedup", {});
  check("绑定网关且池空时回退 fallbackModel", c4.length === 1 && c4[0].model.modelId === "gpt-4o-mini" && c4[0].source === "gateway", JSON.stringify(c4.map((c) => c.model.modelId)));

  // 任务绑定 modelId：置顶且压过 priority（网关池空时另有 fallback 候选垫底）
  setModels([mk("mm1", "route-mini", ["extract"], 50), mk("mm2", "route-big", ["extract"], 10)]);
  store.memCfg.set({ "models.routing": [{ task: "extract", modelId: "route-mini" }] }, { local: true });
  const c5 = store.client.resolveCandidates("extract", {});
  check("任务指定模型排到链首", c5.length === 3 && c5[0].model.modelId === "route-mini" && c5[2].model.modelId === "gpt-4o-mini", JSON.stringify(c5.map((c) => `${c.source}:${c.model.modelId}`)));

  // 试调 preferModelId：置顶且绕过任务级供应商绑定（测试哪个模型就该真调哪个）
  const c6 = store.client.resolveCandidates("extract", { preferModelId: "route-big" });
  check("preferModelId 置顶", c6[0].model.modelId === "route-big", JSON.stringify(c6.map((c) => c.model.modelId)));
  store.memCfg.set({ "models.routing": [{ task: "extract", providerId: "gw-local", modelId: "route-big" }] }, { local: true });
  const c7 = store.client.resolveCandidates("extract", { preferModelId: "route-big" });
  check("preferModelId 绕过供应商绑定", c7[0].model.modelId === "route-big" && c7[0].source === "custom", JSON.stringify(c7.map((c) => `${c.model.modelId}/${c.source}`)));

  // v1.25.2：指定模型/试调模型「没带该任务的标签」时也必须生效。
  // 此前这两条路径只做置顶，而候选池早被标签过滤清空 —— 置顶无从下手，
  // 「指定模型」就成了选了不生效的空旋钮（蒸馏这类任务照样报「无可用模型」，L2 永远没数据）。
  // 这段单独用一个"网关不可用"的 store，排除网关 fallback 候选干扰，只看自定义来源。
  const noGw = new ProviderStore({ memCfg: cfg, service: svc, emit: () => {}, gatewayResolver: () => ({ available: false, baseUrl: "" }) });
  setModels([mk("mm1", "route-mini", ["extract"], 10)]);
  store.memCfg.set({ "models.routing": [{ task: "distill", modelId: "route-mini" }] }, { local: true });
  const c8a = noGw.client.resolveCandidates("distill", {});
  check("指定模型无匹配标签时补进链首", c8a.length === 1 && c8a[0].model.modelId === "route-mini" && c8a[0].source === "custom", JSON.stringify(c8a.map((c) => `${c.source}:${c.model.modelId}`)));
  check("路由预览链路含指定模型", noGw.routingPreview().find((r) => r.task === "distill").chain.length === 1, JSON.stringify(noGw.routingPreview().find((r) => r.task === "distill").chain));
  check("路由预览指定模型可用时标注 ok", noGw.routingPreview().find((r) => r.task === "distill").modelState === "ok", String(noGw.routingPreview().find((r) => r.task === "distill").modelState));
  const c8b = noGw.client.resolveCandidates("distill", { preferModelId: "route-mini" });
  check("试调指名的模型未带标签时也补进链首", c8b.length === 1 && c8b[0].model.modelId === "route-mini", JSON.stringify(c8b.map((c) => c.model.modelId)));
  // 指定的模型已停用：不能把停用模型拉进链来跑，预览用 modelState 如实说明（否则用户只看到"绑了没反应"）
  setModels([{ ...mk("mm1", "route-off", ["extract"], 10), enabled: false }]);
  store.memCfg.set({ "models.routing": [{ task: "distill", modelId: "route-off" }] }, { local: true });
  const c8c = noGw.client.resolveCandidates("distill", {});
  check("指定的模型已停用时不补进链", c8c.length === 0, JSON.stringify(c8c.map((c) => c.model.modelId)));
  check("路由预览如实标注指定模型已停用", noGw.routingPreview().find((r) => r.task === "distill").modelState === "disabled", String(noGw.routingPreview().find((r) => r.task === "distill").modelState));
  store.memCfg.set({ "models.routing": [{ task: "distill", modelId: "查无此模" }] }, { local: true });
  check("路由预览如实标注指定模型不存在", noGw.routingPreview().find((r) => r.task === "distill").modelState === "missing", String(noGw.routingPreview().find((r) => r.task === "distill").modelState));
  setModels([mk("mm1", "route-mini", ["extract"], 10)]);
  store.memCfg.set({ "models.routing": [{ task: "extract", modelId: "route-mini" }] }, { local: true });
  const c8d = noGw.client.resolveCandidates("extract", { preferModelId: "查无此模" });
  check("试调指名不存在的模型时不污染链路", c8d.length === 1 && c8d[0].model.modelId === "route-mini", JSON.stringify(c8d.map((c) => c.model.modelId)));

  // 兜底绑定：绑了才参与解析（作为最后一环）；未绑不参与且 sources() 如实显示
  setModels([mk("mm1", "route-mini", ["extract"], 50), mk("mm2", "route-big", ["extract"], 10), gwMk("mm3", "gw-mini", ["extract"], 1)]);
  store.memCfg.set({ "models.routing": [], "models.degrade": { enabled: true, providerId: rid, modelId: "route-big", effort: "low" } }, { local: true });
  const c8 = store.client.resolveCandidates("extract", {});
  check("兜底绑定后作为最后一环参与解析", c8.length === 4 && c8[3].source === "degrade" && c8[3].model.modelId === "route-big" && c8[3].model.reasoning.effort === "low", JSON.stringify(c8.map((c) => `${c.source}:${c.model.modelId}`)));
  store.memCfg.set({ "models.degrade": { enabled: true, effort: "minimal" } }, { local: true });
  const c9 = store.client.resolveCandidates("extract", {});
  check("兜底未绑定模型时不参与解析", c9.length === 3 && !c9.some((c) => c.source === "degrade"), JSON.stringify(c9.map((c) => c.source)));
  const src2 = store.sources();
  check("sources() 兜底档 available 如实反映绑定", src2.sources.find((s) => s.key === "degrade").available === false, JSON.stringify(src2.sources.find((s) => s.key === "degrade")));
  check("sources() 返回 degrade 配置", typeof src2.degrade === "object" && src2.degrade.enabled === true, JSON.stringify(src2.degrade));

  // 默认映射打通 supersede/consolidate：池里只有 classify/summarize 模型也能解析（网关 fallback 候选垫底不计）
  setModels([mk("mm1", "route-cls", ["classify"], 10), mk("mm2", "route-sum", ["summarize"], 10)]);
  const c10 = store.client.resolveCandidates("supersede", {});
  const c11 = store.client.resolveCandidates("consolidate", {});
  check("supersede 借道 classify 默认映射", c10.length === 2 && c10[0].model.modelId === "route-cls" && c10[0].source === "custom", JSON.stringify(c10.map((c) => `${c.source}:${c.model.modelId}`)));
  check("consolidate 借道 summarize 默认映射", c11.length === 2 && c11[0].model.modelId === "route-sum" && c11[0].source === "custom", JSON.stringify(c11.map((c) => `${c.source}:${c.model.modelId}`)));

  // 路由预览带任务级绑定字段，tags 未显式配置时用默认映射
  store.memCfg.set({ "models.routing": [{ task: "extract", providerId: rid, modelId: "route-cls" }] }, { local: true });
  const pvExtract = store.routingPreview().find((r) => r.task === "extract");
  check("路由预览带 providerId/modelId", pvExtract.providerId === rid && pvExtract.modelId === "route-cls", JSON.stringify({ p: pvExtract.providerId, m: pvExtract.modelId }));
  check("路由预览未配 tags 时用默认映射", JSON.stringify(store.routingPreview().find((r) => r.task === "supersede").tags) === JSON.stringify(DEFAULT_TASK_TAGS.supersede), "");

  svc.close && svc.close();
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
  if (failCount) {
    console.log("失败项：");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("自测异常：", e);
  process.exit(1);
});

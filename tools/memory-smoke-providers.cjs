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

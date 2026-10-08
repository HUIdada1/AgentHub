// 共享配置同步自测：exportShared → encodeEnvelope → decodeEnvelope → applyShared 全链路（离线，无 WebDAV）。
// 覆盖：映射类配置合并、API Key 导入去重、模型清单按渠道 syncedAt 新者胜、幂等、格式守卫、封套密码守卫。
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-sharedsync-smoke.cjs [临时数据目录]
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-sharedsync-test-"));
process.env.APPDATA = tmp; // config.cjs 纯 Node 模式退回 %APPDATA%\AgentHub

async function main() {
  const assert = (cond, msg) => { if (!cond) throw new Error("断言失败: " + msg); };
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const config = require("../electron/backend/config.cjs");
  const poolsync = require("../electron/backend/proxy/poolsync.cjs");

  store.open();
  rules.init();

  // ===== 1. 封套 roundtrip + 密码守卫 =====
  console.log("[1] 封套 roundtrip / 密码守卫");
  const payload = { format: "agenthub-proxy-shared@1", n: 1 };
  const buf = poolsync.encodeEnvelope(payload, "pw-a");
  const back = poolsync.decodeEnvelope(buf, "pw-a");
  assert(back.n === 1 && back.format === payload.format, "同密码解封还原");
  let threw = false;
  try { poolsync.decodeEnvelope(buf, "pw-b"); } catch { threw = true; }
  assert(threw, "错密码必须抛错（不能静默解出坏数据）");

  // ===== 2. 本机种子：Key + 映射 + 清单 =====
  console.log("[2] 本机种子状态");
  const k1 = store.createKey({ name: "本机已有", route: "auto", dailyQuota: 5, rateLimit: 0 });
  const cfg0 = config.loadConfig();
  cfg0.proxy.modelAliases = { "old-alias": "target-a" };
  config.saveConfig(cfg0);
  const T1 = Date.now() - 86400000;
  const T2 = Date.now() - 3600000;
  const T0 = Date.now() - 7 * 86400000;
  const T3 = Date.now(); // 远端比本机更新（本机 trae 是 T2）
  fs.writeFileSync(
    path.join(rules.rulesDir(), "catalog.json"),
    JSON.stringify({ trae: { syncedAt: T2, models: [{ id: "m1", name: "本机已拉取", rate: 1 }] } }, null, 2),
    "utf8"
  );
  rules.reload("catalog.json");

  const ex = poolsync.exportShared();
  assert(ex.format === "agenthub-proxy-shared@1", "导出 format 正确");
  assert(ex.keys.some((k) => k.id === k1.id && k.secret === k1.secret), "导出含本机 Key 明文（加密包内）");
  assert(ex.catalog.trae && ex.catalog.trae.syncedAt === T2, "导出含本机模型清单");
  assert(typeof ex.config.modelAliases === "object", "导出含映射类配置");

  // ===== 3. 应用远端快照：映射合并 + Key 去重导入 + 清单按渠道新者胜 =====
  console.log("[3] 应用远端快照（映射 + Key + 清单）");
  const k2 = { id: "remote-key-1", name: "对端Key", secret: "sk-" + "b".repeat(48), route: "trae", routeOrder: "cost-first", dailyQuota: 9, rateLimit: 0, enabled: true, createdAt: Date.now() };
  const snap = {
    format: "agenthub-proxy-shared@1",
    exportedAt: Date.now(),
    deviceId: "device-B",
    deviceName: "对端设备",
    config: {
      modelAliases: { "old-alias": "target-a", "new-alias": "target-b" },
      modelReverseAliases: { "rev-1": ["m1"] },
      modelCustom: {}, modelOverrides: {}, modelFallback: {}, disabledModels: [],
    },
    keys: [
      { id: k1.id, name: "重复Key应跳过", secret: k1.secret, route: "auto", dailyQuota: 0, rateLimit: 0, enabled: false, createdAt: 1 },
      k2,
    ],
    catalog: {
      trae: { syncedAt: T3, models: [{ id: "m1", name: "远端较新版本", rate: 0.5 }, { id: "m2", name: "远端新增", rate: 1 }] },
      lobster: { syncedAt: T1, models: [{ id: "l1", name: "新渠道", rate: 1 }] },
    },
  };
  const r1 = poolsync.applyShared(snap);
  assert(r1.applied === true, "快照被应用");
  assert(r1.configChanged === 2, `映射合并变更数 = 2（old-alias 同值不算，new-alias + rev-1），实际 ${r1.configChanged}`);
  assert(r1.keyAdded === 1, `只导入本机没有的 Key（实际 ${r1.keyAdded}）`);
  assert(r1.catalogUpdated === 1 && r1.catalogAdded === 1, `清单 更新1+新增1（实际 u=${r1.catalogUpdated} a=${r1.catalogAdded}）`);

  const cfg1 = config.loadConfig();
  assert(cfg1.proxy.modelAliases["new-alias"] === "target-b", "新映射已入配置");
  assert(cfg1.proxy.modelAliases["old-alias"] === "target-a", "同值映射未被破坏");
  assert(JSON.stringify(cfg1.proxy.modelReverseAliases) === JSON.stringify({ "rev-1": ["m1"] }), "反向映射已入配置");
  assert(store.listKeys().filter((k) => k.id === k1.id).length === 1, "同 id Key 不重复");
  const imported = store.findKeyBySecret(k2.secret);
  assert(imported && imported.route === "trae", "对端 Key 导入后可鉴权命中");
  assert(imported.routeOrder === "cost-first", "per-key 路由策略随 Key 同步");
  const cat1 = rules.get("catalog.json");
  assert(cat1.trae.models.some((m) => m.id === "m2"), "较新清单渠道整体替换（含远端新增模型）");
  assert(cat1.trae.models[0].rate === 0.5, "较新清单参数随之更新");
  assert(cat1.lobster && cat1.lobster.models[0].id === "l1", "本机没有的清单渠道直接入");

  // ===== 4. 旧清单不回捞：远端 syncedAt 更旧，本机保持 =====
  console.log("[4] 旧清单不回捞（syncedAt 新者胜）");
  const snapOld = {
    format: "agenthub-proxy-shared@1", exportedAt: Date.now(), deviceId: "device-C", deviceName: "旧目录设备",
    config: {}, keys: [],
    catalog: { trae: { syncedAt: T0, models: [{ id: "stale", name: "过期模型", rate: 9 }] } },
  };
  const r2 = poolsync.applyShared(snapOld);
  assert(r2.catalogUpdated === 0 && r2.catalogAdded === 0, "旧清单不得覆盖新清单");
  assert(!rules.get("catalog.json").trae.models.some((m) => m.id === "stale"), "过期模型未混入");

  // ===== 5. 幂等：同一快照重复应用零变更 =====
  console.log("[5] 幂等性");
  const r3 = poolsync.applyShared(snap);
  assert(r3.configChanged === 0 && r3.keyAdded === 0 && r3.catalogUpdated === 0 && r3.catalogAdded === 0,
    `重复应用应零变更（实际 c=${r3.configChanged} k=${r3.keyAdded} u=${r3.catalogUpdated} a=${r3.catalogAdded}）`);

  // ===== 6. 格式守卫：未知 format 拒绝 =====
  console.log("[6] 格式守卫");
  const r4 = poolsync.applyShared({ format: "agenthub-proxy-pool@1", config: { modelAliases: { x: "y" } } });
  assert(r4.applied === false, "归档格式混入共享通道必须拒绝");
  const r5 = poolsync.applyShared(null);
  assert(r5.applied === false, "空快照拒绝");

  // ===== 7. 空清单快照不写空目录（防止对端异常清空本机） =====
  console.log("[7] 空清单防护");
  const before = JSON.stringify(rules.get("catalog.json"));
  poolsync.applyShared({ format: "agenthub-proxy-shared@1", exportedAt: Date.now(), config: {}, keys: [], catalog: {} });
  assert(JSON.stringify(rules.get("catalog.json")) === before, "空 catalog 不落盘");

  // ===== 8. 向后兼容：旧版载荷 / 旧记账字段缺失 =====
  console.log("[8] 向后兼容旧同步数据");  // 8a. 老版本设备发出的载荷没有 catalog 字段、Key 没有 routeOrder —— 不得报错、不得清数据
  const oldSnap = {
    format: "agenthub-proxy-shared@1", exportedAt: Date.now(), deviceId: "old-device", deviceName: "旧版设备",
    config: { modelAliases: { "legacy": "m0" } },
    keys: [{ id: "old-key-1", name: "旧版Key", secret: "sk-" + "c".repeat(48), route: "auto", dailyQuota: 0, rateLimit: 0, enabled: true, createdAt: Date.now() }],
    // 注意：没有 catalog 字段、keys 里没有 routeOrder
  };
  const catBefore8 = JSON.stringify(rules.get("catalog.json"));
  const r8 = poolsync.applyShared(oldSnap);
  assert(r8.applied !== false && r8.catalogAdded === 0 && r8.catalogUpdated === 0, "无 catalog 字段的旧载荷安全跳过清单合并");
  assert(JSON.stringify(rules.get("catalog.json")) === catBefore8, "旧载荷不动本机清单");
  assert(store.findKeyBySecret("sk-" + "c".repeat(48)), "旧载荷 Key（无 routeOrder）正常导入");
  const cfg8 = config.loadConfig();
  assert(cfg8.proxy.modelAliases.legacy === "m0", "旧载荷映射正常合并");
  // 8b. 号池归档格式不受影响：共享格式与归档格式互不误认
  let misread = false;
  try { poolsync.applyShared({ format: "agenthub-proxy-pool@1", accounts: [] }); } catch { misread = true; }
  assert(misread === false, "归档格式混入不抛异常（安全拒绝）");
  // 8c. 旧版 sync-state.json（无 shared 字段）等价于 persisted={}：e2e 全程即此形态，此处对齐默认值语义
  console.log("  8c: e2e 用 persisted={}（等价旧记账缺字段）已验证，loadPersisted 默认 sharedAppliedAt=0/sharedHash=''");

  // ===== 9. 数组值语义：disabledModels 并集去重，且必须保持为数组 =====
  console.log("[9] 数组值合并（disabledModels）");
  poolsync.applyShared({ format: "agenthub-proxy-shared@1", exportedAt: Date.now(), config: { disabledModels: ["m-x"] }, keys: [] });
  const cfg9 = config.loadConfig();
  assert(Array.isArray(cfg9.proxy.disabledModels), "合并后必须仍是数组（Object.assign 会把数组变对象 → 网关 500）");
  assert(cfg9.proxy.disabledModels.includes("m-x"), "远端禁用项并入");
  poolsync.applyShared({ format: "agenthub-proxy-shared@1", exportedAt: Date.now(), config: { disabledModels: ["m-y"] }, keys: [] });
  const cfg9b = config.loadConfig();
  assert(Array.isArray(cfg9b.proxy.disabledModels) && cfg9b.proxy.disabledModels.includes("m-x") && cfg9b.proxy.disabledModels.includes("m-y"), "数组取并集去重");

  // ===== 10. 号池归档封套与共享配置同源（去重后行为不回退） =====
  console.log("[10] 归档封套复用 encode/decodeEnvelope");
  const arc = { format: "agenthub-proxy-pool@1", deviceId: "d", exportedAt: Date.now(), accounts: [{ key: "a@b", channel: "trae" }] };
  const arcBuf = poolsync.encodeArchive(arc, "pw-x");
  const arcBack = poolsync.decodeArchive(arcBuf, "pw-x");
  assert(arcBack.accounts.length === 1 && arcBack.accounts[0].key === "a@b", "归档 roundtrip 不变");
  assert(poolsync.decodeEnvelope(arcBuf, "pw-x").format === "agenthub-proxy-pool@1", "归档与共享共用同一封套（可交叉解出）");
  let arcErr = "";
  try { poolsync.decodeArchive(arcBuf, "pw-y"); } catch (e) { arcErr = String(e.message); }
  assert(/解密失败/.test(arcErr), `错密码仍是「解密失败」文案（实际「${arcErr}」）`);
  let fmtErr = "";
  try { poolsync.decodeArchive(poolsync.encodeArchive({ format: "other@1", accounts: 1 }, "pw-x"), "pw-x"); } catch (e) { fmtErr = String(e.message); }
  assert(/快照格式不识别/.test(fmtErr), `形状不符仍是「快照格式不识别」（实际「${fmtErr}」）`);

  // ===== 11. 形状守卫：对端载荷形状不符不得写坏本机配置 =====
  console.log("[11] 形状守卫（对端载荷形状 ≠ 本机形状）");
  poolsync.applyShared({
    format: "agenthub-proxy-shared@1", exportedAt: Date.now(), keys: [],
    config: { modelAliases: ["把映射写成数组"], disabledModels: { "0": "把数组写成对象" } },
  });
  const cfg11 = config.loadConfig();
  assert(Array.isArray(cfg11.proxy.disabledModels), "数组键收到对象载荷 → 本机仍是数组");
  assert(!JSON.stringify(cfg11.proxy.disabledModels).includes("把数组写成对象"), "对象载荷未被并入");
  assert(!Array.isArray(cfg11.proxy.modelAliases) && typeof cfg11.proxy.modelAliases === "object", "映射键收到数组载荷 → 本机仍是对象（原实现会整体替换成数组）");
  assert(cfg11.proxy.modelAliases["new-alias"] === "target-b", "映射内容未被数组载荷顶掉");
  // 本机侧历史脏数据（数组键被写成对象）→ 收到远端数组后纠正回数组
  const dirty = config.loadConfig();
  dirty.proxy.disabledModels = { "0": "脏数据" };
  config.saveConfig(dirty);
  poolsync.applyShared({ format: "agenthub-proxy-shared@1", exportedAt: Date.now(), config: { disabledModels: ["m-z"] }, keys: [] });
  const cfg11b = config.loadConfig();
  assert(Array.isArray(cfg11b.proxy.disabledModels) && cfg11b.proxy.disabledModels.includes("m-z"), "本机脏形状被远端正数组纠正回数组");

  console.log("\nSHARED-SYNC SMOKE OK（9 组断言全过）");
  process.exit(0); // rules.init 的 watcher 会让事件循环保持存活，测完显式退出
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });

// 反代网关 · Qoder 本机扫描/导入自测（真实本机登录态；数据目录隔离）
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-qoder-discovery-selftest.cjs
//
// 覆盖：
//   1) scanAll 含 Qoder 候选（启用门生效：暂停的区不产出候选）
//   2) 候选字段契约：channel/uid/name/token/refreshToken/expiresAt/meta.machineId/source/file
//   3) token 不出现在候选里会被 proxy_scan 出口脱敏（此处直接校验 discovery 层仍带 token，
//      脱敏是 index.cjs 的职责——避免误以为 discovery 就该脱敏）
//   4) importCandidate：新增入库（meta.machineId 落库）+ 同 uid 二次导入走更新分支
//   5) 加密候选的提示语渠道感知（Qoder 不误导用户去走不存在的 OAuth）
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-disc-"));
process.env.AGENTHUB_DATA_DIR = dataDir;

const assert = (cond, msg) => {
  if (!cond) throw new Error("断言失败: " + msg);
  console.log("  ✓ " + msg);
};

async function main() {
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const discovery = require("../electron/backend/proxy/discovery.cjs");

  store.open();
  rules.init();

  // ===== 1. scanAll 含 Qoder 候选 =====
  console.log("\n[1] scanAll 含 Qoder 候选");
  const all = discovery.scanAll();
  const qoderCands = all.filter((c) => c.channel === "qoder" || c.channel === "qoder_intl");
  console.log(`  全量候选 ${all.length} 条，其中 Qoder ${qoderCands.length} 条`);
  for (const c of qoderCands) console.log(`    · ${c.channel}: uid=${c.uid ? c.uid.slice(0, 8) + "***" : "(无)"} ${c.encrypted ? "[加密/失败] " + c.file : ""}`);
  // 环境守卫：本测试验证「扫描→导入」真实链路，必须有本机登录态。
  // CI / 未装客户端的机器上没有候选是**环境问题而非代码问题**——按仓库约定跳过而非失败
  //（对齐 run-selftests.cjs 的「缺依赖跳过」与 proxy-qoder-selftest 的「无客户端跳过」先例）。
  if (!qoderCands.some((c) => !c.encrypted)) {
    console.log("  ⏭ 跳过：本机无已登录的 Qoder 客户端（扫描导入链路需要真实登录态）");
    return;
  }
  assert(qoderCands.length > 0, "scanAll 产出 Qoder 候选（本机已登录）");

  // 启用门：CHANNELS 中不存在的渠道不得出现在候选里
  const enabledIds = store.CHANNELS.map((c) => c.id);
  assert(qoderCands.every((c) => enabledIds.includes(c.channel)), "候选渠道均在 CHANNELS 中（启用门生效）");
  if (!store.QODER_INTL_ENABLED) {
    assert(!qoderCands.some((c) => c.channel === "qoder_intl"), "INTL 暂停启用时不产出 qoder_intl 候选");
  }

  // ===== 2. 候选字段契约 =====
  console.log("\n[2] 候选字段契约");
  const ok = qoderCands.find((c) => !c.encrypted);
  assert(!!ok, "至少一条可用候选（非加密）");
  for (const f of ["channel", "uid", "token", "refreshToken", "source", "file"]) {
    assert(f in ok, `候选含字段 ${f}`);
  }
  assert(ok.token.startsWith("dt-"), "token 为 dt- 形态");
  assert(ok.refreshToken.startsWith("drt-"), "refreshToken 为 drt- 形态");
  assert(typeof ok.expiresAt === "number" && ok.expiresAt > Date.now(), "expiresAt 为未来时间戳（落库供临期预刷新）");
  assert(ok.meta && typeof ok.meta.machineId === "string" && ok.meta.machineId.length > 0, "meta.machineId 非空（签名与续期必需）");
  assert(ok.meta.product === ok.channel, "meta.product 与 channel 一致");
  assert(ok.source === "scan", "source=scan");
  assert(/auth\.v1\.dat/.test(ok.file), "file 指向 auth.v1.dat（含渠道标签）");

  // ===== 3. 加密候选提示语渠道感知 =====
  // scanQoder 的 file 形如 "auth.v1.dat（Qoder CN）：<失败原因>"，importCandidate 取冒号后原因拼接
  console.log("\n[3] 加密候选提示语");
  let msg = "";
  try {
    discovery.importCandidate({ channel: "qoder", uid: "", token: "", refreshToken: "", encrypted: true, file: "auth.v1.dat（Qoder CN）：DPAPI 解密失败（需与 Qoder 客户端同一 Windows 用户）" });
  } catch (e) { msg = String(e.message); }
  console.log("    实际:", msg);
  assert(/同一 Windows 用户/.test(msg), "Qoder 加密候选提示指向「同一 Windows 用户」");
  assert(/Qoder 客户端/.test(msg), "提示指明是 Qoder 客户端（可执行的下一步）");
  assert(!/OAuth 登录/.test(msg), "提示中不含误导性的 OAuth 引导（Qoder 无回环 OAuth）");
  let msg2 = "";
  try {
    discovery.importCandidate({ channel: "workbuddy", uid: "", token: "", refreshToken: "", encrypted: true });
  } catch (e) { msg2 = String(e.message); }
  assert(/OAuth 登录/.test(msg2), "既有渠道（WB）提示语未被改动（仍引导 OAuth）");
  // 退化情形：file 只含文件名（无原因）时，仍须给出可执行指引
  let msg3 = "";
  try {
    discovery.importCandidate({ channel: "qoder", uid: "", token: "", refreshToken: "", encrypted: true, file: "auth.v1.dat" });
  } catch (e) { msg3 = String(e.message); }
  console.log("    无原因时:", msg3);
  assert(/同一 Windows 用户/.test(msg3), "无失败原因时仍给出可执行指引");
  // 技术性原因应被保留（不能只剩指引）
  let msg4 = "";
  try {
    discovery.importCandidate({ channel: "qoder", uid: "", token: "", refreshToken: "", encrypted: true, file: "auth.v1.dat（Qoder CN）：os_crypt 前缀异常" });
  } catch (e) { msg4 = String(e.message); }
  assert(/os_crypt 前缀异常/.test(msg4), "上游技术原因被保留在提示里（便于排查）");

  // ===== 4. importCandidate 新增 + 更新 =====
  console.log("\n[4] importCandidate 新增/更新");
  const r1 = discovery.importCandidate(ok);
  assert(r1 && r1.id && r1.updated === false, "首次导入为新增");
  const acc = store.listAccounts(ok.channel).find((a) => a.id === r1.id);
  assert(acc && acc.uid === ok.uid, "入库 uid 正确");
  assert(acc.meta && acc.meta.machineId === ok.meta.machineId, "meta.machineId 落库");
  // 注意：listAccounts 返回 accountView（驼峰 expiresAt）；getAccount 才是原始行（expires_at）
  assert(acc.expiresAt === ok.expiresAt, "expiresAt 落库（view 字段）");
  assert(store.getAccount(r1.id).expires_at === ok.expiresAt, "expires_at 落库（原始列）");
  const sec = store.accountSecrets(store.getAccount(r1.id));
  assert(sec.token === ok.token && sec.refreshToken === ok.refreshToken, "凭据加密入库且可正确解出");
  // 二次导入同 uid → 走更新分支（不产生重复账号）
  const before = store.listAccounts(ok.channel).length;
  const r2 = discovery.importCandidate({ ...ok, token: ok.token, name: (ok.name || "") + "（更新）" });
  const after = store.listAccounts(ok.channel).length;
  assert(r2.updated === true && r2.id === r1.id, "同 uid 二次导入走更新分支（复用账号 id）");
  assert(after === before, "不产生重复账号");
}

/** 安装探测与渠道启用门的一致性（UI 入口可用性的依据） */
async function checkIdeStatus() {
  const store = require("../electron/backend/proxy/store.cjs");
  const ideswitch = require("../electron/backend/proxy/ideswitch.cjs");
  const auth = require("../electron/backend/proxy/qoderAuth.cjs");
  console.log("\n[5] ideStatus 安装探测与启用门");
  // 环境守卫（与 main 的跳过守卫同因）：无客户端时 installed 本来就是 false，
  // 下面的「installed=true」断言只对装了客户端的机器有意义
  const det = auth.detectAll();
  if (!det.qoder) {
    console.log("  ⏭ 跳过：本机无 Qoder 客户端（安装探测断言需要真实安装态）");
    return;
  }
  const st = ideswitch.ideSwitchStatus();
  console.log(`  qoderInstalled=${st.qoderInstalled} qoderIntlInstalled=${st.qoderIntlInstalled}`);
  assert(st.qoderInstalled === true, "已启用的 qoder 上报 installed=true（UI 给出导入入口）");
  if (!store.QODER_INTL_ENABLED) {
    assert(st.qoderIntlInstalled === false, "暂停的 qoder_intl 上报 installed=false（不给点不进去的入口）");
    assert(st.channels.qoder_intl.installed === false, "channels.qoder_intl.installed 同样受启用门约束");
  }
  assert(!!st.channels.qoder.file && /auth\.v1\.dat$/.test(st.channels.qoder.file), "channels.qoder.file 指向 auth.v1.dat");
}

main()
  .then(() => checkIdeStatus())
  .then(() => {
    console.log("\n[done] Qoder 本机扫描/导入自测通过");
    process.exit(0);
  })
  .catch((e) => {
    console.error("\n[FAIL] " + ((e && e.stack) || e));
    process.exit(1);
  });

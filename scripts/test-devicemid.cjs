// deviceMid 切号/诊断/修复/领取模式全链路沙箱自测（不碰真实 ~/.zcode，不依赖 SQLite，直接删临时目录）
// 运行：node scripts/test-devicemid.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-mid-test-"));
process.env.ZCODE_V2_DIR = path.join(TMP, "v2");
// anchor / sync-state 沙箱：getOrCreateAnchor 会写 config.dataDir()/proxy/，不隔离会污染真机
process.env.AGENTHUB_DATA_DIR = path.join(TMP, "data");

const zcodeLocal = require("../electron/backend/proxy/zcodeLocal.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

function makeJwt(uid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ user_id: uid })}.sig`;
}

function writeLive(uid, mid) {
  const p = zcodeLocal.paths();
  fs.mkdirSync(p.dir, { recursive: true });
  const secret = zcodeLocal.defaultSecret();
  const cred = {
    zcodejwttoken: zcodeLocal.encEncrypt(makeJwt(uid), secret),
    "oauth:active_provider": zcodeLocal.encEncrypt("zai", secret),
    "oauth:zai:access_token": zcodeLocal.encEncrypt("at-" + uid, secret),
    "oauth:zai:user_info": zcodeLocal.encEncrypt(JSON.stringify({ user_id: uid, name: "u" + uid }), secret),
    "web-remote-control:external-relay:pass_hash": "enc:v1:relay-fixed",
  };
  zcodeLocal.atomicWriteJson(p.credentials, cred);
  zcodeLocal.atomicWriteJson(p.telemetry, { deviceMid: mid, lastDailyActiveDate: "2026-09-29" });
}

function readMid() {
  return String((zcodeLocal.readJson(zcodeLocal.paths().telemetry) || {}).deviceMid || "");
}

const UID_A = "11111111-1111-4111-8111-111111111111";
const UID_B = "22222222-2222-4222-8222-222222222222";
const M0 = "aaaaaaaa-0000-4000-8000-000000000000";
const M1 = "bbbbbbbb-1111-4111-8111-111111111111";
const M2 = "cccccccc-2222-4222-8222-222222222222";

// 内存版 store stub：zcodeSwitch 通过 require("./store.cjs") 拿它（在 require 前注入缓存）
const storeStub = {
  _rows: new Map(),
  addAccount(a) { const id = a.id || `id-${this._rows.size + 1}`; this._rows.set(id, { ...a, id }); return id; },
  listAccounts() { return [...this._rows.values()]; },
  getAccount(id) { return this._rows.get(id) || null; },
  updateAccount(id, patch) { const r = this._rows.get(id); if (r) Object.assign(r, patch); },
  accountSecrets(r) { return { token: r.token || "", refreshToken: r.refreshToken || "" }; },
};
require.cache[require.resolve("../electron/backend/proxy/store.cjs")] = { exports: storeStub };
const zcodeSwitch = require("../electron/backend/proxy/zcodeSwitch.cjs");

// 沙箱进程控制：模拟「客户端未运行」，绝不探测/击杀真机的 ZCode.exe，绝不真启动
zcodeLocal.isZcodeRunning = () => false;
zcodeLocal.findZcodeExe = () => "";
zcodeLocal.launchZcode = () => ({ ok: false, message: "sandbox" });

(async () => {
  console.log(`沙箱目录 ${TMP}`);

  // ① applyDeviceMid：原子写 + 字段保留 + 回读校验
  console.log("① applyDeviceMid 原子写");
  writeLive(UID_A, M0);
  const r1 = zcodeLocal.applyDeviceMid({ deviceMid: M1 });
  ok(r1.ok && !r1.unchanged && r1.from === M0 && r1.to === M1, "M0 → M1 切换成功");
  const after = zcodeLocal.readJson(zcodeLocal.paths().telemetry);
  ok(after.deviceMid === M1 && after.lastDailyActiveDate === "2026-09-29", "其它字段（lastDailyActiveDate）原样保留");
  const r2 = zcodeLocal.applyDeviceMid({ deviceMid: M1 });
  ok(r2.ok && r2.unchanged, "相同指纹幂等无操作");
  const r3 = zcodeLocal.applyDeviceMid({ deviceMid: "" });
  ok(r3.ok && r3.to && r3.to !== M1, "空指纹回退派生兜底");
  ok(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-a[\da-f]{3}-[\da-f]{12}$/.test(r3.to), "兜底指纹是合法 UUIDv4 形态");

  // ② 诊断：多号共用一枚指纹 → 撞车互认 + 疑似被烧
  console.log("② deviceStatus 撞车诊断");
  storeStub.addAccount({ channel: "zcode", uid: UID_A, name: "A", token: makeJwt(UID_A), meta: { deviceMid: M0 } });
  storeStub.addAccount({ channel: "zcode", uid: "33333333-3333-4333-8333-333333333333", name: "B", token: makeJwt("33333333-3333-4333-8333-333333333333"), meta: { deviceMid: M0 } });
  writeLive(UID_A, M0); // A 是 live
  const st = zcodeSwitch.deviceStatus();
  const rowA = st.rows.find((r) => r.name === "A");
  const rowB = st.rows.find((r) => r.name === "B");
  ok(rowA.isLive && rowA.conflictWith.length === 1 && rowB.conflictWith.length === 1, "A/B 双向撞车互认");
  ok(rowA.burnedLikely && rowB.burnedLikely, "撞车组全员标「疑似被烧」");
  ok(rowB.liveShared && !rowA.liveShared, "非 live 的 B 标 liveShared，live 的 A 不标");
  ok(st.liveMid === M0, "liveMid 正确");

  // ③ 修复：撞车组整组重派；live 文件绝不被修复流程改写；二次修复幂等
  console.log("③ repairDeviceMid 修复");
  const rep = zcodeSwitch.repairDeviceMid({});
  ok(rep.repaired === 2, `撞车组整组重派（实际 ${rep.repaired}）`);
  const st2 = zcodeSwitch.deviceStatus();
  ok(readMid() === M0, "live 文件保持 M0（修复绝不动 live 文件）");
  const fa = st2.rows.find((r) => r.name === "A");
  const fb = st2.rows.find((r) => r.name === "B");
  ok(fa.deviceMid !== M0 && fb.deviceMid !== M0 && fa.deviceMid !== fb.deviceMid, "A/B 各换全新且互不相同");
  ok(!st2.rows.some((r) => r.conflictWith.length || r.burnedLikely), "修复后全池零撞车零告警");
  const rep2 = zcodeSwitch.repairDeviceMid({});
  ok(rep2.repaired === 0, "二次修复幂等（0 个改动）");

  // ④ live 指纹被占坑但 live 号不在池里：重派占坑号后撞车消除，live 文件不动
  console.log("④ live 占坑脱离");
  storeStub._rows.clear();
  storeStub.addAccount({ channel: "zcode", uid: UID_A, name: "A", token: makeJwt(UID_A), meta: { deviceMid: M0 } });
  writeLive("99999999-9999-4999-8999-999999999999", M0); // live 换成池外的 C，但指纹仍 M0
  const st4 = zcodeSwitch.deviceStatus();
  ok(st4.rows.find((r) => r.name === "A").liveShared, "占坑号标 liveShared");
  const rep3 = zcodeSwitch.repairDeviceMid({});
  ok(rep3.repaired === 1, "占坑号被重派");
  const st5 = zcodeSwitch.deviceStatus();
  ok(readMid() === M0 && !st5.rows.some((r) => r.deviceMid === M0), "live 文件不动，占坑号脱离 live 指纹");

  // ⑤ adopt 陷阱隔离：live 指纹已被池内 A 持有时，捕获 live 账号 B 不得继承 M0
  console.log("⑤ 捕获隔离（adopt 陷阱）");
  storeStub._rows.clear();
  storeStub.addAccount({ channel: "zcode", uid: UID_A, name: "A", token: makeJwt(UID_A), meta: { deviceMid: M0 } });
  writeLive(UID_B, M0); // B 是 live，live 指纹 M0 已被 A 持有
  const parsedB = zcodeLocal.parseCredentials(zcodeLocal.readJson(zcodeLocal.paths().credentials));
  const recB = zcodeLocal.accountRecord(parsedB, {});
  ok(recB.meta.deviceMid && recB.meta.deviceMid !== M0, `B 不继承被 A 占用的 live 指纹（得到 ${recB.meta.deviceMid.slice(0, 8)}…）`);
  ok(recB.meta.deviceMid === zcodeLocal.derivedDeviceMid(UID_B), "B 回退到 uid 确定性派生指纹");
  // 对照：live 指纹无人占用时，live 账号沿用 live 指纹（真实形态保持）
  storeStub._rows.clear();
  const recB2 = zcodeLocal.accountRecord(parsedB, {});
  ok(recB2.meta.deviceMid === M0, "live 指纹无人占用时 B 沿用 M0");

  // ⑥ remoteMid 锚定初始化：优先取备份史里最早的 live 指纹（最接近 deviceSid 首次注册时的值）
  console.log("⑥ remoteMid 锚定初始化");
  const backupRoot = path.join(process.env.AGENTHUB_DATA_DIR, "proxy", "zcode-switch-backup");
  for (const [ts, mid] of [["1000", M0], ["2000", M1]]) {
    fs.mkdirSync(path.join(backupRoot, String(ts)), { recursive: true });
    zcodeLocal.atomicWriteJson(path.join(backupRoot, String(ts), "telemetry-state.json"), { deviceMid: mid });
  }
  ok(zcodeLocal.findOriginalMidFromBackups() === M0, "备份史取最早出现的 live 指纹 M0");
  const anchor = zcodeLocal.getOrCreateAnchor();
  ok(anchor.remoteMid === M0 && Number(anchor.remoteMidSavedAt) > 0, "锚定值初始化为 M0 并记录落锚时间");
  const st0 = zcodeLocal.remoteMidState();
  ok(st0.anchorMid === M0 && st0.liveMid === M0 && st0.claimMode === false, "初始不在领取模式（live = 锚定值）");

  // ⑦ 切号绝不碰指纹（v1.34.0 回归托底）：只换登录态，telemetry 恒为锚定值
  console.log("⑦ 切号不换指纹");
  writeLive(UID_A, M0); // live = A + 锚定指纹 M0
  const parsedA = zcodeLocal.parseCredentials(zcodeLocal.readJson(zcodeLocal.paths().credentials));
  writeLive(UID_B, M1); // 短暂把 live 变成 B，只为产出 B 的凭据快照
  const parsedB2 = zcodeLocal.parseCredentials(zcodeLocal.readJson(zcodeLocal.paths().credentials));
  writeLive(UID_A, M0); // 恢复 live = A
  const idB = storeStub.addAccount({
    channel: "zcode", uid: UID_B, name: "B", token: makeJwt(UID_B), refreshToken: "rt-b",
    meta: { deviceMid: zcodeLocal.derivedDeviceMid(UID_B), sw: zcodeLocal.buildSwitchSnapshot(parsedB2, "", UID_B) },
  });
  storeStub.addAccount({
    channel: "zcode", uid: UID_A, name: "A", token: makeJwt(UID_A), refreshToken: "rt-a",
    meta: { deviceMid: M2, sw: zcodeLocal.buildSwitchSnapshot(parsedA, "", UID_A) },
  });
  const sw = await zcodeSwitch.switchZcodeAccount(idB, { confirmAck: true });
  ok(sw.ok, `切号成功（${(sw.message || "").slice(0, 40)}…）`);
  ok(zcodeLocal.uidFromJwt(zcodeLocal.readLive().jwt) === UID_B, "切号后 live 登录态 = B");
  ok(readMid() === M0, "切号未动指纹（telemetry 恒为锚定值 M0）——远程不失效的核心保证");
  const ds7 = zcodeSwitch.deviceStatus();
  ok(ds7.anchorMid === M0 && ds7.claimMode === false, "deviceStatus 携带 anchorMid/claimMode 扩展字段");

  // ⑧ 领取模式：借出 → 恢复（人工链路的两个动作，客户端进程闸已沙箱跳过）
  console.log("⑧ 领取模式借出与恢复");
  const idA2 = storeStub.listAccounts().find((a) => a.name === "A").id;
  const cm = await zcodeSwitch.enterClaimMode(idA2, {});
  ok(cm.ok && !cm.unchanged && cm.to === M2 && cm.anchorMid === M0, `领取模式借出 A 的专属指纹（${(cm.message || "").slice(0, 30)}…）`);
  ok(readMid() === M2, "借出生效：live = A 专属指纹 M2");
  ok(zcodeLocal.remoteMidState().claimMode === true, "claimMode = true（借出中，远程不可用）");
  const rs = await zcodeSwitch.restoreRemoteMid({});
  ok(rs.ok && rs.to === M0 && rs.from === M2, `恢复锚定指纹（${(rs.message || "").slice(0, 30)}…）`);
  ok(readMid() === M0 && zcodeLocal.remoteMidState().claimMode === false, "恢复后 live = 锚定值，claimMode = false");
  const rs2 = await zcodeSwitch.restoreRemoteMid({});
  ok(rs2.ok && rs2.unchanged, "重复恢复幂等（已是锚定值直接返回）");
  const cm2 = await zcodeSwitch.enterClaimMode("不存在的id", {});
  ok(!cm2.ok, "领取模式对不存在账号如实拒绝");

  // ⑨ WebDAV 锚定备份：未配置时静默 skipped（不抛错、不拖累主流程）
  console.log("⑨ WebDAV 锚定备份兜底");
  const poolsync = require("../electron/backend/proxy/poolsync.cjs");
  ok(typeof poolsync.backupAnchorMid === "function" && typeof poolsync.restoreAnchorMidFromRemote === "function", "poolsync 导出锚定备份/恢复两函数");
  const bk = await poolsync.backupAnchorMid();
  ok(bk && bk.action === "skipped", `未配置 WebDAV 时返回 skipped（${(bk && bk.reason) || ""}）`);

  console.log(failed ? `\n✗ ${failed} 项失败，${pass} 项通过` : `\n✓ 全部 ${pass} 项通过`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("自测异常：", e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});

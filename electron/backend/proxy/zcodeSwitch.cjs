// 反代网关 · ZCode 快捷切号（把号池账号写为本机 ZCode 客户端的当前登录态）
//
// 红线（用户点名）：切号后移动端远程连接地址绝不允许变。机制保证（zcode-switch
// store.rs 生产实证 + 本机实测）：
//   ① 合并式写回 credentials.json——只动 oauth:*/zcodejwttoken/account-provider:* 凭据键，
//      web-remote-control:* 前缀键（relay pass_hash）以 live 原值一字节不动（zcodeLocal.mergeWriteCredentials）；
//   ② setting.json 的 webRemoteControlExternalRelayDevice.deviceSid 不碰（只写 providerFamilyDomain 两键）；
//   ③ telemetry-state.json 的 deviceMid 不碰（与官方客户端同机多账号的真实行为一致）。
// 四道安全闸（在 ideswitch 既有三闸基础上加第④道 relay 专项校验）：
//   ① 切前 sync-back：live 当前凭据若是号池里另一个账号，先把它的最新态回写号池（防丢号）；
//   ② 写前哈希比对：kill 客户端后文件仍被第三方改动 → 作废本次；
//   ③ 原子写 + 回读校验三连（jwt 落位属目标账号 / relay 键原值保留 / 原有非凭据键一个不少）；
//   ④ 失败自动整目录回滚（备份留最近 5 份），另提供 proxy_zcode_switch_rollback 手动逃生。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const store = require("./store.cjs");
const config = require("../config.cjs");
const zcodeLocal = require("./zcodeLocal.cjs");

let switchBusy = false;

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** 切号备份目录：%APPDATA%\AgentHub\proxy\zcode-switch-backup\<时间戳>\（滚动只留 5 份） */
function backupRoot() {
  const dir = path.join(config.dataDir(), "proxy", "zcode-switch-backup");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** v2 目录里切号涉及的四份文件整组备份（存在才拷），返回备份目录 */
function backupV2Files() {
  const p = zcodeLocal.paths();
  const dest = path.join(backupRoot(), String(Date.now()));
  fs.mkdirSync(dest, { recursive: true });
  for (const file of [p.credentials, p.config, p.telemetry, p.setting, p.planCache]) {
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dest, path.basename(file)));
    } catch { /* 单文件备份失败不阻断（回滚时这份缺失即跳过） */ }
  }
  // 滚动清理：只留最近 5 份（备份含凭据密文，无限累积扩大泄漏面）
  try {
    const dirs = fs.readdirSync(backupRoot()).filter((n) => /^\d+$/.test(n)).sort();
    for (const n of dirs.slice(0, Math.max(0, dirs.length - 5))) {
      fs.rmSync(path.join(backupRoot(), n), { recursive: true, force: true });
    }
  } catch { /* 清理失败不阻断 */ }
  return dest;
}

/** 整目录回滚：把备份文件逐个写回 v2 目录（config.json 新代际下切时没动，回滚也带上无害） */
function rollbackFrom(backupDir) {
  const p = zcodeLocal.paths();
  const restored = [];
  for (const name of ["credentials.json", "config.json", "telemetry-state.json", "setting.json", "coding-plan-cache.json"]) {
    const src = path.join(backupDir, name);
    const dest = { "credentials.json": p.credentials, "config.json": p.config, "telemetry-state.json": p.telemetry, "setting.json": p.setting, "coding-plan-cache.json": p.planCache }[name];
    try {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        restored.push(name);
      }
    } catch { /* 单文件回滚失败继续其余，最终结果如实报告 */ }
  }
  return restored;
}

/**
 * 闸① live 凭据回写号池（sync-live-back-to-source 语义）：
 * 切走之前，当前 live 登录的账号若在号池里且有 sw 快照，把 live 的最新凭据回写它的 meta.sw——
 * 用户在官方客户端里重新登录刷新过 token 时，号池里的旧快照不会把新登录态顶掉。
 */
function syncBackLiveToPool(selfId) {
  const live = zcodeLocal.readLive();
  if (!live || !live.jwt) return { synced: false };
  const uid = zcodeLocal.uidFromJwt(live.jwt) || (live.codingPlanKeys[0] && live.codingPlanKeys[0].uid) || "";
  if (!uid) return { synced: false };
  const hit = store.listAccounts("zcode").find((a) => a.uid === uid && a.id !== selfId);
  if (!hit) return { synced: false, uid };
  const meta = { ...(hit.meta || {}) };
  meta.provider = live.provider || meta.provider || "zai";
  meta.sw = zcodeLocal.buildSwitchSnapshot(live, (meta.sw && zcodeLocal.unseal(meta.sw.relayPassHash)) || "", uid);
  // live 凭据本身也最新，顺手更新对话凭据槽位
  const planKey = zcodeLocal.pickPlanKey(live.codingPlanKeys, null);
  store.updateAccount(hit.id, {
    token: live.jwt,
    ...(planKey.plain ? { refreshToken: planKey.plain } : {}),
    meta,
  });
  return { synced: true, uid, accountId: hit.id };
}

/**
 * 切号主流程。opts.confirmAck = true 表示用户已确认「关闭 ZCode 客户端」。
 * 返回 { ok, needConfirm?, probe?, message, backup? }
 */
async function switchZcodeAccount(accountId, opts) {
  if (switchBusy) return { ok: false, channel: "zcode", message: "另一个切号操作正在进行中，请稍候" };
  switchBusy = true;
  try {
    return await doSwitch(accountId, opts || {});
  } finally {
    switchBusy = false;
  }
}

async function doSwitch(accountId, opts) {
  const acc = store.getAccount(accountId);
  if (!acc) throw new Error("账号不存在");
  if (acc.channel !== "zcode") return { ok: false, channel: acc.channel, message: "不是 zcode 渠道账号" };

  // 快照检查：粘贴 JSON/纯 token 导入的账号没有切号快照，如实拒绝并指路
  const target = zcodeLocal.readSwitchSnapshot(acc);
  if (!target) {
    return {
      ok: false,
      channel: "zcode",
      message: "该账号没有切号快照（缺少 oauth 凭据组），仅支持反代调用。请用「从本机软件导入」或「OAuth 登录」补全快照后再切号。",
    };
  }

  // live 文件检查
  const p = zcodeLocal.paths();
  if (!fs.existsSync(p.credentials)) {
    return { ok: false, channel: "zcode", message: "未找到本机 ZCode 登录文件（~/.zcode/v2/credentials.json），请先安装并登录一次 ZCode 客户端" };
  }

  // 进程检查：官方客户端运行中会回写覆盖——先请用户确认关闭（热切换留口：默认关，求证后另行开放）
  const exeFile = zcodeLocal.findZcodeExe();
  if (zcodeLocal.isZcodeRunning()) {
    if (!opts.confirmAck) {
      return {
        ok: false,
        channel: "zcode",
        needConfirm: true,
        message: "ZCode 客户端正在运行，切换需要先关闭它（未保存的会话请先自行保存）。确认关闭客户端并切换吗？",
      };
    }
    if (!zcodeLocal.killZcode(8000)) {
      return { ok: false, channel: "zcode", message: "ZCode 客户端未能在 8 秒内退出，已中止切换（未改动任何文件）。请手动关闭客户端后重试。" };
    }
  }

  // 闸① sync-back：当前 live 账号的最新凭据先回写号池（防丢号）
  const sync = syncBackLiveToPool(acc.id);

  const liveRaw = fs.readFileSync(p.credentials, "utf8");
  const liveJson = JSON.parse(liveRaw); // readLive 已验证过可解析；这里若抛说明刚坏，按失败处理
  const backup = backupV2Files();
  let relaunch = false;
  try {
    // 闸② 写前哈希：备份完毕到动手之间文件被改过 → 作废
    const beforeHash = sha256(liveRaw);
    const nowRaw = fs.readFileSync(p.credentials, "utf8");
    if (sha256(nowRaw) !== beforeHash) {
      return { ok: false, channel: "zcode", backup, message: "登录文件在切号准备期间被改写，已停止覆盖，请重试" };
    }

    // 合并写 credentials.json
    const merged = zcodeLocal.mergeWriteCredentials(target, liveJson);
    zcodeLocal.atomicWriteJson(p.credentials, merged);

    // setting.json 家族域对齐 + 删套餐缓存（新代际不写 config.json；telemetry-state.json 不动）
    zcodeLocal.alignFamilyDomain(target.provider);
    zcodeLocal.resetPlanCache();

    // 闸③+④ 回读校验三连：jwt 落位属目标账号 / relay 键原值保留 / 原有键一个不少；不过 → 整目录回滚
    const verify = zcodeLocal.verifyCredentialsWritten(p.credentials, target, liveJson);
    if (!verify.ok) {
      const restored = rollbackFrom(backup);
      return {
        ok: false,
        channel: "zcode",
        backup,
        message: `写入校验未通过（${verify.message}），已自动回滚到切换前状态${restored.length ? `（恢复 ${restored.join("/")}）` : ""}`,
      };
    }

    // 重启客户端（能定位到 exe 才拉；找不到如实提示手动启动）
    const rel = zcodeLocal.launchZcode(exeFile || undefined);
    relaunch = !!rel.ok;

    // live 有 relay 键而号池快照没有时回填（下次切别的号回来，兜底注入源仍在）
    try {
      const liveRelay = Object.entries(merged).find(([k]) => k === "web-remote-control:external-relay:pass_hash");
      const meta = typeof acc.meta === "string" ? (() => { try { return JSON.parse(acc.meta); } catch { return {}; } })() : { ...(acc.meta || {}) };
      if (liveRelay && meta.sw && !zcodeLocal.unseal(meta.sw.relayPassHash)) {
        meta.sw.relayPassHash = zcodeLocal.seal(String(liveRelay[1] || ""));
        store.updateAccount(acc.id, { meta });
      }
    } catch { /* 回填失败不影响切号结果 */ }

    return {
      ok: true,
      channel: "zcode",
      file: p.credentials,
      backup,
      probe: {
        relayKept: true, // relay 键逐字节保留（闸④已断言，失败到不了这里）
        deviceKept: true, // telemetry-state.json 未动
        syncBack: !!sync.synced,
      },
      relaunched: relaunch,
      message: `已把「${acc.name || acc.uid}」写为本机 ZCode 当前登录态，远程连接地址保持不变（${relaunch ? "客户端已重启" : "请手动启动 ZCode 客户端"}）${sync.synced ? `；原登录账号的最新凭据已回存号池` : ""}`,
    };
  } catch (e) {
    // 未预期的异常同样回滚（宁可不动也不留半拉子状态）
    try {
      rollbackFrom(backup);
    } catch { /* 回滚失败如实报告 */ }
    return { ok: false, channel: "zcode", backup, message: `切号失败：${(e && e.message) || e}（已回滚）` };
  }
}

/** 手动回滚最近一次切号（逃生通道：切出问题 / 远程连接异常时一键还原） */
function rollbackLatest() {
  const root = backupRoot();
  const dirs = fs
    .readdirSync(root)
    .filter((n) => /^\d+$/.test(n))
    .sort();
  if (!dirs.length) return { ok: false, message: "没有可回滚的切号备份" };
  if (zcodeLocal.isZcodeRunning()) {
    return { ok: false, message: "ZCode 客户端正在运行，请先关闭客户端再回滚" };
  }
  const latest = path.join(root, dirs[dirs.length - 1]);
  const restored = rollbackFrom(latest);
  if (!restored.length) return { ok: false, message: "最近一次备份里没有可恢复的文件" };
  return { ok: true, file: latest, message: `已从 ${new Date(Number(dirs[dirs.length - 1])).toLocaleString("zh-CN")} 的备份恢复：${restored.join(" / ")}` };
}

/** 切号能力探测（ideSwitchStatus 的 zcode 段）：装了没 / 当前登录 uid / 是否新代际 */
function zcodeIdeStatus() {
  try {
    const live = zcodeLocal.readLive();
    const p = zcodeLocal.paths();
    return {
      installed: fs.existsSync(p.credentials),
      file: p.credentials,
      uid: live ? zcodeLocal.uidFromJwt(live.jwt) || (live.codingPlanKeys[0] && live.codingPlanKeys[0].uid) || "" : "",
      newGen: zcodeLocal.isNewGen(),
      running: zcodeLocal.isZcodeRunning(),
    };
  } catch {
    return { installed: false, file: "", uid: "", newGen: false, running: false };
  }
}

module.exports = { switchZcodeAccount, rollbackLatest, zcodeIdeStatus, syncBackLiveToPool, backupV2Files, rollbackFrom, backupRoot };

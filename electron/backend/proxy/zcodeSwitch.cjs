/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · ZCode 快捷切号（把号池账号写为本机 ZCode 客户端的当前登录态）
//
// 红线（用户点名）：切号后移动端远程连接地址绝不允许变。机制保证（生产实证 + 本机实测）：
// 生产实证 + 本机实测）：
//   ① 合并式写回 credentials.json——只动 oauth:*/zcodejwttoken/account-provider:* 凭据键，
//      web-remote-control:* 前缀键（relay pass_hash）以 live 原值一字节不动（zcodeLocal.mergeWriteCredentials）；
//   ② setting.json 的 webRemoteControlExternalRelayDevice.deviceSid 不碰（只写 providerFamilyDomain 两键）；
//   ③ telemetry-state.json 的 deviceMid 也不碰——它同时是远程链接的 mid 参数与 relay 设备身份
//      （v1.34.0 曾在切号时换指纹，实测当天远程即被服务端 KICKED 判会话冲突，已回退）。
//      锚定值存 anchor.remoteMid（zcodeLocal.getOrCreateAnchor，终生恒定）。
// 周末套餐领取资格（1004 专项）：资格 = 账号本周未领 ∧ 设备指纹本周未被消耗。AgentHub 自身
// 的领取请求头 X-Device-Mid 按号注入 meta.deviceMid（每号独立），与 live 文件无关。
//
// ⚠️⚠️ 2026-10-28 合规收口（R-7）：**「领取模式」已移除** ⚠️⚠️
//   移除对象：原 `enterClaimMode`（把 live 指纹临时「借出」为目标账号的专属指纹，
//             让用户去官方客户端里绕过「一设备一周一次」的领取限制）。
//   移除日期：2026-10-28
//   依据：docs/号池签到核对-20261028/15-完整修改方案.md §5 R-7（"移除「领取模式」（跨账号借指纹）"）
//         docs/号池签到核对-20261028/11-qoder-zcode-签到核对.md §3
//   事实依据（客户端反编译）：ZCode 客户端的 deviceMid 存在 `.zcode/v2/telemetry-state.json`，
//         **生成一次、终生不轮换**（v1.34.0 曾在切号时换指纹，实测当天远程即被服务端 KICKED）。
//         号池「按 uid 确定性派生 + 可轮换」的指纹是本项目自建的派生规则，**不是客户端行为**；
//         轮换指纹以规避每周一次的资格限制属于**资格规避**，故整条能力从本模块下线。
//   保留的正当语义（**不涉及跨账号借用**）：
//     ① `repairDeviceMid`——**指纹修复**：修复撞车（多账号持有同一指纹导致上游关联），
//        把撞车账号各自的指纹恢复为**该账号自己的稳定值**（重派随机 UUID）。
//     ② `restoreRemoteMid`——**恢复本机锚定指纹**：把 anchor.remoteMid 写回 live telemetry，
//        纯恢复动作；同时是历史遗留「借出中」状态的唯一逃生口（移除后仍必须保留）。
//   备注：本模块只负责能力下线；index.cjs 的 IPC 入口与前端按钮不在本文件授权范围内，
//        残留调用点已在交付回报中逐条列出，交 lead 另行分派移除。
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

/** 当前 live telemetry 的 deviceMid（无则空串） */
function liveDeviceMid() {
  const t = zcodeLocal.readJson(zcodeLocal.paths().telemetry);
  return String((t && t.deviceMid) || "");
}

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

  // 进程检查：官方客户端运行中会回写覆盖——先请用户确认关闭（热切换留口：默认关，求证后另行开放）。
  //   注意 ok 必须为 true：前端 call() 会把 ok:false 当作执行失败直接抛错，那样确认框永远弹不出来。
  //   probe 供确认框展示真实状态（客户端名 / 是否在跑 / 安装路径 / 切完是否自动重启）。
  const exeFile = zcodeLocal.findZcodeExe();
  if (zcodeLocal.isZcodeRunning()) {
    if (!opts.confirmAck) {
      return {
        ok: true,
        channel: "zcode",
        needConfirm: true,
        probe: {
          channel: "zcode",
          clientName: "ZCode",
          file: p.credentials,
          exe: exeFile,
          running: true,
          relaunch: !!exeFile,
          // R-7（2026-10-28）：原提示末句「请切号后再点该账号的『领取模式』」指向已移除的能力，
          // 一并删除——不再把用户指路到已下线的资格规避链路
          note: "切号只写登录态：本机指纹与移动端远程连接保持原样不动。",
          warning: exeFile
            ? "客户端将被关闭，未保存的内容会丢失；切换完成后自动重新打开。"
            : "客户端将被关闭，未保存的内容会丢失；请稍后手动重新打开。",
        },
        message: exeFile
          ? "ZCode 客户端正在运行，切换需要先关闭它，切换完成后会自动重新打开。未保存的会话请先自行保存。确认关闭客户端并切换吗？"
          : "ZCode 客户端正在运行，切换需要先关闭它（未保存的会话请先自行保存）。确认关闭客户端并切换吗？",
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

    // setting.json 家族域对齐 + 删套餐缓存（新代际不写 config.json）
    zcodeLocal.alignFamilyDomain(target.provider);
    zcodeLocal.resetPlanCache();

    // telemetry-state.json 的 deviceMid 刻意不动：它是远程链接的 mid 参数与 relay 设备身份，
    // 变更会被服务端判会话冲突踢线（v1.34.0 实证）。切号只换登录态，指纹恒为锚定值。
    // R-7（2026-10-28）：原注释在此指引「用领取模式（enterClaimMode）人工借出与恢复」——
    // 该能力已移除，指纹不再有任何「借出」路径；指纹修复（repairDeviceMid）与
    // 恢复锚定（restoreRemoteMid）不经过切号流程，也不改写 live 指纹。

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

    const verifySetting = zcodeLocal.verifySettingWritten();
    if (!verifySetting.ok) {
      const restored = rollbackFrom(backup);
      return {
        ok: false,
        channel: "zcode",
        backup,
        message: `配置校验未通过（${verifySetting.message}），已自动回滚到切换前状态${restored.length ? `（恢复 ${restored.join("/")}）` : ""}`,
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
        projectsKept: true, // recentProjects 与 lastWorkspaceSession 跨账号共用已保障
        syncBack: !!sync.synced,
      },
      relaunched: relaunch,
      message: `已把「${acc.name || acc.uid}」写为本机 ZCode 当前登录态，本机指纹与移动端远程连接保持原样，所有项目与历史会话已共用保留（${relaunch ? "客户端已重启" : "请手动启动 ZCode 客户端"}）${sync.synced ? `；原登录账号的最新凭据已回存号池` : ""}。`,
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

/**
 * 设备指纹诊断（只读，不发任何领取请求）：
 * 逐账号给出专属指纹与冲突判定——①与其它账号撞车（同指纹被多号共用，一号领取全组 1004）；
 * ②等于 live 指纹且非当前登录号（当前登录号与 live 指纹相同是正确状态，非冲突）；
 * ③该账号本周资格大概率已被消耗（本机或任何机器上用同指纹领过：preview 有套餐但 claim 必 1004）。
 * 返回 { ok, liveMid, rows: [{ id, name, uid, deviceMid, short, isLive, conflictWith[], liveShared, burnedLikely }] }
 */
function deviceStatus() {
  const midState = zcodeLocal.remoteMidState();
  const liveMid = midState.liveMid;
  const live = zcodeLocal.readLive();
  const liveUid = live ? zcodeLocal.uidFromJwt(live.jwt) || (live.codingPlanKeys[0] && live.codingPlanKeys[0].uid) || "" : "";
  const accounts = store.listAccounts("zcode");
  const ownerByMid = new Map(); // mid -> 首个持有者的行下标（撞车组判定）
  const rows = [];
  for (const a of accounts) {
    const meta = typeof a.meta === "string" ? (() => { try { return JSON.parse(a.meta); } catch { return {}; } })() : a.meta || {};
    const mid = String(meta.deviceMid || "");
    const isLive = !!liveUid && a.uid === liveUid;
    const row = {
      id: a.id,
      name: a.name || "",
      uid: a.uid || "",
      deviceMid: mid,
      short: mid ? mid.slice(0, 8) : "（无）",
      isLive,
      conflictWith: [],
      liveShared: false,
      burnedLikely: false,
    };
    if (mid) {
      if (ownerByMid.has(mid)) {
        const firstIdx = ownerByMid.get(mid);
        row.conflictWith.push(firstIdx);
        if (!rows[firstIdx].conflictWith.includes(rows.length)) rows[firstIdx].conflictWith.push(rows.length);
      } else {
        ownerByMid.set(mid, rows.length);
      }
    }
    rows.push(row);
  }
  for (const row of rows) {
    // live 共享：指纹等于 live 且本人不是当前登录号 → 该指纹的任何消耗都在烧 live 号的资格
    row.liveShared = !!liveMid && row.deviceMid === liveMid && !row.isLive;
    if (row.liveShared) row.burnedLikely = true;
    // 撞车组：同指纹任一账号完成过一次领取，全组当周资格即被消耗（服务端设备维判据）
    if (row.conflictWith.length) row.burnedLikely = true;
  }
  return {
    ok: true,
    liveMid,
    // 远程锚定指纹与「live 偏离锚定」状态。
    // R-7（2026-10-28）：「领取模式」（enterClaimMode）已移除，**不再有任何新建借出态的路径**；
    // 但 `claimMode` 字段名与语义必须原样保留——前端（ProxyAgentsView.vue）与
    // src/types/index.ts 在读它，且历史上已进入借出态的用户仍需靠它看到「恢复本机指纹」入口。
    // 因此它现在的含义是「live 指纹 ≠ 锚定值」的**遗留状态指示**，不是可进入的模式开关。
    anchorMid: midState.anchorMid,
    anchorSavedAt: midState.anchorSavedAt,
    claimMode: midState.claimMode,
    rows,
  };
}

/**
 * 设备指纹修复（幂等）：撞车/疑似被烧的账号重派全新随机 UUID。
 * 三条铁律：
 *   ① 撞车组整组重派（不跳过 live 号）——留着确定性派生指纹会把「下周再撞」埋在原地；
 *      live 文件的 deviceMid 绝不在此流程改写（写 live 是切号动作的专属职责），
 *      live 号的库内指纹换新后，live 文件自然脱离撞车组，下次切号时才落位新指纹；
 *   ② all=true 时把「确定性派生指纹」也一并换成随机指纹（彻底切断跨机可复算关联）；
 *   ③ live 指纹被池外占坑（池内某号持有 liveMid 但 live 号不在池里）：重派占坑号即可，
 *      不动 live 文件（官方客户端自己在用这枚指纹，改它会干扰官方遥测）。
 * 返回 { ok, repaired, rows }（rows 为修复后的最新诊断行）
 */
function repairDeviceMid(opts) {
  const all = !!(opts && opts.all);
  const st = deviceStatus();
  const used = new Set(st.rows.map((r) => r.deviceMid).filter(Boolean));
  if (st.liveMid) used.add(st.liveMid);
  let repaired = 0;
  for (const row of st.rows) {
    const derived = !!row.uid && row.deviceMid === zcodeLocal.derivedDeviceMid(row.uid);
    const need = !row.deviceMid || row.conflictWith.length > 0 || row.burnedLikely || (all && derived && !row.isLive);
    if (!need) continue;
    let fresh = crypto.randomUUID();
    while (used.has(fresh)) fresh = crypto.randomUUID();
    used.add(fresh);
    try {
      const acc = store.getAccount(row.id);
      if (!acc) continue;
      const meta = typeof acc.meta === "string" ? (() => { try { return JSON.parse(acc.meta); } catch { return {}; } })() : { ...(acc.meta || {}) };
      meta.deviceMid = fresh;
      store.updateAccount(row.id, { meta });
      repaired++;
    } catch { /* 单账号失败不拖垮整批 */ }
  }
  const finalSt = deviceStatus();
  return { ok: true, repaired, rows: finalSt.rows, liveMid: finalSt.liveMid };
}

/** 锚定指纹上云（fire-and-forget）：WebDAV 未配置/网络失败都静默，备份是副业不拖累主流程。
 *  R-7（2026-10-28）：领取模式已移除，调用方只剩 restoreRemoteMid，注释同步改写。 */
function backupAnchorMidQuiet() {
  try {
    Promise.resolve(require("./poolsync.cjs").backupAnchorMid()).catch(() => {});
  } catch { /* 模块不可用不影响指纹恢复 */ }
}

/** 指纹恢复专用进程闸（R-7 前是「领取模式通用进程闸」，因领取模式已移除而收窄为单一调用方）：
 *  客户端在跑且未确认时返回 needConfirm 探针（结构对齐切号确认框）；
 *  已确认则先杀客户端，返回 { exeFile } 表示可以动手。杀不掉返回 { fail } */
function claimProcessGate(opts, noteText) {
  const exeFile = zcodeLocal.findZcodeExe();
  if (zcodeLocal.isZcodeRunning()) {
    if (!opts || !opts.confirmAck) {
      return {
        needConfirm: true,
        probe: {
          channel: "zcode",
          clientName: "ZCode",
          file: zcodeLocal.paths().credentials,
          exe: exeFile,
          running: true,
          relaunch: !!exeFile,
          note: noteText,
          warning: exeFile
            ? "客户端将被关闭，未保存的内容会丢失；完成后自动重新打开。"
            : "客户端将被关闭，未保存的内容会丢失；请稍后手动重新打开。",
        },
      };
    }
    if (!zcodeLocal.killZcode(8000)) {
      return { fail: "ZCode 客户端未能在 8 秒内退出，已中止（未改动任何文件）。请手动关闭客户端后重试。" };
    }
  }
  return { exeFile };
}

/**
 * 【已移除】「领取模式」（原 enterClaimMode）—— 2026-10-28 合规收口 R-7。
 *
 * 移除理由（依据 docs/号池签到核对-20261028/11-qoder-zcode-签到核对.md §3 与
 * 05-pool-probing-audit.md R-7）：
 *   · 原能力把**本机 live 指纹临时借出为目标账号的专属指纹**，目的是规避 ZCode
 *     「一设备一周一次」的领取限制 —— 属**资格规避**，不是账号管理；
 *   · 客户端事实：ZCode 3.16.3 的 `deviceMid` 存在 `.zcode/v2/telemetry-state.json`，
 *     **生成一次、终生不轮换**（`randomUUID()` 落盘）。因此「轮换/借出指纹」是号池
 *     自建的能力，**不是**复刻客户端行为。
 *
 * 保留函数名与签名（返回明确的「已移除」结果），避免既有 IPC 调用方抛
 * `is not a function`——前端按钮会看到清晰文案而非崩溃。
 * 与「指纹修复」的区别：`repairDeviceMid` 只把撞车账号恢复为**它自己的**稳定指纹，
 * 不涉及任何跨账号借用，故**保留**。
 */
async function enterClaimMode() {
  return {
    ok: false,
    channel: "zcode",
    removed: true,
    message: "「领取模式」（跨账号借用设备指纹以规避每周领取限制）已于 2026-10-28 移除：该能力属资格规避，不在「仅做账号管理」的范围内。如需多账号领取，请在官方客户端逐个账号正常操作。",
  };
}

/**
 * 恢复本机锚定指纹：把 anchor.remoteMid 写回 live telemetry-state.json，
 * 客户端重启后 relay 以锚定指纹重新连上（与 deviceSid 的服务端绑定一致），手机远程恢复。
 *
 * R-7（2026-10-28）保留说明：本函数原为「领取模式收尾」，但**它本身不做任何跨账号借用**——
 * 只把本机自己的锚定值写回，属于「指纹恢复/修复」语义，故不随领取模式一起下线。
 * 保留它还有一个硬理由：领取模式存在期间已进入「借出态」（live ≠ anchor）的用户，
 * 移除 enterClaimMode 后本函数是他们把指纹恢复为锚定值的**唯一逃生口**。
 */
async function restoreRemoteMid(opts) {
  const anchor = zcodeLocal.getOrCreateAnchor();
  const target = String(anchor.remoteMid || "");
  if (!target) return { ok: false, channel: "zcode", message: "还没有本机锚定指纹可恢复（从未锚定过）" };
  if (liveDeviceMid() === target) {
    return { ok: true, channel: "zcode", unchanged: true, anchorMid: target, relaunched: false, message: "本机指纹已是锚定值，无需恢复" };
  }

  const gate = claimProcessGate(opts, "本机指纹将恢复为锚定值，手机远程连接随之恢复；客户端需要先关闭并重新打开。");
  if (gate.needConfirm) {
    return {
      ok: true,
      channel: "zcode",
      needConfirm: true,
      probe: gate.probe,
      message: "ZCode 客户端正在运行，恢复本机指纹需要先关闭它（写完自动重新打开）。确认吗？",
    };
  }
  if (gate.fail) return { ok: false, channel: "zcode", message: gate.fail };

  const r = zcodeLocal.restoreRemoteMid();
  if (!r.ok) return { ok: false, channel: "zcode", message: r.message || "本机指纹恢复失败" };
  const rel = zcodeLocal.launchZcode(gate.exeFile || undefined);
  backupAnchorMidQuiet();
  return {
    ok: true,
    channel: "zcode",
    from: r.from,
    to: target,
    anchorMid: target,
    relaunched: !!rel.ok,
    message: `已恢复本机锚定指纹（${target.slice(0, 8)}…），客户端${rel.ok ? "已重启" : "请手动启动"}。手机远程连接回到锚定状态。`,
  };
}

/** 切号能力探测（ideSwitchStatus 的 zcode 段）：装了没 / 当前登录 uid / 是否新代际。
 *  刻意不探进程存活：isZcodeRunning 是同步 tasklist（约 350ms），而本函数被高频的 ideSwitchStatus
 *  调用（号池页每次刷新都走），会把主进程反复堵死，且该字段没有任何消费方。切号要用的实时存活
 *  判断由 precheckSwitch 直接调 zcodeLocal.isZcodeRunning() 完成——每次切号只探一次，可以接受 */
function zcodeIdeStatus() {
  try {
    const live = zcodeLocal.readLive();
    const p = zcodeLocal.paths();
    return {
      installed: fs.existsSync(p.credentials),
      file: p.credentials,
      uid: live ? zcodeLocal.uidFromJwt(live.jwt) || (live.codingPlanKeys[0] && live.codingPlanKeys[0].uid) || "" : "",
      newGen: zcodeLocal.isNewGen(),
    };
  } catch {
    return { installed: false, file: "", uid: "", newGen: false };
  }
}

module.exports = { switchZcodeAccount, rollbackLatest, zcodeIdeStatus, syncBackLiveToPool, backupV2Files, rollbackFrom, backupRoot, deviceStatus, repairDeviceMid, enterClaimMode, restoreRemoteMid };

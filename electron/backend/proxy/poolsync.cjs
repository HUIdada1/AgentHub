// 反代网关 · 号池 WebDAV 同步引擎：多设备共享号池（账号 + 凭据）
// 远端布局（root 默认 /agenthub-proxy，与技能仓库 /agent-skills、用量统计 /dosage-sync 同盘隔离）：
//   pool/devices/<deviceId>.json     设备档案
//   pool/archives/<deviceId>.zip     该设备号池快照：accounts.json 经 AES-256-GCM 加密后打成 zip
//   pool/tombstones.json             删除墓碑（accountKey → 删除时间），传播「移除账号」
// 规矩：
// - 压缩包加密口令 = 统一 WebDAV 密码（scrypt 固定盐派生 AES-256 密钥），换密码后历史包
//   自动标记 keyChange，下次同步重打包；token 出本机前先用 DPAPI 解密、再进加密包，绝不明文上传
// - 自动去重：账号身份 = channel:uid（uid 缺失时 channel:name）；本机已有 → 仅按 credits_at
//   新者胜刷新额度/有效期等动态字段（本机启停与冷却状态不被远端覆盖）；本机没有 → 直接入池
// - 删除传播：本机移除账号写墓碑，他机拉取后按墓碑移除同身份账号
"use strict";
const fs = require("node:fs");
const path = require("path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const config = require("../config.cjs");
const store = require("./store.cjs");
const webdav = require("../webdav.cjs");
const rules = require("./rules.cjs");
const zip = require("../zip.cjs");
const events = require("./events.cjs");

const POOL_DIR = "pool";
const ZIP_ENTRY = "accounts.json";
const KDF_SALT = "agenthub-proxy-pool-v1"; // 固定盐：同密码各机器派生同密钥，才能互解
const FILE_FORMAT = "agenthub-proxy-pool@1";

const STAGE_LABEL = {
  idle: "空闲",
  connect: "连接检查",
  pull: "拉取",
  merge: "合并",
  upload: "上传",
  done: "完成",
  cancelled: "已取消",
  error: "失败",
};

// 阶段进度百分比（同步页进度条用）：按阶段给稳定锚点，细节文案仍走 detail
const STAGE_PERCENT = {
  idle: 0,
  connect: 5,
  pull: 25,
  merge: 55,
  upload: 80,
  done: 100,
  cancelled: 100,
  error: 100,
};

let state = { running: false, stage: "idle", detail: "", lastError: "", lastSyncAt: 0, lastSummary: "", percent: 0, channel: "" };
let cancelSignal = null;

// ===== 同步状态持久化（proxy/sync-state.json：上次同步时间 / 上传记账 / 合并记账） =====

function stateFile() {
  return path.join(store.proxyDir(), "sync-state.json");
}

function loadPersisted() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return {
      lastSyncAt: Number(s.lastSyncAt) || 0,
      uploadedHash: typeof s.uploadedHash === "string" ? s.uploadedHash : "",
      uploadedFor: typeof s.uploadedFor === "string" ? s.uploadedFor : "", // 记账绑定的远端（endpoint+root+密钥指纹）
      merged: s.merged && typeof s.merged === "object" ? s.merged : {},     // deviceId → 已合并包的内容 hash
      keyChangeAt: Number(s.keyChangeAt) || 0, // 统一密码改动时间：早于它的历史包全部重打
      uploadedAnchorHash: typeof s.uploadedAnchorHash === "string" ? s.uploadedAnchorHash : "", // 锚定指纹上传记账（内容未变不重传）
      uploadedAnchorFor: typeof s.uploadedAnchorFor === "string" ? s.uploadedAnchorFor : "",
      // 共享配置（模型映射 + API Key）记账：appliedAt 做 LWW 判定，hash 做「内容未变不重传」
      sharedAppliedAt: Number(s.sharedAppliedAt) || 0,
      sharedHash: typeof s.sharedHash === "string" ? s.sharedHash : "",
    };
  } catch {
    return { lastSyncAt: 0, uploadedHash: "", uploadedFor: "", merged: {}, keyChangeAt: 0, uploadedAnchorHash: "", uploadedAnchorFor: "", sharedAppliedAt: 0, sharedHash: "" };
  }
}

function savePersisted(s) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2), "utf8");
  } catch { /* 记账写失败不影响当次同步结果 */ }
}

function progress() {
  const p = loadPersisted();
  return {
    running: state.running,
    stage: state.stage,
    stageLabel: STAGE_LABEL[state.stage] || state.stage,
    detail: state.detail,
    lastError: state.lastError,
    lastSyncAt: state.lastSyncAt || p.lastSyncAt || 0,
    lastSummary: state.lastSummary,
    percent: state.percent ?? (STAGE_PERCENT[state.stage] ?? 0),
    channel: state.channel || "",
    configured: configured(),
    deviceId: deviceId(),
    deviceName: deviceName(),
  };
}

function setStage(stage, detail) {
  state.stage = stage;
  state.detail = detail || "";
  state.percent = STAGE_PERCENT[stage] ?? state.percent ?? 0;
  events.emit({ type: "poolsync", stage, detail: state.detail, running: state.running, percent: state.percent });
}

function cancel() {
  if (cancelSignal) cancelSignal.abort();
  return { ok: true };
}

// ===== 配置与身份 =====

/** 号池同步用的完整 webdav 配置（统一服务器 + proxy 根目录） */
function wd() {
  return config.moduleWebdav("proxy");
}

function configured() {
  const w = wd();
  return !!(w.endpoint && w.username && w.password);
}

/** 本机设备身份：复用框架 webdav.deviceId/deviceName（与技能仓库同一台设备同一个 id） */
function deviceId() {
  return config.loadConfig().webdav.deviceId;
}
function deviceName() {
  return config.loadConfig().webdav.deviceName || "这台电脑";
}

function remoteUrl(w, ...segs) {
  return webdav.joinUrl(w.endpoint, w.root, segs.join("/"));
}

// ===== 账号快照导出 / 导入 =====

/** 账号身份键：channel:uid（uid 缺失时退回 channel:name，手动粘贴无 uid 的账号也能去重） */
function accountKeyOf(a) {
  return `${a.channel}:${a.uid || "name:" + (a.name || "")}`;
}

/** 导出前元数据脱敏/明文化：DPAPI 密文无法跨机解密，将切号快照等敏感字段还原为明文 JSON 结构。
 *  由于快照整体会打入 AES-256-GCM 加密压缩包，凭据在网络传输与存储中受统一密码严格保护。 */
function prepareMetaForExport(meta, channel) {
  if (!meta || typeof meta !== "object") return {};
  const cloned = JSON.parse(JSON.stringify(meta));
  if (channel === "zcode" && cloned.sw && typeof cloned.sw === "object") {
    try {
      const zl = require("./zcodeLocal.cjs");
      cloned.sw = {
        accessToken: zl.unseal(cloned.sw.accessToken),
        refreshToken: zl.unseal(cloned.sw.refreshToken),
        userInfo: zl.unseal(cloned.sw.userInfo),
        codingPlanKeys: zl.unseal(cloned.sw.codingPlanKeys),
        relayPassHash: zl.unseal(cloned.sw.relayPassHash),
        _plain: true,
      };
    } catch { /* 解密异常保留原样 */ }
  }
  return cloned;
}

/** 导入时元数据本地化：对明文切号快照使用本机 DPAPI 重新封信（seal），确保存入库中的凭据在当前机器上能被 ideswitch 解密切号 */
function restoreMetaForLocal(meta, channel) {
  if (!meta || typeof meta !== "object") return {};
  const cloned = JSON.parse(JSON.stringify(meta));
  if (channel === "zcode" && cloned.sw && typeof cloned.sw === "object") {
    try {
      const zl = require("./zcodeLocal.cjs");
      const sw = cloned.sw;
      // 只要带有 _plain 标记，或者字段存在且不以本机 ZSEAL 密文前缀开头，就重新封信
      const needsSeal = sw._plain || (!String(sw.accessToken || "").startsWith("ZCV1:enc:v1:") && (sw.accessToken || sw.refreshToken || sw.codingPlanKeys));
      if (needsSeal) {
        cloned.sw = {
          accessToken: zl.seal(sw.accessToken),
          refreshToken: zl.seal(sw.refreshToken),
          userInfo: zl.seal(sw.userInfo),
          codingPlanKeys: zl.seal(sw.codingPlanKeys),
          relayPassHash: zl.seal(sw.relayPassHash),
        };
      }
    } catch { /* 封信异常保留原样 */ }
  }
  return cloned;
}

/** 导出本机号池为快照对象：token/refreshToken 及切号快照为解密后的明文（只进加密包，绝不上明文）。
 *  channel 给定时只导出该渠道（同步页支持「只同步某一个编译器」）。
 *  凭据为空的账号跳过：把空号打进加密包会传播到所有设备（他机拿到的是无凭据坏号） */
function exportPool(channel) {
  const accounts = store
    .listAccounts()
    .map((view) => {
      if (channel && view.channel !== channel) return null;
      const row = store.getAccount(view.id);
      if (!row) return null;
      const secrets = store.accountSecrets(row);
      if (!secrets.token) return null;
      const rawUpdatedAt = row.updated_at || view.updatedAt || Math.max(view.creditsAt || 0, view.lastUsed || 0, view.createdAt || 0);
      return {
        key: accountKeyOf(view),
        channel: view.channel,
        uid: view.uid || "",
        name: view.name || "",
        token: secrets.token || "",
        refreshToken: secrets.refreshToken || "",
        expiresAt: view.expiresAt || 0,
        credits: view.credits || 0,
        creditsAt: view.creditsAt || 0,
        source: view.source || "paste",
        meta: prepareMetaForExport(view.meta, view.channel),
        updatedAt: rawUpdatedAt,
      };
    })
    .filter(Boolean);
  return { format: FILE_FORMAT, deviceId: deviceId(), deviceName: deviceName(), exportedAt: Date.now(), channel: channel || "", accounts };
}

/** 快照 → 加密 zip：JSON → gzip 由 zip deflate 承担，加密用 AES-256-GCM（scrypt 派生密钥）。
 *  封套本体与共享配置共用 encodeEnvelope（同一 magic/派生参数）：两处各写一份的话，
 *  改一处忘一处就是「同一个密码，一边打得开一边打不开」 */
function encodeArchive(snapshot, password) {
  return encodeEnvelope(snapshot, password);
}

/** 加密 zip → 快照：封套由 decodeEnvelope 解，这里只做号池快照的形状校验与错误归类
 *  （结构错误 / 密码不对 / 内容损坏分别给出可读错误） */
function decodeArchive(buf, password) {
  // 封套层错误原样抛出（缺条目/封套损坏/解密失败三条文案都已经可读），这里只管号池快照的形状
  const snap = decodeEnvelope(buf, password);
  if (!snap || snap.format !== FILE_FORMAT || !Array.isArray(snap.accounts)) throw new Error("快照格式不识别");
  return snap;
}

function sha1(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

/** 加密口令指纹：WebDAV 密码的散列（不存明文、不存可逆值），用于判断历史包是不是当前密码打的 */
function keyFingerprint(password) {
  // scrypt 派生而非快速 SHA-256：指纹存本地 sync-state.json，快速哈希对弱口令可被离线爆破
  return crypto.scryptSync(String(password || ""), KDF_SALT + "|fingerprint", 32).toString("hex").slice(0, 16);
}

// ===== 合并（自动处理冲突：有效性仲裁 + 时间戳新者胜 LWW，保证多端凭据同步与切号登录可用） =====

/**
 * 把远端快照合并进本机号池：
 * 1. 本机无同身份账号：整号入池，快照敏感字段使用本机 DPAPI 重新封信；
 * 2. 本机已有同身份账号：自动冲突处理
 *    - 凭据有效性裁决（Validity First）：本机过期/失效而远端有效 → 自动采用远端凭据；远端过期而本机有效 → 保留本机
 *    - 时间戳裁决（Last-Write-Wins）：均有效时，以 updatedAt 较新者胜
 *    - 采纳远端新凭据后，自动重置冷却（cool_until=0）、清除上游错误记录并恢复状态为 online
 *    - 动态额度按 creditsAt 新者胜刷新；自定义备注名按修改时间覆盖
 * 返回 { added, updated, skipped }
 */
function mergeSnapshot(snap, channel) {
  const tombstones = readLocalTombstones();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const now = Date.now();
  const localByKey = new Map(store.listAccounts().map((a) => [accountKeyOf(a), a]));

  for (const ra of snap.accounts) {
    if (!ra || typeof ra.key !== "string" || !ra.key) continue;
    if (channel && ra.channel !== channel) continue; // 只同步指定渠道：其余渠道的远端账号不动
    const raUpdatedAt = Number(ra.updatedAt || 0);

    // 墓碑命中且本机没有该账号：尊重删除，不回捞
    const local = localByKey.get(ra.key);
    if (!local) {
      if (tombstones[ra.key] && Number(tombstones[ra.key]) >= raUpdatedAt) continue;
      // 远端空凭据不入池：无 token 的账号不可调度，还会继续向下一台设备传播坏号
      if (!ra.token) {
        skipped++;
        continue;
      }
      store.addAccount({
        channel: ra.channel,
        uid: ra.uid || "",
        name: ra.name || "",
        token: ra.token || "",
        refreshToken: ra.refreshToken || "",
        source: ra.source || "paste",
        expiresAt: ra.expiresAt || 0,
        meta: restoreMetaForLocal(ra.meta, ra.channel),
        updatedAt: raUpdatedAt || now,
      });
      added++;
      continue;
    }

    // 本机已有同身份账号：自动冲突仲裁
    const localRow = store.getAccount(local.id);
    const localSecrets = localRow ? store.accountSecrets(localRow) : { token: "", refreshToken: "" };
    const localUpdatedAt = Number(local.updatedAt || local.creditsAt || local.lastUsed || local.createdAt || 0);

    // 检查凭据是否实质不同
    const tokenDiffers = (ra.token || "") !== (localSecrets.token || "") || (ra.refreshToken || "") !== (localSecrets.refreshToken || "");

    // 凭据有效性判定：expiresAt 明确过期或 relogin 判定为无效
    const localHasToken = !!local.hasToken && !!localSecrets.token;
    const localExpired = local.expiresAt > 0 && local.expiresAt <= now;
    const localInvalid = !localHasToken || localExpired || local.status === "relogin";

    const remoteHasToken = !!ra.token;
    const remoteExpired = ra.expiresAt > 0 && ra.expiresAt <= now;
    const remoteValid = remoteHasToken && !remoteExpired;

    let adoptRemoteCreds = false;
    if (tokenDiffers && remoteHasToken) {
      if (localInvalid && remoteValid) {
        // 规则 1：本机凭据已失效或过期，远端凭据有效 → 远端胜出
        adoptRemoteCreds = true;
      } else if (!remoteValid && !localInvalid) {
        // 规则 2：远端已过期，本机凭据有效 → 坚决保护本机可用凭据
        adoptRemoteCreds = false;
      } else {
        // 规则 3：两端均有效（或均无到期时间），以时间戳新者胜（LWW）
        if (raUpdatedAt > localUpdatedAt) {
          adoptRemoteCreds = true;
        }
      }
    }

    const patch = {};

    if (adoptRemoteCreds) {
      patch.token = ra.token;
      patch.refreshToken = ra.refreshToken || "";
      patch.expiresAt = ra.expiresAt || 0;
      patch.meta = restoreMetaForLocal(ra.meta, ra.channel);
      patch.updatedAt = raUpdatedAt || now;
      // 只要采纳了远端较新且有效的凭据，重置冷却与解除上游错误，自愈恢复调度
      patch.coolUntil = 0;
      patch.coolReason = "";
      if (local.status === "relogin" || local.status === "cooling") {
        patch.status = "online";
      }
      store.clearError(local.id);
    } else {
      // 不换凭据时，若本机切号快照缺失（如纯 token 导入）而远端带有快照，补充切号快照
      if (ra.channel === "zcode" && ra.meta && ra.meta.sw) {
        const localMeta = local.meta || {};
        if (!localMeta.sw || !localMeta.sw.accessToken) {
          patch.meta = restoreMetaForLocal({ ...localMeta, sw: ra.meta.sw, deviceMid: localMeta.deviceMid || ra.meta.deviceMid }, ra.channel);
        }
      }
    }

    // 动态字段 LWW（credits_at 新者胜）
    if (Number(ra.creditsAt || 0) > Number(local.creditsAt || 0)) {
      patch.credits = ra.credits;
      patch.creditsAt = ra.creditsAt;
      if (adoptRemoteCreds) patch.expiresAt = ra.expiresAt;
    }

    // 自定义备注名：远端修改时间更新时覆盖本机
    if (typeof ra.name === "string" && ra.name && ra.name !== local.name && raUpdatedAt > localUpdatedAt) {
      patch.name = ra.name;
    }

    if (Object.keys(patch).length) {
      store.updateAccount(local.id, patch);
      updated++;
    }
  }
  return { added, updated, skipped };
}

/** 应用远端墓碑：移除本机同身份账号（账号当时有未同步更新也不拦——删除是显式操作，理当生效） */
function applyTombstones(remote, channel) {
  let removed = 0;
  const accounts = store.listAccounts();
  for (const [key, at] of Object.entries(remote || {})) {
    if (channel && !key.startsWith(`${channel}:`)) continue; // 只同步指定渠道：其他渠道墓碑不动
    const local = accounts.find((a) => accountKeyOf(a) === key);
    if (!local) continue;
    // 本机账号比墓碑新（删完后又重新添加了同身份账号）：不删，并视为复活（下面合并墓碑时本机包会盖过它）
    if (Number(local.creditsAt || local.createdAt || 0) > Number(at)) continue;
    if (store.removeAccount(local.id)) removed++;
  }
  return removed;
}

// ===== 墓碑（本地暂存 + 远端合并） =====

function tombstoneFile() {
  return path.join(store.proxyDir(), "pool-tombstones.json");
}

function readLocalTombstones() {
  try {
    const s = JSON.parse(fs.readFileSync(tombstoneFile(), "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

function writeLocalTombstones(t) {
  try {
    fs.writeFileSync(tombstoneFile(), JSON.stringify(t, null, 2), "utf8");
  } catch { /* 忽略 */ }
}

/** 供 index.cjs 在删除账号时调用：记录墓碑（值为删除时间戳），同步时推给远端 */
function noteRemoved(accountKey) {
  if (!accountKey) return;
  const t = readLocalTombstones();
  t[accountKey] = Date.now();
  writeLocalTombstones(t);
}

// ===== 同步主流程 =====

async function run(opts) {
  if (state.running) throw new Error("号池同步已在进行中");
  const channel = String((opts && opts.channel) || "");
  if (channel && !store.CHANNELS.some((c) => c.id === channel)) throw new Error(`未知渠道 "${channel}"`);
  const w = wd();
  if (!configured()) throw new Error("WebDAV 未配置完整：请先在「设置 · 数据存储」配置统一服务器");
  // 号池压缩包用 WebDAV 密码加密：未设密码时拒绝同步，避免凭据裸奔
  if (!w.password) throw new Error("请先在「设置 · 数据存储」填写 WebDAV 密码（号池压缩包用它加密）");

  state = { ...state, running: true, stage: "connect", detail: "", lastError: "", percent: 0, channel };
  cancelSignal = new AbortController();
  webdav.setActiveSignal(cancelSignal.signal);
  const persisted = loadPersisted();
  const myId = deviceId();
  const myName = deviceName();
  const result = { pulled: 0, added: 0, updated: 0, removed: 0, skipped: 0, uploaded: false, skippedUpload: false };

  try {
    // ---- 连接检查 + 远端目录就绪 ----
    setStage("connect", "检查远端连接…");
    const t = await webdav.test(w);
    if (!t.ok) throw new Error(t.message);
    await webdav.ensureDir(remoteUrl(w, POOL_DIR, "devices"), w);
    await webdav.ensureDir(remoteUrl(w, POOL_DIR, "archives"), w);

    // ---- 拉取：其他设备的号池压缩包 + 远端墓碑 ----
    setStage("pull", channel ? `拉取远端号池（仅 ${store.channelDisplay(channel)}）…` : "拉取远端号池…");
    const archDir = remoteUrl(w, POOL_DIR, "archives");
    const archList = (await webdav.list(archDir, w)).filter((e) => !e.isDir && e.name.endsWith(".zip"));
    const remoteTombText = await webdav.getText(remoteUrl(w, POOL_DIR, "tombstones.json"), w);
    let remoteTomb = {};
    try { remoteTomb = remoteTombText ? JSON.parse(remoteTombText) : {}; } catch { remoteTomb = {}; }

    // ---- 合并：逐设备解密合并（内容未变的包按记账跳过；渠道过滤时记账键带渠道，防漏合他渠道） ----
    for (const e of archList) {
      checkAborted();
      const devId = e.name.replace(/\.zip$/, "");
      if (devId === myId) continue;
      const buf = await webdav.get(remoteUrl(w, POOL_DIR, "archives", e.name), w);
      if (!buf) continue;
      const hash = sha1(buf);
      const mergeKey = devId + (channel ? `|${channel}` : "");
      if (persisted.merged[mergeKey] === hash) continue; // 内容未变，上次已合并过
      try {
        const snap = decodeArchive(buf, w.password);
        const m = mergeSnapshot(snap, channel);
        result.pulled++;
        result.added += m.added;
        result.updated += m.updated;
        result.skipped += m.skipped || 0;
        persisted.merged[mergeKey] = hash; // 成功合并才记账，坏包下轮重试
      } catch (err) {
        // 密码不一致/包损坏：跳过该设备但不阻断整体同步
        events.emit({ type: "poolsync", stage: state.stage, detail: `跳过「${devId.slice(0, 8)}」的号池包：${err.message}`, running: true, percent: state.percent });
      }
    }

    // ---- 墓碑：远端生效到本机 + 双向合并推回 ----
    setStage("merge", "合并删除墓碑…");
    result.removed = applyTombstones(remoteTomb, channel);
    const localTomb = readLocalTombstones();
    const mergedTomb = { ...remoteTomb };
    let tombDirty = false;
    for (const [k, at] of Object.entries(localTomb)) {
      if (!mergedTomb[k] || Number(at) > Number(mergedTomb[k])) {
        mergedTomb[k] = at;
        tombDirty = true;
      }
    }
    // 30 天前的墓碑清理（号池条目存活周期内足够传播）
    const cutoff = Date.now() - 30 * 86400000;
    for (const [k, at] of Object.entries(mergedTomb)) {
      if (Number(at) < cutoff) {
        delete mergedTomb[k];
        delete localTomb[k];
        tombDirty = true;
      }
    }
    writeLocalTombstones(localTomb);
    if (tombDirty || !remoteTombText) {
      await webdav.put(remoteUrl(w, POOL_DIR, "tombstones.json"), w, JSON.stringify(mergedTomb));
    }

    // ---- 上传：本机号池打成加密压缩包（内容未变且未换密码则跳过） ----
    setStage("upload", channel ? `打包上传本机号池（仅 ${store.channelDisplay(channel)}）…` : "打包上传本机号池…");
    checkAborted();
    const snapshot = exportPool(channel);
    const zipBuf = encodeArchive(snapshot, w.password);
    const hash = sha1(zipBuf);
    const fp = keyFingerprint(w.password);
    const remoteKey = `${w.endpoint}|${w.root}|${channel || "*"}|${fp}`;
    // 上传跳过条件：内容 hash 一致 + 同远端 + 同渠道范围 + 同密码 + 打包时间晚于密码改动时间
    if (persisted.uploadedHash === hash && persisted.uploadedFor === remoteKey && persisted.lastSyncAt >= persisted.keyChangeAt) {
      result.skippedUpload = true;
    } else {
      await webdav.put(remoteUrl(w, POOL_DIR, "archives", `${myId}.zip`), w, zipBuf);
      persisted.uploadedHash = hash;
      persisted.uploadedFor = remoteKey;
      result.uploaded = true;
    }
    // 设备档案（每次同步都推，lastSyncAt 本来就该更新）
    await webdav.put(remoteUrl(w, POOL_DIR, "devices", `${myId}.json`), w,
      JSON.stringify({ name: myName, appVersion: appVersion(), accountCount: snapshot.accounts.length, channel: channel || "", lastSyncAt: new Date().toISOString() }));

    await runSharedSync(w, persisted, result);
    persisted.lastSyncAt = Date.now();
    savePersisted(persisted);
    state.lastSyncAt = persisted.lastSyncAt;
    state.lastSummary = `${channel ? store.channelDisplay(channel) + " · " : ""}拉取 ${result.pulled} 台设备 · 新增 ${result.added} · 刷新 ${result.updated} · 移除 ${result.removed} · ${result.uploaded ? "已上传" : "本机无变化"}`;
    state.running = false;
    if (result.sharedSummary) state.lastSummary += " | " + result.sharedSummary;
    setStage("done", state.lastSummary);
    events.emit({ type: "poolsync", stage: "done", detail: state.lastSummary, running: false, percent: 100 });
    events.emit({ type: "status" }); // 号池页刷新
    return { ok: true, ...result, summary: state.lastSummary };
  } catch (e) {
    state.running = false;
    if (e && e.name === "AbortError") {
      state.stage = "cancelled";
      state.detail = "同步已取消";
      events.emit({ type: "poolsync", stage: "cancelled", running: false, detail: state.detail, percent: 100 });
      return { ok: false, cancelled: true, message: "同步已取消" };
    }
    state.stage = "error";
    state.lastError = webdav.isNetworkError(e) ? webdav.describeFailure("号池同步", e) : String((e && e.message) || e);
    state.detail = state.lastError;
    events.emit({ type: "poolsync", stage: "error", running: false, detail: state.lastError, percent: 100 });
    return { ok: false, message: state.lastError };
  } finally {
    cancelSignal = null;
    webdav.setActiveSignal(null);
  }
}

function checkAborted() {
  if (cancelSignal && cancelSignal.signal.aborted) {
    throw Object.assign(new Error("同步已取消"), { name: "AbortError" });
  }
}

function appVersion() {
  try { return require("electron").app.getVersion(); } catch { return ""; }
}

/** 统一 WebDAV 密码改动后调用：令历史上传记账失效，下次同步用新密码重打包 */
function onSharedPasswordMaybeChanged() {
  const p = loadPersisted();
  p.keyChangeAt = Date.now();
  savePersisted(p);
}

// ===== 本机远程锚定指纹（remoteMid）的 WebDAV 备份 =====
// 目的：anchor 文件随 %APPDATA% 走，重装/换机就丢——锚定指纹一丢，远程链接的 mid 与
// 服务端绑定就对不上。按 deviceId 分文件存（每台设备一枚指纹，绝不能互相覆盖）。
// 只备份 deviceMid 本身（随机 UUID，非机密），不含 deviceSid/passHashEnc 等设备凭据。

const ANCHOR_REMOTE_DIR = "anchors";

/** 上传本机锚定指纹到 pool/anchors/<deviceId>.json；内容未变（记账 hash 相同）不重传 */
async function backupAnchorMid() {
  if (!configured()) return { action: "skipped", reason: "未配置 WebDAV" };
  const zl = require("./zcodeLocal.cjs");
  const anchor = zl.getOrCreateAnchor();
  const mid = String(anchor.remoteMid || "");
  if (!mid) return { action: "skipped", reason: "锚定指纹未初始化" };
  const w = wd();
  const payload = JSON.stringify({
    v: 1,
    deviceMid: mid,
    deviceName: deviceName(),
    updatedAt: Date.now(),
    appVersion: appVersion(),
  });
  const hash = sha1(Buffer.from(payload));
  const st = loadPersisted();
  const forRemote = `${w.endpoint}${w.root}`;
  if (st.uploadedAnchorHash === hash && st.uploadedAnchorFor === forRemote) {
    return { action: "unchanged" };
  }
  await webdav.ensureDir(remoteUrl(w, POOL_DIR, ANCHOR_REMOTE_DIR), w);
  await webdav.put(remoteUrl(w, POOL_DIR, ANCHOR_REMOTE_DIR, `${deviceId() || "local"}.json`), w, payload);
  savePersisted({ ...st, uploadedAnchorHash: hash, uploadedAnchorFor: forRemote });
  return { action: "uploaded", deviceMid: mid };
}

/** 本机 anchor 缺锚定指纹时（重装/换机后首次启动）从 WebDAV 拉回并落锚 */
async function restoreAnchorMidFromRemote() {
  if (!configured()) return { action: "skipped", reason: "未配置 WebDAV" };
  const zl = require("./zcodeLocal.cjs");
  const anchor = zl.getOrCreateAnchor();
  if (anchor.remoteMid) return { action: "skipped", reason: "本地已有锚定指纹" };
  const w = wd();
  const text = await webdav.getText(remoteUrl(w, POOL_DIR, ANCHOR_REMOTE_DIR, `${deviceId() || "local"}.json`), w);
  if (!text) return { action: "skipped", reason: "远端没有本机的指纹备份" };
  let remote = null;
  try { remote = JSON.parse(text); } catch { remote = null; }
  const mid = remote && typeof remote === "object" ? String(remote.deviceMid || "").trim() : "";
  if (!mid) return { action: "skipped", reason: "远端备份内容无效" };
  anchor.remoteMid = mid;
  anchor.remoteMidSavedAt = Date.now();
  zl.saveAnchor(anchor);
  return { action: "restored", deviceMid: mid };
}

module.exports = { run, cancel, progress, configured, noteRemoved, onSharedPasswordMaybeChanged, accountKeyOf, backupAnchorMid, restoreAnchorMidFromRemote,
  // 共享配置同步（自测与诊断用；主流程在 run() 内部调用 runSharedSync）
  exportShared, applyShared, encodeEnvelope, decodeEnvelope, runSharedSync,
  // 号池归档封套（自测用：与共享配置共用同一 encode/decodeEnvelope，去重后靠这组断言守住行为）
  encodeArchive, decodeArchive };
const SHARED_FILE = "shared-config.json";
const SHARED_FORMAT = "agenthub-proxy-shared@1";
// 跨设备应当一致的配置项。设备专属的 port / bind / 并发 / 限速 / 签到开关刻意不含：
// 同步过去会把另一台设备上按自身环境改过的端口与常开签到开关盖掉。
const SHARED_CONFIG_KEYS = ["modelAliases", "modelReverseAliases", "modelCustom",
  "modelOverrides", "modelFallback", "disabledModels"];
/** 各键在本机配置里的形状：对端载荷按这个口径收，形状不符一律不写。
 *  config 里只有 disabledModels 是数组，其余是「模型 → 值」映射；形状写错下游必炸——
 *  server.cjs 的 (settings.disabledModels || []).includes / (settings.modelAliases || {})[model]
 *  分别在禁用判定与别名解析的必经路径上，错了是所有对话请求 500/400。 */
const SHARED_ARRAY_KEYS = new Set(["disabledModels"]);
const shapeOk = (v, wantArray) => (wantArray ? Array.isArray(v) : !!v && typeof v === "object" && !Array.isArray(v));

/** 本机共享配置快照（Key 先本机解密再进加密包，与 token 同规矩：绝不明文上传） */
function exportShared() {
  const cfg = config.loadConfig();
  const p = cfg.proxy || {};
  const conf = {};
  for (const k of SHARED_CONFIG_KEYS) {
    const v = p[k];
    conf[k] = Array.isArray(v) ? v.slice() : (v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : {});
  }
  const keys = store.listKeys()
    .filter((k) => k.secret) // 解不开明文的（旧信封）跳过，避免把不可用 Key 传播出去
    .map((k) => ({
      id: k.id, name: k.name, secret: k.secret, route: k.route, routeOrder: k.routeOrder || "",
      dailyQuota: k.dailyQuota, rateLimit: k.rateLimit,
      enabled: k.enabled, createdAt: k.createdAt,
    }));
  // 模型清单及参数（rules/catalog.json）：整份随共享包走，新设备免重新拉官方目录。
  // get 返回的是缓存对象本身，必须深拷贝，避免后续合并改动污染缓存。
  let catalog = {};
  try { catalog = JSON.parse(JSON.stringify(rules.get("catalog.json") || {})); } catch { catalog = {}; }
  return {
    format: SHARED_FORMAT,
    exportedAt: Date.now(),
    deviceId: deviceId(),
    deviceName: deviceName(),
    config: conf,
    keys,
    catalog,
  };
}

/**
 * 对象逐键合并：取并集，冲突以远端为准（远端 exportedAt 更晚）。
 * 数组值（disabledModels）按整体处理并取【并集去重】：新增会传播、删除不传播（禁用名单宁多勿漏）。
 * ⚠ 绝不能让数组走进 Object.assign({}, local)——那会把数组变成 {0:"…"} 形状的对象，
 *    下游 (settings.disabledModels || []).includes 直接 TypeError，网关所有对话请求 500（真踩过）。
 */
function mergeSharedMap(local, remote) {
  if (Array.isArray(local) || Array.isArray(remote)) {
    const a = Array.isArray(local) ? local : [];
    const b = Array.isArray(remote) ? remote : [];
    const out = [];
    const seen = new Set();
    for (const v of a.concat(b)) {
      const k = JSON.stringify(v);
      if (!seen.has(k)) { seen.add(k); out.push(v); }
    }
    return { out, changed: JSON.stringify(out) === JSON.stringify(a) ? 0 : 1 };
  }
  const out = Object.assign({}, local || {});
  let changed = 0;
  for (const [k, v] of Object.entries(remote || {})) {
    if (JSON.stringify(out[k]) !== JSON.stringify(v)) { out[k] = v; changed++; }
  }
  return { out, changed };
}

/**
 * 模型清单合并（按渠道为单元）：本机没有的渠道直接入；
 * 两边都有 → syncedAt 新者胜。渠道内不拆模型行合并——目录是「一次官方拉取」的产物，
 * 按渠道整体取新，避免半新半旧的参数拼出矛盾条目（倍率是新的、上下文长度是旧的）。
 */
function mergeSharedCatalog(localCat, remoteCat) {
  const out = Object.assign({}, localCat || {});
  let added = 0, updated = 0;
  for (const [ch, sec] of Object.entries(remoteCat || {})) {
    if (!sec || typeof sec !== "object" || !Array.isArray(sec.models)) continue;
    const cur = out[ch];
    if (!cur || typeof cur !== "object") { out[ch] = JSON.parse(JSON.stringify(sec)); added++; continue; }
    if ((Number(sec.syncedAt) || 0) > (Number(cur.syncedAt) || 0)) {
      out[ch] = JSON.parse(JSON.stringify(sec));
      updated++;
    }
  }
  return { out, added, updated };
}

/**
 * 把对端共享配置合并进本机。
 * 语义：映射类逐键并集、冲突取远端（远端 exportedAt 更晚）；
 *       API Key 按 id/hash 去重，只补本机没有的（本机已有的以本机为准，不覆盖启停状态）；
 *       模型清单按渠道 syncedAt 新者胜（见 mergeSharedCatalog）。
 */
function applyShared(snap) {
  const none = { applied: false, configChanged: 0, keyAdded: 0, catalogAdded: 0, catalogUpdated: 0 };
  if (!snap || snap.format !== SHARED_FORMAT) return none;
  const out = { applied: true, configChanged: 0, keyAdded: 0, catalogAdded: 0, catalogUpdated: 0 };
  const cfg = config.loadConfig();
  cfg.proxy = cfg.proxy || {};
  for (const k of SHARED_CONFIG_KEYS) {
    const remote = (snap.config || {})[k];
    const wantArray = SHARED_ARRAY_KEYS.has(k);
    // 形状校验双向：对端把 disabledModels 塞成对象（或把映射塞成数组）一律跳过；
    // 本机侧形状不符（历史脏数据）时按空值起底，不能让坏形状顺着合并继续传下去
    if (!shapeOk(remote, wantArray)) continue;
    const localVal = cfg.proxy[k];
    const r = mergeSharedMap(shapeOk(localVal, wantArray) ? localVal : (wantArray ? [] : {}), remote);
    if (r.changed) { cfg.proxy[k] = r.out; out.configChanged += r.changed; }
  }
  if (out.configChanged) config.saveConfig(cfg);
  for (const kk of Array.isArray(snap.keys) ? snap.keys : []) {
    if (store.importKey(kk).ok) out.keyAdded++;
  }
  // 模型清单：与「拉取官方目录」同一写回路径（落盘 + reload 热生效）
  if (snap.catalog && typeof snap.catalog === "object" && Object.keys(snap.catalog).length) {
    let cur = {};
    try { cur = JSON.parse(JSON.stringify(rules.get("catalog.json") || {})); } catch { cur = {}; }
    const r = mergeSharedCatalog(cur, snap.catalog);
    if (r.added || r.updated) {
      fs.writeFileSync(path.join(rules.rulesDir(), "catalog.json"), JSON.stringify(r.out, null, 2), "utf8");
      rules.reload("catalog.json");
      out.catalogAdded = r.added;
      out.catalogUpdated = r.updated;
    }
  }
  return out;
}

/** 通用加密封套（与号池归档同一套：AES-256-GCM + scrypt 固定盐 + AHPPOOL1 magic） */
function encodeEnvelope(snapshot, password) {
  const plain = Buffer.from(JSON.stringify(snapshot), "utf8");
  const key = crypto.scryptSync(String(password || ""), KDF_SALT, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([Buffer.from("AHPPOOL1", "latin1"), iv, tag, enc]);
  return zip.createZip([{ name: ZIP_ENTRY, data: payload }]);
}

/** 解开封套（不做 format 校验，交给调用方） */
function decodeEnvelope(buf, password) {
  const entries = zip.readZip(buf);
  const entry = entries.find((e) => e.name === ZIP_ENTRY);
  if (!entry) throw new Error("不是号池同步压缩包（缺少 accounts.json）");
  const d = entry.data;
  if (d.length < 36 || d.subarray(0, 8).toString("latin1") !== "AHPPOOL1") throw new Error("压缩包封套损坏或版本不识别");
  const key = crypto.scryptSync(String(password || ""), KDF_SALT, 32);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, d.subarray(8, 20));
    decipher.setAuthTag(d.subarray(20, 36));
    const plain = Buffer.concat([decipher.update(d.subarray(36)), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch (e) {
    throw new Error("解密失败：WebDAV 密码与打包时不一致，或压缩包已损坏");
  }
}

/**
 * 共享配置同步：先拉取合并、再导出上传（顺序不能反：
 * 反过来的话本机旧配置会盖掉对端刚做的改动）。
 * 独立成函数是为了不动 run() 主体，改动面小、也好单独验证。
 */
async function runSharedSync(w, persisted, result) {
  // 只有「远端读得成」才允许本轮上传：GET 报错（网络/鉴权）时远端是什么状态我们并不知道，
  // 这时推本机版本会把对端更新的配置盖掉（LWW 语义下对端下次同步又反过来吃掉本机改动）。
  // 读到内容但解不开（损坏/密码变过）不算「不知道」——按首次上传自愈，与号池归档同一处理。
  let remoteReadOk = false;
  try {
    const got = await webdav.get(remoteUrl(w, POOL_DIR, SHARED_FILE), w);
    remoteReadOk = true; // 含 404：确认对端还没有这个文件
    if (got) {
      let snap = null;
      try {
        snap = decodeEnvelope(got, w.password);
      } catch (e) {
        result.sharedDecodeError = String((e && e.message) || e);
      }
      if (snap && snap.format === SHARED_FORMAT && Number(snap.exportedAt) > Number(persisted.sharedAppliedAt || 0)) {
        const ap = applyShared(snap);
        persisted.sharedAppliedAt = Number(snap.exportedAt);
        result.sharedFrom = snap.deviceName || snap.deviceId || "";
        result.sharedConfigChanged = ap.configChanged;
        result.sharedKeyAdded = ap.keyAdded;
        result.sharedCatalogAdded = ap.catalogAdded;
        result.sharedCatalogUpdated = ap.catalogUpdated;
      }
    }
  } catch (e) { result.sharedPullError = String((e && e.message) || e); /* 网络/鉴权异常：不阻断号池同步，但留痕可诊断 */ }
  try {
    const shared = exportShared();
    // hash 只覆盖内容（不含 exportedAt），否则每次同步都因时间戳不同而重传
    const stable = sha1(Buffer.from(JSON.stringify({ config: shared.config, keys: shared.keys, catalog: shared.catalog })));
    if (!remoteReadOk) {
      result.sharedUploadSkipped = true;
    } else if (persisted.sharedHash !== stable) {
      await webdav.put(remoteUrl(w, POOL_DIR, SHARED_FILE), w, encodeEnvelope(shared, w.password));
      persisted.sharedHash = stable;
      result.sharedUploaded = true;
    }
  } catch (e) { result.sharedUploadError = String((e && e.message) || e); /* 上传失败不影响号池结果，但留痕可诊断 */ }
  const parts = [
    result.sharedFrom ? "配置取自 " + result.sharedFrom : "",
    result.sharedConfigChanged ? "改 " + result.sharedConfigChanged + " 项" : "",
    result.sharedKeyAdded ? "补 Key " + result.sharedKeyAdded : "",
    result.sharedCatalogAdded ? "增清单渠道 " + result.sharedCatalogAdded : "",
    result.sharedCatalogUpdated ? "更新清单渠道 " + result.sharedCatalogUpdated : "",
    result.sharedUploadSkipped ? "共享配置本轮未上传（远端读取失败，等下轮）" : "",
    result.sharedUploaded ? "共享配置已上传" : "",
  ].filter(Boolean);
  result.sharedSummary = parts.join(" · ");
}

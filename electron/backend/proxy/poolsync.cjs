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
    };
  } catch {
    return { lastSyncAt: 0, uploadedHash: "", uploadedFor: "", merged: {}, keyChangeAt: 0 };
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

/** 导出本机号池为快照对象：token/refreshToken 为 DPAPI 解密后的明文（只进加密包，绝不上明文）。
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
        meta: view.meta && typeof view.meta === "object" ? view.meta : {},
        updatedAt: Math.max(view.creditsAt || 0, view.lastUsed || 0, view.createdAt || 0),
      };
    })
    .filter(Boolean);
  return { format: FILE_FORMAT, deviceId: deviceId(), deviceName: deviceName(), exportedAt: Date.now(), channel: channel || "", accounts };
}

/** 快照 → 加密 zip：JSON → gzip 由 zip deflate 承担，加密用 AES-256-GCM（scrypt 派生密钥） */
function encodeArchive(snapshot, password) {
  const plain = Buffer.from(JSON.stringify(snapshot), "utf8");
  const key = crypto.scryptSync(String(password || ""), KDF_SALT, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 自描述封套：magic(8) + iv(12) + tag(16) + 密文，解密端先验 magic 再验 GCM
  const payload = Buffer.concat([Buffer.from("AHPPOOL1", "latin1"), iv, tag, enc]);
  return zip.createZip([{ name: ZIP_ENTRY, data: payload }]);
}

/** 加密 zip → 快照：结构错误 / 密码不对 / 内容损坏分别给出可读错误 */
function decodeArchive(buf, password) {
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
    const snap = JSON.parse(plain.toString("utf8"));
    if (!snap || snap.format !== FILE_FORMAT || !Array.isArray(snap.accounts)) throw new Error("快照格式不识别");
    return snap;
  } catch (e) {
    if (e && /格式/.test(String(e.message))) throw e;
    throw new Error("解密失败：WebDAV 密码与打包时不一致，或压缩包已损坏");
  }
}

function sha1(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

/** 加密口令指纹：WebDAV 密码的散列（不存明文、不存可逆值），用于判断历史包是不是当前密码打的 */
function keyFingerprint(password) {
  // scrypt 派生而非快速 SHA-256：指纹存本地 sync-state.json，快速哈希对弱口令可被离线爆破
  return crypto.scryptSync(String(password || ""), KDF_SALT + "|fingerprint", 32).toString("hex").slice(0, 16);
}

// ===== 合并（自动去重，绝不自动选边删账号：删除只走墓碑） =====

/**
 * 把远端快照合并进本机号池：
 * - 本机已有同身份账号：仅当远端 creditsAt 更新时刷新额度/有效期/到期等动态字段；
 *   远端带了有效 token 而本机为空（如本机凭据损坏）时顺带补凭据
 * - 本机没有：整号入池
 * 返回 { added, updated }
 */
function mergeSnapshot(snap, channel) {
  const tombstones = readLocalTombstones();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  // 本机账号一次取出建索引：原来每条远端账号都全表 listAccounts().find，
  // O(远端×本机) 且每轮重查 DB，号池大了同步明显变慢
  const localByKey = new Map(store.listAccounts().map((a) => [accountKeyOf(a), a]));
  for (const ra of snap.accounts) {
    if (!ra || typeof ra.key !== "string" || !ra.key) continue;
    if (channel && ra.channel !== channel) continue; // 只同步指定渠道：其余渠道的远端账号不动
    // 墓碑命中且本机没有该账号：尊重删除，不回捞
    const local = localByKey.get(ra.key);
    if (!local) {
      if (tombstones[ra.key] && Number(tombstones[ra.key]) >= Number(ra.updatedAt || 0)) continue;
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
        meta: ra.meta && typeof ra.meta === "object" ? ra.meta : {},
      });
      added++;
      continue;
    }
    // 已有：动态字段 LWW（credits_at 新者胜）；本机状态（启停/冷却）不动
    const patch = {};
    if (Number(ra.creditsAt || 0) > Number(local.creditsAt || 0)) {
      patch.credits = ra.credits;
      patch.creditsAt = ra.creditsAt;
      patch.expiresAt = ra.expiresAt;
    }
    if (!local.hasToken && ra.token) {
      patch.token = ra.token;
      if (ra.refreshToken) patch.refreshToken = ra.refreshToken;
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

    persisted.lastSyncAt = Date.now();
    savePersisted(persisted);
    state.lastSyncAt = persisted.lastSyncAt;
    state.lastSummary = `${channel ? store.channelDisplay(channel) + " · " : ""}拉取 ${result.pulled} 台设备 · 新增 ${result.added} · 刷新 ${result.updated} · 移除 ${result.removed} · ${result.uploaded ? "已上传" : "本机无变化"}`;
    state.running = false;
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

module.exports = { run, cancel, progress, configured, noteRemoved, onSharedPasswordMaybeChanged, accountKeyOf };

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
// - 凭据仲裁：按 tokenAt（凭据写入时刻）比新旧、按 tokenExp（access 到期时刻）判可用性，
//   均不用 updated_at/expiresAt——前者被无关更新顶新、后者对小浣熊这类「额度接口不回到期时间」
//   的渠道恒 0。绝不采纳「看起来更新但已过期」的凭据
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
const oplog = require("./oplog.cjs");
const zip = require("../zip.cjs");
const events = require("./events.cjs");
const util = require("./util.cjs");
const platform = require("./platform/index.cjs");

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

/** 取消在途同步：中止网络信号 + 撤掉待触发的去抖回传。
 *  去抖回传必须一并撤：用户点了「取消」还留着 60s 后自动上传的定时器，等于取消没生效。 */
function cancel() {
  if (cancelSignal) cancelSignal.abort();
  stopTimers();
  return { ok: true };
}

/** 停掉本模块持有的全部定时设施（去抖回传定时器）。
 *  对称清理的必要性：模块停用（index.setRuntime(false)）会 store.close()，而待触发的
 *  pushSoon 定时器到点会跑 run({uploadOnly})→exportPool→store.open()，把刚关掉的库
 *  重新打开——「停用后不运行」的承诺被一个残留定时器打破。由 index.cjs 的
 *  stopTimers()/setRuntime(false) 调用。 */
function stopTimers() {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
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
  // 包集一次全量读再按账号分桶（逐账号查在导出全渠道时是 N+1）
  const packagesByAccount = store.listAllCreditPackages();
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
        // 逐包明细随快照走，否则同步过来的账号只有聚合余额、没有到期日历
        packages: packagesByAccount.get(view.id) || [],
        source: view.source || "paste",
        meta: prepareMetaForExport(view.meta, view.channel),
        updatedAt: rawUpdatedAt,
        // 凭据时刻：合并仲裁「凭据谁新」的唯一依据；存量行可能为 0，回退 updatedAt 保底。
        // 刻意不用 updatedAt——它被额度刷新/冷却/备注一路顶新，比不出凭据真身的新旧
        tokenAt: Number(view.tokenAt) || rawUpdatedAt,
        // 凭据到期：本地解 access 的 JWT exp（不验签、不发请求）。非 JWT 渠道解不出 → 0，
        // 合并侧自动退回 expiresAt 旧口径。小浣熊 access 仅 3h 且额度接口不回到期时间，
        // 没有这个字段就分不出「新鲜凭据」与「已过期凭据」，有效性仲裁形同虚设
        tokenExp: Number(util.jwtDecode(secrets.token).exp || 0) * 1000,
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
 *    - 凭据新旧裁决（Last-Write-Wins）：均有效时，以 **tokenAt**（凭据写入时刻）较新者胜
 *    - 采纳远端新凭据后，自动重置冷却（cool_until=0）、清除上游错误记录并恢复状态为 online
 *    - 动态额度按 creditsAt 新者胜刷新；自定义备注名按修改时间覆盖
 * opts.preferKeys：账号身份键集合，命中的账号强制采纳远端凭据（刷新被判失效时的兜底拉取用：
 *   本机那份刚被上游拒了，远端那份更值得赌，哪怕它的 tokenAt 更旧）。
 * 返回 { added, updated, skipped }
 */
function mergeSnapshot(snap, channel, opts) {
  const tombstones = readLocalTombstones();
  const preferKeys = (opts && opts.preferKeys) || null;
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const now = Date.now();
  const localByKey = new Map(store.listAccounts().map((a) => [accountKeyOf(a), a]));
  // 预取本机全部原始行（含 token_enc 密文）：mergeSnapshot 对命中的每个远端账号都要
  // 解密本机凭据做有效性比对，循环内逐个 getAccount 是 N+1——同步是全渠道批量操作，
  // 几百个号时每轮多几百次 SELECT。一次查全建 Map，按 id 直取（accountView 刻意不含密文，
  // 这一步绕不开，只能收敛成一次查询）
  const localRowsById = new Map(store.accountRows().map((r) => [r.id, r]));

  for (const ra of snap.accounts) {
    if (!ra || typeof ra.key !== "string" || !ra.key) continue;
    if (channel && ra.channel !== channel) continue; // 只同步指定渠道：其余渠道的远端账号不动
    const raUpdatedAt = Number(ra.updatedAt || 0);
    // 老版本包没有 tokenAt/tokenExp：退回 updatedAt/expiresAt 旧口径（逐字节兼容，不因此判死）
    const raTokenAt = Number(ra.tokenAt || 0) || raUpdatedAt;
    const raTokenExp = Number(ra.tokenExp || 0) || Number(ra.expiresAt || 0);
    // 墓碑命中且本机没有该账号：尊重删除，不回捞
    const local = localByKey.get(ra.key);
    if (!local) {
      if (tombstones[ra.key] && Number(tombstones[ra.key]) >= raUpdatedAt) continue;
      // 远端空凭据不入池：无 token 的账号不可调度，还会继续向下一台设备传播坏号
      if (!ra.token) {
        skipped++;
        continue;
      }
      const newId = store.addAccount({
        channel: ra.channel,
        uid: ra.uid || "",
        name: ra.name || "",
        token: ra.token || "",
        refreshToken: ra.refreshToken || "",
        source: ra.source || "paste",
        expiresAt: ra.expiresAt || 0,
        meta: restoreMetaForLocal(ra.meta, ra.channel),
        updatedAt: raUpdatedAt || now,
        tokenAt: raTokenAt || now, // 凭据是远端那一刻写下的，别按本机入池时刻记（否则永远压过远端）
      });
      // 新入池的账号连包集一起收：没有这一步的话对端推过来的逐包明细会被丢弃，
      // 本机这个号的日历永远是空的（账号级 credits 有值，看不出缺了东西）
      if (Array.isArray(ra.packages)) store.setCreditPackages(newId, ra.channel, ra.packages);
      added++;
      continue;
    }

    // 本机已有同身份账号：自动冲突仲裁
    const localRow = localRowsById.get(local.id) || null;
    const localSecrets = localRow ? store.accountSecrets(localRow) : { token: "", refreshToken: "" };
    const localUpdatedAt = Number(local.updatedAt || local.creditsAt || local.lastUsed || local.createdAt || 0);
    const localTokenAt = Number(local.tokenAt || 0) || localUpdatedAt;

    // 检查凭据是否实质不同
    const tokenDiffers = (ra.token || "") !== (localSecrets.token || "") || (ra.refreshToken || "") !== (localSecrets.refreshToken || "");

    // 凭据有效性判定：凭据已过期（优先 tokenExp，退回 expiresAt）或 relogin 判定为无效。
    // 本机到期时刻从**当前凭据**现解（比快照字段更准），远端只能信快照带过来的 tokenExp
    const localCredExp = Number(util.jwtDecode(localSecrets.token).exp || 0) * 1000 || Number(local.expiresAt || 0);
    const localHasToken = !!local.hasToken && !!localSecrets.token;
    const localExpired = localCredExp > 0 && localCredExp <= now;
    const localInvalid = !localHasToken || localExpired || local.status === "relogin";

    const remoteHasToken = !!ra.token;
    const remoteExpired = raTokenExp > 0 && raTokenExp <= now;
    const remoteValid = remoteHasToken && !remoteExpired;

    let adoptRemoteCreds = false;
    if (tokenDiffers && remoteHasToken) {
      if (preferKeys && preferKeys.has(ra.key) && (remoteValid || raTokenAt > localTokenAt)) {
        // 规则 0（兜底强制）：本机这份刚被上游拒（401/200822），调用方等着换个凭据重试。
        // 比常规仲裁多放一档——**允许采纳已过期的远端凭据**（对端刚轮换出新的 refresh、
        // 但它的 access 已经躺过 3h，规则 2 会把这份「唯一可能有用」的挡掉）。
        // 但要守住「远端不比本机更值得赌」的边界（否则就是拿对端更旧的死凭据顶掉本机
        // 可能还活着的凭据）：
        //   · 远端 access 现在就能用 → 采纳；
        //   · 远端这份写得比本机晚（tokenAt 更新，说明对端轮换在本机之后）→ 采纳；
        //   · 对端更旧、且它的 access 也过期 → 不采纳，交下面几条按常规仲裁处理。
        // 3h 寿命下「对端更新 + 对端过期」必然意味着本机的也过期了，所以这一档不会挡住
        // 真正需要的自愈路径。
        adoptRemoteCreds = true;
      } else if (localInvalid && remoteValid) {
        // 规则 1：本机凭据已失效或过期，远端凭据有效 → 远端胜出
        adoptRemoteCreds = true;
      } else if (!remoteValid && !localInvalid) {
        // 规则 2：远端已过期，本机凭据有效 → 坚决保护本机可用凭据
        adoptRemoteCreds = false;
      } else {
        // 规则 3：两端均有效（或均无到期时间），以**凭据写入时刻**新者胜（LWW）。
        // 用 tokenAt 而非 updatedAt：后者被额度刷新/冷却顶新，会把刚失败一侧的坏凭据判成最新的。
        // 只有在**两端都带** tokenAt 时才这么比：对端是老版本（包内无该字段）时退回 updatedAt
        // 旧口径——混着比等于拿「本机的凭据时刻」压「远端的活动时刻」，
        // 老对端刚轮换出来的新凭据会永远进不来（本机 tokenAt 是几小时前刷新的，照样比它大）
        const useTokenAt = Number(ra.tokenAt || 0) > 0 && Number(local.tokenAt || 0) > 0;
        const raCmp = useTokenAt ? raTokenAt : raUpdatedAt;
        const localCmp = useTokenAt ? localTokenAt : localUpdatedAt;
        if (raCmp > localCmp) {
          adoptRemoteCreds = true;
        }
      }
    }

    const patch = {};

    if (adoptRemoteCreds) {
      patch.token = ra.token;
      patch.refreshToken = ra.refreshToken || "";
      patch.expiresAt = ra.expiresAt || 0;
      // 合并式（对齐 discovery.importCandidate 的 { ...curMeta, ...meta }）：远端快照 meta
      // 为空对象时整包替换会把本机设备绑定元数据（machineId/deviceId/deviceMid/sw）
      // 一并抹掉 → 跨机同步后 Qoder 签名失败/小浣熊 200003 串号/ZCode 切号失效
      const localMeta = local.meta || {};
      // 凭据合并只搬「与凭据/设备绑定有关的」meta，用户编辑的内容与时钟一律钉回本机：
      //  ① renamedAt/noteAt 描述的是「本机这一行的 name/note 何时被用户改的」，继承了远端的值
      //     会出现本机名字没变、时钟却变成远端那次编辑，之后本机真改名反而判负。
      //  ② note 同理必须留在本机——否则文本跟着凭据走过来了、时钟却还是本机的（更新的那一个），
      //     下一轮谁都比不动它；备注的传递归下面那条按 noteAt 比的独立分支管。
      // 缺省时留 undefined（JSON 序列化即不落键），比较退回 updatedAt 旧口径，存量行为不变。
      patch.meta = restoreMetaForLocal(
        { ...localMeta, ...(ra.meta || {}), note: localMeta.note, renamedAt: localMeta.renamedAt, noteAt: localMeta.noteAt },
        ra.channel
      );
      patch.updatedAt = raUpdatedAt || now;
      // 凭据时刻记**远端那一刻**：两机时钟才可比，下一轮也不会被当成本机刚写的。
      // 刻意不记当下——强制采纳（401 兜底）也可能采纳到一份已经作废的凭据，
      // 记当下会让它冒充「最新」并在后续同步里压住对端真正有效的凭据
      patch.tokenAt = raTokenAt || now;
      // 自愈（重置冷却与解除上游错误）以远端凭据有效为前提：两端均失效时采纳
      // 过期远端凭据不能把死号「自愈」成 online 进调度（必然 401 的请求）
      if (remoteValid) {
        patch.coolUntil = 0;
        patch.coolReason = "";
        if (local.status === "relogin" || local.status === "cooling") {
          patch.status = "online";
        }
        store.clearError(local.id);
      }
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
      // 包集与额度是同一次查询的产物，必须同一次 LWW 整体替换：远端 creditsAt 更新才以它的
      // 包集为准。放在这个门外，一份更旧的包集会盖掉本机更新的逐包状态。
      if (Array.isArray(ra.packages)) store.setCreditPackages(local.id, ra.channel || local.channel, ra.packages);
      if (adoptRemoteCreds) patch.expiresAt = ra.expiresAt;
    }

    // 自定义备注名：**用户编辑时钟**比大小。这里原来用 raUpdatedAt > localUpdatedAt，而
    // updated_at 是 store.updateAccount 无条件推进的（每请求扣减 server.cjs、每 30min 额度刷新
    // credits.cjs 都会写它）⇒ 对端只要跑过流量，它那份**陈旧名字**的时间戳就比本机新，
    // 本机改名必然被还原。老快照没有 renamedAt 时退回原口径（updatedAt），存量行为不变。
    const remoteNameAt = Number(ra.meta && ra.meta.renamedAt) || raUpdatedAt;
    const localNameAt = Number(local.meta && local.meta.renamedAt) || localUpdatedAt;
    if (typeof ra.name === "string" && ra.name && ra.name !== local.name && remoteNameAt > localNameAt) {
      patch.name = ra.name;
      // 采纳时把编辑时钟一并落回（updateAccount 见 renamedAt 显式传入就不再取当下）：
      // 不追平的话本机每一轮都会把这个名字当「刚改的」重发一次。
      patch.renamedAt = remoteNameAt;
    }

    // 账号备注（meta.note）：与备注名同一口径——按 meta.noteAt 这个用户编辑时钟比，不用 updated_at。
    // meta 合并只在采纳远端凭据时发生（凭据相同时不合并），备注必须独立一条才传播得动。
    // 两处判据改动：
    //  ① 按「note 键存在」判定而不是「remoteNote 非空」——否则「删掉备注」这个动作永远传不到
    //    对端（store.noteAccount 已改为清除时写空串保留键，两边要同口径才闭合）。
    //  ② 采纳时把 noteAt 一并落回，本机时钟才追平远端；不追平每轮都会重发同一条备注、
    //    updated 计数虚高。
    const remoteNote = ra.meta && typeof ra.meta.note === "string" ? ra.meta.note.trim() : null;
    // 本机侧同样 trim 再比：store.noteAccount 写入时就 trim 过，但用户手改库可能留下首尾空白，
    // 一边 trim 一边不 trim 会让同一条备注永远「不等」、每轮同步都白写一次
    const localNote = local.meta && typeof local.meta.note === "string" ? local.meta.note.trim() : "";
    if (remoteNote !== null && remoteNote !== localNote) {
      const remoteNoteAt = Number(ra.meta.noteAt) || raUpdatedAt;
      const localNoteAt = Number(local.meta && local.meta.noteAt) || localUpdatedAt;
      if (remoteNoteAt > localNoteAt) {
        patch.meta = { ...(patch.meta || local.meta || {}), note: remoteNote, noteAt: remoteNoteAt };
      }
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
    // 本机账号比墓碑新（删完后又重新添加了同身份账号）：不删，并视为复活（下面合并墓碑时本机包会盖过它）。
    // ⚠ 判据刻意不含 updatedAt（与 mergeSnapshot 的 LWW 口径不同）：删除是显式操作理当生效，
    // 若并入 updatedAt，「A 删除、B 后台 token 刷新顶新 updated_at」会让账号永远存活，
    // 删除永远无法传播——这是有注释声明的取舍，勿「对齐 mergeSnapshot」
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

/** 撤销墓碑（审查整改 F10：删除失败回滚用）。
 *  账号删除链路是「先写墓碑再删本机」——若 removeAccount 失败（数据库异常等），
 *  墓碑已写但账号还在，同步时会把远端这台机器上的同名账号也删掉，造成「两边都删错」。
 *  本函数仅在「确认本机删除失败」时回滚墓碑，正常使用是 noteRemoved 后立即 removeAccount。 */
function noteRestored(accountKey) {
  if (!accountKey) return;
  const t = readLocalTombstones();
  if (t[accountKey]) {
    delete t[accountKey];
    writeLocalTombstones(t);
  }
}

// ===== Key 删除墓碑（issue #92：API Key 的删除与修改一样要跨设备传播） =====

function keyTombstoneFile() {
  return path.join(store.proxyDir(), "pool-keys-tombstones.json");
}

function readKeyTombstones() {
  try {
    const s = JSON.parse(fs.readFileSync(keyTombstoneFile(), "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

/** 写墓碑文件；返回是否成功。调用方若需要「写失败要留痕」语义（如删除 Key）应检查返回值 */
function writeKeyTombstones(t) {
  try {
    fs.writeFileSync(keyTombstoneFile(), JSON.stringify(t, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 供 index.cjs 在删除 API Key 时调用：记录墓碑（值为删除时间戳），同步时推给远端。
 *  写失败必须留痕（审查整改）：Key 已删而墓碑永缺时，他机共享包里的这把 Key 会复活
 *  且没有任何重试触发点——至少在操作日志里留下可诊断的错误 */
function noteKeyRemoved(keyId) {
  if (!keyId) return;
  const t = readKeyTombstones();
  t[String(keyId)] = Date.now();
  // 复用同一写入器：避免「两处各写一份写盘逻辑」日后漂移（改了一处忘了另一处）
  if (!writeKeyTombstones(t)) {
    oplog.log("error", "API Key", "删除墓碑写入失败（该 Key 的删除将无法同步到其他设备）");
  }
}

// ===== 只拉取（刷新被判失效时的兜底取新凭据） =====

/**
 * 只拉取合并：不上传、不动墓碑、不碰共享配置。
 * 用途见 adapters.cjs 的 raccoon.refreshToken：某台设备刷新时轮换了 refresh_token，
 * 本机手里那份就作废了；刷新被 401/200822 拒掉时先来这里把对端刚轮换出来的凭据取回来，
 * 而不是直接把账号推给用户「重新登录」。
 * opts.merged        —— 合并记账表（run 传入持久化对象；缺省则不做「内容未变跳过」优化）
 * opts.preferKeys    —— 账号身份键集合：命中的账号强制采纳远端凭据（见 mergeSnapshot 规则 0）
 * opts.onDeviceError —— (devId, message) 单包失败回调（run 用来推事件，缺省静默跳过该包）
 * opts.holdLock      —— true 表示调用方已持有全局同步槽位（run 内部调用），不抢也不释放
 */
async function pullChannel(channel, opts) {
  const o = opts || {};
  const w = wd();
  const empty = { devices: 0, added: 0, updated: 0, skipped: 0 };
  if (!configured()) return { ok: false, ...empty, message: "WebDAV 未配置" };
  if (!o.holdLock && !webdav.tryBeginSync("proxy-pull")) return { ok: false, ...empty, message: "其他同步进行中" };
  try {
    const myId = deviceId();
    const archDir = remoteUrl(w, POOL_DIR, "archives");
    const archList = (await webdav.list(archDir, w)).filter((e) => !e.isDir && e.name.endsWith(".zip"));
    const res = { ok: true, ...empty };
    for (const e of archList) {
      checkAborted();
      const devId = e.name.replace(/\.zip$/, "");
      if (devId === myId) continue;
      const buf = await webdav.get(remoteUrl(w, POOL_DIR, "archives", e.name), w);
      if (!buf) continue;
      const hash = sha1(buf);
      const mergeKey = devId + (channel ? `|${channel}` : "");
      if (o.merged && o.merged[mergeKey] === hash) continue; // 内容未变，上次已合并过
      try {
        const snap = decodeArchive(buf, w.passphrase);
        const m = mergeSnapshot(snap, channel, o);
        res.devices++;
        res.added += m.added;
        res.updated += m.updated;
        res.skipped += m.skipped || 0;
        if (o.merged) o.merged[mergeKey] = hash; // 成功合并才记账，坏包下轮重试
      } catch (err) {
        // 密码不一致/包损坏：跳过该设备但不阻断整体（调用方决定要不要留痕）
        if (o.onDeviceError) o.onDeviceError(devId, String((err && err.message) || err));
      }
    }
    return res;
  } catch (e) {
    // 原异常一并回传：run 侧要按 name 区分「用户取消」（AbortError → 落 cancelled 态）
    // 与网络错误（isNetworkError → 走 describeFailure 出可读文案）。压成字符串就只剩
    // 一个裸的 "fetch failed"，号池同步页也不再是「已取消」而是「失败」
    return { ok: false, ...empty, message: String((e && e.message) || e), error: e };
  } finally {
    if (!o.holdLock) webdav.endSync();
  }
}

// ===== 刷新后回传（凭据刚轮换，尽快让其他设备拿到） =====

const PUSH_DEBOUNCE_MS = Number(process.env.AGENTHUB_POOL_PUSH_DEBOUNCE_MS) > 0
  ? Number(process.env.AGENTHUB_POOL_PUSH_DEBOUNCE_MS)
  : 60 * 1000; // 自测用环境变量缩短（不设即 60s，与 config.cjs 的 AGENTHUB_DATA_DIR 沙箱钩子同一先例）
let pushTimer = null;

/**
 * 去抖回传：小浣熊这类渠道刷新一次就轮换一个 refresh_token，对端手里的快照立刻作废。
 * 刷新成功后就近推一次号池（只上传、不拉取），对端最迟一个去抖窗口后拿到新凭据。
 * 刻意不「发即推」：一轮额度刷新会连着刷好几个号，逐个上传纯属浪费；
 * 也刻意不重试：回传失败不影响本机刷新结果，下一轮定时同步自然会补。
 */
function pushSoon() {
  if (pushTimer) return; // 已在去抖窗口内
  if (!configured()) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    // 忙则重排、不消耗这次回传（判据与 run 的守卫同源，且两处之间没有 await，不存在竞态）：
    // 这次回传带着刚轮换出的凭据，丢掉它等于让对端继续拿着作废的 refresh 撞 401
    if (state.running || webdav.syncBusyTag()) return pushSoon();
    // 真失败（网络/鉴权）不重排：每 60s 撞一次网络没意义，留给下一轮定时同步
    run({ uploadOnly: true }).catch(() => { /* 尽力而为 */ });
  }, PUSH_DEBOUNCE_MS);
}

// ===== 同步主流程 ===== 

async function run(opts) {
  const uploadOnly = !!(opts && opts.uploadOnly);
  if (state.running) throw new Error("号池同步已在进行中");
  const channel = String((opts && opts.channel) || "");
  if (channel && !store.CHANNELS.some((c) => c.id === channel)) throw new Error(`未知渠道 "${channel}"`);
  const w = wd();
  if (!configured()) throw new Error("WebDAV 未配置完整：请先在「设置 · 数据存储」配置统一服务器");
  // 号池压缩包用加密口令加密（issue #89：显式口令优先，缺省沿用 password / S3 SecretKey）
  if (!w.password) throw new Error("请先在「设置 · 数据存储」配置服务器与密码（S3 模式为 SecretKey）");
  // 弱口令告警（不阻断）：太短的口令打的包在远端可被离线爆破。刻意只 warn 不拒绝——
  // 部分用户的 WebDAV 服务器本身只支持短密码，阻断会破坏既有同步；强度由用户自行权衡。
  // 回传（uploadOnly）不重复告警：同一件事每刷一次号就记一条，纯噪声
  if (!uploadOnly && String(w.passphrase).length < 8) {
    oplog.log("warn", "号池同步", "号池压缩包加密口令不足 8 位：短口令在远端可被离线爆破，建议改用更长密码或设置独立加密口令");
  }
  // 远端同步跨模块互斥（issue #92）：技能/用量/记忆同步进行中时跳过本轮
  if (!webdav.tryBeginSync("proxy")) throw new Error("其他模块的远端同步正在进行，本轮已跳过");

  // 占锁与收尾必须同处一个保护块（审查加固）：原先 state/cancelSignal/deviceId 等初始化
  // 位于 try 之外，一旦其中任何一步抛错，finally 里的 webdav.endSync() 不会执行，
  // 全局同步槽位（syncRunTag）将永久被占，技能/用量/号池/记忆四个模块的同步入口
  // 全部被拒直到重启应用。当前这些调用在现有实现下不抛，但结构上必须收紧。
  try {
    state = { ...state, running: true, stage: "connect", detail: "", lastError: "", percent: 0, channel };
    cancelSignal = new AbortController();
    webdav.setActiveSignal(cancelSignal.signal);
    const persisted = loadPersisted();
    const myId = deviceId();
    const myName = deviceName();
    const result = { pulled: 0, added: 0, updated: 0, removed: 0, skipped: 0, uploaded: false, skippedUpload: false };

    // ---- 连接检查 + 远端目录就绪 ----
    setStage("connect", "检查远端连接…");
    const t = await webdav.test(w);
    if (!t.ok) throw new Error(t.message);
    await webdav.ensureDir(remoteUrl(w, POOL_DIR, "devices"), w);
    await webdav.ensureDir(remoteUrl(w, POOL_DIR, "archives"), w);

    // ---- 拉取：其他设备的号池压缩包 + 远端墓碑 ----
    if (!uploadOnly) setStage("pull", channel ? `拉取远端号池（仅 ${store.channelDisplay(channel)}）…` : "拉取远端号池…");
    const remoteTombText = uploadOnly ? "" : await webdav.getText(remoteUrl(w, POOL_DIR, "tombstones.json"), w);
    let remoteTomb = {};
    try { remoteTomb = remoteTombText ? JSON.parse(remoteTombText) : {}; } catch { remoteTomb = {}; }

    // ---- 合并：逐设备解密合并（内容未变的包按记账跳过；渠道过滤时记账键带渠道，防漏合他渠道） ----
    if (!uploadOnly) {
      const pulled = await pullChannel(channel, {
        holdLock: true, // run 已持全局同步槽位
        merged: persisted.merged,
        onDeviceError: (devId, message) => {
          events.emit({ type: "poolsync", stage: state.stage, detail: `跳过「${devId.slice(0, 8)}」的号池包：${message}`, running: true, percent: state.percent });
        },
      });
      if (!pulled.ok) throw pulled.error || new Error(pulled.message || "拉取远端号池失败");
      result.pulled = pulled.devices;
      result.added = pulled.added;
      result.updated = pulled.updated;
      result.skipped = pulled.skipped;
    }

    // ---- 墓碑：远端生效到本机 + 双向合并推回 ----
    // 回传模式（uploadOnly）必须整段跳过：没拉远端墓碑就推回，等于拿本机的一份
    // 把对端设备写过的墓碑覆盖掉——「A 删了账号，B 一刷新就把删除记录抹平」。
    if (!uploadOnly) {
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
    }

    // ---- 上传：本机号池打成加密压缩包（内容未变且未换密码则跳过） ----
    setStage("upload", uploadOnly
      ? "回传本机号池（刷新后凭据已轮换）…"
      : (channel ? `打包上传本机号池（仅 ${store.channelDisplay(channel)}）…` : "打包上传本机号池…"));
    checkAborted();
    const snapshot = exportPool(channel);
    const zipBuf = encodeArchive(snapshot, w.passphrase);
    const hash = sha1(zipBuf);
    const fp = keyFingerprint(w.passphrase);
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

    // 共享配置（模型映射 + API Key）只在完整同步里跑：回传模式的目的是「把刚轮换的凭据推上去」，
    // 顺手做一遍共享配置的拉取/确认是无谓的往返
    if (!uploadOnly) await runSharedSync(w, persisted, result);
    persisted.lastSyncAt = Date.now();
    savePersisted(persisted);
    state.lastSyncAt = persisted.lastSyncAt;
    state.lastSummary = uploadOnly
      ? `${channel ? store.channelDisplay(channel) + " · " : ""}仅回传本机号池（刷新后凭据已轮换）· ${result.uploaded ? "已上传" : "本机无变化"}`
      : `${channel ? store.channelDisplay(channel) + " · " : ""}拉取 ${result.pulled} 台设备 · 新增 ${result.added} · 刷新 ${result.updated} · 移除 ${result.removed} · ${result.uploaded ? "已上传" : "本机无变化"}`;
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
    webdav.endSync();
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
  return platform.version();
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

module.exports = { run, cancel, stopTimers, progress, configured, noteRemoved, noteRestored, noteKeyRemoved, onSharedPasswordMaybeChanged, accountKeyOf, backupAnchorMid, restoreAnchorMidFromRemote,
  // 兜底取新凭据（adapters.cjs 的 raccoon.refreshToken 在 401/200822 时调用）与刷新后回传
  pullChannel, pushSoon,
  // 号池逐包的自测面（自测与诊断用，与下面 encodeArchive 同一先例）：
  // mergeSnapshot 不走这两个导出的话，「包集随同步传播」只能靠 grep 源文件钉，抓不到
  // 「写错了 LWW 门的位置」这类真缺陷
  exportPool, mergeSnapshot,
  // 元数据明文化（号池「导出凭据」复用：zcode 切号快照是 DPAPI 密文，导出给外部软件用
  // 必须先解密；与同步快照共用同一份实现，两处各写一份会让字段清单分叉）
  prepareMetaForExport,
  // 共享配置同步（自测与诊断用；主流程在 run() 内部调用 runSharedSync）
  exportShared, applyShared, encodeEnvelope, decodeEnvelope, runSharedSync,
  // 号池归档封套（自测用：与共享配置共用同一 encode/decodeEnvelope，去重后靠这组断言守住行为）
  encodeArchive, decodeArchive,
  // 合并仲裁（自测用：改名/备注的用户编辑时钟回归，见 scripts/test-pool-edit-clock.cjs）
  mergeSnapshot };
const SHARED_FILE = "shared-config.json";
const SHARED_FORMAT = "agenthub-proxy-shared@1";
// 跨设备应当一致的配置项。设备专属的 port / bind / 并发 / 限速 / 签到开关刻意不含：
// 同步过去会把另一台设备上按自身环境改过的端口与常开签到开关盖掉。
// 超时与瞬时重试旋钮（firstByteBaseMs 等 / retrySameAccountCount）同属设备专属（网络环境不同），不同步。
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
      updatedAt: k.updatedAt || 0, // LWW 仲裁：改名/改配额/启停靠它传播到其他设备（issue #92）
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
 *       API Key 按 updatedAt 新者胜（issue #92）：改名/改配额/启停会传播；
 *       本机墓碑时间晚于对端修改时间的 Key 不导入（对端还没感知删除）；
 *       模型清单按渠道 syncedAt 新者胜（见 mergeSharedCatalog）。
 */
function applyShared(snap) {
  const none = { applied: false, configChanged: 0, keyAdded: 0, keyUpdated: 0, catalogAdded: 0, catalogUpdated: 0 };
  if (!snap || snap.format !== SHARED_FORMAT) return none;
  const out = { applied: true, configChanged: 0, keyAdded: 0, keyUpdated: 0, catalogAdded: 0, catalogUpdated: 0 };
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
  const keyTomb = readKeyTombstones();
  for (const kk of Array.isArray(snap.keys) ? snap.keys : []) {
    if (!kk || !kk.id) continue;
    // 墓碑优先（issue #92）：远端包可能来自还没感知删除的老设备——
    // 删除时间晚于对端最后修改 → 不导入；对端在删除之后又改过（updatedAt 更新）→ 视为重建。
    // 用 >= 而非 >：同一毫秒内的「删除 vs 修改」判删除优先（否则该删除会丢），
    // 与 runSharedSync 的本机删除判据（下方 Number(at) >= updatedAt）保持同口径，两处须同改。
    const tombAt = Number(keyTomb[kk.id]) || 0;
    if (tombAt && tombAt >= (Number(kk.updatedAt) || 0)) continue;
    const r = store.importKey(kk);
    if (r.ok) { if (r.updated) out.keyUpdated++; else out.keyAdded++; }
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
  // 空口令守卫（审查整改）：口令没接上时宁可同步失败，也绝不用公开可推导的空密钥
  // 加密号池归档/共享配置（里面有账号凭据与 API Key 明文）传到远端
  if (!password) throw new Error("号池加密口令为空，拒绝打包上传（请检查统一服务器配置）");
  const plain = Buffer.from(JSON.stringify(snapshot), "utf8");
  const key = crypto.scryptSync(String(password), KDF_SALT, 32);
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
  // 口令口径：显式 passphrase 优先，缺省沿用 w.password（与 wd() 的注入语义一致；
  // 直接以自有 w 对象调用本函数的测试/诊断路径两者都缺时才拒绝）
  const phrase = w.passphrase || w.password;
  if (!phrase) throw new Error("号池加密口令为空，拒绝共享配置同步（请检查统一服务器配置）");
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
        snap = decodeEnvelope(got, phrase);
      } catch (e) {
        result.sharedDecodeError = String((e && e.message) || e);
      }
      if (snap && snap.format === SHARED_FORMAT && Number(snap.exportedAt) > Number(persisted.sharedAppliedAt || 0)) {
        const ap = applyShared(snap);
        persisted.sharedAppliedAt = Number(snap.exportedAt);
        result.sharedFrom = snap.deviceName || snap.deviceId || "";
        result.sharedConfigChanged = ap.configChanged;
        result.sharedKeyAdded = ap.keyAdded;
        result.sharedKeyUpdated = ap.keyUpdated;
        result.sharedCatalogAdded = ap.catalogAdded;
        result.sharedCatalogUpdated = ap.catalogUpdated;
      }
    }
  } catch (e) { result.sharedPullError = String((e && e.message) || e); /* 网络/鉴权异常：不阻断号池同步，但留痕可诊断 */ }
  // ---- Key 删除墓碑：远端生效到本机 + 双向合并推回（issue #92，同账号墓碑语义） ----
  try {
    const ktText = await webdav.getText(remoteUrl(w, POOL_DIR, "keys-tombstones.json"), w);
    let remoteKT = {};
    try { remoteKT = ktText ? JSON.parse(ktText) : {}; } catch { remoteKT = {}; }
    if (!remoteKT || typeof remoteKT !== "object" || Array.isArray(remoteKT)) remoteKT = {};
    const localKT = readKeyTombstones();
    const merged = { ...remoteKT };
    let dirty = false;
    for (const [id, at] of Object.entries(localKT)) {
      if (!merged[id] || Number(at) > Number(merged[id])) { merged[id] = at; dirty = true; }
    }
    // 远端墓碑生效到本机：删除时间晚于本机 Key 的最后修改 → 本机跟随删除。
    // >= 与 applyShared 的墓碑判据同口径（同毫秒判删除优先），两处须同改。
    // 先取一次 Key 快照：listKeys() 含当日用量聚合，若放在墓碑循环里会随 Key 数放大成 O(n²)
    const keyById = new Map(store.listKeys().map((x) => [x.id, x]));
    for (const [id, at] of Object.entries(merged)) {
      const k = keyById.get(id);
      if (k && Number(at) >= (k.updatedAt || 0)) {
        store.deleteKey(id);
        result.sharedKeyRemoved = (result.sharedKeyRemoved || 0) + 1;
      }
    }
    // 30 天前的墓碑清理（Key 条目存活周期内足够传播）
    const kcut = Date.now() - 30 * 86400000;
    for (const [id, at] of Object.entries(merged)) {
      if (Number(at) < kcut) { delete merged[id]; delete localKT[id]; dirty = true; }
    }
    writeKeyTombstones(localKT);
    // 只在确有墓碑内容时上传：否则「远端缺文件 + 本机无墓碑」会写入一个空对象 {}，
    // 徒增一次写请求与远端噪音
    if ((dirty || ktText == null) && Object.keys(merged).length) {
      await webdav.put(remoteUrl(w, POOL_DIR, "keys-tombstones.json"), w, JSON.stringify(merged));
    }
  } catch (e) { result.sharedKeyTombError = String((e && e.message) || e); /* 墓碑同步失败不影响本轮其余部分，留痕可诊断 */ }
  try {
    const shared = exportShared();
    // hash 只覆盖内容（不含 exportedAt），否则每次同步都因时间戳不同而重传
    const stable = sha1(Buffer.from(JSON.stringify({ config: shared.config, keys: shared.keys, catalog: shared.catalog })));
    if (!remoteReadOk) {
      result.sharedUploadSkipped = true;
    } else if (persisted.sharedHash !== stable) {
      await webdav.put(remoteUrl(w, POOL_DIR, SHARED_FILE), w, encodeEnvelope(shared, phrase));
      persisted.sharedHash = stable;
      result.sharedUploaded = true;
    }
  } catch (e) { result.sharedUploadError = String((e && e.message) || e); /* 上传失败不影响号池结果，但留痕可诊断 */ }
  const parts = [
    result.sharedFrom ? "配置取自 " + result.sharedFrom : "",
    result.sharedConfigChanged ? "改 " + result.sharedConfigChanged + " 项" : "",
    result.sharedKeyAdded ? "补 Key " + result.sharedKeyAdded : "",
    result.sharedKeyUpdated ? "更新 Key " + result.sharedKeyUpdated : "",
    result.sharedKeyRemoved ? "删 Key " + result.sharedKeyRemoved : "",
    result.sharedCatalogAdded ? "增清单渠道 " + result.sharedCatalogAdded : "",
    result.sharedCatalogUpdated ? "更新清单渠道 " + result.sharedCatalogUpdated : "",
    result.sharedUploadSkipped ? "共享配置本轮未上传（远端读取失败，等下轮）" : "",
    result.sharedUploaded ? "共享配置已上传" : "",
  ].filter(Boolean);
  result.sharedSummary = parts.join(" · ");
}

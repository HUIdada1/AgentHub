// 反代网关 · 本地 IDE 快捷切换账号：把号池账号一键应用为本地桌面客户端的当前登录态
//
// WorkBuddy 双区：登录文件在同目录下按文件名区分（中国区 workbuddy-desktop.info /
//   国际版 workbuddy-desktop-ai.info），明文 JSON 是登录驱动源 —— 合并式写回，只动凭据字段。
//   三道安全闸（对齐参考项目，均为"失败即停"，绝不在拿不准的时候覆盖官方登录态）：
//     ① 官方已启用 $wbEncrypted 加密包装 → 直接拒绝（我们没有官方密钥，写进去就是破坏登录）
//     ② 写前记哈希、写时校验：期间官方客户端若回写过，本次切换作废，让用户重试
//     ③ 写后回读校验：token 必须与写入值一致，根键（account/auth/accounts/allAccounts）必须齐
// Trae：登录态是 ByteCrypto 加密信封（含 ECDSA 设备密钥绑定），无官方密钥无法构造合法信封，
//   诚实降级为引导客户端内重新登录；号池侧对话转发不受影响。
// 小浣熊：~/.box-agent/config/auth.json 明文 JSON（见 switchRaccoonAccount）。切号前必须关闭
//   客户端（含 ACP 运行时，内存态会回写覆盖）；文件被官方「退出登录」清空/删除时按号池凭据重建。
//   注意「退出登录」（logout，服务端吊销凭据）与「关闭客户端」（quit，只退进程）是两回事，
//   提示语需明确引导用户走后者，别让客户端的登录操作牵连号池。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const store = require("./store.cjs");
const discovery = require("./discovery.cjs");
const util = require("./util.cjs");
const raccoonAuth = require("./raccoonAuth.cjs");
const raccoonClient = require("./raccoonClient.cjs");
const zcodeSwitch = require("./zcodeSwitch.cjs");
const wbCrypto = require("./wbCrypto.cjs");

/** 渠道 → 本机登录文件名（两区共用一个 auth 目录，只能靠文件名区分） */
const WB_AUTH_FILES = {
  workbuddy: "workbuddy-desktop.info",
  workbuddy_ai: "workbuddy-desktop-ai.info",
};
/** 官方登录文件的完整根键（写回校验的兜底基准，见 verifyWritten） */
const WB_ROOT_KEYS = ["account", "auth", "accounts", "allAccounts"];

function wbAuthFile(channel) {
  const name = WB_AUTH_FILES[channel];
  return name ? path.join(discovery.wbAuthDir(), name) : "";
}

/** raccoon（商汤小浣熊）本地登录文件：~/.box-agent/config/auth.json（明文 JSON，box-agent 与 Electron 共用）。
 *  结构 = { access_token, refresh_token, office_identity }，读写双方都是"临时文件 + 原子 rename + 0o600"。
 *  注意：Electron 侧刷新只回写它认识的字段、会丢弃未知字段（会话1 §3.1），所以这里只动这三个键。
 *  路径与凭据键定义收敛到 raccoonAuth.cjs（刷新链路也用它双向同步，避免两处漂移） */
const RACCOON_AUTH_KEYS = raccoonAuth.AUTH_KEYS;
function raccoonAuthFile() {
  return raccoonAuth.authFile();
}

/** 小浣熊 IDE 写回：关客户端（防旧内存态回写覆盖）→ 合并式只改凭据三键（保留其余字段）
 *  → 原子写 + 回读校验 + 失败回滚 → 拉起客户端。
 *  登录文件缺失（官方客户端「退出登录」会清空/删除 auth.json）时，以号池凭据重建文件，
 *  不再要求"先在本机登录一次"——官方退出登录不影响号池账号，也不阻断切号。 */
function switchRaccoonAccount(acc, opts) {
  opts = opts || {};
  const file = raccoonAuthFile();
  const secrets = store.accountSecrets(acc);
  if (!secrets.token) throw new Error("该账号没有凭据");

  // 闸⓪：客户端进程检测——桌面端 / ACP 运行时内存里持有旧登录态，运行期间刷新会回写
  //   auth.json 把本次切换覆盖掉（raccoonAuth.cjs 文件头：两侧内存态不一致即掉登录根因）。
  //   运行中先请用户确认关闭；确认后强杀并等退出，再动文件。
  const run = raccoonClient.isRaccoonRunning();
  let relaunchExe = "";
  if (run.running) {
    if (!opts.confirmAck) {
      return {
        ok: false,
        channel: acc.channel,
        needConfirm: true,
        probe: run,
        message: `小浣熊${run.main ? "客户端" : "后台运行时"}正在运行：它内存里持有当前登录态，运行期间会把旧凭据回写覆盖（实测掉登录根因），切换前需要先关闭它${run.acp ? "；若有正在进行的会话请先保存" : ""}。确认关闭并切换吗？`,
      };
    }
    // 原本开着桌面客户端 → 记下启动路径，切换成功后拉回；只有 ACP 运行时在跑则不主动拉起
    if (run.main) relaunchExe = raccoonClient.findRaccoonExe();
    if (!raccoonClient.killRaccoon(8000)) {
      return { ok: false, channel: acc.channel, message: "小浣熊客户端未能在 8 秒内退出，已中止切换（未改动任何文件）。请手动关闭客户端后重试。" };
    }
  }

  // 读现状：文件存在 → 合并写；不存在（官方退出登录已清空/删除）→ 以号池凭据重建
  let raw = "";
  let json = {};
  let exist = false;
  try {
    exist = fs.existsSync(file);
    if (exist) {
      raw = fs.readFileSync(file, "utf8");
      json = JSON.parse(raw);
    }
  } catch (e) {
    return { ok: false, channel: acc.channel, message: `登录文件解析失败：${(e && e.message) || e}` };
  }
  if (exist && (!json || typeof json !== "object" || Array.isArray(json))) {
    return { ok: false, channel: acc.channel, message: "登录文件结构异常（非对象），已停止覆盖" };
  }

  const beforeHash = exist ? sha256(raw) : "";
  // 备份只在原文件存在时有意义（不存在时无内容可回滚，校验失败按"删除新建文件"处理）。
  // 备份失败必须中止：继续写入的话，一旦写坏就没有原文件可回滚（绝不无备份覆盖登录态）
  let backup = "";
  if (exist) {
    backup = `${file}.bak-${Date.now()}`;
    try {
      fs.copyFileSync(file, backup);
    } catch (e) {
      return { ok: false, channel: acc.channel, message: `创建登录文件备份失败：${(e && e.message) || e}，已停止覆盖` };
    }
  }

  // 工作区防丢保护（~/.box-agent/config/workspaces.json，全账号项目共用保障）
  const workspacesFile = path.join(path.dirname(file), "workspaces.json");
  let workspacesBackup = "";
  if (fs.existsSync(workspacesFile)) {
    try {
      workspacesBackup = `${workspacesFile}.bak-${Date.now()}`;
      fs.copyFileSync(workspacesFile, workspacesBackup);
    } catch {}
  }

  // 备份滚动清理：只留最近 5 份（备份含明文 refresh_token，无限累积扩大凭据泄漏面）
  try {
    const dir = path.dirname(file);
    const base = path.basename(file) + ".bak-";
    const olds = fs.readdirSync(dir).filter((n) => n.startsWith(base)).sort();
    for (const n of olds.slice(0, Math.max(0, olds.length - 5))) fs.rmSync(path.join(dir, n), { force: true });
  } catch { /* 清理失败不阻断切换 */ }

  // 闸：写时再比对哈希——客户端在切号期间回写过就作废本次（否则会把它的新登录态覆盖掉）
  if (exist) {
    let nowRaw;
    try {
      nowRaw = fs.readFileSync(file, "utf8");
    } catch (e) {
      return { ok: false, channel: acc.channel, message: `读取登录文件失败：${(e && e.message) || e}` };
    }
    if (sha256(nowRaw) !== beforeHash) {
      return { ok: false, channel: acc.channel, message: "登录信息在切号期间被官方客户端更新，已停止覆盖，请稍后重试" };
    }
  }

  const merged = { ...json, access_token: secrets.token };
  if (secrets.refreshToken) merged.refresh_token = secrets.refreshToken;
  const identity = resultOfficeIdentity(acc);
  if (identity) merged.office_identity = identity;
  else merged.office_identity = ""; // 目标账号无组织标识（如手动导入未带）：清空，别把上个号的 org code 带过去（官方刷新会按其口径重写）

  // 重建场景（文件曾被退出登录删掉）目录可能也没了，写前确保父目录存在
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* 已存在 */ }
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 残留临时文件不影响原文件 */ }
    return { ok: false, channel: acc.channel, message: `写入登录文件失败：${(e && e.message) || e}` };
  }

  const verify = verifyRaccoonWritten(file, secrets.token, Object.keys(json));
  if (!verify.ok) {
    try {
      if (exist && backup) fs.copyFileSync(backup, file);
      else fs.rmSync(file, { force: true }); // 重建产物校验不过：删掉，不留半成品冒充登录态
    } catch { /* 回滚失败也要如实报告，备份路径已返回 */ }
    return { ok: false, channel: acc.channel, backup, file, message: `写入校验未通过（${verify.message}），已自动回滚到切换前状态` };
  }

  // 确保工作区文件完整未丢失
  if (workspacesBackup && !fs.existsSync(workspacesFile)) {
    try { fs.copyFileSync(workspacesBackup, workspacesFile); } catch {}
  }

  // 拉回客户端（原本开着桌面客户端才拉；只有 ACP 运行时在跑则不主动拉起，避免打扰）
  const rel = relaunchExe ? raccoonClient.launchRaccoon(relaunchExe) : { ok: false };

  const label = acc.name || acc.uid || acc.id;
  const rebuilt = exist ? "" : "（原登录文件缺失，已按号池凭据重建）";
  const restart = rel.ok
    ? "客户端已重新启动，稍候即为新账号登录态。"
    : "请打开小浣熊客户端使用新账号。";
  const warn = "换号请再用本功能切换，切勿在客户端里点「退出登录」——那会向服务端吊销凭据，号池中该账号也会一并失效。";
  return {
    ok: true,
    channel: acc.channel,
    file,
    backup,
    relaunched: !!rel.ok,
    message: `已把「${label}」写为「商汤小浣熊」本地登录态${rebuilt}。${restart}${warn}${backup ? `原文件已备份：${path.basename(backup)}` : ""}`,
  };
}

/** 从账号 meta 取 office_identity（团队版 org code；个人版为 "personal"；缺失则不写该键） */
function resultOfficeIdentity(acc) {
  const meta = (acc && acc.meta) || {};
  return String(meta.officeIdentity || "").trim();
}

/** 小浣熊写后回读：access_token 落位 + 原有根键一个不少 */
function verifyRaccoonWritten(file, token, beforeKeys) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, message: `回读解析失败 ${(e && e.message) || e}` };
  }
  if (String(json.access_token || "") !== String(token)) return { ok: false, message: "access_token 与写入值不一致" };
  const missing = (beforeKeys || RACCOON_AUTH_KEYS).filter((k) => !(k in json));
  if (missing.length) return { ok: false, message: `原有根键丢失：${missing.join(" / ")}` };
  return { ok: true, message: "" };
}

/** 递归找 $wbEncrypted（官方加密包装的标记键）：出现即拒绝覆盖 */
function hasEncryptedWrapper(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return false;
  if (Object.prototype.hasOwnProperty.call(node, "$wbEncrypted")) return true;
  return Object.values(node).some((v) => (v && typeof v === "object" ? hasEncryptedWrapper(v, depth + 1) : false));
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/**
 * 合并式写回 auth 文件：只动凭据相关字段，其余配置原样保留（参考项目是整快照替换，这里更温和）。
 * 官方文件的结构是 { account, accounts, allAccounts, auth }，凭据的真身在 auth 节点；
 * 但历史/简化格式会把凭据平铺在根上，所以两种位置都写：根键存在才改（不存在就不凭空造），
 * auth / account 节点按官方结构补齐。
 */
function mergeAuthFields(json, account, secrets) {
  const out = { ...json };
  // ① 平铺字段（老格式 / 第三方导出的文件）：键存在才改，别给官方文件塞没用的根键
  if ("accessToken" in out || !("access_token" in out)) out.accessToken = secrets.token;
  if ("access_token" in out) out.access_token = secrets.token;
  if ("refreshToken" in out || !("refresh_token" in out)) out.refreshToken = secrets.refreshToken || "";
  if ("refresh_token" in out) out.refresh_token = secrets.refreshToken || "";
  if (account.uid) {
    if ("uid" in out || !("userId" in out)) out.uid = account.uid;
    if ("userId" in out) out.userId = account.uid;
  }
  if (account.name) {
    if ("nickname" in out) out.nickname = account.name;
    if ("displayName" in out) out.displayName = account.name;
  }
  if (account.expiresAt) {
    if ("expiresAtMs" in out) out.expiresAtMs = account.expiresAt;
    if ("expiresAt" in out) out.expiresAt = account.expiresAt;
  }
  // ② 官方结构：auth 是登录驱动源，account 里的 uid 决定本地会话目录，必须同步改
  if (out.auth && typeof out.auth === "object") {
    out.auth = {
      ...out.auth,
      accessToken: secrets.token,
      ...(secrets.refreshToken ? { refreshToken: secrets.refreshToken } : {}),
      ...(account.tokenType ? { tokenType: account.tokenType } : {}),
      ...(account.expiresAt ? { expiresAt: account.expiresAt } : {}),
      lastRefreshTime: Date.now(),
    };
  }
  if (out.account && typeof out.account === "object" && account.uid) {
    out.account = {
      ...out.account,
      uid: account.uid,
      ...(account.name ? { nickname: account.name } : {}),
      ...(account.uin ? { uin: account.uin } : {}),
    };
  }
  // ③ accounts / allAccounts 列表里同一条记录跟着换（官方客户端按 uid 关联会话）
  for (const key of ["accounts", "allAccounts"]) {
    const list = out[key];
    if (!list || typeof list !== "object") continue;
    const next = { ...list };
    for (const [k, v] of Object.entries(next)) {
      if (v && typeof v === "object" && (!account.uid || !v.uid || v.uid === account.uid)) {
        next[k] = { ...v, ...(account.uid ? { uid: account.uid } : {}), ...(account.name ? { nickname: account.name } : {}) };
      }
    }
    out[key] = next;
  }
  return out;
}

/**
 * 加密感知合并写回（$wbEncrypted 文件专用）：
 * 官方 5.6.x 起凭据/昵称/手机号是 { $wbEncrypted:1, envelope } 包装。切号时把目标账号的
 * 明文凭据重新封信回同结构，未加密的标量字段（uid / expiresAt / tokenType 等）按原样覆盖。
 * 关键：mergeAuthFields 会把目标字段覆盖成明文，所以先记录「原文件里哪些字段是包装形态」，
 * 合并后只对原本就是包装的字段重新加密（原文是明文的字段保持明文写法，不强行加密）。
 */
function mergeAuthFieldsEncrypted(json, account, secrets) {
  // ① 先快照原文件里每个包装字段的位置（合并前判定，否则被明文覆盖后认不出来）
  const wasWrapped = {
    authAccess: wbCrypto.isEncryptedWrapper(json.auth && json.auth.accessToken),
    authRefresh: wbCrypto.isEncryptedWrapper(json.auth && json.auth.refreshToken),
    accountNick: wbCrypto.isEncryptedWrapper(json.account && json.account.nickname),
    listNick: new Set(), // "listKey:index" — accounts/allAccounts 各项昵称
  };
  for (const listKey of ["accounts", "allAccounts"]) {
    const list = json[listKey];
    if (!list || typeof list !== "object") continue;
    Object.keys(list).forEach((k, i) => {
      if (wbCrypto.isEncryptedWrapper(list[k] && list[k].nickname)) wasWrapped.listNick.add(`${listKey}:${k}`);
    });
  }

  const merged = mergeAuthFields(json, account, secrets);
  // 加密文件的凭据只在 auth 信封里，根上不应出现明文平铺 accessToken/refreshToken/uid
  // （mergeAuthFields 为兼容老格式会塞，这里按官方加密文件的真实结构清掉，防凭据明文落盘）
  delete merged.accessToken;
  delete merged.access_token;
  delete merged.refreshToken;
  delete merged.refresh_token;
  delete merged.uid;
  delete merged.userId;

  // ② 只对「原本就是包装」的字段重新封信；明文原样的字段保持明文（老格式不强行加密）
  const seal = (container, key, plainText, force) => {
    if (!force || !container) return;
    if (typeof plainText === "string" && plainText) container[key] = wbCrypto.encryptField(plainText);
  };
  if (merged.auth && typeof merged.auth === "object") {
    seal(merged.auth, "accessToken", secrets.token, wasWrapped.authAccess);
    seal(merged.auth, "refreshToken", secrets.refreshToken || "", wasWrapped.authRefresh);
  }
  if (account.name) {
    seal(merged.account, "nickname", account.name, wasWrapped.accountNick);
    for (const listKey of ["accounts", "allAccounts"]) {
      const list = merged[listKey];
      if (!list || typeof list !== "object") continue;
      for (const [k, v] of Object.entries(list)) {
        if (v && typeof v === "object" && wasWrapped.listNick.has(`${listKey}:${k}`)) {
          v.nickname = wbCrypto.encryptField(account.name);
        }
      }
    }
  }
  return merged;
}

/**
 * 递归增量安全复制目录（只复制目标缺失的文件，绝不覆盖已有文件，跨平台安全）
 */
function safeSyncDirIncremental(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  try {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copied += safeSyncDirIncremental(srcPath, destPath);
      } else if (entry.isFile()) {
        if (!fs.existsSync(destPath)) {
          try {
            fs.copyFileSync(srcPath, destPath);
            copied++;
          } catch {}
        }
      }
    }
  } catch {}
  return copied;
}

/**
 * WorkBuddy 本地扩展数据根目录（跨平台自适应探测）
 */
function wbDataDir() {
  const dirs = [];
  if (process.env.LOCALAPPDATA) {
    dirs.push(path.join(process.env.LOCALAPPDATA, "CodeBuddyExtension", "Data"));
  }
  if (process.platform === "darwin") {
    dirs.push(path.join(os.homedir(), "Library", "Application Support", "CodeBuddyExtension", "Data"));
  }
  if (process.platform === "linux") {
    if (process.env.XDG_DATA_HOME) dirs.push(path.join(process.env.XDG_DATA_HOME, "CodeBuddyExtension", "Data"));
    dirs.push(path.join(os.homedir(), ".local", "share", "CodeBuddyExtension", "Data"));
    if (process.env.XDG_CONFIG_HOME) dirs.push(path.join(process.env.XDG_CONFIG_HOME, "CodeBuddyExtension", "Data"));
    dirs.push(path.join(os.homedir(), ".config", "CodeBuddyExtension", "Data"));
  }
  dirs.push(path.join(os.homedir(), "AppData", "Local", "CodeBuddyExtension", "Data"));
  for (const d of dirs) {
    try {
      if (fs.existsSync(d)) return d;
    } catch {}
  }
  return dirs[0];
}

/**
 * WorkBuddy 全账号会话共用（项目与历史会话不丢失）：
 * 官方客户端按 uid 隔离 ~/.CodeBuddyExtension/Data/<uid>/CodeBuddyIDE/ (plan-task, genie-cache)
 * 当切换到新账号 targetUid 时，自动将已有账号的会话增量同步至目标账号目录，保证切号后会话无缝继承
 */
function syncWorkBuddySessions(targetUid, currentUid) {
  if (!targetUid) return { synced: false, count: 0 };
  const base = wbDataDir();
  if (!fs.existsSync(base)) return { synced: false, count: 0 };

  const targetIdeDir = path.join(base, targetUid, "CodeBuddyIDE");

  // 寻找最佳源目录：优先切号前的原账号 UID，其次扫描目录下会话最多的 UID
  let sourceIdeDir = "";
  if (currentUid && currentUid !== targetUid) {
    const cand = path.join(base, currentUid, "CodeBuddyIDE");
    if (fs.existsSync(cand)) sourceIdeDir = cand;
  }
  if (!sourceIdeDir) {
    let maxFiles = 0;
    try {
      const dirs = fs.readdirSync(base);
      for (const d of dirs) {
        if (d === targetUid || d === "Public" || d === "default") continue;
        const ideDir = path.join(base, d, "CodeBuddyIDE");
        if (fs.existsSync(ideDir)) {
          let count = 0;
          try {
            for (const sub of ["plan-task", "genie-cache"]) {
              const sp = path.join(ideDir, sub);
              if (fs.existsSync(sp)) count += fs.readdirSync(sp).length;
            }
          } catch {}
          if (count > maxFiles) {
            maxFiles = count;
            sourceIdeDir = ideDir;
          }
        }
      }
    } catch {}
  }

  if (!sourceIdeDir || sourceIdeDir === targetIdeDir) return { synced: false, count: 0 };

  // 增量同步核心会话目录（plan-task 计划任务 + genie-cache 对话缓存）
  let totalCopied = 0;
  try {
    for (const sub of ["plan-task", "genie-cache"]) {
      const s = path.join(sourceIdeDir, sub);
      const d = path.join(targetIdeDir, sub);
      if (fs.existsSync(s)) {
        totalCopied += safeSyncDirIncremental(s, d);
      }
    }
    return { synced: true, count: totalCopied, sourceUid: path.basename(path.dirname(sourceIdeDir)) };
  } catch (e) {
    return { synced: false, count: totalCopied, error: String(e) };
  }
}

/**
 * 快捷切换：accountId → 本地 IDE 当前登录账号
 * 返回 { ok, channel, file, backup, message }
 */
function switchIdeAccount(accountId, opts) {
  const acc = store.getAccount(accountId);
  if (!acc) throw new Error("账号不存在");
  // zcode：渠道专属模块（四道闸 + 合并式写回保远程连接地址，见 zcodeSwitch.cjs 文件头）
  if (acc.channel === "zcode") return zcodeSwitch.switchZcodeAccount(accountId, opts);
  // raccoon：渠道专属模块（关客户端防回写 + 缺失文件按号池凭据重建，见本文件 switchRaccoonAccount）
  if (acc.channel === "raccoon") return switchRaccoonAccount(acc, opts);
  if (acc.channel === "trae") {
    return {
      ok: false,
      channel: acc.channel,
      message: "Trae 本地登录态为 ByteCrypto 加密信封（绑定设备密钥），无官方密钥无法构造合法信封，暂不支持直接写回；请在 Trae SOLO CN 客户端内重新登录该账号。号池侧对话转发不受影响。",
    };
  }
  const file = wbAuthFile(acc.channel);
  if (!file) return { ok: false, channel: acc.channel, message: `渠道 ${acc.channel} 不支持写回本地客户端` };
  if (!fs.existsSync(file)) {
    return { ok: false, channel: acc.channel, message: "未找到本机对应客户端的登录文件（未安装或从未登录过该客户端）" };
  }
  const secrets = store.accountSecrets(acc);
  if (!secrets.token) throw new Error("该账号没有凭据");

  let raw;
  let json;
  try {
    raw = fs.readFileSync(file, "utf8");
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, channel: acc.channel, message: `登录文件解析失败：${(e && e.message) || e}` };
  }
  // 闸①：官方加密包装。5.6.x 起凭据是 $wbEncrypted 信封——用内置保护密钥走「信封级写回」，
  //       解得开就照切不误；只有密钥不可用（官方重换密钥）才诚实降级、停手不破坏登录态。
  const encrypted = hasEncryptedWrapper(json);
  if (encrypted && !wbCrypto.protectorKey()) {
    return {
      ok: false,
      channel: acc.channel,
      message: "当前登录文件包含官方加密字段（$wbEncrypted），但本机客户端加密方案已变更（保护密钥失效），已停止覆盖以避免破坏登录状态。请升级客户端后在客户端内手动切换账号，或联系号池工具更新密钥。",
    };
  }

  const currentUid = String((json.account && json.account.uid) || (json.auth && json.auth.uid) || "");
  const beforeHash = sha256(raw);
  // 写前备份（单文件级回滚，命名带时间戳；若 IDE 正在运行可能回写覆盖，提示用户先关闭客户端）
  const backup = `${file}.bak-${Date.now()}`;
  fs.copyFileSync(file, backup);
  // 备份滚动清理：只留最近 5 份。备份里是明文 token，无限累积既占空间又扩大凭据泄漏面
  try {
    const dir = path.dirname(file);
    const base = path.basename(file) + ".bak-";
    const olds = fs.readdirSync(dir).filter((n) => n.startsWith(base)).sort();
    for (const n of olds.slice(0, Math.max(0, olds.length - 5))) {
      fs.rmSync(path.join(dir, n), { force: true });
    }
  } catch { /* 清理失败不阻断切换 */ }

  // 闸②：写时再比对一次哈希，官方客户端在切号期间写过就作废本次（否则会把它的新登录态覆盖掉）
  let nowRaw;
  try {
    nowRaw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, channel: acc.channel, message: `读取登录文件失败：${(e && e.message) || e}` };
  }
  if (sha256(nowRaw) !== beforeHash) {
    return { ok: false, channel: acc.channel, message: "登录信息在切号期间被官方客户端更新，已停止覆盖，请稍后重试" };
  }

  const accountFor = { uid: acc.uid, name: acc.name, expiresAt: acc.expires_at, tokenType: acc.meta && acc.meta.tokenType };
  const merged = encrypted ? mergeAuthFieldsEncrypted(json, accountFor, secrets) : mergeAuthFields(json, accountFor, secrets);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 残留临时文件不影响原文件 */ }
    return { ok: false, channel: acc.channel, message: `写入登录文件失败：${(e && e.message) || e}` };
  }

  // 闸③：回读校验，写坏了自己先发现，而不是让用户打开客户端才发现登不上
  // 闸③：回读校验。加密文件的合法根键就是官方四件套（WB_ROOT_KEYS）——
  // 写前文件里若混入了平铺明文凭据键（历史坏写/第三方导出），不能当成「必须保留的基准」，否则永远校验不过。
  const verify = verifyWritten(file, secrets.token, acc.uid, encrypted ? WB_ROOT_KEYS : Object.keys(json));
  if (!verify.ok) {
    try {
      fs.copyFileSync(backup, file);
    } catch { /* 回滚失败也要如实报告，备份路径已返回给用户 */ }
    return { ok: false, channel: acc.channel, backup, file, message: `写入校验未通过（${verify.message}），已自动回滚到切换前状态` };
  }

  // 会话共用：把已有账号的会话增量同步至目标账号目录（防丢会话）
  const syncInfo = syncWorkBuddySessions(acc.uid, currentUid);

  const label = acc.channel === "workbuddy_ai" ? "WorkBuddy AI" : "WorkBuddy CN";
  const encNote = encrypted ? "（含官方加密字段已同步重封）" : "";
  return {
    ok: true,
    channel: acc.channel,
    file,
    backup,
    message: `已把「${acc.name}」写为${label}本地登录态${encNote}，所有项目与历史会话已共用保留${syncInfo.synced ? `（已增量同步 ${syncInfo.count} 项历史会话）` : ""}。请完全退出并重启该客户端生效；若客户端正在运行，可能回写覆盖，建议先关闭再切换。原文件已备份：${path.basename(backup)}`,
  };
}

/**
 * 写后回读：凭据落位 + 原有根键一个不少（凭空要求官方全套根键会把老格式文件全部误判成失败，
 * 所以以"写之前有什么"为基准做差集）
 */
function verifyWritten(file, token, uid, beforeKeys) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, message: `回读解析失败 ${(e && e.message) || e}` };
  }
  // 凭据比对要兼容密文：accessToken / auth.accessToken 可能是 $wbEncrypted 信封，先还原再比
  const resolveToken = (v) => (wbCrypto.isEncryptedWrapper(v) ? wbCrypto.decryptField(v) || "" : v);
  const flat = resolveToken(json.accessToken) || json.access_token || "";
  const nested = resolveToken(json.auth && json.auth.accessToken) || "";
  if (flat !== token && nested !== token) return { ok: false, message: "accessToken 与写入值不一致" };
  const missing = (beforeKeys || WB_ROOT_KEYS).filter((k) => !(k in json));
  if (missing.length) return { ok: false, message: `原有根键丢失：${missing.join(" / ")}` };
  if (uid && json.account && json.account.uid && String(json.account.uid) !== String(uid)) {
    return { ok: false, message: "account.uid 与目标账号不一致" };
  }
  return { ok: true, message: "" };
}

/** IDE 切换能力探测（决定号池页按钮是否可用）：逐渠道报本机登录文件与当前 uid */
function ideSwitchStatus() {
  const out = { traeInstalled: false, workbuddyInstalled: false, workbuddyAiInstalled: false, raccoonInstalled: false, zcodeInstalled: false, currentUid: "", channels: {} };
  for (const [channel, name] of Object.entries(WB_AUTH_FILES)) {
    const file = path.join(discovery.wbAuthDir(), name);
    let uid = "";
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      uid = String((json.account && json.account.uid) || (json.auth && json.auth.uid) || "");
    } catch { /* 未安装 / 未登录 */ }
    if (channel === "workbuddy") {
      out.workbuddyInstalled = !!uid || fs.existsSync(file);
      out.currentUid = uid;
    } else {
      out.workbuddyAiInstalled = !!uid || fs.existsSync(file);
    }
    out.channels[channel] = { file, installed: fs.existsSync(file), uid };
  }
  // Trae：能扫到本机登录态即视为已安装
  try {
    out.traeInstalled = discovery.traeStoragePaths(["TRAE SOLO CN"]).length > 0;
  } catch { /* 探测失败按未安装处理 */ }
  out.channels.trae = { installed: out.traeInstalled, file: "", uid: "" };
  // 小浣熊：~/.box-agent 目录在即视为已安装（官方「退出登录」会删 auth.json，但号池凭据完整、
  //   切号时可重建文件——不能因文件缺失把切号按钮禁掉）；uid 取 JWT 的 iss（与 scanRaccoon 同口径）
  try {
    const rf = raccoonAuthFile();
    const home = path.dirname(path.dirname(rf)); // ~/.box-agent
    let ruid = "";
    try {
      const rjson = JSON.parse(fs.readFileSync(rf, "utf8"));
      if (rjson && rjson.access_token) {
        const p = String(rjson.access_token).split(".");
        const payload = p.length >= 2 ? JSON.parse(Buffer.from(p[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) : null;
        ruid = String((payload && (payload.iss || payload.sid)) || "");
      }
    } catch { /* 未登录 / 文件不存在 */ }
    out.raccoonInstalled = fs.existsSync(rf) || fs.existsSync(home);
    out.channels.raccoon = { file: rf, installed: out.raccoonInstalled, uid: ruid, running: raccoonClient.isRaccoonRunning().running };
  } catch { /* 未安装 / 未登录 */ }
  // zcode：~/.zcode/v2/credentials.json 存在即视为已安装；uid 解 zcodejwttoken 的 user_id
  try {
    const zs = zcodeSwitch.zcodeIdeStatus();
    out.zcodeInstalled = zs.installed;
    out.channels.zcode = { file: zs.file, installed: zs.installed, uid: zs.uid, newGen: zs.newGen, running: zs.running };
  } catch { /* 未安装 / 未登录 */ }
  return out;
}

module.exports = { switchIdeAccount, ideSwitchStatus, WB_AUTH_FILES, syncWorkBuddySessions, wbDataDir };

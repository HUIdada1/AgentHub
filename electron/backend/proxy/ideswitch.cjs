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
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const store = require("./store.cjs");
const discovery = require("./discovery.cjs");

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
 * 快捷切换：accountId → 本地 IDE 当前登录账号
 * 返回 { ok, channel, file, backup, message }
 */
function switchIdeAccount(accountId) {
  const acc = store.getAccount(accountId);
  if (!acc) throw new Error("账号不存在");
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
  // 闸①：官方加密包装
  if (hasEncryptedWrapper(json)) {
    return {
      ok: false,
      channel: acc.channel,
      message: "当前登录文件包含官方加密字段（$wbEncrypted），未取得官方密钥，已停止覆盖以避免破坏登录状态。请在客户端内手动切换账号。",
    };
  }

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

  const merged = mergeAuthFields(
    json,
    { uid: acc.uid, name: acc.name, expiresAt: acc.expires_at, tokenType: acc.meta && acc.meta.tokenType },
    secrets
  );
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 残留临时文件不影响原文件 */ }
    return { ok: false, channel: acc.channel, message: `写入登录文件失败：${(e && e.message) || e}` };
  }

  // 闸③：回读校验，写坏了自己先发现，而不是让用户打开客户端才发现登不上
  const verify = verifyWritten(file, secrets.token, acc.uid, Object.keys(json));
  if (!verify.ok) {
    try {
      fs.copyFileSync(backup, file);
    } catch { /* 回滚失败也要如实报告，备份路径已返回给用户 */ }
    return { ok: false, channel: acc.channel, backup, file, message: `写入校验未通过（${verify.message}），已自动回滚到切换前状态` };
  }

  const label = acc.channel === "workbuddy_ai" ? "WorkBuddy AI（国际版）" : "WorkBuddy（中国区）";
  return {
    ok: true,
    channel: acc.channel,
    file,
    backup,
    message: `已把「${acc.name}」写为${label}本地登录态。请完全退出并重启该客户端生效；若客户端正在运行，可能回写覆盖，建议先关闭再切换。原文件已备份：${path.basename(backup)}`,
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
  const flat = json.accessToken || json.access_token || "";
  const nested = (json.auth && json.auth.accessToken) || "";
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
  const out = { traeInstalled: false, workbuddyInstalled: false, workbuddyAiInstalled: false, currentUid: "", channels: {} };
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
  return out;
}

module.exports = { switchIdeAccount, ideSwitchStatus, WB_AUTH_FILES };

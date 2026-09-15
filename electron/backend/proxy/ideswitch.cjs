// 反代网关 · 本地 IDE 快捷切换账号：把号池账号一键应用为本地桌面客户端的当前登录态
// WorkBuddy：auth 文件是明文 JSON 登录驱动源——合并式写回（保留原文件其它字段），写前备份，可回滚
// Trae：登录态是 byteCrypto 加密信封（含 ECDSA 设备密钥绑定），无 pepper 无法构造合法信封，
//       参考项目走 13 文件整快照路线（我们没有逐账号快照），诚实降级为引导客户端内重新登录
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const store = require("./store.cjs");
const discovery = require("./discovery.cjs");

/** 合并式写回 auth 文件：只动凭据相关字段，其余配置原样保留（参考项目是整快照替换，我们按字段合并更温和） */
function mergeAuthFields(json, account, secrets) {
  const out = { ...json };
  // token 字段名按原文件既有键对齐，两个变体都没有才补 accessToken
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
  return out;
}

/**
 * 快捷切换：accountId → 本地 IDE 当前登录账号
 * 返回 { ok, file, backup, note }；Trae 渠道返回 ok:false + 引导文案
 */
function switchIdeAccount(accountId) {
  const acc = store.getAccount(accountId);
  if (!acc) throw new Error("账号不存在");
  if (acc.channel === "trae") {
    return {
      ok: false,
      channel: acc.channel,
      message: "Trae 本地登录态为加密信封（绑定设备密钥），暂不支持直接写回；请在 Trae 客户端内重新登录该账号。号池侧对话转发不受影响。",
    };
  }
  const secrets = store.accountSecrets(acc);
  if (!secrets.token) throw new Error("该账号没有凭据");
  const file = path.join(discovery.wbAuthDir(), "workbuddy-desktop.info");
  if (!fs.existsSync(file)) {
    return { ok: false, channel: acc.channel, message: "未找到本机 WorkBuddy 登录文件（未安装或未登录过客户端）" };
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, channel: acc.channel, message: `登录文件解析失败：${e.message}` };
  }
  // 写前备份（单文件级回滚，命名带时间戳；若 IDE 正在运行可能回写覆盖，提示用户先关闭客户端）
  const backup = `${file}.bak-${Date.now()}`;
  fs.copyFileSync(file, backup);
  const merged = mergeAuthFields(json, { uid: acc.uid, name: acc.name, expiresAt: acc.expires_at }, secrets);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return {
    ok: true,
    channel: acc.channel,
    file,
    backup,
    message: `已把「${acc.name}」写为 WorkBuddy 本地登录态。请完全退出并重启 WorkBuddy 客户端生效；若客户端正在运行，可能回写覆盖，建议先关闭再切换。原文件已备份。`,
  };
}

/** IDE 切换能力探测：auth 文件是否存在（决定号池页按钮是否可用） */
function ideSwitchStatus() {
  const file = path.join(discovery.wbAuthDir(), "workbuddy-desktop.info");
  let currentUid = "";
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    currentUid = String(json.uid || json.userId || "");
  } catch { /* 未安装/未登录 */ }
  return { workbuddyInstalled: !!currentUid || fs.existsSync(file), currentUid };
}

module.exports = { switchIdeAccount, ideSwitchStatus };

// CatPaw 凭证来源（移植来源：参照实现 catpaw/credentials.rs，其上游是 catpaw-local-auth.mjs
// 与 account-store.mjs）。
//
// 三处来源（优先级照抄参照实现 resolveCredentials）：
//   1. 账号记录（手动粘贴 / 本机导入）→ record.token + record.uid|loginName；
//   2. 桌面端实时登录态：~/.meituan-catpaw/auth.json → auth.accessToken + account.uid|loginName；
//   3. 环境变量旁路：CATPAW_COOKIE（+ CATPAW_USER_UID）。
//
// 与其它渠道的本质差别：CatPaw 的头是 `Cookie: X-Passport-Token=<token>`（不是 Bearer、不是 JWT），
// 且 uid 是**独立请求头**——它不在 token 里，所以凭证必须是 {token, uid} 两个字段。
//
// 没有刷新机制：没有 refreshToken 概念，token 过期只能在桌面端重新登录
// （桌面端账号的凭证每次实时读 auth.json，所以「重新登录」立即恢复）。
//
// 与参照实现的一处差异：本机导入的账号**同时把 token 落库**（而非只读 auth.json）。
// 原因在 AgentHub 的号池模型：号池按 hasToken 判定账号可用性，只记「读文件」的账号会被判不可用、
// 永远选不中。落库后：桌面端文件读得到就用实时值（客户端换号/续期自动跟着走），
// 读不到就回落库里那份（客户端未安装 / 文件临时不可读时仍可用）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const CatPawError = require("./errors.cjs");
const log = require("./log.cjs");

/** 桌面端登录态文件大小上限（参照实现 MAX_AUTH_FILE_SIZE） */
const MAX_AUTH_FILE_SIZE = 64 * 1024;
/** 凭证字段长度上限（参照实现 MAX_TOKEN_LENGTH / MAX_USER_UID_LENGTH） */
const MAX_TOKEN_LENGTH = 8192;
const MAX_USER_UID_LENGTH = 256;

/** CatPaw 配置目录（账号文件与登录态都在这里） */
function catpawHome() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, ".meituan-catpaw");
}

/** 桌面端登录态文件 */
function desktopAuthFile() {
  return path.join(catpawHome(), "auth.json");
}

/** 从 Cookie 串里取 X-Passport-Token 的值；取不到时原样返回整串
 *  （CATPAW_COOKIE 可能是完整 Cookie 头，也可能是裸 token） */
function passportTokenOf(cookie) {
  const KEY = "x-passport-token=";
  for (const segment of String(cookie || "").split(";")) {
    const trimmed = segment.trim();
    if (trimmed.slice(0, KEY.length).toLowerCase() === KEY) {
      const value = trimmed.slice(KEY.length).trim();
      if (value) return value;
    }
  }
  return String(cookie || "").trim();
}

/** 字段校验：非空、不超长、不含 CR/LF/分号（这些值进 HTTP 头，换行是头注入、分号会让 Cookie 串被解析成另一段） */
function safeField(value, field, maxLength) {
  const trimmed = String(value == null ? "" : value).trim();
  if (!trimmed) throw new Error(`CatPaw 本地登录态缺少 ${field}`);
  if (trimmed.length > maxLength || /[\r\n;]/.test(trimmed)) {
    throw new Error(`CatPaw 本地登录态中的 ${field} 格式无效`);
  }
  return trimmed;
}

/** 读一个「CatPaw 登录态」文件。防御项照抄原实现 readAuthJson：
 *  普通文件（符号链接拒绝）、大小在 (0, 64KB]、可解析且根是 JSON 对象 */
function readDesktopLogin() {
  const file = desktopAuthFile();
  let meta;
  try {
    meta = fs.lstatSync(file);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      throw new Error(`未找到 CatPaw 本地登录态（${file}），请先在 CatPaw 桌面端登录`);
    }
    throw new Error(`无法访问 CatPaw 本地登录态（${file}）: ${String((e && e.message) || e)}`);
  }
  if (meta.isSymbolicLink()) throw new Error("CatPaw 本地登录态路径是符号链接，已拒绝读取");
  if (!meta.isFile()) throw new Error("CatPaw 本地登录态路径不是普通文件");
  if (meta.size === 0 || meta.size > MAX_AUTH_FILE_SIZE) throw new Error("CatPaw 本地登录态文件大小异常");
  const modifiedAt = Math.floor(meta.mtimeMs || 0);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("CatPaw 本地登录态文件无法解析");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CatPaw 本地登录态根节点不是 JSON 对象");
  }
  const auth = parsed.auth && typeof parsed.auth === "object" ? parsed.auth : {};
  const account = parsed.account && typeof parsed.account === "object" ? parsed.account : {};
  const loginType = String(auth.loginType == null ? "" : auth.loginType).trim().toLowerCase();
  if (loginType && loginType !== "passport") {
    throw new Error(`当前 CatPaw 登录方式 ${loginType} 暂不支持自动直连`);
  }
  const token = safeField(auth.accessToken, "auth.accessToken", MAX_TOKEN_LENGTH);
  const uidRaw = account.uid === null || account.uid === undefined ? "" : String(account.uid);
  const loginRaw = account.loginName === null || account.loginName === undefined ? "" : String(account.loginName);
  const uid = uidRaw.trim() ? safeField(uidRaw, "account.uid", MAX_USER_UID_LENGTH) : "";
  const loginName = loginRaw.trim() ? safeField(loginRaw, "account.loginName", MAX_USER_UID_LENGTH) : "";
  if (!uid && !loginName) throw new Error("CatPaw 本地登录态缺少 account.uid 或 account.loginName");
  return {
    token,
    uid: uid || loginName,
    loginName,
    modifiedAt,
    tokenTail: token.slice(-4),
  };
}

/** 桌面端登录态的**摘要**（导入候选展示用）。**不含 token 本身** */
function desktopSummary() {
  const login = readDesktopLogin();
  return {
    uid: login.uid,
    loginName: login.loginName,
    tokenTail: login.tokenTail,
    modifiedAt: login.modifiedAt,
  };
}

/** 环境变量旁路凭证（CATPAW_COOKIE + CATPAW_USER_UID）；没配返回 null */
function envCredentials() {
  const cookie = String(process.env.CATPAW_COOKIE || "").trim();
  if (!cookie) return null;
  const uid = String(process.env.CATPAW_USER_UID || "").trim();
  return { token: passportTokenOf(cookie), uid };
}

/** 取一次会话转发要用的凭证。
 *  顺序：指定账号 → 桌面端实时登录态（meta.desktop）→ 账号记录里的 token → 环境变量 → 实时登录态 */
function resolveCredentials(account, secrets) {
  const meta = (secrets && secrets.meta) || (account && account.meta) || {};
  if (meta.desktop) {
    try {
      const login = readDesktopLogin();
      log.verbose(`凭证来源 桌面端实时登录态（账号 ${account.id}，uid ${login.uid || "-"}）`);
      return { token: login.token, uid: login.uid };
    } catch (e) {
      // 读不到就回落库里那份：客户端没装/没登录/临时不可读时，本机导入的账号照旧可用
      log.verbose(`桌面端登录态不可读（${(e && e.message) || e}），回落账号记录里的凭证`);
    }
  }
  const token = String((secrets && secrets.token) || "").trim();
  if (token) {
    const uid = String((account && account.uid) || meta.uid || "").trim();
    log.verbose(`凭证来源 账号记录（账号 ${(account && account.id) || "-"}，uid ${uid || "-"}）`);
    return { token, uid };
  }
  const env = envCredentials();
  if (env) {
    log.verbose(`凭证来源 环境变量（CATPAW_COOKIE）`);
    return env;
  }
  try {
    const login = readDesktopLogin();
    log.verbose(`凭证来源 默认登录态（uid ${login.uid || "-"}）`);
    return { token: login.token, uid: login.uid };
  } catch {
    /* 落到下面的报错 */
  }
  throw new CatPawError(503, "CatPaw 没有可用的登录凭证：请在账号页添加账号（粘贴登录态或从本机客户端导入）", {
    fatal: true,
  });
}

module.exports = {
  catpawHome,
  desktopAuthFile,
  passportTokenOf,
  readDesktopLogin,
  desktopSummary,
  envCredentials,
  resolveCredentials,
  MAX_AUTH_FILE_SIZE,
};

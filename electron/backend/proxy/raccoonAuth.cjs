// 反代网关 · 商汤小浣熊本地登录文件（~/.box-agent/config/auth.json）读写
//
// 这个文件是 AgentHub 号池与官方桌面客户端共用的凭据真身，双方各自维护一份内存态。
// 只在一侧刷新并持有新 refresh_token 时，另一侧拿旧值去刷就会被 401 打回登录墙（实测掉登录根因），
// 因此刷新链路必须双向同步：刷前以文件里的最新 refresh_token 为准，刷新成功后原子写回。
// 写回口径对齐官方（会话1 §1.3 _write_auth_state）：合并式只改凭据键、其余字段不动，
// 临时文件 + rename 原子替换 + 回读校验。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** 凭据三键（官方 Electron 刷新只回写这三键，见会话1 §3.1） */
const AUTH_KEYS = ["access_token", "refresh_token", "office_identity"];

function authFile() {
  return path.join(os.homedir(), ".box-agent", "config", "auth.json");
}

/** 读明文登录文件（不存在 / 坏 JSON / 结构异常一律返回 null，调用方按「文件不可用」处理） */
function readAuth() {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 取文件里的凭据三元组 */
function readTokens() {
  const j = readAuth();
  if (!j) return null;
  return {
    accessToken: String(j.access_token || "").trim(),
    refreshToken: String(j.refresh_token || "").trim(),
    officeIdentity: String(j.office_identity || "").trim(),
  };
}

/** 从 JWT payload 解账户 ID（小浣熊顶层 iss；sid 是登录会话 ID 兜底，与 discovery.scanRaccoon 同口径） */
function tokenUid(token) {
  try {
    const p = String(token || "").trim().split(".");
    if (p.length < 2) return "";
    const payload = JSON.parse(Buffer.from(p[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return String((payload && (payload.iss || payload.sid)) || "");
  } catch {
    return "";
  }
}

/**
 * 本地文件是否确属该账号。号池可多号而 auth.json 只有一份，回写串号会把桌面端别的号顶掉，
 * 必须先验明正身：access 的 iss 与账号 uid 一致，或 refresh_token 与传入快照同值（同号铁证）。
 * 命中返回文件凭据（可安全采用/回写），否则返回 null（绝不碰该文件）。
 */
function ownedTokens(accountUid, secretsRefresh) {
  const t = readTokens();
  if (!t) return null;
  const iss = tokenUid(t.accessToken);
  if (iss && accountUid && String(iss) === String(accountUid)) return t;
  if (t.refreshToken && secretsRefresh && t.refreshToken === secretsRefresh) return t;
  return null;
}

/**
 * 合并式原子写回凭据：只覆盖传入的键，其余字段保持原样；写后回读校验 access 落位。
 * 一律返回 {ok, message} 而不抛——后台刷新同步是尽力而为，绝不因此中断刷新主流程。
 */
function writeTokens({ accessToken, refreshToken, officeIdentity } = {}) {
  const file = authFile();
  const cur = readAuth();
  if (!cur) return { ok: false, message: "本地登录文件不存在或不可解析" };
  const next = { ...cur };
  if (accessToken) next.access_token = String(accessToken);
  if (refreshToken) next.refresh_token = String(refreshToken);
  if (officeIdentity) next.office_identity = String(officeIdentity);
  const tmp = `${file}.agenthub-tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 残留临时文件不影响原文件 */ }
    return { ok: false, message: `写入登录文件失败：${(e && e.message) || e}` };
  }
  try {
    const back = JSON.parse(fs.readFileSync(file, "utf8"));
    if (accessToken && String(back.access_token || "") !== String(accessToken)) {
      return { ok: false, message: "回读校验失败：access_token 未落位" };
    }
  } catch (e) {
    return { ok: false, message: `回读解析失败：${(e && e.message) || e}` };
  }
  return { ok: true, file };
}

module.exports = { authFile, readAuth, readTokens, tokenUid, ownedTokens, writeTokens, AUTH_KEYS };

// 反代网关 · 凭据接入（方案 §2.4 矩阵）：本地扫描（首选）→ OAuth 登录（兜底）→ 手动粘贴
// - WorkBuddy：%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\ 下 workbuddy*.info 明文 JSON（含历史快照）
// - Trae SOLO CN：storage.json 里 iCubeServerData 明文积分可读；iCubeAuthInfo 是 byteCrypto 信封，
//   离线解密依赖安装目录 main.js 内的 pepper（不做硬编码），主路径走 OAuth 回环登录（127.0.0.1:17388）
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const store = require("./store.cjs");
const rules = require("./rules.cjs");
const util = require("./util.cjs");
const adapters = require("./adapters.cjs");

const OAUTH_PORT = 17388;

// ===== 本地扫描 =====

function wbAuthDir() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodeBuddyExtension", "Data", "Public", "auth");
}

/** 扫描 WorkBuddy auth 文件（当前登录态 + 历史快照 workbuddy-desktop.<ts>.<pid>.<uuid>.info） */
function scanWorkBuddy() {
  const dir = wbAuthDir();
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^workbuddy.*\.info$/i.test(f));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const token = data.accessToken || data.access_token || "";
      if (!token) continue;
      out.push({
        channel: "workbuddy", // CN 与国际版共享账号体系布局，导入时可改渠道
        uid: String(data.uid || data.userId || ""),
        name: String(data.nickname || data.displayName || data.userName || ""),
        token: String(token),
        refreshToken: String(data.refreshToken || data.refresh_token || ""),
        expiresAt: util.toMs(data.expiresAtMs || data.expiresAt),
        // WB 头矩阵元数据（X-Domain / X-Enterprise-Id 的真值来源）
        meta: {
          domain: String(data.domain || data.Domain || ""),
          enterpriseId: String(data.enterpriseId || data.enterprise_id || ""),
          editionType: String(data.editionType || ""),
        },
        source: "scan",
        file,
      });
    } catch { /* 单个快照坏了不影响其他 */ }
  }
  return out;
}

/** 扫描 Trae 本地登录态：明文积分/套餐可读；JWT 是 byteCrypto 信封，给出去 OAuth 的引导 */
function scanTrae() {
  const out = [];
  const candidates = ["Trae CN", "TRAE SOLO CN"].map((n) =>
    path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), n, "User", "globalStorage", "storage.json")
  );
  // 取 mtime 最新者（方案 §2.1 双候选探测）
  const existing = candidates
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!existing.length) return out;
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(existing[0].p, "utf8"));
  } catch {
    return out;
  }
  // iCubeServerData://icube.cloudide：明文商业化 JSON（订阅/积分零请求即得）
  let credits = 0;
  let expiresAt = 0;
  let uid = "";
  try {
    const serverData = JSON.parse(data["iCubeServerData://icube.cloudide"] || "{}");
    credits = Number(util.dig(serverData, /remain|balance|credit|quota/i)) || 0;
    expiresAt = util.toMs(util.dig(serverData, /expire|end_time|deadline/i));
  } catch { /* 明文键缺失也继续 */ }
  // iCubeAuthInfo://icube-dc:<deviceId> 键名可推出设备 id；uid 从 gtm.users 取
  try {
    const users = JSON.parse(data["icube_gtm.users"] || "[]");
    if (Array.isArray(users) && users.length) uid = String(users[0].uid || users[0].id || "");
  } catch { /* 忽略 */ }
  const hasAuthEnvelope = !!data["iCubeAuthInfo://icube.cloudide"];
  out.push({
    channel: "trae",
    uid,
    name: "",
    token: "", // byteCrypto 信封，需 OAuth 或手动粘贴获取 JWT
    refreshToken: "",
    credits,
    expiresAt,
    source: "scan",
    encrypted: hasAuthEnvelope, // true = 检测到登录态但无法离线解密
    file: path.basename(existing[0].p),
  });
  return out;
}

/** 全量扫描（三渠道候选） */
function scanAll() {
  const wb = scanWorkBuddy();
  const trae = scanTrae();
  return [...trae, ...wb];
}

/** 导入扫描结果入池：同渠道同 uid 已存在则更新凭据（刷新 token），否则新建 */
function importCandidate(candidate, channelOverride) {
  const channel = channelOverride || candidate.channel;
  if (!candidate.token) throw new Error("该候选不含可用凭据（Trae 本地登录态已加密，请用 OAuth 登录或手动粘贴）");
  const existing = store.listAccounts(channel).find((a) => a.uid && a.uid === candidate.uid);
  if (existing) {
    store.updateAccount(existing.id, {
      token: candidate.token,
      refreshToken: candidate.refreshToken || undefined,
      expiresAt: candidate.expiresAt || undefined,
      meta: candidate.meta || undefined,
      status: "online",
      coolUntil: 0,
      coolReason: "",
    });
    return { id: existing.id, updated: true };
  }
  const id = store.addAccount({
    channel,
    uid: candidate.uid,
    name: candidate.name,
    token: candidate.token,
    refreshToken: candidate.refreshToken,
    source: "scan",
    expiresAt: candidate.expiresAt,
    meta: candidate.meta,
  });
  return { id, updated: false };
}

// ===== Trae OAuth 回环登录（方案 §2.4 兜底路径；参考项目 oauth_loopback 复刻） =====

let oauthSession = null; // { server, timer, resolve }

/** 生成登录 URL（client 凭证可被 rules/headers.json 的 trae.clientId 覆盖） */
function buildLoginUrl(state, machineId, deviceId) {
  const c = rules.get("headers.json").trae;
  const q = new URLSearchParams({
    client_id: c.clientId,
    client_secret: "-",
    app_id: c.appId,
    auth_callback_url: `http://127.0.0.1:${OAUTH_PORT}/authorize`,
    state,
    machine_id: machineId,
    device_id: deviceId,
    response_type: "code",
  });
  return `https://www.trae.cn/authorization?${q.toString()}`;
}

/**
 * 开始 OAuth：起回环服务 → 返回登录 URL（主进程负责 shell.openExternal）
 * 回调拿到 refreshToken/accessToken 后 ExchangeToken 换/补 accessToken，GetUserInfo 补 uid，
 * 原子写回号池，结果经 onDone 回调（广播到渲染层）
 */
function beginOAuth(onDone) {
  if (oauthSession) throw new Error("已有进行中的登录，请先完成或等待超时");
  const state = crypto.randomBytes(16).toString("hex");
  const machineId = crypto.randomBytes(16).toString("hex");
  // 设备指纹要 15 位纯数字：hex 去字母再补零会得到大量全零后缀，熵极低
  const deviceId = Array.from(crypto.randomBytes(15), (b) => b % 10).join("");
  const url = buildLoginUrl(state, machineId, deviceId);

  return new Promise((resolve) => {
    const finish = (result) => {
      if (!oauthSession) return;
      clearTimeout(oauthSession.timer);
      try { oauthSession.server.close(); } catch { /* 已关 */ }
      oauthSession = null;
      onDone(result);
    };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url || "/", `http://127.0.0.1:${OAUTH_PORT}`);
      if (u.pathname !== "/authorize") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      (async () => {
        const q = u.searchParams;
        // CSRF 防线：state 必须与发起会话一致。不校验时攻击者可诱导受害者浏览器访问
        // /authorize?accessToken=<攻击者token>，把攻击者账号注入受害者号池，流量全走别人的号
        if (!oauthSession || q.get("state") !== state) {
          res.statusCode = 400;
          res.end("<meta charset=utf-8><body style='font-family:monospace;background:#0b0d0f;color:#f26d6d;display:grid;place-items:center;height:100vh'>登录失败：state 校验不通过（非本次发起的授权回调）</body>");
          finish({ ok: false, message: "state 校验不通过，已拒绝该回调" });
          return;
        }
        let accessToken = (q.get("accessToken") || "").replace(/^Cloud-IDE-JWT\s+/i, "");
        let refreshToken = q.get("refreshToken") || "";
        const code = q.get("code") || "";
        if (!accessToken && (refreshToken || code)) {
          // 只有 code 时用 ExchangeToken 交换（参考项目同路径）
          const r = await adapters.get("trae").refreshToken(null, { token: "", refreshToken: refreshToken || code });
          if (r.ok) {
            accessToken = r.token;
            refreshToken = r.refreshToken;
          }
        }
        if (!accessToken) {
          res.end("<meta charset=utf-8><body style='font-family:monospace;background:#0b0d0f;color:#ddd;display:grid;place-items:center;height:100vh'>登录失败：回调未携带凭据，请返回重试</body>");
          finish({ ok: false, message: "回调未携带凭据" });
          return;
        }
        const info = await adapters.get("trae").userInfo(accessToken).catch(() => ({ uid: util.jwtDecode(accessToken).uid, name: "" }));
        const uid = info.uid || util.jwtDecode(accessToken).uid;
        // 同 uid 已在池：更新凭据而不是再加一行（回调重放/重复登录不产生重复账号）
        const existing = uid ? store.listAccounts().find((a) => a.channel === "trae" && a.uid === uid) : null;
        let id;
        if (existing) {
          store.updateAccount(existing.id, { token: accessToken, refreshToken, status: "online", coolUntil: 0, coolReason: "" });
          id = existing.id;
        } else {
          id = store.addAccount({
            channel: "trae",
            uid,
            name: info.name || (uid ? `Trae ${uid.slice(-6)}` : "Trae 账号"),
            token: accessToken,
            refreshToken,
            source: "oauth",
          });
        }
        res.end("<meta charset=utf-8><body style='font-family:monospace;background:#0b0d0f;color:#44e07f;display:grid;place-items:center;height:100vh'>登录成功，已加入 Trae 号池，可关闭本页</body>");
        finish({ ok: true, id, uid });
      })().catch((e) => {
        res.end("<meta charset=utf-8><body>登录失败</body>");
        finish({ ok: false, message: String((e && e.message) || e) });
      });
    });
    server.on("error", (e) => {
      oauthSession = null;
      resolve({ ok: false, message: `回环端口 ${OAUTH_PORT} 被占用：${e.message}` });
    });
    server.listen(OAUTH_PORT, "127.0.0.1", () => {
      oauthSession = {
        server,
        timer: setTimeout(() => finish({ ok: false, message: "登录超时（3 分钟）" }), 180000),
      };
      resolve({ ok: true, url });
    });
  });
}

function cancelOAuth() {
  if (!oauthSession) return false;
  clearTimeout(oauthSession.timer);
  try { oauthSession.server.close(); } catch { /* 已关 */ }
  oauthSession = null;
  return true;
}

module.exports = { scanAll, scanWorkBuddy, scanTrae, importCandidate, beginOAuth, cancelOAuth, OAUTH_PORT, wbAuthDir };

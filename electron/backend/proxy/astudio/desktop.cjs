/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-10
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// AStudio 桌面端登录态只读导入。
// 依据 Agent2Providers `astudio/accounts.rs` 模块头：
//   <DataRoot>/userdata/astron-session.json
//       {modelBearerToken, token, accountId, uid, ssoSessionId, banned?}
//   <DataRoot>/runtime/acode-home/config.toml
//       [model_providers.astron-spark] experimental_bearer_token = "…"
// DataRoot 的找法（按顺序）：
//   1. ASTUDIO_HOME / SYNARA_HOME 环境变量；
//   2. Windows 注册表 HKCU\Software\AStudioStorage 的
//      Production/Canary/DevelopmentDataRoot；
//   3. ~/.acode/acode/。
// **只读**：不写回、不改客户端文件。注册表读取失败（无 reg.exe / 无键）只跳过这一路，
// 继续走文件候选，不把整个导入判死。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REGISTRY_KEY = "HKCU\\Software\\AStudioStorage";
const PREFIXES = ["Production", "Canary", "Development"];

function envRoots() {
  const roots = [];
  for (const name of ["ASTUDIO_HOME", "SYNARA_HOME"]) {
    const value = String(process.env[name] || "").trim();
    if (value) roots.push(value);
  }
  return roots;
}

/** 读注册表的三个 DataRoot 值（失败返回空数组，不抛） */
function registryRoots() {
  if (process.platform !== "win32") return [];
  let text = "";
  try {
    text = execFileSync("reg", ["query", REGISTRY_KEY, "/s"], {
      encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const roots = [];
  const wanted = new Set(PREFIXES.map((prefix) => `${prefix}DataRoot`.toLowerCase()));
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^\s{2,}([A-Za-z0-9_]+)\s+REG_SZ\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    if (!wanted.has(match[1].toLowerCase())) continue;
    const value = match[2].trim();
    if (value) roots.push(value);
  }
  return roots;
}

/** 本机数据根候选（去重、保持优先级） */
function dataRoots() {
  const home = process.env.USERPROFILE || os.homedir();
  const roots = [
    ...envRoots(),
    ...registryRoots(),
    path.join(home, ".acode", "acode"),
  ];
  const seen = new Set();
  return roots.filter((root) => {
    const key = path.resolve(root).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** TOML 里 `[model_providers.astron-spark]` 段的 bearer（只做行级解析，不引 TOML 库） */
function configToken(text) {
  let inside = false;
  let token = "";
  let uid = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inside = trimmed.replace(/^\[/, "").replace(/\]$/, "").trim() === "model_providers.astron-spark";
      continue;
    }
    if (!inside) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (key === "experimental_bearer_token") token = value;
    else if (key === "uid" || key === "account_id") uid = value;
  }
  return { token, uid };
}

/** 桌面端的 Cookie 形态（与 accounts.rs cookie_header 逐字同序） */
function cookieHeader(session) {
  const parts = [];
  if (session.ssoSessionId) {
    parts.push(`ssoSessionId=${session.ssoSessionId}`);
    parts.push(`sso_sessionid=${session.ssoSessionId}`);
  }
  if (session.accountId) parts.push(`account_id=${session.accountId}`);
  if (session.token) parts.push(`token=${session.token}`);
  return parts.join("; ");
}

/** 读一次桌面端登录态。返回 {ok, key, uid, cookie, origin} 或 {ok:false,message} */
function readDesktopState() {
  const roots = dataRoots();
  const problems = [];
  for (const root of roots) {
    const sessionFile = path.join(root, "userdata", "astron-session.json");
    try {
      const stat = fs.statSync(sessionFile);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      const value = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      if (value && value.banned === true) return { ok: false, message: `AStudio 账号已被封禁（${sessionFile}）` };
      const key = String(value?.modelBearerToken || value?.token || "").trim();
      if (!key) continue;
      const session = {
        token: String(value?.token || "").trim(),
        accountId: String(value?.accountId || "").trim(),
        ssoSessionId: String(value?.ssoSessionId || "").trim(),
      };
      return {
        ok: true, key, uid: String(value?.uid || "").trim(),
        cookie: cookieHeader(session), origin: sessionFile,
        source: "desktop",
      };
    } catch (error) {
      if (error && error.code !== "ENOENT") problems.push(`${sessionFile}: ${error.message}`);
    }
    // 兜底：acode 的 config.toml（部分安装只有这一份）
    for (const configFile of [path.join(root, "runtime", "acode-home", "config.toml"), path.join(root, "config.toml")]) {
      try {
        const stat = fs.statSync(configFile);
        if (!stat.isFile() || stat.size > 1024 * 1024) continue;
        const parsed = configToken(fs.readFileSync(configFile, "utf8"));
        if (!parsed.token) continue;
        return {
          ok: true, key: parsed.token, uid: parsed.uid,
          cookie: "", origin: configFile, source: "desktop-config",
        };
      } catch (error) {
        if (error && error.code !== "ENOENT") problems.push(`${configFile}: ${error.message}`);
      }
    }
  }
  return {
    ok: false,
    message: roots.length
      ? `未找到 AStudio 桌面端登录态（已查：${roots.join(" / ")}）`
      : "未找到 AStudio 桌面端数据目录（ASTUDIO_HOME / SYNARA_HOME / 注册表 / ~/.acode 均未命中）",
    detail: problems.slice(0, 4).join("；"),
  };
}

module.exports = { readDesktopState, dataRoots, registryRoots, cookieHeader, configToken, REGISTRY_KEY };

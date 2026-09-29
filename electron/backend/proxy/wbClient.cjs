// 反代网关 · WorkBuddy 双区桌面客户端本机环境探测（进程检测 / 关闭 / 启动 / 安装定位）
//
// 为什么切号前必须关客户端：WorkBuddy 桌面端在内存里持有当前登录态，运行期间会刷新并把它
// 回写进登录文件（%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop*.info）。
// 不关进程直接切号，客户端一刷新就把刚写入的新账号覆盖回旧账号。所以切号顺序是
// 「关进程 → 等退出 → 再读文件 → 写回 → 校验 → 拉起」，读文件必须在关进程之后（退出瞬间的回写已落定）。
//
// 进程名必须精确、绝不通配：WorkBuddy 的数据目录叫 CodeBuddyExtension，同机往往还装着腾讯
// CodeBuddy（CodeBuddy.exe）与 Trae 系列——进程名一旦带上 "CodeBuddy" 就是误杀他人进程的事故。
//   中国区 WorkBuddy.exe / 国际版 WorkBuddyAI.exe 是两个互不相干的进程，双区各自独立、互不牵连。
//
// exe 定位三级（找不到就由调用方降级为「仅切换 + 提示手动重启」，绝不关掉打不开的东西）：
//   ① 运行中进程反查（切号时客户端通常正跑，最可靠）
//   ② 注册表 Uninstall 项的 DisplayIcon（覆盖装在非标准盘符的情况，本机实测装在 E:）
//   ③ 安装目录候选表
// 注册表反查按 DisplayIcon 的文件名（而非 DisplayName）归属渠道——「WorkBuddy AI 5.6.2」的
// DisplayName 也含 "WorkBuddy"，用名字匹配会串区，用可执行文件名匹配天然区分。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync, spawn } = require("node:child_process");

/** 渠道 → 客户端显示名 + 进程/可执行文件名（双区共用一个 auth 目录，只能靠这两样区分） */
const WB_CLIENTS = {
  workbuddy: { label: "WorkBuddy CN", exe: "WorkBuddy.exe" },
  workbuddy_ai: { label: "WorkBuddy AI", exe: "WorkBuddyAI.exe" },
};

function clientOf(channel) {
  return WB_CLIENTS[channel] || WB_CLIENTS.workbuddy;
}

/** 200ms 粒度无损休眠（不占 CPU，对齐 raccoonClient.syncSleep） */
function syncSleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 降级兜底 */ }
  }
}

/** tasklist 单进程探测：命中输出含 ".exe"，未命中输出中文提示（兜底输出乱码也不影响判定） */
function procRunning(name) {
  if (process.platform !== "win32") return false;
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { encoding: "utf8", windowsHide: true, timeout: 8000 });
    return /\.exe/i.test(out);
  } catch {
    return false;
  }
}

/** 指定渠道的客户端是否在运行（只看自己那一份进程，双区互不牵连） */
function isWorkbuddyRunning(channel) {
  const main = procRunning(clientOf(channel).exe);
  return { running: main, main };
}

/**
 * 关闭指定渠道的客户端并等待退出。先发关闭请求（taskkill 不带 /F，编辑器得以正常收尾）
 * 给 3 秒；仍在跑（例如被「有未保存内容」的确认框拦住）再强杀进程树。
 * 默认 8s 总超时；杀不掉返回 false，调用方中止切换且不改动任何文件。
 * stdio 全静默：不带 /F 的那一趟对子进程必然报「只能强制终止此进程(带 /F 选项)」，
 * 强杀那趟也会对已退出的项报错——这些是预期噪音，漏到主进程 stderr 上只会刷屏。
 */
function killWorkbuddy(channel, timeoutMs = 8000) {
  if (process.platform !== "win32") return true;
  const name = clientOf(channel).exe;
  const total = Math.max(1000, timeoutMs);
  const quiet = { encoding: "utf8", windowsHide: true, timeout: 8000, stdio: ["ignore", "ignore", "ignore"] };
  if (procRunning(name)) {
    // ① 优雅退出：向窗口发关闭请求，让编辑器保存/询问未保存内容
    try { execSync(`taskkill /IM "${name}" /T`, quiet); } catch { /* 可能已退出 */ }
    const softDeadline = Date.now() + Math.min(3000, total);
    while (Date.now() < softDeadline) {
      if (!procRunning(name)) return true;
      syncSleep(200);
    }
    // ② 强杀（连带 Chromium 多进程树）
    try { execSync(`taskkill /F /IM "${name}" /T`, quiet); } catch { /* 可能已退出 */ }
  }
  const deadline = Date.now() + total;
  while (Date.now() < deadline) {
    if (!procRunning(name)) return true;
    syncSleep(200);
  }
  return !procRunning(name);
}

/** 注册表 Uninstall 项的 DisplayIcon 全量取值（可能为空行 / 带 ",0" 图标索引 / 带引号）。
 *  必须先 Where-Object 过滤：卸载项里大量条目没有 DisplayIcon，直接 -ExpandProperty 会对
 *  每一条缺失该属性的项报一条错（实测刷出 80KB 噪音），且 2>$null 抑制不了这种流内错误记录。 */
function registryDisplayIcons() {
  if (process.platform !== "win32") return [];
  try {
    const out = execSync(
      'powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-ItemProperty \'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*\',\'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*\',\'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*\' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayIcon } | Select-Object -ExpandProperty DisplayIcon"',
      { encoding: "utf8", windowsHide: true, timeout: 8000 }
    );
    return String(out)
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^"|"$/g, "").replace(/,\s*-?\d+$/, "")) // 去引号与图标索引
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 安装路径候选表（注册表与进程反查都落空时的兜底；覆盖少数装在非标准位置的场景） */
function exeCandidates(channel) {
  const exe = clientOf(channel).exe;
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const dirs = [
    path.join(localAppData, "Programs", "WorkBuddy"),
    path.join(localAppData, "WorkBuddy"),
    path.join(pf, "WorkBuddy"),
    path.join(pf86, "WorkBuddy"),
    "C:\\WorkBuddy",
    "D:\\WorkBuddy",
    "E:\\WorkBuddy",
    "F:\\WorkBuddy",
  ];
  // 双区目录名与进程名同形（WorkBuddy / WorkBuddyAI），按渠道各拼一份
  const stem = exe.replace(/\.exe$/i, "");
  const list = dirs.map((d) => path.join(d, exe));
  for (const d of dirs) list.push(path.join(d.replace(/WorkBuddy$/, stem), exe));
  return list;
}

/** 定位客户端可执行文件（找不到返回空串，由调用方降级为「手动关闭/打开」提示） */
function findWorkbuddyExe(channel) {
  if (process.platform !== "win32") return "";
  const exe = clientOf(channel).exe;
  // ① 运行中进程反查（一次调用拿全部同名进程路径，取第一个存在的）
  try {
    const out = execSync(
      `powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process -Name '${exe.replace(/\.exe$/i, "")}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path"`,
      { encoding: "utf8", windowsHide: true, timeout: 8000 }
    );
    for (const line of String(out).split(/\r?\n/)) {
      const p = line.trim();
      if (p && fs.existsSync(p)) return p;
    }
  } catch { /* 反查失败继续下一条线索 */ }
  // ② 注册表 DisplayIcon：按可执行文件名归属渠道（双区名称重叠，用名字匹配会串区）
  for (const icon of registryDisplayIcons()) {
    if (path.basename(icon).toLowerCase() === exe.toLowerCase() && fs.existsSync(icon)) return icon;
  }
  // ③ 候选目录表
  for (const cand of exeCandidates(channel)) {
    try {
      if (fs.existsSync(cand)) return cand;
    } catch { /* 下一个 */ }
  }
  return "";
}

/** 启动客户端（分离进程，不阻塞；失败如实返回，不影响已完成的切号） */
function launchWorkbuddy(exe) {
  if (!exe) return { ok: false, message: "未找到 WorkBuddy 可执行文件，请手动打开客户端" };
  try {
    const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return { ok: true, file: exe };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

module.exports = { WB_CLIENTS, clientOf, isWorkbuddyRunning, killWorkbuddy, findWorkbuddyExe, launchWorkbuddy };
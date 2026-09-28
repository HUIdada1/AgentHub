// 反代网关 · 商汤小浣熊桌面客户端本机环境探测（进程检测 / 关闭 / 启动 / 安装定位）
//
// 为什么切号前必须关客户端：桌面端与 box-agent ACP 运行时各自在内存里持有一份登录态，
// 运行期间会刷新并把它回写进 ~/.box-agent/config/auth.json（raccoonAuth.cjs 文件头：
// 两侧内存态不同步就是"实测掉登录根因"）。不关进程直接切号，客户端一退出/一刷新
// 就把刚写入的新账号覆盖回旧账号 —— 表现为"退出登录影响了切号结果"。
//
// 探测口径（保守：宁误报不漏报。漏报=静默覆盖登录态，误报=多一次确认框，代价不对称）：
//   ① box-agent-acp.exe：ASCII 进程名，tasklist 无编码风险
//   ② 商汤小浣熊.exe：中文进程名，Node→cmd→tasklist 走 Unicode 命令行实测可用；
//      命中判定只看输出里是否出现 ".exe"（未命中时 tasklist 输出中文提示，与编码无关）
//   ③ Electron lockfile（%APPDATA%\office-raccoon\lockfile）内 PID 查活：客户端运行时存在、
//      正常退出即删；三条线索取或，任一可用即可兜住其余场景（中文名/进程名变更）
// 非 Windows 平台不做进程保护（小浣熊桌面端以 Windows 为主），相关函数安全降级。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync, spawn } = require("node:child_process");

/** 客户端进程：主进程 + 内嵌 ACP 运行时，两者运行期间都会回写 auth.json */
const PROC_MAIN = "商汤小浣熊.exe";
const PROC_ACP = "box-agent-acp.exe";

/** 200ms 粒度无损休眠（不占 CPU，对齐 zcodeLocal.syncSleep） */
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

/** Electron lockfile PID 查活（宽松解析：取首个 ≥2 位数字串；格式随 Electron 版本变，不依赖具体形状） */
function lockfileAlive() {
  if (process.platform !== "win32") return false;
  try {
    const lf = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "office-raccoon", "lockfile");
    const m = String(fs.readFileSync(lf, "utf8")).match(/\d{2,}/);
    if (!m) return false;
    const out = execSync(`tasklist /FI "PID eq ${m[0]}" /NH`, { encoding: "utf8", windowsHide: true, timeout: 8000 });
    return /\.exe/i.test(out);
  } catch {
    return false;
  }
}

/** 客户端是否在运行（三线索取或；main=桌面主进程，acp=ACP 运行时，lock=lockfile） */
function isRaccoonRunning() {
  const main = procRunning(PROC_MAIN);
  const acp = procRunning(PROC_ACP);
  const lock = lockfileAlive();
  return { running: main || acp || lock, main, acp, lock };
}

/** 关闭全部相关进程并等待退出（默认 8s 超时；杀不掉返回 false，调用方中止切换）。
 *  等待只盯两个进程是否消失（lockfile 可能异常残留，不参与退出判定，避免 PID 复用误判拖死流程） */
function killRaccoon(timeoutMs = 8000) {
  if (process.platform !== "win32") return true;
  // 先主客户端（/T 连带 Chromium 多进程树与子服务），再 ACP 运行时
  for (const n of [PROC_MAIN, PROC_ACP]) {
    try { execSync(`taskkill /F /IM "${n}" /T`, { encoding: "utf8", windowsHide: true, timeout: 8000 }); } catch { /* 可能已退出 */ }
  }
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    if (!procRunning(PROC_MAIN) && !procRunning(PROC_ACP)) return true;
    syncSleep(200);
  }
  return !procRunning(PROC_MAIN) && !procRunning(PROC_ACP);
}

/** 安装路径候选表 + 运行中进程反查（找不到返回空串，由调用方降级为"手动打开"提示） */
function findRaccoonExe() {
  if (process.platform !== "win32") return "";
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const dirs = [
    path.join(localAppData, "Programs", "raccoon-ai"),
    path.join(localAppData, "Programs", "商汤小浣熊"),
    path.join(localAppData, "raccoon-ai"),
    path.join(pf, "raccoon-ai"),
    path.join(pf86, "raccoon-ai"),
    "C:\\raccoon-ai",
    "D:\\raccoon-ai",
    "E:\\raccoon-ai",
    "F:\\raccoon-ai",
  ];
  for (const d of dirs) {
    const p = path.join(d, PROC_MAIN);
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* 下一个 */ }
  }
  // 运行中进程反查：ACP 等子进程路径含 <install>\resources\ → 上溯出安装根再拼主程序名
  try {
    const out = execSync(
      'powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like \'*raccoon-ai*\' } | Select-Object -ExpandProperty Path"',
      { encoding: "utf8", windowsHide: true, timeout: 8000 }
    );
    for (const line of String(out).split(/\r?\n/)) {
      const p = line.trim();
      if (!p) continue;
      const m = p.match(/^(.*)[\\/]resources[\\/]/i);
      const cand = m ? path.join(m[1], PROC_MAIN) : p;
      try {
        if (fs.existsSync(cand) && /\.exe$/i.test(cand) && !/uninstall|box-agent/i.test(cand)) return cand;
      } catch { /* 下一个 */ }
    }
  } catch { /* 反查失败按未找到处理 */ }
  return "";
}

/** 启动客户端（分离进程，不阻塞；失败如实返回，不影响已完成的切号） */
function launchRaccoon(exe) {
  const file = exe || findRaccoonExe();
  if (!file) return { ok: false, message: "未找到小浣熊可执行文件，请手动打开客户端" };
  try {
    const child = spawn(file, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return { ok: true, file };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

module.exports = { PROC_MAIN, PROC_ACP, isRaccoonRunning, killRaccoon, findRaccoonExe, launchRaccoon };

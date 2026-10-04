// 反代网关 · Qoder 客户端安装定位（qoder / qoder_intl 共用）
//
// 用户可能以多种形态安装 Qoder 客户端，resources 目录位置随之不同（全部实测于本机）：
//   ① 默认安装：%LOCALAPPDATA%\Programs\<exeLabel>\resources
//   ② 启动器（launcher）形态：应用本体在版本目录里，如
//      %LOCALAPPDATA%\Qoder\Qoder Launcher\state.ini
//        [launcher] installDir=E:\Qoder   appExecutable=.qoder-versions\0.3.3\Qoder.exe
//      → resources = <installDir>\.qoder-versions\0.3.3\resources
//      （state.ini 为 UTF-16LE；install.ini 是旧字段/兜底）
//   ③ 解包直装：%LOCALAPPDATA%\<exeLabel>\resources
//   ④ 注册表兜底（自定义安装路径、无 launcher）：Uninstall 项 DisplayIcon / InstallLocation
//
// 硬编码单一路径会在 launcher/自定义路径安装上失明——wasm 签名器与风控身份（runtime-info.exe）
// 都依赖本模块，定位失败即该渠道不可调用。找到即缓存；全部失败返回 null（不缓存失败：
// 用户装完客户端后无需重启 AgentHub）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** 产品 → exeLabel（安装目录名，与 qoderAuth.PRODUCTS 共用同一份事实源） */
const EXE_LABELS = { qoder: "Qoder CN", qoder_intl: "Qoder" };
/** 产品 → 环境变量覆盖键（调试/测试用：直接指定 resources 目录） */
const ENV_KEYS = { qoder: "AGENTHUB_QODER_RESOURCES", qoder_intl: "AGENTHUB_QODER_INTL_RESOURCES" };

const cache = new Map(); // product -> resources 绝对路径

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

/** 解析启动器 ini（UTF-16LE（带 BOM）或 UTF-8 均可读）→ { installDir, appExecutable } */
function readLauncherIni(file) {
  let text = "";
  try {
    const buf = fs.readFileSync(file);
    const isUtf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf.length > 3 && buf[1] === 0x00 && buf[3] === 0x00);
    text = buf.toString(isUtf16 ? "utf16le" : "utf8");
  } catch {
    return null;
  }
  const pick = (k) => {
    const m = text.match(new RegExp(`^\\s*${k}\\s*=\\s*(.+?)\\s*$`, "m"));
    return m ? m[1].trim() : "";
  };
  const installDir = pick("installDir");
  if (!installDir) return null;
  return { installDir, appExecutable: pick("appExecutable") };
}

/** 目录名是否属于该产品：CN 与 INTL 是两套并行安装，不能互相命中 */
function sameProductDir(dirName, exeLabel) {
  if (!/qoder/i.test(dirName)) return false;
  const wantCn = /\bCN\b/i.test(exeLabel);
  const isCn = /\bCN\b/i.test(dirName) || /中国/i.test(dirName);
  return wantCn === isCn;
}

/** launcher 形态候选：扫 %LOCALAPPDATA% 下属于该产品的目录里的 *Launcher*（不猜死目录名） */
function launcherResources(exeLabel) {
  const local = localAppData();
  const out = [];
  let subs = [];
  try {
    subs = fs.readdirSync(local);
  } catch {
    return out;
  }
  for (const sub of subs) {
    if (!sameProductDir(sub, exeLabel)) continue;
    const base = path.join(local, sub);
    let inners = [];
    try {
      inners = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const inner of inners) {
      if (!/launcher/i.test(inner)) continue;
      const dir = path.join(base, inner);
      const st = readLauncherIni(path.join(dir, "state.ini")) || readLauncherIni(path.join(dir, "install.ini"));
      if (!st) continue;
      const appDir = st.appExecutable ? path.join(st.installDir, path.dirname(st.appExecutable)) : st.installDir;
      out.push(path.join(appDir, "resources"));
      if (appDir !== st.installDir) out.push(path.join(st.installDir, "resources")); // 版本目录已清时的兜底
    }
  }
  return out;
}

/** 注册表块的解析结果（一次查询两产品复用；reg.exe 单次 ~100ms，避免每个候选重复跑） */
let regBlocks = null;
function queryRegBlocks() {
  if (regBlocks) return regBlocks;
  const roots = [
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const blocks = [];
  for (const root of roots) {
    let txt = "";
    try {
      txt = execFileSync("reg.exe", ["query", root, "/s", "/f", "Qoder", "/d"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1 << 20,
      });
    } catch {
      continue; // 无匹配（reg 退出码 1）或平台不支持
    }
    for (const block of txt.split(/\r?\n\r?\n/)) {
      const name = (block.match(/DisplayName\s+REG_SZ\s+(.+)/i) || [])[1] || "";
      if (!/qoder/i.test(name)) continue;
      const icon = (block.match(/DisplayIcon\s+REG_SZ\s+(.+)/i) || [])[1] || "";
      const loc = (block.match(/InstallLocation\s+REG_SZ\s+(.+)/i) || [])[1] || "";
      const iconDir = icon ? path.dirname(icon.replace(/,+\d+$/, "").replace(/^"|"$/g, "")) : "";
      blocks.push({ name, iconDir, loc });
    }
  }
  regBlocks = blocks;
  return blocks;
}

/** 注册表兜底：Uninstall 项的 DisplayIcon / InstallLocation（仅在前述候选全失败时调用） */
function registryResources(exeLabel) {
  const wantCn = /\bCN\b/i.test(exeLabel);
  const out = [];
  for (const b of queryRegBlocks()) {
    // Qoder CN 与 Qoder 是两套安装：DisplayName 归属要分清
    const isCn = /\bCN\b/i.test(b.name) || /中国/i.test(b.name);
    if (wantCn !== isCn) continue;
    if (b.loc) out.push(path.join(b.loc, "resources"));
    if (b.iconDir) out.push(path.join(b.iconDir, "resources"));
  }
  return out;
}

/** resources 目录候选（按命中概率排序；返回第一个存在 app.asar.unpacked 的候选） */
function candidates(product) {
  const exeLabel = EXE_LABELS[product];
  if (!exeLabel) return [];
  const local = localAppData();
  const out = [];
  const env = ENV_KEYS[product] && process.env[ENV_KEYS[product]];
  if (env) out.push(env);
  out.push(path.join(local, "Programs", exeLabel, "resources"));
  out.push(path.join(local, exeLabel, "resources"));
  out.push(...launcherResources(exeLabel));
  out.push(...registryResources(exeLabel));
  return [...new Set(out.filter(Boolean))];
}

/**
 * 定位某产品的 resources 目录（含 app.asar.unpacked 才算命中）。
 * 成功缓存；失败返回 null 且不缓存（装完客户端无需重启）。
 */
function findResources(product) {
  const hit = cache.get(product);
  if (hit && fs.existsSync(hit)) return hit;
  for (const c of candidates(product)) {
    try {
      if (fs.existsSync(c) && fs.existsSync(path.join(c, "app.asar.unpacked"))) {
        cache.set(product, c);
        return c;
      }
    } catch {
      /* 单个候选异常不阻断后续 */
    }
  }
  return null;
}

/** 风控身份生成器（领取接口必需，见 qoderAuth.readRiskIdentity） */
function runtimeInfoPath(product) {
  const res = findResources(product);
  return res ? path.join(res, "umid", "runtime-info.exe") : "";
}

/** 清缓存（自测用：安装目录是探测结果，测试要能重放） */
function clearCache() {
  cache.clear();
  regBlocks = null;
}

module.exports = { EXE_LABELS, ENV_KEYS, findResources, runtimeInfoPath, clearCache, readLauncherIni, sameProductDir, queryRegBlocks, localAppData };

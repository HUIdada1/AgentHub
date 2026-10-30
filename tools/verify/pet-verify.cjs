/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-30
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/**
 * 桌宠模块（卡冈图雅）· 纯代码静态验证
 *
 * 不启动 Electron、不需要 GPU：只做「契约一致性」与「接线完整性」检查。
 * 用法：
 *   node tools/verify/pet-verify.cjs           报告模式
 *   node tools/verify/pet-verify.cjs --assert  断言模式（有失败则退出码 1）
 *
 * 覆盖：
 *   1. 模块文件齐全
 *   2. 默认值三处逐字一致（backend/config.cjs、pet/pet-config.cjs、src/types/index.ts）
 *   3. 6 条 pet_* IPC 在四处一一对应（preload、pet-ipc、ipc.ts、mock）
 *   4. 主进程 / 设置面板挂载点存在
 *   5. 渲染层 GLSL uniform 与 JS uniforms() 一一对应、两个 pass 都有有效区 discard
 *   6. 窗口三要素（无边框 / 透明 / 置顶 / 穿透 / 不占任务栏）
 *   7. 需求配置项（大小 / 转速 / 扭曲强度 / 特效开关 / 右键菜单）
 *   8. index.html 脚本加载顺序（file:// 下禁用 ES module）
 *   9. 全部 .cjs 与渲染层 .js 的 Node 语法检查
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const has = (rel) => fs.existsSync(path.join(ROOT, rel));

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail: detail || "" });
  } catch (e) {
    results.push({ ok: false, name, detail: String((e && e.message) || e) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ===== 1. 文件齐全 =====
const MODULE_FILES = [
  "electron/pet/index.cjs",
  "electron/pet/pet-config.cjs",
  "electron/pet/pet-window.cjs",
  "electron/pet/pet-menu.cjs",
  "electron/pet/pet-actions.cjs",
  "electron/pet/pet-input.cjs",
  "electron/pet/pet-capture.cjs",
  "electron/pet/pet-ipc.cjs",
  "electron/pet/preload-pet.cjs",
  "electron/pet/README.md",
  "electron/pet/web/index.html",
  "electron/pet/web/pet.css",
  "electron/pet/web/app.js",
  "electron/pet/web/capture.js",
  "electron/pet/web/lens.js",
  "electron/pet/web/disk.js",
  "electron/pet/web/renderer.js",
  "docs/桌宠/01-模块契约.md",
  "docs/桌宠/02-渲染层规格.md",
];
check("模块文件齐全", () => {
  const missing = MODULE_FILES.filter((f) => !has(f));
  assert(missing.length === 0, "缺少：" + missing.join(", "));
  return MODULE_FILES.length + " 个文件";
});

// ===== 2. 默认值三处一致 =====
check("默认值三处一致", () => {
  const backend = require(path.join(ROOT, "electron/backend/config.cjs"));
  const petConfigMod = require(path.join(ROOT, "electron/pet/pet-config.cjs"));
  const ts = read("src/types/index.ts");
  const m = ts.match(/export const PET_CONFIG_DEFAULTS: PetConfig = (\{[\s\S]*?\n\});/);
  assert(m, "src/types/index.ts 里找不到 PET_CONFIG_DEFAULTS 字面量");
  // 对象里全是普通字面量（数字/布尔/字符串/null/嵌套对象），可直接当 JS 求值
  const tsDefaults = Function("return " + m[1])();
  const backendDefaults = backend.defaultConfig().pet;
  const petDefaults = petConfigMod.DEFAULTS;

  const walk = (a, b, prefix, diffs) => {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
      const pa = prefix ? prefix + "." + k : k;
      const av = a ? a[k] : undefined;
      const bv = b ? b[k] : undefined;
      if (av && typeof av === "object" && !Array.isArray(av)) walk(av, bv, pa, diffs);
      else if (av !== bv) diffs.push(`${pa}: backend=${JSON.stringify(av)} pet=${JSON.stringify(bv)}`);
    }
  };
  const d1 = [];
  const d2 = [];
  walk(backendDefaults, petDefaults, "", d1);
  walk(backendDefaults, tsDefaults, "", d2);
  assert(d1.length === 0, "backend 与 pet-config 默认值不一致 → " + d1.join("; "));
  assert(d2.length === 0, "backend 与 types 默认值不一致 → " + d2.join("; "));
  return Object.keys(petDefaults).length + " 个顶层字段一致";
});

// ===== 3. 6 条 IPC 通道一一对应 =====
const PET_CHANNELS = [
  "pet_status",
  "pet_config_save",
  "pet_set_enabled",
  "pet_reset_position",
  "pet_usage_today",
  "pet_optimize_preview",
];
const uniq = (arr) => [...new Set(arr)].sort();
check("6 条 pet_* 通道四处一致", () => {
  const preload = uniq((read("electron/preload.cjs").match(/"(pet_[a-z_]+)"/g) || []).map((s) => s.slice(1, -1)));
  const ipc = uniq((read("electron/pet/pet-ipc.cjs").match(/h\("(pet_[a-z_]+)"/g) || []).map((s) => s.match(/"([^"]+)"/)[1]));
  const api = uniq((read("src/api/ipc.ts").match(/"(pet_[a-z_]+)"/g) || []).map((s) => s.slice(1, -1)));
  const mock = uniq((read("src/api/mock.ts").match(/case "(pet_[a-z_]+)"/g) || []).map((s) => s.match(/"([^"]+)"/)[1]));
  const expect = uniq(PET_CHANNELS);
  for (const [name, list] of [["preload.cjs", preload], ["pet-ipc.cjs", ipc], ["ipc.ts", api], ["mock.ts", mock]]) {
    assert(list.length === expect.length, `${name} 通道数 ${list.length} ≠ 6（${list.join(",")}）`);
    assert(expect.every((c) => list.includes(c)), `${name} 缺少通道：${expect.filter((c) => !list.includes(c)).join(",")}`);
  }
  return "preload / pet-ipc / ipc.ts / mock.ts 各 6 条";
});

// ===== 4. 挂载点 =====
check("主进程挂载点", () => {
  const main = read("electron/main.cjs");
  assert(main.includes('require("./pet/index.cjs")'), "main.cjs 未 require pet 模块");
  assert(main.includes("pet.boot("), "main.cjs 未调用 pet.boot");
  assert(main.includes("pet.reloadConfig("), "main.cjs 未在配置保存后 reloadConfig");
  assert(main.includes("pet.shutdown("), "main.cjs 未在退出时 shutdown");
  return "require + boot + reloadConfig + shutdown";
});
check("设置面板挂载点", () => {
  const types = read("src/types/index.ts");
  assert(/\{\s*key:\s*"pet",\s*name:\s*"桌宠组件"/.test(types), "SETTINGS_TABS 缺少桌宠组件页签");
  const dialog = read("src/components/config/SettingsDialog.vue");
  assert(dialog.includes("ConfigPetSection"), "SettingsDialog 未引入 ConfigPetSection");
  assert(dialog.includes('app.settingsTab === \'pet\''), "SettingsDialog 未挂载桌宠页容器");
  const sec = read("src/components/config/ConfigPetSection.vue");
  assert(sec.includes("petSetEnabled"), "ConfigPetSection 未接总开关 IPC");
  return "左列页签 + 懒挂载 + 6 条 IPC 调用面";
});

// ===== 5. 渲染层 GLSL 与 uniforms() 一致性 =====
function shaderStats(file, uniformKeysBlockRe, fragmentRe) {
  const src = read(file);
  const fragMatch = src.match(fragmentRe);
  assert(fragMatch, file + " 找不到 FRAGMENT 着色器字符串");
  const frag = fragMatch[1];
  const uniforms = [...frag.matchAll(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?\w+\s+(\w+)/g)].map((x) => x[1]);
  const uniformsBlock = src.match(uniformKeysBlockRe);
  assert(uniformsBlock, file + " 找不到 uniforms() 返回块");
  const keys = [...uniformsBlock[1].matchAll(/(?:^|\n)\s*(\w+):/g)].map((x) => x[1]);
  const missing = uniforms.filter((u) => !keys.includes(u));
  return { frag, uniforms, keys, missing };
}
check("Pass1 引力透镜：uniform 对齐 + 盘形扭曲区域 + 径向公式", () => {
  const s = shaderStats("electron/pet/web/lens.js", /function uniforms\(s\) \{\s*return \{([\s\S]*?)\n    \};/, /const FRAGMENT = `([\s\S]*?)`;/);
  assert(s.missing.length === 0, "lens.js 有 uniform 未在 uniforms() 提供：" + s.missing.join(","));
  assert(s.frag.includes("discard"), "lens.js 缺少有效区域 discard");
  assert(/r\s*>\s*u_Rh\s*\*/.test(s.frag), "lens.js 缺少半径早退（r > u_Rh * D_DISCARD）");
  // ★ 扭曲区域必须是「跟随主体轮廓（黑球+盘）的包络 + 外缘羽化」，不能再回到以黑洞为圆心的大圆
  assert(s.frag.includes("dBody") && s.frag.includes("bodyMask"), "lens.js 缺少跟随主体轮廓的扭曲区域（dBody/bodyMask）");
  assert(/mix\(theta,\s*srcR,\s*bodyMask\)/.test(s.frag), "lens.js 缺少「采样位移随羽化带收敛」（会与真实桌面重影）");
  assert(!/r\s*>\s*R_outer/.test(s.frag), "lens.js 仍在用大圆 R_outer 作为可见外缘");
  assert(/theta\s*-\s*\(?thetaE\s*\*\s*thetaE\)?\s*\/\s*max\(theta/.test(s.frag) || /theta - .*thetaE.*thetaE.*\/.*theta/.test(s.frag), "lens.js 缺少史瓦西径向公式 beta = theta - thetaE²/theta");
  assert(!/fisheye|barrel|鱼眼|桶形/.test(s.frag), "lens.js 片元里出现鱼眼/桶形关键词（禁止）");
  assert(s.frag.includes("u_screenTex"), "lens.js 未采样桌面纹理");
  return s.uniforms.length + " 个 uniform 全部对齐，盘形遮罩 + 径向公式";
});
check("Pass1/Pass2 盘几何一致（扭曲区域与可见盘面不错位）", () => {
  const lensSrc = read("electron/pet/web/lens.js");
  const diskSrc = read("electron/pet/web/disk.js");
  const pick = (src, name) => {
    const m = src.match(new RegExp(name + ":\\s*([0-9.]+)"));
    assert(m, "找不到常量 " + name);
    return Number(m[1]);
  };
  const pairs = [
    ["D_R_IN", "R_IN"],
    ["D_R_OUT", "R_OUT"],
    ["D_TILT", "TILT"],
  ];
  for (const [a, b] of pairs) {
    const va = pick(lensSrc, a);
    const vb = pick(diskSrc, b);
    assert(va === vb, `${a}=${va} 与 ${b}=${vb} 不一致（背景扭曲区域会与盘面错位）`);
  }
  return "D_R_IN/D_R_OUT/D_TILT = " + pick(lensSrc, "D_R_IN") + "/" + pick(lensSrc, "D_R_OUT") + "/" + pick(lensSrc, "D_TILT");
});
check("Pass2 吸积盘：uniform 对齐 + 有效区剔除 + 三层像 + 多普勒", () => {
  const s = shaderStats("electron/pet/web/disk.js", /function uniforms\(s\) \{\s*return \{([\s\S]*?)\n    \};/, /const FRAGMENT = `([\s\S]*?)`;/);
  assert(s.missing.length === 0, "disk.js 有 uniform 未在 uniforms() 提供：" + s.missing.join(","));
  assert(s.frag.includes("discard"), "disk.js 缺少有效区域 discard");
  assert(/R_OUT|R_IN/.test(s.frag), "disk.js 缺少盘内/外缘常量");
  assert(s.frag.includes("DOPPLER"), "disk.js 缺少多普勒明暗");
  assert(s.frag.includes("ARC_GAIN") || /背/.test(s.frag), "disk.js 缺少背面拱弧层");
  assert(s.frag.includes("RING_R"), "disk.js 缺少光子环");
  return s.uniforms.length + " 个 uniform 全部对齐，三层像齐全";
});

// ===== 6. 窗口三要素 =====
check("悬浮窗属性（无边框/透明/置顶/穿透/不占任务栏）", () => {
  const w = read("electron/pet/pet-window.cjs");
  const need = [
    ["frame: false", "无边框"],
    ["transparent: true", "透明"],
    ['backgroundColor: "#00000000"', "透明底色"],
    ["skipTaskbar: true", "不占任务栏"],
    ["setAlwaysOnTop(", "置顶"],
    ["setIgnoreMouseEvents(", "点击穿透"],
    ["setContentProtection(", "采样不递归拍自己"],
    ["hasShadow: false", "无阴影"],
  ];
  const missing = need.filter(([frag]) => !w.includes(frag)).map(([frag, name]) => name + "(" + frag + ")");
  assert(missing.length === 0, "pet-window.cjs 缺少：" + missing.join(", "));
  return need.map((x) => x[1]).join(" / ");
});

// ===== 7. 需求配置项 =====
check("配置项覆盖需求", () => {
  const types = read("src/types/index.ts");
  const petType = types.match(/export interface PetConfig \{[\s\S]*?\n\}/);
  assert(petType, "types 里找不到 PetConfig 接口");
  const body = petType[0];
  const fields = ["size", "diskSpeed", "lensStrength", "fxEnabled", "rightMenu", "enabled"];
  const missing = fields.filter((f) => !new RegExp("\\b" + f + "\\??:").test(body));
  assert(missing.length === 0, "PetConfig 缺少字段：" + missing.join(","));
  const sec = read("src/components/config/ConfigPetSection.vue");
  for (const k of ["size", "diskSpeed", "lensStrength", "fxEnabled"]) {
    assert(sec.includes('"' + k + '"') || sec.includes(k), "设置页未暴露 " + k);
  }
  assert(sec.includes("右键菜单功能"), "设置页缺少右键菜单自定义区");
  return fields.join(" / ") + " + rightMenu 5 项";
});

// ===== 8. index.html 脚本顺序 =====
check("渲染层加载顺序（file:// 禁用 ES module）", () => {
  const html = read("electron/pet/web/index.html");
  // 只看真实的 <script> 标签属性，避免注释里「禁止 type="module"」这句话被误判
  assert(!/<script[^>]*type\s*=\s*["']module["']/.test(html), "index.html 用了 ES module（file:// 下会白屏）");
  const order = ["capture.js", "lens.js", "disk.js", "renderer.js", "app.js"].map((f) =>
    html.indexOf('src="' + f + '"')
  );
  assert(order.every((i) => i >= 0), "index.html 缺少脚本：" + order.map((i, idx) => (i < 0 ? ["capture.js", "lens.js", "disk.js", "renderer.js", "app.js"][idx] : "")).filter(Boolean).join(","));
  for (let i = 1; i < order.length; i++) assert(order[i] > order[i - 1], "脚本加载顺序错误（必须 capture→lens→disk→renderer→app）");
  return "capture → lens → disk → renderer → app";
});

// ===== 9. 语法检查 =====
check("全部脚本 Node 语法检查", () => {
  const files = [
    ...fs.readdirSync(path.join(ROOT, "electron/pet")).filter((f) => f.endsWith(".cjs")).map((f) => "electron/pet/" + f),
    ...fs.readdirSync(path.join(ROOT, "electron/pet/web")).filter((f) => f.endsWith(".js")).map((f) => "electron/pet/web/" + f),
  ];
  const bad = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" });
    } catch (e) {
      bad.push(f + ": " + String((e && e.stderr) || e).toString().slice(0, 300));
    }
  }
  assert(bad.length === 0, bad.join(" | "));
  return files.length + " 个脚本通过";
});

// ===== 输出 =====
function main() {
  const isAssert = process.argv.includes("--assert");
  console.log("=================================================");
  console.log(" 桌宠模块（卡冈图雅）· 纯代码静态验证");
  console.log("=================================================\n");
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    if (r.ok) {
      pass++;
      console.log(`  [PASS] ${r.name}${r.detail ? " — " + r.detail : ""}`);
    } else {
      fail++;
      console.error(`  [FAIL] ${r.name}\n         ${r.detail}`);
    }
  }
  console.log("\n=================================================");
  console.log(` 结果：通过 ${pass} 项，失败 ${fail} 项`);
  console.log("=================================================");
  if (isAssert && fail > 0) process.exit(1);
}

if (require.main === module) main();
module.exports = { runCheck: () => ({ results }) };

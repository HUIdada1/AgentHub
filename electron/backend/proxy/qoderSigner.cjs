// 反代网关 · Qoder 请求签名器（WASM 驱动）
//
// 为什么需要它：Qoder 的推理请求**每请求签名**（20 个头，含 Cosy-Date 与绑定请求体的签名），
// 且请求体经 Encode=1 自定义编码——两者都由 Qoder 客户端内置的 wasm 完成，无法手工构造。
// 本模块把该 wasm 及其 wasm-bindgen 胶水从**本机已安装客户端**中提取出来，在 Node 里独立驱动。
//
// 客户端形态与提取路径（都是实测出来的，单一路径会在另一种安装上失明）：
//   · 安装定位：默认路径 / launcher 版本目录 / 注册表兜底 —— 见 qoderInstall.cjs
//   · 提取分两条，补丁产物对上层暴露同一套 API（initGlue() / glue()）：
//     ① 截断路径（0.4.x）：在 worker 入口 `SY(),Bir(` 处截断（不截断会启动 worker 主循环挂住），
//        追加 `export{t9 as initGlue,Hm as glue}`；
//     ② 通用路径（0.3.x 等）：混淆变量名随版本变化（入口标记可能整体不存在），
//        故不认名字认结构——按 wasm-bindgen 的稳定特征现取变量名：
//          · 内嵌 wasm：`<X>="AGFzbQEAAAA…`（base64 魔数）+ 其懒加载器 `,<Y>=b(()=>{…})`
//          · 胶水容器：`er(<Z>,{…QoderContext:()=>…})`（键名是 wasm-bindgen 真名，跨版本稳定）
//          · 胶水懒加载器：由 `ProfileEncryptor` 实现类的 `=class` 定义向前定位
//        追加补丁：触发两个懒加载 + 导出 initGlue()/glue()（内部用内嵌 base64 初始化 wasm）。
//     两条路径的产物缓存键一致：obf 的 size+mtime + 提取方式，客户端升级自动重建。
//
// 胶水为**标准 wasm-bindgen 产物**，import 全部来自 ./qoder_auth_wasm_bg.js；wasm 本体 298,606 B，
// 17 个公开 API（qodercontext_* / requestresult_* / generate_runtime_auth_fields /
// decrypt_server_response / model_cache_* / credential_storage_* 等）。
//
// 已知代价：缓存模块 33MB（Node 解析约 1s），仅在首次使用 qoder 渠道时惰性加载。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const config = require("../config.cjs");
const install = require("./qoderInstall.cjs");

const ENTRY_MARK = "SY(),Bir("; // 0.4.x worker 入口；截断点（未命中则走通用提取）
const CACHE_VERSION = 2; // v2：新增通用提取路径 + 安装定位多候选，旧缓存自动失效

/** 客户端 resources 目录（多候选定位，见 qoderInstall.cjs） */
function installResources(product) {
  return install.findResources(product) || "";
}

/** 定位 worker obf 与客户端版本 */
function locate(product) {
  const res = install.findResources(product);
  if (!res) return null;
  // SDK 目录名按版本而异（实测 0.3.3 国际版 = qoder-agent-sdk；0.4.x CN = qoder-cn-agent-sdk）——
  // 两个都试，命中即用，不按产品名硬编码
  for (const sdk of ["qoder-agent-sdk", "qoder-cn-agent-sdk"]) {
    const obf = path.join(res, "app.asar.unpacked", "node_modules", "@qoder-ai", sdk, "dist", "_worker", "qoder-worker-runtime.obf.mjs");
    if (!fs.existsSync(obf)) continue;
    let version = "0.4.3";
    try {
      const bm = JSON.parse(fs.readFileSync(path.join(res, "build-manifest.json"), "utf8"));
      if (bm && bm.productVersion) version = String(bm.productVersion);
    } catch { /* 缺失则用兜底版本号（版本串实测宽容：0.2.x~9.9.9 均通过签名） */ }
    return { obf, version, resources: res, sdk };
  }
  return null;
}

/**
 * 通用提取：不认混淆名、按 wasm-bindgen 结构特征现取变量名。
 * 返回 { loaderGlue, loaderWasm, glueVar, wasmVar, initAsync, initSync, names }
 */
function pickByStructure(text) {
  const pick = (re) => {
    const m = text.match(re);
    return m ? m[1] : "";
  };
  const names = {
    wasmVar: pick(/([A-Za-z_$][\w$]*)="AGFzbQEAAAA/),
    loaderWasm: pick(/,\s*([A-Za-z_$][\w$]*)=b\(\(\)=>\{[A-Za-z_$][\w$]*="AGFzbQEAAAA/),
    glueVar: pick(/er\(([A-Za-z_$][\w$]*),\s*\{[^{}]{0,800}?QoderContext:\(\)=>/),
    profileEnc: pick(/ProfileEncryptor:\(\)=>([A-Za-z_$][\w$]*)/),
    initSync: pick(/initSync:\(\)=>([A-Za-z_$][\w$]*)/),
  };
  // default（async init）在 glue 的 er 调用段内取
  const erStart = text.search(/er\([A-Za-z_$][\w$]*,\s*\{[^{}]{0,800}?QoderContext:/);
  if (erStart >= 0) {
    const m = text.slice(erStart, erStart + 1400).match(/default:\(\)=>([A-Za-z_$][\w$]*)/);
    if (m) names.initAsync = m[1];
  }
  // 胶水懒加载器：ProfileEncryptor 实现类的 =class 定义前
  if (names.profileEnc) {
    const at = text.indexOf(names.profileEnc + "=class");
    if (at > 0) {
      const before = text.slice(Math.max(0, at - 400), at);
      const m = before.match(/,([A-Za-z_$][\w$]*)=b\(\(\)=>\{$/) || before.match(/([A-Za-z_$][\w$]*)=b\(\(\)=>\{/);
      if (m) names.loaderGlue = m[1];
    }
  }
  return names;
}

/** 生成补丁文本；两条路径产物对上层暴露同一套 API：initGlue()（async）/ glue() */
function patchText(text) {
  const cut = text.indexOf(ENTRY_MARK);
  if (cut >= 0) {
    return `${text.slice(0, cut)}\nexport{t9 as initGlue,Hm as glue};\n`;
  }
  const n = pickByStructure(text);
  const missing = ["wasmVar", "loaderWasm", "glueVar", "loaderGlue", "initAsync"].filter((k) => !n[k]);
  if (missing.length) {
    throw new Error(`Qoder worker 结构变化：通用提取缺 ${missing.join("/")}（客户端版本可能大改，需重新适配）`);
  }
  return [
    text,
    "",
    `try { ${n.loaderGlue}(); } catch (e) { /* 懒加载失败留给 initGlue 报错 */ }`,
    `try { ${n.loaderWasm}(); } catch (e) { /* 懒加载失败留给 initGlue 报错 */ }`,
    `export async function initGlue() { await ${n.initAsync}(Buffer.from(${n.wasmVar}, "base64")); }`,
    `export function glue() { return ${n.glueVar}; }`,
    "",
  ].join("\n");
}

function cacheDir() {
  const d = path.join(config.dataDir(), "proxy", "qoder-signer");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 提取 + 追加导出 → 缓存模块；返回可 import 的绝对路径 */
function buildPatchedModule(product, loc) {
  if (!loc || !loc.obf) throw new Error(`${product} 客户端未安装或结构不匹配，无法提取签名器`);
  const st = fs.statSync(loc.obf);
  // 缓存键 = 产品 + SDK 目录 + obf 指纹 + 补丁代次；**先查缓存再读文件**——
  // obf 是 33MB，缓存命中时再读一遍既浪费又会让多次调用把内存打爆
  const hash = crypto.createHash("sha256").update(`${product}:${loc.sdk || ""}:${st.size}:${Math.floor(st.mtimeMs)}:v${CACHE_VERSION}`).digest("hex").slice(0, 16);
  const out = path.join(cacheDir(), `worker-${product}-${hash}.mjs`);
  if (fs.existsSync(out)) return out;
  const text = fs.readFileSync(loc.obf, "utf8");
  const patched = patchText(text);
  const tmp = out + ".tmp";
  fs.writeFileSync(tmp, patched, "utf8");
  fs.renameSync(tmp, out);
  // 清理旧版本缓存（同渠道只保留最新一份，避免 33MB 累积）
  try {
    for (const f of fs.readdirSync(cacheDir())) {
      if (f.startsWith(`worker-${product}-`) && f !== path.basename(out) && f.endsWith(".mjs")) {
        fs.unlinkSync(path.join(cacheDir(), f));
      }
    }
  } catch { /* 清理失败不影响功能 */ }
  return out;
}

// ===== 签名器实例（按渠道缓存）=====

const signerCache = new Map(); // product → Promise<{glue, version}> | null(不可用)

async function loadGlue(product) {
  if (signerCache.has(product)) return signerCache.get(product);
  const p = (async () => {
    const loc = locate(product);
    if (!loc) return null; // 客户端未安装：该渠道不可签名（凭据可导入但无法调用）
    const mod = await import(pathToFileURL(buildPatchedModule(product, loc)).href);
    await mod.initGlue();
    return { glue: mod.glue(), version: loc.version, resources: loc.resources, sdk: loc.sdk };
  })();
  signerCache.set(product, p);
  return p;
}

/** 渠道是否可用（客户端已安装且胶水加载成功） */
async function available(product) {
  try {
    return !!(await loadGlue(product));
  } catch {
    return false;
  }
}

/**
 * 为某账号建立签名会话。
 * 关键：签名材料由**该账号的 token** 派生（generate_runtime_auth_fields）——
 * 这正是早期 "Signature invalid" 的缺环：不派生而传空串，签名必被拒。
 */
async function createSession({ product, token, uid, machineId }) {
  const loaded = await loadGlue(product);
  if (!loaded) throw new Error(`${product} 客户端未安装，无法签名（请先安装并登录对应版本）`);
  const { glue, version } = loaded;

  const seed = JSON.stringify({
    uid,
    security_oauth_token: token,
    organization_id: "",
    organization_tags: [], // 必须是数组（wasm 侧 Rust serde 校验）
    data_policy_agreed: true,
  });
  const runtime = JSON.parse(glue.generate_runtime_auth_fields(seed));
  const userAuth = {
    uid,
    encrypt_user_info: runtime.encrypt_user_info,
    key: runtime.key,
    organization_id: "",
    organization_tags: [],
    data_policy_agreed: true,
  };
  // clientInfo 传空对象即可：wasm 内置默认值，仍产出完整 Cosy-* 头（实测）
  const ctx = new glue.QoderContext(machineId || "00000000-0000-0000-0000-000000000000", version, JSON.stringify(userAuth), "{}");
  ctx.refreshAuthFields(JSON.stringify(userAuth));

  return {
    version,
    /** 生成签名+编码后的推理请求：arg1=origin，arg2=请求体 JSON 字符串，arg3=modelKey，arg4=source */
    prepareInferRequest(origin, bodyJson, modelKey, source = "system") {
      const r = ctx.prepareInferRequest(origin, bodyJson, modelKey, source);
      const headers = {};
      const pairs = r.headers instanceof Map ? [...r.headers.entries()] : Object.entries(r.headers || {});
      for (const [k, v] of pairs) headers[k] = String(v);
      return { url: r.url, headers, body: Buffer.from(r.body.buffer ?? r.body) };
    },
    /** 目录缓存解密：catalog-v6 文件文本 + uid → JSON 文本 */
    modelCacheDecrypt(text, ownerUid) {
      return glue.model_cache_decrypt(text, ownerUid);
    },
    free() {
      try { ctx.free && ctx.free(); } catch { /* 忽略 */ }
    },
  };
}

/** 供自测/诊断：返回定位与加载信息 */
async function describe(product) {
  const loc = locate(product);
  const info = { product, installed: !!loc, obf: loc ? loc.obf : null, version: loc ? loc.version : null, resources: loc ? loc.resources : null, sdk: loc ? loc.sdk : null };
  if (loc) {
    try {
      const loaded = await loadGlue(product);
      info.glueLoaded = !!loaded;
      info.exports = loaded ? Object.keys(loaded.glue).length : 0;
    } catch (e) {
      info.glueError = String((e && e.message) || e).slice(0, 160);
    }
  }
  return info;
}

module.exports = { locate, available, createSession, describe, installResources, buildPatchedModule, patchText, pickByStructure };

// 反代网关 · Qoder 请求签名器（WASM 驱动）
//
// 为什么需要它：Qoder 的推理请求**每请求签名**（20 个头，含 Cosy-Date 与绑定请求体的签名），
// 且请求体经 Encode=1 自定义编码——两者都由 Qoder 客户端内置的 wasm 完成，无法手工构造。
// 本模块把该 wasm 及其 wasm-bindgen 胶水从**本机已安装客户端**中提取出来，在 Node 里独立驱动。
//
// 提取策略（不 vendor 厂商产物，避免再分发与版本漂移）：
//   qoder-worker-runtime.obf.mjs（33MB，wasm 以 base64 内嵌于 dAi 工厂）
//     → 在入口 `SY(),Bir(` 处截断（不截断会启动 worker 主循环挂住，实测）
//     → 追加 `export{t9 as initGlue,Hm as glue}`
//     → 写入缓存目录，动态 import，initGlue() 后即可 new QoderContext(...)
//   缓存键 = obf 的 size+mtime，客户端升级自动重建。
//
// 胶水为**标准 wasm-bindgen 产物**（import 全部来自 ./qoder_auth_wasm_bg.js，共 31 个内建），
// 因此截断+追加导出即可，无需重写 ABI。wasm 本体 298,606 B，34 个导出（qodercontext_* /
// requestresult_* / generate_runtime_auth_fields / decrypt_server_response / model_cache_* 等）。
//
// 已知代价：缓存模块约 33MB（Node 解析约 1s），仅在首次使用 qoder 渠道时惰性加载；
// 后续可收窄为「胶水区段 + wasm base64」的 ~10KB 切片（边界已定位：import 表 @EAi，
// 辅助函数簇，类定义 qnA/khe），列为 P1 优化。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const config = require("../config.cjs");

const ENTRY_MARK = "SY(),Bir("; // worker 入口；截断点
const CACHE_VERSION = 1;

/** 客户端安装根：%LOCALAPPDATA%\Programs\Qoder[ CN]\resources */
function installResources(product) {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const dirName = product === "qoder_intl" ? "Qoder" : "Qoder CN";
  return path.join(local, "Programs", dirName, "resources");
}

/** 定位 worker obf 与客户端版本 */
function locate(product) {
  const res = installResources(product);
  const obf = path.join(res, "app.asar.unpacked", "node_modules", "@qoder-ai",
    product === "qoder_intl" ? "qoder-agent-sdk" : "qoder-cn-agent-sdk",
    "dist", "_worker", "qoder-worker-runtime.obf.mjs");
  if (!fs.existsSync(obf)) return null;
  let version = "0.4.3";
  try {
    const bm = JSON.parse(fs.readFileSync(path.join(res, "build-manifest.json"), "utf8"));
    if (bm && bm.productVersion) version = String(bm.productVersion);
  } catch { /* 缺失则用兜底版本号（版本串实测宽容：0.4.2~9.9.9 均通过签名） */ }
  return { obf, version, resources: res };
}

function cacheDir() {
  const d = path.join(config.dataDir(), "proxy", "qoder-signer");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 截断 + 追加导出 → 缓存模块；返回可 import 的绝对路径 */
function buildPatchedModule(product, loc) {
  const st = fs.statSync(loc.obf);
  const hash = crypto.createHash("sha256").update(`${product}:${st.size}:${Math.floor(st.mtimeMs)}:v${CACHE_VERSION}`).digest("hex").slice(0, 16);
  const out = path.join(cacheDir(), `worker-${product}-${hash}.mjs`);
  if (fs.existsSync(out)) return out;
  const text = fs.readFileSync(loc.obf, "utf8");
  const cut = text.indexOf(ENTRY_MARK);
  if (cut < 0) throw new Error("Qoder worker 结构变化：找不到入口标记（客户端版本可能大改）");
  const patched = `${text.slice(0, cut)}\nexport{t9 as initGlue,Hm as glue};\n`;
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
    return { glue: mod.glue(), version: loc.version };
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
  const info = { product, installed: !!loc, obf: loc ? loc.obf : null, version: loc ? loc.version : null };
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

module.exports = { locate, available, createSession, describe, installResources, buildPatchedModule };

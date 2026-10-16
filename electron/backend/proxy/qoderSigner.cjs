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
//          · 内嵌 wasm：`<X>="AGFzbQEAAAA…`（base64 魔数）+ 其懒加载器（任意包装形态）
//          · 胶水容器：`er(<Z>,{…})` 导出注册段（QoderContext 键名跨版本稳定，但
//            v3 起以 ProfileEncryptor 键反查 er 开括号，不再依赖 QoderContext 的距离）
//          · 胶水懒加载器：由 `ProfileEncryptor` 实现类的 `=class` 定义向前定位，
//            兜底从 er 容器开括号向前找最近的懒加载赋值
//        追加补丁：触发懒加载（可选）+ 导出 initGlue()/glue()（内部用内嵌 base64 初始化 wasm）。
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
const WASM_MAGIC = "AGFzbQEAAAA"; // 内嵌 wasm 的 base64 魔数（\0asm）；下面 pickByStructure 的正则里是同一串
// 必需特征：initGlue()/glue() 直接依赖的三个（wasm 字节、胶水容器、async init）。
// loaderWasm/loaderGlue 已降为可选（见 pickByStructure 末尾的补救逻辑与 patchText）：
// 顶层常量形态下它们本来就不存在，不触发也不会错；initGlue 不依赖它们。
const REQUIRED_FEATURES = ["wasmVar", "glueVar", "initAsync"];
const CACHE_VERSION = 3; // v3：pickByStructure 增加 profileEnc 反查 / 懒加载器形态放宽，旧缓存自动失效

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
 * 返回 { loaderGlue, loaderWasm, glueVar, wasmVar, initAsync, initSync, profileEnc }
 *
 * 每个特征都给**多条候选正则**（按精确度降序），命中即止——客户端换打包器/加字段时，
 * 先失配的往往是「引号类型」「空白」「容器长度上限」这类无关语义的细节，
 * 单条正则会把整条提取链一起拖死（issue #119 的表现就是五缺四）。
 * 候选一律**先严后宽**：宽的那条只在严的失配时才跑，故对已知结构的结果逐字不变。
 *
 * v3 补救（issue #119，适配 0.4.8 结构变化）：0.4.8 失效模式是**懒加载器包装形态变化**
 * （`X=b(()=>{` 不再是唯一形式）与 **er 容器字段增多/键名变化**（QoderContext 不再是
 * 可靠锚点）。profileEnc / initSync 是导出注册段内的键值对，只要段还在就命中——
 * 用它反查 er 容器，不依赖任何易变键名：
 *   · glueVar / initAsync：profileEnc 键之前最近的 `er(` 开括号（双验证：段内同时含
 *     `default:()=>` 与 `initSync:()=>`，防误匹配到其他 er 调用）
 *   · loaderWasm：wasmVar 声明处向前找最近的懒加载赋值（结尾锚定 `{`，任意包装形态）
 *   · loaderGlue：主路径（类定义前扫）放宽窗口；兜底从 er 容器开括号向前找懒加载赋值
 */
function pickByStructure(text) {
  const pick = (res) => {
    for (const re of Array.isArray(res) ? res : [res]) {
      const m = text.match(re);
      if (m) return m[1];
    }
    return "";
  };
  const names = {
    // 内嵌 wasm 的 base64 变量：引号有 " ' ` 三种写法
    wasmVar: pick([
      /([A-Za-z_$][\w$]*)="AGFzbQEAAAA/,
      /([A-Za-z_$][\w$]*)='AGFzbQEAAAA/,
      /([A-Za-z_$][\w$]*)=`AGFzbQEAAAA/,
    ]),
    // wasm 懒加载器：要求闭包**紧跟** wasm 赋值（`X=<包装>(...)=> {Y="AGFzbQEAAAA`）。
    // 注意：不能用「400 字符内有魔数」这类宽判据——33MB 文本里魔数出现多次
    // （base64 数据内部存在巧合子串），宽判据会误匹配到无关懒加载器（issue #119 实测
    // 命中 /dev/null 集合的 D7A）。「紧跟」既覆盖包装名变化（b 只是本版本名字），
    // 又天然排除巧合；闭包内赋值不紧跟的形态由下方补救⑤（从声明位置向前找）兜底。
    loaderWasm: pick([
      /,\s*([A-Za-z_$][\w$]*)=b\(\(\)=>\{[A-Za-z_$][\w$]*="AGFzbQEAAAA/,
      /,\s*([A-Za-z_$][\w$]*)=(?:async\s+)?(?:[\w$]+\s*)?\([^)]*\)\s*(?:=>)?\s*\{[A-Za-z_$][\w$]*="AGFzbQEAAAA/,
    ]),
    // 胶水容器 er(X,{…QoderContext:()=>…})：键名跨版本稳定，但容器字段会变多——
    // 原 800 字符上限在字段增加时会失配，宽松版放到 3000 并允许 er( 后有空白
    glueVar: pick([
      /er\(([A-Za-z_$][\w$]*),\s*\{[^{}]{0,800}?QoderContext:\(\)=>/,
      /er\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{[\s\S]{0,3000}?QoderContext\s*:\s*\(\)\s*=>/,
    ]),
    profileEnc: pick(/ProfileEncryptor:\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)/),
    initSync: pick(/initSync:\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)/),
  };
  // default（async init）在 glue 的 er 调用段内取；窗口同步放宽到 3000（字段变多时 default 更靠后）
  const erAt = text.search(/er\(\s*[A-Za-z_$][\w$]*\s*,\s*\{[\s\S]{0,3000}?QoderContext\s*:\s*\(\)\s*=>/);
  if (erAt >= 0) {
    const m = text.slice(erAt, erAt + 3000).match(/default:\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)/);
    if (m) names.initAsync = m[1];
  }
  // 胶水懒加载器（两条路径，命中即止）：
  //   ① ProfileEncryptor 实现类的 =class 定义前扫懒加载赋值（v3 窗口 400→1200，
  //      闭包形态从 b(()=>{ 放宽到任意「=…{」结尾的赋值）
  //   ② 从 glueVar 反查——包含 `er(glueVar,` 的那个 `X=b(()=>{` 闭包就是胶水模块的懒加载器。
  //      ②是①的兜底：客户端删掉/改名 ProfileEncryptor 时①必然失配，而 er(glueVar 这个锚点
  //      由 glueVar 的成功提取保证存在，不依赖任何易变的类名
  if (names.profileEnc) {
    const at = text.indexOf(names.profileEnc + "=class");
    if (at > 0) {
      const before = text.slice(Math.max(0, at - 1200), at);
      const m = before.match(/,([A-Za-z_$][\w$]*)=b\(\(\)=>\{$/) || before.match(/([A-Za-z_$][\w$]*)=b\(\(\)=>\{/) || before.match(/([A-Za-z_$][\w$]*)=[^{}]{0,200}\{$/);
      if (m) names.loaderGlue = m[1];
    }
  }
  if (!names.loaderGlue && names.glueVar) {
    // er(glueVar, 的位置：兼容 `er(X,{` 与 `er( X , {` 两种空白写法
    const at = text.search(new RegExp(`er\\(\\s*${names.glueVar.replace(/\$/g, "\\$")}\\s*,`));
    if (at > 0) {
      const before = text.slice(0, at);
      const idx = before.lastIndexOf("=b(()=>{");
      if (idx > 0) {
        const m = before.slice(0, idx).match(/([A-Za-z_$][\w$]*)$/);
        if (m) names.loaderGlue = m[1];
      }
    }
  }

  // ===== v3 补救（profileEnc 反查，不依赖 QoderContext 键名/距离）=====
  // er 容器开括号：ProfileEncryptor 键之前最近的 er(（wasm-bindgen 导出注册的标准格式是
  // `er(Z,{ProfileEncryptor:()=>…,…})`，ProfileEncryptor 通常紧跟开括号；双验证兜底）
  const peKeyAt = names.profileEnc ? text.indexOf("ProfileEncryptor:()=>" + names.profileEnc) : -1;
  const erOpenAt = peKeyAt > 0 ? text.lastIndexOf("er(", peKeyAt) : -1;
  // wasm 声明位置（loaderWasm 补救用）
  const wasmDeclAt = (() => {
    const m = text.match(/([A-Za-z_$][\w$]*)="AGFzbQEAAAA/);
    return m ? m.index : -1;
  })();
  if (erOpenAt >= 0) {
    const seg = text.slice(erOpenAt, erOpenAt + 8000);
    const isGlueSeg = /default:\s*\(\)\s*=>/.test(seg) && new RegExp("initSync:\\s*\\(\\)\\s*=>").test(seg);
    // ③ glueVar：er 开括号首参
    if (!names.glueVar && isGlueSeg) {
      const m = seg.match(/^er\(\s*([A-Za-z_$][\w$]*)\s*,/);
      if (m) names.glueVar = m[1];
    }
    // ④ initAsync：容器段内找 default:()=>（QoderContext 改名/挪远后原路径失配）
    if (!names.initAsync && isGlueSeg) {
      const m = seg.match(/default:\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)/);
      if (m) names.initAsync = m[1];
    }
    // ⑥ loaderGlue 兜底③：er 容器开括号向前找最近的懒加载赋值（任意包装形态）。
    //    字符类只排 { }（不排 =）：箭头函数的 `=>` 含 =，排掉会断匹配。
    if (!names.loaderGlue) {
      const m = text.slice(0, erOpenAt).match(/([A-Za-z_$][\w$]*)=[^{}]{0,200}\{$/);
      if (m) names.loaderGlue = m[1];
    }
  }
  // ⑤ loaderWasm 兜底：wasmVar 声明处向前找最近的懒加载赋值（b(()=>{ 形态变化时）。
  //    字符类只排 { }（不排 =）：同⑥，兼容 `X=async()=>{` 等箭头包装。
  if (!names.loaderWasm && wasmDeclAt > 0) {
    const m = text.slice(0, wasmDeclAt).match(/([A-Za-z_$][\w$]*)=[^{}]{0,200}\{$/);
    if (m) names.loaderWasm = m[1];
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
  const missing = REQUIRED_FEATURES.filter((k) => !n[k]);
  if (missing.length) {
    const err = new Error(`Qoder worker 结构变化：通用提取缺 ${missing.join("/")}（客户端版本可能大改，需重新适配）`);
    // 诊断上下文挂在错误上：buildPatchedModule 补上客户端版本/体积后一并抛出。
    // 「入口标记在不在 / 内嵌 wasm 还在不在」这两项决定这次是放宽正则就能救，
    // 还是客户端把 wasm 拆成了外链文件（那要新增一条读取路径，不是调正则的事）。
    err.qoderDiag = { entryMarkHit: false, hasInlineWasm: text.includes(WASM_MAGIC), features: n, missing };
    throw err;
  }
  // loaderWasm / loaderGlue 为可选（顶层常量形态下不存在，不触发也不会错）：
  // 有则触发懒加载（胶水/wasm 未加载时 initGlue 内部会报更直观的错），无则跳过。
  const lines = [text, ""];
  if (n.loaderGlue) {
    lines.push(`try { ${n.loaderGlue}(); } catch (e) { /* 懒加载失败留给 initGlue 报错 */ }`);
  }
  if (n.loaderWasm) {
    lines.push(`try { ${n.loaderWasm}(); } catch (e) { /* 懒加载失败留给 initGlue 报错 */ }`);
  }
  lines.push(
    `export async function initGlue() { await ${n.initAsync}(Buffer.from(${n.wasmVar}, "base64")); }`,
    `export function glue() { return ${n.glueVar}; }`,
    "",
  );
  return lines.join("\n");
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
  let patched;
  try {
    patched = patchText(text);
  } catch (e) {
    // 把「哪个版本、多大、入口标记在不在、内嵌 wasm 在不在、已命中哪些特征」补进消息。
    // 只靠「缺 X/Y/Z」用户没法自助，维护者也得反追问一轮；补上后一眼能判断适配方向。
    if (e && e.qoderDiag) {
      const d = e.qoderDiag;
      const hit = Object.keys(d.features || {}).filter((k) => d.features[k]);
      e.message +=
        `｜客户端版本=${loc.version} sdk=${loc.sdk || "?"} obf=${st.size}B` +
        `｜入口标记${d.entryMarkHit ? "命中" : "未命中"}，内嵌 wasm ${d.hasInlineWasm ? "在" : "不在"}，已命中特征=${hit.join(",") || "无"}` +
        `｜取证：node tools/proxy-qoder-probe.cjs`;
    }
    throw e;
  }
  const tmp = `${out}.tmp.${process.pid}`;
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
  // 成功才缓存（对齐 qoderInstall「不缓存失败」的设计声明）：失败/null 钉死在缓存里
  // 会让签名器一次性故障（结构变更/临时 IO 错/用户装完客户端）直到重启才能恢复
  p.then((v) => {
    if (!v) signerCache.delete(product);
  }).catch(() => {
    signerCache.delete(product);
  });
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

/**
 * 取证：对某产品的 obf 做**纯结构探测**，返回可直接回传的诊断摘要（issue #119 用）。
 * 只读客户端文件——不加载 wasm、不写缓存、不联网，可在任何机器上安全跑。
 *
 * 输出里最能定方向的三项：
 *   · entryMark.hit    入口标记是否还在 → 在的话走截断路径，通用路径根本没被用到
 *   · inlineWasm.hit   内嵌 wasm 是否还在 → 不在说明客户端把 wasm 拆成外链了，要新增读取路径
 *   · missing          通用提取缺哪几个特征 → 决定是放宽正则还是改结构
 */
function probe(product) {
  const loc = locate(product);
  if (!loc) {
    return {
      product,
      installed: false,
      message:
        "客户端未安装，或 resources 目录未定位到（可用 AGENTHUB_QODER_RESOURCES / AGENTHUB_QODER_INTL_RESOURCES 直接指定 resources 目录）",
    };
  }
  const st = fs.statSync(loc.obf);
  const text = fs.readFileSync(loc.obf, "utf8");
  const entryAt = text.indexOf(ENTRY_MARK);
  const wasmAt = text.indexOf(WASM_MAGIC);
  const features = pickByStructure(text);
  const missing = REQUIRED_FEATURES.filter((k) => !features[k]);
  return {
    product,
    installed: true,
    version: loc.version,
    sdk: loc.sdk,
    obf: loc.obf,
    obfSize: st.size,
    obfMtime: new Date(Math.floor(st.mtimeMs)).toISOString(),
    entryMark: { mark: ENTRY_MARK, hit: entryAt >= 0, offset: entryAt },
    inlineWasm: { magic: WASM_MAGIC, hit: wasmAt >= 0, offset: wasmAt },
    features,
    missing,
    path: entryAt >= 0 ? "截断路径（入口标记命中）" : missing.length ? "两条路径均失败" : "通用路径（结构提取成功）",
    snippets: probeSnippets(text, entryAt),
  };
}

/** 取特征附近的短片段（客户端混淆代码，不含任何用户数据），供适配时比对结构 */
function probeSnippets(text, entryAt) {
  const near = (re) => {
    const m = text.match(re);
    return m ? text.slice(Math.max(0, m.index - 80), m.index + 220) : "";
  };
  return {
    wasmDecl: near(/([A-Za-z_$][\w$]*)="AGFzbQEAAAA/),
    wasmLoader: near(/,\s*([A-Za-z_$][\w$]*)=b\(\(\)=>\{[A-Za-z_$][\w$]*="AGFzbQEAAAA/),
    erCall: near(/er\(([A-Za-z_$][\w$]*),\s*\{[^{}]{0,800}?QoderContext:\(\)=>/),
    profileEnc: near(/ProfileEncryptor:\(\)=>([A-Za-z_$][\w$]*)/),
    entryMark: entryAt < 0 ? "" : text.slice(Math.max(0, entryAt - 160), entryAt + 160),
  };
}

module.exports = { locate, available, createSession, describe, probe, installResources, buildPatchedModule, patchText, pickByStructure };

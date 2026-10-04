// 反代网关 · Qoder 渠道自测（Electron ELECTRON_RUN_AS_NODE 模式跑，拿 Node 22 + node:sqlite）
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-qoder-selftest.cjs [临时数据目录]
//
// 覆盖（不需要网络，纯本机能力验证）：
//   1) 凭据层：双渠道目录探测 + auth.v1.dat 解密（DPAPI + AES-256-GCM）字段完整性
//   2) v10 信封往返：加密 → 解密 → 内容一致（写回链路的地基）
//   3) 签名器：定位 obf（默认路径 / launcher 版本目录）→ 提取补丁（0.4.x 截断 / 通用惰性导出）
//      → 缓存 → 动态 import → 胶水导出表
//   4) 签名会话：generate_runtime_auth_fields 派生 + prepareInferRequest 产出 20 头 + Encode=1 体
//   5) 目录解密：catalog-v6 → JSON（14 模型，含 price_factor）
//   6) 缓存复用：二次构建命中同一模块文件（不重复写 33MB）
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-test-"));
process.env.APPDATA = process.env.APPDATA || tmp; // 仅在缺省时隔离；本机自测需读真实 APPDATA 下的凭据

const assert = (cond, msg) => {
  if (!cond) throw new Error("断言失败: " + msg);
  console.log("  ✓ " + msg);
};

async function main() {
  const auth = require("../electron/backend/proxy/qoderAuth.cjs");
  const signer = require("../electron/backend/proxy/qoderSigner.cjs");

  // ===== 1. 凭据层 =====
  console.log("\n[1] 凭据层");
  const detect = auth.detectAll();
  console.log("  客户端探测:", JSON.stringify(detect));
  const products = Object.keys(auth.PRODUCTS).filter((p) => detect[p]);
  if (!products.length) {
    console.log("  ! 本机未检测到已登录的 Qoder 客户端，跳过凭据/签名实测（仅验证模块可加载）");
    console.log("\n[done] 模块加载正常（无凭据可用）");
    return;
  }
  let cred = null;
  let credProduct = null;
  for (const p of products) {
    try {
      const c = auth.readCredentials(p);
      if (c.token && c.refreshToken && c.user && c.user.id) {
        cred = c;
        credProduct = p;
        break;
      }
    } catch (e) {
      console.log(`  · ${p} 读取失败：${String((e && e.message) || e).slice(0, 100)}`);
    }
  }
  assert(!!cred, "至少一个渠道的凭据可解密");
  console.log(`  渠道=${credProduct} uid=${cred.user.id.slice(0, 8)}*** token=${cred.token.slice(0, 6)}***(${cred.token.length}) refresh=${cred.refreshToken.slice(0, 6)}***(${cred.refreshToken.length})`);
  assert(cred.token.startsWith("dt-"), "token 为 dt- 设备令牌");
  assert(cred.refreshToken.startsWith("drt-"), "refreshToken 为 drt- 形态");
  assert(cred.expiresAt > Date.now(), "token 未过期（expiresAt 可解析）");
  assert(!!cred.machineId, "machine_id 已读取");

  // ===== 2. v10 信封往返 =====
  console.log("\n[2] v10 信封往返");
  const key = auth.dpapiUnprotectKey(JSON.parse(fs.readFileSync(auth.pathsOf(credProduct).localState, "utf8")).os_crypt.encrypted_key);
  assert(key.length === 32, "DPAPI 解出 32 字节 AES key");
  const probe = Buffer.from(JSON.stringify({ hello: "世界", n: 42 }), "utf8");
  const round = auth.decryptV10(auth.encryptV10(probe, key), key);
  assert(round.equals(probe), "加密→解密内容一致（含中文）");

  // ===== 3. 签名器加载 =====
  // 重要区分：凭据在 APPDATA（可解密导入）≠ 客户端已安装（可签名）。
  // 签名器需要本机安装目录下的 worker obf + 内嵌 wasm；客户端卸载后凭据仍可读，但无法签名。
  console.log("\n[3] 签名器加载");
  const REQUIRED_API = [
    "QoderContext", "RequestResult", "ProfileEncryptor",
    "generate_runtime_auth_fields", "decrypt_server_response",
    "model_cache_decrypt", "model_cache_encrypt",
    "credential_storage_decrypt", "credential_storage_encrypt",
    "profile_encrypt", "get_httpdns_config",
  ];
  const installed = [];
  const credOnly = [];
  for (const p of Object.keys(auth.PRODUCTS)) {
    const d = await signer.describe(p);
    const hasCred = products.includes(p);
    console.log(`  ${p}: 客户端=${d.installed ? "已装 " + d.version : "未装"} 凭据=${hasCred ? "有" : "无"} glue=${d.glueLoaded ?? "-"} exports=${d.exports ?? "-"}${d.glueError ? " err=" + d.glueError : ""}`);
    if (d.installed) {
      installed.push(p);
      assert(d.glueLoaded, `${p} 胶水加载成功（截断+追加导出 + wasm 实例化）`);
      assert(d.exports === 17, `${p} 胶水导出 17 个公开 API`);
    } else if (hasCred) {
      credOnly.push(p); // 凭据可导入、但该渠道当前不可调用——如实记录，不算失败
    }
  }
  assert(installed.length > 0, "至少一个渠道客户端已安装且签名器可用");
  if (credOnly.length) {
    console.log(`  ! 以下渠道凭据可用但客户端未安装，暂不可调用（导入后需装回客户端才能签名）：${credOnly.join(", ")}`);
  }

  // 签名实测对象：必须「已安装客户端 + 有可解密凭据」——
  // 凭据存在 ≠ 客户端已安装（客户端卸载后凭据仍在 APPDATA），只看凭据会在这种机器上直接失败
  let signedProduct = installed.find((p) => {
    try {
      const c = auth.readCredentials(p);
      return !!(c.token && c.user && c.user.id);
    } catch {
      return false;
    }
  });
  let signedCred = null;
  if (signedProduct) {
    signedCred = auth.readCredentials(signedProduct);
  } else {
    // 客户端已装但无凭据：用 stub token 走通签名链（签名材料由 token 派生，凭据合法性由上游判定）
    signedProduct = installed[0];
    signedCred = { token: "dt-stub", user: { id: "uid-stub" }, machineId: cred.machineId };
    console.log(`  ! ${signedProduct} 客户端已装但无可用凭据，签名链用 stub 凭据验证`);
  }

  const desc = await signer.describe(signedProduct);
  const loc0 = signer.locate(signedProduct);
  const mod0 = await import(require("node:url").pathToFileURL(signer.buildPatchedModule(signedProduct, loc0)).href);
  await mod0.initGlue();
  const api = mod0.glue();
  for (const k of REQUIRED_API) assert(k in api, `公开 API 存在：${k}`);

  // ===== 4. 签名会话 =====
  console.log("\n[4] 签名会话");
  const session = await signer.createSession({ product: signedProduct, token: signedCred.token, uid: signedCred.user.id, machineId: signedCred.machineId });
  assert(!!session.version, `客户端版本 ${session.version}`);
  const body = JSON.stringify({
    session_id: "11111111-1111-1111-1111-111111111111",
    source_session_id: "",
    request_id: "22222222-2222-2222-2222-222222222222",
    request_set_id: "22222222-2222-2222-2222-222222222222",
    model_config: { key: "dfmodel", display_name: "DeepSeek-Flash", model: "", format: "openai", is_vl: true, is_reasoning: false, api_key: "", url: "", source: "system", max_input_tokens: 180000 },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    business: {},
  });
  const signed = session.prepareInferRequest(auth.PRODUCTS[signedProduct].gateway, body, "dfmodel", "system");
  const hk = Object.keys(signed.headers);
  console.log("  url:", signed.url.slice(0, 96) + "…");
  console.log("  头数:", hk.length, "| 体长:", signed.body.length);
  assert(signed.url.includes("agent_chat_generation"), "URL 指向推理端点");
  assert(signed.url.includes("Encode=1"), "URL 带 Encode=1");
  assert(hk.length === 20, "签名头 20 个");
  for (const need of ["Authorization", "Cosy-MachineId", "Cosy-Key", "Cosy-Date", "X-Model-Key"]) {
    assert(hk.includes(need), `含签名头 ${need}`);
  }
  // ⚠ Authorization 不是原始 dt- token：wasm 用 dt- + 账号材料封装出
  //   "COSY.<base64(payload)>.<32B 签名>" 的**每请求现签密文信封**（payload 含 requestId/info）。
  //   适配器必须直接透传该头，绝不能自作主张拼 `Bearer dt-…`。
  const az = String(signed.headers.Authorization || "");
  const bare = az.replace(/^Bearer\s+/i, "");
  const azParts = bare.split(".");
  assert(/^Bearer\s/i.test(az), "Authorization 带 Bearer 前缀");
  assert(bare.startsWith("COSY."), "Authorization 为 COSY 复合令牌（非裸 dt- token）");
  assert(azParts.length === 3, "COSY 令牌三段式（COSY / payload / 签名）");
  assert(bare !== signedCred.token, "COSY 令牌 ≠ 原始 dt- token（确认 wasm 做了封装）");
  let cosyPayload = null;
  try { cosyPayload = JSON.parse(Buffer.from(azParts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch { /* 容忍 */ }
  assert(!!cosyPayload && cosyPayload.version, `COSY payload 可解（version=${cosyPayload && cosyPayload.version}）`);
  assert(!!cosyPayload.requestId, "COSY payload 含 requestId（每请求独立）");
  console.log(`  Authorization: COSY.…（payload version=${cosyPayload.version}, requestId=${String(cosyPayload.requestId).slice(0, 8)}…, 总长 ${az.length}）`);
  assert(signed.body.length > 100, "请求体为 Encode=1 编码产物");
  // 签名头绑定请求体：改一个字节，签名应变化（防「签名与体脱钩」）
  const signed2 = session.prepareInferRequest(auth.PRODUCTS[signedProduct].gateway, body + " ", "dfmodel", "system");
  assert(signed2.headers.Authorization !== signed.headers.Authorization, "签名随请求体变化（体已绑定）");
  // 同一会话内两次签名不同（COSY 含 requestId，非静态缓存）
  const signed3 = session.prepareInferRequest(auth.PRODUCTS[signedProduct].gateway, body, "dfmodel", "system");
  assert(signed3.headers.Authorization !== signed.headers.Authorization, "同会话重复签名不相等（每请求现签）");

  // ===== 5. 目录解密 =====
  console.log("\n[5] 模型目录解密");
  const blob = auth.readCatalogBlob(signedProduct, signedCred.user.id);
  if (blob) {
    const json = JSON.parse(session.modelCacheDecrypt(blob, cred.user.id));
    const scenes = Object.keys(json);
    let total = 0;
    for (const k of scenes) if (Array.isArray(json[k])) total += json[k].length;
    console.log(`  场景: ${scenes.join("/")} | 模型条目总数 ${total}`);
    assert(scenes.length > 0, "目录含场景分组");
    const chat = json.chat || json.assistant || [];
    const withRate = chat.filter((m) => m && m.price_factor != null);
    assert(withRate.length > 0, "模型含 price_factor 计价字段");
    console.log("  chat 场景样本:", chat.slice(0, 3).map((m) => `${m.key}(${m.display_name},×${m.price_factor})`).join(" "));
  } else {
    console.log("  ! 无本地目录缓存（未使用过该客户端），跳过");
  }

  // ===== 6. 缓存复用 =====
  console.log("\n[6] 缓存复用");
  const loc = signer.locate(signedProduct);
  const a = signer.buildPatchedModule(signedProduct, loc);
  const b = signer.buildPatchedModule(signedProduct, loc);
  assert(a === b, "二次构建命中同一缓存模块（不重复落盘）");
  assert(fs.existsSync(a), "缓存模块存在");
  console.log(`  缓存: ${path.basename(a)} (${(fs.statSync(a).size / 1048576).toFixed(1)} MB)`);

  console.log("\n[done] Qoder 自测全部通过");
}

main()
  .then(() => process.exit(0)) // fetch keep-alive 句柄会让事件循环保持存活，测完显式退出（对齐 proxy-smoke 约定）
  .catch((e) => {
    console.error("\n[FAIL] " + ((e && e.stack) || e));
    process.exit(1);
  });

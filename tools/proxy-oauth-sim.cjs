// Trae OAuth 回调行为模拟测试（ELECTRON_RUN_AS_NODE 运行）
// 不依赖真实浏览器登录：起本地回环会话，直接向回调端口打请求验证
// ① 空参探测 → 200 挂起页且会话存活  ② error 参数 → 400 结束会话
// ③ 空探测后带凭据回调 → 换令牌链路照常执行  ④ hash 形态粘贴解析  ⑤ authCodeInfo 解析
"use strict";
const discovery = require("../electron/backend/proxy/discovery.cjs");
const rules = require("../electron/backend/proxy/rules.cjs");

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? require("node:https") : require("node:http");
    lib.get(url, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

async function begin() {
  const p = new Promise((resolve) => {
    discovery.beginOAuth("trae", resolve).then((r) => {
      resolve.__r = r;
      resolve(r);
    });
  });
  const r = await discovery.beginOAuth("trae", (res) => {});
  return r;
}

(async () => {
  rules.init();

  // ===== 会话 1：空探测 → 挂起页 → error 参数结束会话 =====
  let done1 = null;
  const r1 = await new Promise((resolve) => {
    discovery.beginOAuth("trae", (res) => { done1 = res; }).then(resolve);
  });
  log(`会话1: ok=${r1.ok} port=${r1.port}`);
  const probe1 = await httpGet(`http://127.0.0.1:${r1.port}/authorize`);
  log(`  空参探测: HTTP ${probe1.status} 挂起页=${probe1.body.includes("正在等待授权结果")}`);
  const err1 = await httpGet(`http://127.0.0.1:${r1.port}/authorize?error=access_denied&error_description=test`);
  await sleep(300);
  log(`  error 参数: HTTP ${err1.status} onDone=${JSON.stringify(done1)}`);
  log(`  断言1: 空探测后会话仍存活(error 参数能被处理)=${done1 !== null && done1.ok === false}`);

  // ===== 会话 2：空探测 → 挂起页 → 带凭据回调（坏 refreshToken → 走换令牌失败路径，证明链路没被探测杀） =====
  let done2 = null;
  const r2 = await new Promise((resolve) => {
    discovery.beginOAuth("trae", (res) => { done2 = res; }).then(resolve);
  });
  log(`\n会话2: port=${r2.port}`);
  const probe2 = await httpGet(`http://127.0.0.1:${r2.port}/authorize`);
  log(`  空参探测: HTTP ${probe2.status} 挂起页=${probe2.body.includes("正在等待授权结果")}`);
  await httpGet(`http://127.0.0.1:${r2.port}/authorize?refreshToken=bad-token&userInfo=${encodeURIComponent(JSON.stringify({ UserID: "123", ScreenName: "测试" }))}`);
  await sleep(2500);
  log(`  凭据回调后 onDone: ${JSON.stringify(done2)}`);
  log(`  断言2: 空探测后带凭据回调照常进入换令牌流程=${done2 !== null}`);

  // ===== 会话 3：粘贴解析——hash 形态 / 无凭据形态 =====
  const r3 = await new Promise((resolve) => {
    discovery.beginOAuth("trae", () => {}).then(resolve);
  });
  log(`\n会话3: port=${r3.port}`);
  const noCred = await discovery.submitCallbackUrl("http://127.0.0.1:1/authorize", "trae");
  log(`  粘贴无凭据URL: ${JSON.stringify(noCred)} 断言3a=${noCred.ok === false && /解析|凭据/.test(noCred.message)}`);
  const hashForm = await discovery.submitCallbackUrl("http://127.0.0.1:1/authorize#refreshToken=hash-bad-token", "trae");
  log(`  粘贴hash形态URL: ${JSON.stringify(hashForm)} 断言3b(hash被解析并进入换令牌)=${hashForm.ok === true}`);

  // ===== 会话 4：authCodeInfo 形态粘贴（独立会话，避免上一会话已因坏凭据结束） =====
  let done4 = null;
  await new Promise((resolve) => {
    discovery.beginOAuth("trae", (res) => { done4 = res; }).then(resolve);
  });
  const authCodeInfoForm = await discovery.submitCallbackUrl(
    `http://127.0.0.1:1/authorize?authCodeInfo=${encodeURIComponent(JSON.stringify({ AuthCode: "some-code" }))}`,
    "trae"
  );
  await sleep(2500);
  log(`  粘贴authCodeInfo形态: ${JSON.stringify(authCodeInfoForm)} onDone=${JSON.stringify(done4)}`);
  log(`  断言3c(authCodeInfo被解析并进入授权码换令牌流程)=${authCodeInfoForm.ok === true && done4 !== null && /HTTP|授权码|令牌/i.test(done4.message || "")}`);
  await discovery.cancelOAuth();

  // ===== 解析单元：挂起页含 hash→query 回捞脚本 =====
  log(`\n断言4: 挂起页含hash回捞脚本=${probe1.body.includes("location.hash") && probe1.body.includes("location.replace")}`);

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

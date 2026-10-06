// ModelScope Cookie 可用性验证（full Electron，可解密 DPAPI）
//
// 为什么需要单独的探针：自测用 ELECTRON_RUN_AS_NODE 跑，safeStorage(DPAPI) 不可用
// → decryptSecret 对 enc:v1: 返回 ""，自测只能断言「meta.msCookie 已写入」，
// 无法验证解密后 Cookie 真的能调 /api/v1 族。本探针补上这一段。
//
// ⚠ 只读：不做点赞（写动作会被他人看见）。点赞的端到端结果由交易记录核对。
// 用法：electron tools/probe-modelscope-cookie-check.cjs
"use strict";
const path = require("node:path");
const { app } = require("electron");
app.setName("AgentHub");
app.setPath("userData", path.join(process.env.APPDATA || "", "agenthub"));

app.whenReady().then(async () => {
  const store = require(path.join(__dirname, "..", "electron", "backend", "proxy", "store.cjs"));
  const rules = require(path.join(__dirname, "..", "electron", "backend", "proxy", "rules.cjs"));
  const ad = require(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs")).get("modelscope");
  rules.init(); store.open();
  const c = rules.get("headers.json").modelscope;
  const base = String(c.apiBase).replace(/\/+$/, "");
  const accs = store.listAccounts("modelscope");
  if (!accs.length) { console.log("号池内无 modelscope 账号"); app.exit(1); return; }

  let allOk = true;
  for (const a of accs) {
    const s = store.accountSecrets(store.getAccount(a.id));
    const ck = ad.cookieHeaderOf(s);
    console.log("════ " + a.name + " ════");
    console.log("  Cookie: " + (ck ? ck.length + " 字符 / " + ck.split("; ").length + " 项" : "❌ 无（DPAPI 解不开或未采集）"));
    if (!ck) { allOk = false; continue; }
    console.log("  登录态关键项: " + ck.split("; ").map((x) => x.split("=")[0]).filter((n) => /m_session_id|csrf|_tb_token_|cookie2|^t$/i.test(n)).join(", "));
    console.log("  hasStarCredential: " + ad.hasStarCredential(s));

    const hdrs = { cookie: ck, accept: "application/json", "user-agent": c.userAgent, origin: base, referer: base + "/my/overview" };
    // ① login/info（日活触发端点；OAuth/ms- 令牌都不能替代）
    const li = await require(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs")).httpJson(base + "/api/v1/users/login/info", { method: "GET", headers: hdrs }).catch(() => ({ ok: false, status: 0, data: null }));
    const u = li.data && li.data.Data && (li.data.Data.UserName || li.data.Data.NickName);
    console.log("  /api/v1/users/login/info → HTTP " + li.status + "  用户=" + (u || "?") + (li.status === 200 && !li.data?.Message?.includes?.("登录") ? " ✅" : ""));
    if (li.status !== 200) allOk = false;

    // ② 列点赞目标（走 Cookie 的星标族；只读）
    const tg = await ad.fetchLikeTargets(s, 3).catch(() => []);
    console.log("  列点赞目标 → " + tg.length + " 个" + (tg.length ? " ✅（Cookie 可调星标族）" : " ⚠️ 空"));

    // ③ webTouch（日活触碰，只读）
    const wt = await ad.webTouch(s).catch((e) => ({ ok: false, touched: 0, message: String(e.message || e) }));
    console.log("  webTouch → ok=" + wt.ok + " touched=" + wt.touched + " dead=" + wt.dead + (wt.ok ? " ✅" : ""));
    if (!wt.ok) allOk = false;
    console.log("");
  }
  console.log(allOk ? "结论：Cookie 通道完全可用（A1 目标达成）✅" : "结论：存在问题，见上 ⚠️");
  app.exit(allOk ? 0 : 1);
}).catch((e) => { console.error("失败: " + (e && e.message)); try { app.exit(1); } catch { process.exit(1); } });

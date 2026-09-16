// 回归探针：新实现实测（余额求和 / 1001 unavailable / 签到状态 / 渠道过滤导出）
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const store = require("../electron/backend/proxy/store.cjs");
const rules = require("../electron/backend/proxy/rules.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const discovery = require("../electron/backend/proxy/discovery.cjs");

const log = (...a) => console.log(...a);

function readWbCurrent(channel) {
  const authDir = path.join(process.env.LOCALAPPDATA || "", "CodeBuddyExtension", "Data", "Public", "auth");
  const f = channel === "workbuddy_ai" ? "workbuddy-desktop-ai.info" : "workbuddy-desktop.info";
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(authDir, f), "utf8"));
    return {
      token: (parsed.auth && (parsed.auth.accessToken || parsed.auth.access_token)) || "",
      refresh: (parsed.auth && (parsed.auth.refreshToken || parsed.auth.refresh_token)) || "",
      uid: (parsed.account && (parsed.account.uid || parsed.account.userId)) || "",
      domain: (parsed.auth && parsed.auth.domain) || "",
      enterpriseId: (parsed.auth && (parsed.auth.enterpriseId || parsed.auth.enterprise_id)) || "",
    };
  } catch {
    return null;
  }
}

(async () => {
  rules.init();
  store.open();

  // 1) WB 余额：新 queryCredits 应对 CN 返回 981、AI 返回 588（全包求和）
  for (const ch of ["workbuddy", "workbuddy_ai"]) {
    const lt = readWbCurrent(ch);
    if (!lt) { log(`[${ch}] 本机无登录文件`); continue; }
    const acc = { uid: lt.uid, enterpriseId: lt.enterpriseId, domain: lt.domain, id: "probe" };
    try {
      const r = await adapters.get(ch).queryCredits(acc, { token: lt.token, refreshToken: lt.refresh });
      log(`[${ch}] queryCredits(新): ${JSON.stringify(r)}`);
    } catch (e) {
      log(`[${ch}] queryCredits 失败: ${e.message}`);
    }
    const st = await adapters.get(ch).checkinStatus(acc, { token: lt.token, refreshToken: lt.refresh });
    log(`[${ch}] checkinStatus(新): ${JSON.stringify(st).slice(0, 220)}`);
  }

  // 2) Trae：queryCredits 应返回 unavailable（不 authError、不打 relogin）；checkinStatus 同样
  const cand = discovery.scanTrae().find((c) => c.token);
  if (cand) {
    log(`\n[trae] scan: uid=${cand.uid} expiresAt=${cand.expiresAt}(${new Date(cand.expiresAt).toISOString()}) tokenLen=${cand.token.length}`);
    const acc = { uid: cand.uid, enterpriseId: "", domain: "", id: "probe" };
    const r = await adapters.get("trae").queryCredits(acc, { token: cand.token, refreshToken: cand.refreshToken }).catch((e) => ({ error: e.message }));
    log(`[trae] queryCredits(新): ${JSON.stringify(r)}`);
    const st = await adapters.get("trae").checkinStatus(acc, { token: cand.token, refreshToken: cand.refreshToken });
    log(`[trae] checkinStatus(新): ${JSON.stringify(st).slice(0, 220)}`);
  }

  // 3) poolsync 渠道过滤：导出/合并函数是模块内部实现，这里只核对本机号池渠道分布，
  //    过滤行为由 poolsync.run({channel}) 的 exportPool/mergeSnapshot 代码路径保证
  const all = store.listAccounts();
  const byCh = {};
  for (const view of all) byCh[view.channel] = (byCh[view.channel] || 0) + 1;
  log(`\n[poolsync] 本机号池 ${all.length} 个账号: ${JSON.stringify(byCh)}`);

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

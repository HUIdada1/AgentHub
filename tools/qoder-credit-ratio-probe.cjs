// 真实调用 Qoder CN 上游，量 credits 与 token 的换算比例（会消耗少量 credits）
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-ratio-"));
process.env.AGENTHUB_DATA_DIR = dataDir;

async function main() {
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const discovery = require("../electron/backend/proxy/discovery.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");

  store.open();
  rules.init();
  const cands = discovery.scanAll();
  console.log("登录态候选:", cands.map((c) => `${c.channel}:${c.encrypted ? "enc" : "plain"}`).join(", ") || "(无)");
  const cand = cands.find((c) => c.channel === "qoder" && !c.encrypted);
  if (!cand) {
    console.log("本机无 Qoder CN 明文登录态，跳过真实调用");
    return;
  }
  const r = discovery.importCandidate(cand);
  const acc = store.listAccounts("qoder").find((a) => a.id === r.id);
  const sec = store.accountSecrets(store.getAccount(r.id));
  const ad = adapters.get("qoder");

  const unit = "Qoder 计费换算探针：这段文字用于构造固定前缀，测试 credits 与 token 的比例关系。";
  const mkPrefix = (chars) => unit.repeat(Math.ceil(chars / unit.length));
  const cases = [
    { name: "短输入+短输出", prefix: mkPrefix(1800), max: 160, user: "只回复 OK，不要解释。" },
    { name: "长输入+短输出", prefix: mkPrefix(14000), max: 8, user: "只回复 OK。" },
  ];
  for (const c of cases) {
    const events = [];
    const body = {
      messages: [
        { role: "system", content: c.prefix },
        { role: "user", content: `${c.user}（${Date.now()}）` },
      ],
      max_tokens: c.max,
    };
    const t0 = Date.now();
    let res = null;
    try {
      res = await ad.chat({ account: acc, secrets: sec, model: "dfmodel", body, emit: (e) => events.push(e), meta: {} });
    } catch (e) {
      console.log(`${c.name} 失败:`, String((e && e.message) || e));
      continue;
    }
    const usageEv = events.find((e) => e.type === "usage");
    const usage = (usageEv && usageEv.usage) || (res && res.usage) || {};
    console.log(`\n${c.name}  ${Date.now() - t0}ms  usage=${JSON.stringify(usage)}`);
    const p = Number(usage.prompt_tokens) || 0;
    const out = Number(usage.completion_tokens) || 0;
    const cr = Number(usage.credits) || 0;
    const cached = (usage.prompt_tokens_details && Number(usage.prompt_tokens_details.cached_tokens)) || 0;
    if (cr > 0) {
      console.log(`  input=${p} output=${out} cached=${cached} credits=${cr}  →  全量 token/credit = ${(((p + out) / cr)).toFixed(1)}  input token/credit = ${(p / cr).toFixed(1)}`);
    } else {
      console.log("  usage 里没有 credits 字段");
    }
    if (c === cases[0]) await new Promise((r2) => setTimeout(r2, 1200));
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[FAIL] " + ((e && e.stack) || e));
    process.exit(1);
  });

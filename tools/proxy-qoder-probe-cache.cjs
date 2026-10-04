// 反代网关 · Qoder 探针：大前缀缓存命中（P2-3）+ 限流语义校验（P1-4 平台侧）
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-qoder-probe-cache.cjs [--tokens 64000]
//
// 为什么需要：P2-3 先前只测到小上下文（<200 token），cached_tokens 恒为 0，
// 无法判断前缀缓存是否真的生效。本脚本构造一段足够长的固定前缀，连续发两轮：
//   第 1 轮：冷前缀 → 期望 cached_tokens=0（或很小）
//   第 2 轮：同一前缀 → 期望 cached_tokens 显著 > 0（命中）
// 这会真实消耗 credits（仅 2 次调用，前缀越长 input 越贵）。
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-cache-"));
process.env.AGENTHUB_DATA_DIR = dataDir;

function argNum(name, def) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]) || def;
  return def;
}
const TARGET_TOKENS = argNum("--tokens", 64000);

async function main() {
  const auth = require("../electron/backend/proxy/qoderAuth.cjs");
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const discovery = require("../electron/backend/proxy/discovery.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");

  store.open();
  rules.init();
  console.log(`数据目录（隔离）: ${dataDir}`);

  const cand = discovery.scanAll().find((c) => c.channel === "qoder" && !c.encrypted);
  if (!cand) {
    console.log("  · 本机无 Qoder CN 登录态，跳过（credential-only 环境）");
    return;
  }
  const r = discovery.importCandidate(cand);
  const acc = store.listAccounts("qoder").find((a) => a.id === r.id);
  const sec = store.accountSecrets(store.getAccount(r.id));
  const ad = adapters.get("qoder");

  // 构造固定前缀：用可重复的中文段落，约 1 token ≈ 1.6 字符（中文）
  // 取保守估计 1 token ≈ 2 字符，避免前缀过短导致探针无效
  const unit = "Qoder 前缀缓存探针：这段文字在两次请求中完全一致，用于触发服务端前缀缓存。";
  const repeats = Math.ceil((TARGET_TOKENS * 2) / unit.length);
  const prefix = unit.repeat(repeats);
  console.log(`  构造前缀长度：${prefix.length} 字符（目标约 ${TARGET_TOKENS} token）`);

  const results = [];
  for (let round = 1; round <= 2; round++) {
    const events = [];
    const body = {
      messages: [
        { role: "system", content: prefix },
        { role: "user", content: `第 ${round} 轮：只回复"OK"，不要解释。` },
      ],
      max_tokens: 8,
    };
    let res = null;
    try {
      res = await ad.chat({
        account: acc,
        secrets: sec,
        model: "dfmodel", // DeepSeek-Flash，rate 0.1，成本最低
        body,
        emit: (e) => events.push(e),
        meta: {},
      });
    } catch (e) {
      console.log(`  第 ${round} 轮失败：${String((e && e.message) || e)}`);
      break;
    }
    const usageEv = events.find((e) => e.type === "usage");
    const usage = (usageEv && usageEv.usage) || (res && res.usage) || {};
    results.push(usage);
    console.log(`  第 ${round} 轮 status=${res && res.status} 事件=${events.length} usage=${JSON.stringify(usage)}`);
    if (round === 1) await new Promise((r2) => setTimeout(r2, 1500)); // 给服务端落缓存留时间
  }

  const u1 = results[0] || {};
  const u2 = results[1] || {};
  const c1 = (u1.prompt_tokens_details && u1.prompt_tokens_details.cached_tokens) || 0;
  const c2 = (u2.prompt_tokens_details && u2.prompt_tokens_details.cached_tokens) || 0;
  console.log("\n[结论]");
  console.log(`  第 1 轮 prompt_tokens=${u1.prompt_tokens ?? "?"} cached_tokens=${c1}`);
  console.log(`  第 2 轮 prompt_tokens=${u2.prompt_tokens ?? "?"} cached_tokens=${c2}`);
  if (c1 === 0 && c2 === 0) {
    console.log("  → 前缀缓存未命中（或该模型/账号不启用缓存）。小上下文结论一致。");
  } else if (c2 > c1) {
    console.log(`  → 前缀缓存命中：cached_tokens ${c1} → ${c2}（命中率约 ${((c2 / (u2.prompt_tokens || 1)) * 100).toFixed(1)}%）`);
  } else {
    console.log("  → 结果不符合预期，需人工判读");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n[FAIL] " + ((e && e.stack) || e));
    process.exit(1);
  });

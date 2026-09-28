/**
 * 记忆中枢 · 配置三档分层与推荐值合规性校验
 * 纯 Node.js，零 GUI
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");

function runCheck(isAssert = false) {
  console.log("=== [m-cfg-tiers] 配置三档分层与默认推荐值校验 ===");
  let pass = 0;
  let fail = 0;

  function assertCheck(name, cond, details) {
    if (cond) {
      pass++;
      console.log(`  ✓ ${name}`);
      return true;
    }
    fail++;
    console.log(`  ✗ ${name} ${details ? " -> " + details : ""}`);
    return false;
  }

  const { SCHEMA } = require("../../electron/backend/memory/config-schema.cjs");
  const keys = Object.keys(SCHEMA);
  const totalKeys = keys.length;

  console.log(`  统计: 总配置项数 = ${totalKeys}`);

  // 1. 每项必须有 tier 属性 (basic | advanced | internal)
  const allowedTiers = new Set(["basic", "advanced", "internal"]);
  const missingTier = keys.filter((k) => !SCHEMA[k].tier || !allowedTiers.has(SCHEMA[k].tier));
  assertCheck(
    "所有配置项均已标注 tier (basic | advanced | internal)",
    missingTier.length === 0,
    `缺失或非法 tier 的项 (${missingTier.length}): [${missingTier.slice(0, 10).join(", ")}${missingTier.length > 10 ? "..." : ""}]`
  );

  const basicKeys = keys.filter((k) => SCHEMA[k].tier === "basic");
  const advKeys = keys.filter((k) => SCHEMA[k].tier === "advanced");
  const intKeys = keys.filter((k) => SCHEMA[k].tier === "internal");
  console.log(`  分层统计: basic(${basicKeys.length}), advanced(${advKeys.length}), internal(${intKeys.length})`);

  // 2. basic 档项数控制在合理范围 (<= 20)
  assertCheck(
    "核心常用 basic 档项数不超过 20 项 (极简体验)",
    basicKeys.length <= 20,
    `当前 basic 项数: ${basicKeys.length}`
  );

  // 3. ConfigMemorySection.vue 中废除硬编码的 ADVANCED_KEYS Set
  const configVuePath = path.join(ROOT, "src/components/config/ConfigMemorySection.vue");
  if (fs.existsSync(configVuePath)) {
    const vueContent = fs.readFileSync(configVuePath, "utf8");
    const hasHardcodedSet = /const\s+ADVANCED_KEYS\s*=\s*new\s+Set/.test(vueContent);
    assertCheck(
      "ConfigMemorySection.vue 废除硬编码 ADVANCED_KEYS，完全由 Schema 驱动",
      !hasHardcodedSet,
      "仍检测到硬编码 ADVANCED_KEYS Set"
    );
  }

  // 4. 关键推荐默认值检查（保护用户成本与开箱体验）
  if (SCHEMA["dedup.l4.enabled"]) {
    // 语义去重耗费模型 token，开箱最推荐默认设为 false
    assertCheck(
      "dedup.l4.enabled (语义模型去重) 默认关闭以避免隐性消耗",
      SCHEMA["dedup.l4.enabled"].def === false,
      `当前默认值: ${SCHEMA["dedup.l4.enabled"].def}`
    );
  }

  if (SCHEMA["classify.autoCreateProject"]) {
    assertCheck(
      "classify.autoCreateProject 默认关闭以避免项目列表爆炸",
      SCHEMA["classify.autoCreateProject"].def === false,
      `当前默认值: ${SCHEMA["classify.autoCreateProject"].def}`
    );
  }

  if (isAssert && fail > 0) {
    process.exit(1);
  }
  return { pass, fail };
}

if (require.main === module) {
  const isAssert = process.argv.includes("--assert");
  runCheck(isAssert);
}

module.exports = { runCheck };

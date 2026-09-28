/**
 * 记忆中枢 · 纯代码自动化验证总运行器
 * 纯 Node.js，零 GUI
 * 用法:
 *   node tools/verify/m-run-all.cjs           (报告模式)
 *   node tools/verify/m-run-all.cjs --assert  (断言模式，有错则退出码 1)
 */
"use strict";

const plumbing = require("./m-plumbing.cjs");
const cfgTiers = require("./m-cfg-tiers.cjs");
const terminology = require("./m-terminology.cjs");
const nav = require("./m-nav.cjs");
const structure = require("./m-structure.cjs");

function main() {
  const isAssert = process.argv.includes("--assert");
  console.log("=================================================");
  console.log(` 记忆中枢纯代码自动化验证 (${isAssert ? "严格断言模式" : "综合报告模式"})`);
  console.log("=================================================\n");

  const results = [
    plumbing.runCheck(false),
    cfgTiers.runCheck(false),
    terminology.runCheck(false),
    nav.runCheck(false),
    structure.runCheck(false),
  ];

  let totalPass = 0;
  let totalFail = 0;
  for (const r of results) {
    totalPass += r.pass;
    totalFail += r.fail;
  }

  console.log("\n=================================================");
  console.log(` 验证汇总: 通过 ${totalPass} 项, 失败/待落实 ${totalFail} 项`);
  console.log("=================================================");

  if (isAssert && totalFail > 0) {
    console.error(`\n[FATAL] 断言失败，共有 ${totalFail} 项检查未通过！`);
    process.exit(1);
  } else {
    console.log("\n[OK] 自动化校验运行完成！");
  }
}

if (require.main === module) {
  main();
}

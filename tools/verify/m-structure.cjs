/**
 * 记忆中枢 · 页面结构、首屏瘦身与组件装配静态校验
 * 纯 Node.js，零 GUI
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");

function runCheck(isAssert = false) {
  console.log("=== [m-structure] 页面结构、首屏瘦身与组件装配校验 ===");
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

  // 1. MemMorePanel 组件存在
  const morePanelFile = path.join(ROOT, "src/components/memory/MemMorePanel.vue");
  assertCheck("MemMorePanel 扩展功能面板组件已创建", fs.existsSync(morePanelFile));

  // 2. MemFirstRun 组件存在
  const firstRunFile = path.join(ROOT, "src/components/memory/MemFirstRun.vue");
  assertCheck("MemFirstRun 新手引导组件已创建", fs.existsSync(firstRunFile));

  // 3. DashboardView 引用了 MemMorePanel 和 MemFirstRun，且健康/花费卡片折叠
  const dashFile = path.join(ROOT, "src/views/memory/DashboardView.vue");
  if (fs.existsSync(dashFile)) {
    const dashContent = fs.readFileSync(dashFile, "utf8");
    assertCheck("DashboardView 挂载 MemFirstRun 首次使用引导", /MemFirstRun/.test(dashContent));
    assertCheck("DashboardView 挂载 MemMorePanel 更多功能面板", /MemMorePanel/.test(dashContent));
    const hasHealthCollapse = /healthOpen|detailOpen|healthy/.test(dashContent);
    assertCheck("DashboardView 系统健康明细支持折叠披露", hasHealthCollapse);
  }

  // 4. SyncView 界面 WebDAV 入口收敛检查
  const syncFile = path.join(ROOT, "src/views/memory/SyncView.vue");
  if (fs.existsSync(syncFile)) {
    const syncContent = fs.readFileSync(syncFile, "utf8");
    // 不应存在用于配置服务器 endpoint 的双向绑定输入框
    const hasEndpointInput = /v-model="[^"]*endpoint"/.test(syncContent);
    assertCheck("SyncView 不再重复提供 WebDAV 服务器配置输入框，已收敛到统一设置入口", !hasEndpointInput);
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

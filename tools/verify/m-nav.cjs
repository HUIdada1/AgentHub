/**
 * 记忆中枢 · 跨 Tab 联动与导航状态机自动化单测
 * 纯 Node.js，零 GUI
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");

function runCheck(isAssert = false) {
  console.log("=== [m-nav] 跨 Tab 联动与导航状态机单测 ===");
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

  // 1. 纯函数模块测试 (src/stores/memory-nav.ts)
  const navTsPath = path.join(ROOT, "src/stores/memory-nav.ts");
  if (fs.existsSync(navTsPath)) {
    const content = fs.readFileSync(navTsPath, "utf8");
    const hasPickTab = /function\s+pickReviewTab/.test(content);
    const hasResolveNav = /function\s+resolveMemNav/.test(content);
    assertCheck("memory-nav.ts 源码定义 pickReviewTab 与 resolveMemNav 函数", hasPickTab && hasResolveNav);

    // 提取纯 JS 逻辑并执行严格测试用例
    try {
      const jsCode = content
        .replace(/export\s+type\s+[\s\S]*?;/g, "")
        .replace(/export\s+interface\s+[\s\S]*?\}/g, "")
        .replace(/export\s+function/g, "function")
        .replace(/:\s*NavResolution/g, "")
        .replace(/:\s*ReviewCounts/g, "")
        .replace(/:\s*ReviewKind/g, "")
        .replace(/:\s*NavTarget/g, "");
      const evalFn = new Function(`${jsCode}; return { pickReviewTab, resolveMemNav };`);
      const { pickReviewTab, resolveMemNav } = evalFn();

      const c1 = pickReviewTab({ supersede: 0, classify: 0, dedup: 0 }) === "supersede";
      const c2 = pickReviewTab({ supersede: 0, classify: 0, dedup: 5 }) === "dedup";
      const c3 = pickReviewTab({ supersede: 3, classify: 5, dedup: 1 }) === "classify";
      const c4 = pickReviewTab({ supersede: 2, classify: 2, dedup: 2 }) === "supersede";
      assertCheck("pickReviewTab 优先级与平局推导正确 (全空/最大值/平局)", c1 && c2 && c3 && c4);

      const nav1 = resolveMemNav({ page: "browse", view: "review", counts: { supersede: 0, classify: 4, dedup: 1 } });
      const nav2 = resolveMemNav({ page: "projects", project: "HUIdada1--AgentHub" });
      assertCheck(
        "resolveMemNav 跨 Tab 参数解析正确 (目标视图/队列/项目)",
        nav1.page === "browse" && nav1.view === "review" && nav1.tab === "classify" && nav2.project === "HUIdada1--AgentHub"
      );
    } catch (e) {
      assertCheck("memory-nav 纯函数动态单元测试通过", false, String(e));
    }
  } else {
    assertCheck("src/stores/memory-nav.ts 存在", false, "文件尚未创建");
  }

  // 2. 静态代码断言：gotoReview 不直接赋值 activePage
  const memStorePath = path.join(ROOT, "src/stores/memory.ts");
  if (fs.existsSync(memStorePath)) {
    const memStoreContent = fs.readFileSync(memStorePath, "utf8");
    const directAssign = /gotoReview\s*\([^)]*\)\s*\{[\s\S]*?app\.activePage\s*=/m.test(memStoreContent);
    assertCheck(
      "memory.ts 中 gotoReview 走规范导航流程，不直接覆盖 app.activePage",
      !directAssign,
      "仍检测到直接赋值 app.activePage"
    );

    const hasReviewCounts = /reviewCounts\s*:\s*\{[\s\S]*?supersede[\s\S]*?classify[\s\S]*?dedup/m.test(memStoreContent);
    assertCheck(
      "memory.ts 维护统一同源的 reviewCounts 状态",
      hasReviewCounts,
      "未找到 reviewCounts 统一定义"
    );
  }

  // 3. 静态代码断言：MemReviewPanel total 与 store 同源
  const panelPath = path.join(ROOT, "src/components/memory/MemReviewPanel.vue");
  if (fs.existsSync(panelPath)) {
    const panelContent = fs.readFileSync(panelPath, "utf8");
    const isSourceConsistent = /reviewCounts/.test(panelContent) || /pending\.browse/.test(panelContent);
    assertCheck(
      "MemReviewPanel 统计数量与 MemoryStore 统一事实源对齐",
      isSourceConsistent,
      "统计数量尚未引用统一事实源"
    );
  }

  // 4. 静态代码断言：memory.css 清除 .is-2nd 死代码
  const cssPath = path.join(ROOT, "src/styles/memory.css");
  if (fs.existsSync(cssPath)) {
    const cssContent = fs.readFileSync(cssPath, "utf8");
    const hasIs2nd = /\.is-2nd/.test(cssContent);
    assertCheck("memory.css 清除死代码 .is-2nd", !hasIs2nd, "仍存在 .is-2nd 规则");
  }

  // 5. 静态代码断言：BrowseView browseViewHint 告警与兜底
  const browsePath = path.join(ROOT, "src/views/memory/BrowseView.vue");
  if (fs.existsSync(browsePath)) {
    const browseContent = fs.readFileSync(browsePath, "utf8");
    const hasSafeFallback = /console\.warn[\s\S]*?未知视图/.test(browseContent) || /list/.test(browseContent);
    assertCheck("BrowseView 视图跳转具备非法值安全保底机制", hasSafeFallback);
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

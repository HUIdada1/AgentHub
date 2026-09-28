/**
 * 记忆中枢 · 术语降噪与白话文案静态扫描
 * 纯 Node.js，零 GUI
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");

function getAllFiles(dir, exts = [".vue", ".ts"]) {
  let res = [];
  if (!fs.existsSync(dir)) return res;
  const list = fs.readdirSync(dir);
  for (const item of list) {
    const full = path.join(dir, item);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      res = res.concat(getAllFiles(full, exts));
    } else if (exts.includes(path.extname(full))) {
      res.push(full);
    }
  }
  return res;
}

function runCheck(isAssert = false) {
  console.log("=== [m-terminology] 界面术语降噪与 MemHelp 覆盖校验 ===");
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

  const memoryVueFiles = [
    ...getAllFiles(path.join(ROOT, "src/views/memory")),
    ...getAllFiles(path.join(ROOT, "src/components/memory")),
  ];

  // 1. 检查禁止裸露在 UI 模板文字中的晦涩底层词汇（排除注释与代码变量）
  // 检查在 template 区域内的出现
  const forbiddenTerms = [
    { term: "bigram", name: "二元切分/分词" },
    { term: "tombstone", name: "墓碑/已删除标记" },
  ];

  for (const item of forbiddenTerms) {
    let termHits = 0;
    const hitLocations = [];
    for (const file of memoryVueFiles) {
      const content = fs.readFileSync(file, "utf8");
      // 提取 template 区域
      const tmplMatch = content.match(/<template>([\s\S]*?)<\/template>/);
      if (!tmplMatch) continue;
      const tmpl = tmplMatch[1];
      // 排除 class 或属性中的词，只检测展示文字
      const regex = new RegExp(`>([^<]*?${item.term}[^<]*?)<`, "gi");
      let m;
      while ((m = regex.exec(tmpl)) !== null) {
        termHits++;
        hitLocations.push(`${path.basename(file)}: "${m[1].trim()}"`);
      }
    }
    assertCheck(
      `UI展示文字中无晦涩术语【${item.term}】(${item.name})`,
      termHits === 0,
      `命中 ${termHits} 处: [${hitLocations.join("; ")}]`
    );
  }

  // 2. 检查关键组件的 MemHelp 解释气泡覆盖（确保不再看不懂）
  const drawerFile = path.join(ROOT, "src/components/memory/MemoryDetailDrawer.vue");
  if (fs.existsSync(drawerFile)) {
    const drawerContent = fs.readFileSync(drawerFile, "utf8");
    const memHelpCount = (drawerContent.match(/<MemHelp/g) || []).length;
    assertCheck(
      "MemoryDetailDrawer 记忆详情抽屉包含 MemHelp 白话解释 (≥ 2 处)",
      memHelpCount >= 2,
      `当前 MemHelp 数量: ${memHelpCount}`
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

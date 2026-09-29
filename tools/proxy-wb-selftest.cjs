// WorkBuddy 双区客户端探测自测（只读：只探测进程与定位程序，绝不关闭/启动任何进程、不写任何文件）
// 跑法（与 zcode 自测一致，用项目内 Electron 的 Node）：
//   ELECTRON_RUN_AS_NODE=1 "node_modules/electron/dist/electron.exe" tools/proxy-wb-selftest.cjs
// 本模块不依赖 Electron API，系统 Node 亦可在非 Windows 平台上跑（进程类断言自动按平台跳过）。
//
// 这几条断言守的是「切号不会误伤用户其它软件」这条红线：
//   · 进程名必须精确到 WorkBuddy.exe / WorkBuddyAI.exe，一旦有人改成含 "CodeBuddy" 的模糊匹配，
//     就会去杀同机的腾讯 CodeBuddy（数据目录虽叫 CodeBuddyExtension，但两者毫无关系）——就此挂红；
//   · 双区是两个独立进程，任一渠道都不得返回另一个渠道的程序路径（两区显示名都含 "WorkBuddy"，
//     用显示名匹配必然串区）；
//   · findWorkbuddyExe 返回非空时该文件必须真实存在（返回幽灵路径 = 关了客户端却打不开）；
//   · 未运行时调用关闭必须是安全无操作（返回 true 且不改动任何东西）。
"use strict";
const fs = require("node:fs");
const assert = require("node:assert");

const wb = require("../electron/backend/proxy/wbClient.cjs");

let pass = 0;
let fail = 0;
const failures = [];
function T(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${(e && e.message) || e}`);
    console.log(`FAIL  ${name}: ${(e && e.message) || e}`);
  }
}

const isWin = process.platform === "win32";

function main() {
  console.log(`platform: ${process.platform}  (Windows 专属断言: ${isWin ? "开" : "跳过"})\n`);

  // ===== T1 进程名精确映射（红线：不得含 CodeBuddy） =====
  T("T1 进程名精确映射：双区各自独立且不含 CodeBuddy", () => {
    assert.strictEqual(wb.WB_CLIENTS.workbuddy.exe, "WorkBuddy.exe");
    assert.strictEqual(wb.WB_CLIENTS.workbuddy_ai.exe, "WorkBuddyAI.exe");
    assert.notStrictEqual(wb.WB_CLIENTS.workbuddy.exe, wb.WB_CLIENTS.workbuddy_ai.exe, "双区必须是两个不同进程名");
    for (const [ch, c] of Object.entries(wb.WB_CLIENTS)) {
      assert.ok(!/codebuddy/i.test(c.exe), `${ch} 的进程名不得含 CodeBuddy（会误杀腾讯 CodeBuddy）`);
      assert.ok(!/trae|zcode|raccoon/i.test(c.exe), `${ch} 的进程名不得含其它客户端名`);
      assert.ok(/\.exe$/i.test(c.exe), `${ch} 进程名应为 .exe`);
      assert.ok(c.label && c.label.length > 0, `${ch} 需要显示名`);
    }
  });

  // ===== T2 clientOf 未知渠道兜底 =====
  T("T2 clientOf 未知渠道回退到中国区且不抛", () => {
    assert.strictEqual(wb.clientOf("workbuddy").exe, "WorkBuddy.exe");
    assert.strictEqual(wb.clientOf("workbuddy_ai").exe, "WorkBuddyAI.exe");
    assert.strictEqual(wb.clientOf("nope").exe, "WorkBuddy.exe", "未知渠道应兜底而非抛错");
    assert.strictEqual(wb.clientOf(undefined).exe, "WorkBuddy.exe");
    assert.strictEqual(wb.clientOf(null).exe, "WorkBuddy.exe");
  });

  // ===== T3 进程探测返回结构稳定 =====
  T("T3 isWorkbuddyRunning 返回 {running, main} 布尔结构且不抛", () => {
    for (const ch of ["workbuddy", "workbuddy_ai", "nope"]) {
      const r = wb.isWorkbuddyRunning(ch);
      assert.strictEqual(typeof r, "object");
      assert.strictEqual(typeof r.running, "boolean", `${ch}.running 应为布尔`);
      assert.strictEqual(typeof r.main, "boolean", `${ch}.main 应为布尔`);
      assert.strictEqual(r.running, r.main, "单进程渠道 running 与 main 应一致");
    }
  });

  // ===== T4 exe 定位：返回值要么为空串，要么是真实存在的文件；且不串区 =====
  T("T4 findWorkbuddyExe 不返回幽灵路径、不串区", () => {
    const a = wb.findWorkbuddyExe("workbuddy");
    const b = wb.findWorkbuddyExe("workbuddy_ai");
    for (const [ch, p] of [["workbuddy", a], ["workbuddy_ai", b]]) {
      assert.strictEqual(typeof p, "string", `${ch} 应返回字符串`);
      if (p) assert.ok(fs.existsSync(p), `${ch} 返回的路径必须真实存在：${p}`);
    }
    // 双区程序名不同：返回了路径就不得是另一区的可执行文件
    if (a) assert.ok(!/WorkBuddyAI\.exe$/i.test(a), `中国区返回了国际版程序：${a}`);
    if (b) assert.ok(!/[\\/]WorkBuddy\.exe$/i.test(b), `国际版返回了中国区程序：${b}`);
  });

  // ===== T5 未运行时调用关闭 = 安全无操作 =====
  T("T5 未运行渠道的 killWorkbuddy 是无操作且返回 true", () => {
    if (!isWin) return; // 非 Windows 直接 true，无进程概念
    for (const ch of ["workbuddy", "workbuddy_ai"]) {
      if (wb.isWorkbuddyRunning(ch).running) {
        console.log(`      (跳过 ${ch}：本机正在运行，自测不关用户的客户端)`);
        continue;
      }
      assert.strictEqual(wb.killWorkbuddy(ch, 1500), true, `${ch} 未运行时关闭应返回 true`);
      assert.strictEqual(wb.isWorkbuddyRunning(ch).running, false, `${ch} 关闭后仍应为未运行`);
    }
  });

  // ===== T6 launchWorkbuddy 对空路径如实失败而非乱启动 =====
  T("T6 launchWorkbuddy 空路径返回 ok:false 且不抛不启动", () => {
    for (const empty of ["", undefined, null]) {
      const r = wb.launchWorkbuddy(empty);
      assert.strictEqual(r.ok, false, "空路径不得报成功");
      assert.ok(typeof r.message === "string" && r.message.length > 0, "应给出可读原因");
    }
  });

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  pass=${pass} fail=${fail}`);
  if (failures.length) {
    console.log("失败项：");
    for (const f of failures) console.log(" - " + f);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();
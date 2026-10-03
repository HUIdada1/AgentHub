// 记忆同步「拉包失败不得覆盖远端」沙箱自测：异常中止 + 404 首次上传两条路都要钉住
// 运行：node scripts/test-memory-sync-overwrite.cjs
// 只碰临时目录，WebDAV 全打桩，不需要真实服务器 / Electron
//
// 背景：sync.run() 拉远端包时，webdav.get 网络异常（超时/5xx/断网）曾与「404 远端没有包」
// 共用同一个 null 出口——异常被当「首次上传」，跳过合并直接整包上传，把其他设备已同步的
// 记忆覆盖掉且不可逆。修复口径：异常一律中止本轮；只有 get 返回 null（404）才走首次上传。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-mem-syncow-"));
const webdav = require("../electron/backend/webdav.cjs");
const { MemorySync } = require("../electron/backend/memory/sync.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`); }
}

/** 造一个只落在临时目录、依赖全打桩的 syncer（与 test-memory-conflict-batch 同款桩） */
function makeSyncer(rootDir, dataDir) {
  return new MemorySync({
    rootDir,
    dataDir,
    getConfig: () => ({}),
    moduleWebdav: () => ({ endpoint: "https://webdav.example.invalid/dav", username: "u", password: "p", root: "memory" }),
    service: {
      store: {
        writeAtomic(rel, text, { backup = false } = {}) {
          const target = path.join(rootDir, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (backup && fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak.${Date.now()}`);
          fs.writeFileSync(target, text);
        },
        moveToTrash(rel) { fs.rmSync(path.join(rootDir, rel), { force: true }); },
      },
      index: { removeByPath() {}, setMeta() {} },
      reindexFile() {},
      withWrite: (fn) => fn(),
    },
  });
}

/** 打桩 webdav：get 按 scenario 行事，写类方法全部记账。返回 { puts, getMode } 控制柄 */
function stubWebdav() {
  const puts = [];
  const real = { get: webdav.get, put: webdav.put, ensureDir: webdav.ensureDir, test: webdav.test };
  const handle = {
    puts,
    getMode: "throw", // "throw" | "null"
  };
  webdav.test = async () => ({ ok: true });
  webdav.get = async () => {
    if (handle.getMode === "throw") throw new Error("ETIMEDOUT（打桩网络异常）");
    return null; // 404：远端没有包
  };
  webdav.put = async (url, _c, buf) => { puts.push({ url: String(url), bytes: buf.length }); };
  webdav.ensureDir = async () => {};
  handle.restore = () => Object.assign(webdav, real);
  return handle;
}

function makeTree(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "general.md"), "# 总览\n\n本地内容。\n");
  fs.mkdirSync(path.join(rootDir, "projects", "demo"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "projects", "demo", "2026-10-01.md"), "# 日记\n\n本地独有。\n");
}

async function main() {
  console.log("\n[1] 拉包网络异常 → 中止本轮，绝不整包上传");
  {
    const rootDir = path.join(TMP, "root-throw");
    const dataDir = path.join(TMP, "data-throw");
    makeTree(rootDir);
    fs.mkdirSync(dataDir, { recursive: true });
    const stub = stubWebdav();
    try {
      stub.getMode = "throw";
      const r = await makeSyncer(rootDir, dataDir).run();
      ok(r.ok === false, `run() 报告失败（ok=${r.ok}）`);
      ok(/拉取远端包失败/.test(String(r.message)), `错误指明原因（${String(r.message).slice(0, 48)}…）`);
      ok(stub.puts.length === 0, `零上传（实际 ${stub.puts.length} 次 put）`);
      ok(!fs.existsSync(path.join(dataDir, "memory-sync-stage", "memory-pack.tar.gz")) && true, "未进入打包阶段");
    } finally {
      stub.restore();
    }
  }

  console.log("\n[2] 404（远端没有包）→ 首次上传路径保持畅通");
  {
    const rootDir = path.join(TMP, "root-null");
    const dataDir = path.join(TMP, "data-null");
    makeTree(rootDir);
    fs.mkdirSync(dataDir, { recursive: true });
    const stub = stubWebdav();
    try {
      stub.getMode = "null";
      const r = await makeSyncer(rootDir, dataDir).run();
      ok(r.ok === true, `run() 成功（message=${r.message || "-"}）`);
      ok(r.uploaded === 1, `uploaded=1（实际 ${r.uploaded}）`);
      ok(stub.puts.length >= 2, `包+清单已上传（实际 ${stub.puts.length} 次 put）`);
      ok(stub.puts.some((p) => /memory-latest\.tar\.gz$/.test(p.url)) && stub.puts[0].bytes > 0, "远端包已上传且非空");
    } finally {
      stub.restore();
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(`\n结果：${pass} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("回归自测崩溃：", (e && e.stack) || e);
  process.exit(2);
});

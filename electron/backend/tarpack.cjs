// tar.gz 打包/解包：WebDAV 远端技能传输格式，单文件 PUT 原子落地，小文件多的散传在坚果云这类
// 服务器上容易半途失败。手写 USTAR tar + Node 内置 zlib，守住项目零第三方依赖的底线（zip 没有内置实现）。
// 纯字节搬运、不转换行：往返内容与 scanner.treeHash 完全一致（treeHash 只按文件内容与相对路径算）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const BLOCK = 512; // tar 块大小
// USTAR header 字段布局：name 100 / mode 8 / uid 8 / gid 8 / size 12 / mtime 12 / chksum 8 /
// typeflag 1 / linkname 100 / magic 6("ustar\0") / version 2("00") / uname 32 / gname 32 /
// devmajor 8 / devminor 8 / prefix 155，共 512 字节

function writeOctal(buf, off, len, num) {
  buf.write(num.toString(8).padStart(len - 1, "0"), off, "ascii"); // 右对齐补零，GNU tar 也能读
  buf[off + len - 1] = 0; // 字段末尾补 \0 收尾，才是合法 octal 字段
}

function cstr(buf) {
  const i = buf.indexOf(0);
  return (i < 0 ? buf : buf.subarray(0, i)).toString("utf8");
}

/** 包内相对路径折进 header 的 name(100B)/prefix(155B)：整段塞得下就 solo name，塞不下目录部分挪 prefix */
function splitHeaderPath(rel) {
  if (Buffer.byteLength(rel, "utf8") <= 100) return { name: rel, prefix: "" };
  const segs = rel.split("/");
  let name = "";
  let i = segs.length - 1;
  while (i >= 0 && Buffer.byteLength(segs[i] + (name ? "/" : "") + name, "utf8") <= 100) {
    name = segs[i] + (name ? "/" : "") + name;
    i--;
  }
  const head = segs.slice(0, i + 1).join("/");
  if (!name || Buffer.byteLength(head, "utf8") > 155) {
    throw new Error(`技能内文件路径过长：${rel}`);
  }
  return { name, prefix: head };
}

function makeHeader(rel, size, mtimeSec) {
  const h = Buffer.alloc(BLOCK);
  const { name, prefix } = splitHeaderPath(rel);
  h.write(name, 0, "utf8");
  h.write(prefix, 345, "utf8");
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtimeSec);
  h[156] = 0x30; // typeflag '0'：常规文件（纯空子目录不入包，treeHash 口径也只认文件）
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.fill(0x20, 148, 156); // chksum 字段先按空格占位参与求和
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

/** 技能目录打成 tar.gz（返回打包文件数）。文件按相对路径排序，与 treeHash 同序，包内容确定 */
function packDir(dir, outFile) {
  // scanner 只服务「按目录打包」这一个入口，惰性引入：worker 引导只搬运 tarpack 本身，
  // 依赖闭包越小，临时目录引导越不易被模块图变化破坏
  const scanner = require("./scanner.cjs");
  const files = [];
  scanner.collectFiles(dir, "", files);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return packFiles(files, outFile);
}

/** 按 (rel, abs) 文件清单打包（返回文件数）。walk 与过滤留在调用方，这里只做读盘 + tar + gzip */
function packFiles(files, outFile) {
  const chunks = [];
  let packedCount = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(f.abs);
      if (!st.isFile()) continue;
      const buf = fs.readFileSync(f.abs);
      chunks.push(makeHeader(f.rel.replace(/\\/g, "/"), buf.length, Math.floor(st.mtimeMs / 1000)));
      chunks.push(buf);
      chunks.push(Buffer.alloc((BLOCK - (buf.length % BLOCK)) % BLOCK)); // 内容按 512 对齐补零
      packedCount++;
    } catch {
      // 瞬态文件（如并发清理的临时文件/锁文件）读取失败跳过，避免单文件异常破坏整体打包
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // tar 结尾双零块
  fs.writeFileSync(outFile, zlib.gzipSync(Buffer.concat(chunks)));
  return packedCount;
}

/** 包内路径落地检查：挡绝对路径与 .. 穿越，坏包/恶意包不能写到技能目录外面去 */
function safeJoin(destDir, name) {
  const segs = String(name).replace(/\\/g, "/").split("/").filter(Boolean);
  if (!segs.length) throw new Error(`压缩包内路径为空`);
  if (segs.some((s) => s === ".." || s.includes(":"))) throw new Error(`压缩包内路径非法：${name}`);
  return path.join(destDir, ...segs);
}

function headerName(h) {
  const name = cstr(h.subarray(0, 100));
  const prefix = cstr(h.subarray(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

/** 解包 tar.gz 到 destDir（返回落盘文件数）。目录条目兼容处理，自己打的包只有文件 */
function unpack(tgzFile, destDir) {
  const raw = zlib.gunzipSync(fs.readFileSync(tgzFile));
  let off = 0;
  let count = 0;
  while (off + BLOCK <= raw.length) {
    const h = raw.subarray(off, off + BLOCK);
    off += BLOCK;
    if (h.every((b) => b === 0)) continue; // 结尾/中间零块
    const size = parseInt(cstr(h.subarray(124, 136)) || "0", 8) || 0;
    const dest = safeJoin(destDir, headerName(h));
    if (h[156] === 0x35) {
      fs.mkdirSync(dest, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, raw.subarray(off, off + size));
      // 还原 header 里的原始 mtime：冲突裁决与界面「修改时间」都按 mtime 比新旧，
      // 不还原就一律读成「刚下载」，无远端清单兜底时建议会系统性偏向远端
      const mtimeSec = parseInt(cstr(h.subarray(136, 148)) || "0", 8) || 0;
      if (mtimeSec > 0) {
        try {
          fs.utimesSync(dest, mtimeSec, mtimeSec);
        } catch { /* 个别文件系统不支持回写时间，忽略即可，不影响解包结果 */ }
      }
      count++;
    }
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return count;
}

module.exports = { packDir, packFiles, unpack, packDirAsync, packFilesAsync, unpackAsync };

// ---------- worker 化：把读盘 + tar + gzip 挪出主进程事件循环 ----------

/**
 * 为什么要有异步版：打包/解包是纯 CPU + 逐文件同步 I/O（gzipSync 单线程压完才返回），
 * 而 tarpack 的调用方全部活在 Electron 主进程里——主进程事件循环被占死的每一毫秒，
 * UI 的 IPC、记忆中枢本地 API、连同 9527 模型网关的全部请求都在排队。
 * 实测记忆中枢整树打包 ~40s，也就是主界面和模型网关会一起冻 ~40s。
 *
 * 实现取舍：用 eval 引导的 worker，把 tarpack 自身源码文本经 workerData 传进去、
 * 落到临时目录再 require——worker 内只碰 Node 内置模块和真实磁盘文件，
 * 完全不依赖「worker 里能否加载 asar」，开发态与打包态行为一致。
 * tarpack 的依赖闭包只有 scanner.cjs（且已改为惰性引入，仅按目录打包这一入口用到），
 * 引导需要搬运的模块图因此收敛到单个文件。
 */
const WORKER_BOOT = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-tarpack-"));
try {
  for (const [name, src] of Object.entries(workerData.sources)) {
    fs.writeFileSync(path.join(dir, name), src);
  }
  const mod = require(path.join(dir, workerData.entry));
  const result = mod[workerData.fn](...workerData.args);
  parentPort.postMessage({ ok: true, result });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
`;

const DEFAULT_WORKER_TIMEOUT_MS = 300000; // 5分钟超时护栏，防御磁盘异常挂死

/** 单次一命的 worker：低频重活，启动开销（几十 ms）相对耗时可忽略；带超时防护与句柄清理 */
function runInWorker(fn, args, timeoutMs = DEFAULT_WORKER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let worker = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const done = (err, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      err ? reject(err) : resolve(result);
    };

    try {
      const { Worker } = require("node:worker_threads");
      worker = new Worker(WORKER_BOOT, {
        eval: true,
        workerData: {
          sources: {
            "tarpack.cjs": fs.readFileSync(__filename, "utf8"),
            "scanner.cjs": fs.readFileSync(path.join(__dirname, "scanner.cjs"), "utf8"),
          },
          entry: "tarpack.cjs",
          fn,
          args,
        },
      });
    } catch (e) {
      done(new Error(`打包工作线程启动失败：${String((e && e.message) || e)}`));
      return;
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { worker.terminate(); } catch {}
        done(new Error(`打包工作线程执行超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
    }

    worker.on("message", (m) => {
      if (m && m.ok) done(null, m.result);
      else done(new Error((m && m.error) || "打包工作线程返回异常结果"));
    });
    worker.on("error", (e) => done(new Error(`打包工作线程出错：${String((e && e.message) || e)}`)));
    worker.on("exit", (code) => {
      if (!settled && code !== 0) done(new Error(`打包工作线程异常退出（code ${code}）`));
    });
  });
}

/** worker 版按目录打包：语义与 packDir 完全一致（scanner.walk 也在 worker 内做） */
function packDirAsync(dir, outFile, timeoutMs) {
  return runInWorker("packDir", [dir, outFile], timeoutMs);
}

/** worker 版按文件清单打包：清单由调用方在主线程生成（walk+过滤是轻活，避免把过滤逻辑复制进 worker） */
function packFilesAsync(files, outFile, timeoutMs) {
  return runInWorker("packFiles", [files, outFile], timeoutMs);
}

/** worker 版解包：语义与 unpack 完全一致 */
function unpackAsync(tgzFile, destDir, timeoutMs) {
  return runInWorker("unpack", [tgzFile, destDir], timeoutMs);
}
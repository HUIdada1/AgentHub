// tar.gz 打包/解包：WebDAV 远端技能传输格式，单文件 PUT 原子落地，小文件多的散传在坚果云这类
// 服务器上容易半途失败。手写 USTAR tar + Node 内置 zlib，守住项目零第三方依赖的底线（zip 没有内置实现）。
// 纯字节搬运、不转换行：往返内容与 scanner.treeHash 完全一致（treeHash 只按文件内容与相对路径算）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const scanner = require("./scanner.cjs");

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
  const files = [];
  scanner.collectFiles(dir, "", files);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const chunks = [];
  for (const f of files) {
    const st = fs.statSync(f.abs);
    const buf = fs.readFileSync(f.abs);
    chunks.push(makeHeader(f.rel.replace(/\\/g, "/"), buf.length, Math.floor(st.mtimeMs / 1000)));
    chunks.push(buf);
    chunks.push(Buffer.alloc((BLOCK - (buf.length % BLOCK)) % BLOCK)); // 内容按 512 对齐补零
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // tar 结尾双零块
  fs.writeFileSync(outFile, zlib.gzipSync(Buffer.concat(chunks)));
  return files.length;
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
      count++;
    }
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return count;
}

module.exports = { packDir, unpack };
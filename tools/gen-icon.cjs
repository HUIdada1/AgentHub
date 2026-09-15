// 图标生成：以根目录 logo.png（1024×1024）为源，解码 → 缩放 → 产出
// build/icon.png + build/icon.ico + build/tray.png + src/assets/logo.png
// 纯 Node 手搓 PNG 解码/编码/缩放/ICO 打包，运行：node tools/gen-icon.cjs
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SRC = path.join(__dirname, "..", "logo.png");

// ---------- PNG 解码（8-bit RGBA 非隔行） ----------
function decodePNG(buf) {
  let off = 8, w = 0, h = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0)
        throw new Error("源图需为 8-bit RGBA 非隔行 PNG");
    } else if (type === "IDAT") {
      idat.push(data);
    }
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length !== h * (1 + w * 4))
    throw new Error(`源图像素数据不完整：期望 ${h * (1 + w * 4)} 字节，实际 ${raw.length}`);
  const stride = w * 4;
  const px = new Uint8Array(w * h * 4);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const out = y * stride + x;
      const a = x >= 4 ? px[out - 4] : 0;
      const b = y > 0 ? px[out - stride] : 0;
      const c = x >= 4 && y > 0 ? px[out - stride - 4] : 0;
      let v = raw[p + x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      px[out] = v;
    }
    p += stride;
  }
  return { w, h, px };
}

// ---------- 盒式平均缩放（RGB 按 alpha 预乘，透明边缘不出色晕） ----------
function resize(src, tw, th) {
  const { w: sw, h: sh, px } = src;
  const out = new Uint8Array(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor(ty * sh / th);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((ty + 1) * sh / th)));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor(tx * sw / tw);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((tx + 1) * sw / tw)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * sw + x) * 4, al = px[i + 3];
          r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al; n++;
        }
      const o = (ty * tw + tx) * 4;
      out[o + 3] = Math.round(a / n);
      if (a > 0) {
        // 预乘加权平均：Σ(p×α) ÷ Σα
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
    }
  }
  return { w: tw, h: th, px: out };
}

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

function encodePNG(img) {
  const { w, h, px } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 每行行首一个 filter 字节，全用 0（None）
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    Buffer.from(px.buffer, y * w * 4, w * 4).copy(raw, y * (1 + w * 4) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- ICO 打包：每条尺寸内嵌一张 PNG（Vista 之后都认） ----------
function wrapICO(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = e[1] = size === 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([head, ...entries, ...pngs.map((p) => p.png)]);
}

// ---------- 产出 ----------
const src = decodePNG(fs.readFileSync(SRC));
const pngOf = (n) => ({ size: n, png: encodePNG(resize(src, n, n)) });

const icon256 = pngOf(256);
const tray32 = pngOf(32);

const root = path.join(__dirname, "..");
fs.mkdirSync(path.join(root, "build"), { recursive: true });
fs.mkdirSync(path.join(root, "src", "assets"), { recursive: true });
fs.writeFileSync(path.join(root, "build", "icon.png"), icon256.png);
fs.writeFileSync(path.join(root, "build", "icon.ico"), wrapICO([pngOf(16), pngOf(32), pngOf(48), icon256]));
fs.writeFileSync(path.join(root, "build", "tray.png"), tray32.png);
fs.writeFileSync(path.join(root, "src", "assets", "logo.png"), icon256.png);
console.log(
  `图标已生成（源 ${src.w}×${src.h}）：build/icon.png + icon.ico（16/32/48/256）+ tray.png + src/assets/logo.png`
);

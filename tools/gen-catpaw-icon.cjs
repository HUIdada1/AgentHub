// CatPaw（美团）渠道图标生成器：自绘「猫头」意象（三角耳 + 圆脸 + 眼睛 + 鼻点），
// 256×256 PNG（与其它渠道图标同尺寸），产出 src/assets/channels/catpaw.png。
//
// 为什么用脚本自绘而不是找图：方案 §7 明确「图形自行设计，不与参照实现完全一致」，
// 且本项目图标资产是入库的 PNG（不引位图机制）。脚本留在仓库里，改形状/配色可复现，
// 不必依赖设计工具。3×3 超采样出抗锯齿边缘。
//
// 用法：node tools/gen-catpaw-icon.cjs
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZE = 256;
const YELLOW = [255, 196, 0, 255]; // 美团黄
const YELLOW_DEEP = [255, 143, 0, 255]; // 耳内/鼻头（深一档）
const DARK = [58, 42, 8, 255]; // 眼睛

/** 点是否在三角形内（重心符号法） */
function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function inCircle(px, py, cx, cy, r) {
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/** 逐像素渲染：返回 RGBA 缓冲区（3×3 超采样，形状按 耳 → 头 → 眼 → 鼻 叠加） */
function render() {
  const out = Buffer.alloc(SIZE * SIZE * 4, 0);
  const head = { cx: 128, cy: 148, r: 82 };
  const earL = [[56, 96], [104, 52], [112, 132]];
  const earR = [[200, 96], [152, 52], [144, 132]];
  const innerL = [[76, 100], [104, 70], [108, 124]];
  const innerR = [[180, 100], [152, 70], [148, 124]];
  const eyeL = { cx: 100, cy: 140, rx: 15, ry: 19 };
  const eyeR = { cx: 156, cy: 140, rx: 15, ry: 19 };
  const nose = { cx: 128, cy: 190, r: 13 };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let acc = [0, 0, 0, 0];
      let samples = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const px = x + (sx + 0.5) / 3;
          const py = y + (sy + 0.5) / 3;
          samples += 1;
          let color = null;
          if (inTriangle(px, py, ...earL) || inTriangle(px, py, ...earR)) color = YELLOW;
          if (inTriangle(px, py, ...innerL) || inTriangle(px, py, ...innerR)) color = YELLOW_DEEP;
          if (inCircle(px, py, head.cx, head.cy, head.r)) color = YELLOW;
          if (((px - eyeL.cx) / eyeL.rx) ** 2 + ((py - eyeL.cy) / eyeL.ry) ** 2 <= 1) color = DARK;
          if (((px - eyeR.cx) / eyeR.rx) ** 2 + ((py - eyeR.cy) / eyeR.ry) ** 2 <= 1) color = DARK;
          if (inCircle(px, py, nose.cx, nose.cy, nose.r)) color = YELLOW_DEEP;
          if (color) {
            acc = acc.map((v, i) => v + color[i]);
          }
        }
      }
      const offset = (y * SIZE + x) * 4;
      out[offset] = Math.round(acc[0] / samples);
      out[offset + 1] = Math.round(acc[1] / samples);
      out[offset + 2] = Math.round(acc[2] / samples);
      out[offset + 3] = Math.round(acc[3] / samples);
    }
  }
  return out;
}

// ===== 最小 PNG 写入器（IHDR/IDAT/IEND + zlib，避免为一张图标引依赖） =====

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const target = path.join(__dirname, "..", "src", "assets", "channels", "catpaw.png");
fs.writeFileSync(target, encodePng(render(), SIZE));
console.log(`CatPaw 图标已生成：${target}`);

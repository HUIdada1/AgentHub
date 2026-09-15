// 轻量 zip 读写（纯 Node 内置 zlib，零第三方依赖）。
// 供「本机存储」备份压缩包使用：写入为标准 zip（deflate 压缩），任何工具可解压查看；
// 读取只需支持本工具自产的 zip（无 zip64、无加密、无 zip 注释）。
"use strict";
const zlib = require("node:zlib");

// CRC32 查表（zip 规范要求对未压缩数据计算）
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 时间（本地时间，2 秒精度）：zip 头的标准时间字段 */
function dosDateTime(ms) {
  const d = new Date(ms);
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * 创建 zip（deflate 压缩）。entries = [{ name, data: Buffer }]。
 * 备份内容固定为少量英文文件名且总体积远小于 4GB，无需 zip64 与目录项。
 */
function createZip(entries) {
  const parts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const { time, date } = dosDateTime(Date.now());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header 签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 标志位 bit11：UTF-8 文件名
    local.writeUInt16LE(8, 8); // 压缩方法：deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra 长度
    parts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory 签名
    central.writeUInt16LE(20, 4); // 创建版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // 对应 local header 偏移
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + compressed.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const p of centralParts) centralSize += p.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD 签名
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...parts, ...centralParts, eocd]);
}

/**
 * 读取 zip，返回 [{ name, data: Buffer }]（按中央目录顺序）。
 * 结构非法时抛错（恢复入口据此判定「不是有效的备份压缩包」）。
 */
function readZip(buf) {
  // 从尾部定位 EOCD（容忍最多 64KB 的 zip 注释）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("无效的 zip 文件（未找到目录结构）");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("无效的 zip 文件（中央目录损坏）");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    // local header 的文件名/extra 长度可能与中央目录不同，须按 local 头自身定位数据区
    if (localOffset + 30 > buf.length) throw new Error("无效的 zip 文件（条目头越界）");
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    if (dataStart + compSize > buf.length) throw new Error("无效的 zip 文件（条目数据越界）");
    // 只支持自产的 deflate/存储两种压缩方法：其余按存储静默返回会把压缩字节当内容恢复出去
    if (method !== 0 && method !== 8) throw new Error(`无效的 zip 文件（不支持的压缩方法 ${method}）`);
    const raw = buf.slice(dataStart, dataStart + compSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    // CRC 校验：结构完整但内容损坏的包在这里拦截，防止坏数据静默进入还原流程（2026-09-10 审查修复 N2）
    if (crc32(data) !== crc) throw new Error("无效的 zip 文件（数据校验失败，文件已损坏）");
    entries.push({ name, data });
  }
  return entries;
}

module.exports = { createZip, readZip };

// CatPaw 内联图片压缩：把 round 请求体里的超阈值 Base64 大图压成小 JPEG
// （移植来源：参照实现 catpaw/image_compress.rs，其上游是 catpaw-local-proxy/image-compress.mjs）。
//
// 为什么必须有它：CatPaw 上游不拉取 http(s) 图片，图片只能以 data:image/...;base64, 内联；
// 而大图是 round 请求体超限 / 超时的主因（参照实现线上问题根因：单张约 176KB 的截图
// 让 round 请求体超过上游约 200KB 的限制直接 504）。
//
// 压缩语义（参数唯一事实来源是上面那个 .mjs，照抄不改）：
//   触发按 **base64 文本长度** > 60KB；达标按 **JPEG 二进制长度** ≤ 120KB；
//   最长边 1568（等比不放大）、降尺寸下限 896、质量 80 起步每轮 -15 最低 55、最多编码 4 次。
//   即尺寸序列 1568 → 1568 → 1176(→896) → 896，质量序列 80 → 65 → 55 → 55。
//   两个阈值量纲不同（触发按字符数、达标按字节数）是原实现就有的口径，改口径属于行为变更。
//
// 编码器：本机没有 sharp/jimp，用 Electron nativeImage（主进程可用）承担解码/缩放/JPEG 编码。
// 为让「循环与判定逻辑」可被自测（tools/ 下的自测跑在纯 node 里，没有 nativeImage），
// 编解码走可注入的 codec：默认实现懒加载 Electron，测试注入假 codec 复验降质/降尺寸序列。
//
// 容错：任何一步失败（格式不符、base64 解不开、图解不开、编码失败、压了反而更大）一律原样返回，
// 绝不阻断请求——宁可超重发出去（上游报错可见），也不让一张坏图带走整个请求。
"use strict";

const COMPRESS_THRESHOLD_BASE64 = 60 * 1024;
const TARGET_OUTPUT_BYTES = 120 * 1024;
const MAX_DIMENSION = 1568;
const MIN_DIMENSION = 896;
const JPEG_QUALITY = 80;
const MIN_QUALITY = 55;
const MAX_ATTEMPTS = 4;
const DATA_URL_PREFIX = "data:image/";

/** 默认 codec：Electron nativeImage。
 *  decode → {width,height,img}；resize 按等比缩到上限内（不放大）；encodeJpeg 产出 JPEG Buffer。
 *  非 Electron 环境（纯 node 跑自测/脚本）返回 null，压缩整体降级为「原样返回」 */
function electronCodec() {
  let api = null;
  try {
    // 懒加载：proxy 后端跑在 Electron 主进程里；纯 node 下 require("electron") 只会拿到可执行文件路径
    const electron = require("electron");
    if (electron && electron.nativeImage) api = electron.nativeImage;
  } catch {
    api = null;
  }
  if (!api) return null;
  return {
    decode(buffer) {
      const img = api.createFromBuffer(buffer);
      if (!img || img.isEmpty()) return null;
      const size = img.getSize();
      if (!size || !size.width || !size.height) return null;
      return { img, width: size.width, height: size.height };
    },
    resize(handle, maxDimension) {
      const { img, width, height } = handle;
      if (width <= maxDimension && height <= maxDimension) return handle;
      const scale = Math.min(maxDimension / width, maxDimension / height);
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));
      const resized = img.resize({ width: targetWidth, height: targetHeight, quality: "best" });
      if (!resized || resized.isEmpty()) return null;
      const size = resized.getSize();
      return { img: resized, width: size.width, height: size.height };
    },
    encodeJpeg(handle, quality) {
      const buf = handle.img.toJPEG(quality);
      return buf && buf.length ? Buffer.from(buf) : null;
    },
  };
}

let codec = null;
let codecResolved = false;

/** 覆盖 codec（自测用；传 null 恢复默认懒加载） */
function setCodec(next) {
  codec = next;
  codecResolved = true;
}

function activeCodec() {
  if (!codecResolved) {
    codec = electronCodec();
    codecResolved = true;
  }
  return codec;
}

/** 取出 `data:image/<subtype>;base64,<body>` 里的 base64 主体（前缀大小写敏感、subtype 与正文均有字符集约束） */
function imageDataUrlBody(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(DATA_URL_PREFIX)) return null;
  const rest = dataUrl.slice(DATA_URL_PREFIX.length);
  const separator = rest.indexOf(";");
  if (separator < 0) return null;
  const subtype = rest.slice(0, separator);
  if (!subtype || !/^[A-Za-z0-9.+-]+$/.test(subtype)) return null;
  const tail = rest.slice(separator);
  if (!tail.startsWith(";base64,")) return null;
  const body = tail.slice(";base64,".length);
  if (!body || !/^[A-Za-z0-9+/=\r\n]+$/.test(body)) return null;
  return body;
}

/** 压缩内联图片：超阈值的 data:image/*;base64 压成 JPEG，其余原样返回 */
function compressIfNeeded(dataUrl) {
  const body = imageDataUrlBody(dataUrl);
  if (!body) return dataUrl;
  if (body.length < COMPRESS_THRESHOLD_BASE64) return dataUrl;
  const impl = activeCodec();
  if (!impl) return dataUrl;
  let input;
  try {
    input = Buffer.from(body.replace(/[\r\n]/g, ""), "base64");
  } catch {
    return dataUrl;
  }
  if (!input.length) return dataUrl;
  let decoded = null;
  try {
    decoded = impl.decode(input);
  } catch {
    decoded = null;
  }
  if (!decoded) return dataUrl;

  let dimension = MAX_DIMENSION;
  let quality = JPEG_QUALITY;
  let output = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let encoded = null;
    try {
      const scaled = impl.resize(decoded, dimension);
      if (scaled) encoded = impl.encodeJpeg(scaled, quality);
    } catch {
      encoded = null;
    }
    if (!encoded) return dataUrl;
    output = encoded;
    if (encoded.length <= TARGET_OUTPUT_BYTES) break;
    quality = Math.max(MIN_QUALITY, quality - 15);
    if (attempt >= 1) dimension = Math.max(MIN_DIMENSION, Math.floor((dimension * 3) / 4));
  }
  if (!output || output.length >= input.length) return dataUrl;
  return `data:image/jpeg;base64,${output.toString("base64")}`;
}

/** 归一化消息里的内联图片批量压缩（prepare 的调用点）：只处理 image_url 块的 data:image/ URL，
 *  压缩产物与原值不同才回写（不复制其它字段，只替换 url） */
function compressMessages(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || block.type !== "image_url") continue;
      const url = block.imageUrl && block.imageUrl.url;
      if (typeof url !== "string" || !url.startsWith("data:image/")) continue;
      const next = compressIfNeeded(url);
      if (next !== url) block.imageUrl.url = next;
    }
  }
  return messages;
}

module.exports = {
  compressIfNeeded,
  compressMessages,
  setCodec,
  __internals: { imageDataUrlBody, COMPRESS_THRESHOLD_BASE64, TARGET_OUTPUT_BYTES, MAX_DIMENSION, MIN_DIMENSION, JPEG_QUALITY, MIN_QUALITY, MAX_ATTEMPTS },
};

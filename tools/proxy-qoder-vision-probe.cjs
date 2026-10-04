// 反代网关 · Qoder 图片多模态实测
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-qoder-vision-probe.cjs [--model qfmodel]
//
// 为什么需要：适配器此前对 image_url 只是"原样透传"，从未真实发给上游验证过。
// 本脚本回答四个问题：
//   ① 上游是否接受 OpenAI 的 image_url 形态（data URL）
//   ② 模型能否真的"看到"图片内容（而非把 base64 当文本吞掉）
//   ③ 不支持视觉的模型（mmodel）会返回什么错误
//   ④ detail 字段是否被接受
//
// 测试图：现场生成一张 64x64 纯色 PNG（红底 + 白块），让模型回答颜色/形状。
// 若模型答对颜色，说明图片确实被解码识别，而不是被忽略。
//
// 默认用 qfmodel（免费，price_factor=0）避免消耗 credits。
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const zlib = require("node:zlib");

function argVal(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const MODEL = argVal("--model", "qfmodel");

/** 生成一张 64x64 的 PNG：纯红底 + 中心白色方块（便于模型判断"主色是什么"） */
function makePng() {
  const W = 64, H = 64;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const inCenter = x >= 24 && x < 40 && y >= 24 && y < 40;
      // 中心白，其余纯红
      raw[p++] = inCenter ? 255 : 255; // R
      raw[p++] = inCenter ? 255 : 0;   // G
      raw[p++] = inCenter ? 255 : 0;   // B
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunks = [];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const body = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunks.push(chunk("IHDR", ihdr));
  chunks.push(chunk("IDAT", idat));
  chunks.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

async function main() {
  const auth = require("../electron/backend/proxy/qoderAuth.cjs");
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const discovery = require("../electron/backend/proxy/discovery.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  store.open();
  rules.init();

  const cand = discovery.scanAll().find((c) => c.channel === "qoder" && !c.encrypted);
  if (!cand) {
    console.log("  · 本机无 Qoder CN 登录态，跳过");
    return;
  }
  const r = discovery.importCandidate(cand);
  const acc = store.listAccounts("qoder").find((a) => a.id === r.id);
  const sec = store.accountSecrets(store.getAccount(r.id));
  const ad = adapters.get("qoder");

  const png = makePng();
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  console.log(`测试图：64x64 PNG（红底 + 中心白方块），${png.length}B，data URL ${dataUrl.length} 字符`);
  console.log(`模型：${MODEL}`);
  console.log("");

  async function run(label, body, model) {
    const events = [];
    try {
      const res = await ad.chat({ account: acc, secrets: sec, model, body, emit: (e) => events.push(e), meta: {} });
      const text = events.filter((e) => e.type === "delta" && e.delta && e.delta.content).map((e) => e.delta.content).join("");
      const usage = (events.find((e) => e.type === "usage") || {}).usage;
      const err = events.find((e) => e.type === "error");
      console.log(`  [${label}] status=${res.status} planLimit=${res.planLimit}`);
      if (err) console.log(`      错误: ${JSON.stringify(err).slice(0, 220)}`);
      if (text) console.log(`      回复: ${JSON.stringify(text.slice(0, 160))}`);
      if (usage) console.log(`      usage: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} credits=${usage.credits}`);
      return { res, text, usage, err };
    } catch (e) {
      console.log(`  [${label}] 抛错: ${String((e && e.message) || e).slice(0, 200)}`);
      return { error: e };
    }
  }

  console.log("[1] 纯文本基线（确认模型可用）");
  await run("text-only", { messages: [{ role: "user", content: "只回复两个字：正常" }], max_tokens: 8 }, MODEL);

  console.log("\n[2] 图片 + 提问（核心测试）");
  const withImage = {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "这张图片的主体颜色是什么？只回答颜色词（红/绿/蓝/白/黑之一）。" },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    }],
    max_tokens: 16,
  };
  const r2 = await run("image", withImage, MODEL);

  console.log("\n[3] detail 字段兼容性");
  await run("image+detail", {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "图片里中心是什么颜色？只回答一个颜色词。" },
        { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
      ],
    }],
    max_tokens: 16,
  }, MODEL);

  console.log("\n[4] 不支持视觉的模型（mmodel）应报错");
  await run("no-vl-model", {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "描述这张图。" },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    }],
    max_tokens: 16,
  }, "mmodel");

  console.log("\n[结论]");
  const ok = r2 && r2.res && r2.res.status === 200 && r2.text && r2.text.trim().length > 0;
  if (ok) {
    const saidRed = /红|red/i.test(r2.text);
    console.log(`  → 上游接受 image_url 且返回正文。${saidRed ? "模型答出「红」——图片被真实识别（非忽略）。" : "但回答未含「红」，需人工判读。"}`);
  } else {
    console.log("  → 图片请求未成功，详见上方错误。");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n[FAIL] " + ((e && e.stack) || e));
    process.exit(1);
  });

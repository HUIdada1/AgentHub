"use strict";
/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-19
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/**
 * 渠道图标同步器：把 Agent2API 官方 provider 图标刷进 src/assets/channels/，
 * 并生成 channels/SOURCES.md 来源台账。
 *
 * 用法：
 *   node tools/sync-channel-icons.cjs            # 复制 + 校验 + 出台账（默认）
 *   node tools/sync-channel-icons.cjs --check    # 只校验，不写文件（CI / 改完自查）
 *
 * 两个素材源（已逐字节比对：同一张图，SHA-256 相同）：
 *   1) 本机示例项目 Agent2API（v3.4.2 及以前，provider 仍内置于本体前端）
 *      E:\idea work\示例项目\Agent2API\desktop-tauri\ui\assets\providers\
 *   2) Agent2API 官网插件目录（v3.5.0-beta 起，provider 拆成外置插件）
 *      https://agent2api.dev/api/plugins/index.json → /plugin-assets/agent2api-wasm-*.{png,svg}
 *      离线副本见 E:\idea work\示例项目\Agent2api最新插件\icons\
 * 优先读源 1；源 1 没有的文件（beta 才有的 kiro / qwenwork 新版）回落源 2 的离线副本。
 * 若两个源都不在机器上，脚本会明确报错而不是悄悄留着旧图。
 *
 * 官方口径：同一产品的国内版 / 国际版、同一产品的两个池共用同一张图，靠名称区分；
 * 本脚本沿用该口径（原自绘地区角标变体已归档到「废弃代码（禁止git提交推送）」）。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const DEST = path.join(ROOT, "src", "assets", "channels");
const SRC_A2API = "E:\\idea work\\示例项目\\Agent2API\\desktop-tauri\\ui\\assets\\providers";
const SRC_STORE = "E:\\idea work\\示例项目\\Agent2api最新插件\\icons";
const FORMAT_TS = path.join(ROOT, "src", "views", "proxy", "format.ts");
const ICONS_TS = path.join(ROOT, "src", "views", "proxy", "channelIcons.ts");

/** 目标文件名 → [ 官方源文件名, 官方 provider id ] */
const MAP = {
  "trae.png": ["trae.png", "trae"],
  "workbuddy.png": ["workbuddy.png", "workbuddy"],
  "raccoon.png": ["raccoon.png", "raccoon"],
  "modelscope.png": ["modelscope.png", "modelscope"],
  "modelscope_intl.png": ["modelscope.png", "modelscope-intl"],
  "lobster.png": ["lobsterai.png", "lobsterai"],
  "zcode.png": ["zcode.png", "zcode"],
  "kiro.svg": ["kiro.svg", "kiro"],
  "antigravity.png": ["antigravity.png", "antigravity"],
  "minimax.svg": ["minimax-code.svg", "minimax-code"],
  "catpaw.png": ["catpaw.png", "catpaw"],
  "qoder.png": ["qoder.png", "qoder"],
  "qwen_office.svg": ["qwenwork.svg", "qwenwork"],
  "qwen_office_intl.svg": ["qwenwork.svg", "qwenwork-intl"],
  "commandcode.png": ["commandcode.png", "commandcode"],
  "officeace.png": ["officeace.png", "officeace"],
  "atomcode.png": ["atomcode.png", "atomcode"],
  "orcaterm.png": ["orcaterm.png", "orcaterm"],
  "astudio.png": ["astudio.png", "astudio"],
  "doubaowork.png": ["doubaowork.png", "doubaowork"],
  "autoclaw.png": ["autoclaw.png", "autoclaw"],
  "autoclaw_intl.png": ["autoclaw.png", "autoclaw-intl"],
  "cline_free.png": ["cline.png", "cline-free"],
  "cline_pass.png": ["cline.png", "cline-pass"],
  "accio.png": ["accio.png", "accio"],
  "accio_cn.png": ["accio.png", "accio-cn"],
  "codearts.png": ["codearts.png", "codearts"],
  "loomy.png": ["loomy.png", "loomy"],
  "kuku.png": ["kuku.png", "kuku"],
  "monkeycode.png": ["monkeycode.png", "monkeycode"],
};

/** beta 起才有 / 已换版的矢量图，只存在于官网插件目录 */
const STORE_ONLY = {
  "kiro.svg": ["agent2api-wasm-kiro.svg", "kiro"],
  "qwen_office.svg": ["agent2api-wasm-qwenwork.svg", "qwenwork"],
  "qwen_office_intl.svg": ["agent2api-wasm-qwenwork.svg", "qwenwork-intl"],
};

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const head = (p) => sha(p).slice(0, 10).toUpperCase();

/** 取一张源图：优先示例项目，回落官网插件离线副本 */
function pickSource(destName) {
  const storeEntry = STORE_ONLY[destName];
  const candidates = [];
  if (storeEntry) candidates.push([path.join(SRC_STORE, storeEntry[0]), storeEntry[1], "agent2api.dev plugin-assets"]);
  const a = MAP[destName];
  if (a) candidates.push([path.join(SRC_A2API, a[0]), a[1], "Agent2API providers"]);
  for (const [file, provider, origin] of candidates) {
    if (fs.existsSync(file)) return { file, provider, origin };
  }
  return null;
}

/** PNG 宽高（IHDR：块类型在偏移 12，宽高在 16 / 20；避免为读尺寸引入图像库） */
function sizeOf(file) {
  if (!file.toLowerCase().endsWith(".png")) return "矢量";
  const b = fs.readFileSync(file);
  return b.length > 24 && b.readUInt32BE(12) === 0x49484452 ? `${b.readUInt32BE(16)}×${b.readUInt32BE(20)}` : "PNG";
}

/** 从 format.ts 的 CHANNEL_NAMES 与 channelIcons.ts 的 CHANNEL_ICONS 里抽 key 做覆盖对账 */
function keysFrom(file, blockName) {
  const text = fs.readFileSync(file, "utf8");
  const start = text.indexOf(blockName);
  if (start < 0) throw new Error(`找不到 ${blockName}（${path.basename(file)}）`);
  const open = text.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) { end = i; break; }
  }
  return [...text.slice(open, end).matchAll(/^\s*"?([a-z][a-z0-9_]*)"?\s*:/gm)].map((m) => m[1]);
}

const checkOnly = process.argv.includes("--check");
const rows = [];
const problems = [];

// MAP 与 STORE_ONLY 可能有同名目标（beta 换过版的 kiro / qwenwork），按目标名去重，
// 让 STORE_ONLY（更新版）优先命中 —— 见 pickSource。
for (const destName of [...new Set([...Object.keys(MAP), ...Object.keys(STORE_ONLY)])].sort()) {
  const src = pickSource(destName);
  if (!src) { problems.push(`缺源文件：${destName}（两个素材源都没有）`); continue; }
  const to = path.join(DEST, destName);
  const before = fs.existsSync(to) ? sha(to) : "";
  const after = sha(src.file);
  const action = !before ? "ADDED" : before === after ? "same" : "REPLACED";
  if (!checkOnly && action !== "same") fs.copyFileSync(src.file, to);
  rows.push({
    dest: destName,
    provider: src.provider,
    origin: src.origin,
    size: sizeOf(src.file),
    bytes: fs.statSync(src.file).size,
    full: after,
    hash: after.slice(0, 10).toUpperCase(),
    action,
  });
}

// ---- 对账 1：每个渠道显示名都要有图标（否则界面上会掉进首字母徽章）----
const names = keysFrom(FORMAT_TS, "CHANNEL_NAMES");
const icons = keysFrom(ICONS_TS, "CHANNEL_ICONS");
const missIcon = names.filter((id) => !icons.includes(id));
const orphan = icons.filter((id) => !names.includes(id));
if (missIcon.length) problems.push(`CHANNEL_NAMES 有渠道但 CHANNEL_ICONS 没配图：${missIcon.join(", ")}`);
if (orphan.length) problems.push(`CHANNEL_ICONS 配了图但 CHANNEL_NAMES 没这个渠道：${orphan.join(", ")}`);

// ---- 对账 2：文件必须真在磁盘上且与源同哈希 ----
for (const r of rows) {
  const to = path.join(DEST, r.dest);
  if (!fs.existsSync(to)) { problems.push(`图标未落盘：${r.dest}`); continue; }
  if (sha(to) !== r.full) problems.push(`落盘内容与源不一致：${r.dest}`);
}

// ---- 台账 ----
if (!checkOnly) {
  const table = [
    "| 渠道文件 | 官方 provider id | 图形 | 尺寸 | 字节 | SHA-256(前10) | 素材源 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| \`${r.dest}\` | \`${r.provider}\` | ${r.dest.endsWith(".svg") ? "SVG" : "PNG"} | ${r.size} | ${r.bytes} | \`${r.hash}\` | ${r.origin} |`),
  ].join("\n");
  fs.writeFileSync(
    path.join(DEST, "SOURCES.md"),
    `# 渠道图标来源台账\n\n` +
      `本目录是号池渠道 / 技能工具图标的唯一素材来源，映射代码见 \`src/views/proxy/channelIcons.ts\`。\n` +
      `**图形全部取自 Agent2API 官方 provider 图标**（与官网插件目录 \`plugin-assets\` 逐字节相同），\n` +
      `因此与 Agent2API 本体及各插件里显示的完全一致；版权归各厂商，仅作渠道识别。\n\n` +
      `双区 / 双池（\`*_intl\`、\`cline_pass\`、\`accio_cn\` 等）与官方一致：共用同一张图，靠卡片名称区分地区，\n` +
      `不再自绘地区角标 —— 自绘版本无法随官方更新，且会与官方显示不一致。\n\n` +
      `刷新方式：\`node tools/sync-channel-icons.cjs\`（素材源位置见该脚本头部注释）。\n\n` +
      table + "\n",
    "utf8"
  );
}

const changed = rows.filter((r) => r.action !== "same");
console.log(
  JSON.stringify(
    { mode: checkOnly ? "check" : "sync", total: rows.length, changed: changed.length,
      added: rows.filter((r) => r.action === "ADDED").length,
      replaced: rows.filter((r) => r.action === "REPLACED").length,
      channels: names.length, icons: icons.length, problems },
    null, 2
  )
);
process.exit(problems.length ? 1 : 0);

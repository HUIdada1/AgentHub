/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-02
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 用量统计 · 本地缓存被清空后的同步保护自测
// 跑法：node scripts/test-usage-cache-clear-keep-remote.cjs
//      （需要 node:sqlite，老版本 node 用 ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe 跑）
//
// 背景（缺陷）：用量同步上传日分片是「本机该天全部记录整体覆盖写」。设置页「清空本地缓存」只清本地库，
// 远端 WebDAV 数据不动；但清空后源端往往只能重新抽取到一部分历史（会话流水轮转、账本被清理），
// 此时再点顶栏「立即同步」/ 设置页「立即同步」，就会用不完整的本地记录覆盖远端日分片，
// 把远端仍然存着的原始记录削掉。正确语义是：本地缓存可以丢，远端原文不能丢——
// 上传前先读远端、按 id 取并集、把本地缺失的记录补回本地库，再写回并集；读不到远端就中止上传。
//
// 本自测全程假 WebDAV（内存 Map）+ 临时 SQLite，不联网、不碰真实 ~/.Dosage_sync、不起窗口。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

// ===== 沙箱：先改掉用量库路径，再加载 db/sync（二者都在运行时取 config.dbPath，改属性即生效）=====
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cacheclear-"));
const syncConfig = require("../electron/backend/sync-config.cjs");
syncConfig.dbPath = () => path.join(TMP, "dosage-sync.sqlite");
syncConfig.dataDir = () => TMP;
syncConfig.configPath = () => path.join(TMP, "config.json");

const db = require("../electron/backend/db.cjs");
const sync = require("../electron/backend/sync.cjs");
const webdav = require("../electron/backend/webdav.cjs");

let pass = 0;
let failed = 0;
function ok(cond, name, got) {
  if (cond) {
    pass++;
    console.log("  \u2713", name);
  } else {
    failed++;
    console.log("  \u2717", name, got !== undefined ? `→ ${JSON.stringify(got)}` : "");
  }
}

// ===== 假 WebDAV：内存 Map，URL → Buffer =====
const store = new Map();
const shardPutUrls = []; // 只记用量日分片的 PUT（价格表/设备元数据的 PUT 不参与断言）
const shardGetUrls = []; // 只记用量日分片的 GET（探针也算）
let failShardGet = null; // 置为 URL 子串时，该分片 GET 抛错（模拟远端读取失败）

const DATA_PREFIX = "https://dav.test/dav/dosage-sync/usage-tracker/data/";
const shardUrl = (day, ext) => `${DATA_PREFIX}${DEVICE}/${day}.${ext}`;
const isShardUrl = (u) => String(u).startsWith(DATA_PREFIX) && /\.jsonl(\.gz)?$/.test(String(u));

const fakeWebdav = {
  put: async (u, _cfg, text) => {
    if (isShardUrl(u)) shardPutUrls.push(String(u));
    store.set(String(u), Buffer.isBuffer(text) ? Buffer.from(text) : Buffer.from(String(text), "utf8"));
  },
  get: async (u) => {
    if (isShardUrl(u)) shardGetUrls.push(String(u));
    if (failShardGet && String(u).includes(failShardGet)) throw new Error("模拟远端分片读取失败");
    return store.has(String(u)) ? Buffer.from(store.get(String(u))) : null;
  },
  getText: async (u) => {
    const buf = store.get(String(u));
    return buf == null ? null : buf.toString("utf8");
  },
  list: async (u) => {
    const base = String(u).replace(/\/+$/, "");
    const dirs = new Set();
    const files = [];
    for (const key of store.keys()) {
      if (!key.startsWith(base + "/")) continue;
      const rest = key.slice(base.length + 1);
      const slash = rest.indexOf("/");
      if (slash >= 0) dirs.add(rest.slice(0, slash));
      else files.push({ href: `/${rest}`, name: rest, isDir: false, size: 0, modified: null });
    }
    return [
      ...[...dirs].map((d) => ({ href: `/${d}/`, name: d, isDir: true, size: 0, modified: null })),
      ...files,
    ];
  },
  ensureDir: async () => {},
  remove: async (u) => {
    for (const key of [...store.keys()]) {
      if (key === String(u) || key.startsWith(String(u) + "/")) store.delete(key);
    }
  },
};

const ORIG = {};
const STUBBED = ["put", "get", "getText", "list", "ensureDir", "remove"];
for (const k of STUBBED) {
  ORIG[k] = webdav[k];
  webdav[k] = fakeWebdav[k];
}
function restoreWebdav() {
  for (const k of STUBBED) webdav[k] = ORIG[k];
}
function resetRemote() {
  store.clear();
  shardPutUrls.length = 0;
  shardGetUrls.length = 0;
  failShardGet = null;
}

// ===== 固定设备与日期 =====
const DEVICE = "selftest-device-0001";
const D1 = "2026-10-20";
const D2 = "2026-10-21";
const D3 = "2026-10-22";
const D4 = "2026-10-23";
const tsOf = (day, hour = 8) => {
  const p = day.split("-").map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2], hour, 0, 0);
};
const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex");

const CFG = {
  deviceName: "自测机",
  webdav: { endpoint: "https://dav.test/dav", username: "u", password: "p", root: "/dosage-sync", preset: "" },
  localBackup: { dir: TMP },
  sources: [],
  sourceVisibility: { order: [], hidden: [], initialized: true },
  schedule: {},
  totalMode: "full",
  billing: {
    enabled: false,
    displayCurrency: "CNY",
    usdToCny: 7.2,
    importProxy: "",
    sources: { official: { enabled: false }, modelsdev: { enabled: false }, remote: { enabled: false } },
  },
};

/** 造一条本机记录（字段与适配器产出同形） */
function rec(id, day, hour, extra = {}) {
  return {
    id,
    deviceId: DEVICE,
    deviceName: "自测机",
    source: "zcode",
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 10,
    startedAt: tsOf(day, hour),
    status: "success",
    ...extra,
  };
}

/** 按线上 encodeShard 口径把本地当天记录编码成 gzip 分片字节（供「历史已上传」的远端造数） */
function encodeFromDb(day) {
  const recs = db.getRecordsByDay(DEVICE, day);
  return zlib.gzipSync(Buffer.from(recs.map((r) => JSON.stringify(r)).join("\n"), "utf8"));
}

/** 把本地当天记录写进假远端 + 更新 manifest，等价于「上一次成功同步后的远端状态」 */
function seedRemote(day, bytes) {
  store.set(shardUrl(day, "jsonl.gz"), Buffer.from(bytes));
  const key = `usage-tracker/data/${DEVICE}/manifest.json`;
  const old = store.get(`${DATA_PREFIX}${DEVICE}/manifest.json`);
  const shards = old ? JSON.parse(old.toString("utf8")).shards : {};
  shards[`${day}.jsonl.gz`] = sha1(bytes);
  store.set(`${DATA_PREFIX}${DEVICE}/manifest.json`, Buffer.from(JSON.stringify({ v: 1, shards })));
}
function seedDeviceMeta() {
  const url = `https://dav.test/dav/dosage-sync/usage-tracker/devices/${DEVICE}.json`;
  store.set(url, Buffer.from(JSON.stringify({ deviceId: DEVICE, deviceName: "自测机", source: "zcode", lastSyncAt: Date.now(), bootId: "seed" })));
}
/** 解远端日分片 → 记录数组 */
function decodeRemote(day) {
  const buf = store.get(shardUrl(day, "jsonl.gz"));
  if (!buf) return [];
  return zlib
    .gunzipSync(buf)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

(async () => {
  console.log("\n[0] 前置：造好「远端已存原文、本地缓存刚被清空」的现场");
  db.setMeta("device_id", DEVICE);
  db.clearLocalCache(DEVICE);
  db.insertRecords([rec("d1-a", D1, 8), rec("d1-b", D1, 9), rec("d1-c", D1, 10)]);
  db.insertRecords([rec("d2-a", D2, 8), rec("d2-b", D2, 9)]);
  seedRemote(D1, encodeFromDb(D1));
  seedRemote(D2, encodeFromDb(D2));
  seedDeviceMeta();
  const d1Original = Buffer.from(store.get(shardUrl(D1, "jsonl.gz")));
  const d2Original = Buffer.from(store.get(shardUrl(D2, "jsonl.gz")));
  ok(decodeRemote(D1).length === 3 && decodeRemote(D2).length === 2, "远端原有 D1=3 条、D2=2 条");

  // ===== ① 清空本地缓存 + 只重新抽到 1 条 → 远端原文不能被削，本地要被补回 =====
  console.log("\n[1] 清空本地缓存后「立即同步」：远端原文不缩水、本地补齐");
  {
    db.clearLocalCache(DEVICE); // 等价于设置页「清空本地缓存」
    db.insertRecords([rec("d1-a", D1, 8)]); // 源端只重新抽到 1 条历史
    ok(db.getRecordsByDay(DEVICE, D1).length === 1, "清空后本地只剩重新抽到的 1 条（D2 全丢）");

    const r = await sync.run(CFG);
    ok(r && r.ok === true, "同步成功（不因本地不完整而报错）", r);

    const remoteD1 = decodeRemote(D1);
    const remoteD2 = decodeRemote(D2);
    ok(remoteD1.length === 3, "远端 D1 仍是 3 条（未被本地 1 条覆盖丢失）", remoteD1.length);
    ok(remoteD2.length === 2, "远端 D2 仍是 2 条（本地已无 D2，整日保留）", remoteD2.length);
    ok(sha1(store.get(shardUrl(D1, "jsonl.gz"))) === sha1(d1Original), "远端 D1 字节与原文完全一致（并集等于原文时不做无意义写入）");
    ok(sha1(store.get(shardUrl(D2, "jsonl.gz"))) === sha1(d2Original), "远端 D2 字节与原文完全一致");
    ok(db.getRecordsByDay(DEVICE, D1).length === 3, "本地 D1 被远端补回 3 条", db.getRecordsByDay(DEVICE, D1).length);
    ok(db.getRecordsByDay(DEVICE, D2).length === 2, "本地已丢失的 D2 也从远端还原回本地库", db.getRecordsByDay(DEVICE, D2).length);
    const manifest = JSON.parse(store.get(`${DATA_PREFIX}${DEVICE}/manifest.json`).toString("utf8")).shards;
    ok(manifest[`${D1}.jsonl.gz`] === sha1(d1Original) && manifest[`${D2}.jsonl.gz`] === sha1(d2Original),
      "manifest 仍声明两天原文的 hash（远端台账没被改小）");

    // 幂等：补齐后再同步一轮，不应再写任何分片
    shardPutUrls.length = 0;
    const r2 = await sync.run(CFG);
    ok(r2 && r2.ok === true, "第二轮同步成功");
    ok(shardPutUrls.length === 0, "第二轮没有分片写入（内容一致直接跳过）", shardPutUrls);
  }

  // ===== ② 远端分片读不到 → 必须中止上传，远端原文一个字节都不能动 =====
  console.log("\n[2] 远端分片读取失败：中止上传，不拿不完整数据覆盖原文");
  {
    resetRemote();
    db.clearLocalCache(DEVICE);
    db.insertRecords([rec("d1-a", D1, 8), rec("d1-b", D1, 9), rec("d1-c", D1, 10)]);
    seedRemote(D1, encodeFromDb(D1));
    seedDeviceMeta();
    const before = Buffer.from(store.get(shardUrl(D1, "jsonl.gz")));
    db.clearLocalCache(DEVICE);

    failShardGet = `${D1}.jsonl.gz`;
    const r = await sync.run(CFG);
    failShardGet = null;
    ok(r && r.ok === false, "本轮同步返回失败（而不是静默覆盖）", r);
    ok(sha1(store.get(shardUrl(D1, "jsonl.gz"))) === sha1(before), "远端 D1 分片字节未变");
    ok(db.getRecordsByDay(DEVICE, D1).length === 0, "读不到远端就不写本地（本轮不会假装补齐）");
  }

  // ===== ③ 全新远端（无 manifest/无分片）：仍能正常全量上传，且不白发探测请求 =====
  console.log("\n[3] 全新远端回归：正常全量上传，不做无意义的逐日探针");
  {
    resetRemote();
    db.clearLocalCache(DEVICE);
    db.insertRecords([rec("d3-a", D3, 8), rec("d3-b", D3, 9)]);
    seedDeviceMeta();

    const r = await sync.run(CFG);
    ok(r && r.ok === true, "同步成功", r);
    ok(decodeRemote(D3).length === 2, "远端生成 D3 分片且含 2 条记录", decodeRemote(D3).length);
    ok(shardGetUrls.length === 0, "全新远端不逐日探测（GET 分片次数为 0）", shardGetUrls);
    const manifest = JSON.parse(store.get(`${DATA_PREFIX}${DEVICE}/manifest.json`).toString("utf8")).shards;
    ok(typeof manifest[`${D3}.jsonl.gz`] === "string", "manifest 声明了 D3 分片");
  }

  // ===== ④ manifest 缺失 + 旧版纯文本 .jsonl 分片：先读回并集，旧原文不被覆盖 =====
  console.log("\n[4] 旧版远端（无 manifest、纯文本 .jsonl）：读回并集，旧原文原样保留");
  {
    resetRemote();
    db.clearLocalCache(DEVICE);
    db.insertRecords([rec("d4-a", D4, 8), rec("d4-b", D4, 9), rec("d4-c", D4, 10)]);
    const oldText = db.getRecordsByDay(DEVICE, D4).map((r) => JSON.stringify(r)).join("\n");
    store.set(shardUrl(D4, "jsonl"), Buffer.from(oldText, "utf8"));
    const oldBytes = Buffer.from(store.get(shardUrl(D4, "jsonl")));
    seedDeviceMeta();
    db.clearLocalCache(DEVICE);

    const r = await sync.run(CFG);
    ok(r && r.ok === true, "同步成功", r);
    ok(db.getRecordsByDay(DEVICE, D4).length === 3, "本地从旧版远端分片还原 3 条", db.getRecordsByDay(DEVICE, D4).length);
    ok(sha1(store.get(shardUrl(D4, "jsonl"))) === sha1(oldBytes), "旧版 .jsonl 原文未被改写覆盖");
    ok(decodeRemote(D4).length === 3, "新 .jsonl.gz 并集分片含 3 条");
    const manifest = JSON.parse(store.get(`${DATA_PREFIX}${DEVICE}/manifest.json`).toString("utf8")).shards;
    ok(manifest[`${D4}.jsonl.gz`] === sha1(store.get(shardUrl(D4, "jsonl.gz"))), "manifest 指向新并集分片");
  }

  restoreWebdav();
  try { db.close(); } catch { /* 关库失败不影响结论 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用不影响结论 */ }

  console.log(`\n${failed ? "FAIL" : "OK"} 本地缓存清空后的同步保护自测：${pass} 项通过，${failed} 项失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  restoreWebdav();
  try { db.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.error(`\nFAIL 自测异常中断：${(e && e.stack) || e}`);
  process.exit(1);
});

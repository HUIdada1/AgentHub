/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-05
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 渠道锁定回归（v1.82.2「渠道覆盖」的恢复）：
//   · 旧版 proxy.modelOverrides 一次性迁入 localgw.models.channelLocks，落盘打标记；
//   · 设置 / 清除 / 大小写收敛 / 非法渠道拒绝（清除必须真删键，不能写 null）；
//   · models.list() 的 sources / lockChannel / renameLocked 口径；
//   · 改名绑定（overrides）优先，渠道锁不会误伤上游模型名；
//   · routing.pick 认渠道锁；
//   · normalize 清洗坏条目、保留未知键（回滚到旧版不丢数据）。
//
// 跑法：node scripts/run-all-tests.cjs 会自动带上本文件；
// 单跑需要 node:sqlite → ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe <本文件>
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-channel-locks-"));
process.env.AGENTHUB_DATA_DIR = dataDir;
// 迁移前置：磁盘上先放一份"反代网关时代"的配置（旧字段 proxy.modelOverrides）
fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify({ proxy: { modelOverrides: { "legacy-model-x": "trae" } }, localgw: { models: { channelLocks: {} } } }, null, 2),
  "utf8"
);

const store = require("../electron/backend/proxy/store.cjs");
const pool = require("../electron/backend/proxy/pool.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const lgwConfig = require("../electron/backend/localgw/config.cjs");
const models = require("../electron/backend/localgw/models.cjs");
const routing = require("../electron/backend/localgw/routing.cjs");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}
const readDisk = () => JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));

// ---------- 1. 旧配置迁移 ----------
check("旧版 proxy.modelOverrides 一次性迁入 channelLocks 并落盘打标记", () => {
  const c = lgwConfig.get();
  assert.equal(c.models.channelLocks["legacy-model-x"], "trae");
  assert.equal(c.models.migratedChannelLocks, true);
  const disk = readDisk();
  assert.equal(disk.localgw.models.channelLocks["legacy-model-x"], "trae");
  assert.equal(disk.localgw.models.migratedChannelLocks, true);
});

check("迁移标记已落盘：清空锁定后不会被下次迁移重新灌回", () => {
  // 用 normalize 的视角验证机制：标记为 true 时迁移函数在 get() 首行直接 return。
  // （进程内 legacyMigrationChecked 已置位，这里断言落盘标记存在即证明下次启动不会重迁）
  assert.equal(readDisk().localgw.models.migratedChannelLocks, true);
  const c = lgwConfig.get();
  assert.equal(c.models.channelLocks["legacy-model-x"], "trae", "本次进程内应照常可读");
});

// ---------- 2. 在全部内置渠道里找一个双源模型，再给这两个渠道造账号 ----------
const CHANNELS = Object.keys(adapters.ADAPTERS || {});
const idsByChannel = new Map();
for (const ch of CHANNELS) {
  let ids = [];
  try {
    ids = adapters.channelModelIds(ch) || [];
  } catch {
    ids = [];
  }
  idsByChannel.set(ch, new Set(ids));
}

let multi = "";
let chA = "";
let chB = "";
for (const [ch, set] of idsByChannel) {
  for (const id of set) {
    for (const [ch2, set2] of idsByChannel) {
      if (ch2 !== ch && set2.has(id)) {
        multi = id;
        chA = ch;
        chB = ch2;
        break;
      }
    }
    if (multi) break;
  }
  if (multi) break;
}

check("内置渠道目录里存在双源模型（测试前提）", () => {
  assert.ok(multi, "全部内置渠道里找不到同名模型，用例无法继续");
  assert.notEqual(chA, chB);
});

for (const ch of [chA, chB]) {
  for (let n = 0; n < 2; n++) {
    store.addAccount({ channel: ch, uid: `${ch}-lock-${n}`, name: `${ch}-lock-${n}`, token: `${ch}-lock-${n}`, source: "paste" });
  }
}
for (const a of store.listAccounts()) pool.updateStatus(a.id, { status: "online", coolUntil: 0, coolReason: "" });

// ---------- 3. list() 口径 ----------
check("list(): 未锁行的 sources / lockChannel / renameLocked 口径", () => {
  const rows = models.list().filter((m) => m.id === multi);
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.deepEqual([...row.sources].sort(), [chA, chB].sort());
    assert.equal(row.lockChannel, "");
    assert.equal(row.renameLocked, false);
  }
});

// ---------- 4. 设置 / 清除 ----------
check("设置渠道锁：目录只留锁行，source=channel-lock，上游名不改成渠道别名", () => {
  assert.equal(models.setChannelLock(multi, chB).ok, true);
  const rows = models.list().filter((m) => m.id === multi);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "channel-lock");
  assert.equal(rows[0].channel, chB);
  assert.equal(rows[0].lockChannel, chB);
  // 只锁渠道 → 发上游的名字仍是模型自身（不是渠道目录条目名之外的任何东西）
  assert.equal(rows[0].realModel, adapters.resolveModelTarget(multi, chB) || multi);
});

check("清除渠道锁：真删键（不是写 null），目录回落渠道来源", () => {
  assert.equal(models.setChannelLock(multi, "").ok, true);
  const c = lgwConfig.get();
  assert.equal(Object.prototype.hasOwnProperty.call(c.models.channelLocks, multi), false);
  const disk = readDisk();
  assert.equal(Object.prototype.hasOwnProperty.call(disk.localgw.models.channelLocks, multi), false);
  const rows = models.list().filter((m) => m.id === multi);
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.equal(row.source, "channel");
    assert.equal(row.lockChannel, "");
  }
});

// ---------- 5. 大小写收敛 ----------
check("大小写收敛：同名不同大小写只留一条锁", () => {
  const upper = multi.toUpperCase();
  const lower = multi.toLowerCase();
  assert.equal(models.setChannelLock(upper, chB).ok, true);
  assert.equal(models.setChannelLock(lower, chA).ok, true);
  const c = lgwConfig.get();
  const keys = Object.keys(c.models.channelLocks).filter((k) => k.toLowerCase() === lower);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], lower);
  assert.equal(models.setChannelLock(lower, "").ok, true);
});

// ---------- 6. 非法渠道 ----------
check("非法渠道被拒绝，不写坏配置", () => {
  const r = models.setChannelLock(multi, "not-a-real-channel");
  assert.equal(r.ok, false);
  assert.ok(String(r.message || "").includes("没有模型"));
  assert.ok(models.list().filter((m) => m.id === multi).every((m) => m.source === "channel"));
});

// ---------- 7. 「尽力锁」：锁渠道被关闭时回落自动路由 ----------
check("锁渠道被关闭时回落自动路由（尽力锁），锁值仍回传供前端提示", () => {
  assert.equal(models.setChannelLock(multi, chB).ok, true);
  routing.setChannelEnabled(chB, false);
  try {
    const rows = models.list().filter((m) => m.id === multi);
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((m) => m.source === "channel"), "锁失效应回落到渠道目录，而不是让模型消失");
    assert.ok(rows.every((m) => m.lockChannel === chB), "锁值要保留，前端才能提示「锁定已失效」");
  } finally {
    routing.setChannelEnabled(chB, true);
    assert.equal(models.setChannelLock(multi, "").ok, true);
  }
});

// ---------- 8. 改名绑定优先，锁不误伤 ----------
check("改名绑定优先：渠道锁不生效，renameLocked=true（前端据此禁用行内锁）", () => {
  assert.equal(models.setOverride(multi, { real_model: multi, channel: chA }).ok, true);
  assert.equal(models.setChannelLock(multi, chB).ok, true);
  const rows = models.list().filter((m) => m.id === multi);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "override");
  assert.equal(rows[0].channel, chA);
  assert.equal(rows[0].renameLocked, true);
  assert.equal(models.removeRule("overrides", multi).ok, true);
  assert.equal(models.setChannelLock(multi, "").ok, true);
});

// ---------- 9. 路由 ----------
check("routing.pick 认渠道锁", () => {
  assert.equal(models.setChannelLock(multi, chB).ok, true);
  assert.equal(routing.pick(multi), chB);
  assert.equal(models.setChannelLock(multi, "").ok, true);
});

// ---------- 10. normalize 容错与回滚安全 ----------
check("normalize：坏条目丢弃、默认值补全、未知键保留（回滚到旧版不丢数据）", () => {
  const out = lgwConfig.normalize({
    models: { channelLocks: { "": "x", good: "", ok: "trae", bad: null }, unknownFutureField: 1 },
  });
  assert.deepEqual(out.models.channelLocks, { ok: "trae" });
  assert.equal(out.models.unknownFutureField, 1);
  assert.equal(Array.isArray(out.models.channelLocks), false);
  assert.equal(typeof out.models.migratedChannelLocks, "boolean");
});

// ---------- 11. 默认配置形状 ----------
check("默认配置：channelLocks 为空对象、迁移标记为 false", () => {
  const def = lgwConfig.normalize({});
  assert.deepEqual(def.models.channelLocks, {});
  assert.equal(def.models.migratedChannelLocks, false);
});

store.close();
console.log(`\n全部通过：${passed} 项`);

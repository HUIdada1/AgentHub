/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-10
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 模型组回归（「对外名 → 多个渠道模型」）：
//   · normalize 清洗坏组 / 坏成员 / 大小写去重 / 无成员整组丢弃；
//   · bindings / groupSpec：顺序、大小写、别名 → 组、停用渠道成员剔除；
//   · list() 每成员一行，renameLocked=true（行内锁避让）；
//   · setGroup 落盘 / 大小写收敛 / 与 overrides 重名拒绝；removeRule("groups") 真删；
//   · routing.pickGroupMember：顺序优先、排除渠道、成员级排重、同渠道多模型、轮询。
//
// 跑法：node scripts/run-all-tests.cjs 会自动带上本文件；
// 单跑需要 node:sqlite → ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe <本文件>
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-model-groups-"));
process.env.AGENTHUB_DATA_DIR = dataDir;

const store = require("../electron/backend/proxy/store.cjs");
const pool = require("../electron/backend/proxy/pool.cjs");
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

/** 假目录：只回答「渠道是否打开 + 元数据」，不碰真实服务/账号 */
function fakeCatalog(openChannels) {
  const open = new Set(openChannels);
  return {
    channelOn: (ch) => open.has(ch),
    resolveModelTarget: (model) => model,
    modelMetadata: () => ({ rate: 1, capabilities: {}, contextLength: 0, maxOutputTokens: 0, metadataScope: "binding", rateSource: "catalog" }),
    historicalBindings: () => [],
    channelModelIds: () => [],
    listableModels: () => [],
  };
}

function snapshotWith(config, openChannels = ["trae", "zcode"]) {
  return { catalog: fakeCatalog(openChannels), config, base: [], proxy: {} };
}

async function main() {
// ---------- 1. normalize 容错 ----------
check("normalize：坏组/坏成员丢弃，成员顺序保留，同渠道同名去重（大小写不敏感）", () => {
  const out = lgwConfig.normalize({
    models: {
      groups: {
        "": { members: [{ channel: "trae", real_model: "x" }] },
        empty: { members: [] },
        second: "not-an-object",
        free: {
          strategy: "whatever",
          members: [
            { channel: "trae", real_model: "glm-4.6" },
            { channel: "Trae", real_model: "GLM-4.6" },
            { channel: "", real_model: "x" },
            { channel: "zcode", real_model: "" },
            null,
            { channel: "zcode", real_model: "glm-5.3" },
          ],
        },
      },
    },
  });
  assert.deepEqual(out.models.groups.free, {
    strategy: "priority",
    members: [
      { channel: "trae", real_model: "glm-4.6" },
      { channel: "zcode", real_model: "glm-5.3" },
    ],
  });
  assert.equal(out.models.groups.empty, undefined);
  assert.equal(out.models.groups.second, undefined);
  assert.equal(out.models.groups[""], undefined);
});

check("默认配置：groups 为空对象，策略只认 priority / round-robin", () => {
  const def = lgwConfig.normalize({});
  assert.deepEqual(def.models.groups, {});
  const round = lgwConfig.normalize({ models: { groups: { g: { strategy: "round-robin", members: [{ channel: "trae", real_model: "m" }] } } } });
  assert.equal(round.models.groups.g.strategy, "round-robin");
});

// ---------- 2. 绑定解析 ----------
const cfgFree = lgwConfig.normalize({
  models: {
    groups: {
      free: {
        strategy: "priority",
        members: [
          { channel: "trae", real_model: "glm-4.6" },
          { channel: "zcode", real_model: "glm-5.3" },
          { channel: "offchan", real_model: "hidden-model" },
        ],
      },
    },
  },
});

check("bindings：按成员顺序返回，关停渠道的成员被剔除，行上带 groupName", () => {
  const rows = models.bindings("free", new Set(), snapshotWith(cfgFree));
  assert.deepEqual(rows.map((r) => [r.channel, r.realModel, r.source, r.groupName]), [
    ["trae", "glm-4.6", "group", "free"],
    ["zcode", "glm-5.3", "group", "free"],
  ]);
});

check("bindings / groupSpec：组名大小写不敏感，组名不存在回 null", () => {
  const snapshot = snapshotWith(cfgFree);
  assert.equal(models.groupSpec("FREE", snapshot).name, "free");
  assert.equal(models.groupSpec("nope", snapshot), null);
  const rows = models.bindings("Free", new Set(), snapshot);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.display === "Free" && r.groupName === "free"));
});

check("别名 → 组：组多成员照常解析，source=alias 但 groupName 保留（转发层据此按组策略选）", () => {
  const cfg = lgwConfig.normalize({
    models: {
      aliases: { default: "free" },
      groups: { free: { members: [{ channel: "trae", real_model: "glm-4.6" }, { channel: "zcode", real_model: "glm-5.3" }] } },
    },
  });
  const snapshot = snapshotWith(cfg);
  assert.equal(models.groupSpec("default", snapshot).name, "free");
  const rows = models.bindings("default", new Set(), snapshot);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.source === "alias" && r.groupName === "free"));
});

check("组内成员全部不可用：bindings 回空（不偷偷回落同名渠道模型），groupSpec 仍可解析", () => {
  const snapshot = snapshotWith(cfgFree, []);
  assert.deepEqual(models.bindings("free", new Set(), snapshot), []);
  assert.equal(models.groupSpec("free", snapshot).name, "free");
});

check("groupSpec：对外名被 disabledModels 停用时回 null（按 404 处理，不是组没有成员）", () => {
  const snapshot = snapshotWith(cfgFree);
  snapshot.proxy = { disabledModels: ["FREE"] };
  assert.equal(models.groupSpec("free", snapshot), null);
});

// ---------- 3. list() 口径 ----------
check("list()：每个成员一行，source=group，renameLocked=true，行内锁避让", () => {
  const rows = models.list(snapshotWith(cfgFree)).filter((m) => m.id === "free");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((m) => m.source === "group" && m.groupName === "free" && m.renameLocked === true));
  assert.deepEqual(rows.map((m) => m.channel), ["trae", "zcode"]);
});

// ---------- 4. 写入 / 删除 ----------
check("setGroup：整组落盘，成员顺序保留", () => {
  const r = models.setGroup("free", {
    strategy: "round-robin",
    members: [
      { channel: "zcode", real_model: "glm-5.3" },
      { channel: "trae", real_model: "glm-4.6" },
    ],
  });
  assert.equal(r.ok, true);
  const c = lgwConfig.get();
  assert.equal(c.models.groups.free.strategy, "round-robin");
  assert.deepEqual(c.models.groups.free.members.map((m) => m.channel), ["zcode", "trae"]);
  const disk = readDisk();
  assert.deepEqual(disk.localgw.models.groups.free.members.map((m) => m.channel), ["zcode", "trae"]);
});

check("setGroup：大小写收敛（Free/free 只留一条）", () => {
  assert.equal(models.setGroup("Free", { strategy: "priority", members: [{ channel: "trae", real_model: "m1" }] }).ok, true);
  const keys = Object.keys(lgwConfig.get().models.groups).filter((k) => k.toLowerCase() === "free");
  assert.equal(keys.length, 1);
  assert.equal(keys[0], "Free");
});

check("setGroup：与改名覆盖 / 别名重名直接拒绝（组优先级最高，重名会让另一套规则静默失效）", () => {
  assert.equal(models.setOverride("free2", { real_model: "x", channel: "trae" }).ok, true);
  const r = models.setGroup("free2", { members: [{ channel: "trae", real_model: "x" }] });
  assert.equal(r.ok, false);
  assert.ok(String(r.message || "").includes("占用"));
  assert.equal(models.removeRule("overrides", "free2").ok, true);
  assert.equal(models.setAlias("free3", "free").ok, true);
  const r2 = models.setGroup("FREE3", { members: [{ channel: "trae", real_model: "x" }] });
  assert.equal(r2.ok, false);
  assert.equal(models.removeRule("aliases", "free3").ok, true);
});

check("组名的反向占用：override / alias / custom / 批量添加 / 渠道锁都不能写同名规则", () => {
  // 当前存在组 "Free"（大小写不同也算同名）
  assert.equal(models.setOverride("free", { real_model: "x", channel: "trae" }).ok, false);
  assert.equal(models.setAlias("FREE", "some-model").ok, false);
  assert.equal(models.addCustom("Free", { channel: "trae", real_model: "x" }).ok, false);
  const batch = models.addBatch("override", [
    { model: "free", channel: "trae", real_model: "x" },
    { model: "ok-model", channel: "trae", real_model: "y" },
  ]);
  assert.equal(batch.ok, true);
  assert.equal(batch.added, 1);
  assert.equal(batch.skipped.length, 1);
  assert.ok(String(batch.skipped[0].message).includes("模型组"));
  assert.equal(models.setChannelLock("Free", "trae").ok, false);
  assert.equal(models.removeRule("overrides", "ok-model").ok, true);
});

check("setGroup：空成员 / 无有效成员被拒绝，不写坏配置", () => {
  assert.equal(models.setGroup("bad", { members: [] }).ok, false);
  assert.equal(models.setGroup("bad", { members: [{ channel: "", real_model: "x" }] }).ok, false);
  assert.equal(lgwConfig.get().models.groups.bad, undefined);
});

check("removeRule('groups')：真删键（不是写 null），幂等", () => {
  assert.equal(models.removeRule("groups", "Free").ok, true);
  assert.equal(lgwConfig.get().models.groups.Free, undefined);
  assert.equal(readDisk().localgw.models.groups.Free, undefined);
  assert.equal(models.removeRule("groups", "Free").ok, true);
  assert.equal(models.removeRule("groups", "free").ok, true, "幂等键按原样删，不存在的键直接 ok");
});

// ---------- 5. 组内路由 ----------
for (const ch of ["trae", "zcode"]) {
  for (let n = 0; n < 2; n++) {
    store.addAccount({ channel: ch, uid: `${ch}-grp-${n}`, name: `${ch}-grp-${n}`, token: `${ch}-grp-${n}`, source: "paste" });
  }
}
for (const a of store.listAccounts()) pool.updateStatus(a.id, { status: "online", coolUntil: 0, coolReason: "" });

check("pickGroupMember：priority 按成员顺序取第一个可用", () => {
  const members = [{ channel: "trae", realModel: "m1" }, { channel: "zcode", realModel: "m2" }];
  assert.equal(routing.pickGroupMember(members, "priority").channel, "trae");
});

check("pickGroupMember：排除渠道 / 成员级排重 / 同渠道第二个模型可接上", () => {
  const members = [{ channel: "trae", realModel: "m1" }, { channel: "trae", realModel: "m2" }, { channel: "zcode", realModel: "m3" }];
  assert.equal(routing.pickGroupMember(members, "priority", new Set(["trae"])).realModel, "m3");
  const blocked = new Set([routing.groupMemberKey(members[0])]);
  assert.equal(routing.pickGroupMember(members, "priority", new Set(), blocked).realModel, "m2");
  const allBlocked = new Set(members.map((m) => routing.groupMemberKey(m)));
  assert.equal(routing.pickGroupMember(members, "priority", new Set(), allBlocked), null);
});

check("pickGroupMember：全部渠道被排除时回 null（调用方据此 503）", () => {
  const members = [{ channel: "trae", realModel: "m1" }, { channel: "zcode", realModel: "m2" }];
  assert.equal(routing.pickGroupMember(members, "priority", new Set(["trae", "zcode"])), null);
});

check("pickGroupMember：round-robin 在可用成员间轮转", () => {
  const members = [{ channel: "trae", realModel: "m1" }, { channel: "zcode", realModel: "m2" }];
  const picks = [];
  for (let i = 0; i < 4; i++) picks.push(routing.pickGroupMember(members, "round-robin", new Set(), new Set(), "test:free").channel);
  assert.deepEqual(picks, ["trae", "zcode", "trae", "zcode"]);
});

check("pickGroupMember：失效成员（渠道关闭）不参与选择", () => {
  const members = [{ channel: "trae", realModel: "m1" }, { channel: "zcode", realModel: "m2" }];
  routing.setChannelEnabled("trae", false);
  try {
    assert.equal(routing.pickGroupMember(members, "priority").channel, "zcode");
  } finally {
    routing.setChannelEnabled("trae", true);
  }
});

console.log(`\n全部通过：${passed} 项`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

/**
 * 自动化测试：深层画像持久缓存与自愈机制验证
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const profileCache = require("../../electron/backend/memory/profile-cache.cjs");

const testDataDir = path.join(__dirname, ".tmp-test-profile-cache-data");
const testStoreDir = path.join(__dirname, ".tmp-test-profile-cache-store");

function clean() {
  fs.rmSync(testDataDir, { recursive: true, force: true });
  fs.rmSync(testStoreDir, { recursive: true, force: true });
}

clean();
fs.mkdirSync(testDataDir, { recursive: true });
fs.mkdirSync(testStoreDir, { recursive: true });

try {
  console.log("1. 测试 saveCache 与 loadCache...");
  const sampleSections = {
    persona: "- 深度思考型\n  证据：id101",
    preferences: "- 简洁代码\n  证据：id102",
    tech: "- TypeScript 专家\n  证据：id103",
    habits: "- 严谨自动化测试\n  证据：id104",
  };
  const saveOk = profileCache.saveCache(testDataDir, sampleSections, { updatedAt: 123456789 });
  assert.strictEqual(saveOk, true, "saveCache 应当返回 true");

  const loaded = profileCache.loadCache(testDataDir);
  assert.ok(loaded, "loadCache 应当返回非空对象");
  assert.strictEqual(loaded.version, 1, "版本应为 1");
  assert.strictEqual(loaded.updatedAt, 123456789, "时间戳应当一致");
  assert.strictEqual(loaded.sections.persona, sampleSections.persona, "persona 分区内容应当一致");
  assert.strictEqual(loaded.sections.tech, sampleSections.tech, "tech 分区内容应当一致");
  console.log("   ✓ saveCache / loadCache 正常");

  console.log("2. 测试 restoreIfMissing 自愈恢复机制...");
  // 模拟 Store 对象
  const memoryStore = {};
  const reindexed = [];
  const fakeStore = {
    read(rel) {
      return memoryStore[rel] || null;
    },
    writeAtomic(rel, content) {
      memoryStore[rel] = content;
    },
  };

  // 初始时 store 里没有任何 profile/*.md
  assert.strictEqual(fakeStore.read("profile/persona.md"), null);

  // 执行自愈恢复
  const restoreRes = profileCache.restoreIfMissing(fakeStore, testDataDir, (rel) => reindexed.push(rel));
  assert.deepStrictEqual(restoreRes.restored.sort(), ["habits", "persona", "preferences", "tech"].sort());
  assert.strictEqual(fakeStore.read("profile/persona.md"), sampleSections.persona);
  assert.strictEqual(fakeStore.read("profile/tech.md"), sampleSections.tech);
  assert.strictEqual(reindexed.length, 4, "4 个分区都应触发 reindex 回调");
  console.log("   ✓ 缺失时自动自愈恢复 4 个分区成功");

  console.log("3. 测试本地已存在内容时不再重复覆盖...");
  // 再次调用，此时 store 里已存在，不应再次 restore
  reindexed.length = 0;
  const secondRestore = profileCache.restoreIfMissing(fakeStore, testDataDir, (rel) => reindexed.push(rel));
  assert.strictEqual(secondRestore.restored.length, 0, "已存在时不应重复还原");
  assert.strictEqual(reindexed.length, 0, "不应触发 reindex");
  console.log("   ✓ 避免无效重复覆盖机制正常");

  console.log("4. 测试 syncStoreToCache 镜像同步...");
  // 用户在本地编辑了 habits
  fakeStore.writeAtomic("profile/habits.md", "- [pinned] 每日敏捷回顾\n  证据：id999");
  const syncOk = profileCache.syncStoreToCache(fakeStore, testDataDir);
  assert.strictEqual(syncOk, true, "syncStoreToCache 应当返回 true");
  const updatedCache = profileCache.loadCache(testDataDir);
  assert.strictEqual(updatedCache.sections.habits, "- [pinned] 每日敏捷回顾\n  证据：id999");
  console.log("   ✓ store 同步到 cache 正常");

  console.log("\n[PASS] profile-cache 全部自动化断言通过！");
} finally {
  clean();
}

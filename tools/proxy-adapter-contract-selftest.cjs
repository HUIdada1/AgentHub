// 反代网关 · 适配器契约符合性自测：双表一致（CHANNELS↔ADAPTERS）+ 必需/推荐方法全员符合 + 守卫可拦截
// 用法：node tools/proxy-adapter-contract-selftest.cjs（纯逻辑，不触碰 SQLite；
// 也可按 proxy-smoke 同款在 ELECTRON_RUN_AS_NODE=1 electron 下跑）
"use strict";

async function main() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error("断言失败: " + msg);
  };
  const store = require("../electron/backend/proxy/store.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");

  // 1. 契约方法清单固定（漏改契约注释块即失败）
  assert(
    JSON.stringify(adapters.REQUIRED_ADAPTER_METHODS) === JSON.stringify(["cfg", "models", "chat", "queryCredits"]),
    "REQUIRED_ADAPTER_METHODS = cfg/models/chat/queryCredits"
  );

  // 2. 双表一致性：两向差集必须为空（只加一张表 = 模型被路由到无账号渠道/渠道不出现在 UI）
  const report = adapters.consistencyReport();
  assert(!report.channelsWithoutAdapter.length, `CHANNELS 全有适配器（缺：${report.channelsWithoutAdapter.join("/")}）`);
  assert(!report.adaptersWithoutChannel.length, `ADAPTERS 全有渠道行（缺：${report.adaptersWithoutChannel.join("/")}）`);
  assert(Object.keys(adapters.ADAPTERS).length === store.CHANNELS.length, `ADAPTERS 数 = CHANNELS 数 = ${store.CHANNELS.length}`);

  // 3. 必需方法全员符合（启动期已校验，这里复验并逐渠道点名）
  for (const c of store.CHANNELS) {
    const ad = adapters.get(c.id);
    assert(ad, `渠道 ${c.id} 适配器已注册`);
    adapters.assertAdapterContract(c.id, ad);
    // 推荐方法（现有渠道全有；新渠道缺省时调用点守卫/降级，这里按现状断言防回归）
    for (const m of ["fetchModels", "checkin", "checkinStatus", "refreshToken"]) {
      assert(typeof ad[m] === "function", `渠道 ${c.id} 推荐方法 ${m}() 存在`);
    }
  }

  // 4. 守卫可拦截：缺 chat 的残缺适配器必须抛错且点名缺失方法
  let threw = "";
  try {
    adapters.assertAdapterContract("残缺渠道", { cfg() {}, models() { return []; } });
  } catch (e) {
    threw = String((e && e.message) || e);
  }
  assert(/缺少必需的适配器方法 chat/.test(threw), "缺 chat 的残缺适配器被断言拦截（实际：" + (threw || "未抛错") + "）");

  // 5. 只实现必需方法的最小适配器通过契约（推荐/可选方法由调用点守卫，不在契约层封死）
  let minimal = true;
  try {
    adapters.assertAdapterContract("最小渠道", { cfg() {}, models() { return []; }, chat() {}, queryCredits() {} });
  } catch {
    minimal = false;
  }
  assert(minimal, "只实现必需方法的最小适配器通过契约");

  console.log(`适配器契约自测全过（${store.CHANNELS.length} 渠道 × 必需/推荐方法 + 双表一致 + 守卫拦截）`);
}

main().catch((e) => {
  console.error((e && e.message) || e);
  process.exit(1);
});

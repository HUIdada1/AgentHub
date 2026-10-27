/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// refreshTokenLocked 并发 single-flight 压测（审查整改 M6）：
//  同一 (channel, account) 的 N 个并发调用必须共享同一 Promise（refreshInflight 去重），
//  即适配器 refreshToken 只被调用一次；N 个 await 返回相同结果。
//  这是「refresh_token 轮换型渠道」的生命线：并发双刷 = 第一次的 refresh_token 刚被服务端
//  轮换作废，第二次请求拿旧凭据 → 401 → 用户被迫重新登录（历史事故）。
// 跑法：node scripts/test-refresh-token-locked.cjs
"use strict";
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
// 不依赖 store/config：refreshTokenLocked 只需要 adapters.get() 里注册好的适配器对象。
// 用一个最薄的 stub 适配器注入 ADAPTERS，避免拉起整个 store + SQLite。
const adapters = require(path.join(ROOT, "electron", "backend", "proxy", "adapters.cjs"));

let refreshCallCount = 0;
let lastSecrets = null;
const CHANNEL = "__test_refresh_locked__";
adapters.ADAPTERS[CHANNEL] = {
  id: CHANNEL,
  cfg() { return {}; },
  async refreshToken(_account, secrets) {
    refreshCallCount++;
    lastSecrets = secrets;
    // 模拟真实网络的异步等待（让并发真的撞在 in-flight 上）
    await new Promise((r) => setTimeout(r, 50));
    return { ok: true, token: `tk-${refreshCallCount}`, refreshToken: `rt-${refreshCallCount}`, rotated: true };
  },
};

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

async function main() {
  const account = { id: "acc-1", uid: "u-1" };
  const secrets = { token: "old-tk", refreshToken: "old-rt" };

  console.log("[1] 10 个并发调用 → refreshToken 只执行 1 次");
  {
    refreshCallCount = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => adapters.refreshTokenLocked(CHANNEL, account, secrets))
    );
    ok(refreshCallCount === 1, `refreshToken 实际执行 ${refreshCallCount} 次（期望 1）`);
    ok(results.every((r) => r.ok && r.token === results[0].token), "所有并发拿到同一份结果");
    ok(lastSecrets === secrets, "适配器收到的 secrets 是入参引用（未被包装修改）");
  }

  console.log("[2] 串行第二轮 → 再次执行（in-flight 已清）");
  {
    refreshCallCount = 0;
    await adapters.refreshTokenLocked(CHANNEL, account, secrets);
    await adapters.refreshTokenLocked(CHANNEL, account, secrets);
    ok(refreshCallCount === 2, `串行两次共执行 ${refreshCallCount} 次（期望 2）`);
  }

  console.log("[3] 失败路径：in-flight 在 reject 后也会被清");
  {
    // 失败桩也要计数：只断言「两次都拿到失败结果」是无效断言——in-flight 泄漏时第二次会复用
    // 同一个已 reject 的 promise，照样是 ok:false，测试恒绿却什么都没验证。真正要钉的是
    // 「第二次又真的调了一次适配器」（= 表项已删），故这里必须 refreshCallCount++
    adapters.ADAPTERS[CHANNEL].refreshToken = async () => { refreshCallCount++; throw new Error("network down"); };
    refreshCallCount = 0;
    const r1 = await adapters.refreshTokenLocked(CHANNEL, account, secrets).catch((e) => ({ ok: false, message: String(e.message) }));
    const r2 = await adapters.refreshTokenLocked(CHANNEL, account, secrets).catch((e) => ({ ok: false, message: String(e.message) }));
    ok(r1.ok === false && r2.ok === false, "两次都拿到失败结果");
    ok(refreshCallCount === 2, `reject 后表项已清，第二次真的重发（实际调用 ${refreshCallCount} 次，期望 2）`);
  }

  console.log(`\n结果：${pass} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

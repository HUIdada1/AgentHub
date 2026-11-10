/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-06
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
"use strict";
const assert = require("node:assert/strict");
const management = require("../electron/backend/proxy/management-adapters.cjs");
const adapter = management.get("modelscope");
assert.ok(adapter, "ModelScope account-management adapter is registered");
for (const method of ["cfg", "models", "fetchModels", "queryCredits", "checkinStatus", "checkin", "trial", "refreshToken"])
  assert.equal(typeof adapter[method], "function", `ModelScope management method ${method} is retained`);
for (const method of ["chat", "mapModel", "rewriteBody"])
  assert.equal(typeof adapter[method], "undefined", `ModelScope forwarding method ${method} is not in the host management adapter`);
const catalog = adapter.models();
assert.ok(Array.isArray(catalog) && catalog.length > 0, "ModelScope management catalog remains available");
console.log("PASS ModelScope host management contract remains; forwarding protocol belongs to AgentHub_skill/test/modelscope.test.cjs");

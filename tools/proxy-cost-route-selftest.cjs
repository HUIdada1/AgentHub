// 渠道成本感知路由自测（v1.49.0 cost-first / per-key 覆盖 / 无限账号修复）
// 用法：AGENTHUB_DATA_DIR=<临时数据目录> ELECTRON_RUN_AS_NODE=1 electron tools/proxy-cost-route-selftest.cjs [<临时数据目录>]
// （argv 形式兼容两种写法：给了 argv 就按它设置沙箱，等价于环境变量）
// 断言面：store 迁移与回填守卫 / 成本档与路由策略白名单 / cost-first 排序行为 / 无限账号排序 / per-key 覆盖优先级
"use strict";
if (process.argv[2]) process.env.AGENTHUB_DATA_DIR = process.argv[2];
const assert = require("node:assert");
const store = require("../electron/backend/proxy/store.cjs");
const server = require("../electron/backend/proxy/server.cjs");

let pass = 0;
function ok(name, cond) {
  if (!cond) throw new Error(`FAIL: ${name}`);
  pass++;
  console.log(`  ok ${name}`);
}

// ===== 1. store 迁移与回填 =====
console.log("1. 迁移与回填");
store.open();
// 新列存在性：直接靠行为验证（listAgents 带 costTier / key 带 routeOrder）
const agents = store.listAgents();
ok("agents 视图带 costTier 字段", agents.every((a) => "costTier" in a));
const ms = agents.find((a) => a.id === "modelscope");
const lb = agents.find((a) => a.id === "lobster");
const tr = agents.find((a) => a.id === "trae");
ok("modelscope 回填 free", ms && ms.costTier === "free");
ok("lobster 回填 low", lb && lb.costTier === "low");
ok("未标注渠道 costTier 为空串（按 normal 解释）", tr && tr.costTier === "");

// 回填守卫：用户手动改过的档位不回被覆盖（再次触发迁移路径 = 重开库）
ok("setAgentCostTier 生效", store.setAgentCostTier("modelscope", "normal"));
store.close();
store.open();
ok("手动改档后重开库不被种子回填覆盖", (store.listAgents().find((a) => a.id === "modelscope") || {}).costTier === "normal");

// ===== 2. 白名单 =====
console.log("2. 白名单");
ok("setAgentCostTier 拒绝非法档", store.setAgentCostTier("modelscope", "paid") === false);
ok("setAgentCostTier 拒绝空串", store.setAgentCostTier("modelscope", "") === false);
store.setAgentCostTier("modelscope", "free"); // 恢复
const k = store.createKey({ name: "t", route: "auto", routeOrder: "bogus", dailyQuota: 0, rateLimit: 0 });
ok("createKey 非法 routeOrder 落空串（跟随全局）", store.listKeys().find((x) => x.id === k.id).routeOrder === "");
ok("updateKey 合法 routeOrder 生效", store.updateKey(k.id, { routeOrder: "cost-first" }) && store.listKeys().find((x) => x.id === k.id).routeOrder === "cost-first");
ok("updateKey 非法 routeOrder 不落库", store.updateKey(k.id, { routeOrder: "hack" }) && store.listKeys().find((x) => x.id === k.id).routeOrder === "cost-first");
const k2 = store.createKey({ name: "t2", route: "auto", routeOrder: "score", dailyQuota: 0, rateLimit: 0 });
ok("findKeyBySecret 透传 routeOrder", store.findKeyBySecret(store.listKeys().find((x) => x.id === k2.id).secret).routeOrder === "score");

// ===== 3. 排序行为 =====
console.log("3. 排序行为");
// 造号：modelscope（free）余额 5；zcode（normal）余额 9999；lobster（low）余额 100
// 注意 addAccount 后要 creditsAt>0 才算「查过余额」（pickAccount 语义），poolSummary 只看 status/credits
function mkAcc(channel, credits) {
  const id = store.addAccount({ channel, name: `${channel}-${credits}`, token: "x" });
  store.updateAccount(id, { credits, creditsAt: Date.now(), status: "online" });
  return id;
}
const ids = [mkAcc("modelscope", 5), mkAcc("zcode", 9999), mkAcc("lobster", 100), mkAcc("zcode", -1)];
const groups = server.tierGroups();
ok("tierGroups：modelscope→0", groups.get("modelscope") === 0);
ok("tierGroups：lobster→1", groups.get("lobster") === 1);
ok("tierGroups：zcode→2", groups.get("zcode") === 2);

const { cmpByOrder, routeOrderOf, pickByOrder, costFirstScore, channelScore } = server;
// score 档 = 现状：纯按 channelScore 降序
const scoreOrder = ["modelscope", "zcode", "lobster"].sort(cmpByOrder("score", groups));
ok("score 档按余额降序（zcode 9999 第一）", scoreOrder[0] === "zcode");
// cost-first 档：免费渠道排最前，即便余额只有 5
const costOrder = ["modelscope", "zcode", "lobster"].sort(cmpByOrder("cost-first", groups));
ok("cost-first 档免费渠道第一（余额 5 < 9999 仍优先）", costOrder[0] === "modelscope");
ok("cost-first 档低成本第二", costOrder[1] === "lobster");
ok("cost-first 档普通渠道最后", costOrder[2] === "zcode");
// 无限账号修复：仅 cost-first 组内生效
ok("costFirstScore：无限账号渠道按超大余额", costFirstScore("zcode") > 1e12);
ok("channelScore（现状口径）：含无限账号渠道仍按 totalCredits 记分", channelScore("zcode") === 1 + 9999);
// 纯无限账号渠道（只有 -1 号）：现状 totalCredits=0 打分垫底（1 分），cost-first 修复
const pureId = mkAcc("trae", -1);
ok("现状口径：纯无限账号渠道打分恒 1（缺陷现场）", channelScore("trae") === 1);
ok("cost-first：纯无限账号渠道按超大余额参与", costFirstScore("trae") > 1e12);
// 同组（normal）内对照：trae 纯无限 vs qoder 有限余额 5000 —— 修复后同组第一（现状口径垫底）
const qoderId = mkAcc("qoder", 5000);
const sameGroup = ["trae", "qoder"].sort(cmpByOrder("cost-first", groups));
ok("同组内无限账号渠道排前（仅 cost-first 生效）", sameGroup[0] === "trae");
const scoreSame = ["trae", "qoder"].sort(cmpByOrder("score", groups));
ok("score 档无此修复：纯无限渠道仍垫底（保持现状）", scoreSame[scoreSame.length - 1] === "trae");

// ===== 4. per-key 覆盖 =====
console.log("4. per-key 覆盖");
ok("缺省 = score", routeOrderOf({}, {}) === "score");
ok("全局 cost-first 生效", routeOrderOf({}, { routeOrder: "cost-first" }) === "cost-first");
ok("key 覆盖优先于全局", routeOrderOf({ routeOrder: "score" }, { routeOrder: "cost-first" }) === "score");
ok("key 空串回落全局", routeOrderOf({ routeOrder: "" }, { routeOrder: "cost-first" }) === "cost-first");
ok("pickByOrder 取排序首", pickByOrder("cost-first", ["zcode", "modelscope"], groups) === "modelscope");

// ===== 清理 =====
for (const id of [...ids, pureId, qoderId]) store.removeAccount(id);
store.deleteKey(k.id);
store.deleteKey(k2.id);
store.setAgentCostTier("modelscope", "free");

console.log(`COST-ROUTE SELFTEST OK（${pass} 项）`);

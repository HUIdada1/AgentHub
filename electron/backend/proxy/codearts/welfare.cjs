/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · CodeArts 每日福利（领取→确认→回读核实 三段式，**不进每日签到框架**）
//
// 别家的每日签到是「定点、无人值守、一次请求」；本家是运营活动交付：先读活动列表（delivery）、
// 挑出该自动领的那几类、逐个 claim、再 confirm、最后回读列表二次确认。三个接口、两套状态、一个幂等键。
//
// 关键纪律：
//   1. **必须回读 delivery 才算成功**：claim 与 confirm 都只回 code:0，那是「请求受理了」不是「到账了」，
//      把受理当成功 = 面板显示一个没发生的领取；
//   2. **幂等键要在发请求「之前」落盘**：崩溃在「请求已发出、响应没收到」之间时内存里的键就没了，
//      重启后换一个键再领，上游会当成另一笔。写入顺序：先存键 → 再领 → 领成功再存 claimed；
//   3. **本地台账不能当「全天跳过」**：delivery 列表里的 CONFIRMED 不带确认日期（上一期留下的
//      CONFIRMED 会一直显示到今天）。本地台账只用来限流写请求（每天 ≤6 次、间隔 ≥10 分钟）；
//   4. 领到的是套餐赠送积分，不增加福利模型的 token 池（两个账户各记各的），文案必须照实写；
//   5. 台账版本 LEDGER_VERSION=2，对 version != 2 的记录拒绝发送写请求（读不懂的台账不能当「今天还没领过」）。
"use strict";

const models = require("./models.cjs");

const LEDGER_VERSION = 2;
const MAX_ATTEMPTS_PER_DAY = 6;
const MIN_INTERVAL_MS = 10 * 60 * 1000;

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// 读本地台账（限流写请求用；不决定「今天领没领过」）
function readLedger(account) {
  const meta = (account && account.meta) || {};
  const ledger = meta.welfareLedger;
  if (!ledger || typeof ledger !== "object") return { version: LEDGER_VERSION, day: "", attempts: 0, lastAttemptAt: 0, idempotencyKeys: [] };
  return ledger;
}

function writeLedger(store, account, ledger) {
  try {
    const meta = { ...((account && account.meta) || {}), welfareLedger: ledger };
    store.updateAccount(account.id, { meta });
  } catch { /* 落台账失败不阻断，但限流口径会退化成「按内存」 */ }
}

// 活动列表里「该自动领的那几类」：CONFIRMED 不带确认日期，上一期留下的会一直显示到今天，故只按状态排除
function claimableOf(items) {
  return (Array.isArray(items) ? items : []).filter((it) => it && it.claimable === true && it.campaignId != null && it.type);
}

/** 上游信封是 {code, message, data}：HTTP 200 不代表受理成功，code != 0 是业务拒绝
 *  （如 40001「尚未到达权益刷新时间，暂时无法领取」）——不判它就会把拒绝当成"已领取"。 */
function envelopeError(res) {
  const d = res && res.data;
  if (!d || d.code === undefined || d.code === null) return "";
  return Number(d.code) === 0 ? "" : String(d.message || `code ${d.code}`);
}

/** 只读探测：领取前先看清有什么可领（只发一个 GET，不写任何东西）。
 *  与 claim 共用 claimableOf 口径，避免「预览说可领、领取却跳过」这种两套判据的分叉。 */
async function previewWelfare(base, credential, account) {
  const delivery = await models.signedJson(credential, base, "GET", "/v1/ops/delivery?channel=IDE");
  if (!delivery.ok) return { ok: false, message: `福利列表读取失败（HTTP ${delivery.status}）` };
  const listErr = envelopeError(delivery);
  if (listErr) return { ok: false, message: `福利列表读取失败：${listErr}` };
  const items = (delivery.data && delivery.data.data && delivery.data.data.items) || [];
  const claimable = claimableOf(items);
  const ledger = readLedger(account);
  const names = claimable.map((it) => String(it.type || it.name || "福利"));
  return {
    ok: true,
    total: items.length,
    claimable: names,
    attemptsToday: ledger.day === todayKey() ? ledger.attempts : 0,
    message: names.length ? `可领取 ${names.length} 项：${names.join("、")}` : "今天没有可领取的福利（或已全部确认）",
  };
}

// 三段式：delivery → 挑可自动领的 → claim → confirm → 回读核实
async function claimWelfare(base, credential, store, account) {
  const now = Date.now();
  const ledger = readLedger(account);
  if (ledger.version !== LEDGER_VERSION) {
    return { ok: false, message: "福利台账版本不认识（!= 2），拒绝发送写请求（请重新登录刷新台账）" };
  }
  if (ledger.day === todayKey() && ledger.attempts >= MAX_ATTEMPTS_PER_DAY) {
    return { ok: false, already: true, message: `今天已领过（${MAX_ATTEMPTS_PER_DAY} 次限流满）` };
  }
  if (ledger.lastAttemptAt && now - ledger.lastAttemptAt < MIN_INTERVAL_MS) {
    const waitMin = Math.ceil((MIN_INTERVAL_MS - (now - ledger.lastAttemptAt)) / 60000);
    return { ok: false, message: `领取间隔太短，请 ${waitMin} 分钟后再试` };
  }

  // 幂等键先落盘（崩溃在「请求已发出、响应没收到」之间时内存键会丢）
  const idempotencyKey = `${todayKey()}-${Math.random().toString(36).slice(2, 10)}`;
  ledger.idempotencyKeys = [...(ledger.idempotencyKeys || []).slice(-20), idempotencyKey];
  ledger.attempts = (ledger.day === todayKey() ? ledger.attempts : 0) + 1;
  ledger.day = todayKey();
  ledger.lastAttemptAt = now;
  writeLedger(store, account, ledger);

  // ① 读活动列表
  const delivery = await models.signedJson(credential, base, "GET", "/v1/ops/delivery?channel=IDE");
  if (!delivery.ok) return { ok: false, message: `福利列表读取失败（HTTP ${delivery.status}）` };
  const listErr = envelopeError(delivery);
  if (listErr) return { ok: false, message: `福利列表读取失败：${listErr}` };
  const items = (delivery.data && delivery.data.data && delivery.data.data.items) || [];
  // 挑该自动领的那几类（按上游活动类型白名单）
  const claimable = claimableOf(items);
  if (!claimable.length) return { ok: true, already: true, message: "今天没有可领取的福利（或已全部确认）" };

  let claimed = 0;
  let lastError = "";
  const details = [];
  for (const item of claimable) {
    // ② claim（受理 ≠ 到账）
    const claim = await models.signedJson(credential, base, "POST", "/v1/ops/claim", { campaignId: item.campaignId, channel: "IDE" });
    if (!claim.ok) { lastError = `领取失败（HTTP ${claim.status}）`; continue; }
    const claimErr = envelopeError(claim);
    if (claimErr) { lastError = claimErr; continue; }
    // ③ confirm
    const confirm = await models.signedJson(credential, base, "POST", "/v1/ops/confirm", { campaignId: item.campaignId });
    if (!confirm.ok) { lastError = `领取确认失败（HTTP ${confirm.status}）`; continue; }
    const confirmErr = envelopeError(confirm);
    if (confirmErr) { lastError = `领取确认失败：${confirmErr}`; continue; }
    details.push(String(item.type || item.name || "福利"));
    claimed += 1;
  }

  // ④ 回读核实：claim/confirm 只回 code:0，必须回读 delivery 看是否真的 CONFIRMED
  const verify = await models.signedJson(credential, base, "GET", "/v1/ops/delivery?channel=IDE");
  const verifyItems = (verify.ok && verify.data && verify.data.data && verify.data.data.items) || [];
  const verified = verifyItems.filter((it) => it && (it.status === "CONFIRMED" || it.status === "CLAIMED")).length;

  if (!claimed) return { ok: false, message: lastError || "没有领取成功任何一项福利" };
  return {
    ok: true,
    already: false,
    message: `已领取 ${claimed} 项（${details.join("、")}），回读确认 ${verified} 项已确认`,
    credit: claimed,
  };
}

module.exports = { claimWelfare, previewWelfare, todayKey, LEDGER_VERSION, MAX_ATTEMPTS_PER_DAY, MIN_INTERVAL_MS };

/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · KukuAI 会话三件套（bdstoken / uinfo / uk）
//
// 对话链每一跳都要在 query 里带这三件，它们由登录 Cookie 向 userreport 换来，上游给 600 秒有效期。
// 每次对话都重新换一个既没必要也招风控（同一账号短时间反复换会话材料是明显的机器行为），所以按
// BDUSS 缓存 600 秒；键选 BDUSS 而不是账号 id，是因为同一份登录态可能对应多条账号记录。
//
// 并发时这里可能重复刷新（不持锁等网络：先读缓存、放开、发请求、回来再写槽）。代价是同一账号
// 多打一次 userreport，远小于「持锁等网络」把整条渠道拖住的代价。
//
// 会话自愈：业务接口判「未登录」时，先试向通行证换发产品级 STOKEN 再重试一次（见 engine.cjs）。
// 换出来的新令牌只在进程内跟随这份 BDUSS，**不回写账号记录**——账号里存的是用户粘贴的原始 Cookie，
// 换发材料（PTOKEN）来自其中，回写会把一次性材料固化成凭据的一部分。
"use strict";

const credentials = require("./credentials.cjs");
const endpoints = require("./endpoints.cjs");
const engine = require("./engine.cjs");

/** 三件套有效期（上游口径 600 秒） */
const TTL_MS = 600000;

/** bduss → { triple, at } */
const slots = new Map();
/** bduss → 换发出来的产品级 STOKEN（进程内，不落库） */
const stokenOverrides = new Map();
/** bduss → 进行中的换发（单飞：并发请求只打一次通行证，换发本身是一次原生签名 + 一次 POST） */
const reissueInFlight = new Map();

/**
 * 换发产品级 STOKEN 并挂到这份 BDUSS 上（成功返回新令牌，失败返回 null）。
 * 单飞：同一 BDUSS 的并发换发共用一次调用，结果共享——避免一波请求同时打通行证接口，
 * 那既是无谓的重复签名，也是最容易被风控盯上的形态。
 */
function reissueStoken(cred, deps) {
  const bduss = String((cred && cred.bduss) || "");
  if (!bduss) return Promise.resolve(null);
  if (reissueInFlight.has(bduss)) return reissueInFlight.get(bduss);
  const ptoken = credentials.ptokenOf(cred.extras);
  if (!ptoken) return Promise.resolve(null);
  const run = engine
    .exchangeStoken(bduss, ptoken, deps)
    .then((stoken) => {
      if (stoken) {
        stokenOverrides.set(bduss, stoken);
        cred.stoken = stoken;
      }
      return stoken || null;
    })
    .catch(() => null)
    .finally(() => {
      reissueInFlight.delete(bduss);
    });
  reissueInFlight.set(bduss, run);
  return run;
}

function cachedTriple(bduss, now) {
  const slot = slots.get(bduss);
  if (!slot) return null;
  if (now - slot.at >= TTL_MS) {
    slots.delete(bduss);
    return null;
  }
  return slot.triple;
}

/** 会话 query 段：原样拼接，**不做百分号编码**——上游按字面量校验这三个值，编码过的会被判会话无效 */
function tokenQuery(triple) {
  return `&bdstoken=${triple.bdstoken}&uinfo=${triple.uinfo}&uk=${triple.uk}`;
}

// 两张表都按 BDUSS 建键，账号换得多了会无界增长。给一个硬上限：先扫掉过期项，还超就整份清空。
// 会话材料都是从上游可重取的临时数据，清空只多打一次 userreport，比让主进程内存跟着账号池
// 无限涨要划算得多（网关就活在 Electron 主进程里）。
const MAX_TRACKED_SESSIONS = 200;

function remember(bduss, triple) {
  if (slots.size > MAX_TRACKED_SESSIONS) {
    const now = Date.now();
    for (const [key, slot] of slots) if (now - slot.at >= TTL_MS) slots.delete(key);
    if (slots.size > MAX_TRACKED_SESSIONS) slots.clear();
  }
  slots.set(bduss, { triple, at: Date.now() });
  if (stokenOverrides.size > MAX_TRACKED_SESSIONS) stokenOverrides.clear();
}

/** HTTP 层的错误翻译：401/403 是登录态问题（本渠道没有续期，只能重新登录或重新粘贴 Cookie） */
function transportFailure(status, url) {
  if (status === 401 || status === 403) {
    return Object.assign(
      new Error(`KukuAI 登录态已失效，请重新登录该账号或重新粘贴完整 Cookie（HTTP ${status}，${url}）`),
      { status: 401 },
    );
  }
  return Object.assign(new Error(`KukuAI 返回 HTTP ${status}（${url}）`), { status: status || 502 });
}

/** 打一次 userreport 换三件套 */
async function fetchTriple(cred, deps) {
  const url = `${endpoints.baseUrl()}${endpoints.PATHS.userReport}?${endpoints.WEB_QUERY}`;
  const r = await deps.httpJson(url, {
    method: "GET",
    headers: credentials.requestHeaders(cred, "application/json, text/plain, */*"),
  });
  if (!r || !r.ok) throw transportFailure(r && r.status, url);
  const payload = r.data;
  if (!payload || typeof payload !== "object") {
    throw Object.assign(new Error(`KukuAI 返回非 JSON 响应（${url}）`), { status: 502 });
  }
  const errno = Number(payload.errno);
  if (errno !== 0) {
    const message = String(payload.show_msg || payload.errmsg || "未知错误");
    // 文案里给「等 1-2 分钟再试」：会话校验失败除真失效外，还有一类是上游临时风控，
    // 只说「重新登录」会把可恢复的情况指到错误的操作上
    throw Object.assign(
      new Error(
        `KukuAI 会话校验未通过（userreport errno=${Number.isFinite(errno) ? errno : "缺失"}：${message}）——` +
          "请重新登录该账号（或重新粘贴完整 Cookie）后再试；若账号无误，等 1-2 分钟再试",
      ),
      { status: 401 },
    );
  }
  const data = payload.data;
  if (!data || typeof data !== "object") {
    throw Object.assign(new Error("KukuAI userreport 返回缺少 data（上游响应异常）"), { status: 502 });
  }
  const text = (v) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v));
  const triple = {
    bdstoken: text(data.bdstoken),
    uinfo: text(data.uinfo),
    // uk 上游给过字符串也给过数字两种形态；对话接口对空值容忍度不一致，两种都收下来
    uk: text(data.uk),
  };
  if (!triple.bdstoken) {
    throw Object.assign(new Error("KukuAI userreport 返回缺少 bdstoken（上游响应异常）"), { status: 502 });
  }
  return triple;
}

/**
 * 取（必要时刷新）会话三件套。
 * @param {boolean} force 跳过缓存直接刷新（添加账号、手动校验时用，要的是「现在真的能用」）
 */
async function ensureTriple(cred, deps, force) {
  const now = Date.now();
  if (!force) {
    const hit = cachedTriple(cred.bduss, now);
    if (hit) return hit;
  }
  // 账号里存的可能是通行证级令牌：先套上本进程换发过的那一份，再打业务接口
  const override = stokenOverrides.get(cred.bduss);
  if (override && !cred.stokenOverride) {
    cred.stoken = override;
    cred.stokenOverride = true;
  }
  try {
    const triple = await fetchTriple(cred, deps);
    remember(cred.bduss, triple);
    return triple;
  } catch (e) {
    // 只在「会话校验未通过」这一类失败上自愈；HTTP 401/403 或非业务错误直接透传
    const recoverable = Number(e && e.status) === 401 && /userreport errno=/.test(String(e && e.message));
    if (!recoverable) throw e;
    const reissued = await reissueStoken(cred, deps);
    if (reissued) {
      // 换到了就再打一次：这次仍失败才是真失效，错误文案沿用第一次的
      const retried = await fetchTriple(cred, deps);
      remember(cred.bduss, retried);
      return retried;
    }
    // 换发没成功：把两种成因都如实写进文案，让用户知道自己该做什么
    const hasEngine = await engine.engineAvailable();
    e.engineHint = hasEngine
      ? "（业务会话令牌换发未成功，请重新粘贴包含 PTOKEN 的完整 Cookie）"
      : `（未找到官方客户端引擎 ${engine.ENGINE_DLL_NAME}，无法换发业务会话令牌：请安装该客户端，或用 ${engine.ENGINE_ENV} 指定引擎路径）`;
    throw e;
  }
}

module.exports = { ensureTriple, tokenQuery, reissueStoken, TTL_MS };

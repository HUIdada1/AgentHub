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
// 反代网关 · MonkeyCode 建任务材料发现
//
// 建任务必须带镜像 id（任务容器的 VM 镜像 UUID），而它不属于登录态：上游只在「这个账号跑过任务」
// 之后的任务列表里把它回吐出来。号池的账号编辑面上没有给这个字段留输入位，所以取它的唯一出路是
// 转发时顺手发现一次并落到账号元数据里——这也是本渠道第一次用起来的实际顺序：
// 先在官网跑一个任务，再来号池里发请求。
//
// 发现失败不是错误：拿不到就按「缺镜像 id」如实回 400 并说清怎么补，绝不拿空值去建任务碰运气
// （空值上游回的是模型/镜像不存在 404，会把用户引到完全错误的排查方向上）。
"use strict";

const endpoints = require("./endpoints.cjs");
const regionStore = require("./region.cjs");
const models = require("./models.cjs");

/** 从最近的任务列表里取第一个非空 image.id */
function firstImageId(payload) {
  const data = (payload && payload.data) || payload || {};
  const rows = Array.isArray(data.tasks) ? data.tasks : Array.isArray(payload && payload.tasks) ? payload.tasks : [];
  for (const row of rows) {
    const value = row && row.image && row.image.id;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * 查一次「最近任务」以发现镜像 id。
 * @returns {Promise<string>} 空串 = 没发现（新号还没跑过任务，或上游结构变了）
 */
async function discoverImageId(deps, region, section, session) {
  if (!region || !String(session || "").trim()) return "";
  const base = regionStore.baseUrl(region, section);
  try {
    const payload = await models.requestJson(
      deps,
      `${base}${endpoints.TASKS_PATH}${endpoints.TASKS_DISCOVER_QUERY}`,
      session,
      section,
      region,
      "任务列表查询",
    );
    return firstImageId(payload);
  } catch (e) {
    deps.verbose && deps.verbose(`镜像 id 发现失败（不阻断）：${e.message}`);
    return "";
  }
}

module.exports = { discoverImageId, firstImageId };

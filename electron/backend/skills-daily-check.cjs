/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-13
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 技能仓库 · 每日全自动健康检测与流程优化引擎
// 自动巡检各渠道目录连通性、新安装技能感知、失效 Junction 挂载检测、未登记孤儿检测与自动修复
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const config = require("./config.cjs");
const syncer = require("./syncer.cjs");
const adapter = require("./adapter.cjs");
const hub = require("./hub.cjs");

function stateFile() {
  return path.join(config.dataDir(), "skills-daily-check.json");
}

function loadDailyCheckStatus() {
  try {
    const f = stateFile();
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, "utf8"));
      return data;
    }
  } catch {
    /* 忽略读取错误 */
  }
  return {
    checkedAt: 0,
    ok: true,
    totalTargets: 0,
    activeTargets: 0,
    skillCount: 0,
    brokenMounts: 0,
    repairedMounts: 0,
    orphans: 0,
    conflicts: 0,
    summary: "尚未执行全自动检测，点击「立即全盘检测」开始。",
    channelDetails: [],
  };
}

function saveDailyCheckStatus(st) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(st, null, 2), "utf8");
  } catch {
    /* 忽略写入错误 */
  }
}

/**
 * 运行每日健康检测
 * @param {object} [cfg] 应用配置
 * @param {object} [opts] 参数（如 autoMount 强制开关）
 */
function runDailyCheck(cfg, opts = {}) {
  const c = cfg || config.loadConfig();
  const autoRepair = opts.autoMount !== undefined ? !!opts.autoMount : (c.schedule?.dailyCheckAutoMount !== false);

  // 1. 运行全局调查
  const survey = syncer.survey(c);
  const targets = adapter.resolveScanTargets(c);
  const allToolList = adapter.listTools(c);

  // 2. 统计各工具健康与连通状态
  const activeTargets = targets.length;
  const channelDetails = allToolList.map((t) => ({
    id: t.id,
    name: t.name,
    enabled: t.enabled,
    hit: !!t.dir,
    dir: t.dir || "",
    skillCount: (survey.scanned?.targets?.find((x) => x.id === t.id)?.skillCount) || 0,
  }));

  // 3. 统计失效挂载与孤儿
  const brokenList = (survey.mountHealth || []).filter((m) => !m.valid);
  const brokenMounts = brokenList.length;
  const orphans = (survey.orphans || []).length;
  const conflicts = syncer.loadConflicts().items.filter((x) => !x.resolved).length;
  const hubExtra = (survey.hubExtra || []).length;
  const totalSkills = Object.keys(survey.manifest?.skills || {}).length;

  // 4. 自动修复挂载（若开启自动修复且存在失效）
  let repairedMounts = 0;
  if (autoRepair && brokenMounts > 0) {
    try {
      const rep = syncer.repairMounts(c);
      repairedMounts = rep?.repaired || 0;
    } catch {
      /* 修复失败静默记录 */
    }
  }

  // 5. 组合报告摘要
  const issues = [];
  if (brokenMounts > 0) {
    issues.push(`${brokenMounts} 处失效挂载${repairedMounts ? `（已自动修复 ${repairedMounts} 处）` : ""}`);
  }
  if (orphans > 0) issues.push(`${orphans} 个未收纳新技能`);
  if (conflicts > 0) issues.push(`${conflicts} 个冲突待裁决`);
  if (hubExtra > 0) issues.push(`${hubExtra} 个中央未登记项`);

  let summary = "";
  if (issues.length === 0) {
    summary = `全渠道健康：已检测 ${activeTargets}/${allToolList.length} 个渠道目录，共管理 ${totalSkills} 个技能，连接状态良好。`;
  } else {
    summary = `检测发现：${issues.join("，")}。`;
  }

  const result = {
    checkedAt: Date.now(),
    ok: issues.length === 0,
    totalTargets: allToolList.length,
    activeTargets,
    skillCount: totalSkills,
    brokenMounts,
    repairedMounts,
    orphans,
    conflicts,
    hubExtra,
    summary,
    channelDetails,
  };

  saveDailyCheckStatus(result);
  return result;
}

module.exports = {
  loadDailyCheckStatus,
  saveDailyCheckStatus,
  runDailyCheck,
};

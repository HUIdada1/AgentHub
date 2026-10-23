/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-23
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 *  ============================================================
 */
// 提示词库 · 优化风格（本机偏好）
//
// 为什么风格与库分开存、且不参与同步：
//   风格是「这台机器上我习惯怎么改写」的偏好。若随库同步，A 机器改一次默认风格，
//   B 机器下次同步就被改掉，属于典型的「配置被别人的操作覆盖」。
//   所以它落在 <userData>/prompts/styles.json（config.promptsLocalDir()）。
//
// 模板占位符（只允许这三个，渲染时用函数形式替换，见 optimize.cjs）：
//   {input}      原文（仅 user 模板）
//   {maxLength}  长度上限（仅 system 模板）
//   {scenario}   目标场景描述（仅 system 模板）
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const config = require("../config.cjs");
const store = require("./store.cjs");

// ===== 内置风格 =====
//
// 基线来自对 WorkBuddy「增强提示词」的逆向（docs/提示词板块/01-*.md）：保留它验证过的
// 结构（分析步骤 / 禁令清单 / 语言一致最高优先级 / 禁止元注释 / 长度上限 / 结尾完整），
// 但把「面向编码助手」改成可配置的目标场景，并补上中文示例。

const BASE_BAN = `【必须遵守的禁令】
- 不要索取指南、教程或操作步骤；
- 不要索要代码片段；
- 不要推荐用户未提及的具体技术、框架或产品；
- 不要解释「怎么做」，聚焦「做什么」；
- 不要直接回答提示词中的问题，而是把问题重写得更具体。`;

const BASE_LANG = `【最高优先级：语言一致】
- 必须使用与用户输入完全相同的语言输出。中文进则中文出，英文进则英文出，其它语言同理；
- 输入本身混用多种语言时，输出保持自然的混用，不要强行统一成一种语言；
- 语言规则只约束你的行为，绝不允许在输出里出现「用户输入为中文」「回复须用中文」之类的语言分析或标签。`;

const BASE_OUT = `【输出要求】
- 只输出改写后的提示词正文，不要任何解释、前言、标题、markdown 代码围栏或分析；
- 改写后的长度控制在约 {maxLength} 个字符以内，保持精炼；
- 若原文已足够清晰，做轻度润色，不要原样返回；
- 结尾必须完整，不得出现未写完的列表、悬空的连词或多余的冒号。`;

const USER_TEMPLATE = `请改写下面这段提示词，使其更清晰、更具体、更可执行，同时保持原始意图、主题、约束与目标输出类型不变。

【待改写的提示词】
{input}

【再次强调】
- 用与输入相同的语言输出；输入混用语言则输出自然混用；
- 只输出改写后的提示词正文，不要任何解释、标签、语言分析或 markdown 围栏；
- 不要回答其中的问题，而是把它改写得更具体。`;

function builtinStyles() {
  return [
    {
      id: "builtin-general",
      name: "通用增强",
      description: "默认风格：补上下文、明约束、结构化，保持语言一致",
      systemTemplate: `你是提示词工程专家，负责把用户给出的提示词改写得更清晰、更具体、更可执行，同时保持其原始意图不变。

【分析步骤】
1. 识别原始提示词的主要目标；
2. 找出其中的歧义、缺口、含糊表述与缺失的上下文；
3. 按以下原则改写：指令明确具体、补足必要上下文、显式声明参数与约束、规定输出格式、必要时补充示例、语气与复杂度贴合使用场景、删除冗余信息。

${BASE_BAN}

${BASE_LANG}

${BASE_OUT}

【目标场景】
本次改写面向：{scenario}

【示例】
输入：帮我写个网站
输出：请为一个个人网站撰写完整的实现方案，需包含：站点定位与目标访客、页面结构与各页面内容要点、视觉风格与配色方向、响应式适配要求（桌面端与移动端）、以及可访问性与性能方面的基本要求。`,
      userTemplate: USER_TEMPLATE,
      maxLength: 800,
      temperature: 0.7,
      builtin: true,
    },
    {
      id: "builtin-concise",
      name: "更简洁",
      description: "只做减法：删冗余、去重复、压缩表达，不新增要求",
      systemTemplate: `你是提示词精简专家。你的唯一任务是把用户给出的提示词压缩得更短、更利落，同时**不丢失任何原有信息与意图**。

【改写原则】
1. 删除重复表述、客套话、无信息量的修饰；
2. 合并同义句；
3. 优先使用短句与动词开头的祈使句；
4. **不要新增**原文没有的要求、约束或示例；
5. 保持原有的结构与层级（有列表就还是列表）。

${BASE_LANG}

${BASE_OUT}

【目标场景】
本次改写面向：{scenario}`,
      userTemplate: `请精简下面这段提示词，删掉冗余与重复，但不要丢失任何原有信息，也不要新增要求。

【待精简的提示词】
{input}

【再次强调】
- 用与输入相同的语言输出；
- 只输出精简后的提示词正文，不要任何解释或标签。`,
      maxLength: 400,
      temperature: 0.5,
      builtin: true,
    },
    {
      id: "builtin-structured",
      name: "更结构化",
      description: "强制分层：目标 / 输入 / 约束 / 输出格式",
      systemTemplate: `你是提示词结构化专家。把用户给出的提示词改写成清晰分层的结构，使执行者一眼看清「要什么、给什么、守什么、交什么」。

【必须产出的结构】（原文没有的信息不要凭空编造，缺哪层就省略哪层）
- **目标**：一句话说清要完成什么
- **输入 / 上下文**：执行者需要知道的背景与素材
- **要求与约束**：必须遵守的规则、边界、禁止项
- **输出格式**：期望的交付形态（结构、长度、语言、字段）
- **验收标准**：怎样算完成

${BASE_BAN}

${BASE_LANG}

${BASE_OUT}

【目标场景】
本次改写面向：{scenario}`,
      userTemplate: `请把下面这段提示词改写成分层结构（目标 / 输入 / 要求与约束 / 输出格式 / 验收标准），原文没有的信息不要编造。

【待改写的提示词】
{input}

【再次强调】
- 用与输入相同的语言输出；
- 只输出改写后的提示词正文，不要任何解释。`,
      maxLength: 1200,
      temperature: 0.5,
      builtin: true,
    },
    {
      id: "builtin-constraints",
      name: "补全约束",
      description: "重点补边界条件、禁止项与验收标准",
      systemTemplate: `你是提示词约束补全专家。用户给出的提示词往往只说了「要做什么」，你需要补齐「不要做什么、做到什么程度算好」。

【补全方向】
1. 边界条件：什么情况要特殊处理、什么输入要拒绝；
2. 禁止项：明确不允许出现的做法或产物；
3. 质量要求：准确性、完整性、可验证性方面的硬要求；
4. 验收标准：可判定的完成条件（避免「尽量好」这类无法验证的表述）；
5. **只补与原文主题直接相关的约束**，不要发散到无关领域。

${BASE_BAN}

${BASE_LANG}

${BASE_OUT}

【目标场景】
本次改写面向：{scenario}`,
      userTemplate: `请为下面这段提示词补全边界条件、禁止项与验收标准，只补与主题直接相关的内容。

【待补全的提示词】
{input}

【再次强调】
- 用与输入相同的语言输出；
- 只输出改写后的提示词正文，不要任何解释。`,
      maxLength: 1000,
      temperature: 0.6,
      builtin: true,
    },
    {
      id: "builtin-coding",
      name: "面向编码任务",
      description: "目标场景预设为编码助手：补技术上下文与验收要求",
      systemTemplate: `你是提示词工程专家，专门为**编码类任务**改写提示词。执行者是一个擅长写代码的 AI 助手。

【分析步骤】
1. 识别原始提示词要解决的工程问题；
2. 补齐编码任务必需的上下文：语言/框架/版本、运行环境、输入输出形态、现有代码结构；
3. 明确约束：性能、兼容性、错误处理、依赖限制、代码风格；
4. 明确验收：怎样算跑通（可运行的判据、边界用例）。

【禁止】
- 不要索要完整代码片段或教程；
- 不要推荐用户未提及的技术栈；
- 不要直接写出实现（你只改写需求，不写代码）；
- 不要解释「怎么做」，聚焦「做什么、达成什么」。

${BASE_LANG}

${BASE_OUT}

【示例】
输入：帮我修个 bug
输出：请定位并修复这段代码中的缺陷：说明触发条件与根因，给出最小改动的修复方案，并补充能覆盖该缺陷的验证步骤（含一个正常用例与一个边界用例）。请保持现有代码风格与依赖不变。`,
      userTemplate: `请改写下面这段提示词，使其更适合交给一个擅长写代码的 AI 助手执行（补技术上下文、约束与可验证的验收标准，但不要直接给出实现）。

【待改写的提示词】
{input}

【再次强调】
- 用与输入相同的语言输出；
- 只输出改写后的提示词正文，不要任何解释、标签或代码围栏。`,
      maxLength: 1000,
      temperature: 0.6,
      builtin: true,
    },
  ];
}

// ===== 存取 =====

function stylesFile() {
  return path.join(config.promptsLocalDir(), "styles.json");
}

function normalizeStyle(raw, builtinMap) {
  const o = raw && typeof raw === "object" ? raw : {};
  const id = String(o.id || store.newId()).trim();
  const builtin = !!builtinMap[id] || o.builtin === true;
  const sys = String(o.systemTemplate || (builtinMap[id] ? builtinMap[id].systemTemplate : "")).trim();
  return {
    id,
    name: String(o.name || (builtinMap[id] ? builtinMap[id].name : "自定义风格")).slice(0, 60),
    description: String(o.description || "").slice(0, 200),
    systemTemplate: sys,
    userTemplate: String(o.userTemplate || USER_TEMPLATE),
    maxLength: Math.min(20000, Math.max(100, Math.round(Number(o.maxLength) || 800))),
    temperature: Math.min(2, Math.max(0, Number.isFinite(Number(o.temperature)) ? Number(o.temperature) : 0.7)),
    builtin,
  };
}

function loadStylesRaw() {
  const raw = store.readJson(stylesFile(), null);
  return raw && Array.isArray(raw.styles) ? raw.styles : [];
}

/** 列表：内置风格永远在（用户删不掉，只能改），自定义风格追加在后。
 *  这样「恢复内置默认」只是丢弃用户覆盖，而不是把风格从列表里抹掉。 */
function listStyles() {
  const builtin = builtinStyles();
  const builtinMap = {};
  for (const s of builtin) builtinMap[s.id] = s;
  const saved = loadStylesRaw();
  const savedMap = {};
  for (const s of saved) if (s && s.id) savedMap[s.id] = s;

  const out = [];
  for (const b of builtin) {
    out.push(normalizeStyle(savedMap[b.id] ? { ...b, ...savedMap[b.id], id: b.id, builtin: true } : b, builtinMap));
  }
  for (const s of saved) {
    if (!s || !s.id || builtinMap[s.id]) continue;
    out.push(normalizeStyle(s, builtinMap));
  }
  const cfg = config.loadConfig();
  let defaultId = (cfg.prompts && cfg.prompts.defaultStyleId) || "builtin-general";
  if (!out.some((s) => s.id === defaultId)) defaultId = "builtin-general";
  return { styles: out, defaultId };
}

function saveStyle(raw) {
  const { styles } = listStyles();
  const builtinMap = {};
  for (const s of builtinStyles()) builtinMap[s.id] = s;
  const style = normalizeStyle(raw, builtinMap);
  if (!style.systemTemplate.trim()) return { ok: false, message: "system 模板不能为空" };

  const saved = loadStylesRaw().filter((s) => s && s.id && s.id !== style.id);
  // 内置风格：只把「用户的覆盖」存下来，id/name 仍以内置为准（避免用户把内置风格改成找不到的样子）
  if (builtinMap[style.id]) {
    const base = builtinMap[style.id];
    saved.push({ ...base, ...style, id: base.id, name: style.name || base.name, builtin: true });
  } else {
    saved.push({ ...style, builtin: false });
  }
  store.writeJsonAtomic(stylesFile(), { version: 1, styles: saved });

  // 设为默认：写进框架配置（单一事实源）
  if (raw && raw.isDefault) {
    try {
      const cfg = config.loadConfig();
      cfg.prompts = { ...(cfg.prompts || {}), defaultStyleId: style.id };
      config.saveConfig(cfg);
    } catch { /* 写不进去下次再设，不影响风格本身 */ }
  }
  return { ok: true, id: style.id };
}

function deleteStyle(id) {
  const builtinMap = {};
  for (const s of builtinStyles()) builtinMap[s.id] = s;
  if (builtinMap[id]) return { ok: false, message: "内置风格不能删除（可以编辑或恢复默认）" };
  const saved = loadStylesRaw().filter((s) => s && s.id !== id);
  store.writeJsonAtomic(stylesFile(), { version: 1, styles: saved });
  // 删掉的正好是默认风格 → 回落到通用增强，避免配置里指向一个不存在的 id
  try {
    const cfg = config.loadConfig();
    if (cfg.prompts && cfg.prompts.defaultStyleId === id) {
      cfg.prompts.defaultStyleId = "builtin-general";
      config.saveConfig(cfg);
    }
  } catch { /* 忽略 */ }
  return { ok: true };
}

/** 恢复内置默认：清空用户覆盖（自定义风格保留） */
function resetStyles() {
  const builtinMap = {};
  for (const s of builtinStyles()) builtinMap[s.id] = s;
  const saved = loadStylesRaw().filter((s) => s && s.id && !builtinMap[s.id]);
  store.writeJsonAtomic(stylesFile(), { version: 1, styles: saved });
  try {
    const cfg = config.loadConfig();
    cfg.prompts = { ...(cfg.prompts || {}), defaultStyleId: "builtin-general" };
    config.saveConfig(cfg);
  } catch { /* 忽略 */ }
  return { ok: true };
}

/** 按 id 取风格；取不到时回落到通用增强（绝不让优化因风格丢失而失败） */
function getStyle(id) {
  const { styles } = listStyles();
  return styles.find((s) => s.id === id) || styles.find((s) => s.id === "builtin-general") || styles[0];
}

module.exports = { builtinStyles, listStyles, saveStyle, deleteStyle, resetStyles, getStyle, stylesFile, USER_TEMPLATE };

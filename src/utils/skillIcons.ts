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
// 技能仓库 · 渠道工具图标单一来源（与号池管家保持高度一致）
import traeIcon from "../assets/channels/trae.png";
import workbuddyIcon from "../assets/channels/workbuddy.png";
import raccoonIcon from "../assets/channels/raccoon.png";
import qoderIcon from "../assets/channels/qoder.png";
import zcodeIcon from "../assets/channels/zcode.png";
import catpawIcon from "../assets/channels/catpaw.png";
import autoclawIcon from "../assets/channels/autoclaw.png";
import autoclawIntlIcon from "../assets/channels/autoclaw_intl.png";
import clineFreeIcon from "../assets/channels/cline_free.png";
import clinePassIcon from "../assets/channels/cline_pass.png";
import accioIcon from "../assets/channels/accio.png";
import accioCnIcon from "../assets/channels/accio_cn.png";
import codeartsIcon from "../assets/channels/codearts.png";
import loomyIcon from "../assets/channels/loomy.png";
import kukuIcon from "../assets/channels/kuku.png";
import monkeycodeIcon from "../assets/channels/monkeycode.png";
import minimaxIcon from "../assets/channels/minimax.svg";
// 与号池渠道同一份官方素材（Agent2API providers / 官网 plugin-assets 逐字节同源），
// 不再用本应用 logo 顶替 Antigravity，也不让 QwenWork 借用 Qoder 的图
import qwenworkIcon from "../assets/channels/qwen_office.svg";
import antigravityOfficialIcon from "../assets/channels/antigravity.png";
import modelscopeIcon from "../assets/channels/modelscope.png";
import lobsterIcon from "../assets/channels/lobster.png";
import commandcodeIcon from "../assets/channels/commandcode.png";
import officeaceIcon from "../assets/channels/officeace.png";
import atomcodeIcon from "../assets/channels/atomcode.png";
import orcatermIcon from "../assets/channels/orcaterm.png";
import astudioIcon from "../assets/channels/astudio.png";
import doubaoworkIcon from "../assets/channels/doubaowork.png";
import kiroIcon from "../assets/channels/kiro.svg";

import anthropicIcon from "../assets/providers/anthropic.png";
import openaiIcon from "../assets/providers/openai.png";
import deepseekIcon from "../assets/providers/deepseek.png";

export const SKILL_TOOL_ICONS: Record<string, string> = {
  // 号池管家同款官方渠道图标
  raccoon: raccoonIcon,
  "box-agent": raccoonIcon,
  "office-raccoon": raccoonIcon,
  autoclaw: autoclawIcon,
  autoclaw_intl: autoclawIntlIcon,
  "autoclaw-intl": autoclawIntlIcon,
  qoder: qoderIcon,
  qoder_cn: qoderIcon,
  "qoder-cn": qoderIcon,
  qoder_intl: qoderIcon,
  "qoder-intl": qoderIcon,
  qwen_office: qwenworkIcon,
  qwen_office_intl: qwenworkIcon,
  trae: traeIcon,
  trae_cn: traeIcon,
  "trae-cn": traeIcon,
  workbuddy: workbuddyIcon,
  "workbuddy-ai": workbuddyIcon,
  workbuddy_ai: workbuddyIcon,
  zcode: zcodeIcon,
  zcode_intl: zcodeIcon,
  "zcode-intl": zcodeIcon,
  catpaw: catpawIcon,
  minimax: minimaxIcon,
  loomy: loomyIcon,
  codearts: codeartsIcon,
  kuku: kukuIcon,
  accio: accioIcon,
  accio_cn: accioCnIcon,
  cline_free: clineFreeIcon,
  cline_pass: clinePassIcon,
  monkeycode: monkeycodeIcon,
  monkeycode_intl: monkeycodeIcon,
  modelscope: modelscopeIcon,
  "modelscope-intl": modelscopeIcon,
  lobster: lobsterIcon,
  commandcode: commandcodeIcon,
  officeace: officeaceIcon,
  atomcode: atomcodeIcon,
  orcaterm: orcatermIcon,
  astudio: astudioIcon,
  doubaowork: doubaoworkIcon,
  kiro: kiroIcon,
  // 供应商/CLI 官方图标
  claude: anthropicIcon,
  "claude-code": anthropicIcon,
  anthropic: anthropicIcon,
  codex: openaiIcon,
  "codex-cli": openaiIcon,
  openai: openaiIcon,
  dsh: deepseekIcon,
  deepseek: deepseekIcon,
  antigravity: antigravityOfficialIcon,
  gemini: antigravityOfficialIcon,
};

/** 规范化 toolId 匹配 key */
function normId(id?: string): string {
  return String(id || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]/g, "-");
}

/** 获取工具渠道的位图图标 URL（若无则返回 null） */
export function getToolIconUrl(toolId?: string): string | null {
  if (!toolId) return null;
  const raw = String(toolId).trim().toLowerCase();
  if (SKILL_TOOL_ICONS[raw]) return SKILL_TOOL_ICONS[raw];
  const norm = normId(toolId);
  if (SKILL_TOOL_ICONS[norm]) return SKILL_TOOL_ICONS[norm];
  // 尝试下划线版本
  const under = norm.replace(/-/g, "_");
  if (SKILL_TOOL_ICONS[under]) return SKILL_TOOL_ICONS[under];
  return null;
}

/** 无图标时的首字标识 */
export function getToolInitial(toolId?: string, name?: string): string {
  const display = (name || toolId || "?").trim();
  if (!display) return "?";
  return display.slice(0, 1).toUpperCase();
}

/** 无图标时的 Phosphor 回退图标 */
export function getToolPhosphor(toolId?: string): string {
  const norm = normId(toolId);
  if (norm.includes("cursor") || norm.includes("roo")) return "ph-robot";
  if (norm.includes("code") || norm.includes("windsurf")) return "ph-code";
  if (norm.includes("agent") || norm.includes("custom")) return "ph-folder-open";
  return "ph-terminal-window";
}

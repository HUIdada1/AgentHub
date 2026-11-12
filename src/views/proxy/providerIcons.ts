/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/** 预设渠道图标的单一来源：「自定义提供商」的预设选择弹窗与列表行共用。
 *  键是后端 ProviderPreset.brand，值是按 Vite 规则 import 出来的资源 URL。
 *  没有收录的品牌（如基元律动 tokenrhythm）回落名称首字母徽章 —— 与 channelIcons 同一口径。
 *  openrouter / opencode 素材有深浅两套，这里只用 light 版：本页不做主题切换，
 *  与 views/proxy/channelIcons.ts 的现状保持一致（不在这里另造一套主题机制）。 */
import bigmodelLogo from "../../assets/providers/bigmodel.svg";
import zaiLogo from "../../assets/providers/zai.png";
import kimiLogo from "../../assets/providers/kimi.png";
import minimaxLogo from "../../assets/providers/minimax.png";
import deepseekLogo from "../../assets/providers/deepseek.png";
import bailianLogo from "../../assets/providers/bailian.png";
import mimoLogo from "../../assets/providers/mimo.png";
import tokenhubLogo from "../../assets/providers/tokenhub.png";
import volcengineLogo from "../../assets/providers/volcengine.png";
import stepfunLogo from "../../assets/providers/stepfun.png";
import openaiLogo from "../../assets/providers/openai.png";
import anthropicLogo from "../../assets/providers/anthropic.png";
import xaiLogo from "../../assets/providers/xai.png";
import siliconflowLogo from "../../assets/providers/siliconflow.png";
import openrouterLogo from "../../assets/providers/openrouter-light.svg";
import opencodeLogo from "../../assets/providers/opencode-light.svg";

export const PROVIDER_LOGOS: Record<string, string> = {
  bigmodel: bigmodelLogo,
  zai: zaiLogo,
  kimi: kimiLogo,
  minimax: minimaxLogo,
  deepseek: deepseekLogo,
  bailian: bailianLogo,
  mimo: mimoLogo,
  tokenhub: tokenhubLogo,
  volcengine: volcengineLogo,
  stepfun: stepfunLogo,
  openai: openaiLogo,
  anthropic: anthropicLogo,
  xai: xaiLogo,
  siliconflow: siliconflowLogo,
  openrouter: openrouterLogo,
  opencode: opencodeLogo,
};

/** 未收录的品牌返回空串：调用方据空串回落首字母徽章（不要在这里编造占位图） */
export function providerLogo(brand?: string): string {
  const key = String(brand || "").trim();
  return key ? PROVIDER_LOGOS[key] || "" : "";
}

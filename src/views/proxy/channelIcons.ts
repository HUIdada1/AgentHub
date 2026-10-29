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
/** 渠道图标的单一来源：号池页顶部切换（收起行的小方块）与「上游启闭」弹窗共用。
 *  有图标就用图标（取自各客户端安装目录内嵌的同一张图，与系统里显示的为一致），
 *  没有收录图标的渠道回落名称首字母 —— 收起行只露 logo，无 logo 时首字母就是它的 identity。 */
import { channelName } from "./format";
import traeIcon from "../../assets/channels/trae.png";
import workbuddyIcon from "../../assets/channels/workbuddy.png";
import raccoonIcon from "../../assets/channels/raccoon.png";
import qoderIcon from "../../assets/channels/qoder.png";
import zcodeIcon from "../../assets/channels/zcode.png";
// CatPaw 无官方客户端图标可提取，为自绘（tools/gen-catpaw-icon.cjs 生成，可复现）
import catpawIcon from "../../assets/channels/catpaw.png";
// AutoClaw 双区共用爪印图形，地区角标区分（tools/gen-autoclaw-icon.cjs 生成，可复现）
import autoclawIcon from "../../assets/channels/autoclaw.png";
import autoclawIntlIcon from "../../assets/channels/autoclaw_intl.png";
// Cline 双池共用「终端窗」图形，池角标区分（tools/gen-cline-icon.cjs 生成，可复现）
import clineFreeIcon from "../../assets/channels/cline_free.png";
import clinePassIcon from "../../assets/channels/cline_pass.png";
// Accio（阿里）双区 / CodeArts（华为云）/ Loomy（讯飞）：取自各官方客户端安装目录内嵌的
// 同一张品牌图标（与系统里显示的一致）；三地无自绘脚本可复现，故直接采用官方位图
import accioIcon from "../../assets/channels/accio.png";
import accioCnIcon from "../../assets/channels/accio_cn.png";
import codeartsIcon from "../../assets/channels/codearts.png";
import loomyIcon from "../../assets/channels/loomy.png";
// KukuAI（百度文库）/ MonkeyCode（长亭）：同样取自官方客户端内嵌的品牌图标，与系统显示一致；
// MonkeyCode 双区共用同一张图，靠地区角标区分（与 qoder 双区同款处理）
import kukuIcon from "../../assets/channels/kuku.png";
import monkeycodeIcon from "../../assets/channels/monkeycode.png";

export const CHANNEL_ICONS: Record<string, string> = {
  trae: traeIcon,
  workbuddy: workbuddyIcon,
  workbuddy_ai: workbuddyIcon,
  raccoon: raccoonIcon,
  qoder: qoderIcon,
  qoder_intl: qoderIcon,
  zcode: zcodeIcon,
  catpaw: catpawIcon,
  autoclaw: autoclawIcon,
  autoclaw_intl: autoclawIntlIcon,
  cline_free: clineFreeIcon,
  cline_pass: clinePassIcon,
  accio: accioIcon,
  accio_cn: accioCnIcon,
  codearts: codeartsIcon,
  loomy: loomyIcon,
  kuku: kukuIcon,
  monkeycode: monkeycodeIcon,
  monkeycode_intl: monkeycodeIcon,
};

/** 无图标渠道的字母角标：优先用服务端回的 display（与卡片上显示的名称一致），
 *  缺失再退回静态名表；中文名取首字（如「商汤小浣熊」→「商」），英文名取首字母大写 */
export function channelInitial(id: string, display?: string): string {
  return (display || channelName(id) || id || "?").trim().slice(0, 1).toUpperCase() || "?";
}

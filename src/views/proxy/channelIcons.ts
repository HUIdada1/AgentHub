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
 *  有图标就用图标，没有收录图标的渠道回落名称首字母 —— 收起行只露 logo，无 logo 时首字母就是它的 identity。
 *
 *  图片来源（v1.8x 起统一口径）：全部取自 Agent2API 官方 provider 图标目录
 *  `desktop-tauri/ui/assets/providers/`，与官网插件市场 `agent2api.dev/api/plugins/index.json`
 *  声明的 `plugin-assets/agent2api-wasm-*.png|svg` 逐字节相同（SHA-256 已校验），
 *  因此这里的图形与 Agent2API 本体 / 各插件包里显示的完全一致。
 *  官方对「同一产品的国内版与国际版」「同一产品的两个池」共用同一张图，靠名称区分地区；
 *  本表沿用该口径（不再自绘地区角标，避免与官方显示不一致、也无法随官方更新）。
 *  品牌图形版权归各厂商，仅作渠道识别；素材出处见 assets/providers/SOURCES.md 同一约定。 */
import { channelName } from "./format";
import traeIcon from "../../assets/channels/trae.png";
import workbuddyIcon from "../../assets/channels/workbuddy.png";
import raccoonIcon from "../../assets/channels/raccoon.png";
import modelscopeIcon from "../../assets/channels/modelscope.png";
import lobsterIcon from "../../assets/channels/lobster.png";
import zcodeIcon from "../../assets/channels/zcode.png";
import minimaxIcon from "../../assets/channels/minimax.svg";
import catpawIcon from "../../assets/channels/catpaw.png";
import qoderIcon from "../../assets/channels/qoder.png";
import qwenworkIcon from "../../assets/channels/qwen_office.svg";
import commandcodeIcon from "../../assets/channels/commandcode.png";
import officeaceIcon from "../../assets/channels/officeace.png";
import atomcodeIcon from "../../assets/channels/atomcode.png";
import orcatermIcon from "../../assets/channels/orcaterm.png";
import astudioIcon from "../../assets/channels/astudio.png";
import doubaoworkIcon from "../../assets/channels/doubaowork.png";
import kiroIcon from "../../assets/channels/kiro.svg";
import antigravityIcon from "../../assets/channels/antigravity.png";
import autoclawIcon from "../../assets/channels/autoclaw.png";
import clineIcon from "../../assets/channels/cline_free.png";
import accioIcon from "../../assets/channels/accio.png";
import codeartsIcon from "../../assets/channels/codearts.png";
import loomyIcon from "../../assets/channels/loomy.png";
import kukuIcon from "../../assets/channels/kuku.png";
import monkeycodeIcon from "../../assets/channels/monkeycode.png";

/** 官方同图的双区 / 双池渠道：写成显式别名，读者一眼看出「不是漏配，是官方就这么设计」 */
export const CHANNEL_ICONS: Record<string, string> = {
  trae: traeIcon,
  workbuddy: workbuddyIcon,
  workbuddy_ai: workbuddyIcon,
  raccoon: raccoonIcon,
  modelscope: modelscopeIcon,
  modelscope_intl: modelscopeIcon,
  lobster: lobsterIcon,
  zcode: zcodeIcon,
  zcode_intl: zcodeIcon,
  minimax: minimaxIcon,
  minimax_intl: minimaxIcon,
  catpaw: catpawIcon,
  qoder: qoderIcon,
  qoder_intl: qoderIcon,
  // 千问办公（QwenWork）有官方图形，不再借用 Qoder 的图
  qwen_office: qwenworkIcon,
  qwen_office_intl: qwenworkIcon,
  commandcode: commandcodeIcon,
  officeace: officeaceIcon,
  atomcode: atomcodeIcon,
  orcaterm: orcatermIcon,
  astudio: astudioIcon,
  doubaowork: doubaoworkIcon,
  kiro: kiroIcon,
  antigravity: antigravityIcon,
  autoclaw: autoclawIcon,
  autoclaw_intl: autoclawIcon,
  cline_free: clineIcon,
  cline_pass: clineIcon,
  accio: accioIcon,
  accio_cn: accioIcon,
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

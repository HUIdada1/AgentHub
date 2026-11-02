/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐晖 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · Agent 卡片排序（「Agent 接入」页与「仪表盘·Agent 连接状态」共用同一套口径）。
// 梯队严格对齐卡片徽标（稳定排序，组内保持后端默认序）：
//   ① 真实调用过（桥上报过心跳 beat；含已卸载、配置条目已不在但确实调用过记忆工具的 Agent）
//   ② 已配置未调用（配置文件里仍有 MCP 条目，但从未观察到真实调用）
//   ③ 未配置（既没有条目、也没有调用记录）
// 「通用（~/.agents）」扩展位只要没有真实调用就固定垫底：它是跨工具兜底路径，不该挤掉具体 Agent；
// 若它真的被调用过，仍按①排最前（「有真实调用的排最前」是硬规则）。
// 注意：injected = access.list 组装的 config.ok（配置文件里真的有 MCP 条目）；beat 只在桥真的被
// Agent 调用记忆工具时写入（indexer.beat 无空心跳），所以 beat 非空即「真实调用过」。
import type { MemoryAgentCard } from "../types";

/** 是否「已配置且真实调用过」：卡片标题计数与 KPI 用这一条判据（排序按三态，见 cardRank）。
 *  不用它单独代表「真实调用过」——已卸载但调用过的卡 beat 仍在，只是配置没了。 */
export function isInjectedCalled(a: MemoryAgentCard): boolean {
  return a.injected && !!a.beat;
}

/** 梯队序号：0 真实调用过 / 1 已配置未调用 / 2 未配置 / 3 通用扩展位（无调用时）垫底 */
function cardRank(a: MemoryAgentCard): number {
  if (a.beat) return 0;
  if (a.injected) return 1;
  return a.id === "agents" ? 3 : 2;
}

/** 卡片排序：有真实调用的排最前 → 已配置未调用 → 未配置；「通用（~/.agents）」扩展位无调用时垫底 */
export function sortAgentCards(list: MemoryAgentCard[]): MemoryAgentCard[] {
  return [...list].sort((x, y) => cardRank(x) - cardRank(y));
}

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
// 梯队（稳定排序，组内保持后端默认序）：
//   ① 已接入 且 真实调用过（配置文件里有 MCP 条目，且桥上报过心跳）
//   ② 已接入（条目在，但还没观察到真实调用）
//   ③ 其余（未接入；含卸载后残留的心跳——它不能因此被提到②前面）
// 「通用（~/.agents）」扩展位固定垫底。
// 已接入 = injected（access.list 组装的 config.ok，即配置文件里真的有 MCP 条目）；
// beat 只作「已接入之内的次键」：卸载后心跳历史仍残留，若让 beat 单独提权会把已卸载的卡排到最前。
import type { MemoryAgentCard } from "../types";

/** 是否「已接入且真实调用过」：卡片排序、标题计数、徽标三处共用这一条判据。
 *  beat 只会在桥真的被 Agent 调用记忆工具时写入（indexer.beat 无空心跳），所以 beat 非空即调用过。 */
export function isInjectedCalled(a: MemoryAgentCard): boolean {
  return a.injected && !!a.beat;
}

/** 梯队序号：0 已接入且调用过 / 1 已接入 / 2 其余 / 3 通用扩展位垫底 */
function cardRank(a: MemoryAgentCard): number {
  if (a.id === "agents") return 3;
  if (isInjectedCalled(a)) return 0;
  return a.injected ? 1 : 2;
}

/** 卡片排序：已接入且真实调用过的排最前，其次已接入；「通用（~/.agents）」扩展位固定垫底 */
export function sortAgentCards(list: MemoryAgentCard[]): MemoryAgentCard[] {
  return [...list].sort((x, y) => cardRank(x) - cardRank(y));
}

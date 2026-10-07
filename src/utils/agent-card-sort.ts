/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆中枢 · Agent 卡片排序（「Agent 接入」页与「仪表盘·Agent 连接状态」共用同一套口径）。
// 已接入 = injected（access.list 组装的 config.ok，即配置文件里真的有 MCP 条目）；
// 不用 beat 判——卸载后心跳历史仍残留，会把已卸载的卡误排到前面。
import type { MemoryAgentCard } from "../types";

/** 卡片排序：已接入的排前面，其余保持默认序（稳定排序保组内原序）；「通用（~/.agents）」扩展位固定垫底 */
export function sortAgentCards(list: MemoryAgentCard[]): MemoryAgentCard[] {
  return [...list].sort((x, y) => {
    if (x.id === "agents") return 1;
    if (y.id === "agents") return -1;
    return x.injected === y.injected ? 0 : x.injected ? -1 : 1;
  });
}

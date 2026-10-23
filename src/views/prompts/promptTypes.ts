/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-23
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/**
 * AgentHub · 提示词库（Prompt Library）
 * Copyright (c) 2026 沐晖 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */
// 提示词库 · 类型与 IPC 调用面的 T3 侧收口（事实源：docs/提示词板块/02-实施契约.md §3 / §4）
//
// 为什么这里还要写一份「镜像」而不是直接 import：
//   契约 §3 的类型与 §4 的 IPC 封装由 T2（frontend-shell）写入 src/types/index.ts 与 src/api/ipc.ts，
//   而 T3（本文件所属的页面层）与 T2 是并行开发的。若页面直接 import 尚未落地的导出，
//   vue-tsc 会立刻报错（本项目基线 0 错，交付要求是「不得增加」）。
//   于是把「类型 + 调用面」收口在这一个文件：
//     · 字段名 / 通道名 / 入参 / 返回严格照契约，一字不改、不增不减；
//     · 页面一律 import 本文件，T2 落地后只需把这里的两处 import 换成 ../../types 与直接调用即可，
//       页面代码零改动（这也是为什么不让每个页面各自去取 api 属性）。
//   注意：本文件不新增任何后端通道，也不做任何二次包装——它只是「按契约函数名取用」的类型收口。
import * as api from "../../api/ipc";

// ===== 契约 §3：数据模型 =====

export type PromptVariable = { name: string; label?: string; def?: string; required?: boolean };

export type PromptVersion = { version: number; body: string; at: number; note?: string; by?: "user" | "sync-merge" };

export type PromptItem = {
  id: string;
  name: string;
  description: string;
  body: string;
  variables: PromptVariable[];
  category: string;
  tags: string[];
  source: "local" | "optimized" | "online" | "imported";
  originRef?: string;
  originMeta?: { author?: string; license?: string; url?: string; version?: string };
  lineage?: { parentHash?: string; styleId?: string; model?: string; inputText?: string };
  version: number;
  versions: PromptVersion[];
  favorite: boolean;
  pinned?: boolean;
  useCount: number;
  lastUsedAt: number;
  hash: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
};

export type PromptStyle = {
  id: string; name: string; description: string;
  systemTemplate: string; userTemplate?: string;
  maxLength?: number; temperature?: number;
  builtin: boolean; isDefault?: boolean;
};

export type PromptHistoryItem = {
  id: string; at: number;
  styleId: string; styleName: string; model: string;
  inputText: string; outputText: string;
  inputTruncated?: boolean; outputTruncated?: boolean;
  elapsedMs: number;
  tokens?: { in: number; out: number };
  savedToLibrary?: string;
  applied?: boolean;
  error?: string;
};

export type PromptSyncStatus = {
  running: boolean; configured: boolean;
  stage: "idle" | "connect" | "pull" | "merge" | "push" | "done" | "cancelled" | "error";
  stageLabel: string; detail: string; pct?: number;
  lastSyncAt: number; lastError: string;
  autoMerged: number; pendingConflicts: number;
};

export type PromptConflict = {
  id: string; kind: "content" | "delete" | "remote";
  name: string; title: string; detail: string;
  autoMerged: boolean; strategy?: string;
  kept?: "local" | "remote"; discardedAt?: number;
  localHash?: string; remoteHash?: string;
  at: number; resolved?: { at: number; choice: string };
};

export type PromptConflictDiff = {
  item: PromptConflict;
  left: { label: string; body: string; updatedAt: number };
  right: { label: string; body: string; updatedAt: number };
};

export type PromptStats = {
  total: number; today: number; week: number; optimized: number;
  favorited: number; trash: number; conflicts: number; lastSyncAt: number;
};

/** 契约 §2 的 prompts 配置段（框架 config.json）；配置页按它读写 app.config.prompts */
export type PromptsConfig = {
  syncAuto: boolean;
  syncIntervalHours: number;
  mergeStrategy: "newer-wins" | "local-wins" | "remote-wins" | "longer-wins" | "manual";
  onDeleteConflict: "tombstone" | "keep-modified";
  syncVersions: boolean;
  rootDir: string;
  versionKeep: number;
  trashDays: number;
  itemMaxKB: number;
  defaultCategory: string;
  defaultStyleId: string;
  defaultModel: string;
  maxLength: number;
  temperature: number;
  maxTokens: number;
  timeoutSec: number;
  scenario: string;
  historyLimit: number;
};

/** 契约 §2 的默认值：**单一事实源在 src/types/index.ts**（stores/app.ts 的深合并基线也要用它，
 *  不能让 store 反向依赖页面层）。这里 re-export 出去，保持页面层既有 import 路径不变。 */
export { PROMPTS_CONFIG_DEFAULTS } from "../../types";

// ===== 契约 §4：IPC 调用面 =====
// 命名规则：通道 `prompts_xxx_yyy` → 封装 `promptsXxxYyy`（与既有 memory_* 的封装风格一致）。
// 返回形状沿用 src/api/ipc.ts 的既有信封：成功返回整个 { ok:true, ... }，失败由 unwrapResult 抛错，
// 错误码挂在 err.code 上（§4.2 明确要求按 code 分支，不许按 message 文案匹配）。

export interface PromptsIpc {
  // 4.1 库
  promptsList(opts?: { includeTrash?: boolean }): Promise<{ ok: boolean; items: PromptItem[] }>;
  promptsGet(args: { id: string }): Promise<{ ok: boolean; item: PromptItem }>;
  promptsSave(args: { item: PromptItem; expectedHash?: string }): Promise<{ ok: boolean; id: string; hash: string }>;
  promptsDelete(args: { id: string }): Promise<{ ok: boolean }>;
  promptsRestore(args: { id: string }): Promise<{ ok: boolean }>;
  promptsPurge(args: { id: string }): Promise<{ ok: boolean }>;
  promptsEmptyTrash(): Promise<{ ok: boolean; count: number }>;
  promptsStats(): Promise<{ ok: boolean; stats: PromptStats }>;
  promptsMeta(): Promise<{ ok: boolean; categories: string[]; tags: string[] }>;
  promptsExport(args: { ids?: string[]; format: "md" | "json" }): Promise<{ ok: boolean; path: string; count: number }>;
  promptsImport(args: { data: string; format: "md" | "json"; onConflict: "new" | "overwrite" | "skip" }): Promise<{ ok: boolean; imported: number; overwritten: number; skipped: number }>;
  promptsOpenDir(): Promise<{ ok: boolean }>;
  promptsSetDir(args: { dir: string }): Promise<{ ok: boolean; dir: string }>;
  promptsRebuild(): Promise<{ ok: boolean; count: number }>;
  // 4.2 优化
  promptsStylesList(): Promise<{ ok: boolean; styles: PromptStyle[]; defaultId: string }>;
  promptsStylesSave(args: { style: PromptStyle }): Promise<{ ok: boolean; id: string }>;
  promptsStylesDelete(args: { id: string }): Promise<{ ok: boolean }>;
  promptsStylesReset(): Promise<{ ok: boolean }>;
  promptsOptimize(args: {
    text: string; styleId: string; model?: string;
    maxLength?: number; temperature?: number; maxTokens?: number; timeoutSec?: number; scenario?: string;
  }): Promise<{ ok: boolean; text: string; styleName: string; model: string; elapsedMs: number; tokens?: { in: number; out: number } }>;
  promptsOptimizeCancel(): Promise<{ ok: boolean }>;
  promptsHistoryList(): Promise<{ ok: boolean; items: PromptHistoryItem[] }>;
  promptsHistoryDelete(args: { id: string }): Promise<{ ok: boolean }>;
  promptsHistoryClear(): Promise<{ ok: boolean }>;
  // 4.3 同步
  promptsSyncStatus(): Promise<{ ok: boolean; status: PromptSyncStatus }>;
  promptsSyncRun(): Promise<{ ok: boolean; message?: string }>;
  promptsSyncCancel(): Promise<{ ok: boolean }>;
  promptsSyncLogs(): Promise<{ ok: boolean; logs: { at: number; text: string }[] }>;
  promptsSyncDevices(): Promise<{ ok: boolean; devices: { id: string; name: string; appVersion: string; lastSyncAt: number; self: boolean }[] }>;
  promptsConflictsList(): Promise<{ ok: boolean; items: PromptConflict[] }>;
  promptsConflictDiff(args: { id: string }): Promise<{ ok: boolean; diff: PromptConflictDiff }>;
  promptsConflictResolve(args: { id: string; decision: "local" | "remote" | "both" | "merge"; mergedText?: string }): Promise<{ ok: boolean }>;
  promptsConflictsAuto(args?: { strategy?: string }): Promise<{ ok: boolean; merged: number; remaining: number }>;
  // 4.5 报告历史：提示词库有自己的报告目录（<库>/reports），不复用技能仓库的 listReports
  //（那个读的是 hub 目录，把提示词报告写进去会污染技能的报告列表）
  promptsReportsList(): Promise<{ ok: boolean; reports: { name: string; path: string; size: number }[] }>;
  promptsReportRead(args: { name: string }): Promise<{ ok: boolean; text: string }>;
}

/** 契约 §4 的调用入口。用 `as unknown as` 而不是直接调用，是为了在 T2 尚未落地时也能通过类型检查；
 *  T2 落地后这里自动生效（ES 模块命名空间对象上就是这些具名导出），无需改动任何页面。 */
export const pipc = api as unknown as PromptsIpc;

/** 契约 §4.4 的事件信封（走既有 app:event，event 字段固定为 "prompts"） */
export type PromptsEvent = {
  event?: string;
  type?: "sync-stage" | "sync-done" | "sync-error" | "library-changed" | "history-changed";
  stage?: string;
  stageLabel?: string;
  detail?: string;
  pct?: number;
  running?: boolean;
  autoMerged?: number;
  pendingConflicts?: number;
  message?: string;
};

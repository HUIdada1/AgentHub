/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-23
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/**
 * AgentHub · 提示词库（Prompt Library）
 * Copyright (c) 2026 沐晖 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */
// 提示词库 · 模块级共享状态：库列表 / 分类标签 / 筛选 / 统计 / 风格 / 优化历史 / 同步状态
//
// 为什么把筛选与排序也放进 store 而不是各页各自 computed：
//   库列表页、详情页返回、侧栏概况卡要共用同一套口径；放在 store 里切页不丢筛选
//   （页面虽然是 v-show 保活，但组件重建时靠 store 恢复「我刚才筛的是什么」）。
//
// 与 app store 的分工：app 管框架（模块顺序 / 主题 / 全局设置弹窗），
// 提示词库自己的旋钮在框架 config 的 prompts 段（契约 §2），本 store 通过 cfg / saveCfg 读写。
import { defineStore } from "pinia";
import { useAppStore } from "./app";
import { onUpdateEvent } from "../api/ipc";
import { coalesceAsync } from "../utils/timing";
import {
  pipc, PROMPTS_CONFIG_DEFAULTS,
  type PromptConflict, type PromptHistoryItem, type PromptItem, type PromptStats,
  type PromptStyle, type PromptSyncStatus, type PromptsConfig, type PromptsEvent,
} from "../views/prompts/promptTypes";
import { splitCategory } from "../views/prompts/promptUtil";

/** 快捷入口（左栏）：全部 / 收藏 / 最近 / 未分类 / 回收站 */
export type PromptQuick = "all" | "favorite" | "recent" | "uncategorized" | "trash";
/** 顶栏筛选 chips */
export type PromptChip = "favorite" | "recent" | "variables" | "conflict" | "synced";
export type PromptSort = "updated" | "created" | "used" | "name";
export type PromptSource = "all" | PromptItem["source"];

/** 「最近」口径：7 天内更新过（与统计里的「本周」对齐，避免两个「最近」不一样） */
const RECENT_MS = 7 * 24 * 3600 * 1000;

// ===== 非响应式的模块级私有量 =====
// 为什么不放 state：退订函数与合流器都不是「界面要跟着变的数据」，
// 放进 state 会被 Pinia 深代理包一层（函数被代理后 this 指向也可能变），纯属自找麻烦。
let offEvent: (() => void) | null = null;

export const usePromptsStore = defineStore("prompts", {
  state: () => ({
    loaded: false,
    loading: false,
    error: "",
    /** 库全量（含回收站条目：deletedAt 有值即为回收站） */
    items: [] as PromptItem[],
    categories: [] as string[],
    tags: [] as string[],
    stats: null as PromptStats | null,
    styles: [] as PromptStyle[],
    defaultStyleId: "",
    history: [] as PromptHistoryItem[],
    syncStatus: null as PromptSyncStatus | null,
    conflicts: [] as PromptConflict[],
    /** 详情页目标条目 id（页面不接收 props，落点靠 store 传递，与记忆中枢 detailDrawerId 同款做法） */
    detailId: "",
    /** 优化历史「回填」的中转：历史页写入，优化页激活时取走并清空（与 detailId 同一套落点传递） */
    draft: null as null | {
      input: string; output: string;
      styleName: string; model: string; elapsedMs: number;
      tokens?: { in: number; out: number };
    },
    /** ===== 库列表筛选态 ===== */
    query: "",
    quick: "all" as PromptQuick,
    category: "",          // 形如 "写作" 或 "写作/邮件"，空 = 不限
    tag: "",
    source: "all" as PromptSource,
    sort: "updated" as PromptSort,
    view: "card" as "card" | "list",
    /** 顶栏 chips（可多选，与左栏 quick 是「与」关系） */
    chips: [] as PromptChip[],
    /** 批量模式与选中集合 */
    batchMode: false,
    selected: [] as string[],
    /** 上次同步基线时刻：用来推导「已同步」筛选（见 getter syncBaseAt） */
    lastSyncAt: 0,
  }),

  getters: {
    /** 框架 config 的 prompts 段（后端缺字段时用契约 §2 的默认值兜底，保证配置页首帧不空白） */
    cfg(): PromptsConfig {
      const app = useAppStore();
      const raw = (app.config as unknown as { prompts?: Partial<PromptsConfig> }).prompts;
      return { ...PROMPTS_CONFIG_DEFAULTS, ...(raw || {}) };
    },
    /** 在用条目（不含回收站） */
    liveItems: (s) => s.items.filter((i) => !i.deletedAt),
    trashItems: (s) => s.items.filter((i) => !!i.deletedAt),
    /** 分类树（两级）：从条目的 category 字符串现算，不引入独立分类实体（见 promptUtil.splitCategory） */
    categoryTree(s): { parent: string; count: number; children: { name: string; path: string; count: number }[] }[] {
      const map = new Map<string, { count: number; children: Map<string, number> }>();
      for (const it of s.items.filter((i) => !i.deletedAt)) {
        const { parent, child } = splitCategory(it.category);
        if (!map.has(parent)) map.set(parent, { count: 0, children: new Map() });
        const node = map.get(parent)!;
        node.count++;
        if (child) node.children.set(child, (node.children.get(child) || 0) + 1);
      }
      return [...map.entries()]
        .map(([parent, node]) => ({
          parent,
          count: node.count,
          children: [...node.children.entries()].map(([name, count]) => ({ name, path: `${parent}/${name}`, count })),
        }))
        .sort((a, b) => b.count - a.count || a.parent.localeCompare(b.parent, "zh"));
    },
    /** 标签云：按出现次数倒序（次数即「这个标签值不值得点」的唯一依据） */
    tagCounts(s): { name: string; count: number }[] {
      const map = new Map<string, number>();
      for (const it of s.items.filter((i) => !i.deletedAt)) for (const t of it.tags || []) map.set(t, (map.get(t) || 0) + 1);
      return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
    },
    sourceCounts(s): Record<string, number> {
      const out: Record<string, number> = { local: 0, optimized: 0, online: 0, imported: 0 };
      for (const it of s.items.filter((i) => !i.deletedAt)) out[it.source] = (out[it.source] || 0) + 1;
      return out;
    },
    /** 上次同步基线：契约 §4 没有「单条同步状态」通道，用「条目最后修改时间 ≤ 上次同步时刻」推导「已同步」。
     *  口径收在 store 里，是为了让「已同步」筛选与侧栏概况卡永远一致。 */
    syncBaseAt(s): number {
      return s.lastSyncAt || s.stats?.lastSyncAt || 0;
    },
    /** 待裁决冲突的条目 id 集合（库卡片上的冲突角标与筛选都读它） */
    conflictIds(s): Set<string> {
      return new Set(s.conflicts.filter((c) => !c.resolved).map((c) => c.id));
    },
    /** 顶栏 chips 各自的命中数（chips 上要显示数字，用户才知道点下去有没有东西） */
    chipCounts(s): Record<PromptChip, number> {
      const base = s.items.filter((i) => !i.deletedAt);
      const now = Date.now();
      const conflict = new Set(s.conflicts.filter((c) => !c.resolved).map((c) => c.id));
      const syncAt = s.lastSyncAt || s.stats?.lastSyncAt || 0;
      return {
        favorite: base.filter((i) => i.favorite).length,
        recent: base.filter((i) => now - i.updatedAt < RECENT_MS).length,
        variables: base.filter((i) => (i.variables || []).length > 0).length,
        conflict: base.filter((i) => conflict.has(i.id)).length,
        synced: syncAt ? base.filter((i) => i.updatedAt <= syncAt).length : 0,
      };
    },
    /** 主区列表：左栏（quick/category/tag/source）+ 顶栏（query/chips）逐层过滤，再排序 */
    filtered(s): PromptItem[] {
      const q = s.query.trim().toLowerCase();
      const conflict = new Set(s.conflicts.filter((c) => !c.resolved).map((c) => c.id));
      const now = Date.now();
      const syncAt = s.lastSyncAt || s.stats?.lastSyncAt || 0;
      let list = s.items.filter((i) => (s.quick === "trash" ? !!i.deletedAt : !i.deletedAt));
      if (s.quick === "favorite") list = list.filter((i) => i.favorite);
      if (s.quick === "recent") list = list.filter((i) => now - i.updatedAt < RECENT_MS);
      if (s.quick === "uncategorized") list = list.filter((i) => !i.category || i.category === "未分类");
      if (s.category) list = list.filter((i) => i.category === s.category || i.category.startsWith(s.category + "/"));
      if (s.tag) list = list.filter((i) => (i.tags || []).includes(s.tag));
      if (s.source !== "all") list = list.filter((i) => i.source === s.source);
      if (q) {
        list = list.filter((i) =>
          [i.name, i.description, i.body, i.category, (i.tags || []).join(" ")].join("\n").toLowerCase().includes(q)
        );
      }
      for (const c of s.chips) {
        if (c === "favorite") list = list.filter((i) => i.favorite);
        if (c === "recent") list = list.filter((i) => now - i.updatedAt < RECENT_MS);
        if (c === "variables") list = list.filter((i) => (i.variables || []).length > 0);
        if (c === "conflict") list = list.filter((i) => conflict.has(i.id));
        if (c === "synced") list = syncAt ? list.filter((i) => i.updatedAt <= syncAt) : [];
      }
      const sorted = [...list];
      sorted.sort((a, b) => {
        if (s.sort === "created") return b.createdAt - a.createdAt;
        if (s.sort === "used") return b.useCount - a.useCount || b.updatedAt - a.updatedAt;
        if (s.sort === "name") return a.name.localeCompare(b.name, "zh");
        return b.updatedAt - a.updatedAt;
      });
      // 置顶优先（契约 §3 的 pinned 可选字段）：置顶是用户显式表达的「这条最常用」，
      // 任何排序下都该浮在最前面，否则「置顶」形同虚设
      return [...sorted.filter((i) => i.pinned), ...sorted.filter((i) => !i.pinned)];
    },
    /** 详情页当前条目：回收站里的条目也能打开（只读 + 可还原），所以不限 deletedAt */
    detailItem(s): PromptItem | null {
      return s.items.find((i) => i.id === s.detailId) || null;
    },
    styleById(s): (id: string) => PromptStyle | undefined {
      return (id: string) => s.styles.find((x) => x.id === id);
    },
    /** 优化页的模型候选：契约 §4 没有「模型清单」通道（模型池在「设置 · 模型与网关」），
     *  这里用优化历史里出现过的模型名做候选，再配合手填——既不给用户假选项，也不新增通道。 */
    recentModels(s): string[] {
      return [...new Set(s.history.map((h) => h.model).filter(Boolean))].slice(0, 8);
    },
    /** 历史筛选口径（优化页抽屉）：失败条目不进「成功」，已存库单独一档 */
    historyCounts(s): { all: number; ok: number; fail: number; saved: number } {
      return {
        all: s.history.length,
        ok: s.history.filter((h) => !h.error).length,
        fail: s.history.filter((h) => !!h.error).length,
        saved: s.history.filter((h) => !!h.savedToLibrary).length,
      };
    },
  },

  actions: {
    /** 模块是否处于前台：隐藏时不做重量级刷新（各页 v-show 保活，切回时由页面的 watch 补一次）。
     *  这里用 String() 比较而不是直接比字面量：ModuleKey 由 T2 扩展，提前写死会让本文件在 T2 落地前报类型错。 */
    isForeground(): boolean {
      const app = useAppStore();
      return String(app.activeModule) === "prompts";
    },

    /** 事件订阅（契约 §4.4）：模块级只订阅一次；页面反复挂载不会叠加监听 */
    init() {
      if (offEvent) return;
      const un = onUpdateEvent((payload) => this.onEvent(payload as PromptsEvent));
      offEvent = un || null;
    },
    dispose() {
      if (offEvent) offEvent();
      offEvent = null;
    },

    /** 主进程事件分流（契约 §4.4）：
     *  - sync-stage：只更新进度字段，不重拉（阶段事件很密，重拉会把 IPC 排满）；
     *  - sync-done / sync-error：补一次冲突与库列表（自动合并会改条目与冲突队列）；
     *  - library-changed / history-changed：库或历史变了，各自合流刷新。 */
    onEvent(e: PromptsEvent) {
      if (e.event && e.event !== "prompts") return;
      if (e.type === "sync-stage") {
        const st = this.syncStatus;
        this.syncStatus = {
          running: e.running !== undefined ? e.running : true,
          configured: st?.configured ?? true,
          stage: (e.stage as PromptSyncStatus["stage"]) || st?.stage || "idle",
          stageLabel: e.stageLabel || st?.stageLabel || "",
          detail: e.detail || st?.detail || "",
          pct: e.pct !== undefined ? e.pct : st?.pct,
          lastSyncAt: st?.lastSyncAt || 0,
          lastError: st?.lastError || "",
          autoMerged: e.autoMerged !== undefined ? e.autoMerged : st?.autoMerged || 0,
          pendingConflicts: e.pendingConflicts !== undefined ? e.pendingConflicts : st?.pendingConflicts || 0,
        };
        return;
      }
      if (e.type === "sync-done") {
        void this.loadSync();
        void this.loadConflicts();
        void this.loadLibrary(true);
        return;
      }
      if (e.type === "sync-error") { void this.loadSync(); return; }
      if (e.type === "library-changed") { scheduleLibrary(); return; }
      if (e.type === "history-changed") { scheduleHistory(); return; }
    },

    async loadLibrary(force = false) {
      if (this.loaded && !force) return;
      this.loading = true;
      this.error = "";
      try {
        const [list, meta, stats] = await Promise.all([pipc.promptsList({ includeTrash: true }), pipc.promptsMeta(), pipc.promptsStats()]);
        this.items = list.items || [];
        this.categories = meta.categories || [];
        this.tags = meta.tags || [];
        this.stats = stats.stats || null;
        this.lastSyncAt = this.stats?.lastSyncAt || 0;
        this.loaded = true;
      } catch (e) {
        // 库目录不可用 / 台账损坏这类错误必须原样呈现（§8.2 第 8、10 条要引导用户重建或重新指定）
        this.error = (e as Error).message || "读取提示词库失败";
      } finally {
        this.loading = false;
      }
    },

    async loadStats() {
      try {
        const r = await pipc.promptsStats();
        this.stats = r.stats || null;
        this.lastSyncAt = this.stats?.lastSyncAt || 0;
      } catch { /* 概况卡是附属信息，取不到不影响主流程 */ }
    },

    async loadStyles() {
      try {
        const r = await pipc.promptsStylesList();
        this.styles = r.styles || [];
        this.defaultStyleId = r.defaultId || this.styles.find((s) => s.isDefault)?.id || "";
      } catch { /* 风格取不到时优化页会退化为「无可用风格」提示，由页面兜底 */ }
    },

    async loadHistory() {
      try {
        const r = await pipc.promptsHistoryList();
        this.history = r.items || [];
      } catch { /* 历史是本机偏好，取不到不影响优化主流程 */ }
    },

    async loadSync() {
      try {
        const r = await pipc.promptsSyncStatus();
        this.syncStatus = r.status || null;
        this.lastSyncAt = this.syncStatus?.lastSyncAt || 0;
      } catch { /* 未配置 WebDAV 时状态取不到，同步页据此显示空态 */ }
    },

    async loadConflicts() {
      try {
        const r = await pipc.promptsConflictsList();
        this.conflicts = r.items || [];
      } catch { /* 同上 */ }
    },

    /** 首屏一次性拉全（各页也可只调自己需要的细分方法，避免无谓 IPC） */
    async loadAll(force = false) {
      await Promise.all([this.loadLibrary(force), this.loadStyles(), this.loadHistory(), this.loadSync(), this.loadConflicts()]);
    },

    /** 保存条目：expectedHash 是乐观锁（§8.2 第 16 条）。
     *  返回 conflict 标记而不是抛错，让调用方决定「是否覆盖」——覆盖是用户的决定，工具层不替他做。 */
    async saveItem(item: PromptItem, expectedHash?: string): Promise<{ ok: boolean; id: string; hash: string; conflict: boolean; message?: string }> {
      try {
        const r = await pipc.promptsSave({ item, expectedHash });
        await this.loadLibrary(true);
        return { ok: true, id: r.id || item.id, hash: r.hash || "", conflict: false };
      } catch (e) {
        const err = e as Error & { code?: string };
        if (err.code === "conflict") return { ok: false, id: item.id, hash: "", conflict: true, message: err.message };
        return { ok: false, id: item.id, hash: "", conflict: false, message: err.message || "保存失败" };
      }
    },

    async removeItem(id: string) {
      await pipc.promptsDelete({ id });
      await this.loadLibrary(true);
    },
    async restoreItem(id: string) {
      await pipc.promptsRestore({ id });
      await this.loadLibrary(true);
    },
    async purgeItem(id: string) {
      await pipc.promptsPurge({ id });
      await this.loadLibrary(true);
    },
    async emptyTrash() {
      const r = await pipc.promptsEmptyTrash();
      await this.loadLibrary(true);
      return r.count || 0;
    },
    /** 收藏切换：先本地改（点击要立刻有反馈），失败回滚（避免界面与磁盘不一致） */
    async toggleFavorite(item: PromptItem) {
      const before = item.favorite;
      item.favorite = !before;
      const r = await this.saveItem(item, item.hash);
      if (!r.ok) item.favorite = before;
      return r.ok;
    },
    /** 记录一次「使用」（详情页复制成品时自增，供「使用次数」排序） */
    async bumpUse(item: PromptItem) {
      item.useCount = (item.useCount || 0) + 1;
      item.lastUsedAt = Date.now();
      await this.saveItem(item, item.hash);
    },

    openDetail(id: string) {
      this.detailId = id;
      useAppStore().setPage("prompt-detail");
    },
    closeDetail() {
      this.detailId = "";
    },

    /** 保存框架 config 的 prompts 段：prompts 不是「磁盘优先字段」，走整份 save 即可（契约 §7.2 第 2 条） */
    async saveCfg(patch: Partial<PromptsConfig>) {
      const app = useAppStore();
      const cur = (app.config as unknown as { prompts?: Partial<PromptsConfig> }).prompts || {};
      (app.config as unknown as { prompts: PromptsConfig }).prompts = { ...PROMPTS_CONFIG_DEFAULTS, ...cur, ...patch };
      const r = await app.save();
      if (r && (r as { ok?: boolean }).ok === false) throw new Error((r as { message?: string }).message || "配置保存失败");
    },
  },
});

// 刷新合流器：批量删除 / 批量打标签会连发多条 library-changed，
// 直接逐条重拉会把 IPC 排满（库列表是「列表 + 元信息 + 统计」三个串行请求）。
const scheduleLibrary = coalesceAsync(() => usePromptsStore().loadLibrary(true), 800);
const scheduleHistory = coalesceAsync(() => usePromptsStore().loadHistory(), 800);

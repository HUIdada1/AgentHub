/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 记忆仓库 · 模块级共享状态：状态/统计/配置/词条（多页共用，避免各页重复拉取）
// 与 app store 的分工：app 只管框架（模块顺序/主题），仓库自己的旋钮在 memory.config.json，
// 本 store 负责把它的信封（config + schema + diff）缓存下来给各页与配置页共用。
import { defineStore } from "pinia";
import type {
  MemoryStats, MemoryIndexStatus, MemoryStatusEnvelope, MemoryConfigFieldMeta,
  MemoryBeatsRow, MemoryBridgeStatus,
} from "../types";
import * as api from "../api/ipc";
import { useAppStore } from "./app";

type MemoryConfigTree = Record<string, any>;

export const useMemoryStore = defineStore("memory", {
  state: () => ({
    loaded: false,
    loadError: "",
    /** 模块是否启用（框架侧 memory.enabled） */
    enabled: true,
    /** 仓库根目录 */
    root: "",
    /** 仓库内配置信封 */
    config: {} as MemoryConfigTree,
    schema: {} as Record<string, MemoryConfigFieldMeta>,
    diff: [] as { key: string; value: unknown; default: unknown }[],
    /** 统计与索引状态 */
    stats: null as MemoryStats | null,
    index: null as MemoryIndexStatus | null,
    bridge: { running: false, port: 0 } as MemoryBridgeStatus,
    /** Agent 调用心跳（三级校验的第三级数据源） */
    beats: [] as MemoryBeatsRow[],
    verifiedAgents: 0,
    /** 事件回流计数：新增记忆时自增，浏览页据此置顶高亮 */
    newTick: 0,
    lastNewId: "",
    /** 配置页子板块跳转提示：仪表盘点「模型与网关」时写 "__models__"，配置页消费后清空 */
    configTabHint: "",
    /** 项目页「查看记忆」跳转预过滤：BrowseView 激活时消费并清空 */
    browsePrefilter: "",
    /** 记忆浏览的视图落点提示（"list" | "heatmap" | "review" | "trash"）：待确认收件箱入口都走它，消费后清空 */
    browseViewHint: "",
    /** 待确认收件箱落点提示（"supersede" | "classify" | "dedup"）：入口按队列类型带过来，消费后清空 */
    reviewTabHint: "",
    /** 最近一次索引事件（进度条用） */
    indexEvent: null as { running: boolean; done: number; total: number; detail?: string } | null,
    /** 各页「待你处理」计数（键＝页面 id）：顶部页签红点与侧栏提醒的唯一事实源。
        只有真的需要你点头的事才进这里，自动流转的队列不算。 */
    pending: {} as Record<string, number>,
    /** refreshPending 的上次执行时刻（节流用，纯记账不需要响应式） */
    pendingAt: 0,
  }),

  getters: {
    /** 点路径取配置值（与后端 schema 的键一致，如 index.titleBoost） */
    cfg: (s) => (key: string, fallback?: unknown) => {
      let cur: any = s.config;
      for (const seg of key.split(".")) {
        if (cur === null || typeof cur !== "object") return fallback;
        cur = cur[seg];
      }
      return cur === undefined ? fallback : cur;
    },
    /** 已连通的 Agent（三级校验第三级：有真实调用） */
    connectedAgents: (s) => s.beats.filter((b) => b.last_call).map((b) => b.agent),
    pendingReview: (s) => s.stats?.pending ?? 0,
    /** ui.realtimeRefresh=false 时浏览页不跟着事件自动重拉（配置在仓库内，故是本模块的 getter） */
    realtimeEnabled(s): boolean {
      const v = s.config?.ui?.realtimeRefresh;
      return v !== false;
    },
  },

  actions: {
    async loadAll(force = false) {
      if (this.loaded && !force) return;
      try {
        const env = await api.memoryConfigGet();
        this.config = env.config || {};
        // 「待确认」从独立页签并入了记忆浏览：老配置里存着 review 的用户，
        // 这里在内存里纠正回默认页（不写盘，用户下次动这个下拉时自然覆盖）
        if (this.config?.ui?.defaultTab === "review") this.config.ui.defaultTab = "dashboard";
        this.schema = env.schema || {};
        this.diff = env.diff || [];
        this.root = env.root || "";
        this.loaded = true;
        this.loadError = "";
      } catch (e) {
        this.loadError = (e as Error).message || "读取配置失败";
      }
      await Promise.all([this.loadStats(), this.loadIndex(), this.loadStatus()]);
      void this.refreshPending(true);
    },

    async loadStats() {
      try {
        this.stats = await api.memoryStats();
      } catch {
        /* 保留旧值（模块未启用时静默降级） */
      }
    },

    async loadIndex() {
      try {
        this.index = await api.memoryIndexStatus();
      } catch {
        /* 保留旧值 */
      }
    },

    async loadStatus() {
      try {
        const st: MemoryStatusEnvelope = await api.memoryStatus();
        this.enabled = st.enabled;
        this.root = st.root || this.root;
        this.bridge = st.bridge;
        this.beats = st.beats || [];
        this.verifiedAgents = st.verifiedAgents || 0;
        if (st.index) this.index = st.index;
      } catch {
        /* 保留旧值 */
      }
    },

    /** 刷新各页待处理计数（顶部页签红点）：三个维度都不是同一批数据，故分头取。
     *  ① 待裁决三类（事实失效/归类/去重）统一记在「记忆浏览」——收件箱已并入那里；
     *  ② 索引与磁盘不一致记在「检索与索引」；③ WebDAV 冲突记在「WebDAV同步」。
     *  事件风暴下会被高频触发，故带 2 秒节流：红点晚两秒亮，换来不打 IPC 风暴。 */
    async refreshPending(force = false) {
      const now = Date.now();
      if (!force && now - this.pendingAt < 2000) return;
      this.pendingAt = now;
      const out: Record<string, number> = {};
      try {
        const s = await api.memoryStats();
        out.browse = s.pending || 0;
      } catch {
        /* 取不到就当没有待处理，不用旧值吓人 */
      }
      try {
        const i = await api.memoryIndexStatus();
        out.index = i.consistent === false ? 1 : 0;
      } catch {
        /* 同上 */
      }
      try {
        const c = await api.memoryConflictsList();
        out.sync = c.conflicts.length;
      } catch {
        /* 同上 */
      }
      this.pending = out;
    },

    /** 保存一组配置项（键为点路径），成功后重拉信封 */
    async save(entries: Record<string, unknown>, local = false) {
      await api.memoryConfigSave(entries, local);
      await this.loadAll(true);
    },

    async reset(keys?: string[]) {
      await api.memoryConfigReset(keys);
      await this.loadAll(true);
    },

    /** 跳到「记忆浏览 · 待确认」视图，可选带落点 tab（KPI/侧栏/各页的待处理入口统一走这里）。
     *  待确认收件箱不再是独立页签，它现在是记忆浏览里的第三个视图，故这里同时置视图落点。 */
    gotoReview(kind?: "supersede" | "classify" | "dedup") {
      if (kind) this.reviewTabHint = kind;
      this.browseViewHint = "review";
      try {
        const app = useAppStore();
        if (app.activeModule !== "memory" || app.settingsOpen) app.selectModule("memory");
        app.settingsOpen = false;
        app.activePage = "browse";
      } catch {
        /* 组件外调用时跳过 */
      }
    },

    /** 主进程广播分流：供 App.vue 调用（本模块只处理 event === "memory"） */
    onEvent(p: { type?: string; id?: string; done?: number; total?: number; running?: boolean; detail?: string; port?: number }) {
      const type = p?.type || "";
      // 任何一次记忆事件都可能改变待裁决/冲突数：统一在这里刷新页签红点（store 内自带节流）
      if (type) void this.refreshPending();
      if (type === "memory-new") {
        this.newTick += 1;
        this.lastNewId = p.id || "";
        void this.loadStats();
        void this.loadIndex();
        return;
      }
      if (type === "config-changed") {
        void this.loadAll(true);
        return;
      }
      if (type === "index") {
        this.indexEvent = { running: !!p.running, done: p.done || 0, total: p.total || 0, detail: p.detail };
        if (!p.running) {
          void this.loadIndex();
          void this.loadStats();
        }
        return;
      }
      if (type === "bridge") {
        this.bridge = { ...this.bridge, running: true, port: p.port || this.bridge.port };
        return;
      }
      if (type === "deleted" || type === "supersede" || type === "root-changed") {
        void this.loadStats();
        void this.loadIndex();
      }
    },
  },
});

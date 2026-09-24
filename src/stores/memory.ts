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
    /** 待确认收件箱落点提示（"supersede" | "classify" | "dedup"）：入口按队列类型带过来，消费后清空 */
    reviewTabHint: "",
    /** 最近一次索引事件（进度条用） */
    indexEvent: null as { running: boolean; done: number; total: number; detail?: string } | null,
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
        this.schema = env.schema || {};
        this.diff = env.diff || [];
        this.root = env.root || "";
        this.loaded = true;
        this.loadError = "";
        this.applyUiConfig();
      } catch (e) {
        this.loadError = (e as Error).message || "读取配置失败";
      }
      await Promise.all([this.loadStats(), this.loadIndex(), this.loadStatus()]);
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

    /** 保存一组配置项（键为点路径），成功后重拉信封 */
    async save(entries: Record<string, unknown>, local = false) {
      await api.memoryConfigSave(entries, local);
      await this.loadAll(true);
      this.applyUiConfig();
    },

    /** ui.tabs 反馈到页签条（框架 store 持有排序结果，记忆模块不在框架里写死顺序） */
    applyUiConfig() {
      const tabs = this.cfg("ui.tabs", []);
      const list = Array.isArray(tabs) ? tabs.filter((x): x is string => typeof x === "string") : [];
      if (!list.length) return;
      try {
        useAppStore().memoryTabs = list;
      } catch {
        /* 组件外/未安装 pinia 时跳过（浏览器预览的极早期调用） */
      }
    },

    async reset(keys?: string[]) {
      await api.memoryConfigReset(keys);
      await this.loadAll(true);
    },

    /** 跳到「待确认」收件箱，可选带落点 tab（KPI/侧栏/各页的待处理入口统一走这里） */
    gotoReview(kind?: "supersede" | "classify" | "dedup") {
      if (kind) this.reviewTabHint = kind;
      try {
        useAppStore().activePage = "review";
      } catch {
        /* 组件外调用时跳过 */
      }
    },

    /** 主进程广播分流：供 App.vue 调用（本模块只处理 event === "memory"） */
    onEvent(p: { type?: string; id?: string; done?: number; total?: number; running?: boolean; detail?: string; port?: number }) {
      const type = p?.type || "";
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

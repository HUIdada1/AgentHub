// 用量同步模块状态：模块配置、当前数据源、同步状态（原「用量记录同步」stores/app.ts）
// 主题/页面切换归框架 stores/app.ts，本 store 不再持有 theme/update/activePage
import { defineStore } from "pinia";
import type { SyncConfig, SourceInfo, SourceVisibility, SyncProgress, SyncStage, TotalMode, TopBarItem } from "../types/sync";
import { GROUP_PREFIX, SOURCE_GROUPS, sourceGroupOf } from "../types/sync";
import * as api from "../api/sync";
import { useAppStore } from "./app";

// 浏览器 mock / 后端加载失败时的兜底默认值；后端权威默认值见 electron/backend/config.cjs
import { TOTAL_MODES } from "../types/sync";

/** 组内子源顺序（纯函数，getter 与 action 共用）：用户自定义 groupOrder 优先，缺项按内置默认顺序补尾 */
function childOrderOfList(vis: SourceVisibility, groupKey: string): string[] {
  const def = SOURCE_GROUPS.find((g) => g.key === groupKey);
  if (!def) return [];
  const saved = vis.groupOrder?.[groupKey];
  const list = Array.isArray(saved) ? Array.from(new Set(saved)).filter((id) => def.items.includes(id)) : [];
  for (const id of def.items) if (!list.includes(id)) list.push(id);
  return list;
}
const defaultConfig: SyncConfig = {
  deviceName: "这台电脑",
  webdav: { endpoint: "", username: "", password: "", root: "/dosage-sync", preset: "feiniu" },
  localBackup: { dir: "" },
  sources: [
    { source: "zcode", enabled: true, dataDir: null },
    { source: "codex", enabled: false, dataDir: null },
    { source: "dsh", enabled: false, dataDir: null },
    { source: "workbuddy", enabled: true, dataDir: null },
    { source: "workbuddy-ai", enabled: true, dataDir: null },
    { source: "reasonix", enabled: true, dataDir: null },
    { source: "codebuddy", enabled: false, dataDir: null },
    { source: "qoder", enabled: false, dataDir: null },
    { source: "qoder-cn", enabled: false, dataDir: null },
    { source: "antigravity", enabled: false, dataDir: null },
    { source: "antigravity-ide", enabled: false, dataDir: null },
    { source: "antigravity-legacy", enabled: false, dataDir: null },
    { source: "trae", enabled: false, dataDir: null },
    { source: "trae-cn", enabled: false, dataDir: null },
    { source: "trae-solo", enabled: false, dataDir: null },
    { source: "trae-solo-cn", enabled: false, dataDir: null },
    { source: "opensquilla", enabled: false, dataDir: null },
    { source: "grok", enabled: false, dataDir: null },
  ],
  sourceVisibility: {
    order: ["zcode", "codex", "dsh", "workbuddy", "workbuddy-ai", "reasonix", "codebuddy", "qoder", "qoder-cn", "antigravity", "antigravity-ide", "antigravity-legacy", "trae", "trae-cn", "trae-solo", "trae-solo-cn", "opensquilla", "grok"],
    hidden: [],
    initialized: false,
  },
  schedule: { hourly: false, hourlyInterval: 1, daily: false, dailyTime: "23:30", autoStart: false, minimizeToTray: true, notifyOnSuccess: false },
  totalMode: "full",
  billing: {
    enabled: false,
    displayCurrency: "CNY" as const,
    usdToCny: 7.2,
    importProxy: "",
    remotePricing: {
      enabled: false,
      url: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json",
      hashUrl: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.sha256",
      intervalHours: 24,
    },
  },
};

/** 「全部」汇总视图的虚拟源 id：查询时由 querySource 归一化为 null（后端 null = 不按源过滤） */
export const ALL_SOURCES = "all";

export const useSyncStore = defineStore("sync", {
  state: () => ({
    config: { ...defaultConfig } as SyncConfig,
    loaded: false,
    activeSource: ALL_SOURCES as string,
    // 数据源清单（id/name 来自后端适配器，唯一事实源；enabled 为磁盘配置中的状态）
    sources: [] as SourceInfo[],
    sync: { running: false, stage: "idle" as SyncStage, stageLabel: "", percent: 0, message: "", lastSyncAt: null, localOnly: false } as SyncProgress & { lastSyncAt: number | null },
    syncing: false,
    syncDialogOpen: false,
    syncStartError: "",
    dataDir: "",
  }),
  getters: {
    // 主题归框架统一管理；图表等组件仍读这里，委托框架 store（浅色返回 false）
    isDark: () => useAppStore().isDark,
    totalMode: (s) => s.config.totalMode,
    // 旧代码里 watch(app.activePage) 的兼容入口：代理框架 store 的当前页
    activePage: () => useAppStore().activePage,
    /** WebDAV 是否已配置（endpoint 非空）：顶栏「立即同步/立即读取」文案与本机存储提示据此切换 */
    webdavReady: (s) => !!s.config.webdav.endpoint.trim(),
    isSourceEnabled: (s) => (source: string) => !!s.config.sources.find((item) => item.source === source)?.enabled,
    sourceName: (s) => (source: string) => (source === ALL_SOURCES ? "全部" : s.sources.find((item) => item.id === source)?.name || source),
    /** 传给后端查询的源参数：「全部」归一化为 null（后端 null = 不按源过滤，即各分类累加） */
    querySource: (s) => (s.activeSource === ALL_SOURCES ? null : s.activeSource),
    /** 顶栏「全部」圆点：任一可见源已启用即亮 */
    anyVisibleSourceEnabled(): boolean {
      return this.visibleSources.some((item) => this.isSourceEnabled(item.id));
    },
    /** 当前激活源是否有数据可看（「全部」= 任一可见源启用） */
    activeSourceEnabled(): boolean {
      return this.activeSource === ALL_SOURCES ? this.anyVisibleSourceEnabled : this.isSourceEnabled(this.activeSource);
    },
    /** 组内子源顺序（含隐藏项）：用户自定义 groupOrder 优先，缺项按内置默认顺序补尾 */
    childOrderOf: (s) => (groupKey: string): string[] => childOrderOfList(s.config.sourceVisibility, groupKey),
    /**
     * 工具栏顶层条目（按 order 排序）。
     * includeHidden=false（顶栏用）：组内 children 已剔除隐藏项；
     * includeHidden=true（设置页用）：children 含全部成员。
     * 组条目缺失/被隐藏到只剩 0 个可见子源时整组不出现；组内成员若散落在 order 中
     * 只经其组渲染（不单独平铺），避免重复。
     */
    topItems: (s) => (includeHidden: boolean): TopBarItem[] => {
      const vis = s.config.sourceVisibility;
      const hidden = new Set(vis.hidden || []);
      const byId = new Map(s.sources.map((x) => [x.id, x]));
      const items: TopBarItem[] = [];
      const used = new Set<string>();
      const shown = new Set<string>();
      for (const token of Array.isArray(vis.order) ? vis.order : []) {
        if (typeof token !== "string") continue;
        if (token.startsWith(GROUP_PREFIX)) {
          const key = token.slice(GROUP_PREFIX.length);
          const def = SOURCE_GROUPS.find((g) => g.key === key);
          if (!def) continue;
          const children = childOrderOfList(vis, key)
            .map((id) => byId.get(id))
            .filter((x): x is SourceInfo => !!x && (includeHidden || !hidden.has(x.id)));
          if (!children.length) continue;
          children.forEach((c) => used.add(c.id));
          shown.add(key);
          items.push({ kind: "group", key, label: def.label, children });
        } else {
          if (used.has(token)) continue;
          // 组内成员只经其组渲染（配置迁移已保证组条目先于成员出现）
          if (sourceGroupOf(token)) { used.add(token); continue; }
          const src = byId.get(token);
          if (!src) continue;
          if (!includeHidden && hidden.has(token)) continue;
          used.add(token);
          items.push({ kind: "source", source: src });
        }
      }
      // 兜底：不在 order 中的独立源补到末尾
      for (const src of s.sources) {
        if (used.has(src.id)) continue;
        if (!includeHidden && hidden.has(src.id)) continue;
        if (sourceGroupOf(src.id)) continue;
        used.add(src.id);
        items.push({ kind: "source", source: src });
      }
      // 兜底：组条目缺失但仍有成员的组，按其内置定义补到末尾。
      // 组成员只会经组渲染（字面量在 order 中仅被跳过不渲染），故此处无需 used 过滤；
      // 否则半迁移状态（部分组有条目、部分无）会因字面量被 used 消费而整组丢失。
      for (const g of SOURCE_GROUPS) {
        if (shown.has(g.key)) continue;
        const children = childOrderOfList(vis, g.key)
          .map((id) => byId.get(id))
          .filter((x): x is SourceInfo => !!x && (includeHidden || !hidden.has(x.id)));
        if (!children.length) continue;
        children.forEach((c) => used.add(c.id));
        items.push({ kind: "group", key: g.key, label: g.label, children });
      }
      return items;
    },
    /** 顶栏可见来源：按 order 排序 + 过滤 hidden（组内成员平铺；供「全部」圆点等场景用） */
    visibleSources: (s) => {
      const vis = s.config.sourceVisibility;
      const hidden = new Set(vis.hidden || []);
      const rank = new Map((vis.order || []).map((id, i) => [id, i]));
      return [...s.sources]
        .filter((item) => !hidden.has(item.id))
        .sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    },
  },
  actions: {
    /** 加载后端配置并合并进 store（load 与「恢复备份后刷新」共用；不重复启动进度轮询） */
    async reloadConfig() {
      try {
      const loaded = await api.loadConfig();
      Object.assign(this.config, loaded);
      if (loaded.webdav) Object.assign(this.config.webdav, loaded.webdav);
      if (loaded.localBackup) Object.assign(this.config.localBackup, loaded.localBackup);
      if (loaded.schedule) Object.assign(this.config.schedule, loaded.schedule);
      // 口径兜底：后端已归一化，这里再防 mock/异常值（platform 选项已移除，等效 compact）
      if (!TOTAL_MODES[this.config.totalMode]) this.config.totalMode = "compact";
      } catch {
        this.config = { ...defaultConfig };
      }
      // 两级结构迁移：旧扁平 order 插入 g:组条目（有变更才落盘）
      try {
        if (this.migrateGroupOrder()) await api.saveConfig(this.config);
      } catch {
        /* 迁移落盘失败不阻断启动，下次加载重试 */
      }
      this.loadDataDir();
    },
    async load() {
      await this.reloadConfig();
      this.loaded = true;
      this.loadSources();
      this.startProgressPolling();
    },
    /** 来源清单：name 唯一事实源在后端适配器，前端不再硬编码；失败时退回本地配置（仅 id） */
    async loadSources() {
      try {
        this.sources = await api.listSources();
      } catch {
        this.sources = this.config.sources.map((s) => ({ id: s.source, name: s.source, enabled: s.enabled, visible: true }));
      }
      // 兜底：当前激活项若被隐藏或已不存在，回退到「全部」；「全部」本身永远合法
      if (this.activeSource !== ALL_SOURCES) {
        const visibleIds = this.visibleSources.map((s) => s.id);
        if (!visibleIds.includes(this.activeSource)) this.activeSource = ALL_SOURCES;
      }
    },
    async loadDataDir() {
      try {
        this.dataDir = await api.getDataDir();
      } catch {
        this.dataDir = "";
      }
    },
    async save() {
      return api.saveConfig(this.config);
    },
    setTotalMode(mode: TotalMode) {
      this.config.totalMode = mode;
      this.save();
    },
    setActiveSource(source: string) {
      this.activeSource = source;
    },
    /** 切换顶栏项的显示/隐藏（隐藏 ≠ 停用同步） */
    async setSourceVisible(source: string, visible: boolean) {
      const vis = this.config.sourceVisibility;
      const hidden = new Set(vis.hidden || []);
      if (visible) hidden.delete(source);
      else hidden.add(source);
      vis.hidden = Array.from(hidden);
      // 若隐藏的是当前激活项，自动回退到「全部」
      if (!visible && this.activeSource === source) this.activeSource = ALL_SOURCES;
      await this.save();
    },
    /**
     * 两级结构迁移：旧的扁平 order（只有源 id）升级为「组条目 + 成员」结构——
     * 在每个组的首个成员出现之前插入 `g:组key`。逐组补齐（非全有全无）：
     * 半迁移状态（部分组已有条目）只补缺失的组条目，成员字面量顺序原样保留。返回是否变更。
     */
    migrateGroupOrder(): boolean {
      const vis = this.config.sourceVisibility;
      if (!vis || !Array.isArray(vis.order)) return false;
      let changed = false;
      const out: string[] = [];
      const placed = new Set<string>();
      for (const t of vis.order) {
        if (typeof t !== "string") continue;
        if (t.startsWith(GROUP_PREFIX)) {
          placed.add(t.slice(GROUP_PREFIX.length));
          out.push(t);
          continue;
        }
        const def = sourceGroupOf(t);
        if (def && !placed.has(def.key)) {
          out.push(GROUP_PREFIX + def.key);
          placed.add(def.key);
          changed = true;
        }
        out.push(t);
      }
      // 后端已保证注册源均在 order 中；此处仅为防御：成员未出现的组补到末尾
      for (const g of SOURCE_GROUPS) {
        if (!placed.has(g.key)) {
          out.push(GROUP_PREFIX + g.key);
          changed = true;
        }
      }
      if (!changed) return false;
      vis.order = out;
      return true;
    },
    /** 顶层排序（拖拽）：将条目 token（源 id 或 `g:组key`）移动到 targetIndex（顶层条目列表的下标） */
    async moveTopItem(token: string, targetIndex: number) {
      const items = this.topItems(true).map((it) => (it.kind === "group" ? GROUP_PREFIX + it.key : it.source.id));
      const from = items.indexOf(token);
      if (from < 0) return;
      const to = Math.max(0, Math.min(targetIndex, items.length - 1));
      if (from === to) return;
      const order = (this.config.sourceVisibility.order || []).slice();
      const f = order.indexOf(token);
      if (f < 0) return;
      order.splice(f, 1);
      const targetToken = items[to];
      const t = order.indexOf(targetToken);
      if (t < 0) order.push(token);
      else order.splice(t, 0, token);
      this.config.sourceVisibility.order = order;
      await this.save();
    },
    /** 顶层条目上移一位 */
    async moveTopUp(token: string) {
      const items = this.topItems(true).map((it) => (it.kind === "group" ? GROUP_PREFIX + it.key : it.source.id));
      const idx = items.indexOf(token);
      if (idx > 0) await this.moveTopItem(token, idx - 1);
    },
    /** 顶层条目下移一位 */
    async moveTopDown(token: string) {
      const items = this.topItems(true).map((it) => (it.kind === "group" ? GROUP_PREFIX + it.key : it.source.id));
      const idx = items.indexOf(token);
      if (idx >= 0 && idx < items.length - 1) await this.moveTopItem(token, idx + 1);
    },
    /** 组内排序（拖拽）：将组内子源移到 targetIndex（该组子项列表的下标） */
    async moveChildInGroup(groupKey: string, childId: string, targetIndex: number) {
      const vis = this.config.sourceVisibility;
      const go = vis.groupOrder || (vis.groupOrder = {});
      const list = this.childOrderOf(groupKey);
      const from = list.indexOf(childId);
      if (from < 0) return;
      const to = Math.max(0, Math.min(targetIndex, list.length - 1));
      if (from === to) return;
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      go[groupKey] = list;
      await this.save();
    },
    /** 组内子源上移一位 */
    async moveChildUp(groupKey: string, childId: string) {
      const idx = this.childOrderOf(groupKey).indexOf(childId);
      if (idx > 0) await this.moveChildInGroup(groupKey, childId, idx - 1);
    },
    /** 组内子源下移一位 */
    async moveChildDown(groupKey: string, childId: string) {
      const list = this.childOrderOf(groupKey);
      const idx = list.indexOf(childId);
      if (idx >= 0 && idx < list.length - 1) await this.moveChildInGroup(groupKey, childId, idx + 1);
    },
    /** 页面切换归框架 store；模块配置在各模块右上「配置」按钮切换的配置页（框架 openModuleConfig） */
    setPage(page: "overview" | "detail" | "costs" | "billing" | "log") {
      const framework = useAppStore();
      framework.selectModule("sync");
      framework.setPage(page);
    },
    /** mode="backup"：强制本机备份（未配置 WebDAV 时顶栏按钮「立即读取」即此语义）；默认走常规同步 */
    async startSync(mode: "auto" | "backup" = "auto") {
      this.syncing = true;
      this.syncDialogOpen = true;
      this.syncStartError = "";
      // 立即同步前落盘，确保刚编辑的 WebDAV/备份目录配置由主进程读取到
      const saved = await api.saveConfig(this.config);
      if (!saved.ok) {
        this.syncing = false;
        this.syncStartError = saved.message;
        this.sync = { ...this.sync, running: false, stage: "error", stageLabel: "失败", message: saved.message };
        return;
      }
      // start_sync 后台运行、立即返回，进度通过轮询 get_sync_progress 更新
      try {
        await api.startSync(mode === "backup" ? { mode: "backup" } : undefined);
        this.refreshProgress();
      } catch (e) {
        const message = e instanceof Error ? e.message : "同步启动失败";
        this.syncing = false;
        this.sync = { ...this.sync, running: false, stage: "error", stageLabel: "失败", message };
      }
    },
    closeSyncDialog() {
      if (!this.sync.running && !this.syncing) this.syncDialogOpen = false;
    },
    async cancelSync() {
      await api.cancelSync();
    },
    async refreshProgress() {
      const progress = await api.getSyncProgress();
      this.sync = { ...progress, lastSyncAt: progress.lastSyncAt ?? this.sync.lastSyncAt ?? null };
      // 同步结束（含失败/取消）后关闭「同步中」态
      if (!this.sync.running) this.syncing = false;
    },
    // 进度轮询：每 600ms 拉取一次；空闲且非同步中时降频为 1500ms，有同步任务时自动恢复
    startProgressPolling() {
      const tick = async () => {
        try {
          await this.refreshProgress();
        } catch {
          /* 忽略单次轮询错误 */
        }
        const busy = this.sync.running || this.syncing;
        setTimeout(tick, busy ? 600 : 1500);
      };
      tick();
    },
  },
});

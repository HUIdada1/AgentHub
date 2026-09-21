// 应用级状态：配置（主题 / 模块顺序 + 技能仓库配置）、当前模块与子页面、技能仓库全局数据
import { defineStore } from "pinia";
import { MODULES } from "../types";
import type { AppConfig, SettingsTab, ModuleDef, ModuleKey, PageDef, Overview, ToolRow } from "../types";
import * as api from "../api/ipc";

// 浏览器 mock / 后端加载失败时的兜底默认值；后端权威默认值见 electron/backend/config.cjs
const defaultConfig: AppConfig = {
  theme: "dark",
  // 动效默认关闭（低配置电脑友好），用户在设置里开启后本机记住
  fx: false,
  moduleOrder: MODULES.map((m) => m.key),
  tools: {},
  customDirs: [],
  mountMode: "junction",
  l3: { enabled: false, threshold: 0.85 },
  trashDays: 7,
  update: { channel: "stable", autoCheck: true, notifiedVersion: "" },
  webdav: { endpoint: "", username: "", password: "", root: "/agent-skills", deviceId: "", deviceName: "" },
  schedule: { minimizeToTray: true, autoStart: false, hourly: false, daily: false, dailyTime: "09:00", notifyOnSuccess: false },
  watch: { enabled: true },
  // 反代网关设置兜底（权威默认值见 electron/backend/config.cjs）
  proxy: {
    port: 9527,
    bind: "127.0.0.1",
    restoreOnLaunch: false,
    routeStrategy: "smart",
    fixedChannel: "trae",
    rateLimitPerMin: 120,
    concurrency: 8,
    creditsRefreshMin: 30,
    debugStatus: false,
    modelOverrides: {},
    humanizeJitter: true,
    disabledModels: [],
    modelFallback: {},
    modelAliases: {},
    autoFallbackEnabled: true,
    checkinAuto: false,
    checkinAutoTime: "09:00",
    fallbackModel: "",
    ccSwitchModel: "",
  },
};

/** 技能仓库内的页面 id（skill-detail 为隐藏详情页，不进横条菜单，由技能库卡片进入） */
export type SkillsPageId = "dashboard" | "library" | "skill-detail" | "sync" | "webdav" | "dedup";

export const useAppStore = defineStore("app", {
  state: () => ({
    config: { ...defaultConfig } as AppConfig,
    loaded: false,
    activeModule: "skills" as ModuleKey,
    activePage: MODULES[0].pages[0].id,
    // ===== 全局设置弹窗（左下角设置按钮）：通用 / WebDAV 同步 / 数据与备份 =====
    settingsOpen: false,
    settingsTab: "general" as SettingsTab,
    /** 更新通知 / 托盘「发现新版本」跳转信号：自增计数，通用页据此滚动并高亮更新卡片 */
    configFocusUpdate: 0,
    /** 是否有更新待处理（available/downloaded）：侧栏设置齿轮与更新按钮红点的数据源 */
    updateAvailable: false,
    /** 模块配置页（各模块右上「配置」按钮切换，id=config）：进入前所在的子页面，完成时回去 */
    pageBeforeConfig: "",
    // ===== 技能仓库全局数据 =====
    toolMeta: [] as ToolRow[],   // 工具适配器显示名/图标的唯一来源，别处不许再硬编码
    skillsOverview: null as Overview | null, // 左栏概况卡 / 仪表盘徽标用
    conflictCount: 0,            // 去重与冲突徽标
    skillDetailName: "",         // 进详情页时带上技能名
    helpOpen: false,             // 技能仓库使用帮助对话框
    helpSection: "",             // 打开时定位到的帮助小节 id
  }),
  getters: {
    isDark: (s) => s.config.theme === "dark",
    moduleOf: () => (key: ModuleKey): ModuleDef => MODULES.find((m) => m.key === key) || MODULES[0],
    /** 左栏模块列表：用户自定义顺序优先，缺失模块按内置默认补尾 */
    orderedModules(s): ModuleDef[] {
      const byKey = new Map(MODULES.map((m) => [m.key, m]));
      return s.config.moduleOrder.map((k) => byKey.get(k)).filter((m): m is ModuleDef => !!m);
    },
    /** 当前模块的子页面 */
    pagesOf(s): PageDef[] {
      return this.moduleOf(s.activeModule).pages;
    },
    /** 子页面徽标：技能仓库的待裁决数走实时数据，其余模块暂用静态 mock 值 */
    pageBadge(s): (pageId: string) => string | undefined {
      return (pageId: string) => {
        if (s.activeModule === "skills" && pageId === "dedup") {
          return s.conflictCount > 0 ? String(s.conflictCount) : undefined;
        }
        return this.moduleOf(s.activeModule).pages.find((p) => p.id === pageId)?.badge;
      };
    },
  },
  actions: {
    async load() {
      try {
        Object.assign(this.config, await api.loadConfig());
      } catch {
        this.config = JSON.parse(JSON.stringify(defaultConfig));
      }
      // 启动默认板块：左栏三大模块自定义排序的第一个（而非固定技能仓库），页面取其第一个子页
      const first = this.orderedModules[0];
      if (first) {
        this.activeModule = first.key;
        this.activePage = first.pages[0].id;
      }
      this.applyTheme(this.config.theme);
      // 只有显式 true 才开（默认关闭）：旧配置无此字段时回落默认关
      this.applyFx(this.config.fx === true);
      this.loaded = true;
      // 工具显示名全局一份；启动即拉取，设置保存后 refreshTools 刷新
      this.toolMeta = (await api.listTools().catch(() => null)) || [];
      if (this.activeModule === "skills") this.refreshSkillsStats();
    },
    async save() {
      try {
        return await api.saveConfig(this.config);
      } catch (e) {
        // 保存失败不抛断：设置弹窗内的表单区有自己的错误展示
        console.warn("配置保存失败", e);
        return { ok: false, message: String((e as Error).message || e) };
      }
    },
    applyTheme(theme: "dark" | "light") {
      this.config.theme = theme;
      document.documentElement.setAttribute("data-theme", theme);
      // Element Plus 的暗色方案认 html.dark，跟应用主题一起切
      document.documentElement.classList.toggle("dark", theme === "dark");
    },
    toggleTheme() {
      this.applyTheme(this.isDark ? "light" : "dark");
      this.save();
    },
    /** 设置弹窗里的外观切换（与侧栏亮暗按钮同源） */
    setTheme(theme: "dark" | "light") {
      if (this.config.theme === theme) return;
      this.applyTheme(theme);
      this.save();
    },
    /** 界面动效开关（仅展示层）的即时应用：html.fx-off 供 CSS 压停装饰动画；
        localStorage 镜像供 main.ts 在配置异步加载前同步判定是否安装液滴光标，
        关闭动效的用户冷启动不闪系统箭头 */
    applyFx(on: boolean) {
      this.config.fx = on;
      document.documentElement.classList.toggle("fx-off", !on);
      try {
        localStorage.setItem("agenthub.fx", on ? "1" : "0");
      } catch {
        /* 镜像写不进只影响下次冷启动首帧，不碍事 */
      }
    },
    /** 设置弹窗里的动效切换：即时生效并落盘 */
    setFx(on: boolean) {
      if (this.config.fx === on) return;
      this.applyFx(on);
      this.save();
    },
    /** 打开全局设置弹窗：tab 缺省保持当前模块；左下角齿轮给 general，跨模块入口给 webdav 等 */
    openSettings(tab?: SettingsTab) {
      if (tab) this.settingsTab = tab;
      this.settingsOpen = true;
    },
    closeSettings() {
      this.settingsOpen = false;
    },
    /** 右上「配置」按钮：切到当前模块的配置页（与左侧 tab 同一套页面切换逻辑，记住来时页） */
    openModuleConfig() {
      if (this.activePage === "config") return;
      this.pageBeforeConfig = this.activePage;
      this.settingsOpen = false;
      this.activePage = "config";
    },
    /** 配置页点「完成」：回到进配置前的子页面（来路失效则回模块第一页） */
    closeModuleConfig() {
      const pages = this.moduleOf(this.activeModule).pages;
      const back = this.pageBeforeConfig && pages.some((p) => p.id === this.pageBeforeConfig) ? this.pageBeforeConfig : pages[0].id;
      this.pageBeforeConfig = "";
      this.activePage = back;
    },
    /** 切换大模块：默认进入其第一个子页面；点模块卡 = 离开设置弹窗与配置页 */
    selectModule(key: ModuleKey) {
      this.settingsOpen = false;
      this.pageBeforeConfig = "";
      if (this.activeModule === key) return;
      this.activeModule = key;
      this.activePage = this.moduleOf(key).pages[0].id;
      // 进技能仓库时刷新概况/徽标数据（异步不阻塞切换）
      if (key === "skills") this.refreshSkillsStats();
    },
    setPage(id: string) {
      this.settingsOpen = false;
      this.activePage = id;
    },
    /** 技能仓库模块内跳转（各技能页面里的「去同步 / 去裁决 / 返回技能库」都用它） */
    go(page: SkillsPageId) {
      this.settingsOpen = false;
      this.activeModule = "skills";
      this.activePage = page;
    },
    /** 从技能库卡片进详情页 */
    openSkillDetail(name: string) {
      this.skillDetailName = name;
      this.settingsOpen = false;
      this.activeModule = "skills";
      this.activePage = "skill-detail";
    },
    showHelp(section = "") {
      this.helpSection = section;
      this.helpOpen = true;
    },
    /** 模块排序：采用「设置 · 个性化」里算好的完整顺序并落盘 */
    async setModuleOrder(order: ModuleKey[]) {
      if (order.join() === this.config.moduleOrder.join()) return;
      this.config.moduleOrder = order;
      await this.save();
    },
    /** 刷新技能仓库概况（去重与冲突徽标数据源），失败静默保留旧值。
     *  只读冲突 JSON，不触发 get_overview 的全量扫描+逐技能哈希（那是仪表盘页的按需动作，
     *  侧栏切模块就全量哈希会把 UI 拖卡） */
    async refreshSkillsStats() {
      const conflicts = await api.listConflicts().catch(() => null);
      if (Array.isArray(conflicts)) this.conflictCount = conflicts.length;
    },
    /** 设置弹窗保存完工具配置后调用，立即刷新全站的工具显示名 */
    async refreshTools() {
      this.toolMeta = (await api.listTools().catch(() => [])) || [];
    },
    /** 拉一次更新状态维护红点（启动兜底；此后由 App.vue 的 update:event 回流实时增减） */
    async refreshUpdateStatus() {
      try {
        const st = await api.getUpdateStatus();
        this.updateAvailable = st.status === "available" || st.status === "downloaded";
      } catch {
        /* 取不到就保旧值（浏览器预览走 mock） */
      }
    },
    toolName(id: string): string {
      const t = this.toolMeta.find((x) => x.id === id);
      return t?.name || id;
    },
    toolIcon(id: string): string {
      const t = this.toolMeta.find((x) => x.id === id);
      return t?.icon || "ph-folder-open";
    },
  },
});

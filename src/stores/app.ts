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
// 应用级状态：配置（主题 / 模块顺序 + 技能仓库配置）、当前模块与子页面、技能仓库全局数据
import { defineStore } from "pinia";
import { MODULES } from "../types";
import { moduleEnabled } from "../api/caps";
import type { AppConfig, SettingsTab, ModuleDef, ModuleKey, PageDef, Overview, ToolRow } from "../types";
// 提示词库默认值：单一事实源在 types（配置页从 promptTypes re-export 拿同一份），
// 这里只做「后端缺字段 / 浏览器 mock」时的深合并基线
import { PROMPTS_CONFIG_DEFAULTS, LOCALGW_CONFIG_DEFAULTS } from "../types";
import * as api from "../api/ipc";

/** 递归合并：以 base 为基线补全 patch 缺失的嵌套字段；数组与原始值一律整体取 patch（有则覆盖）。
 *  用途：后端返回的配置一旦缺某个嵌套字段（旧版后端 / 字段重命名 / mock 未同步），浅合并会让
 *  模板访问形如 proxy.poolsyncSchedule 时直接抛错白屏——这里保证任何层级都有 defaultConfig 兜底。 */
function mergeConfigDeep<T>(base: T, patch: unknown): T {
  if (Array.isArray(base) || Array.isArray(patch)) return (patch === undefined ? base : (patch as T));
  if (base && typeof base === "object" && patch && typeof patch === "object") {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const key of Object.keys(patch as Record<string, unknown>)) {
      out[key] = mergeConfigDeep((base as Record<string, unknown>)[key], (patch as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return patch === undefined ? base : (patch as T);
}

// 浏览器 mock / 后端加载失败时的兜底默认值；后端权威默认值见 electron/backend/config.cjs
const defaultConfig: AppConfig = {
  theme: "dark",
  // 动效默认开启（装饰层默认体验）；粒子尘场 / 光池追随默认关闭（背景层最吃性能的两项），
  // 个性化鼠标样式默认开启（轻量；保持老用户升级后液滴光标不断档）
  fx: true,
  fxParticles: false,
  fxPools: false,
  fxCursor: true,
  // moduleOrder 直接由 MODULES 派生：MODULES 里新增板块（如 prompts）时这里自动带上，
  // 不需要再手工补一份顺序，避免两处清单不同步导致新板块在左栏「不存在」
  moduleOrder: MODULES.map((m) => m.key),
  modules: { skills: { enabled: true }, sync: { enabled: true }, proxy: { enabled: true }, memory: { enabled: true }, prompts: { enabled: true }, localgw: { enabled: true } },
  tools: {},
  customDirs: [],
  mountMode: "junction",
  l3: { enabled: false, threshold: 0.85 },
  trashDays: 7,
  update: { channel: "stable", autoCheck: true, notifiedVersion: "" },
  webdav: { endpoint: "", username: "", password: "", root: "/agent-skills", deviceId: "", deviceName: "" },
  schedule: { minimizeToTray: true, shortcutToggle: "Alt+`", lightweightMode: false, autoStart: false, hourly: false, daily: false, dailyTime: "09:00", notifyOnSuccess: false },
  watch: { enabled: true, intervalSeconds: 15 },
  // 反代网关设置兜底（权威默认值见 electron/backend/config.cjs）
  proxy: {
    port: 9527,
    bind: "127.0.0.1",
    restoreOnLaunch: false,
    routeStrategy: "smart",
    fixedChannel: "trae",
    routeOrder: "score",
    rateLimitPerMin: 120,
    concurrency: 8,
    creditsRefreshMin: 30,
    usageRetentionDays: 90,
    expiringSoonDays: 1,
    poolsyncSchedule: { hourly: false, hourlyInterval: 6, daily: false, dailyTime: "04:00" },
    debugStatus: false,
    modelOverrides: {},
    humanizeJitter: true,
    disabledModels: [],
    modelFallback: {},
    modelAliases: {},
    modelReverseAliases: {},
    modelCustom: {},
    autoFallbackEnabled: true,
    checkinAutoRules: {},
    fallbackModel: "",
    channelFailover: true,
    channelFailoverMax: 3,
    channelCooldownMs: 120000,
    channelCooldownCapMs: 900000,
    channelEnabled: {},
    ccSwitchModel: "",
  },
  // 记忆中枢指针（其余配置在 <仓库>/config/memory.config.json，由 memory 模块页读取）
  memory: { enabled: true, rootDir: "" },
  // 提示词库（配置与技能仓库/号池同源，走 app.save() 落 framework config.json）。
  // 深合并基线里必须有这一段：后端还没补 prompts 段时，配置页读 app.config.prompts.syncIntervalHours
  // 才不会因 undefined 直接抛错白屏
  prompts: { ...PROMPTS_CONFIG_DEFAULTS },
  // 本地网关：新增第五板块，深合并基线里必须有这一段（与 prompts 同款理由）。
  // 必须深拷贝：LOCALGW_CONFIG_DEFAULTS 里 security / routing / models / providers 是四层嵌套对象，
  // 浅展开会让「导出的默认值常量」与 defaultConfig、store.state 共用同一批子对象 ——
  // 配置页一次 Object.assign 写回（ConfigLocalgwSection 的 patch）就会把默认值常量本身改掉，
  // 此后任何走 defaultConfig 兜底的路径（load 失败回退 / 浏览器 mock）读到的都是被改脏的值。
  localgw: structuredClone(LOCALGW_CONFIG_DEFAULTS),
};

/** 技能仓库内的页面 id（skill-detail 为隐藏详情页，不进横条菜单，由技能库卡片进入） */
export type SkillsPageId = "dashboard" | "library" | "skill-detail" | "sync" | "webdav" | "dedup";

/** 动效开关的 localStorage 镜像：main.ts 在配置异步加载前靠它同步判定首帧状态
    （写不进只影响下次冷启动首帧，不碍事） */
function mirrorFx(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* 私隐模式等场景写不进：忽略 */
  }
}

// ===== 界面位置镜像（轻量模式必需）=====
// 轻量模式关窗时会销毁整个渲染进程，Pinia 里的 activeModule/activePage 随之丢失。
// 若不落盘，用户每次唤回界面都会回到默认页 —— 等于轻量化把"我刚才在看哪"清一次。
// 用 localStorage 而非新增 IPC：与动效镜像同款做法，渲染层自己记住即可，
// 不必让主进程参与，Web/容器端（NAS）也不受影响。
const PAGE_MIRROR_KEY = "agenthub.lastPage";

function mirrorPage(moduleKey: string, pageId: string) {
  try {
    localStorage.setItem(PAGE_MIRROR_KEY, JSON.stringify({ module: moduleKey, id: pageId }));
  } catch {
    /* 写不进只影响下次恢复位置：忽略 */
  }
}

function readMirroredPage(): { module: string; id: string } | null {
  try {
    const raw = localStorage.getItem(PAGE_MIRROR_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && typeof v.module === "string" && typeof v.id === "string") {
      return { module: v.module, id: v.id };
    }
  } catch {
    /* 解析失败按没有处理 */
  }
  return null;
}

export const useAppStore = defineStore("app", {
  state: () => ({
    config: { ...defaultConfig } as AppConfig,
    loaded: false,
    // 首帧的默认位置：**必须同源**取 MODULES[0]，不能一处写死 "skills"、另一处取 MODULES[0]。
    // 内置顺序调整（用量统计打头）后，写死的 "skills" 会与 MODULES[0].pages[0]（"overview"）
    // 配成一对不存在的组合 —— 首帧主区空白，且会命中 App.vue 的「页面不存在」兜底卡。
    // config 异步加载完成后 loadConfig() 会按用户顺序再定一次，这里只是加载前那一两帧的基线。
    activeModule: MODULES[0].key,
    activePage: MODULES[0].pages[0].id,
    // ===== 全局设置弹窗（左下角设置按钮）：通用 / WebDAV 同步 / 数据与备份 =====
    settingsOpen: false,
    settingsTab: "general" as SettingsTab,
    /** 更新通知 / 托盘「发现新版本」跳转信号：自增计数，「检查更新」页据此滚动并高亮更新卡片 */
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
    // ===== 记忆中枢：页签显隐白名单（由 memory store 的 loadAll 从 cfg["ui.tabs"] 写回）=====
    /** 空数组 = 未加载/未配置，pagesOf 兜底为默认 8 个（dashboard/browse/projects/profile/agents/auto/import/sync） */
    memoryTabs: [] as string[],
    /** 记忆中枢「接入与迁移」页内段落落点（"agents" | "import" | "sync"）：入口带过来，HubView 消费后清空 */
    hubSubHint: "",
    // ===== 外置插件：已安装插件清单（侧栏入口与设置板块的唯一数据源）=====
    plugins: [] as api.PluginInfo[],
    /** 主区域正在内嵌的插件页；null = 显示普通模块页面 */
    pluginView: null as { id: string; url: string; title: string } | null,
  }),
  getters: {
    isDark: (s) => s.config.theme === "dark",
    moduleOf: () => (key: ModuleKey): ModuleDef => MODULES.find((m) => m.key === key) || MODULES[0],
    /** 左栏模块列表：用户自定义顺序优先，缺失模块按内置默认补尾；
     *  附 enabled 标志（issue #91）：关闭的板块左上角置灰不可点；
     *  Web 托管形态按服务端能力清单裁剪（容器版只有 proxy），桌面全量 */
    orderedModules(s): (ModuleDef & { enabled: boolean })[] {
      const byKey = new Map(MODULES.map((m) => [m.key, m]));
      // 只按 moduleOrder 映射取模块是不够的：moduleOrder 是「用户顺序」的持久化快照，
      // 一旦它缺某个 key（老配置没写过新板块、后端 normalizeModuleOrder 归一化、
      // Web 托管形态下发的是旧清单、将来新增第七板块），该板块就从左栏凭空消失且没有任何提示。
      // 与 electron/backend/config.cjs 的 normalizeModuleOrder()「缺失模块按默认顺序补尾」
      // 保持对称：先按用户顺序取，再把 MODULES 里没被覆盖的 key 按内置顺序补到末尾。
      const order = [...s.config.moduleOrder, ...MODULES.map((m) => m.key).filter((k) => !s.config.moduleOrder.includes(k))];
      return order.map((k) => byKey.get(k)).filter((m): m is ModuleDef => !!m)
        .filter((m) => moduleEnabled(m.key))
        .map((m) => ({ ...m, enabled: !s.config.modules?.[m.key] || s.config.modules[m.key].enabled !== false }));
    },
    /** 当前模块的子页面：memory 模块按 ui.tabs 白名单过滤（空=默认核心页；dashboard/browse 保底），其余模块全量返回 */
    pagesOf(s): PageDef[] {
      const all = this.moduleOf(s.activeModule).pages;
      if (s.activeModule !== "memory") return all;
      // 默认核心页：接入/导入/同步三段已并入 hub；老配置显式勾选 agents/import/sync 的仍照常显示
      const DEFAULT_TABS = ["dashboard", "browse", "projects", "profile", "hub", "auto"];
      const allow = new Set(s.memoryTabs.length ? s.memoryTabs : DEFAULT_TABS);
      allow.add("dashboard");
      allow.add("browse");
      return all.filter((p) => allow.has(p.id));
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
    /** 外置插件状态：安装/卸载/启停后都要重拉，侧栏入口据此显隐。
     *  失败一律归零——插件不可用绝不能影响主程序启动。 */
    async refreshPlugins() {
      try {
        const list = await api.pluginList();
        this.plugins = Array.isArray(list) ? list : [];
      } catch { this.plugins = []; }
      // 插件被停用/卸载时，正在内嵌的页面要跟着关掉
      if (this.pluginView) {
        const cur = this.plugins.find((p) => p.id === this.pluginView!.id);
        if (!cur || !cur.installed || cur.invalid || !cur.running) this.pluginView = null;
      }
    },
    /** 打开插件页：优先内嵌主区域；插件声明 ui.embed:false 或取地址失败时返回错误，由调用方回落独立窗口 */
    async openPluginView(id: string) {
      try {
        const r = await api.pluginEmbed(id);
        if (!r || !r.ok || !r.url) return { ok: false, message: (r && r.message) || "打开失败" };
        this.settingsOpen = false;
        this.pluginView = { id: r.id || id, url: r.url, title: r.title || id };
        this.refreshPlugins();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    closePluginView() { this.pluginView = null; },
    /** 板块开关切换（issue #91）：走主进程唯一写入口，成功后同步内存态供 UI 即时置灰。
     *  必须是 action 不能是 getter——Pinia getter 会被立即求值，函数值会被提前调用炸掉 */
    async toggleModule(key: string, enabled: boolean) {
      const r = await api.moduleToggle(key, enabled);
      if (r && r.ok) {
        const mods = this.config.modules as Record<string, { enabled: boolean }> | undefined;
        if (mods && mods[key]) mods[key].enabled = enabled;
      }
      return r;
    },
    async load() {
      try {
        // 深合并而非 Object.assign（浅合并会把 proxy 等嵌套对象整体替换，后端一旦缺字段即白屏）
        const remote = await api.loadConfig();
        Object.assign(this.config, mergeConfigDeep(structuredClone(defaultConfig), remote));
      } catch {
        this.config = JSON.parse(JSON.stringify(defaultConfig));
      }
      // 启动默认板块：左栏模块自定义排序的第一个【已启用】板块（关闭的板块置灰不可选），
      // 页面取其第一个子页；全部未启用时回落第一个（后端 module_toggle 有「至少留一个」守卫）
      const first = this.orderedModules.find((m) => m.enabled) || this.orderedModules[0];
      if (first) {
        this.activeModule = first.key;
        this.activePage = first.pages[0].id;
      }
      // 恢复上次停留的页面（轻量模式销毁界面后唤回时，用户应回到原处而不是默认页）。
      // 只在模块与页面都仍然合法时恢复 —— 记忆页签白名单会变、模块顺序也可能被改过，
      // 失效就静默回落到上面的默认位置。
      const mirrored = readMirroredPage();
      if (mirrored) {
        const mod = this.orderedModules.find((m) => m.key === mirrored.module);
        if (mod && this.moduleOf(mod.key).pages.some((p) => p.id === mirrored.id)) {
          this.activeModule = mod.key;
          this.activePage = mirrored.id;
        }
      }
      this.applyTheme(this.config.theme);
      // 界面动效默认开启：只有显式存的 false 才关（旧配置无此字段时跟随新默认）；
      // 粒子 / 光池默认关、显式 true 才开；鼠标样式默认开、显式 false 才关
      this.applyFx(this.config.fx !== false);
      this.applyFxParticles(this.config.fxParticles === true);
      this.applyFxPools(this.config.fxPools === true);
      this.applyFxCursor(this.config.fxCursor !== false);
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
    /** 界面动效总开关（仅展示层）的即时应用：html.fx-off 供 CSS 压停装饰动画；
        localStorage 镜像供 main.ts 在配置异步加载前同步判定是否安装液滴光标，
        关闭动效的用户冷启动不闪系统箭头 */
    applyFx(on: boolean) {
      this.config.fx = on;
      document.documentElement.classList.toggle("fx-off", !on);
      mirrorFx("agenthub.fx", on);
    },
    /** 设置弹窗里的动效切换：即时生效并落盘 */
    setFx(on: boolean) {
      if (this.config.fx === on) return;
      this.applyFx(on);
      this.save();
    },
    /** 粒子尘场子开关（与光池互相独立）：html.fx-particles-off 隐藏画布层，
        防止关闭后最后一帧尘粒定格在屏上 */
    applyFxParticles(on: boolean) {
      this.config.fxParticles = on;
      document.documentElement.classList.toggle("fx-particles-off", !on);
      mirrorFx("agenthub.fxParticles", on);
    },
    setFxParticles(on: boolean) {
      if (this.config.fxParticles === on) return;
      this.applyFxParticles(on);
      this.save();
    },
    /** 光池追随子开关（与粒子、鼠标样式互相独立）：一类是鼠标互动光影——
        光池、玻璃反光、卡片聚光、背景光标视差；html.fx-pools-off 隐藏相关图层 */
    applyFxPools(on: boolean) {
      this.config.fxPools = on;
      document.documentElement.classList.toggle("fx-pools-off", !on);
      mirrorFx("agenthub.fxPools", on);
    },
    setFxPools(on: boolean) {
      if (this.config.fxPools === on) return;
      this.applyFxPools(on);
      this.save();
    },
    /** 个性化鼠标样式子开关（液滴光标 + 点击涟漪，默认开启）：只写配置与镜像，
        DOM 侧由 App.vue 的 watch 调 setCursorFX 装卸（与总开关联动） */
    applyFxCursor(on: boolean) {
      this.config.fxCursor = on;
      mirrorFx("agenthub.fxCursor", on);
    },
    setFxCursor(on: boolean) {
      if (this.config.fxCursor === on) return;
      this.applyFxCursor(on);
      this.save();
    },
    /** 把当前停留位置写进 localStorage 镜像（轻量模式销毁界面后唤回时据此恢复）。
     *  由 App.vue 的「loaded + 当前位置」watcher 调用，故只在配置加载完成、位置已定后记录。 */
    mirrorActivePage() {
      mirrorPage(this.activeModule, this.activePage);
    },
    /** 重拉配置到内存快照：main 侧托盘等直写配置后经 app:event 广播，渲染层据此刷新。
     *  与 load() 的区别：不动 activeModule/activePage（重拉不能把用户从当前页拽走）。 */
    async refreshConfig() {
      try {
        const remote = await api.loadConfig();
        Object.assign(this.config, mergeConfigDeep(structuredClone(defaultConfig), remote));
      } catch {
        /* 拉取失败保留当前快照 */
      }
      this.applyTheme(this.config.theme);
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
      // 切模块即离开插件页面（插件页面不属于任何模块）
      this.pluginView = null;
      // 已停用的板块置灰不可点（issue #91）：入口拦在切换处，避免渲染层绕过
      if (this.config.modules?.[key] && this.config.modules[key].enabled === false) return;
      if (this.activeModule === key) return;
      this.activeModule = key;
      this.activePage = this.moduleOf(key).pages[0].id;
      // 进技能仓库时刷新概况/徽标数据（异步不阻塞切换）
      if (key === "skills") this.refreshSkillsStats();
    },
    setPage(id: string) {
      this.settingsOpen = false;
      // 点模块页签即离开插件页面
      this.pluginView = null;
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

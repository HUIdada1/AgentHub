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
// 用量数据状态：总览摘要、设备、趋势、热力图、明细
import { defineStore } from "pinia";
import type { DeviceBreakdown, DeviceMeta, Summary, UsageRecord } from "../types/sync";
import * as api from "../api/sync";
import { useSyncStore } from "./sync";

/** 热力图行：total/费用 + 命中率（后端按缓存口径算好，null = 取不到）与调用次数的分项字段（后端 get_heatmap 返回） */
export interface HeatmapRow {
  date: string;
  total: number;
  cost?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheHitRate?: number | null; // 当日缓存命中率（0~1）；null = 无缓存口径数据，DayModal 显示「-」
  cacheInputTokens?: number; // 命中率分母（口径值，只含缓存口径可得的来源）
  credits?: number; // 额度点（Qoder / Antigravity 系官方模型；不是 token，不并入 total）
  callCount?: number;
}

/** 热力图时间视图：近一年（滚动 365 天）/ 年（自然年 + 年度选择器） */
export type HeatmapMode = "recent" | "year";

let trendRequestId = 0;
let overviewRequestId = 0;
let heatmapRequestId = 0;
let recordsRequestId = 0;

/** 本地日期键（YYYY-MM-DD，与后端 todayStartMs 同一本地时区口径） */
export function localDayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 热力图渲染窗口（Date 版，组件画格子用）：
 *  · 近一年 = 今天往前 364 天 → 今天（滚动窗口，最右侧恒为今天，与改版前一致）
 *  · 年     = 所选自然年 1 月 1 日 → 12 月 31 日；选到今年时截到「今天」，不出现未来空格子
 */
export function heatmapDayRange(mode: HeatmapMode, year: number, now = new Date()): { start: Date; end: Date } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (mode === "year") {
    const start = new Date(year, 0, 1);
    const last = new Date(year, 11, 31);
    const end = last.getTime() > today.getTime() ? today : last;
    return { start, end: end.getTime() < start.getTime() ? start : end };
  }
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  return { start, end: today };
}

/**
 * 热力图取数窗口（日期串版，store 请求后端用）：
 *  · 近一年 = 今天往前 364 天 → 今天
 *  · 年     = 所选自然年 1 月 1 日 → 12 月 31 日（整年请求键稳定、便于后端聚合缓存；
 *              当年后端只会返回有数据的日期，渲染截到今天由 heatmapDayRange 负责）
 */
export function heatmapWindow(mode: HeatmapMode, year: number): { start: string; end: string } {
  if (mode === "year") return { start: `${year}-01-01`, end: `${year}-12-31` };
  const { start, end } = heatmapDayRange(mode, year);
  return { start: localDayKey(start), end: localDayKey(end) };
}

let dayTicker = 0;
let lastDayKey = "";

export const useUsageStore = defineStore("usage", {
  state: () => ({
    summary: null as Summary | null,
    devices: [] as DeviceMeta[],
    deviceBreakdowns: [] as DeviceBreakdown[],
    trend: [] as { date: string; total: number; models?: Record<string, number>; cacheHitRate?: number | null }[],
    heatmap: [] as HeatmapRow[],
    records: [] as UsageRecord[],
    recordsTotal: 0,
    loading: false,
    loadError: "",
    recordsError: "", // 明细页专用错误：与总览/趋势错误分离，避免跨页串扰
    trendDays: 7, // 趋势图当前范围（天），默认「近七天」
    trendDay: null as string | null, // 趋势图单日模式：选中某天（YYYY-MM-DD）时按小时展示，null 回落近 N 天
    heatmapMode: "recent" as HeatmapMode, // 热力图时间视图：近一年（滚动）/ 年（自然年）
    heatmapYear: new Date().getFullYear(), // 「年」视图的年度选择器，默认今年
    selectedDeviceId: null as string | null, // null 表示查看全部电脑数据
  }),
  getters: {
    selectedDevice: (s) => (s.selectedDeviceId ? s.devices.find((d) => d.deviceId === s.selectedDeviceId) : undefined),
    isFiltered: (s) => s.selectedDeviceId !== null,
  },
  actions: {
    resetOverview() {
      overviewRequestId++;
      this.summary = null;
      this.devices = [];
      this.deviceBreakdowns = [];
      this.trend = [];
      this.trendDay = null;
      this.heatmap = [];
      this.selectedDeviceId = null;
      this.loadError = "";
      this.loading = false;
    },
    /** 后台本地统计完成事件：静默重拉总览（未在途时）。在途请求自带新数据时跳过，失败保留旧数据 */
    refreshQuietly() {
      if (this.loading) return;
      void this.loadOverview();
    },
    /**
     * 跨天换日守护：口径里的「今日 / 本月」在本地 0 点整体翻转，界面不重取就会一直停在昨天
     * （原先只有切页触发重载，停在页面上过夜看到的是昨天数字）。
     * 用每分钟心跳 + 窗口聚焦双检查，而不是精确定时到 0 点：系统休眠、时钟调整、跨时区后
     * 都能在一个检查周期内自然纠正。跨天只重拉总览即可覆盖各页的今日/本月口径
     * （计费页的本月卡片与命中率都读 summary）；从未加载过总览时不动作，避免白占主进程。
     */
    startDayWatcher() {
      if (dayTicker) return;
      const check = () => {
        const today = localDayKey();
        if (!lastDayKey) { lastDayKey = today; return; } // 首次只登记基线
        if (today === lastDayKey) return;
        lastDayKey = today;
        if (this.summary) this.refreshQuietly();
      };
      check();
      dayTicker = window.setInterval(check, 60000);
      window.addEventListener("focus", check);
    },
    async loadOverview() {
      const app = useSyncStore();
      const mode = app.totalMode;
      const deviceId = this.selectedDeviceId;
      const source = app.querySource;
      const requestId = ++overviewRequestId;
      const trendDaysAtCall = this.trendDays;
      // 热力图窗口按当前视图（近一年 / 所选自然年）取；序号用于丢弃切视图后在途的旧响应
      const heatmapSeqAtCall = ++heatmapRequestId;
      const heatmapWin = heatmapWindow(this.heatmapMode, this.heatmapYear);
      this.loading = true;
      try {
        const [summary, devices, deviceBreakdowns, trend, heatmap] = await Promise.all([
          api.getSummary(mode, deviceId, source),
          api.getDevices(mode, source),
          api.getDeviceBreakdowns(mode, deviceId, source),
          api.getTrend(mode, this.trendDays, deviceId, source, this.trendDay),
          api.getHeatmap(mode, heatmapWin.start, heatmapWin.end, deviceId, source),
        ]);
        if (requestId !== overviewRequestId) return;
        this.summary = summary;
        this.devices = devices;
        this.deviceBreakdowns = deviceBreakdowns;
        // 用户在本请求在途期间可能已通过 loadTrend 切换了天数：此时 overview
        // 带回的是旧天数数据，写回会造成「标签 30 天 / 数据 7 天」错位，直接丢弃
        if (trendDaysAtCall === this.trendDays) this.trend = trend;
        // 同理：在途期间切过热力图视图/年度时，这份旧窗口数据不得写回
        if (heatmapSeqAtCall === heatmapRequestId) this.heatmap = heatmap;
        this.loadError = "";
      } catch (e) {
        // 单次查询失败时保留旧数据并给出可见提示，避免切换设备后「看似没反应」
        if (requestId === overviewRequestId) this.loadError = e instanceof Error ? e.message : "总览数据加载失败";
      } finally {
        if (requestId === overviewRequestId) this.loading = false;
      }
    },
    /** 热力图单独取数：切「近一年 / 年」或年度时只刷这张卡，不牵动总览其余卡片 */
    async loadHeatmap() {
      const app = useSyncStore();
      const win = heatmapWindow(this.heatmapMode, this.heatmapYear);
      const requestId = ++heatmapRequestId;
      try {
        const rows = await api.getHeatmap(app.totalMode, win.start, win.end, this.selectedDeviceId, app.querySource);
        if (requestId !== heatmapRequestId) return; // 快速连切时旧响应不覆盖新视图
        this.heatmap = rows;
        this.loadError = "";
      } catch (e) {
        if (requestId === heatmapRequestId) this.loadError = e instanceof Error ? e.message : "热力图数据加载失败";
      }
    },
    /** 切换热力图时间视图：近一年（滚动 365 天）/ 年（自然年，配合年度选择器，默认今年） */
    async setHeatmapMode(mode: HeatmapMode) {
      if (this.heatmapMode === mode) return;
      this.heatmapMode = mode;
      await this.loadHeatmap();
    },
    /** 切换热力图「年」视图的年度；只允许到今年（未来年份由选择器禁用兜底） */
    async setHeatmapYear(year: number) {
      const y = Math.trunc(year);
      if (!Number.isFinite(y) || y <= 0 || y > new Date().getFullYear()) return;
      if (this.heatmapYear === y) return;
      this.heatmapYear = y;
      if (this.heatmapMode === "year") await this.loadHeatmap();
    },
    async selectDevice(deviceId: string | null) {
      // 点击即选中；取消选择走「全部电脑」或横幅「查看全部」按钮，避免二次点击误取消
      this.selectedDeviceId = deviceId;
      await this.loadOverview();
    },
    /** 刷新设备列表（明细页设备下拉独立于总览加载数据时使用）；失败保留旧列表 */
    async refreshDevices() {
      const app = useSyncStore();
      try {
        this.devices = await api.getDevices(app.totalMode, app.querySource);
      } catch {
        /* 保留旧设备列表，避免下拉突然清空 */
      }
    },
    async setDevice(deviceId: string | null) {
      this.selectedDeviceId = deviceId;
      await this.loadOverview();
    },
    async loadTrend(days: number) {
      const app = useSyncStore();
      this.trendDays = days;
      const requestId = ++trendRequestId;
      try {
        const next = await api.getTrend(app.totalMode, days, this.selectedDeviceId, app.querySource, this.trendDay);
        if (requestId === trendRequestId) {
          this.trend = next;
          this.loadError = ""; // 成功后清掉此前失败留下的提示
        }
      } catch (e) {
        // 保留旧趋势数据并给出可见提示，避免切换天数后图表「看似没反应」
        if (requestId === trendRequestId) this.loadError = e instanceof Error ? e.message : "趋势数据加载失败";
      }
    },
    /** 单日模式：选中某天按小时展示该天趋势；清空（null）回落近七天 */
    async setTrendDay(date: string | null) {
      this.trendDay = date;
      if (!date) this.trendDays = 7; // 清空日期强制回到近七天（需求口径，而非回到上次选中的范围）
      await this.loadTrend(date ? 1 : this.trendDays);
    },
    async loadRecords(filter: Parameters<typeof api.getRecords>[0]) {
      // 竞态防护：快速连切筛选/翻页时旧响应不得覆盖新筛选的结果
      const requestId = ++recordsRequestId;
      try {
        const res = await api.getRecords(filter);
        if (requestId !== recordsRequestId) return;
        this.records = res.records;
        this.recordsTotal = res.total;
        this.recordsError = "";
      } catch (e) {
        if (requestId === recordsRequestId) this.recordsError = e instanceof Error ? e.message : "明细数据加载失败";
      }
    },
  },
});

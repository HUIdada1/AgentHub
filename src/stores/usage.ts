// 用量数据状态：总览摘要、设备、趋势、热力图、聚合、明细
import { defineStore } from "pinia";
import type { AggregateRow, DeviceBreakdown, DeviceMeta, Summary, UsageRecord } from "../types/sync";
import * as api from "../api/sync";
import { useSyncStore } from "./sync";

/** 热力图行：total/费用 + 命中率（cacheRead/input）与调用次数的分项字段（后端 get_heatmap 返回） */
export interface HeatmapRow {
  date: string;
  total: number;
  cost?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  callCount?: number;
}

let trendRequestId = 0;
let overviewRequestId = 0;
let recordsRequestId = 0;

/** 本地日期键（YYYY-MM-DD，与后端 todayStartMs 同一本地时区口径） */
export function localDayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let dayTicker = 0;
let lastDayKey = "";

export const useUsageStore = defineStore("usage", {
  state: () => ({
    summary: null as Summary | null,
    devices: [] as DeviceMeta[],
    deviceBreakdowns: [] as DeviceBreakdown[],
    trend: [] as { date: string; total: number; models?: Record<string, number>; cacheHitRate?: number }[],
    heatmap: [] as HeatmapRow[],
    aggregate: [] as AggregateRow[],
    records: [] as UsageRecord[],
    recordsTotal: 0,
    loading: false,
    loadError: "",
    recordsError: "", // 明细页专用错误：与总览/趋势错误分离，避免跨页串扰
    trendDays: 7, // 趋势图当前范围（天），默认「近七天」
    trendDay: null as string | null, // 趋势图单日模式：选中某天（YYYY-MM-DD）时按小时展示，null 回落近 N 天
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
      this.loading = true;
      try {
        // 热力图滚动一年窗口：今天往前 364 天 → 今天（最右侧恒为今天）
        const now = new Date();
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const start = new Date(end);
        start.setDate(start.getDate() - 364);
        const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const [summary, devices, deviceBreakdowns, trend, heatmap] = await Promise.all([
          api.getSummary(mode, deviceId, source),
          api.getDevices(mode, source),
          api.getDeviceBreakdowns(mode, deviceId, source),
          api.getTrend(mode, this.trendDays, deviceId, source, this.trendDay),
          api.getHeatmap(mode, fmt(start), fmt(end), deviceId, source),
        ]);
        if (requestId !== overviewRequestId) return;
        this.summary = summary;
        this.devices = devices;
        this.deviceBreakdowns = deviceBreakdowns;
        // 用户在本请求在途期间可能已通过 loadTrend 切换了天数：此时 overview
        // 带回的是旧天数数据，写回会造成「标签 30 天 / 数据 7 天」错位，直接丢弃
        if (trendDaysAtCall === this.trendDays) this.trend = trend;
        this.heatmap = heatmap;
        this.loadError = "";
      } catch (e) {
        // 单次查询失败时保留旧数据并给出可见提示，避免切换设备后「看似没反应」
        if (requestId === overviewRequestId) this.loadError = e instanceof Error ? e.message : "总览数据加载失败";
      } finally {
        if (requestId === overviewRequestId) this.loading = false;
      }
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
    async loadAggregate(dim: "model" | "provider" | "device" | "source", from: number | null, to: number | null) {
      const app = useSyncStore();
      try {
        this.aggregate = (await api.getAggregate(app.totalMode, dim, from, to, app.querySource)) as AggregateRow[];
        this.loadError = "";
      } catch (e) {
        this.loadError = e instanceof Error ? e.message : "聚合数据加载失败";
      }
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

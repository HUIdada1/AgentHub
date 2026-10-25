<!--
  ============================================================
   作者：沐晖
   日期：2026-10-22
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 左栏三卡片：上 = 品牌；中 = 四大模块切换（独立卡片，可纵向滚动）；下 = 当前模块的总览概况
     概况数据全部来自真实统计：skills 走轻量 IPC（skills_side_stats）、sync 走 usage store、
     proxy 走号池账号与余额统计、memory 走记忆中枢统计 IPC；模块顺序自定义在「设置 · 通用」
     版本 / 署名 / GitHub / 亮暗 / 设置入口统一收在最左下角 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { useAppStore } from "../stores/app";
import { useMemoryStore } from "../stores/memory";
import { useSyncStore } from "../stores/sync";
import { useUsageStore } from "../stores/usage";
import * as syncApi from "../api/sync";
import { formatToken, formatCost, formatInteger, timeAgo } from "../composables/useFormat";
import { fmtBalance, balanceUnit } from "../views/proxy/format";
import { isUnusableChannel } from "../views/proxy/channelHealth";
import type { DeviceMeta } from "../types/sync";
import type { ModuleKey } from "../types";
import * as api from "../api/ipc";
import { coalesceAsync } from "../utils/timing";
import ProxyUpstreamDialog from "./ProxyUpstreamDialog.vue";

const app = useAppStore();
const memStore = useMemoryStore();
const usageApp = useSyncStore();
const usage = useUsageStore();

// ===== 外置插件入口 =====
/** 插件卡统一排在所有内置大板块之后（新装插件只会往下加，不插进大板块中间）；
 *  只要 manifest 声明了 sidebar（label 用作显示名）就出卡片，与安装先后无关 */
const pluginsTail = computed(() => app.plugins.filter((p) => p.installed && !p.invalid && p.sidebar));

/** 打开插件：优先内嵌到主区域；插件声明不内嵌或取地址失败时回落独立窗口 */
async function openPlugin(id: string) {
  const e = await app.openPluginView(id);
  if (e && e.ok) return;
  try {
    const r = await api.pluginOpen(id);
    if (!r || !r.ok) {
      ElMessageBox.alert((r && r.message) || (e && e.message) || "插件启动失败", "外置插件");
      return;
    }
  } finally {
    app.refreshPlugins();
  }
}

// 事件合流：poolsync/credits、memory 写入/索引等事件密集到达时，
// 侧栏卡片的刷新被合并成有节制的几次，不再逐事件打 IPC（事件风暴 → IPC 风暴）
const scheduleProxyRefresh = coalesceAsync(() => Promise.all([refreshProxyMeta(), refreshChannels()]), 800);
const scheduleMemoryRefresh = coalesceAsync(refreshMemoryStats, 800);
// 提示词库的库变更 / 同步进度事件同样密集（一次同步会连发多条 sync-stage），与记忆中枢同款合流
const schedulePromptsRefresh = coalesceAsync(refreshPromptsStats, 800);

// 板块启用态（issue #91）：停用板块的统计 IPC 一律不打（后台已停，打了也没意义）
function modOn(k: string) {
  const mods = app.config.modules as Partial<Record<string, { enabled: boolean }>> | undefined;
  const m = mods?.[k];
  return !m || m.enabled !== false;
}
function refreshStatsForEnabled(only?: string) {
  const want = (k: string) => (only ? only === k : true);
  if (want("proxy") && modOn("proxy")) { refreshProxyMeta(); refreshChannels(); }
  if (want("skills") && modOn("skills")) refreshSkillsStats();
  if (want("memory") && modOn("memory")) refreshMemoryStats();
  if (want("prompts") && modOn("prompts")) refreshPromptsStats();
  if (want("usage") && modOn("usage")) ensureUsageSummary();
}
onMounted(async () => {
  refreshStatsForEnabled();
  // 网关启停/号池同步都经 app:event 广播：侧栏卡片只订阅不轮询。
  // 原来只在切模块时刷一次，本模块内点「启动服务」后卡片会一直停在「网关未启动」
  offProxyEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string; module?: string; enabled?: boolean };
    // 板块开关切换（issue #91）：启用时补一轮该板块统计，停用时不动（卡片由置灰态呈现）
    if (p.event === "module-toggled") {
      if (p.enabled) refreshStatsForEnabled(p.module);
      return;
    }
    if (p.event === "proxy" && (p.type === "status" || p.type === "poolsync" || p.type === "credits")) {
      scheduleProxyRefresh();
      return;
    }
    // 记忆中枢：写入 / 索引 / 桥状态变化时刷新侧栏卡片（实时条数）
    if (p.event === "memory") scheduleMemoryRefresh();
    // 提示词库：库变更（增删改）与同步阶段事件都刷概况卡
    if (p.event === "prompts") schedulePromptsRefresh();
  });
});
let offProxyEvent: (() => void) | undefined;
onUnmounted(() => {
  if (offProxyEvent) offProxyEvent();
  scheduleProxyRefresh.cancel();
  scheduleMemoryRefresh.cancel();
  schedulePromptsRefresh.cancel();
});
// 切模块时刷新对应板块的实时统计（号池可能刚被同步 / 技能刚被收纳 / 用量刚落库）
watch(
  () => app.activeModule,
  (m) => {
    if (m === "proxy") {
      refreshChannels();
      refreshProxyMeta();
    } else if (m === "skills") {
      refreshSkillsStats();
    } else if (m === "sync") {
      ensureUsageSummary(true);
    } else if (m === "memory") {
      refreshMemoryStats();
    } else if (m === "prompts") {
      refreshPromptsStats();
    }
  }
);

// ===== 技能仓库 · 轻量真实统计（manifest / 冲突 / 工具目录一层列表，不做全量哈希） =====
const skillsStats = ref<api.SkillsSideStats | null>(null);
async function refreshSkillsStats() {
  try {
    skillsStats.value = await api.skillsSideStats();
  } catch {
    /* 拉不到保留旧值 */
  }
}

// ===== 号池管家 · 号池概况（账号数 / 在线可用 / 即将到期） =====
const poolAccountCount = ref(0);
const poolOnlineCount = ref(0);
const poolExpiringCount = ref(0);
async function refreshProxyMeta() {
  try {
    const st = await api.proxyStatus();
    poolAccountCount.value = st.accountCount ?? 0;
    poolOnlineCount.value = st.onlineCount ?? 0;
    poolExpiringCount.value = st.expiringSoonCount ?? 0;
  } catch {
    /* 保留旧值 */
  }
}

// ===== 记忆中枢 · 真实概况（条数 / 今日 / 待处理 / 项目 / 已连通 Agent / 索引一致率） =====
type MemoryOverview = {
  enabled: boolean; total: number; today: number; l2: number; projects: number; pending: number;
  agents: number; verifiedAgents: number; consistent: boolean;
  topProjects: { slug: string; name: string; count: number; latest: number }[];
};
const memoryOverview = ref<MemoryOverview | null>(null);
async function refreshMemoryStats() {
  try {
    // 三个查询互不依赖，并发取回；任一失败只降级对应字段，不拖垮整卡
    const [st, stats, projects] = await Promise.all([
      api.memoryStatus(),
      api.memoryStats().catch(() => null),
      api.memoryProjects().catch(() => null),
    ]);
    memoryOverview.value = {
      enabled: st.enabled,
      total: st.index?.rows ?? stats?.total ?? 0,
      today: stats?.today ?? 0,
      l2: stats?.l2 ?? 0,
      projects: stats?.projects ?? (projects ? projects.projects.length : 0),
      pending: stats?.pending ?? 0,
      agents: st.beats.length,
      verifiedAgents: st.verifiedAgents,
      consistent: st.index ? st.index.consistent : true,
      topProjects: (projects ? projects.projects : [])
        .slice()
        .sort((a, b) => (b.latest || 0) - (a.latest || 0))
        .slice(0, 3)
        .map((p) => ({ slug: p.slug, name: p.name, count: p.count, latest: p.latest })),
    };
  } catch {
    /* 模块未启用或未初始化时保留旧值静默降级 */
  }
}

/** 概况行/项目行点击：跳到对应页面（与仪表盘 KPI 的跳转口径一致） */
function gotoMemory(page: string) {
  if (app.activeModule !== "memory" || app.settingsOpen) {
    app.selectModule("memory");
    app.settingsOpen = false;
  }
  app.activePage = page;
}

// ===== 提示词库 · 真实概况（总量 / 本周新增 / 优化产出 / 冲突 / 同步状态） =====
// 两个查询互不依赖，并发取回；同步状态失败只降级「同步」那一行，不影响条数行。
// 冲突数取 stats.conflicts（后端按冲突队列实时算），与 syncStatus.pendingConflicts 同源，
// 这里只认 stats 一份，避免两处数据不同步时卡片与页签红点对不上。
const promptsStats = ref<api.PromptStats | null>(null);
const promptsSync = ref<api.PromptSyncStatus | null>(null);
async function refreshPromptsStats() {
  try {
    const [st, sync] = await Promise.all([
      api.promptsStats(),
      api.promptsSyncStatus().catch(() => null),
    ]);
    promptsStats.value = st?.stats ?? null;
    promptsSync.value = sync?.status ?? null;
  } catch {
    /* 模块未启用 / 后端未注册 prompts 通道时保留旧值静默降级 */
  }
}

/** 提示词库概况行点击：跳到对应页面（与记忆中枢 gotoMemory 同口径） */
function gotoPrompts(page: string) {
  if (app.activeModule !== "prompts" || app.settingsOpen) {
    app.selectModule("prompts");
    app.settingsOpen = false;
  }
  app.setPage(page);
}

/** 同步状态行文案：未配置 > 同步中 > 上次结果，三态互斥，避免同屏出现互相矛盾的两句话 */
const promptsSyncText = computed(() => {
  const s = promptsSync.value;
  if (!s) return "同步状态未知";
  if (!s.configured) return "未配置 WebDAV";
  if (s.running) return s.stageLabel || "同步中";
  if (s.lastError) return `上次失败：${s.lastError}`;
  return s.lastSyncAt ? `上次同步 ${timeAgo(s.lastSyncAt)}` : "尚未同步过";
});

// ===== 用量统计 · 今日费用 / tokens（真实；summary 已由总览页加载过则直接复用） =====
async function ensureUsageSummary(force = false) {
  if (!force && usage.summary) return;
  if (usage.loading) return;
  await usage.loadOverview().catch(() => {});
}
const syncTodayCost = computed(() => usage.summary?.todayCost ?? null);
const syncTodayTokens = computed(() => usage.summary?.todayTokens ?? 0);
const billingOn = computed(() => !!usageApp.config.billing?.enabled);
const currency = computed(() => usageApp.config.billing?.displayCurrency || "CNY");

// ===== 模块卡片的运行状态与统计（全部真实数据，无 mock） =====
const MODULE_META = computed<Record<ModuleKey, { state: string; level: "ok" | "warn"; stats: { v: string; label: string; unit?: string }[] }>>(() => {
  const sk = skillsStats.value;
  const syncStats: { v: string; label: string; unit?: string }[] = [
    { v: String(usage.devices.length), label: "机器", unit: "台" },
  ];
  if (billingOn.value && syncTodayCost.value !== null) {
    syncStats.push({ v: formatCost(syncTodayCost.value, 2, currency.value), label: "今日费用" });
  }
  syncStats.push({ v: formatToken(syncTodayTokens.value), label: "今日 tokens" });
  return {
    skills: {
      state: sk && sk.pendingConflicts > 0 ? `${sk.pendingConflicts} 冲突待裁决` : "运行中",
      level: sk && sk.pendingConflicts > 0 ? "warn" : "ok",
      stats: [
        { v: sk ? String(sk.skillCount) : "-", label: "已收纳", unit: "个" },
        { v: sk ? String(sk.pendingConflicts) : "-", label: "待裁决", unit: "个" },
        { v: sk ? String(sk.toolCount) : "-", label: "接入工具", unit: "个" },
      ],
    },
    sync: {
      state: usage.loadError ? "加载失败" : "已同步",
      level: usage.loadError ? "warn" : "ok",
      stats: syncStats,
    },
    proxy: {
      state: poolAccountCount.value ? `${poolOnlineCount.value}/${poolAccountCount.value} 个账号可用` : "尚未接入账号",
      level: poolOnlineCount.value > 0 ? "ok" : "warn",
      stats: [
        { v: String(poolAccountCount.value), label: "账号", unit: "个" },
        { v: String(poolOnlineCount.value), label: "在线", unit: "个" },
        { v: String(poolExpiringCount.value), label: "即将到期", unit: "个" },
      ],
    },
    memory: {
      state: !memoryOverview.value
        ? "未启用"
        : memoryOverview.value.pending > 0
          ? `${memoryOverview.value.pending} 项待处理`
          : memoryOverview.value.verifiedAgents > 0
            ? `${memoryOverview.value.verifiedAgents} 个 Agent 已连通`
            : "等待 Agent 调用",
      level: memoryOverview.value && memoryOverview.value.pending === 0 && memoryOverview.value.verifiedAgents > 0 ? "ok" : "warn",
      stats: [
        // 普通 = 总量 − 深层 L2；「N 个 Agent 已连通」已在右上状态，这里只报记忆条数
        { v: memoryOverview.value ? String(Math.max(0, memoryOverview.value.total - memoryOverview.value.l2)) : "-", label: "普通记忆", unit: "条" },
        { v: memoryOverview.value ? String(memoryOverview.value.l2) : "-", label: "深层记忆", unit: "条" },
      ],
    },
    prompts: {
      // 有冲突待裁决时优先把它顶到状态位（和技能仓库的「N 冲突待裁决」同款口径）
      state: !promptsStats.value
        ? "未就绪"
        : promptsStats.value.conflicts > 0
          ? `${promptsStats.value.conflicts} 冲突待裁决`
          : "运行中",
      level: promptsStats.value && promptsStats.value.conflicts > 0 ? "warn" : "ok",
      stats: [
        { v: promptsStats.value ? String(promptsStats.value.total) : "-", label: "总量", unit: "条" },
        { v: promptsStats.value ? String(promptsStats.value.week) : "-", label: "本周新增", unit: "条" },
        { v: promptsStats.value ? String(promptsStats.value.conflicts) : "-", label: "冲突", unit: "个" },
      ],
    },
  };
});

// 号池管家 · 渠道额度（真实数据：号池各渠道的积分余量与可用账号；渠道增减自动跟进）
type ProxyChannelRow = {
  id: string;
  display: string;
  summary: { totalCredits: number; accountCount: number; onlineCount: number; earliestExpire: number; expiringSoon: boolean };
};
const channels = ref<ProxyChannelRow[]>([]);
async function refreshChannels() {
  channels.value = (await api.proxyPool().catch(() => channels.value)) || [];
}
// 死渠道（有号已过期 且 在线余额合计 0）不占侧栏那一行：它们不可用却和可用渠道长得一样，
// 渠道一多就把真正要看的挤下去。判据落在 channelHealth.ts 里，理由是那条规则错了会静默藏号。
const visibleChannels = computed(() => {
  const now = Date.now();
  return channels.value.filter((c) => !isUnusableChannel(c.summary, now));
});
const fmtDay = (ts: number) => {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// 上游启闭弹窗（渠道级开关：关闭的渠道在号池管家全部页面动态隐藏）
const upOpen = ref(false);

// 模块图标（线稿 path，复刻 design.html）
const MODULE_ICONS: Record<ModuleKey, string> = {
  skills: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  sync: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v5h-5"/>',
  proxy: '<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>',
  // 记忆中枢：脑/记忆背包（同款线稿：外轮廓 + 内部层线）
  memory: '<path d="M12 3a6 6 0 0 0-6 6v9a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3V9a6 6 0 0 0-6-6z"/><path d="M9 10h6M9 14h6"/>',
  // 提示词库：对话气泡 + 光标（线稿风格与其余四个一致，笔画粗细由外层 svg 的 stroke-width 统一给）
  prompts: '<path d="M20 12a7 7 0 0 1-7 7H8l-4 3v-5.5A7 7 0 0 1 11 5h2a7 7 0 0 1 7 7z"/><path d="M9 11h6M9 14.5h3.5"/>',
};

// ===== 下卡片：模块总览概况（标题 / 提示全部接真实统计） =====
const OVERVIEW = computed<Record<ModuleKey, { title: string; hint: string }>>(() => ({
  skills: {
    title: "工具连接",
    hint: skillsStats.value ? `${skillsStats.value.mountOk}/${skillsStats.value.mountTotal} 挂载` : "挂载",
  },
  sync: { title: "设备用量", hint: `${devices.value.length} 台设备` },
  proxy: { title: "渠道额度", hint: visibleChannels.value.length ? `${visibleChannels.value.length} 个渠道` : "渠道" },
  memory: {
    title: "记忆概况",
    hint: memoryOverview.value ? `${memoryOverview.value.total} 条记忆` : "记忆中枢",
  },
  prompts: {
    title: "提示词概况",
    hint: promptsStats.value ? `${promptsStats.value.total} 条提示词` : "提示词库",
  },
}));

// 用量统计 · 设备用量（真实数据：usage store 的设备列表，原「用量记录同步」侧栏同款）
const devices = computed(() => usage.devices);
const allTotalTokens = computed(() => usage.devices.reduce((s, d) => s + (d.totalTokens || 0), 0));

function onSelectDevice(deviceId: string | null) {
  // 点设备行跳到总览页并按设备过滤（与原应用一致）；行内左滑是删除手势，不触发跳转
  if (app.activeModule !== "sync" || app.activePage !== "overview" || app.settingsOpen) {
    app.activeModule = "sync";
    app.activePage = "overview";
    app.settingsOpen = false;
  }
  usage.selectDevice(deviceId);
}

// ===== 设备行左滑删除（桌面端按横向拖拽实现：向左拖出删除区，松手停在展开态）=====
const swipedId = ref(""); // 当前展开删除区的设备 id
let swipe = { id: "", startX: 0, dx: 0, active: false };

function onDevicePointerDown(d: DeviceMeta, e: PointerEvent) {
  if (d.isLocal) return; // 本机设备不可删
  swipe = { id: d.deviceId, startX: e.clientX, dx: 0, active: true };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function onDevicePointerMove(d: DeviceMeta, e: PointerEvent) {
  if (!swipe.active || swipe.id !== d.deviceId) return;
  swipe.dx = Math.max(-72, Math.min(0, e.clientX - swipe.startX));
  const el = e.currentTarget as HTMLElement;
  el.style.transform = `translateX(${swipe.dx}px)`;
}
function onDevicePointerUp(d: DeviceMeta, e: PointerEvent) {
  if (!swipe.active || swipe.id !== d.deviceId) return;
  swipe.active = false;
  const el = e.currentTarget as HTMLElement;
  // 拖过阈值（-36px）停在展开态，否则弹回
  if (swipe.dx < -36) {
    swipedId.value = d.deviceId;
    el.style.transform = "translateX(-56px)";
  } else {
    if (swipedId.value === d.deviceId) swipedId.value = "";
    el.style.transform = "";
  }
  swipe.dx = 0;
}
function closeSwipe(d: DeviceMeta, e: MouseEvent) {
  e.stopPropagation();
  if (swipedId.value === d.deviceId) swipedId.value = "";
}

/** 删除退役设备：确认弹窗 → 后端先删 WebDAV 远端数据再清本地（与原应用一致） */
async function removeDevice(d: DeviceMeta) {
  swipedId.value = "";
  try {
    await ElMessageBox.confirm(
      `将同时删除 WebDAV 上「${d.deviceName}」的数据与本地记录，不可恢复。`,
      `删除退役设备「${d.deviceName}」？`,
      { confirmButtonText: "确认删除", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return; // 取消
  }
  const r = await syncApi.deleteDevice(d.deviceId);
  if (!r || !r.ok) {
    await ElMessageBox.alert(r?.message || "删除设备失败", "删除失败", { type: "error" });
    return;
  }
  if (usage.selectedDeviceId === d.deviceId) usage.selectedDeviceId = null;
  await usage.refreshDevices();
  await usage.loadOverview();
}

// 技能仓库 · 各工具真实挂载状态（skills_side_stats：目录一层列表 + manifest 挂载台账）
// 某工具的挂载数 = manifest 里指向该工具的挂载条目；目录不存在即未命中
const TOOLS = computed<{ name: string; meta: string; label: string; ok: boolean }[]>(() => {
  const sk = skillsStats.value;
  if (!sk) return [];
  return sk.tools.map((t) => ({
    name: t.name,
    meta: `${t.dir} · ${t.skillCount} 个技能`,
    label: t.skillCount > 0 || sk.mountTotal > 0 ? "已接入" : "空目录",
    ok: true,
  }));
});
</script>

<template>
  <aside class="side-col">
    <!-- 卡片 1：板块切换（模块/插件变多时卡内纵向滚动，滚动条走主题绿） -->
    <div class="side glass">
      <nav class="modules">
        <template v-for="mod in app.orderedModules" :key="mod.key">
          <div
            class="module-card"
            :class="{ active: app.activeModule === mod.key, disabled: !mod.enabled }"
            :aria-disabled="!mod.enabled"
            @click="app.selectModule(mod.key)"
          >
            <span v-if="!mod.enabled" class="mc-off">已停用</span>
            <span class="mc-state" :class="MODULE_META[mod.key].level === 'warn' ? 'st-warn' : 'st-ok'">
              <i class="mc-dot"></i>{{ MODULE_META[mod.key].state }}
            </span>
            <div class="mc-top">
              <div class="mc-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="MODULE_ICONS[mod.key]"></svg>
              </div>
              <div class="mc-name">{{ mod.name }}</div>
            </div>
            <div class="mc-stats">
              <div v-for="s in MODULE_META[mod.key].stats" :key="s.label" class="mc-stat">
                <b>{{ s.v }}<span v-if="s.unit" class="mc-unit">{{ s.unit }}</span></b><span>{{ s.label }}</span>
              </div>
              <!-- 上游启闭（仅号池管家卡）：渠道级开关入口，弹窗内各渠道图标 + 名称 + 开关 -->
              <el-tooltip v-if="mod.key === 'proxy'" content="上游启闭：控制各渠道在号池管家中的启用与可见" placement="top">
                <button class="mc-up-btn" @click.stop="upOpen = true">
                  <i class="ph ph-plugs-connected"></i>上游启闭
                </button>
              </el-tooltip>
            </div>
          </div>

        </template>

        <!-- 外置插件入口：统一排在所有内置大板块之后（往下排），新装插件只往下加，不插进大板块中间 -->
        <div
          v-for="p in pluginsTail"
          :key="p.id"
          class="module-card plugin-card"
          :class="{ active: app.pluginView && app.pluginView.id === p.id }"
          @click="openPlugin(p.id)"
        >
          <span class="mc-state" :class="p.running ? 'st-ok' : 'st-warn'">
            <i class="mc-dot"></i>{{ p.running ? "运行中" : "已停止" }}
          </span>
          <div class="mc-top">
            <div class="mc-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 3v4M15 3v4M5 7h14v6a7 7 0 0 1-7 7 7 7 0 0 1-7-7V7Z" />
              </svg>
            </div>
            <div class="mc-name">{{ p.sidebar?.label || p.name }}</div>
          </div>
          <div class="pc-meta">
            <span class="pc-tag">插件</span>
            <span class="pc-ver">v{{ p.version }}</span>
          </div>
        </div>
      </nav>
    </div>

    <!-- 卡片 3：当前模块的总览概况 + 左下角全局操作 -->
    <div class="side-overview glass">
      <div class="ov-head">
        <span class="ov-title">{{ OVERVIEW[app.activeModule].title }}</span>
        <span class="ov-hint">{{ OVERVIEW[app.activeModule].hint }}</span>
      </div>
      <div class="ov-body">
        <!-- 用量统计：设备用量（真实数据；非本机设备左滑出删除，确认后连 WebDAV 远端一起删） -->
        <template v-if="app.activeModule === 'sync'">
          <el-tooltip content="点击查看所有电脑数据汇总" placement="right">
            <div class="ov-row ov-pick" :class="{ selected: usage.selectedDeviceId === null }" @click="onSelectDevice(null)">
              <span class="ov-dot"></span>
              <div class="grow">
                <div class="ov-name">全部电脑<span class="ov-tag">汇总</span></div>
                <div class="ov-meta">{{ devices.length }} 台设备合计</div>
              </div>
              <b class="ov-num">{{ formatToken(allTotalTokens) }}</b>
            </div>
          </el-tooltip>
          <el-tooltip
            v-for="d in devices"
            :key="d.deviceId"
            :content="d.isLocal ? '本机设备' : '点击只看该设备；向左滑可删除'"
            placement="right"
          >
            <div
              class="ov-row ov-pick ov-device"
              :class="{ selected: usage.selectedDeviceId === d.deviceId, swiped: swipedId === d.deviceId }"
              @click="onSelectDevice(d.deviceId)"
              @pointerdown="onDevicePointerDown(d, $event)"
              @pointermove="onDevicePointerMove(d, $event)"
              @pointerup="onDevicePointerUp(d, $event)"
              @pointercancel="onDevicePointerUp(d, $event)"
            >
              <span class="ov-dot" :class="{ off: !d.online }"></span>
              <div class="grow">
                <div class="ov-name">{{ d.deviceName }}<span v-if="d.isLocal" class="ov-tag">本机</span></div>
                <div class="ov-meta">{{ timeAgo(d.lastSyncAt) }}</div>
              </div>
              <b class="ov-num">{{ formatToken(d.totalTokens) }}</b>
              <el-tooltip v-if="!d.isLocal" content="删除该退役设备（同时删除 WebDAV 上的数据）" placement="top">
                <button class="ov-del" @click.stop="removeDevice(d)">删除</button>
              </el-tooltip>
            </div>
          </el-tooltip>
        </template>

        <!-- 技能仓库：工具连接（真实扫描目标 + 技能计数） -->
        <template v-else-if="app.activeModule === 'skills'">
          <div v-for="t in TOOLS" :key="t.name" class="ov-row">
            <div class="grow">
              <div class="ov-name">{{ t.name }}</div>
              <div class="ov-meta">{{ t.meta }}</div>
            </div>
            <el-tag :type="t.ok ? 'success' : 'warning'">{{ t.label }}</el-tag>
          </div>
          <div v-if="!TOOLS.length" class="ov-row">
            <div class="grow"><div class="ov-meta">未探测到已接入的工具目录</div></div>
          </div>
        </template>

        <!-- 记忆中枢：概况（条数/今日/待处理/最近项目/已连通 Agent/索引一致率；每行可点跳对应页面） -->
        <template v-else-if="app.activeModule === 'memory'">
          <template v-if="memoryOverview">
            <el-tooltip content="点击查看记忆浏览" placement="right">
              <div class="ov-row ov-pick" @click="gotoMemory('browse')">
                <span class="ov-dot" :class="{ off: !memoryOverview.enabled }"></span>
                <div class="grow">
                  <div class="ov-name">记忆总量<span class="ov-tag">L2 {{ formatInteger(memoryOverview.l2) }} 条</span></div>
                  <div class="ov-meta">
                    今日新增 {{ formatInteger(memoryOverview.today) }} 条 · {{ formatInteger(memoryOverview.projects) }} 个项目
                  </div>
                </div>
                <b class="ov-num">{{ formatInteger(memoryOverview.total) }}<span class="ov-unit">条</span></b>
              </div>
            </el-tooltip>

            <el-tooltip :content="memoryOverview.pending ? '有待处理项：待确认失效/归类/去重' : '暂无待处理项'" placement="right">
              <div class="ov-row ov-pick" @click="memStore.gotoReview()">
                <span class="ov-dot" :class="memoryOverview.pending ? 'warn-dot' : ''"></span>
                <div class="grow">
                  <div class="ov-name">
                    待确认
                    <span v-if="memoryOverview.pending" class="ov-tag warn">需处理</span>
                  </div>
                  <div class="ov-meta">事实失效 / 归类 / 去重</div>
                </div>
                <b class="ov-num">{{ formatInteger(memoryOverview.pending) }}<span class="ov-unit">项</span></b>
              </div>
            </el-tooltip>

            <el-tooltip
              v-for="p in memoryOverview.topProjects"
              :key="p.slug"
              :content="`点击查看项目归档（最近更新 ${timeAgo(p.latest)}）`"
              placement="right"
            >
              <div
                class="ov-row ov-pick"
                @click="gotoMemory('projects')"
              >
                <span class="ov-dot"></span>
                <div class="grow">
                  <div class="ov-name">{{ p.name }}</div>
                  <div class="ov-meta">最近 {{ timeAgo(p.latest) }}</div>
                </div>
                <b class="ov-num">{{ formatInteger(p.count) }}<span class="ov-unit">条</span></b>
              </div>
            </el-tooltip>
            <div v-if="!memoryOverview.topProjects.length" class="ov-row">
              <div class="grow"><div class="ov-meta">还没有项目 —— Agent 带上项目路径写记忆后会自动建项目文件夹</div></div>
            </div>

            <el-tooltip content="点击查看 Agent 接入（三级校验）" placement="right">
              <div class="ov-row ov-pick" @click="gotoMemory('agents')">
                <span class="ov-dot" :class="memoryOverview.verifiedAgents ? '' : 'off'"></span>
                <div class="grow">
                  <div class="ov-name">Agent 接入</div>
                  <div class="ov-meta">
                    {{ memoryOverview.agents ? `${memoryOverview.verifiedAgents}/${memoryOverview.agents} 真实调用过` : "尚未探测到可接入的 Agent" }}
                  </div>
                </div>
                <el-tag :type="memoryOverview.verifiedAgents ? 'success' : 'warning'">
                  {{ memoryOverview.verifiedAgents ? "已连通" : "待调用" }}
                </el-tag>
              </div>
            </el-tooltip>

            <el-tooltip :content="memoryOverview.consistent ? '索引与记忆文件一致' : '索引不一致：去「检索与索引」点诊断修复'" placement="right">
              <div class="ov-row ov-pick" @click="gotoMemory('index')">
                <span class="ov-dot" :class="memoryOverview.consistent ? '' : 'warn-dot'"></span>
                <div class="grow">
                  <div class="ov-name">索引健康</div>
                  <div class="ov-meta">{{ memoryOverview.consistent ? "索引与文件一致" : "检出不一致，需重建" }}</div>
                </div>
                <el-tag :type="memoryOverview.consistent ? 'success' : 'warning'">{{ memoryOverview.consistent ? "正常" : "需修复" }}</el-tag>
              </div>
            </el-tooltip>
          </template>
          <div v-else class="ov-row">
            <div class="grow"><div class="ov-meta">记忆中枢加载中…（未启用时可在「设置 · 通用」或配置页开启）</div></div>
          </div>
        </template>

        <!-- 提示词库：概况（总量 / 本周新增与优化产出 / 同步状态；三行都可点跳对应页面） -->
        <template v-else-if="app.activeModule === 'prompts'">
          <template v-if="promptsStats">
            <el-tooltip content="点击查看个人提示词库" placement="right">
              <div class="ov-row ov-pick" @click="gotoPrompts('library')">
                <span class="ov-dot"></span>
                <div class="grow">
                  <div class="ov-name">提示词总量<span class="ov-tag">收藏 {{ formatInteger(promptsStats.favorited) }} 条</span></div>
                  <div class="ov-meta">今日新增 {{ formatInteger(promptsStats.today) }} 条 · 回收站 {{ formatInteger(promptsStats.trash) }} 条</div>
                </div>
                <b class="ov-num">{{ formatInteger(promptsStats.total) }}<span class="ov-unit">条</span></b>
              </div>
            </el-tooltip>

            <el-tooltip content="点击去优化提示词" placement="right">
              <div class="ov-row ov-pick" @click="gotoPrompts('optimize')">
                <span class="ov-dot"></span>
                <div class="grow">
                  <div class="ov-name">本周新增</div>
                  <div class="ov-meta">其中优化产出 {{ formatInteger(promptsStats.optimized) }} 条</div>
                </div>
                <b class="ov-num">{{ formatInteger(promptsStats.week) }}<span class="ov-unit">条</span></b>
              </div>
            </el-tooltip>

            <el-tooltip content="点击进入 WebDAV 同步与冲突裁决" placement="right">
              <div class="ov-row ov-pick" @click="gotoPrompts('sync')">
                <span class="ov-dot" :class="promptsStats.conflicts ? 'warn-dot' : promptsSync && !promptsSync.configured ? 'off' : ''"></span>
                <div class="grow">
                  <div class="ov-name">
                    WebDAV 同步
                    <span v-if="promptsStats.conflicts" class="ov-tag warn">需裁决</span>
                  </div>
                  <div class="ov-meta">{{ promptsSyncText }}</div>
                </div>
                <el-tag :type="promptsStats.conflicts ? 'warning' : promptsSync?.configured ? 'success' : 'info'">
                  {{ promptsStats.conflicts ? `${formatInteger(promptsStats.conflicts)} 冲突` : promptsSync?.configured ? "已就绪" : "未配置" }}
                </el-tag>
              </div>
            </el-tooltip>
          </template>
          <div v-else class="ov-row">
            <div class="grow"><div class="ov-meta">提示词库加载中…（未启用时可在「设置 · 通用」或配置页开启）</div></div>
          </div>
        </template>

        <!-- 号池管家：渠道额度（号池实时数据，渠道增减自动跟进） -->
        <template v-else>
          <div v-for="c in visibleChannels" :key="c.id" class="ov-row">
            <div class="grow">
              <div class="ov-name">
                {{ c.display }}<span v-if="c.summary.expiringSoon" class="ov-tag warn">即将到期</span>
              </div>
              <div class="ov-meta">
                {{ c.summary.accountCount ? `${c.summary.onlineCount}/${c.summary.accountCount} 可用` : "空号池" }}<template v-if="c.summary.earliestExpire"> · 最早到期 {{ fmtDay(c.summary.earliestExpire) }}</template>
              </div>
            </div>
            <b class="ov-num">{{ fmtBalance(c.summary.totalCredits, c.id) }}<span class="ov-unit">{{ balanceUnit(c.id) }}</span></b>
          </div>
          <div v-if="!visibleChannels.length" class="ov-row">
            <div class="grow"><div class="ov-meta">{{ channels.length ? "无可用余额渠道（已过期或额度耗尽）" : "号池尚未接入或加载中" }}</div></div>
          </div>
        </template>
      </div>
    </div>

    <!-- 上游启闭弹窗（渠道级开关）：关闭的渠道在号池管家全部页面动态隐藏，重新打开立即恢复 -->
    <ProxyUpstreamDialog :open="upOpen" @close="upOpen = false" />
  </aside>
</template>

<style scoped>
/* 左栏外层：品牌已上移到顶部通栏（AppTopBar.vue），这里只剩「板块切换 + 概况」两张卡。
   极矮窗口（浏览器预览等无缩放兜底时）整列可滚 */
.side-col {
  grid-area: side;
  display: flex;
  flex-direction: column;
  gap: var(--gap-shell);
  min-height: 0;
  overflow-y: auto;
  /* 只允许纵向滚：任何横向溢出都直接裁掉，别出现横向滚动条 */
  overflow-x: hidden;
}
.side-col::-webkit-scrollbar {
  width: 4px;
}

/* ===== 卡片 1：板块切换（内容自然高度；超出「五板块」才卡内纵向滚动） ===== */
.side {
  border-radius: var(--r-panel);
  display: flex;
  flex-direction: column;
  padding: 10px;
  overflow: hidden;
  /* 高度不写死：5 个板块时取内容自然高度——整倍缩放下的亚像素取整、字体渲染差都会让
     实际高度比 5×88 的精确算式多出 1~2px，写死高度正好放不下就冒滚动条。
     这里只设上限（按单卡 90 留足余量）：内容超出（装插件后追加插件卡、窄栏下
     「上游启闭」按钮换行把卡片涨到 117）才限高，交给 .modules 自己滚 */
  height: auto;
  max-height: calc(5 * 90px + 4 * 6px + 20px);
  /* 窗口太矮时允许被压缩，压缩后同样交给 .modules 滚，不把下面的概况卡挤没 */
  flex: 0 1 auto;
  min-height: 104px;
}

/* 模块卡片（顺序自定义入口在「设置 · 通用」，支持拖拽排序） */
.modules {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* 只纵向滚：模块卡里任何横向溢出都不许变成横向滚动条 */
  overflow-x: hidden;
  /* 滚到底不再带动外层左栏一起滚，卡片内滚动更稳 */
  overscroll-behavior: contain;
  padding-right: 2px;
}
/* 卡内滚动条：主题绿（滑块 accent-line，悬停点亮为 accent），宽度收窄贴合卡片 */
.modules::-webkit-scrollbar {
  width: 5px;
}
.modules::-webkit-scrollbar-track {
  background: transparent;
}
.modules::-webkit-scrollbar-thumb {
  background: var(--accent-line);
  border-radius: var(--r-pill);
}
.modules::-webkit-scrollbar-thumb:hover {
  background: var(--accent);
}
.module-card {
  border-radius: var(--r-ctl);
  border: 1px solid transparent;
  background: rgba(255, 255, 255, 0.025);
  padding: 10px 11px 9px;
  cursor: pointer;
  position: relative;
  transition: background 0.2s var(--ease), border-color 0.2s, transform 0.15s;
}
/* 已停用板块（issue #91）：低对比置灰、禁用指针交互反馈，右上角「已停用」角标 */
.module-card.disabled {
  opacity: 0.45;
  cursor: not-allowed;
  filter: grayscale(0.6);
}
.module-card.disabled:hover { background: rgba(255, 255, 255, 0.025); }
.module-card.disabled:active { transform: none; }
.module-card.disabled::after { display: none; }
/* 外置插件卡：虚线描边与内置模块区分；未安装时整块不存在 */
.plugin-card {
  border-style: dashed;
  border-color: var(--line-strong);
}
.plugin-card:hover { border-color: var(--accent); }
.plugin-card .mc-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pc-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding-left: 35px;
}
.pc-tag {
  font-size: 9px;
  line-height: 1;
  color: var(--text-3);
  background: var(--surface-3);
  border-radius: 4px;
  padding: 2px 5px;
}
.pc-ver {
  font-size: 9px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
.mc-off {
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 10px;
  line-height: 1;
  color: var(--text-3);
  background: var(--surface-3);
  border-radius: 4px;
  padding: 2px 5px;
}
:root[data-theme="light"] .module-card {
  background: rgba(15, 23, 42, 0.02);
}
.module-card:hover {
  background: rgba(255, 255, 255, 0.05);
  transform: translateY(-1px);
}
:root[data-theme="light"] .module-card:hover {
  background: rgba(15, 23, 42, 0.045);
}
.module-card:active {
  transform: scale(0.985);
}
/* 悬停聚光（--mx/--my 由 App.vue 全局委托写入；::before 已被激活指示条占用） */
.module-card::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(180px circle at var(--mx, 50%) var(--my, 50%), var(--spot-wash), transparent 65%);
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
}
.module-card:hover::after {
  opacity: 1;
}
.module-card.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
}
.module-card.active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 12px;
  bottom: 12px;
  width: 3px;
  border-radius: var(--r-pill);
  background: var(--accent);
}
/* 激活指示条呼吸：明暗缓慢起伏 */
@media (prefers-reduced-motion: no-preference) {
  .module-card.active::before {
    animation: barBreathe 3s ease-in-out infinite;
  }
  @keyframes barBreathe {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.55;
    }
  }
}
.mc-top {
  display: flex;
  align-items: center;
  gap: 9px;
}
.mc-icon {
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  flex-shrink: 0;
  display: grid;
  place-items: center;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-2);
  transition: all 0.2s;
}
:root[data-theme="light"] .mc-icon {
  background: rgba(15, 23, 42, 0.05);
}
.module-card.active .mc-icon {
  background: var(--accent-dim);
  color: var(--accent);
}
.module-card:hover .mc-icon {
  transform: scale(1.06);
}
.mc-icon svg {
  width: 13px;
  height: 13px;
}
.mc-name {
  font-weight: 600;
  font-size: 12.5px;
}
.mc-stats {
  display: flex;
  flex-wrap: wrap; /* 挤不下时「上游启闭」按钮换行右对齐，数字不被压缩 */
  align-items: flex-end;
  gap: 12px;
  margin-top: 8px;
}
.mc-stat b {
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-weight: 600;
  display: block;
}
/* 数字后的弱化单位（台/个/条）：与下卡片 .ov-unit 同构的两段式 */
.mc-unit {
  font-size: 9px;
  font-weight: 500;
  color: var(--text-3);
  margin-left: 2px;
  font-family: var(--font-ui);
}
.mc-stat span {
  font-size: 9px;
  color: var(--text-3);
}
/* 上游启闭小按钮（仅号池管家卡）：绿色描边常态，悬停点亮加深，与免责问号同色系 */
.mc-up-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: var(--r-pill);
  border: 1px solid var(--accent-line);
  background: transparent;
  color: var(--text-3);
  font-size: 9px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.mc-up-btn .ph {
  font-size: 10px;
}
.mc-up-btn:hover {
  color: var(--accent-strong);
  border-color: var(--accent-strong);
  background: var(--accent-dim);
}
.mc-state {
  position: absolute;
  right: 10px;
  top: 11px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 9px;
  font-family: var(--font-mono);
  padding: 2px 6px;
  border-radius: var(--r-pill);
}
/* 状态圆点：带一圈持续荡开的涟漪（warn 时跟随警示色） */
.mc-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
  position: relative;
  flex-shrink: 0;
}
.mc-dot::after {
  content: "";
  position: absolute;
  inset: -2px;
  border-radius: 50%;
  border: 1px solid currentColor;
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .mc-dot::after {
    animation: mcDotRipple 2.4s var(--ease) infinite;
  }
  @keyframes mcDotRipple {
    from {
      transform: scale(1);
      opacity: 0.7;
    }
    to {
      transform: scale(3);
      opacity: 0;
    }
  }
}
.st-ok {
  color: var(--accent-strong);
  background: var(--accent-dim);
}
.st-warn {
  color: var(--warn);
  background: var(--warn-dim);
}

/* 左下角全局操作条（版本 / 作者 / Star / 亮暗 / 设置）已整体移到右上横条，
   见 TopBarActions.vue；这里不再保留对应样式，恢复时从那个组件搬回来即可 */

/* ===== 下卡片：模块总览概况 ===== */
.side-overview {
  flex: 1;
  /* 高度下限：保证标题 + 几行概况常驻，再矮就交给 side-col 滚动 */
  min-height: 128px;
  border-radius: var(--r-panel);
  display: flex;
  flex-direction: column;
  padding: 10px 10px 8px;
  overflow: hidden;
}
.ov-head {
  display: flex;
  align-items: center;
  padding: 2px 6px 6px;
  flex-shrink: 0;
}
.ov-title {
  font-size: 9.5px;
  letter-spacing: 0.14em;
  font-weight: 600;
  color: var(--text-3);
}
.ov-hint {
  margin-left: auto;
  font-size: 9px;
  font-family: var(--font-mono);
  color: var(--text-3);
}
.ov-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 2px 2px;
  display: flex;
  flex-direction: column;
}
.ov-body::-webkit-scrollbar {
  width: 4px;
}
.ov-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 8px;
  border-radius: var(--r-sm);
  font-size: 12px;
}
/* 悬停底色只给未选中行：亮色主题下这条选择器权重更高，会盖掉选中高亮 */
.ov-row:not(.selected):hover {
  background: rgba(255, 255, 255, 0.035);
}
:root[data-theme="light"] .ov-row:not(.selected):hover {
  background: rgba(15, 23, 42, 0.03);
}
.ov-row + .ov-row {
  border-top: 1px solid var(--line);
}
.ov-row .grow {
  flex: 1;
  min-width: 0;
}
.ov-name {
  font-weight: 550;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-meta {
  font-size: 10px;
  color: var(--text-3);
  font-family: var(--font-mono);
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-num {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  flex-shrink: 0;
}
/* 渠道额度数字后的单位（积分/Tokens/Credits）：弱化小字，与号池页两段式同构 */
.ov-unit {
  font-size: 9px;
  font-weight: 500;
  color: var(--text-3);
  margin-left: 3px;
  font-family: var(--font-ui);
}
.ov-tag {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: var(--r-pill);
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-weight: 600;
  margin-left: 5px;
}
.ov-tag.warn {
  background: var(--warn-dim);
  color: var(--warn);
}
/* 可选中行（「全部电脑」与各设备行共用同一套指针/过渡/选中高亮，样式完全一致） */
.ov-pick {
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}
.ov-pick.selected {
  background: var(--accent-dim);
}
/* 设备行：在可选中行之上叠加左滑删除手势（行体左移，露出右侧删除按钮） */
.ov-device {
  position: relative;
  touch-action: pan-y; /* 纵向滚动不受影响，横向拖动才是删除手势 */
  transition: transform 0.18s var(--ease), background 0.15s;
}
.ov-device .ov-del {
  position: absolute;
  right: -56px;
  top: 0;
  bottom: 0;
  width: 52px;
  border: none;
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: var(--danger);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.ov-device.swiped .ov-del,
.ov-device:active .ov-del {
  opacity: 1;
}
/* 行容器不能裁掉左移露出的删除按钮以外的部分：删掉行间距分割线错位即可 */
.ov-body {
  overflow-x: clip;
}

/* 设备在线圆点（在线涟漪，离线置灰静止） */
.ov-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
  position: relative;
  flex-shrink: 0;
}
.ov-dot.off {
  background: var(--text-3);
  box-shadow: none;
}
/* 记忆中枢概况里的「需注意」圆点（待处理项 / 索引不一致） */
.ov-dot.warn-dot {
  background: var(--warn);
  box-shadow: 0 0 6px var(--warn);
}
.ov-dot::after {
  content: "";
  position: absolute;
  inset: -2px;
  border-radius: 50%;
  border: 1px solid var(--accent);
  opacity: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .ov-dot:not(.off)::after {
    animation: ovDotRipple 2.4s var(--ease) infinite;
  }
  @keyframes ovDotRipple {
    from {
      transform: scale(1);
      opacity: 0.7;
    }
    to {
      transform: scale(3);
      opacity: 0;
    }
  }
}
</style>

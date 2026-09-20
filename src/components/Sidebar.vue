<!-- 左栏双卡片：上 = 品牌 + 三大模块切换；下 = 当前模块的总览概况
     概况数据全部来自真实统计：skills 走轻量 IPC（skills_side_stats）、sync 走 usage store、
     proxy 走号池/Keys/网关状态；模块顺序自定义在「设置 · 通用」
     版本 / 署名 / 亮暗 / 设置入口统一收在最左下角 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { useAppStore } from "../stores/app";
import { useSyncStore } from "../stores/sync";
import { useUsageStore } from "../stores/usage";
import * as syncApi from "../api/sync";
import { formatToken, formatCost, timeAgo } from "../composables/useFormat";
import type { DeviceMeta } from "../types/sync";
import type { ModuleKey } from "../types";
import * as api from "../api/ipc";
import logoUrl from "../assets/logo.png";

const app = useAppStore();
const usageApp = useSyncStore();
const usage = useUsageStore();

// 版本号从主进程取（浏览器预览时 mock 返回 0.1.0）
const version = ref("v0.1.0");
onMounted(async () => {
  refreshChannels();
  refreshSkillsStats();
  refreshProxyMeta();
  ensureUsageSummary();
  try {
    version.value = "v" + (await api.getAppVersion());
  } catch {
    /* 取不到就用默认 */
  }
  // 网关启停/号池同步都经 app:event 广播：侧栏卡片只订阅不轮询。
  // 原来只在切模块时刷一次，本模块内点「启动服务」后卡片会一直停在「网关未启动」
  offProxyEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event !== "proxy") return;
    if (p.type === "status" || p.type === "poolsync" || p.type === "credits") {
      refreshProxyMeta();
      refreshChannels();
    }
  });
});
let offProxyEvent: (() => void) | undefined;
onUnmounted(() => {
  if (offProxyEvent) offProxyEvent();
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

// ===== 反代网关 · 网关状态 + Key 数（真实） =====
const proxyRunning = ref(false);
const proxyKeyCount = ref(0);
async function refreshProxyMeta() {
  try {
    const st = await api.proxyStatus();
    proxyRunning.value = !!st.running;
    proxyKeyCount.value = st.keyCount ?? 0;
  } catch {
    /* 保留旧值 */
  }
}

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
const MODULE_META = computed<Record<ModuleKey, { state: string; level: "ok" | "warn"; stats: { v: string; label: string }[] }>>(() => {
  const sk = skillsStats.value;
  const syncStats: { v: string; label: string }[] = [
    { v: String(usage.devices.length), label: "机器" },
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
        { v: sk ? String(sk.skillCount) : "-", label: "已收纳" },
        { v: sk ? String(sk.pendingConflicts) : "-", label: "待裁决" },
        { v: sk ? String(sk.toolCount) : "-", label: "接入工具" },
      ],
    },
    sync: {
      state: usage.loadError ? "加载失败" : "已同步",
      level: usage.loadError ? "warn" : "ok",
      stats: syncStats,
    },
    proxy: {
      state: proxyRunning.value ? "网关运行中" : "网关未启动",
      level: proxyRunning.value ? "ok" : "warn",
      stats: [
        { v: `:${app.config.proxy.port}`, label: "端口" },
        { v: String(proxyKeyCount.value), label: "Key" },
        { v: channels.value.length ? String(channels.value.length) : "-", label: "上游" },
      ],
    },
  };
});

// 反代网关 · 渠道额度（真实数据：号池各渠道的积分余量与可用账号；渠道增减自动跟进）
type ProxyChannelRow = {
  id: string;
  display: string;
  summary: { totalCredits: number; accountCount: number; onlineCount: number; earliestExpire: number; expiringSoon: boolean };
};
const channels = ref<ProxyChannelRow[]>([]);
async function refreshChannels() {
  channels.value = (await api.proxyPool().catch(() => channels.value)) || [];
}
const fmtDay = (ts: number) => {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// 模块图标（线稿 path，复刻 design.html）
const MODULE_ICONS: Record<ModuleKey, string> = {
  skills: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  sync: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v5h-5"/>',
  proxy: '<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>',
};

// ===== 下卡片：模块总览概况（标题 / 提示全部接真实统计） =====
const OVERVIEW = computed<Record<ModuleKey, { title: string; hint: string }>>(() => ({
  skills: {
    title: "工具连接",
    hint: skillsStats.value ? `${skillsStats.value.mountOk}/${skillsStats.value.mountTotal} 挂载` : "挂载",
  },
  sync: { title: "设备用量", hint: `${devices.value.length} 台设备` },
  proxy: { title: "渠道额度", hint: channels.value.length ? `${channels.value.length} 个渠道` : "渠道" },
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
    <!-- 上卡片：品牌 + 三大模块切换 -->
    <div class="side glass">
      <div class="brand">
        <img class="brand-mark" :src="logoUrl" alt="AgentHub" />
        <div class="brand-txt">
          <div class="brand-name">AgentHub</div>
          <div class="brand-sub">Agent中控台</div>
        </div>
      </div>

      <nav class="modules">
        <div
          v-for="mod in app.orderedModules"
          :key="mod.key"
          class="module-card"
          :class="{ active: app.activeModule === mod.key }"
          @click="app.selectModule(mod.key)"
        >
          <span class="mc-state" :class="MODULE_META[mod.key].level === 'warn' ? 'st-warn' : 'st-ok'">
            <i class="mc-dot"></i>{{ MODULE_META[mod.key].state }}
          </span>
          <div class="mc-top">
            <div class="mc-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="MODULE_ICONS[mod.key]"></svg>
            </div>
            <div class="mc-name">{{ mod.name }}</div>
            <el-tooltip
              v-if="mod.key === 'proxy'"
              placement="right-start"
              :show-after="120"
              popper-class="glass-popper qa-tip"
            >
              <template #content>
                本反向代理网关仅作技术测试用途。上游站点监控策略严格，服务存在更新滞后、随时失效、访问不稳定等情况，不保证持续可用，请谨慎使用，请勿用于违规场景。
              </template>
              <i class="mc-qa ph ph-question" @click.stop></i>
            </el-tooltip>
          </div>
          <div class="mc-stats">
            <div v-for="s in MODULE_META[mod.key].stats" :key="s.label" class="mc-stat">
              <b>{{ s.v }}</b><span>{{ s.label }}</span>
            </div>
          </div>
        </div>
      </nav>
    </div>

    <!-- 下卡片：当前模块的总览概况 + 左下角全局操作 -->
    <div class="side-overview glass">
      <div class="ov-head">
        <span class="ov-title">{{ OVERVIEW[app.activeModule].title }}</span>
        <span class="ov-hint">{{ OVERVIEW[app.activeModule].hint }}</span>
      </div>
      <div class="ov-body">
        <!-- 用量统计：设备用量（真实数据；非本机设备左滑出删除，确认后连 WebDAV 远端一起删） -->
        <template v-if="app.activeModule === 'sync'">
          <div class="ov-row" :class="{ selected: usage.selectedDeviceId === null }" @click="onSelectDevice(null)" title="点击查看所有电脑数据汇总">
            <span class="ov-dot"></span>
            <div class="grow">
              <div class="ov-name">全部电脑<span class="ov-tag">汇总</span></div>
              <div class="ov-meta">{{ devices.length }} 台设备合计</div>
            </div>
            <b class="ov-num">{{ formatToken(allTotalTokens) }}</b>
          </div>
          <div
            v-for="d in devices"
            :key="d.deviceId"
            class="ov-row ov-device"
            :class="{ selected: usage.selectedDeviceId === d.deviceId, swiped: swipedId === d.deviceId }"
            @click="onSelectDevice(d.deviceId)"
            @pointerdown="onDevicePointerDown(d, $event)"
            @pointermove="onDevicePointerMove(d, $event)"
            @pointerup="onDevicePointerUp(d, $event)"
            @pointercancel="onDevicePointerUp(d, $event)"
            :title="d.isLocal ? '本机设备' : '点击只看该设备；向左滑可删除'"
          >
            <span class="ov-dot" :class="{ off: !d.online }"></span>
            <div class="grow">
              <div class="ov-name">{{ d.deviceName }}<span v-if="d.isLocal" class="ov-tag">本机</span></div>
              <div class="ov-meta">{{ timeAgo(d.lastSyncAt) }}</div>
            </div>
            <b class="ov-num">{{ formatToken(d.totalTokens) }}</b>
            <button v-if="!d.isLocal" class="ov-del" title="删除该退役设备（同时删除 WebDAV 上的数据）" @click.stop="removeDevice(d)">删除</button>
          </div>
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

        <!-- 反代网关：渠道额度（号池实时数据，渠道增减自动跟进） -->
        <template v-else>
          <div v-for="c in channels" :key="c.id" class="ov-row">
            <div class="grow">
              <div class="ov-name">
                {{ c.display }}<span v-if="c.summary.expiringSoon" class="ov-tag warn">即将到期</span>
              </div>
              <div class="ov-meta">
                {{ c.summary.accountCount ? `${c.summary.onlineCount}/${c.summary.accountCount} 可用` : "空号池" }}<template v-if="c.summary.earliestExpire"> · 最早到期 {{ fmtDay(c.summary.earliestExpire) }}</template>
              </div>
            </div>
            <b class="ov-num">{{ c.summary.totalCredits.toLocaleString("en-US") }}</b>
          </div>
          <div v-if="!channels.length" class="ov-row">
            <div class="grow"><div class="ov-meta">号池尚未接入或加载中</div></div>
          </div>
        </template>
      </div>

      <!-- 左下角全局操作：版本 / 署名 / 亮暗 / 设置 -->
      <div class="side-foot">
        <div class="foot-meta">
          <div class="foot-ver">{{ version }}</div>
          <div class="foot-author" title="作者"><i class="ph ph-user"></i><b>沐辉</b></div>
        </div>
        <el-button circle @click="app.toggleTheme()">
          <i class="ph" :class="app.isDark ? 'ph-moon' : 'ph-sun'"></i>
        </el-button>
        <!-- 红点不能直接挂 el-button 里：按钮 overflow:hidden 会把溢出角裁掉一半，用 .dot-host 承载 -->
        <span class="dot-host">
          <el-button circle class="settings-btn" @click="app.openSettings('general')" title="设置">
            <i class="ph ph-gear-six"></i>
          </el-button>
          <span v-if="app.updateAvailable" class="dot-ping"></span>
        </span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* 左栏外层：上下双卡片列。极矮窗口（浏览器预览等无缩放兜底时）整体可滚 */
.side-col {
  grid-area: side;
  display: flex;
  flex-direction: column;
  gap: var(--gap-shell);
  min-height: 0;
  overflow-y: auto;
}
.side-col::-webkit-scrollbar {
  width: 4px;
}

/* ===== 上卡片：品牌 + 模块切换 ===== */
.side {
  border-radius: var(--r-panel);
  display: flex;
  flex-direction: column;
  padding: 18px 12px 12px;
  overflow: hidden;
  flex-shrink: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px 16px;
}
.brand-mark {
  width: 33px;
  height: 33px;
  border-radius: var(--r-sm);
  flex-shrink: 0;
  object-fit: cover;
  display: block;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
}
.brand-txt {
  flex: 1;
  line-height: 1.2;
}
.brand-name {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.2px;
}
.brand-sub {
  font-size: 10.5px;
  color: var(--text-3);
  margin-top: 1px;
}
/* 左下角的图标按钮交给 el-button（样式见 element.css 的 .el-button.is-circle），
   这里只管图标字号与呼吸间距 */
.side-foot .ph {
  font-size: 15px;
}
.side-foot .el-button + .el-button {
  margin-left: 0;
}
/* 设置齿轮：承载「有更新」红点的定位上下文（红点样式见 global.css 的 .dot-ping） */
.side-foot .settings-btn {
  position: relative;
}

/* 三大模块卡片（顺序自定义入口在「设置 · 个性化」） */
.modules {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
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
/* 反代网关免责问号：缓慢呼吸式闪动提醒，悬停停住并点亮（弹层样式见 element.css 的 .qa-tip） */
.mc-qa {
  font-size: 12px;
  color: var(--text-3);
  cursor: help;
  flex-shrink: 0;
  margin-left: -3px;
  animation: mc-qa-blink 2.6s ease-in-out infinite;
}
.mc-qa:hover {
  animation-play-state: paused;
  opacity: 1;
  color: var(--accent);
}
@keyframes mc-qa-blink {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}
.mc-stats {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}
.mc-stat b {
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-weight: 600;
  display: block;
}
.mc-stat span {
  font-size: 9px;
  color: var(--text-3);
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

/* 左下角全局操作条（概况卡底部，常驻可见） */
.side-foot {
  margin-top: 8px;
  border-top: 1px solid var(--line);
  padding: 10px 4px 2px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.foot-meta {
  line-height: 1.4;
  flex: 1;
}
.foot-ver {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-2);
}
.foot-author {
  font-size: 10px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 4px;
}
.foot-author .ph {
  font-size: 11px;
}
.foot-author b {
  color: var(--text-2);
  font-weight: 600;
}

/* ===== 下卡片：模块总览概况 ===== */
.side-overview {
  flex: 1;
  /* 高度下限：保证标题 / 底部操作条常驻，再矮就交给 side-col 滚动 */
  min-height: 150px;
  border-radius: var(--r-panel);
  display: flex;
  flex-direction: column;
  padding: 12px 12px 10px;
  overflow: hidden;
}
.ov-head {
  display: flex;
  align-items: center;
  padding: 2px 8px 8px;
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
  padding: 8px;
  border-radius: var(--r-sm);
  font-size: 12px;
}
.ov-row:hover {
  background: rgba(255, 255, 255, 0.035);
}
:root[data-theme="light"] .ov-row:hover {
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
/* 设备行：选中态 + 左滑删除手势（行体左移，露出右侧删除按钮） */
.ov-device {
  position: relative;
  cursor: pointer;
  touch-action: pan-y; /* 纵向滚动不受影响，横向拖动才是删除手势 */
  user-select: none;
  transition: transform 0.18s var(--ease), background 0.15s;
}
.ov-device.selected {
  background: var(--accent-dim);
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

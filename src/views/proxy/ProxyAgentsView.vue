<!-- 反代网关 · 号池：各渠道独立号池（方案 §6.10 / §7 agents.html）
     聚合顶部（总余额/账号数/可用/最早到期/今日消耗）+ 账号明细 + 四途径添加（OAuth / 本机导入 / 文件 / 粘贴）+ 池内调度策略 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import * as api from "../../api/ipc";
import type { ProxyChannelView, ProxyAccount, ProxyChannelId, ProxyPoolStrategy, ProxyScanCandidate } from "../../types";
import { useAppStore } from "../../stores/app";
import { fmtInt, fmtK, fmtDate, fmtAgo, ACCOUNT_STATUS, SOURCE_NAMES, channelName } from "./format";

const app = useAppStore();
const pool = ref<ProxyChannelView[]>([]);
const err = ref("");
const refreshingAll = ref(false);
const refreshingId = ref("");
// 渠道 Tab：顶部按钮切换，下方只显示当前渠道号池
const activeChannel = ref<ProxyChannelId>("trae");
// 本地 IDE 快捷切换
const ideStatus = ref<{ workbuddyInstalled: boolean; workbuddyAiInstalled?: boolean; traeInstalled?: boolean; currentUid: string } | null>(null);
const ideMsg = ref("");
const ideSwitching = ref("");
let offEvent: (() => void) | undefined;

// 添加账号弹窗（四方式：oauth 官方登录 / local 从本机软件导入 / file 从 JSON-ZIP 文件 / paste 粘贴 JSON）
type AddMethod = "oauth" | "local" | "file" | "paste";
const addOpen = ref(false);
const addChannel = ref<ProxyChannelId>("trae");
const addMethod = ref<AddMethod>("oauth");
const pasteJson = ref("");
const pasteMsg = ref("");
const pasteErr = ref(false);
const pasteBusy = ref(false);
const fileMsg = ref("");
const fileErr = ref(false);
const fileBusy = ref(false);
const oauthWaiting = ref(false);
const oauthMsg = ref("");
const oauthMode = ref("");
// 浏览器没跳回回环地址时的兜底：把地址栏整段粘回来
const callbackInput = ref("");
const callbackBusy = ref(false);
const callbackMsg = ref("");
// 本机软件导入：候选列表 + 逐条/一键导入
const scanList = ref<ProxyScanCandidate[]>([]);
const scanBusy = ref(false);
const scanMsg = ref("");
const scanErr = ref(false);
// 用「渠道:文件」当导入中的行标识：列表在导入过程中会被重新扫描替换，下标引用不稳
const scanImporting = ref("");

// 三渠道都支持官方登录：Trae SOLO CN 走回环 PKCE，WorkBuddy 双区走官方 state 轮询
const METHOD_TABS = computed(
  () =>
    [
      { key: "oauth" as const, label: "OAuth 登录", icon: "ph-key" },
      { key: "local" as const, label: "从本机软件导入", icon: "ph-desktop-tower" },
      { key: "file" as const, label: "从 JSON/ZIP 文件", icon: "ph-file-arrow-up" },
      { key: "paste" as const, label: "粘贴 JSON", icon: "ph-clipboard-text" },
    ] as { key: AddMethod; label: string; icon: string }[]
);

// OAuth 面板文案按渠道切换（两种登录形态完全不同，说清楚用户才知道要做什么）
const OAUTH_HELP: Record<string, { title: string; desc: string }> = {
  trae: {
    title: "用 Trae SOLO CN 官方授权页登录",
    desc: "跳转官方授权页（登录域由官方下发），授权后回调本机回环地址完成登录。<br />每账号独立执行一次，可反复添加多账号；3 分钟无响应即超时。<br />若浏览器停在回调页没自动跳回，可把地址栏内容整段粘到下方。",
  },
  workbuddy: {
    title: "用 WorkBuddy（中国区）官方登录页登录",
    desc: "跳转官方登录页，登录完成后本机每 1.5 秒轮询一次授权结果，无需手动回调。<br />每账号独立执行一次，可反复添加多账号；3 分钟无响应即超时。",
  },
  workbuddy_ai: {
    title: "用 WorkBuddy AI（国际版）官方登录页登录",
    desc: "跳转国际版官方登录页，登录完成后本机自动轮询授权结果。<br />每账号独立执行一次，可反复添加多账号；3 分钟无响应即超时。",
  },
};

// 粘贴 JSON 的字段示例（placeholder 用，随渠道切换 token 字段名提示）
const pastePlaceholder = computed(() => {
  const tokenKey = addChannel.value === "trae" ? "jwt" : "accessToken";
  return `单个对象或数组均可，字段容忍别名：\n{\n  "name": "主账号（选填）",\n  "${tokenKey}": "渠道原生 token（必填）",\n  "refreshToken": "选填",\n  "uid": "选填，缺省从 token 解析"\n}`;
});

// 移出确认
const delOpen = ref(false);
const delRow = ref<ProxyAccount | null>(null);

const STRATEGIES: { value: ProxyPoolStrategy; label: string }[] = [
  { value: "expire_first", label: "到期优先" },
  { value: "credit_first", label: "余额优先" },
  { value: "round_robin", label: "轮询" },
];

async function refresh() {
  try {
    pool.value = await api.proxyPool();
    ideStatus.value = await api.proxyIdeStatus().catch(() => null);
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

/** 一键把账号应用为本地 IDE 当前登录态（WB 双区写回 auth 文件；Trae 加密信封诚实降级） */
async function ideSwitch(acc: ProxyAccount) {
  if (ideSwitching.value) return;
  ideSwitching.value = acc.id;
  ideMsg.value = "";
  try {
    const r = await api.proxyIdeSwitch(acc.id);
    ideMsg.value = r.message || (r.ok ? "已切换" : "暂不支持");
  } catch (e) {
    ideMsg.value = String((e as Error).message || e);
  } finally {
    ideSwitching.value = "";
    ideStatus.value = await api.proxyIdeStatus().catch(() => ideStatus.value);
  }
}

/** 该账号能否写回本地客户端（Trae 的登录态是加密信封，写不了） */
function ideSupported(acc: ProxyAccount) {
  if (acc.channel === "trae") return false;
  if (!ideStatus.value) return true;
  return acc.channel === "workbuddy_ai" ? ideStatus.value.workbuddyAiInstalled !== false : ideStatus.value.workbuddyInstalled !== false;
}

function ideTitle(acc: ProxyAccount) {
  if (acc.channel === "trae") return "Trae 本地登录态为 ByteCrypto 加密信封（绑定设备密钥），无法构造合法信封，暂不支持写回";
  if (!ideSupported(acc)) return "本机未找到对应客户端的登录文件（未安装或从未登录过）";
  return `把该账号写为本地 ${channelName(acc.channel)} 当前登录态（需重启客户端）`;
}

async function refreshAllCredits() {
  if (refreshingAll.value) return;
  refreshingAll.value = true;
  try {
    await api.proxyCreditsRefresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    refreshingAll.value = false;
    await refresh();
  }
}

async function refreshOne(acc: ProxyAccount) {
  refreshingId.value = acc.id;
  try {
    await api.proxyAccountRefresh(acc.id);
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    refreshingId.value = "";
    await refresh();
  }
}

async function setStrategy(ch: ProxyChannelView, strategy: ProxyPoolStrategy) {
  try {
    await api.proxyPoolStrategy(ch.id, strategy);
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

async function toggleAccount(acc: ProxyAccount) {
  try {
    await api.proxyAccountToggle(acc.id, acc.status === "disabled");
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

async function doDelete() {
  if (!delRow.value) return;
  try {
    await api.proxyAccountRemove(delRow.value.id);
    delOpen.value = false;
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

// ===== 添加账号 =====

function openAdd(ch: ProxyChannelView) {
  addChannel.value = ch.id;
  addMethod.value = "oauth";
  pasteJson.value = "";
  pasteMsg.value = "";
  pasteErr.value = false;
  fileMsg.value = "";
  fileErr.value = false;
  oauthMsg.value = "";
  oauthMode.value = "";
  callbackInput.value = "";
  callbackMsg.value = "";
  scanMsg.value = "";
  scanErr.value = false;
  addOpen.value = true;
  loadScan(); // 打开即扫描本机，切到「从本机软件导入」时结果已经在了
}

/** 关弹窗：正在等待 OAuth 回调时一并取消，不留后台悬挂的授权流程 */
function closeAdd() {
  addOpen.value = false;
  if (oauthWaiting.value) cancelOauth();
}

function switchMethod(m: AddMethod) {
  if (oauthWaiting.value) return; // OAuth 等待回调期间不许切走，避免状态丢失
  addMethod.value = m;
  if (m === "local" && !scanList.value.length) loadScan();
}

async function beginOauth() {
  if (oauthWaiting.value) return;
  oauthWaiting.value = true;
  oauthMsg.value = "已在浏览器打开官方登录页，完成授权后自动加入号池（3 分钟超时）…";
  callbackMsg.value = "";
  try {
    const r = await api.proxyOauthBegin(addChannel.value);
    if (r.ok === false) {
      oauthMsg.value = r.message || "无法启动登录";
      oauthWaiting.value = false;
      return;
    }
    oauthMode.value = r.mode || "";
  } catch (e) {
    oauthMsg.value = String((e as Error).message || e);
    oauthWaiting.value = false;
  }
}

async function cancelOauth() {
  await api.proxyOauthCancel().catch(() => {});
  oauthWaiting.value = false;
  oauthMsg.value = "";
  oauthMode.value = "";
}

/** 兜底：把浏览器地址栏内容整段粘回来完成登录（仅回环模式用得上） */
async function submitCallback() {
  if (callbackBusy.value || !callbackInput.value.trim()) return;
  callbackBusy.value = true;
  callbackMsg.value = "";
  try {
    const r = await api.proxyOauthSubmitCallback(addChannel.value, callbackInput.value.trim());
    callbackMsg.value = r.ok ? "已提交，正在换取凭据…" : r.message || "提交失败";
    if (r.ok) callbackInput.value = "";
  } catch (e) {
    callbackMsg.value = String((e as Error).message || e);
  } finally {
    callbackBusy.value = false;
  }
}

// ===== 从本机软件导入（本机已登录的客户端里直接取凭据） =====

async function loadScan() {
  if (scanBusy.value) return;
  scanBusy.value = true;
  scanErr.value = false;
  try {
    scanList.value = await api.proxyScan();
    scanMsg.value = scanList.value.length ? `发现 ${scanList.value.length} 个候选登录态` : "未在本机发现可导入的登录态";
  } catch (e) {
    scanErr.value = true;
    scanMsg.value = String((e as Error).message || e);
  } finally {
    scanBusy.value = false;
  }
}

/** 候选排序：当前渠道优先，其次未导入的、能直接用的 */
const scanRows = computed(() =>
  [...scanList.value].sort((a, b) => {
    const ca = a.channel === addChannel.value ? 0 : 1;
    const cb = b.channel === addChannel.value ? 0 : 1;
    if (ca !== cb) return ca - cb;
    if (a.imported !== b.imported) return a.imported ? 1 : -1;
    return 0;
  })
);

const scanKey = (c: ProxyScanCandidate) => `${c.channel}:${c.file}`;

/**
 * 导入单个候选。下标只在"当下这一份列表"里有意义，主进程还会按 file/uid 复核一次；
 * 一键导入时列表会被重新扫描整体替换，所以这里不依赖旧下标，始终以 file/uid 为准
 */
async function importScan(c: ProxyScanCandidate, opts?: { silent?: boolean }) {
  if (scanImporting.value) return;
  scanImporting.value = scanKey(c);
  if (!opts?.silent) scanErr.value = false;
  try {
    const idx = scanList.value.indexOf(c);
    const r = await api.proxyScanImport(idx, c.channel, c.file, c.uid);
    scanMsg.value = r.message || (r.updated ? "已更新该账号凭据" : "已加入号池");
    if (!opts?.silent) {
      await loadScan();
      await refresh();
    }
    return r.ok;
  } catch (e) {
    scanErr.value = true;
    scanMsg.value = String((e as Error).message || e);
    return false;
  } finally {
    scanImporting.value = "";
  }
}

/** 一键导入全部可用候选（加密 / 已导入的跳过），跑完只刷新一次 */
async function importAllScan() {
  const targets = scanRows.value.filter((c) => !c.encrypted && !c.imported);
  if (!targets.length) {
    scanErr.value = true;
    scanMsg.value = "没有可导入的候选（已全部导入或不含可用凭据）";
    return;
  }
  let okCount = 0;
  for (const c of targets) {
    if (await importScan(c, { silent: true })) okCount++;
  }
  scanMsg.value = `已导入 ${okCount} 个账号`;
  await loadScan();
  await refresh();
}

// 粘贴 JSON：文本进主进程统一解析（单对象 / 数组 / {accounts:[]} 均可）
async function doPasteJson() {
  if (pasteBusy.value || !pasteJson.value.trim()) return;
  pasteBusy.value = true;
  pasteMsg.value = "";
  try {
    const r = await api.proxyAccountImportJson(addChannel.value, pasteJson.value);
    pasteErr.value = !r.ok;
    pasteMsg.value = r.message || (r.ok ? "导入完成" : "导入失败");
    if (r.ok) {
      await refresh();
      if ((r.added ?? 0) > 0) pasteJson.value = ""; // 有入账才清空，全失败时保留现场便于改
    }
  } catch (e) {
    pasteErr.value = true;
    pasteMsg.value = String((e as Error).message || e);
  } finally {
    pasteBusy.value = false;
  }
}

// 从 JSON/ZIP 文件添加：主进程弹文件框，zip 取包内全部 .json 合并导入
async function doImportFile() {
  if (fileBusy.value) return;
  fileBusy.value = true;
  fileMsg.value = "";
  try {
    const r = await api.proxyAccountImportFile(addChannel.value);
    if (r.canceled) return; // 用户取消选择，不留痕迹
    fileErr.value = !r.ok;
    fileMsg.value = r.message || (r.ok ? "导入完成" : "导入失败");
    if (r.ok) await refresh();
  } catch (e) {
    fileErr.value = true;
    fileMsg.value = String((e as Error).message || e);
  } finally {
    fileBusy.value = false;
  }
}

// ===== 号池 WebDAV 同步（加密压缩包，配置在左下角「设置 · WebDAV 同步」） =====
const syncStatus = ref<api.ProxyPoolSyncStatus | null>(null);
const syncMsg = ref("");
const syncing = computed(() => !!syncStatus.value?.running);

async function refreshSyncStatus() {
  try {
    syncStatus.value = await api.proxyPoolsyncStatus();
  } catch { /* 浏览器预览走 mock */ }
}
async function runPoolsync() {
  syncMsg.value = "";
  try {
    const r = await api.proxyPoolsyncRun();
    syncMsg.value = r?.ok ? r.summary || "同步完成" : r?.message || "同步失败";
  } catch (e) {
    syncMsg.value = String((e as Error).message || e);
  }
  await refreshSyncStatus();
  await refresh(); // 合并可能带新账号进来
}

onMounted(() => {
  refresh();
  refreshSyncStatus();
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string; ok?: boolean; message?: string; channel?: string; stage?: string; detail?: string; running?: boolean };
    if (p.event !== "proxy") return;
    if (p.type === "oauth-done") {
      oauthWaiting.value = false;
      oauthMode.value = "";
      oauthMsg.value = p.ok ? "登录成功，已加入号池" : `登录失败：${p.message || ""}`;
      if (p.ok) {
        addOpen.value = false;
        refresh();
      }
    } else if (p.type === "credits") {
      refresh();
    } else if (p.type === "poolsync") {
      // 号池同步进度：进行中更新状态行，结束时刷新号池
      if (syncStatus.value) {
        syncStatus.value.running = !!p.running;
        if (p.stage) syncStatus.value.stage = p.stage;
        syncStatus.value.detail = p.detail || "";
      }
      if (p.running === false) {
        refreshSyncStatus();
        refresh();
      }
    }
  });
});
onUnmounted(() => {
  if (offEvent) offEvent();
});
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <div class="page-title">号池</div>
        <div class="page-sub">各渠道各自独立号池</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" :disabled="refreshingAll" @click="refreshAllCredits">
          {{ refreshingAll ? "刷新中…" : "全部刷新" }}
        </button>
      </div>
    </div>
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>

      <!-- 号池 WebDAV 同步：加密压缩包多设备共享（服务器配置统一在「设置 · WebDAV 同步」） -->
      <div class="card pool-sync-card">
        <div class="ps-left">
          <div class="ps-title">
            号池同步
            <span class="tag" :class="syncStatus?.configured ? 'tag-ok' : 'tag-warn'">
              {{ syncing ? syncStatus?.detail || "同步中…" : syncStatus?.configured ? "已就绪" : "未配置" }}
            </span>
          </div>
          <div class="set-desc">
            账号（含凭据）打成加密压缩包经 WebDAV 共享，多设备按账号自动去重合并；移除账号同步生效到他机
          </div>
          <div class="set-desc" style="margin-top: 2px" v-if="syncStatus?.lastSyncAt">
            上次同步 {{ fmtAgo(syncStatus.lastSyncAt) }}<template v-if="syncStatus.lastSummary"> · {{ syncStatus.lastSummary }}</template>
          </div>
          <div class="set-desc err-text" v-if="syncStatus?.lastError && !syncing">上次失败：{{ syncStatus.lastError }}</div>
        </div>
        <div class="ps-actions">
          <span v-if="syncMsg" class="tag tag-ok">{{ syncMsg }}</span>
          <button v-if="!syncStatus?.configured" class="btn btn-sm" @click="app.openSettings('webdav')">去配置 WebDAV</button>
          <button v-else class="btn btn-sm" :disabled="syncing" @click="runPoolsync">{{ syncing ? "同步中…" : "同步号池" }}</button>
        </div>
      </div>
      <!-- 渠道 Tab：按钮切换，下方显示当前渠道号池 -->
      <div class="chips channel-tabs">
        <button
          v-for="ch in pool"
          :key="ch.id"
          class="chip"
          :class="{ active: activeChannel === ch.id }"
          @click="activeChannel = ch.id"
        >
          {{ ch.display }}
          <span class="tab-badge">{{ ch.summary.onlineCount }}/{{ ch.summary.accountCount }}</span>
        </button>
      </div>
      <div v-if="ideMsg" class="card" style="margin-bottom: 12px"><div class="set-desc">{{ ideMsg }}</div></div>
      <template v-for="ch in pool" :key="ch.id">
      <div v-if="ch.id === activeChannel" class="card" style="margin-bottom: 12px">
        <div class="card-title">
          {{ ch.display }}
          <span class="tag" :class="ch.summary.onlineCount > 0 ? 'tag-ok' : 'tag-dim'">
            {{ ch.summary.accountCount ? `${ch.summary.onlineCount}/${ch.summary.accountCount} 可用` : "空号池" }}
          </span>
          <span v-if="ch.summary.expiringSoon" class="tag tag-warn">24h 内有到期</span>
          <span class="right">
            <el-select
              :model-value="ch.poolStrategy"
              popper-class="glass-popper"
              size="small"
              class="strategy-select"
              @change="setStrategy(ch, $event as ProxyPoolStrategy)"
            >
              <el-option v-for="s in STRATEGIES" :key="s.value" :value="s.value" :label="s.label" />
            </el-select>
            <button class="btn btn-sm" @click="openAdd(ch)">添加账号</button>
          </span>
        </div>
        <!-- 聚合顶部（单一数据源实时推导） -->
        <div class="agg">
          <div class="agg-item"><span>总余额</span><b>{{ fmtInt(ch.summary.totalCredits) }}</b></div>
          <div class="agg-item"><span>账号数</span><b>{{ ch.summary.accountCount }}</b></div>
          <div class="agg-item"><span>可用</span><b>{{ ch.summary.onlineCount }}</b></div>
          <div class="agg-item"><span>最早到期</span><b>{{ ch.summary.earliestExpire ? fmtDate(ch.summary.earliestExpire) : "-" }}</b></div>
          <div class="agg-item"><span>今日消耗</span><b>{{ ch.summary.todayReq }} 次 · {{ fmtK(ch.summary.todayTokens) }}</b></div>
          <div class="agg-item"><span>上次刷新</span><b>{{ fmtAgo(ch.summary.lastCreditsAt) }}</b></div>
        </div>
        <!-- 账号明细 -->
        <div class="tbl-wrap" style="margin-top: 8px">
          <table class="tbl">
            <tbody>
              <tr><th>账号</th><th>UID</th><th>状态</th><th>余额</th><th>到期</th><th>来源</th><th>今日</th><th>操作</th></tr>
              <tr v-for="acc in ch.accounts" :key="acc.id">
                <td>{{ acc.name }}</td>
                <td class="mono">{{ acc.uid || "-" }}</td>
                <td>
                  <span class="tag" :class="ACCOUNT_STATUS[acc.status]?.cls || 'tag-dim'">
                    {{ ACCOUNT_STATUS[acc.status]?.text || acc.status }}
                  </span>
                  <span v-if="acc.coolReason" class="set-desc" style="margin-left: 4px">{{ acc.coolReason }}</span>
                </td>
                <td class="mono">{{ acc.hasToken ? fmtInt(acc.credits) : "-" }}</td>
                <td class="mono">{{ acc.expiresAt ? fmtDate(acc.expiresAt) : "-" }}</td>
                <td>{{ SOURCE_NAMES[acc.source] || acc.source }}</td>
                <td class="mono">{{ acc.todayReq }} · {{ fmtK(acc.todayTokens) }}</td>
                <td>
                  <button class="btn-link btn-sm" :disabled="refreshingId === acc.id" @click="refreshOne(acc)">
                    {{ refreshingId === acc.id ? "刷新中…" : "刷新" }}
                  </button>
                  <button
                    class="btn-link btn-sm"
                    :disabled="ideSwitching === acc.id || !ideSupported(acc)"
                    :title="ideTitle(acc)"
                    @click="ideSwitch(acc)"
                  >
                    {{ ideSwitching === acc.id ? "切换中…" : "切到 IDE" }}
                  </button>
                  <button class="btn-link btn-sm" @click="toggleAccount(acc)">{{ acc.status === "disabled" ? "启用" : "停用" }}</button>
                  <button class="btn-link btn-sm danger" @click="delRow = acc; delOpen = true">移出</button>
                </td>
              </tr>
              <tr v-if="!ch.accounts.length">
                <td colspan="8" style="text-align: center; color: var(--text-3); padding: 14px">
                  号池为空 —— 点「添加账号」：OAuth 登录 / 从本机软件导入 / 文件导入 / 手动粘贴
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      </template>
    </div>

    <!-- 添加账号弹窗（三方式：OAuth 登录 / 从 JSON/ZIP 文件 / 粘贴 JSON） -->
    <Teleport to="body">
      <div v-if="addOpen" class="p-mask" @click.self="closeAdd()">
        <div class="p-dlg glass add-dlg" role="dialog" aria-modal="true" aria-label="添加账号">
          <!-- 头部：图标 + 标题 + 入池渠道 + 关闭 -->
          <header class="add-head">
            <span class="add-head-icon"><i class="ph ph-user-plus"></i></span>
            <div class="add-head-text">
              <div class="add-title">
                添加账号
                <span class="add-chip">{{ pool.find((c) => c.id === addChannel)?.display || addChannel }}</span>
              </div>
              <div class="add-sub">凭据仅本机 DPAPI 加密保管，不入日志、不外发</div>
            </div>
            <button class="add-close" title="关闭" @click="closeAdd()"><i class="ph ph-x"></i></button>
          </header>

          <!-- 方式切换：分段控件 -->
          <div class="add-tabs">
            <button
              v-for="t in METHOD_TABS"
              :key="t.key"
              class="add-tab"
              :class="{ active: addMethod === t.key, disabled: oauthWaiting && addMethod === 'oauth' && t.key !== 'oauth' }"
              @click="switchMethod(t.key)"
            >
              <i class="ph" :class="t.icon"></i>{{ t.label }}
            </button>
          </div>

          <!-- 方式内容：各面板共用固定高度，切换时弹窗不跳高度 -->
          <div class="add-body">
            <!-- OAuth 官方登录（三渠道各自主流形态） -->
            <div v-if="addMethod === 'oauth'" class="add-pane center">
              <div class="add-pane-icon"><i class="ph ph-key"></i></div>
              <div class="add-pane-title">{{ OAUTH_HELP[addChannel]?.title || "用官方登录页登录" }}</div>
              <div class="add-pane-desc" v-html="OAUTH_HELP[addChannel]?.desc || ''"></div>
              <!-- 回环模式下浏览器没跳回来时的兜底：整段粘贴回调地址 -->
              <div v-if="oauthMode === 'loopback' && oauthWaiting" class="cb-row">
                <input v-model="callbackInput" class="input" style="flex: 1" placeholder="浏览器没跳回？把地址栏整段粘到这里" />
                <button class="btn btn-sm" :disabled="!callbackInput.trim() || callbackBusy" @click="submitCallback">
                  {{ callbackBusy ? "提交中…" : "提交" }}
                </button>
              </div>
              <div v-if="callbackMsg" class="add-msg">{{ callbackMsg }}</div>
              <div v-if="oauthMsg" class="add-msg" :class="{ err: !oauthWaiting && oauthMsg.includes('失败') }">{{ oauthMsg }}</div>
            </div>

            <!-- 从本机软件导入：读本机已登录客户端的凭据，零请求入池 -->
            <div v-else-if="addMethod === 'local'" class="add-pane">
              <div class="scan-head">
                <span class="scan-hint">读取本机已登录客户端的登录态，凭据不出本机</span>
                <button class="btn btn-sm" :disabled="scanBusy" @click="loadScan">{{ scanBusy ? "扫描中…" : "重新扫描" }}</button>
                <button class="btn btn-sm" :disabled="scanBusy || !scanRows.length" @click="importAllScan">全部导入</button>
              </div>
              <div class="scan-list">
                <div v-for="(c, i) in scanRows" :key="`${c.channel}-${c.uid || i}`" class="scan-row" :class="{ dim: c.imported || c.encrypted }">
                  <span class="scan-ch">{{ channelName(c.channel) }}</span>
                  <div class="scan-main">
                    <div class="scan-name">
                      {{ c.name || c.uid || "（未识别账号）" }}
                      <span v-if="c.imported" class="tag tag-ok">已导入</span>
                      <span v-else-if="c.encrypted" class="tag tag-warn">加密不可读</span>
                    </div>
                    <div class="scan-file">{{ c.file }}<template v-if="c.credits"> · 余额 {{ fmtInt(c.credits) }}</template></div>
                  </div>
                  <button
                    class="btn btn-sm"
                    :disabled="c.imported || c.encrypted || !!scanImporting"
                    :title="c.encrypted ? '本机登录态已加密，请改用 OAuth 登录' : ''"
                    @click="importScan(c)"
                  >
                    {{ scanImporting === scanKey(c) ? "导入中…" : c.imported ? "已导入" : "导入" }}
                  </button>
                </div>
                <div v-if="!scanRows.length" class="scan-empty">
                  未在本机发现可导入的登录态 —— 请先在本机登录对应客户端，或改用「OAuth 登录」
                </div>
              </div>
              <div v-if="scanMsg" class="add-msg" :class="{ err: scanErr }">{{ scanMsg }}</div>
            </div>

            <!-- 从 JSON/ZIP 文件添加 -->
            <div v-else-if="addMethod === 'file'" class="add-pane center">
              <div class="add-pane-icon"><i class="ph ph-file-arrow-up"></i></div>
              <div class="add-pane-title">从导出文件批量入池</div>
              <div class="add-pane-desc">
                <span class="mono">.json</span> 支持单对象 / 数组 / <span class="mono">{accounts:[]}</span> 包装；<br />
                <span class="mono">.zip</span> 会读取包内全部 .json 合并导入，同渠道同 UID 自动跳过。
              </div>
              <div v-if="fileMsg" class="add-msg" :class="{ err: fileErr }">{{ fileMsg }}</div>
            </div>

            <!-- 粘贴 JSON -->
            <div v-else class="add-pane paste-pane">
              <div class="paste-label">凭据 JSON</div>
              <textarea
                v-model="pasteJson"
                class="input mono paste-area"
                :placeholder="pastePlaceholder"
                spellcheck="false"
              ></textarea>
              <div v-if="pasteMsg" class="add-msg" :class="{ err: pasteErr }">{{ pasteMsg }}</div>
            </div>
          </div>

          <!-- 底部操作：左侧状态/提示，右侧按方式给对应主操作 -->
          <footer class="add-foot">
            <span class="add-foot-hint">
              <template v-if="addMethod === 'oauth' && oauthWaiting"><i class="ph ph-circle-notch"></i>已在浏览器打开登录页，完成后会自动入池</template>
              <template v-else-if="addMethod === 'local'">导入后仍可刷新余额、切到 IDE 或停用</template>
              <template v-else>入池后可在下方列表里刷新余额、切到 IDE 或停用</template>
            </span>
            <button class="btn" @click="closeAdd()">{{ addMethod === "oauth" && oauthWaiting ? "取消登录" : "取消" }}</button>

            <button
              v-if="addMethod === 'oauth'"
              class="btn btn-cta"
              :disabled="oauthWaiting"
              @click="beginOauth"
            >{{ oauthWaiting ? "等待授权…" : "打开登录页" }}</button>
            <button
              v-else-if="addMethod === 'file'"
              class="btn btn-cta"
              :disabled="fileBusy"
              @click="doImportFile"
            >{{ fileBusy ? "导入中…" : "选择文件…" }}</button>
            <button
              v-else-if="addMethod === 'paste'"
              class="btn btn-cta"
              :disabled="!pasteJson.trim() || pasteBusy"
              @click="doPasteJson"
            >{{ pasteBusy ? "导入中…" : "解析并加入号池" }}</button>
            <button
              v-else
              class="btn btn-cta"
              :disabled="scanBusy || !scanRows.some((c) => !c.imported && !c.encrypted)"
              @click="importAllScan"
            >加入号池</button>
          </footer>
        </div>
      </div>

      <!-- 移出确认 -->
      <div v-if="delOpen" class="p-mask" @click.self="delOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">移出号池</div>
          <div class="set-desc">
            确定把「{{ delRow?.name }}」移出号池？本地加密保管的凭据会一并删除，该账号不再参与调度。
          </div>
          <div class="p-actions">
            <button class="btn" @click="delOpen = false">取消</button>
            <button class="btn btn-primary danger-solid" @click="doDelete">移出</button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
.channel-tabs {
  margin-bottom: 12px;
}
.tab-badge {
  margin-left: 6px;
  font-family: var(--font-mono);
  font-size: 10px;
  opacity: 0.75;
}
.danger {
  color: var(--err, #e05555);
}
.agg {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
  margin-top: 4px;
}
.agg-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.agg-item span {
  font-size: 10px;
  color: var(--text-3);
}
.agg-item b {
  font-family: var(--font-mono);
  font-size: 13px;
}
.select-sm {
  margin-right: 8px;
}
/* 策略下拉与「添加账号」按钮同为小控件档（--ctl-h-sm = 24px），严格同高对齐 */
.strategy-select {
  width: 108px;
  margin-right: 8px;
  vertical-align: middle;
}
.strategy-select :deep(.el-select__wrapper) {
  min-height: var(--ctl-h-sm);
  font-size: 11px;
}
/* ===== 添加账号弹窗：头部 + 分段方式切换 + 等高面板 + 固定底部操作（弹窗外壳版式见 global.css 的 .p-dlg） ===== */
.add-dlg {
  width: 560px;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.add-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 18px 13px;
  border-bottom: 1px solid var(--line);
}
.add-head-icon {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--r-sm);
  background: var(--accent-dim);
  color: var(--accent);
  font-size: 17px;
}
.add-head-text {
  flex: 1;
  min-width: 0;
}
.add-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
}
.add-chip {
  padding: 2px 8px;
  border-radius: var(--r-pill);
  border: 1px solid var(--accent-line);
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}
.add-sub {
  font-size: 10.5px;
  color: var(--text-3);
  margin-top: 3px;
}
.add-close {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--bg-soft);
  color: var(--text-3);
  cursor: pointer;
  font-size: 13px;
  transition: color 0.15s, border-color 0.15s, transform 0.2s var(--ease);
}
.add-close:hover {
  color: var(--text);
  border-color: var(--accent-line);
  transform: rotate(90deg);
}
.add-tabs {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 4px;
  margin: 14px 18px 0;
  padding: 4px;
  border-radius: var(--r-ctl);
  background: var(--bg-soft);
  border: 1px solid var(--line);
}
.add-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  font-family: var(--font-ui);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.add-tab:hover {
  color: var(--text);
}
.add-tab.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
  font-weight: 600;
}
.add-tab.disabled {
  opacity: 0.4;
  pointer-events: none;
}
/* 定高内容区：三种方式共用一个高度，切 tab 时弹窗不跳 */
.add-body {
  height: 248px;
  display: flex;
  flex-direction: column;
  padding: 16px 18px 4px;
}
.add-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.add-pane.center {
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 10px;
}
.add-pane-icon {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--r-ctl);
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-size: 21px;
}
.add-pane-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.add-pane-desc {
  font-size: 11px;
  line-height: 1.75;
  color: var(--text-3);
  max-width: 420px;
}
.add-msg {
  font-size: 11px;
  line-height: 1.6;
  color: var(--ok, var(--accent-strong));
  word-break: break-all;
  max-width: 100%;
}
.add-msg.err {
  color: var(--err, #e05555);
}
/* 粘贴面板：标签 + 撑满的文本域 */
.paste-pane {
  gap: 8px;
}
.paste-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
}
.paste-area {
  flex: 1;
  width: 100%;
  min-height: 0;
  padding: 9px 11px;
  resize: none;
  line-height: 1.6;
  font-size: 11.5px;
}
.add-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px 14px;
  border-top: 1px solid var(--line);
  margin-top: 12px;
}
.add-foot-hint {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-3);
}
.add-foot-hint .ph {
  font-size: 13px;
}
.mono {
  font-family: var(--font-code);
}

/* ===== 本机软件导入面板：候选列表（等高面板内滚，避免撑高弹窗） ===== */
.scan-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.scan-hint {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scan-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
.scan-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
}
.scan-row:last-child {
  border-bottom: none;
}
.scan-row.dim {
  opacity: 0.62;
}
.scan-ch {
  flex-shrink: 0;
  width: 96px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scan-main {
  flex: 1;
  min-width: 0;
}
.scan-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scan-file {
  font-size: 10px;
  color: var(--text-3);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scan-empty {
  padding: 22px 12px;
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.7;
}
/* 回调地址兜底行：输入框 + 提交按钮等高并排 */
.cb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 420px;
}

/* 号池同步卡片：左状态说明 + 右操作 */
.pool-sync-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
}
.ps-left {
  flex: 1;
  min-width: 0;
}
.ps-title {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.ps-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
</style>

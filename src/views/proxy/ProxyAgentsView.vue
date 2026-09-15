<!-- 反代网关 · 号池：各渠道独立号池（方案 §6.10 / §7 agents.html）
     聚合顶部（总余额/账号数/可用/最早到期/今日消耗）+ 账号明细 + 多途径添加（扫描/OAuth/粘贴）+ 池内调度策略 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import * as api from "../../api/ipc";
import type { ProxyChannelView, ProxyAccount, ProxyScanCandidate, ProxyChannelId, ProxyPoolStrategy } from "../../types";
import { useAppStore } from "../../stores/app";
import { fmtInt, fmtK, fmtDate, fmtAgo, ACCOUNT_STATUS, SOURCE_NAMES } from "./format";

const app = useAppStore();
const pool = ref<ProxyChannelView[]>([]);
const err = ref("");
const refreshingAll = ref(false);
const refreshingId = ref("");
// 渠道 Tab：顶部按钮切换，下方只显示当前渠道号池
const activeChannel = ref<ProxyChannelId>("trae");
// 本地 IDE 快捷切换
const ideStatus = ref<{ workbuddyInstalled: boolean; currentUid: string } | null>(null);
const ideMsg = ref("");
const ideSwitching = ref("");
let offEvent: (() => void) | undefined;

// 添加账号弹窗（三途径：scan / oauth / paste）
const addOpen = ref(false);
const addChannel = ref<ProxyChannelId>("trae");
const addMethod = ref<"scan" | "oauth" | "paste">("scan");
const scanList = ref<ProxyScanCandidate[]>([]);
const scanning = ref(false);
const pasteForm = ref({ name: "", token: "", refreshToken: "" });
const oauthWaiting = ref(false);
const oauthMsg = ref("");

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

/** 一键把账号应用为本地 IDE 当前登录态（WB 写回 auth 文件；Trae 加密信封诚实降级） */
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
  addMethod.value = ch.id === "trae" ? "oauth" : "scan";
  pasteForm.value = { name: "", token: "", refreshToken: "" };
  oauthMsg.value = "";
  addOpen.value = true;
  if (addMethod.value === "scan") doScan();
}

async function doScan() {
  scanning.value = true;
  try {
    scanList.value = await api.proxyScan();
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    scanning.value = false;
  }
}

async function importScan(c: ProxyScanCandidate, index: number) {
  try {
    await api.proxyScanImport(index, c.channel === addChannel.value ? undefined : addChannel.value);
    addOpen.value = false;
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

async function beginOauth() {
  if (oauthWaiting.value) return;
  oauthWaiting.value = true;
  oauthMsg.value = "已在浏览器打开登录页，完成授权后自动加入号池（3 分钟超时）…";
  try {
    const r = await api.proxyOauthBegin();
    if (r.ok === false) {
      oauthMsg.value = r.message || "无法启动登录";
      oauthWaiting.value = false;
    }
    // 结果经 app:event(proxy/oauth-done) 回流
  } catch (e) {
    oauthMsg.value = String((e as Error).message || e);
    oauthWaiting.value = false;
  }
}

async function cancelOauth() {
  await api.proxyOauthCancel().catch(() => {});
  oauthWaiting.value = false;
  oauthMsg.value = "";
}

async function doPaste() {
  try {
    await api.proxyAccountAdd({
      channel: addChannel.value,
      name: pasteForm.value.name,
      token: pasteForm.value.token,
      refreshToken: pasteForm.value.refreshToken,
    });
    addOpen.value = false;
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
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

function channelCandidates(ch: ProxyChannelId) {
  // Trae 的扫描结果（encrypted 信封）只在 trae 渠道展示；WB 扫描结果两个 WB 渠道都可导入
  return scanList.value.filter((c) =>
    ch === "trae" ? c.channel === "trae" : c.channel === "workbuddy" || c.channel === "workbuddy_ai"
  );
}

onMounted(() => {
  refresh();
  refreshSyncStatus();
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string; ok?: boolean; message?: string; stage?: string; detail?: string; running?: boolean };
    if (p.event !== "proxy") return;
    if (p.type === "oauth-done") {
      oauthWaiting.value = false;
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
            <select class="select select-sm" :value="ch.poolStrategy" @change="setStrategy(ch, ($event.target as HTMLSelectElement).value as ProxyPoolStrategy)">
              <option v-for="s in STRATEGIES" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
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
                    :disabled="ideSwitching === acc.id"
                    :title="acc.channel === 'trae' ? 'Trae 本地登录态为加密信封，暂不支持写回' : '把该账号写为本地 WorkBuddy 当前登录态（需重启客户端）'"
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
                  号池为空 —— 点「添加账号」：本地扫描 / OAuth 登录 / 手动粘贴
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      </template>
    </div>

    <!-- 添加账号弹窗（三途径） -->
    <Teleport to="body">
      <div v-if="addOpen" class="p-mask" @click.self="addOpen = false; cancelOauth()">
        <div class="p-dlg glass">
          <div class="p-title">添加账号 —— {{ pool.find((c) => c.id === addChannel)?.display }}</div>
          <div class="chips" style="margin-bottom: 12px">
            <button v-if="addChannel !== 'trae'" class="chip" :class="{ active: addMethod === 'scan' }" @click="addMethod = 'scan'; doScan()">本地扫描</button>
            <button v-if="addChannel === 'trae'" class="chip" :class="{ active: addMethod === 'oauth' }" @click="addMethod = 'oauth'">OAuth 登录</button>
            <button class="chip" :class="{ active: addMethod === 'paste' }" @click="addMethod = 'paste'">手动粘贴</button>
          </div>

          <!-- 本地扫描（WorkBuddy 双区） -->
          <div v-if="addMethod === 'scan'">
            <div class="set-desc" style="margin-bottom: 8px">
              扫描本机 CodeBuddyExtension auth 目录（当前登录态 + 历史快照），凭据仅本地加密存储。
              <button class="btn-link btn-sm" @click="doScan">{{ scanning ? "扫描中…" : "重新扫描" }}</button>
            </div>
            <div v-for="(c, i) in channelCandidates(addChannel)" :key="i" class="row scan-row">
              <div class="grow">
                <div class="name">{{ c.name || c.uid || c.file }}</div>
                <div class="set-desc">{{ c.file }} · uid {{ c.uid || "-" }}<span v-if="c.encrypted"> · 登录态已加密，请改用 OAuth / 粘贴</span></div>
              </div>
              <span v-if="c.imported" class="tag tag-dim">已入池</span>
              <button v-else-if="!c.encrypted" class="btn btn-sm" @click="importScan(c, scanList.indexOf(c))">导入</button>
            </div>
            <div v-if="!scanning && !channelCandidates(addChannel).length" class="set-desc" style="padding: 8px 0">
              未发现本机登录态 —— 确认已安装并登录对应软件，或改用手动粘贴
            </div>
          </div>

          <!-- OAuth 登录（Trae） -->
          <div v-else-if="addMethod === 'oauth'">
            <div class="set-desc" style="margin-bottom: 10px">
              跳转 Trae 官方授权页，回调本机回环地址（127.0.0.1:17388）完成登录；每账号独立执行，可反复添加多账号。
            </div>
            <div v-if="oauthMsg" class="set-desc" style="margin-bottom: 10px">{{ oauthMsg }}</div>
            <div class="p-actions" style="margin-top: 0">
              <button v-if="oauthWaiting" class="btn" @click="cancelOauth">取消登录</button>
              <button class="btn btn-primary" :disabled="oauthWaiting" @click="beginOauth">
                {{ oauthWaiting ? "等待授权…" : "打开登录页" }}
              </button>
            </div>
          </div>

          <!-- 手动粘贴 -->
          <div v-else>
            <div class="set-row">
              <div class="set-info"><div class="set-name">备注名</div></div>
              <input v-model="pasteForm.name" class="input" style="width: 170px" placeholder="选填" />
            </div>
            <div class="set-row">
              <div class="set-info">
                <div class="set-name">{{ addChannel === "trae" ? "JWT（Cloud-IDE-JWT）" : "accessToken" }}</div>
              </div>
              <input v-model="pasteForm.token" class="input mono" style="width: 240px" placeholder="sk- 以外，渠道原生 token" />
            </div>
            <div class="set-row">
              <div class="set-info"><div class="set-name">refreshToken（选填）</div></div>
              <input v-model="pasteForm.refreshToken" class="input mono" style="width: 240px" />
            </div>
            <div class="p-actions">
              <button class="btn" @click="addOpen = false">取消</button>
              <button class="btn btn-primary" :disabled="!pasteForm.token.trim()" @click="doPaste">加入号池</button>
            </div>
          </div>
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
.scan-row {
  padding: 6px 0;
}
.p-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(0, 0, 0, 0.45);
  display: grid;
  place-items: center;
}
.p-dlg {
  width: 480px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 96px);
  overflow: auto;
  border-radius: var(--r-panel);
  padding: 16px 18px;
}
.p-title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 12px;
}
.p-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.danger-solid {
  background: var(--err, #e05555);
  border-color: var(--err, #e05555);
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

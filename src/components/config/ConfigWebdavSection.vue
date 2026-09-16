<!-- 设置弹窗 · WebDAV 同步：统一服务器 + 模块根目录/预设/电脑名 + 反代号池同步
     技能仓库的「中央仓库同步」运行器（进度/日志/设备/报告）不在弹窗里：
     移到了技能仓库模块顶部「WebDAV 同步」页（views/skills/SkillsWebdavView.vue） -->
<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import * as api from "../../api/ipc";
import { webdavStatus, onUpdateEvent, type WebDavStatus } from "../../api/ipc";
import { useAppStore } from "../../stores/app";
import { useSyncStore } from "../../stores/sync";

const app = useAppStore();
const syncApp = useSyncStore();

// 连接状态只用来在页头显示「已连接就绪 / 未配置」（运行器在技能仓库 · WebDAV 同步页）
const status = ref<WebDavStatus | null>(null);
const configured = computed(() => !!status.value?.configured);

// 每次激活都重拉状态与共享配置（服务器配置在本页改，改完主进程即时生效）
const active = computed(() => app.settingsOpen && app.settingsTab === "webdav");
watch(active, (v) => { if (v) loadPage(); }, { immediate: true });

async function refreshStatus() {
  try {
    status.value = await webdavStatus();
  } catch { /* 保留旧值 */ }
}

// 激活即加载：状态 / 共享配置 / 号池状态
async function loadPage() {
  await refreshStatus();
  loadShared();
  refreshPoolsync();
}

// ===== 统一 WebDAV 服务器（webdavShared）：技能仓库 / 用量统计 / 反代网关共用 =====
const SYNC_PASSWORD_MASK = "••••••••"; // 与后端掩码约定一致：精确掩码视为「未修改密码」
const shared = ref<api.SharedWebdavConfig>({
  endpoint: "",
  username: "",
  password: "",
  roots: { skills: "/agent-skills", usage: "/dosage-sync", proxy: "/agenthub-proxy" },
});
const sharedTestResult = ref<{ ok: boolean; message: string } | null>(null);
const sharedSaveMsg = ref("");
const sharedTesting = ref(false);
const sharedSaving = ref(false);

// 密码框防误触：显示的是掩码，任何编辑（哪怕只删一个字符）都先清空，避免残缺掩码被当新密码落盘
function onSharedPasswordInput() {
  const v = shared.value.password;
  if (v !== SYNC_PASSWORD_MASK && v.includes("•")) shared.value.password = "";
}
async function testShared() {
  sharedTestResult.value = null;
  sharedTesting.value = true;
  try {
    sharedTestResult.value = await api.webdavSharedTest(shared.value);
  } catch (e) {
    sharedTestResult.value = { ok: false, message: String((e as Error).message || e) };
  } finally {
    sharedTesting.value = false;
  }
}
async function saveShared() {
  sharedSaveMsg.value = "";
  sharedSaving.value = true;
  try {
    const r = await api.webdavSharedSave(shared.value);
    sharedSaveMsg.value = r?.ok ? "已保存，三个模块的同步即刻生效" : r?.message || "保存失败";
    if (r?.ok) {
      // 回读掩码态（密码不回显明文）；用量模块内存配置的服务器字段也要刷新
      await loadShared();
      await syncApp.reloadConfig().catch(() => {});
      refreshPoolsync();
      await refreshStatus();
    }
  } catch (e) {
    sharedSaveMsg.value = String((e as Error).message || e);
  } finally {
    sharedSaving.value = false;
  }
}
async function loadShared() {
  try {
    shared.value = await api.webdavSharedGet();
  } catch { /* 浏览器预览走 mock */ }
}

// ---- 用量统计模块附带项（跟随共享服务器；预设与电脑名仍存用量模块自己配置里） ----
const syncCfg = syncApp.config;
// 存储预设（仅备忘记忆）：跟随用量模块配置里的 webdav.preset 字段
const usagePreset = computed({
  get: () => syncCfg.webdav.preset,
  set: (v) => { syncCfg.webdav.preset = v; },
});
const usagePresets = [
  { key: "feiniu", label: "飞牛 fnOS" },
  { key: "nextcloud", label: "Nextcloud" },
  { key: "nutstore", label: "坚果云" },
  { key: "synology", label: "群晖" },
  { key: "custom", label: "自定义" },
];
const usageExtraMsg = ref("");
async function saveUsageExtra() {
  usageExtraMsg.value = "";
  const r = await syncApp.save();
  usageExtraMsg.value = r?.ok ? "已保存" : r?.message || "保存失败";
  window.setTimeout(() => (usageExtraMsg.value = ""), 3200);
}

// ---- 反代网关号池同步（压缩包用 WebDAV 密码加密；进度走 app:event 推送） ----
const poolsync = ref<api.ProxyPoolSyncStatus | null>(null);
const poolsyncMsg = ref("");
const poolsyncRunning = computed(() => !!poolsync.value?.running);
let offPoolsync: (() => void) | undefined;

async function refreshPoolsync() {
  try {
    poolsync.value = await api.proxyPoolsyncStatus();
  } catch { /* 浏览器预览走 mock */ }
}
async function runPoolsync() {
  poolsyncMsg.value = "";
  try {
    const r = await api.proxyPoolsyncRun();
    poolsyncMsg.value = r?.ok ? r.summary || "同步完成" : r?.message || "同步失败";
  } catch (e) {
    poolsyncMsg.value = String((e as Error).message || e);
  }
  await refreshPoolsync();
}
function fmtAgoMs(ms: number) {
  if (!ms) return "从未同步";
  const diff = Date.now() - ms;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

// 号池同步进度（proxy 事件流里的 poolsync 子事件）
onMounted(() => {
  offPoolsync = onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string; stage?: string; detail?: string; running?: boolean };
    if (p?.event !== "proxy" || p?.type !== "poolsync" || !poolsync.value) return;
    poolsync.value.running = !!p.running;
    if (p.stage) poolsync.value.stage = p.stage;
    poolsync.value.detail = p.detail || "";
  });
});
onUnmounted(() => {
  if (offPoolsync) offPoolsync();
});
</script>

<template>
  <div class="cfg-sec">
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">WebDAV 同步</div>
        <div class="cfg-sec-sub">统一服务器 · 模块根目录 · 号池同步（三个模块共用这一台服务器）。技能仓库的「中央仓库同步」运行器在「技能仓库 · WebDAV 同步」页。</div>
      </div>
      <div class="cfg-sec-actions">
        <el-tag :type="configured ? 'success' : 'info'" effect="plain" round>
          <i class="ph" :class="configured ? 'ph-cloud-check' : 'ph-cloud-slash'"></i>
          {{ configured ? "已连接就绪" : "未配置" }}
        </el-tag>
      </div>
    </div>

    <div class="sk-note warn" v-if="status && !configured">
      <i class="ph ph-cloud-slash"></i>
      <div>还没配置 WebDAV 服务器。在下方「统一 WebDAV 服务器」填好地址、账号与应用密码并保存，即可开始跨设备同步。</div>
    </div>

    <!-- 统一 WebDAV 服务器：三个模块共用这一套凭据，根目录各自隔离 -->
    <div class="sync-scope" style="display:flex; flex-direction:column; gap:12px">
      <div class="card" style="padding: 16px 18px">
        <div class="setting-group" style="margin-bottom: 0">
          <div class="sg-title" style="margin-bottom: 12px">
            统一 WebDAV 服务器
            <span class="sg-hint">技能仓库 / 用量统计 / 反代网关三套同步共用 · 密码经系统密钥加密保存，界面只显示掩码</span>
          </div>
          <div class="form-grid">
            <div class="form-field"><label>服务器地址（WebDAV）</label><input class="f-input" v-model="shared.endpoint" placeholder="https://dav.jianguoyun.com/dav" /></div>
            <div class="form-field"><label>账号</label><input class="f-input" v-model="shared.username" autocomplete="off" /></div>
            <div class="form-field full"><label>密码（同时作为反代号池压缩包的加密口令，多设备必须一致）</label><input class="f-input" type="password" v-model="shared.password" autocomplete="new-password" placeholder="已保存密码显示为掩码；输入任意字符即进入修改，请填写完整新密码" @input="onSharedPasswordInput" /></div>
            <div class="form-field full">
              <button class="btn-outline" :disabled="sharedTesting" @click="testShared">{{ sharedTesting ? "测试中…" : "测试连接" }}</button>
              <button class="btn btn-cta" :disabled="sharedSaving" @click="saveShared">{{ sharedSaving ? "保存中" : "保存设置" }}</button>
              <span v-if="sharedTestResult" class="hint" :style="{ marginLeft: '10px', color: sharedTestResult.ok ? 'var(--ok)' : 'var(--err)' }">{{ sharedTestResult.message }}</span>
              <span v-else-if="sharedSaveMsg" class="hint" style="margin-left: 10px">{{ sharedSaveMsg }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 各模块根目录：同一台服务器上的隔离目录（默认值即存量数据位置，勿轻易改） -->
      <div class="card" style="padding: 16px 18px">
        <div class="setting-group" style="margin-bottom: 0">
          <div class="sg-title" style="margin-bottom: 12px">
            模块根目录
            <span class="sg-hint">三个模块在同一网盘上的隔离目录 · 改根目录 = 换一个全新数据位置（旧数据不搬）</span>
          </div>
          <div class="form-grid">
            <div class="form-field"><label>技能仓库（存量默认 /agent-skills）</label><input class="f-input mono" v-model="shared.roots.skills" placeholder="/agent-skills" /></div>
            <div class="form-field"><label>用量统计（存量默认 /dosage-sync）</label><input class="f-input mono" v-model="shared.roots.usage" placeholder="/dosage-sync" /></div>
            <div class="form-field"><label>反代网关号池（默认 /agenthub-proxy）</label><input class="f-input mono" v-model="shared.roots.proxy" placeholder="/agenthub-proxy" /></div>
            <div class="form-field"><label>存储预设（仅备忘，帮你记服务器是哪家的）</label>
              <select class="f-select" v-model="usagePreset"><option v-for="p in usagePresets" :key="p.key" :value="p.key">{{ p.label }}</option></select>
            </div>
            <div class="form-field"><label>电脑名（用量统计多设备列表里显示）</label><input class="f-input" v-model="syncCfg.deviceName" placeholder="如：公司笔记本" /></div>
            <div class="form-field" style="align-self:end">
              <button class="btn-outline" @click="saveUsageExtra">保存预设与电脑名</button>
              <span v-if="usageExtraMsg" class="hint" style="margin-left: 10px">{{ usageExtraMsg }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 反代网关号池同步：压缩包 + 加密 + 自动去重合并 -->
    <div class="sync-scope">
      <div class="card" style="padding: 6px 18px">
        <div class="switch-row" style="align-items: flex-start">
          <div class="s-left">
            <div class="s-title">反代网关 · 号池同步</div>
            <div class="s-desc">把号池账号（含登录凭据）打成加密压缩包上传到 WebDAV，其他电脑拉取后按账号自动去重合并；本机移除账号会同步移除他机</div>
            <div class="s-desc" style="color: var(--text-3); margin-top: 2px">
              压缩包用上面的 WebDAV 密码加密（AES-256-GCM），各设备密码须一致 · 根目录 {{ shared.roots.proxy || "/agenthub-proxy" }}
            </div>
            <div class="s-desc" style="margin-top: 2px" v-if="poolsync">
              <span :style="{ color: poolsync.configured ? 'var(--ok)' : 'var(--warn)' }">{{ poolsync.configured ? "已就绪" : "未配置" }}</span>
              <template v-if="poolsync.lastSyncAt"> · 上次同步 {{ fmtAgoMs(poolsync.lastSyncAt) }}</template>
              <template v-if="poolsync.lastSummary">（{{ poolsync.lastSummary }}）</template>
            </div>
            <div class="s-desc" v-if="poolsync?.lastError" :style="{ color: 'var(--err)' }">上次失败：{{ poolsync.lastError }}</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px; flex-shrink: 0">
            <span v-if="poolsyncMsg" class="hint">{{ poolsyncMsg }}</span>
            <button class="btn-outline" :disabled="poolsyncRunning" @click="runPoolsync">{{ poolsyncRunning ? "同步中…" : "立即同步号池" }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

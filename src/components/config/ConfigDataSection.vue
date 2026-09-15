<!-- 设置弹窗 · 数据与备份：本机存储（备份压缩包 / 整包还原 / 数据缓存目录）
     WebDAV 云端侧在同弹窗的「WebDAV 同步」模块 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import { useSyncStore } from "../../stores/sync";
import { useUsageStore } from "../../stores/usage";
import * as syncApi from "../../api/sync";
import type { BackupInfo } from "../../types/sync";

const framework = useAppStore();
const syncApp = useSyncStore();
const syncCfg = syncApp.config;
const usage = useUsageStore();

const backupInfo = ref<BackupInfo | null>(null);
const backupBusy = ref(false); // 恢复进行中（备份走同步引擎，看 syncApp.syncing / syncApp.sync.running）
const backupResult = ref<{ ok: boolean; message: string } | null>(null);
let backupResultTimer = 0;
const backupButtonDisabled = computed(() => syncApp.syncing || syncApp.sync.running || backupBusy.value);

const dataDirInfo = ref<{ dataDir: string; defaultDataDir: string; isCustom: boolean } | null>(null);
const dataDirInput = ref(""); // 手动输入的新路径（仅编辑态使用）
const dataDirResult = ref<{ ok: boolean; message: string } | null>(null);
const editingDataDir = ref(false);
let dataDirResultTimer = 0;

// 每次激活都重拉备份信息与缓存目录（可能在别处被改动）
const active = computed(() => framework.settingsOpen && framework.settingsTab === "data");
watch(active, (v) => { if (v) { refreshBackupInfo(); loadDataDirInfo(); } }, { immediate: true });

async function refreshBackupInfo() {
  try {
    backupInfo.value = await syncApi.getBackupInfo();
  } catch {
    backupInfo.value = null;
  }
}
/** 修改备份目录：复用系统目录选择对话框，选定即落盘 */
async function browseBackupDir() {
  const r = await syncApi.browseDataDir();
  if (r?.ok && r.path) {
    syncCfg.localBackup.dir = r.path;
    await syncApp.save();
    await refreshBackupInfo();
  }
}
/** 恢复默认备份目录（重新跟随数据缓存目录） */
async function resetBackupDir() {
  syncCfg.localBackup.dir = "";
  await syncApp.save();
  await refreshBackupInfo();
}
/** 立即备份：走同步引擎强制备份模式 */
function backupNow() {
  syncApp.startSync("backup");
}
/** 从压缩包恢复：整包还原数据与设置，成功后重拉配置与页面数据 */
async function restoreBackup() {
  const r = await syncApi.browseBackupFile();
  if (!r?.ok || !r.path) return;
  const ok = window.confirm(
    `确定从该压缩包恢复吗？\n\n${r.path}\n\n当前全部数据与设置将被覆盖为备份时点的状态；恢复前会自动留一份安全副本，失败自动回滚。`
  );
  if (!ok) return;
  backupBusy.value = true;
  try {
    const res = await syncApi.restoreBackup(r.path);
    backupResult.value = res;
    if (res?.ok) {
      // 配置与数据已被整包替换：重拉配置、数据源清单与页面数据（不重复启动进度轮询）
      await syncApp.reloadConfig();
      await syncApp.loadSources();
      usage.resetOverview();
      await usage.loadOverview();
      await refreshBackupInfo();
    }
  } catch (e) {
    backupResult.value = { ok: false, message: e instanceof Error ? e.message : "恢复失败" };
  } finally {
    backupBusy.value = false;
    window.clearTimeout(backupResultTimer);
    backupResultTimer = window.setTimeout(() => (backupResult.value = null), 8000);
  }
}
function fmtBackupSize(n: number) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
function fmtBackupTime(ms: number | null) {
  return ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "—";
}

async function loadDataDirInfo() {
  try {
    dataDirInfo.value = await syncApi.getDataDirInfo();
    dataDirInput.value = dataDirInfo.value?.dataDir || "";
  } catch {
    dataDirInfo.value = null;
  }
}
/** 浏览选择目录（系统对话框） */
async function browseDataDir() {
  const r = await syncApi.browseDataDir();
  if (r?.ok && r.path) {
    dataDirInput.value = r.path;
    editingDataDir.value = true;
  }
}
function startEditDataDir() {
  dataDirInput.value = dataDirInfo.value?.dataDir || "";
  editingDataDir.value = true;
}
/** 保存新目录：可选迁移旧缓存数据（默认迁移） */
async function applyDataDir(migrate: boolean) {
  const target = dataDirInput.value.trim();
  const r = await syncApi.setDataDir(target, migrate);
  dataDirResult.value = r;
  window.clearTimeout(dataDirResultTimer);
  dataDirResultTimer = window.setTimeout(() => (dataDirResult.value = null), 8000);
  if (r?.ok) {
    editingDataDir.value = false;
    dataDirInfo.value = { dataDir: r.dataDir || target, defaultDataDir: r.defaultDataDir || dataDirInfo.value?.defaultDataDir || "", isCustom: true };
    syncApp.dataDir = r.dataDir || target;
  }
}
/** 恢复默认目录 */
async function resetDataDir() {
  const ok = window.confirm("确定恢复默认数据缓存目录吗？\n\n将回退到用户主目录下的 .Dosage_sync（重启后生效），当前自定义目录下的数据不会被删除。");
  if (!ok) return;
  const r = await syncApi.resetDataDir();
  dataDirResult.value = r;
  window.clearTimeout(dataDirResultTimer);
  dataDirResultTimer = window.setTimeout(() => (dataDirResult.value = null), 8000);
  if (r?.ok) {
    editingDataDir.value = false;
    dataDirInfo.value = { dataDir: r.dataDir || "", defaultDataDir: r.defaultDataDir || "", isCustom: false };
    syncApp.dataDir = r.dataDir || "";
  }
}
function openSyncDataDir() {
  syncApi.openDataDir();
}
</script>

<template>
  <div class="cfg-sec sync-scope">
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">数据与备份</div>
        <div class="cfg-sec-sub">备份压缩包 · 数据缓存目录（WebDAV 云端同步在同弹窗的「WebDAV 同步」模块）</div>
      </div>
    </div>

    <!-- 本机存储：无 WebDAV 时的数据安全网（备份压缩包 + 整包还原 + 缓存目录） -->
    <div class="card" style="padding: 6px 18px">
      <div class="switch-row" style="align-items: flex-start">
        <div class="s-left">
          <div class="s-title">备份目录</div>
          <div class="s-desc">用量数据备份压缩包（dosage-sync-backup.zip）的存放位置，始终覆盖为最新一份</div>
          <div class="s-desc" style="color: var(--text-3); margin-top: 2px">默认：数据缓存目录<span v-if="backupInfo && !backupInfo.isDefault" style="color: var(--accent-strong)"> · 已自定义</span></div>
          <div class="s-desc mono" style="word-break: break-all; margin-top: 4px">{{ backupInfo?.dir || '—' }}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px; flex-shrink: 0">
          <button class="btn-outline" @click="browseBackupDir">修改目录</button>
          <button v-if="backupInfo && !backupInfo.isDefault" class="btn-outline" @click="resetBackupDir" title="重新跟随数据缓存目录">恢复默认</button>
        </div>
      </div>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">立即备份</div>
          <div class="s-desc">
            抽取本机数据并重新生成备份压缩包<template v-if="backupInfo?.archiveExists"> · 上次备份：{{ fmtBackupTime(backupInfo.lastBackupAt) }}（{{ fmtBackupSize(backupInfo.archiveSize) }}）</template>
          </div>
          <div class="s-desc" style="color: var(--text-3)">包含汇总库与设置文件；未配置 WebDAV 时，定时同步也会自动重新生成</div>
        </div>
        <button class="btn-outline" :disabled="backupButtonDisabled" :title="backupButtonDisabled ? '同步或恢复进行中' : ''" @click="backupNow">{{ syncApp.syncing || syncApp.sync.running ? "进行中" : "立即备份" }}</button>
      </div>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">从压缩包恢复</div>
          <div class="s-desc">选择备份压缩包，整包还原数据与设置（覆盖当前数据与设置）</div>
          <div class="s-desc" style="color: var(--text-3)">恢复前自动留安全副本，失败自动回滚；跨电脑恢复时 WebDAV 密码需重新填写</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px; flex-shrink: 0">
          <span v-if="backupResult" class="hint" :style="{ color: backupResult.ok ? 'var(--ok)' : 'var(--err)' }">{{ backupResult.message }}</span>
          <button class="btn-outline" :disabled="backupButtonDisabled" @click="restoreBackup">{{ backupBusy ? "恢复中…" : "选择压缩包…" }}</button>
        </div>
      </div>
    </div>

    <div class="card" style="padding: 6px 18px">
      <div class="switch-row" style="align-items: flex-start">
        <div class="s-left">
          <div class="s-title">数据缓存目录</div>
          <div class="s-desc">用量统计本地汇总库（SQLite 缓存）与配置文件的存放位置</div>
          <div class="s-desc" style="color: var(--text-3); margin-top: 2px">默认：{{ dataDirInfo?.defaultDataDir || '用户主目录/.Dosage_sync' }}<span v-if="dataDirInfo?.isCustom" style="color: var(--accent-strong)"> · 已自定义</span></div>
          <div v-if="!editingDataDir" class="s-desc mono" style="word-break: break-all; margin-top: 4px">{{ dataDirInfo?.dataDir || '—' }}</div>
          <div v-else class="data-dir-edit">
            <input class="f-input mono" v-model="dataDirInput" placeholder="请输入目录绝对路径" style="width: 100%" />
            <div class="data-dir-actions">
              <button class="btn-outline" @click="browseDataDir">浏览…</button>
              <button class="btn-outline" @click="applyDataDir(true)" title="把原目录的汇总库与配置复制到新目录">迁移并保存</button>
              <button class="btn-outline" @click="applyDataDir(false)" title="保留原目录数据，在新目录新建缓存">仅新建保存</button>
              <button class="btn-outline" @click="editingDataDir = false">取消</button>
            </div>
            <div class="s-desc" style="color: var(--text-3)">修改后需重启应用生效；迁移会复制原目录数据，新建则保留原目录并在新目录重建缓存。</div>
          </div>
          <div v-if="dataDirResult" class="s-desc" :style="{ color: dataDirResult.ok ? 'var(--ok)' : 'var(--err)', marginTop: 4 }">{{ dataDirResult.message }}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px; flex-shrink: 0">
          <button v-if="!editingDataDir" class="btn-outline" @click="startEditDataDir">修改</button>
          <button v-if="dataDirInfo?.isCustom && !editingDataDir" class="btn-outline" @click="resetDataDir" title="恢复默认目录（当前自定义目录数据保留）">恢复默认</button>
        </div>
      </div>
      <div class="switch-row" style="padding-bottom:2px"><div class="s-left"><div class="s-title">打开数据目录</div><div class="s-desc">在资源管理器中打开用量统计缓存目录</div></div><button class="btn-outline" @click="openSyncDataDir">打开</button></div>
    </div>
  </div>
</template>

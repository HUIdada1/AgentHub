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
<!-- 设置 · 同步时间：各板块「自动同步 / 自动刷新 / 本地感知」的周期统一在这里管，
     五个页签（用量统计 / 记忆中枢 / 技能仓库 / 号池管家 / 提示词库）各自切换对应的时间设置。
     三个配置源各自走自己的保存链路——框架（技能仓库+号池管家+提示词库）app.save()、
     用量统计 syncApp.save()、记忆中枢 mem.save()；改动即改即存，状态反馈集中在顶部 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import { useSyncStore } from "../../stores/sync";
import { useMemoryStore } from "../../stores/memory";
import * as api from "../../api/ipc";

const app = useAppStore();
const syncApp = useSyncStore();
const mem = useMemoryStore();

const tab = ref<"usage" | "memory" | "skills" | "proxy" | "prompts">("usage");

const ready = ref(false);
const saveState = ref("");
let stateTimer = 0;

function feedback(text: string) {
  saveState.value = text;
  window.clearTimeout(stateTimer);
  stateTimer = window.setTimeout(() => (saveState.value = ""), 2600);
}

/** 框架配置（技能仓库调度 / 本地感知 / 号池管家周期）改动即存 */
async function saveFramework() {
  const r = await app.save();
  feedback(r && r.ok === false ? `保存失败：${r.message}` : "已保存");
}

/** 用量统计调度改动即存 */
async function saveUsage() {
  const r = await syncApp.save();
  feedback(r && r.ok === false ? `保存失败：${r.message}` : "已保存");
}

/** 记忆中枢同步配置改动即存（schema 热生效，调度器下一拍自取） */
async function saveMemory(entries: Record<string, unknown>) {
  try {
    await mem.save(entries);
    feedback("已保存");
  } catch (e) {
    feedback(`保存失败：${(e as Error).message || "未知错误"}`);
  }
}

function setWatchInterval(v: number) {
  if (!Number.isFinite(v)) return;
  app.config.watch.intervalSeconds = Math.min(600, Math.max(5, Math.round(v)));
  void saveFramework();
}

function setMemInterval(v: number) {
  if (!Number.isFinite(v)) return;
  void saveMemory({ "sync.intervalMin": Math.min(1440, Math.max(5, Math.round(v))) });
}

/** 自动签到已改为按渠道设置（时间/抖动随各渠道领取形态不同），从这里直接去号池页 */
function gotoProxyPool() {
  app.settingsOpen = false;
  app.selectModule("proxy");
  app.setPage("agents");
}

// ===== 提示词库：自动同步开关 + 同步周期（配置走框架 config.json，与技能仓库/号池同一条保存链路） =====
const promptsSync = ref<api.PromptSyncStatus | null>(null);
const promptsSyncing = ref(false);

async function refreshPromptsSync() {
  try {
    const r = await api.promptsSyncStatus();
    promptsSync.value = r?.status ?? null;
  } catch {
    /* 板块未启用 / 后端未注册该通道时保留旧值静默降级，不影响本页其它页签 */
  }
}

/** 只在切到该页签时拉一次同步状态：设置弹窗一打开就打 IPC 没必要，
 *  而且板块可能已停用（停用后后端不注册 prompts 通道，白打一次还多一条报错日志） */
watch(tab, (v) => {
  if (v === "prompts") void refreshPromptsSync();
});

/** 同步周期落盘：契约 §2 规定 1~24 小时。手输 0 / 99 / 留空（Number("") = 0）都钳到合法区间，
 *  保证写进配置的永远是后端调度器能直接用的值——钳制放在落盘前，而不是渲染时兜底 */
function setPromptsInterval(v: number) {
  if (!Number.isFinite(v)) return;
  app.config.prompts.syncIntervalHours = Math.min(24, Math.max(1, Math.round(v)));
  void saveFramework();
}

/** 立即同步：整库三方合并是长任务，按钮期间锁住防重复触发；跑完回读状态刷新「上次同步」 */
async function runPromptsSync() {
  promptsSyncing.value = true;
  try {
    const r = await api.promptsSyncRun();
    feedback(r && r.ok ? r.message || "同步完成" : "同步失败");
  } catch (e) {
    feedback(`同步失败：${(e as Error).message || "未知错误"}`);
  } finally {
    promptsSyncing.value = false;
    void refreshPromptsSync();
  }
}

/** 去同步中心查看：提示词库自己的「WebDAV 同步」页（冲突裁决、设备与日志都在那里） */
function gotoPromptsSync() {
  app.settingsOpen = false;
  app.selectModule("prompts");
  app.setPage("sync");
}

/** 下次预计同步时刻：自动同步关闭、或从未同步过时不预测——
 *  给出一个其实不会发生的时刻比不给更糟（用户会照它等） */
const promptsNextAt = computed(() => {
  const s = promptsSync.value;
  if (!app.config.prompts.syncAuto || !s?.lastSyncAt) return 0;
  const hours = Math.min(24, Math.max(1, Number(app.config.prompts.syncIntervalHours) || 4));
  return s.lastSyncAt + hours * 3600_000;
});

/** 时刻展示到分钟即可：同步本身带抖动，精确到秒没有意义 */
const fmtClock = (ts: number) =>
  new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

/** 上次同步的相对时间（与设置页 WebDAV 卡片同款口径） */
function fmtAgo(ts: number) {
  if (!ts) return "从未同步";
  const diff = Date.now() - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

onMounted(async () => {
  // 两个模块配置是懒加载：没加载过就先拉，否则会用默认值盖掉磁盘真实配置
  // （load() 不做幂等守卫，重复调用会重启进度轮询，所以这里自己挡一道）
  await Promise.all([syncApp.loaded ? Promise.resolve() : syncApp.load(), mem.loadAll()]);
  ready.value = true;
});
</script>

<template>
  <div v-if="ready" class="timing-sec">
    <div class="tg-head">
      <span class="tg-hint">各板块的自动同步 / 刷新周期统一在这里改，即改即存</span>
      <span v-if="saveState" class="tg-state">{{ saveState }}</span>
    </div>

    <div class="cfg-subtabs">
      <button class="cfg-subtab" :class="{ active: tab === 'usage' }" @click="tab = 'usage'"><i class="ph ph-chart-bar"></i>用量统计</button>
      <button class="cfg-subtab" :class="{ active: tab === 'memory' }" @click="tab = 'memory'"><i class="ph ph-brain"></i>记忆中枢</button>
      <button class="cfg-subtab" :class="{ active: tab === 'skills' }" @click="tab = 'skills'"><i class="ph ph-puzzle-piece"></i>技能仓库</button>
      <button class="cfg-subtab" :class="{ active: tab === 'proxy' }" @click="tab = 'proxy'"><i class="ph ph-plugs-connected"></i>号池管家</button>
      <button class="cfg-subtab" :class="{ active: tab === 'prompts' }" @click="tab = 'prompts'"><i class="ph ph-chat-centered-text"></i>提示词库</button>
    </div>

    <template v-if="tab === 'usage'">
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">每小时同步（WebDAV）</div>
          <div class="s-desc">开启后按选定周期自动上传本机用量并拉取他机</div>
        </div>
        <div class="tg-ctl">
          <el-select v-if="syncApp.config.schedule.hourly" v-model="syncApp.config.schedule.hourlyInterval" class="f-el-select" popper-class="glass-popper" style="width: 110px" @change="saveUsage">
            <el-option v-for="n in [1, 2, 3, 6, 12]" :key="n" :value="n" :label="`${n} 小时`" />
          </el-select>
          <div class="switch" :class="{ on: syncApp.config.schedule.hourly }" role="switch" :aria-checked="syncApp.config.schedule.hourly" @click="syncApp.config.schedule.hourly = !syncApp.config.schedule.hourly; saveUsage()"></div>
        </div>
      </div>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">每天固定时间</div>
          <div class="s-desc">每天到点同步一次（错过自动补跑）</div>
        </div>
        <div class="tg-ctl">
          <input v-if="syncApp.config.schedule.daily" type="time" class="f-input" style="width: 110px" v-model="syncApp.config.schedule.dailyTime" @change="saveUsage" />
          <div class="switch" :class="{ on: syncApp.config.schedule.daily }" role="switch" :aria-checked="syncApp.config.schedule.daily" @click="syncApp.config.schedule.daily = !syncApp.config.schedule.daily; saveUsage()"></div>
        </div>
      </div>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">同步成功也弹系统通知</div>
          <div class="s-desc">失败始终会提醒；开启后成功也通知一次</div>
        </div>
        <div class="switch" :class="{ on: syncApp.config.schedule.notifyOnSuccess }" role="switch" :aria-checked="syncApp.config.schedule.notifyOnSuccess" @click="syncApp.config.schedule.notifyOnSuccess = !syncApp.config.schedule.notifyOnSuccess; saveUsage()"></div>
      </div>
    </template>

    <template v-else-if="tab === 'memory'">
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">自动同步（WebDAV）</div>
          <div class="s-desc">开启后按周期与其它设备互相同步记忆中枢</div>
        </div>
        <div class="switch" :class="{ on: !!mem.cfg('sync.auto', true) }" role="switch" :aria-checked="!!mem.cfg('sync.auto', true)" @click="saveMemory({ 'sync.auto': !mem.cfg('sync.auto', true) })"></div>
      </div>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">同步间隔</div>
          <div class="s-desc">5 ~ 1440 分钟；记忆页「WebDAV 同步」也可随时手动跑</div>
        </div>
        <div class="tg-ctl">
          <input type="number" class="f-input" style="width: 90px" min="5" max="1440" :value="Number(mem.cfg('sync.intervalMin', 60))" @change="setMemInterval(Number(($event.target as HTMLInputElement).value))" />
          <span class="tg-unit">分钟</span>
        </div>
      </div>
    </template>

    <template v-else-if="tab === 'skills'">
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">每小时自动同步（WebDAV）</div>
          <div class="s-desc">开启后每小时把本机技能与中央仓库互相同步一次</div>
        </div>
        <div class="switch" :class="{ on: app.config.schedule.hourly }" role="switch" :aria-checked="app.config.schedule.hourly" @click="app.config.schedule.hourly = !app.config.schedule.hourly; saveFramework()"></div>
      </div>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">每天定时同步（WebDAV）</div>
          <div class="s-desc">每天到点同步一次；错过时刻（关机/睡眠）当天内补跑</div>
        </div>
        <div class="tg-ctl">
          <input v-if="app.config.schedule.daily" type="time" class="f-input" style="width: 110px" v-model="app.config.schedule.dailyTime" @change="saveFramework" />
          <div class="switch" :class="{ on: app.config.schedule.daily }" role="switch" :aria-checked="app.config.schedule.daily" @click="app.config.schedule.daily = !app.config.schedule.daily; saveFramework()"></div>
        </div>
      </div>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">同步成功也弹系统通知</div>
          <div class="s-desc">失败始终会提醒；开启后成功也通知一次</div>
        </div>
        <div class="switch" :class="{ on: app.config.schedule.notifyOnSuccess }" role="switch" :aria-checked="app.config.schedule.notifyOnSuccess" @click="app.config.schedule.notifyOnSuccess = !app.config.schedule.notifyOnSuccess; saveFramework()"></div>
      </div>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">本地目录自动感知</div>
          <div class="s-desc">按周期快照各工具技能目录，有新技能且零冲突时自动收纳</div>
        </div>
        <div class="tg-ctl">
          <template v-if="app.config.watch.enabled">
            <input type="number" class="f-input" style="width: 90px" min="5" max="600" :value="app.config.watch.intervalSeconds" @change="setWatchInterval(Number(($event.target as HTMLInputElement).value))" />
            <span class="tg-unit">秒</span>
          </template>
          <div class="switch" :class="{ on: app.config.watch.enabled }" role="switch" :aria-checked="app.config.watch.enabled" @click="app.config.watch.enabled = !app.config.watch.enabled; saveFramework()"></div>
        </div>
      </div>
    </template>

    <template v-else-if="tab === 'proxy'">
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">号池定时同步（WebDAV）</div>
          <div class="s-desc">API Keys、模型映射与账号随号池同步；开启后按周期自动跑，换设备不用手动点</div>
        </div>
        <div class="tg-ctl">
          <el-select v-if="app.config.proxy.poolsyncSchedule.hourly" v-model="app.config.proxy.poolsyncSchedule.hourlyInterval" class="f-el-select" popper-class="glass-popper" style="width: 110px" @change="saveFramework">
            <el-option v-for="n in [1, 2, 3, 6, 12]" :key="n" :value="n" :label="`${n} 小时`" />
          </el-select>
          <div class="switch" :class="{ on: app.config.proxy.poolsyncSchedule.hourly }" role="switch" :aria-checked="app.config.proxy.poolsyncSchedule.hourly" @click="app.config.proxy.poolsyncSchedule.hourly = !app.config.proxy.poolsyncSchedule.hourly; saveFramework()"></div>
        </div>
      </div>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">号池每天固定时间</div>
          <div class="s-desc">每天到点同步一次（错过自动补跑）；与每小时档可同时开</div>
        </div>
        <div class="tg-ctl">
          <input v-if="app.config.proxy.poolsyncSchedule.daily" type="time" class="f-input" style="width: 110px" v-model="app.config.proxy.poolsyncSchedule.dailyTime" @change="saveFramework" />
          <div class="switch" :class="{ on: app.config.proxy.poolsyncSchedule.daily }" role="switch" :aria-checked="app.config.proxy.poolsyncSchedule.daily" @click="app.config.proxy.poolsyncSchedule.daily = !app.config.proxy.poolsyncSchedule.daily; saveFramework()"></div>
        </div>
      </div>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">额度自动刷新周期</div>
          <div class="s-desc">逐账号批量查询各渠道额度（每渠道并发 ≤2）</div>
        </div>
        <el-select v-model="app.config.proxy.creditsRefreshMin" class="f-el-select" popper-class="glass-popper" style="width: 120px" @change="saveFramework">
          <el-option :value="10" label="10 分钟" />
          <el-option :value="30" label="30 分钟" />
          <el-option :value="60" label="60 分钟" />
        </el-select>
      </div>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">定时自动签到</div>
          <div class="s-desc">已改为按渠道设置：在号池页各渠道工具栏里设签到 / 加油包 / Credits 的时间与抖动</div>
        </div>
        <div class="tg-ctl">
          <button class="btn btn-sm" @click="gotoProxyPool">去号池页设置</button>
        </div>
      </div>
    </template>

    <!-- 提示词库：自动同步开关 + 周期（1~24 小时，钳制后落盘）+ 状态与两个动作入口。
         冲突裁决、设备列表与同步日志不在设置弹窗里，统一收在「提示词库 · WebDAV 同步」页 -->
    <template v-else>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">自动同步（WebDAV）</div>
          <div class="s-desc">开启后按周期与其它设备互相同步提示词库（三方合并，冲突进裁决队列等你确认）</div>
        </div>
        <div class="switch" :class="{ on: app.config.prompts.syncAuto }" role="switch" :aria-checked="app.config.prompts.syncAuto" @click="app.config.prompts.syncAuto = !app.config.prompts.syncAuto; saveFramework()"></div>
      </div>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">同步周期</div>
          <div class="s-desc">1 ~ 24 小时；超出范围的输入会就近钳到边界值再保存</div>
        </div>
        <div class="tg-ctl">
          <input
            type="number"
            class="f-input"
            style="width: 90px"
            min="1"
            max="24"
            :value="app.config.prompts.syncIntervalHours"
            @change="setPromptsInterval(Number(($event.target as HTMLInputElement).value))"
          />
          <span class="tg-unit">小时</span>
        </div>
      </div>
      <div class="switch-row">
        <div class="s-left">
          <div class="s-title">同步状态</div>
          <div class="s-desc">
            上次同步 {{ promptsSync ? fmtAgo(promptsSync.lastSyncAt) : "读取中…" }}
            <template v-if="promptsNextAt"> · 下次预计 {{ fmtClock(promptsNextAt) }}</template>
            <template v-if="promptsSync && !promptsSync.configured"> · 未配置统一 WebDAV 服务器</template>
            <template v-else-if="promptsSync && promptsSync.running"> · {{ promptsSync.stageLabel || "同步中" }}</template>
          </div>
          <div class="s-desc" v-if="promptsSync?.lastError" :style="{ color: 'var(--err)' }">上次失败：{{ promptsSync.lastError }}</div>
        </div>
        <div class="tg-ctl">
          <button class="btn btn-sm" :disabled="promptsSyncing || !!promptsSync?.running" @click="runPromptsSync">
            {{ promptsSyncing || promptsSync?.running ? "同步中…" : "立即同步" }}
          </button>
          <button class="btn-outline btn-sm" @click="gotoPromptsSync">去同步中心查看</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.timing-sec {
  display: flex;
  flex-direction: column;
}
.tg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 10px;
}
.tg-hint {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
}
.tg-state {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--accent-strong);
}
.tg-ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.tg-unit {
  font-size: 11px;
  color: var(--text-3);
}
</style>

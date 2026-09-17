<!-- 设置弹窗 · 通用：外观（主题）+ 模块顺序 + 应用行为（自启 / 托盘）+ 软件更新 + 关于（含免责声明）
     各模块的操作设置在对应模块右上「配置」按钮切换的配置页里；
     更新通知 / 托盘跳转经 app.configFocusUpdate 滚动并高亮更新卡片 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
import type { UpdateStatus, UpdateEvent } from "../../types";

const app = useAppStore();
const version = ref("v0.1.0");
const dataDir = ref("");
const isPortable = ref(false);

async function refresh() {
  try {
    version.value = "v" + (await api.getAppVersion());
  } catch {
    /* 取不到就用默认 */
  }
  try {
    dataDir.value = await api.getDataDir();
  } catch {
    /* 浏览器预览无数据目录 */
  }
  try {
    isPortable.value = await api.getIsPortable();
  } catch {
    /* 浏览器预览走 mock */
  }
  try {
    update.value = await api.getUpdateStatus();
  } catch {
    /* 浏览器预览走 mock */
  }
}

// ===== 软件更新（状态由主进程 updater.cjs 维护，经 get_update_status 拉取 + update:event 推送）=====
const update = ref<UpdateStatus>({
  status: "idle",
  isPortable: false,
  currentVersion: "",
  latestVersion: "",
  percent: 0,
  notes: "",
  message: "",
});
const updateCard = ref<HTMLElement | null>(null);
const highlight = ref(false); // 通知/托盘跳转时闪一下，指明看哪里
let highlightTimer: ReturnType<typeof setTimeout> | undefined;

const updateBusy = computed(() => update.value.status === "checking" || update.value.status === "downloading");

/** 状态行文案：按状态给一句人能读懂的话 */
const updateStateText = computed(() => {
  const s = update.value;
  switch (s.status) {
    case "checking":
      return "正在检查更新…";
    case "up-to-date":
      return "已是最新版本";
    case "available":
      return s.isPortable ? `发现新版本 v${s.latestVersion}，便携版请手动下载` : `发现新版本 v${s.latestVersion}`;
    case "downloading":
      return `正在下载更新 ${s.percent}%`;
    case "downloaded":
      return "更新已下载，重启应用即安装";
    case "error":
      return "更新未完成";
    default:
      return "尚未检查";
  }
});

/** 仅在设置弹窗 · 通用可见时刷新数据（版本 / 数据目录 / 更新状态保持最新） */
const active = computed(() => app.settingsOpen && app.settingsTab === "general");
watch(active, (v) => { if (v) refresh(); }, { immediate: true });

/** 通知 / 托盘点击「发现新版本」：App.vue 已切到通用分类并自增信号，这里滚到更新卡片 */
watch(
  () => app.configFocusUpdate,
  async (n) => {
    if (!n) return;
    await nextTick();
    scrollToCard();
  },
  { immediate: true }
);

async function scrollToCard() {
  await nextTick();
  updateCard.value?.scrollIntoView({ block: "center", behavior: "smooth" });
  highlight.value = true;
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => (highlight.value = false), 1600);
}

// ===== 更新操作（结果由主进程事件回流，这里只用返回值兜住无事件的边界）=====
async function doCheck() {
  try {
    update.value = await api.checkUpdate();
  } catch {
    /* 失败态由主进程 error 事件给出 */
  }
}
async function doDownload() {
  try {
    update.value = await api.downloadUpdate();
  } catch {
    /* 同上 */
  }
}
async function doInstall() {
  try {
    update.value = await api.installUpdate();
  } catch {
    /* 同上 */
  }
}
function openReleases() {
  api.openReleasePage().catch(() => {});
}
function openRepo() {
  api.openRepoPage().catch(() => {});
}

/** 自动检查开关：v-model 已改框架配置，这里只管落盘；主进程每轮检查前读盘故即时生效 */
async function setAutoCheck() {
  await app.save();
}

/** 应用行为开关（自启 / 托盘）：v-model 已改框架配置，这里只管落盘；
    save_config 后端会 applyAutoStart，开机自启即时生效，托盘行为关窗时实时读盘 */
async function toggleAppBehavior() {
  await app.save();
}

/** 外观切换（与左栏亮暗按钮同源） */
function setTheme(v: string | number | boolean | undefined) {
  if (v === "dark" || v === "light") app.setTheme(v);
}

/** 模块顺序上移 / 下移一位（顺序落盘由 store 负责） */
function move(idx: number, dir: -1 | 1) {
  const order = app.config.moduleOrder.slice();
  const to = idx + dir;
  if (to < 0 || to >= order.length) return;
  [order[idx], order[to]] = [order[to], order[idx]];
  app.setModuleOrder(order);
}

async function openDataDir() {
  try {
    await api.openDataDir();
  } catch {
    /* 浏览器预览无此能力 */
  }
}

// ===== 免责声明（关于卡内点击弹出；滚动长文，点「我已知晓」关闭）=====
const disclaimerOpen = ref(false);
const DISCLAIMER: { h: string; p: string[] }[] = [
  {
    h: "一、软件性质与用途",
    p: [
      "AgentHub（以下简称「本软件」）是由作者「沐辉」开发并免费提供的开源工具，仅供技术交流、学习研究与个人合法使用。本软件不构成任何商业产品、服务或承诺，作者不提供任何形式的担保、技术支持义务或质量保证。",
      "你在下载、安装、复制、修改或使用的任一时刻，即视为已阅读、理解并自愿接受本声明的全部内容；如不同意，请立即停止使用并删除本软件。",
    ],
  },
  {
    h: "二、账号与第三方平台风险",
    p: [
      "本软件的「反代网关」等功能涉及将你本机已登录的第三方平台客户端（包括但不限于 Trae、WorkBuddy 等）的凭证用于本地 API 转发。此类使用方式可能违反相关平台的用户协议、服务条款或使用政策。",
      "因使用本软件（包括反代、共享账号额度、调用第三方接口等）导致的账号被限制、冻结、停用、封禁，额度被清零，或被第三方平台追究任何责任等一切后果，均由使用者本人自行承担，作者概不负责。",
      "请你务必自行评估风险，并优先使用你自己拥有合法权益的账号与额度；切勿将反代服务开放给不可信的网络环境或他人使用。",
    ],
  },
  {
    h: "三、数据安全与文件操作",
    p: [
      "本软件涉及技能目录的收纳、合并、Junction 挂载、删除，以及 WebDAV 网盘的上传、下载与合并等文件操作。尽管已提供回收站、备份压缩包与冲突裁决机制，作者仍不对任何数据丢失、文件损坏、同步冲突误判、配置错乱或云端数据被覆盖等后果承担责任。",
      "请在首次使用前自行备份重要数据；执行删除、清空回收站、从压缩包恢复等不可逆操作前，请仔细确认弹窗中的提示内容。",
      "WebDAV 密码等凭据经系统密钥加密后保存在本机，作者不会、也无能力收集你的任何凭据与数据；因本机系统环境（如密钥损坏、重装系统）导致凭据无法解密的风险由使用者自行承担。",
    ],
  },
  {
    h: "四、免责范围",
    p: [
      "在法律允许的最大范围内，作者不对使用或无法使用本软件所引起的一切直接、间接、附带、特殊或后果性损害承担责任，包括但不限于：数据丢失、账号损失、工作中断、设备故障、利润损失、商业机会损失，以及与第三方平台产生的任何纠纷。",
      "本软件按「现状」提供，不保证无错误、不中断运行，也不保证与任何第三方软件、系统版本或网盘服务持续兼容。",
    ],
  },
  {
    h: "五、知识产权与第三方资源",
    p: [
      "本软件中提及的第三方平台名称、商标与服务（如 Trae、WorkBuddy、坚果云、Nextcloud、群晖等）均归其各自权利人所有，本软件与上述平台无任何隶属、合作或背书关系。",
      "使用者通过本软件管理的技能、脚本与配置等内容的合法性与合规性由使用者本人负责，与作者无关。",
    ],
  },
  {
    h: "六、其他",
    p: [
      "本声明的最终解释权归作者所有。作者有权在不另行通知的情况下修改本声明，修改后的声明随新版本软件发布即生效。",
      "若本声明的任何条款被认定为无效或不可执行，不影响其余条款的效力。",
    ],
  },
];

// 主进程推送的更新状态变化（下载进度等实时回流）
let offUpdate: (() => void) | undefined;
onMounted(() => {
  offUpdate = api.onUpdateEvent((e) => {
    const { event, ...state } = e as UpdateEvent;
    if (event === "focus-update") return; // 跳转信号由 App.vue 统一处理
    update.value = state;
  });
});
onUnmounted(() => {
  if (offUpdate) offUpdate();
  if (highlightTimer) clearTimeout(highlightTimer);
});
</script>

<template>
  <div class="cfg-sec">
    <div class="cfg-sec-head">
      <div>
        <div class="cfg-sec-title">通用</div>
        <div class="cfg-sec-sub">外观 · 模块顺序 · 应用行为 · 软件更新 · 关于（各模块的操作设置在对应模块右上「配置」）</div>
      </div>
    </div>

    <div class="card">
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">外观</div>
          <div class="set-desc">深色 / 浅色主题，即时生效并记住</div>
        </div>
        <el-radio-group :model-value="app.isDark ? 'dark' : 'light'" @update:model-value="setTheme">
          <el-radio-button value="dark">深色</el-radio-button>
          <el-radio-button value="light">浅色</el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <div class="card">
      <div class="set-row set-row-head">
        <div class="set-info">
          <div class="set-name">模块顺序</div>
          <div class="set-desc">左栏三大模块的显示顺序</div>
        </div>
      </div>
      <div class="rows">
        <div v-for="(mod, i) in app.orderedModules" :key="mod.key" class="row">
          <span class="num">{{ i + 1 }}</span>
          <div class="grow"><div class="name">{{ mod.name }}</div></div>
          <el-button size="small" :disabled="i === 0" @click="move(i, -1)">上移</el-button>
          <el-button size="small" :disabled="i === app.orderedModules.length - 1" @click="move(i, 1)">下移</el-button>
        </div>
      </div>
    </div>

    <!-- 应用行为：窗口级设置（原在技能仓库与用量统计的设置里，归位到框架通用设置） -->
    <div class="card">
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">开机自启</div>
          <div class="set-desc">{{ isPortable ? "便携版不支持开机自启（注册的会是临时副本）" : "登录 Windows 后自动运行 AgentHub，改动即时生效" }}</div>
        </div>
        <el-switch v-model="app.config.schedule.autoStart" :disabled="isPortable" @change="toggleAppBehavior" />
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">关闭最小化到托盘</div>
          <div class="set-desc">点关闭按钮不退出，仅最小化到托盘（托盘菜单「退出」才是真正退出）</div>
        </div>
        <el-switch v-model="app.config.schedule.minimizeToTray" @change="toggleAppBehavior" />
      </div>
    </div>

    <div ref="updateCard" class="card" :class="{ flash: highlight }">
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">
            {{ updateStateText }}
            <el-tag
              v-if="update.status === 'available' || update.status === 'downloading' || update.status === 'downloaded'"
              type="success"
              class="upd-ver"
            >
              {{ update.currentVersion }} → {{ update.latestVersion }}
            </el-tag>
          </div>
          <div v-if="update.message" class="set-desc">{{ update.message }}</div>
          <div v-else-if="update.isPortable" class="set-desc">便携版为免安装单文件，无法自动覆盖，检测到新版后请到 Releases 手动替换</div>
        </div>
        <div class="upd-actions">
          <el-button v-if="update.status === 'available' && !update.isPortable" type="primary" size="small" @click="doDownload">
            下载更新
          </el-button>
          <el-button v-else-if="update.status === 'downloaded' && !update.isPortable" type="primary" size="small" @click="doInstall">
            重启并安装
          </el-button>
          <el-button v-else-if="update.status === 'available'" type="primary" size="small" @click="openReleases">前往下载</el-button>
          <el-button v-else-if="update.status === 'error'" size="small" @click="openReleases">前往下载</el-button>
          <el-button size="small" :disabled="updateBusy" @click="doCheck">
            {{ updateBusy ? "处理中…" : "检查更新" }}
          </el-button>
        </div>
      </div>

      <el-progress
        v-if="update.status === 'downloading'"
        class="upd-progress"
        :percentage="update.percent"
        :stroke-width="4"
        :show-text="false"
      />

      <div v-if="update.notes" class="upd-notes">
        <div class="upd-notes-head">更新说明</div>
        <div class="upd-notes-body">{{ update.notes }}</div>
      </div>

      <div class="set-row">
        <div class="set-info">
          <div class="set-name">自动检查更新</div>
          <div class="set-desc">每小时检查更新，发现新版仅提醒</div>
        </div>
        <el-switch v-model="app.config.update.autoCheck" @change="setAutoCheck" />
      </div>
    </div>

    <div class="card">
      <div class="set-row">
        <div class="set-info"><div class="set-name">版本</div></div>
        <span class="num">{{ version }} · 作者 沐辉</span>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">数据目录</div>
          <div class="set-desc">{{ dataDir || "（浏览器预览）" }}</div>
        </div>
        <el-button size="small" @click="openDataDir">打开目录</el-button>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">GitHub 仓库</div>
          <div class="set-desc">HUIdada1/AgentHub · 软件更新与安装包发布地址</div>
        </div>
        <el-button size="small" @click="openRepo">打开仓库</el-button>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">免责声明</div>
          <div class="set-desc">本平台仅供交流学习使用；使用本平台（含反代网关等功能）产生的一切后果，作者概不负责</div>
        </div>
        <el-button size="small" @click="disclaimerOpen = true">查看声明</el-button>
      </div>
    </div>

    <!-- 免责声明：文档型弹窗（仅此与帮助保留弹窗形态），内容超长时弹窗内滚动 -->
    <el-dialog v-model="disclaimerOpen" class="disclaimer-dialog" width="560px" align-center append-to-body>
      <template #header>
        <div>
          <div class="dc-title">免责声明</div>
          <div class="dc-sub">使用本平台前请仔细阅读；继续使用即视为你已理解并接受全部条款</div>
        </div>
      </template>
      <div class="dc-body">
        <section v-for="sec in DISCLAIMER" :key="sec.h" class="dc-sec">
          <h3>{{ sec.h }}</h3>
          <p v-for="(p, i) in sec.p" :key="i">{{ p }}</p>
        </section>
        <div class="dc-foot">—— 作者：沐辉 · AgentHub</div>
      </div>
      <template #footer>
        <el-button type="primary" @click="disclaimerOpen = false">我已知晓</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 只有标题的设置行：不留底部内边距，让下面的 rows 贴上来 */
.set-row-head {
  padding-bottom: 2px;
  border-bottom: none;
}
/* 通知/托盘跳转进来的落点提示：高亮一圈，1.6 秒后自行退去 */
.card.flash {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
/* 版本迁移标签：复用 el-tag，仅补左间距 */
.upd-ver {
  margin-left: 8px;
}
.upd-progress {
  margin: 2px 0 10px;
}
.upd-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.upd-notes {
  margin: 2px 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--code-bg);
  overflow: hidden;
}
.upd-notes-head {
  padding: 7px 11px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-2);
  border-bottom: 1px solid var(--line);
}
/* 限高内滚：更新说明可能有十几行，不能撑长页面 */
.upd-notes-body {
  max-height: 148px;
  overflow: auto;
  padding: 9px 11px;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ===== 免责声明弹窗 ===== */
.disclaimer-dialog {
  max-width: calc(100vw - 48px);
}
.disclaimer-dialog :deep(.el-dialog__body) {
  max-height: min(52vh, 460px);
  overflow-y: auto;
}
.dc-title {
  font-size: 15px;
  font-weight: 700;
}
.dc-sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}
.dc-sec {
  margin-bottom: 14px;
}
.dc-sec h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin: 0 0 6px;
}
.dc-sec p {
  font-size: 12px;
  line-height: 1.75;
  color: var(--text-2);
  margin: 0 0 6px;
  text-align: justify;
}
.dc-foot {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-3);
  text-align: right;
}
</style>

<!-- 设置弹窗 · 通用：外观（主题）+ 模块顺序 + 应用行为（自启 / 托盘）+ 关于（含免责声明）
     各模块的操作设置在对应模块右上「配置」按钮切换的配置页里；
     软件更新已拆到独立页签「检查更新」（ConfigUpdateSection），更新通知 / 托盘跳转落点随之过去 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";

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
}

/** 仅在设置弹窗 · 通用可见时刷新数据（版本 / 数据目录保持最新；更新状态归「检查更新」页管） */
const active = computed(() => app.settingsOpen && app.settingsTab === "general");
watch(active, (v) => { if (v) refresh(); }, { immediate: true });

function openRepo() {
  api.openRepoPage().catch(() => {});
}

/** 应用行为开关（自启 / 托盘）：v-model 已改框架配置，这里只管落盘；
    save_config 后端会 applyAutoStart，开机自启即时生效，托盘行为关窗时实时读盘 */
async function toggleAppBehavior() {
  await app.save();
}

/** 未开托盘常驻时轻量模式无意义（关窗本来就释放界面）—— 置灰并说明理由，而不是点了没反应 */
const lightweightDisabledReason = computed(() =>
  app.config.schedule.minimizeToTray ? "" : "已关闭「关闭最小化到托盘」：关窗本身就会释放界面，无需轻量模式"
);

/** 轻量模式开关：开启前确认一次（重建窗口有秒级等待，且会重置界面内的临时状态） */
async function toggleLightweightMode(v: string | number | boolean | undefined) {
  if (v !== true) {
    app.config.schedule.lightweightMode = false;
    await toggleAppBehavior();
    return;
  }
  try {
    await ElMessageBox.confirm(
      "开启后，点关闭按钮会直接释放整个界面进程（实测省约 300 MB 内存），托盘与后台服务照常运行。\n" +
        "下次点托盘「显示主界面」需要重新加载界面，约 1~3 秒，界面内未保存的临时状态会重置。",
      "开启轻量模式？",
      { confirmButtonText: "开启", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return; // 用户取消：不开启
  }
  app.config.schedule.lightweightMode = true;
  await toggleAppBehavior();
}

/** 外观切换（与左栏亮暗按钮同源） */
function setTheme(v: string | number | boolean | undefined) {
  if (v === "dark" || v === "light") app.setTheme(v);
}

/** 界面动效总开关：仅切展示层（光标 / 装饰动画 / 图表动画），业务逻辑不受影响；落盘由 store.setFx 负责。
    默认开启；关闭后再开启时确认一次（低配置电脑持续动效可能卡顿），取消时 config.fx 未变，受控开关自动回弹 */
async function toggleFx(v: string | number | boolean | undefined) {
  if (v !== true) {
    app.setFx(false);
    return;
  }
  try {
    await ElMessageBox.confirm(
      "液滴鼠标、玻璃反光、滚动渐入等装饰效果会持续占用显卡与 CPU，电脑配置较低时部分界面可能出现卡顿。",
      "开启界面动效？",
      { confirmButtonText: "开启动效", cancelButtonText: "暂不开启", type: "warning" }
    );
  } catch {
    return; // 用户取消：不开启
  }
  app.setFx(true);
}

/** 粒子尘场 / 光池追随子开关：彼此独立、也都挂在总开关之下（总开关关闭时置灰不可点）；
    开启前各确认一次——这两项是背景层最吃性能的两个 */
async function toggleParticles(v: string | number | boolean | undefined) {
  if (!app.config.fx) return;
  if (v !== true) {
    app.setFxParticles(false);
    return;
  }
  try {
    await ElMessageBox.confirm(
      "粒子尘场会以约 30fps 持续重绘整层背景，并带动毛玻璃持续重新采样，电脑配置较低时可能出现卡顿。",
      "开启粒子尘场？",
      { confirmButtonText: "开启", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return; // 用户取消：不开启
  }
  app.setFxParticles(true);
}
async function togglePools(v: string | number | boolean | undefined) {
  if (!app.config.fx) return;
  if (v !== true) {
    app.setFxPools(false);
    return;
  }
  try {
    await ElMessageBox.confirm(
      "光池、玻璃反光、卡片聚光与背景光标偏移都会随鼠标实时重绘，鼠标频繁移动时持续占用显卡与 CPU，电脑配置较低时可能出现卡顿。",
      "开启光池追随？",
      { confirmButtonText: "开启", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return; // 用户取消：不开启
  }
  app.setFxPools(true);
}

/** 个性化鼠标样式子开关（液滴光标，默认开启）：轻量装饰、开关即时生效，无需性能确认 */
function toggleCursor(v: string | number | boolean | undefined) {
  if (!app.config.fx) return;
  app.setFxCursor(v === true);
}

// 板块顺序列表展示全部六个板块（含本地网关，可拖动 / 上移下移换位）；
// 启停同样对本地网关开放（后端 module_toggle 分支会对 localgw 执行 lgw.shutdown()/lgw.boot()），
// 因此不能再用 computed 过滤 localgw —— 一过滤它就不出现在顺序里，列表只剩五个板块
const orderList = computed(() => app.orderedModules);

/** 模块顺序上移 / 下移一位（顺序落盘由 store 负责）。
 *  下标口径：按 key 在 moduleOrder 里定位槽位再交换（顺序列表与 moduleOrder
 *  在 Web 托管形态下可能出现缺失补尾的不一致，按 key 翻译对两种形态都成立），
 *  语义就是「在可视列表里与相邻模块换位」，其余模块位置不变。 */
function move(idx: number, dir: -1 | 1) {
  const list = orderList.value;
  const to = idx + dir;
  if (to < 0 || to >= list.length) return;
  const order = app.config.moduleOrder.slice();
  const a = order.indexOf(list[idx].key);
  const b = order.indexOf(list[to].key);
  if (a < 0 || b < 0) return;
  [order[a], order[b]] = [order[b], order[a]];
  app.setModuleOrder(order);
}

// ===== 板块启停开关（issue #91 轻量模式）：走主进程唯一写入口，切换即停后台设施 =====
const toggling = ref("");
const moduleMsg = ref("");

function toggleHint(mod: { key: string; name: string; enabled: boolean }) {
  if (mod.key === "proxy") {
    return mod.enabled
      ? `停用「${mod.name}」：网关服务与额度/签到定时全部停止，正在使用网关（127.0.0.1）的客户端会断开`
      : `启用「${mod.name}」：重新加载规则与号池库（网关是否自启仍看「记住网关开关」）`;
  }
  if (mod.key === "memory") {
    return mod.enabled
      ? `停用「${mod.name}」：索引库释放、监听与自动化任务停止，已注入外部 Agent 的记忆 MCP 将不可用`
      : `启用「${mod.name}」：重新打开索引库与监听，立即恢复`;
  }
  if (mod.key === "localgw") {
    return mod.enabled
      ? `停用「${mod.name}」：本机回环 API 立即停止监听，正在调用（127.0.0.1）的客户端会断开`
      : `启用「${mod.name}」：重新开始监听本机回环地址，立即生效`;
  }
  return mod.enabled
    ? `停用「${mod.name}」：定时同步/自动感知停止${mod.key === "usage" ? "、本地用量库释放" : ""}，左上角置灰不可点`
    : `启用「${mod.name}」：恢复定时能力，立即生效`;
}

async function toggleModule(mod: { key: string; enabled: boolean }) {
  if (toggling.value) return;
  toggling.value = mod.key;
  moduleMsg.value = "";
  try {
    const r = await app.toggleModule(mod.key, !mod.enabled);
    if (r && r.ok === false) moduleMsg.value = r.message || "切换失败";
  } catch (e) {
    moduleMsg.value = String((e as Error).message || e);
  } finally {
    toggling.value = "";
  }
}

// ===== 模块顺序拖拽排序：拖过哪行实时换位（左栏顺序同步预览），松手统一落盘 =====
const dragIndex = ref(-1); // 拖动行当前所在下标（随换位实时更新）
const dragOriginal = ref("");

function onDragStart(i: number, e: DragEvent) {
  dragIndex.value = i;
  dragOriginal.value = app.config.moduleOrder.join();
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(i));
  }
}
function onDragEnter(i: number) {
  const from = dragIndex.value;
  if (from < 0 || from === i) return;
  // 同 move()：拖动下标是「可视列表」的下标，落到 moduleOrder 上按 key 定位槽位，
  // 不直接拿下标换 —— 对「moduleOrder 缺项补尾」的形态也成立
  const list = orderList.value;
  const order = app.config.moduleOrder.slice();
  const fi = order.indexOf(list[from]?.key);
  const ti = order.indexOf(list[i]?.key);
  if (fi < 0 || ti < 0) return;
  const [item] = order.splice(fi, 1);
  order.splice(ti, 0, item);
  app.config.moduleOrder = order; // 拖动中只做本地预览，dragend 统一落盘
  dragIndex.value = i;
}
function onDragOver(i: number, e: DragEvent) {
  if (dragIndex.value < 0) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
}
function onDragEnd() {
  if (dragIndex.value >= 0 && dragOriginal.value !== app.config.moduleOrder.join()) {
    void app.save(); // 顺序已在拖动中写入 config.moduleOrder，这里只补落盘
  }
  dragIndex.value = -1;
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
      "AgentHub（以下简称「本软件」）是由作者「沐晖」开发并免费提供的开源工具，仅供技术交流、学习研究与个人合法使用。本软件不构成任何商业产品、服务或承诺，作者不提供任何形式的担保、技术支持义务或质量保证。",
      "你在下载、安装、复制、修改或使用的任一时刻，即视为已阅读、理解并自愿接受本声明的全部内容；如不同意，请立即停止使用并删除本软件。",
    ],
  },
  {
    h: "二、账号与第三方平台风险",
    p: [
      "本软件的「号池管家」会读取你本机已登录的第三方平台客户端（包括但不限于 Trae、WorkBuddy 等）的凭证，用于余额查询、签到与号池管理等本地操作。此类使用方式可能违反相关平台的用户协议、服务条款或使用政策。",
      "因使用本软件（包括共享账号额度、调用第三方接口等）导致的账号被限制、冻结、停用、封禁，额度被清零，或被第三方平台追究任何责任等一切后果，均由使用者本人自行承担，作者概不负责。",
      "请你务必自行评估风险，并优先使用你自己拥有合法权益的账号与额度；切勿将号池凭据分享给不可信的网络环境或他人使用。",
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

// ===== 全局快捷键（默认 Alt+`，两键）=====
// 校验口径与后端一致（功能键+字符键），但**前端先拦一道**：非法值即时红字提示，
// 不让用户提交后才由后端拒绝（后端仍是权威，两边都校验）。
// 注意：前端只能做语法校验；「是否已被别的程序占用」只有主进程注册时才知道，
// 故冲突提示走系统气泡（见 shortcut.cjs 的 createRegistrar）。
const shortcutDraft = ref("");
const shortcutMsg = ref<{ ok: boolean; text: string } | null>(null);
const shortcutBusy = ref(false);

/** 是否桌面端：全局快捷键依赖窗口与 Electron 的 globalShortcut，
 *  Web/容器端（NAS）没有这些能力，该设置项必须隐藏而不是让用户点了没反应 */
const isDesktop = computed(() => api.isElectron());

const MODS = ["Ctrl", "Alt", "Shift", "Super"];
const KEY_ALIASES: Record<string, string> = {
  // ~ → ` ：与后端 shortcut.cjs 同口径（此表两边必须一致）。
  // ~ 在标准键盘要 Shift+`，Electron 会当成**三键**组合 —— 用户按两键没反应。
  // 故统一归一成不带 Shift 的 ` 键，保证「按两键」即可触发。
  "~": "`", "`": "`", "-": "-", "=": "=", "[": "[", "]": "]", "\\": "\\",
  ";": ";", "'": "'", ",": ",", ".": ".", "/": "/",
  space: "Space", tab: "Tab", enter: "Enter", return: "Enter",
  backspace: "Backspace", delete: "Delete", insert: "Insert",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  up: "Up", down: "Down", left: "Left", right: "Right",
  plus: "Plus", numpadadd: "numadd", numpadsub: "numsub",
};

/** 与 backend/shortcut.cjs 的 normalize 同口径（保持两边规则一致，改一处要改两处） */
function normalizeShortcut(input: string): { ok: boolean; accelerator?: string; message?: string } {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, message: "快捷键不能为空（留空表示不启用快捷键）" };
  const parts = raw.split("+").map((s) => s.trim()).filter((s) => s !== "");
  if (!parts.length) return { ok: false, message: "快捷键不能为空" };
  const mods: string[] = [];
  const keys: string[] = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    const canon = MODS.find((m) => m.toLowerCase() === lower)
      || (lower === "option" ? "Alt" : lower === "cmd" || lower === "meta" || lower === "win" || lower === "command" ? "Super" : "");
    if (canon) { if (!mods.includes(canon)) mods.push(canon); }
    else keys.push(p);
  }
  if (!mods.length) return { ok: false, message: "必须包含至少一个功能键（Ctrl / Alt / Shift / Super）" };
  if (!keys.length) return { ok: false, message: "必须包含一个字符键（如 ~、A、1、F5）" };
  if (keys.length > 1) return { ok: false, message: `只能有一个字符键，当前给了 ${keys.length} 个` };
  let key = keys[0];
  if (/^[A-Za-z]$/.test(key)) key = key.toUpperCase();
  else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) key = key.toUpperCase();
  else {
    const alias = KEY_ALIASES[key.toLowerCase()] || KEY_ALIASES[key];
    if (alias) key = alias;
    else if (!/^[0-9]$/.test(key)) return { ok: false, message: `不支持的字符键「${keys[0]}」` };
  }
  return { ok: true, accelerator: [...MODS.filter((m) => mods.includes(m)), key].join("+") };
}

/** 保存快捷键：前端校验 → 落盘（主进程注册时才知道是否冲突，冲突会弹系统气泡） */
async function saveShortcut() {
  const v = normalizeShortcut(shortcutDraft.value);
  if (!v.ok) {
    shortcutMsg.value = { ok: false, text: v.message || "格式不正确" };
    return;
  }
  shortcutBusy.value = true;
  try {
    app.config.schedule.shortcutToggle = v.accelerator!;
    await app.save();
    shortcutDraft.value = v.accelerator!;
    shortcutMsg.value = { ok: true, text: `已设为 ${v.accelerator}（若已被其它程序占用，会弹气泡提示并自动重试）` };
  } finally {
    shortcutBusy.value = false;
  }
}

/** 清空 = 不启用快捷键 */
async function clearShortcut() {
  shortcutBusy.value = true;
  try {
    app.config.schedule.shortcutToggle = "";
    await app.save();
    shortcutDraft.value = "";
    shortcutMsg.value = { ok: true, text: "已关闭快捷键" };
  } finally {
    shortcutBusy.value = false;
  }
}

onMounted(() => {
  // 快捷键输入框初值 = 当前配置（用户直接看到现在生效的是哪个键）
  shortcutDraft.value = app.config.schedule.shortcutToggle || "";
});
</script>

<template>
  <div class="cfg-sec">
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
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">界面动效</div>
          <div class="set-desc">装饰性动效（液滴鼠标、玻璃反光等），关闭后界面回到纯静态</div>
        </div>
        <div
          class="switch"
          :class="{ on: app.config.fx }"
          role="switch"
          :aria-checked="!!app.config.fx"
          @click="toggleFx(!app.config.fx)"
        ></div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">粒子尘场</div>
          <div class="set-desc">最底层缓慢上浮的尘粒；开启会持续重绘并带动毛玻璃重新采样，低配电脑可能卡顿</div>
        </div>
        <el-tooltip content="先开启「界面动效」" :disabled="!!app.config.fx" placement="top">
          <div
            class="switch"
            :class="{ on: app.config.fxParticles, disabled: !app.config.fx }"
            role="switch"
            :aria-checked="!!app.config.fxParticles"
            @click="toggleParticles(!app.config.fxParticles)"
          ></div>
        </el-tooltip>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">光池追随</div>
          <div class="set-desc">光池、聚光与背景光标偏移；低配电脑可能卡顿</div>
        </div>
        <el-tooltip content="先开启「界面动效」" :disabled="!!app.config.fx" placement="top">
          <div
            class="switch"
            :class="{ on: app.config.fxPools, disabled: !app.config.fx }"
            role="switch"
            :aria-checked="!!app.config.fxPools"
            @click="togglePools(!app.config.fxPools)"
          ></div>
        </el-tooltip>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">个性化鼠标样式</div>
          <div class="set-desc">把系统指针换成一枚跟随光标的液滴（含点击涟漪）；关闭后恢复系统指针</div>
        </div>
        <el-tooltip content="先开启「界面动效」" :disabled="!!app.config.fx" placement="top">
          <div
            class="switch"
            :class="{ on: app.config.fxCursor, disabled: !app.config.fx }"
            role="switch"
            :aria-checked="!!app.config.fxCursor"
            @click="toggleCursor(!app.config.fxCursor)"
          ></div>
        </el-tooltip>
      </div>
    </div>

    <div class="card">
      <div class="set-row set-row-head">
        <div class="set-info">
          <div class="set-name">模块顺序</div>
          <div class="set-desc">左栏模块顺序，拖动可换位；右侧开关控制板块启停，停用后后台完全停止运行与统计</div>
        </div>
      </div>
      <div class="rows">
        <div
          v-for="(mod, i) in orderList"
          :key="mod.key"
          class="row"
          :class="{ dragging: dragIndex === i }"
          draggable="true"
          @dragstart="onDragStart(i, $event)"
          @dragenter="onDragEnter(i)"
          @dragover="onDragOver(i, $event)"
          @dragend="onDragEnd"
        >
          <i class="ph ph-dots-six-vertical grip"></i>
          <span class="num">{{ i + 1 }}</span>
          <div class="grow"><div class="name">{{ mod.name }}</div></div>
          <button class="btn btn-ghost" :disabled="i === 0" @click="move(i, -1)">上移</button>
          <button class="btn btn-ghost" :disabled="i === orderList.length - 1" @click="move(i, 1)">下移</button>
          <el-tooltip
            :content="toggleHint(mod)"
            placement="top"
          >
            <div
              class="switch"
              :class="{ on: mod.enabled, busy: toggling === mod.key }"
              role="switch"
              :aria-checked="mod.enabled"
              @click="toggleModule(mod)"
            ></div>
          </el-tooltip>
        </div>
      </div>
      <div v-if="moduleMsg" class="set-desc" style="margin-top: 8px; color: var(--err)">{{ moduleMsg }}</div>
    </div>

    <!-- 应用行为：窗口级设置（原在技能仓库与用量统计的设置里，归位到框架通用设置） -->
    <div class="card">
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">开机自启</div>
          <div class="set-desc">{{ isPortable ? "便携版不支持开机自启（注册的会是临时副本）" : "登录 Windows 后自动运行 AgentHub，改动即时生效" }}</div>
        </div>
        <el-tooltip :content="'便携版不支持开机自启'" :disabled="!isPortable" placement="top">
          <div
            class="switch"
            :class="{ on: app.config.schedule.autoStart, disabled: isPortable }"
            role="switch"
            :aria-checked="!!app.config.schedule.autoStart"
            @click="!isPortable && (app.config.schedule.autoStart = !app.config.schedule.autoStart, toggleAppBehavior())"
          ></div>
        </el-tooltip>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">关闭最小化到托盘</div>
          <div class="set-desc">点关闭按钮不退出，仅最小化到托盘（托盘菜单「退出」才是真正退出）</div>
        </div>
        <div
          class="switch"
          :class="{ on: app.config.schedule.minimizeToTray }"
          role="switch"
          :aria-checked="!!app.config.schedule.minimizeToTray"
          @click="app.config.schedule.minimizeToTray = !app.config.schedule.minimizeToTray; toggleAppBehavior()"
        ></div>
      </div>
      <!-- 全局快捷键：桌面专属（Web/容器端无全局快捷键概念） -->
      <div v-if="isDesktop" class="set-row">
        <div class="set-info">
          <div class="set-name">全局快捷键（唤起 / 收起界面）</div>
          <div class="set-desc">
            应用在后台或托盘时也能用。按下时：界面可见则收起，不可见则唤回。<br />
            必须是「功能键 + 字符键」，如 <code>Alt+`</code>、<code>Ctrl+Shift+K</code>；留空表示不启用。<br />
            <b>注意</b>：不要用 <code>~</code> —— 它需要 Shift，实际会变成三键（<code>Alt+Shift+`</code>）；填 <code>Alt+~</code> 会自动按 <code>Alt+`</code> 处理。
          </div>
          <div v-if="shortcutMsg" class="set-desc" :class="shortcutMsg.ok ? 'sc-ok' : 'sc-err'">{{ shortcutMsg.text }}</div>
        </div>
        <div class="sc-edit">
          <el-input
            v-model="shortcutDraft"
            class="sc-input"
            size="small"
            :placeholder="app.config.schedule.shortcutToggle || '未启用'"
            @keyup.enter="saveShortcut"
          />
          <el-button size="small" type="primary" :loading="shortcutBusy" @click="saveShortcut">保存</el-button>
          <el-button size="small" :disabled="shortcutBusy || !app.config.schedule.shortcutToggle" @click="clearShortcut">清除</el-button>
        </div>
      </div>
      <!-- 轻量模式：桌面专属（Web/容器端没有窗口，开关无意义，故整体不渲染） -->
      <div v-if="isDesktop" class="set-row">
        <div class="set-info">
          <div class="set-name">轻量模式（关窗释放界面内存）</div>
          <div class="set-desc">
            {{
              lightweightDisabledReason ||
              "点关闭按钮时销毁界面进程，托盘与后台服务（号池管家 / 定时同步 / 记忆中枢）照常运行；实测省约 300 MB 内存，唤回时重新加载界面"
            }}
          </div>
        </div>
        <el-tooltip :content="lightweightDisabledReason" :disabled="!lightweightDisabledReason" placement="top">
          <div
            class="switch"
            :class="{ on: app.config.schedule.lightweightMode, disabled: !!lightweightDisabledReason }"
            role="switch"
            :aria-checked="!!app.config.schedule.lightweightMode"
            @click="!lightweightDisabledReason && toggleLightweightMode(!app.config.schedule.lightweightMode)"
          ></div>
        </el-tooltip>
      </div>
    </div>

    <div class="card">
      <div class="set-row">
        <div class="set-info"><div class="set-name">版本</div></div>
        <span class="num">{{ version }} · 作者 沐晖</span>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">数据目录</div>
          <div class="set-desc">{{ dataDir || "（浏览器预览）" }}</div>
        </div>
        <button class="btn btn-ghost" @click="openDataDir">打开目录</button>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">GitHub 仓库</div>
          <div class="set-desc">HUIdada1/AgentHub · 软件更新与安装包发布地址</div>
        </div>
        <button class="btn btn-ghost" @click="openRepo">打开仓库</button>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">免责声明</div>
          <div class="set-desc">本平台仅供交流学习；使用产生的一切后果作者概不负责</div>
        </div>
        <button class="btn btn-ghost" @click="disclaimerOpen = true">查看声明</button>
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
        <div class="dc-foot">—— 作者：沐晖 · AgentHub</div>
      </div>
      <template #footer>
        <button class="btn btn-cta" @click="disclaimerOpen = false">我已知晓</button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 便携版禁用的开机自启开关：置灰且不响应 */
.switch.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* 只有标题的设置行：不留底部内边距，让下面的 rows 贴上来 */
.set-row-head {
  padding-bottom: 2px;
  border-bottom: none;
}
/* 模块顺序拖拽排序：抓手光标 + 拖动中的行半透明 */
.rows .row {
  cursor: grab;
}
.rows .row.dragging {
  opacity: 0.4;
}
.grip {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-3);
}
/* 快捷键的编辑区：输入框 + 按钮横排，靠右不换行 */
.sc-edit {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.sc-input {
  width: 168px;
}
/* 校验反馈：成功绿、失败红（与全局语义色一致） */
.sc-ok {
  color: var(--ok, #3ecf8e);
}
.sc-err {
  color: var(--danger, #f56c6c);
}
/* 描述里的按键示例：等宽、淡底，与正文区分 */
.set-desc code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--code-bg);
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 0.94em;
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
/* 板块启停开关：切换进行中半透明防连点 */
.switch.busy {
  opacity: 0.5;
  pointer-events: none;
}
</style>

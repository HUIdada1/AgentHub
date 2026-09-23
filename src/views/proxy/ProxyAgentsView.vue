<!-- 反代网关 · 号池：顶部三渠道主按钮（各自独立成区，选中即点亮），下方整块切换为当前渠道面板。
     面板内自带工具栏（策略 / 添加账号 / 一键签到或领加油包 / 刷新），全部只作用于当前渠道，互不关联；
     签到结果按渠道各自记忆；账号经四途径添加（OAuth / 本机导入 / 文件 / 粘贴）。
     号池多设备 WebDAV 同步已移至独立「号池同步」页 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type { ProxyChannelView, ProxyAccount, ProxyChannelId, ProxyPoolStrategy, ProxyScanCandidate, ProxyCheckinRow } from "../../types";
import { useAppStore } from "../../stores/app";
import { fmtInt, fmtK, fmtDate, fmtAgo, ACCOUNT_STATUS, SOURCE_NAMES, channelName } from "./format";

const app = useAppStore();
const pool = ref<ProxyChannelView[]>([]);
const refreshingChannel = ref(false);
const refreshingId = ref("");

// ===== Toast 悬浮提示（右上角、自动消失）：替代常驻页面的提示卡片 =====
const toasts = ref<{ id: number; text: string; kind: "info" | "err" }[]>([]);
let toastSeq = 0;
function toast(text: string, kind: "info" | "err" = "info") {
  if (!text) return;
  const id = ++toastSeq;
  toasts.value.push({ id, text, kind });
  if (toasts.value.length > 4) toasts.value.shift(); // 同屏最多 4 条，更早的直接让位
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 4200);
}
// 渠道主按钮：顶部三个大按钮切换，下方整块区域只显示当前渠道号池
const activeChannel = ref<ProxyChannelId>("trae");
// 本地 IDE 快捷切换
const ideStatus = ref<{ workbuddyInstalled: boolean; workbuddyAiInstalled?: boolean; traeInstalled?: boolean; raccoonInstalled?: boolean; currentUid: string } | null>(null);
const ideSwitching = ref("");
let offEvent: (() => void) | undefined;

// 渠道主按钮元信息：图标 + 差异说明（各渠道登录/签到形态互不相同，一眼看出各自独立）
const CHANNEL_META: Record<ProxyChannelId, { icon: string; hint: string }> = {
  trae: { icon: "ph-code-simple", hint: "回环登录 · 每日签到" },
  workbuddy: { icon: "ph-buildings", hint: "官方登录 · 每日签到" },
  workbuddy_ai: { icon: "ph-globe-hemisphere-west", hint: "国际版 · 一次性加油包" },
  raccoon: { icon: "ph-paw-print", hint: "文件导入/粘贴 · 每日签到" },
};

// 签到状态区：结果按渠道各自记忆，切渠道互不串扰；跑完弹弹窗展示「发起签到那个渠道」的结果
const checkinBusy = ref(false);
const checkinOpen = ref(false);
const checkinShownChannel = ref<ProxyChannelId>("trae");
const checkinByChannel = ref<Record<string, ProxyCheckinRow[]>>({});
const shownCheckin = computed(() => checkinByChannel.value[checkinShownChannel.value] || []);
const shownCheckinName = computed(
  () => pool.value.find((c) => c.id === checkinShownChannel.value)?.display || checkinShownChannel.value
);
const shownCheckinStats = computed(() => {
  const rows = shownCheckin.value;
  return {
    ok: rows.filter((r) => r.ok && !r.already && !r.unavailable).length,
    already: rows.filter((r) => r.already).length,
    unavail: rows.filter((r) => r.unavailable).length,
    fail: rows.filter((r) => !r.ok).length,
  };
});
function putCheckin(channel: ProxyChannelId, rows: ProxyCheckinRow[]) {
  checkinByChannel.value = { ...checkinByChannel.value, [channel]: rows };
}

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
// 账号重命名（点击名称进入编辑）：renamingId 当前编辑行，renameText 输入内容
const renamingId = ref("");
const renameText = ref("");

// 添加方式可用性：小浣熊已支持「OAuth 登录」（手动粘贴回调地址换 token）与「从本机软件导入」
// （scanRaccoon 读 ~/.box-agent/config/auth.json）与文件/粘贴导入——四种方式全开放
function addTabAllowed(_key: AddMethod): boolean {
  return true;
}

// 渠道允许的添加方式（分段控件按渠道过滤）
const METHOD_TABS = computed(
  () =>
    [
      { key: "oauth" as const, label: "OAuth 登录", icon: "ph-key" },
      { key: "local" as const, label: "从本机软件导入", icon: "ph-desktop-tower" },
      { key: "file" as const, label: "从 JSON/ZIP 文件", icon: "ph-file-arrow-up" },
      { key: "paste" as const, label: "粘贴 JSON", icon: "ph-clipboard-text" },
    ].filter((t) => addTabAllowed(t.key)) as { key: AddMethod; label: string; icon: string }[]
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
  raccoon: {
    title: "用「商汤小浣熊」官方授权页登录",
    desc: "跳转官方授权页完成登录后，浏览器地址栏会显示 office-raccoon://auth/callback?code=…<br />把地址栏整段内容复制粘贴到下方输入框，即可完成登录入池。<br />3 分钟无操作即超时。",
  },
};

// 粘贴 JSON 的字段示例（placeholder 用，随渠道切换 token 字段名提示）
const pastePlaceholder = computed(() => {
  const tokenKey = addChannel.value === "trae" ? "jwt" : "accessToken";
  const extra = addChannel.value === "raccoon" ? `\n  "officeIdentity": "选填，团队版组织标识",` : "";
  return `单个对象或数组均可，字段容忍别名：\n{\n  "name": "主账号（选填）",\n  "${tokenKey}": "渠道原生 token（必填）",\n  "refreshToken": "选填",${extra}\n  "uid": "选填，缺省从 token 解析"\n}`;
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
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  }
}

/** 右上角刷新按钮：只刷当前渠道（不是全量），结果走 Toast 提示 */
async function refreshCurrentChannel() {
  if (refreshingChannel.value) return;
  refreshingChannel.value = true; // 期间可能切渠道，消息与结果都归属发起时的渠道
  try {
    const r = await api.proxyCreditsRefreshChannel(activeChannel.value);
    const unavail = (r.results || []).filter((x) => x.unavailable);
    let text = `${channelName(activeChannel.value)} 已刷新 ${r.total ?? 0} 个账号，失败 ${r.failed ?? 0}`;
    if (unavail.length) text += ` · ${unavail.length} 个账号积分服务未开放（${unavail[0].message || ""}）`;
    toast(text, r.failed ? "err" : "info");
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    refreshingChannel.value = false;
    await refresh();
  }
}

// ===== 每日签到（三渠道不同形态：Trae ug 签到 / WB 中国区 daily-checkin / 国际版无签到只有加油包） =====

function checkinTagCls(r: ProxyCheckinRow) {
  if (!r.ok) return "tag-err";
  if (r.already) return "tag-dim";
  if (r.unavailable) return "tag-warn";
  return "tag-ok";
}
function checkinTagText(r: ProxyCheckinRow) {
  if (!r.ok) return "失败";
  if (r.already) return "已签到";
  if (r.unavailable) return "不开放";
  return "成功";
}

/** 渠道级一键签到（只对当前渠道），跑完弹弹窗逐账号展示、结果只记在该渠道名下 */
async function runCheckinChannel() {
  if (checkinBusy.value) return;
  const channel = activeChannel.value; // 签到期间可能切渠道：发起渠道先存快照，结果才不会记错名下
  checkinBusy.value = true;
  try {
    const r = await api.proxyCheckinRun({ channel, action: "checkin" });
    if (r.ok === false) {
      toast(r.message || "签到失败", "err");
      return;
    }
    putCheckin(channel, r.rows);
    checkinShownChannel.value = channel;
    checkinOpen.value = true;
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    checkinBusy.value = false;
    await refresh();
  }
}

/** 单账号签到（表格行内按钮），结果同样进弹窗 */
async function runCheckinAccount(acc: ProxyAccount) {
  if (checkinBusy.value) return;
  checkinBusy.value = true;
  try {
    const r = await api.proxyCheckinRun({ channel: acc.channel, accountId: acc.id, action: "checkin" });
    if (r.ok === false) {
      toast(r.message || "签到失败", "err");
      return;
    }
    putCheckin(acc.channel, r.rows);
    checkinShownChannel.value = acc.channel;
    checkinOpen.value = true;
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    checkinBusy.value = false;
    await refresh();
  }
}

/** 国际版加油包（trial）：AI 无每日签到，只有一次性加油包 */
async function runTrial() {
  if (checkinBusy.value) return;
  checkinBusy.value = true;
  try {
    const r = await api.proxyCheckinRun({ channel: "workbuddy_ai", action: "trial" });
    if (r.ok === false) {
      toast(r.message || "领取失败", "err");
      return;
    }
    putCheckin("workbuddy_ai", r.rows);
    checkinShownChannel.value = "workbuddy_ai";
    checkinOpen.value = true;
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    checkinBusy.value = false;
    await refresh();
  }
}

/** 一键把账号应用为本地 IDE 当前登录态（WB 双区写回 auth 文件；Trae 加密信封诚实降级） */
async function ideSwitch(acc: ProxyAccount) {
  if (ideSwitching.value) return;
  ideSwitching.value = acc.id;
  try {
    const r = await api.proxyIdeSwitch(acc.id);
    toast(r.message || (r.ok ? "已切换" : "暂不支持"), r.ok ? "info" : "err");
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    ideSwitching.value = "";
    ideStatus.value = await api.proxyIdeStatus().catch(() => ideStatus.value);
  }
}

/** 该账号能否写回本地客户端（Trae 的登录态是加密信封，写不了） */
function ideSupported(acc: ProxyAccount) {
  if (acc.channel === "trae") return false;
  if (!ideStatus.value) return true;
  if (acc.channel === "raccoon") return ideStatus.value.raccoonInstalled !== false;
  return acc.channel === "workbuddy_ai" ? ideStatus.value.workbuddyAiInstalled !== false : ideStatus.value.workbuddyInstalled !== false;
}

function ideTitle(acc: ProxyAccount) {
  if (acc.channel === "trae") return "Trae 本地登录态为 ByteCrypto 加密信封（绑定设备密钥），无法构造合法信封，暂不支持写回";
  if (acc.channel === "raccoon") return "把该账号写为本机 ~/.box-agent/config/auth.json（小浣熊登录态，明文 JSON，需重启客户端生效）";
  if (!ideSupported(acc)) return "本机未找到对应客户端的登录文件（未安装或从未登录过）";
  return `把该账号写为本地 ${channelName(acc.channel)} 当前登录态（需重启客户端）`;
}

async function refreshOne(acc: ProxyAccount) {
  refreshingId.value = acc.id;
  try {
    await api.proxyAccountRefresh(acc.id);
  } catch (e) {
    toast(String((e as Error).message || e), "err");
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
    toast(String((e as Error).message || e), "err");
  }
}

async function toggleAccount(acc: ProxyAccount) {
  try {
    await api.proxyAccountToggle(acc.id, acc.status === "disabled");
    await refresh();
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  }
}

/** 手动解除冷却：账号级立即回 online，模型级负缓存一并豁免（解了就要能立刻被调度） */
const coolOffId = ref("");

// ===== 账号重命名（自定义备注）：点击名称变输入框，失焦/回车提交，Esc 取消 =====

function startRename(acc: ProxyAccount) {
  renamingId.value = acc.id;
  renameText.value = acc.name || "";
}

async function commitRename(acc: ProxyAccount) {
  const name = renameText.value.trim();
  if (!name || name === acc.name) {
    renamingId.value = "";
    return;
  }
  try {
    const r = await api.proxyAccountRename(acc.id, name);
    if (r.ok === false) toast(r.message || "重命名失败", "err");
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    renamingId.value = "";
    renameText.value = "";
    await refresh();
  }
}

async function releaseCool(acc: ProxyAccount) {
  if (coolOffId.value) return;
  coolOffId.value = acc.id;
  try {
    const r = await api.proxyAccountCoolOff(acc.id);
    if (r.ok === false) {
      toast(r.message || "解除失败", "err");
      return;
    }
    toast(r.releasedModels ? `已解除冷却，并豁免 ${r.releasedModels} 个模型级冷却` : "已解除冷却");
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    coolOffId.value = "";
    await refresh();
  }
}

async function doDelete() {
  if (!delRow.value) return;
  try {
    await api.proxyAccountRemove(delRow.value.id);
    delOpen.value = false;
    await refresh();
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  }
}

// ===== 添加账号 =====

function openAdd(ch: ProxyChannelView) {
  addChannel.value = ch.id;
  // 各渠道默认都落 OAuth 登录（raccoon 现在也支持——手动粘贴回调地址换 token）
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

/** 候选排序与过滤：只显示当前渠道的（各渠道各自管理本机登录态，不混在一起） */
const scanRows = computed(() =>
  scanList.value
    .filter((c) => c.channel === addChannel.value)
    .sort((a, b) => {
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

/** 本页是否处于前台：v-show 保活的页面切走后，秒级 tick 与事件全量刷新都应停掉，
    不能在后台空烧主线程拖累前台页的鼠标跟手度 */
const active = computed(() => app.activeModule === "proxy" && app.activePage === "agents");
watch(active, (on) => {
  if (!on) return;
  now.value = Date.now(); // 切回来先校准时钟，冷却倒计时才不会停在旧读数
  refresh();
});

// ===== 冷却剩余时间（秒级跳动：一个定时器驱动全表，冷却多为 1min~6h，秒级粒度直观） =====
const now = ref(Date.now());
let nowTimer: number | undefined;
/** 只有存在未到期的 cooling 账号时才值得每秒跳数：now 不更新，ref 不变，全表不 patch */
function tickNow() {
  if (!active.value) return;
  const ch = pool.value.find((c) => c.id === activeChannel.value);
  if (ch?.accounts.some((a) => a.status === "cooling" && a.coolUntil)) now.value = Date.now();
}
function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
/** cooling 状态且未到期的剩余时长；其余状态返回空（不展示） */
function coolLeft(acc: ProxyAccount): string {
  if (acc.status !== "cooling" || !acc.coolUntil) return "";
  return acc.coolUntil > now.value ? fmtLeft(acc.coolUntil - now.value) : "";
}
/** 模型级负缓存（6004/11102 不落账号状态）的剩余时长：取最早到期的模型；无则空 */
function modelCoolLeft(acc: ProxyAccount): string {
  const list = (acc.modelCool || []).filter((m) => m.until > now.value);
  if (!list.length) return "";
  return fmtLeft(Math.min(...list.map((m) => m.until)) - now.value);
}
/** 悬浮明细：逐条列出被冷却的模型与原因 */
function modelCoolTitle(acc: ProxyAccount): string {
  return (acc.modelCool || [])
    .map((m) => `${m.model}：${m.reason || "模型级冷却"}，至 ${fmtClock(m.until)}`)
    .join("\n");
}
/** 气泡里展示的绝对时间点（HH:mm:ss） */
function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

// ===== UID 查看（列表副行只显示缩略，点击弹小窗看全文 + 复制） =====
const uidRow = ref<ProxyAccount | null>(null);
const uidCopied = ref(false);
/** 列表副行的 UID 缩略：过长截断，全文在弹窗里看 */
function uidBrief(uid: string): string {
  return uid.length > 14 ? `${uid.slice(0, 14)}…` : uid;
}
async function copyUid() {
  if (!uidRow.value?.uid) return;
  try {
    await navigator.clipboard.writeText(uidRow.value.uid);
    uidCopied.value = true;
    setTimeout(() => (uidCopied.value = false), 1600);
  } catch {
    toast("复制失败，请手动选择复制", "err");
  }
}

// ===== 最近错误小窗（点击状态标签弹出）：只展示错误全文本身，液态玻璃小卡 =====
const errRow = ref<ProxyAccount | null>(null);
const errCopied = ref(false);
async function copyErr() {
  if (!errRow.value?.lastError) return;
  try {
    await navigator.clipboard.writeText(errRow.value.lastError.message);
    errCopied.value = true;
    setTimeout(() => (errCopied.value = false), 1600);
  } catch {
    toast("复制失败，请手动选择复制", "err");
  }
}

// ===== 事件订阅与生命周期 =====

onMounted(() => {
  nowTimer = window.setInterval(tickNow, 1000);
  refresh();
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string; ok?: boolean; message?: string; channel?: string };
    if (p.event !== "proxy") return;
    if (p.type === "oauth-done") {
      oauthWaiting.value = false;
      oauthMode.value = "";
      oauthMsg.value = p.ok ? "登录成功，已加入号池（已自动签到）" : `登录失败：${p.message || ""}`;
      if (p.ok) {
        addOpen.value = false;
        refresh();
      }
    } else if (p.type === "credits" || p.type === "status") {
      if (active.value) refresh(); // 页面不在前台就不拉不渲染，切回时 watch(active) 会补一次
    }
  });
});
onUnmounted(() => {
  if (offEvent) offEvent();
  if (nowTimer) clearInterval(nowTimer);
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <!-- 渠道主按钮：三个大按钮，各自独立成区；选中即点亮，下方整块区域随之切换 -->
      <div class="channel-switch">
        <button
          v-for="ch in pool"
          :key="ch.id"
          class="channel-btn"
          :class="{ active: activeChannel === ch.id }"
          @click="activeChannel = ch.id"
        >
          <span class="ch-text">
            <span class="ch-name">{{ ch.display }}</span>
            <span class="ch-hint">{{ CHANNEL_META[ch.id]?.hint }}</span>
          </span>
          <span class="ch-badge" :class="{ ok: ch.summary.onlineCount > 0 }">
            {{ ch.summary.accountCount ? `${ch.summary.onlineCount}/${ch.summary.accountCount} 可用` : "空号池" }}
          </span>
        </button>
      </div>
      <template v-for="ch in pool" :key="ch.id">
      <div v-if="ch.id === activeChannel" class="card channel-panel" style="margin-bottom: 12px">
        <div class="card-title">
          <i class="ph" :class="CHANNEL_META[ch.id]?.icon"></i>
          {{ ch.display }}
          <span class="tag" :class="ch.summary.onlineCount > 0 ? 'tag-ok' : 'tag-dim'">
            {{ ch.summary.accountCount ? `${ch.summary.onlineCount}/${ch.summary.accountCount} 可用` : "空号池" }}
          </span>
          <span v-if="ch.summary.expiringSoon" class="tag tag-warn">24h 内有到期</span>
          <!-- 工具栏：只属于当前渠道（策略 / 添加 / 签到或加油包 / 刷新），与其他渠道互不关联 -->
          <span class="panel-tools">
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
            <button
              v-if="ch.id === 'workbuddy_ai'"
              class="btn btn-sm"
              :disabled="checkinBusy"
              :title="'国际版无每日签到，这是一次性 trial 加油包'"
              @click="runTrial"
            >{{ checkinBusy ? "领取中…" : "领加油包" }}</button>
            <button v-else class="btn btn-sm" :disabled="checkinBusy" @click="runCheckinChannel">
              {{ checkinBusy ? "签到中…" : "一键签到" }}
            </button>
            <button class="btn btn-sm btn-primary" :disabled="refreshingChannel" @click="refreshCurrentChannel">
              {{ refreshingChannel ? "刷新中…" : "刷新" }}
            </button>
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
        <!-- 账号明细：6 列两行式布局 —— 账号列首行为名称、副行是来源与 UID（点击看全文）；
             状态列点击弹液态玻璃小窗（只显最近一次上游错误全文），冷却剩余时间直接在列表里秒级跳动 -->
        <div class="tbl-wrap" style="margin-top: 8px">
          <table class="tbl pool-tbl">
            <tbody>
              <tr><th>账号</th><th>状态</th><th>余额</th><th>到期</th><th>今日</th><th>操作</th></tr>
              <tr v-for="acc in ch.accounts" :key="acc.id">
                <td class="acc-cell">
                  <span v-if="renamingId !== acc.id" class="acc-name" :title="acc.name + '（点击重命名）'" @click="startRename(acc)">{{ acc.name || "（未命名账号）" }}</span>
                  <input
                    v-else
                    v-model="renameText"
                    class="input input-xs"
                    style="width: 120px"
                    @blur="commitRename(acc)"
                    @keydown.enter="commitRename(acc)"
                    @keydown.esc="renamingId = ''"
                  />
                  <span class="acc-sub">
                    <span class="acc-src">{{ SOURCE_NAMES[acc.source] || acc.source }}</span>
                    <i>·</i>
                    <button class="acc-uid mono" :disabled="!acc.uid" title="点击查看完整 UID" @click="uidRow = acc">
                      {{ acc.uid ? uidBrief(acc.uid) : "无 UID" }}
                    </button>
                  </span>
                </td>
                <td>
                  <!-- 状态标签：有最近错误的账号可点击，弹小窗看错误全文 -->
                  <span
                    class="tag status-tag"
                    :class="[ACCOUNT_STATUS[acc.status]?.cls || 'tag-dim', { 'has-err': !!acc.lastError }]"
                    :title="acc.lastError ? '点击查看最近一次上游错误' : ''"
                    @click="acc.lastError && (errRow = acc)"
                  >
                    {{ ACCOUNT_STATUS[acc.status]?.text || acc.status }}
                  </span>
                  <!-- 冷却剩余时间：秒级跳动，到点自动归零消失（状态派生在主进程惰性完成） -->
                  <span v-if="coolLeft(acc)" class="cool-left mono">剩 {{ coolLeft(acc) }}</span>
                  <!-- 模型级冷却（6004/11102 不落账号状态）：悬浮看逐模型明细 -->
                  <span v-if="modelCoolLeft(acc)" class="cool-left mono" :title="modelCoolTitle(acc)">模型冷却剩 {{ modelCoolLeft(acc) }}</span>
                </td>
                <td class="mono num">{{ acc.hasToken ? (acc.credits === -1 ? "不限" : fmtInt(acc.credits)) : "-" }}</td>
                <td class="mono">{{ acc.expiresAt ? fmtDate(acc.expiresAt) : "-" }}</td>
                <td class="mono num">{{ acc.todayReq }} 次 · {{ fmtK(acc.todayTokens) }}</td>
                <td>
                  <button class="btn-link btn-sm" :disabled="refreshingId === acc.id" @click="refreshOne(acc)">
                    {{ refreshingId === acc.id ? "刷新中…" : "刷新" }}
                  </button>
                  <button
                    v-if="acc.hasToken"
                    class="btn-link btn-sm"
                    :disabled="checkinBusy"
                    :title="acc.channel === 'workbuddy_ai' ? '国际版无每日签到，用上方工具栏「领加油包」' : acc.channel === 'raccoon' ? '登录送积分（幂等，锁定当日积分 7 天）' : '对该账号执行每日签到'"
                    @click="runCheckinAccount(acc)"
                  >
                    签到
                  </button>
                  <button
                    class="btn-link btn-sm"
                    :disabled="ideSwitching === acc.id || !ideSupported(acc)"
                    :title="ideTitle(acc)"
                    @click="ideSwitch(acc)"
                  >
                    {{ ideSwitching === acc.id ? "切换中…" : "切到 IDE" }}
                  </button>
                  <button
                    v-if="acc.status === 'cooling' || (acc.modelCool && acc.modelCool.length)"
                    class="btn-link btn-sm"
                    :disabled="coolOffId === acc.id"
                    :title="acc.status === 'cooling'
                      ? '立即结束冷却，账号马上回到可用调度（同时豁免其模型级冷却）'
                      : '该账号部分模型在冷却中（6004 限流/11102 不支持），解除后这些模型立即恢复可用'"
                    @click="releaseCool(acc)"
                  >
                    {{ coolOffId === acc.id ? "解除中…" : "解冷却" }}
                  </button>
                  <button class="btn-link btn-sm" @click="toggleAccount(acc)">{{ acc.status === "disabled" ? "启用" : "停用" }}</button>
                  <button class="btn-link btn-sm danger" @click="delRow = acc; delOpen = true">移出</button>
                </td>
              </tr>
              <tr v-if="!ch.accounts.length">
                <td colspan="6" style="text-align: center; color: var(--text-3); padding: 14px">
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
              <!-- 回环模式兜底 + 手动粘贴模式主操作：整段粘贴回调地址 -->
              <div v-if="(oauthMode === 'loopback' || oauthMode === 'manual') && oauthWaiting" class="cb-row">
                <input
                  v-model="callbackInput"
                  class="input"
                  style="flex: 1"
                  :placeholder="oauthMode === 'manual' ? '登录完成后，把浏览器地址栏整段粘到这里（office-raccoon://auth/callback?code=…）' : '浏览器没跳回？把地址栏整段粘到这里'"
                />
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

      <!-- 签到结果弹窗：一键签到 / 单账号签到 / 领加油包跑完即弹，逐账号一行（结果仍按渠道记忆，切渠道互不串扰） -->
      <div v-if="checkinOpen" class="p-mask" @click.self="checkinOpen = false">
        <div class="p-dlg glass checkin-dlg">
          <div class="p-title checkin-head">
            <i class="ph ph-seal-check"></i>
            {{ shownCheckinName }} · 签到结果
            <span class="checkin-stats">
              <span class="tag tag-ok">成功 {{ shownCheckinStats.ok }}</span>
              <span class="tag tag-dim">已签到 {{ shownCheckinStats.already }}</span>
              <span class="tag tag-warn">不开放 {{ shownCheckinStats.unavail }}</span>
              <span class="tag tag-err">失败 {{ shownCheckinStats.fail }}</span>
            </span>
          </div>
          <div class="checkin-rows">
            <div v-for="r in shownCheckin" :key="r.accountId" class="checkin-row">
              <div class="checkin-name">
                {{ r.name || r.uid || r.accountId }}
                <span class="tag" :class="checkinTagCls(r)">{{ checkinTagText(r) }}</span>
              </div>
              <span class="checkin-msg">
                <template v-if="r.credit">+{{ r.credit }} 积分 · </template>
                <template v-if="r.streakDays">连续 {{ r.streakDays }} 天 · </template>
                {{ r.message || "" }}
              </span>
            </div>
            <div v-if="!shownCheckin.length" class="checkin-empty">本次没有需要签到的账号</div>
          </div>
          <div class="p-actions">
            <button class="btn btn-primary" @click="checkinOpen = false">完成</button>
          </div>
        </div>
      </div>

      <!-- UID 查看弹窗：全文展示 + 一键复制（列表副行显示缩略，点击看全文） -->
      <div v-if="uidRow" class="p-mask" @click.self="uidRow = null">
        <div class="p-dlg glass uid-dlg">
          <div class="p-title">账号 UID</div>
          <div class="set-desc">{{ uidRow.name }}（{{ channelName(uidRow.channel) }}）</div>
          <div class="uid-text mono">{{ uidRow.uid || "-" }}</div>
          <div class="p-actions">
            <button class="btn" @click="uidRow = null">关闭</button>
            <button class="btn btn-primary" :disabled="!uidRow.uid" @click="copyUid">{{ uidCopied ? "已复制" : "复制 UID" }}</button>
          </div>
        </div>
      </div>

      <!-- 最近错误小窗：点状态标签弹出，液态玻璃小卡只装错误全文本身（可复制给排查工具） -->
      <div v-if="errRow" class="p-mask" @click.self="errRow = null">
        <div class="p-dlg glass err-dlg">
          <div class="p-title err-head">
            <i class="ph ph-warning-circle"></i>
            最近错误
            <span v-if="errRow.lastError" class="err-time mono">{{ fmtClock(errRow.lastError.at) }}</span>
          </div>
          <div class="err-text mono">{{ errRow.lastError?.message || "（无错误详情）" }}</div>
          <div class="p-actions">
            <button class="btn" @click="errRow = null">关闭</button>
            <button class="btn btn-primary" :disabled="!errRow.lastError" @click="copyErr">{{ errCopied ? "已复制" : "复制错误" }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Toast 悬浮提示：右上角自动消失（刷新/签到摘要与错误提示都走这里） -->
    <Teleport to="body">
      <div class="toast-host">
        <TransitionGroup name="toast">
          <div v-for="t in toasts" :key="t.id" class="toast-item glass" :class="{ err: t.kind === 'err' }">
            <i class="ph" :class="t.kind === 'err' ? 'ph-warning-circle' : 'ph-check-circle'"></i>
            <span>{{ t.text }}</span>
          </div>
        </TransitionGroup>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
/* ===== Toast 悬浮提示：右上角玻璃小卡，自动消失（替代常驻页面卡片） ===== */
.toast-host {
  position: fixed;
  top: 18px;
  right: 18px;
  z-index: 120; /* 盖过 .p-mask(50)：弹窗内触发的操作提示也要浮在最上层 */
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 380px;
  padding: 9px 14px;
  border-radius: var(--r-ctl);
  border: 1px solid var(--accent-line);
  font-size: 12px;
  line-height: 1.55;
  color: var(--text);
  word-break: break-all;
  box-shadow: var(--glass-shadow);
}
.toast-item .ph {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--accent-strong);
  margin-top: 1px;
}
.toast-item.err {
  border-color: var(--danger, var(--err, #e05555));
}
.toast-item.err .ph {
  color: var(--danger, var(--err, #e05555));
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.28s var(--ease), transform 0.28s var(--ease);
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(24px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active {
    transition: none;
  }
}
/* ===== 渠道主按钮：三列大按钮，各自独立成区，选中才点亮 ===== */
.channel-switch {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.channel-btn {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 12px 13px;
  border-radius: var(--r-ctl);
  border: 1px solid var(--line);
  background: var(--bg-soft);
  color: var(--text-2);
  font-family: var(--font-ui);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.22s, color 0.22s, background 0.22s, transform 0.28s var(--ease-spring), box-shadow 0.25s;
}
/* 底部光条：选中时从中间向两侧展开，作为"当前渠道"的指示锚点 */
.channel-btn::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 0;
  height: 2px;
  border-radius: var(--r-pill);
  background: var(--accent);
  box-shadow: 0 0 10px var(--accent);
  transform: translateX(-50%);
  transition: width 0.3s var(--ease);
}
.channel-btn:hover {
  color: var(--text);
  border-color: var(--line-strong);
  transform: translateY(-2px);
  box-shadow: 0 8px 20px -14px rgba(0, 0, 0, 0.8);
}
:root[data-theme="light"] .channel-btn:hover {
  box-shadow: 0 8px 20px -14px rgba(15, 23, 42, 0.4);
}
.channel-btn:active {
  transform: scale(0.98);
}
.channel-btn:focus-visible {
  outline: 2px solid var(--accent-line);
  outline-offset: 2px;
}
.channel-btn.active {
  color: var(--text);
  border-color: var(--accent-line);
  background: linear-gradient(180deg, var(--accent-dim), transparent 140%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 0 24px -10px var(--accent-line);
}
.channel-btn.active::after {
  width: 100%;
}
.ch-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ch-name {
  font-size: 12.5px;
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-hint {
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-badge {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  padding: 2.5px 8px;
  border-radius: var(--r-pill);
  border: 1px solid var(--line-strong);
  color: var(--text-2);
  transition: border-color 0.22s, background 0.22s, color 0.22s;
}
.ch-badge.ok {
  color: var(--accent-strong);
}
.channel-btn.active .ch-badge {
  border-color: var(--accent-line);
  background: var(--accent-dim);
  color: var(--accent-strong);
}
/* 渠道面板：切渠道时新面板淡入上浮；v-for 按 key 复用，数据刷新不会重播 */
.channel-panel {
  animation: panelIn 0.32s var(--ease);
}
@keyframes panelIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .channel-panel {
    animation: none;
  }
}
/* 面板工具栏：策略 / 添加账号 / 签到或加油包 / 刷新，全部只作用于当前渠道 */
.panel-tools {
  margin-left: auto;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* 面板标题里的渠道图标：与主按钮同图标，形成"按钮 → 面板"的视觉呼应 */
.channel-panel .card-title .ph {
  font-size: 13px;
  color: var(--accent-strong);
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
  font-size: 11px;
  color: var(--text-3);
}
.agg-item b {
  font-family: var(--font-mono);
  font-size: 13px;
}
/* 策略下拉与工具栏其他按钮同为小控件档（--ctl-h-sm = 24px），严格同高对齐 */
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
  font-size: 11px;
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

/* 号池同步卡片已移至独立「号池同步」页；此处样式不再使用 */

/* ===== 签到结果弹窗：逐账号一行，多行限高滚动 ===== */
.checkin-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.checkin-head .ph {
  font-size: 15px;
  color: var(--accent-strong);
}
.checkin-stats {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.checkin-dlg {
  width: 460px;
}
.checkin-rows {
  margin-top: 10px;
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.checkin-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--r-sm);
  background: var(--bg-soft);
  border: 1px solid var(--line);
}
.checkin-name {
  flex-shrink: 0;
  max-width: 45%;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.checkin-msg {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-3);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.checkin-empty {
  padding: 18px 0;
  text-align: center;
  font-size: 11.5px;
  color: var(--text-3);
}
/* ===== UID 查看弹窗 ===== */
.uid-dlg {
  width: 400px;
}
.uid-text {
  margin-top: 10px;
  padding: 11px 12px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  background: var(--bg-soft);
  font-size: 12.5px;
  letter-spacing: 0.4px;
  word-break: break-all;
  user-select: all;
}
/* ===== 列表布局：账号两行式 + 数字列右对齐 ===== */
.pool-tbl th:nth-child(3),
.pool-tbl th:nth-child(5),
.pool-tbl td.num {
  text-align: right;
}
.acc-cell {
  line-height: 1.3;
}
.acc-name {
  display: block;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  cursor: text;
  border-bottom: 1px dashed transparent;
}
.acc-name:hover {
  border-bottom-color: var(--text-3);
}
.acc-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--text-3);
}
.acc-sub i {
  font-style: normal;
  opacity: 0.6;
}
.acc-uid {
  border: none;
  background: none;
  padding: 0;
  color: var(--text-3);
  font-size: 10.5px;
  cursor: pointer;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.15s;
}
.acc-uid:hover:not(:disabled) {
  color: var(--accent-strong);
}
/* ===== 状态列：冷却剩余 + 点击弹最近错误小窗 ===== */
.cool-left {
  margin-left: 6px;
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
/* 有错误的账号状态标签才可点：hover 时用警示色描边提示"这里能点" */
.status-tag.has-err {
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s, filter 0.2s;
}
.status-tag.has-err:hover {
  border-color: var(--danger);
  box-shadow: 0 0 10px -4px var(--danger);
  filter: brightness(1.12);
}
/* ===== 最近错误小窗：液态玻璃小卡只装错误全文 ===== */
.err-dlg {
  width: 480px;
}
.err-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.err-head .ph {
  font-size: 15px;
  color: var(--danger);
}
.err-time {
  margin-left: auto;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--text-3);
}
.err-text {
  margin-top: 10px;
  padding: 11px 12px;
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-2);
  word-break: break-all;
  white-space: pre-wrap;
  user-select: text;
}
.tag-err {
  background: var(--danger-dim);
  color: var(--danger);
  border: 1px solid transparent;
}
</style>

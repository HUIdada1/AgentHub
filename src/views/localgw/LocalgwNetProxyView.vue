<!--
  ============================================================
   作者：沐晖
   日期：2026-10-28
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 本地网关 · 网络代理：出网出口池 + 出站伪装与清洗。

     上半「出口池」照搬 fdb3e55^ 的「反代网关 · 网络代理」页（旧文件 views/proxy/ProxyNetworkView.vue），
     与旧版的差别只有保活 watch 的 activeModule（"proxy" → "localgw"）与共享格式化工具的引用路径。

     网关向上游的每一次请求都从 adapters.cjs 的 netproxy.fetchThrough 出去，本页维护的
     就是它取用的那份出口集合：
       · 出口（条目）：命名 + 协议（http / socks5）+ 主机端口 + 可选账号密码，可单独启停；
       · 出口策略：直连（默认）/ 固定一条 / 轮询启用条目；
       · 测试：连一次测试网址，回「通不通 + 状态码 + 出口 IP + 耗时」，结果落进条目
         （重启 / 换页回来还看得到上次测出来是什么，但它只是历史事实，不参与选路）。
     存储与校验都在后端 netproxy.cjs（proxyDir/netproxy.json，密码走加密信封）。

     下半「出站伪装」是本次新增的二级 tab：旧版把出站伪装散在配置页里，恢复页面时按方案把它与
     出口池同页呈现（同属「网关怎么出去」这一件事）。数据源是 localgw_outbound_get/set/preview
     三条通道，字段形状按 docs/localgw-outbound-contract.md（冻结契约）§2/§4.8/§5.3，
     与配置页 ConfigLocalgwSection 的「出站伪装」tab 读写同一份 localgw.outbound，两处不互相覆盖。 -->
<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import * as api from "../../api/ipc";
import * as localgwApi from "../../api/localgw";
import type { ProxyNetProxyItem, ProxyNetProxyList, ProxyNetProxyMode } from "../../types";
import { LOCALGW_CONFIG_DEFAULTS } from "../../types";
import type { LocalgwKeywordRule, LocalgwOutboundConfig, LocalgwRewriteRule, LocalgwRuleScope } from "../../types";
import { fmtAgo, fmtMs } from "../proxy/format";

const app = useAppStore();

/** 二级 tab：出口池（照搬旧版）与出站伪装（本次新增）。默认停在出口池，与旧版进入本页的观感一致 */
const tab = ref<"pool" | "outbound">("pool");

// ===== 出口池（旧版 ProxyNetworkView 的 script 段，逐行保留）=====

const data = ref<ProxyNetProxyList | null>(null);
const loading = ref(false);
const err = ref("");

const items = computed(() => data.value?.items || []);
const mode = ref<ProxyNetProxyMode>("off");
const fixedId = ref("");
const strategyBusy = ref(false);
const strategyMsg = ref<{ ok: boolean; text: string } | null>(null);
let strategyMsgTimer = 0;

const selectedIds = ref<Set<string>>(new Set());
const testing = reactive<Record<string, boolean>>({});
const batchTesting = ref(false);
const batchDeleting = ref(false);
const copiedId = ref("");
let copiedTimer = 0;

const selectedCount = computed(() => items.value.filter((i) => selectedIds.value.has(i.id)).length);
const allSelected = computed(() => items.value.length > 0 && selectedCount.value === items.value.length);
const enabledCount = computed(() => items.value.filter((i) => i.enabled).length);

async function load() {
  loading.value = true;
  err.value = "";
  try {
    const r = await api.proxyNetproxyList();
    data.value = r;
    mode.value = r?.mode || "off";
    fixedId.value = r?.fixedId || "";
    // 已删除的条目不再留在选择集里
    const alive = new Set((r?.items || []).map((i) => i.id));
    selectedIds.value = new Set([...selectedIds.value].filter((id) => alive.has(id)));
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
// v-show 常驻页：切回本页时刷新（出口可能在另一台设备 / 容器里改过）
// 旧版判定的是 "proxy" 模块，本页现在挂在 "localgw" 模块下
watch(
  () => app.activeModule === "localgw" && app.activePage === "netproxy",
  (on) => { if (on) load(); }
);

function flashStrategy(ok: boolean, text: string) {
  strategyMsg.value = { ok, text };
  window.clearTimeout(strategyMsgTimer);
  strategyMsgTimer = window.setTimeout(() => { strategyMsg.value = null; }, 6000);
}

/** 策略与设置：改完立刻落盘，下一次上游请求就按新策略走（不必重启网关） */
async function saveStrategy() {
  if (strategyBusy.value) return;
  if (mode.value === "fixed" && !fixedId.value) {
    flashStrategy(false, "选择「固定出口」时请先指定一条出口");
    rollbackStrategy();
    return;
  }
  strategyBusy.value = true;
  try {
    const r = await api.proxyNetproxySaveSettings({ mode: mode.value, fixedId: fixedId.value });
    data.value = r;
    mode.value = r.mode;
    fixedId.value = r.fixedId;
    flashStrategy(true, "已保存，立即生效");
  } catch (e) {
    flashStrategy(false, String((e as Error).message || e));
    // 保存失败时把控件退回后端实际状态，避免「界面显示轮询、实际还在直连」
    rollbackStrategy();
  } finally {
    strategyBusy.value = false;
  }
}

function rollbackStrategy() {
  mode.value = data.value?.mode || "off";
  fixedId.value = data.value?.fixedId || "";
}

/** 切到「固定出口」时若还没指定，自动选第一条启用的（少一次手点，也避免保存被后端挡回） */
function onModeChange(next: string | number | boolean | undefined) {
  const m = String(next) as ProxyNetProxyMode;
  mode.value = m;
  if (m === "fixed" && !fixedId.value) {
    const first = items.value.find((i) => i.enabled);
    if (first) fixedId.value = first.id;
  }
  saveStrategy();
}

function addressOf(item: ProxyNetProxyItem) {
  return `${item.protocol}://${item.host}:${item.port}`;
}

async function copyAddress(item: ProxyNetProxyItem) {
  try {
    await navigator.clipboard.writeText(addressOf(item));
    copiedId.value = item.id;
    window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => { copiedId.value = ""; }, 1500);
  } catch {
    err.value = "复制失败（系统剪贴板不可用）";
  }
}

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function toggleSelectAll() {
  selectedIds.value = allSelected.value ? new Set() : new Set(items.value.map((i) => i.id));
}

async function toggleItem(item: ProxyNetProxyItem, next: boolean) {
  try {
    const r = await api.proxyNetproxyToggle(item.id, next);
    if (r?.item) Object.assign(item, r.item);
  } catch (e) {
    err.value = String((e as Error).message || e);
    await load();
  }
}

/** 单条测试：结果直接写回条目（后端也落盘，别处打开能看到） */
async function testItem(item: ProxyNetProxyItem) {
  if (testing[item.id]) return;
  testing[item.id] = true;
  err.value = "";
  try {
    const r = await api.proxyNetproxyTest({ id: item.id });
    item.lastTest = { success: r.success, status: r.status, ip: r.ip, durationMs: r.durationMs, error: r.error, at: Date.now() };
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    testing[item.id] = false;
  }
}

/** 批量测试：并发 3 条（代理服务多半有并发限制，一次全推容易互相拖慢） */
async function batchTest() {
  if (batchTesting.value) return;
  const targets = items.value.filter((i) => selectedIds.value.has(i.id));
  if (!targets.length) return;
  batchTesting.value = true;
  err.value = "";
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) await testItem(item);
    }
  };
  try {
    await Promise.all([worker(), worker(), worker()]);
  } finally {
    batchTesting.value = false;
  }
}

async function batchDelete() {
  if (batchDeleting.value) return;
  const targets = items.value.filter((i) => selectedIds.value.has(i.id));
  if (!targets.length) return;
  if (!window.confirm(`确定删除选中的 ${targets.length} 条出口吗？\n\n${targets.map((i) => `· ${i.name}`).join("\n")}\n\n删除后引用它的「固定出口」策略会回落直连。`)) return;
  batchDeleting.value = true;
  err.value = "";
  try {
    for (const item of targets) {
      await api.proxyNetproxyRemove(item.id);
      selectedIds.value.delete(item.id);
    }
    await load();
  } catch (e) {
    err.value = String((e as Error).message || e);
    await load();
  } finally {
    batchDeleting.value = false;
  }
}

/** 单条删除：文案与批量删除分开写（「删 1 条」不该套用「选中的 N 条」的说法） */
async function deleteItem(item: ProxyNetProxyItem) {
  if (!window.confirm(`确定删除出口「${item.name}」吗？\n\n${item.protocol}://${item.host}:${item.port}\n\n删除后引用它的「固定出口」策略会回落直连。`)) return;
  try {
    await api.proxyNetproxyRemove(item.id);
    selectedIds.value.delete(item.id);
    await load();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

// ===== 出口表单（新增 / 编辑）=====

const formOpen = ref(false);
const editingId = ref("");
const formBusy = ref(false);
const formTesting = ref(false);
const formStatus = ref<{ ok: boolean; text: string } | null>(null);
const form = reactive({
  name: "",
  protocol: "http" as "http" | "socks5",
  host: "",
  port: "",
  username: "",
  password: "",
  clearPassword: false,
  enabled: true,
});
const editingItem = computed(() => items.value.find((i) => i.id === editingId.value) || null);

function openCreate() {
  editingId.value = "";
  form.name = "";
  form.protocol = "http";
  form.host = "";
  form.port = "";
  form.username = "";
  form.password = "";
  form.clearPassword = false;
  form.enabled = true;
  formStatus.value = null;
  formOpen.value = true;
}

function openEdit(item: ProxyNetProxyItem) {
  editingId.value = item.id;
  form.name = item.name;
  form.protocol = item.protocol;
  form.host = item.host;
  form.port = String(item.port);
  form.username = item.username;
  form.password = "";
  form.clearPassword = false;
  form.enabled = item.enabled;
  formStatus.value = null;
  formOpen.value = true;
}

/** 表单 → 提交载荷；明显写错的先在本地挡住（后端还会再校一次，文案一致） */
function draftPayload() {
  const name = form.name.trim();
  if (!name) return { error: "请填写代理名称" } as const;
  const host = form.host.trim();
  if (!host) return { error: "请填写代理主机地址" } as const;
  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "代理端口必须是 1-65535 的整数" } as const;
  return {
    payload: {
      id: editingId.value || undefined,
      name,
      protocol: form.protocol,
      host,
      port,
      username: form.username.trim(),
      password: form.password,
      clearPassword: form.clearPassword || undefined,
      enabled: form.enabled,
    },
  } as const;
}

/** 未保存也能测：先确认能通，再决定要不要存 */
async function testDraft() {
  if (formTesting.value) return;
  const draft = draftPayload();
  if ("error" in draft) {
    formStatus.value = { ok: false, text: String(draft.error || "表单填写有误") };
    return;
  }
  formTesting.value = true;
  formStatus.value = { ok: true, text: "正在连接测试网址…" };
  try {
    const p = draft.payload;
    const r = await api.proxyNetproxyTest({
      draft: { name: p.name, protocol: p.protocol, host: p.host, port: p.port, username: p.username, password: p.password, enabled: p.enabled },
    });
    formStatus.value = r.success
      ? { ok: true, text: `出口可用${r.ip ? ` · 出口 IP ${r.ip}` : ""}${r.status ? ` · HTTP ${r.status}` : ""} · ${fmtMs(r.durationMs)}` }
      : { ok: false, text: r.error || "连接失败" };
  } catch (e) {
    formStatus.value = { ok: false, text: String((e as Error).message || e) };
  } finally {
    formTesting.value = false;
  }
}

async function saveForm() {
  if (formBusy.value) return;
  const draft = draftPayload();
  if ("error" in draft) {
    formStatus.value = { ok: false, text: String(draft.error || "表单填写有误") };
    return;
  }
  formBusy.value = true;
  formStatus.value = null;
  try {
    await api.proxyNetproxySave(draft.payload);
    formOpen.value = false;
    await load();
  } catch (e) {
    formStatus.value = { ok: false, text: String((e as Error).message || e) };
  } finally {
    formBusy.value = false;
  }
}

// ===== 代理设置（测试网址 / 超时）=====

const settingsOpen = ref(false);
const settingsBusy = ref(false);
const settingsMsg = ref<{ ok: boolean; text: string } | null>(null);
const settings = reactive({ testUrl: "", timeoutMs: "15000" });

function openSettings() {
  settings.testUrl = data.value?.settings.testUrl || "";
  settings.timeoutMs = String(data.value?.settings.timeoutMs || 15000);
  settingsMsg.value = null;
  settingsOpen.value = true;
}

function resetSettings() {
  settings.testUrl = "";
  settings.timeoutMs = String(data.value?.settings.defaultTimeoutMs || 15000);
  settingsMsg.value = null;
}

async function saveSettings() {
  if (settingsBusy.value) return;
  const timeoutMs = Number(settings.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    settingsMsg.value = { ok: false, text: "超时必须是 1000-120000 之间的毫秒数" };
    return;
  }
  settingsBusy.value = true;
  try {
    const r = await api.proxyNetproxySaveSettings({ testUrl: settings.testUrl.trim(), timeoutMs });
    data.value = r;
    settingsMsg.value = { ok: true, text: "已保存" };
    window.setTimeout(() => { settingsOpen.value = false; }, 500);
  } catch (e) {
    settingsMsg.value = { ok: false, text: String((e as Error).message || e) };
  } finally {
    settingsBusy.value = false;
  }
}

const MODE_LABEL: Record<ProxyNetProxyMode, string> = { off: "直连", fixed: "固定出口", rotate: "轮询启用出口" };

// ===== 出站伪装与清洗（契约 §2 / §4.8；与配置页 ConfigLocalgwSection 的同一 tab 读写同一份配置）=====

/** 配置本地副本：读回来一律先过 normalize，避免老 config.json 缺段时模板里 form.outbound.defaults.x 直接抛错 */
const outbound = ref<LocalgwOutboundConfig>(deepClone(LOCALGW_CONFIG_DEFAULTS.outbound));
const outboundReady = ref(false);
const outboundLoading = ref(false);
const outboundSaving = ref(false);
const outboundErr = ref("");
/** outbound_get 的 profiles：内置（只读）+ 自定义，供下拉选择 */
const outboundProfiles = ref<localgwApi.LocalgwOutboundProfileOption[]>([]);
/** outbound_get 的 channels：渠道清单 + 各自生效策略摘要（后端 describePolicy 算的） */
const outboundChannels = ref<localgwApi.LocalgwOutboundChannelRow[]>([]);
const outboundMsg = ref<{ ok: boolean; text: string } | null>(null);
let outboundMsgTimer = 0;

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 读回来的 outbound 段可能整段缺失 / 只有半个形状（老 config.json），逐字段补齐 */
function normalizeOutbound(raw: unknown): LocalgwOutboundConfig {
  const base = deepClone(LOCALGW_CONFIG_DEFAULTS.outbound);
  const r = (isPlain(raw) ? raw : {}) as Partial<LocalgwOutboundConfig>;
  const d = (isPlain(r.defaults) ? r.defaults : {}) as Partial<LocalgwOutboundConfig["defaults"]>;
  const custom = isPlain(r.profiles) && isPlain((r.profiles as { custom?: unknown }).custom)
    ? ((r.profiles as { custom: Record<string, unknown> }).custom)
    : {};
  return {
    defaults: { ...base.defaults, ...d },
    perChannel: isPlain(r.perChannel) ? (r.perChannel as LocalgwOutboundConfig["perChannel"]) : {},
    keywords: Array.isArray(r.keywords) ? r.keywords : [],
    rewrites: Array.isArray(r.rewrites) ? r.rewrites : [],
    profiles: { custom: custom as LocalgwOutboundConfig["profiles"]["custom"] },
  };
}

/** 行内反馈：保存是本地 IPC 几乎瞬间返回，提示挂 3 秒再收 */
function flashOutbound(ok: boolean, text: string) {
  outboundMsg.value = { ok, text };
  window.clearTimeout(outboundMsgTimer);
  outboundMsgTimer = window.setTimeout(() => { outboundMsg.value = null; }, 3000);
}

/** 读 outbound_get。失败 = 通道未接入（真机未注册 → unwrapResult 抛错；dev:web 预览 → mock 抛错），
 *  整块降级成占位态，不冒未捕获异常把整页打白 */
async function loadOutbound() {
  if (outboundLoading.value) return;
  outboundLoading.value = true;
  try {
    const r = await localgwApi.outboundGet();
    if (!r || !r.outbound) throw new Error("主进程未返回 outbound 配置");
    outbound.value = normalizeOutbound(r.outbound);
    outboundProfiles.value = Array.isArray(r.profiles) ? r.profiles : [];
    outboundChannels.value = Array.isArray(r.channels) ? r.channels : [];
    outboundReady.value = true;
    outboundErr.value = "";
  } catch (e) {
    outboundReady.value = false;
    outboundProfiles.value = [];
    outboundChannels.value = [];
    outboundErr.value = e instanceof Error && e.message ? e.message : "出站通道不可用";
  } finally {
    outboundLoading.value = false;
  }
}

/** 改动即存：调 localgw_outbound_set（深合并补丁）。
 *  `null` = 删除该键（契约 §4.5.1，RFC 7386）；keywords / rewrites 是**整体替换**语义，
 *  清空请发 []，不要发 null 元素。失败一律回读一次真值，避免界面停在没落盘的假状态。 */
async function patchOutbound(p: Record<string, unknown>, label: string): Promise<boolean> {
  if (outboundSaving.value) return false;
  outboundSaving.value = true;
  try {
    await localgwApi.outboundSet(p);
    await loadOutbound();
    flashOutbound(true, `${label}已保存`);
    return true;
  } catch (e) {
    flashOutbound(false, `${label}保存失败：${e instanceof Error ? e.message : String(e)}`);
    await loadOutbound();
    return false;
  } finally {
    outboundSaving.value = false;
  }
}

/** 切到本 tab 时才去拉配置：出口池是进页的主用途，不为一个没打开的 tab 先付一次 IPC */
watch(tab, (v) => {
  if (v === "outbound" && !outboundReady.value && !outboundLoading.value) void loadOutbound();
});

const OUTBOUND_SWITCHES: { key: keyof LocalgwOutboundConfig["defaults"]; label: string; hint: string }[] = [
  { key: "builtinSanitize", label: "内置指纹脱敏", hint: "叠加 sanitize.cjs 内置规则（模板句 / 计费头字段名 / 裸错误码 11128）" },
  { key: "keywordSanitize", label: "关键词清洗", hint: "启用关键词规则（全局库）" },
  { key: "rewriteSanitize", label: "文案替换", hint: "启用文案替换表（整句成对改写，执行顺序在关键词之前）" },
  { key: "headerOverride", label: "请求头覆盖", hint: "启用请求头的新增 / 改写 / 移除" },
  { key: "jitter", label: "拟人抖动", hint: "每次上游请求前随机停 40~220ms（沿用原 humanizeJitter 语义）" },
];
/** passthrough = 头与 body 全透传，短路一切清洗：此时下面那些开关写了也不生效，界面上要置灰说明 */
const passthrough = computed(() => outbound.value.defaults.mode === "passthrough");

function setOutboundMode(next: string) {
  const mode = next === "passthrough" ? "passthrough" : "mimic";
  outbound.value.defaults.mode = mode;
  void patchOutbound({ defaults: { ...outbound.value.defaults, mode } }, "出站模式");
}
function setOutboundProfile(v: string | number | boolean | undefined) {
  const profile = String(v || "");
  outbound.value.defaults.profile = profile;
  void patchOutbound({ defaults: { ...outbound.value.defaults, profile } }, "模拟档案");
}
function setOutboundSwitch(key: keyof LocalgwOutboundConfig["defaults"], v: string | number | boolean) {
  (outbound.value.defaults as Record<string, unknown>)[key] = !!v;
  void patchOutbound({ defaults: { ...outbound.value.defaults } }, "出站开关");
}

// ---- 关键词规则（全局库；数组整体替换）----
const SCOPES: { value: LocalgwRuleScope; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "system", label: "system" },
  { value: "user", label: "user" },
  { value: "assistant", label: "assistant" },
  { value: "tool", label: "tool" },
];
let ruleSeq = 0;
function newRuleId(prefix: string) {
  return `${prefix}${Date.now().toString(36)}${++ruleSeq}`;
}
function addKeyword() {
  const list = [...outbound.value.keywords, {
    id: newRuleId("k"),
    label: "",
    enabled: true,
    mode: "literal" as const,
    pattern: "",
    flags: "g",
    replace: "",
    scope: "all" as LocalgwRuleScope,
  }];
  outbound.value.keywords = list;
  void patchOutbound({ keywords: list }, "关键词规则");
}
function delKeyword(i: number) {
  const list = outbound.value.keywords.filter((_, idx) => idx !== i);
  outbound.value.keywords = list;
  void patchOutbound({ keywords: list }, "关键词规则");
}
function commitKeywords() {
  void patchOutbound({ keywords: deepClone(outbound.value.keywords) }, "关键词规则");
}

// ---- 文案替换（全局库；数组整体替换）----
function addRewrite() {
  const list = [...outbound.value.rewrites, {
    id: newRuleId("r"),
    label: "",
    enabled: true,
    from: "",
    to: "",
    scope: "all" as LocalgwRuleScope,
  }];
  outbound.value.rewrites = list;
  void patchOutbound({ rewrites: list }, "文案替换");
}
function delRewrite(i: number) {
  const list = outbound.value.rewrites.filter((_, idx) => idx !== i);
  outbound.value.rewrites = list;
  void patchOutbound({ rewrites: list }, "文案替换");
}
function commitRewrites() {
  void patchOutbound({ rewrites: deepClone(outbound.value.rewrites) }, "文案替换");
}

// ---- 试跑（契约 §4.8 的 localgw_outbound_preview，纯函数计算，不打上游）----
const previewText = ref("You are Claude Code, Anthropic's official CLI for Claude");
const previewChannel = ref("");
const previewOut = ref<{ before: string; after: string; hits: { label: string; count: number }[] } | null>(null);
const previewBusy = ref(false);
/** 命中明细 → 摘要串：与后端 outbound.cjs 的 formatHits 同口径（label×count，用 " · " 连接） */
function formatPreviewHits(hits: { label: string; count: number }[]) {
  return hits.map((h) => `${h.label}×${h.count}`).join(" · ");
}
async function runPreview() {
  if (previewBusy.value) return;
  previewBusy.value = true;
  try {
    const r = await localgwApi.outboundPreview(previewChannel.value, previewText.value);
    previewOut.value = {
      before: String(r?.before ?? ""),
      after: String(r?.after ?? ""),
      hits: Array.isArray(r?.hits) ? r.hits.map((h) => ({ label: String(h?.label ?? ""), count: Number(h?.count) || 0 })) : [],
    };
  } catch (e) {
    previewOut.value = null;
    flashOutbound(false, `试跑失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    previewBusy.value = false;
  }
}
function profileLabelOf(id: string) {
  if (!id) return "不额外套档案";
  const hit = outboundProfiles.value.find((p) => p.id === id);
  return hit ? `${hit.label}${hit.builtin ? "（内置）" : ""}` : id;
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <div class="page-title">网络代理</div>
        <div class="page-sub">
          网关向上游转发时的出网出口池：配一次、测一次，按策略取用；默认直连，配好并切到「固定」或「轮询」后才走代理
        </div>
      </div>
      <div class="page-actions">
        <span v-if="loading" class="hint">加载中…</span>
        <button class="btn-outline" @click="openSettings">代理设置</button>
        <button class="btn-outline" @click="load">刷新</button>
        <button class="btn btn-primary" @click="openCreate">新增出口</button>
      </div>
    </div>

    <div class="page-body">
      <!-- 二级 tab：出口池与出站伪装是「网关怎么出去」的两半，同页分栏，避免用户在两页之间来回对账 -->
      <div class="seg">
        <button :class="{ on: tab === 'pool' }" @click="tab = 'pool'">出口池</button>
        <button :class="{ on: tab === 'outbound' }" @click="tab = 'outbound'">出站伪装</button>
      </div>

      <div v-if="err" class="card err-card"><div class="s-desc" style="color: var(--err)">{{ err }}</div></div>

      <!-- ================= 出口池（照搬旧版）================= -->
      <template v-if="tab === 'pool'">
        <!-- 出口策略：改完立即落盘，下一次上游请求就按新策略走 -->
        <div class="card strategy-card">
          <div class="strategy-row">
            <div class="s-left">
              <div class="s-title">出口策略</div>
              <div class="s-desc">
                直连 = 不经过任何代理（与未配置时完全一致）；固定 = 所有上游请求都走指定出口；轮询 = 每条请求按顺序换一条启用出口
              </div>
              <div class="s-desc" style="color: var(--text-3)">
                共 {{ items.length }} 条出口 · 已启用 {{ enabledCount }} 条 · 当前：{{ MODE_LABEL[mode] }}
              </div>
            </div>
            <div class="strategy-ctl">
              <el-radio-group :model-value="mode" :disabled="strategyBusy" @update:model-value="onModeChange">
                <el-radio-button value="off">直连</el-radio-button>
                <el-radio-button value="fixed">固定出口</el-radio-button>
                <el-radio-button value="rotate">轮询</el-radio-button>
              </el-radio-group>
              <el-select
                v-if="mode === 'fixed'"
                :model-value="fixedId"
                placeholder="选择出口"
                popper-class="glass-popper"
                class="f-el-select fixed-select"
                @update:model-value="(v: string) => { fixedId = v; saveStrategy(); }"
              >
                <el-option v-for="i in items" :key="i.id" :value="i.id" :label="`${i.name}（${i.host}:${i.port}）${i.enabled ? '' : ' · 已停用'}`" />
              </el-select>
              <span v-if="strategyMsg" class="hint" :style="{ color: strategyMsg.ok ? 'var(--ok)' : 'var(--err)' }">{{ strategyMsg.text }}</span>
            </div>
          </div>
        </div>

        <!-- 工具条：多选后原地换成批量条，表格不因多出一条状态带而整体下移 -->
        <div class="toolbar">
          <template v-if="selectedCount">
            <span class="batch-info">已选 {{ selectedCount }} 条</span>
            <button class="btn-outline" :disabled="batchTesting" @click="batchTest">{{ batchTesting ? "测试中…" : "批量测试" }}</button>
            <button class="btn danger" :disabled="batchDeleting" @click="batchDelete">{{ batchDeleting ? "删除中…" : "批量删除" }}</button>
            <button class="btn-ghost" @click="selectedIds = new Set()">取消选择</button>
          </template>
          <template v-else>
            <span class="hint">出口可被「固定出口」策略引用；停用的出口不参与轮询，也不会被固定策略取用</span>
          </template>
        </div>

        <div class="card">
          <div class="table-scroll">
            <table class="table table-bare tbl-static netproxy-tbl">
              <thead>
                <tr>
                  <th class="sel-col"><input type="checkbox" :checked="allSelected" :disabled="!items.length" @change="toggleSelectAll" /></th>
                  <th style="width: 190px">名称</th>
                  <th style="width: 210px">地址</th>
                  <th style="width: 130px">认证</th>
                  <th style="width: 74px">启用</th>
                  <th>连通性</th>
                  <th style="width: 168px">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in items" :key="item.id">
                  <td class="sel-col"><input type="checkbox" :checked="selectedIds.has(item.id)" @change="toggleSelect(item.id)" /></td>
                  <td>
                    <div class="np-name">{{ item.name }}</div>
                    <div class="np-meta">
                      <span class="tag tag-dim">{{ item.protocol }}</span>
                      <span v-if="mode === 'fixed' && fixedId === item.id" class="tag tag-ok" style="margin-left: 6px">当前固定出口</span>
                    </div>
                  </td>
                  <td class="mono np-addr">
                    <span>{{ item.host }}:{{ item.port }}</span>
                    <button class="btn-link btn-sm" @click="copyAddress(item)">{{ copiedId === item.id ? "已复制" : "复制" }}</button>
                  </td>
                  <td class="np-auth">
                    <span v-if="item.hasPassword">账号密码</span>
                    <span v-else-if="item.username">仅账号</span>
                    <span v-else class="hint">无</span>
                  </td>
                  <td>
                    <el-switch :model-value="item.enabled" size="small" @update:model-value="(v: string | number | boolean) => toggleItem(item, !!v)" />
                  </td>
                  <td class="np-health">
                    <template v-if="testing[item.id]">
                      <span class="hint">测试中…</span>
                    </template>
                    <template v-else-if="item.lastTest">
                      <div class="np-health-line">
                        <span class="tag" :class="item.lastTest.success ? 'tag-ok' : 'tag-err'">{{ item.lastTest.success ? "可用" : "失败" }}</span>
                        <span class="hint">
                          {{ item.lastTest.success ? `HTTP ${item.lastTest.status ?? "—"} · ${fmtMs(item.lastTest.durationMs)}` : fmtMs(item.lastTest.durationMs) }}
                          <template v-if="item.lastTest.ip"> · 出口 {{ item.lastTest.ip }}</template>
                          <template v-if="item.lastTest.at"> · {{ fmtAgo(item.lastTest.at) }}</template>
                        </span>
                      </div>
                      <el-tooltip v-if="!item.lastTest.success && item.lastTest.error" :content="item.lastTest.error" placement="top">
                        <div class="np-err-line">{{ item.lastTest.error }}</div>
                      </el-tooltip>
                    </template>
                    <span v-else class="hint">未测试</span>
                  </td>
                  <td>
                    <button class="btn-link btn-sm" :disabled="testing[item.id]" @click="testItem(item)">测试</button>
                    <button class="btn-link btn-sm" @click="openEdit(item)">编辑</button>
                    <button class="btn-link btn-sm danger" @click="deleteItem(item)">删除</button>
                  </td>
                </tr>
                <tr v-if="!items.length">
                  <td colspan="7" class="empty">
                    还没有配置出口{{ loading ? "" : " —— 点右上角「新增出口」，填上代理的主机与端口即可" }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>

      <!-- ================= 出站伪装与清洗 ================= -->
      <template v-else>
        <div v-if="!outboundReady" class="card">
          <div class="card-title">出站伪装与清洗</div>
          <div class="set-desc">
            需要主进程的 localgw_outbound_get / localgw_outbound_set / localgw_outbound_preview 三条通道；当前不可用，
            这块整体降级为占位（出口池不受影响）。
          </div>
          <div v-if="outboundErr" class="set-desc err-text" style="margin-top: 6px; overflow-wrap: anywhere">原始报错：{{ outboundErr }}</div>
          <div class="p-actions">
            <button class="btn" :disabled="outboundLoading" @click="loadOutbound">{{ outboundLoading ? "读取中…" : "重新读取" }}</button>
          </div>
        </div>

        <template v-else>
          <div v-if="outboundMsg" class="card" :class="outboundMsg.ok ? 'ok-card' : 'err-card'">
            <div class="set-desc" :class="{ 'err-text': !outboundMsg.ok }">{{ outboundMsg.text }}</div>
          </div>

          <!-- 全局默认策略：未单独配置的渠道都继承它 -->
          <div class="card strategy-card">
            <div class="strategy-row">
              <div class="s-left">
                <div class="s-title">全局默认策略</div>
                <div class="s-desc">
                  伪装 = 按档案套官方客户端形态后再发出；全透传 = 头与 body 都不动（短路一切清洗与覆盖，用于排查「是不是伪装本身把请求改坏了」）
                </div>
                <div class="s-desc" style="color: var(--text-3)">
                  当前：{{ passthrough ? "全透传" : "伪装" }} · 档案 {{ profileLabelOf(outbound.defaults.profile) }}
                </div>
              </div>
              <div class="strategy-ctl">
                <div class="seg">
                  <button :class="{ on: !passthrough }" :disabled="outboundSaving" @click="setOutboundMode('mimic')">伪装</button>
                  <button :class="{ on: passthrough }" :disabled="outboundSaving" @click="setOutboundMode('passthrough')">全透传</button>
                </div>
                <el-select
                  :model-value="outbound.defaults.profile"
                  placeholder="不额外套档案"
                  popper-class="glass-popper"
                  class="f-el-select fixed-select"
                  :disabled="outboundSaving || passthrough"
                  @update:model-value="setOutboundProfile"
                >
                  <el-option value="" label="不额外套档案（用渠道自带形态）" />
                  <el-option v-for="p in outboundProfiles" :key="p.id" :value="p.id" :label="`${p.label}${p.builtin ? '（内置）' : ''}`" />
                </el-select>
              </div>
            </div>
            <div class="strategy-row" style="border-top: 1px solid var(--line)">
              <div class="s-left">
                <div class="s-desc">
                  五个开关都只作用于<b>伪装</b>模式；全透传下置灰。执行顺序：先文案替换、后关键词清洗（与 sanitize.cjs「先改写层、后剥离层」一致）。
                </div>
              </div>
              <div class="strategy-ctl">
                <label v-for="s in OUTBOUND_SWITCHES" :key="String(s.key)" class="ob-switch" :title="s.hint">
                  <el-switch
                    :model-value="!!outbound.defaults[s.key]"
                    size="small"
                    :disabled="outboundSaving || passthrough"
                    @update:model-value="(v: string | number | boolean) => setOutboundSwitch(s.key, v)"
                  />
                  <span>{{ s.label }}</span>
                </label>
              </div>
            </div>
          </div>

          <!-- 关键词清洗：全局库，所有渠道叠加使用 -->
          <div class="card">
            <div class="card-title">
              关键词清洗
              <span class="right"><span class="hint">{{ outbound.keywords.length }} 条 · 全局库，所有渠道叠加使用</span></span>
            </div>
            <div v-if="!outbound.keywords.length" class="set-desc">还没有关键词规则。逐字匹配适合删掉固定的特征串，正则适合带走位的内容。</div>
            <div v-else class="tbl-wrap">
              <table class="tbl ob-tbl">
                <thead>
                  <tr>
                    <th style="width: 54px">启用</th>
                    <th style="width: 170px">展示名</th>
                    <th style="width: 104px">方式</th>
                    <th style="width: 122px">作用域</th>
                    <th>匹配内容</th>
                    <th>替换为</th>
                    <th style="width: 78px">flags</th>
                    <th style="width: 70px">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(r, i) in outbound.keywords" :key="r.id || i">
                    <td><input v-model="r.enabled" type="checkbox" @change="commitKeywords" /></td>
                    <td><input v-model="r.label" class="input" placeholder="命中摘要里用它" @blur="commitKeywords" /></td>
                    <td>
                      <el-select v-model="r.mode" size="small" popper-class="glass-popper" :disabled="outboundSaving" @change="commitKeywords">
                        <el-option value="literal" label="逐字" />
                        <el-option value="regex" label="正则" />
                      </el-select>
                    </td>
                    <td>
                      <el-select v-model="r.scope" size="small" popper-class="glass-popper" :disabled="outboundSaving" @change="commitKeywords">
                        <el-option v-for="s in SCOPES" :key="s.value" :value="s.value" :label="s.label" />
                      </el-select>
                    </td>
                    <td><input v-model="r.pattern" class="input mono" placeholder="literal 逐字；regex 编译为正则" @blur="commitKeywords" /></td>
                    <td><input v-model="r.replace" class="input mono" placeholder="regex 可用 $1" @blur="commitKeywords" /></td>
                    <td><input v-if="r.mode === 'regex'" v-model="r.flags" class="input mono" placeholder="g" @blur="commitKeywords" /><span v-else class="hint">—</span></td>
                    <td><button class="btn-link btn-sm danger" @click="delKeyword(i)">删除</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="p-actions">
              <button class="btn btn-sm" :disabled="outboundSaving" @click="addKeyword">添加关键词</button>
            </div>
          </div>

          <!-- 文案替换：整句成对改写，比关键词更适合改「身份句」 -->
          <div class="card">
            <div class="card-title">
              文案替换
              <span class="right"><span class="hint">{{ outbound.rewrites.length }} 条 · 执行顺序在关键词之前</span></span>
            </div>
            <div v-if="!outbound.rewrites.length" class="set-desc">还没有文案替换规则。整句成对编辑，比关键词更适合改「身份句」。</div>
            <div v-else class="tbl-wrap">
              <table class="tbl ob-tbl">
                <thead>
                  <tr>
                    <th style="width: 54px">启用</th>
                    <th style="width: 170px">展示名</th>
                    <th style="width: 122px">作用域</th>
                    <th>原文（整句）</th>
                    <th>替换为</th>
                    <th style="width: 70px">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(r, i) in outbound.rewrites" :key="r.id || i">
                    <td><input v-model="r.enabled" type="checkbox" @change="commitRewrites" /></td>
                    <td><input v-model="r.label" class="input" placeholder="展示名" @blur="commitRewrites" /></td>
                    <td>
                      <el-select v-model="r.scope" size="small" popper-class="glass-popper" :disabled="outboundSaving" @change="commitRewrites">
                        <el-option v-for="s in SCOPES" :key="s.value" :value="s.value" :label="s.label" />
                      </el-select>
                    </td>
                    <td><input v-model="r.from" class="input mono" placeholder="原文（整句）" @blur="commitRewrites" /></td>
                    <td><input v-model="r.to" class="input mono" placeholder="替换为" @blur="commitRewrites" /></td>
                    <td><button class="btn-link btn-sm danger" @click="delRewrite(i)">删除</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="p-actions">
              <button class="btn btn-sm" :disabled="outboundSaving" @click="addRewrite">添加文案替换</button>
            </div>
          </div>

          <!-- 试跑：纯函数计算，不打上游，用来确认规则命中与最终文本 -->
          <div class="card">
            <div class="card-title">
              试跑
              <span class="right"><span class="hint">只做本地清洗计算，不消耗额度</span></span>
            </div>
            <div class="ob-preview-row">
              <el-select v-model="previewChannel" popper-class="glass-popper" class="f-el-select" style="width: 260px" :disabled="previewBusy">
                <el-option value="" label="不指定渠道（按全局默认）" />
                <el-option v-for="c in outboundChannels" :key="c.id" :value="c.id" :label="`${c.display}（${c.policy.mode}）`" />
              </el-select>
              <input v-model="previewText" class="input mono ob-preview-input" placeholder="要试跑的一段文本" @keyup.enter="runPreview" />
              <button class="btn btn-primary" :disabled="previewBusy || !previewText" @click="runPreview">{{ previewBusy ? "试跑中…" : "试跑" }}</button>
            </div>
            <div v-if="previewOut" class="set-desc ob-preview-out">
              · 命中：{{ previewOut.hits.length ? formatPreviewHits(previewOut.hits) : "无" }}<br />
              · 结果：{{ previewOut.after === previewOut.before ? "与原文相同（没有规则命中）" : previewOut.after }}
            </div>
            <div v-else-if="!outboundChannels.length" class="set-desc" style="margin-top: 8px">
              还没有渠道清单（需要后端 localgw_outbound_get 返回 channels，号池里得先有渠道与账号）；不指定渠道也能试跑全局规则。
            </div>
          </div>
        </template>
      </template>
    </div>

    <!-- 新增 / 编辑出口 -->
    <Teleport to="body">
      <div v-if="formOpen" class="p-mask" @click.self="!formBusy && (formOpen = false)">
        <div class="p-dlg np-dlg" role="dialog" aria-modal="true" :aria-label="editingId ? '编辑出口' : '新增出口'">
          <div class="p-title">{{ editingId ? "编辑出口" : "新增出口" }}</div>
          <div class="np-form">
            <label class="np-field">
              <span>名称</span>
              <input v-model="form.name" class="f-input" placeholder="例如：香港落地 / 公司出口" maxlength="60" />
            </label>
            <div class="np-field-row">
              <label class="np-field">
                <span>协议</span>
                <el-select v-model="form.protocol" popper-class="glass-popper" class="f-el-select">
                  <el-option value="http" label="HTTP / HTTPS" />
                  <el-option value="socks5" label="SOCKS5" />
                </el-select>
              </label>
              <label class="np-field np-field-grow">
                <span>主机</span>
                <input v-model="form.host" class="f-input mono" placeholder="127.0.0.1" maxlength="255" />
              </label>
              <label class="np-field np-field-port">
                <span>端口</span>
                <input v-model="form.port" class="f-input mono" placeholder="7890" inputmode="numeric" />
              </label>
            </div>
            <div class="np-field-row">
              <label class="np-field np-field-grow">
                <span>用户名（可选）</span>
                <input v-model="form.username" class="f-input mono" placeholder="留空表示不需要认证" autocomplete="off" maxlength="200" />
              </label>
              <label class="np-field np-field-grow">
                <span>密码（可选）</span>
                <input
                  v-model="form.password"
                  class="f-input mono"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="editingItem?.hasPassword ? '留空表示不修改' : '留空表示不需要认证'"
                  @input="form.clearPassword = false"
                />
              </label>
            </div>
            <div class="np-form-foot">
              <label class="np-check">
                <input v-model="form.enabled" type="checkbox" />
                <span>启用这条出口</span>
              </label>
              <button
                v-if="editingItem?.hasPassword"
                class="btn-link btn-sm"
                @click="form.clearPassword = !form.clearPassword; form.password = ''"
              >
                {{ form.clearPassword ? "已标记清除密码（点此撤销）" : "清除已保存的密码" }}
              </button>
            </div>
            <div class="np-status" :style="{ color: formStatus ? (formStatus.ok ? 'var(--ok)' : 'var(--err)') : 'var(--text-3)' }">
              {{ formStatus ? formStatus.text : "密码经本机加密后落盘，列表接口不会回传明文；编辑时留空即保持原密码" }}
            </div>
          </div>
          <div class="p-actions">
            <button class="btn-outline" :disabled="formTesting || formBusy" @click="testDraft">{{ formTesting ? "测试中…" : "测试出口" }}</button>
            <div style="flex: 1"></div>
            <button class="btn-ghost" :disabled="formBusy" @click="formOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="formBusy" @click="saveForm">{{ formBusy ? "保存中…" : "保存" }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 代理设置 -->
    <Teleport to="body">
      <div v-if="settingsOpen" class="p-mask" @click.self="!settingsBusy && (settingsOpen = false)">
        <div class="p-dlg np-dlg" role="dialog" aria-modal="true" aria-label="代理设置">
          <div class="p-title">代理设置</div>
          <div class="np-form">
            <label class="np-field">
              <span>出口测试网址</span>
              <input v-model="settings.testUrl" class="f-input mono" :placeholder="data?.settings.defaultTestUrl || 'https://api.deepseek.com/'" />
            </label>
            <div class="s-desc" style="margin-top: 6px">
              「测试」与「批量测试」访问的目标；留空用默认（{{ data?.settings.defaultTestUrl || "默认站点" }}）。判据是能否拿到 HTTP 响应，不关心返回内容
            </div>
            <label class="np-field" style="margin-top: 14px">
              <span>测试超时（毫秒）</span>
              <input v-model="settings.timeoutMs" class="f-input mono" inputmode="numeric" placeholder="15000" />
            </label>
            <div class="s-desc" style="margin-top: 6px">1000 - 120000；出口慢（跨境 / 弱网）时适当放大</div>
            <div class="np-status" :style="{ color: settingsMsg ? (settingsMsg.ok ? 'var(--ok)' : 'var(--err)') : 'var(--text-3)' }">
              {{ settingsMsg ? settingsMsg.text : "设置立即生效，只影响测试，不影响转发超时" }}
            </div>
          </div>
          <div class="p-actions">
            <button class="btn-ghost" :disabled="settingsBusy" @click="resetSettings">恢复默认</button>
            <div style="flex: 1"></div>
            <button class="btn-ghost" :disabled="settingsBusy" @click="settingsOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="settingsBusy" @click="saveSettings">{{ settingsBusy ? "保存中…" : "保存" }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
/* ===== 二级 tab：出口池 / 出站伪装 =====
   自研原子类而不是 el-radio-group：这里表达的是「页面分栏」而非「表单取值」，
   两栏各自有整块内容，用按钮语义更贴切（也省一个 Element 组件）。 */
.seg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  margin-bottom: 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--bg-2, transparent);
}
.seg > button {
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  padding: 5px 16px;
  border-radius: 7px;
  cursor: pointer;
}
.seg > button.on {
  background: var(--accent, #4a9eff);
  color: #fff;
}
.seg > button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.ok-card {
  margin-bottom: 12px;
  border-color: var(--ok, #2fa977);
}
.err-text {
  color: var(--err, #e05555);
}

/* 策略卡：与设置页的 .switch-row 同一套「左说明 + 右控件」版式 */
.strategy-card {
  padding: 6px 18px;
}
.strategy-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 12px 0;
}
.strategy-row .s-left {
  flex: 1;
  min-width: 0;
}
.strategy-ctl {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.fixed-select {
  width: 220px;
}

/* 工具条：批量条与说明共用一个槽位 */
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
  margin: 14px 0 10px;
}
.batch-info {
  font-size: 12px;
  color: var(--text-2);
  font-weight: 600;
}

.table-scroll {
  overflow-x: auto;
}
/* 出口列表：本表行内只有复选框与按钮，不点行看详情。
   全局 .table 默认给了 pointer + 主色悬停底色，这里关掉，免得看起来像能点 */
.tbl-static tbody tr {
  cursor: default;
}
.tbl-static tbody tr:hover {
  background: transparent;
}
.netproxy-tbl {
  width: 100%;
}
.netproxy-tbl th {
  text-align: left;
}
.netproxy-tbl td {
  vertical-align: middle;
}
.netproxy-tbl .sel-col {
  width: 34px;
  text-align: center;
}
.netproxy-tbl .sel-col input[type="checkbox"] {
  vertical-align: middle;
  cursor: pointer;
  accent-color: var(--accent);
}
.np-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}
.np-meta {
  display: flex;
  align-items: center;
  margin-top: 3px;
}
.np-addr {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  word-break: break-all;
}
.np-auth {
  font-size: 12px;
  color: var(--text-2);
}
.np-health-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.np-err-line {
  margin-top: 3px;
  font-size: 11px;
  color: var(--err);
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-err {
  color: var(--err);
  background: color-mix(in srgb, var(--err) 14%, transparent);
}
.empty {
  text-align: center;
  color: var(--text-3);
  padding: 26px 0;
}

/* 弹窗表单 */
.np-dlg {
  width: 560px;
}
.np-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.np-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.np-field > span {
  font-size: 11px;
  color: var(--text-3);
}
.np-field-row {
  display: flex;
  gap: 10px;
}
.np-field-grow {
  flex: 1;
}
.np-field-port {
  width: 92px;
  flex-shrink: 0;
}
.np-form-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 22px;
}
.np-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}
.np-check input {
  accent-color: var(--accent);
}
.np-status {
  font-size: 11.5px;
  line-height: 1.6;
  min-height: 18px;
}

/* ===== 出站伪装：开关组 / 规则表 / 试跑 ===== */
/* 五个开关横排：窄屏换行，不挤压左边的说明列 */
.ob-switch {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  white-space: nowrap;
}
/* 规则表：单元格里是输入控件，行高要比展示型表格矮一点才不显臃肿 */
.ob-tbl th {
  text-align: left;
  font-weight: 500;
}
.ob-tbl td {
  vertical-align: middle;
  padding: 4px 6px;
}
.ob-tbl td .input {
  width: 100%;
}
.ob-tbl td input[type="checkbox"] {
  cursor: pointer;
  accent-color: var(--accent);
}
.ob-preview-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.ob-preview-input {
  flex: 1;
  min-width: 220px;
}
.ob-preview-out {
  margin-top: 10px;
  line-height: 1.9;
  overflow-wrap: anywhere;
}
</style>

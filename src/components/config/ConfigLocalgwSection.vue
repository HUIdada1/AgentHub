<!--
  ============================================================
   作者：沐晖
   日期：2026-10-27
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 本地网关 · 配置（方案 §7 默认值清单）
     五个二级 tab：监听与安全 / 性能与限流 / 联动 / 扩展点 / 出站伪装。
     改动即存（与提示词库配置页同款交互：用户改完常直接关弹窗，漏存比多存烦人）。
     所有字段打开时就按 LOCALGW_CONFIG_DEFAULTS 渲染好，用户零成本上手（方案 §7 末段）。
     「出站伪装」按 docs/localgw-outbound-contract.md（冻结契约）§2/§4.8/§5.3 实现。 -->
<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAppStore } from "../../stores/app";
import {
  LOCALGW_CONFIG_DEFAULTS,
  type LocalgwConfig,
  type LocalgwKeywordRule,
  type LocalgwOutboundConfig,
  type LocalgwOutboundPolicy,
  type LocalgwProfile,
  type LocalgwRewriteRule,
  type LocalgwRuleScope,
} from "../../types";
import * as api from "../../api/ipc";

const app = useAppStore();
const tab = ref<"net" | "perf" | "bind" | "extend" | "outbound">("net");

/** 深拷贝：本文件既有的 JSON.parse(JSON.stringify(...)) 写法收敛成一个函数（配置来自 JSON，无函数/循环引用） */
function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
/** 纯对象判定：数组与 null 都不算（契约 §4.5 的「必须是纯对象」同款口径） */
function isPlain(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 表单镜像：以 store 里的配置为源，改动即 patch 到主进程 config.json 的 localgw 段 */
const form = reactive<LocalgwConfig>(JSON.parse(JSON.stringify(LOCALGW_CONFIG_DEFAULTS)));
watch(
  () => app.config.localgw,
  (v) => {
    if (!v) return;
    const copy = JSON.parse(JSON.stringify(v)) as LocalgwConfig;
    Object.assign(form, copy);
    // outbound 是新增段：老 config.json / 后端未接线时可能整段缺失或只有半个形状，
    // 不补齐的话模板里 form.outbound.defaults.xxx 会直接抛错把整页打白
    form.outbound = normalizeOutbound(copy.outbound);
  },
  { immediate: true, deep: true }
);

/** 后端通道是否可用：不可用时所有写操作会失败，页面上要明确说明而不是静默 */
const backendReady = ref(false);
const saving = ref(false);

/** 改动即存：调 localgw_config_patch（深合并补丁），失败必须把错误说出来 */
async function patch(p: Record<string, unknown>) {
  if (saving.value) return;
  saving.value = true;
  try {
    const r = await api.localgwConfigPatch(p);
    if (r && r.ok) {
      // 回写内存态，避免配置页与其它页面（如总览的 Base URL）读到旧值
      Object.assign(app.config.localgw as object, p);
      ElMessage.success("已保存");
    } else {
      ElMessage.error("保存失败：主进程未响应");
    }
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  } finally {
    saving.value = false;
  }
}

/** 改绑定地址要二次确认：0.0.0.0 会把网关暴露到局域网/公网 */
async function setBind(v: string) {
  if (v !== "127.0.0.1" && v !== "::1") {
    try {
      await ElMessageBox.confirm(
        `绑定到 ${v} 后，局域网内其它设备也能访问该网关。请确认你了解这个风险。`,
        "开放网络访问",
        { confirmButtonText: "我知道，继续", cancelButtonText: "取消", type: "warning" }
      );
    } catch {
      return;
    }
  }
  form.bind = v;
  await patch({ bind: v });
}

async function setPort(v: number) {
  form.port = v;
  // 端口走专用通道（方案 §6 localgw_set_port），不走 config_patch：
  // 它除了写配置，还会在网关运行中「停止 → 用新端口重启」，改完立即生效；
  // 只 patch 配置的话运行中的实例仍监听旧端口，用户看到的是「改了没反应」。
  if (saving.value) return;
  saving.value = true;
  try {
    const r = await api.localgwSetPort(v);
    if (r && r.ok) {
      Object.assign(app.config.localgw as object, { port: v });
      ElMessage.success(r.port && r.port !== v ? `已保存，当前实际端口 ${r.port}` : "端口已保存");
    } else {
      ElMessage.error((r && r.message) || "端口保存失败");
    }
  } catch (e) {
    ElMessage.error((e as Error).message || "端口保存失败");
  } finally {
    saving.value = false;
  }
}

/** 端口候选列表：编辑成 "9527,9528" 这类逗号分隔串 */
const portCandidatesText = computed({
  get: () => (form.portCandidates || []).join(", "),
  set: (v: any) => {
    const arr = String(v)
      .split(/[,，\s]+/)
      .map((s: string) => parseInt(s.trim(), 10))
      .filter((n: number) => Number.isFinite(n) && n > 0 && n < 65536);
    form.portCandidates = arr;
  },
});

/** 安全：清空 secret 后重启会重新生成（用于轮转） */
async function rotateSecret() {
  try {
    await ElMessageBox.confirm(
      "轮转密钥后，已签发的访问凭据会失效（API Key 不受影响，它们哈希存库）。继续？",
      "轮转内部签名密钥",
      { confirmButtonText: "轮转", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return;
  }
  await patch({ security: { ...form.security, secret: "" } });
}

/** provider 扩展点：本期只做开关与目录，exe 不进仓库（方案决策 2） */
const providersHint = computed(() =>
  form.providers.enabled
    ? "已开启：将从指定目录扫描 provider，未通过 doctor 校验的不会被加载"
    : "未开启（本期默认）：仅保留接口与目录约定，不加载任何第三方 provider"
);

watch(
  () => app.config.localgw,
  async () => {
    const st = await api.localgwStatus().catch(() => null);
    backendReady.value = !!st;
  },
  { immediate: true }
);

// ===== 出站伪装与清洗（契约 §5.3 第 5 个 tab）=====
// 数据只来自 localgw_outbound_get 一条通道，本文件不做任何网络/后端探测（契约 §5.3 末条）。
// 后端通道可能还没接线（T1 并行实现中）：读写全部包在 try/catch 里，失败只落
// 「后端通道未接入」占位，绝不冒未捕获异常、绝不白屏。

/** 补齐成契约 §2 的稳定形状（手改 config.json 删过键 / 老配置没有这一段时也不会炸） */
function normalizeProfile(raw: unknown): LocalgwProfile {
  const r = (isPlain(raw) ? raw : {}) as Partial<LocalgwProfile>;
  return {
    label: typeof r.label === "string" ? r.label : "",
    userAgent: typeof r.userAgent === "string" ? r.userAgent : "",
    headers: isPlain(r.headers) ? (r.headers as Record<string, string>) : {},
    removeHeaders: Array.isArray(r.removeHeaders) ? r.removeHeaders.filter((s) => typeof s === "string") : [],
    note: typeof r.note === "string" ? r.note : "",
  };
}
function normalizeOutbound(raw: unknown): LocalgwOutboundConfig {
  const base = deepClone(LOCALGW_CONFIG_DEFAULTS.outbound);
  const r = (isPlain(raw) ? raw : {}) as Partial<LocalgwOutboundConfig>;
  const d = (isPlain(r.defaults) ? r.defaults : {}) as Partial<LocalgwOutboundConfig["defaults"]>;
  const prof = isPlain(r.profiles) ? (r.profiles as LocalgwOutboundConfig["profiles"]) : null;
  const custom = prof && isPlain(prof.custom) ? prof.custom : {};
  return {
    defaults: { ...base.defaults, ...d },
    perChannel: isPlain(r.perChannel) ? (r.perChannel as LocalgwOutboundConfig["perChannel"]) : {},
    keywords: Array.isArray(r.keywords) ? r.keywords : [],
    rewrites: Array.isArray(r.rewrites) ? r.rewrites : [],
    profiles: { custom: Object.fromEntries(Object.entries(custom).map(([id, p]) => [id, normalizeProfile(p)])) },
  };
}

const outbound = reactive<LocalgwOutboundConfig>(deepClone(LOCALGW_CONFIG_DEFAULTS.outbound));
/** 出站通道是否可用（三条 localgw_outbound_* 通道是否已注册） */
const outboundReady = ref(false);
const outboundLoading = ref(false);
const outboundSaving = ref(false);
/** 通道不可用时的原始报错（展示出来，不吞） */
const outboundErr = ref("");
/** outbound_get 的 profiles：内置（只读）+ 自定义，供下拉与档案区展示 */
const outboundProfiles = ref<api.LocalgwOutboundProfileOption[]>([]);
/** outbound_get 的 channels：渠道清单 + 各自生效策略摘要（后端 describePolicy 算的） */
const outboundChannels = ref<api.LocalgwOutboundChannelRow[]>([]);
/** 当前展开编辑的渠道 id */
const openChannel = ref("");
/** 展开渠道时的请求头草稿：headers 是 map，用「行」编辑比直接 v-model 一个对象好写也好读 */
const chanDraft = reactive<{ id: string; headers: { k: string; v: string }[]; removeHeaders: string }>({
  id: "",
  headers: [],
  removeHeaders: "",
});

/** 读 outbound_get。失败 = 通道未接入（真机未注册 → unwrapResult 抛错；dev:web 预览 → mock 抛错） */
async function loadOutbound() {
  if (outboundLoading.value) return;
  outboundLoading.value = true;
  try {
    const r = await api.localgwOutboundGet();
    if (!r || !r.outbound) throw new Error("主进程未返回 outbound 配置");
    Object.assign(outbound, normalizeOutbound(r.outbound));
    outboundProfiles.value = Array.isArray(r.profiles) ? r.profiles : [];
    outboundChannels.value = Array.isArray(r.channels) ? r.channels : [];
    outboundReady.value = true;
    outboundErr.value = "";
    // 回写内存态：与上面 patch() 同款做法，避免其它页面读到旧配置
    const cfg = app.config.localgw as LocalgwConfig | undefined;
    if (cfg) cfg.outbound = deepClone(outbound);
  } catch (e) {
    outboundReady.value = false;
    outboundProfiles.value = [];
    outboundChannels.value = [];
    outboundErr.value = e instanceof Error && e.message ? e.message : "出站通道不可用";
    openChannel.value = "";
  } finally {
    outboundLoading.value = false;
  }
}

/** 改动即存：调 localgw_outbound_set（深合并补丁）。
 *  `null` = 删除该键（契约 §4.5.1，RFC 7386）：perChannel[cid] / profiles.custom[id] / perChannel[cid].headers[key]；
 *  数组（keywords / rewrites / removeHeaders）是整体替换，清空发 []，不要发 null 元素。
 *  存完重新拉一次：渠道行的生效策略摘要是后端算的（describePolicy），前端推不出来。 */
async function patchOutbound(p: Record<string, unknown>, label: string): Promise<boolean> {
  if (outboundSaving.value) return false;
  outboundSaving.value = true;
  try {
    const r = await api.localgwOutboundSet(p);
    if (!r || !r.ok) {
      ElMessage.error((r && r.message) || `${label}保存失败：主进程未响应`);
      return false;
    }
    ElMessage.success("已保存");
    await loadOutbound();
    return true;
  } catch (e) {
    ElMessage.error(e instanceof Error && e.message ? e.message : `${label}保存失败`);
    return false;
  } finally {
    outboundSaving.value = false;
  }
}

/** 切到「出站伪装」时才拉数据：不在页面初始化时无条件探测未接线的通道 */
watch(tab, (v) => {
  if (v === "outbound" && !outboundReady.value) void loadOutbound();
});

// ---- 全局默认 ----
type BooleanPolicyKey = "builtinSanitize" | "keywordSanitize" | "rewriteSanitize" | "headerOverride" | "jitter";
const POLICY_FLAGS: { key: BooleanPolicyKey; label: string; hint: string }[] = [
  { key: "builtinSanitize", label: "内置指纹脱敏", hint: "叠加 sanitize.cjs 内置规则（模板句 / 计费头字段名 / 裸错误码 11128）" },
  { key: "keywordSanitize", label: "关键词清洗", hint: "启用关键词规则（全局库 + 渠道内联）" },
  { key: "rewriteSanitize", label: "文案替换", hint: "启用文案替换表（整句成对改写，执行顺序在关键词之前）" },
  { key: "headerOverride", label: "请求头覆盖", hint: "启用 headers 覆盖与 removeHeaders 移除；自定义供应商建议关掉" },
  { key: "jitter", label: "拟人抖动", hint: "每次上游请求前随机停 40~220ms（沿用原 humanizeJitter 语义）" },
];

function modeLabel(m: string): string {
  return m === "passthrough" ? "全透传" : "伪装";
}
function modeHint(m: string): string {
  return m === "passthrough"
    ? "短路一切：不改请求头、不清洗 body、不加抖动"
    : "按下面各项逐条生效";
}
/** 老开关（指纹脱敏 / 拟人抖动）与新开关的关系要说清楚，否则用户会以为两边打架 */
const legacyHint = computed(() =>
  form.fingerprintObfuscation === false || form.humanizeJitter === false
    ? "注意：本页「性能与限流」里的旧开关当前是关的（指纹脱敏 / 拟人抖动），后端按「旧开关关 = 新开关也关」处理，这里打开也会被旧开关压住。"
    : "「性能与限流」里的旧开关（指纹脱敏 / 拟人抖动）仍生效，语义是「旧开关关 = 新开关也关」。"
);

function setDefaultMode(v: string) {
  const mode: "mimic" | "passthrough" = v === "passthrough" ? "passthrough" : "mimic";
  outbound.defaults.mode = mode;
  void patchOutbound({ defaults: { ...outbound.defaults, mode } }, "出站模式");
}
function setDefaultProfile(v: string) {
  const profile = String(v || "");
  outbound.defaults.profile = profile;
  void patchOutbound({ defaults: { ...outbound.defaults, profile } }, "模拟档案");
}
function setDefaultFlag(key: BooleanPolicyKey, v: boolean) {
  outbound.defaults[key] = v;
  void patchOutbound({ defaults: { ...outbound.defaults } }, "出站开关");
}

// ---- 按渠道策略 ----
function chanPolicy(id: string): Partial<LocalgwOutboundPolicy> {
  const v = outbound.perChannel[id];
  return isPlain(v) ? v : {};
}
/** 该字段是否被渠道显式覆盖（undefined = 继承全局默认；"" 是有意义的显式值，不算继承） */
function chanOverridden(id: string, key: keyof LocalgwOutboundPolicy): boolean {
  return chanPolicy(id)[key] !== undefined;
}
function chanMode(id: string): "mimic" | "passthrough" {
  const m = chanPolicy(id).mode;
  return m === "passthrough" || m === "mimic" ? m : outbound.defaults.mode;
}
function chanProfile(id: string): string {
  const p = chanPolicy(id).profile;
  return p === undefined ? outbound.defaults.profile : String(p);
}
function chanKeywords(id: string): LocalgwKeywordRule[] {
  const v = chanPolicy(id).keywords;
  return Array.isArray(v) ? v : [];
}
function chanRewrites(id: string): LocalgwRewriteRule[] {
  const v = chanPolicy(id).rewrites;
  return Array.isArray(v) ? v : [];
}

function patchChannel(id: string, p: Record<string, unknown>, label: string) {
  void patchOutbound({ perChannel: { [id]: p } }, label);
}
function setChannelMode(id: string, v: string) {
  patchChannel(id, { mode: v === "passthrough" ? "passthrough" : "mimic" }, "渠道出站模式");
}
function setChannelProfile(id: string, v: string) {
  patchChannel(id, { profile: String(v || "") }, "渠道模拟档案");
}
function toggleChannelRow(id: string) {
  if (openChannel.value === id) {
    openChannel.value = "";
    return;
  }
  openChannel.value = id;
  resetChanDraft(id);
}
function resetChanDraft(id: string) {
  const h = chanPolicy(id).headers;
  const rm = chanPolicy(id).removeHeaders;
  chanDraft.id = id;
  chanDraft.headers = isPlain(h)
    ? Object.keys(h as Record<string, string>).map((k) => ({ k, v: String((h as Record<string, string>)[k]) }))
    : [];
  chanDraft.removeHeaders = Array.isArray(rm) ? rm.join("\n") : "";
}
function addHeaderRow() {
  chanDraft.headers.push({ k: "", v: "" });
}
/** 删一行覆盖头：`headers[key] = null` 是契约 §4.5.1 的删除信号（深合并下删不掉键） */
function removeHeaderRow(i: number) {
  const row = chanDraft.headers[i];
  chanDraft.headers.splice(i, 1);
  const k = row ? row.k.trim() : "";
  if (k) saveChannelHeaders({ [k]: null });
}
function saveChannelHeaders(extra: Record<string, unknown> = {}) {
  const id = chanDraft.id;
  if (!id) return;
  const headers: Record<string, string> = {};
  for (const r of chanDraft.headers) {
    const k = r.k.trim();
    if (k) headers[k] = r.v;
  }
  patchChannel(id, { headers: { ...headers, ...extra } }, "请求头覆盖");
}
function saveChannelRemoveHeaders() {
  const id = chanDraft.id;
  if (!id) return;
  const arr = chanDraft.removeHeaders
    .split(/[\n,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  patchChannel(id, { removeHeaders: arr }, "移除请求头");
}
/** 恢复继承默认：必须发 null —— 发 {} 在深合并下是无操作，发显式默认值则以后改全局默认不再传导 */
async function resetChannelPolicy(id: string) {
  try {
    await ElMessageBox.confirm(
      `将清除「${id}」的渠道级覆盖，回到跟随全局默认策略。继续？`,
      "恢复继承默认",
      { confirmButtonText: "恢复", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return;
  }
  const ok = await patchOutbound({ perChannel: { [id]: null } }, "恢复继承默认");
  if (ok) resetChanDraft(id);
}

// ---- 共享规则库：关键词 / 文案替换（数组整体替换，增删改都靠提交过滤后的数组）----
const SCOPES: { value: LocalgwRuleScope; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "system", label: "system" },
  { value: "user", label: "user" },
  { value: "assistant", label: "assistant" },
  { value: "tool", label: "tool" },
];
/** 规则 id：契约只要求「稳定 id」，不要求格式；这里用时间戳 + 随机片段，避免两条同毫秒 */
function newRuleId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
function newKeywordRule(): LocalgwKeywordRule {
  return { id: newRuleId("k"), label: "", enabled: true, mode: "literal", pattern: "", flags: "", replace: "", scope: "all" };
}
function newRewriteRule(): LocalgwRewriteRule {
  return { id: newRuleId("r"), label: "", enabled: true, from: "", to: "", scope: "system" };
}

function saveGlobalKeywords(v: LocalgwKeywordRule[]) {
  outbound.keywords = v;
  void patchOutbound({ keywords: v }, "关键词规则");
}
function saveGlobalRewrites(v: LocalgwRewriteRule[]) {
  outbound.rewrites = v;
  void patchOutbound({ rewrites: v }, "文案替换");
}
function saveChannelKeywords(id: string, v: LocalgwKeywordRule[]) {
  patchChannel(id, { keywords: v }, "渠道关键词");
}
function saveChannelRewrites(id: string, v: LocalgwRewriteRule[]) {
  patchChannel(id, { rewrites: v }, "渠道文案替换");
}
function addKeyword(list: LocalgwKeywordRule[], save: (v: LocalgwKeywordRule[]) => void) {
  save([...list, newKeywordRule()]);
}
function delKeyword(list: LocalgwKeywordRule[], save: (v: LocalgwKeywordRule[]) => void, i: number) {
  save(list.filter((_, idx) => idx !== i));
}
function addRewrite(list: LocalgwRewriteRule[], save: (v: LocalgwRewriteRule[]) => void) {
  save([...list, newRewriteRule()]);
}
function delRewrite(list: LocalgwRewriteRule[], save: (v: LocalgwRewriteRule[]) => void, i: number) {
  save(list.filter((_, idx) => idx !== i));
}
/** 改一条规则的某个字段后立即存（与全页「改动即存」一致） */
function saveKeywordList(list: LocalgwKeywordRule[], save: (v: LocalgwKeywordRule[]) => void) {
  save(list.map((r) => ({ ...r })));
}
function saveRewriteList(list: LocalgwRewriteRule[], save: (v: LocalgwRewriteRule[]) => void) {
  save(list.map((r) => ({ ...r })));
}
/** 模板里的 v-model 直接改本地镜像里的规则对象，失焦/改选时整体提交一次 */
function commitGlobalKeywords() {
  saveKeywordList(outbound.keywords, saveGlobalKeywords);
}
function commitGlobalRewrites() {
  saveRewriteList(outbound.rewrites, saveGlobalRewrites);
}
function commitChannelKeywords(id: string) {
  saveKeywordList(chanKeywords(id), (v) => saveChannelKeywords(id, v));
}
function commitChannelRewrites(id: string) {
  saveRewriteList(chanRewrites(id), (v) => saveChannelRewrites(id, v));
}

/** 档案 id → 展示名（下拉里选的是 id，界面上要给人看的名字） */
function profileLabelOf(id: string): string {
  if (!id) return "不额外套档案";
  const hit = outboundProfiles.value.find((p) => p.id === id);
  return hit ? hit.label : id;
}

// ---- 试跑（契约 §4.8 的 localgw_outbound_preview，纯函数计算，不打上游）----
const previewText = ref("You are Claude Code, Anthropic's official CLI for Claude");
const previewChannel = ref("");
/** 命中明细与后端 hitList() 同形状（{label,count}[]，次数降序），不是 string[] */
const previewOut = ref<{ before: string; after: string; hits: { label: string; count: number }[] } | null>(null);
const previewBusy = ref(false);
/** 命中明细 → 摘要串：与后端 outbound.cjs 的 formatHits 同口径（label×count，用 " · " 连接） */
function formatPreviewHits(hits: { label: string; count: number }[]): string {
  return hits.map((h) => (h.count > 1 ? `${h.label}×${h.count}` : h.label)).join(" · ");
}
async function runPreview() {
  if (previewBusy.value) return;
  previewBusy.value = true;
  try {
    const r = await api.localgwOutboundPreview(previewChannel.value, previewText.value);
    const raw = Array.isArray(r?.hits) ? r.hits : [];
    previewOut.value = {
      before: String(r?.before ?? ""),
      after: String(r?.after ?? ""),
      hits: raw
        .filter((h) => h && typeof h.label === "string")
        .map((h) => ({ label: h.label, count: Number(h.count) || 0 })),
    };
  } catch (e) {
    previewOut.value = null;
    ElMessage.error(e instanceof Error && e.message ? e.message : "试跑失败");
  } finally {
    previewBusy.value = false;
  }
}

// ---- 档案 ----
const builtinProfiles = computed(() => outboundProfiles.value.filter((p) => p.builtin));
const customProfileIds = computed(() => Object.keys(outbound.profiles.custom));
const newProfileId = ref("");
function saveProfile(id: string) {
  const p = outbound.profiles.custom[id];
  if (!p) return;
  void patchOutbound({ profiles: { custom: { [id]: deepClone(p) } } }, "自定义档案");
}
/** headers 文本 <-> 对象：每行 `Key: Value`；无冒号的行忽略（不猜用户意图） */
function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(":");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    if (k) out[k] = t.slice(i + 1).trim();
  }
  return out;
}
function stringifyHeaderLines(h: unknown): string {
  if (!isPlain(h)) return "";
  return Object.entries(h as Record<string, string>)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}
function saveProfileHeaders(id: string, text: string) {
  const p = outbound.profiles.custom[id];
  if (!p) return;
  const next = parseHeaderLines(text);
  // 文本域是这一项的权威来源：原来有、现在没有的键就是用户删掉的行，
  // 必须显式发 null 才会从后端消失（契约 §4.5.1 v1.4 第 4 处：
  // profiles.custom[id].headers[key] = null）。深合并本身删不掉键。
  // 注意这里**不能**走 saveProfile(id)（它发的是不含 null 的完整档案），否则删行是无声空操作。
  const removed: Record<string, null> = {};
  for (const k of Object.keys(p.headers)) if (!(k in next)) removed[k] = null;
  p.headers = next;
  void patchOutbound(
    { profiles: { custom: { [id]: { headers: { ...next, ...removed } } } } },
    "档案请求头覆盖"
  );
}
function saveProfileRemoveHeaders(id: string, text: string) {
  const p = outbound.profiles.custom[id];
  if (!p) return;
  p.removeHeaders = String(text || "")
    .split(/[\n,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  saveProfile(id);
}
function addCustomProfile() {
  const id = newProfileId.value.trim();
  if (!id) {
    ElMessage.warning("先填一个档案 id（渠道策略里按 id 引用它）");
    return;
  }
  if (outbound.profiles.custom[id]) {
    ElMessage.warning(`自定义档案 ${id} 已存在`);
    return;
  }
  if (outboundProfiles.value.some((p) => p.id === id)) {
    ElMessage.warning(`${id} 与内置档案重名，换一个（内置档案只读，不可覆盖）`);
    return;
  }
  newProfileId.value = "";
  outbound.profiles.custom[id] = { label: id, userAgent: "", headers: {}, removeHeaders: [], note: "" };
  saveProfile(id);
}
async function removeCustomProfile(id: string) {
  try {
    await ElMessageBox.confirm(
      `删除自定义档案「${id}」？引用它的渠道会退回「用渠道自带形态」。`,
      "删除档案",
      { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" }
    );
  } catch {
    return;
  }
  // null = 删除该键（契约 §4.5.1）
  const ok = await patchOutbound({ profiles: { custom: { [id]: null } } }, "删除档案");
  if (!ok) return;
  if (openChannel.value && chanProfile(openChannel.value) === id) {
    // 渠道还引用着刚删掉的档案：显式改回「不额外套档案」，别留一个悬空 id
    for (const c of outboundChannels.value) {
      if (chanProfile(c.id) === id) setChannelProfile(c.id, "");
    }
  }
}
</script>

<template>
  <div class="cfg-sec lgw-scope">
    <!-- 二级页签：全站标准 .cfg-subtabs / .cfg-subtab（定义 src/styles/global.css:1496-1537，
         范例 src/components/config/ConfigTimingSection.vue:164-170）。
         原先用 el-button 拼的 5 个按钮与其它配置页的页签观感不一致，这里换成同一套。
         间距由 localgw.css 的 .lgw-subtabs 提供（本组件没有 <style> 块，样式统一放模块样式表）。 -->
    <div class="cfg-subtabs lgw-subtabs">
      <button class="cfg-subtab" :class="{ active: tab === 'net' }" @click="tab = 'net'">
        <i class="ph ph-shield-check"></i>监听与安全
      </button>
      <button class="cfg-subtab" :class="{ active: tab === 'perf' }" @click="tab = 'perf'">
        <i class="ph ph-sliders"></i>性能与限流
      </button>
      <button class="cfg-subtab" :class="{ active: tab === 'bind' }" @click="tab = 'bind'">
        <i class="ph ph-link"></i>模块联动
      </button>
      <button class="cfg-subtab" :class="{ active: tab === 'extend' }" @click="tab = 'extend'">
        <i class="ph ph-puzzle-piece"></i>扩展点
      </button>
      <button class="cfg-subtab" :class="{ active: tab === 'outbound' }" @click="tab = 'outbound'">
        <i class="ph ph-fingerprint"></i>出站伪装
      </button>
    </div>

    <div v-if="!backendReady" class="lgw-backend-off" style="margin-bottom:14px">
      <i class="ph ph-warning-circle lgw-backend-off-icon"></i>
      <div class="lgw-backend-off-title">后端通道未接入，本页改动无法保存</div>
      <div class="lgw-backend-off-desc">
        前端已按默认值渲染好（方案 §7），主进程接上 localgw/index.cjs 的 IPC 注册后即可生效。当前展示的是推荐默认配置。
      </div>
    </div>

    <!-- ===== 监听与安全 ===== -->
    <div v-show="tab === 'net'" style="display:flex;flex-direction:column;gap:12px">
      <div class="lgw-section">
        <div class="lgw-section-title">监听地址</div>
        <div class="lgw-field">
          <span class="lgw-field-label">绑定</span>
          <el-select :model-value="form.bind" size="small" style="width:200px" @change="setBind">
            <el-option label="127.0.0.1（仅本机，推荐）" value="127.0.0.1" />
            <el-option label="::1（IPv6 回环）" value="::1" />
            <el-option label="0.0.0.0（局域网/公网可访问）" value="0.0.0.0" />
          </el-select>
        </div>
        <div v-if="form.bind === '0.0.0.0'" class="lgw-kpi-sub" style="color:var(--warn)">
          当前绑定对外开放：任何能访问本机网络的人都能调用该网关。请确保已设置强 API Key。
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">端口</span>
          <el-input-number
            :model-value="form.port"
            :min="1024"
            :max="65535"
            size="small"
            @change="(v: any) => setPort(Number(v))"
          />
          <span class="lgw-kpi-sub">被占用时自动尝试：{{ portCandidatesText }}</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">候选端口</span>
          <el-input
            v-model="portCandidatesText"
            size="small"
            placeholder="9527, 9528, 9529, 9530"
            @blur="patch({ portCandidates: form.portCandidates })"
          />
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">开机自启</span>
          <el-switch
            :model-value="form.autostart"
            size="small"
            @change="(v: any) => { form.autostart = v; patch({ autostart: v }); }"
          />
          <span class="lgw-kpi-sub">应用启动时自动开始监听（默认关）</span>
        </div>
      </div>

      <div class="lgw-section">
        <div class="lgw-section-title">安全</div>
        <div class="lgw-field">
          <span class="lgw-field-label">密钥哈希落库</span>
          <el-switch
            :model-value="form.security.encryptKeysAtRest"
            size="small"
            disabled
          />
          <span class="lgw-kpi-sub">固定开启：API Key 只存 HMAC-SHA256 + 前缀，列表永不回显明文</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">内部签名密钥</span>
          <el-button size="small" @click="rotateSecret">轮转</el-button>
          <span class="lgw-kpi-sub">留空时首次启动自动生成；轮转会使旧访问凭据失效</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">请求体上限</span>
          <el-input-number :model-value="form.bodyLimitMb" :min="1" :max="64" size="small" @change="(v: any) => patch({ bodyLimitMb: Number(v) })" />
          <span class="lgw-kpi-sub">MB（超限直接 413，避免大 payload 撑爆主进程）</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">请求超时</span>
          <el-input-number :model-value="Math.round(form.requestTimeoutMs / 1000)" :min="10" :max="1800" size="small" @change="(v: any) => patch({ requestTimeoutMs: Number(v) * 1000 })" />
          <span class="lgw-kpi-sub">秒（长上下文推理建议 ≥120）</span>
        </div>
      </div>

      <div class="lgw-section">
        <div class="lgw-section-title">跨域（CORS）</div>
        <div class="lgw-field" style="align-items:flex-start">
          <span class="lgw-field-label" style="padding-top:4px">允许来源</span>
          <el-input
            :model-value="(form.corsOrigins || []).join('\n')"
            type="textarea"
            :rows="3"
            size="small"
            placeholder="http://localhost:5174"
            @blur="(e: FocusEvent) => patch({ corsOrigins: String((e.target as HTMLTextAreaElement).value).split('\n').map((s) => s.trim()).filter(Boolean) })"
          />
        </div>
        <div class="lgw-kpi-sub">
          仅在从浏览器页面直连网关时需要；IDE 与 curl 不受 CORS 限制。默认只放行本地 dev 与 tauri webview。
        </div>
      </div>
    </div>

    <!-- ===== 性能与限流 ===== -->
    <div v-show="tab === 'perf'" style="display:flex;flex-direction:column;gap:12px">
      <div class="lgw-section">
        <div class="lgw-section-title">并发与限流</div>
        <div class="lgw-field">
          <span class="lgw-field-label">全局并发</span>
          <el-input-number :model-value="form.concurrency" :min="1" :max="64" size="small" @change="(v: any) => patch({ concurrency: Number(v) })" />
          <span class="lgw-kpi-sub">同刻最大在途请求；与号池共用主进程 event loop，建议 ≤16</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">全局限流</span>
          <el-input-number :model-value="form.rateLimitPerMin" :min="1" :max="100000" size="small" @change="(v: any) => patch({ rateLimitPerMin: Number(v) })" />
          <span class="lgw-kpi-sub">req/min（所有密钥合计）</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">单 Key 限流</span>
          <el-input-number :model-value="form.apiKeyRatePerMin" :min="1" :max="100000" size="small" @change="(v: any) => patch({ apiKeyRatePerMin: Number(v) })" />
          <span class="lgw-kpi-sub">req/min（新建 Key 的默认值，单个 Key 可另行覆盖）</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">排队上限</span>
          <el-input-number :model-value="Math.round(form.queueTimeoutMs / 1000)" :min="1" :max="300" size="small" @change="(v: any) => patch({ queueTimeoutMs: Number(v) * 1000 })" />
          <span class="lgw-kpi-sub">秒（超并发的请求最多排队这么久，超时返回 429）</span>
        </div>
      </div>

      <div class="lgw-section">
        <div class="lgw-section-title">出站行为</div>
        <div class="lgw-field">
          <span class="lgw-field-label">指纹脱敏</span>
          <el-switch :model-value="form.fingerprintObfuscation" size="small" @change="(v: any) => { form.fingerprintObfuscation = v; patch({ fingerprintObfuscation: v }); }" />
          <span class="lgw-kpi-sub">转发前剥离上游内容审核的逐字指纹（默认开）</span>
        </div>
        <div class="lgw-kpi-sub" style="line-height:1.9">
          · 上游按<b>逐字精确匹配</b>审核（不是语义审核）：客户端注入的固定模板句、计费头字段名、
          以及裸错误码 <code>11128</code> 出现在报文里就会整单拦截（400）<br />
          · 处理方式：表头键值整段删除、<code>cc_*</code> 键值整段删除、
          模板句只换一个词（如 official CLI for Claude → official CLI tool for Claude）、
          <code>11128</code> 改写为 <code>11-128</code> —— 对话内容与语义都不变<br />
          · 只改<b>发给上游的副本</b>，客户端看到的响应内容不变；命中的请求会在「请求日志」的
          <b>敏</b> 列打标，悬停可看命中了哪几条规则<br />
          · 关掉后客户端模板会原样发往上游，可能重新出现模板句被误拦的 400
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">拟人抖动</span>
          <el-switch :model-value="form.humanizeJitter" size="small" @change="(v: any) => { form.humanizeJitter = v; patch({ humanizeJitter: v }); }" />
          <span class="lgw-kpi-sub">每次上游请求前随机停 40~220ms（默认开）</span>
        </div>
      </div>

      <div class="lgw-section">
        <div class="lgw-section-title">数据保留</div>
        <div class="lgw-field">
          <span class="lgw-field-label">请求流水</span>
          <el-input-number :model-value="form.logRetentionDays" :min="1" :max="3650" size="small" @change="(v: any) => patch({ logRetentionDays: Number(v) })" />
          <span class="lgw-kpi-sub">天（超期在启动时 GC）</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">用量记录</span>
          <el-input-number :model-value="form.usageRetentionDays" :min="1" :max="3650" size="small" @change="(v: any) => patch({ usageRetentionDays: Number(v) })" />
          <span class="lgw-kpi-sub">天（写入用量统计模块的明细保留期）</span>
        </div>
      </div>
    </div>

    <!-- ===== 模块联动 ===== -->
    <div v-show="tab === 'bind'" style="display:flex;flex-direction:column;gap:12px">
      <div class="lgw-section">
        <div class="lgw-section-title">提示词注入</div>
        <div class="lgw-field">
          <span class="lgw-field-label">注入提示词</span>
          <el-switch :model-value="form.injectPrompt" size="small" @change="(v: any) => { form.injectPrompt = v; patch({ injectPrompt: v }); }" />
          <span class="lgw-kpi-sub">开启后，命中下面这条提示词的请求会把它的正文前置进 system 消息（默认关）</span>
        </div>
        <div v-if="form.injectPrompt" class="lgw-field">
          <span class="lgw-field-label">提示词名</span>
          <el-input v-model="form.injectPromptName" size="small" placeholder="填个人提示词库里的条目名（必须精确匹配）" @blur="patch({ injectPromptName: form.injectPromptName })" />
        </div>
        <div v-if="form.injectPrompt" class="lgw-kpi-sub" style="line-height:1.9">
          · 名字<b>留空 = 不注入</b>：本仓库没有「active 提示词」这个概念，不做"按 model/channel 自动匹配"的猜测——那等于替你选提示词<br />
          · 名字填错 / 条目正文为空 / 提示词库不可用 → 原样转发，注入失败绝不影响请求
        </div>
      </div>

      <div class="lgw-section">
        <div class="lgw-section-title">记忆中枢</div>
        <!-- 本期未接线：不展示开关，只如实说明。理由见 electron/backend/localgw/server.cjs
             的 maybeWriteToMemory 注释（记忆库是用户资产，逐请求写入的语义与内容策略尚无定论）。 -->
        <div class="lgw-kpi-sub" style="line-height:1.9">
          · <b>对话写入记忆：本期未接线</b>（开关与配置字段已预留，不会静默生效）<br />
          · 原因：记忆库是用户资产（参与 WebDAV 同步、全文索引与画像蒸馏），
          把网关这个高频转发面的每一次请求都写进去，会把记忆库变成请求流水账，且不可逆
        </div>
      </div>

      <div class="lgw-section">
        <div class="lgw-section-title">与号池的联动</div>
        <div class="lgw-kpi-sub" style="line-height:1.9">
          · 账号与凭证：<b>只读</b>复用号池（不建第二套账号模型）<br />
          · 号池停用某账号 → 网关侧立即熔断，不再选到它<br />
          · 号池模块整体停用 → 本地网关无法启动（没有凭证来源）<br />
          · 渠道启闭：本模块的「路由与渠道」只影响网关可见集合，不改号池自身配置
        </div>
      </div>
    </div>

    <!-- ===== 扩展点 ===== -->
    <div v-show="tab === 'extend'" style="display:flex;flex-direction:column;gap:12px">
      <div class="lgw-section">
        <div class="lgw-section-title">第三方 Provider（预留）</div>
        <div class="lgw-field">
          <span class="lgw-field-label">启用</span>
          <el-switch :model-value="form.providers.enabled" size="small" @change="(v: any) => { form.providers.enabled = v; patch({ providers: { ...form.providers, enabled: v } }); }" />
        </div>
        <div class="lgw-kpi-sub">{{ providersHint }}</div>
        <div class="lgw-field">
          <span class="lgw-field-label">扫描目录</span>
          <el-input v-model="form.providers.dir" size="small" placeholder="留空 = <dataDir>/providers" @blur="patch({ providers: { ...form.providers, dir: form.providers.dir } })" />
        </div>
        <div class="lgw-kpi-sub" style="line-height:1.9;color:var(--warn)">
          本期不打包任何第三方 exe（方案决策 2）：无源码、不可审计，出 Bug 无法修。
          未来如需接入：把 provider 包放到扫描目录 → 通过 doctor 校验签名与版本 → 在 allowlist 里显式放行。
        </div>
      </div>

      <div class="lgw-section">
        <div class="lgw-section-title">关于本模块</div>
        <div class="lgw-kpi-sub" style="line-height:1.9">
          · 模块 key：<code style="font-family:var(--font-mono)">localgw</code>（可启停：停用后网关监听关闭，重新启用即恢复）<br />
          · 转发链路：单进程内嵌（不另起子进程），与本项目其余模块同款 IPC 直连<br />
          · 协议：OpenAI + Anthropic 双协议，不支持 Gemini
        </div>
      </div>
    </div>

    <!-- ===== 出站伪装与清洗（契约 §5.3：4 个折叠区块）=====
         数据只来自 localgw_outbound_get；通道未接入时整块降级成占位，不白屏、不抛未捕获异常 -->
    <div v-show="tab === 'outbound'" style="display:flex;flex-direction:column;gap:12px">
      <!-- 顶部说明（契约 §5.3 v1.5）：自定义供应商「无需请求头覆盖」，但**不是**「默认透传」——
           后端没有按 kind 自动切默认值的规则（policyFor 只读 defaults / perChannel），
           这里不能写成「默认透传」，否则与真机行为不符。 -->
      <div class="lgw-warn-block">
        <i class="ph ph-info"></i>
        <div>
          <b>自定义供应商（<code>kind==="custom"</code>）没有官方客户端指纹可套</b>（<code>x-app</code> /
          <code>anthropic-beta</code> 那套对它本就不存在），所以<b>无需请求头覆盖</b>；
          但它仍会过全局的清洗与拟人抖动。要连头带 body 一律不动，把该渠道显式改成「全透传」
          —— 下面带 <b>自定义供应商</b> 标记的渠道，行内有一键「设为全透传」。
        </div>
      </div>

      <div v-if="!outboundReady" class="lgw-backend-off">
        <i class="ph ph-link-break lgw-backend-off-icon"></i>
        <div class="lgw-backend-off-title">后端通道未接入</div>
        <div class="lgw-backend-off-desc">
          「出站伪装与清洗」需要主进程的 localgw_outbound_get / localgw_outbound_set / localgw_outbound_preview
          三条通道（契约 §4.8）。下面展示的是按契约 §2 渲染的默认形状，<b>改动无法保存</b>。
        </div>
        <div v-if="outboundErr" class="lgw-kpi-sub" style="max-width:460px;overflow-wrap:anywhere">原始报错：{{ outboundErr }}</div>
        <el-button size="small" :loading="outboundLoading" @click="loadOutbound">重新读取</el-button>
      </div>

      <!-- ===== 区块 1：全局默认 ===== -->
      <div class="lgw-section">
        <div class="lgw-section-title">全局默认策略</div>
        <div class="lgw-kpi-sub" style="line-height:1.9">
          · 没单独配置过的渠道都继承这一份；「按渠道策略」里改过的字段以渠道那份为准<br />
          · <b>伪装</b> = 下面各项逐条生效；<b>全透传</b> = 短路一切（请求头 + body 都不动、不加抖动）<br />
          · {{ legacyHint }}
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">模式</span>
          <el-radio-group
            :model-value="outbound.defaults.mode"
            size="small"
            :disabled="!outboundReady || outboundSaving"
            @change="(v: any) => setDefaultMode(String(v))"
          >
            <el-radio-button value="mimic">伪装</el-radio-button>
            <el-radio-button value="passthrough">全透传</el-radio-button>
          </el-radio-group>
          <span class="lgw-kpi-sub">{{ modeHint(outbound.defaults.mode) }}</span>
        </div>
        <div class="lgw-field">
          <span class="lgw-field-label">模拟档案</span>
          <el-select
            :model-value="outbound.defaults.profile"
            size="small"
            style="width:260px"
            :disabled="!outboundReady || outboundSaving || outbound.defaults.mode === 'passthrough'"
            @change="setDefaultProfile"
          >
            <el-option label="不额外套档案（用渠道自带形态）" value="" />
            <el-option
              v-for="p in outboundProfiles"
              :key="p.id"
              :label="p.builtin ? `${p.label}（内置）` : `${p.label}（自定义）`"
              :value="p.id"
            />
          </el-select>
          <span class="lgw-kpi-sub">档案 = 请求形态（UA + 特征头），merge 应用，鉴权头一定保留</span>
        </div>
        <div v-for="s in POLICY_FLAGS" :key="s.key" class="lgw-field">
          <span class="lgw-field-label">{{ s.label }}</span>
          <el-switch
            :model-value="outbound.defaults[s.key]"
            size="small"
            :disabled="!outboundReady || outboundSaving || outbound.defaults.mode === 'passthrough'"
            @change="(v: any) => setDefaultFlag(s.key, !!v)"
          />
          <span class="lgw-kpi-sub">{{ s.hint }}</span>
        </div>
      </div>

      <!-- ===== 区块 2：按渠道策略 ===== -->
      <div class="lgw-section">
        <div class="lgw-section-title">按渠道策略</div>
        <div class="lgw-kpi-sub" style="line-height:1.9">
          · 每行显示的是<b>合并后的生效结果</b>（后端 describePolicy 算的）；展开可改该渠道的覆盖项，改完即存<br />
          · 没改过的渠道<b>完全继承</b>全局默认；「恢复继承默认」会把该渠道的覆盖整条删掉（补丁里发 null）
        </div>
        <div v-if="!outboundChannels.length" class="lgw-kpi-sub" style="padding:10px 0">
          还没有渠道清单：需要后端 localgw_outbound_get 返回 channels（号池里得先有渠道与账号）。
        </div>
        <div v-for="c in outboundChannels" :key="c.id" style="display:flex;flex-direction:column;gap:8px">
          <div class="lgw-channel-row" style="cursor:pointer" @click="toggleChannelRow(c.id)">
            <i class="ph ph-caret-right lgw-caret" :class="{ 'is-open': openChannel === c.id }"></i>
            <div class="lgw-channel-icon"><i class="ph ph-plugs-connected"></i></div>
            <div style="flex:1;min-width:0">
              <div class="lgw-channel-name">
                {{ c.display }}
                <span v-if="c.kind === 'custom'" class="lgw-tag warn">自定义供应商 · 无官方指纹可套</span>
              </div>
              <div class="lgw-channel-meta">
                {{ modeLabel(c.policy.mode) }} · 档案 {{ c.policy.profileLabel || '渠道自带' }} ·
                {{ (c.policy.parts || []).join(' · ') || '无附加动作' }}
              </div>
            </div>
            <!-- 自定义供应商是最可能需要「全透传」的一类渠道：把「无需头覆盖」变成一键可达，
                 而不是后端按 kind 隐式切默认值（显式优于隐式，见契约 §5.3 v1.5） -->
            <el-button
              v-if="c.kind === 'custom' && chanMode(c.id) !== 'passthrough'"
              size="small"
              :disabled="!outboundReady || outboundSaving"
              @click.stop="setChannelMode(c.id, 'passthrough')"
            >设为全透传</el-button>
            <span v-else-if="c.kind === 'custom'" class="lgw-tag warn">已全透传</span>
            <span class="lgw-kpi-sub">{{ c.accountCount }} 账号</span>
          </div>

          <div
            v-if="openChannel === c.id"
            style="display:flex;flex-direction:column;gap:10px;padding:2px 0 6px 26px"
          >
            <div class="lgw-field">
              <span class="lgw-field-label">模式</span>
              <el-radio-group
                :model-value="chanMode(c.id)"
                size="small"
                :disabled="!outboundReady || outboundSaving"
                @change="(v: any) => setChannelMode(c.id, String(v))"
              >
                <el-radio-button value="mimic">伪装</el-radio-button>
                <el-radio-button value="passthrough">透传</el-radio-button>
              </el-radio-group>
              <span class="lgw-kpi-sub">{{ chanOverridden(c.id, 'mode') ? '已覆盖' : '继承全局默认' }}</span>
            </div>
            <div class="lgw-field">
              <span class="lgw-field-label">模拟档案</span>
              <el-select
                :model-value="chanProfile(c.id)"
                size="small"
                style="width:260px"
                :disabled="!outboundReady || outboundSaving"
                @change="(v: string) => setChannelProfile(c.id, v)"
              >
                <el-option label="不额外套档案（用渠道自带形态）" value="" />
                <el-option
                  v-for="p in outboundProfiles"
                  :key="p.id"
                  :label="p.builtin ? `${p.label}（内置）` : `${p.label}（自定义）`"
                  :value="p.id"
                />
              </el-select>
              <span class="lgw-kpi-sub">
                {{ chanOverridden(c.id, 'profile') ? '已覆盖' : `继承全局默认（${profileLabelOf(outbound.defaults.profile)}）` }}
              </span>
            </div>

            <div class="lgw-kpi-sub" style="font-weight:600;color:var(--text-2)">请求头覆盖（merge 应用：同名覆盖，其余头保留）</div>
            <div v-for="(r, i) in chanDraft.headers" :key="`${c.id}-h-${i}`" class="lgw-field">
              <el-input v-model="r.k" size="small" placeholder="Header-Name" style="width:220px" :disabled="!outboundReady || outboundSaving" @blur="saveChannelHeaders()" />
              <el-input v-model="r.v" size="small" placeholder="值" style="width:280px" :disabled="!outboundReady || outboundSaving" @blur="saveChannelHeaders()" />
              <el-button size="small" text type="danger" :disabled="!outboundReady || outboundSaving" @click="removeHeaderRow(i)">删除</el-button>
            </div>
            <div class="lgw-field">
              <el-button size="small" :disabled="!outboundReady || outboundSaving" @click="addHeaderRow"><i class="ph ph-plus"></i>添加覆盖头</el-button>
              <span class="lgw-kpi-sub">键名大小写不敏感匹配，写回时保留你填的键名；删行 = 补丁里发 null</span>
            </div>

            <div class="lgw-field" style="align-items:flex-start">
              <span class="lgw-field-label" style="padding-top:4px">移除头</span>
              <el-input
                v-model="chanDraft.removeHeaders"
                type="textarea"
                :rows="2"
                size="small"
                style="width:440px"
                placeholder="一行一个头名，如 x-anthropic-billing-header"
                :disabled="!outboundReady || outboundSaving"
                @blur="saveChannelRemoveHeaders"
              />
            </div>
            <div class="lgw-kpi-sub">大小写不敏感；数组整体替换，清空即全部保留</div>

            <!-- 渠道内联规则（与全局库叠加，先全局后内联） -->
            <div class="lgw-kpi-sub" style="font-weight:600;color:var(--text-2)">内联关键词（{{ chanKeywords(c.id).length }}）</div>
            <div
              v-for="(r, i) in chanKeywords(c.id)"
              :key="r.id"
              style="display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-3)"
            >
              <div class="lgw-field">
                <el-switch v-model="r.enabled" size="small" :disabled="!outboundReady || outboundSaving" @change="commitChannelKeywords(c.id)" />
                <el-input v-model="r.label" size="small" placeholder="展示名" style="width:160px" :disabled="!outboundReady || outboundSaving" @blur="commitChannelKeywords(c.id)" />
                <el-select v-model="r.mode" size="small" style="width:100px" :disabled="!outboundReady || outboundSaving" @change="commitChannelKeywords(c.id)">
                  <el-option label="逐字" value="literal" />
                  <el-option label="正则" value="regex" />
                </el-select>
                <el-select v-model="r.scope" size="small" style="width:120px" :disabled="!outboundReady || outboundSaving" @change="commitChannelKeywords(c.id)">
                  <el-option v-for="s in SCOPES" :key="s.value" :label="s.label" :value="s.value" />
                </el-select>
                <el-button size="small" text type="danger" :disabled="!outboundReady || outboundSaving" @click="delKeyword(chanKeywords(c.id), (v: LocalgwKeywordRule[]) => saveChannelKeywords(c.id, v), i)">删除</el-button>
              </div>
              <div class="lgw-field">
                <el-input v-model="r.pattern" size="small" placeholder="匹配内容" style="flex:1;min-width:170px" :disabled="!outboundReady || outboundSaving" @blur="commitChannelKeywords(c.id)" />
                <el-input v-model="r.replace" size="small" placeholder="替换为" style="flex:1;min-width:170px" :disabled="!outboundReady || outboundSaving" @blur="commitChannelKeywords(c.id)" />
                <el-input v-if="r.mode === 'regex'" v-model="r.flags" size="small" placeholder="flags" style="width:80px" :disabled="!outboundReady || outboundSaving" @blur="commitChannelKeywords(c.id)" />
              </div>
            </div>
            <div class="lgw-field">
              <el-button size="small" :disabled="!outboundReady || outboundSaving" @click="addKeyword(chanKeywords(c.id), (v: LocalgwKeywordRule[]) => saveChannelKeywords(c.id, v))"><i class="ph ph-plus"></i>添加内联关键词</el-button>
            </div>

            <div class="lgw-kpi-sub" style="font-weight:600;color:var(--text-2)">内联文案替换（{{ chanRewrites(c.id).length }}）</div>
            <div
              v-for="(r, i) in chanRewrites(c.id)"
              :key="r.id"
              style="display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-3)"
            >
              <div class="lgw-field">
                <el-switch v-model="r.enabled" size="small" :disabled="!outboundReady || outboundSaving" @change="commitChannelRewrites(c.id)" />
                <el-input v-model="r.label" size="small" placeholder="展示名" style="width:160px" :disabled="!outboundReady || outboundSaving" @blur="commitChannelRewrites(c.id)" />
                <el-select v-model="r.scope" size="small" style="width:120px" :disabled="!outboundReady || outboundSaving" @change="commitChannelRewrites(c.id)">
                  <el-option v-for="s in SCOPES" :key="s.value" :label="s.label" :value="s.value" />
                </el-select>
                <el-button size="small" text type="danger" :disabled="!outboundReady || outboundSaving" @click="delRewrite(chanRewrites(c.id), (v: LocalgwRewriteRule[]) => saveChannelRewrites(c.id, v), i)">删除</el-button>
              </div>
              <div class="lgw-field">
                <el-input v-model="r.from" size="small" placeholder="原文（整句）" style="flex:1;min-width:170px" :disabled="!outboundReady || outboundSaving" @blur="commitChannelRewrites(c.id)" />
                <el-input v-model="r.to" size="small" placeholder="替换为" style="flex:1;min-width:170px" :disabled="!outboundReady || outboundSaving" @blur="commitChannelRewrites(c.id)" />
              </div>
            </div>
            <div class="lgw-field">
              <el-button size="small" :disabled="!outboundReady || outboundSaving" @click="addRewrite(chanRewrites(c.id), (v: LocalgwRewriteRule[]) => saveChannelRewrites(c.id, v))"><i class="ph ph-plus"></i>添加内联替换</el-button>
            </div>

            <div class="lgw-field">
              <el-button size="small" :disabled="!outboundReady || outboundSaving" @click="resetChannelPolicy(c.id)">恢复继承默认</el-button>
              <span class="lgw-kpi-sub">清除该渠道的全部覆盖（模式/档案/头/内联规则），回到跟随全局默认</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== 区块 3：共享规则库 ===== -->
      <div class="lgw-section">
        <div class="lgw-section-title">共享规则库（全局，所有渠道叠加使用）</div>
        <div class="lgw-kpi-sub" style="line-height:1.9">
          · 执行顺序：<b>先文案替换，后关键词清洗</b>（与 sanitize.cjs「先改写层、后剥离层」一致，
          避免剥离把待改写句子切碎导致改写失效）<br />
          · 只改<b>发给上游的副本</b>，客户端看到的响应不变；命中会在「请求日志」的 <b>敏</b> 列打标
        </div>

        <div class="lgw-kpi-sub" style="font-weight:600;color:var(--text-2)">关键词清洗（{{ outbound.keywords.length }}）</div>
        <div v-if="!outbound.keywords.length" class="lgw-kpi-sub">还没有关键词规则。</div>
        <div
          v-for="(r, i) in outbound.keywords"
          :key="r.id"
          style="display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-3)"
        >
          <div class="lgw-field">
            <el-switch v-model="r.enabled" size="small" :disabled="!outboundReady || outboundSaving" @change="commitGlobalKeywords" />
            <el-input v-model="r.label" size="small" placeholder="展示名（命中摘要里用它）" style="width:180px" :disabled="!outboundReady || outboundSaving" @blur="commitGlobalKeywords" />
            <el-select v-model="r.mode" size="small" style="width:104px" :disabled="!outboundReady || outboundSaving" @change="commitGlobalKeywords">
              <el-option label="逐字" value="literal" />
              <el-option label="正则" value="regex" />
            </el-select>
            <el-select v-model="r.scope" size="small" style="width:124px" :disabled="!outboundReady || outboundSaving" @change="commitGlobalKeywords">
              <el-option v-for="s in SCOPES" :key="s.value" :label="s.label" :value="s.value" />
            </el-select>
            <el-button size="small" text type="danger" :disabled="!outboundReady || outboundSaving" @click="delKeyword(outbound.keywords, saveGlobalKeywords, i)">删除</el-button>
          </div>
          <div class="lgw-field">
            <el-input v-model="r.pattern" size="small" placeholder="匹配内容（literal 逐字；regex 编译为正则）" style="flex:1;min-width:180px" :disabled="!outboundReady || outboundSaving" @blur="commitGlobalKeywords" />
            <el-input v-model="r.replace" size="small" placeholder="替换为（regex 可用 $1，literal 不做 $1 展开）" style="flex:1;min-width:180px" :disabled="!outboundReady || outboundSaving" @blur="commitGlobalKeywords" />
            <el-input v-if="r.mode === 'regex'" v-model="r.flags" size="small" placeholder="flags" style="width:84px" :disabled="!outboundReady || outboundSaving" @blur="commitGlobalKeywords" />
          </div>
        </div>
        <div class="lgw-field">
          <el-button size="small" :disabled="!outboundReady || outboundSaving" @click="addKeyword(outbound.keywords, saveGlobalKeywords)"><i class="ph ph-plus"></i>添加关键词</el-button>
          <span class="lgw-kpi-sub">scope 按消息角色判定；tool = role==="tool" 的消息 + assistant.tool_calls 的参数</span>
        </div>

        <div class="lgw-kpi-sub" style="font-weight:600;color:var(--text-2)">文案替换（{{ outbound.rewrites.length }}）</div>
        <div v-if="!outbound.rewrites.length" class="lgw-kpi-sub">还没有文案替换规则。整句成对编辑，比关键词更适合改「身份句」。</div>
        <div
          v-for="(r, i) in outbound.rewrites"
          :key="r.id"
          style="display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-3)"
        >
          <div class="lgw-field">
            <el-switch v-model="r.enabled" size="small" :disabled="!outboundReady || outboundSaving" @change="commitGlobalRewrites" />
            <el-input v-model="r.label" size="small" placeholder="展示名" style="width:180px" :disabled="!outboundReady || outboundSaving" @blur="commitGlobalRewrites" />
            <el-select v-model="r.scope" size="small" style="width:124px" :disabled="!outboundReady || outboundSaving" @change="commitGlobalRewrites">
              <el-option v-for="s in SCOPES" :key="s.value" :label="s.label" :value="s.value" />
            </el-select>
            <el-button size="small" text type="danger" :disabled="!outboundReady || outboundSaving" @click="delRewrite(outbound.rewrites, saveGlobalRewrites, i)">删除</el-button>
          </div>
          <div class="lgw-field">
            <el-input v-model="r.from" size="small" placeholder="原文（整句）" style="flex:1;min-width:180px" :disabled="!outboundReady || outboundSaving" @blur="commitGlobalRewrites" />
            <el-input v-model="r.to" size="small" placeholder="替换为" style="flex:1;min-width:180px" :disabled="!outboundReady || outboundSaving" @blur="commitGlobalRewrites" />
          </div>
        </div>
        <div class="lgw-field">
          <el-button size="small" :disabled="!outboundReady || outboundSaving" @click="addRewrite(outbound.rewrites, saveGlobalRewrites)"><i class="ph ph-plus"></i>添加文案替换</el-button>
        </div>

        <el-divider style="margin:4px 0" />
        <div class="lgw-kpi-sub" style="font-weight:600;color:var(--text-2)">试跑（本地纯函数清洗，不打上游）</div>
        <div class="lgw-field">
          <span class="lgw-field-label">渠道</span>
          <el-select v-model="previewChannel" size="small" style="width:220px" :disabled="!outboundReady || previewBusy">
            <el-option label="全局默认（渠道无关规则）" value="" />
            <el-option v-for="c in outboundChannels" :key="c.id" :label="c.display" :value="c.id" />
          </el-select>
          <el-button size="small" :loading="previewBusy" :disabled="!outboundReady || !previewText" @click="runPreview">试跑</el-button>
        </div>
        <div class="lgw-field" style="align-items:flex-start">
          <span class="lgw-field-label" style="padding-top:4px">原文</span>
          <el-input v-model="previewText" type="textarea" :rows="2" size="small" style="width:460px" :disabled="!outboundReady || previewBusy" />
        </div>
        <div v-if="previewOut" class="lgw-kpi-sub" style="line-height:1.9;overflow-wrap:anywhere">
          · 命中：{{ previewOut.hits.length ? formatPreviewHits(previewOut.hits) : '无' }}<br />
          · 结果：{{ previewOut.after === previewOut.before ? '与原文相同（没有规则命中）' : previewOut.after }}<br />
          · 试跑会把<b>所有规则</b>叠上去（不按消息角色过滤 scope），看清「最坏情况」；真机转发时才会按 role 过滤
        </div>
      </div>

      <!-- ===== 区块 4：档案 ===== -->
      <div class="lgw-section">
        <div class="lgw-section-title">agent 软件模拟档案</div>
        <div class="lgw-kpi-sub" style="line-height:1.9">
          · 档案只描述<b>请求形态</b>（UA + 特征头），不含任何密钥/凭据<br />
          · 应用方式是 <b>merge</b> 而不是 replace：鉴权头（Authorization / x-api-key）与渠道签名头一定原样保留<br />
          · 内置档案由后端 BUILTIN_PROFILES 提供（能取到号池 rules/headers.json 的渠道优先取那里），<b>只读</b>
        </div>

        <div class="lgw-kpi-sub" style="font-weight:600;color:var(--text-2)">内置档案（{{ builtinProfiles.length }}）</div>
        <div v-if="!builtinProfiles.length" class="lgw-kpi-sub">需要后端通道才能列出内置档案。</div>
        <div v-for="p in builtinProfiles" :key="p.id" class="lgw-key-row">
          <div style="flex:1;min-width:0">
            <div class="lgw-key-name">{{ p.label }} <span class="lgw-key-prefix">{{ p.id }}</span></div>
            <div class="lgw-key-meta">
              UA: {{ p.userAgent || '—' }} · 特征头 {{ Object.keys(p.headers || {}).length }} 个{{ p.note ? ' · ' + p.note : '' }}
            </div>
          </div>
        </div>

        <div class="lgw-kpi-sub" style="font-weight:600;color:var(--text-2);margin-top:6px">自定义档案（{{ customProfileIds.length }}）</div>
        <div class="lgw-field">
          <el-input v-model="newProfileId" size="small" placeholder="新档案 id（渠道策略按这个 id 引用）" style="width:280px" :disabled="!outboundReady || outboundSaving" />
          <el-button size="small" :disabled="!outboundReady || outboundSaving" @click="addCustomProfile"><i class="ph ph-plus"></i>新增档案</el-button>
        </div>
        <div v-if="!customProfileIds.length" class="lgw-kpi-sub">还没有自定义档案。内置档案不够用时，在这里照抄一份再改。</div>
        <div
          v-for="id in customProfileIds"
          :key="id"
          style="display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-3)"
        >
          <div class="lgw-field">
            <span class="lgw-field-label">档案 id</span>
            <span class="lgw-key-prefix">{{ id }}</span>
            <el-button size="small" text type="danger" :disabled="!outboundReady || outboundSaving" @click="removeCustomProfile(id)">删除档案</el-button>
          </div>
          <div class="lgw-field">
            <span class="lgw-field-label">展示名</span>
            <el-input v-model="outbound.profiles.custom[id].label" size="small" style="width:260px" :disabled="!outboundReady || outboundSaving" @blur="saveProfile(id)" />
          </div>
          <div class="lgw-field">
            <span class="lgw-field-label">User-Agent</span>
            <el-input v-model="outbound.profiles.custom[id].userAgent" size="small" style="width:360px" placeholder="如 TraeClient/TTNet" :disabled="!outboundReady || outboundSaving" @blur="saveProfile(id)" />
          </div>
          <div class="lgw-field" style="align-items:flex-start">
            <span class="lgw-field-label" style="padding-top:4px">特征头</span>
            <el-input
              :model-value="stringifyHeaderLines(outbound.profiles.custom[id].headers)"
              type="textarea"
              :rows="3"
              size="small"
              style="width:440px"
              placeholder="一行一个：Header-Name: value"
              :disabled="!outboundReady || outboundSaving"
              @blur="(e: FocusEvent) => saveProfileHeaders(id, (e.target as HTMLTextAreaElement).value)"
            />
          </div>
          <div class="lgw-field" style="align-items:flex-start">
            <span class="lgw-field-label" style="padding-top:4px">移除头</span>
            <el-input
              :model-value="(outbound.profiles.custom[id].removeHeaders || []).join('\n')"
              type="textarea"
              :rows="2"
              size="small"
              style="width:440px"
              placeholder="一行一个头名"
              :disabled="!outboundReady || outboundSaving"
              @blur="(e: FocusEvent) => saveProfileRemoveHeaders(id, (e.target as HTMLTextAreaElement).value)"
            />
          </div>
          <div class="lgw-field">
            <span class="lgw-field-label">备注</span>
            <el-input v-model="outbound.profiles.custom[id].note" size="small" style="width:360px" :disabled="!outboundReady || outboundSaving" @blur="saveProfile(id)" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

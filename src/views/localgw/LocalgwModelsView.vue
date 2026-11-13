<!--
  ============================================================
   作者：沐晖
   日期：2026-10-28
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转載、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 本地网关 · 模型目录：三主 Tab（模型目录 / 别名 / 覆盖与自定义）
     页面形式照搬旧版反代网关的「模型目录」页
     （fdb3e55^:src/views/proxy/ProxyModelsView.vue:371-385 的 .models-main-tabs、
      390-432 的 .models-head 一条线、434-613 的 .table.table-bare + colgroup 定宽表、599-609 的空态），
     数据源换成现在的 localgw_models_list / _set_alias / _set_override / _add_custom。 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useLocalgwStore } from "../../stores/localgw";
import * as localgwApi from "../../api/localgw";
import type { LocalgwModelRow } from "../../api/ipc";
import type { ChannelModelRefreshResult } from "../../api/ipc";
// 渠道名称与图标必须与「上游启闭」弹窗逐项一致：直接复用同一份实现
// （ProxyUpstreamDialog.vue:109-113 用 CHANNEL_ICONS[row.id] / channelInitial(row.id, row.display)，
//  名称用 row.display || channelName(row.id)），本页不再自己拼名字或另存一张图标表
import { channelName, fmtRate } from "../proxy/format";
import { CHANNEL_ICONS, channelInitial } from "../proxy/channelIcons";
import { requireExecutionPlugin, handlePluginError } from "../../composables/usePluginGuard";

const app = useAppStore();
const lgw = useLocalgwStore();

/** 三主 Tab：catalog 模型目录 / alias 别名 / custom 覆盖与自定义 */
const mainTab = ref<"catalog" | "alias" | "custom">("catalog");
/** 保存中标志：避免连点重复提交 */
const saving = ref(false);
const refreshingChannels = ref(false);
const refreshResults = ref<ChannelModelRefreshResult[]>([]);
/** 最近一次成功拉取的时刻（本页会话内）：让用户知道「现在看到的是什么时候的目录」 */
const lastPulledAt = ref(0);

/**
 * 拉取最新模型（force）。
 *
 * 为什么与「打开页面时自动刷新」分开：页面挂载走的是 models.snapshot()，它**不带
 * force** —— 插件返回的是账号登录时缓存的目录，可能是几天前甚至几个月前的清单。
 * 只有这里显式传 force，插件才会真的去上游要一次最新目录。所以按钮文案是「拉取
 * 最新模型」而不是「刷新」：用户点它之前就该知道这会打上游。
 *
 * channels 为空 = 全部渠道；给数组 = 只拉这些渠道（顶部按钮的「仅当前渠道」）。
 */
async function pullLatestModels(channels?: string[]) {
  if (refreshingChannels.value) return;
  const wanted = channels === undefined ? undefined : [...new Set(channels.filter(Boolean))];
  // 没有账号的渠道拉不到 account 目录，只会在结果里刷一片「失败」；先提示去号池
  if (wanted !== undefined && !wanted.length) {
    ElMessage.warning("号池里还没有可用账号，先到「号池管家」添加并上线账号");
    return;
  }
  // 号池渠道的目录只有外置插件能拉：插件没装/没启用时先提示，别让后端回一句 503。
  // 用插件声明的渠道判断，而不是「有账号的渠道」—— 自定义供应商渠道也有账号，
  // 但它由供应商页维护，不该触发「去装插件」的弹窗。
  const pluginChannels = new Set(app.plugins.flatMap((p) => p.channels || []));
  const touchesPool = wanted && wanted.length
    ? wanted.some((id) => pluginChannels.has(id))
    : pluginChannels.size > 0;
  if (touchesPool && !(await requireExecutionPlugin("拉取模型目录"))) return;
  refreshingChannels.value = true;
  refreshResults.value = [];
  try {
    const result = await localgwApi.modelsRefreshChannels(wanted && wanted.length ? wanted : undefined);
    refreshResults.value = result.results;
    // Invalidate in-flight reads as well as successful empty dropdown caches.
    for (const [channel, seq] of modelsSeq) modelsSeq.set(channel, seq + 1);
    channelModels.value = {};
    modelsLoading.value = {};
    await lgw.refreshModels();
    await Promise.all([...new Set([ovChannel.value, cuChannel.value, batchChannel.value].filter(Boolean))].map(loadChannelModels));
    const { refreshed, skipped, failed } = result.summary;
    const message = `模型拉取：更新 ${refreshed} 个渠道，跳过 ${skipped}，失败 ${failed}`;
    if (failed || result.results.some(row => row.partial)) ElMessage.warning(message);
    else if (!refreshed) ElMessage.info(message);
    else ElMessage.success(message);
    if (refreshed > 0) lastPulledAt.value = Date.now();
  } catch (error) {
    // 插件在调用途中被停用/卸载：同样落到「去安装 / 去启用」，不再抛一句看不懂的 503
    if (!handlePluginError(error, "拉取模型目录")) ElMessage.error(error instanceof Error ? error.message : "模型拉取失败");
  } finally {
    refreshingChannels.value = false;
  }
}

/** 有账号的渠道：模型目录只展示这些渠道，拉取也只拉它们 —— 无账号渠道必然
 *  拿不到 account 目录，全量拉取时会把结果面板刷成一片「失败」。
 *  模型行本身就是「该渠道有账号」的产物，渠道列表还没回来时用它兜底。 */
const accountChannelIds = computed(() => {
  const ids = new Set(lgw.channels.map((c) => c.id).filter(Boolean));
  for (const model of lgw.models) if (text(model.channel)) ids.add(text(model.channel));
  return [...ids];
});

/** 顶部主按钮：有选中渠道时只拉该渠道，否则拉全部有账号渠道 */
function pullCurrentScope() {
  return pullLatestModels(channelTab.value ? [channelTab.value] : accountChannelIds.value);
}

/** 「拉取全部渠道」：同样只含有账号渠道 */
function pullAllModels() {
  return pullLatestModels(accountChannelIds.value);
}

/** 结果面板的引导动作：自定义供应商去供应商页，插件问题直接开「设置 · 外置插件」。
 *  ⚠️ 必须先切模块再设页面：selectModule 会把 activePage 重置成模块首页，
 *  反过来调用会被它覆盖回「总览」。 */
function followRefreshHint(row: ChannelModelRefreshResult) {
  if (row.hint === "plugin") { app.openSettings("plugins"); return; }
  if (row.hint !== "provider") return;
  if (app.activeModule !== "localgw") app.selectModule("localgw");
  app.setPage("providers");
}

/** 结果行的一句话：把「跳过」的原因说清楚，而不是只显示 skipped */
function refreshLine(row: ChannelModelRefreshResult): string {
  if (row.status === "refreshed") return `已更新 ${row.count} 个模型${row.partial ? "（部分账号目录失败，已保留可用模型）" : ""}`;
  return row.message;
}

/** 统一取字符串：后端漏字段时不能直接 .toLowerCase()（会整页 TypeError 白屏） */
function text(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** 来源标签文案与配色（旧版用 .tag/.custom-badge 区分来源） */
const SOURCE_META: Record<string, { label: string; cls: string }> = {
  channel: { label: "渠道", cls: "tag-dim" },
  override: { label: "覆盖", cls: "tag-info" },
  alias: { label: "别名", cls: "tag-warn" },
  custom: { label: "自定义", cls: "tag-ok" },
  // v1.82.2「渠道覆盖」的语义：只锁渠道、不改上游模型名
  "channel-lock": { label: "渠道锁", cls: "tag-info" },
  // 模型组：对外名聚合多个渠道模型，每个成员一行
  group: { label: "模型组", cls: "tag-info" },
};
const sourceLabel = (s: string) => SOURCE_META[s]?.label || s || "—";
const sourceCls = (s: string) => SOURCE_META[s]?.cls || "tag-dim";

// ---- Tab 1：模型目录（合并视图，只读） ----
const filter = ref("");
const channelTab = ref("");
const sourceFilter = ref("all");

/** 渠道 id → 号池给的展示名（与「上游启闭」弹窗同源：display 优先，缺失才回落静态名表）。
 *  ⚠️ store 在 display 缺失时会回落成 id（stores/localgw.ts refreshChannels 的 `r.display || r.id`），
 *  这种「假 display」要剔掉，否则本页会显示 id 而弹窗显示 channelName(id)，两边对不上。 */
const channelDisplayById = computed(() => {
  const by = new Map<string, string>();
  for (const c of [...lgw.channels, ...lgw.allChannels]) {
    if (!c || typeof c.id !== "string" || !c.id || by.has(c.id)) continue;
    const d = text(c.display);
    by.set(c.id, d && d !== c.id ? d : "");
  }
  return by;
});

/** 渠道 seg：从当前模型列表里现算，保证只出现真的有模型的渠道；
 *  名称 / 图标与「上游启闭」弹窗一致（有图标用图标，没有就回落名称首字母） */
const tabChannels = computed(() => {
  const ids = new Set<string>();
  for (const channel of [...lgw.channels, ...lgw.allChannels]) if (channel.id) ids.add(channel.id);
  for (const m of lgw.models) {
    const id = text(m.channel);
    if (id) ids.add(id);
  }
  return [...ids].map((id) => {
    const display = channelDisplayById.value.get(id) || "";
    return {
      id,
      display: display || channelName(id),
      icon: CHANNEL_ICONS[id] || "",
      initial: channelInitial(id, display),
    };
  });
});

/** 渠道切换：照搬号池管家（ProxyAgentsView.vue）收起与展开两态 */
const switcherCollapsed = ref(true);
const stripRef = ref<HTMLElement | null>(null);

function modelCountByChannel(channelId: string): number {
  return lgw.models.filter((m) => text(m.channel) === channelId).length;
}

function channelTip(ch: { id: string; display: string }): string {
  const count = modelCountByChannel(ch.id);
  return `${ch.display} · ${count} 个可用模型`;
}

const rows = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return lgw.models.filter((m) => {
    if (channelTab.value && text(m.channel) !== channelTab.value) return false;
    // 「渠道锁」筛选按 lockChannel 算而不是 source：锁失效后行会回落成 channel 来源，
    // 但用户仍然锁着它，按 source 筛会"配了却搜不到"。
    if (sourceFilter.value === "channel-lock") {
      if (!text(m.lockChannel)) return false;
    } else if (sourceFilter.value !== "all" && text(m.source) !== sourceFilter.value) {
      return false;
    }
    if (!q) return true;
    return (
      text(m.display).toLowerCase().includes(q) ||
      text(m.channel).toLowerCase().includes(q) ||
      text(m.realModel).toLowerCase().includes(q)
    );
  });
});

const stats = computed(() => {
  const total = lgw.models.length;
  const overrides = lgw.models.filter((m) => m.source === "override").length;
  const aliases = lgw.models.filter((m) => m.source === "alias").length;
  const customs = lgw.models.filter((m) => m.source === "custom").length;
  // 渠道锁统计按 lockChannel 算（含"锁已失效、已回落自动路由"的行）——
  // 只按 source === "channel-lock" 会漏掉失效锁，用户会以为自己没配过。
  const locks = lgw.models.filter((m) => text(m.lockChannel)).length;
  // 组按配置条数算：目录里每个成员一行，按行数统计会重复计数
  const groups = Object.keys(app.config.localgw?.models?.groups || {}).length;
  return { total, overrides, aliases, customs, locks, groups };
});

// ---- 行内「渠道锁定」：v1.82.2「渠道覆盖」的操作逻辑 ----
// 口径（与旧版 ProxyModelsView 逐条对齐）：
//  · 选项 =「自动（按路由策略）」+ 该模型真实存在的渠道（row.sources）；
//  · 多源才可改，单源禁用（单源强制走所属渠道，锁了也没意义）；
//  · 即改即存，不弹二次确认；
//  · 只锁渠道，**绝不改发给上游的模型名**（改名走第 3 个 Tab 的「改名覆盖」）。
// 两条新版才需要的避让：被改名绑定接管的行不给锁（否则会把上游模型名改错）；
// 别名 / 自定义行自带渠道，也不给锁。
const savingLock = ref(false);

/** 渠道展示名：与「上游启闭」弹窗同源（display 优先，缺省回落静态名表） */
function channelDisplay(channel: string): string {
  return channelDisplayById.value.get(channel) || channelName(channel);
}

/** 下拉当前值：已锁的行显示锁值（即使锁已失效），未锁显示空 = 自动 */
function lockValue(m: LocalgwModelRow): string {
  return text(m.lockChannel) || (m.source === "channel-lock" ? text(m.channel) : "");
}

/** 可选项：来源渠道；锁已失效时把失效渠道补回来，让用户能看见并取消它 */
function lockCandidates(m: LocalgwModelRow): { value: string; label: string; unavailable: boolean }[] {
  const list = (m.sources || []).map((ch) => ({ value: ch, label: channelDisplay(ch), unavailable: false }));
  const lock = text(m.lockChannel);
  if (lock && !list.some((o) => o.value === lock)) {
    list.push({ value: lock, label: `${channelDisplay(lock)}（当前锁定，渠道不可用）`, unavailable: true });
  }
  return list;
}

/** 是否允许行内改锁 */
function canLock(m: LocalgwModelRow): boolean {
  if (savingLock.value) return false;
  if (m.renameLocked || m.groupName) return false;
  if (m.source === "alias" || m.source === "custom") return false;
  // 已有锁一定可操作（至少要能改回「自动」）；未锁时按旧版口径：多源才给锁
  return !!text(m.lockChannel) || (m.sources || []).length > 1;
}

/** 禁用原因（空串 = 可操作）*/
function lockTip(m: LocalgwModelRow): string {
  if (m.groupName) return "该模型属于模型组，请求由组成员按策略接管，不支持行内锁定";
  if (m.renameLocked) return "该模型已被「改名覆盖」接管，渠道由第 3 个 Tab 决定，请到那里修改";
  if (m.source === "alias") return "别名模型自带目标渠道，不支持行内锁定";
  if (m.source === "custom") return "自定义模型自带渠道，不支持行内锁定";
  if (!text(m.lockChannel) && (m.sources || []).length <= 1) return "单源模型强制走所属渠道，无需覆盖";
  if (text(m.lockChannel) && m.source !== "channel-lock") {
    return "锁定的渠道当前不可用（已关闭 / 无账号），请求会回落自动路由；重新选择或改回「自动」即可";
  }
  return "";
}

/** 改锁：选渠道 = 锁定；选「自动」= 清空（后端真删键，不是写 null） */
async function changeLock(m: LocalgwModelRow, channel: string) {
  const name = text(m.display) || text(m.id);
  if (!name || savingLock.value) return;
  const next = text(channel);
  if (next === lockValue(m)) return;
  savingLock.value = true;
  try {
    const r = await localgwApi.modelsSetChannelLock(name, next);
    if (r && r.ok) {
      ElMessage.success(next ? `已锁定走「${channelDisplay(next)}」` : "已恢复自动路由");
      await lgw.refreshModels();
    } else {
      await lgw.refreshModels().catch(() => {});
      ElMessage.error(r?.message || "保存失败");
    }
  } catch (e) {
    // 失败也要重拉：el-select 受控模式下内部可能已切到新值，列表不变会停在错误状态
    await lgw.refreshModels().catch(() => {});
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    savingLock.value = false;
  }
}

/** 有没有生效中的筛选：空态据此决定是否给「清空筛选」（旧版 599-609 行的双分支） */
const hasFilter = computed(() => !!filter.value.trim() || !!channelTab.value || sourceFilter.value !== "all");
function clearFilter() {
  filter.value = "";
  channelTab.value = "";
  sourceFilter.value = "all";
}

const exposeOn = computed(() => app.config.localgw?.models?.exposeInV1Models !== false);

/** 切换「在 /v1/models 中暴露」：只提交这一个键，
 *  后端 config_patch 是深合并，overrides/aliases/custom 不会被本地旧副本覆盖掉 */
async function exposeToggle(v: unknown) {
  if (saving.value) return;
  const on = v === true;
  saving.value = true;
  try {
    const r = await localgwApi.configPatch({ models: { exposeInV1Models: on } });
    if (r && r.ok) {
      // 回填本地配置，开关立刻反映真实状态（否则下一次渲染又会弹回旧值）
      if (app.config.localgw?.models) app.config.localgw.models.exposeInV1Models = on;
      ElMessage.success("已保存");
    } else {
      ElMessage.error("保存失败");
    }
  } catch (e) {
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}

// ---- Tab 2：别名（from → to） ----
/** 别名表从本地配置副本读（写成功后后端会回读，这里以配置为准） */
const aliasList = computed(() => {
  const map = app.config.localgw?.models?.aliases || {};
  return Object.entries(map).map(([from, to]) => ({ from, to: String(to), enabled: !app.config.localgw?.models?.disabledAliases?.includes(from) }));
});
async function toggleAlias(from: string, enabled: boolean) {
  const disabled = new Set(app.config.localgw?.models?.disabledAliases || []);
  if (enabled) disabled.delete(from); else disabled.add(from);
  try {
    await localgwApi.configPatch({ models: { disabledAliases: [...disabled] } });
    await reloadConfig(); await lgw.refreshModels();
  } catch (e) { ElMessage.error(e instanceof Error ? e.message : String(e)); }
}

const aliasFrom = ref("");
const aliasTo = ref("");

async function addAlias() {
  const from = aliasFrom.value.trim();
  const to = aliasTo.value.trim();
  // 旧版就拦了 from===to：自己映射自己没有意义，且会在后端形成自环
  if (!from || !to) {
    ElMessage.warning("请填写「对外名」与「实际模型名」");
    return;
  }
  if (from === to) {
    ElMessage.warning("对外名与实际模型名不能相同");
    return;
  }
  if (aliasList.value.some((a) => a.from === from)) {
    ElMessage.warning(`「${from}」已存在别名`);
    return;
  }
  saving.value = true;
  try {
    const r = await localgwApi.modelsSetAlias(from, to);
    if (r && r.ok) {
      ElMessage.success("已添加");
      aliasFrom.value = "";
      aliasTo.value = "";
      await reloadConfig();
      await lgw.refreshModels();
    } else {
      ElMessage.error("添加失败");
    }
  } catch (e) {
    ElMessage.error(`添加失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}

/** 删除一条模型规则（kind: aliases / overrides / custom）。
 *
 *  为什么必须走专用通道而不是 configPatch：config.cjs 的 mergeDeep 是**加性**合并
 *  （以 base 为骨架、只遍历 incoming 的键），提交"少了某个键"的表不会真删 —— 该键会从
 *  base 存活；传 null 也只会在表里存下一个 null（实测确认）。所以后端单开了
 *  localgw_models_remove_rule，在原始配置层摘键再 normalize 落盘。幂等：已不存在也回 ok。 */
async function removeRule(kind: "aliases" | "overrides" | "custom" | "groups", name: string, label: string) {
  saving.value = true;
  try {
    const r = await localgwApi.modelsRemoveRule(kind, name);
    if (r && r.ok) {
      ElMessage.success(`已移除${label}`);
      await reloadConfig();
      await lgw.refreshModels();
    } else {
      ElMessage.error(r?.message || `移除${label}失败`);
    }
  } catch (e) {
    // unwrapResult 会把 {ok:false} 转成异常抛出，这里统一兜住
    ElMessage.error(`移除${label}失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}

// ---- Tab 3：覆盖与自定义 ----
/** 覆盖：把某个对外名固定指向「某渠道的实际模型」 */
const overrides = computed(() => {
  const map = app.config.localgw?.models?.overrides || {};
  return Object.entries(map).map(([model, v]) => ({ model, realModel: text(v?.real_model), channel: text(v?.channel) }));
});
/** 自定义：新增一个渠道里原本没有的模型名 */
const customs = computed(() => {
  const map = app.config.localgw?.models?.custom || {};
  return Object.entries(map).map(([model, v]) => ({ model, realModel: text(v?.real_model), channel: text(v?.channel) }));
});
const ovModel = ref("");
const ovReal = ref("");
const ovChannel = ref("");
const cuModel = ref("");
const cuReal = ref("");
const cuChannel = ref("");

// ---- 模型消耗倍率（用户手填）：上游目录不一定给（如 Trae），这里按对外名补一个 ----
const rateName = ref("");
const rateValue = ref("");
const rateSaving = ref(false);
const rateList = computed(() =>
  Object.entries(app.config.localgw?.models?.rates || {})
    .map(([model, rate]) => ({ model, rate: Number(rate) }))
    .filter((row) => row.model && Number.isFinite(row.rate))
    .sort((a, b) => a.model.localeCompare(b.model)),
);

async function saveRate() {
  const model = rateName.value.trim();
  const raw = rateValue.value.trim();
  if (!model) { ElMessage.warning("请填写对外模型名"); return; }
  if (!raw) { ElMessage.warning("请填写倍率（0 表示免费档）"); return; }
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1000) { ElMessage.warning("倍率需为 0–1000 的数字"); return; }
  rateSaving.value = true;
  try {
    const r = await localgwApi.modelsSetRate(model, rate);
    if (!r || r.ok === false) { ElMessage.error(r?.message || "保存倍率失败"); return; }
    ElMessage.success(`已保存「${model}」的消耗倍率`);
    rateName.value = "";
    rateValue.value = "";
    await reloadConfig();
    await lgw.refreshModels();
  } catch (e) {
    ElMessage.error(`保存倍率失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rateSaving.value = false;
  }
}

async function clearRate(model: string) {
  rateSaving.value = true;
  try {
    const r = await localgwApi.modelsSetRate(model, null);
    if (!r || r.ok === false) { ElMessage.error(r?.message || "移除倍率失败"); return; }
    await reloadConfig();
    await lgw.refreshModels();
  } catch (e) {
    ElMessage.error(`移除倍率失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rateSaving.value = false;
  }
}

// ---- Tab 3 的「批量添加」：一次把某渠道的多个模型写进覆盖 / 自定义 ----
// 逐条表单在「同一渠道要加十几个模型」时是纯苦力；这里复用「实际模型名」下拉的
// 同一份渠道原生目录（channelModels 缓存），多选后一次落盘（后端 addBatch）。
/** 批量添加的目标表：override = 改名覆盖，custom = 自定义模型 */
const batchKind = ref<"override" | "custom">("override");
const batchChannel = ref("");
const batchKeyword = ref("");
const batchSelected = ref<Set<string>>(new Set());
const batchSaving = ref(false);

/** 候选行：该渠道的原生模型清单；已存在同名规则的标出来，避免用户以为漏了 */
const batchCandidates = computed(() => {
  const ch = batchChannel.value;
  if (!ch) return [];
  const q = batchKeyword.value.trim().toLowerCase();
  const table = batchKind.value === "override"
    ? (app.config.localgw?.models?.overrides || {})
    : (app.config.localgw?.models?.custom || {});
  return (channelModels.value[ch] || [])
    .filter((row) => !q || row.realModel.toLowerCase().includes(q))
    .map((row) => ({
      realModel: row.realModel,
      // 对外名默认沿用渠道目录里的名字（最常见的用法）；用户可以之后单独改
      model: row.id || row.realModel,
      exists: Object.prototype.hasOwnProperty.call(table, row.id || row.realModel),
    }));
});
const batchAllChecked = computed(() => batchCandidates.value.length > 0 && batchCandidates.value.every((r) => batchSelected.value.has(r.realModel)));

function batchToggle(realModel: string) {
  const next = new Set(batchSelected.value);
  if (next.has(realModel)) next.delete(realModel); else next.add(realModel);
  batchSelected.value = next;
}
function batchToggleAll() {
  batchSelected.value = batchAllChecked.value ? new Set() : new Set(batchCandidates.value.map((r) => r.realModel));
}
/** 切渠道 / 切目标表都清空勾选：勾选态是按「渠道 + 表」的组合成立的，
 *  留着会在另一张表里提交一批用户没看过的条目 */
function resetBatchSelection() {
  batchSelected.value = new Set();
  batchKeyword.value = "";
}
watch(batchChannel, (ch) => { resetBatchSelection(); void loadChannelModels(ch); });
watch(batchKind, () => resetBatchSelection());

async function submitBatch() {
  const ch = batchChannel.value;
  const picked = batchCandidates.value.filter((r) => batchSelected.value.has(r.realModel));
  if (!ch || !picked.length) {
    ElMessage.warning("请选择渠道并至少勾选一个模型");
    return;
  }
  batchSaving.value = true;
  try {
    const rows = picked.map((r) => ({ model: r.model, real_model: r.realModel, channel: ch }));
    const r = await localgwApi.modelsBatchAdd(batchKind.value, rows);
    if (r && r.ok) {
      const label = batchKind.value === "override" ? "覆盖" : "自定义";
      const skipped = r.skipped?.length
        ? `，跳过 ${r.skipped.length} 条（${r.skipped[0].message}${r.skipped.length > 1 ? " 等" : ""}）`
        : "";
      ElMessage.success(`已写入 ${r.added} 条${label}${r.replaced ? `（其中 ${r.replaced} 条覆盖了同名旧值）` : ""}${skipped}`);
      batchSelected.value = new Set();
      await reloadConfig();
      await lgw.refreshModels();
    } else {
      ElMessage.error(r?.message || "批量添加失败");
    }
  } catch (e) {
    ElMessage.error(`批量添加失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    batchSaving.value = false;
  }
}

// ---- 模型组：对外名 → 多个「渠道 + 实际模型」 ----
// 需求口径：给一组模型起一个对外名（如 free），客户端只请求 free；转发层按组策略选择
// 成员，成员失败（限流 / 无账号 / 模型不存在）自动换下一个。成员顺序即顺序优先策略的优先级。
type GroupDraftMember = { channel: string; real_model: string };

const groupList = computed(() => {
  const map = app.config.localgw?.models?.groups || {};
  return Object.entries(map).map(([name, group]) => ({
    name,
    strategy: group?.strategy === "round-robin" ? ("round-robin" as const)
      : group?.strategy === "credit" ? ("credit" as const) : ("priority" as const),
    members: Array.isArray(group?.members) ? group.members : [],
  }));
});

const grpName = ref("");
const grpStrategy = ref<"priority" | "round-robin" | "credit">("priority");
/** 正在编辑的原始组名（空 = 新建）；改名保存成功后要删掉旧键 */
const grpEditing = ref("");
const grpMembers = ref<GroupDraftMember[]>([]);
const grpChannel = ref("");
const grpKeyword = ref("");
const grpSelected = ref<Set<string>>(new Set());
const grpSaving = ref(false);

const grpCandidates = computed(() => {
  const ch = grpChannel.value;
  if (!ch) return [];
  const q = grpKeyword.value.trim().toLowerCase();
  return (channelModels.value[ch] || [])
    .filter((row) => !q || row.realModel.toLowerCase().includes(q))
    .map((row) => ({
      realModel: row.realModel,
      inGroup: grpMembers.value.some((m) => m.channel === ch && m.real_model === row.realModel),
    }));
});
const grpAllChecked = computed(() => grpCandidates.value.length > 0 && grpCandidates.value.every((r) => grpSelected.value.has(r.realModel)));

function grpToggle(realModel: string) {
  const next = new Set(grpSelected.value);
  if (next.has(realModel)) next.delete(realModel); else next.add(realModel);
  grpSelected.value = next;
}
function grpToggleAll() {
  grpSelected.value = grpAllChecked.value ? new Set() : new Set(grpCandidates.value.map((r) => r.realModel));
}
watch(grpChannel, (ch) => {
  grpKeyword.value = "";
  grpSelected.value = new Set();
  void loadChannelModels(ch);
});

/** 把勾选的模型加入草稿成员（跨渠道累积，同渠道同模型去重） */
function grpAddSelected() {
  const ch = grpChannel.value;
  if (!ch) return;
  const seen = new Set(grpMembers.value.map((m) => `${m.channel}\u0000${m.real_model}`));
  const next = [...grpMembers.value];
  for (const row of grpCandidates.value) {
    if (!grpSelected.value.has(row.realModel)) continue;
    const key = `${ch}\u0000${row.realModel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({ channel: ch, real_model: row.realModel });
  }
  grpMembers.value = next;
  grpSelected.value = new Set();
}
function grpRemoveMember(index: number) {
  grpMembers.value = grpMembers.value.filter((_, i) => i !== index);
}
function grpMoveMember(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= grpMembers.value.length) return;
  const next = [...grpMembers.value];
  [next[index], next[target]] = [next[target], next[index]];
  grpMembers.value = next;
}
function resetGroupForm() {
  grpName.value = "";
  grpStrategy.value = "priority";
  grpEditing.value = "";
  grpMembers.value = [];
  grpChannel.value = "";
  grpKeyword.value = "";
  grpSelected.value = new Set();
}
function editGroup(group: { name: string; strategy: "priority" | "round-robin" | "credit"; members: { channel: string; real_model: string }[] }) {
  grpEditing.value = group.name;
  grpName.value = group.name;
  grpStrategy.value = group.strategy;
  grpMembers.value = group.members.map((m) => ({ channel: m.channel, real_model: m.real_model }));
  grpChannel.value = "";
  grpKeyword.value = "";
  grpSelected.value = new Set();
}

async function saveGroup() {
  const name = grpName.value.trim();
  if (!name) { ElMessage.warning("请填写对外名（如 free）"); return; }
  if (!grpMembers.value.length) { ElMessage.warning("模型组至少需要一个成员"); return; }
  const clash = groupList.value.find((g) => g.name.toLowerCase() === name.toLowerCase() && g.name !== grpEditing.value);
  if (clash) { ElMessage.warning(`模型组「${clash.name}」已存在`); return; }
  grpSaving.value = true;
  const editing = grpEditing.value;
  try {
    const r = await localgwApi.modelsSetGroup(name, {
      strategy: grpStrategy.value,
      members: grpMembers.value.map((m) => ({ channel: m.channel, real_model: m.real_model })),
    });
    if (!r || r.ok === false) { ElMessage.error(r?.message || "保存模型组失败"); return; }
    // 改名保存：后端没有原子改名，先落新组再删旧键；删除失败只提示，不回滚新组
    if (editing && editing !== name) {
      const removed = await localgwApi.modelsRemoveRule("groups", editing)
        .catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
      if (!removed || removed.ok === false) {
        ElMessage.warning(`新组已保存，但旧组名「${editing}」移除失败：${removed?.message || "请到列表里手动移除"}`);
      }
    }
    ElMessage.success(editing ? "模型组已更新" : "模型组已保存");
    resetGroupForm();
    await reloadConfig();
    await lgw.refreshModels();
  } catch (e) {
    ElMessage.error(`保存模型组失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    grpSaving.value = false;
  }
}

/** 渠道下拉候选：优先有账号的渠道，退化为全清单；名称口径与切换条 / 上游启闭一致 */
const channelOptions = computed(() => {
  const list = lgw.channels.length ? lgw.channels : lgw.allChannels;
  return list.map((c) => ({
    id: c.id,
    display: channelDisplayById.value.get(c.id) || channelName(c.id),
  }));
});

// ---- 「实际模型名」下拉：选项来自「后方所选渠道」的原生模型清单 ----
// 需求口径：实际模型名不再是自由文本，而是**跟着渠道走的单选下拉**（带输入筛选）——
// 选中哪个渠道就只列那个渠道的模型；渠道没选时先置灰，因为「有哪些模型」是渠道的属性。
// 数据源用 localgw_models_channel_models（渠道适配器原生目录），**不能**拿 lgw.models 过滤渠道：
// 合并目录里同名模型被覆盖 / 自定义接管后，原渠道那一行就不在列表里，会漏掉可选模型。
/** 渠道 id → 该渠道的原生模型清单；按需拉取后缓存（同渠道切来切回不重复打 IPC） */
const channelModels = ref<Record<string, localgwApi.LocalgwChannelModel[]>>({});
/** 渠道 id → 正在拉取（驱动 el-select 的 loading 转圈） */
const modelsLoading = ref<Record<string, boolean>>({});
/** 请求序号：连点切换渠道时晚到的旧响应不许盖掉新结果（与 store 里轮询的竞态处理同口径） */
const modelsSeq = new Map<string, number>();

/** 取某渠道清单：已缓存直接返回；失败不写缓存（后端重启 / 通道补齐后切回来能重试） */
async function loadChannelModels(channel: string) {
  const ch = channel.trim();
  if (!ch || channelModels.value[ch]) return;
  const seq = (modelsSeq.get(ch) || 0) + 1;
  modelsSeq.set(ch, seq);
  modelsLoading.value = { ...modelsLoading.value, [ch]: true };
  try {
    const rows = await localgwApi.modelsChannelModels(ch);
    if (seq !== modelsSeq.get(ch)) return;
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.realModel === "string" && r.realModel);
    channelModels.value = { ...channelModels.value, [ch]: list };
  } catch {
    // 通道未接线 / 后端异常：保持空清单即可 —— 下拉仍允许手输，不能因为目录拿不到就把表单锁死
  } finally {
    if (seq === modelsSeq.get(ch)) modelsLoading.value = { ...modelsLoading.value, [ch]: false };
  }
}

/** 渠道变了就按需拉该渠道清单（缓存命中则同步出选项，不闪 loading） */
watch(ovChannel, (ch) => { ovReal.value = ""; void loadChannelModels(ch); });
watch(cuChannel, (ch) => { cuReal.value = ""; void loadChannelModels(ch); });

/** 某渠道的下拉选项：value 必须是 realModel（localgw 转发时原样发给上游），label 用同一个名字 */
function realModelOptions(channel: string) {
  return (channelModels.value[channel] || []).map((r) => ({ value: r.realModel, label: r.realModel }));
}
const ovRealOptions = computed(() => realModelOptions(ovChannel.value));
const cuRealOptions = computed(() => realModelOptions(cuChannel.value));

/** 当前值不在该渠道清单里（切过渠道 / 手输过）：补一条占位选项，
 *  否则下拉会显示一个看不出处境的裸值，用户不知道它到底还对不对。 */
function staleValue(value: string, options: { value: string }[]) {
  const v = value.trim();
  return v && !options.some((o) => o.value === v) ? v : "";
}
const ovRealStale = computed(() => staleValue(ovReal.value, ovRealOptions.value));
const cuRealStale = computed(() => staleValue(cuReal.value, cuRealOptions.value));

/** 选完实际模型名后，对外名还空着就补成该渠道目录条目名：
 *  覆盖最常见的用法是「对外名沿用渠道原名」，不补的话用户得把同一个名字再敲一遍。
 *  ⚠️ 只在对外名空着时补，绝不覆盖用户已经写好的对外名。
 *  ⚠️ 自定义模型**不**自动补：它的对外名本来就该是新名字，自动补只会造出一条与渠道行重复的规则。 */
function onOvRealChange(v: unknown) {
  const real = typeof v === "string" ? v : "";
  if (!real || ovModel.value.trim()) return;
  const hit = (channelModels.value[ovChannel.value] || []).find((r) => r.realModel === real);
  ovModel.value = hit?.id || real;
}

async function submitOverride() {
  const model = ovModel.value.trim();
  const real = ovReal.value.trim();
  if (!model || !real || !ovChannel.value) {
    ElMessage.warning("请填写对外名、实际模型名并选择渠道");
    return;
  }
  saving.value = true;
  try {
    const r = await localgwApi.modelsSetOverride(model, { real_model: real, channel: ovChannel.value });
    if (r && r.ok) {
      ElMessage.success("已保存覆盖");
      ovModel.value = "";
      ovReal.value = "";
      await reloadConfig();
      await lgw.refreshModels();
    } else {
      ElMessage.error("保存失败");
    }
  } catch (e) {
    ElMessage.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}

async function submitCustom() {
  const model = cuModel.value.trim();
  const real = cuReal.value.trim();
  if (!model || !real || !cuChannel.value) {
    ElMessage.warning("请填写模型名、实际模型名并选择渠道");
    return;
  }
  saving.value = true;
  try {
    const r = await localgwApi.modelsAddCustom(model, { channel: cuChannel.value, real_model: real });
    if (r && r.ok) {
      ElMessage.success("已添加自定义模型");
      cuModel.value = "";
      cuReal.value = "";
      await reloadConfig();
      await lgw.refreshModels();
    } else {
      ElMessage.error("添加失败");
    }
  } catch (e) {
    ElMessage.error(`添加失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}

/** 重新读配置段：overrides/aliases/custom 的权威副本在后端 config.json，
 *  写成功后必须回读，否则界面留的是本地旧副本（下次写会把旧值深合并回去） */
async function reloadConfig() {
  const cfg = await localgwApi.configGet().catch(() => null);
  if (cfg && typeof cfg === "object" && app.config.localgw) {
    const m = (cfg as { models?: Record<string, unknown> }).models;
    if (m && typeof m === "object" && app.config.localgw.models) {
      Object.assign(app.config.localgw.models, m);
    }
  }
}

onMounted(async () => {
  // refreshModels 成功即置 backendReady，不依赖先打开总览页
  await Promise.all([lgw.refreshModels(), lgw.refreshChannels(), reloadConfig()]);
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <!-- 错误红卡 -->
      <div v-if="lgw.lastError" class="card err-card"><div class="set-desc err-text">{{ lgw.lastError }}</div></div>

      <!-- 后端未接入占位 -->
      <div v-if="!lgw.backendReady" class="card">
        <div class="empty">
          <div class="empty-title">后端通道未接入</div>
          <div class="empty-sub">模型目录需要主进程 localgw IPC 通道，由渠道 discovery 汇总生成。</div>
        </div>
      </div>

      <template v-else>
        <!-- 顶部三主 Tab（照搬旧版 .models-main-tabs） -->
        <div class="models-main-tabs">
          <button class="main-tab-btn" :class="{ active: mainTab === 'catalog' }" @click="mainTab = 'catalog'">
            模型目录
          </button>
          <button class="main-tab-btn" :class="{ active: mainTab === 'alias' }" @click="mainTab = 'alias'">
            自定义模型映射
          </button>
          <button class="main-tab-btn" :class="{ active: mainTab === 'custom' }" @click="mainTab = 'custom'">
            覆盖与自定义
          </button>
          <div style="flex: 1"></div>
          <!-- 「拉取最新模型」：显式的 force 动作。页面挂载时的 models.snapshot() 不带 force，
               插件返回的是账号登录时的缓存目录 —— 只有这里才会真的向上游要一次最新清单。 -->
          <span v-if="lastPulledAt" class="seg-label">上次拉取 {{ new Date(lastPulledAt).toLocaleTimeString("zh-CN", { hour12: false }) }}</span>
          <button class="btn btn-sm btn-primary" :disabled="refreshingChannels" @click="pullCurrentScope">
            {{ refreshingChannels ? "正在向上游拉取…" : channelTab ? `拉取「${channelDisplay(channelTab)}」最新模型` : "拉取最新模型" }}
          </button>
          <button v-if="channelTab" class="btn btn-sm" :disabled="refreshingChannels" @click="pullAllModels">
            拉取全部渠道
          </button>
          <!-- 「在 /v1/models 中暴露」：旧版的全局开关位置在 tab 行右侧 -->
          <span class="seg-label">在 /v1/models 中暴露</span>
          <el-switch :model-value="exposeOn" :loading="saving" @update:model-value="(v: any) => exposeToggle(v)" />
        </div>

        <!-- ===== Tab 1：模型目录 ===== -->
        <div v-if="refreshResults.length" class="card" style="margin-bottom: 10px" aria-live="polite">
          <div class="card-title">
            本次拉取结果
            <el-tooltip
              content="拉取只更新模型目录，不代表渠道可调用。新版插件会自动接管其声明的渠道；同一渠道装了多个插件时到「外置插件设置」固定来源；自定义供应商请在对应页面拉取。"
              placement="top"
              :show-after="100"
            >
              <span class="title-qmark" role="img" aria-label="说明">?</span>
            </el-tooltip>
            <span class="right">更新 {{ refreshResults.filter(r => r.status === 'refreshed').length }} · 跳过 {{ refreshResults.filter(r => r.status === 'skipped').length }} · 失败 {{ refreshResults.filter(r => r.status === 'failed').length }}</span>
          </div>
          <div v-for="result in refreshResults" :key="result.channel" class="refresh-line">
            <span class="refresh-ch">{{ channelDisplay(result.channel) }}</span>
            <span class="refresh-msg" :class="{ 'is-bad': result.status === 'failed', 'is-warn': result.status === 'skipped' }">{{ refreshLine(result) }}</span>
            <button v-if="result.hint" class="btn-link" @click="followRefreshHint(result)">去处理 →</button>
          </div>
        </div>
        <template v-if="mainTab === 'catalog'">
          <el-alert v-if="lgw.modelDirectory?.historyWarning" type="warning" title="模型来源历史未完整保存：部分离线模型诊断可能缺失" :closable="false" show-icon style="margin-bottom: 8px" />
          <el-alert v-if="lgw.modelDirectory && !lgw.modelDirectory.complete" type="warning" title="模型目录尚未完整：尚有待查询账号或部分上游不可用" :closable="false" show-icon style="margin-bottom: 8px">
            <button class="btn btn-sm" :disabled="refreshingChannels" @click="pullCurrentScope" style="margin-left: 6px">重新拉取</button>
          </el-alert>

          <!-- 渠道切换：照搬号池管家顶部切换样式（收起为一行方块条，展开为三列大卡片） -->
          <div class="ch-switch">
            <div v-if="switcherCollapsed" class="ch-strip">
              <div class="ch-strip-list" ref="stripRef" aria-label="渠道切换">
                <span v-if="!tabChannels.length" class="ch-strip-empty">无可用渠道</span>
                <el-tooltip content="全部渠道" placement="top" :show-after="120">
                  <button
                    class="ch-sq"
                    :class="{ active: !channelTab }"
                    :aria-pressed="!channelTab"
                    aria-label="全部渠道"
                    @click="channelTab = ''"
                  >
                    <b>全</b>
                  </button>
                </el-tooltip>
                <el-tooltip
                  v-for="ch in tabChannels"
                  :key="ch.id"
                  :content="channelTip(ch)"
                  placement="top"
                  :show-after="120"
                >
                  <button
                    class="ch-sq"
                    :class="{ active: channelTab === ch.id }"
                    :aria-pressed="channelTab === ch.id"
                    :aria-label="channelTip(ch)"
                    @click="channelTab = ch.id"
                  >
                    <img v-if="ch.icon" :src="ch.icon" alt="" />
                    <b v-else>{{ ch.initial }}</b>
                  </button>
                </el-tooltip>
              </div>
              <el-tooltip content="展开全部渠道" placement="top" :show-after="120">
                <button class="ch-sq ch-sq-arrow" :disabled="!tabChannels.length" aria-label="展开全部渠道" @click="switcherCollapsed = false">
                  <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 9 L12 16 L19 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
              </el-tooltip>
            </div>
            <template v-else>
              <div class="channel-switch">
                <button
                  class="channel-btn"
                  :class="{ active: !channelTab }"
                  @click="channelTab = ''"
                >
                  <span class="ch-ico"><b>全</b></span>
                  <span class="ch-text">
                    <span class="ch-name">全部渠道</span>
                    <span class="ch-sub">{{ lgw.models.length }} 个模型</span>
                  </span>
                </button>
                <button
                  v-for="ch in tabChannels"
                  :key="ch.id"
                  class="channel-btn"
                  :class="{ active: channelTab === ch.id }"
                  @click="channelTab = ch.id"
                >
                  <span class="ch-ico">
                    <img v-if="ch.icon" :src="ch.icon" alt="" />
                    <b v-else>{{ ch.initial }}</b>
                  </span>
                  <span class="ch-text">
                    <span class="ch-name">{{ ch.display }}</span>
                    <span class="ch-sub">{{ modelCountByChannel(ch.id) }} 个模型</span>
                  </span>
                </button>
              </div>
              <div class="ch-strip-foot">
                <el-tooltip content="收起渠道切换" placement="top" :show-after="120">
                  <button class="ch-sq ch-sq-arrow" aria-label="收起渠道切换" @click="switcherCollapsed = true">
                    <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 16 L12 9 L19 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  </button>
                </el-tooltip>
              </div>
            </template>
          </div>

          <div class="models-head">
            <span class="current-scope-badge" v-if="channelTab">
              已选渠道：<b>{{ channelDisplay(channelTab) }}</b>（{{ modelCountByChannel(channelTab) }} 个模型）
              <button class="btn-link" style="margin-left: 6px" @click="channelTab = ''">看全部 →</button>
            </span>
            <span class="current-scope-badge" v-else>
              全部渠道（共 {{ rows.length }} 个匹配模型）
            </span>
            <span class="head-tools">
              <div class="seg-group">
                <span class="seg-label">来源</span>
                <div class="seg">
                  <button class="seg-item" :class="{ active: sourceFilter === 'all' }" @click="sourceFilter = 'all'">全部</button>
                  <button class="seg-item" :class="{ active: sourceFilter === 'channel' }" @click="sourceFilter = 'channel'">渠道</button>
                  <button class="seg-item" :class="{ active: sourceFilter === 'override' }" @click="sourceFilter = 'override'">覆盖</button>
                  <button class="seg-item" :class="{ active: sourceFilter === 'alias' }" @click="sourceFilter = 'alias'">别名</button>
                  <button class="seg-item" :class="{ active: sourceFilter === 'custom' }" @click="sourceFilter = 'custom'">自定义</button>
                  <button class="seg-item" :class="{ active: sourceFilter === 'group' }" @click="sourceFilter = 'group'">模型组</button>
                  <button class="seg-item" :class="{ active: sourceFilter === 'channel-lock' }" @click="sourceFilter = 'channel-lock'">渠道锁</button>
                </div>
              </div>
              <label class="search-box">
                <i class="ph ph-magnifying-glass"></i>
                <input v-model="filter" class="search-input" placeholder="搜索模型 ID / 渠道 / 实际模型" spellcheck="false" />
                <el-tooltip v-if="filter" content="清空搜索" placement="top">
                  <button class="search-clear" @click.prevent="filter = ''"><i class="ph ph-x"></i></button>
                </el-tooltip>
              </label>
            </span>
          </div>

          <div class="card" style="margin-top: 10px">
            <div class="card-title">
              合并模型目录
              <el-tooltip
                content="合并渠道原生目录、改名覆盖、自定义与别名；支持行内锁定渠道，保存即热生效。"
                placement="top"
                :show-after="100"
              >
                <span class="title-qmark" role="img" aria-label="说明">?</span>
              </el-tooltip>
              <span class="right">{{ rows.length }} 个模型 · 保存即热生效</span>
            </div>
            <div class="table-scroll">
              <table class="table table-bare tbl-static" style="table-layout: fixed; width: 100%">
                <!-- 定宽列：对外名自适应，其余按内容固定（照搬旧版 colgroup 做法） -->
                <colgroup>
                  <col style="width: auto; min-width: 180px" />
                  <col style="width: 220px" />
                  <col style="width: 150px" />
                  <col style="width: 110px" />
                  <col style="width: 100px" />
                  <!-- 渠道锁定列：select 固定 104px + 单元格左右 padding 各 12px = 128px 起步 -->
                  <col style="width: 128px" />
                </colgroup>
                <thead>
                  <tr>
                    <th>对外模型名</th>
                    <th>实际模型</th>
                    <th>倍率 / 上下文</th>
                    <th>渠道</th>
                    <th>来源</th>
                    <th>渠道锁定</th>
                  </tr>
                </thead>
                <tbody>
                  <!-- key 必须带渠道 + 实际模型：模型组一个对外名会展开成多行，只按 id|source 会重复 -->
                  <tr v-for="m in rows" :key="`${m.id}|${m.source}|${m.channel}|${m.realModel}`">
                    <td class="mono">{{ text(m.display) || "—" }}</td>
                    <td class="mono">{{ text(m.realModel) || "—" }}</td>
                    <td class="mono" :title="`${m.rateSource === 'user' ? '用户手填倍率（覆盖渠道目录声明）' : m.rateSource === 'provider-config' ? '提供商配置' : '渠道目录'}；未知值不估算`">{{ fmtRate(m.rate) }} / {{ m.contextLength || "未知" }}</td>
                    <td>{{ text(m.channel) || "—" }}</td>
                    <td><span class="tag" :class="sourceCls(text(m.source))">{{ sourceLabel(text(m.source)) }}</span></td>
                    <!-- 行内渠道锁定（v1.82.2「渠道覆盖」）：只锁渠道，不改上游模型名。
                         自动 = 空值（清锁）；锁已失效时把失效渠道补成一条醒目的选项，方便取消。 -->
                    <td>
                      <el-tooltip :content="lockTip(m)" :disabled="!lockTip(m)" placement="top">
                        <!-- title 兜底：el-select 在 disabled 态下不冒泡 hover，原生 title 仍能看到禁用原因 -->
                        <span :title="lockTip(m) || undefined">
                          <el-select
                            class="f-el-select lock-select"
                            popper-class="glass-popper"
                            :persistent="false"
                            :model-value="lockValue(m)"
                            :disabled="!canLock(m)"
                            :loading="savingLock"
                            placeholder="自动"
                            @update:model-value="(v: string) => changeLock(m, v)"
                          >
                            <el-option value="" label="自动（按路由策略）" />
                            <el-option
                              v-for="o in lockCandidates(m)"
                              :key="o.value"
                              :value="o.value"
                              :label="o.label"
                              :disabled="o.unavailable"
                            />
                          </el-select>
                        </span>
                      </el-tooltip>
                    </td>
                  </tr>
                  <!-- 空态双分支：有筛选给「清空筛选」，没筛选给引导（旧版 599-609 行） -->
                  <tr v-if="!rows.length">
                    <td colspan="6" class="empty-cell">
                      <template v-if="hasFilter">
                        当前筛选没有匹配的模型
                        <button class="btn-link" style="margin-left: 6px" @click="clearFilter">清空筛选 →</button>
                      </template>
                      <template v-else-if="channelTab">
                        该渠道当前没有可用模型 —— 常见原因：号池里还没有这个渠道的账号、渠道在「路由与渠道」里被关闭、
                        或执行插件未运行 / 未授权。三种都处理完后点上面的「拉取最新模型」。
                      </template>
                      <template v-else>
                        暂无可用模型 —— 点击「拉取最新模型」更新目录；号池渠道由已启用且授权的执行插件自动接管，
                        同一渠道装了多个插件时到「设置 · 外置插件 → 设置」里固定来源；自定义供应商请在供应商页面导入模型
                      </template>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>

        <!-- ===== Tab 2：别名 ===== -->
        <template v-else-if="mainTab === 'alias'">
          <div class="card">
            <div class="card-title">
              自定义模型映射
              <el-tooltip
                content="对外名与上游实际模型名的一对一别名映射，让客户端请求的名字与后端服务解耦。"
                placement="top"
                :show-after="100"
              >
                <span class="title-qmark" role="img" aria-label="说明">?</span>
              </el-tooltip>
              <span class="right">{{ aliasList.length }} 条 · 对外名 → 实际模型名</span>
            </div>
            <div class="alias-form">
              <input v-model="aliasFrom" class="f-input" placeholder="对外名（客户端里填的）" spellcheck="false" />
              <i class="ph ph-arrow-right alias-arrow"></i>
              <input v-model="aliasTo" class="f-input" placeholder="实际模型名（发给上游的）" spellcheck="false" />
              <button class="btn btn-primary" :disabled="saving" @click="addAlias">添加映射</button>
            </div>
            <div class="table-scroll">
              <table class="table table-bare tbl-static">
                <thead>
                  <tr><th>对外名</th><th>实际模型名</th><th class="col-act">操作</th></tr>
                </thead>
                <tbody>
                  <tr v-for="a in aliasList" :key="a.from">
                    <td class="mono">{{ a.from }}</td>
                    <td class="mono">{{ a.to }}</td>
                    <td class="col-act">
                      <button class="btn btn-sm" @click="toggleAlias(a.from, !a.enabled)">{{ a.enabled ? "停用" : "启用" }}</button>
                      <button class="btn-link" :disabled="saving" @click="removeRule('aliases', a.from, '映射')">移除</button>
                    </td>
                  </tr>
                  <tr v-if="!aliasList.length">
                    <td colspan="3" class="empty-cell">还没有模型映射 —— 别名让客户端可用的名字与上游真实模型名解耦</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>

        <!-- ===== Tab 3：覆盖与自定义 ===== -->
        <template v-else>
          <!-- 批量添加：选渠道 → 勾模型 → 一次写入。放在两张表之前，因为它是常用入口 -->
          <div class="card">
            <div class="card-title">
              批量添加
              <el-tooltip
                content="从所选渠道的原生模型清单中多选勾选，一次性批量写入改名覆盖或自定义模型。对外名默认沿用原名，写入后可在下方表格单独微调。"
                placement="top"
                :show-after="100"
              >
                <span class="title-qmark" role="img" aria-label="说明">?</span>
              </el-tooltip>
              <span class="right">{{ batchSelected.size }} / {{ batchCandidates.length }} 已选 · 一次落盘</span>
            </div>
            <div class="alias-form">
              <el-select v-model="batchKind" class="f-el-select" style="width: 132px">
                <el-option value="override" label="写入改名覆盖" />
                <el-option value="custom" label="写入自定义模型" />
              </el-select>
              <el-select v-model="batchChannel" placeholder="选择渠道" popper-class="glass-popper" class="f-el-select" style="width: 180px">
                <el-option v-for="c in channelOptions" :key="c.id" :label="c.display" :value="c.id" />
              </el-select>
              <input v-model="batchKeyword" class="f-input" placeholder="筛选模型名" spellcheck="false" />
              <button class="btn btn-sm" :disabled="!batchChannel || !batchCandidates.length" @click="batchToggleAll">
                {{ batchAllChecked ? "取消全选" : "全选" }}
              </button>
              <button class="btn btn-primary" :disabled="batchSaving || !batchSelected.size" @click="submitBatch">
                {{ batchSaving ? "正在写入…" : `添加 ${batchSelected.size} 个` }}
              </button>
            </div>
            <div v-if="batchChannel" class="batch-list">
              <div v-if="!batchCandidates.length" class="empty-cell">
                该渠道目录里没有可选的模型 —— 先在上面「拉取最新模型」，或到号池确认该渠道的账号可用
              </div>
              <label
                v-for="row in batchCandidates"
                :key="row.realModel"
                class="batch-item"
                :class="{ on: batchSelected.has(row.realModel) }"
              >
                <input type="checkbox" :checked="batchSelected.has(row.realModel)" @change="batchToggle(row.realModel)" />
                <span class="mono batch-name">{{ row.realModel }}</span>
                <span v-if="row.model !== row.realModel" class="batch-alias">对外名 {{ row.model }}</span>
                <span v-if="row.exists" class="tag tag-warn">已存在</span>
              </label>
            </div>
          </div>

          <!-- 模型组：对外名 → 多个「渠道 + 实际模型」。客户端只认组名，转发层按策略挑成员，
               成员失败自动换下一个。组名在 bindings() 里优先级最高，因此不许与覆盖/别名重名。 -->
          <div class="card">
            <div class="card-title">
              模型组
              <el-tooltip
                content="为多个渠道的模型指定统一的对外名（如 free）。客户端只请求组名，网关按顺序/轮询/积分策略调度，某成员不可用时自动故障转移。组名不可与覆盖/别名重名。"
                placement="top"
                :show-after="100"
              >
                <span class="title-qmark" role="img" aria-label="说明">?</span>
              </el-tooltip>
              <span class="right">{{ groupList.length }} 个 · 对外名 → 多个渠道模型</span>
            </div>
            <div class="alias-form">
              <input v-model="grpName" class="f-input" placeholder="对外名（如 free）" spellcheck="false" />
              <el-select v-model="grpStrategy" class="f-el-select" style="width: 180px">
                <el-option value="priority" label="顺序优先（按成员顺序）" />
                <el-option value="round-robin" label="轮询均衡（分摊请求）" />
                <el-option value="credit" label="积分优先（跨渠道按账号额度）" />
              </el-select>
              <span v-if="grpEditing" class="seg-label">正在编辑「{{ grpEditing }}」</span>
              <button v-if="grpEditing" class="btn btn-sm" @click="resetGroupForm">取消编辑</button>
            </div>
            <div class="alias-form">
              <el-select v-model="grpChannel" placeholder="选择渠道以添加成员" popper-class="glass-popper" class="f-el-select" style="width: 180px">
                <el-option v-for="c in channelOptions" :key="c.id" :label="c.display" :value="c.id" />
              </el-select>
              <input v-model="grpKeyword" class="f-input" placeholder="筛选模型名" spellcheck="false" />
              <button class="btn btn-sm" :disabled="!grpChannel || !grpCandidates.length" @click="grpToggleAll">
                {{ grpAllChecked ? "取消全选" : "全选" }}
              </button>
              <button class="btn btn-sm" :disabled="!grpSelected.size" @click="grpAddSelected">
                加入成员 {{ grpSelected.size }}
              </button>
            </div>
            <div v-if="grpChannel" class="batch-list">
              <div v-if="!grpCandidates.length" class="empty-cell">
                该渠道目录里没有可选的模型 —— 先在顶部「拉取最新模型」，或到号池确认该渠道的账号可用
              </div>
              <label
                v-for="row in grpCandidates"
                :key="row.realModel"
                class="batch-item"
                :class="{ on: grpSelected.has(row.realModel) }"
              >
                <input type="checkbox" :checked="grpSelected.has(row.realModel)" @change="grpToggle(row.realModel)" />
                <span class="mono batch-name">{{ row.realModel }}</span>
                <span v-if="row.inGroup" class="tag tag-warn">已在组内</span>
              </label>
            </div>
            <!-- 草稿成员：顺序就是顺序优先策略的优先级，可上下调整 -->
            <div v-if="grpMembers.length" class="grp-members">
              <div v-for="(m, i) in grpMembers" :key="`${m.channel}|${m.real_model}`" class="grp-member">
                <span class="grp-order">{{ i + 1 }}</span>
                <span class="tag tag-dim">{{ channelDisplay(m.channel) }}</span>
                <span class="mono grp-real">{{ m.real_model }}</span>
                <button class="btn-link" :disabled="i === 0" @click="grpMoveMember(i, -1)">上移</button>
                <button class="btn-link" :disabled="i === grpMembers.length - 1" @click="grpMoveMember(i, 1)">下移</button>
                <button class="btn-link" @click="grpRemoveMember(i)">移除</button>
              </div>
            </div>
            <div class="alias-form grp-actions">
              <button class="btn btn-primary" :disabled="grpSaving || !grpName.trim() || !grpMembers.length" @click="saveGroup">
                {{ grpSaving ? "正在保存…" : grpEditing ? "保存修改" : "保存模型组" }}
              </button>
              <span class="seg-label">成员顺序 = 顺序优先的调用顺序；积分优先下同档同到期时按它兜底{{ grpMembers.length ? `（当前 ${grpMembers.length} 个）` : "" }}</span>
            </div>
            <div class="table-scroll">
              <table class="table table-bare tbl-static">
                <thead>
                  <tr><th>组名</th><th>策略</th><th>成员（按优先级）</th><th class="col-act">操作</th></tr>
                </thead>
                <tbody>
                  <tr v-for="g in groupList" :key="g.name">
                    <td class="mono">{{ g.name }}</td>
                    <td>{{ g.strategy === "round-robin" ? "轮询均衡" : g.strategy === "credit" ? "积分优先" : "顺序优先" }}</td>
                    <td class="mono group-members-cell">
                      <span v-for="(m, i) in g.members" :key="`${m.channel}|${m.real_model}`" class="grp-chip">
                        {{ i + 1 }}. {{ channelDisplay(m.channel) }} / {{ m.real_model }}
                      </span>
                    </td>
                    <td class="col-act">
                      <button class="btn btn-sm" :disabled="saving" @click="editGroup(g)">编辑</button>
                      <button class="btn-link" :disabled="saving" @click="removeRule('groups', g.name, '模型组')">移除</button>
                    </td>
                  </tr>
                  <tr v-if="!groupList.length">
                    <td colspan="4" class="empty-cell">
                      还没有模型组 —— 给一组模型起个对外名（如 free），客户端只请求这个名字，网关自动在成员之间调用
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 改名覆盖：把对外模型名固定到某渠道的「另一个」实际模型名。
               与 Tab1 行内「渠道锁定」分工：那个只换渠道、不改模型名；这里才改上游名。 -->
          <div class="card">
            <div class="card-title">
              改名覆盖
              <el-tooltip
                content="将对外模型名指向某渠道的另一个实际模型名。若仅需锁定渠道而不改模型名，在 Tab 1 表格中使用「渠道锁定」列即可。"
                placement="top"
                :show-after="100"
              >
                <span class="title-qmark" role="img" aria-label="说明">?</span>
              </el-tooltip>
              <span class="right">{{ overrides.length }} 条 · 对外名 → 某渠道的另一个实际模型名</span>
            </div>
            <div class="alias-form">
              <input v-model="ovModel" class="f-input" placeholder="对外模型名" spellcheck="false" />
              <!-- 实际模型名：单选下拉 + 输入筛选，选项 =「后方所选渠道」的原生模型清单。
                   渠道没选时置灰（有哪些模型是渠道的属性）；清单外的名字仍可直接输入、回车创建 -->
              <el-select
                v-model="ovReal"
                class="f-el-select model-pick"
                popper-class="glass-popper"
                :disabled="!ovChannel"
                :loading="!!modelsLoading[ovChannel]"
                :placeholder="ovChannel ? '选择实际模型（可输入筛选）' : '请先选择渠道'"
                no-data-text="目录里没有匹配项 —— 直接输入后回车即可"
                filterable
                allow-create
                default-first-option
                clearable
                @change="onOvRealChange"
              >
                <el-option v-if="ovRealStale" :key="ovRealStale" :label="ovRealStale + '（已不在渠道目录）'" :value="ovRealStale" />
                <el-option v-for="o in ovRealOptions" :key="o.value" :label="o.label" :value="o.value" />
              </el-select>
              <el-select v-model="ovChannel" placeholder="选择渠道" popper-class="glass-popper" class="f-el-select" style="width: 180px">
                <el-option v-for="c in channelOptions" :key="c.id" :label="c.display" :value="c.id" />
              </el-select>
              <button class="btn btn-primary" :disabled="saving" @click="submitOverride">保存覆盖</button>
            </div>
            <div class="table-scroll">
              <table class="table table-bare tbl-static">
                <thead>
                  <tr><th>对外模型名</th><th>实际模型名</th><th>渠道</th><th class="col-act">操作</th></tr>
                </thead>
                <tbody>
                  <tr v-for="o in overrides" :key="o.model">
                    <td class="mono">{{ o.model }}</td>
                    <td class="mono">{{ o.realModel }}</td>
                    <td><span class="tag tag-info">{{ o.channel }}</span></td>
                    <td class="col-act">
                      <button class="btn-link" :disabled="saving" @click="removeRule('overrides', o.model, '覆盖')">移除</button>
                    </td>
                  </tr>
                  <tr v-if="!overrides.length">
                    <td colspan="4" class="empty-cell">还没有覆盖规则</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 自定义：新增渠道里原本没有的模型名 -->
          <div class="card">
            <div class="card-title">
              自定义模型
              <el-tooltip
                content="新增渠道原本没有列出但你想暴露给客户端调用的模型名。"
                placement="top"
                :show-after="100"
              >
                <span class="title-qmark" role="img" aria-label="说明">?</span>
              </el-tooltip>
              <span class="right">{{ customs.length }} 条 · 渠道没有但你想暴露的模型名</span>
            </div>
            <div class="alias-form">
              <input v-model="cuModel" class="f-input" placeholder="对外模型名" spellcheck="false" />
              <!-- 实际模型名：同「模型覆盖」——跟着渠道走的单选下拉（可输入筛选 / 可输入清单外名字） -->
              <el-select
                v-model="cuReal"
                class="f-el-select model-pick"
                popper-class="glass-popper"
                :disabled="!cuChannel"
                :loading="!!modelsLoading[cuChannel]"
                :placeholder="cuChannel ? '选择实际模型（可输入筛选）' : '请先选择渠道'"
                no-data-text="目录里没有匹配项 —— 直接输入后回车即可"
                filterable
                allow-create
                default-first-option
                clearable
              >
                <el-option v-if="cuRealStale" :key="cuRealStale" :label="cuRealStale + '（已不在渠道目录）'" :value="cuRealStale" />
                <el-option v-for="o in cuRealOptions" :key="o.value" :label="o.label" :value="o.value" />
              </el-select>
              <el-select v-model="cuChannel" placeholder="选择渠道" popper-class="glass-popper" class="f-el-select" style="width: 180px">
                <el-option v-for="c in channelOptions" :key="c.id" :label="c.display" :value="c.id" />
              </el-select>
              <button class="btn btn-primary" :disabled="saving" @click="submitCustom">添加自定义</button>
            </div>
            <div class="table-scroll">
              <table class="table table-bare tbl-static">
                <thead>
                  <tr><th>对外模型名</th><th>实际模型名</th><th>渠道</th><th class="col-act">操作</th></tr>
                </thead>
                <tbody>
                  <tr v-for="c in customs" :key="c.model">
                    <td class="mono">{{ c.model }}</td>
                    <td class="mono">{{ c.realModel }}</td>
                    <td><span class="tag tag-ok">{{ c.channel }}</span></td>
                    <td class="col-act">
                      <button class="btn-link" :disabled="saving" @click="removeRule('custom', c.model, '自定义模型')">移除</button>
                    </td>
                  </tr>
                  <tr v-if="!customs.length">
                    <td colspan="4" class="empty-cell">还没有自定义模型</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <!-- 消耗倍率：上游目录不一定给（Trae 就没有），允许按模型手填 -->
          <div class="card">
            <div class="card-title">
              消耗倍率
              <el-tooltip
                content="渠道目录未声明倍率时，可按模型配置系数用于比价与选型；0 为免费档，移除后恢复渠道默认。"
                placement="top"
                :show-after="100"
              >
                <span class="title-qmark" role="img" aria-label="说明">?</span>
              </el-tooltip>
              <span class="right">{{ rateList.length }} 条 · 按对外模型名手填</span>
            </div>
            <div class="alias-form">
              <input v-model="rateName" class="f-input" placeholder="对外模型名（与模型目录里的名字一致）" spellcheck="false" />
              <input v-model="rateValue" class="f-input mono" type="number" min="0" max="1000" step="0.1" placeholder="倍率，如 0.5" style="width: 150px" />
              <button class="btn btn-primary" :disabled="rateSaving" @click="saveRate">保存倍率</button>
            </div>
            <div class="alias-form">
              <input v-model="rateName" class="f-input" placeholder="对外模型名（与模型目录里的名字一致）" spellcheck="false" />
              <input v-model="rateValue" class="f-input mono" type="number" min="0" max="1000" step="0.1" placeholder="倍率，如 0.5" style="width: 150px" />
              <button class="btn btn-primary" :disabled="rateSaving" @click="saveRate">保存倍率</button>
            </div>
            <div class="table-scroll">
              <table class="table table-bare tbl-static">
                <thead>
                  <tr><th>模型</th><th>倍率</th><th class="col-act">操作</th></tr>
                </thead>
                <tbody>
                  <tr v-for="row in rateList" :key="row.model">
                    <td class="mono">{{ row.model }}</td>
                    <td class="mono">{{ fmtRate(row.rate) }}</td>
                    <td class="col-act">
                      <button class="btn-link" :disabled="rateSaving" @click="clearRate(row.model)">移除</button>
                    </td>
                  </tr>
                  <tr v-if="!rateList.length">
                    <td colspan="3" class="empty-cell">还没有手填倍率 —— 目录已声明倍率的模型无需在这里重复配置</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>

        <!-- 口径说明：暴露开关关掉时对外可见集合会收窄，容易让人以为模型丢了 -->
        <div class="card">
          <div class="card-title">口径说明</div>
          <div class="s-desc">
            开启「在 /v1/models 中暴露」：<code class="mono">GET /v1/models</code> 返回全部启用渠道的合并视图；
            关闭则 <code class="mono">/v1/models</code> 返回空列表（客户端需自行知道模型名）。
            模型组在 /v1/models 里只出现一个组名，实际调用由网关在成员之间选择。
            当前共 {{ stats.total }} 个模型：模型组 {{ stats.groups }} · 改名覆盖 {{ stats.overrides }} · 别名 {{ stats.aliases }} · 自定义 {{ stats.customs }} · 渠道锁 {{ stats.locks }}。
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
/* 本页根节点是 <section class="page">，不是 .lgw-scope —— localgw.css 只在 .lgw-scope 里
   定义过 --surface-2 / --surface-3 两个别名，直接引用 var(--surface-2) 会让整条声明失效
   （底色静默消失，暗色下不明显、亮色下很明显）。这里按同款口径在本页根上补齐。 */
.page {
  --surface-2: var(--bg-soft);
  --surface-3: var(--code-bg);
}
/* 行内「渠道锁定」下拉：固定 104px，与旧版「渠道覆盖」列同宽（select 100px + 单元格内边距） */
.lock-select {
  width: 104px;
}
/* 错误红卡（旧版 6 页各自声明一份，照旧版做法保留页内） */
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
/* 拉取结果逐行：渠道名定宽、说明自适应、hint 链接贴右 */.refresh-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  line-height: 1.7;
}
.refresh-ch {
  flex: none;
  min-width: 96px;
  color: var(--text-2);
  font-weight: 500;
}
.refresh-msg {
  flex: 1;
  min-width: 0;
  color: var(--text-3);
}
.refresh-msg.is-warn {
  color: var(--warn, #b8860b);
}
.refresh-msg.is-bad {
  color: var(--err, #e05555);
}
/* 批量添加的模型多选区：网格排布，条目多时内部滚动，不把页面撑长 */
.batch-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 4px 10px;
  max-height: 260px;
  overflow-y: auto;
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm, 8px);
  background: var(--surface-2);
}
.batch-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}
.batch-item:hover {
  background: var(--surface-3);
}
.batch-item.on {
  color: var(--text);
}
.batch-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.batch-alias {
  flex: none;
  font-size: 11px;
  color: var(--text-3);
}
/* ===== 模型组：草稿成员列表（顺序 = 优先级） ===== */
.grp-members {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm, 8px);
  background: var(--surface-2);
}
.grp-member {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
}
.grp-order {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--surface-3);
  color: var(--text-3);
  font-size: 11px;
}
.grp-real {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grp-actions {
  border-bottom: none;
  margin-bottom: 10px;
  padding-top: 10px;
  padding-bottom: 0;
}
.group-members-cell {
  color: var(--text-3);
  font-size: 11.5px;
}
.grp-chip {
  display: inline-block;
  margin-right: 10px;
  white-space: nowrap;
}
/* ===== 三主 Tab（照搬旧版 ProxyModelsView.css:761-）===== */
.models-main-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 10px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 0;
}
.main-tab-btn {
  border: none;
  background: none;
  padding: 7px 12px;
  font-size: 12.5px;
  color: var(--text-3);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.main-tab-btn:hover {
  color: var(--text);
}
.main-tab-btn.active {
  color: var(--accent-strong);
  border-bottom-color: var(--accent);
  font-weight: 600;
}
/* ===== head 一条线：渠道 / 来源 / 搜索（照搬旧版 .models-head）===== */
.models-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.head-tools {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.seg-group {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.seg-label {
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
}
.seg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-sm, 8px);
  background: var(--surface-2);
}
/* 渠道切换条：允许换行 + 限高滚动。
   20+ 个渠道时一行放不下，inline-flex 会把容器横向撑破（后面的渠道看不见）；
   换行后再给一个 3 行左右的高度上限，渠道再多也不会把模型表格挤出首屏。 */
.seg-group-channels {
  flex: 1 1 auto;
  min-width: 0;
}
.seg-wrap {
  flex-wrap: wrap;
  max-height: 92px;
  overflow-y: auto;
  align-content: flex-start;
}
.seg-wrap::-webkit-scrollbar {
  width: 6px;
}
.seg-wrap::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: 3px;
}
.seg-item {
  border: none;
  background: none;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--text-3);
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.15s, background 0.15s;
}
.seg-item:hover {
  color: var(--text);
}
.seg-item.active {
  color: var(--text);
  background: var(--surface-3);
  font-weight: 500;
}
/* 渠道切换条上的图标：与「上游启闭」弹窗同款配方（圆角方块 + 图片 / 首字母），
   尺寸按 seg 的 24px 行高等比缩到 18/14，不抢切换条的节奏 */
.seg-item-ico {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px 3px 4px;
}
.seg-ico {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  background: var(--surface-3);
  overflow: hidden;
}
.seg-ico img {
  width: 14px;
  height: 14px;
  object-fit: contain;
  display: block;
}
.seg-ico b {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-2);
}
/* 搜索框（照搬旧版 .search-box） */
.search-box {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm, 8px);
  background: var(--surface-2);
}
.search-box .ph {
  font-size: 12px;
  color: var(--text-3);
}
.search-input {
  border: none;
  background: none;
  outline: none;
  width: 200px;
  font-size: 12px;
  color: var(--text);
}
.search-input::placeholder {
  color: var(--text-3);
}
.search-clear {
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  color: var(--text-3);
  font-size: 12px;
  display: inline-flex;
}
.search-clear:hover {
  color: var(--text);
}
/* ===== 别名 / 覆盖 / 自定义 的行内表单（照搬旧版 .alias-*）===== */
.alias-form {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 10px;
}
.f-input {
  flex: 1;
  min-width: 160px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm, 8px);
  background: var(--surface-2);
  color: var(--text);
  font-size: 12px;
  outline: none;
}
.f-input:focus {
  border-color: var(--accent-line, var(--accent));
}
.f-input::placeholder {
  color: var(--text-3);
}
.alias-arrow {
  color: var(--text-3);
  font-size: 12px;
  flex: none;
}
/* 「实际模型名」下拉：与行内 .f-input 同权限伸缩。
   el-select 根默认 width:100%，在 flex 行里必须显式给 flex-basis，
   否则它以 100% 当基准、和旁边输入框互相挤压 */
.model-pick {
  flex: 1 1 200px;
  min-width: 200px;
}
/* ===== 列表统一走用量统计同款表格（.table.table-bare + .table-scroll）=====
   这几张表只是只读展示 + 行内操作，不点行看详情：照 LogView 的做法去掉
   全局 .table 默认给的 pointer 与悬停底色，免得看起来像能点 */
.tbl-static tbody tr {
  cursor: default;
}
.tbl-static tbody tr:hover {
  background: transparent;
}
.tbl-static .col-act {
  width: 84px;
  text-align: right;
}
.empty-cell {
  text-align: center;
  color: var(--text-3);
  padding: 22px 0;
}
/* 空态 */
.empty {
  padding: 28px 0;
  text-align: center;
}
.empty-title {
  font-size: 13px;
  color: var(--text);
  font-weight: 500;
}
.empty-sub {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 4px;
}
.s-desc {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.7;
}

/* 标题旁边的小问号说明徽章 */
.title-qmark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 1px solid var(--line-strong, rgba(255, 255, 255, 0.2));
  color: var(--text-3);
  font-size: 11px;
  font-weight: 700;
  cursor: help;
  margin-left: 6px;
  vertical-align: middle;
  transition: all 0.18s;
  user-select: none;
}
.title-qmark:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-dim, rgba(16, 185, 129, 0.1));
  transform: scale(1.08);
}

/* ===== 渠道切换：号池管家同款顶部切换 ===== */
.ch-switch {
  --ch-card-h: 52px;
  --ch-strip-h: 38px;
  --ch-sq: 32px;
  min-width: 0;
  margin-bottom: 8px;
}
.ch-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--ch-strip-h);
  min-width: 0;
  animation: stripIn 0.2s ease;
}
.ch-strip-list {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.ch-strip-list::-webkit-scrollbar {
  display: none;
}
.ch-strip-empty {
  font-size: 11.5px;
  color: var(--text-3);
}
.ch-sq {
  position: relative;
  flex: 0 0 var(--ch-sq);
  width: var(--ch-sq);
  height: var(--ch-sq);
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: var(--r-sm, 6px);
  border: 1px solid var(--line);
  background: var(--surface-2, rgba(255, 255, 255, 0.04));
  color: var(--text-2);
  cursor: pointer;
  overflow: hidden;
  transition: all 0.18s;
}
.ch-sq img {
  width: 18px;
  height: 18px;
  object-fit: contain;
  display: block;
}
.ch-sq b {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-2);
  line-height: 1;
}
.ch-sq:hover {
  color: var(--text);
  border-color: var(--line-strong);
  transform: translateY(-1px);
}
.ch-sq:active {
  transform: scale(0.95);
}
.ch-sq.active {
  border-color: var(--accent);
  background: var(--accent-dim, rgba(16, 185, 129, 0.12));
  color: var(--text);
  box-shadow: 0 0 12px -4px var(--accent);
}
.ch-sq.active::after {
  content: "";
  position: absolute;
  left: 6px;
  right: 6px;
  bottom: 2px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
}
.ch-sq.active b {
  color: var(--accent-strong, var(--accent));
}
.ch-sq-arrow {
  flex: 0 0 var(--ch-sq);
  margin-left: auto;
  color: var(--text-3);
}
.ch-sq-arrow:hover {
  color: var(--accent-strong);
}
.ch-sq-arrow svg {
  display: block;
}
.ch-strip-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
}
.channel-switch {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
}
.channel-btn {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  height: var(--ch-card-h, 52px);
  padding: 0 12px;
  border-radius: var(--r-sm, 8px);
  border: 1px solid var(--line);
  background: var(--surface-2, rgba(255, 255, 255, 0.04));
  color: var(--text-2);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: all 0.2s;
}
.channel-btn:hover {
  border-color: var(--line-strong);
  transform: translateY(-1px);
}
.channel-btn.active {
  border-color: var(--accent);
  background: var(--accent-dim, rgba(16, 185, 129, 0.08));
  color: var(--text);
}
.channel-btn.active::after {
  content: "";
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 0;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}
.channel-btn .ch-ico {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  background: var(--surface-3, rgba(255, 255, 255, 0.08));
  overflow: hidden;
}
.channel-btn .ch-ico img {
  width: 18px;
  height: 18px;
  object-fit: contain;
}
.channel-btn .ch-ico b {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-2);
}
.channel-btn .ch-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.channel-btn .ch-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.channel-btn .ch-sub {
  font-size: 11px;
  color: var(--text-3);
}
.current-scope-badge {
  font-size: 12px;
  color: var(--text-2);
}
.current-scope-badge b {
  color: var(--accent);
}
@keyframes stripIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
</style>

<!-- 反代网关 · 模型目录：渠道 tab（全部/各渠道）+ 官方目录拉取 + 启停开关 / 渠道覆盖 / 倍率与能力 / 自定义模型映射
     管理态存框架整体配置（disabledModels / modelOverrides / modelAliases），保存即热生效（服务端每请求读盘） -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import * as api from "../../api/ipc";
import type { ModelCustomEntry, ProxyChannelId, ProxyModel } from "../../types";
import { useAppStore } from "../../stores/app";
import { capabilityNames, capabilityTags, channelName, fmtCtx, fmtInt, fmtRate, parseCtxInput } from "./format";

const app = useAppStore();
const models = ref<ProxyModel[]>([]);
const err = ref("");
const msg = ref("");
const syncing = ref("");
const filter = ref("");
const activeTab = ref(""); // "" = 全部
const mainTab = ref<"catalog" | "alias" | "reverse">("catalog");
const ruleDialogOpen = ref(false);

// 渠道候选 = 号池当前渠道（渠道后续扩充时自动跟进，不写死）
const channels = ref<{ id: string; display: string }[]>([]);
const CHANNEL_OPTIONS = computed<{ value: "" | ProxyChannelId; label: string }[]>(() => [
  { value: "", label: "自动（打分）" },
  ...channels.value.map((c) => ({ value: c.id as ProxyChannelId, label: c.display })),
]);

// 渠道 tab 只显示有模型的渠道：复用下方 modelsByChannel 预分组（O(渠道) 查直值，不再 O(渠道×模型) 逐对扫描）
const tabChannels = computed(() => channels.value.filter((c) => (modelsByChannel.value[c.id] || []).length > 0));

const rows = computed(() => {
  const kw = filter.value.trim().toLowerCase();
  return models.value.filter((m) => {
    if (activeTab.value && !m.sources.includes(activeTab.value as ProxyChannelId)) return false;
    if (!kw) return true;
    return m.id.toLowerCase().includes(kw) || String(m.name || "").toLowerCase().includes(kw);
  });
});

// ===== 思考强度选项 =====
const REASONING_EFFORT_OPTIONS = [
  { value: "", label: "默认" },
  { value: "off", label: "关闭思考 (off)" },
  { value: "minimal", label: "极低 (minimal)" },
  { value: "low", label: "低 (low)" },
  { value: "medium", label: "中等 (medium)" },
  { value: "high", label: "高 (high)" },
  { value: "xhigh", label: "极高 (xhigh)" },
  { value: "max", label: "最大 (max)" },
];

// ===== 模型自定义参数更新 =====
// ===== 上下文长度输入：显示 K/M 缩写，编辑时展开为数字 =====
// ctxDraft 存「正在编辑的原始文本」：有 key 时输入框显示草稿，无 key 时显示 ctxDisplay 的缩写值。
// 不在草稿态做任何格式化，用户输入的每个字符都原样保留，光标不会跳。
const ctxDraft = ref<Record<string, string>>({});

/** 该模型当前生效的上下文长度（自定义优先，否则渠道目录值） */
function ctxValue(m: ProxyModel): number {
  return Number((app.config.proxy.modelCustom || {})[m.id]?.contextLength) || Number(m.contextLength) || 0;
}

/** 非编辑态显示值：K/M 缩写 */
function ctxDisplay(m: ProxyModel): string {
  return fmtCtx(ctxValue(m));
}

/** 悬停提示：编辑说明 + 当前精确值（缩写有精度损失，精确数字放这里） */
function ctxTip(m: ProxyModel): string {
  const v = ctxValue(m);
  return v ? `自定义上下文长度（Token）：${fmtInt(v)}，可直接写 128K / 1M，留空恢复默认` : "自定义上下文长度（Token），留空则恢复默认";
}

/** 提交编辑：解析 "128K"/"1M" 为数字落库；草稿清掉后回到缩写显示 */
async function commitCtx(m: ProxyModel) {
  const raw = ctxDraft.value[m.id];
  if (raw === undefined) return;
  delete ctxDraft.value[m.id];
  const parsed = parseCtxInput(raw);
  // 与「当前生效值」比较而不是与自定义值比较：只聚焦再失焦时草稿就是原始数字，
  // 若拿自定义值(0)比就会把目录自带值误写成一条自定义覆盖（凭空多出「自」标记）
  if ((parsed || 0) === ctxValue(m)) return;
  await updateModelCustom(m, { contextLength: parsed });
}

async function updateModelCustom(m: ProxyModel, patch: Partial<ModelCustomEntry>) {
  const mc = { ...(app.config.proxy.modelCustom || {}) };
  const cur = { ...(mc[m.id] || {}) };
  const next = { ...cur, ...patch };

  if (!next.contextLength || next.contextLength <= 0) delete next.contextLength;
  if (!next.maxOutputTokens || next.maxOutputTokens <= 0) delete next.maxOutputTokens;
  if (!next.reasoningEffort) delete next.reasoningEffort;

  if (Object.keys(next).length > 0) mc[m.id] = next;
  else delete mc[m.id];

  app.config.proxy.modelCustom = mc;
  await persist(`模型 ${m.id} 自定义参数已生效`);
  await refresh();
}

// ===== 模型映射（别名）管理 =====
const aliasName = ref("");
const aliasTarget = ref("");
const aliases = computed<[string, string][]>(() => Object.entries(app.config.proxy.modelAliases || {}));

// ===== 反向模型映射管理（统一请求名 -> 各渠道实际模型） =====
const reverseName = ref("");
const reverseTargets = ref<Record<string, string>>({});
const reverseAliases = computed<[string, Record<string, string>][]>(() =>
  Object.entries(app.config.proxy.modelReverseAliases || {})
);

/** 渠道 → 模型列表的预分组：computed 只在 models 变化时重算一次，
 *  模板（反向映射表单的每渠道下拉）取直值，不再每渲染每渠道全量 filter（O(渠道×模型)） */
const modelsByChannel = computed<Record<string, ProxyModel[]>>(() => {
  const map: Record<string, ProxyModel[]> = {};
  for (const c of channels.value) map[c.id] = [];
  for (const m of models.value) {
    for (const src of m.sources) {
      if (map[src]) map[src].push(m);
    }
  }
  return map;
});
function channelModels(chId: string) {
  return modelsByChannel.value[chId] || [];
}

async function addReverseAlias() {
  const name = reverseName.value.trim();
  if (!name) return;
  const targetMap: Record<string, string> = {};
  for (const [ch, target] of Object.entries(reverseTargets.value)) {
    if (target && target.trim()) targetMap[ch] = target.trim();
  }
  if (!Object.keys(targetMap).length) {
    err.value = "至少为一个渠道选择目标模型";
    return;
  }
  const rev = { ...(app.config.proxy.modelReverseAliases || {}) };
  rev[name] = targetMap;
  app.config.proxy.modelReverseAliases = rev;
  reverseName.value = "";
  reverseTargets.value = {};
  await persist(`反向映射 ${name} 已生效`);
  await refresh();
}

async function removeReverseAlias(name: string) {
  const rev = { ...(app.config.proxy.modelReverseAliases || {}) };
  delete rev[name];
  app.config.proxy.modelReverseAliases = rev;
  await persist(`已移除反向映射 ${name}`);
  await refresh();
}

function editReverseAlias(name: string, targetMap: Record<string, string>) {
  reverseName.value = name;
  reverseTargets.value = { ...targetMap };
}

async function refresh() {
  try {
    models.value = await api.proxyModels();
    channels.value = await api.proxyPool().catch(() => channels.value);
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

/** 管理态写回整体配置（save 即热生效；保存后重拉对齐服务端口径） */
async function persist(successMsg: string) {
  const r = await app.save();
  if (r && r.ok === false) {
    err.value = r.message || "保存失败";
    return;
  }
  msg.value = successMsg;
  setTimeout(() => (msg.value = ""), 2000);
}

/** 启停开关：默认开；关闭即写入 disabledModels 落盘（软件记录，重启保持） */
async function toggleEnabled(m: ProxyModel, v: string | number | boolean) {
  const on = !!v;
  const list = new Set(app.config.proxy.disabledModels || []);
  if (on) list.delete(m.id);
  else list.add(m.id);
  app.config.proxy.disabledModels = [...list];
  await persist(on ? `已启用 ${m.id}` : `已禁用 ${m.id}`);
  await refresh();
}

async function setOverride(m: ProxyModel, v: string) {
  const ov = { ...(app.config.proxy.modelOverrides || {}) };
  if (v) ov[m.id] = v as ProxyChannelId;
  else delete ov[m.id];
  app.config.proxy.modelOverrides = ov;
  await persist(v ? `${m.id} → 固定走 ${channelName(v)}` : `${m.id} 恢复自动路由`);
  await refresh();
}

async function addAlias() {
  const from = aliasName.value.trim();
  const to = aliasTarget.value;
  if (!from || !to) return;
  if (from === to) {
    err.value = "别名与目标模型不能相同";
    return;
  }
  const al = { ...(app.config.proxy.modelAliases || {}) };
  al[from] = to;
  app.config.proxy.modelAliases = al;
  aliasName.value = "";
  aliasTarget.value = "";
  await persist(`映射 ${from} → ${to} 已生效`);
}

async function removeAlias(from: string) {
  const al = { ...(app.config.proxy.modelAliases || {}) };
  delete al[from];
  app.config.proxy.modelAliases = al;
  await persist(`已移除映射 ${from}`);
}

/** 拉取官方模型目录（云端接口，用号池账号 token，不依赖本地软件）：写回 rules/catalog.json 热生效 */
async function syncCatalog(channel: string) {
  if (syncing.value) return;
  syncing.value = channel;
  try {
    const r = await api.proxyModelsSync(channel);
    if (r && r.ok === false) err.value = r.message || "拉取失败";
    else {
      const rateInfo = r.withRate ? `，其中 ${r.withRate} 个含倍率` : "";
      msg.value = `已拉取 ${r.count ?? 0} 个模型到 ${channelName(channel)}目录${rateInfo}`;
      setTimeout(() => (msg.value = ""), 3000);
    }
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    syncing.value = "";
    await refresh();
  }
}

/** 全部渠道并发拉取：逐渠道汇总结果，部分失败不拖垮整体 */
async function syncAll() {
  if (syncing.value) return;
  syncing.value = "__all__";
  try {
    const results = await Promise.all(channels.value.map((c) => api.proxyModelsSync(c.id).catch((e) => ({ ok: false as const, message: String((e as Error).message || e) }))));
    const okParts: string[] = [];
    const failParts: string[] = [];
    results.forEach((r, i) => {
      const name = channelName(channels.value[i].id);
      if (r && r.ok !== false) okParts.push(`${name} ${r.count ?? 0} 个`);
      else failParts.push(`${name}：${(r && r.message) || "失败"}`);
    });
    if (okParts.length) {
      msg.value = `已拉取 ${okParts.join("、")}`;
      setTimeout(() => (msg.value = ""), 3000);
    }
    if (failParts.length) err.value = failParts.join("；");
  } finally {
    syncing.value = "";
    await refresh();
  }
}

onMounted(refresh);
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>

      <!-- 顶部三大 Tab：合并模型目录 / 自定义模型映射 / 全渠道反向模型映射 + 路由说明按钮 -->
      <div class="models-main-tabs">
        <button class="main-tab-btn" :class="{ active: mainTab === 'catalog' }" @click="mainTab = 'catalog'">
          {{ activeTab ? channelName(activeTab) + "模型目录" : "合并模型目录" }}
        </button>
        <button class="main-tab-btn" :class="{ active: mainTab === 'alias' }" @click="mainTab = 'alias'">
          自定义模型映射
        </button>
        <button class="main-tab-btn" :class="{ active: mainTab === 'reverse' }" @click="mainTab = 'reverse'">
          全渠道反向模型映射
        </button>
        <div style="flex: 1"></div>
        <button class="btn btn-ghost" @click="ruleDialogOpen = true">
          <i class="ph ph-info"></i>路由与切换规则
        </button>
      </div>

      <!-- Tab 1: 模型目录 -->
      <template v-if="mainTab === 'catalog'">
        <!-- 页头工具条：渠道分段选择器在左、搜索与官方目录拉取在右 -->
        <div class="models-head">
          <div class="seg">
            <button class="seg-item" :class="{ active: !activeTab }" @click="activeTab = ''">全部</button>
            <button
              v-for="c in tabChannels"
              :key="c.id"
              class="seg-item"
              :class="{ active: activeTab === c.id }"
              @click="activeTab = c.id"
            >
              {{ c.display }}
            </button>
          </div>
          <span class="head-tools">
            <label class="search-box">
              <i class="ph ph-magnifying-glass"></i>
              <input v-model="filter" class="search-input" placeholder="搜索模型" spellcheck="false" />
              <el-tooltip v-if="filter" content="清空搜索" placement="top">
                <button class="search-clear" @click.prevent="filter = ''"><i class="ph ph-x"></i></button>
              </el-tooltip>
            </label>
            <button v-if="activeTab" class="btn btn-cta" :disabled="!!syncing" @click="syncCatalog(activeTab)">
              <i class="ph ph-cloud-arrow-down"></i>{{ syncing === activeTab ? "拉取中…" : "拉取模型" }}
            </button>
            <button v-else class="btn btn-cta" :disabled="!!syncing" @click="syncAll">
              <i class="ph ph-cloud-arrow-down"></i>{{ syncing === "__all__" ? "拉取中…" : "全部拉取" }}
            </button>
          </span>
          <Transition name="headmsg">
            <span v-if="msg" class="head-msg tag tag-ok">{{ msg }}</span>
          </Transition>
        </div>

        <div class="card" style="margin-top: 10px">
          <div class="card-title">
            {{ activeTab ? channelName(activeTab) + "模型目录" : "合并模型目录" }}
            <span class="right">{{ rows.length }} 个模型 · 保存即热生效</span>
          </div>
          <div class="table-scroll" style="overflow-x: hidden">
            <table class="table table-bare" style="table-layout: fixed; width: 100%">
              <colgroup>
                <col style="width: auto; min-width: 150px" />
                <!-- 上下文列：输入框 62px + 自badge 21px + 左右 padding 24px = 107px 起步（显示 131K / 1M 缩写） -->
                <col style="width: 108px" />
                <!-- 思考强度列：select 90px + 自badge 21px + 左右 padding 24px = 135px 起步 -->
                <col style="width: 136px" />
                <col style="width: 58px" />
                <col style="width: 78px" />
                <col v-if="!activeTab" style="width: 110px" />
                <!-- 渠道覆盖列：select 固定 100px + 单元格左右 padding 各 12px = 124px 起步（118 仍差 6px） -->
                <col style="width: 124px" />
                <!-- 状态列：开关固定 40px + 单元格左右 padding 各 12px = 64px 起步。
                     48px 的内容区只有 24px，开关必然溢出被裁（4K@200% 报障的直接原因） -->
                <col style="width: 68px" />
              </colgroup>
              <thead>
                <tr>
                  <th>模型</th>
                  <th>上下文</th>
                  <th>思考强度</th>
                  <th>倍率</th>
                  <th>能力</th>
                  <th v-if="!activeTab">来源渠道</th>
                  <th>渠道覆盖</th>
                  <th style="text-align: center">状态</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(m, i) in rows" :key="m.id" :style="{ '--i': i }">
                  <td style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                    <el-tooltip :content="m.id" placement="top">
                      <div class="mono" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ m.id }}</div>
                    </el-tooltip>
                    <el-tooltip v-if="m.name && m.name !== m.id" :content="m.name" placement="top">
                      <div class="model-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ m.name }}</div>
                    </el-tooltip>
                  </td>
                  <td>
                    <div class="custom-cell">
                      <!-- 非编辑态显示 K/M 缩写（131K / 1M），聚焦时才展开成完整数字：
                           列宽只有 90px，直接显示 131072 必然被裁。tooltip 同步显示精确值 -->
                      <el-tooltip :content="ctxTip(m)" placement="top">
                        <input
                          type="text"
                          class="f-input custom-input"
                          style="width: 62px"
                          :value="ctxDraft[m.id] ?? ctxDisplay(m)"
                          placeholder="自动"
                          @focus="ctxDraft[m.id] = String(ctxValue(m) || '')"
                          @input="ctxDraft[m.id] = ($event.target as HTMLInputElement).value"
                          @change="commitCtx(m)"
                          @blur="commitCtx(m)"
                          @keydown.enter="($event.target as HTMLInputElement).blur()"
                        />
                      </el-tooltip>
                      <el-tooltip v-if="(app.config.proxy.modelCustom || {})[m.id]?.contextLength" content="已自定义覆盖上下文" placement="top">
                        <span class="custom-badge">自</span>
                      </el-tooltip>
                    </div>
                  </td>
                  <td>
                    <div class="custom-cell">
                      <el-tooltip content="自定义思考强度，直接注入出站请求参数" placement="top">
                        <span>
                          <el-select
                            class="f-el-select custom-el-select"
                            popper-class="glass-popper"
                            :persistent="false"
                            :model-value="(app.config.proxy.modelCustom || {})[m.id]?.reasoningEffort || ''"
                            style="width: 90px"
                            placeholder="默认"
                            @update:model-value="(v: string) => updateModelCustom(m, { reasoningEffort: v })"
                          >
                            <el-option v-for="opt in REASONING_EFFORT_OPTIONS" :key="opt.value" :value="opt.value" :label="opt.label" />
                          </el-select>
                        </span>
                      </el-tooltip>
                      <el-tooltip v-if="(app.config.proxy.modelCustom || {})[m.id]?.reasoningEffort" content="已自定义覆盖思考强度" placement="top">
                        <span class="custom-badge">自</span>
                      </el-tooltip>
                    </div>
                  </td>
                  <td class="mono">{{ fmtRate(m.rate) }}</td>
                  <!-- 能力/来源渠道：列宽固定且内容可多值，悬停展开完整清单 -->
                  <td>
                    <el-tooltip placement="top" :show-after="120" :disabled="!capabilityTags(m).length" popper-class="glass-popper qa-tip">
                      <template #content>
                        <div class="tip-title">模型能力</div>
                        <div v-for="n in capabilityNames(m)" :key="n" class="tip-line">· {{ n }}</div>
                        <div v-if="ctxValue(m)" class="tip-line">· 上下文 {{ fmtCtx(ctxValue(m)) }}（{{ ctxValue(m).toLocaleString("en-US") }}）</div>
                      </template>
                      <span class="tip-host" :class="{ 'can-tip': capabilityTags(m).length }">
                        <span v-for="t in capabilityTags(m)" :key="t" class="tag tag-dim" style="margin-right: 3px; font-size: 10px; padding: 1px 4px">{{ t }}</span>
                        <span v-if="!capabilityTags(m).length" style="color: var(--text-3)">—</span>
                      </span>
                    </el-tooltip>
                  </td>
                  <td v-if="!activeTab">
                    <el-tooltip placement="top" :show-after="120" :disabled="m.sources.length <= 1" popper-class="glass-popper qa-tip">
                      <template #content>
                        <div class="tip-title">来源渠道（{{ m.sources.length }}）</div>
                        <div v-for="s in m.sources" :key="s" class="tip-line">· {{ channelName(s) }}</div>
                      </template>
                      <span class="tip-host" :class="{ 'can-tip': m.sources.length > 1 }">
                        <span v-for="s in m.sources" :key="s" class="tag tag-dim" style="margin-right: 3px; font-size: 10px; padding: 1px 4px">{{ channelName(s) }}</span>
                      </span>
                    </el-tooltip>
                  </td>
                  <td>
                    <el-tooltip :content="m.sources.length === 1 ? '单源模型强制走所属渠道，无需覆盖' : ''" :disabled="m.sources.length !== 1" placement="top">
                      <span>
                        <el-select
                          class="f-el-select"
                          popper-class="glass-popper"
                          :persistent="false"
                          style="width: 100px"
                          :model-value="m.override"
                          :disabled="!m.enabled || m.sources.length === 1"
                          @update:model-value="(v: string) => setOverride(m, v)"
                        >
                          <el-option
                            v-for="o in CHANNEL_OPTIONS.filter((o) => !o.value || m.sources.includes(o.value as ProxyChannelId))"
                            :key="o.value"
                            :value="o.value"
                            :label="o.label"
                          />
                        </el-select>
                      </span>
                    </el-tooltip>
                  </td>
                  <td style="text-align: center">
                    <div
                      class="switch"
                      :class="{ on: m.enabled }"
                      role="switch"
                      :aria-checked="!!m.enabled"
                      @click="toggleEnabled(m, !m.enabled)"
                    ></div>
                  </td>
                </tr>
                <tr v-if="!rows.length">
                  <td :colspan="activeTab ? 7 : 8" style="text-align: center; color: var(--text-3); padding: 24px 0">
                    无匹配模型 —— 点上方「拉取模型」从官方目录云端同步（用号池账号 token，不依赖本地软件）
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>

      <!-- Tab 2: 自定义模型映射 -->
      <div v-else-if="mainTab === 'alias'" class="card">
        <div class="card-title">
          自定义模型映射
          <span class="right">客户端请求别名 → 实际模型 · 响应模型字段保持请求值</span>
        </div>
        <div class="alias-form">
          <input v-model="aliasName" class="input" style="width: 220px" placeholder="别名（如 gpt-4o）" />
          <span class="alias-arrow">→</span>
          <el-select v-model="aliasTarget" class="f-el-select" popper-class="glass-popper" :persistent="false" style="width: 260px" placeholder="目标模型" filterable>
            <el-option v-for="m in models" :key="m.id" :value="m.id" :label="m.id" />
          </el-select>
          <button class="btn" :disabled="!aliasName.trim() || !aliasTarget" @click="addAlias">添加映射</button>
        </div>
        <div v-if="aliases.length" class="alias-list">
          <span v-for="[from, to] in aliases" :key="from" class="tag tag-dim alias-item">
            <span class="mono">{{ from }}</span> → <span class="mono">{{ to }}</span>
            <el-tooltip content="移除映射" placement="top">
              <button class="alias-del" @click="removeAlias(from)">×</button>
            </el-tooltip>
          </span>
        </div>
        <div v-else class="set-desc" style="margin-top: 8px; color: var(--text-3)">
          暂无映射 —— 例如把 gpt-4o 映射到 kimi-k3，客户端按 gpt-4o 请求即自动走 kimi-k3
        </div>
      </div>

      <!-- Tab 3: 全渠道反向模型映射 -->
      <div v-else-if="mainTab === 'reverse'" class="card">
        <div class="card-title">
          全渠道反向模型映射
          <span class="right">统一请求名 → 各渠道实际模型 · 响应模型字段保持请求名</span>
        </div>
        <div class="set-desc" style="margin-bottom: 10px">
          解决不同渠道同一模型命名不一致（例如 Trae 的 glm-5.3 与 WorkBuddy/ZCode 的名称不同）。客户端按统一名称请求，网关根据路由渠道自动发给对应渠道的模型名。
        </div>
        <div class="rev-form">
          <div class="rev-row">
            <span class="rev-label">统一请求名：</span>
            <input v-model="reverseName" class="input" style="width: 240px" placeholder="统一名称（如 glm-5.3-flash）" />
          </div>
          <div class="rev-channels-grid">
            <div v-for="c in channels" :key="c.id" class="rev-ch-item">
              <span class="rev-ch-label">{{ c.display }}：</span>
              <el-select
                class="f-el-select"
                popper-class="glass-popper"
                :persistent="false"
                style="width: 190px"
                :model-value="reverseTargets[c.id] || ''"
                placeholder="（不映射此渠道）"
                filterable
                @update:model-value="(v: string) => reverseTargets[c.id] = v"
              >
                <el-option value="" label="（不映射此渠道）" />
                <el-option v-for="cm in channelModels(c.id)" :key="cm.id" :value="cm.id" :label="cm.id" />
              </el-select>
            </div>
          </div>
          <div class="rev-actions">
            <button class="btn btn-cta" :disabled="!reverseName.trim()" @click="addReverseAlias">
              <i class="ph ph-plus"></i>保存反向映射
            </button>
            <button v-if="reverseName" class="btn" style="margin-left: 8px" @click="reverseName = ''; reverseTargets = {}">
              重置
            </button>
          </div>
        </div>
        <div v-if="reverseAliases.length" class="rev-list">
          <div v-for="[uname, cmap] in reverseAliases" :key="uname" class="rev-card-item">
            <div class="rev-card-head">
              <span class="mono rev-card-title">{{ uname }}</span>
              <div class="rev-card-btns">
                <el-tooltip content="编辑映射" placement="top">
                  <button class="btn btn-sm" @click="editReverseAlias(uname, cmap)"><i class="ph ph-pencil-simple"></i>编辑</button>
                </el-tooltip>
                <el-tooltip content="移除映射" placement="top">
                  <button class="btn btn-sm btn-del" @click="removeReverseAlias(uname)"><i class="ph ph-trash"></i>删除</button>
                </el-tooltip>
              </div>
            </div>
            <div class="rev-card-routes">
              <span v-for="(target, ch) in cmap" :key="ch" class="tag tag-dim rev-route-tag">
                <span class="rev-route-ch">{{ channelName(ch) }}</span>：<span class="mono">{{ target }}</span>
              </span>
            </div>
          </div>
        </div>
        <div v-else class="set-desc" style="margin-top: 10px; color: var(--text-3)">
          暂无反向映射 —— 输入统一名称并为各渠道指定对应实际模型后点保存即可生效。
        </div>
      </div>
    </div>

    <!-- 路由与切换规则小弹窗 -->
    <Teleport to="body">
      <div v-if="ruleDialogOpen" class="p-mask" @click.self="ruleDialogOpen = false">
        <div class="p-dlg glass rule-dlg" role="dialog" aria-modal="true" aria-label="路由与切换规则">
          <header class="rule-head">
            <div class="rule-head-left">
              <span class="rule-head-icon"><i class="ph ph-git-fork"></i></span>
              <div class="rule-head-text">
                <div class="rule-title">路由与切换规则</div>
                <div class="rule-sub">网关请求调度与模型切换说明</div>
              </div>
            </div>
            <el-tooltip content="关闭" placement="top">
              <button class="rule-close" @click="ruleDialogOpen = false"><i class="ph ph-x"></i></button>
            </el-tooltip>
          </header>
          <div class="rule-body">
            <div class="rule-item"><b>1. 渠道路由：</b>模型仅存在于单渠道 → 强制走该渠道；多源重叠 → per-model 覆盖优先，否则按路由策略打分。</div>
            <div class="rule-item"><b>2. 自定义模型映射：</b>请求入口先把别名解析为实际模型再路由（响应模型字段保持请求值）。</div>
            <div class="rule-item"><b>3. 反向模型映射：</b>一个统一请求名映射到各渠道不同模型名，渠道确定后自动转为该渠道模型转发（响应保持统一请求名）。</div>
            <div class="rule-item"><b>4. 上下文与思考强度：</b>支持在表格中行内自定义覆盖，修改后即时注入出站参数并反映在模型目录。</div>
            <div class="rule-item"><b>5. 全局回退降级：</b>模型未知或号池耗尽 → 按配置页「不可用时自动切换模型」统一设置切到全局回退模型（客户端无感）。</div>
            <div class="rule-item"><b>6. 模型级负缓存：</b>模型级限流（6004）/ 该号不支持（11102）→ 只冷却「账号×模型」组合，切模型即豁免。</div>
            <div class="rule-item"><b>7. 用量统计标记：</b>切换命中会在用量明细的备注列标记 alias→实际模型 / rev→实际模型 / fallback→实际模型。</div>
          </div>
          <footer class="rule-foot">
            <button class="btn btn-primary" @click="ruleDialogOpen = false">我知道了</button>
          </footer>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
/* ===== 顶部三大 Tab 切换按钮 ===== */
.models-main-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 10px;
}
.main-tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  background: var(--bg-soft);
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}
.main-tab-btn:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--panel);
}
.main-tab-btn.active {
  color: var(--accent-strong);
  border-color: var(--accent-line);
  background: var(--accent-dim);
}

/* ===== 路由与切换规则弹窗 ===== */
.p-mask {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.rule-dlg {
  width: 580px;
  max-width: 95vw;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-lg);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rule-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.rule-head-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.rule-head-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--r-sm);
  background: var(--accent-dim);
  color: var(--accent-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}
.rule-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}
.rule-sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}
.rule-close {
  background: transparent;
  border: none;
  font-size: 16px;
  color: var(--text-3);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--r-sm);
}
.rule-close:hover {
  color: var(--text);
  background: var(--bg-soft);
}
.rule-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-2);
  background: var(--code-bg);
  padding: 14px 16px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
}
.rule-item b {
  color: var(--text);
}
.rule-foot {
  display: flex;
  justify-content: flex-end;
}

/* ===== 页头工具条：分段选择器 + 搜索 + 拉取，一条 30px 控件线；反馈消息浮层不占布局 ===== */
.models-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.head-tools {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* 渠道分段选择器：容器框住选项，选中项点亮（与号池弹窗的方式切换同一语言）；
   容器 padding 3px + 内项 22px + 边框 = 30px，与右侧 .btn / 搜索框同高成一条线 */
.seg {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
.seg-item {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: calc(var(--r-sm) - 3px);
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  font-family: var(--font-ui);
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.2s;
}
.seg-item:hover {
  color: var(--text);
}
.seg-item.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
  font-weight: 600;
  box-shadow: 0 0 10px -6px var(--accent-line);
}
.seg-item:focus-visible {
  outline: 2px solid var(--accent-line);
  outline-offset: 1px;
}
/* 搜索框：图标 + 无框输入 + 快捷清空；聚焦时整框点亮主色并给图标染色 */
.search-box {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: 210px;
  height: var(--ctl-h);
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.search-box:focus-within {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
.search-box > .ph {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-3);
  transition: color 0.2s;
}
.search-box:focus-within > .ph {
  color: var(--accent-strong);
}
.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  outline: none;
  color: var(--text);
  font-size: 12px;
  font-family: var(--font-ui);
}
.search-input::placeholder {
  color: var(--text-3);
}
.search-clear {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.search-clear:hover {
  color: var(--text);
  background: var(--line);
}
/* 拉取按钮里的云下载图标与文字同高（.btn 自带 6px 图文间距） */
.head-tools .btn .ph {
  font-size: 13px;
}
/* 拉取反馈：浮在工具条下缘，进出均不挤动任何布局 */
.head-msg {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 6;
  max-width: min(560px, 82%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  box-shadow: 0 8px 24px -12px rgba(0, 0, 0, 0.6);
}
.headmsg-enter-active,
.headmsg-leave-active {
  transition: opacity 0.25s var(--ease), transform 0.25s var(--ease);
}
.headmsg-enter-from,
.headmsg-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@media (prefers-reduced-motion: reduce) {
  .headmsg-enter-active,
  .headmsg-leave-active {
    transition: none;
  }
}
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
.model-name {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}
.alias-form {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.alias-arrow {
  color: var(--text-3);
}
.alias-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.alias-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.alias-del {
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
}
.alias-del:hover {
  color: var(--err, #e05555);
}
/* 自定义单元格（上下文与思考强度） */
.custom-cell {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.custom-input {
  height: 26px;
  padding: 0 6px;
  font-size: 11.5px;
  border-radius: var(--r-sm);
  background: var(--bg-soft);
  border: 1px solid var(--line);
  color: var(--text);
  font-family: var(--font-mono);
}
.custom-input:focus {
  border-color: var(--accent-line);
}
.custom-el-select :deep(.el-select__wrapper) {
  min-height: 26px;
  height: 26px;
  font-size: 11.5px;
  padding: 0 8px;
}
.custom-badge {
  margin-left: 4px;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 9px;
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-weight: 600;
  line-height: 1;
}

/* 能力 / 来源渠道列的悬停浮窗：内容多值时展开完整清单。
   宿主保持 inline-block 收在列宽内，浮窗走 teleport，不改变行高与列宽 */
.tip-host {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 有可展开内容时才给 help 光标，暗示可悬停（浮窗禁用时不误导） */
.tip-host.can-tip {
  cursor: help;
}
.tip-title {
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}
.tip-line {
  color: var(--text-2);
  line-height: 1.6;
  white-space: nowrap;
}

/* 反向模型映射卡片样式 */
.rev-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
.rev-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rev-label {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}
.rev-channels-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}
.rev-ch-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rev-ch-label {
  font-size: 11px;
  color: var(--text-3);
  width: 90px;
  text-align: right;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rev-actions {
  display: flex;
  align-items: center;
}
.rev-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.rev-card-item {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
.rev-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.rev-card-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
}
.rev-card-btns {
  display: flex;
  align-items: center;
  gap: 6px;
}
.btn-sm {
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
}
.btn-del:hover {
  color: var(--err, #e05555);
}
.rev-card-routes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.rev-route-tag {
  font-size: 11px;
}
.rev-route-ch {
  color: var(--text-3);
}
</style>

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
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useAppStore } from "../../stores/app";
import { useLocalgwStore } from "../../stores/localgw";
import * as localgwApi from "../../api/localgw";
// 渠道名称与图标必须与「上游启闭」弹窗逐项一致：直接复用同一份实现
// （ProxyUpstreamDialog.vue:109-113 用 CHANNEL_ICONS[row.id] / channelInitial(row.id, row.display)，
//  名称用 row.display || channelName(row.id)），本页不再自己拼名字或另存一张图标表
import { channelName } from "../proxy/format";
import { CHANNEL_ICONS, channelInitial } from "../proxy/channelIcons";

const app = useAppStore();
const lgw = useLocalgwStore();

/** 三主 Tab：catalog 模型目录 / alias 别名 / custom 覆盖与自定义 */
const mainTab = ref<"catalog" | "alias" | "custom">("catalog");
/** 保存中标志：避免连点重复提交 */
const saving = ref(false);

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

const rows = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return lgw.models.filter((m) => {
    if (channelTab.value && text(m.channel) !== channelTab.value) return false;
    if (sourceFilter.value !== "all" && text(m.source) !== sourceFilter.value) return false;
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
  return { total, overrides, aliases, customs };
});

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
  return Object.entries(map).map(([from, to]) => ({ from, to: String(to) }));
});
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
async function removeRule(kind: "aliases" | "overrides" | "custom", name: string, label: string) {
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

/** 渠道下拉候选：优先有账号的渠道，退化为全清单；名称口径与切换条 / 上游启闭一致 */
const channelOptions = computed(() => {
  const list = lgw.channels.length ? lgw.channels : lgw.allChannels;
  return list.map((c) => ({
    id: c.id,
    display: channelDisplayById.value.get(c.id) || channelName(c.id),
  }));
});

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
          <!-- 「在 /v1/models 中暴露」：旧版的全局开关位置在 tab 行右侧 -->
          <span class="seg-label">在 /v1/models 中暴露</span>
          <el-switch :model-value="exposeOn" :loading="saving" @update:model-value="(v: any) => exposeToggle(v)" />
        </div>

        <!-- ===== Tab 1：模型目录 ===== -->
        <template v-if="mainTab === 'catalog'">
          <div class="models-head">
            <div class="seg-group">
              <span class="seg-label">渠道</span>
              <div class="seg">
                <button class="seg-item" :class="{ active: !channelTab }" @click="channelTab = ''">全部</button>
                <button
                  v-for="c in tabChannels"
                  :key="c.id"
                  class="seg-item seg-item-ico"
                  :class="{ active: channelTab === c.id }"
                  @click="channelTab = c.id"
                >
                  <!-- 图标与「上游启闭」弹窗同源（26px 圆角方块内 18px 图片；无图标回落首字母） -->
                  <span class="seg-ico">
                    <img v-if="c.icon" :src="c.icon" alt="" loading="lazy" />
                    <b v-else>{{ c.initial }}</b>
                  </span>
                  {{ c.display }}
                </button>
              </div>
            </div>
            <span class="head-tools">
              <div class="seg-group">
                <span class="seg-label">来源</span>
                <div class="seg">
                  <button class="seg-item" :class="{ active: sourceFilter === 'all' }" @click="sourceFilter = 'all'">全部</button>
                  <button class="seg-item" :class="{ active: sourceFilter === 'channel' }" @click="sourceFilter = 'channel'">渠道</button>
                  <button class="seg-item" :class="{ active: sourceFilter === 'override' }" @click="sourceFilter = 'override'">覆盖</button>
                  <button class="seg-item" :class="{ active: sourceFilter === 'alias' }" @click="sourceFilter = 'alias'">别名</button>
                  <button class="seg-item" :class="{ active: sourceFilter === 'custom' }" @click="sourceFilter = 'custom'">自定义</button>
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
              <span class="right">{{ rows.length }} 个模型 · 保存即热生效</span>
            </div>
            <div class="table-scroll">
              <table class="table table-bare tbl-static" style="table-layout: fixed; width: 100%">
                <!-- 定宽列：对外名自适应，其余按内容固定（照搬旧版 colgroup 做法） -->
                <colgroup>
                  <col style="width: auto; min-width: 180px" />
                  <col style="width: 220px" />
                  <col style="width: 110px" />
                  <col style="width: 130px" />
                </colgroup>
                <thead>
                  <tr>
                    <th>对外模型名</th>
                    <th>实际模型</th>
                    <th>渠道</th>
                    <th>来源</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="m in rows" :key="`${m.id}|${m.source}`">
                    <td class="mono">{{ text(m.display) || "—" }}</td>
                    <td class="mono">{{ text(m.realModel) || "—" }}</td>
                    <td>{{ text(m.channel) || "—" }}</td>
                    <td><span class="tag" :class="sourceCls(text(m.source))">{{ sourceLabel(text(m.source)) }}</span></td>
                  </tr>
                  <!-- 空态双分支：有筛选给「清空筛选」，没筛选给引导（旧版 599-609 行） -->
                  <tr v-if="!rows.length">
                    <td colspan="4" class="empty-cell">
                      <template v-if="hasFilter">
                        当前筛选没有匹配的模型
                        <button class="btn-link" style="margin-left: 6px" @click="clearFilter">清空筛选 →</button>
                      </template>
                      <template v-else>
                        暂无模型 —— 先到「路由与渠道」启用至少一个渠道，并到号池管家刷新模型目录
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
          <!-- 覆盖：把某个模型固定路由到指定渠道 -->
          <div class="card">
            <div class="card-title">
              模型覆盖
              <span class="right">{{ overrides.length }} 条 · 指定渠道优先于自动路由</span>
            </div>
            <div class="alias-form">
              <input v-model="ovModel" class="f-input" placeholder="对外模型名" spellcheck="false" />
              <input v-model="ovReal" class="f-input" placeholder="实际模型名" spellcheck="false" />
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
              <span class="right">{{ customs.length }} 条 · 渠道没有但你想暴露的模型名</span>
            </div>
            <div class="alias-form">
              <input v-model="cuModel" class="f-input" placeholder="对外模型名" spellcheck="false" />
              <input v-model="cuReal" class="f-input" placeholder="实际模型名" spellcheck="false" />
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
        </template>

        <!-- 口径说明：暴露开关关掉时对外可见集合会收窄，容易让人以为模型丢了 -->
        <div class="card">
          <div class="card-title">口径说明</div>
          <div class="s-desc">
            开启「在 /v1/models 中暴露」：<code class="mono">GET /v1/models</code> 返回全部启用渠道的合并视图；
            关闭则只返回覆盖 / 别名 / 自定义三张表的显式声明。
            当前共 {{ stats.total }} 个模型：覆盖 {{ stats.overrides }} · 别名 {{ stats.aliases }} · 自定义 {{ stats.customs }}。
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
/* 错误红卡（旧版 6 页各自声明一份，照旧版做法保留页内） */
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
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
</style>

<!-- 反代网关 · 生态接入（CC Switch）：把 AgentHub 网关注册为 CC Switch 的 provider 条目，
     上游格式 = OpenAI Chat Completions（http://127.0.0.1:{port}/v1），Claude Code / Codex / Claude Desktop 的原生协议
     由 CC Switch 翻译后再打到网关；注册前自动备份 CC Switch 数据库，且只 upsert 固定 id 条目 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import * as api from "../../api/ipc";
import type { CcSwitchStatus, CcSwitchRegisterResult, CcSwitchAppType, ProxyKeyRow, ProxyModel } from "../../types";
import { useAppStore } from "../../stores/app";

const app = useAppStore();
const st = ref<CcSwitchStatus | null>(null);
const keys = ref<ProxyKeyRow[]>([]);
const models = ref<ProxyModel[]>([]);
const keyId = ref("");
const model = ref("");
const busy = ref<CcSwitchAppType | "">("");
const result = ref<CcSwitchRegisterResult | null>(null);
const err = ref("");
const saved = ref(false); // 默认模型已写回配置

const APP_LABELS: Record<CcSwitchAppType, string> = {
  claude: "Claude Code",
  codex: "Codex",
  "claude-desktop": "Claude Desktop",
};

const installed = computed(() => !!st.value?.installed);
const incompatible = computed(() => !!st.value?.incompatible);
/** CC Switch 的「本地路由」未开启时不会做协议转换，直连网关必 404（Claude /v1/messages、Codex /v1/responses、Desktop 映射模式失联） */
const needsTakeover = computed(() =>
  (["claude", "codex", "claude-desktop"] as const).filter((t) => entry(t)?.registered && !takeoverOf(t)),
);
const port = computed(() => app.config?.proxy?.port ?? 9527);
const keyOpts = computed(() => keys.value.filter((k) => k.enabled));
/** 模型占位：未选时用全局回退模型 */
const fallback = computed(() => app.config?.proxy?.fallbackModel || "");

/** 内部条目：模型目录里不对外的子代理 / 占位模板（归组置底，仍可选） */
const INTERNAL_MODEL_RE = /sub_?agent|^summary$|^file_search|^computer_use|^browser_use|^custom_model_/i;
const normalModels = computed(() => models.value.filter((m) => !INTERNAL_MODEL_RE.test(m.id)));
const internalModels = computed(() => models.value.filter((m) => INTERNAL_MODEL_RE.test(m.id)));
/** 当前值已失效（目录里没有）时补一个占位项，避免下拉显示空白让人误以为没配置 */
const staleModel = computed(() => {
  const v = model.value.trim();
  if (!v || models.value.some((m) => m.id === v)) return "";
  return v;
});

function entry(appType: CcSwitchAppType) {
  return (st.value?.entries || []).find((x) => x.appType === appType);
}

/** 各应用的本地路由接管状态：claude-desktop 无独立行，读全局代理网关在线状态（takeover.claudeDesktop） */
function takeoverOf(appType: CcSwitchAppType) {
  const tk = st.value?.takeover;
  if (!tk) return false;
  return appType === "claude-desktop" ? !!tk.claudeDesktop : !!tk[appType];
}

/** 提示语里的条目名：用后端回传的真实名（与 CC Switch 列表一致），
 *  拿不到时退回注册后刷新到的状态，避免前端另拼一套名字造成对不上 */
function registeredName(r: CcSwitchRegisterResult) {
  return r.name || entry(r.appType as CcSwitchAppType)?.name || "AgentHub 网关";
}

const refreshing = ref(false);
const refreshTip = ref<"" | "ok" | "fail">("");

async function refresh(): Promise<boolean> {
  refreshing.value = true;
  try {
    st.value = await api.proxyCcSwitchStatus();
    return true;
  } catch (e) {
    err.value = String((e as Error).message || e);
    // 失败也要结束「检测中」态：否则 st 恒为 null，卡片会永远停在检测中
    st.value = { installed: false };
    return false;
  } finally {
    refreshing.value = false;
  }
}

/** 手动刷新的行内反馈：结果在按钮上短暂提示（进页/注册后的自动刷新不提示） */
let refreshTipTimer: ReturnType<typeof setTimeout> | undefined;
async function manualRefresh() {
  const ok = await refresh();
  refreshTip.value = ok ? "ok" : "fail";
  clearTimeout(refreshTipTimer);
  refreshTipTimer = setTimeout(() => (refreshTip.value = ""), 2000);
}

async function loadKeys() {
  try {
    keys.value = (await api.proxyKeysList()) || [];
    if (!keyId.value && keyOpts.value.length) keyId.value = keyOpts.value[0].id;
  } catch {
    /* Key 列表失败不阻断页面（空态提示去 API Keys 页） */
  }
}

async function loadModels() {
  try {
    models.value = (await api.proxyModels()) || [];
  } catch {
    /* 模型目录失败不阻断页面（下拉退化为仅当前值） */
  }
}

async function register(appType: CcSwitchAppType) {
  if (busy.value) return;
  busy.value = appType;
  err.value = "";
  result.value = null;
  try {
    const key = keys.value.find((k) => k.id === keyId.value);
    if (!key || !key.secret) {
      err.value = "请选择可用的网关 API Key（列表中的 Key 需要带完整密钥）";
      return;
    }
    const r = await api.proxyCcSwitchRegister({
      appType,
      apiKey: key.secret,
      model: (model.value || fallback.value || "").trim(),
      port: port.value,
    });
    if (r?.ok) {
      result.value = r;
      await refresh();
    } else {
      err.value = r?.message || "注册失败";
    }
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    busy.value = "";
  }
}

/** 默认模型写回配置（缺省用 fallbackModel），下次注册生效。
 *  提示语在保存完成后保留 2 秒：落盘是本地 IPC，几乎瞬间返回，若在保存前置位会一闪而过 */
let savedTimer: ReturnType<typeof setTimeout> | undefined;
async function onModelChange() {
  if (!app.config?.proxy) return;
  app.config.proxy.ccSwitchModel = model.value.trim();
  saved.value = false;
  const r = await app.save();
  if (r && r.ok === false) {
    err.value = r.message || "默认模型保存失败";
    return;
  }
  err.value = "";
  saved.value = true;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (saved.value = false), 2000);
}

onMounted(() => {
  model.value = ((app.config?.proxy?.ccSwitchModel || app.config?.proxy?.fallbackModel || "") as string).trim();
  refresh();
  loadKeys();
  loadModels();
});
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <div class="page-title">生态接入</div>
        <div class="page-sub">把 AgentHub 网关注册为 CC Switch 的 provider，Claude Code / Codex / Claude Desktop 的协议翻译由 CC Switch 完成</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" :disabled="!installed || incompatible || busy === 'claude'" @click="register('claude')">
          {{ busy === "claude" ? "注册中…" : "注册 Claude Code" }}
        </button>
        <button class="btn btn-primary" :disabled="!installed || incompatible || busy === 'claude-desktop'" @click="register('claude-desktop')">
          {{ busy === "claude-desktop" ? "注册中…" : "注册 Claude Desktop" }}
        </button>
        <button class="btn btn-primary" :disabled="!installed || incompatible || busy === 'codex'" @click="register('codex')">
          {{ busy === "codex" ? "注册中…" : "注册 Codex" }}
        </button>
      </div>
    </div>
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>

      <div v-if="result && result.ok" class="card ok-card">
        <div class="set-desc">
          {{ result.action === "updated" ? "已更新已有条目（配置已同步）" : "已注册新条目" }}：<b>{{ registeredName(result) }}</b>
        </div>
        <div class="set-desc" style="margin-top: 6px">
          数据库：<span class="mono">{{ result.dbPath }}</span> · 写前备份：<span class="mono">{{ result.backupPath }}</span>
        </div>
        <div class="set-desc" style="margin-top: 6px">
          注册已写入，无需重启 CC Switch。还需在其「设置 → 本地路由」为该应用开启<b>本地路由</b>开关，并切换到该条目。<template v-if="result.appType === 'claude-desktop'">切换后需<b>完全退出并重启 Claude Desktop</b>（Desktop 不热加载配置，且使用期间 CC Switch 需保持运行）。</template>
        </div>
      </div>

      <!-- 接入状态与说明 -->
      <div class="card">
        <div class="card-title">
          CC Switch 接入状态
          <span class="right" style="display: inline-flex; align-items: center; gap: 8px">
            <span v-if="!st" class="tag tag-dim">检测中…</span>
            <span v-else-if="!installed" class="tag tag-warn">未安装</span>
            <span v-else-if="incompatible" class="tag tag-warn">库异常</span>
            <span v-else class="tag tag-ok">已就绪</span>
            <button
              class="btn btn-sm"
              :disabled="refreshing || !installed"
              :title="installed ? '' : '未检测到 CC Switch，无状态可刷新'"
              @click="manualRefresh"
            >
              {{ refreshing ? "刷新中…" : refreshTip === "ok" ? "已刷新" : refreshTip === "fail" ? "刷新失败" : "刷新状态" }}
            </button>
          </span>
        </div>
        <div v-if="!st" class="set-desc">正在检测本机 CC Switch…</div>
        <div v-else-if="!installed" class="set-desc">
          未检测到 CC Switch：请先下载安装 cc-switch（GitHub：farion1231/cc-switch）并启动一次，再回到这里注册。
        </div>
        <div v-else-if="incompatible" class="set-desc">检测到 CC Switch 数据库但结构不符，可能版本过旧；注册时会有更具体的报错。</div>
        <div v-else class="set-desc">
          网关协议为 OpenAI Chat Completions。Claude Code、Codex 与 Claude Desktop 的原生协议由
          CC Switch 翻译成 Chat Completions 再打到网关；每次注册前自动备份 CC Switch 数据库，且不修改其它 provider。
        </div>
        <div v-if="installed && !incompatible && needsTakeover.length" class="set-desc err-text" style="margin-top: 8px">
          检测到 {{ needsTakeover.map((t) => APP_LABELS[t]).join(" / ") }}
          已注册但未开启本地路由。CC Switch 只在本地路由开启时做协议转换，直接「打开终端」或普通切换会把原生请求打到网关而报 404。
        </div>
        <div v-else-if="installed && !incompatible" class="set-desc" style="margin-top: 8px">
          本地路由已开启；请勿使用条目的「打开终端」直连，那条路径不经过 CC Switch 协议转换。
        </div>
        <div class="kpis" style="margin-top: 12px">
          <div class="kpi"><span>网关地址</span><b class="mono">127.0.0.1:{{ port }}/v1</b></div>
          <div class="kpi"><span>Claude Code</span><b :class="entry('claude')?.registered ? 'acc' : ''">{{ entry("claude")?.registered ? "已注册" : "未注册" }}</b></div>
          <div class="kpi"><span>Claude Desktop</span><b :class="entry('claude-desktop')?.registered ? 'acc' : ''">{{ entry("claude-desktop")?.registered ? "已注册" : "未注册" }}</b></div>
          <div class="kpi"><span>Codex</span><b :class="entry('codex')?.registered ? 'acc' : ''">{{ entry("codex")?.registered ? "已注册" : "未注册" }}</b></div>
          <div class="kpi"><span>路由 · Claude Code</span><b :class="takeoverOf('claude') ? 'acc' : 'err'">{{ takeoverOf("claude") ? "已开启" : "未开启" }}</b></div>
          <div class="kpi"><span>路由 · Claude Desktop</span><b :class="takeoverOf('claude-desktop') ? 'acc' : 'err'">{{ takeoverOf("claude-desktop") ? "已开启" : "未开启" }}</b></div>
          <div class="kpi"><span>路由 · Codex</span><b :class="takeoverOf('codex') ? 'acc' : 'err'">{{ takeoverOf("codex") ? "已开启" : "未开启" }}</b></div>
          <div class="kpi"><span>数据库</span><b class="mono">{{ st?.dbPath || "-" }}</b></div>
        </div>
      </div>

      <!-- 注册参数：Key / 默认模型 -->
      <div class="card" style="margin-top: 12px">
        <div class="card-title">注册参数</div>
        <div class="set-desc" style="margin-bottom: 10px">
          网关 Key 与默认模型会写入条目配置（Claude 条目同时覆盖 Sonnet / Opus / Haiku / 子代理等模型字段；Claude Desktop 条目将四档角色路由全映射到该模型，
          菜单显示名同步为该模型以免与真实请求的模型不一致）；
          参数在点击注册时写入 CC Switch，修改后请重新注册以同步。注册后需在 CC Switch 为该应用开启本地路由，
          再切换到该条目；无需重启 CC Switch。
        </div>
        <div v-if="keyOpts.length" class="co-row">
          <span class="co-label">网关 API Key</span>
          <el-select v-model="keyId" popper-class="glass-popper" style="width: 300px">
            <el-option v-for="k in keyOpts" :key="k.id" :value="k.id" :label="`${k.name} · ${k.mask}`" />
          </el-select>
        </div>
        <div v-else class="set-desc err-text">还没有可用的网关 Key，请先到「API Keys」页生成</div>
        <div class="co-row" style="margin-top: 10px">
          <span class="co-label">默认模型</span>
          <el-select
            v-model="model"
            popper-class="glass-popper"
            filterable
            clearable
            style="width: 300px"
            :placeholder="`跟随全局回退模型：${fallback || '—'}`"
            @change="onModelChange"
          >
            <!-- 当前值已不在目录：补项显示，避免下拉空白让人误以为没配置 -->
            <el-option v-if="staleModel" :key="staleModel" :value="staleModel" :label="`${staleModel}（已不在模型目录）`" />
            <el-option-group v-if="normalModels.length" label="对话模型">
              <el-option v-for="m in normalModels" :key="m.id" :value="m.id" :label="m.enabled ? m.id : `${m.id}（已禁用）`" />
            </el-option-group>
            <el-option-group v-if="internalModels.length" label="内部条目">
              <el-option v-for="m in internalModels" :key="m.id" :value="m.id" :label="m.id" />
            </el-option-group>
          </el-select>
          <span v-if="saved" class="tag tag-ok">已保存 · 重新注册后同步</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
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
.co-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.co-label {
  min-width: 110px;
  font-size: 13px;
  color: var(--text-2);
}
</style>

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
<!-- 本地网关 · 生态接入（CC Switch）：把 AgentHub 网关注册为 CC Switch 的 provider 条目，
     上游格式 = OpenAI Chat Completions（http://127.0.0.1:{port}/v1），Claude Code / Codex / Claude Desktop 的原生协议
     由 CC Switch 翻译后再打到网关；注册前自动备份 CC Switch 数据库，且只 upsert 固定 id 条目。

     照搬 fdb3e55^ 的「反代网关 · 生态接入」页（旧文件 views/proxy/ProxyCcSwitchView.vue），
     与旧版的三处差异都是「数据源换实现」，页面结构与文案一字未改：
       ① 网关端口改读 localgw 的实际监听端口（旧版读已下线的转发服务 config.proxy.port）；
          ccswitch.cjs 在 port 缺省时自己会取 localgw 的监听端口，这里传值只为把「网关地址」格显示准。
       ② API Key / 模型下拉改读 localgw 的密钥表与模型目录（旧版的 proxyKeysList / proxyModels 通道已随
          反代网关下线一并移除）。⚠️ 密钥表的列表接口按设计**永不回传明文**（决策 3：完整 Key 只在创建时
          出现一次），而 ccswitch.register 必须有非空 apiKey，所以这里补一个「完整 Key」粘贴位，
          并用 keyPrefix（后端 raw.slice(0,12)）做一次归属校验——粘错一把 Key 会被拦下而不是静默写进客户端配置。
       ③ 保活 watch 的 activeModule 由 "proxy" 改为 "localgw"。 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import * as api from "../../api/ipc";
import type { CcSwitchStatus, CcSwitchRegisterResult, CcSwitchAppType, CcSwitchLiveRoute } from "../../types";
import { useAppStore } from "../../stores/app";
import { useLocalgwStore } from "../../stores/localgw";

const app = useAppStore();
const lgw = useLocalgwStore();
const st = ref<CcSwitchStatus | null>(null);
const keyId = ref("");
/** 完整网关 Key：列表接口只回前缀，明文只能由用户从「API Keys」页复制过来（见文件头 ②） */
const keySecret = ref("");
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
/** 注册参数卡里的「按所选应用注册」：与页头三个按钮走同一个 register()，只是入口不同 */
const appPick = ref<CcSwitchAppType>("claude");

const installed = computed(() => !!st.value?.installed);
const incompatible = computed(() => !!st.value?.incompatible);
/** CC Switch 的「本地路由」未开启时不会做协议转换，直连网关必 404（Claude /v1/messages、Codex /v1/responses、Desktop 映射模式失联） */
const needsTakeover = computed(() =>
  (["claude", "codex", "claude-desktop"] as const).filter((t) => entry(t)?.registered && !takeoverOf(t)),
);
/** 网关端口：优先 localgw 实际监听端口（ccswitch.cjs 的 gatewayPort() 同源口径），拿不到就不传，由后端自己取 */
const port = computed(() => lgw.snapshot?.port ?? 0);
const portText = computed(() => (port.value > 0 ? String(port.value) : "—"));
/** 可选密钥：只列启用中的（吊销的不该被注册进客户端配置） */
const keyOpts = computed(() => lgw.keys.filter((k) => k.status === "active"));
const pickedKey = computed(() => keyOpts.value.find((k) => k.id === keyId.value) || null);
/** 模型占位：未选时用全局回退模型 */
const fallback = computed(() => app.config?.proxy?.fallbackModel || "");

/** 内部条目：模型目录里不对外的子代理 / 占位模板（归组置底，仍可选） */
const INTERNAL_MODEL_RE = /sub_?agent|^summary$|^file_search|^computer_use|^browser_use|^custom_model_/i;
const normalModels = computed(() => lgw.models.filter((m) => !INTERNAL_MODEL_RE.test(m.id)));
const internalModels = computed(() => lgw.models.filter((m) => INTERNAL_MODEL_RE.test(m.id)));
/** 当前值已失效（目录里没有）时补一个占位项，避免下拉显示空白让人误以为没配置 */
const staleModel = computed(() => {
  const v = model.value.trim();
  if (!v || lgw.models.some((m) => m.id === v)) return "";
  return v;
});
/** 模型项的展示名：对外名与实际模型不同名时把真名一并写出来（注册进条目的是对外名） */
function modelLabel(m: { id: string; display: string; realModel: string; channel: string }) {
  const display = m.display || m.id;
  const real = m.realModel && m.realModel !== display ? `（${m.realModel}）` : "";
  return `${display}${real} · ${m.channel || "未指定渠道"}`;
}

function entry(appType: CcSwitchAppType) {
  return (st.value?.entries || []).find((x) => x.appType === appType);
}

/** 各应用的本地路由接管状态：claude-desktop 无独立行，读 claude 行的 proxy_enabled（当前是否接管中） */
function takeoverOf(appType: CcSwitchAppType) {
  const tk = st.value?.takeover;
  if (!tk) return false;
  return appType === "claude-desktop" ? !!tk.claudeDesktop : !!tk[appType];
}

/** 链路格：live 配置当前实际指向的文案 / 配色 / 悬停说明。
 *  「路由」格读的是库里的接管开关，那只是意图——CC Switch 退出时会自动把 live 恢复为直连网关；
 *  这里读的是客户端配置文件里的真实服务地址，两者不一致时以本格为准 */
function liveLabel(r?: CcSwitchLiveRoute) {
  if (!r) return "—";
  if (r.target === "gateway") return "直连网关";
  if (r.target === "ccswitch") return "经 CC Switch";
  return "未指向网关";
}
function liveCls(r?: CcSwitchLiveRoute) {
  if (!r) return "";
  if (r.target === "gateway") return "acc";
  if (r.target === "ccswitch") return "warn";
  return "";
}
function liveTitle(r?: CcSwitchLiveRoute) {
  if (!r) return "";
  const u = r.url || "（未配置服务地址）";
  if (r.target === "gateway") return `live 配置直连 AgentHub 网关：${u}`;
  if (r.target === "ccswitch") return `live 配置经 CC Switch 本地代理转换后到网关，需 CC Switch 保持运行：${u}`;
  if (r.target === "other") return `live 配置未指向 AgentHub 网关，当前：${u}`;
  return "live 配置未设置服务地址（走客户端默认）";
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
  // 密钥表与模型目录都走 localgw store：它自己把失败收敛成占位态，不让本页白屏
  await lgw.refreshKeys();
  if (!keyId.value && keyOpts.value.length) keyId.value = keyOpts.value[0].id;
}

async function loadModels() {
  await lgw.refreshModels();
}

/** 归属校验：选中的密钥前缀必须与粘贴的明文开头一致（后端 keyPrefix = raw.slice(0,12)）。
 *  不校验的后果是「下拉选 A、粘贴 B」也能注册成功，客户端拿 B 去请求而网关只认 A，表现为 401——
 *  排查方向会被引到网关鉴权上，而真正错的是这里。 */
function secretMismatch(): string {
  const k = pickedKey.value;
  const s = keySecret.value.trim();
  if (!k || !k.keyPrefix || !s) return "";
  if (s.startsWith(k.keyPrefix)) return "";
  return `粘贴的完整 Key 与所选「${k.name}」对不上（该条目前缀 ${k.keyPrefix}…）。请确认复制的是同一把 Key。`;
}

async function register(appType: CcSwitchAppType) {
  if (busy.value) return;
  busy.value = appType;
  err.value = "";
  result.value = null;
  try {
    const key = pickedKey.value;
    if (!key) {
      err.value = "请选择可用的网关 API Key（列表只显示启用中的密钥）";
      return;
    }
    if (!keySecret.value.trim()) {
      err.value = "请粘贴该 Key 的完整密钥：列表接口按设计只回前缀，明文只在「API Keys」页创建时显示一次";
      return;
    }
    const mismatch = secretMismatch();
    if (mismatch) {
      err.value = mismatch;
      return;
    }
    const mdl = (model.value || fallback.value || "").trim();
    if (!mdl) {
      err.value = "请选择默认模型（后端会把它写进条目配置，不接受空值）";
      return;
    }
    const r = await api.proxyCcSwitchRegister({
      appType,
      apiKey: keySecret.value.trim(),
      model: mdl,
      // port 缺省时由 ccswitch.cjs 取 localgw 的实际监听端口；这里传值只为与「网关地址」格显示一致
      port: port.value > 0 ? port.value : undefined,
    });
    if (r?.ok) {
      result.value = r;
      // 明文用完即弃：注册已经把 Key 写进 CC Switch 的库，留在渲染层内存里没有收益只有风险
      keySecret.value = "";
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
  // 端口格要显示 localgw 的实际监听端口，所以状态也要拉一次（store 内部失败降级，不会抛）
  void lgw.refreshStatus();
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
            <el-tooltip :content="installed ? '' : '未检测到 CC Switch，无状态可刷新'" :disabled="installed" placement="top">
              <button
                class="btn btn-sm"
                :disabled="refreshing || !installed"
                @click="manualRefresh"
              >
                {{ refreshing ? "刷新中…" : refreshTip === "ok" ? "已刷新" : refreshTip === "fail" ? "刷新失败" : "刷新状态" }}
              </button>
            </el-tooltip>
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
          本地路由已开启；请勿使用条目的「打开终端」直连，那条路径不经过 CC Switch 协议转换。下方「路由」格读 CC Switch 库里的接管开关（只是意图：它退出时会自动把 live 配置恢复为直连网关），「链路」格读客户端配置文件里的实际服务地址（地面真相），两者不一致时以「链路」为准。
        </div>
        <div class="kpis" style="margin-top: 12px">
          <div class="kpi"><span>网关地址</span><b class="mono">127.0.0.1:{{ portText }}/v1</b></div>
          <div class="kpi"><span>Claude Code</span><b :class="entry('claude')?.registered ? 'acc' : ''">{{ entry("claude")?.registered ? "已注册" : "未注册" }}</b></div>
          <div class="kpi"><span>Claude Desktop</span><b :class="entry('claude-desktop')?.registered ? 'acc' : ''">{{ entry("claude-desktop")?.registered ? "已注册" : "未注册" }}</b></div>
          <div class="kpi"><span>Codex</span><b :class="entry('codex')?.registered ? 'acc' : ''">{{ entry("codex")?.registered ? "已注册" : "未注册" }}</b></div>
          <div class="kpi"><span>路由 · Claude Code</span><b :class="takeoverOf('claude') ? 'acc' : 'err'">{{ takeoverOf("claude") ? "已开启" : "未开启" }}</b></div>
          <div class="kpi">
            <span>链路 · Claude Code</span>
            <el-tooltip :content="liveTitle(st?.live?.claude)" :disabled="!liveTitle(st?.live?.claude)" placement="top">
              <b :class="liveCls(st?.live?.claude)">{{ liveLabel(st?.live?.claude) }}</b>
            </el-tooltip>
          </div>
          <div class="kpi"><span>路由 · Codex</span><b :class="takeoverOf('codex') ? 'acc' : 'err'">{{ takeoverOf("codex") ? "已开启" : "未开启" }}</b></div>
          <div class="kpi">
            <span>链路 · Codex</span>
            <el-tooltip :content="liveTitle(st?.live?.codex)" :disabled="!liveTitle(st?.live?.codex)" placement="top">
              <b :class="liveCls(st?.live?.codex)">{{ liveLabel(st?.live?.codex) }}</b>
            </el-tooltip>
          </div>
          <div class="kpi"><span>路由 · Claude Desktop</span><b :class="takeoverOf('claude-desktop') ? 'acc' : 'err'">{{ takeoverOf("claude-desktop") ? "已开启" : "未开启" }}</b></div>
          <div class="kpi"><span>数据库</span><b class="mono">{{ st?.dbPath || "-" }}</b></div>
        </div>
      </div>

      <!-- 注册参数：Key / 默认模型 -->
      <div class="card" style="margin-top: 12px">
        <div class="card-title">注册参数</div>
        <div class="set-desc" style="margin-bottom: 10px">
          网关 Key 与默认模型会写入 CC Switch 条目（Claude 条目同时覆盖 Sonnet / Opus / Haiku / 子代理等模型字段；
          Claude Desktop 条目把四档角色路由全映射到该模型，菜单显示名同步）。
          参数在点「注册」时写入，改完需重新注册；注册后还需在 CC Switch 为对应应用开启本地路由。
        </div>
        <div v-if="keyOpts.length" class="co-row">
          <span class="co-label">网关 API Key</span>
          <el-select v-model="keyId" class="f-el-select" popper-class="glass-popper" style="width: 300px" placeholder="选择 API Key">
            <el-option v-for="k in keyOpts" :key="k.id" :value="k.id" :label="`${k.name} · ${k.keyPrefix}…`" />
          </el-select>
        </div>
        <div v-else class="set-desc err-text">还没有可用的网关 Key，请先到「API Keys」页生成</div>
        <!-- 密钥表只回前缀（决策 3），明文必须由用户粘进来；不填这一格注册一定失败，所以放在紧邻下拉的位置 -->
        <div v-if="keyOpts.length" class="co-row" style="margin-top: 10px">
          <span class="co-label">完整 Key</span>
          <input
            v-model="keySecret"
            class="input mono"
            style="width: 300px"
            type="password"
            autocomplete="off"
            placeholder="粘贴该 Key 的完整密钥（sk-lgw-…）"
          />
        </div>
        <div v-if="keyOpts.length" class="set-desc" style="margin-top: 6px">
          密钥表只回前缀，完整密钥只在「API Keys」页创建时显示一次；粘错会被前缀校验拦下。
        </div>
        <div class="co-row" style="margin-top: 10px">
          <span class="co-label">默认模型</span>
          <el-select
            v-model="model"
            class="f-el-select"
            popper-class="glass-popper"
            style="width: 300px"
            filterable
            placeholder="默认模型"
            @change="onModelChange"
          >
            <!-- 空值 = 跟随全局回退模型（等价旧 placeholder 提示） -->
            <el-option value="" :label="`跟随全局回退模型：${fallback || '—'}`" />
            <!-- 当前值已不在目录：补项显示，避免下拉空白让人误以为没配置 -->
            <el-option v-if="staleModel" :key="staleModel" :value="staleModel" :label="`${staleModel}（已不在模型目录）`" />
            <el-option-group v-if="normalModels.length" label="对话模型">
              <el-option v-for="m in normalModels" :key="m.id" :value="m.id" :label="modelLabel(m)" />
            </el-option-group>
            <el-option-group v-if="internalModels.length" label="内部条目">
              <el-option v-for="m in internalModels" :key="m.id" :value="m.id" :label="modelLabel(m)" />
            </el-option-group>
          </el-select>
          <span v-if="saved" class="tag tag-ok">已保存 · 重新注册后同步</span>
        </div>
        <!-- 参数就在上面，注册入口紧贴着放一个：改完模型不用回到页头再找按钮 -->
        <div class="co-row" style="margin-top: 12px">
          <span class="co-label">注册到</span>
          <el-select v-model="appPick" class="f-el-select" popper-class="glass-popper" style="width: 200px">
            <el-option value="claude" :label="APP_LABELS.claude" />
            <el-option value="codex" :label="APP_LABELS.codex" />
            <el-option value="claude-desktop" :label="APP_LABELS['claude-desktop']" />
          </el-select>
          <button class="btn btn-primary" :disabled="!installed || incompatible || !!busy" @click="register(appPick)">
            {{ busy === appPick ? "注册中…" : "注册" }}
          </button>
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
/* 链路格「经 CC Switch」：可用但依赖 CC Switch 保持运行，用警示色与直连/未指向区分 */
.kpi b.warn {
  color: var(--warn);
  text-shadow: 0 0 18px var(--warn-dim);
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

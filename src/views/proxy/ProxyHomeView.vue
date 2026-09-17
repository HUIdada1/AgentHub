<!-- 反代网关 · 总览：服务开关 / 地址 / 今日核心指标 / 渠道一览 / 实时请求流（方案 §7 index.html） -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import * as api from "../../api/ipc";
import type { ProxyGatewayStatus, ProxyUsageRow } from "../../types";
import { useAppStore } from "../../stores/app";
import { fmtInt, fmtK, fmtMs, fmtTime, statusCls } from "./format";

const app = useAppStore();
const st = ref<ProxyGatewayStatus | null>(null);
const recent = ref<ProxyUsageRow[]>([]);
const busy = ref(false);
const err = ref("");
let offEvent: (() => void) | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;

async function refresh() {
  try {
    st.value = await api.proxyStatus();
    recent.value = await api.proxyRecent(8);
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

async function toggleService() {
  if (busy.value) return;
  busy.value = true;
  const wasRunning = !!st.value?.running;
  try {
    const r = wasRunning ? await api.proxyStop() : await api.proxyStart();
    if (r && (r as { ok?: boolean }).ok === false) err.value = (r as { message?: string }).message || "操作失败";
    else app.config.proxy.restoreOnLaunch = !wasRunning; // 后端已落盘，同步内存里的配置让配置页开关跟手
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    busy.value = false;
    await refresh();
  }
}

/** 接入地址：状态里有就用，没有按配置拼一个兜底 */
const base = computed(() => st.value?.baseUrl || `http://${app.config.proxy.bind}:${app.config.proxy.port}/v1`);

const curlCmd = computed(
  () =>
    `curl ${base.value}/chat/completions \\\n` +
    `  -H "Authorization: Bearer sk-你的Key" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'`,
);
const pyCmd = computed(
  () =>
    `from openai import OpenAI\n\n` +
    `client = OpenAI(\n` +
    `    base_url="${base.value}",  # 网关地址，以 /v1 结尾\n` +
    `    api_key="sk-你的Key",\n` +
    `)\n` +
    `resp = client.chat.completions.create(\n` +
    `    model="deepseek-v4-flash",\n` +
    `    messages=[{"role": "user", "content": "你好"}],\n` +
    `)\n` +
    `print(resp.choices[0].message.content)`,
);

/** 快速上手四步 + 每步的问号提示（接入地址随端口/绑定配置实时联动） */
const steps = computed<{ id: string; title: string; desc: string; link?: boolean }[]>(() => [
  { id: "start", title: "启动网关服务", desc: "点页面上方的服务开关，状态变为 RUNNING 即可开始接收请求。" },
  { id: "key", title: "生成一个 API Key", desc: "到「API Keys」页点“生成 Key”，复制并保存好。", link: true },
  { id: "base", title: "记下接入地址", desc: `就是上方地址条里的 Base URL，当前为 ${base.value}。` },
  { id: "model", title: "在客户端填三项", desc: "接入地址、API Key、模型名，填完用下面的示例先发一条测试。" },
]);
const tips: Record<string, string> = {
  start: "服务启动后网关才开始转发请求；监听端口和绑定地址可以在「配置 → 反代网关」里修改，改完需要重新启动服务。",
  key: "API Key 相当于访问网关的密码，客户端用它证明身份。生成后可随时在 Key 列表里查看 / 复制完整 Key；泄露或丢失就删掉重新生成一个。",
  base: "这是 OpenAI 兼容地址——所有支持“自定义 OpenAI 接口”的软件都能直接填用，不需要装任何插件。默认只监听本机，局域网其他设备访问需在「配置 → 反代网关」里改绑定地址。",
  model: "模型名必须填网关渠道实际提供的名称（在渠道详情里能看到），填了不存在的名称会报 model not found / 404。",
};
const openHint = ref<string | null>(null);
function toggleHint(id: string) {
  openHint.value = openHint.value === id ? null : id;
}
function closeHint() {
  openHint.value = null;
}

/** 地址条与端点标签：点一下整条进剪贴板；文本全部来自实时配置，改端口/绑定后跟着变 */
const endpoints = [
  { key: "chat", text: "POST /v1/chat/completions" },
  { key: "models", text: "GET /v1/models" },
  { key: "health", text: "GET /healthz" },
] as const;
const copied = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
function copyText(text: string, key: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
  copied.value = key;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = ""), 1500);
}

/** 去 Keys 页生成 Key */
function goKeys() {
  app.activeModule = "proxy";
  app.setPage("keys");
}

const exTab = ref<"curl" | "py" | "app">("curl");

onMounted(() => {
  refresh();
  pollTimer = setInterval(refresh, 5000);
  document.addEventListener("click", closeHint);
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event === "proxy") refresh();
  });
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  document.removeEventListener("click", closeHint);
  if (offEvent) offEvent();
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="err" class="card err-card">
        <div class="set-desc err-text">{{ err }}</div>
      </div>
      <!-- 页头工具栏（已去标题化）：地址条/端点/DPAPI 与状态、服务开关排成一行 -->
      <div class="toolbar">
        <button class="pill mono copy-chip" :title="`点击复制：${base}`" @click="copyText(base, 'base')">
          {{ base }}<i class="ph" :class="copied === 'base' ? 'ph-check' : 'ph-copy'"></i>
        </button>
        <button
          v-for="ep in endpoints"
          :key="ep.key"
          class="tag tag-dim copy-chip"
          :title="`点击复制：${ep.text}`"
          @click="copyText(ep.text, ep.key)"
        >
          {{ ep.text }}<i class="ph" :class="copied === ep.key ? 'ph-check' : 'ph-copy'"></i>
        </button>
        <span class="tag" :class="st?.vaultOk ? 'tag-ok' : 'tag-warn'">{{ st?.vaultOk ? "DPAPI 凭证加密" : "凭证加密不可用" }}</span>
        <span class="toolbar-right">
          <span class="pill">
            <span class="dot" :class="{ off: !st?.running }"></span>{{ st?.running ? "RUNNING" : "STOPPED" }}
          </span>
          <button class="btn" :class="st?.running ? 'btn-stop' : 'btn-primary'" :disabled="busy" @click="toggleService">
            {{ busy ? "处理中…" : st?.running ? "停止服务" : "启动服务" }}
          </button>
        </span>
      </div>
      <div class="kpis">
        <div class="kpi"><span>今日请求</span><b class="acc">{{ fmtInt(st?.today.req || 0) }}</b></div>
        <div class="kpi"><span>今日 Token</span><b>{{ fmtK(st?.today.tokens || 0) }}</b></div>
        <div class="kpi"><span>成功率</span><b>{{ (st?.today.successRate ?? 100).toFixed(1) }}%</b></div>
        <div class="kpi"><span>TTFT 均值</span><b>{{ fmtMs(st?.today.ttftAvg || 0) }}</b></div>
      </div>
      <div class="grid-3" style="margin-top: 12px">
        <div v-for="c in st?.channels || []" :key="c.id" class="card">
          <div class="card-title">
            {{ c.display }}
            <span class="tag" :class="c.onlineCount > 0 ? 'tag-ok' : 'tag-dim'">
              {{ c.accountCount ? `${c.onlineCount}/${c.accountCount} 可用` : "未配置" }}
            </span>
          </div>
          <div style="display: flex; align-items: baseline; gap: 8px">
            <b class="big-num">{{ fmtInt(c.totalCredits) }}</b>
            <span style="font-size: 11px; color: var(--text-3)">积分</span>
          </div>
          <div class="rows" style="margin-top: 6px">
            <div class="row"><div class="grow"><div class="name">今日请求 / Token</div></div><span class="num">{{ c.todayReq }} · {{ fmtK(c.todayTokens) }}</span></div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top: 12px">
        <div class="card-title">实时请求流 <span class="right">最近 {{ recent.length }} 条</span></div>
        <div class="tbl-wrap">
          <table class="tbl">
            <tbody>
              <tr><th>时间</th><th>路径</th><th>模型</th><th>KEY</th><th>渠道</th><th>状态</th><th>TTFT</th><th>耗时</th></tr>
              <tr v-for="r in recent" :key="r.id">
                <td class="mono">{{ fmtTime(r.ts) }}</td>
                <td class="mono">/v1/chat/completions</td>
                <td class="mono">{{ r.model || "-" }}</td>
                <td class="mono">{{ r.keyName || "-" }}</td>
                <td>{{ r.channel || "-" }}</td>
                <td><span class="tag" :class="statusCls(r.status)">{{ r.status || "-" }}</span></td>
                <td class="mono">{{ fmtMs(r.ttftMs) }}</td>
                <td class="mono">{{ fmtMs(r.latencyMs) }}</td>
              </tr>
              <tr v-if="!recent.length">
                <td colspan="8" style="text-align: center; color: var(--text-3); padding: 18px">
                  暂无请求记录 —— 用上方地址发起第一个请求即出现在这里
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-title">快速上手 <span class="right">四步完成接入</span></div>
        <div class="steps">
          <div v-for="(s, i) in steps" :key="s.id" class="step">
            <span class="step-no">{{ i + 1 }}</span>
            <div class="step-main">
              <div class="step-t">
                {{ s.title }}
                <span class="qwrap">
                  <span class="qmark" :class="{ on: openHint === s.id }" @click.stop="toggleHint(s.id)">?</span>
                  <span v-if="openHint === s.id" class="qpop" @click.stop>{{ tips[s.id] }}</span>
                </span>
              </div>
              <div class="step-d">
                {{ s.desc }}
                <button v-if="s.link" class="step-link" @click="goKeys">去生成 →</button>
              </div>
            </div>
          </div>
        </div>
        <div class="ex-tabs">
          <button class="ex-tab" :class="{ on: exTab === 'curl' }" @click="exTab = 'curl'">curl 命令</button>
          <button class="ex-tab" :class="{ on: exTab === 'py' }" @click="exTab = 'py'">Python（OpenAI SDK）</button>
          <button class="ex-tab" :class="{ on: exTab === 'app' }" @click="exTab = 'app'">桌面客户端</button>
          <span class="ex-note">把 <b>sk-你的Key</b> 换成第 2 步生成的 Key<span class="qwrap">
            <span class="qmark" :class="{ on: openHint === 'replace' }" @click.stop="toggleHint('replace')">?</span>
            <span v-if="openHint === 'replace'" class="qpop">示例里的"sk-你的Key"和模型名都是占位符，替换成你自己的真实值才能跑通。</span>
          </span></span>
        </div>
        <div v-if="exTab === 'curl'" class="code">{{ curlCmd }}</div>
        <div v-if="exTab === 'py'" class="code">{{ pyCmd }}</div>
        <ol v-if="exTab === 'app'" class="app-steps">
          <li>打开客户端的「设置 → 模型服务」，点「添加」，选择 <b>OpenAI 兼容 / 自定义</b> 类型。</li>
          <li>API 地址：填上方第 3 步的 Base URL（以 <b>/v1</b> 结尾；个别客户端只要求填到端口，按它的提示来）。</li>
          <li>API Key：填第 2 步生成的 <b>sk-开头</b> 的 Key。</li>
          <li>模型：手动输入模型名（以渠道实际提供的为准），保存后发一句话测试。</li>
        </ol>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 页头标题化已去除：地址条/端点/DPAPI 与状态、开关固定一行，不换行 */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.toolbar-right {
  margin-left: auto;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  display: inline-block;
}
.pill .dot.off {
  background: var(--text-3);
}
/* 地址 / 端点快捷复制：悬停点亮，点击后图标短暂变对勾 */
.copy-chip {
  cursor: pointer;
  border: 1px solid transparent;
  user-select: none;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.copy-chip .ph {
  font-size: 11px;
  margin-left: 2px;
  opacity: 0.5;
}
.copy-chip:hover {
  color: var(--accent-strong);
  border-color: var(--accent-line);
}
.copy-chip:hover .ph {
  opacity: 1;
}
/* 停止服务用危险色描边，与启动服务的实心主色形成状态区分 */
.btn-stop {
  color: var(--danger);
}
.btn-stop:hover {
  border-color: var(--danger);
  background: var(--danger-dim);
}
/* 渠道数不固定：按可用宽度自适应排布，接多少渠道都不挤 */
.grid-3 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}
.big-num {
  font-family: var(--font-ui);
  font-variant-numeric: tabular-nums;
  font-size: 22px;
  letter-spacing: -1px;
}
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}

/* ===== 快速上手 ===== */
.steps {
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
}
.step {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.step-no {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent-dim, rgba(52, 211, 153, 0.14));
  color: var(--accent-strong);
  font-size: 11px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}
.step-t {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 6px;
}
.step-d {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
  margin-top: 2px;
}
.step-link {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent-strong);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.step-link:hover {
  text-decoration: underline;
}

/* 问号徽章 + 点击气泡 */
.qwrap {
  position: relative;
  display: inline-flex;
}
.qmark {
  flex: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  color: var(--text-3);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.qmark:hover,
.qmark.on {
  color: var(--accent-strong);
  border-color: var(--accent-strong);
  background: var(--accent-dim, rgba(52, 211, 153, 0.14));
}
.qpop {
  position: absolute;
  top: calc(100% + 7px);
  left: -10px;
  z-index: 30;
  width: 250px;
  padding: 9px 11px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-strong);
  background: var(--bg-soft);
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.55);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.65;
  animation: qpop-in 0.16s ease-out;
}
@keyframes qpop-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}

/* 示例 tab 切换 */
.ex-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.ex-tab {
  display: inline-flex;
  align-items: center;
  height: var(--ctl-h-sm);
  padding: 0 11px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-strong);
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s, transform 0.28s var(--ease-spring), box-shadow 0.25s;
}
.ex-tab:hover {
  color: var(--text);
  border-color: rgba(255, 255, 255, 0.22);
  transform: scale(1.05);
  box-shadow: 0 0 12px -4px var(--accent-line);
}
.ex-tab.on {
  color: var(--accent-strong);
  border-color: var(--accent-line);
  background: var(--accent-dim);
}
.ex-note {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ex-note b {
  color: var(--text-2);
  font-weight: 600;
}

/* 客户端配置步骤 */
.app-steps {
  margin: 0;
  padding: 11px 13px 11px 28px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-2);
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  display: grid;
  gap: 6px;
}
.app-steps b {
  color: var(--text);
  font-weight: 600;
}
</style>

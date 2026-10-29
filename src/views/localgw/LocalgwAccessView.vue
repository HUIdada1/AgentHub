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
<!-- 本地网关 · 接入与文档：地址 / 端点 / 快速上手 / API Key / 客户端片段 / 协议兼容
     页面形式照搬 fdb3e55^ 旧版反代网关总览里的「快速上手」卡（ProxyHomeView.vue 行 290-327：
     .steps 四步 + 问号气泡 + 三档示例切换 + .code 示例 + .app-steps 客户端步骤），
     示例切换按钮已从页内自带的 .ex-tab 换成全站 .chip（与用量统计页的档位切换同一套），
     数据源换成现在的实现（useLocalgwStore + 号池只读渠道）。

     ⚠️ 端点事实（新版后端 server.cjs 实际提供的路由，不要照抄旧版）：
       GET  /health                  ← 旧版写的是 /healthz，新版不存在
       POST /v1/chat/completions
       GET  /v1/models
       POST /v1/messages             ← Anthropic 系
       GET  /v1/anthropic/models     ← Anthropic 系
     新版没有 /v1/responses，也不支持 Google Gemini 协议。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import { useLocalgwStore } from "../../stores/localgw";
import { coalesceAsync } from "../../utils/timing";

const app = useAppStore();
const lgw = useLocalgwStore();

/** 页面级错误 + store 的 lastError 合成一条文案 */
const localErr = ref("");
const err = computed(() => localErr.value || lgw.lastError);
function dismissErr() {
  localErr.value = "";
  lgw.clearError();
}

/** 监听 0.0.0.0 / :: 是「所有网卡」而不是可连的地址，客户端必须用回环地址连自己 */
const bindAddr = computed(() => {
  const b = lgw.snapshot?.bind || "127.0.0.1";
  return b === "0.0.0.0" || b === "::" || b === "[::]" ? "127.0.0.1" : b;
});
/** 根地址（不含 /v1）：Anthropic 系客户端要填这个，它们自己拼 /v1/messages */
const rootUrl = computed(() => `http://${bindAddr.value}:${lgw.snapshot?.port || 9527}`);
/** OpenAI 兼容端点前缀：客户端要填到 /v1 为止 */
const base = computed(() => `${rootUrl.value}/v1`);
const running = computed(() => !!lgw.snapshot?.running);
/** 监听全网卡时的风险提示（方案 §7 安全口径：默认只监听回环） */
const exposedToLan = computed(() => {
  const b = lgw.snapshot?.bind || "";
  return b === "0.0.0.0" || b === "::" || b === "[::]";
});

/** 地址 / 端点快捷复制：点一下整条进剪贴板，图标短暂变对勾 */
const copied = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
function copyText(text: string, key: string) {
  if (!text) return;
  navigator.clipboard?.writeText(text).catch(() => {});
  copied.value = key;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = ""), 1500);
}

/** 端点清单：工具栏放常用的三条，全量（含 Anthropic 两条）在下方「协议兼容」卡里列全 */
const endpoints = [
  { key: "chat", text: "POST /v1/chat/completions" },
  { key: "models", text: "GET /v1/models" },
  { key: "health", text: "GET /health" },
] as const;
const endpointRows = [
  { method: "GET", path: "/health", note: "探活（新版是 /health，不是旧版的 /healthz）" },
  { method: "POST", path: "/v1/chat/completions", note: "OpenAI 兼容对话补全" },
  { method: "GET", path: "/v1/models", note: "OpenAI 兼容模型清单" },
  { method: "POST", path: "/v1/messages", note: "Anthropic Messages（Claude Code 等）" },
  { method: "GET", path: "/v1/anthropic/models", note: "Anthropic 模型清单" },
];

/** 当前 API Key：默认选第一个有效 Key —— 否则下拉框显示占位文案，
 *  而下面的示例片段已经在用这个 Key，前后对不上 */
const activeKeys = computed(() => lgw.keys.filter((k) => k.status === "active"));
const activeKeyId = ref("");
const currentKey = computed(() => activeKeys.value.find((k) => k.id === activeKeyId.value) || activeKeys.value[0]);

/** 快速上手四步 + 每步的问号提示（地址随监听端口实时联动） */
const steps = computed<{ id: string; title: string; desc: string; link?: boolean }[]>(() => [
  { id: "start", title: "启动网关服务", desc: "到「总览」点服务开关，状态变为 RUNNING 即可开始接收请求。" },
  { id: "key", title: "生成一个 API Key", desc: "到「API Keys」页点“生成 Key”，立刻复制保存好。", link: true },
  { id: "base", title: "记下接入地址", desc: `就是上方地址条里的 Base URL，当前为 ${base.value}。` },
  { id: "model", title: "在客户端填三项", desc: "接入地址、API Key、模型名，填完用下面的示例先发一条测试。" },
]);
const tips: Record<string, string> = {
  start: "启动后网关才开始转发；端口与绑定地址在「设置 · 本地网关」修改，改完需重启服务。",
  // ⚠️ 与旧版口径的关键差异：完整 Key 只在创建响应里出现一次，列表只留前缀
  key: "API Key 是访问网关的密码。完整 Key 只在创建时出现一次，列表只留前缀 —— 请立刻保存，丢了只能吊销重建。",
  base: "OpenAI 兼容地址，支持「自定义 OpenAI 接口」的软件可直接填用。默认仅本机可访问，局域网访问需在设置里改绑定地址。",
  model: "模型名要填「模型目录」里实际提供的名称，填错会报 model not found / 404。",
};
const openHint = ref<string | null>(null);
function toggleHint(id: string) {
  openHint.value = openHint.value === id ? null : id;
}
function closeHint() {
  openHint.value = null;
}
/** 去 API Keys 页生成 Key（同模块内切页） */
function goKeys() {
  app.setPage("keys");
}

const exTab = ref<"curl" | "py" | "app">("curl");
/** 示例里的模型名取「模型目录」第一条真实模型，拉不到才回落占位文案 —— 不硬编一个可能不存在的模型 */
const exampleModel = computed(() => lgw.models[0]?.display || "deepseek-v4-flash");
const curlCmd = computed(
  () =>
    `curl ${base.value}/chat/completions \\\n` +
    `  -H "Authorization: Bearer sk-你的Key" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"model":"${exampleModel.value}","messages":[{"role":"user","content":"你好"}]}'`,
);
const pyCmd = computed(
  () =>
    `from openai import OpenAI\n\n` +
    `client = OpenAI(\n` +
    `    base_url="${base.value}",  # 网关地址，以 /v1 结尾\n` +
    `    api_key="sk-你的Key",\n` +
    `)\n` +
    `resp = client.chat.completions.create(\n` +
    `    model="${exampleModel.value}",\n` +
    `    messages=[{"role": "user", "content": "你好"}],\n` +
    `)\n` +
    `print(resp.choices[0].message.content)`,
);

/** 客户端片段：OpenAI 兼容系填 base（到 /v1），Anthropic 系填根地址 */
const clients = computed(() => {
  const key = "<你的Key>";
  return [
    {
      id: "continue",
      name: "VSCode · Continue",
      path: "~/.continue/config.json",
      snippet: `"models": [{\n  "title": "本地网关",\n  "provider": "openai",\n  "apiBase": "${base.value}",\n  "apiKey": "${key}"\n}]`,
    },
    {
      id: "jetbrains",
      name: "JetBrains · AI Assistant",
      path: "Settings → Tools → AI Assistant → Custom Provider",
      snippet: `URL: ${base.value}\nAPI Key: ${key}`,
    },
    {
      id: "zcode",
      name: "ZCode",
      path: "设置 → 模型服务 → 自定义",
      snippet: `Base URL: ${base.value}\nAPI Key: ${key}`,
    },
    {
      id: "trae",
      name: "Raccoon / Trae / Cline",
      path: "自定义 OpenAI 兼容端点",
      snippet: `Base URL: ${base.value}\nAPI Key: ${key}`,
    },
    {
      id: "claude",
      name: "Claude Code",
      path: "环境变量",
      // Anthropic 系客户端会自己在 BASE_URL 后面拼 /v1/messages（后端只提供 POST /v1/messages），
      // 所以这里必须填不带 /v1 的根地址——填成 /v1 会打成 /v1/v1/messages 直接 404
      snippet: `export ANTHROPIC_BASE_URL=${rootUrl.value}\nexport ANTHROPIC_API_KEY=${key}`,
    },
  ];
});

/** 拉取本页要用的数据：状态 / 密钥 / 模型目录（示例模型名要用真实模型） */
async function refresh() {
  await Promise.all([lgw.refreshStatus(), lgw.refreshKeys(), lgw.refreshModels()]);
  if (!activeKeyId.value) activeKeyId.value = activeKeys.value[0]?.id || "";
}
const scheduleRefresh = coalesceAsync(refresh, 1000);

/** 本页是否处于前台：页面经 v-show 保活，切回本页时补一次刷新 */
const active = computed(() => app.activeModule === "localgw" && app.activePage === "access");
watch(active, (on) => {
  if (on) scheduleRefresh();
});

onMounted(async () => {
  await refresh();
  document.addEventListener("click", closeHint);
});
onUnmounted(() => {
  scheduleRefresh.cancel();
  clearTimeout(copiedTimer);
  document.removeEventListener("click", closeHint);
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="err" class="card err-card">
        <div class="set-desc err-text">
          {{ err }}
          <button class="btn-link btn-sm" style="margin-left: 8px" @click="dismissErr">知道了</button>
        </div>
      </div>

      <!-- 监听 0.0.0.0 的安全提示：方案 §7 要求默认只监听回环 -->
      <div v-if="exposedToLan" class="card warn-card">
        <div class="set-desc warn-text">
          当前监听 <b>0.0.0.0</b>（局域网内其它设备也能访问本网关）。请确认已为每个客户端单独签发密钥，
          且不需要外部访问时把监听地址改回 <b>127.0.0.1</b>（设置 · 本地网关）。
        </div>
      </div>

      <!-- 页头工具栏：地址条 / 端点 / 状态与运行徽章排成一行（与总览同一版式） -->
      <div class="toolbar">
        <el-tooltip :content="`点击复制：${base}`" placement="top">
          <button class="pill mono copy-chip" @click="copyText(base, 'base')">
            {{ base }}<i class="ph" :class="copied === 'base' ? 'ph-check' : 'ph-copy'"></i>
          </button>
        </el-tooltip>
        <el-tooltip v-for="ep in endpoints" :key="ep.key" :content="`点击复制：${ep.text}`" placement="top">
          <button class="tag tag-dim copy-chip" @click="copyText(ep.text, ep.key)">
            {{ ep.text }}<i class="ph" :class="copied === ep.key ? 'ph-check' : 'ph-copy'"></i>
          </button>
        </el-tooltip>
        <span class="toolbar-right">
          <!-- 服务状态徽章：与总览页共用 src/styles/localgw.css 的 .lgw-svc-*
               （不用全局 .pill + .dot：那套的涟漪色缺省是主绿，停服时会渲染成绿涟漪） -->
          <span class="lgw-svc-state" :class="running ? 'is-on' : 'is-off'">
            <span class="lgw-svc-dot" aria-hidden="true"></span>
            <span class="lgw-svc-text">{{ running ? "RUNNING" : "STOPPED" }}</span>
          </span>
        </span>
      </div>

      <!-- ===== 快速上手（照搬旧版总览的整张卡） ===== -->
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
        <!-- 示例切换：用全站 .chip（与用量统计页的档位切换同一套），不再自带 .ex-tab -->
        <div class="ex-tabs">
          <button class="chip" :class="{ active: exTab === 'curl' }" @click="exTab = 'curl'">curl 命令</button>
          <button class="chip" :class="{ active: exTab === 'py' }" @click="exTab = 'py'">Python（OpenAI SDK）</button>
          <button class="chip" :class="{ active: exTab === 'app' }" @click="exTab = 'app'">桌面客户端</button>
          <span class="ex-note">
            把 <b>sk-你的Key</b> 换成第 2 步生成的 Key<span class="qwrap">
              <span class="qmark" :class="{ on: openHint === 'replace' }" @click.stop="toggleHint('replace')">?</span>
              <span v-if="openHint === 'replace'" class="qpop">
                示例里的 Key 与模型名都是占位符，换成真实值才能跑通；完整 Key 只在生成时出现一次。
              </span>
            </span>
          </span>
        </div>
        <div v-if="exTab === 'curl'" class="code">{{ curlCmd }}</div>
        <div v-if="exTab === 'py'" class="code">{{ pyCmd }}</div>
        <ol v-if="exTab === 'app'" class="app-steps">
          <li>打开客户端的「设置 → 模型服务」，点「添加」，选择 <b>OpenAI 兼容 / 自定义</b> 类型。</li>
          <li>API 地址：填上方第 3 步的 Base URL（以 <b>/v1</b> 结尾；个别客户端只要求填到端口，按它的提示来）。</li>
          <li>API Key：填第 2 步生成的 <b>sk-</b> 开头的 Key。</li>
          <li>模型：手动输入模型名（以「模型目录」页实际提供的为准），保存后发一句话测试。</li>
          <li>
            Claude Code 等 Anthropic 系客户端不一样：API 地址要填<b>根地址 {{ rootUrl }}</b>（它们自己拼
            <b>/v1/messages</b>），填成 {{ base }} 会打成 /v1/v1/messages 直接 404。
          </li>
        </ol>
      </div>

      <!-- ===== API Key ===== -->
      <div class="card">
        <div class="card-title">API Key <span class="right">完整 Key 只在生成时出现一次</span></div>
        <template v-if="activeKeys.length">
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">选用哪个 Key</div>
              <div class="set-desc">列表只有前缀；完整 Key 无法再次查看，需要新 Key 就到「API Keys」页生成</div>
            </div>
            <!-- 下拉统一用 el-select + glass-popper + f-el-select（与用量统计板块同款），
                 不再用原生 select -->
            <el-select v-model="activeKeyId" class="f-el-select" popper-class="glass-popper" style="width: 280px">
              <el-option v-for="k in activeKeys" :key="k.id" :value="k.id" :label="`${k.name || '未命名'}（${k.keyPrefix || '—'}…）`" />
            </el-select>
            <button
              class="btn"
              :disabled="!currentKey"
              @click="copyText(currentKey?.keyPrefix || '', 'prefix')"
            >
              {{ copied === "prefix" ? "已复制前缀" : "复制前缀" }}
            </button>
          </div>
        </template>
        <div v-else class="set-desc">还没有有效密钥 —— 到「API Keys」页点「生成 Key」创建一个。</div>
      </div>

      <!-- ===== 客户端接入片段 ===== -->
      <div class="card">
        <div class="card-title">客户端接入片段 <span class="right">点标题右侧「复制」整段带走</span></div>
        <div class="cli-grid">
          <div v-for="c in clients" :key="c.id" class="cli-card">
            <div class="cli-head">
              <b>{{ c.name }}</b>
              <button class="btn-link btn-sm" @click="copyText(c.snippet, c.id)">
                {{ copied === c.id ? "已复制" : "复制" }}
              </button>
            </div>
            <div class="cli-path">{{ c.path }}</div>
            <div class="code">{{ c.snippet }}</div>
          </div>
        </div>
      </div>

      <!-- ===== 协议兼容与端点清单 ===== -->
      <div class="card">
        <div class="card-title">协议兼容 <span class="right">新版实际提供的路由</span></div>
        <div class="rows">
          <div v-for="ep in endpointRows" :key="ep.method + ep.path" class="row">
            <div class="grow">
              <div class="name mono">{{ ep.method }} {{ ep.path }}</div>
              <div class="sub">{{ ep.note }}</div>
            </div>
            <span class="tag tag-dim">{{ ep.method }}</span>
          </div>
        </div>
        <div class="set-desc" style="margin-top: 10px">
          网关提供 <b>OpenAI 兼容</b>与 <b>Anthropic Messages</b> 两套协议；没有 <code class="mono">/v1/responses</code>，
          也不支持 Google Gemini。模型映射 / 覆盖 / 别名见「模型目录」页。
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 页头标题化已去除：地址条 / 端点 / 状态固定一行，不换行
   （.toolbar / .copy-chip / .steps / .qmark / .chip 等旧版各页自带的原子类照搬自 ProxyHomeView 的 <style scoped>） */
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
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
/* 局域网暴露提示：语义是「警告」不是「错误」，与 err-card 区分开 */
.warn-card {
  margin-bottom: 12px;
  border-color: var(--warn);
}
.warn-text {
  color: var(--warn);
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
  white-space: normal;
  animation: qpop-in 0.16s ease-out;
}
@keyframes qpop-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}

/* 示例切换：切换按钮本身走全站 .chip，这里只管这一行的排布与右侧说明 */
.ex-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
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

/* 客户端片段：按可用宽度自适应排布，片段多少都不挤 */
.cli-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 10px;
}
.cli-card {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
.cli-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text);
}
.cli-head b {
  font-weight: 600;
}
.cli-head .btn-link {
  margin-left: auto;
}
.cli-path {
  font-size: 11px;
  color: var(--text-3);
  overflow-wrap: anywhere;
}
.cli-card .code {
  font-size: 11px;
  max-height: 120px;
}
</style>

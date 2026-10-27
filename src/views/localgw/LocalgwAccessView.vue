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
<!-- 本地网关 · 接入与文档：Base URL / 当前 API Key / 主流客户端一键配置
     面向"小白用户"的默认视图，只保留必要信息；协议字段映射详见仓库 README -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useLocalgwStore } from "../../stores/localgw";

const lgw = useLocalgwStore();
const activeKeyId = ref("");

/** 监听地址：0.0.0.0 / :: 是「所有网卡」而不是可连的地址，客户端必须用回环地址连自己 */
const bindAddr = computed(() => {
  const b = lgw.snapshot?.bind || "127.0.0.1";
  return b === "0.0.0.0" || b === "::" || b === "[::]" ? "127.0.0.1" : b;
});
/** 对外暴露给客户端的地址（不含 /v1 路径），Anthropic 系客户端要填这个 */
const rootUrl = computed(() => `http://${bindAddr.value}:${lgw.snapshot?.port || 9527}`);
/** OpenAI 兼容端点前缀：客户端要填到 /v1 为止 */
const baseUrl = computed(() => `${rootUrl.value}/v1`);
/** 监听全网卡时的风险提示（方案 §7 安全口径） */
const exposedToLan = computed(() => {
  const b = lgw.snapshot?.bind || "";
  return b === "0.0.0.0" || b === "::" || b === "[::]";
});

const activeKeys = computed(() => lgw.keys.filter((k) => k.status === "active"));
const currentKey = computed(() => activeKeys.value.find((k) => k.id === activeKeyId.value) || activeKeys.value[0]);

const curlExample = computed(() => {
  const key = currentKey.value ? `<你的密钥（${currentKey.value.keyPrefix || "sk-lgw-"}…）>` : "<先在「服务与密钥」创建>";
  return `curl -X POST ${baseUrl.value}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "你好"}]
  }'`;
});

const clients = computed(() => {
  const key = currentKey.value ? `<你的密钥>` : "<先在「服务与密钥」创建>";
  return [
    {
      name: "VSCode · Continue",
      icon: "ph-file-code",
      path: "~/.continue/config.json",
      snippet: `"models": [{
  "title": "本地网关",
  "provider": "openai",
  "apiBase": "${baseUrl.value}",
  "apiKey": "${key}"
}]`,
    },
    {
      name: "JetBrains · AI Assistant",
      icon: "ph-code",
      path: "Settings → Tools → AI Assistant → Custom Provider",
      snippet: `URL: ${baseUrl.value}
API Key: ${key}`,
    },
    {
      name: "ZCode",
      icon: "ph-terminal-window",
      path: "设置 → 模型服务 → 自定义",
      snippet: `Base URL: ${baseUrl.value}
API Key: ${key}`,
    },
    {
      name: "Raccoon / Trae / Cline",
      icon: "ph-robot",
      path: "自定义 OpenAI 兼容端点",
      snippet: `Base URL: ${baseUrl.value}
API Key: ${key}`,
    },
    {
      name: "Claude Code",
      icon: "ph-command",
      path: "环境变量",
      // Anthropic 系客户端会自己在 BASE_URL 后面拼 /v1/messages（后端只提供 POST /v1/messages），
      // 所以这里必须填不带 /v1 的根地址——填成 /v1 会打成 /v1/v1/messages 直接 404
      snippet: `export ANTHROPIC_BASE_URL=${rootUrl.value}
export ANTHROPIC_API_KEY=${key}`,
    },
  ];
});

async function copyText(t: string, label = "已复制") {
  if (!t) {
    ElMessage.warning("没有可复制的内容");
    return;
  }
  try {
    // navigator.clipboard 在非 https / 无权限 / 老内核下不存在，直接调用会 TypeError
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(t);
    ElMessage.success(label);
  } catch {
    ElMessage.warning("复制失败，请手动选中复制");
  }
}

onMounted(async () => {
  await Promise.all([lgw.refreshStatus(), lgw.refreshKeys()]);
  // 默认选中第一个有效密钥：否则下拉框显示占位文案，而下面的示例片段已经在用这个 Key，前后对不上
  if (!activeKeyId.value) activeKeyId.value = activeKeys.value[0]?.id || "";
});
</script>

<template>
  <div class="page lgw-scope">
    <div class="lgw-toolbar">
      <span class="lgw-toolbar-title">接入与文档</span>
      <el-tag v-if="lgw.snapshot?.running" type="success" size="small">网关运行中</el-tag>
      <el-tag v-else type="info" size="small">网关未启动</el-tag>
    </div>

    <!-- 错误横幅：加载失败时把原因显式说出来 -->
    <div v-if="lgw.lastError" class="lgw-inline-err">
      <i class="ph ph-warning-circle"></i>
      <span>{{ lgw.lastError }}</span>
      <el-button size="small" text @click="lgw.clearError()">知道了</el-button>
    </div>

    <!-- 监听 0.0.0.0 的安全提示：方案 §7 要求默认只监听回环 -->
    <div v-if="exposedToLan" class="lgw-warn-block">
      <i class="ph ph-warning-octagon"></i>
      <span>
        当前监听 <b>0.0.0.0</b>（局域网内其它设备也能访问本网关）。请确认已为每个客户端单独签发密钥，
        且不需要外部访问时把监听地址改回 <b>127.0.0.1</b>（设置 · 本地网关）。
      </span>
    </div>

    <!-- 三个关键信息：Base URL / API Key / 示例 -->
    <div class="lgw-section">
      <div class="lgw-section-title">Base URL</div>
      <div class="lgw-copy-block">
        <span class="lgw-copy-text">{{ baseUrl }}</span>
        <el-button size="small" @click="copyText(baseUrl, 'Base URL 已复制')">复制</el-button>
      </div>
      <div class="lgw-kpi-sub">
        Anthropic 系客户端（Claude Code 等）请填根地址 <code style="font-family:var(--font-mono)">{{ rootUrl }}</code>，
        它们会自己拼 <code style="font-family:var(--font-mono)">/v1/messages</code>。
      </div>
    </div>

    <div class="lgw-section">
      <div class="lgw-section-title">API Key</div>
      <template v-if="activeKeys.length">
        <div class="lgw-field">
          <el-select v-model="activeKeyId" size="small" style="width:280px" placeholder="选择一个密钥">
            <el-option v-for="k in activeKeys" :key="k.id" :label="`${k.name || '未命名'}（${k.keyPrefix || '—'}…）`" :value="k.id" />
          </el-select>
          <el-button size="small" @click="copyText(currentKey?.keyPrefix || '', '前缀已复制（完整 Key 只在创建时显示一次）')">复制前缀</el-button>
        </div>
        <div class="lgw-kpi-sub">
          完整 Key 只在创建时显示一次。如需新 Key 请到「服务与密钥」创建。
        </div>
      </template>
      <div v-else style="font-size:12.5px;color:var(--text-3)">
        还没有密钥，请到「服务与密钥」页创建。
      </div>
    </div>

    <div class="lgw-section">
      <div class="lgw-section-title">curl 快速测试</div>
      <div class="lgw-copy-block" style="align-items:flex-start">
        <pre class="lgw-copy-text" style="white-space:pre-wrap;font-size:11.5px;line-height:1.6">{{ curlExample }}</pre>
        <el-button size="small" @click="copyText(curlExample, '示例已复制')">复制</el-button>
      </div>
    </div>

    <!-- 客户端一键配置 -->
    <div class="lgw-section">
      <div class="lgw-section-title">客户端接入片段</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px">
        <div v-for="c in clients" :key="c.name" class="lgw-section" style="padding:12px">
          <div style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:var(--text-1)">
            <i :class="`ph ${c.icon}`"></i>{{ c.name }}
            <el-button size="small" text type="primary" style="margin-left:auto" @click="copyText(c.snippet, `${c.name} 片段已复制`)">复制</el-button>
          </div>
          <div style="font-size:11px;color:var(--text-3)">{{ c.path }}</div>
          <pre class="lgw-copy-text" style="white-space:pre-wrap;font-size:11px;line-height:1.6;max-height:120px;overflow:auto">{{ c.snippet }}</pre>
        </div>
      </div>
    </div>

    <div class="lgw-section" style="background:var(--surface-3)">
      <div class="lgw-section-title">协议兼容</div>
      <div class="lgw-kpi-sub" style="line-height:1.8">
        · <b>OpenAI</b>：{{ baseUrl }}/chat/completions · {{ baseUrl }}/models<br />
        · <b>Anthropic</b>：{{ rootUrl }}/v1/messages（客户端填根地址 {{ rootUrl }}）<br />
        不支持 Google Gemini 协议（方案决策 4）。自定义模型映射、覆盖、别名见「模型目录」页。
      </div>
    </div>
  </div>
</template>

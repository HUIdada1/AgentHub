<!--
  ============================================================
   作者：沐晖
   日期：2026-10-22
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<script setup lang="ts">
// 网关托管形态的登录页：校验管理令牌 → 存 localStorage → 重进主界面。
// 独立挂载（不经主 App）：主界面挂载即发一堆请求，未登录会全 401 把界面打花
//
// ⚠️ 为什么不再"无条件演验证密码"（§5.3.2）：两个令牌都没设时，后端 adminAuth 会把请求
// 当作 full 放行（D2 的既定语义，靠 bind 降级兜底），于是 /api/status 对**任何非空字符串**
// 都返回 200 —— 这个页面就会显示"登录成功"，而实际上什么都没认证。用户以为有门禁、
// 其实没有，比没有门禁更危险。现在先用免鉴权的 /api/capabilities 读 `authRequired`，
// 为 false 就如实说明"本实例未启用管理令牌"，不再假装校验。
import { ref } from "vue";
import { setToken } from "../api/web-transport";

const token = ref("");
const busy = ref(false);
const error = ref("");
// null = 还没探到 / 探测失败（**保守回落到原来的密码表单**，绝不能因为读不到 caps 就不让人登录）
const authRequired = ref<boolean | null>(null);
const capsProbed = ref(false);

async function probeAuth() {
  try {
    const res = await fetch("/api/capabilities");
    const j = await res.json();
    authRequired.value = typeof j?.authRequired === "boolean" ? j.authRequired : null;
  } catch {
    authRequired.value = null; // 探不到就按老路径走，不新增阻塞
  } finally {
    capsProbed.value = true;
  }
}
probeAuth();

// 未启用令牌时，用户明确选择"知道没有认证，仍然进入"
function enterWithoutAuth() {
  setToken("");
  window.location.reload();
}

async function submit() {
  const t = token.value.trim();
  if (!t || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const res = await fetch("/api/status", { headers: { authorization: `Bearer ${t}` } });
    if (res.status === 401) {
      error.value = "令牌不正确";
    } else if (!res.ok) {
      error.value = `网关返回 HTTP ${res.status}`;
    } else {
      setToken(t);
      window.location.reload();
    }
  } catch (e) {
    error.value = "无法连接网关：" + ((e as Error).message || e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <!-- 只有**确凿探到 authRequired===false** 才换成如实说明；
         探测失败/未回（null）一律保持原表单，不能因为多做了这项检查就把人挡在门外。 -->
    <form v-if="authRequired !== false" class="login-card" @submit.prevent="submit">
      <div class="login-title">AgentHub 网关控制台</div>
      <div class="login-sub">输入服务器上的管理令牌（AGENTHUB_ADMIN_TOKEN）</div>
      <input
        v-model="token"
        type="password"
        class="login-input"
        placeholder="管理令牌"
        autocomplete="current-password"
        autofocus
      />
      <button type="submit" class="login-btn" :disabled="busy || !token.trim()">
        {{ busy ? "验证中…" : "进入控制台" }}
      </button>
      <div v-if="error" class="login-err">{{ error }}</div>
    </form>

    <!-- 未启用管理令牌：不演"验证密码"（口径与 gateway/README.md 四态表 ② 一致，勿造第三份说法） -->
    <div v-else class="login-card">
      <div class="login-title">本实例未启用管理令牌</div>
      <div class="login-sub">
        服务器上没有设置 <code>AGENTHUB_ADMIN_TOKEN</code> / <code>AGENTHUB_ADMIN_READONLY_TOKEN</code>，
        管理面<strong>没有任何认证</strong>——这里不再假装"验证密码"，因为在没设令牌的情况下
        任何非空字符串都会"成功"，那是一层假的门禁，比没有门禁更危险。
      </div>
      <div class="login-sub" style="margin-top:10px">
        按安全闸第 ② 态，此时绑定已被<strong>强制降回容器回环</strong>：宿主的端口映射转不进来，
        只有容器内部能访问，这<strong>不是故障</strong>。<br />
        要在别的机器上打开控制台：在 <code>gateway/.env</code> 设
        <code>AGENTHUB_ADMIN_TOKEN=&lt;你的管理密码&gt;</code> 后重建容器。
      </div>
      <button type="button" class="login-btn" @click="enterWithoutAuth">我知道没有认证，仍然进入（本机）</button>
      <div v-if="!capsProbed" class="login-sub">正在确认这个实例的认证状态…</div>
    </div>
  </div>
</template>


<style scoped>
.login-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
  box-sizing: border-box;
}
.login-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 340px;
  padding: 28px 26px;
  border-radius: 16px;
  background: rgba(20, 24, 36, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.09);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(18px);
}
:root[data-theme="light"] .login-card {
  background: rgba(255, 255, 255, 0.86);
  border-color: rgba(15, 23, 42, 0.08);
}
.login-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--text, #e8ecf5);
}
.login-sub {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim, #94a3b8);
}
.login-input {
  height: 38px;
  padding: 0 12px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.25);
  color: var(--text, #e8ecf5);
  font-size: 13px;
  font-family: inherit;
  outline: none;
}
:root[data-theme="light"] .login-input {
  background: rgba(15, 23, 42, 0.04);
  border-color: rgba(15, 23, 42, 0.12);
}
.login-input:focus {
  border-color: rgba(99, 102, 241, 0.65);
}
.login-btn {
  height: 38px;
  border: none;
  border-radius: 9px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}
.login-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.login-err {
  font-size: 12px;
  color: #f87171;
  line-height: 1.5;
}
</style>

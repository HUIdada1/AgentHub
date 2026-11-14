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
defineProps<{ title: string; desc: string; /** 按钮文案：不传则不渲染按钮（空态本身无可跳转动作时用） */ actionText?: string }>();
defineEmits<{ (e: "action"): void }>();
</script>

<template>
  <div class="empty-state">
    <div class="eicon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M8 8h8M8 12h5" />
      </svg>
    </div>
    <div class="etitle">{{ title }}</div>
    <div class="edesc">{{ desc }}</div>
    <button v-if="actionText" class="btn-outline" @click="$emit('action')">{{ actionText }}</button>
  </div>
</template>

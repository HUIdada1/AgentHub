<script setup lang="ts">
defineProps<{ title: string; desc: string }>();
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
    <button class="btn-outline" @click="$emit('action')">前往设置接入</button>
  </div>
</template>

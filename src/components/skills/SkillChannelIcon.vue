<!--
  ============================================================
   作者：沐晖
   日期：2026-11-13
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<script setup lang="ts">
// 技能仓库 · 渠道工具图标组件（统一采用号池管家对应图标，高清位图优先 + 首字/图标回退）
import { computed } from "vue";
import { getToolIconUrl, getToolInitial, getToolPhosphor } from "../../utils/skillIcons";

const props = withDefaults(
  defineProps<{
    toolId?: string;
    name?: string;
    size?: number | "sm" | "md" | "lg" | "xl";
    rounded?: boolean;
    border?: boolean;
  }>(),
  {
    toolId: "",
    name: "",
    size: "md",
    rounded: true,
    border: true,
  }
);

const pxSize = computed(() => {
  if (typeof props.size === "number") return props.size;
  switch (props.size) {
    case "sm": return 20;
    case "md": return 28;
    case "lg": return 36;
    case "xl": return 48;
    default: return 28;
  }
});

const iconUrl = computed(() => getToolIconUrl(props.toolId));
const initialText = computed(() => getToolInitial(props.toolId, props.name));
const fallbackIcon = computed(() => getToolPhosphor(props.toolId));
</script>

<template>
  <div
    class="sk-channel-icon-wrap"
    :class="{ 'is-rounded': rounded, 'has-border': border }"
    :style="{ width: pxSize + 'px', height: pxSize + 'px', minWidth: pxSize + 'px' }"
  >
    <img
      v-if="iconUrl"
      :src="iconUrl"
      :alt="name || toolId"
      class="sk-channel-img"
      loading="lazy"
    />
    <div v-else class="sk-channel-fallback">
      <span v-if="initialText && initialText !== '?'" class="sk-channel-initial">
        {{ initialText }}
      </span>
      <i v-else class="ph" :class="fallbackIcon"></i>
    </div>
  </div>
</template>

<style scoped>
.sk-channel-icon-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
  background: var(--panel-2, rgba(255, 255, 255, 0.04));
  user-select: none;
  box-sizing: border-box;
}

.sk-channel-icon-wrap.is-rounded {
  border-radius: 8px;
}

.sk-channel-icon-wrap.has-border {
  border: 1px solid var(--border-soft, rgba(255, 255, 255, 0.08));
}

.sk-channel-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.sk-channel-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  color: var(--accent, #38bdf8);
  background: var(--accent-dim, rgba(56, 189, 248, 0.12));
}

.sk-channel-initial {
  line-height: 1;
  text-transform: uppercase;
}
</style>

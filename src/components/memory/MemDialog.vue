<!--
  AgentHub · 记忆仓库（Memory Hub）
  Copyright (c) 2026 沐辉 (HUIdada1)
  https://github.com/HUIdada1/AgentHub
  本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
-->
<!-- 记忆仓库 · 标准弹窗基座：本模块所有弹窗一律用它，外观与框架最外侧的「设置」弹窗完全一致
     （液态玻璃 + 半透明 + 幽灵关闭按钮 + 弹簧弹出 + 遮罩模糊，样式来自 element.css 的 .el-dialog）。
     用法约定（新加弹窗照这个写）：
       <MemDialog v-model:open="open" title="标题" sub="一句话说明" width="560px">
         ...正文...
         <template #foot><button class="btn btn-cta">确定</button></template>
       </MemDialog>
     宽度只用 560px（表单/结果）或 760px（长内容表格）；底部按钮一律走 foot 槽（右对齐、等间距）；
     正文里的表单控件用 f-input / f-select / f-el-select，块间距用 mem-section。 -->
<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** 开关（v-model:open） */
    open: boolean;
    title: string;
    /** 副标题：这个弹窗在做什么（可省） */
    sub?: string;
    /** 宽度：默认 560px；长内容表格用 760px */
    width?: string;
    /** 点遮罩是否关闭：进度/危险操作类弹窗传 false，避免误关 */
    closeOnClickModal?: boolean;
  }>(),
  { sub: "", width: "560px", closeOnClickModal: true },
);

const emit = defineEmits<{
  (e: "update:open", v: boolean): void;
  /** 关闭动画结束（需要复位内部状态时用它） */
  (e: "closed"): void;
}>();

const model = computed({ get: () => props.open, set: (v: boolean) => emit("update:open", v) });
</script>

<template>
  <el-dialog
    v-model="model"
    class="mem-dialog"
    :width="width"
    align-center
    append-to-body
    :close-on-click-modal="closeOnClickModal"
    @closed="emit('closed')"
  >
    <template #header>
      <!-- 需要标题里带状态点/徽标这类富内容时，用 header 插槽覆盖默认标题 -->
      <slot name="header">
        <div>
          <div class="md-title">{{ title }}</div>
          <div v-if="sub" class="md-sub">{{ sub }}</div>
        </div>
      </slot>
    </template>
    <slot />
    <template v-if="$slots.foot" #footer>
      <div class="md-foot"><slot name="foot" /></div>
    </template>
  </el-dialog>
</template>
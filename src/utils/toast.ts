/**
 * AgentHub · 记忆仓库（Memory Hub）
 * Copyright (c) 2026 沐辉 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// 全站顶部悬浮提示统一出口：样式（.ah-toast 玻璃面）、时长（3 秒自动消失）、
// 位置（offset 下移避开顶部横条）三件事在一处收口；各模块只管换文案。
// 用法与 element-plus 的 ElMessage 完全一致：import { toast as ElMessage } from "…/utils/toast"。
import { toast as ElMessage } from "./toast";

/** 与 ElMessage 的调用参数保持同构（本仓库实际只用 string 消息 + 四个快捷方法） */
type MsgHandler = { close: () => void };
type ToastFn = ((options: Record<string, unknown>) => MsgHandler) & {
  success(message: unknown, options?: Record<string, unknown>): MsgHandler;
  error(message: unknown, options?: Record<string, unknown>): MsgHandler;
  warning(message: unknown, options?: Record<string, unknown>): MsgHandler;
  info(message: unknown, options?: Record<string, unknown>): MsgHandler;
};

const TOAST_DURATION = 3000;
const TOAST_OFFSET = 64;

function show(options: Record<string, unknown>): MsgHandler {
  return ElMessage({
    duration: TOAST_DURATION,
    offset: TOAST_OFFSET,
    grouping: true,
    customClass: "ah-toast",
    ...options,
  } as Parameters<typeof ElMessage>[0]) as MsgHandler;
}

function shortcut(type: string) {
  return (message: unknown, options: Record<string, unknown> = {}) => show({ type, message, ...options });
}

const toast = show as ToastFn;
toast.success = shortcut("success");
toast.error = shortcut("error");
toast.warning = shortcut("warning");
toast.info = shortcut("info");

export { toast };
export default toast;

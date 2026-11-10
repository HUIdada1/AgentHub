/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-10
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *     此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 执行插件守卫：号池管家 / 本地网关里「必须由外置插件执行」的入口，在调用前先确认插件在。
// 没有插件时后端只会回一句 503（执行插件未启用、未就绪或未打开该渠道），用户看不出该装什么；
// 这里统一弹一句「需要安装 / 需要启用」，点确认直接落到「设置 · 外置插件」。
//
// 判定口径：只认新版 schema 且声明了执行渠道（channels 非空）的已安装插件——
// 老 schema 的桥接插件只同步号池数据，不提供模型执行，不能算数。
import { ElMessageBox } from "element-plus";
import { useAppStore } from "../stores/app";

/** 官方执行插件的默认叫法：一个都没装时提示里也要有名字，用户才知道去装什么 */
const FALLBACK_NAME = "模型增强执行器";

/** 弹窗用了 HTML 字符串：插件名来自第三方 manifest，必须转义 */
function esc(value: string): string {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/** 已安装且能提供模型执行的插件（不看启停） */
function candidates() {
  const app = useAppStore();
  return app.plugins.filter(
    (p) => p.installed && !p.invalid && p.compatible && (p.channels?.length || 0) > 0
  );
}

/** 当前是否已有启用中的执行插件（同步判定，用于禁用按钮之类的轻量场景）。
 *  schema 2 还要求已授权：只启用未授权的插件不会出现在 provider 会话里，
 *  自动接管也不会发生，提前拦下比让后端回一句 503 更清楚。 */
export function hasEnabledExecutionPlugin(): boolean {
  return candidates().some((p) => p.enabled && (p.schema !== 2 || p.authorized === true));
}

/** 是否是「插件缺失」类错误：code 优先，文案只兜底（后端文案可能微调） */
export function isPluginUnavailableError(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null;
  if (err?.code === "FORWARD_PLUGIN_UNAVAILABLE") return true;
  const msg = String(err?.message || "");
  return /插件未(安装|启用|绑定|就绪)|未绑定已授权的模型执行插件|没有安装.*插件/.test(msg);
}

/** 弹窗互斥：连点或两个入口同时触发时只留一个框 */
let prompting = false;

/**
 * 前置守卫：没有可用执行插件时弹窗并返回 false，调用方直接 return。
 * 会先刷新一次插件清单 —— 用户可能在弹窗外装了插件，不能拿旧列表把人拦住。
 * 刷新失败（IPC 异常）按「没有插件」提示，而不是放行：放行只会得到一句 503。
 */
export async function requireExecutionPlugin(task: string): Promise<boolean> {
  if (hasEnabledExecutionPlugin()) return true;
  if (prompting) return false;
  prompting = true;
  try {
    const app = useAppStore();
    await app.refreshPlugins().catch(() => { /* 读不到按未安装处理 */ });
    const list = candidates();
    if (list.some((p) => p.enabled && (p.schema !== 2 || p.authorized === true))) return true;

    const installed = list.length > 0;
    const name = esc(list[0]?.name || FALLBACK_NAME);
    const html = `
    <div style="line-height:1.75;font-size:13px">
      <div>「${esc(task)}」${installed ? "需要外置插件执行，但插件当前未启用或未授权。" : "需要外置插件提供模型执行能力，当前还没有安装。"}</div>
      <div style="margin-top:8px;color:var(--text-2)">· 插件：${name}</div>
      <div style="margin-top:10px;color:var(--text-3);font-size:12px">
        ${installed ? "在「设置 · 外置插件」里打开启用开关即可（启用时会自动补授权）；插件会自动接管它声明的渠道，只有同一渠道装了多个插件时才需要在插件「设置」里固定来源。" : "在「设置 · 外置插件」里导入插件包，安装后会自动启用。"}
      </div>
    </div>`;
    try {
      await ElMessageBox.confirm(html, installed ? "需要启用外置插件" : "需要安装外置插件", {
        dangerouslyUseHTMLString: true,
        confirmButtonText: installed ? "去启用" : "去安装",
        cancelButtonText: "知道了",
        type: "warning",
      });
      app.openSettings("plugins");
    } catch {
      /* 用户选择「知道了」：不打扰 */
    }
    return false;
  } finally {
    prompting = false;
  }
}

/** 错误守卫：catch 到插件缺失类错误时调用，返回 true 表示已被本守卫接管提示 */
export function handlePluginError(error: unknown, task: string): boolean {
  if (!isPluginUnavailableError(error)) return false;
  void requireExecutionPlugin(task);
  return true;
}

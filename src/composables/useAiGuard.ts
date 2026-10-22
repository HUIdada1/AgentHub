/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
/**
 * AgentHub · 记忆中枢（Memory Hub）
 * Copyright (c) 2026 沐晖 (HUIdada1)
 * https://github.com/HUIdada1/AgentHub
 * 本文件为开源项目 AgentHub 的组成部分，作者保留署名权；依据开源协议使用时禁止删除本声明。
 */

// AI 引导守卫：记忆中枢里凡是「会调模型」的入口，未配置或渠道报错时统一弹窗，
// 一键跳到「设置 · 模型与网关」处理。配置已上移为平台级，所以提示里的位置也必须指向设置页。
//
// 判定口径（逐层降级，避免靠单一文案）：
//   L0 ensureAiReady()：调用前先看有没有任何可用来源（两档全无才拦，宁可放过不可误拦）；
//   L1 来源可用性：弹窗正文列出「自定义 / 降级档」各自的状态，用户知道该动哪一档；
//   L2 报错归因：err.code === "no_model" → 未配置；其余 AI 渠道错误 → 带原始 message。
//
// 防打扰：同一次会话内「同一 code + 同一文案」只弹一次（批量任务/连点不刷屏）；
// 后台无人值守的任务不弹模态框（由调用方决定不接本守卫，例如写入路径的异步补判）。
import { ElMessageBox } from "element-plus";
import * as api from "../api/ipc";
import { useAppStore } from "../stores/app";

type AiError = Error & { code?: string; tried?: string[] };
type GuardCtx = { task?: string };

/** 已提示过的原因键：同会话内同因只弹一次 */
const shownKeys = new Set<string>();

function errOf(e: unknown): AiError {
  return (e || new Error("")) as AiError;
}

/** 是否属于「AI 渠道」问题：code 优先，文案只做兜底（后端文案可能微调，不能当唯一依据） */
function isAiError(e: unknown): boolean {
  const err = errOf(e);
  if (err.code === "no_model") return true;
  const msg = String(err.message || "");
  if (!msg) return false;
  return /没有可用于|模型|鉴权|API\s?Key|上游|供应商|网关|HTTP\s?[45]\d\d|超时|429|401|403|渠道/i.test(msg);
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

type Availability = { ready: boolean; lines: string[]; unknown: boolean };

/** 探测两个来源的可用性。任何一项读取失败都按「未知」处理并放行（不能因为探测失败就把用户拦住） */
async function probeAvailability(): Promise<Availability> {
  const [pRes, mRes, sRes] = await Promise.allSettled([
    api.memoryProviderList(),
    api.memoryModelList(),
    api.memoryLlmSources(),
  ]);
  const unknown = [pRes, mRes].some((r) => r.status === "rejected");
  if (unknown) return { ready: true, lines: [], unknown: true };

  const providers = (pRes as PromiseFulfilledResult<{ providers: any[] }>).value.providers || [];
  const models = (mRes as PromiseFulfilledResult<{ models: any[] }>).value.models || [];
  const degrade = (sRes.status === "fulfilled" ? ((sRes.value as any)?.degrade || {}) : {}) as { enabled?: boolean; providerId?: string; modelId?: string };

  const enabledProviders = providers.filter((p) => p.enabled !== false && p.id !== "gw-local");
  // 供应商有启用模型才算「真能出候选」：只有供应商壳子、模型全停用时，解析出来仍是空链
  const providerReady = enabledProviders.filter((p) => {
    const mine = models.filter((m) => m.providerId === p.id && m.enabled !== false);
    return mine.length > 0;
  });
  const degradeReady = degrade.enabled !== false && !!(degrade.providerId && degrade.modelId);

  const lines = [
    `自定义供应商：${enabledProviders.length} 个已启用${enabledProviders.length ? `（其中 ${providerReady.length} 个有启用模型）` : ""}`,
    `降级档：${degradeReady ? "已绑定模型" : "未绑定（不参与解析）"}`,
  ];
  return { ready: providerReady.length > 0 || degradeReady, lines, unknown: false };
}

/** 统一引导弹窗。返回 true 表示「已由本守卫接管提示」（含被节流静默） */
async function showGuide(opts: { key: string; title: string; body: string; lines?: string[]; detail?: string }): Promise<boolean> {
  if (shownKeys.has(opts.key)) return true;
  shownKeys.add(opts.key);
  const app = useAppStore();
  const rows = (opts.lines || []).map((l) => `<div>· ${esc(l)}</div>`).join("");
  const html = `
    <div style="line-height:1.75;font-size:13px">
      <div>${esc(opts.body)}</div>
      ${rows ? `<div style="margin-top:8px;color:var(--text-2)">${rows}</div>` : ""}
      ${opts.detail ? `<div style="margin-top:8px;padding:8px 10px;border-radius:6px;background:var(--bg-soft);font-family:var(--font-mono,monospace);font-size:12px;word-break:break-all">${esc(opts.detail)}</div>` : ""}
      <div style="margin-top:10px;color:var(--text-3);font-size:12px">配好之后回来重试即可，已配置的数据不会丢。</div>
    </div>`;
  try {
    await ElMessageBox.confirm(html, opts.title, {
      dangerouslyUseHTMLString: true,
      confirmButtonText: "去设置配置",
      cancelButtonText: "稍后",
      type: "warning",
      distinguishCancelAndClose: true,
    });
    app.openSettings("models");
  } catch {
    /* 用户选择「稍后」或关闭：不打扰 */
  }
  return true;
}

export function useAiGuard() {
  /**
   * 前置守卫：AI 入口开跑前调用。三个来源全都不可用时弹窗并返回 false，调用方直接 return。
   * 探测失败（IPC 异常）一律放行 —— 宁可让后端如实报错，也不能因为守卫自身出错把功能拦住。
   */
  async function ensureAiReady(ctx: GuardCtx = {}): Promise<boolean> {
    let st: Availability;
    try {
      st = await probeAvailability();
    } catch {
      return true;
    }
    if (st.ready || st.unknown) return true;
    await showGuide({
      key: "no_model:precheck",
      title: "还没配置可用的 AI 模型",
      body: `「${ctx.task || "该操作"}」需要调用模型，但当前没有任何可用的模型来源。`,
      lines: st.lines,
    });
    return false;
  }

  /**
   * 错误守卫：catch 到错误时调用。
   * 返回 true = 这是 AI 渠道问题，已接管提示（或被节流静默）；false = 不是 AI 问题，调用方自行提示。
   */
  function handleAiError(e: unknown, ctx: GuardCtx = {}): boolean {
    if (!isAiError(e)) return false;
    const err = errOf(e);
    const msg = String(err.message || "");
    const noModel = err.code === "no_model" || /没有可用于/.test(msg);
    const key = `${noModel ? "no_model" : "call_failed"}:${msg.slice(0, 60)}`;
    // 弹窗是异步的，这里不能 await（调用方在 catch 里同步收尾）；失败不影响业务
    void (async () => {
      let lines: string[] = [];
      try {
        const st = await probeAvailability();
        lines = st.lines;
      } catch {
        /* 探测失败就不带状态摘要，正文本身已经说清问题 */
      }
      await showGuide({
        key,
        title: noModel ? "还没配置可用的 AI 模型" : "AI 渠道调用失败",
        body: noModel
          ? `「${ctx.task || "该操作"}」找不到可用模型，本次没有执行。`
          : `「${ctx.task || "该操作"}」调用模型失败。`,
        lines,
        detail: noModel ? "" : msg,
      });
    })();
    return true;
  }

  /** 供调用方自行判断（例如自动化页只给 AI 类任务做前置检测） */
  function isNoModelError(e: unknown): boolean {
    const err = errOf(e);
    return err.code === "no_model" || /没有可用于/.test(String(err.message || ""));
  }

  return { ensureAiReady, handleAiError, isNoModelError };
}

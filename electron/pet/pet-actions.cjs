/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 桌宠模块 · 右键动作实现
//
// 每个动作都是「一个 async 函数 + 一条通知」，不持有任何 UI：
// 菜单（pet-menu.cjs）只负责组装 click，渲染层只负责弹菜单，窗口控制回落到 index.cjs。
//
// 复用现有能力，不在本模块重写：
//   · 提示词优化 → electron/backend/prompts/optimize.cjs（与「提示词库 · 优化」同一套风格/模型/历史）
//   · 今日 token 用量 → main.cjs 注入的 usageTodaySummary()（底层 backend/db.cjs 的同一份统计口径）
"use strict";
const { clipboard, Notification } = require("electron");
const petConfig = require("./pet-config.cjs");
const petInput = require("./pet-input.cjs");

/** 运行上下文：由 index.cjs 在 boot 时注入，避免本模块反向 require 主进程 */
let ctx = {
  log: () => {},
  /** (text) => 今日 token 数 | null（main.cjs 的 usageTodaySummary） */
  usageTodaySummary: () => null,
  /** (n) => 中文单位数字（main.cjs 的 formatNum） */
  formatNum: (n) => String(n),
  /** (title, body) => void */
  notify: () => {},
  /** 推事件给桌宠渲染层（busy 状态等） */
  pushEvent: () => {},
  /** 窗口控制，由 index 注入 */
  hide: () => {},
  closePet: () => {},
  resetPosition: () => {},
  /** 通知主窗口设置页刷新（配置被右键菜单改过时） */
  broadcastConfig: () => {},
};

function setContext(next) {
  ctx = Object.assign(ctx, next || {});
}

function log(kind, detail) {
  try {
    ctx.log(`pet-actions/${kind}`, detail);
  } catch {
    /* 忽略 */
  }
}

/**
 * 通知用户：优先用宿主注入的 notify（与托盘/系统通知同源），失败再退回原生 Notification。
 * 两者都不可用时**不能静默**——否则用户只会觉得「点了没反应」：
 * 至少写 pet.log，并推一条 busy:false 给渲染层当作「动作已结束」信号，别让桌宠停在忙碌态。
 * @returns {boolean} 是否至少成功投递一次
 */
function notify(title, body) {
  // 1) 宿主注入的实现（main.cjs 的 notify；它内部再判 Notification.isSupported）
  if (typeof ctx.notify === "function") {
    try {
      const delivered = ctx.notify(title, body);
      // 注入实现允许用 false 表示「没投递成功」；返回 undefined 视为已尝试（兼容旧实现）
      if (delivered !== false) return true;
      log("notify-injected-unavailable", `${title} :: ${body}`);
    } catch (e) {
      log("notify-injected-threw", String((e && e.message) || e));
    }
  }
  // 2) 原生 Notification 兜底（保留原有逻辑）
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
      return true;
    }
  } catch (e) {
    log("notify-native-threw", String((e && e.message) || e));
  }
  // 3) 都不可用：日志 + 通知渲染层结束忙碌态，绝不静默
  log("notify-unavailable", `${title} :: ${body}`);
  try {
    ctx.pushEvent({ event: "busy", on: false, text: body });
  } catch {
    /* 渲染层事件也发不出去（窗口已销毁）：日志已留痕，到此为止 */
  }
  return false;
}

// ===== 今日 token 用量 =====

/** @returns {{ok:boolean, tokens:number|null, text:string}} */
function usageToday() {
  let tokens = null;
  try {
    tokens = ctx.usageTodaySummary();
  } catch (e) {
    log("usage-failed", String((e && e.message) || e));
  }
  const text = tokens == null ? "今日用量 —" : `今日用量 ${ctx.formatNum(tokens)} token`;
  return { ok: true, tokens: tokens == null ? null : tokens, text };
}

// ===== 提示词优化 =====

/** 惰性加载优化器：模块缺失/初始化抛错时只让这个动作不可用，不拖垮桌宠 */
function getOptimizer() {
  try {
    const mod = require("../backend/prompts/optimize.cjs");
    return mod && typeof mod.optimize === "function" ? mod : null;
  } catch (e) {
    log("optimizer-require-failed", String((e && e.message) || e));
    return null;
  }
}

/** 优化错误码 → 用户能看懂的一句话（与提示词库页的文案口径保持一致） */
function explainCode(code, message) {
  switch (code) {
    case "no_model":
      return "尚未配置可用模型，请前往「设置 · 模型与网关」配置供应商与模型";
    case "empty_input":
      return "没有读到可优化的文本";
    case "too_long":
      return message || "原文过长，请分段优化";
    case "cancelled":
      return "已取消";
    case "timeout":
      return "模型响应超时，请稍后重试";
    case "empty_result":
      return "模型返回了空内容，请重试";
    default:
      return message || "优化失败";
  }
}

/** 正在优化的互斥标记：连点右键不该并发烧两次模型调用 */
let optimizing = false;

/**
 * 右键「优化提示词」：读前台输入框 → 调模型 → 回填。
 * @param {{ hwnd?: any }} opts hwnd 为弹菜单前记录的前台窗口句柄
 */
async function optimizePrompt(opts = {}) {
  if (optimizing) {
    // 互斥期间也必须给反馈：菜单点击处只 catch 不提示，静默会让用户以为「点了没反应」
    const busyMsg = "正在优化中，请稍候";
    notify("卡冈图雅", busyMsg);
    return { ok: false, message: busyMsg };
  }
  optimizing = true;
  const cfg = petConfig.get();
  // 快照：动作过程中可能被 Ctrl+C（读输入框）改写，失败/不写结果时必须还原
  const oldClip = readClipSafe();
  let busyTimer = null;
  try {
    // 长任务先给渲染层一个"忙碌"信号（桌宠会在黑洞下方浮一行小字；不支持该事件时无副作用）
    busyTimer = setTimeout(() => {
      try { ctx.pushEvent({ event: "busy", on: true, text: "优化提示词…" }); } catch { /* 忽略 */ }
    }, 260);

    // ---- 1. 取原文 ----
    let text = "";
    let via = "clipboard";
    if (cfg.optimize.source === "auto" && petInput.available()) {
      const copied = await petInput.copyAllFrom(opts.hwnd);
      if (!copied.ok) log("copy-failed", copied.message || "");
      const next = readClipSafe();
      if (next && next !== oldClip) {
        text = next;
        via = "input";
      }
    }
    // auto 模式读不到（焦点不在输入框 / 快捷键被占用 / 用户只复制了内容没进输入框）时，
    // 只要剪贴板本身有内容就兜底用剪贴板 —— 这个降级能救掉大半"点了没反应"的投诉
    if (!text) {
      const clip = readClipSafe();
      if (clip) {
        text = clip;
        via = "clipboard";
      }
    }
    if (!text || !text.trim()) {
      // 不写结果的提前返回：把可能已被 Ctrl+C 改写的剪贴板还原，别让「点一下右键」丢掉用户原本复制的内容
      restoreClipIfNeeded(oldClip);
      notify("卡冈图雅", petInput.available() && cfg.optimize.source === "auto"
        ? "没读到有效输入框内容，也没读到剪贴板文本。请先把光标放进输入框，或先复制要优化的文字"
        : "剪贴板里没有可优化的文本。请先复制要优化的提示词");
      return { ok: false, message: "未检测到有效输入框 / 剪贴板为空" };
    }

    // ---- 2. 调模型（复用提示词库的优化器，风格/模型/历史完全同源） ----
    const opt = getOptimizer();
    if (!opt) {
      restoreClipIfNeeded(oldClip);
      notify("卡冈图雅", "提示词优化模块不可用（可能未随本次安装包一起安装）");
      return { ok: false, message: "优化模块不可用" };
    }
    if (busyTimer) clearTimeout(busyTimer);
    ctx.pushEvent({ event: "busy", on: true, text: "优化提示词…" });

    const res = await opt.optimize({
      text,
      styleId: cfg.optimize.styleId || "",
      extra: cfg.optimize.extra || "",
      // 与提示词库页同一个入口时的默认场景；不传则由后端读配置
      scenario: undefined,
    });

    if (!res || res.ok === false) {
      const msg = explainCode(res && res.code, res && res.message);
      // 失败必须还原剪贴板：用户只是点了下右键，不该丢掉原本复制的内容
      restoreClipIfNeeded(oldClip);
      notify("提示词优化失败", msg);
      return { ok: false, message: msg, code: res && res.code };
    }

    // ---- 3. 回填 ----
    writeClipSafe(res.text);
    let pasted = false;
    let pasteError = "";
    if (cfg.optimize.pasteBack && via === "input") {
      // pasteAllTo 只在「目标窗口仍有效且确实拿到前台焦点」时才发 Ctrl+A/Ctrl+V；
      // 模型调用可能持续几十秒，用户切走窗口是常态，此时它会返回失败，我们只如实提示剪贴板已就绪。
      const p = await petInput.pasteAllTo(opts.hwnd);
      pasted = !!p.ok;
      if (!pasted) {
        pasteError = String((p && p.message) || "目标窗口已失焦，已复制到剪贴板");
        log("paste-back-skipped", pasteError);
      }
    }
    if (res.unchanged) {
      // 不是错误：模型认为原文已经够清晰。必须明说，否则用户会以为"点了没反应"
      notify("提示词已足够清晰", "模型判断原文不需要改写，已保留原样");
      return { ok: true, unchanged: true, text: res.text, styleName: res.styleName, model: res.model, pasted, via };
    }
    const styleTag = res.styleName || "默认风格";
    notify(
      "提示词优化完成",
      pasted
        ? `已回填到原输入框（${styleTag} · ${res.model || "模型"}）`
        : `${pasteError || "已复制到剪贴板"}，请手动 Ctrl+V 粘贴（${styleTag}）`,
    );
    return { ok: true, text: res.text, styleName: res.styleName, model: res.model, pasted, via };
  } catch (e) {
    restoreClipIfNeeded(oldClip);
    const msg = String((e && e.message) || e);
    log("optimize-threw", msg);
    notify("提示词优化失败", msg);
    return { ok: false, message: msg };
  } finally {
    optimizing = false;
    if (busyTimer) clearTimeout(busyTimer);
    try { ctx.pushEvent({ event: "busy", on: false }); } catch { /* 忽略 */ }
  }
}

function readClipSafe() {
  try {
    return clipboard.readText() || "";
  } catch {
    return "";
  }
}

function writeClipSafe(text) {
  try {
    clipboard.writeText(String(text == null ? "" : text));
    return true;
  } catch {
    return false;
  }
}

/**
 * 还原剪贴板快照：**只在本动作确实改写过剪贴板时**才写回。
 *
 * 为什么不无条件 writeClipSafe(oldClip)：oldClip 只取文本，若用户剪贴板里是图片/文件
 * （readText 返回 ""），无条件写回 "" 会把它清掉；而 copyAllFrom 在新实现里失败时根本不会发键、
 * 不会动剪贴板。所以先比对当前文本与快照，一致就说明没被改过，直接跳过。
 */
function restoreClipIfNeeded(snapshot) {
  if (readClipSafe() === snapshot) return false;
  return writeClipSafe(snapshot);
}

/** 设置面板「测试」按钮：只校验优化链路是否具备（不真调模型，省 token） */
function optimizePreview() {
  const cfg = petConfig.get();
  const opt = getOptimizer();
  if (!opt) return { ok: false, message: "提示词优化模块不可用" };
  const parts = [
    `读取方式：${cfg.optimize.source === "auto" ? "自动读前台输入框" : "仅剪贴板"}`,
    `键盘模拟：${petInput.available() ? "可用" : "不可用（" + petInput.unavailableReason() + "）"}`,
    `回填：${cfg.optimize.pasteBack ? "开启" : "关闭"}`,
    `风格：${cfg.optimize.styleId || "跟随默认"}`,
  ];
  return { ok: true, message: parts.join(" · ") };
}

// ===== 菜单动作包装（供 pet-menu.cjs 直接引用） =====

const actions = {
  usageToday,
  optimizePrompt,
  optimizePreview,
  hide() {
    ctx.hide();
  },
  resetPosition() {
    const r = ctx.resetPosition();
    if (r && r.ok === false) notify("卡冈图雅", r.message || "重置位置失败");
  },
  closePet() {
    ctx.closePet();
  },
};

module.exports = { setContext, usageToday, optimizePrompt, optimizePreview, actions, notify };

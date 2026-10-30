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
// 桌宠模块 · 前台输入框读写（Windows 键盘模拟）
//
// 「右键 → 优化提示词」要拿到用户正在写的提示词，而提示词在**别的程序**的输入框里，
// 没有跨进程的通用读取方式（UIA 对 Electron/浏览器内嵌输入框覆盖并不完整）。
// 这里用最稳的一条路：把焦点还给用户原来的前台窗口 → 发 Ctrl+A / Ctrl+C → 读剪贴板。
//
// 为什么用 koffi 而不是 Electron 的 sendInput：
//   Electron 没有键盘模拟 API；koffi 已是项目既有依赖（backend/sqlcipher.cjs 在用），
//   直接调 user32 的 keybd_event 即可，不需要再引一个原生模块。
//
// 失败一律返回 { ok:false }，由上层降级为「只处理剪贴板」，绝不阻塞桌宠主流程。
"use strict";

const KEYUP = 0x0002;
const VK = {
  LBUTTON: 0x01,
  CONTROL: 0x11,
  A: 0x41,
  C: 0x43,
  V: 0x56,
  ESC: 0x1B,
};

let api = null; // 绑定成功后是 { keybd_event, ... }；false = 不可用
let bindError = "";

function bind() {
  if (api !== null) return api;
  if (process.platform !== "win32") {
    api = false;
    bindError = "仅 Windows 支持键盘模拟";
    return api;
  }
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    api = {
      // keybd_event(BYTE bVk, BYTE bScan, DWORD dwFlags, ULONG_PTR dwExtraInfo)
      keybd_event: user32.func("void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)"),
      GetForegroundWindow: user32.func("uintptr __stdcall GetForegroundWindow()"),
      SetForegroundWindow: user32.func("int __stdcall SetForegroundWindow(uintptr hWnd)"),
      IsWindow: user32.func("int __stdcall IsWindow(uintptr hWnd)"),
      // 拖拽看门狗用：主进程据此判断左键是否仍按着。
      // GetAsyncKeyState 返回 SHORT：最高位 0x8000 = 当前按下（koffi 用 int16 接，负数也能按位判断）。
      GetAsyncKeyState: user32.func("int16 __stdcall GetAsyncKeyState(int nVirtKey)"),
    };
  } catch (e) {
    api = false;
    bindError = String((e && e.message) || e);
  }
  return api;
}

function available() {
  return !!bind();
}

function unavailableReason() {
  bind();
  return bindError || "键盘模拟不可用";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keyDown(vk) {
  api.keybd_event(vk, 0, 0, 0);
}
function keyUp(vk) {
  api.keybd_event(vk, 0, KEYUP, 0);
}

/** 发送 Ctrl + 单键（按下/抬起成对；keybd_event 是同步投递，不需要逐键 sleep） */
function ctrlKey(vk) {
  keyDown(VK.CONTROL);
  keyDown(vk);
  keyUp(vk);
  keyUp(VK.CONTROL);
}

/** 记录当前前台窗口句柄（弹菜单之前调用，用来在菜单关闭后把焦点还回去） */
function getForeground() {
  if (!bind()) return null;
  try {
    return api.GetForegroundWindow();
  } catch {
    return null;
  }
}

/** 句柄是否仍是有效窗口（用户可能已经把那个程序关了） */
function isWindow(hwnd) {
  if (!bind() || hwnd == null) return false;
  try {
    return !!api.IsWindow(hwnd);
  } catch {
    return false;
  }
}

/** 把焦点还给指定窗口；返回 API 调用是否成功（是否真的切过去由 waitForeground 复核） */
function focusWindow(hwnd) {
  if (!bind() || hwnd == null) return false;
  try {
    return !!api.SetForegroundWindow(hwnd);
  } catch {
    return false;
  }
}

/** 句柄比较：koffi 的 uintptr 可能是 number，也可能是 bigint，统一按十进制字符串比较 */
function sameHandle(a, b) {
  return a != null && b != null && String(a) === String(b);
}

/**
 * 左键当前是否按下（拖拽看门狗用）。
 * @returns {boolean|null} true/false；键盘模拟不可用时返回 null（调用方据此只保留超时兜底）
 */
function isLeftButtonDown() {
  if (!bind()) return null;
  try {
    return (api.GetAsyncKeyState(VK.LBUTTON) & 0x8000) !== 0;
  } catch {
    return null;
  }
}

/**
 * 等目标窗口**真正**成为前台窗口（默认 400ms）。
 *
 * SetForegroundWindow 受 Windows「前台锁定」策略限制：经常返回成功，但焦点并没有切过去。
 * 此时若继续发 Ctrl+A / Ctrl+C / Ctrl+V，按键会打到**当前前台窗口**（可能是别的程序）：
 * 轻则读错内容，重则把用户另一个编辑器的内容全选覆盖。所以必须用 GetForegroundWindow() 复核，
 * 不一致一律不发键，由调用方降级为「只动剪贴板 + 如实提示」。
 */
async function waitForeground(hwnd, timeoutMs = 400) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (sameHandle(getForeground(), hwnd)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(30);
  }
}

/**
 * 从目标窗口读取「全选后的选中文本」：Ctrl+A + Ctrl+C。
 * 不负责读剪贴板（调用方持有 clipboard，避免本模块依赖 electron 的 clipboard 单例时序）。
 * 只有确认目标窗口已是前台窗口才发键；没有目标窗口 / 焦点没拿到一律返回失败，
 * 让上层走剪贴板兜底，绝不把按键打到别的程序上。
 * @param {*} hwnd 目标窗口句柄（getForeground() 的返回值）
 */
async function copyAllFrom(hwnd) {
  if (!bind()) return { ok: false, message: unavailableReason() };
  if (hwnd == null) return { ok: false, message: "没有可用的目标窗口（前台不是别的程序）" };
  if (!isWindow(hwnd)) return { ok: false, message: "目标窗口已关闭" };
  // 抢回焦点：菜单刚关时前台可能还是桌宠自己，不切回去就会把 Ctrl+C 打到桌宠页面上
  focusWindow(hwnd);
  if (!(await waitForeground(hwnd))) {
    return { ok: false, message: "目标窗口没有拿到焦点，已跳过 Ctrl+A/Ctrl+C" };
  }
  ctrlKey(VK.A);
  await sleep(35);
  ctrlKey(VK.C);
  // 目标应用把内容写进剪贴板是异步的（浏览器还要经过一次渲染进程投递），180ms 是实测下限
  await sleep(190);
  return { ok: true };
}

/**
 * 把剪贴板内容回填到目标窗口：Ctrl+A + Ctrl+V（覆盖原内容）。
 * 用户在大多数编辑器里还能 Ctrl+Z 撤销，故不算不可逆操作——但「覆盖」的前提是目标窗口确实是前台窗口：
 * 模型调用可能持续几十秒，用户早就切走了；此时若还发 Ctrl+A/Ctrl+V，会把别的程序内容全选覆盖。
 * 所以这里同样先校验句柄 + 复核前台窗口，不满足就只返回失败，由上层提示「已复制到剪贴板，请手动粘贴」。
 */
async function pasteAllTo(hwnd) {
  if (!bind()) return { ok: false, message: unavailableReason() };
  if (hwnd == null) return { ok: false, message: "目标窗口已失焦，已复制到剪贴板" };
  if (!isWindow(hwnd)) return { ok: false, message: "目标窗口已关闭，已复制到剪贴板" };
  focusWindow(hwnd);
  if (!(await waitForeground(hwnd))) {
    return { ok: false, message: "目标窗口没有拿到焦点，已复制到剪贴板" };
  }
  ctrlKey(VK.A);
  await sleep(35);
  ctrlKey(VK.V);
  await sleep(150);
  return { ok: true };
}

module.exports = {
  available,
  unavailableReason,
  getForeground,
  isWindow,
  focusWindow,
  isLeftButtonDown,
  copyAllFrom,
  pasteAllTo,
  VK,
};

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

/** 把焦点还给指定窗口；失败返回 false（不阻断——按键会打到当前前台窗口） */
function focusWindow(hwnd) {
  if (!bind() || hwnd == null) return false;
  try {
    return !!api.SetForegroundWindow(hwnd);
  } catch {
    return false;
  }
}

/**
 * 从目标窗口读取「全选后的选中文本」：Ctrl+A + Ctrl+C。
 * 不负责读剪贴板（调用方持有 clipboard，避免本模块依赖 electron 的 clipboard 单例时序）。
 * @param {*} hwnd 目标窗口句柄（getForeground() 的返回值）
 */
async function copyAllFrom(hwnd) {
  if (!bind()) return { ok: false, message: unavailableReason() };
  // 1) 抢回焦点：菜单刚关时前台可能还是桌宠自己，不切回去就会把 Ctrl+C 打到桌宠页面上
  if (hwnd != null) {
    focusWindow(hwnd);
    await sleep(70);
    // SetForegroundWindow 受前台锁定策略限制可能不生效，此时按键会落到当前前台窗口，
    // 由上层的「剪贴板没变化 → 判定无有效输入框」兜底，不会误伤
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
 * 用户在大多数编辑器里还能 Ctrl+Z 撤销，故不算不可逆操作。
 */
async function pasteAllTo(hwnd) {
  if (!bind()) return { ok: false, message: unavailableReason() };
  if (hwnd != null) {
    focusWindow(hwnd);
    await sleep(70);
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
  copyAllFrom,
  pasteAllTo,
  VK,
};

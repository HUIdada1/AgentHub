// issue #90 回归守卫：设置页「整份保存」不得冲掉 out-of-band 的 proxy 字段
//
// 现象（GitHub issue #90 评论 / javalover123 2026-10-10）：
//   「似乎有个 上游启闭，关掉 有道，点击 完成，就可以了。
//     但是，如果再次点击 保存并重启服务，再次点击 上游启闭，有道 又打开了」
// 全库同类字段（共 3 个，都由独立 IPC 直接写盘、不经过设置页表单）：
//   · channelEnabled   ← proxy_channel_toggle（上游启闭）
//   · checkinAutoRules ← proxy_checkin_auto_set（按渠道自动签到）
//   · restoreOnLaunch  ← rememberRunning（网关启停时自动记忆）
//
// 本守卫锁住两条**相反**的契约（缺一不可）：
//   A. 设置页整份提交（saveConfigFromUI）→ 这三个字段**必须**以磁盘为准（旧快照不得冲掉）
//   B. 那三个字段各自的写入方（saveConfig）→ **必须**能正常写盘
//      （若把「磁盘优先」错写进 saveConfig，写入方的改动会被自己刚读到的旧值覆盖，功能当场失效）
//
// 全部在沙箱数据目录内运行，带安全闸门，绝不触碰真实配置。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-issue90-"));
process.env.AGENTHUB_DATA_DIR = SANDBOX;

let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; bad.push(name + (extra ? "  <- " + extra : "")); console.log("  FAIL " + name + (extra ? "   <- " + extra : "")); }
}

const config = require("../electron/backend/config.cjs");

// —— 安全闸门 ——
const cfgPath = config.configPath();
const inSandbox = path.resolve(cfgPath).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase());
console.log("=== 安全闸门 ===");
console.log("  沙箱 = " + SANDBOX);
console.log("  配置路径 = " + cfgPath);
ok("配置路径在沙箱内（绝不写真实配置）", inSandbox);
if (!inSandbox) { console.error("拒绝运行：配置路径不在沙箱内"); process.exit(2); }

const FIELDS = config.OUT_OF_BAND_PROXY_FIELDS;
console.log("");
console.log("=== 前置：名单与接口存在 ===");
ok("导出了 OUT_OF_BAND_PROXY_FIELDS", Array.isArray(FIELDS) && FIELDS.length === 3, JSON.stringify(FIELDS));
ok("名单含三个字段",
  ["channelEnabled", "checkinAutoRules", "restoreOnLaunch"].every((k) => FIELDS.includes(k)),
  JSON.stringify(FIELDS));
ok("导出了 saveConfigFromUI", typeof config.saveConfigFromUI === "function");

// 磁盘上写入「用户通过各自 IPC 设置好的」状态
function writeDiskState() {
  const cfg = config.loadConfig();
  cfg.proxy.channelEnabled = { lobster: false };            // 有道 已关闭
  cfg.proxy.checkinAutoRules = { lobster: { enabled: true, time: "09:00", jitterMin: 30 } };
  cfg.proxy.restoreOnLaunch = true;
  config.saveConfig(cfg);                                   // = 那三个 IPC 所用的路径
}
writeDiskState();
const disk0 = config.loadConfig().proxy;
console.log("");
console.log("=== 磁盘初始状态（模拟用户已用各弹窗设好）===");
console.log("  channelEnabled   = " + JSON.stringify(disk0.channelEnabled));
console.log("  checkinAutoRules = " + JSON.stringify(disk0.checkinAutoRules));
console.log("  restoreOnLaunch  = " + JSON.stringify(disk0.restoreOnLaunch));
ok("磁盘已记录 channelEnabled.lobster=false", disk0.channelEnabled && disk0.channelEnabled.lobster === false);
ok("磁盘已记录 checkinAutoRules.lobster", !!(disk0.checkinAutoRules && disk0.checkinAutoRules.lobster));
ok("磁盘已记录 restoreOnLaunch=true", disk0.restoreOnLaunch === true);

// —— 契约 A：设置页整份提交（旧快照）不得冲掉 ——
console.log("");
console.log("=== 契约 A：设置页整份保存（模拟渲染层旧快照）===");
const stale = config.defaultConfig();                       // 旧快照：这三个字段是默认空值
stale.proxy.port = 9600;                                    // 但用户确实改了端口（必须生效）
console.log("  旧快照提交时 channelEnabled = " + JSON.stringify(stale.proxy.channelEnabled));
config.saveConfigFromUI(stale);
const after = config.loadConfig().proxy;
console.log("  保存后磁盘 channelEnabled   = " + JSON.stringify(after.channelEnabled));
console.log("  保存后磁盘 checkinAutoRules = " + JSON.stringify(after.checkinAutoRules));
console.log("  保存后磁盘 restoreOnLaunch  = " + JSON.stringify(after.restoreOnLaunch));
ok("A1 channelEnabled 未被冲掉（有道 仍是关闭）", after.channelEnabled && after.channelEnabled.lobster === false, JSON.stringify(after.channelEnabled));
ok("A2 checkinAutoRules 未被冲掉", !!(after.checkinAutoRules && after.checkinAutoRules.lobster), JSON.stringify(after.checkinAutoRules));
ok("A3 restoreOnLaunch 未被冲掉", after.restoreOnLaunch === true, JSON.stringify(after.restoreOnLaunch));
ok("A4 设置页真正拥有的字段照常生效（port 改成了 9600）", Number(after.port) === 9600, String(after.port));

// —— 契约 B：三个写入方自己的写入必须仍然生效 ——
console.log("");
console.log("=== 契约 B：各写入方（走 saveConfig）仍能正常写盘 ===");
{
  const cfg = config.loadConfig();
  cfg.proxy.channelEnabled = { ...(cfg.proxy.channelEnabled || {}), qoder: false };
  config.saveConfig(cfg);
}
ok("B1 channelEnabled 可新增键（qoder=false）",
  config.loadConfig().proxy.channelEnabled.qoder === false,
  JSON.stringify(config.loadConfig().proxy.channelEnabled));
{
  const cfg = config.loadConfig();
  cfg.proxy.channelEnabled = {};                             // 重新启用全部
  config.saveConfig(cfg);
}
ok("B2 channelEnabled 可清空（重新启用）",
  JSON.stringify(config.loadConfig().proxy.channelEnabled) === "{}",
  JSON.stringify(config.loadConfig().proxy.channelEnabled));
{
  const cfg = config.loadConfig();
  cfg.proxy.restoreOnLaunch = false;
  config.saveConfig(cfg);
}
ok("B3 restoreOnLaunch 可改回 false", config.loadConfig().proxy.restoreOnLaunch === false);
{
  const cfg = config.loadConfig();
  cfg.proxy.checkinAutoRules = {};
  config.saveConfig(cfg);
}
ok("B4 checkinAutoRules 可清空", JSON.stringify(config.loadConfig().proxy.checkinAutoRules) === "{}");

// —— 契约 C：读盘失败时不得让设置页整体保存失败 ——
console.log("");
console.log("=== 契约 C：兜底不得让保存本身失败 ===");
{
  const r = config.saveConfigFromUI(config.defaultConfig());
  ok("C1 saveConfigFromUI 返回 ok:true", !!(r && r.ok === true), JSON.stringify(r));
  // C2：saveConfigFromUI 里只有「读盘」那段被 try 包住；保存/校验的异常必须照常抛出，
  //     否则设置页会把非法配置当成功（静默丢配置）。用一个缺 webdav 的残缺配置触发。
  let threw = false;
  try { config.saveConfigFromUI({ proxy: {} }); } catch { threw = true; }
  ok("C2 保存/校验失败仍会抛错（不被读盘兜底吞掉）", threw);
  // C3：兜底只影响那三个字段，其余字段不会被顺带改动
  {
    const c = config.defaultConfig();
    c.proxy.port = 9601;
    config.saveConfigFromUI(c);
    const p = config.loadConfig().proxy;
    ok("C3 其余设置页字段照常生效（port 9601）", Number(p.port) === 9601, String(p.port));
  }
}

console.log("");
console.log("RESULT: " + pass + " passed / " + fail + " failed");
if (bad.length) { console.log("failures:"); bad.forEach((x) => console.log("  - " + x)); }
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);

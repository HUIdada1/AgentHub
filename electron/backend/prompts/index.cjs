/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-23
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *      此注释为版权与授权声明，禁止删除。
 *  ============================================================
 */
// 提示词库（第五板块）· 后端总入口：IPC 注册 + 生命周期
//
// 为什么 IPC 注册与板块开关解耦：
//   ipcMain.handle 对同一通道重复注册会抛错，所以注册必须只做一次；
//   而「停用板块」只应停掉后台设施（定时同步调度）。若把注册也塞进 boot()，
//   停用后再启用就会在第二次注册时抛错，表现为「开关一切就坏」。
"use strict";
const fs = require("node:fs");
const config = require("../config.cjs");
const store = require("./store.cjs");
const styles = require("./styles.cjs");
const history = require("./history.cjs");
const optimize = require("./optimize.cjs");
const sync = require("./sync.cjs");
const sched = require("./sched.cjs");

let registered = false;

/** 主进程 → 渲染层广播（走既有 app:event 通道，event 字段固定 "prompts"） */
function emit(payload) {
  try {
    const { BrowserWindow } = require("electron");
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("app:event", payload);
    }
  } catch { /* 无窗口环境（脚本直跑）忽略 */ }
}

function register({ ipcMain, shell } = {}) {
  if (registered || !ipcMain) return;
  registered = true;
  sync.setEmitter(emit);

  /** 统一信封：任何异常都转成 { ok:false, message }，绝不让异常穿透到渲染层
   *  （穿透后渲染层拿到的是 "Error invoking remote method" 这种没有信息量的字符串） */
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_e, args) => {
      try {
        const r = await fn(args || {});
        return r === undefined ? { ok: true } : r;
      } catch (e) {
        return { ok: false, message: String((e && e.message) || e) };
      }
    });
  };

  // ===== 4.1 库 =====
  handle("prompts_list", (a) => {
    const r = store.listItems({ includeTrash: a.includeTrash === true });
    return { ok: true, items: r.items, missing: r.missing };
  });
  handle("prompts_get", (a) => {
    const item = store.getItem(String(a.id || ""));
    if (!item) return { ok: false, message: "条目不存在" };
    return { ok: true, item, versions: store.loadVersions(item.id) };
  });
  handle("prompts_save", (a) => {
    const r = store.saveItem(a.item || {}, a.expectedHash);
    if (r.ok) {
      emit({ event: "prompts", type: "library-changed" });
      return { ok: true, id: r.id, hash: r.hash, item: r.item };
    }
    return r;
  });
  handle("prompts_delete", (a) => {
    const r = store.deleteItem(String(a.id || ""));
    if (r.ok) emit({ event: "prompts", type: "library-changed" });
    return r;
  });
  handle("prompts_restore", (a) => {
    const r = store.restoreItem(String(a.id || ""));
    if (r.ok) emit({ event: "prompts", type: "library-changed" });
    return r;
  });
  handle("prompts_purge", (a) => {
    const r = store.purgeItem(String(a.id || ""));
    if (r.ok) emit({ event: "prompts", type: "library-changed" });
    return r;
  });
  handle("prompts_empty_trash", () => {
    const r = store.emptyTrash();
    emit({ event: "prompts", type: "library-changed" });
    return r;
  });
  handle("prompts_stats", () => {
    const s = store.stats();
    const conflicts = sync.listConflicts().filter((c) => !c.resolved && !c.autoMerged).length;
    return { ok: true, stats: { ...s, conflicts } };
  });
  handle("prompts_meta", () => ({ ok: true, ...store.metaIndex() }));
  handle("prompts_export", (a) => store.exportItems(a.ids, a.format === "md" ? "md" : "json"));
  handle("prompts_import", (a) => {
    const fmt = a.format === "md" ? "md" : "json";
    const onConflict = ["new", "overwrite", "skip"].includes(a.onConflict) ? a.onConflict : "new";
    const r = store.importItems(a.data, fmt, onConflict);
    if (r.ok) emit({ event: "prompts", type: "library-changed" });
    return r;
  });
  handle("prompts_open_dir", async () => {
    const dir = store.ensureLib();
    if (shell && shell.openPath) await shell.openPath(dir);
    return { ok: true, dir };
  });
  handle("prompts_set_dir", (a) => {
    const dir = String(a.dir || "").trim();
    if (dir && !require("node:path").isAbsolute(dir)) return { ok: false, message: "请输入绝对路径" };
    const cfg = config.loadConfig();
    cfg.prompts = { ...(cfg.prompts || {}), rootDir: dir };
    config.saveConfig(cfg);
    const now = config.promptsLibDir();
    return { ok: true, dir: now };
  });
  handle("prompts_rebuild", () => {
    const r = store.rebuild();
    emit({ event: "prompts", type: "library-changed" });
    return r;
  });

  // ===== 4.2 优化 =====
  handle("prompts_styles_list", () => ({ ok: true, ...styles.listStyles() }));
  handle("prompts_styles_save", (a) => styles.saveStyle(a.style || {}));
  handle("prompts_styles_delete", (a) => styles.deleteStyle(String(a.id || "")));
  handle("prompts_styles_reset", () => styles.resetStyles());
  handle("prompts_optimize", async (a) => {
    const r = await optimize.optimize(a || {});
    if (r.ok) emit({ event: "prompts", type: "history-changed" });
    else emit({ event: "prompts", type: "history-changed" });
    return r;
  });
  handle("prompts_optimize_cancel", () => optimize.cancel());
  handle("prompts_history_list", () => ({ ok: true, items: history.list() }));
  handle("prompts_history_delete", (a) => {
    const r = history.remove(String(a.id || ""));
    emit({ event: "prompts", type: "history-changed" });
    return r;
  });
  handle("prompts_history_clear", () => {
    const r = history.clear();
    emit({ event: "prompts", type: "history-changed" });
    return r;
  });

  // ===== 4.3 同步 =====
  handle("prompts_sync_status", () => ({ ok: true, status: sync.status() }));
  handle("prompts_sync_run", async () => {
    const r = await sync.run();
    return r.ok ? { ok: true, message: sync.status().detail } : { ok: false, message: r.message };
  });
  handle("prompts_sync_cancel", () => sync.cancel());
  handle("prompts_sync_logs", () => ({ ok: true, logs: sync.logs() }));
  handle("prompts_sync_devices", async () => ({ ok: true, devices: await sync.devices() }));
  handle("prompts_conflicts_list", () => ({ ok: true, items: sync.listConflicts() }));
  handle("prompts_conflict_diff", (a) => {
    const d = sync.conflictDiff(String(a.id || ""));
    if (!d) return { ok: false, message: "冲突记录不存在" };
    return { ok: true, diff: d };
  });
  handle("prompts_conflict_resolve", (a) => {
    const decision = ["local", "remote", "both", "merge"].includes(a.decision) ? a.decision : "local";
    return sync.resolveConflict(String(a.id || ""), decision, a.mergedText);
  });
  handle("prompts_conflicts_auto", (a) => sync.autoResolveAll(a && a.strategy));

  /** 报告列表（界面「报告历史」用；报告落在库目录 reports/ 下，与技能报告不同目录） */
  handle("prompts_reports_list", () => ({ ok: true, reports: sync.listReports(50) }));
  handle("prompts_report_read", (a) => {
    const name = String(a.name || "");
    // 只允许读本库 reports 目录下的 md，防路径穿越
    if (!/^prompts-[\w.-]+\.md$/.test(name)) return { ok: false, message: "非法文件名" };
    const file = require("node:path").join(store.reportsDir(), name);
    try {
      return { ok: true, text: fs.readFileSync(file, "utf8") };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  });
}

function boot() {
  sched.start();
  // 启动时顺手做一次台账对账与回收站清理：用户可能手工往 items/ 里丢过文件，
  // 也可能有超过保留期的回收站条目。两者都是幂等的，失败不拦启动。
  try { store.cleanTrash(); } catch { /* 忽略 */ }
  try {
    const orphans = store.listOrphans();
    if (orphans.length) store.rebuild();
  } catch { /* 忽略 */ }
  return { ok: true };
}

function shutdown() {
  sched.stop();
  try { sync.cancel(); } catch { /* 无在途任务时无碍 */ }
  return { ok: true };
}

module.exports = { register, boot, shutdown, emit, isRunning: () => sync.isRunning() };

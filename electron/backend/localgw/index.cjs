/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-27
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 本地网关 · 模块入口
// 单进程嵌入：与号池 / 记忆 / 提示词同款主进程模块，不另起子进程（方案 §3.1）。
// 对外四个导出（electron/main.cjs 按此顺序调用）：
//   register(ipcMain)          注册 33 条 IPC 通道（幂等；与板块开关无关，停用也常驻）
//   setRuntime({ broadcast })  **必须在 boot 之前**：usagehook 的广播器只在 boot 时注入，
//                              晚注入会丢掉启动初期的落账事件；传 null/{} 可摘除
//   boot()                     async；内部按 autostart 短路，autostart=false 时**绝不开端口**
//   shutdown()                 async；关监听 + 释放连接，未 start 时也安全、可反复调用
// 注意：方案 §3.2 里画的 ipc.cjs 最终没有单独拆文件，33 条通道的注册就在本文件。
"use strict";
const lgwConfig = require("./config.cjs");
const server = require("./server.cjs");
const routing = require("./routing.cjs");
const models = require("./models.cjs");
const keysStore = require("./keys-store.cjs");
const oplog = require("./oplog.cjs");
const usagehook = require("./usagehook.cjs");
const stats = require("./stats.cjs");
const outbound = require("./outbound.cjs");

/** 运行时句柄：boot 时注入（让本模块不直接 require electron） */
let runtime = null;
function setRuntime(rt) {
  runtime = rt || {};
  // 允许用 setRuntime(null/{}) 显式摘掉广播器：否则模块被停用后仍会往已销毁的窗口广播
  usagehook.setBroadcaster(runtime && typeof runtime.broadcast === "function" ? runtime.broadcast : null);
}

/** 自动启动（autostart=true 时调用）
 *  默认 autostart=false：boot() 在这里短路，**绝不开监听端口**（方案：服务由用户显式启动）。 */
async function autoStartIfNeeded() {
  const c = lgwConfig.get();
  if (!c.autostart) return { ok: true, skipped: true };
  return await server.start();
}

/** 已注册标记：main.cjs 在启动装配与模块开关两处都可能调 register，
 *  重复调用 ipcMain.handle 同一通道会抛 "second handler for ..."，所以这里做幂等。 */
let registered = false;

/** IPC 通道注册（在 main.cjs 中调用；签名是直接收 ipcMain） */
function register(ipcMain) {
  if (!ipcMain || typeof ipcMain.handle !== "function") {
    return { ok: false, message: "register(ipcMain) 需要 Electron 的 ipcMain 实例" };
  }
  if (registered) return { ok: true, skipped: true };
  registered = true;
  const { handle, ok, fail } = makeHelpers();

  // ===== 状态 / 控制 =====
  ipcMain.handle("localgw_status", handle(async () => server.status()));
  ipcMain.handle("localgw_start", handle(async () => {
    const r = await server.start();
    return r.ok ? ok(r) : fail(r.message);
  }));
  ipcMain.handle("localgw_stop", handle(async () => {
    const r = await server.stop();
    return r.ok ? ok(r) : fail(r.message);
  }));
  ipcMain.handle("localgw_set_port", handle(async ({ port }) => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) return fail("端口必须是 1024~65535 的整数");
    const w = lgwConfig.patch({ port: p });
    if (w && w.ok === false) return fail(w.message);
    // 已经在跑：重启生效，并回**实际生效端口**（可能因占用而顺延到候选端口）
    if (server.state.running) {
      await server.stop();
      const r = await server.start();
      return r.ok ? ok({ port: r.port, bind: r.bind }) : fail(r.message);
    }
    return ok({ port: lgwConfig.get().port });
  }));
  ipcMain.handle("localgw_set_autostart", handle(async ({ enabled }) => {
    const w = lgwConfig.patch({ autostart: !!enabled });
    return w && w.ok === false ? fail(w.message) : ok({});
  }));
  ipcMain.handle("localgw_restart", handle(async () => {
    await server.stop();
    const r = await server.start();
    return r.ok ? ok(r) : fail(r.message);
  }));

  // ===== 密钥 =====
  ipcMain.handle("localgw_keys_list", handle(async () => keysStore.list()));
  ipcMain.handle("localgw_keys_create", handle(async (args) => {
    const r = keysStore.create({
      name: args.name,
      scopes: Array.isArray(args.scopes) ? args.scopes : ["*"],
      expiresAt: args.expiresAt || null,
      concurrency: Number(args.concurrency) || 8,
      ratePerMin: Number(args.ratePerMin) || 120,
    });
    return { ok: true, rawKey: r.rawKey, apiKey: r.apiKey };
  }));
  ipcMain.handle("localgw_keys_revoke", handle(async ({ id }) => keysStore.revoke(id)));
  ipcMain.handle("localgw_keys_rename", handle(async ({ id, name }) => keysStore.rename(id, name)));

  // ===== 路由 / 渠道 =====
  ipcMain.handle("localgw_route_get", handle(async () => routing.routeState()));
  ipcMain.handle("localgw_route_set", handle(async (patch) => routing.setRoute(patch || {})));
  ipcMain.handle("localgw_channel_toggle", handle(async ({ channel, enabled }) => {
    if (!channel) return fail("缺少渠道 id");
    const r = routing.setChannelEnabled(String(channel), !!enabled);
    return r && r.ok === false ? fail(r.message) : ok({});
  }));
  ipcMain.handle("localgw_channel_test", handle(async ({ channel }) => routing.testChannel(channel)));

  // ===== 模型目录 =====
  ipcMain.handle("localgw_models_list", handle(async () => models.list()));
  ipcMain.handle("localgw_models_set_override", handle(async ({ model, payload }) => models.setOverride(model, payload)));
  ipcMain.handle("localgw_models_set_alias", handle(async ({ from, to }) => models.setAlias(from, to)));
  ipcMain.handle("localgw_models_add_custom", handle(async ({ model, provider }) => models.addCustom(model, provider)));
  // 删除单条模型规则（overrides / aliases / custom）。
  // 为什么单独开一条通道而不是让前端用 config_patch 提交"少一项的表"：config 的 mergeDeep
  // 是加性合并，去掉键的提交不会真删（实测：键会从 base 存活，传 null 也只是存下 null）。
  // 删除必须在原始配置层做手术，见 models.cjs 的 removeRule 注释。
  ipcMain.handle("localgw_models_remove_rule", handle(async ({ kind, name }) => models.removeRule(kind, name)));

  // ===== 配置 =====
  ipcMain.handle("localgw_config_get", handle(async () => lgwConfig.get()));
  ipcMain.handle("localgw_config_patch", handle(async ({ patch: p }) => {
    // config.patch 现在会校验 bind/port/strategy 越界并回 {ok:false}，这里必须如实上抛
    const w = lgwConfig.patch(p || {});
    return w && w.ok === false ? fail(w.message) : ok({});
  }));

  // ===== 日志 / 监控 =====
  ipcMain.handle("localgw_logs_list", handle(async (filter) => oplog.list(filter || {})));
  ipcMain.handle("localgw_logs_export", handle(async ({ format }) => oplog.exportTo(format === "csv" ? "csv" : "jsonl")));
  ipcMain.handle("localgw_pot_stats", handle(async () => oplog.potStats()));

  // ===== 用量统计（数据源 = localgw_logs 一张表，现算聚合，见 stats.cjs 顶部口径说明）=====
  // overview：区间 KPI / 趋势 / 三维排行 / TOP；detail：明细分页；cleanup：按保留期或清空。
  // 三条都不写库（只有 cleanup 删），聚合本身无副作用，故不落操作日志；cleanup 落一条。
  ipcMain.handle("localgw_stats_overview", handle(async (args) => stats.overview(args || {})));
  ipcMain.handle("localgw_stats_detail", handle(async (args) => stats.detail(args || {})));
  ipcMain.handle("localgw_stats_cleanup", handle(async ({ mode } = {}) => stats.cleanup({ mode })));

  // ===== 出站伪装与清洗（outbound）=====
  ipcMain.handle("localgw_outbound_get", handle(async () => {
    const c = lgwConfig.get();
    return {
      ok: true,
      outbound: c.outbound,
      // 档案表读不出来时 listProfiles 回空数组而不是抛错：否则面板会整体挂掉，
      // 用户看到的是"后端通道未接入"，而真实原因只是一条档案写坏了
      profiles: outbound.listProfiles(c),
      channels: routing.channelMatrix(),
    };
  }));
  ipcMain.handle("localgw_outbound_set", handle(async ({ patch: p }) => {
    // config.patch 会校验 outbound 的越界/类型错误并回 { ok:false, message }，这里如实上抛
    const w = lgwConfig.patch({ outbound: p || {} });
    return w && w.ok === false ? fail(w.message) : ok({});
  }));
  ipcMain.handle("localgw_outbound_preview", handle(async ({ channel, text, scope }) => {
    const before = text == null ? "" : String(text);
    const policy = outbound.policyFor(channel || "", lgwConfig.get());
    const r = outbound.previewText(before, policy, scope);
    return { ok: true, before, after: r.text, hits: r.hits };
  }));

  // ===== Provider 扩展点（决策 2：本期注册但固定返回未启用）=====
  const NOT_ENABLED = () => ({ ok: false, message: "provider 扩展点未启用（方案决策 2，本期不打包 exe）" });
  ipcMain.handle("localgw_providers_list", handle(NOT_ENABLED));
  ipcMain.handle("localgw_providers_enable", handle(NOT_ENABLED));
  ipcMain.handle("localgw_providers_doctor", handle(NOT_ENABLED));
  ipcMain.handle("localgw_providers_exec", handle(NOT_ENABLED));
  return { ok: true, channels: 33 };
}

/** 统一异常收口：渲染层拿到 { ok:false } 而不是 rejected promise */
function makeHelpers() {
  return {
    handle(fn) {
      return async (_event, args) => {
        try {
          return await fn(args || {});
        } catch (e) {
          return { ok: false, message: String((e && e.message) || e) };
        }
      };
    },
    ok(data) {
      return { ok: true, ...(data || {}) };
    },
    fail(message) {
      return { ok: false, message: String((message && message.message) || message) };
    },
  };
}

/** 模块启动入口（在 main.cjs 的 whenReady 之后调用）
 *  可重复调用：autostart=false 时短路；true 时 server.start() 自带"已在运行就直接返回"的幂等闸，
 *  不会重复 listen，也不会重复注册 GC 定时器。 */
async function boot() {
  // GC 一次启动前的残留
  try { oplog.gc(); } catch { /* 静默 */ }
  // 注入 broadcaster（如果 runtime 提供）
  if (runtime && typeof runtime.broadcast === "function") usagehook.setBroadcaster(runtime.broadcast);
  // autostart
  try {
    return await autoStartIfNeeded();
  } catch (e) {
    // boot 由 main.cjs 挂 .catch 兜底，但内部再兜一层能保证"返回稳定结构"的契约
    return { ok: false, message: String((e && e.message) || e) };
  }
}

/** 关闭钩子（在 main.cjs 的 will-quit / 模块停用中调用）
 *  可反复调用：server.stop() 在"从未 start"时直接回 {ok:true}，不抛错。 */
async function shutdown() {
  try { await server.stop(); } catch { /* 静默 */ }
  return { ok: true };
}

module.exports = { register, boot, shutdown, setRuntime, autoStartIfNeeded, isRegistered: () => registered };

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
// IPC 命令注册：主进程 ipcMain.handle 处理器，对应前端 src/api/ipc.ts
// 框架命令（配置 / 版本 / 数据目录）+ 技能仓库命令（扫描 / 同步 / 冲突 / 回收站 / WebDAV / 更新）
// preload 白名单和这里要一一对应
"use strict";
const path = require("node:path");
const { app, shell, dialog, BrowserWindow } = require("electron");
const config = require("./config.cjs");
const adapter = require("./adapter.cjs");
const syncer = require("./syncer.cjs");
const hub = require("./hub.cjs");
const report = require("./report.cjs");
const scanner = require("./scanner.cjs");
const mounter = require("./mounter.cjs");
const updater = require("./updater.cjs");
const remotesync = require("./remotesync.cjs");
const webdav = require("./webdav.cjs");
const watch = require("./watch.cjs");
const proxy = require("./proxy/index.cjs");
const memory = require("./memory/index.cjs");
const pluginHost = require("./plugin-host.cjs");
const pluginBridge = require("./plugin-bridge.cjs");

// 渲染层拿到的密码一律是掩码；保存/测试连接收到精确掩码时回填磁盘真值
const PASSWORD_MASK = "••••••••";

function maskConfig(c) {
  const out = JSON.parse(JSON.stringify(c));
  if (out.webdav && out.webdav.password) out.webdav.password = PASSWORD_MASK;
  if (out.webdavShared && out.webdavShared.password) out.webdavShared.password = PASSWORD_MASK;
  return out;
}

// 表单传回的密码是掩码时用磁盘真值替换，防止掩码被当密码存盘
function unmaskPassword(next) {
  const disk = config.loadConfig();
  if (next && next.webdav && next.webdav.password === PASSWORD_MASK) {
    next.webdav.password = disk.webdav.password || "";
  }
  if (next && next.webdavShared && next.webdavShared.password === PASSWORD_MASK) {
    next.webdavShared.password = (disk.webdavShared && disk.webdavShared.password) || "";
  }
  return next;
}

let cfg = null;
function C() {
  if (!cfg) cfg = config.loadConfig();
  return cfg;
}

function ok(data) {
  return { ok: true, ...data };
}

function fail(message) {
  return { ok: false, message: String((message && message.message) || message) };
}

// 异常统一收口，渲染层拿到 { ok:false } 而不是 rejected promise
function handle(fn) {
  return async (_event, args) => {
    try {
      return await fn(args || {});
    } catch (e) {
      return fail(e);
    }
  };
}

/** 配置保存后的回调钩子（由 main.cjs 注册）：全局快捷键重新注册等。
 *  方向：main → backend 注册，backend 只在保存时回调，避免 backend 反向依赖主进程。 */
const configSavedHooks = [];
function onConfigSaved(fn) {
  if (typeof fn === "function") configSavedHooks.push(fn);
}

/** 托盘等 main 侧直写配置后调用：作废内存快照，下一次 load_config 重读磁盘。
 *  不作废的话 C() 会一直返回旧快照（含托盘刚改过的 schedule 字段）。 */
function refreshConfigCache() {
  cfg = null;
}

/** 应用主题同步到原生窗口框架（标题栏/边框）颜色；主题变化时调用 */
function applyNativeTheme(nativeTheme, cfgObj) {
  const theme = cfgObj && cfgObj.theme;
  if (theme === "dark" || theme === "light") nativeTheme.themeSource = theme;
}

/** 注册所有 IPC handler。ctx = { ipcMain, app, shell, nativeTheme } */
function register(ctx) {
  const { ipcMain, nativeTheme } = ctx;

  // ===== 框架：配置 =====
  ipcMain.handle("load_config", handle(() => {
    const c = C();
    applyNativeTheme(nativeTheme, c);
    return maskConfig(c);
  }));
  // 保存时不做深合并（渲染层持完整配置快照）：仅对已知键做归一化，
  // 主题写回时同步原生标题栏，WebDAV 掩码密码回填真值，开机自启即时生效
  ipcMain.handle("save_config", handle(({ config: next }) => {
    if (!next || typeof next !== "object" || Array.isArray(next)) return fail("配置格式不正确");
    const merged = unmaskPassword(JSON.parse(JSON.stringify(next)));
    // 设置页整份提交：out-of-band 字段（channelEnabled/checkinAutoRules）以磁盘为准，
    // 否则渲染层的旧快照会把「上游启闭」「按渠道签到」的写入冲掉（issue #90）；
    // restoreOnLaunch 不在此列——设置页开关自己就是经这里写盘的，磁盘优先会架空它
    const r = config.saveConfigFromUI(merged);
    // 落盘成功才更新内存快照，写失败时别把脏数据留给 load_config
    cfg = merged;
    applyNativeTheme(nativeTheme, merged);
    config.applyAutoStart(merged);
    // 通知主进程侧「配置已保存」：全局快捷键要按新值重新注册。
    // 为什么不用 ipcMain 反向调用：globalShortcut 只有 main.cjs 持有，
    // backend 不该反向依赖主进程；用一个注册回调把方向理顺（与 remotesync.setOnFinish 同款）。
    for (const fn of configSavedHooks) {
      try { fn(merged); } catch { /* 单个钩子失败不影响保存结果 */ }
    }
    return r;
  }));

  // ===== 框架：其它 =====
  ipcMain.handle("get_app_version", () => app.getVersion());
  ipcMain.handle("get_data_dir", () => config.dataDir());
  ipcMain.handle("open_data_dir", async () => {
    await shell.openPath(config.dataDir());
  });
  // 中央技能仓库目录（真身 / 报告 / 回收站）
  ipcMain.handle("get_hub_dir", handle(() => config.hubDir()));
  ipcMain.handle("open_hub_dir", handle(async () => {
    await shell.openPath(config.hubDir());
    return ok({});
  }));
  ipcMain.handle("browse_dir", handle(async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getAllWindows()[0], { properties: ["openDirectory"] });
    return { ok: true, canceled: r.canceled, path: r.canceled ? null : r.filePaths[0] };
  }));

  // ===== 无边框窗口：自绘标题栏的窗口控制（原生标题栏已在 main.cjs 用 frame:false 去掉）=====
  // 一律用 event.sender 反查窗口，不用全局 mainWindow：轻量模式会销毁重建，全局变量可能是旧实例
  const senderWindow = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle("window_minimize", (e) => {
    const w = senderWindow(e);
    if (w) w.minimize();
    return ok({});
  });
  ipcMain.handle("window_toggle_maximize", (e) => {
    const w = senderWindow(e);
    if (!w) return ok({ maximized: false });
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return ok({ maximized: w.isMaximized() });
  });
  // 走 close() 而不是 destroy()：托盘/轻量模式的三态决策在 main.cjs 的 close 事件里，必须让它经过
  ipcMain.handle("window_close", (e) => {
    const w = senderWindow(e);
    if (w) w.close();
    return ok({});
  });
  ipcMain.handle("window_is_maximized", (e) => {
    const w = senderWindow(e);
    return ok({ maximized: !!w && !w.isDestroyed() && w.isMaximized() });
  });

  // ===== 软件更新 =====
  ipcMain.handle("get_is_portable", () => updater.isPortable());
  ipcMain.handle("get_update_status", () => updater.getStatus());
  ipcMain.handle("check_update", () => updater.check(true));
  ipcMain.handle("download_update", () => updater.download());
  ipcMain.handle("install_update", () => updater.triggerInstall());
  ipcMain.handle("open_release_page", () => updater.openReleases());
  ipcMain.handle("open_repo_page", () => updater.openRepo());
  // 设置页「反馈与需求」的入口：用系统默认浏览器打开 issue 表单（应用内 webview 打不开
  // GitHub 的登录态，也没法提交表单）。只放行本项目仓库的 https 链接 —— 渲染层即使被
  // 注入也打不开任意地址，白名单比「只校验 http(s)」更难被滥用。
  ipcMain.handle("open_external_url", handle(async ({ url } = {}) => {
    const target = String(url || "");
    const allow = /^https:\/\/github\.com\/HUIdada1\/AgentHub(\/|$|\?)/i.test(target);
    if (!allow) return { ok: false, message: "只允许打开本项目仓库的链接" };
    await shell.openExternal(target);
    return { ok: true };
  }));

  // ===== 技能仓库：WebDAV 跨设备同步（服务器凭据走统一 webdavShared，根目录取 roots.skills） =====
  ipcMain.handle("webdav_test", handle(({ config: form }) => {
    // 表单直达：{endpoint, username, password, root}（掩码密码回填真值）；
    // 无表单：共享服务器 + 技能仓库根目录
    if (form && typeof form === "object" && (form.endpoint !== undefined || form.webdav === undefined)) {
      const cur = config.loadSharedWebdav();
      const testCfg = {
        endpoint: String(form.endpoint || ""),
        username: String(form.username || ""),
        password: form.password === config.PASSWORD_MASK ? cur.password : String(form.password || ""),
        root: String(form.root || cur.roots.skills),
      };
      return webdav.test(testCfg);
    }
    return webdav.test(config.moduleWebdav("skills"));
  }));
  ipcMain.handle("webdav_sync", handle(() => {
    const c = C();
    // 同步引擎读 cfg.webdav：用统一共享配置组装（凭据 + skills 根目录 + 设备档案）
    const shared = config.loadSharedWebdav();
    c.webdav = {
      endpoint: shared.endpoint,
      username: shared.username,
      password: shared.password,
      root: shared.roots.skills,
      deviceId: c.webdav.deviceId,
      deviceName: c.webdav.deviceName,
    };
    // S3 兼容存储（issue #89）：带 __s3 标记与桶参数，webdav.cjs 分派到 S3 传输
    if (shared.type === "s3") {
      c.webdav.__s3 = true;
      c.webdav.bucket = shared.s3.bucket;
      c.webdav.region = shared.s3.region;
      c.webdav.pathStyle = shared.s3.pathStyle;
    }
    if (remotesync.isRunning()) return fail("同步已在进行中");
    if (!remotesync.configured(c)) return fail("WebDAV 未配置完整（服务器地址 / 账号 / 密码）");
    remotesync.run(c).catch(() => {}); // 后台跑，进度走事件广播；异常已在 run 内收口
    return ok({});
  }));
  ipcMain.handle("webdav_cancel", handle(() => remotesync.cancel()));
  ipcMain.handle("webdav_status", handle(() => {
    const c = C();
    const shared = config.maskedSharedWebdav();
    const rstate = remotesync.loadRemoteState();
    return {
      running: remotesync.isRunning(),
      configured: !!(shared.endpoint && shared.username && shared.password),
      deviceId: c.webdav.deviceId,
      deviceName: c.webdav.deviceName,
      lastSyncAt: rstate.lastSyncAt || "",
      ...remotesync.progress(),
    };
  }));
  // ===== 统一 WebDAV（设置 · 数据存储）：共享服务器 + 三模块根目录 =====
  ipcMain.handle("webdav_shared_get", handle(() => config.maskedSharedWebdav()));
  ipcMain.handle("webdav_shared_save", handle(({ config: form }) => {
    const before = config.loadSharedWebdav().endpoint;
    const r = config.saveSharedWebdav(form || {});
    cfg = null; // 内存快照已过期：后续 remove_tool 等若拿旧快照整份写盘会把刚存的服务器配置冲回去（issue #95）
    // WebDAV 密码同时是号池压缩包的加密口令：改动后令历史包标记 keyChange，下次同步重打包
    try { require("./proxy/poolsync.cjs").onSharedPasswordMaybeChanged(); } catch { /* 模块未装载不影响保存 */ }
    // 首次配置（之前没配服务器，这次配上）自动跑一次号池同步：API Keys 与模型映射随
    // 共享配置包落到本机，「换台电脑」配好服务器即得，不用去发现「立即同步号池」（issue #92）。
    // 已配置时改字段不触发；proxy 板块已停用时不触发（轻量模式：停用板块后台不运行）；
    // 失败静默（号池面板看得到状态，定时同步下轮也会补）
    const after = config.loadSharedWebdav().endpoint;
    const pm = (config.loadConfig().modules || {}).proxy || {};
    const proxyOn = !pm || pm.enabled !== false;
    if (!before && after && proxyOn) {
      try { require("./proxy/poolsync.cjs").run({}).catch(() => {}); } catch { /* 同步互斥等静默，状态面板可见 */ }
    }
    return r;
  }));
  ipcMain.handle("webdav_shared_clear", handle(() => {
    const r = config.clearSharedWebdav();
    cfg = null;
    return r;
  }));
  ipcMain.handle("webdav_shared_test", handle(({ config: form }) => {
    const cur = config.loadSharedWebdav();
    const f = form && typeof form === "object" ? form : {};
    const fs3 = f.s3 && typeof f.s3 === "object" ? f.s3 : {};
    const cfg = {
      endpoint: String(f.endpoint ?? cur.endpoint),
      username: String(f.username ?? cur.username),
      password: f.password === config.PASSWORD_MASK || f.password == null ? cur.password : String(f.password),
      root: String(f.root ?? cur.roots.skills),
    };
    // S3 模式（issue #89）：注入 __s3 标记与桶参数，webdav.test 分派到 S3 传输
    if ((f.type ?? cur.type) === "s3") {
      cfg.__s3 = true;
      cfg.bucket = String(fs3.bucket ?? cur.s3.bucket);
      cfg.region = String(fs3.region ?? cur.s3.region);
      cfg.pathStyle = fs3.pathStyle ?? cur.s3.pathStyle;
    }
    return webdav.test(cfg);
  }));
  ipcMain.handle("webdav_logs", handle(() => remotesync.recentLogs()));
  ipcMain.handle("webdav_devices", handle(async () => {
    const c = C();
    const wd = config.moduleWebdav("skills");
    if (!wd.endpoint || !wd.username || !wd.password) return { devices: [], error: "未配置" };
    try {
      const entries = await webdav.list(webdav.joinUrl(wd.endpoint, wd.root, "devices"), wd);
      const devices = [];
      for (const e of entries) {
        if (e.isDir || !e.name.endsWith(".json")) continue;
        try {
          const d = JSON.parse(await webdav.getText(webdav.joinUrl(wd.endpoint, wd.root, "devices", e.name), wd));
          devices.push({ id: e.name.replace(/\.json$/, ""), name: d.name || e.name, appVersion: d.appVersion || "", lastSyncAt: d.lastSyncAt || "", self: e.name === `${c.webdav.deviceId}.json` });
        } catch { /* 单个设备信息坏了不影响其他 */ }
      }
      return { devices };
    } catch (e) {
      return { devices: [], error: String((e && e.message) || e) };
    }
  }));

  // ===== 技能仓库：工具适配器 =====
  ipcMain.handle("list_tools", handle(() => adapter.listTools(C())));
  // 左栏模块卡片的轻量统计：只读 manifest / 冲突 JSON / 目录一层列表，
  // 不做 treeHash（get_overview 的全量哈希太重，侧栏每次切模块都算会把 UI 拖卡）
  ipcMain.handle("skills_side_stats", handle(() => {
    const c = C();
    const m = hub.loadManifest();
    const conflicts = syncer.loadConflicts().items.filter((x) => !x.resolved).length;
    const targets = adapter.resolveScanTargets(c);
    let mountOk = 0, mountTotal = 0;
    for (const sk of Object.values(m.skills || {})) {
      for (const mt of sk.mounts || []) {
        mountTotal++;
        try {
          if (mt.path && mounter.isLink(mt.path) && require("node:fs").existsSync(mt.path)) mountOk++;
        } catch { /* 单个挂载坏了不影响统计 */ }
      }
    }
    const tools = targets.map((t) => {
      let skillCount = 0;
      try {
        for (const e of require("node:fs").readdirSync(t.dir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue; // junction 的 dirent.isDirectory() 为 false，天然不计入
          skillCount++;
        }
      } catch { /* 目录不存在按 0 计 */ }
      return { id: t.id, name: t.name, dir: t.dir, skillCount };
    });
    return {
      skillCount: Object.keys(m.skills || {}).length,
      pendingConflicts: conflicts,
      toolCount: tools.length,
      mountOk,
      mountTotal,
      tools,
    };
  }));
  // 电脑扫描发现：只读探测第三方 agent，命中列表给设置页一键添加
  ipcMain.handle("probe_agents", handle(() => adapter.probeAgents(C())));
  // 删除自定义工具适配器：不带 confirm 只干跑报影响，带 confirm 才摘挂载删配置。
  // 传入的必须是磁盘新鲜读：removeCustomTool 会对传入对象整份 saveConfig，
  // 若传内存快照 C()，快照里过期的 webdavShared 等字段会把磁盘新值冲掉（issue #95）
  ipcMain.handle("remove_tool", handle(({ id, confirm: doIt }) => {
    const r = syncer.removeCustomTool(config.loadConfig(), String(id || ""), !!doIt);
    if (r.ok && doIt) cfg = null; // 配置已删条目，内存快照作废
    return r;
  }));

  // ===== 技能仓库：总览 / 技能库 / 详情 =====
  ipcMain.handle("get_overview", handle(() => {
    const survey = syncer.survey(C());
    const conflicts = syncer.loadConflicts().items.filter((x) => !x.resolved);
    const reports = report.listReports(3);
    return {
      hubDir: config.hubDir(),
      skillCount: syncer.librarySkills(survey).length,
      manifestCount: Object.keys(survey.manifest.skills || {}).length,
      sourceCount: survey.scanned.skills.length,
      l1Merged: survey.dedup.duplicates.length,
      l2Conflicts: survey.dedup.conflicts.length,
      tools: survey.scanned.targets.map(({ id, name, dir, skillCount, mountCount }) => ({ id, name, dir, skillCount, mountCount })),
      mountHealth: survey.mountHealth,
      orphans: survey.orphans,
      pendingConflicts: conflicts,
      recentReports: reports,
      trashCount: hub.listTrash().length,
      hubExtra: survey.hubExtra,
    };
  }));
  ipcMain.handle("list_skills", handle(() => {
    const survey = syncer.survey(C());
    const rows = syncer.librarySkills(survey);
    // 工具自带系统技能：默认隐藏（前端只在没有搜索词时过滤），永不收纳，搜索时可辨识
    const seen = new Set(rows.map((r) => r.name));
    for (const s of survey.scanned.skills) {
      if (s.origin !== "system" || seen.has(s.name)) continue;
      seen.add(s.name);
      rows.push({
        name: s.name,
        skillName: s.skillName,
        description: s.description,
        version: s.version,
        treeHash: s.treeHash,
        health: s.health,
        sources: [{ tool: s.tool, name: s.name }],
        inManifest: false,
        mounts: [],
        mtimeMs: s.mtimeMs,
        origin: "system",
      });
    }
    // 中央巡检：仓库里有目录但 manifest 没记账（工具/AI 绕过软件直接放入的），
    // 技能库原样列出并给「纳管」入口，绝不静默当不存在
    for (const hx of survey.hubExtra) {
      if (seen.has(hx.name)) continue;
      seen.add(hx.name);
      rows.push({
        name: hx.name,
        skillName: hx.name,
        description: hx.isLink ? "中央仓库里的悬空链接，无真身" : (hx.hasSkillMd ? "已被直接放入中央仓库但未登记" : "含未登记内容"),
        version: "",
        treeHash: "",
        health: hx.health,
        sources: [],
        inManifest: false,
        mounts: [],
        mtimeMs: hx.mtimeMs,
        origin: "hub-extra",
      });
    }
    return rows;
  }));
  // 已收纳：返回 manifest + 中央真身内容；未收纳：去各工具目录找同名真身，
  // 让详情页能展示内容和"去同步中心收纳"引导，而不是卡在加载态
  ipcMain.handle("get_skill", handle(({ name: raw }) => {
    const fs = require("node:fs");
    const name = path.basename(String(raw || ""));
    if (!name) return null;
    const m = hub.loadManifest();
    const entry = m.skills[name];
    const dir = path.join(hub.skillsDir(), name);
    if (entry || fs.existsSync(dir)) {
      return {
        manifest: entry ? {
          ...entry,
          sources: entry.sources || [],
          mounts: entry.mounts || [],
          mergeHistory: entry.mergeHistory || [],
        } : null,
        dir,
        health: fs.existsSync(dir) ? scanner.healthCheck(dir) : [],
        skillMd: fs.existsSync(path.join(dir, "SKILL.md"))
          ? fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8")
          : "",
        sources: [],
      };
    }
    for (const t of adapter.resolveScanTargets(C())) {
      const p = path.join(t.dir, name);
      if (fs.existsSync(p) && !mounter.isLink(p)) {
        return {
          manifest: null,
          dir: "",
          health: scanner.healthCheck(p),
          skillMd: fs.existsSync(path.join(p, "SKILL.md"))
            ? fs.readFileSync(path.join(p, "SKILL.md"), "utf-8")
            : "",
          sources: [{ tool: t.id, name }],
        };
      }
    }
    // 用户装的没找到，再找工具自带的系统技能（如 Codex .system 里的）：内容可看，但不给收纳引导
    for (const t of adapter.resolveScanTargets(C())) {
      let subs;
      try {
        subs = fs.readdirSync(t.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of subs) {
        if (!e.isDirectory()) continue;
        const sysDir = path.join(t.dir, e.name);
        if (!scanner.isSystemDir(sysDir)) continue;
        const p = path.join(sysDir, name);
        if (fs.existsSync(p)) {
          return {
            manifest: null,
            dir: "",
            health: scanner.healthCheck(p),
            skillMd: fs.existsSync(path.join(p, "SKILL.md"))
              ? fs.readFileSync(path.join(p, "SKILL.md"), "utf-8")
              : "",
            sources: [{ tool: t.id, name, origin: "system" }],
          };
        }
      }
    }
    return null;
  }));

  // ===== 技能仓库：同步 =====
  ipcMain.handle("sync_plan", handle(() => syncer.planSync(C())));
  ipcMain.handle("sync_execute", handle(({ plan }) => {
    const busy = remotesync.runningHint();
    if (busy) return fail(busy); // 两个同步都动中央仓库，禁止并发
    return syncer.executeSync(C(), plan);
  }));
  ipcMain.handle("list_reports", handle(() => report.listReports(30, ""))); // 全部报告（sync-*/webdav-*），前端按前缀过滤
  ipcMain.handle("read_report", handle(({ file }) => ({ content: report.readReport(file) })));
  ipcMain.handle("open_report", handle(async ({ file }) => {
    const p = path.join(hub.reportsDir(), path.basename(file));
    await shell.openPath(p);
    return ok({});
  }));

  // ===== 技能仓库：冲突 =====
  ipcMain.handle("list_conflicts", handle(() => syncer.loadConflicts().items.filter((x) => !x.resolved)));
  ipcMain.handle("get_conflict_diff", handle(({ id }) => {
    const item = syncer.loadConflicts().items.find((x) => x.id === id);
    if (!item) return null;
    const fs = require("node:fs");
    const readMd = (p) => {
      const f = p && path.join(p, "SKILL.md");
      return f && fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    };
    // remote 冲突：左边是本机中央版，右边是同步时暂存的远端版
    if (item.kind === "remote") {
      const localDir = path.join(hub.skillsDir(), item.skill);
      const remoteDir = remotesync.stagingDir(item.skill);
      return {
        item,
        left: { label: "本机版", path: localDir, md: readMd(localDir) },
        right: { label: "远端版", path: remoteDir, md: readMd(remoteDir) },
      };
    }
    // diff-link：左侧是链接现在指向的那份（悬空时没有），右侧是中央真身（可能还没有）
    if (item.kind === "diff-link") {
      const st = syncer.linkConflictState(item);
      return {
        item,
        left: { label: "链接指向", path: st.resolved || "", md: st.resolves ? readMd(st.resolved) : "" },
        right: { label: "中央真身", path: st.centralPath, md: readMd(st.centralPath) },
        link: st,
      };
    }
    const leftPath = item.kind === "content" ? path.join(item.dir, item.skill) : null;
    const rightPath = path.join(hub.skillsDir(), item.skill || "");
    return {
      item,
      left: { label: item.kind === "content" ? `${item.toolId} 版` : "技能 A", path: leftPath || "", md: item.kind === "content" ? readMd(leftPath) : "" },
      right: { label: item.kind === "content" ? "中央版" : "技能 B", path: rightPath, md: item.kind === "content" ? readMd(rightPath) : "" },
    };
  }));
  ipcMain.handle("resolve_conflict", handle(({ id, choice }) => {
    const store = syncer.loadConflicts();
    const item = store.items.find((x) => x.id === id);
    if (!item) return fail("冲突不存在或已裁决");
    const r = item.kind === "norm"
      ? syncer.resolveNormConflict(item, choice, C())
      : item.kind === "remote"
        ? remotesync.resolveRemoteConflict(item, choice, C())
        : item.kind === "diff-link"
          ? syncer.resolveDiffLinkConflict(item, choice, C())
          : syncer.resolveContentConflict(item, choice, C());
    if (r.ok) {
      item.resolved = { at: new Date().toISOString(), choice };
      syncer.saveConflicts(store);
    }
    return r;
  }));
  ipcMain.handle("dismiss_conflict", handle(({ id }) => {
    const store = syncer.loadConflicts();
    const item = store.items.find((x) => x.id === id);
    if (item) {
      item.resolved = { at: new Date().toISOString(), choice: "dismissed" };
      syncer.saveConflicts(store);
    }
    return ok({});
  }));

  // ===== 技能仓库：挂载 / 回收站 / 自动感知 =====
  ipcMain.handle("toggle_mount", handle(({ skill, toolId, enable }) => syncer.toggleMount(skill, toolId, enable, C())));
  ipcMain.handle("repair_mounts", handle(() => syncer.repairMounts(C())));

  ipcMain.handle("trash_list", handle(() => hub.listTrash()));
  ipcMain.handle("trash_restore", handle(({ name }) => hub.restoreFromTrash(name)));
  ipcMain.handle("trash_purge", handle(() => ({ purged: hub.purgeTrash(C().trashDays || 7) })));

  ipcMain.handle("remove_skill", handle(({ name }) => hub.removeSkill(name)));

  // 自动感知状态 + 中央未登记目录纳管（只补账，不动文件）
  ipcMain.handle("watch_status", handle(() => watch.status()));
  ipcMain.handle("adopt_hub_skill", handle(({ name }) => syncer.adoptHubSkill(name, C())));

  // ===== 用量同步模块（原「用量记录同步」backend/ipc.cjs，冲突命令已加 sync_ 前缀） =====
  require("./sync-ipc.cjs").registerSync(ctx);

  // ===== 号池管家（命令实现见 backend/proxy/index.cjs） =====
  proxy.register(ipcMain);

  // ===== 记忆中枢（命令实现见 backend/memory/index.cjs） =====
  memory.register(ipcMain);

  // ===== 外置插件（命令实现见 backend/plugin-host.cjs） =====
  // 命令名固定，插件能力全部由 manifest 描述，宿主不感知具体插件
  ipcMain.handle("plugin_list", () => {
    try {
      // 桥接状态随列表一起返回：设置页要显示「上次同步 / 同步失败」
      return pluginHost.list().map((p) => ({ ...p, poolSync: pluginBridge.status(p.id) }));
    } catch { return []; }
  });
  ipcMain.handle("plugin_install", async (e) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender) || undefined;
      const r = await dialog.showOpenDialog(win, {
        title: "选择插件包",
        filters: [{ name: "插件包", extensions: ["zip"] }],
        properties: ["openFile"],
      });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
      const out = await pluginHost.install(r.filePaths[0]);
      if (out.ok) pluginBridge.schedule("force").catch(() => { /* 安装后首推失败由轮询补 */ });
      return out;
    } catch (err) {
      return { ok: false, message: String((err && err.message) || err) };
    }
  });
  ipcMain.handle("plugin_uninstall", async (_e, args) => {
    try { return await pluginHost.uninstall(String((args && args.id) || "")); }
    catch (err) { return { ok: false, message: String((err && err.message) || err) }; }
  });
  ipcMain.handle("plugin_toggle", async (_e, args) => {
    try {
      const out = await pluginHost.toggle(String((args && args.id) || ""), !!(args && args.enabled));
      if (out.ok && args && args.enabled) pluginBridge.schedule("force").catch(() => { /* 同上 */ });
      return out;
    } catch (err) { return { ok: false, message: String((err && err.message) || err) }; }
  });
  ipcMain.handle("plugin_open", async (_e, args) => {
    try { return await pluginHost.open(String((args && args.id) || "")); }
    catch (err) { return { ok: false, message: String((err && err.message) || err) }; }
  });
  // 内嵌地址：带一次性令牌，渲染层用它填 iframe.src
  ipcMain.handle("plugin_embed", (_e, args) => {
    try {
      const id = String((args && args.id) || "");
      const r = pluginHost.embedUrl(id);
      if (!r.ok) return r;
      // 内嵌前确保插件在跑，并补推一次宿主数据（插件刚起来时号池还是空的）
      return pluginHost.start(id).then((s) => {
        if (!s.ok) return s;
        pluginBridge.schedule("force").catch(() => { /* 失败不影响打开 */ });
        return r;
      }).catch((e) => ({ ok: false, message: String((e && e.message) || e) }));
    } catch (err) {
      return { ok: false, message: String((err && err.message) || err) };
    }
  });
  ipcMain.handle("plugin_sync_now", async (_e, args) => {
    try { return await pluginBridge.pushNow(String((args && args.id) || "")); }
    catch (err) { return { ok: false, message: String((err && err.message) || err) }; }
  });
}

module.exports = { register, onConfigSaved, refreshConfigCache };

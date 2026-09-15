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
    const r = config.saveConfig(merged);
    // 落盘成功才更新内存快照，写失败时别把脏数据留给 load_config
    cfg = merged;
    applyNativeTheme(nativeTheme, merged);
    config.applyAutoStart(merged);
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

  // ===== 软件更新 =====
  ipcMain.handle("get_is_portable", () => updater.isPortable());
  ipcMain.handle("get_update_status", () => updater.getStatus());
  ipcMain.handle("check_update", () => updater.check(true));
  ipcMain.handle("download_update", () => updater.download());
  ipcMain.handle("install_update", () => updater.triggerInstall());
  ipcMain.handle("open_release_page", () => updater.openReleases());
  ipcMain.handle("open_repo_page", () => updater.openRepo());

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
    const r = config.saveSharedWebdav(form || {});
    // WebDAV 密码同时是号池压缩包的加密口令：改动后令历史包标记 keyChange，下次同步重打包
    try { require("./proxy/poolsync.cjs").onSharedPasswordMaybeChanged(); } catch { /* 模块未装载不影响保存 */ }
    return r;
  }));
  ipcMain.handle("webdav_shared_test", handle(({ config: form }) => {
    const cur = config.loadSharedWebdav();
    const f = form && typeof form === "object" ? form : {};
    return webdav.test({
      endpoint: String(f.endpoint ?? cur.endpoint),
      username: String(f.username ?? cur.username),
      password: f.password === config.PASSWORD_MASK || f.password == null ? cur.password : String(f.password),
      root: String(f.root ?? cur.roots.skills),
    });
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
  // 删除自定义工具适配器：不带 confirm 只干跑报影响，带 confirm 才摘挂载删配置
  ipcMain.handle("remove_tool", handle(({ id, confirm: doIt }) => {
    const r = syncer.removeCustomTool(C(), String(id || ""), !!doIt);
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

  // ===== 反代网关（命令实现见 backend/proxy/index.cjs） =====
  proxy.register(ipcMain);
}

module.exports = { register };

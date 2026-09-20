// 配置与数据目录管理（Node 主进程侧）
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 数据源适配器（仅用于首次启动自动探测本机数据源，避免循环依赖时用 require 延迟加载）
const adapter = require("./sync-adapter.cjs");

// Electron safeStorage（主进程可用；纯 Node 环境如脚本直跑时降级明文）
let safeStorage = null;
try {
  const electron = require("electron");
  if (electron && typeof electron === "object" && electron.safeStorage) safeStorage = electron.safeStorage;
} catch {
  /* 非 Electron 环境 */
}

// 密文前缀：config.json 中 WebDAV 密码带此前缀表示经 safeStorage 加密（OS 级密钥，随系统用户绑定）
const ENC_PREFIX = "enc:v1:";
// 密码掩码：load_config 回传渲染进程时用掩码替代明文（渲染层拿不到真实密码）；
// save_config 收到精确掩码值时视为「未修改」，保留磁盘上的原密码
const PASSWORD_MASK = "••••••••";

/** 明文 → 密文；safeStorage 不可用时原样返回（降级明文存储） */
function encryptPassword(plain) {
  if (!plain || typeof plain !== "string" || plain.startsWith(ENC_PREFIX)) return plain ?? "";
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return plain;
  try {
    return ENC_PREFIX + safeStorage.encryptString(plain).toString("base64");
  } catch {
    return plain;
  }
}

/** 密文 → 明文；解密失败（密文来自其他机器/系统用户）返回空串，需重新填写 */
function decryptPassword(stored) {
  if (!stored || typeof stored !== "string" || !stored.startsWith(ENC_PREFIX)) return stored ?? "";
  if (!safeStorage) return "";
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), "base64"));
  } catch {
    return "";
  }
}

/**
 * 便携模式基准目录（exe 所在目录），非便携返回 null。
 * electron-builder 便携版运行时把应用解压到 %TEMP% 且退出即删，process.execPath 指向临时副本；
 * 真正的 exe 目录由 portable stub 注入的 PORTABLE_EXECUTABLE_DIR 提供，必须优先使用它。
 * 安装版/开发环境仍支持在 exe 同目录放 portable.flag 手动开启便携模式。
 */
function portableBaseDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  try {
    const exeDir = path.dirname(process.execPath);
    if (fs.existsSync(path.join(exeDir, "portable.flag"))) return exeDir;
  } catch {
    /* 忽略 */
  }
  return null;
}

/** 判断是否为便携模式（免安装单文件）：便携版不支持开机自启（注册的会是临时解压副本路径）。
 *  数据目录不再随便携模式改变，统一默认 ~/.Dosage_sync，此处仅用于开机自启等能力判定。 */
function isPortable() {
  return portableBaseDir() !== null;
}

/**
 * 旧版（≤1.6.1）安装版数据落在 %APPDATA%/DosageSync；
 * 默认目录改为 ~/.Dosage_sync 后，首次运行时把旧数据复制到新默认目录（复制而非移动，失败不影响使用）。
 */
function migrateLegacyAppData(targetDir) {
  try {
    const legacy = process.env.APPDATA ? path.join(process.env.APPDATA, "DosageSync") : null;
    if (!legacy || legacy === targetDir) return;
    const dbTarget = path.join(targetDir, "dosage-sync.sqlite");
    const dbLegacy = path.join(legacy, "dosage-sync.sqlite");
    // 新目录已初始化或旧目录无数据时不迁移
    if (fs.existsSync(dbTarget) || !fs.existsSync(dbLegacy)) return;
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of ["dosage-sync.sqlite", "dosage-sync.sqlite-wal", "dosage-sync.sqlite-shm", "config.json", "config.json.bak"]) {
      const src = path.join(legacy, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(targetDir, name));
    }
  } catch {
    /* 迁移失败静默：继续用新目录（空数据），旧目录数据保留 */
  }
}

/** 数据目录：优先用户自定义目录，否则默认用户主目录/.Dosage_sync。
 *  默认不再跟随 exe 目录（程序文件夹）——无论安装版还是便携版，未自定义时统一落在
 *  os.homedir()/.Dosage_sync；os.homedir 内部基于 %USERPROFILE% 等系统环境变量动态解析，
 *  绝不硬编码某台电脑的用户名，保证在不同电脑上都指向正确的用户目录。 */
function dataDir() {
  const dir = customDataDir() || defaultDataDir();
  migrateLegacyAppData(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ===== 数据缓存目录自定义（设置页「数据缓存目录」） =====

/** 默认数据目录：动态取当前登录用户主目录（os.homedir 内部即基于 %USERPROFILE% 等系统环境变量），
 *  保证在不同电脑上都指向正确用户目录，绝不硬编码某台电脑的用户名 */
function defaultDataDir() {
  return path.join(os.homedir(), ".Dosage_sync");
}

/** 引导文件路径：记录用户自定义的数据目录。放在主目录下、独立于 dataDir 本身，
 *  避免「配置存在 dataDir 内、却又需要先知道 dataDir 才能读配置」的循环依赖 */
function locationFile() {
  return path.join(os.homedir(), ".Dosage_sync.location");
}

/** 读取用户自定义数据目录；未设置/文件损坏/路径非法时返回 null */
function customDataDir() {
  try {
    const p = locationFile();
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const dir = raw && typeof raw.path === "string" ? raw.path.trim() : "";
    if (dir && path.isAbsolute(dir)) return path.normalize(dir);
  } catch {
    /* 引导文件损坏忽略，回退默认目录 */
  }
  return null;
}

/** 写入用户自定义数据目录（引导文件） */
function setCustomDataDir(dir) {
  const normalized = path.normalize(dir);
  fs.writeFileSync(locationFile(), JSON.stringify({ path: normalized }, null, 2), "utf8");
  return normalized;
}

/** 清除自定义目录（恢复默认 ~/.Dosage_sync） */
function clearCustomDataDir() {
  try { fs.rmSync(locationFile(), { force: true }); } catch { /* 忽略 */ }
}

/**
 * 校验候选数据目录：返回 { ok, message, resolved }。
 * 依次检查：路径非空 → 是否为绝对路径 → 是否可创建/已存在 → 是否可写（写入临时文件再删除）。
 * 校验通过但目录不存在时会自动创建。
 */
function validateDataDir(dir) {
  const raw = typeof dir === "string" ? dir.trim() : "";
  if (!raw) return { ok: false, message: "路径不能为空" };
  if (!path.isAbsolute(raw)) return { ok: false, message: "请输入绝对路径（如 C:\\Users\\<用户名>\\.Dosage_sync）" };
  const resolved = path.normalize(raw);
  try {
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    const st = fs.statSync(resolved);
    if (!st.isDirectory()) return { ok: false, message: "该路径已存在但不是目录" };
    // 写权限探测：创建临时文件并删除
    const probe = path.join(resolved, `.dosage-write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, "ok", "utf8");
    fs.rmSync(probe, { force: true });
    return { ok: true, message: "目录可用", resolved };
  } catch (e) {
    return { ok: false, message: `目录不可用：${e.code ? e.code + " " : ""}${e.message}` };
  }
}

/**
 * 迁移旧数据目录到新目录：把旧目录中的汇总库（含 WAL/SHM）与配置文件复制到新目录。
 * 仅当新目录尚未初始化且旧目录存在数据时执行；失败静默（保留旧目录，不阻断切换）。
 * 返回是否发生了迁移。
 */
function migrateDataDir(fromDir, toDir) {
  try {
    if (!fromDir || !toDir || fromDir === toDir) return false;
    const dbTarget = path.join(toDir, "dosage-sync.sqlite");
    const dbSource = path.join(fromDir, "dosage-sync.sqlite");
    if (fs.existsSync(dbTarget) || !fs.existsSync(dbSource)) return false;
    // 数据库可能正以 WAL 模式打开：先 checkpoint 把 -wal 合并进主库再复制，
    // 不然「复制主库」与「复制 -wal」之间发生一次自动 checkpoint 就会拿到一对不一致的库文件
    try { require("./db.cjs").checkpoint(); } catch { /* 未初始化时静默，直接复制 */ }
    fs.mkdirSync(toDir, { recursive: true });
    for (const name of ["dosage-sync.sqlite", "dosage-sync.sqlite-wal", "dosage-sync.sqlite-shm", "config.json", "config.json.bak"]) {
      const src = path.join(fromDir, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(toDir, name));
    }
    return true;
  } catch {
    return false;
  }
}

/** 汇总库路径 */
function dbPath() {
  return path.join(dataDir(), "dosage-sync.sqlite");
}

/** 配置文件路径 */
function configPath() {
  return path.join(dataDir(), "config.json");
}

/** 备份压缩包固定文件名（覆盖式，目录内始终只有最新一份） */
const BACKUP_FILE = "dosage-sync-backup.zip";

/**
 * 解析备份目录：配置了 localBackup.dir 用之，否则跟随数据缓存目录。
 * 只做路径解析，不建目录（建目录与写权限探测在备份时进行，失败记日志不抛出异常路径）。
 */
function resolveBackupDir(cfg) {
  const raw = cfg && cfg.localBackup && typeof cfg.localBackup.dir === "string" ? cfg.localBackup.dir.trim() : "";
  if (!raw) return dataDir();
  let normalized = path.normalize(raw);
  // 相对路径相对主进程 cwd 解析，落点不可预测（可能是 System32 等系统目录），一律回退默认数据目录
  // （2026-09-10 审查修复 P6）
  if (!path.isAbsolute(normalized)) return dataDir();
  // 手输路径可能带尾部分隔符（"D:\backup\"），去掉（盘符根 "D:\" 保留）
  return normalized.length > 3 && /[\\/]$/.test(normalized) ? normalized.slice(0, -1) : normalized;
}

/** 默认配置（与前端 src/types/index.ts 及 stores/app.ts 保持一致） */
function defaultConfig() {
  return {
    deviceName: "这台电脑",
    // 服务器凭据统一存框架 config.json 的 webdavShared（useShared=true 时本段只保留
    // root 覆盖值与 preset 记忆；endpoint/username/password 不再落在这里）。
    // 存量远端布局（<root>/usage-tracker/...）与数据格式不变
    webdav: {
      endpoint: "",
      username: "",
      password: "",
      root: "/dosage-sync",
      preset: "feiniu",
      useShared: true,
    },
    // 本机存储（备份压缩包）：dir 为空 = 跟随数据缓存目录
    localBackup: {
      dir: "",
    },
    sources: [
      { source: "zcode", enabled: true, dataDir: null },
      { source: "raccoon", enabled: true, dataDir: null },
      { source: "codex", enabled: false, dataDir: null },
      { source: "dsh", enabled: false, dataDir: null },
      { source: "workbuddy", enabled: true, dataDir: null },
      { source: "workbuddy-ai", enabled: true, dataDir: null },
      { source: "reasonix", enabled: true, dataDir: null },
      { source: "codebuddy", enabled: false, dataDir: null },
      { source: "qoder", enabled: false, dataDir: null },
      { source: "qoder-cn", enabled: false, dataDir: null },
      { source: "antigravity", enabled: false, dataDir: null },
      { source: "antigravity-ide", enabled: false, dataDir: null },
      { source: "antigravity-legacy", enabled: false, dataDir: null },
      { source: "trae", enabled: false, dataDir: null },
      { source: "trae-cn", enabled: false, dataDir: null },
      { source: "trae-solo", enabled: false, dataDir: null },
      { source: "trae-solo-cn", enabled: false, dataDir: null },
      { source: "opensquilla", enabled: false, dataDir: null },
      { source: "grok", enabled: false, dataDir: null },
    ],
    // 工具栏切换项显隐与排序：默认全部显示，顺序即下方 order。
    // initialized=false 表示首次启动尚未自动探测，loadConfig 会据本机数据源自动开启。
    sourceVisibility: {
      order: ["zcode", "raccoon", "codex", "dsh", "workbuddy", "workbuddy-ai", "reasonix", "codebuddy", "qoder", "qoder-cn", "antigravity", "antigravity-ide", "antigravity-legacy", "trae", "trae-cn", "trae-solo", "trae-solo-cn", "opensquilla", "grok"],
      hidden: [],
      initialized: false,
    },
    schedule: {
      hourly: false,
      hourlyInterval: 1,
      daily: false,
      dailyTime: "23:30",
      autoStart: false,
      minimizeToTray: true,
      notifyOnSuccess: false,
    },
    totalMode: "full",
    theme: "light",
    // 软件更新：仅「自动检测新版本」开关（默认开）；检测频率为代码内常量（启动后 60 秒 + 每小时）
    update: {
      autoCheck: true,
      notifiedVersion: "", // 已弹过「发现新版本」通知的版本号（跨会话去重，检测到更高版本时替换）
    },
    // 计费设置（费用页显示 / 计费规则页维护；价格表数据在 SQLite，经 WebDAV 多设备同步）
    billing: {
      enabled: false, // 默认关闭：关闭时隐藏费用页入口与所有费用元素，记录与同步不受影响
      displayCurrency: "CNY",
      usdToCny: 7.2,
      importProxy: "", // 价格源导入代理（留空=系统代理/直连）
      // 远程价格源自动拉取（来源 remote，参考 sub2api 的 pricing.remote_url/hash_url）
      remotePricing: {
        enabled: false,
        url: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json",
        hashUrl: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.sha256",
        intervalHours: 24,
      },
    },
  };
}

/** 深合并：用默认配置补齐缺失字段，避免旧配置升级后缺键 */
function mergeConfig(def, cfg) {
  const out = { ...def };
  if (!cfg || typeof cfg !== "object") return out;
  for (const k of Object.keys(def)) {
    if (k in cfg) {
      const dv = def[k];
      const cv = cfg[k];
      if (dv && typeof dv === "object" && !Array.isArray(dv) && cv && typeof cv === "object") {
        out[k] = mergeConfig(dv, cv);
      } else {
        out[k] = cv;
      }
    }
  }
  return out;
}

/**
 * 工具栏切换项显隐与排序归一化。
 * - order/hidden 补齐到全部已注册数据源（新增数据源自动补入，按其默认相对位置插入以保持同族相邻）；
 * - initialized=false（首次启动）时：探测本机数据源，检测到的自动「显示 + 启用」，
 *   未检测到的按默认 enabled 值显示（保持原有行为），随后置 initialized=true。
 * 归一化后的结果写回 merged，由 saveConfig 落盘持久化。
 */
function normalizeSourceVisibility(cfg) {
  const allIds = adapter.sources.map((s) => s.id);
  const defaults = defaultConfig().sourceVisibility;
  let vis = cfg.sourceVisibility;
  if (!vis || typeof vis !== "object") {
    vis = { order: defaults.order.slice(), hidden: [], initialized: false };
    cfg.sourceVisibility = vis;
  }
  const order = Array.isArray(vis.order) ? vis.order.filter((id) => typeof id === "string") : [];
  const hidden = Array.isArray(vis.hidden) ? vis.hidden.filter((id) => typeof id === "string") : [];

  // 首次启动自动探测：检测到数据源 → 显示 + 启用（需求 2）
  if (!vis.initialized) {
    for (const src of adapter.sources) {
      let dir = null;
      try {
        dir = src.detect();
      } catch {
        dir = null;
      }
      const detected = !!dir;
      if (detected) {
        // 从 hidden 中移除（确保显示）
        if (!order.includes(src.id)) order.push(src.id);
        // 自动启用同步
        const s = (cfg.sources || []).find((item) => item.source === src.id);
        if (s) s.enabled = true;
      }
    }
    vis.initialized = true;
  }

  // order 补齐未出现的新数据源：按默认 order 的相对位置插入（使同族源相邻，
  // 如 workbuddy-ai 紧跟 workbuddy），而非一律追加末尾。
  // 只决定「新源插在哪」，已存在项的相对顺序（含用户拖拽过的自定义顺序）完全不变。
  const rankOf = new Map(defaults.order.map((id, i) => [id, i]));
  const rankOrLast = (id) => (rankOf.has(id) ? rankOf.get(id) : Number.MAX_SAFE_INTEGER);
  const merged = order.slice();
  for (const id of allIds) {
    if (merged.includes(id)) continue;
    const target = rankOrLast(id);
    // 插到「默认顺序中位于其前的最后一个已存在项」之后；若前面没有则插到最前。
    // 未登记在默认顺序中的源（rank 为 MAX）会被放到全部已知源之后。
    let at = 0;
    for (let i = 0; i < merged.length; i++) {
      if (rankOrLast(merged[i]) < target) at = i + 1;
    }
    merged.splice(at, 0, id);
  }
  vis.order = merged;
  // hidden 过滤掉已不存在的数据源
  vis.hidden = hidden.filter((id) => allIds.includes(id));
}

/** 加载配置（不存在则返回默认） */
function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) {
    const cfg = defaultConfig();
    normalizeSourceVisibility(cfg);
    return cfg;
  }
  try {
    const text = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(text);
    const merged = mergeConfig(defaultConfig(), parsed);
    const configured = new Map(
      (Array.isArray(parsed.sources) ? parsed.sources : [])
        .filter((item) => item && typeof item === "object")
        .map((item) => [item.source, item])
    );
    merged.sources = defaultConfig().sources.map((fallback) => {
      const saved = configured.get(fallback.source);
      return saved
        ? {
            source: fallback.source,
            enabled: typeof saved.enabled === "boolean" ? saved.enabled : fallback.enabled,
            dataDir: typeof saved.dataDir === "string" && saved.dataDir ? saved.dataDir : null,
          }
        : fallback;
    });
    // 已下线/未知源的保存配置保留（如 antigravity 暂时下线期间），恢复上线后设置不丢
    for (const [id, saved] of configured) {
      if (!merged.sources.some((s) => s.source === id)) {
        merged.sources.push({
          source: id,
          enabled: typeof saved.enabled === "boolean" ? saved.enabled : false,
          dataDir: typeof saved.dataDir === "string" && saved.dataDir ? saved.dataDir : null,
        });
      }
    }
    // 本机存储（备份压缩包）归一化：dir 非字符串/缺失时回退空（跟随数据缓存目录）
    if (!merged.localBackup || typeof merged.localBackup !== "object") merged.localBackup = { dir: "" };
    merged.localBackup.dir = typeof merged.localBackup.dir === "string" ? merged.localBackup.dir.trim() : "";
    // WebDAV 密码：密文解密为明文交给上层使用（明文旧配置保持原样，保存时自动迁移为密文）
    if (merged.webdav) merged.webdav.password = decryptPassword(merged.webdav.password);
    // 统一 WebDAV：useShared 生效时用框架 webdavShared 的服务器凭据覆盖本段
    // （root 保留本模块覆盖值；远端存量布局不变）。注意框架 config.cjs 迁移时会回写
    // 本配置（清空旧服务器字段），此处通过延迟 require 避免循环依赖
    if (merged.webdav && merged.webdav.useShared !== false) {
      try {
        const fw = require("./config.cjs");
        const shared = fw.loadSharedWebdav();
        merged.webdav.useShared = true;
        merged.webdav.endpoint = shared.endpoint;
        merged.webdav.username = shared.username;
        merged.webdav.password = shared.password;
      } catch { /* 框架配置不可达时保留本段旧值 */ }
    }
    // 总量口径归一化：platform 选项从未实现（等效 compact），已从 UI 移除，旧配置值回退为 compact
    if (merged.totalMode !== "full" && merged.totalMode !== "compact") merged.totalMode = "compact";
    // 计费配置归一化：币种只允许 CNY/USD，汇率必须为正数；远程价格源网址为空时回默认
    if (merged.billing) {
      if (merged.billing.displayCurrency !== "USD") merged.billing.displayCurrency = "CNY";
      const rate = Number(merged.billing.usdToCny);
      merged.billing.usdToCny = isFinite(rate) && rate > 0 ? rate : 7.2;
      if (typeof merged.billing.importProxy !== "string") merged.billing.importProxy = "";
      merged.billing.enabled = !!merged.billing.enabled;
      const rp = merged.billing.remotePricing;
      if (rp && typeof rp === "object") {
        rp.enabled = !!rp.enabled;
        rp.url = typeof rp.url === "string" && rp.url.trim() ? rp.url.trim() : defaultConfig().billing.remotePricing.url;
        rp.hashUrl = typeof rp.hashUrl === "string" ? rp.hashUrl.trim() : "";
        const hours = Number(rp.intervalHours);
        rp.intervalHours = isFinite(hours) && hours >= 1 ? hours : 24;
      } else {
        merged.billing.remotePricing = defaultConfig().billing.remotePricing;
      }
    }
    // 工具栏切换项显隐与排序：归一化 + 首次启动自动探测
    normalizeSourceVisibility(merged);
    // 更新开关归一化：仅接受布尔，旧配置缺字段时 mergeConfig 已补默认值
    if (!merged.update || typeof merged.update !== "object") merged.update = defaultConfig().update;
    merged.update.autoCheck = !!merged.update.autoCheck;
    merged.update.notifiedVersion = typeof merged.update.notifiedVersion === "string" ? merged.update.notifiedVersion : "";
    return merged;
  } catch (e) {
    // 配置损坏时留档（.bak）并回退默认，避免应用无法启动；旧留档先删，Windows 下 rename 不覆盖
    try { fs.rmSync(p + ".bak", { force: true }); fs.renameSync(p, p + ".bak"); } catch { /* 留档失败忽略 */ }
    return defaultConfig();
  }
}

/** 保存配置（先写临时文件再原子替换；WebDAV 密码落盘前经 safeStorage 加密） */
function saveConfig(cfg) {
  const p = configPath();
  const out = { ...cfg, webdav: { ...(cfg.webdav || {}) } };
  if (out.webdav) out.webdav.password = encryptPassword(out.webdav.password);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
  fs.renameSync(tmp, p);
}


module.exports = {
  dataDir, dbPath, configPath, loadConfig, saveConfig, defaultConfig, isPortable, PASSWORD_MASK,
  defaultDataDir, customDataDir, setCustomDataDir, clearCustomDataDir, validateDataDir, migrateDataDir,
  resolveBackupDir, BACKUP_FILE,
};

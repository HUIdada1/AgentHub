/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-03（归档版 2026-10-22，本文件自归档恢复并按双模块形态改造）
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// AgentHub Docker headless 形态入口：号池管家（proxy）+ 本地网关（localgw）+ 提示词库（prompts）+ 记忆中枢（memory）四模块装配
//
// 方案：docs/docker-上线/Docker版上线方案-20261103.md（板块 B）。
// 提示词库是第三个容器化板块：Web 控制台需要 prompts 的库/优化/目录/同步全部命令，
// 否则「提示词库」页面整页 404（实测前端调用 42 条 prompts_* 命令）。
// 记忆中枢是第四个容器化板块：Web 控制台需要 memory 的库/统计/配置/同步全部命令，
// 否则「记忆中枢」页面整页 404（实测前端调用 95 条 memory_* 命令）。
// 对外接口统一由 localgw（本地网关）提供，渠道能力通过插件适配；号池管理沿用
// proxy/index.cjs 的 boot()（规则/数据库/额度刷新/
// 真实签到 tick/号池同步/deviceMid 自愈/锚点兜底），桌面版日后新增装配项这里自动继承。
//
// 不能破的约束：
//  ① 数据目录与桌面版相互独立：桌面凭据是 safeStorage 密文、容器解不开，两形态之间
//     传号只走号池同步（poolsync 的口令信封通道）；跨机共用数据卷属误配置，不支持。
//  ② 进程内覆盖监听参数，绝不回写 config.json（与桌面版共享宿主配置时绝不篡改对方 bind）。
//  ③ 未设 AGENTHUB_SECRET_KEY 且未显式 AGENTHUB_ALLOW_PLAINTEXT=1 时拒绝启动。
//  ④ 管理面未设 token 时只绑回环；token 校验恒定时间比较；请求体限 4mb。
//  ⑤ 容器不可用能力诚实拒绝（commands.cjs 的 DENY 文案），不假装能过 OAuth/人机校验。
//  ⑥ localgw 在容器里进程内强制 autostart/bind/port（patch 会落盘，故不用 patch 落盘，
//     改在 loadConfig 上套一次进程内覆盖——桌面版配置语义零改动）。
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const PROXY_DIR = path.join(PROJECT_ROOT, "electron", "backend", "proxy");
const BACKEND_DIR = path.join(PROJECT_ROOT, "electron", "backend");
const LOCALGW_DIR = path.join(BACKEND_DIR, "localgw");

// 数据目录先行：config.cjs 的 dataDir() 以 AGENTHUB_DATA_DIR 优先
process.env.AGENTHUB_DATA_DIR = process.env.AGENTHUB_DATA_DIR || path.join(process.cwd(), "data");

// 容器里没有 safeStorage，凭据加密唯一来源是 AGENTHUB_SECRET_KEY；未设置又未显式放行时
// 拒绝启动，比"静默明文落库"更早暴露问题（逃生门只给本地调试）
if (!process.env.AGENTHUB_SECRET_KEY && process.env.AGENTHUB_ALLOW_PLAINTEXT !== "1") {
  console.error("[guard] secret-key-required");
  console.error("[AgentHub Gateway] 拒绝启动：未设置 AGENTHUB_SECRET_KEY，凭据无法加密落盘。");

  console.error("  生产部署：AGENTHUB_SECRET_KEY=$(openssl rand -base64 32)");
  console.error("  仅本地调试需要明文：设 AGENTHUB_ALLOW_PLAINTEXT=1");
  process.exit(1);
}

const express = require("express");
const config = require(path.join(BACKEND_DIR, "config.cjs"));
const { collectCommands, modeOf, DENY } = require("./commands.cjs");
const platform = require(path.join(PROXY_DIR, "platform", "index.cjs"));
const store = require(path.join(PROXY_DIR, "store.cjs"));
const pool = require(path.join(PROXY_DIR, "pool.cjs"));
const adapters = require(path.join(PROXY_DIR, "management-adapters.cjs"));
const pluginHost = require(path.join(BACKEND_DIR, "plugin-host.cjs"));
const extensionPool = require(path.join(BACKEND_DIR, "extensions", "pool-runtime.cjs")).getPoolRuntime(pluginHost);
const extensionForwarder = require(path.join(BACKEND_DIR, "localgw", "forwarder.cjs"));
// 执行服务（渠道绑定与避让规则）：桌面在 main.cjs:193 也是先拿引用再 configure，
// 这里同样要留引用——onExtensionActivated 要调它的 bindDeclaredChannels（专项 §六 4A / G3）
const executionServices = require(path.join(BACKEND_DIR, "localgw", "services.cjs"));
executionServices.configure({ host: pluginHost, poolService: extensionPool,
  executor: require(path.join(BACKEND_DIR, "localgw", "extension-executor.cjs")).createExtensionExecutor({
    pool: require(path.join(BACKEND_DIR, "proxy", "pool.cjs")), poolService: extensionPool,
    onSuccess: (account, model) => require(path.join(BACKEND_DIR, "proxy", "pool.cjs")).noteSuccess(account, model),
    onFailure: extensionForwarder.applyExtensionFailure
  }) });

/** 容器安装即信开关（专项 §四 S1）：默认 **0** = 新装插件要人工确认授权才生效。
 *  设 1 时保留桌面式"装完即用"（自动授权 + 自动启用 + 自动绑定渠道），给个人 NAS 图省事用。
 *  语义只活在 gateway 入口，绝不回写 config.json（约束②）。 */
const PLUGIN_TRUST_ON_INSTALL = process.env.AGENTHUB_PLUGIN_TRUST_ON_INSTALL === "1";

pluginHost.init({ app: { getVersion: platform.version }, bindExtensionSession: extensionPool.bindSession,
  // G3 修复：对齐桌面 main.cjs:200-202 —— 新装 v2 插件把签名声明的渠道固定到它，
  // 避让规则（自定义提供商占用 / 已绑其它来源 / 当前不可用）由 services.bindDeclaredChannels 承担。
  // 但容器默认**不自动接管**：S1 的收敛要做到"没经用户确认，一个渠道都不交给插件执行"，
  // 光收回授权不够——plugin-host.cjs:747 在安装当场就把绑定写进了 serviceBindings，而被接管
  // 渠道在宿主内**没有进程内兜底**（forwarder.cjs:86 / 风险 R1），插件停用即该渠道 503。
  // 所以这里按开关决定是否放行绑定：默认跳过并记日志，TRUST_ON_INSTALL=1 时与桌面同行为。
  onExtensionActivated: (manifest) => {
    if (!PLUGIN_TRUST_ON_INSTALL) {
      platform.log("info", "[gateway] 新装插件未自动接管渠道（容器默认需人工确认）",
        { id: manifest.id, declaredChannels: (manifest.contributes?.providers || []).flatMap((p) => p.channels || []).length });
      return null;
    }
    return executionServices.bindDeclaredChannels(manifest);
  } });

// 官方插件更新器（专项 §四 S2 / §八 V1）：4C 已把网络出口收口到 proxy/platform 的
// fetchBinary 契约，本文件不再被 electron 拖崩（tools/gateway-deps-purity.cjs --entry
// electron/backend/plugin-updater.cjs 实测 exit 0）。但仍要**容错 require**：
// 一旦有人把顶层 require("electron") 写回来，代价必须是"更新功能不可用 + 页面看得见原因"，
// 而不是整个容器起不来（板块 0 的教训：入口崩 = 号池与网关全停）。
let pluginUpdater = null;
let pluginUpdaterLoadError = "";
try {
  pluginUpdater = require(path.join(BACKEND_DIR, "plugin-updater.cjs"));
} catch (e) {
  pluginUpdaterLoadError = String((e && e.message) || e).split("\n")[0];
  console.error("[AgentHub Gateway] 插件更新器不可用（已降级，不影响其余能力）:", pluginUpdaterLoadError);
  console.error("  容器形态不得顶层 require(\"electron\")——见 electron/backend/plugin-updater.cjs:9 的约束注释");
}
const discovery = require(path.join(PROXY_DIR, "discovery.cjs"));
const poolsync = require(path.join(PROXY_DIR, "poolsync.cjs"));
const oplog = require(path.join(PROXY_DIR, "oplog.cjs"));
// v1 号池镜像桥（GET /api/plugins 要回显 poolSync，与桌面 ipc.cjs:614 同一口径）。
// 容器默认不 resume v1 插件，所以这里绝大多数时候 status 是 null —— 字段**存在**才是重点：
// 前端两种形态拿到同一份契约，不必为容器写分支（专项 §四 S4）。缺失时降级成 null 而不是崩。
let pluginBridge = null;
try {
  pluginBridge = require(path.join(BACKEND_DIR, "plugin-bridge.cjs"));
} catch (e) {
  console.error("[AgentHub Gateway] plugin-bridge 不可用，/api/plugins 的 poolSync 恒为 null:", String((e && e.message) || e));
}

const proxyIndex = require(path.join(PROXY_DIR, "index.cjs"));
const localgw = require(path.join(LOCALGW_DIR, "index.cjs"));
const lgwServer = require(path.join(LOCALGW_DIR, "server.cjs"));

const PORT = Number(process.env.AGENTHUB_PROXY_PORT) || 19527;
const BIND = process.env.AGENTHUB_HOST || "0.0.0.0";
const ADMIN_PORT = Number(process.env.AGENTHUB_ADMIN_PORT) || 19528;
const ADMIN_TOKEN = String(process.env.AGENTHUB_ADMIN_TOKEN || "");
// 只读令牌（可选）：日常监视专用，只放行 read 类命令与查询端点——给自动化/看板用更低风险的凭据
const ADMIN_READONLY_TOKEN = String(process.env.AGENTHUB_ADMIN_READONLY_TOKEN || "");
// 管理面绑定地址：显式设置了就用设置值；没设时"有 token → 0.0.0.0、无 token → 回环"。
// 注意 compose 会显式传 0.0.0.0（宿主 DNAT 需要它），所以"无 token 出回环"这一路要靠
// 下面的安全闸降级回容器回环，不能只靠这里的默认值。let 是因为闸会改写它。
let ADMIN_BIND = process.env.AGENTHUB_ADMIN_HOST || (ADMIN_TOKEN || ADMIN_READONLY_TOKEN ? "0.0.0.0" : "127.0.0.1");

/** 是否「出回环」的地址：容器里发布端口必须由 0.0.0.0 承接，所以非回环即视为可达网络。
 *  127.0.0.0/8 与 ::1 与 localhost 算本机，其余（含 0.0.0.0 / :: / 具体网卡地址）都算公网面。 */
function isNonLoopbackHost(host) {
  const h = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h === "::1") return false;
  if (/^127\./.test(h)) return false;
  if (/^::ffff:127\./.test(h)) return false;
  return true;
}

/** 宿主侧「要不要把管理面公开到网络」的意图（compose 的 AGENTHUB_ADMIN_PUBLIC）。
 *  取值为宿主绑定地址（默认 127.0.0.1，公开填 0.0.0.0）；方案原文也出现过 =1 的写法，
 *  这里两种都认，目的是"无论用户照哪种写法配，都不可能静默裸奔"。 */
function wantsPublicAdmin() {
  const v = String(process.env.AGENTHUB_ADMIN_PUBLIC || "").trim().toLowerCase();
  if (!v || v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  return isNonLoopbackHost(v); // 0.0.0.0 / :: / 具体网卡地址 = 要公开；127.0.0.1 / localhost = 不公开
}

const HAS_ADMIN_TOKEN = !!(ADMIN_TOKEN || ADMIN_READONLY_TOKEN);
const WANTS_PUBLIC = wantsPublicAdmin();

// 安全闸（方案 v2 §5.3 第 1 条 / 阶段 0.3，Lead 2026-11-12 裁决改为「降级不崩溃」）：
// 原则是**绝不明文裸奔公网**，但不能让老部署升级后直接起不来。四态：
//   ① 无 token + 显式要公开（PUBLIC=0.0.0.0/1）  → 拒绝启动（用户点名的意图无法安全满足，附一行修法）
//   ② 无 token + 默认/PUBLIC=127.0.0.1            → 启动，但把绑定**强制降回容器回环** + 醒目 WARN。
//      降级后行为与升级前**完全一致**：容器内绑 127.0.0.1 时宿主 DNAT 本就转不进来，
//      管理面照旧不可远程访问，零破坏；HEALTHCHECK 在容器内 curl 回环，仍恒绿。
//   ③ 有 token + 默认                             → 容器内 0.0.0.0，宿主只回环可达（推荐态）
//   ④ 有 token + PUBLIC=0.0.0.0                   → 全公网可达 + WARN 建议前置 TLS 反代
if (!HAS_ADMIN_TOKEN && WANTS_PUBLIC) {
  // 机器标记单独成行：CI 断言只 grep 这行，中文文案可以随便润色而不会把流水线弄断。
  // 标记名即"这条守卫是什么"，比匹配人读句子更能防止"其实测的是别的守卫"。
  console.error("[guard] public-admin-requires-token");
  console.error("[AgentHub Gateway] 拒绝启动：AGENTHUB_ADMIN_PUBLIC 要求把管理面公开到网络，但两个令牌都没设置。");

  console.error("  一行修法：在 gateway/.env 设 AGENTHUB_ADMIN_TOKEN=<你的管理密码>（只读看板可另设 AGENTHUB_ADMIN_READONLY_TOKEN）");
  console.error("  或者把 AGENTHUB_ADMIN_PUBLIC 改回默认 127.0.0.1（远程访问请前置带 TLS 的反向代理，见 deploy/remote-access.md 的 B 档）");
  process.exit(1);
}
if (!HAS_ADMIN_TOKEN && isNonLoopbackHost(ADMIN_BIND)) {
  console.warn("[guard] downgrade-loopback"); // CI 断言用（见 docker.yml B 态），中文文案可润色
  console.warn(`⚠️  [AgentHub Gateway] 未设 AGENTHUB_ADMIN_TOKEN → 管理面已从 ${ADMIN_BIND} 强制降回 127.0.0.1（容器回环）。`);
  console.warn("    效果：宿主端口映射不可达，只有容器内部能访问（HEALTHCHECK 不受影响）；这是刻意的安全默认，不是故障。");
  console.warn("    要打开 Web 控制台：设 AGENTHUB_ADMIN_TOKEN；PUBLIC 保持默认 127.0.0.1，远程交给带 TLS 的反向代理。");
  ADMIN_BIND = "127.0.0.1";
} else if (HAS_ADMIN_TOKEN && WANTS_PUBLIC) {
  console.warn("[guard] public-admin-authorized"); // A/④ 态：已授权公开（将来可断言"这里不该出现 downgrade-loopback"）
  console.warn("⚠️  [AgentHub Gateway] AGENTHUB_ADMIN_PUBLIC 已把管理面发布到所有网卡（裸端口对外）。");

  console.warn("    强烈建议前置带 TLS 的反向代理（Caddy/Nginx）并把 PUBLIC 收回 127.0.0.1；确需直连请确认令牌强度。");
}



// 免凭据路径：探针（Dockerfile 的 HEALTHCHECK 与编排器 probe 都不带 token）与能力清单
// （Web 端登录页要据此判断"这是网关托管的 Web UI 还是纯前端预览"，必须无凭据可读）
const PUBLIC_PATHS = new Set(["/api/livez", "/api/readyz", "/api/capabilities"]);
const BODY_LIMIT = "4mb";
const DRAIN_TIMEOUT_MS = 15000;
// Web UI 产物目录：镜像内由 ui 构建层 COPY 到 gateway/public；本地验证用 AGENTHUB_UI_DIR 指 dist
const UI_DIR = process.env.AGENTHUB_UI_DIR || path.join(__dirname, "..", "public");

let adminServer = null;
let lockFile = null;
let commandTable = null; // boot() 之后由 collectCommands() 填充（register 首行副作用需要配置已可读）

/** 进程内覆盖监听参数（约束②）：localgw 的 autostart/bind/port 由容器环境变量决定。
 *  实现方式：reroute config.loadConfig 目标 + 过滤 localgw 运行态字段的 patch 落盘。
 *
 *  为什么不能用"包装 loadConfig"：localgw/index.cjs 顶层导出 autoStartIfNeeded()（读
 *  lgwConfig.get()→loadConfig）是在 require 时绑定的，gateway 在主入口包装的 loadConfig
 *  拦截不到它。能在 loadConfig 上改的只有 patch() 的落盘路径。正确做法：
 *  ① 启动早期直接读盘改 localgw 段（config.json 是容器数据目录，独立的，不涉及桌面语义）；
 *  ② 蒙板 localgw.patch——拦截 bind/port/autostart 三个由容器接管的键后落盘，其余字段
 *     （路由、模型、API Key、security 等）原样穿透。 */
function applyContainerOverrides() {
  // ① 读盘改：boot 之前一次性落位
  const cfg = config.loadConfig();
  const next = JSON.parse(JSON.stringify(cfg));
  if (!next.localgw || typeof next.localgw !== "object") next.localgw = {};
  next.localgw.autostart = true;
  next.localgw.bind = BIND;
  next.localgw.port = PORT;
  config.saveConfig(next);

  // ② 蒙板 patch：防桌面版「记住网关开关」类磁盘优先逻辑把容器参数反弹回运行时
  const lgwConfig = require(path.join(LOCALGW_DIR, "config.cjs"));
  const origPatch = lgwConfig.patch;
  lgwConfig.patch = function patch(p) {
    const next = { ...(p || {}) };
    delete next.autostart;
    delete next.bind;
    delete next.port;
    return origPatch(next);
  };
}

/** token 校验：双方先 SHA-256 成等长再恒定时间比较（token 长度不进时序） */
function adminTokenOk(token, expected) {
  const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(digest(token), digest(expected));
}

/** 只读令牌只能读：写端点开头调用；拒绝时已应答并返回 false */
function requireFull(req, res) {
  if (req.adminScope !== "read") return true;
  res.status(403).json({ ok: false, message: "只读令牌不能执行该操作（需要完整管理 token）" });
  return false;
}

/** 单实例锁：同一数据目录只允许一个网关进程（本机直跑与容器、或两个容器共卷双写会把
 *  冷却表/签到/号池同步互相踩烂）。同 host 且 pid 存活 → 拒绝；异 host 无法探活，接管并
 *  继续——跨机共用数据卷属误配置，部署文档明确不支持 */
function acquireLock() {
  const file = path.join(process.env.AGENTHUB_DATA_DIR, "gateway.lock");
  try {
    if (fs.existsSync(file)) {
      const [host, pidStr] = String(fs.readFileSync(file, "utf8")).trim().split(":");
      const pid = Number(pidStr);
      if (host === os.hostname() && Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e) {
          alive = e.code !== "ESRCH"; // 除"不存在"外一律按存活保守处理：误接管=双写，代价最大
        }
        if (alive) {
          console.error(`[AgentHub Gateway] 拒绝启动：数据目录已被本机 pid ${pid} 占用（${file}）`);
          process.exit(1);
        }
      }
    }
    fs.writeFileSync(file, `${os.hostname()}:${process.pid}`);
    return file;
  } catch (e) {
    platform.log("warn", "[gateway] 锁文件不可用，跳过单实例检查", { message: String((e && e.message) || e) });
    return null;
  }
}

async function main() {
  lockFile = acquireLock();
  console.log(`[AgentHub Gateway] 启动中 platform=${platform.form()} version=${platform.version()}`);
  console.log(`[AgentHub Gateway] 数据目录 ${process.env.AGENTHUB_DATA_DIR}`);
  console.log(`[AgentHub Gateway] 凭据加密 ${process.env.AGENTHUB_SECRET_KEY ? "AES-256-GCM (AGENTHUB_SECRET_KEY)" : "无（AGENTHUB_ALLOW_PLAINTEXT=1 已放行明文）"}`);

  // 进程内覆盖（约束②）：先落位再 boot——boot 内的 rules.init/store.open/调度器读的全是落位后值
  applyContainerOverrides();

  // 首启修正自己的 config：qoder 双区需要本机客户端 wasm 签名，容器里必然失败（归档版同款）。
  // 这里 patch 的是渠道启闭（用户数据），不是监听参数，落盘是刻意的——容器数据目录本就独立。
  const cfg = config.loadConfig();
  const ce = (cfg.proxy && cfg.proxy.channelEnabled) || {};
  if (ce.qoder !== false || ce.qoder_intl !== false) {
    cfg.proxy.channelEnabled = Object.assign({}, ce, { qoder: false, qoder_intl: false });
    config.saveConfig(cfg);
  }

  // localgw 广播器必须在 boot 之前注入（usagehook 的广播器只在 boot 时注入，晚注入丢启动初期事件）。
  // 出口直接写 SSE 客户端：usagehook.broadcast 自己包 {event:"localgw", type:"request", ...} 信封，
  // 不走 platform.emit——后者是号池管家（proxy）事件的出口，事件名要固定 "proxy"，混发会让
  // 前端 onUpdateEvent 把 localgw 请求事件误当号池事件刷新（信封不再同形）
  localgw.setRuntime({
    broadcast: (payload) => sseWrite(payload),
  });

  await proxyIndex.boot();
  // Provider transport only; legacy desktop UI plugins are not headless services.
  try { await pluginHost.resumeEnabled({ schema: 2 }); }
  catch { console.error("[AgentHub Gateway] 插件恢复失败，原号池与标准网关继续启动"); }
  // 官方插件更新器初始化（专项 §六 4A）：与桌面 main.cjs:912-927 同序——先恢复已装插件，后排更新。
  // 容器默认 autoApply=false（platform.isElectron 为假且未设 AGENTHUB_PLUGIN_AUTO_UPDATE=1），
  // 于是 init 不排定时器、tick 首行即返回，而**手动 check/apply 照常可用**（专项 §四 S2 定案④）。
  // onStatus 的信封与桌面 app:event 完全同形（{event:"plugin-update", status}，见 main.cjs:922），
  // 前端 ConfigPluginsSection.vue:260 的 `ev?.event!=="plugin-update"||!ev.status` 判定原样命中，
  // 不需要为容器写第二套消费逻辑。
  if (pluginUpdater) {
    try {
      pluginUpdater.init({
        app: { getVersion: platform.version },
        onStatus: (status) => sseWrite({ event: "plugin-update", status }),
        // S1 收敛的第二处调用点（第一处是 POST /api/plugins/install）：feed 自动更新装完也走
        // 同一个 revokeAutoGrantOnInstall，绝不出现"手动上传要确认、自动更新不用确认"的不对称。
        // 该函数自己不抛（内部全捕获），所以这里 fire-and-forget 不会变成 unhandledRejection；
        // 桌面 main.cjs:916 不传这个钩子 → 桌面仍是"装完即用"，行为零变化。
        onInstalled: (result) => { void revokeAutoGrantOnInstall(result); },
      });

      const up = pluginUpdater.getStatus();
      console.log(`[AgentHub Gateway] 插件更新器已就绪 form=${up.form} autoApply=${up.autoApply}`
        + `（自动链路${up.autoApply ? "开启" : "关闭：容器默认手动，需要它请设 AGENTHUB_PLUGIN_AUTO_UPDATE=1"}）`);
    } catch (e) {
      // 更新器起不来不能拖垮容器：号池与网关照跑，页面侧由 updateStatus 的 error 字段诚实暴露
      console.error("[AgentHub Gateway] 插件更新器初始化失败（已降级，不影响其余能力）:", String((e && e.message) || e));
    }
  }

  // 提示词库：库/优化/目录/同步全部命令经管理 RPC 暴露（Web 控制台不遗漏操作页面）。
  // prompts.boot() 只启动调度器（定时同步），register 已在 collectCommands 里完成。
  const promptsIndex = require(path.join(BACKEND_DIR, "prompts", "index.cjs"));
  promptsIndex.boot();
  // 记忆中枢：库/统计/配置/同步全部命令经管理 RPC 暴露（Web 控制台不遗漏操作页面）。
  // memory.boot() 启动索引与桥接，register 已在 collectCommands 里完成。
  const memoryIndex = require(path.join(BACKEND_DIR, "memory", "index.cjs"));
  memoryIndex.boot();
  const lgwBoot = await localgw.boot(); // autostart 已被进程内覆盖为 true，server.start() 由它触发
  if (!lgwBoot || lgwBoot.ok !== true) {
    console.error("[AgentHub Gateway] 本地网关启动失败:", (lgwBoot && lgwBoot.message) || "未知原因");
    process.exit(1);
  }
  // 真实监听参数以 localgw 自身状态为准：config 的 portCandidates[0] 可能是端口已被占（幂等启动时）
  // 落回的旧值——日志别拿覆盖前的值糊弄（契约：诚实不谎报）
  const st = lgwServer.status();
  console.log(`✅ [AgentHub Gateway] 本地网关已监听 ${st.bind}:${st.port}/v1（chat/completions · messages · responses · models）`);

  commandTable = collectCommands();

  adminServer = startAdmin();
  console.log(`✅ [AgentHub Gateway] 管理 API 已监听 ${ADMIN_BIND}:${ADMIN_PORT}（${ADMIN_TOKEN ? "Bearer token 鉴权" : "未设 token，仅回环可达"}）`);
}

// ===== 管理 API =====

/** 路由包装：异常收敛为 JSON 错误（与桌面 IPC 层的 handle() 同款形状）。
 *  同步抛错与异步拒绝都兜住——async handler 的拒绝不会被 try 捕获，漏掉会变成
 *  unhandledRejection 且客户端永远等不到响应 */
function handle(fn) {
  const fail = (res, e) => {
    if (!res.headersSent) res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  };
  return (req, res) => {
    try {
      const out = fn(req, res);
      if (out && typeof out.then === "function") out.catch((e) => fail(res, e));
      return out;
    } catch (e) {
      fail(res, e);
    }
  };
}

function adminAuth(req, res, next) {
  // 非 /api 前缀 = UI 静态资源与 SPA 入口（前端代码无敏感），免凭据。
  // 注意不能用 app.use("/api", adminAuth) 表达：express 会剥掉挂载前缀，PUBLIC_PATHS
  // 与探针判定将全部失配，HEALTHCHECK 401 会把容器判成不健康
  if (!req.path.startsWith("/api/")) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (!ADMIN_TOKEN && !ADMIN_READONLY_TOKEN) {
    req.adminScope = "full"; // 无令牌 = 仅回环可达，等同全权（保持既有语义）
    return next();
  }
  const hdr = String(req.headers.authorization || "");
  const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  const token = bearer || String(req.headers["x-admin-token"] || "");
  if (token && ADMIN_TOKEN && adminTokenOk(token, ADMIN_TOKEN)) {
    req.adminScope = "full";
    return next();
  }
  if (token && ADMIN_READONLY_TOKEN && adminTokenOk(token, ADMIN_READONLY_TOKEN)) {
    req.adminScope = "read";
    return next();
  }
  res.status(401).json({ ok: false, message: "管理 token 缺失或错误（Authorization: Bearer <AGENTHUB_ADMIN_TOKEN>）" });
}

/** /api/status 的模块摘要（板块7 ②：去掉 `{running}` 占位，换成真实计数）。
 *
 * 取数方式是**复用已注册的 RPC handler**（commandTable），不去 require 模块的内部实现：
 *  - 不新增业务语义（禁区），也不引入第二条读路径（口径必须与前端单查一致，
 *    验收要求"逐位一致"，只有走同一个 handler 才谈得上逐位一致）；
 *  - 只**白名单挑计数**，绝不整段透传：`memory_status` 里有 `root`（用户本机绝对路径）、
 *    `memory_index_status` 里有 `rootDir`，那些都不该出现在给看板的摘要里；
 *    同理任何凭据字段都不进（板块3 立的规矩，这里不开新门）。
 * 拿不到就如实报 `available:false + reason`，不用 0 或 {running:true} 冒充。
 * 注意本函数不 await 单个失败：任何一个模块挂了都不该让整个 /api/status 变 500。 */
async function moduleSummary(cmd, pick) {
  try {
    const fn = commandTable && commandTable.get(cmd);
    if (!fn) return { available: false, reason: `${cmd} 未注册` };
    const r = await fn(null, {});
    if (!r || r.ok !== true) return { available: false, reason: String((r && r.message) || "该模块未就绪") };
    const out = { available: true };
    // from 允许点路径（如 "stats.total"）：prompts_stats 的计数嵌在 stats 下，
    // memory_stats 是平铺。这里若按顶层硬取会得到 undefined，而 JSON.stringify
    // 会**静默丢掉 undefined 键** —— 响应看着正常、其实一个数都没有（本轮踩过）。
    for (const [to, from] of pick) {
      let v = r;
      for (const seg of String(from).split(".")) v = v && typeof v === "object" ? v[seg] : undefined;
      out[to] = v === undefined ? null : v;
    }
    return out;

  } catch (e) {
    return { available: false, reason: String((e && e.message) || e) };
  }
}

function registerProbes(app) {

  // 存活：进程活着就 200（容器 HEALTHCHECK 挂这里）；就绪：至少一个启用渠道有在线账号
  app.get("/api/livez", (req, res) => res.json({ ok: true }));
  app.get("/api/readyz", (req, res) => {
    let ready = false;
    try {
      ready = store.CHANNELS.some((c) => adapters.channelOn(c.id) && pool.poolSummary(c.id).onlineCount > 0);
    } catch { /* 库异常按未就绪 */ }
    res.status(ready ? 200 : 503).json({ ok: ready });
  });
  app.get("/api/status", handle(async (req, res) => {
    // 两个摘要并行取，任一慢/挂都不该拖住另一个（status 是看板首屏要打的第一个请求）
    const [promptsSum, memorySum] = await Promise.all([
      moduleSummary("prompts_stats", [["total", "stats.total"], ["today", "stats.today"], ["week", "stats.week"], ["optimized", "stats.optimized"], ["favorited", "stats.favorited"], ["trash", "stats.trash"], ["conflicts", "stats.conflicts"], ["lastSyncAt", "stats.lastSyncAt"]]),
      moduleSummary("memory_stats", [["total", "total"], ["projects", "projects"], ["today", "today"], ["yesterday", "yesterday"], ["pending", "pending"], ["l2", "l2"], ["agents", "agents"], ["llmToday", "llmToday"], ["llmCalls", "llmCalls"]]),
    ]);
    let promptsRunning = false;
    try { promptsRunning = !!require(path.join(BACKEND_DIR, "prompts", "index.cjs")).isRunning(); } catch { /* 未装配按未运行 */ }
    let memoryEnabled = false;
    try { const st = await require(path.join(BACKEND_DIR, "memory", "index.cjs")).status?.(); memoryEnabled = !!(st && st.enabled); } catch { /* 读不到按未启用 */ }
    res.json({
      ok: true,
      localgw: lgwServer.status(),
      // 与桌面号池总览对齐的常用字段：外部监控/看板不必再走 RPC 组装
      today: store.statsToday(),
      // 提示词库：条数 / 今日 / 冲突 / 回收站（原来是 {running} 占位，看板拿不到任何数）
      prompts: Object.assign({ running: promptsRunning }, promptsSum),
      // 记忆中枢：条数 / 今日 / 待处理 / 项目数（不含 root 等本机绝对路径）
      memory: Object.assign({ running: memoryEnabled }, memorySum),
      // 与 /api/capabilities 同一份判定（HAS_ADMIN_TOKEN）：登录页可能先读到任一个，
      // 两处口径必须一样，否则又变成"第三份说法"
      authRequired: HAS_ADMIN_TOKEN,
      // 实时通道自述（板块7 ①的诚实面）：SSE 里**真的有**哪些事件流。
      // memory / prompts 在主进程侧的 emit() 是模块内本地函数、直接写 BrowserWindow，
      // 容器里既没有窗口也没有 setRuntime/broadcast 注入通道（实测：两模块内部对 emit 的
      // 18+ 处调用全是本地引用，经 exports 覆盖拦不到），所以它们的事件在容器形态**会丢**。
      // 前端据此把对应面板标成「非实时（轮询）」而不是假装进度在动 —— 诚实优先于好看。
      // 真要补链需要改 electron/backend/memory 与 prompts 的广播出口，属跨形态改造，不在本板块范围。
      realtime: {
        proxy: true,      // platform.onEmit → sseWrite
        localgw: true,    // localgw.setRuntime({broadcast}) → sseWrite
        pluginUpdate: !!pluginUpdater, // updater onStatus → sseWrite（加载失败时自动变 false）
        memory: false,
        prompts: false,
      },

      channels: store.CHANNELS.filter((c) => adapters.channelOn(c.id)).map((c) => ({
        id: c.id,
        display: c.display,
        ...pool.poolSummary(c.id),
      })),
      platform: platform.form(),
      version: platform.version(),
      dataDir: process.env.AGENTHUB_DATA_DIR,
      encryption: process.env.AGENTHUB_SECRET_KEY ? "aes-256-gcm" : "plaintext",
    });
  }));
}

function registerPoolRoutes(app) {
  app.get("/api/accounts", handle((req, res) => {
    res.json({ ok: true, accounts: store.listAccounts() });
  }));
  // JSON 导入：body 为候选数组或 { channel, accounts: [...] }
  app.post("/api/accounts/import", handle((req, res) => {
    if (!requireFull(req, res)) return;
    const body = req.body || {};
    // 桌面端账号列表导出是元数据包（无 token）：明确告知，不要逐条报“该候选不含可用凭据”
    if (!Array.isArray(body) && body.format === "agenthub-accounts") {
      res.status(400).json({
        ok: false,
        imported: 0,
        total: Array.isArray(body.accounts) ? body.accounts.length : 0,
        message: proxyIndex.METADATA_ONLY_MESSAGE,
        results: [],
      });
      return;
    }
    const list = Array.isArray(body) ? body : Array.isArray(body.accounts) ? body.accounts : [body.candidate || body];
    const channel = Array.isArray(body) ? "" : String(body.channel || "");
    const results = list.map((c) => {
      try {
        const r = discovery.importCandidate(c, channel || undefined);
        return { ok: true, id: r.id, updated: !!r.updated };
      } catch (e) {
        return { ok: false, message: String((e && e.message) || e) };
      }
    });
    const okCount = results.filter((r) => r.ok).length;
    res.status(okCount ? 200 : 400).json({ ok: okCount > 0, imported: okCount, total: list.length, results });
  }));
  app.get("/api/channels", handle((req, res) => {
    res.json({
      ok: true,
      channels: store.CHANNELS.filter((c) => adapters.channelOn(c.id)).map((c) => ({
        id: c.id,
        display: c.display,
        ...pool.poolSummary(c.id),
      })),
    });
  }));
  app.get("/api/models", handle((req, res) => {
    res.json({ ok: true, models: adapters.listableModels(config.loadConfig().proxy) });
  }));
}

/** framework 配置的**路径全等**白名单（方案 v2 §3.2 / §八 阶段3、Lead 11-12 定案）。
 *
 * 为什么必须按"完整路径"而不是"键名在集合里就放行"（F3，务必保留这段注释）：
 * 磁盘上 `theme` 有两个 —— 顶层 `theme:"dark"`（框架主题，:125）和 `pet.theme:"gargantua"`
 * （桌宠主题，:250）。按键名匹配会把 `pet.theme` 一起放开，等于把桌面专属配置写进容器通路。
 * 同类风险还有 `proxy.port/bind`（容器由编排固定，改了会把管理面/数据面搞乱）与
 * `localgw.models.serviceBindings`（渠道绑定，属 providers_exec 的校验通路，见下）。
 *
 * 方案原文里的 `localgw.*.limits` 在磁盘上**不存在**（localgw 顶层只有
 * routing / models / outbound + bodyLimitMb / requestTimeoutMs / streamTotalTimeoutMs），
 * 这里按真实键名登记限额三项；不要照方案文本"补一个 limits"。
 */
const FRAMEWORK_WHITELIST = new Map([
  // —— 外观（纯展示，无副作用）——
  ["theme", { kind: "enum", values: ["dark", "light"] }],
  ["fx", { kind: "bool" }],
  ["fxParticles", { kind: "bool" }],
  ["fxPools", { kind: "bool" }],
  ["fxCursor", { kind: "bool" }],
  ["moduleOrder", { kind: "moduleOrder" }],
  // —— 板块启停：只允许容器里真实存在、且关掉不会自断生路的板块 ——
  // localgw 不上：桌面侧就锁死启用（config.cjs:152 方案决策 5），容器若允许关掉本地网关，
  //           等于让管理界面把自己唯一对外服务的能力关掉，恢复只能改 compose 重建。
  ["modules.proxy.enabled", { kind: "bool" }],
  ["modules.memory.enabled", { kind: "bool" }],
  ["modules.prompts.enabled", { kind: "bool" }],
  ["modules.skills.enabled", { kind: "bool" }],
  ["modules.sync.enabled", { kind: "bool" }],
  // —— 调度（只放同步时刻；autoStart / lightweightMode / shortcutToggle / minimizeToTray
  //     是桌面窗口与开机语义，容器里没有窗口，放开只会写出永远不生效的字段）——
  ["schedule.daily", { kind: "bool" }],
  ["schedule.hourly", { kind: "bool" }],
  ["schedule.dailyTime", { kind: "hhmm" }],
  ["watch.intervalSeconds", { kind: "int", min: 2, max: 3600 }],
  // —— 号池管家运行参数（不含 port / bind / 绝对路径 / 口令类）——
  ["proxy.routeStrategy", { kind: "enum", values: ["smart", "fixed"] }],
  ["proxy.routeOrder", { kind: "enum", values: ["score", "cost-first"] }],
  ["proxy.fixedChannel", { kind: "channel" }],
  ["proxy.rateLimitPerMin", { kind: "int", min: 0, max: 100000 }],
  ["proxy.concurrency", { kind: "int", min: 1, max: 512 }],
  ["proxy.creditsRefreshMin", { kind: "int", min: 15, max: 1440 }], // 下限 15 由 credits.startScheduler 强制
  ["proxy.usageRetentionDays", { kind: "int", min: 1, max: 3650 }],
  ["proxy.expiringSoonDays", { kind: "int", min: 0, max: 3650 }],
  ["proxy.humanizeJitter", { kind: "bool" }],
  ["proxy.autoFallbackEnabled", { kind: "bool" }],
  ["proxy.channelFailover", { kind: "bool" }],
  ["proxy.channelFailoverMax", { kind: "int", min: 1, max: 10 }],
  // —— 本地网关路由与限额（方案文本的 limits 段实际是这三条顶层标量）——
  ["localgw.routing.strategy", { kind: "enum", values: ["smart", "fixed", "round-robin", "score", "cost-first", "credit-first"] }],
  ["localgw.routing.fixedChannel", { kind: "channel" }],
  ["localgw.routing.failover", { kind: "bool" }],
  ["localgw.routing.cooldownMs", { kind: "int", min: 0, max: 3600000 }],
  ["localgw.routing.cooldownCapMs", { kind: "int", min: 0, max: 86400000 }],
  ["localgw.routing.maxRetriesPerRequest", { kind: "int", min: 0, max: 10 }],
  ["localgw.routing.sticky", { kind: "enum", values: ["auto", "on", "off"] }],
  ["localgw.routing.needsFilter", { kind: "bool" }],
  ["localgw.bodyLimitMb", { kind: "int", min: 1, max: 512 }],
  ["localgw.requestTimeoutMs", { kind: "int", min: 1000, max: 3600000 }],
  ["localgw.streamTotalTimeoutMs", { kind: "int", min: 0, max: 3600000 }],
  // ⚠️ 刻意**不放** `plugins.feedUrl`：方案的意图是"允许改 feed（强制 https + full + oplog）"，
  // 那个能力已经由 PUT /api/plugins/feed 单点实现（含 env 锁定回 409 的契约）。
  // 在这里再开一条写入口，等于同一个事实两处校验、两个 oplog 口径，迟早分叉
  // （Lead 11-12：「不得两处各判一遍 env」）。要改 feed 只有一条路：/api/plugins/feed。
]);
const FRAMEWORK_MODULE_KEYS = ["sync", "memory", "prompts", "proxy", "localgw", "skills"];

/** 值校验：返回 {ok} 或 {ok:false, message}。类型严格，宁可拒也不猜。 */
function validateFrameworkValue(rule, value) {
  switch (rule.kind) {
    case "bool":
      return typeof value === "boolean" ? { ok: true } : { ok: false, message: "需要 true/false" };
    case "int": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isInteger(n)) return { ok: false, message: "需要整数" };
      if (n < rule.min || n > rule.max) return { ok: false, message: `需在 ${rule.min}~${rule.max} 之间` };
      return { ok: true, coerced: n };
    }
    case "enum":
      return rule.values.includes(value) ? { ok: true } : { ok: false, message: `只允许 ${rule.values.join(" / ")}` };
    case "hhmm":
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? { ok: true } : { ok: false, message: "需要 HH:MM（24 小时制）" };
    case "channel":
      // 空串=不指定；其余必须是合法渠道 id 形状（不查 CHANNELS 是为了不在此处引入渠道真相，
      // 真正的使用校验在路由模块里，这里只挡明显越界（路径注入 / 超长）
      return value === "" || /^[a-z0-9_]{1,40}$/.test(String(value)) ? { ok: true } : { ok: false, message: "渠道 id 形状不合法" };
    case "moduleOrder": {
      if (!Array.isArray(value) || !value.length) return { ok: false, message: "需要非空数组" };
      const bad = value.filter((k) => !FRAMEWORK_MODULE_KEYS.includes(k));
      if (bad.length) return { ok: false, message: `含未知板块：${bad.join(", ")}` };
      if (new Set(value).size !== value.length) return { ok: false, message: "板块名重复" };
      return { ok: true };
    }
    default:
      return { ok: false, message: "白名单规则缺 kind（内部错误）" };
  }
}

/** 按点路径读写（只服务白名单路径，不接任意路径）*/
function getPath(obj, dotted) {
  return dotted.split(".").reduce((acc, k) => (acc && typeof acc === "object" ? acc[k] : undefined), obj);
}
function setPath(obj, dotted, value) {
  const keys = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * GET/PUT /api/config/framework —— 容器安全的界面偏好读写（总纲 §3.2 / §八 阶段3）。
 *
 * 为什么不是把 load_config/save_config 放开（禁区）：那两条会把绝对路径（prompts_set_dir /
 * memory_root_set 类）、口令类、update.* 与 localgw.models.serviceBindings 一并暴露给浏览器，
 * 而其中 serviceBindings 有 providers_exec 的专用校验通路，绕过去就能把渠道指向任意 ref。
 * 这里反过来：**只有白名单里的路径能读写**，其余一律 400 并说明原因。
 *
 * 分工（README 门禁表同步写明）：只读看板的配置视图是**本端点的 GET**（read 令牌可用），
 * 而不是 RPC localgw_config_get（已移出 READ 档）。
 */
function registerFrameworkConfigRoutes(app) {
  app.get("/api/config/framework", handle((req, res) => {
    const c = config.loadConfig();
    const configView = {};
    for (const p of FRAMEWORK_WHITELIST.keys()) {
      const v = getPath(c, p);
      if (v !== undefined) setPath(configView, p, v);
    }
    res.json({ ok: true, config: configView, writable: [...FRAMEWORK_WHITELIST.keys()], pluginsFeed: feedInfo() });
  }));

  app.put("/api/config/framework", handle((req, res) => {
    if (!requireFull(req, res)) return;
    const incoming = (req.body || {}).config ?? req.body ?? {};
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      res.status(400).json({ ok: false, message: "body 需要是对象（或 { config: {...} }）" });
      return;
    }
    // 把传入对象摊平成点路径，逐条按白名单裁决；**未列出的路径一律拒**（不是忽略）
    const flat = [];
    const walkPaths = (node, trail) => {
      if (node && typeof node === "object" && !Array.isArray(node)) {
        for (const [k, v] of Object.entries(node)) walkPaths(v, trail ? `${trail}.${k}` : k);
        return;
      }
      flat.push([trail, node]);
    };
    walkPaths(incoming, "");
    if (!flat.length) { res.status(400).json({ ok: false, message: "没有收到任何要修改的项" }); return; }

    const rejected = [];
    const accepted = [];
    for (const [p, value] of flat) {
      const rule = FRAMEWORK_WHITELIST.get(p);
      if (!rule) {
        // 明确告知被拒，而不是静默丢掉：静默丢弃就是本轮一直在消灭的"改了不生效"
        rejected.push({ path: p, reason: "不在容器可写白名单内（绝对路径 / 口令 / update.* / 渠道绑定等一律不放开）" });
        continue;
      }
      const v = validateFrameworkValue(rule, value);
      if (!v.ok) { rejected.push({ path: p, reason: v.message }); continue; }
      accepted.push({ path: p, value: v.coerced !== undefined ? v.coerced : value });
    }
    if (rejected.length) {
      // 全有或全无：一半生效一半被拒会让用户对着混合状态猜哪条写进去了
      res.status(400).json({ ok: false, message: `已拒绝，未写入任何一项（避免半更新状态）`, rejected, acceptedPaths: accepted.map((a) => a.path) });
      return;
    }
    const cfg = config.loadConfig();
    if (!cfg || typeof cfg !== "object") { res.status(500).json({ ok: false, message: "读不到现有配置，已放弃写入以免覆盖其它模块" }); return; }
    const before = {};
    for (const a of accepted) before[a.path] = getPath(cfg, a.path);
    for (const a of accepted) setPath(cfg, a.path, a.value);
    try {
      config.saveConfig(cfg);
    } catch (e) {
      res.status(500).json({ ok: false, message: `配置写入失败：${String((e && e.message) || e)}` });
      return;
    }
    oplog.log("info", "config-framework", `界面修改容器可写配置 ${accepted.length} 项`, {
      target: accepted.map((a) => a.path).join(","),
      detail: accepted.map((a) => `${a.path}=${JSON.stringify(before[a.path])}→${JSON.stringify(a.value)}`).join("; ").slice(0, 500),
    });
    res.json({ ok: true, changed: accepted.map((a) => a.path) });
  }));
}

function registerConfigRoutes(app) {
  // C1 收口（task-8 审计表 + Lead 11-12 定案）：这份配置里有 localgw.security.secret
  // （API Key 的 HMAC 签名密钥，落盘是 enc:v2 信封）与全部模型覆盖配置。
  // 原先只判"有没有令牌"，于是**只读令牌**（定位＝看板/监视）能把密钥信封整份拖走；
  // 拿到 SECRET_KEY 即可解，拿不到也可离线爆破。只读视图的真正入口是
  // RPC localgw_config_get（下面出口处会剥掉 security 段），不是这里。
  app.get("/api/config", handle((req, res) => {
    if (!requireFull(req, res)) return;
    const c = config.loadConfig();
    res.json({ ok: true, config: { proxy: JSON.parse(JSON.stringify(c.proxy || {})), localgw: JSON.parse(JSON.stringify(c.localgw || {})) } });
  }));
  app.get("/api/config/webdav", handle((req, res) => {
    res.json({ ok: true, webdav: config.maskedSharedWebdav() });
  }));
  // 写统一 WebDAV/S3 配置：与桌面版设置页同一条落盘路径（掩码密码 = 保留原值）
  //
  // 除落盘外还要补两个副作用，二者都是**照抄桌面 ipc.cjs:250-267**，缺任何一个都会造成
  // "只有容器版才出问题"的形态不一致 bug（task-8 审计期间的发现 F1，Lead 批准并入本任务）：
  //  ① `onSharedPasswordMaybeChanged()`：WebDAV 密码同时是号池压缩包的加密口令。
  //     不通知它，改过口令后 poolsync 仍按旧 key 认知历史包 → 表现是"同步解不开/静默失败"，
  //     且只在容器界面上改过口令才出现，桌面版没这问题，极难排查。
  //  ② 首次配置（before 为空、after 有值）自动跑一次同步，让用户配完就拿到号，不用自己
  //     发现"立即同步"。**已配置过再改字段不触发**（否则每次微调都发一轮全量同步），
  //     proxy 板块停用时也不触发（与桌面同口径；手动同步走 proxy_poolsync_run / 界面按钮）。
  app.put("/api/config/webdav", handle((req, res) => {
    if (!requireFull(req, res)) return;
    let before = "";
    try { before = String(config.loadSharedWebdav().endpoint || ""); } catch { /* 读不到按未配置 */ }
    const r = config.saveSharedWebdav(req.body || {});
    if (!r.ok) { res.status(400).json(r); return; }
    let after = "";
    try { after = String(config.loadSharedWebdav().endpoint || ""); } catch { /* 同上 */ }
    try {
      poolsync.onSharedPasswordMaybeChanged();
    } catch (e) {
      // 标记失败不能吞：它意味着"下次同步可能仍按旧口令解包"，运维需要在日志里看到
      console.error("[AgentHub Gateway] 通知 poolsync 口令可能变更失败：", String((e && e.message) || e));
      oplog.log("warn", "webdav-save", "口令变更未通知到 poolsync，历史号池包可能按旧口令解包失败", { detail: String((e && e.message) || e) });
    }
    let proxyOn = true;
    try {
      const pm = (config.loadConfig().modules || {}).proxy || {};
      proxyOn = pm.enabled !== false;
    } catch { /* 读不到板块配置时保守按启用 */ }
    const firstTime = !before && !!after && r.ok;
    if (firstTime && proxyOn) {
      // **触发时就落一条 oplog**，不等同步跑完：一是运维要立刻看得见"已排定一次自动同步"，
      // 二是同步是异步的，把记录只放在 then/catch 里会让"刚保存就查日志"看不到任何东西
      // （冒烟里这条断言就是这么被我写出竞态失败的）。
      oplog.log("info", "webdav-save", "首次配置共享存储，已排定一次号池同步", { target: after });
      // 异步发出，不阻塞保存响应；结果再补一条（失败只记日志，状态面板看得见，定时同步下轮也会补）
      Promise.resolve().then(() => poolsync.run({}))
        .then(() => oplog.log("info", "webdav-save", "首次配置后的自动同步已完成", { target: after }))
        .catch((e) => oplog.log("warn", "webdav-save", "首次配置后的自动同步未成功（可手动触发 proxy_poolsync_run）",
          { target: after, detail: String((e && e.message) || e) }));
    } else if (firstTime && !proxyOn) {
      oplog.log("info", "webdav-save", "首次配置共享存储，但号池管家板块已停用，未自动同步", { target: after });
    }
    res.json({ ok: true, webdav: config.maskedSharedWebdav(), autoSyncTriggered: firstTime && proxyOn });
  }));
  // 备份：VACUUM INTO 一致性快照（WAL 下直接拷 stats.db 会丢最近事务）
  // C3 收口（task-8 审计表）：stats.db 是**整库**——accounts 表（全部凭据密文）+
  // localgw_logs（每次转发的模型/token/Key 前缀）+ oplog 全量。"只读令牌 = 只能看" 的
  // 直觉在这里不成立：读一次就带走所有秘密材料，与 C1 同类而量级更大。
  // 代价（有意接受）：只读看板/CI 不能再拉备份，备份属运维动作，用 full 令牌或运维脚本。
  app.get("/api/backup", handle((req, res) => {
    if (!requireFull(req, res)) return;
    const target = path.join(os.tmpdir(), `agenthub-stats-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.db`);
    try {
      store.vacuumInto(target);
      res.download(target, "stats.db", () => { try { fs.unlinkSync(target); } catch { /* 已清 */ } });
    } catch (e) {
      try { fs.unlinkSync(target); } catch { /* 不存在 */ }
      throw e; // 交给 handle 收敛为 500
    }
  }));
}

/** read 档必须看不见的字段（仅在 `security` 段内按**字段名**剥，不整段丢）。
 *  为什么是这三个：
 *   · `secret`            —— API Key 的 HMAC 签名密钥（localgw/config.cjs:718 ensureSecret 生成，
 *                            keys-store.cjs 用它算 key_hash）。拿到 SECRET_KEY 即可解，拿不到也能离线爆破。
 *   · `adminToken`        —— 本地网关的管理令牌。今天全库无写入点（只有 server.cjs:74 读它）所以恒空，
 *                            但一旦"桌面管理远程实例"那条能力复活就会写进真值 → 届时只读令牌读到的是
 *                            **管理令牌明文**，直接越权成 full。所以现在就得藏，不能等出事。
 *   · `readonlyToken`     —— 同上，只读令牌本身也不该能从只读档被读出来。
 * ⚠️ 新增敏感字段必须登记到这里；同时记住这只是**第二道门**，
 *    完整配置对象仍由 `GET /api/config` 的 requireFull 兜着（C1）。
 * ⚠️ 不剥 `encryptKeysAtRest`：它是 localgw/config.cjs:499 明写"不允许被关"的**公开布尔**，
 *    前端要用它显示"API Key 加密态"。整段丢 security 会把它一起吞掉（审查 R 的缺陷来源，
 *    也违背板块3「该拒绝的是字段，不是整段」的原则）。 */
const READ_HIDDEN_KEYS = new Set(["secret", "adminToken", "readonlyToken"]);
/** 只有出现在这个段名下的同名键才被剥（避免误伤业务里别的 `secret`/`token` 字段） */
const READ_HIDDEN_SECTIONS = new Set(["security"]);

/** 只读令牌响应的**第二道门**（task-8 审计表 C2 / Lead 11-12 定案：主门是把
 *  `localgw_config_get` 移出 READ，这里是纵深防御，**不是替代 REST 收口**）。
 *  做法：遇到 `security` 这类敏感段时**只删名单里的字段、其余原样保留**，
 *  并且继续向下递归（段里再嵌段也能剥到）。 */
function redactForReadScope(payload, depth = 0) {
  if (!payload || typeof payload !== "object" || depth > 6) return payload;
  if (Array.isArray(payload)) return payload.map((v) => redactForReadScope(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (READ_HIDDEN_SECTIONS.has(k) && v && typeof v === "object" && !Array.isArray(v)) {
      const inner = {};
      for (const [ik, iv] of Object.entries(v)) {
        if (READ_HIDDEN_KEYS.has(ik)) continue; // 只丢这三个键
        inner[ik] = redactForReadScope(iv, depth + 1);
      }
      out[k] = inner;
      continue;
    }
    out[k] = redactForReadScope(v, depth + 1);
  }
  return out;
}

// 远程管理的统一命令通道：命令表经收集器取自桌面注册表（proxy 66 条 + localgw 43 条），
// Web UI 与桌面远程模式共用同一契约。前端拿到的信封与桌面 IPC 完全一致
// （{ok:true,...} / {ok:false,message}），错误处理零新增
function registerRpcRoutes(app) {
  app.get("/api/capabilities", (req, res) => {
    res.json({
      ok: true,
      platform: platform.form(),
      version: platform.version(),
      modules: ["proxy", "localgw", "prompts", "memory"],
      features: { serviceControl: false, sse: true, fileDialog: false },
      // 这个实例到底有没有启用令牌（§5.3.2）。**免鉴权下发**是刻意的：登录页要在拿到令牌
      // 之前就知道该不该演"验证密码"。今天两个令牌都没设时，adminAuth 会把请求当作 full
      // 放行（靠 bind 降级兜底，是 D2 的既定语义），于是 `/api/status` 对**任何非空字符串**
      // 都返回 200 —— 登录页据此显示"登录成功"，用户以为有认证、其实没有。
      // 本字段就是把这件事变成一个可如实呈现的事实。判定表达式与 /api/status 同一份
      // （都取 HAS_ADMIN_TOKEN），冒烟有断言要求两处逐字一致。
      authRequired: HAS_ADMIN_TOKEN,
      // 实时通道清单与 /api/status 同源（前端在登录前就要知道哪些面板只能轮询，
      // 好把「非实时」标出来而不是给一个永远不动的进度条）
      realtime: {
        proxy: true,
        localgw: true,
        pluginUpdate: !!pluginUpdater,
        memory: false,   // 见 /api/status 处的说明：容器形态 memory/prompts 广播链路缺失
        prompts: false,
      },

      // deny 的文案随清单下发（前端不重复维护提示语）
      commands: Object.fromEntries(
        [...commandTable.keys()].map((cmd) => {
          const mode = modeOf(cmd);
          return [cmd, mode === "deny" ? { mode, reason: DENY[cmd] } : { mode }];
        })
      ),
    });
  });
  app.post("/api/rpc/:cmd", handle(async (req, res) => {
    const cmd = String(req.params.cmd || "");
    // 先查 DENY：即便命令未注册（如 pet/window/webdav），也要返回明确文案而不是 404
    if (modeOf(cmd) === "deny") {
      res.status(403).json({ ok: false, message: DENY[cmd] });
      return;
    }
    const fn = commandTable && commandTable.get(cmd);
    if (!fn) {
      res.status(404).json({ ok: false, message: `未知命令 ${cmd}（先看 /api/capabilities）` });
      return;
    }
    if (req.adminScope === "read" && modeOf(cmd) !== "read") {
      res.status(403).json({ ok: false, message: "只读令牌只能执行监视类命令（需要完整管理 token）" });
      return;
    }
    // 桌面 handler 统一形如 (event, args)，且全部不使用 event（实测 0 处），传 null 即可
    const r = await fn(null, req.body.args || {});
    // 门控失败（如 prompts_save 空条目）返回 {ok:false} 但 HTTP 状态仍是 200，前端按 ok 字段判定
    // read 档过一道第二段剥离（第二道门，主门是门控表里它已不在 READ）
    res.json(req.adminScope === "read" ? redactForReadScope(r) : r);
  }));

  // 兼容旧前端：POST /api/rpc 且 body.cmd（Web 托管形态的 web-transport 走这里）
  app.post("/api/rpc", handle(async (req, res) => {
    const cmd = String((req.body || {}).cmd || "");
    if (!cmd) {
      res.status(400).json({ ok: false, message: "缺少 cmd 字段" });
      return;
    }
    if (modeOf(cmd) === "deny") {
      res.status(403).json({ ok: false, message: DENY[cmd] });
      return;
    }
    const fn = commandTable && commandTable.get(cmd);
    if (!fn) {
      res.status(404).json({ ok: false, message: `未知命令 ${cmd}（先看 /api/capabilities）` });
      return;
    }
    if (req.adminScope === "read" && modeOf(cmd) !== "read") {
      res.status(403).json({ ok: false, message: "只读令牌只能执行监视类命令（需要完整管理 token）" });
      return;
    }
    const r = await fn(null, (req.body || {}).args || {});
    res.json(req.adminScope === "read" ? redactForReadScope(r) : r); // 同上：read 档第二道门
  }));
}

// 实时事件流（SSE）：复用 platform 的事件出口，信封与桌面 IPC 的 app:event 同形。
// 前端用 fetch 流订阅（EventSource 带不了自定义头，鉴权要靠 Bearer）
const sseClients = new Set();

/** 向所有 SSE 订阅者写一条事件（单一出口：localgw 广播、插件更新器 onStatus 都走这里）。
 *  payload 必须自带 event 字段，与桌面 app:event 同形，前端两套形态共用消费逻辑。 */
function sseWrite(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of sseClients) {
    try {
      c.write(line);
    } catch {
      /* 连接已断，close 收尾 */
    }
  }
}

function registerEventRoutes(app) {
  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    const off = platform.onEmit((payload) => {
      try {
        res.write(`data: ${JSON.stringify(payload && payload.event ? payload : { event: "proxy", ...payload })}\n\n`);
      } catch {
        /* 连接已断，close 收尾 */
      }
    });
    const keepAlive = setInterval(() => {
      try {
        res.write(": ka\n\n");
      } catch {
        /* 同上 */
      }
    }, 25000);
    req.on("close", () => {
      clearInterval(keepAlive);
      off();
      sseClients.delete(res);
    });
  });
}

// Web UI 静态托管：与 API 同源（前端 CSP connect-src 'self' 只允许同源请求）。
// 未内置 UI 时明确跳过——只有 API 的镜像照样能用
function registerUiRoutes(app) {
  const indexFile = path.join(UI_DIR, "index.html");
  if (!fs.existsSync(indexFile)) {
    console.log(`[AgentHub Gateway] 未内置 Web UI（${UI_DIR}/index.html 不存在），仅提供管理 API`);
    return;
  }
  app.use(express.static(UI_DIR, { index: false }));
  // SPA 入口兜底：非 /api 前缀一律回 index.html（前端无路由库，保住未来加路由不被 404）
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(indexFile));
  console.log(`[AgentHub Gateway] Web UI 已挂载：${UI_DIR}`);
}

/**
 * 外置插件（容器形态的能力边界 · 专项 §四 S1/S3/S4、§六 4B）。
 *
 * ── 为什么单独一组路由 ────────────────────────────────────────
 * 桌面版的 plugin_* 注册在 electron/backend/ipc.cjs（依赖 BrowserWindow / dialog），
 * 而 collectCommands() 只收 proxy / localgw / prompts / memory 四个模块 —— 所以
 * /api/rpc/plugin_list 这类调用会 404。容器里插件的全部进出都走这组专用 REST。
 *
 * ── 与桌面不同的一条安全语义（S1）──────────────────────────────
 * plugin-host.cjs:708-724 的全新安装 = 自动授予 required 权限 + **全部声明渠道** + 自动启用 +
 * 自动拉起子进程。桌面这样是"装完即用"；容器里 full token 泄漏一次，攻击者上传一个**合法签名**
 * 的包就能让 32 个渠道的流量与 scoped 凭据进一个自动运行的子进程。
 * 所以容器在**入口层**做"安装后收敛"（不改 plugin-host，桌面零变化）：立即停用 + 收回授权，
 * 返回 requiresAuthorization=true 让界面弹确认。设 AGENTHUB_PLUGIN_TRUST_ON_INSTALL=1 可跳过。
 */

/** 插件包上限：与 plugin-host.cjs:35 的 MAX_ZIP_BYTES 同口径（两处漂移会导致
 *  "gateway 收下了但 plugin-host 拒收"的错位，改一边必须改另一边）。 */
const MAX_PLUGIN_ZIP_BYTES = 200 * 1024 * 1024;

/** 把请求体**流式**落盘成临时 zip。
 *  为什么不用 express.json / express.raw：全局 body 限 4mb（约束④），而放宽到 200mb 会把
 *  整个包读进内存 —— 容器 cgroup 才 512M（compose 现值），一次上传就能把自己 OOM 掉。
 *  流式写盘 + 边写边数字节，超上限立刻断开，内存占用与包大小无关。 */
function streamUploadToFile(req) {
  return new Promise((resolve, reject) => {
    const dir = path.join(os.tmpdir(), "agenthub-plugin-uploads");
    const file = path.join(dir, `install-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.zip`);
    let out = null;
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { req.unpipe(out); } catch { /* 已断 */ }
      req.pause();
      try { out && out.destroy(); } catch { /* 已毁 */ }
      fs.unlink(file, () => { /* 落不了就留给下次启动清 */ });
      reject(err);
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      resolve({ file, size });
    };
    try {
      // 0o700：只有跑容器的 node 用户能进这个目录（里面是待验签的第三方包）
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // 上一次崩溃/断连留下的孤儿包，超过一小时清掉（与 plugin-updater.cjs:186 同一策略）
      try {
        const cutoff = Date.now() - 60 * 60 * 1000;
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* 下次再清 */ }
        }
      } catch { /* 清不动不影响本次上传 */ }
      out = fs.createWriteStream(file, { mode: 0o600 });
    } catch (e) {
      return fail(new Error(`插件包临时落盘失败：${String((e && e.message) || e)}`));
    }
    out.on("error", (e) => fail(new Error(`插件包写入失败：${String((e && e.message) || e)}`)));
    req.on("error", (e) => fail(e));
    req.on("aborted", () => fail(new Error("上传中断（客户端提前断开）")));
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_PLUGIN_ZIP_BYTES) {
        fail(new Error(`插件包超过上限 ${Math.floor(MAX_PLUGIN_ZIP_BYTES / 1024 / 1024)}MB（已收 ${Math.ceil(size / 1024 / 1024)}MB）`));
      }
    });
    out.on("close", () => (size ? ok() : fail(new Error("插件包为空（没有收到任何字节）"))));
    req.pipe(out);
  });
}

/** S1 容器收敛：**一处实现、两处调用**（专项 §四 S1 + Lead 裁决）——
 *  ① REST 上传安装成功后 await 调用；② 作为 onInstalled 传给 pluginUpdater.init（feed 自动更新）。
 *  做成一份是为了避免"上传路径收敛了、feed 路径漏了"这种最要命的不对称。
 *  只处理"新装且被自动授予"的形态：更新（result.updated=true）保留用户原有启停与授权；
 *  失败/回滚分支（plugin-host.cjs:739、:759）压根没装成，无东西可收（已按该函数全部
 *  return 分支逐条核对：:677 忙、:687 超大、:689 schema、:695/:696 manifest 坏、
 *  :702/:703 跨发布者/数据版本、:739 新版启动失败已回滚、:759 恢复未完成 —— 都是 ok:false）。
 *  本函数**自己不抛**（onInstalled 是 fire-and-forget，抛出去会变成 unhandledRejection），
 *  失败一律折进返回值的 revokeError，由调用方显示或记日志。
 *  @returns {Promise<{converged:boolean, trustOnInstall:boolean, revokedAuto?:object, revokeError?:string, note?:string}>} */
async function revokeAutoGrantOnInstall(result) {
  const base = { converged: false, trustOnInstall: PLUGIN_TRUST_ON_INSTALL };
  const finish = (patch) => {
    const out = { ...base, ...patch };
    if (out.revokeError) {
      // 没收成功 = 插件正带着全部声明渠道与 scoped 凭据在跑，这是安全事件，必须显眼
      console.error(`[AgentHub Gateway] ⚠️ 插件 ${result?.id} 的安装后收敛未完成：${out.revokeError}`);
      try { oplog.log("error", "plugin-install-converge", `容器安装收敛失败（插件可能已自动运行）：${result?.id || ""}`, { target: String(result?.id || ""), detail: out.revokeError }); } catch { /* 日志失败不再套一层失败 */ }
    }
    return out;
  };
  try {
    if (PLUGIN_TRUST_ON_INSTALL) return finish({});                 // 显式信任：保留桌面式装完即用
    if (!result || result.ok !== true || !result.id) return finish({});
    if (result.updated) return finish({});                          // 更新：用户原本的选择不动
    if (!result.autoGranted && !result.autoEnabled) return finish({}); // 本来就没自动授予
    // 先停（toggle(false) 会关掉 enabled，重启后也不会自己爬起来）—— plugin-host.cjs:612-626
    const t = await pluginHost.toggle(result.id, false);
    if (t && t.ok === false) return finish({ revokeError: `停用失败：${t.message || ""}` });
    const item = pluginHost.list().find((p) => p.id === result.id) || null;
    const revoked = {
      permissions: item && Array.isArray(item.requiredPermissions) ? [...item.requiredPermissions] : [],
      channels: item && Array.isArray(item.channels) ? [...item.channels] : [],
    };
    // 只有 v2 有授权面可收；v1 没有 permissions/channels（authorize 会直接拒），停掉即可
    if (!item || item.schema !== 2) {
      return finish({ converged: true, revokedAuto: revoked, note: item ? `schema=${item.schema} 无授权面可收，已停用` : "安装后未在产品列表里找到该插件，已停用" });
    }
    const a = await pluginHost.authorize(result.id, { permissions: [], channels: [] });
    if (a && a.ok === false) return finish({ revokedAuto: revoked, revokeError: `收回授权失败：${a.message || ""}` });
    return finish({ converged: true, revokedAuto: revoked });
  } catch (e) {
    return finish({ revokeError: String((e && e.message) || e) });
  }
}

/** 从 list() 里取该插件的签名声明，供安装响应告诉前端"要确认的到底是什么" */
function declaredOf(id) {
  try {
    const item = pluginHost.list().find((p) => p.id === id);
    if (!item) return { declaredPermissions: [], declaredChannels: [] };
    return {
      declaredPermissions: Array.isArray(item.requiredPermissions) ? item.requiredPermissions : [],
      declaredChannels: Array.isArray(item.channels) ? item.channels : [],
    };
  } catch {
    return { declaredPermissions: [], declaredChannels: [] };
  }
}

/** 更新器状态（缺失时如实报 loaded:false + 原因，而不是让端点 500 或假装 idle）。
 *  用 loaded 而不是 available 命名"更新器本身可用吗"——因为 status.available 是
 *  「可更新条目数组」，两个 available 撞名会让 4D 把布尔当列表读（专项 §四 S4 的字段表里
 *  available 只有一个意思）。 */
function updaterStatusOrError() {
  if (!pluginUpdater) {
    return { loaded: false, reason: pluginUpdaterLoadError || "插件更新器未加载", status: null };
  }
  try {
    return { loaded: true, reason: "", status: pluginUpdater.getStatus() };
  } catch (e) {
    return { loaded: false, reason: String((e && e.message) || e), status: null };
  }
}

/** 部署期换源的环境变量（4C/4E 已落在 plugin-updater.cjs:33）。优先级 env → config → 内置默认。
 *  gateway 侧要独立判它，否则会出现「界面改了 feed、显示成功、实际没生效」——
 *  正是本轮整顿"设置静默失败"要消灭的模式（专项 §四 S4 + Lead 11-12 追加要求）。 */
const PLUGIN_FEED_ENV = "AGENTHUB_PLUGIN_FEED";

/** 与 plugin-updater.cjs:58-62 的 normalizeFeedUrl **同一口径**：只认 https，畸形/明文一律视为没配。
 *  必须一致，否则 gateway 判出的"生效源"与更新器实际用的地址会分叉。 */
function normalizeFeedUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try { return new URL(text).protocol === "https:" ? text : ""; } catch { return ""; }
}

/** 当前生效的 feed 与"是谁在生效"。口径**唯一产出处**是 plugin-updater 的 getFeedSource()
 *  （4C 定案 / Lead 11-12 契约：字段名 feedSource / lockedByEnv，同步返回普通对象）。
 *  这里**不重复判 env** —— 两处算同一个事实必然分叉（尤其 env 的 https 过滤规则）。
 *  更新器没能加载时（见上面的容错 require）如实报 feedSource="unavailable"，不猜。 */
function feedInfo() {
  let cfg = null;
  try { cfg = config.loadConfig(); } catch { /* 读不到就按空 */ }
  const p = cfg && cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {};
  const configFeed = typeof p.feedUrl === "string" ? p.feedUrl.trim() : "";
  const envFeed = String(process.env[PLUGIN_FEED_ENV] || "").trim();
  const defaultFeed = (pluginUpdater && pluginUpdater.DEFAULT_FEED) || "";
  if (pluginUpdater && typeof pluginUpdater.getFeedSource === "function") {
    try {
      const picked = pluginUpdater.getFeedSource();
      return {
        feedUrl: picked.feedUrl,
        feedSource: picked.feedSource,
        lockedByEnv: !!picked.lockedByEnv,
        envFeed, configFeed, defaultFeed,
        // 当前在用的源是不是 https。config 层 4C 不过滤（桌面明文内网源是既有能力，不打死），
        // 所以这里只**照出事实**给界面提示；写入口（PUT）才强制 https
        httpsOk: !!picked.feedUrl && !!normalizeFeedUrl(picked.feedUrl),
      };
    } catch (e) {
      return { feedUrl: configFeed || defaultFeed, feedSource: "unavailable", lockedByEnv: false,
        envFeed, configFeed, defaultFeed, httpsOk: false, note: String((e && e.message) || e) };
    }
  }
  return { feedUrl: configFeed || defaultFeed, feedSource: "unavailable", lockedByEnv: false,
    envFeed, configFeed, defaultFeed, httpsOk: false,
    note: pluginUpdaterLoadError || "插件更新器未加载，feed 生效值无法判定" };
}
function pluginUpdaterDefaultFeed() {
  return (pluginUpdater && pluginUpdater.DEFAULT_FEED) || "";
}

function registerPluginRoutes(app) {
  app.get("/api/plugins", handle((_req, res) => {
    try {
      // poolSync：与桌面 ipc.cjs:614 同一拼法（v1 桥状态）；updateStatus：桌面是另一个
      // IPC（plugin_update_status），容器一次给全，前端不必拼三个请求（专项 §四 S4）
      const plugins = pluginHost.list().map((p) => ({
        ...p,
        poolSync: pluginBridge ? pluginBridge.status(p.id) : null,
      }));
      const feed = feedInfo();
      res.json({
        ok: true,
        plugins,
        poolSyncAvailable: !!pluginBridge,
        updateStatus: updaterStatusOrError(),
        feed: feed.feedUrl,
        feedSource: feed.feedSource,
        feedLockedByEnv: feed.lockedByEnv,
        // 让界面知道"装完是否要人确认"，否则用户会奇怪为什么装完显示"需授权"
        trustOnInstall: PLUGIN_TRUST_ON_INSTALL,
      });
    } catch (e) {
      res.json({ ok: false, plugins: [], message: String((e && e.message) || e) });
    }
  }));

  /** 真安装（专项 §六 4B④：去掉恒 501）。body = zip 原始字节（--data-binary / fetch(File)）。
   *  装完立刻走 S1 收敛：默认停用 + 收回自动授予，等用户在界面确认授权。 */
  app.post("/api/plugins/install", handle(async (req, res) => {
    if (!requireFull(req, res)) return;
    const ct = String(req.headers["content-type"] || "");
    if (ct.includes("application/json")) {
      // 全局 body 限 4mb（约束④），base64 再涨 1/3 —— 明确说该怎么发，而不是回一个难懂的 413
      res.status(415).json({
        ok: false,
        message: "插件包请用**原始 zip 字节**上传（content-type: application/zip，例如 "
          + "`curl --data-binary @plugin.zip` 或前端 fetch(File)）；base64 塞 JSON 会撞 4mb body 上限",
      });
      return;
    }
    let uploaded = null;
    try {
      uploaded = await streamUploadToFile(req);
      const result = await pluginHost.install(uploaded.file);
      if (!result || result.ok !== true) {
        oplog.log("warn", "plugin-install", `容器上传安装失败：${(result && result.message) || "未知原因"}`,
          { target: (result && result.id) || "", detail: `size=${uploaded.size}` });
        res.status(400).json({ ok: false, message: (result && result.message) || "插件安装失败", rollback: !!(result && result.rollback) });
        return;
      }
      const converged = await revokeAutoGrantOnInstall(result);
      const declared = declaredOf(result.id);
      oplog.log("info", "plugin-install",
        converged.converged ? `已安装并收回自动授权，等待人工确认：${result.name} ${result.version}`
          : converged.trustOnInstall ? `已安装（TRUST_ON_INSTALL=1，跳过确认）：${result.name} ${result.version}`
            : `已安装：${result.name} ${result.version}`,
        { target: result.id, detail: `size=${uploaded.size}; autoGranted=${result.autoGranted}; revokedChannels=${(converged.revokedAuto && converged.revokedAuto.channels.length) || 0}` });
      const needsConfirm = converged.converged || !!converged.revokeError
        ? true : !!result.requiresAuthorization;
      res.json({
        ok: true,
        id: result.id,
        name: result.name,
        version: result.version,
        updated: !!result.updated,
        warning: result.warning || "",
        autoGranted: !!result.autoGranted,
        autoEnabled: !!result.autoEnabled,
        autoBound: result.autoBound ?? null,
        ...declared,
        requiresAuthorization: needsConfirm,
        trustOnInstall: converged.trustOnInstall,
        revokedAuto: converged.revokedAuto || null,
        // 收敛没做成 = 插件正带着全部声明渠道在跑，必须让界面看到而不是吞掉
        revokeError: converged.revokeError || "",
        size: uploaded.size,
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      const tooBig = /超过上限/.test(msg);
      res.status(tooBig ? 413 : 400).json({ ok: false, message: tooBig ? msg : `插件安装失败：${msg}` });
    } finally {
      if (uploaded) { try { fs.unlinkSync(uploaded.file); } catch { /* 已清 */ } }
    }
  }));

  app.post("/api/plugins/:id/toggle", handle(async (req, res) => {
    if (!requireFull(req, res)) return;
    const out = await pluginHost.toggle(String(req.params.id || ""), !!req.body?.enabled);
    if (out && out.ok) {
      oplog.log("info", "plugin-toggle", `${out.ok && req.body?.enabled ? "启用" : "停用"}插件 ${req.params.id}`, { target: String(req.params.id) });
    }
    res.json(out);
  }));
  app.post("/api/plugins/:id/uninstall", handle(async (req, res) => {
    if (!requireFull(req, res)) return;
    const out = await pluginHost.uninstall(String(req.params.id || ""));
    if (out && out.ok) oplog.log("info", "plugin-uninstall", `卸载插件 ${req.params.id}`, { target: String(req.params.id) });
    res.json(out);
  }));
  app.post("/api/plugins/:id/authorize", handle(async (req, res) => {
    if (!requireFull(req, res)) return;
    const out = await pluginHost.authorize(String(req.params.id || ""), {
      permissions: req.body?.permissions,
      channels: req.body?.channels,
    });
    if (out && out.ok) {
      oplog.log("info", "plugin-authorize", `授权插件 ${req.params.id}`, {
        target: String(req.params.id),
        detail: `permissions=${(req.body?.permissions || []).join(",")}; channels=${(req.body?.channels || []).join(",")}`,
      });
    }
    res.json(out);
  }));

  // ===== 更新链（专项 §四 S4）=====
  // 三个端点都以"更新器可用"为前提；不可用回 503 + 真实原因，不假装 idle
  const needUpdater = (res) => {
    const u = updaterStatusOrError();
    if (u.loaded) return true;
    res.status(503).json({ ok: false, message: `插件更新器不可用：${u.reason}` });
    return false;
  };

  app.get("/api/plugins/update/status", handle((_req, res) => {
    const u = updaterStatusOrError();
    // 状态是只读监视面，read 令牌就该能看到（含 lastError 原文，便于页面上诚实显示）
    res.status(u.loaded ? 200 : 503).json({ ok: u.loaded, ...u, ...feedInfo() });
  }));

  app.post("/api/plugins/update/check", handle(async (req, res) => {
    if (!requireFull(req, res)) return;
    if (!needUpdater(res)) return;
    try {
      const status = await pluginUpdater.check({ manual: true });
      res.json({ ok: true, status });
    } catch (e) {
      // check({manual:true}) 会把失败抛出来：原文回给界面，别只给"检查失败"（S2 要求看得见 lastError）
      res.status(502).json({ ok: false, message: String((e && e.message) || e), status: pluginUpdater.getStatus() });
    }
  }));

  app.post("/api/plugins/update/apply", handle(async (req, res) => {
    if (!requireFull(req, res)) return;
    if (!needUpdater(res)) return;
    const ids = Array.isArray(req.body?.ids) && req.body.ids.length ? req.body.ids.map(String) : undefined;
    try {
      // 不传 ids = 装全部（桌面同语义）；传了 = 只装点选（4C 交付的 apply({ids})）。
      // 装完的收敛由 onInstalled 钩子走同一个 revokeAutoGrantOnInstall，与上传路径同口径。
      const out = await pluginUpdater.apply(ids ? { ids } : {});
      oplog.log("info", "plugin-update-apply", `容器触发插件更新安装：${ids ? ids.join(",") : "全部可更新条目"}`,
        { detail: `ok=${out && out.ok}; results=${((out && out.results) || []).length}` });
      res.json({ ok: !!(out && out.ok), ...(out || {}) });
    } catch (e) {
      res.status(500).json({ ok: false, message: String((e && e.message) || e) });
    }
  }));

  // ===== feed 换源（专项 §四 S4 / §十 第 7 条：它是"改变容器执行引擎"的入口）=====
  app.get("/api/plugins/feed", handle((_req, res) => {
    res.json({ ok: true, ...feedInfo() });
  }));

  app.put("/api/plugins/feed", handle((req, res) => {
    if (!requireFull(req, res)) return;
    const info = feedInfo();
    // 编排层已经用环境变量定了源 → 这里写 config 会"看似成功、实际不生效"，必须明确拒绝
    if (info.lockedByEnv) {
      oplog.log("warn", "plugin-feed-set", `拒绝改 feed：当前生效源由环境变量固定（${PLUGIN_FEED_ENV}）`, { target: info.feedUrl });
      res.status(409).json({
        ok: false,
        code: "feed-locked-by-env",
        message: `当前插件 feed 由环境变量 ${PLUGIN_FEED_ENV} 固定为 ${info.feedUrl}，界面上的修改不会生效。请改 compose/.env 后重建容器。`,
        ...info,
      });
      return;
    }
    const raw = String((req.body || {}).feedUrl ?? "").trim();
    if (!raw) {
      // 清空 = 回到内置默认源（官方 GitHub Release）。这也算改配置，同样落 oplog
      const cfg = config.loadConfig();
      cfg.plugins = { ...(cfg.plugins || {}), feedUrl: "" };
      config.saveConfig(cfg);
      oplog.log("info", "plugin-feed-set", "插件 feed 已恢复为内置默认源", { target: pluginUpdaterDefaultFeed() });
      res.json({ ok: true, ...feedInfo() });
      return;
    }
    // 强制 https（与 plugin-feed.cjs / plugin-updater.cjs:58 对索引 url 的校验同口径）：容器指向
    // http 源等于让"下载哪个执行引擎"这件事可以在网络上被改写，签名只能保证是官方 key 签的，
    // 挡不住整体降级投毒
    if (!normalizeFeedUrl(raw)) {
      oplog.log("warn", "plugin-feed-set", `拒绝非 https 的插件 feed：${raw.slice(0, 200)}`, { target: raw.slice(0, 200) });
      res.status(400).json({ ok: false, message: "插件 feed 只允许 https:// 地址（与索引内 url 校验同口径）", ...feedInfo() });
      return;
    }
    const cfg = config.loadConfig();
    const before = (cfg.plugins && cfg.plugins.feedUrl) || "";
    cfg.plugins = { ...(cfg.plugins || {}), feedUrl: raw };
    config.saveConfig(cfg);
    oplog.log("info", "plugin-feed-set", "变更插件 feed 源（改变容器执行引擎的入口）",
      { target: raw, detail: `before=${before || "(默认)"}; after=${raw}` });
    res.json({ ok: true, before: before || pluginUpdaterDefaultFeed(), ...feedInfo() });
  }));

}


function startAdmin() {
  const app = express();
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(adminAuth);
  registerProbes(app);
  registerPoolRoutes(app);
  registerPluginRoutes(app);
  registerConfigRoutes(app);
  registerFrameworkConfigRoutes(app);

  registerRpcRoutes(app);
  registerEventRoutes(app);
  registerUiRoutes(app);

  const srv = app.listen(ADMIN_PORT, ADMIN_BIND);
  // 监听失败必须显式收口：否则 unhandled 'error' 直接崩掉整个进程（含在跑的本地网关）
  srv.on("error", (e) => {
    console.error(`[AgentHub Gateway] 管理 API 监听 ${ADMIN_BIND}:${ADMIN_PORT} 失败:`, e.message);
    process.exit(1);
  });
  return srv;
}

// ===== 停机（docker stop / compose down 的 SIGTERM）=====
let stopping = false;
async function shutdown(signal) {
  if (stopping) return; // 幂等闸：重复信号不重入（最终由 docker 的 kill 超时兜底）
  stopping = true;
  console.log(`[AgentHub Gateway] 收到 ${signal}，开始停机…`);
  try { if (adminServer) adminServer.close(); } catch { /* 已关 */ }
  for (const c of sseClients) { try { c.end(); } catch { /* 已断 */ } } // 主动收掉长连接，停机不留悬挂
  // 先停更新器的定时器：否则停机窗口里到点的 tick 还会去拉 feed / 下载包，
  // 把一个没人等的 install 插进正在关闭的 plugin-host（容器优雅停机的常见竞态）
  try { pluginUpdater?.stop(); } catch { /* 未装配或已停 */ }

  const drain = (async () => {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    try { await localgw.shutdown(); } catch { /* 未装配 */ }
    return { drained: true, remainingMs: Math.max(0, deadline - Date.now()) };
  })();
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ drained: false }), DRAIN_TIMEOUT_MS));
  const drained = await Promise.race([drain, timeout]);
  extensionPool.close();
  pluginHost.killAll();
  console.log(`[AgentHub Gateway] 本地网关已停（${drained.drained ? "已排空" : "超时强断"}）`);
  try { proxyIndex.stopTimers(); } catch { /* 未装配 */ }
  try { await poolsync.cancel(); } catch { /* 在途同步收尾 */ }
  try { const p = require(path.join(BACKEND_DIR, "prompts", "index.cjs")); p.shutdown(); } catch { /* 未装配 */ }
  try { const m = require(path.join(BACKEND_DIR, "memory", "index.cjs")); m.shutdown(); } catch { /* 未装配 */ }
  try { store.close(); } catch { /* 句柄随进程退出 */ }
  if (lockFile) { try { fs.unlinkSync(lockFile); } catch { /* 已清 */ } }
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });

main().catch((e) => {
  console.error("[AgentHub Gateway] 启动失败:", (e && e.stack) || e);
  process.exit(1);
});

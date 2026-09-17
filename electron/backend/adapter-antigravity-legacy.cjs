// Antigravity（旧版）老数据恢复适配器（一次性迁移，入官方 LS 解密通道）
//
// 背景：
//   1. 现行 Antigravity（0.1.x 版之后）把会话改写成明文 SQLite（各会话 *.db，gen_metadata
//      逐次生成计数），走同目录 adapter-antigravity.cjs 即可全量采集；
//   2. 但 2026-05~07 月（含 5-20 官方迁移快照 antigravity-backup）的会话文件是整文件
//      加密的 .pb，密钥不在本机，本地暴力破解无解（2 万多种组合实测全灭）；
//   3. 语言服务器 language_server.exe 自己有解密通道——它对会话 .pb 的读取与平台账
//      号/账号态绑死，本地任何地方都得不到解密密钥，但可以让官方进程帮我们解；
//
// 恢复原理（自研独家路径，开源后给其他机器复用）：
//   - 把 `~/.gemini/antigravity-backup/conversations/*.pb`（以及可选的
//     `~/.gemini/antigravity/conversations/*.pb`、implicit 目录）合到临时沙盒
//     `<tmp>/dosage-sync-ag-legacy/.gemini/antigravity`，再用反重力自家的
//     language_server.exe 指向该沙盒启动；
//   - 语言服务器需要 stdin 握手一个合法 protobuf 的 exa.codeium_common_pb.Metadata，
//     最小合法输入是 2 字节 `\x10\x01`（field 2 = varint 1）；否则在读取阶段直接
//     报 "Failed to unmarshal initial Protobuf metadata from stdin" 退出；
//   - 之后通过 HTTP RPC `exa.language_server_pb.LanguageServerService
//     .GetCascadeTrajectoryGeneratorMetadata` 拿到每个 cascadeId 的
//     `chatModel.usage`（inputTokens / outputTokens / thinkingOutputTokens /
//     responseOutputTokens），按行入库；
//   - 语言服务器只在内存里解密，不会改写任何原始 .pb 文件（沙盒文件字节与源完全一致）。
//
// 对学习端开源使用者（非本机）的开箱说明：
//   ① 前提：该机器装过 Antigravity（任一新版），language_server.exe 才能拿到——它不在此
//     仓库分发，需要现场探测；
//   ② 数据：只需把 `~/.gemini/antigravity-backup`（老 5-20 迁移快照）放对位置，无需再
//     预置其他凭据；语言服务器副产物（含一个 `installation_id`）对读取没影响；
//   ③ 平台库写入源头 source_id = "antigravity-legacy"，与现行 .db 采集器共用同一个
//     usage_record；幂等靠 (device_id, source, cascadeId, 调用序号) 同键 INSERT OR REPLACE；
//
// 增量语义（与同步框架锚点联动，解决「每次同步都卡 100 秒」）：
//   - 首次（锚点=0）或指纹变化时才真正跑一次官方 LS 恢复；
//   - 指纹 = 全部老 .pb 的「文件名:大小:mtime」哈希（只用于判断是否要重跑，不参与数据）；
//   - 已有锚点 + 指纹未变 + 上次 0 失败 → 直接返回空（不启 LS、不建沙盒，耗时 <10ms）；
//   - 「重置同步数据」会删 usage_record 和 checkpoint 但保留 meta 完成标记——由于跳过条件是
//     与锚点联动（sinceMs>0 才可能跳），重置后锚点=0 会自然重新全量恢复，数据不丢；
//   - 失败 N 条时不写完成标记，下次同步自动重试。
//
// 降级与幂等：
//   - 语言服务器二进制找不到 / 沙盒无 .pb：返回空记录（跳过不阻断）；
//   - 端口动态探测（127.0.0.1 随机空闲端口），残留 LS 进程按命令行精确清理，杜绝 60s 硬等；
//   - LS 启动即崩时立即放弃（不等满 LS_START_MS）；单个会话 RPC 失败只跳过该会话；
//   - 每轮自扫 `%TEMP%/dosage-sync-ag-legacy*` 目录，避免在 Windows 上越积越多；
//   - 只读源目录 .pb 与 immutable 备份不动（与 adapter-antigravity.cjs 一样复制副本给 LS 用）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { rmTempDir, sweepStale } = require("./temp-util.cjs");

const CONV_DIR_NAME = "conversations";
const LEGACY_SOURCE_ID = "antigravity-legacy";
const LEGACY_SOURCE_NAME = "Antigravity 老数据恢复";
const LS_HTTP_PORT = 56499;        // 难以撞车的高位端口（动态探测失败时的兜底）
const LS_START_MS = 25_000;        // 语言服务器握手最长时间（快速失败，避免 60s 硬等）
const LS_RPC_TIMEOUT_MS = 30_000;
const LS_POLL_MS = 500;
const LEGACY_TMP_PREFIX = "dosage-sync-ag-legacy";
const MAX_SANDBOX_PB = 400;
const META_STATE_KEY = "antigravity-legacy:state"; // { done, fingerprint, lastRunAt }

// 语言服务器二进制探测路径（Windows/Linux/macOS 安装目录 + ~/.gemini 的运行目录覆盖）
const LS_CANDIDATES = [
  "%LOCALAPPDATA%/Programs/Antigravity/resources/bin/language_server.exe",
  "%APPDATA%/Antigravity/resources/bin/language_server.exe",
  path.join(homeDir(), "Applications", "Antigravity.app", "Contents", "Resources", "bin", "language_server"),
  path.join(homeDir(), ".local", "share", "Antigravity", "resources", "bin", "language_server"),
  path.join(homeDir(), ".gemini", "antigravity", "bin", "language_server.exe"),
  path.join(homeDir(), ".gemini", "antigravity", "bin", "language_server"),
];

// 沙盒里要合并的老加密数据目录（源不修改，仅读）
const MIGRATION_SOURCES = [
  // 精确命中 2026-05-20 官方迁移快照（你好，我就在这）
  path.join(homeDir(), ".gemini", "antigravity-backup", "conversations"),
  // 现行版本会话目录（.pb 部分；.db 已由常规适配器吃东西，此处不进沙盒）
  path.join(homeDir(), ".gemini", "antigravity", "conversations"),
  // 用户主线轨迹：这些是加密 .pb，但不能直接按 cascadeId 取（用的是另一种轨迹格式，
  // 本地无法解出 token 记录，实际也不会产生 token；出于穷举考虑也蹦迪沙盒中备用，
  // 不会在提取阶段统计）
];

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

function expandExternal(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  const home = homeDir();
  const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppdata = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const upper = s.toUpperCase();
  if (upper.startsWith("%APPDATA%")) return path.join(appdata, s.slice(9));
  if (upper.startsWith("%LOCALAPPDATA%")) return path.join(localAppdata, s.slice(14));
  return path.isAbsolute(s) ? s : path.join(home, s);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------- 语言服务器探测 ----------

function findLanguageServer() {
  for (const cand of LS_CANDIDATES) {
    const p = expandExternal(cand);
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// ---------- 老数据变化指纹（与锚点联动决定是否跳过一次完整恢复） ----------

function computeFingerprint() {
  const entries = [];
  for (const srcDir of MIGRATION_SOURCES) {
    if (!fs.existsSync(srcDir)) continue;
    let files;
    try { files = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { continue; }
    for (const e of files) {
      if (!e.isFile() || !e.name.endsWith(".pb")) continue;
      try {
        const st = fs.statSync(path.join(srcDir, e.name));
        entries.push(`${e.name}:${st.size}:${Math.floor(st.mtimeMs)}`);
      } catch { /* 跳过读不到属性的文件 */ }
    }
  }
  if (!entries.length) return null;
  entries.sort();
  const hash = crypto.createHash("sha256").update(entries.join("\n")).digest("hex");
  return { hash, fileCount: entries.length, totalBytes: entries.reduce((a, s) => a + Number(s.split(":")[1]), 0) };
}

function readState() {
  try {
    const raw = require("./db.cjs").getMeta(META_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeState(state) {
  try {
    require("./db.cjs").setMeta(META_STATE_KEY, JSON.stringify(state));
  } catch { /* 写失败（无 db 环境）不影响本轮已生成的记录 */ }
}

// ---------- 沙盒 ----------

function buildSandbox() {
  const sandbox = path.join(os.tmpdir(), `${LEGACY_TMP_PREFIX}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const convDir = path.join(sandbox, ".gemini", "antigravity", CONV_DIR_NAME);
  fs.mkdirSync(convDir, { recursive: true });

  let copied = 0;
  const sourceHints = [];
  for (const srcDir of MIGRATION_SOURCES) {
    if (!fs.existsSync(srcDir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(srcDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".pb"));
    } catch { continue; }
    for (const e of entries) {
      if (+copied >= MAX_SANDBOX_PB) break;
      const src = path.join(srcDir, e.name);
      const dst = path.join(convDir, e.name);
      try {
        fs.copyFileSync(src, dst);
        copied++;
      } catch { /* 失败跳过该文件（可能正被占用） */ }
    }
    if (entries.length) sourceHints.push(`${srcDir}（${entries.length} 个 .pb）`);
  }

  return { sandbox, convDir, copied, sourceHints };
}

function cleanupSandbox(dir) {
  if (!dir) return;
  rmTempDir(dir);
}

// ---------- HTTP RPC ----------

function httpPostJson(port, rpcPath, body, timeoutMs = LS_RPC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body || {}), "utf8");
    const req = http.request({
      host: "127.0.0.1", port, path: `/${rpcPath}`, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": payload.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode || 0, text });
      });
    });
    req.on("error", () => resolve({ status: 0, text: "" }));
    req.setTimeout(timeoutMs, () => req.destroy());
    req.end(payload);
  });
}

// 语言服务器心跳探测：返回是否已可处理 RPC
// isDead（可选）：LS 进程端口/生命周期挂了时立即返回，避免白板等 LS_START_MS
async function waitForServer(port, deadlineMs, isDead) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (typeof isDead === "function" && isDead()) return false;
    const r = await httpPostJson(port, "exa.language_server_pb.LanguageServerService/Heartbeat", {}, 3000);
    if (r.status === 200 && r.text) return true;
    await new Promise((r2) => setTimeout(r2, LS_POLL_MS));
  }
  return false;
}

/** 在 127.0.0.1 上临时监听一个随机端口，关闭前记下端口号——比固定端口 LS_HTTP_PORT 更难撞车 */
async function probeFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on("error", () => resolve(LS_HTTP_PORT));
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address() && srv.address().port;
      srv.close(() => resolve(port || LS_HTTP_PORT));
    });
  });
}

// ---------- RPC 抽取 ----------

/**
 * 把「一个会话的 generatorMetadata 数组」摊开为**每次 LLM 调用一条**记录。
 * 粒度与 .db 时代 adapter-antigravity.cjs（gen_metadata 每行一次调用）一致，
 * 幂等键 = deviceId:antigravity-legacy:<cascadeId>:<generatorMetadata 数组下标>，
 * 数组顺序由服务端稳定返回，重复同步只覆盖不重复。
 */
function sanitizeConversation(rec, deviceId, deviceName, nowTs) {
  if (!rec.cascadeId) return [];
  const out = [];
  (rec.generatorMetadata || []).forEach((m, idx) => {
    const u = m.chatModel?.usage;
    if (!u) return;
    const inputTokens = num(u.inputTokens);
    const outputTokens = num(u.outputTokens) + num(u.responseOutputTokens);
    const reasoningTokens = num(u.thinkingOutputTokens);
    let credits = null;
    if (u.credits != null) {
      const c = Number(u.credits);
      if (Number.isFinite(c) && c >= 0) credits = c;
    }
    const created = millisecondsFromUsage(m.chatModel?.chatStartMetadata?.createdAt, nowTs);
    out.push({
      id: `${deviceId}:${LEGACY_SOURCE_ID}:${rec.cascadeId}:${idx}`,
      deviceId,
      deviceName,
      source: LEGACY_SOURCE_ID,
      providerId: "Google",
      modelId: u.model || m.chatModel?.model || "unknown",
      sessionId: rec.cascadeId,
      inputTokens, outputTokens, reasoningTokens,
      cacheCreationTokens: 0, cacheReadTokens: 0,
      credits,
      startedAt: created,
      completedAt: created,
      status: "success",
    });
  });
  return out;
}

function millisecondsFromUsage(iso, fallback) {
  const n = Date.parse(iso || "");
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return fallback;
}

// ---------- 主流程 ----------

/**
 * 老数据恢复（老 .pb → 明文 SQLite）
 * @param dir 数据源目录（detect() 返回的）
 * @param deviceId 本机真实设备 ID（用于幂等键，必传——上传按它过滤日分片）
 * @param deviceName 设备显示名
 * @param sinceMs 增量锚点（由调用方 checkpoint 推进；0 = 首次/全量）
 */
async function extractLegacy(dir, deviceId, deviceName, sinceMs, log) {
  // 1) 先算指纹：老数据根本没变就不用碰 LS（把「每次同步都卡 100 秒」变成「只在数据变化时跑一次」）
  const fp = computeFingerprint();
  if (!fp) {
    log("extract", "info", `${LEGACY_SOURCE_NAME}：没有找到任何 .pb 老数据（备份 / 现行全量未下过），跳过`);
    return [];
  }

  // 2) 已有锚点 + 指纹未变 + 上次成功：直接跳过。
  // 与锚点联动（不是单纯 done=1）是因为「重置同步数据」会删 usage_record 和 checkpoint，
  // 但会保留 meta 里的完成标记；删库后 sinceMs 回到 0，自然重新跑一遍官方恢复，数据不会丢。
  if (sinceMs > 0) {
    const state = readState();
    if (state && state.done && state.fingerprint === fp.hash) {
      log("extract", "info", `${LEGACY_SOURCE_NAME}：老数据已恢复且无变化（${fp.fileCount} 个 .pb），跳过`);
      return [];
    }
  }

  // 3) 真正要跑：先杀残留 LS（避免上轮异常退出占着端口），再挑一个动态端口
  sweepLegacyLs();
  sweepStale(LEGACY_TMP_PREFIX);

  const lsPath = findLanguageServer();
  if (!lsPath) {
    log("extract", "warn", `${LEGACY_SOURCE_NAME}：未找到 language_server.exe（未安装 Antigravity？），跳过`);
    return [];
  }

  const { sandbox, convDir, copied, sourceHints } = buildSandbox();
  if (!copied) {
    log("extract", "info", `${LEGACY_SOURCE_NAME}：沙盒没有可恢复的 .pb，跳过`);
    cleanupSandbox(sandbox);
    return [];
  }
  log("extract", "info", `${LEGACY_SOURCE_NAME}：沙盒准备就绪，共 ${copied} 个 .pb（${sourceHints.join("；")}）`);

  const lsPort = await probeFreePort();
  let lsProc = null;
  let lsDead = false;
  try {
    lsProc = spawn(lsPath, [
      `-gemini_dir=${path.join(sandbox, ".gemini")}`,
      `-app_data_dir=antigravity`,
      "-disable_telemetry",
      `-http_server_port=${lsPort}`,
      `-https_server_port=${lsPort + 1}`,
    ], { stdio: ["pipe", "ignore", "ignore"] });
    lsProc.on("exit", () => { lsDead = true; });
    lsProc.on("error", () => { lsDead = true; });

    // 写入 stdin 握手
    lsProc.stdin.write(Buffer.from([0x10, 0x01]), () => { try { lsProc.stdin.end(); } catch { /* ignore */ } });
    // 死进程快速失败：LS 启动即崩（被杀软拦截/端口被占）时立刻放弃，不等满 LS_START_MS
    const ok = await waitForServer(lsPort, LS_START_MS, () => lsDead);
    if (!ok) {
      log("extract", "error",
        lsDead
          ? `${LEGACY_SOURCE_NAME}：language_server 启动后立即退出（被杀软拦截？），请重试或加白名单`
          : `${LEGACY_SOURCE_NAME}：language_server 启动超过 ${LS_START_MS / 1000}s 未就绪（被 360/防病毒拦截？），请重试`);
      throw new Error("language_server 未就绪");
    }

    // 读取沙盒中的全部 .pb 会话 id
    const ids = fs.readdirSync(convDir)
      .filter((f) => f.endsWith(".pb"))
      .map((f) => f.replace(/\.pb$/, ""));

    let totalMeta = 0, totalUnread = 0, totalCalls = 0;
    const allRecords = [];
    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      const chunkResults = await Promise.all(chunk.map((id) => (async () => {
        const r = await httpPostJson(lsPort, "exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata", { cascadeId: id });
        if (r.status !== 200) return { cascadeId: id, unreadable: true, err: r.text.slice(0, 120) };
        let parsed;
        try { parsed = JSON.parse(r.text); } catch { return { cascadeId: id, unreadable: true, err: "bad json" }; }
        const steps = parsed?.generatorMetadata && Array.isArray(parsed.generatorMetadata) ? parsed.generatorMetadata.length : 0;
        return { cascadeId: id, generatorMetadata: parsed.generatorMetadata || [], steps };
      })()));
      for (const cr of chunkResults) {
        if (cr.unreadable) { totalUnread++; continue; }
        totalMeta++;
        totalCalls += cr.steps;
        allRecords.push(...sanitizeConversation(cr, deviceId, deviceName, Date.now()));
      }
    }
    log("extract", "info", `${LEGACY_SOURCE_NAME}：读取完成 ${totalMeta} 个会话（不可用 ${totalUnread}，总调用 ${totalCalls}），生成 ${allRecords.length} 条用量记录`);

    // 只有 0 失败才写完成标记；否则下次同步会再跑一遍（残留/被杀软杀的那部分）
    if (totalUnread === 0) {
      writeState({ done: true, fingerprint: fp.hash, lastRunAt: Date.now() });
    } else {
      log("extract", "warn", `${LEGACY_SOURCE_NAME}：${totalUnread} 个会话未读出（implicit 轨迹 / 杀软拦截），下次同步会重试`);
    }
    return allRecords;
  } catch (e) {
    log("extract", "error", `${LEGACY_SOURCE_NAME}：恢复失败`, String(e && (e.stack || e.message || e)));
    return [];
  } finally {
    if (lsProc && !lsProc.killed) {
      try { lsProc.kill(); } catch { /* ignore */ }
      lsProc = null;
    }
    cleanupSandbox(sandbox);
  }
}

/**
 * 清杀历史残留 language_server 进程：
 * 命令行含 -gemini_dir 且 gemini_dir 指向本适配器沙盒（dosage-sync-ag-legacy-*）。
 * 上轮同步被强制退出/杀软杀父进程时，LS 会变成孤儿占着端口；
 * 这里用 PowerShell 临时脚本精确找出并终结，失败静默（与 temp-util 三原则一致）。
 * 不靠引号嵌套纯字符串拼接——那很容易写出运行不了的一行。
 */
function sweepLegacyLs() {
  const tmpScript = path.join(os.tmpdir(), `${LEGACY_TMP_PREFIX}-sweep-${process.pid}.ps1`);
  try {
    const { execSync } = require("node:child_process");
    const script = [
      `$prefix = '${LEGACY_TMP_PREFIX}'`,
      `Get-CimInstance Win32_Process -Filter "Name='language_server.exe'" -ErrorAction SilentlyContinue |`,
      `  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($prefix) } |`,
      `  ForEach-Object { Write-Output $_.ProcessId }`,
    ].join("\n");
    fs.writeFileSync(tmpScript, script, "utf8");
    const out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"`,
      { maxBuffer: 2 * 1024 * 1024, timeout: 15000, stdio: ["ignore", "pipe", "ignore"] },
    ).toString("utf8");
    for (const line of out.split(/\r?\n/)) {
      const pid = parseInt(line.trim(), 10);
      if (!pid || pid === process.pid) continue;
      try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
    }
  } catch { /* ignore */ } finally {
    try { fs.rmSync(tmpScript, { force: true }); } catch { /* ignore */ }
  }
}

// ---------- 适配器工厂 ----------

function makeLog() {
  return (kind, level, message, detail) => {
    try {
      require("./db.cjs").addLog(kind, level, message, detail);
    } catch { /* 自测环境无 db，忽略 */ }
  };
}

function makeLegacyAdapter() {
  function getDeviceId() {
    const base = path.join(homeDir(), ".gemini", "antigravity");
    try {
      const text = fs.readFileSync(path.join(base, "antigravity_state.pbtxt"), "utf8");
      const m = text.match(/installation_uuid:\s*"?([-0-9a-fA-F]{8,})"?/);
      if (m && m[1]) return m[1];
    } catch { /* 文件不存在或读不出 uuid，走默认 id */ }
    return "local";
  }

  return {
    id: LEGACY_SOURCE_ID,
    name: LEGACY_SOURCE_NAME,
    detect() {
      // 只探测有 .pb 老数据的目录；目录不存在或没有 .pb 都不进
      for (const src of MIGRATION_SOURCES) {
        if (!fs.existsSync(src)) continue;
        try {
          if (fs.readdirSync(src).some((f) => f.endsWith(".pb"))) return src;
        } catch { /* ignore */ }
      }
      return null;
    },
    validate(dir) {
      return !!dir && fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".pb"));
    },
    getDeviceId,
    extract(dir, deviceId, deviceName, sinceMs) {
      return extractLegacy(dir, deviceId || getDeviceId(), deviceName || "这台电脑", sinceMs, makeLog());
    },
  };
}

module.exports = makeLegacyAdapter();

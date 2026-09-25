// DeepSeek Harness 数据源适配器（账本 + 会话流水合并为一路）
// 权威数据源：
//  1) ~/.dsh/tokenledger.sqlite 的 session_rollups —— 官方结算账本（2026-09 起新版官方软件不再写入，仅剩历史）
//  2) ~/.dsh/sessions/<项目>/<会话>/session*.jsonl.zstd —— 官方软件会话流水（全量，含账本未覆盖的增量）
//
// 流水是多 frame 串联 zstd（每条记录一个 frame），按 magic number 切片逐 frame 解压。
// !! 该解析必须跑在子进程里：Electron 主进程内 zlib.zstdDecompressSync 处理超大多 frame
//    文件时存在概率性原生崩溃（0xc0000005 级，JS try-catch 拦不住，直接闪退应用，
//    2026-09-25 发版实测），而 ELECTRON_RUN_AS_NODE 子进程同数据稳定。因此 extractSessions
//    把解析委托给 WORKER_SOURCE 生成的临时子进程脚本，主进程只做枚举/记账/建记录；
//    子进程按 NDJSON 逐文件回报，崩在哪个文件只丢该文件（清单不记账，下轮自动重试）。
//
// usage 载体按文件版本区分：老格式（v1）在 assistant/chunk（且 assistant/message 重复携带
// 同值），v3/v4 在 assistant/message；同 (turn,step,数值) 指纹去重兜底双写。
// provider/model 优先取消息自带 source，回退 request/context·request/header·
// model/selection·title 请求维护的会话级当前路由。
// 两路记录 id 同构（site 槽固定 direct），同一会话键入库时互相覆盖幂等；
// 流水与官方账本已对 2026-08 历史会话逐日校准一致。
// 设备标识：~/.dsh/.anonymous-user-id
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { normalizeModel, providerName } = require("./adapter-zcode.cjs");
const { rmTempDir, sweepStale } = require("./temp-util.cjs");

const ID = "dsh";
const NAME = "DeepSeek Harness";

// 会话流水相对账本的独立通道：site 无从得知，固定与官方账本历史值一致，保证记录 id 同构可互相覆盖
const FLOW_SITE = "direct";

// 子进程解析超时：首扫全量实测秒级，余量给到 5 分钟；超时 kill 后已回报的文件照常入账
const WORKER_TIMEOUT_MS = 5 * 60 * 1000;

// 单 frame 解压输出上限（32MB）：单条记录远小于此，超限必是异常数据，跳过保护子进程
// （Node 对未声明 content size 的 zstd frame 会按实际输出分配，该上限同时是分配护栏）
const MAX_FRAME_OUTPUT = 32 * 1024 * 1024;

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

function defaultDir() {
  return path.join(homeDir(), ".dsh");
}

function detect() {
  const dir = defaultDir();
  return fs.existsSync(dir) ? dir : null;
}

function validate(dir) {
  // 官方账本与流水目录任一存在即可用：9 月起新版官方软件只写流水不写账本
  return fs.existsSync(path.join(dir, "tokenledger.sqlite")) || fs.existsSync(path.join(dir, "sessions"));
}

function getDeviceId(dir) {
  try {
    const value = fs.readFileSync(path.join(dir, ".anonymous-user-id"), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

// ===== 通道 1：官方结算账本 =====

function readRows(dbFile) {
  const conn = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return conn.prepare(`
      SELECT sessionId, day, site, provider, model, inputTokens, outputTokens,
             cacheReadTokens, cacheWriteTokens, reasoningTokens
      FROM session_rollups
      ORDER BY day ASC, sessionId ASC
    `).all();
  } finally {
    conn.close();
  }
}

function readWithWalFallback(dir) {
  const dbFile = path.join(dir, "tokenledger.sqlite");
  try {
    return readRows(dbFile);
  } catch (directError) {
    sweepStale("dosage-sync-dsh-"); // 崩溃遗留的上轮临时副本，本轮顺手清理
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dosage-sync-dsh-"));
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        const source = dbFile + suffix;
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(tempDir, `tokenledger.sqlite${suffix}`));
      }
      return readRows(path.join(tempDir, "tokenledger.sqlite"));
    } catch (fallbackError) {
      throw new Error(`读取 DeepSeek Harness 数据失败：${fallbackError.message || directError.message}`);
    } finally {
      rmTempDir(tempDir); // 删除失败静默：不掩盖正常结果/原始错误，残留由下轮 sweepStale 清理
    }
  }
}

// ===== 通道 2：官方软件会话流水 =====

/** 会话流水文件版本：session.jsonl.zstd=1，session.vN.jsonl.zstd=N，其余（未知命名）=0 忽略 */
function sessionFileVersion(fileName) {
  if (fileName === "session.jsonl.zstd") return 1;
  const match = fileName.match(/^session\.v(\d+)\.jsonl\.zstd$/);
  return match ? Number(match[1]) : 0;
}

/** 枚举全部会话流水文件；同一会话多格式文件并存（官方重封装产物，内容重叠）只取版本号最高的一个 */
function listSessionFiles(dir) {
  const root = path.join(dir, "sessions");
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    let sessions;
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory() || !session.name.startsWith("session-")) continue;
      let files;
      try {
        files = fs.readdirSync(path.join(projectDir, session.name));
      } catch {
        continue;
      }
      let best = null;
      for (const fileName of files) {
        const version = sessionFileVersion(fileName);
        if (version === 0) continue;
        if (!best || version > best.version) best = { version, fileName };
      }
      if (!best) continue;
      const file = path.join(projectDir, session.name, best.fileName);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      out.push({
        rel: `${project.name}/${session.name}/${best.fileName}`,
        file,
        sessionId: session.name,
        version: best.version,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  return out;
}

function localDayStart(day) {
  const match = String(day || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [y, m, d] = [+match[1], +match[2], +match[3]];
  // 非法月份/日期（如 2026-13-40）必须拒绝——Date 构造会静默进位到错误的年月
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const value = new Date(y, m - 1, d).getTime();
  return Number.isFinite(value) ? value : null;
}

/** 本地日期字符串 YYYY-MM-DD（与 session_rollups.day 同一口径） */
function localDateStr(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 流水聚合桶 → 统一用量记录（id 与账本行同构，同键覆盖幂等） */
function flowRecord(sessionId, bucket, deviceId, deviceName) {
  const modelId = normalizeModel(bucket.model || "unknown");
  // DSH 的 inputTokens 不含缓存读取，归一化后补入缓存读取量以统一缓存命中率口径（与账本通道一致）
  return {
    id: `${deviceId}:dsh:${sessionId}:${bucket.day}:${FLOW_SITE}:${bucket.provider}:${bucket.model}`,
    deviceId,
    deviceName,
    source: ID,
    providerId: providerName(bucket.provider, modelId),
    modelId,
    taskType: FLOW_SITE,
    sessionId,
    inputTokens: bucket.input + bucket.cacheRead,
    outputTokens: bucket.output,
    reasoningTokens: bucket.reasoning,
    cacheCreationTokens: bucket.cacheWrite,
    cacheReadTokens: bucket.cacheRead,
    startedAt: localDayStart(bucket.day),
    status: "success",
  };
}

/** DSH 的 inputTokens 不含缓存读取，归一化后补入缓存读取量以统一缓存命中率口径。 */
function extract(dir, deviceId, deviceName, since) {
  if (!validate(dir)) throw new Error(`未找到 DeepSeek Harness 数据（tokenledger.sqlite 与 sessions 目录均不存在）：${dir}`);

  // 日粒度记录配毫秒水位线的关键防御：session_rollups 的 startedAt 被压成当天零点，
  // 若按「startedAt <= since 跳过」严格增量，昨天/今天行在锚点推进后发生的迟写更新
  // （跨午夜会话收尾、token 回填）会被永久过滤。改为按「本地日期 ≥ since 前一天」
  // 宽松回扫，重复行靠幂等 id（含 sessionId+day+site+provider+model）在入库时覆盖去重。
  const minDay = since > 0 ? localDateStr(since - 86400000) : "";

  const out = [];
  // 通道 1：官方结算账本（2026-09 起新版官方软件不再写入；缺失时只走会话流水通道）
  if (fs.existsSync(path.join(dir, "tokenledger.sqlite"))) {
    for (const row of readWithWalFallback(dir)) {
      if (minDay && String(row.day || "") < minDay) continue;
      const startedAt = localDayStart(row.day);
      if (startedAt === null) continue;
      const modelId = normalizeModel(row.model || "unknown");
      const rawInput = row.inputTokens ?? 0;
      const cacheRead = row.cacheReadTokens ?? 0;
      const cacheWrite = row.cacheWriteTokens ?? 0;
      out.push({
        id: `${deviceId}:dsh:${row.sessionId}:${row.day}:${row.site}:${row.provider}:${row.model}`,
        deviceId,
        deviceName,
        source: ID,
        providerId: providerName(row.provider, modelId),
        modelId,
        taskType: row.site || undefined,
        sessionId: row.sessionId || undefined,
        inputTokens: rawInput + cacheRead,
        outputTokens: row.outputTokens ?? 0,
        reasoningTokens: row.reasoningTokens ?? 0,
        cacheCreationTokens: cacheWrite,
        cacheReadTokens: cacheRead,
        startedAt,
        status: "success",
      });
    }
  }
  return out;
}

// ===== 通道 2 的子进程解析器 =====
// 自包含脚本（仅 node 内置依赖），运行时写入临时目录后以 ELECTRON_RUN_AS_NODE 子进程执行：
// 天然绕开打包 asar 与主进程 zstd 原生崩溃两个坑。
const WORKER_SOURCE = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_FRAME_OUTPUT = ${MAX_FRAME_OUTPUT};

/** 会话流水文件版本：session.jsonl.zstd=1，session.vN.jsonl.zstd=N，其余忽略 */
function sessionFileVersion(fileName) {
  if (fileName === "session.jsonl.zstd") return 1;
  const match = fileName.match(/^session\\.v(\\d+)\\.jsonl\\.zstd$/);
  return match ? Number(match[1]) : 0;
}

/** 多 frame 串联 zstd 解压：按 magic 切片逐 frame 解，损坏/超限 frame 跳过 */
function decodeZstdFrames(buf) {
  const texts = [];
  const offsets = [];
  for (let at = buf.indexOf(MAGIC); at !== -1; at = buf.indexOf(MAGIC, at + 1)) offsets.push(at);
  for (let n = 0; n < offsets.length; n++) {
    const start = offsets[n];
    const end = n + 1 < offsets.length ? offsets[n + 1] : buf.length;
    try {
      const out = zlib.zstdDecompressSync(buf.subarray(start, end));
      if (out.length <= MAX_FRAME_OUTPUT) texts.push(out.toString("utf8"));
    } catch {
      /* 单 frame 损坏/超限不影响其余 */
    }
  }
  return texts;
}

function localDateStr(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/** 解析单个会话流水文件，usage 按（本地日, provider, model）聚合 */
function collectSessionUsage(file, version, sessionId) {
  const buckets = new Map();
  const seen = new Set();
  let route = null; // 会话级当前路由：官方只在请求发起/切换时落记录，之后持续生效
  for (const text of decodeZstdFrames(fs.readFileSync(file))) {
    for (const line of text.split("\\n")) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const data = o.data;
      if (!data) continue;
      if (o.type === "request/context" && data.provider) {
        route = { provider: data.provider, model: data.model || "unknown" };
        continue;
      }
      if (o.type === "request/header" && data.header && data.header.config && data.header.config.provider) {
        route = { provider: data.header.config.provider, model: data.header.config.model || "unknown" };
        continue;
      }
      if (o.type === "model/selection" && data.provider) {
        route = { provider: data.provider, model: data.model || "unknown" };
        continue;
      }
      if (o.type === "session/title-llm-request" && data.route && data.route.provider) {
        route = { provider: data.route.provider, model: data.route.model || "unknown" };
        continue;
      }
      // usage 载体按文件版本区分：老格式（v1）在 assistant/chunk 且 assistant/message 重复携带
      // 同值，v3/v4 只在 assistant/message；版本分流后天然单倍，指纹去重仅作双写兜底
      let usage = null;
      let turn = "?";
      let step = "?";
      let msgSource = null;
      if (version >= 3) {
        if (o.type === "assistant/message" && data.usage) {
          usage = data.usage;
          turn = data.turn;
          step = data.step;
          msgSource = data.message && data.message.source;
        }
      } else if (o.type === "assistant/chunk" && data.chunk && data.chunk.type === "usage") {
        usage = data.chunk.usage;
        turn = data.turn;
        step = data.step;
      }
      if (!usage) continue;
      if (!Number.isFinite(o.time) || o.time <= 0) continue;
      const day = localDateStr(o.time);
      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(day)) continue;
      const input = usage.inputTokens ?? 0;
      const output = usage.outputTokens ?? 0;
      const cacheRead = usage.cacheReadTokens ?? 0;
      const cacheWrite = usage.cacheWriteTokens ?? 0;
      const reasoning = usage.reasoningTokens ?? 0;
      const fingerprint = turn + "|" + step + "|" + input + "|" + output + "|" + cacheRead + "|" + cacheWrite + "|" + reasoning;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      const provider = (msgSource && msgSource.provider) || (route && route.provider) || "unknown";
      const model = (msgSource && msgSource.model) || (route && route.model) || "unknown";
      const key = day + "\\u0000" + provider + "\\u0000" + model;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { sessionId, day, provider, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
        buckets.set(key, bucket);
      }
      bucket.input += input;
      bucket.output += output;
      bucket.cacheRead += cacheRead;
      bucket.cacheWrite += cacheWrite;
      bucket.reasoning += reasoning;
    }
  }
  return [...buckets.values()];
}

// 任务从 stdin 读入：{ files: [{ rel, file, version, sessionId }] }；NDJSON 逐文件回报，崩溃只丢当前文件
let taskText = "";
process.stdin.on("data", (chunk) => { taskText += chunk; });
process.stdin.on("end", () => {
  const task = JSON.parse(taskText);
  for (const item of task.files) {
    try {
      const buckets = collectSessionUsage(item.file, item.version, item.sessionId);
      process.stdout.write(JSON.stringify({ ok: 1, rel: item.rel, buckets }) + "\\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: 0, rel: item.rel, error: String(e && e.message || e) }) + "\\n");
    }
  }
  process.stdout.write(JSON.stringify({ done: 1 }) + "\\n");
});
`;

/**
 * 会话流水抽取（清单增量）：主进程枚举待解析文件后委托子进程解析（见 WORKER_SOURCE 注释，
 * 主进程内直接解压存在概率性原生闪退，绝不能跑回主线程），按结果建记录。
 * index 为上轮清单 { files: { 相对路径: [size, mtimeMs] } }，只解析新增/变化的文件。
 * 返回 { records, settledFiles }：settledFiles 仅含本轮成功解析的文件账目，
 * 崩溃/超时未完成文件不入账（配合 sync 层保留旧账，下轮自动重试）。
 */
async function extractSessions(dir, deviceId, deviceName, index) {
  const known = (index && index.files) || {};
  const pending = [];
  for (const item of listSessionFiles(dir)) {
    const prev = known[item.rel];
    // 流水文件只追加不改写，size+mtime 均未变即内容未变，跳过重解析
    if (prev && prev[0] === item.size && prev[1] === Math.round(item.mtimeMs)) continue;
    pending.push(item);
  }
  if (pending.length === 0) return { records: [], settledFiles: new Map() };

  const out = [];
  const settledFiles = new Map(); // rel → [size, mtimeMs]（仅成功回报的文件记入新清单）
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dosage-sync-dsh-worker-"));
  const workerFile = path.join(tempDir, "worker.cjs");
  try {
    fs.writeFileSync(workerFile, WORKER_SOURCE);
    const child = spawn(process.execPath, [workerFile], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.stdin.write(JSON.stringify({
      files: pending.map((item) => ({ rel: item.rel, file: item.file, version: item.version, sessionId: item.sessionId })),
    }));
    child.stdin.end();

    // NDJSON 逐行收割：子进程每完成一个文件立即输出一行，崩在哪个文件只丢该文件
    let buffer = "";
    let stderrTail = "";
    let childFailed = false;
    const onLine = (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.ok === 1 && Array.isArray(msg.buckets)) {
        const item = pending.find((p) => p.rel === msg.rel);
        if (item) settledFiles.set(msg.rel, [item.size, Math.round(item.mtimeMs)]);
        for (const bucket of msg.buckets) {
          out.push(flowRecord(bucket.sessionId, bucket, deviceId, deviceName));
        }
      }
      // ok:0 的文件不记账，下轮清单不命中自动重试
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let at;
      while ((at = buffer.indexOf("\n")) !== -1) {
        onLine(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
    });
    child.stderr.on("data", (chunk) => {
      // 只留尾部用于诊断，不落库不弹窗
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* 已退出 */ }
        resolve();
      }, WORKER_TIMEOUT_MS);
      timer.unref?.();
      child.on("close", (code) => {
        clearTimeout(timer);
        // 非零退出 = 子进程原生崩溃/异常结束：已回报文件照常入账，未完成文件本轮放弃
        if (code !== 0 && code !== null) childFailed = true;
        resolve();
      });
      child.on("error", () => { clearTimeout(timer); childFailed = true; resolve(); });
    });
    // 进程结束后把残余不满一行的缓冲也收割掉
    if (buffer.trim()) onLine(buffer);
    // spawn 失败（error 事件，未产生任何结果）时上抛：与「子进程崩溃丢文件」区分，让调用方看到
    if (childFailed && settledFiles.size === 0 && stderrTail.trim()) {
      throw new Error(`DeepSeek Harness 会话流水子进程解析失败：${stderrTail.trim().split("\n").pop().slice(0, 200)}`);
    }
  } finally {
    rmTempDir(tempDir); // 删除失败静默：残留临时目录由下轮 sweepStale 兜底清理
  }

  return { records: out, settledFiles };
}

function buildSessionsIndex(dir) {
  const files = {};
  for (const item of listSessionFiles(dir)) {
    files[item.rel] = [item.size, Math.round(item.mtimeMs)];
  }
  return { v: 1, files };
}

module.exports = { id: ID, name: NAME, detect, validate, getDeviceId, extract, extractSessions, buildSessionsIndex };

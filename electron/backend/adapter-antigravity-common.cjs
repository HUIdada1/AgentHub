// Antigravity / Antigravity IDE 数据源公共工厂
// 用量权威来源：~/.gemini/<homeSub>/conversations/<conversationId>.db（每会话一个明文 SQLite）
//   gen_metadata 表每行对应一次 LLM 生成调用，data 为 protobuf BLOB：
//     外层 f1 → 生成元消息：f4 = 用量子消息{f2 credits 额度点, f3 输出 token,
//     f5 输入提示词水位(会话内单调递增累计), f9 ≈思考 token}，f19 = 模型名。
// 口径（2026-09-11 本机实测，详见 docs/Antigravity数据源接入方案-2026-09-11.md）：
//   - 官方模型服务端按 credits 计费 → 写入 usage_record.credits 独立列，不进 token 总量；
//   - 输出 token 为精确值（f3）；输入 token 为 f5 水位的相邻差分（每会话首行从 0 起算），
//     属近似口径；本地无缓存明细，cache 两桶为 0；
//   - .pb 旧格式会话（2026-05~07）整文件加密、密钥不在本机，本适配器不读；
//     这类历史数据由 adapter-antigravity-legacy.cjs 走官方 language_server 通道恢复。
// 幂等键：deviceId:source:conversationId:genIdx（conversationId 取 .db 文件名，UUID 全局唯一），
//   同库重写导致行号漂移时 INSERT OR REPLACE 按键覆盖，不会重复入账。
// 时间戳：会话库无逐次生成时间，取文件 mtime 作为该文件全部记录的 startedAt（同 CodeBuddy 策略）。
// 设备标识：~/.gemini/<homeSub>/antigravity_state.pbtxt 的 installation_uuid。
// 优雅降级：单库损坏/被占用跳过该库（锁库时复制临时副本回退），全目录不可读返回空记录并写日志。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { rmTempDir, sweepStale, openReadOnly } = require("./temp-util.cjs");

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

/** 非负有限数字，非法返回 0（db 层 safeToken 之外的适配器侧兜底） */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** credits 额度点：缺失/非法返回 null（不造 0 假数据），与 Qoder creditsOf 同约定 */
function creditsVal(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ---------- 极简 protobuf 解码（仅覆盖本数据源用到的 wire type，无第三方依赖） ----------

function readVarint(buf, i) {
  let v = 0n;
  let shift = 0n;
  while (true) {
    if (i >= buf.length) throw new Error("varint 越界");
    const b = buf[i++];
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [Number(v), i];
    shift += 7n;
    if (shift > 63n) throw new Error("varint 过长");
  }
}

/** 解析一段 protobuf 为字段列表；结构非法时抛错（调用方按字段容错） */
function parseFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let tag;
    [tag, i] = readVarint(buf, i);
    const field = tag >> 3;
    const wt = tag & 7;
    if (field === 0) throw new Error("非法字段号");
    if (wt === 0) {
      let v;
      [v, i] = readVarint(buf, i);
      out.push({ field, wt, varint: v });
    } else if (wt === 1) {
      if (i + 8 > buf.length) throw new Error("double 越界");
      out.push({ field, wt, dbl: buf.readDoubleLE(i) });
      i += 8;
    } else if (wt === 2) {
      let len;
      [len, i] = readVarint(buf, i);
      if (i + len > buf.length) throw new Error("长度越界");
      out.push({ field, wt, data: buf.slice(i, i + len) });
      i += len;
    } else if (wt === 5) {
      if (i + 4 > buf.length) throw new Error("float 越界");
      out.push({ field, wt, flt: buf.readFloatLE(i) });
      i += 4;
    } else {
      throw new Error(`不支持的 wire type ${wt}`);
    }
  }
  return out;
}

/**
 * 解析一行 gen_metadata.data → { model, credits, outputTokens, inputWatermark, reasoningTokens }。
 * 任何一层结构不符返回 null（该行跳过），不抛错。
 */
function parseGenMetadata(buf) {
  let outer;
  try {
    outer = parseFields(buf);
  } catch {
    return null;
  }
  const metaF = outer.find((e) => e.field === 1 && e.wt === 2);
  if (!metaF) return null;
  let meta;
  try {
    meta = parseFields(metaF.data);
  } catch {
    return null;
  }
  const modelF = meta.find((e) => e.field === 19 && e.wt === 2);
  const usageF = meta.find((e) => e.field === 4 && e.wt === 2);
  if (!usageF) return null; // 无用量的行（如纯元数据）跳过
  let usage;
  try {
    usage = parseFields(usageF.data);
  } catch {
    return null;
  }
  const get = (n) => {
    const f = usage.find((e) => e.field === n && e.wt === 0);
    return f ? f.varint : null;
  };
  return {
    model: modelF ? modelF.data.toString("utf8") : null,
    credits: get(2),
    outputTokens: get(3),
    inputWatermark: get(5),
    reasoningTokens: get(9),
  };
}

// ---------- 会话库读取（openReadOnly 在 temp-util.cjs，锁库时复制临时副本回退） ----------

/** 读取一个会话库的全部 gen_metadata 行（按 idx 升序）；失败返回 null */
function readGenMetadataRows(file) {
  let conn;
  try {
    conn = openReadOnly(file, "dosage-sync-ag-");
    // 只取必需两列；表缺失（结构变体）会抛错走降级
    return conn.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx").all();
  } catch {
    return null;
  } finally {
    if (conn) {
      try {
        conn.close();
      } catch {
        /* 忽略关闭异常 */
      }
    }
  }
}

/** 日志惰性桥：生产走 db.addLog，自测（无数据库环境）静默 */
function log(kind, level, message, detail) {
  try {
    require("./db.cjs").addLog(kind, level, message, detail);
  } catch {
    /* 自测环境无 db，忽略 */
  }
}

// ---------- 适配器工厂 ----------

/**
 * @param id 源 id（antigravity / antigravity-ide）
 * @param name 显示名
 * @param homeSub ~/.gemini 下的子目录名
 * @param envKey 自测注入环境变量（覆盖默认目录），可选
 */
function makeAdapter(id, name, homeSub, envKey) {
  function defaultBase() {
    return path.join(homeDir(), ".gemini", homeSub);
  }

  function resolveBase() {
    if (envKey) {
      const env = String(process.env[envKey] || "").trim();
      if (env) return path.resolve(env);
    }
    return defaultBase();
  }

  function detect() {
    const base = resolveBase();
    return fs.existsSync(path.join(base, "conversations")) ? base : null;
  }

  function validate(dir) {
    return !!dir && fs.existsSync(path.join(dir, "conversations"));
  }

  /** 设备标识：installation_uuid（同一安装多账号共享，符合「设备」语义）；取不到返回 null 走统一回退链 */
  function getDeviceId(dir) {
    const base = typeof dir === "string" && dir ? dir : defaultBase();
    const file = path.join(base, "antigravity_state.pbtxt");
    try {
      const text = fs.readFileSync(file, "utf8");
      const m = text.match(/installation_uuid:\s*"?([-0-9a-fA-F]{8,})"?/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * 增量抽取：扫 conversations/*.db，mtime 早于回扫窗口起点的库直接跳过；
   * 每库逐行解 gen_metadata，f5 输入水位按行序差分入账。
   */
  function extract(dir, deviceId, deviceName, since) {
    const convDir = path.join(dir, "conversations");
    let files;
    try {
      files = fs.readdirSync(convDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".db"));
    } catch (e) {
      log("extract", "warn", `${name} 会话目录不可读，已跳过`, e.message);
      return [];
    }

    const out = [];
    let skippedFiles = 0;
    for (const file of files) {
      const filePath = path.join(convDir, file.name);
      let mtime;
      try {
        mtime = fs.statSync(filePath).mtimeMs;
      } catch {
        skippedFiles++;
        continue;
      }
      if (since > 0 && mtime <= since) continue;

      const rows = readGenMetadataRows(filePath);
      if (!rows) {
        skippedFiles++;
        continue; // 坏库/锁库/结构变体：跳过该库，不阻断其余
      }
      const conversationId = file.name.replace(/\.db$/, "");
      // f5 输入水位差分：同一会话内单调递增，首行从 0 起算
      let prevWatermark = 0;
      for (const row of rows) {
        const parsed = parseGenMetadata(Buffer.from(row.data));
        if (!parsed) continue;
        const watermark = num(parsed.inputWatermark);
        const inputTokens = watermark >= prevWatermark ? watermark - prevWatermark : 0;
        if (watermark > 0) prevWatermark = watermark;
        out.push({
          id: `${deviceId}:${id}:${conversationId}:${row.idx}`,
          deviceId,
          deviceName,
          source: id,
          providerId: "Google",
          modelId: parsed.model || "unknown",
          sessionId: conversationId,
          inputTokens,
          outputTokens: num(parsed.outputTokens),
          reasoningTokens: num(parsed.reasoningTokens),
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          credits: creditsVal(parsed.credits),
          startedAt: Math.floor(mtime),
          completedAt: Math.floor(mtime),
          status: "success",
        });
      }
    }

    if (skippedFiles > 0) {
      log("extract", "info", `${name} 跳过 ${skippedFiles} 个不可读会话库（损坏或占用），不影响其余数据`);
    }
    out.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
    return out;
  }

  return { id, name, detect, validate, getDeviceId, extract };
}

module.exports = {
  makeAdapter,
  readVarint,
  parseFields,
  parseGenMetadata,
};

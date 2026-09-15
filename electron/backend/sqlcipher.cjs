// SQLCipher 加密 SQLite 读取桥（Trae 系数据源专用）
// 背景：Trae / Trae CN / TRAE SOLO / TRAE SOLO CN 的会话主库 ModularData/ai-agent/database.db
//   为 SQLCipher 整库加密（AES-256-CBC + HMAC-SHA512，raw key 模式）。
//   密钥为应用内硬编码固定值（四应用通用，与机器/salt 无关，2026-09-11 实测验证）。
// 读取路径：koffi FFI 打开加密库 → sqlcipher_export 导出到内存明文库 → 句柄交给
//   适配器直接查询（不走 node:sqlite，因为 node:sqlite 无 SQLCipher 支持且
//   无法打开别人已 attach 的内存库——同一连接内完成全部查询）。
// DLL 位置：开发环境在 <项目根>/resources/sqlcipher/；打包后经 extraResources
//   落在 process.resourcesPath/sqlcipher/。libcrypto/libssl 为其依赖，须同目录。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const koffi = require("koffi");

// Trae 系 SQLCipher 硬编码密钥（raw key，64 hex；全量用户统一，非机器派生）
const TRAE_DB_KEY = "3605f6691095a993f03d5009c918352ef5be31ae31e8f000212b81ff058da773";

let lib = null;
let loadError = null;

/** 定位 sqlcipher.dll：打包后 resourcesPath，开发环境项目根 resources/ */
function dllDir() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "sqlcipher"));
  candidates.push(path.join(__dirname, "..", "..", "resources", "sqlcipher"));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "sqlcipher.dll"))) return dir;
  }
  return null;
}

/** 懒加载 DLL（含 libcrypto/libssl 依赖预载，Windows 加载顺序敏感） */
function ensureLib() {
  if (lib) return lib;
  if (loadError) throw loadError;
  try {
    const dir = dllDir();
    if (!dir) throw new Error("未找到 sqlcipher.dll（resources/sqlcipher 缺失）");
    // 先加载 OpenSSL 依赖，再加载 sqlcipher 本体
    koffi.load(path.join(dir, "libcrypto-1_1-x64.dll"));
    koffi.load(path.join(dir, "libssl-1_1-x64.dll"));
    const dll = koffi.load(path.join(dir, "sqlcipher.dll"));

    // 一次性声明全部需要的 C 函数（koffi.func(lib, name, retType, [argTypes])）
    lib = {
      sqlite3_open: dll.func("int sqlite3_open(const char *filename, _Out_ void **ppDb)"),
      sqlite3_close: dll.func("int sqlite3_close(void *db)"),
      sqlite3_exec: dll.func("int sqlite3_exec(void *db, const char *sql, void *cb, void *arg, _Out_ char **errmsg)"),
      sqlite3_prepare_v2: dll.func("int sqlite3_prepare_v2(void *db, const char *sql, int nByte, _Out_ void **ppStmt, void *pzTail)"),
      sqlite3_step: dll.func("int sqlite3_step(void *stmt)"),
      sqlite3_finalize: dll.func("int sqlite3_finalize(void *stmt)"),
      sqlite3_column_count: dll.func("int sqlite3_column_count(void *stmt)"),
      sqlite3_column_type: dll.func("int sqlite3_column_type(void *stmt, int i)"),
      sqlite3_column_int64: dll.func("int64 sqlite3_column_int64(void *stmt, int i)"),
      sqlite3_column_double: dll.func("double sqlite3_column_double(void *stmt, int i)"),
      sqlite3_column_text: dll.func("const char *sqlite3_column_text(void *stmt, int i)"),
      sqlite3_column_name: dll.func("const char *sqlite3_column_name(void *stmt, int i)"),
      sqlite3_errmsg: dll.func("const char *sqlite3_errmsg(void *db)"),
    };
    return lib;
  } catch (e) {
    loadError = e;
    throw e;
  }
}

/** 该环境是否可用 SQLCipher（DLL 存在且可加载） */
function available() {
  try {
    ensureLib();
    return true;
  } catch {
    return false;
  }
}

const SQLITE_OK = 0;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;

function checkRc(db, rc, what) {
  if (rc !== SQLITE_OK && rc !== SQLITE_DONE && rc !== SQLITE_ROW) {
    const msg = lib.sqlite3_errmsg(db) || `rc=${rc}`;
    throw new Error(`SQLCipher ${what} 失败: ${msg}`);
  }
}

function exec(db, sql) {
  const rc = lib.sqlite3_exec(db, sql, null, null, null);
  if (rc !== SQLITE_OK) {
    const msg = lib.sqlite3_errmsg(db) || `rc=${rc}`;
    throw new Error(`SQLCipher 执行失败: ${msg}`);
  }
}

/**
 * 以 Trae 密钥打开加密库并校验可读性。
 * @param {string} dbPath 数据库文件路径（建议先复制副本，避免与应用锁冲突）
 * @returns 原生连接句柄（用于 queryAll / close）
 */
function open(dbPath) {
  ensureLib();
  const out = [null];
  const rc = lib.sqlite3_open(dbPath, out);
  if (rc !== SQLITE_OK || !out[0]) {
    throw new Error(`SQLCipher 打开失败: ${lib.sqlite3_errmsg(out[0]) || `rc=${rc}`}`);
  }
  const db = out[0];
  try {
    // raw key 模式（x'<64hex>'）：SQLCipher 跳过 PBKDF2 直接以 32 字节密钥解密
    exec(db, `PRAGMA key = "x'${TRAE_DB_KEY}'"`);
    // 探测性读取：密钥错误时此处抛 "file is not a database"
    exec(db, "SELECT count(*) FROM sqlite_master");
    return db;
  } catch (e) {
    lib.sqlite3_close(db);
    throw e;
  }
}

/** 关闭连接（容忍重复调用） */
function close(db) {
  if (db) lib.sqlite3_close(db);
}

/**
 * 在已打开的加密连接上执行查询，返回行对象数组。
 * 仅支持适配器需要的列类型：INTEGER / FLOAT / TEXT / NULL（BLOB 转 hex 字符串）。
 */
function queryAll(db, sql) {
  const out = [null];
  const rc = lib.sqlite3_prepare_v2(db, sql, -1, out, null);
  checkRc(db, rc, "prepare");
  const stmt = out[0];
  const rows = [];
  try {
    const ncol = lib.sqlite3_column_count(stmt);
    const names = [];
    for (let i = 0; i < ncol; i++) names.push(lib.sqlite3_column_name(stmt, i));

    while (true) {
      const stepRc = lib.sqlite3_step(stmt);
      if (stepRc === SQLITE_DONE) break;
      checkRc(db, stepRc, "step");
      const row = {};
      for (let i = 0; i < ncol; i++) {
        const t = lib.sqlite3_column_type(stmt, i);
        if (t === 1) row[names[i]] = Number(lib.sqlite3_column_int64(stmt, i)); // INTEGER
        else if (t === 2) row[names[i]] = lib.sqlite3_column_double(stmt, i); // FLOAT
        else if (t === 3) row[names[i]] = lib.sqlite3_column_text(stmt, i); // TEXT
        else row[names[i]] = null; // NULL / BLOB（本数据源不需要 BLOB）
      }
      rows.push(row);
    }
  } finally {
    lib.sqlite3_finalize(stmt);
  }
  return rows;
}

module.exports = { available, open, close, queryAll, TRAE_DB_KEY };

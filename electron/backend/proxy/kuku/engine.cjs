/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · KukuAI 业务会话令牌换发
//
// 为什么需要这一步（本渠道最容易踩空的地方）：
//   对话 / 模型目录 / 签到这几路业务接口认的是**按产品签发**的会话令牌。从网页登录 Cookie 里
//   拿到的那份是通行证级的，无论再补多少个 Cookie 都过不了业务门的校验；而余额类接口只看 BDUSS，
//   于是用户看到的是「余额正常、模型拉不下」——跨天、跨客户端、跨网络都能复现，与请求内容无关。
//   官方客户端的解法是：用随客户端安装的原生引擎算出签名参数，再向通行证接口换发产品级令牌。
//   缺签 / 错签服务端都回 errno=4（细分码 110003），所以这一段**没有纯 HTTP 复刻的路子**，
//   只能调那颗 DLL。
//
// 换发结果只存在于响应体里（响应不带 Set-Cookie），拿到后只在进程内跟随这份 BDUSS 使用，
// 不回写账号记录：账号里存的是用户粘贴的原始 Cookie，换发材料（PTOKEN）正是从其中取的。
//
// 失败语义（与「不阻断」的取舍一起设计）：
//   没装客户端 / 没有 PTOKEN / 非 Windows → 返回 null，调用方按原凭证继续走，并给出可读提示。
//   这里刻意不抛错：转发链上层会因为会话校验失败给出更精确的 401 文案，比在本模块报
//   「找不到 DLL」更能指到用户该做的事。
//
// 主进程纪律：注册表扫描是**子进程**且可能跑到秒级，绝不许同步阻塞（网关就活在 Electron 主进程里，
// 一阻塞整个界面就冻住）。所以定位走异步 + 单飞，结果（含"没找到"）进程内只算一次。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const endpoints = require("./endpoints.cjs");

/** 引擎 DLL 的文件名（随官方客户端安装） */
const ENGINE_DLL_NAME = "genflowengine.dll";
/** 显式指定引擎路径的口子：装在非常规位置、或排障时用 */
const ENGINE_ENV = "KUKU_GENFLOW_ENGINE_DLL";

const UNINSTALL_ROOTS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

const REG_TIMEOUT_MS = 8000;

// 定位与加载都是进程级一次性的：找不到也缓存，避免每次换发都扫一遍注册表
let locatedResult; // undefined = 没查过；null = 查过且没找到
let locatePromise = null;
let engineLib = null;
let bindPromise = null;

function isWindows() {
  return process.platform === "win32";
}

/** 异步跑一次 reg.exe；失败（视图不存在 / 无权读 / 超时）就当没有结果，不抛 */
function regQuery(root) {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", root, "/s"],
      { encoding: "utf8", timeout: REG_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? "" : String(stdout || "")),
    );
  });
}

/**
 * 从注册表卸载项里收集安装目录（读 InstallLocation，退到 DisplayIcon 的所在目录）。
 * 不按显示名过滤：卸载项的中文名在 reg.exe 的控制台输出里会被代码页弄乱，
 * 而我们只要目录里那颗引擎 DLL，逐项试比按名匹配更稳。
 */
function installDirsFrom(text) {
  const dirs = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s+(InstallLocation|DisplayIcon)\s+REG_SZ\s+(.+)$/.exec(line);
    if (!m) continue;
    let value = String(m[2] || "").trim();
    if (!value) continue;
    if (m[1] === "DisplayIcon") {
      // DisplayIcon 常见形态是 `"C:\...\app.exe",0`：去引号、去参数、取父目录
      value = path.dirname(value.replace(/^"|"$/g, "").split(",")[0].trim());
    }
    if (value && dirs.indexOf(value) < 0) dirs.push(value);
  }
  return dirs;
}

async function scanDll() {
  const explicit = String(process.env[ENGINE_ENV] || "").trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const root of UNINSTALL_ROOTS) {
    const text = await regQuery(root);
    for (const dir of installDirsFrom(text)) {
      const candidate = path.join(dir, ENGINE_DLL_NAME);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* 目录不可达就继续找下一个 */
      }
    }
  }
  return null;
}

/** 定位引擎 DLL（异步 + 单飞：并发请求只扫一次，"没找到"同样缓存） */
function locateDll() {
  if (locatedResult !== undefined) return Promise.resolve(locatedResult);
  if (!isWindows()) {
    locatedResult = null;
    return Promise.resolve(null);
  }
  if (!locatePromise) {
    locatePromise = scanDll()
      .then((found) => {
        locatedResult = found || null;
        return locatedResult;
      })
      .catch(() => {
        locatedResult = null;
        return null;
      })
      .finally(() => {
        locatePromise = null;
      });
  }
  return locatePromise;
}

/** 加载引擎并绑定导出（句柄进程内常驻：引擎体积不小，且客户端不会在运行中卸载）。
 *  单飞：并发换发共用同一次加载。 */
function bindEngine() {
  if (engineLib) return Promise.resolve(engineLib);
  if (!bindPromise) {
    bindPromise = locateDll()
      .then((dll) => {
        if (!dll) return null;
        const koffi = require("koffi");
        const lib = koffi.load(dll);
        // 参数体长度由出参带回，所以返回类型按指针取、再按长度解码——不假设它是 NUL 结尾串
        const getAuthParam = lib.func(
          "void *genflow_engine_get_login_auth_param(const char *bduss, const char *ptoken, int32_t *out_len)",
        );
        const engineFree = lib.func("int32_t genflow_engine_free(void *ptr)");
        engineLib = { koffi, lib, getAuthParam, engineFree };
        return engineLib;
      })
      .catch(() => null)
      .finally(() => {
        bindPromise = null;
      });
  }
  return bindPromise;
}

/**
 * 调引擎构造签名参数体（形如 `appid=…&bduss=…&ptoken=…&return_type=…&tpl=…&tpl_list=…&sig=…`）。
 * 实测无需先做引擎全局初始化，单次调用即可出完整参数体。
 */
async function buildAuthParam(bduss, ptoken) {
  const bound = await bindEngine();
  if (!bound) return null;
  const { koffi, getAuthParam, engineFree } = bound;
  let outLenRef = null;
  let ptr = null;
  try {
    outLenRef = koffi.alloc("int32", 1);
    koffi.encode(outLenRef, "int32", 0);
    ptr = getAuthParam(String(bduss), String(ptoken), outLenRef);
    const length = koffi.decode.int32(outLenRef);
    if (!ptr || !length || length <= 0) return null;
    const text = String(koffi.decode.string(ptr, length) || "").trim();
    return text || null;
  } catch {
    return null;
  } finally {
    // 内存由引擎自己分配，必须交回引擎释放；释放失败不影响本次结果
    try {
      if (ptr) engineFree(ptr);
    } catch {
      /* 忽略 */
    }
  }
}

/** 引擎是否可用（给面板与日志一个如实的说法，不拿它当成功判定）。异步：调用方别在主进程里等注册表。 */
async function engineAvailable() {
  return !!(await locateDll());
}

/**
 * 用 BDUSS + PTOKEN 换发产品级业务会话令牌。
 * @returns {Promise<string|null>} 新令牌；null = 换不了（没引擎 / 缺 PTOKEN / 上游拒绝），调用方按原凭证继续
 */
async function exchangeStoken(bduss, ptoken, deps) {
  const b = String(bduss || "").trim();
  const p = String(ptoken || "").trim();
  if (!b || !p) return null;
  const body = await buildAuthParam(b, p);
  if (!body) return null;
  try {
    const r = await deps.httpJson(endpoints.PASSPORT_AUTH_URL, {
      method: "POST",
      headers: {
        // 不带 Cookie：换发材料全在签好名的请求体里
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Referer: endpoints.referer(),
        Origin: endpoints.baseUrl(),
        "User-Agent": endpoints.USER_AGENT,
      },
      body,
    });
    const payload = r && r.data;
    if (!payload || Number(payload.errno) !== 0) return null;
    const stoken = String((payload.stoken_list && payload.stoken_list.genflowpro) || "").trim();
    return stoken || null;
  } catch {
    return null;
  }
}

module.exports = { exchangeStoken, engineAvailable, ENGINE_DLL_NAME, ENGINE_ENV };

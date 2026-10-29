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
// 反代网关 · KukuAI（百度文库「库库 AI / GenFlowPro」）上游地址与客户端形态常量
//
// 单域：对话 / 模型目录 / 积分 / 签到全在 kuku.baidu.com 上，只有业务会话令牌的换发落在百度通行证域。
//
// query 里的 clienttype / web / version / app_id 不是装饰，是上游判「请求来自哪个客户端形态」的字段：
// 缺 app_id 时 sendmsg 与 freepoint 直接 400 params error。对话链按网页形态取值，积分接口按桌面形态的
// 子集取值且**不认 app_id**——两组接口各认各的形态，混用会被判非官方客户端，所以这里按接口分开给值，
// 不做"统一一套形态"的简化。
"use strict";

const DEFAULT_BASE_URL = "https://kuku.baidu.com";
/** 通行证域：业务会话令牌（genflowpro 作用域 STOKEN）的换发入口，见 engine.cjs */
const PASSPORT_AUTH_URL = "https://passport.baidu.com/v3/login/api/auth";

/** 客户端内置 app_id；另有一个云盘流媒体专用的 id 与它相近，混用会 400 params error */
const APP_ID = 123971023;
const CHANNEL = "chunlei";
const CLIENT_TYPE = 400;
const CLIENT_VERSION = "1.4.4";
/** 会话通道名：sendmsg / idallochstr 都要带，上游按它归理会话 */
const SESSION_CHANNEL = "kuku_web_genflowpro_v1";

/** 出站 UA：上游对 UA 敏感，默认 UA 会被判非官方客户端；这里锁定网页客户端实测可用的那一个 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

/** 默认模型：上游自动选路；未知模型名上游会**静默降级**，所以本渠道显式回退它，让降级变成可见的口径 */
const DEFAULT_MODEL = "auto";
/** 思考档位：上游有 think_mode 字段，但网关的「思考等级 → think_mode」映射没有实测证据，固定按客户端默认值发 */
const DEFAULT_THINK_MODE = 3;

/** 对话链 query（网页形态）；会话三件套由 session.cjs 追加在后面 */
const WEB_QUERY = `clienttype=${CLIENT_TYPE}&app_id=${APP_ID}&web=1&channel=${CHANNEL}&version=${CLIENT_VERSION}`;
/** 积分接口 query（桌面形态子集）：该接口不认 app_id，带上反而被拒 */
const POINTS_QUERY = `channel=${CHANNEL}&clienttype=${CLIENT_TYPE}&version=${CLIENT_VERSION}`;

const PATHS = {
  userReport: "/api/genflowpro/common/userreport",
  sendMsg: "/wenchain/genflowpro/sendmsg",
  // 注意这一条挂在 /wenchain/genflow/ 下，不是 genflowpro：路径写错上游直接 404
  allocate: "/wenchain/genflow/idallochstr",
  sessionSwitch: "/api/genflowpro/workspace/sessionswitch",
  chatStream: "/wenchain/genflowpro/sse/getchatcontent",
  // 目录接口是 model/list；旧写法 model_list 已废弃（返回 404）
  modelList: "/wenchain/genflowpro/model/list",
  balance: "/bizapi/gfpro/getgfvipremain",
  checkinPanel: "/api/genflowpro/freepoint/homenew",
  checkinTask: "/api/genflowpro/freepoint/taskComplete",
};

// 超时不在这里定：出站都走 adapters 的共用 HTTP 通道（httpJson 的 proxy.httpJsonTimeoutMs
// 与 SSE 的首字节预算 / 流空闲判定），一处调档全渠道生效，本渠道不另开旋钮。

function envOverride(name) {
  const v = String(process.env[name] || "").trim().replace(/\/+$/, "");
  return v || null;
}

/**
 * 规则文件（headers.json 的 kuku 段）可热改项：客户端形态常量随官方客户端升级会变，
 * 放进规则文件就能改完即生效、不必发版；不配则沿用下面内置的实测值。
 *
 * 改这里必须同步重建两条 query：版本号改了而 query 还是旧的，是最难查的一类不一致
 * （上游按形态字段判客户端，半新半旧的请求会被当成异常流量）。
 */
function configure(overrides) {
  const c = overrides && typeof overrides === "object" ? overrides : {};
  const self = module.exports;
  const base = String(c.baseUrl || "").trim().replace(/\/+$/, "");
  if (base) self.OVERRIDE_BASE_URL = base;
  if (String(c.userAgent || "").trim()) self.USER_AGENT = String(c.userAgent).trim();
  if (Number(c.appId) > 0) self.APP_ID = Math.trunc(Number(c.appId));
  if (String(c.channel || "").trim()) self.CHANNEL = String(c.channel).trim();
  if (String(c.version || "").trim()) self.CLIENT_VERSION = String(c.version).trim();
  if (Number(c.clientType) > 0) self.CLIENT_TYPE = Math.trunc(Number(c.clientType));
  if (Number(c.thinkMode) >= 0) self.DEFAULT_THINK_MODE = Math.trunc(Number(c.thinkMode));
  if (String(c.sessionChannel || "").trim()) self.SESSION_CHANNEL = String(c.sessionChannel).trim();
  self.WEB_QUERY =
    `clienttype=${self.CLIENT_TYPE}&app_id=${self.APP_ID}&web=1&channel=${self.CHANNEL}&version=${self.CLIENT_VERSION}`;
  self.POINTS_QUERY = `channel=${self.CHANNEL}&clienttype=${self.CLIENT_TYPE}&version=${self.CLIENT_VERSION}`;
}

module.exports = {
  PASSPORT_AUTH_URL,
  APP_ID,
  CHANNEL,
  CLIENT_TYPE,
  CLIENT_VERSION,
  SESSION_CHANNEL,
  USER_AGENT,
  DEFAULT_MODEL,
  DEFAULT_THINK_MODE,
  WEB_QUERY,
  POINTS_QUERY,
  PATHS,
  configure,
  /** 环境变量 KUKU_BASE_URL 与规则文件都能改基址：规则文件是用户显式配置，优先级更高 */
  baseUrl: () => self_override_base() || envOverride("KUKU_BASE_URL") || DEFAULT_BASE_URL,
  /** 换发业务令牌时的 Referer/Origin 用主站，不带路径前缀之外的东西 */
  referer: () => `${module.exports.baseUrl()}/genflowpro`,
};

function self_override_base() {
  return String(module.exports.OVERRIDE_BASE_URL || "").replace(/\/+$/, "") || null;
}

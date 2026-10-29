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
// 反代网关 · KukuAI（百度文库「库库 AI」）渠道适配器
//
// 上游是「换会话 → 建会话 → 分配算力 → SSE 取回」的四跳链式协议，一条客户端请求对应多次上游请求。
// 本仓库的转发入口统一是 chat()（号池与本地网关都只调它），所以这条链整体装进一次 chat() 里完成，
// 不声明 stateful()/chatSession()：那个扩展点在现网关里没有分流方（只有归档版 server.cjs 分过流），
// 声明了等于把对话挂到一条没人走的路径上。协议实现收在 kuku/ 子目录，这里只做挂载与凭据解析。
//
// 三处与本家形态相关的取舍：
//   1. 没有续期：登录态就是百度通行证 Cookie，上游没有 refresh 接口，过期只能重新登录或重新粘贴；
//   2. 没有桌面端导入：只走「粘贴 Cookie」这一条添加路径（Cookie 头 / Cookie 编辑器 JSON / 对象三种形态）；
//   3. 不做工具调用：上游的工具体系是注入式文本协议且带产品级人格保护，见 chat.cjs 文件头。
"use strict";

const rules = require("../rules.cjs");
const util = require("../util.cjs");
const credentials = require("./credentials.cjs");
const chat = require("./chat.cjs");
const models = require("./models.cjs");
const balance = require("./balance.cjs");
const checkin = require("./checkin.cjs");
const endpoints = require("./endpoints.cjs");
const log = require("./log.cjs");

const CHANNEL = "kuku";

function makeKuku(deps) {
  const { fetchStream, pumpSse, httpJson, firstByteBudgetMs } = deps;
  const cfg = () => {
    const section = (rules.get("headers.json") || {})[CHANNEL] || {};
    // 形态常量放规则文件里就能热改（改完下一次调用生效），所以每次取配置时同步一次
    endpoints.configure(section);
    return section;
  };

  // 子模块共用的出站依赖：HTTP 三件套 + 首字节预算 + 随机 id + 排障日志
  const bundle = {
    httpJson,
    fetchStream,
    pumpSse,
    firstByteBudgetMs,
    uuid: () => util.uuid(),
    verbose: (text) => log.verbose(text),
  };

  /** 账号里的 token 存整段 Cookie 头；解不出有效 BDUSS 就是需要重新添加（401，不是 502） */
  function credentialOf(secrets) {
    const raw = String((secrets && secrets.token) || "").trim();
    const cred = credentials.parseCookieHeader(raw);
    if (!cred) {
      throw Object.assign(
        new Error("KukuAI 账号缺少有效的 BDUSS：请重新添加账号，或重新粘贴完整 Cookie（需包含 BDUSS、STOKEN、PTOKEN）"),
        { status: 401 },
      );
    }
    cfg();
    return cred;
  }

  return {
    id: CHANNEL,
    cfg,

    /** 静态兜底清单（离线也有 /v1/models 可列），拉过目录之后以远程清单为准 */
    models() {
      return models.ids();
    },

    modelEntries() {
      return models.entries();
    },

    /** 拉取上游目录：会话没建立时先换三件套；没账号不是失败，如实回跳过 */
    async fetchModels(account, secrets, opts) {
      if (!String((secrets && secrets.token) || "").trim()) {
        return { ok: true, skipped: true, models: models.ids(), message: "尚未添加账号，保留静态兜底清单" };
      }
      let cred = null;
      try {
        cred = credentialOf(secrets);
      } catch (e) {
        return { ok: false, authError: true, message: e.message };
      }
      return models.refresh(cred, bundle, !!(opts && opts.force));
    },

    async chat(ctx) {
      cfg();
      return chat.runChat({
        deps: bundle,
        credential: credentialOf(ctx && ctx.secrets),
        body: (ctx && ctx.body) || {},
        model: ctx && ctx.model,
        emit: ctx && ctx.emit,
      });
    },

    /** 通用分类器已经把 HTTP 401 判成「需重登 + 可换号」；本家多一个 403——上游把登录态失效也
     *  回 403（Cookie 过期 / 会话被踢），与 401 同口径处理，否则会掉进通用表的其它分支被误判成账号故障 */
    classifyError(e) {
      const status = Number(e && e.status) || 0;
      if (status === 403) return { kind: "relogin", switchable: true, status: 401 };
      return null;
    },

    async queryCredits(account, secrets) {
      let cred = null;
      try {
        cred = credentialOf(secrets);
      } catch (e) {
        return { authError: true, message: e.message };
      }
      try {
        return await balance.queryCredits(cred, bundle);
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    },

    async checkin(account, secrets) {
      let cred = null;
      try {
        cred = credentialOf(secrets);
      } catch (e) {
        return { ok: false, authError: true, message: e.message };
      }
      try {
        return await checkin.checkin(cred, bundle);
      } catch (e) {
        const status = Number(e && e.status) || 0;
        return { ok: false, authError: status === 401 || status === 403, message: String((e && e.message) || e) };
      }
    },

    checkinStatus() {
      return checkin.checkinStatus();
    },

    // 上游没有续期接口：如实回不可用，让账号进「需重新登录」而不是白跑一次刷新
    async refreshToken() {
      return {
        ok: false,
        noRefresh: true,
        message: "KukuAI 的登录态就是百度通行证 Cookie，上游没有续期接口：请在浏览器重新登录后，重新粘贴包含 BDUSS/STOKEN/PTOKEN 的完整 Cookie",
      };
    },
  };
}

module.exports = { makeKuku, CHANNEL };

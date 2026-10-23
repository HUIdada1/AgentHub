/**
 * 外置插件 · 宿主数据桥
 * 把宿主掌握的资源（号池账号、渠道启闭）推送给声明了 manifest.bridge 的插件。
 *
 * 约束：
 *  - 宿主只认 kinds（pool / channels），不认识任何具体插件；
 *  - 插件侧是只读镜像，宿主是唯一真源；
 *  - 只走 127.0.0.1，带插件自己的管理令牌，不写日志、不外传渲染层。
 */
"use strict";
const crypto = require("node:crypto");
const config = require("./config.cjs");
const store = require("./proxy/store.cjs");

let host = null;             // plugin-host 模块（注入，避免循环依赖）
let timer = null;
let revision = 0;
let pushing = false;

/** id -> { lastAt, lastError, imported, removed, revision } */
const statusMap = new Map();
/** id -> 上次推送时的数据签名，用来判断"有没有变" */
const sigMap = new Map();

const POLL_MS = 5000;
const TIMEOUT_MS = 8000;
const RETRY_DELAYS = [1000, 3000, 9000];
const MAX_ACCOUNTS_PER_PUSH = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function init(pluginHost) {
  host = pluginHost;
  if (timer) return;
  // 5 秒一次比对签名：账号增删改、渠道启闭、号池同步导入都会让签名变化。
  // 不用事件钩子是因为写入口分散在 proxy/index.cjs 的十几个 handler 与 poolsync 里，
  // 轮询一个本地 SQLite 的聚合值比到处埋点更可靠，代价可忽略。
  timer = setInterval(() => { schedule("poll"); }, POLL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** 宿主资源快照：账号凭据在落库时是密文，这里解出明文再推（与 proxy_account_export_plain 同源逻辑）
 *  注意必须用 accountRows：listAccounts 给的是脱敏视图，不含 token_enc，解出来是空串。 */
function poolSnapshot() {
  const rows = store.accountRows().slice(0, MAX_ACCOUNTS_PER_PUSH);
  return rows.map((r) => {
    let secrets = { token: "", refreshToken: "", meta: null };
    try { secrets = store.accountSecrets(r) || secrets; } catch { /* 单条解不开不影响其余 */ }
    return {
      id: String(r.id || ""),
      channel: String(r.channel || ""),
      uid: String(r.uid || ""),
      name: String(r.name || ""),
      token: String(secrets.token || ""),
      refreshToken: String(secrets.refreshToken || ""),
      meta: secrets.meta && typeof secrets.meta === "object" ? secrets.meta : {},
      status: String(r.status || "online"),
      expiresAt: Number(r.expires_at) || 0,
    };
  });
}

function channelMap() {
  const cfg = config.loadConfig();
  const map = (cfg && cfg.proxy && cfg.proxy.channelEnabled) || {};
  return map && typeof map === "object" ? map : {};
}

/** 数据签名：只算「会影响转发的内容」——账号身份、凭据密文、过期时间、渠道启闭。
 *  刻意不含 updated_at：store.updateAccount 每次额度刷新、每次代理请求扣减都会推进它，
 *  带上就等于每 5 秒全量重推一次（插件侧要逐账号 upsert，白白烧 CPU 和 SQLite 写）。 */
function signature() {
  let rows = [];
  try { rows = store.accountRows(); } catch { return ""; }
  const parts = rows.map((r) =>
    [r.id, r.channel, r.uid, r.name, r.token_enc, r.refresh_enc, r.expires_at].join("\u0001")
  );
  const ch = channelMap();
  const chSig = Object.keys(ch).sort().map((k) => `${k}=${ch[k] === false ? 0 : 1}`).join(",");
  return crypto.createHash("sha1").update(parts.join("\u0002") + "|" + chSig).digest("hex");
}

function targets() {
  if (!host) return [];
  return host.list().filter((p) => p.installed && !p.invalid && p.running && p.compatible
    && p.ui && p.ui.url && p.bridgeKinds && p.bridgeKinds.length);
}

async function postOnce(plugin, body) {
  const url = new URL(plugin.bridgeUrl, plugin.ui.url).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${plugin.token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应按状态码判 */ }
  if (!res.ok) throw new Error((data && data.message) || `HTTP ${res.status}`);
  return data || {};
}

async function pushOne(plugin, sig) {
  const kinds = plugin.bridgeKinds;
  const body = { revision: ++revision, kinds: {} };
  try {
    if (kinds.includes("pool")) body.kinds.pool = { accounts: poolSnapshot() };
    if (kinds.includes("channels")) body.kinds.channels = { enabled: channelMap() };
  } catch (e) {
    statusMap.set(plugin.id, {
      lastAt: (statusMap.get(plugin.id) || {}).lastAt || 0,
      lastError: String((e && e.message) || e), imported: 0, removed: 0, revision: body.revision,
    });
    return false;
  }

  let lastErr = "";
  for (let i = 0; i <= RETRY_DELAYS.length; i++) {
    try {
      const r = await postOnce(plugin, body);
      sigMap.set(plugin.id, sig);
      statusMap.set(plugin.id, {
        lastAt: Date.now(), lastError: "", imported: Number(r.imported) || 0,
        removed: Number(r.removed) || 0, revision: body.revision,
      });
      return true;
    } catch (e) {
      lastErr = String((e && e.message) || e);
      if (i < RETRY_DELAYS.length) await sleep(RETRY_DELAYS[i]);
    }
  }
  statusMap.set(plugin.id, {
    lastAt: (statusMap.get(plugin.id) || {}).lastAt || 0,
    lastError: lastErr, imported: 0, removed: 0, revision: body.revision,
  });
  return false;
}

/** 立即比对并推送（默认节流在调用侧，poll 每 5 秒一次） */
async function schedule(reason) {
  if (pushing || !host) return;
  pushing = true;
  try {
    const list = targets();
    if (!list.length) return;
    const sig = signature();
    for (const p of list) {
      if (reason !== "force" && sigMap.get(p.id) === sig) continue;
      const full = {
        ...p,
        bridgeUrl: (host.bridgeOf(p.id) || {}).url || "",
        token: host.tokenOf(p.id),
      };
      if (!full.bridgeUrl || !full.token) continue;
      await pushOne(full, sig);
    }
  } catch { /* 桥接失败不影响宿主 */ } finally {
    pushing = false;
  }
}

/** 手动「立即同步」：忽略签名，强制推一次 */
async function pushNow(id) {
  if (!host) return { ok: false, message: "未初始化" };
  const p = targets().find((x) => x.id === id);
  if (!p) return { ok: false, message: "插件未运行或不支持同步" };
  const full = { ...p, bridgeUrl: (host.bridgeOf(id) || {}).url || "", token: host.tokenOf(id) };
  if (!full.bridgeUrl || !full.token) return { ok: false, message: "插件未声明桥接地址" };
  const ok = await pushOne(full, signature());
  const st = statusMap.get(id) || {};
  return ok ? { ok: true, imported: st.imported, removed: st.removed } : { ok: false, message: st.lastError || "推送失败" };
}

function status(id) {
  const s = statusMap.get(id);
  if (!s) return null;
  return { lastAt: s.lastAt, lastError: s.lastError, imported: s.imported, removed: s.removed };
}

module.exports = { init, stop, schedule, pushNow, status, poolSnapshot, channelMap, signature };

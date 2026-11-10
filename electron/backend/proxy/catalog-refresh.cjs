"use strict";
// Management operation only. Refreshing a catalog never grants execution access.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function createCatalogRefresh({ store, management, rules, ensureFreshSecrets, now = Date.now }) {
  const pending = new Map();
  function stamp(row) {
    return JSON.stringify([row.id, row.channel, row.uid, row.token_enc, row.refresh_enc, row.meta, row.token_at]);
  }
  function entries(adapter, channel, result) {
    const rows = Array.isArray(result?.models) && result.models.every(m => m && typeof m === "object")
      ? result.models : typeof adapter.modelEntries === "function" ? adapter.modelEntries()
        : (rules.get("catalog.json")?.[channel]?.models || adapter.models().map(id => ({ id })));
    if (!Array.isArray(rows) || !rows.length || rows.length > 4096) throw new Error("CATALOG_EMPTY");
    const seen = new Set();
    return rows.filter(row => {
      if (!row || typeof row.id !== "string" || !row.id.trim() || row.id.length > 160 || /[\x00-\x1f\x7f]/.test(row.id)) throw new Error("CATALOG_INVALID");
      const key = row.id.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  function persist(channel, models) {
    // Read/merge/write synchronously so parallel channels cannot overwrite each other.
    const file = path.join(rules.rulesDir(), "catalog.json");
    let catalog;
    try { catalog = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; catalog = structuredClone(rules.get("catalog.json") || {}); }
    if (!catalog || Array.isArray(catalog) || typeof catalog !== "object") throw new Error("CATALOG_INVALID");
    catalog[channel] = { syncedAt: now(), models };
    const body = JSON.stringify(catalog, null, 2);
    if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error("CATALOG_LIMIT");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
    rules.reload("catalog.json");
  }
  async function refreshOne(channel, accountId) {
    const key = JSON.stringify([channel, accountId || ""]);
    // A single channel owns its refresh; a different explicit account waits its turn.
    const running = pending.get(channel);
    if (running) {
      if (running.key === key) return running.promise;
      await running.promise;
      return refreshOne(channel, accountId);
    }
    const promise = Promise.resolve().then(async () => {
      const base = { channel, accountId: accountId || null, count: 0, refreshedAt: null };
      try {
        if (store.channelList().find(row => row.id === channel)?.kind !== "builtin") return { ...base, status: "skipped", message: "自定义供应商请在供应商页面拉取并确认导入模型" };
        const adapter = management.get(channel);
        if (typeof adapter?.fetchModels !== "function") return { ...base, status: "skipped", message: "该渠道暂不支持模型目录刷新" };
        let row = accountId ? store.getAccount(accountId) : store.accountRows(channel).find(r => r.status !== "disabled");
        if (accountId && (!row || row.channel !== channel || row.status === "disabled")) {
          return { ...base, status: "failed", code: "INVALID_ACCOUNT", message: "指定账号不存在、已停用或不属于该渠道" };
        }
        // Public catalogs can refresh without adding an account.
        if (!row && !["cline_free", "cline_pass", "lobster"].includes(channel)) return { ...base, status: "skipped", message: "尚无启用账号，请先添加账号" };
        let secrets = row ? store.accountSecrets(row) : {};
        if (row) {
          base.accountId = row.id;
          const before = stamp(row), previous = secrets;
          const view = { ...row, meta: secrets.meta || {} };
          secrets = typeof adapter.ensureForwardCredentials === "function"
            ? await adapter.ensureForwardCredentials(view, secrets) : await ensureFreshSecrets(view, secrets);
          const live = store.getAccount(row.id);
          if (!secrets || !live || live.channel !== channel || live.uid !== row.uid || live.status === "disabled") throw new Error("ACCOUNT_CHANGED");
          if (stamp(live) !== before) {
            const current = store.accountSecrets(live);
            if (current.token !== secrets.token || current.refreshToken !== secrets.refreshToken
              || JSON.stringify(current.meta) !== JSON.stringify(previous.meta)) throw new Error("ACCOUNT_CHANGED");
          }
          // The existing refresh service may have persisted a rotated credential.
          row = live;
        }
        const original = row && stamp(row);
        const assertCurrent = () => {
          if (!row) return;
          const live = store.getAccount(row.id);
          if (!live || live.status === "disabled" || stamp(live) !== original) throw new Error("ACCOUNT_CHANGED");
        };
        const result = await adapter.fetchModels(row ? { ...row, meta: secrets.meta || {} } : {}, secrets, { force: true, deferPersist: true, assertCurrent });
        assertCurrent();
        if (!result?.ok) return { ...base, status: "failed", code: result?.authError ? "AUTH_REQUIRED" : "UPSTREAM_FAILED", message: result?.authError ? "登录态失效，请重新登录" : "上游目录获取失败，已保留原目录" };
        if (result.skipped) return { ...base, status: "skipped", message: "上游未刷新，已保留原目录" };
        const models = entries(adapter, channel, result);
        assertCurrent();
        persist(channel, models);
        return { ...base, status: "refreshed", count: models.length, refreshedAt: now(), partial: result.partial === true,
          message: result.partial ? "部分目录源未返回，当前清单可能不完整，请稍后重试" : "模型目录已更新" };
      } catch (error) {
        // Do not echo upstream bodies, URLs or credential-bearing exception text to UI.
        const changed = error.message === "ACCOUNT_CHANGED";
        return { ...base, status: "failed", code: changed ? "ACCOUNT_CHANGED" : "REFRESH_FAILED", message: changed ? "刷新期间账号已变化，请重试" : "刷新未完成，已保留原目录；请检查登录态、网络与目录文件权限" };
      }
    });
    pending.set(channel, { key, promise });
    try { return await promise; }
    finally { if (pending.get(channel)?.promise === promise) pending.delete(channel); }
  }
  async function refresh(options = {}) {
    const allChannels = store.channelList();
    const available = allChannels.map(row => row.id);
    const channels = options.channels === undefined ? allChannels.filter(row => row.kind === "builtin").map(row => row.id) : options.channels;
    const accounts = options.accounts || {};
    if (!Array.isArray(channels) || channels.length > 256 || channels.some(ch => typeof ch !== "string" || !available.includes(ch))
      || !accounts || typeof accounts !== "object" || Array.isArray(accounts)
      || Object.entries(accounts).some(([ch, id]) => !channels.includes(ch) || typeof id !== "string" || !id || id.length > 160)) throw new TypeError("无效的渠道或账号范围");
    const unique = [...new Set(channels)], results = new Array(unique.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, unique.length) }, async () => {
      while (cursor < unique.length) { const index = cursor++; results[index] = await refreshOne(unique[index], accounts[unique[index]]); }
    }));
    return { results, summary: Object.fromEntries(["refreshed", "skipped", "failed"].map(status => [status, results.filter(r => r.status === status).length])) };
  }
  return { refresh };
}
let singleton;
module.exports = { createCatalogRefresh, refresh(options) {
  singleton ||= createCatalogRefresh({ store: require("./store.cjs"), management: require("./management-adapters.cjs"), rules: require("./rules.cjs"), ensureFreshSecrets: require("./credits.cjs").ensureFreshSecrets });
  return singleton.refresh(options);
} };

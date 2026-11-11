"use strict";
// Executable model facts only: standard supplier configuration or an authorized
// live plugin listModels. No management registry or private model implementation.
const { createHash, randomUUID } = require("node:crypto");
const { compatModelEntries, providerCatalogMap } = require("./standard/openai-compat.cjs");
const { finiteRate } = require("../proxy/util.cjs");
const { authority } = require("../extensions/authority-watch.cjs");
const refKey = ref => ref && JSON.stringify([ref.kind, ref.providerId, ref.pluginId, ref.publisherId, ref.channel]);
const sameRef = (a, b) => refKey(a) === refKey(b);
const denied = code => Object.assign(new Error("模型目录当前不可用"), { code, status: 503 });
const lower = value => String(value || "").toLowerCase();

function normalizeModels(models) {
  if (!Array.isArray(models) || models.length > 4096 || Buffer.byteLength(JSON.stringify(models)) > 2 * 1024 * 1024) throw denied("CATALOG_LIMIT");
  const seen = new Set();
  return models.flatMap(model => {
    if (!model || typeof model.id !== "string" || !model.id.trim() || model.id.length > 160 || /[\x00-\x1f]/.test(model.id)) throw denied("CATALOG_INVALID");
    if (seen.has(lower(model.id))) return [];
    seen.add(lower(model.id));
    const limit = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const capabilities = {};
    for (const [key, value] of Object.entries(model.capabilities || {})) {
      if (["images", "tools", "reasoning", "audio", "video", "pdf"].includes(key) && typeof value === "boolean") capabilities[key] = value;
    }
    // Routing details belong to the provider plugin. Keep a bounded opaque
    // JSON value so protocol-specific identifiers survive catalog caching.
    const normalizeRouting = (value, depth = 0) => {
      if (depth > 3) throw denied("CATALOG_INVALID");
      if (value === null || typeof value === "boolean") return value;
      if (typeof value === "string") {
        if (value.length > 512) throw denied("CATALOG_INVALID");
        return value;
      }
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw denied("CATALOG_INVALID");
        return value;
      }
      if (Array.isArray(value)) {
        if (value.length > 64) throw denied("CATALOG_INVALID");
        return value.map(item => normalizeRouting(item, depth + 1));
      }
      if (value && Object.getPrototypeOf(value) === Object.prototype) {
        const entries = Object.entries(value);
        if (entries.length > 32 || entries.some(([key]) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key))) throw denied("CATALOG_INVALID");
        return Object.fromEntries(entries.map(([key, item]) => [key, normalizeRouting(item, depth + 1)]));
      }
      throw denied("CATALOG_INVALID");
    };
    return [{ id: model.id, name: typeof model.name === "string" ? model.name.slice(0, 256) : model.id,
      rate: finiteRate(model.rate), capabilities, contextLength: limit(model.contextLength), maxOutputTokens: limit(model.maxOutputTokens),
      ...(model.routing !== undefined ? { routing: normalizeRouting(model.routing) } : {}) }];
  });
}

function createModelCatalog({ services, store, pool, getProxy, now = Date.now, ttlMs = 60000, maxEntries = 128, maxBytes = 16 * 1024 * 1024,
  refreshMs = 10000, batchSize = 64, concurrency = 4, maxPreparations = 8, snapshotBytes = 16 * 1024 * 1024, history } = {}) {
  for (const value of [ttlMs, maxEntries, maxBytes, refreshMs, batchSize, concurrency, maxPreparations, snapshotBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid catalog resource limit");
  }
  if (concurrency > 32 || batchSize > 1024 || maxPreparations > 32) throw new TypeError("Invalid catalog concurrency limit");
  // Entries are source/audience groups, not accounts. A 1000-account source
  // must not silently turn into its last 128 accounts during one preparation.
  const cache = new Map(), pending = new Map(), cursors = new Map(), revisions = new Map();
  let bytes = 0, preparations = 0;
  function contextFor(options = {}) {
    const context = { audience: "admin", authorizeChannel: () => true, authorizeAccount: () => true, authorizationVersion: "", ...options };
    if (typeof context.audience !== "string" || !context.audience || context.audience.length > 256
      || typeof context.authorizationVersion !== "string" || context.authorizationVersion.length > 2048
      || typeof context.authorizeChannel !== "function" || typeof context.authorizeAccount !== "function"
      || context.channels !== undefined && (!Array.isArray(context.channels) || context.channels.length > 256 || context.channels.some(id => typeof id !== "string" || id.length > 160))) {
      throw denied("CATALOG_CONTEXT_INVALID");
    }
    return context;
  }
  function allowed(context, channel) {
    try { return (!context.channels || context.channels.includes(channel)) && context.authorizeChannel(channel) === true; }
    catch { return false; }
  }
  function accountAllowed(context, accountId) {
    try { return context.authorizeAccount(accountId) === true; } catch { return false; }
  }
  function stamp(accountId) {
    const account = store.getAccount(accountId);
    if (!account || account.status === "disabled") throw denied("CATALOG_ACCOUNT_UNAVAILABLE");
    // Hash encrypted storage fields; do not decrypt credentials merely to key a cache.
    // Usage/cooldown writes update the row too; they must not turn a known model
    // into an unknown model or force another credential read. Identity and
    // credential replacement invalidate; disabled/deleted accounts fail above.
    return createHash("sha256").update(JSON.stringify([account.id, account.channel, account.uid,
      account.token_enc, account.refresh_enc, account.meta, account.token_at])).digest("hex");
  }
  function keyFor(context, captured, accountId, accountStamp) {
    return JSON.stringify([context.audience, context.authorizationVersion, refKey(captured.ref), captured.identity, captured.version, captured.catalogMode,
      captured.catalogRevision ?? revisions.get(captured.ref.channel) ?? 0, accountId, accountStamp]);
  }
  function current(context, captured, accountId, accountStamp) {
    if (captured.catalogRevision !== undefined && captured.catalogRevision !== (revisions.get(captured.ref.channel) || 0)) throw denied("CATALOG_CHANGED");
    if (!allowed(context, captured.ref.channel) || !sameRef(services.refFor(captured.ref.channel), captured.ref)) throw denied("CATALOG_AUTH_CHANGED");
    captured.assertCurrent();
    if (accountId && (!accountAllowed(context, accountId) || stamp(accountId) !== accountStamp)) throw denied("CATALOG_ACCOUNT_CHANGED");
  }
  function remember(groupKey, entry) {
    let group = cache.get(groupKey);
    if (group) cache.delete(groupKey);
    else group = { entries: new Map(), bytes: 0 };
    const accountKey = entry.accountId || "";
    const previous = group.entries.get(accountKey);
    if (previous) { bytes -= previous.bytes; group.bytes -= previous.bytes; }
    group.entries.set(accountKey, entry); group.bytes += entry.bytes; bytes += entry.bytes;
    cache.set(groupKey, group);
    while (cache.size > maxEntries || bytes > maxBytes) {
      const oldest = cache.keys().next().value;
      bytes -= cache.get(oldest).bytes; cache.delete(oldest);
    }
  }
  function advanceCursor(key, offset) {
    cursors.delete(key); cursors.set(key, offset);
    while (cursors.size > maxEntries) cursors.delete(cursors.keys().next().value);
  }
  async function waitFor(task, signal) {
    task.waiters++;
    let abort;
    try {
      signal?.throwIfAborted();
      if (!signal) return await task.promise;
      return await Promise.race([task.promise, new Promise((_, reject) => {
        abort = () => reject(signal.reason || denied("CATALOG_CANCELLED"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
      if (--task.waiters === 0 && !task.done) {
        if (pending.get(task.key) === task) pending.delete(task.key);
        task.controller.abort(denied("CATALOG_CANCELLED"));
      }
    }
  }
  async function refreshSource(context, source, accountId) {
    const channel = source.channel;
    if (!allowed(context, channel)) return;
    const captured = { ...services.check(channel, () => allowed(context, channel) && (!accountId || accountAllowed(context, accountId))), catalogRevision: revisions.get(channel) || 0 };
    if (captured.ref.kind !== "extension") return;
    const accountStamp = accountId ? stamp(accountId) : undefined;
    if (captured.catalogMode !== "public" && !accountId) throw denied("NO_CATALOG_ACCOUNT");
    current(context, captured, accountId, accountStamp);
    const key = keyFor(context, captured, accountId, accountStamp);
    const groupKey = keyFor(context, captured);
    const existing = cache.get(groupKey)?.entries.get(accountId || "");
    if (!context.force && existing?.key === key && existing.expiresAt > now()) { current(context, captured, accountId, accountStamp); return existing; }
    let task = pending.get(key);
    if (!task) {
      if (pending.size >= 32) throw denied("CATALOG_BUSY");
      task = { key, channel, controller: new AbortController(), waiters: 0, done: false };
      const owner = task;
      // Register before any work: a synchronous source/grant failure must not
      // leave an already-completed owner permanently installed in pending.
      pending.set(key, owner);
      owner.promise = Promise.resolve().then(async () => {
        let grant, releaseAuthority, grantAbort;
        const deadlineAt = Date.now() + refreshMs;
        const timer = setTimeout(() => owner.controller.abort(denied("CATALOG_TIMEOUT")), refreshMs);
        try {
          owner.controller.signal.throwIfAborted();
          current(context, captured, accountId, accountStamp);
          if (accountId) grant = captured.open({ accountId, purpose: "catalog", invocationId: randomUUID(), deadlineAt, network: context.force === true });
          releaseAuthority = authority.watch({ controller: owner.controller, tags: { channel, accountId }, check() {
            current(context, captured, accountId, accountStamp);
            return true;
          } });
          grantAbort = () => owner.controller.abort(grant.signal.reason);
          grant?.signal?.addEventListener("abort", grantAbort, { once: true });
          if (grant?.signal?.aborted) grantAbort();
          owner.controller.signal.throwIfAborted();
          const result = await waitFor({ waiters: 0, done: true,
            promise: captured.session.listModels({ providerId: captured.ref.providerId, channel,
              grantId: grant?.grantId, invocationId: grant?.invocationId, force: context.force === true, signal: owner.controller.signal }) }, owner.controller.signal);
          owner.controller.signal.throwIfAborted();
          current(context, captured, accountId, accountStamp);
          const models = normalizeModels(result);
          const entry = { key, audience: context.audience, authorizationVersion: context.authorizationVersion, ref: captured.ref, captured, accountId, accountStamp, models,
            bytes: Buffer.byteLength(JSON.stringify([key, models])), expiresAt: now() + ttlMs };
          remember(groupKey, entry);
          history?.remember(entry);
          return entry;
        } finally {
          clearTimeout(timer);
          releaseAuthority?.();
          grant?.signal?.removeEventListener("abort", grantAbort);
          try { grant?.close(); }
          finally { owner.done = true; if (pending.get(key) === owner) pending.delete(key); }
        }
      });
      owner.promise.catch(() => {});
    }
    const entry = await waitFor(task, context.signal);
    current(context, captured, accountId, accountStamp);
    return entry;
  }
  async function prepare(options) {
    const context = contextFor(options);
    const callerSignal = context.signal;
    callerSignal?.throwIfAborted();
    const budget = new AbortController();
    context.signal = callerSignal ? AbortSignal.any([callerSignal, budget.signal]) : budget.signal;
    const errors = [], prepared = new Map(), plans = [];
    const counts = { examinedAccounts: 0, totalAccounts: 0, examinedSources: 0, totalSources: 0, refreshedSources: 0, refreshedByChannel: {} };
    let retainedBytes = 0, cursor = 0, stopped = false;
    function recordError(channel, code) {
      const prior = errors.find(error => error.channel === channel && error.code === code);
      if (prior) { prior.count++; return; }
      if (errors.length < 64) errors.push({ ...(channel ? { channel } : {}), code, count: 1 });
      else {
        const overflow = errors.find(error => error.code === "CATALOG_DIAGNOSTIC_LIMIT");
        if (overflow) overflow.count++;
        else errors.push({ code: "CATALOG_DIAGNOSTIC_LIMIT", count: 1 });
      }
    }
    function result() {
      history?.flush();
      return view(context, errors, prepared, { ...counts, complete: errors.length === 0 && !stopped
        && counts.totalAccounts === counts.examinedAccounts && counts.totalSources === counts.examinedSources,
        pendingAccounts: counts.totalAccounts - counts.examinedAccounts,
        pendingSources: counts.totalSources - counts.examinedSources });
    }
    // Bound request-retained snapshots separately from the shared cache and
    // pending RPCs. Saturation still exposes standard providers and diagnostics.
    if (preparations >= maxPreparations) { recordError(undefined, "CATALOG_BUSY"); return result(); }
    preparations++;
    const timer = setTimeout(() => budget.abort(denied("CATALOG_TIMEOUT")), refreshMs);
    try {
      for (const source of services.list()) {
        if (!source.selected || source.ref?.kind !== "extension" || !allowed(context, source.channel)) continue;
        let counted = false;
        try {
          if (!source.ready) throw denied("CATALOG_SOURCE_UNAVAILABLE");
          const captured = services.check(source.channel, () => allowed(context, source.channel));
          if (captured.catalogMode === "public") {
            counts.totalSources++;
            counted = true;
            plans.push({ source, remaining: 1 });
          }
          else {
            captured.assertPurpose?.("catalog");
            // Entitlements belong to individual accounts, never the first account
            // projected onto an entire channel. Read-only planning preserves use order.
            const rows = pool.accountPlan(source.channel, undefined, [], 0, "");
            const eligible = rows.reduce((count, row) => count + (row.eligible && accountAllowed(context, row.account.id) ? 1 : 0), 0);
            // No usable account means there is no account-scoped catalog to
            // read. Installed plugins declare every channel they can serve,
            // so counting those as "incomplete" would make every snapshot
            // permanently incomplete for users who only have a few accounts.
            if (!eligible) continue;
            counts.totalSources++;
            counted = true;
            counts.totalAccounts += eligible;
            const key = keyFor(context, captured);
            plans.push({ source, rows, remaining: rows.length, key, offset: (cursors.get(key) || 0) % rows.length, eligible });
          }
        } catch (error) {
          if (!counted) counts.totalSources++;
          recordError(source.channel, error.code || "CATALOG_FAILED");
        }
      }
      function nextCandidate() {
        for (let attempts = 0; attempts < plans.length; attempts++) {
          const plan = plans[cursor++ % plans.length];
          while (plan.remaining > 0) {
            plan.remaining--;
            if (!plan.rows) return { source: plan.source, plan };
            const row = plan.rows[plan.offset];
            plan.offset = (plan.offset + 1) % plan.rows.length;
            if (row.eligible && accountAllowed(context, row.account.id)) return { source: plan.source, accountId: row.account.id, plan, nextOffset: plan.offset };
          }
        }
      }
      let batch = [], batchCursor = 0;
      function next() {
        if (stopped || context.signal.aborted) return;
        if (batchCursor >= batch.length) {
          batch = []; batchCursor = 0;
          while (batch.length < batchSize) { const candidate = nextCandidate(); if (!candidate) break; batch.push(candidate); }
        }
        return batch[batchCursor++];
      }
      async function worker() {
        let candidate;
        while ((candidate = next())) {
          context.signal?.throwIfAborted();
          const { source, accountId, plan } = candidate;
          // Commit progress only when work starts, not when a batch is prefetched.
          // Otherwise repeated timeouts could permanently skip queued accounts.
          if (accountId) advanceCursor(plan.key, candidate.nextOffset);
          if (accountId) counts.examinedAccounts++;
          // A source is examined once every planned account (or its public
          // lookup) was visited; failures still make completeness false.
          plan.examined = (plan.examined || 0) + 1;
          if (plan.examined === (plan.eligible || 1)) counts.examinedSources++;
          try {
            const entry = await refreshSource(context, source, accountId);
            counts.refreshedSources++;
            counts.refreshedByChannel[source.channel] = (counts.refreshedByChannel[source.channel] || 0) + 1;
            if (entry && !prepared.has(entry.key)) {
              if (retainedBytes + entry.bytes > snapshotBytes) { stopped = true; recordError(source.channel, "CATALOG_SNAPSHOT_LIMIT"); }
              else { prepared.set(entry.key, entry); retainedBytes += entry.bytes; }
            }
          } catch (error) { recordError(source.channel, error.code || "CATALOG_FAILED"); }
        }
      }
      const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, batchSize) }, worker));
      callerSignal?.throwIfAborted();
      for (const worker of workers) if (worker.status === "rejected" && !budget.signal.aborted) throw worker.reason;
      if (budget.signal.aborted) { stopped = true; recordError(undefined, "CATALOG_TIMEOUT"); }
      return result();
    } finally { clearTimeout(timer); preparations--; }
  }
  async function refresh(options = {}) {
    const sourcesList = services.list();
    const providers = store.listProviders().map(row => row.id);
    const available = [...new Set([
      ...store.channelList().map(row => row.id),
      ...providers,
      ...sourcesList.map(source => source.channel),
    ])];
    const requested = options.channels === undefined ? available : options.channels;
    if (!Array.isArray(requested) || requested.length > 256 || requested.some(channel => typeof channel !== "string" || !available.includes(channel))) {
      throw denied("CATALOG_CONTEXT_INVALID");
    }
    const channels = [...new Set(requested)];
    const sources = new Map();
    for (const source of sourcesList) {
      if (!channels.includes(source.channel) || source.ref?.kind !== "extension") continue;
      // Several installed plugins can advertise the same channel. A later
      // unselected candidate must not hide the source that actually executes.
      if (!sources.has(source.channel) || source.selected) sources.set(source.channel, source);
    }
    const ready = channels.filter(channel => { const source = sources.get(channel); return source?.selected && source.ready && source.modelRefresh !== false; });
    const catalog = ready.length ? await prepare({ ...options, channels: ready, force: true }) : view(contextFor({ ...options, channels: [] }));
    const results = channels.map(channel => {
      const source = sources.get(channel);
      const base = { channel, accountId: null, count: 0, refreshedAt: null };
      // hint 只给前端决定「下一步该去哪」：provider = 自定义供应商页，plugin = 插件管理。
      // 文案仍由后端给（前端不重复维护一套原因表）。
      if (providers.includes(channel)) return { ...base, status: "skipped", hint: "provider", message: "自定义供应商请在供应商设置中拉取并确认模型" };
      if (!store.channelList().some(row => row.id === channel)) return { ...base, status: "skipped", message: "该渠道来源已不可用，未执行刷新" };
      if (!source?.selected || source.ref?.kind !== "extension") return { ...base, status: "skipped", hint: "plugin", message: "未绑定已授权的模型执行插件：插件未启用、未授权，或未在插件「设置」里固定该渠道" };
      if (!source.ready) return { ...base, status: "skipped", hint: "plugin", message: "执行插件未就绪，请检查插件状态" };
      if (source.modelRefresh === false) return { ...base, status: "skipped", message: "该插件声明为固定模型目录，无需远程刷新" };
      const count = catalog.channelModelIds(channel).length;
      const failures = catalog.errors.filter(error => !error.channel || error.channel === channel);
      const successfulSources = catalog.completeness.refreshedByChannel?.[channel] || 0;
      // Account-mode catalogs need a usable account. prepare() silently omits
      // such sources (they are not directory failures), so report a skip here
      // instead of claiming the upstream refresh failed.
      if (!failures.length && !successfulSources) return { ...base, status: "skipped", message: "该渠道在号池里没有可用账号，暂无可拉取的目录" };
      if (failures.length && successfulSources > 0 && count) return { ...base, status: "refreshed", count, refreshedAt: now(), partial: true, message: "部分账号目录刷新失败，已保留可用模型" };
      if (failures.length || !count || !successfulSources) return { ...base, status: "failed", code: failures[0]?.code || "CATALOG_EMPTY", message: "插件目录刷新失败或未返回模型，已保留此前目录" };
      return { ...base, status: "refreshed", count, refreshedAt: now(), message: "插件模型目录已更新" };
    });
    const summary = Object.fromEntries(["refreshed", "skipped", "failed"].map(status => [status, results.filter(row => row.status === status).length]));
    return { results, summary };
  }
  function view(options, errors = [], prepared, completeness = { complete: false, examinedAccounts: 0, totalAccounts: 0, pendingAccounts: 0, examinedSources: 0, totalSources: 0, pendingSources: 0, refreshedSources: 0, refreshedByChannel: {} }) {
    const context = contextFor(options), records = new Map(), historical = new Map();
    // These names only distinguish known-unavailable from unknown after restart.
    // They never populate records or model/account execution entitlements.
    // History is flattened once per view instead of once per model lookup:
    // re-expanding entries() (up to 4096 rows) per model made catalog listing
    // O(models × history). Index is lower(model) -> distinct channels.
    const persistedIndex = new Map();
    for (const entry of history?.entries(context) || []) {
      const channel = entry.ref.channel;
      try {
        if (!allowed(context, channel) || !sameRef(services.refFor(channel), entry.ref)) continue;
        if (entry.accountId) {
          const account = store.getAccount(entry.accountId);
          if (!account || account.channel !== channel || account.status === "disabled" || !accountAllowed(context, entry.accountId)) continue;
        }
      } catch { /* Invalid pins are not historical authorization either. */ }
      for (const item of entry.models) {
        const key = lower(item.id);
        if (!persistedIndex.has(key)) persistedIndex.set(key, []);
        const rows = persistedIndex.get(key);
        if (!rows.includes(channel)) rows.push(channel);
      }
    }
    for (const provider of store.listProviders()) {
      if (!allowed(context, provider.id) || !provider.enabled) continue;
      try {
        const selected = services.check(provider.id, () => allowed(context, provider.id));
        if (selected.ref.kind !== "custom") continue;
        records.set(provider.id, { kind: "custom", ref: selected.ref, models: compatModelEntries(provider).map(entry => ({ id: entry.client })),
          metadata: providerCatalogMap(provider), version: provider.updatedAt });
      } catch { /* Explicit corrupt pins must not restore implicit standard sources. */ }
    }
    const entries = new Map(prepared);
    let retained = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const group of cache.values()) for (const entry of group.entries.values()) {
      if (entry.audience !== context.audience || entry.authorizationVersion !== context.authorizationVersion || !allowed(context, entry.ref.channel)) continue;
      if (entries.has(entry.key)) continue;
      if (prepared && retained + entry.bytes > snapshotBytes) continue;
      entries.set(entry.key, entry); retained += entry.bytes;
    }
    for (const entry of entries.values()) {
      const channel = entry.ref.channel;
      if (entry.audience !== context.audience || entry.authorizationVersion !== context.authorizationVersion || !allowed(context, channel)) continue;
      try {
        if (!sameRef(services.refFor(channel), entry.ref)) continue;
        if (entry.accountId && (!accountAllowed(context, entry.accountId) || stamp(entry.accountId) !== entry.accountStamp)) continue;
        if (!historical.has(channel)) historical.set(channel, []);
        historical.get(channel).push(...entry.models);
        if (entry.expiresAt <= now()) continue;
        current(context, entry.captured, entry.accountId, entry.accountStamp);
        if (!records.has(channel)) records.set(channel, { kind: "extension", ref: entry.ref, entries: [] });
        records.get(channel).entries.push(entry);
      } catch { /* A stale/old-generation catalog is history, never executable proof. */ }
    }
    return createView({ records, historical, persistedIndex, context, errors, completeness, historyWarning: history?.diagnostics() || null, proxy: getProxy(),
      valid(channel) {
        const record = records.get(channel);
        if (!record || !allowed(context, channel)) return false;
        try {
          if (record.kind === "extension") return record.entries.some(entry => entryValid(entry));
          else {
            const provider = store.getProvider(channel);
            if (!provider?.enabled || provider.updatedAt !== record.version || !sameRef(services.refFor(channel), record.ref)) return false;
          }
          return true;
        } catch { return false; }
      },
      entryValid, accountIds: channel => pool.accountPlan(channel, undefined, [], 0, "").map(row => row.account.id)
    });
    function entryValid(entry) {
      try { if (entry.expiresAt <= now()) return false; current(context, entry.captured, entry.accountId, entry.accountStamp); return true; }
      catch { return false; }
    }
  }
  function invalidate(channels) {
    if (!Array.isArray(channels) || channels.length > 256 || channels.some(channel => typeof channel !== "string" || !channel || channel.length > 160)) throw denied("CATALOG_CONTEXT_INVALID");
    const selected = new Set(channels);
    for (const channel of selected) revisions.set(channel, (revisions.get(channel) || 0) + 1);
    for (const [key, group] of cache) if ([...group.entries.values()].some(entry => selected.has(entry.ref.channel))) {
      cache.delete(key); bytes -= group.bytes;
    }
    for (const task of pending.values()) if (selected.has(task.channel)) task.controller.abort(denied("CATALOG_CHANGED"));
  }
  return Object.freeze({ prepare, refresh, view, invalidate, get cacheSize() { return cache.size; }, get cacheBytes() { return bytes; }, get pendingCount() { return pending.size; }, get preparingCount() { return preparations; } });
}

function createView({ records, historical, persistedIndex, context, errors, completeness, historyWarning, proxy, valid, entryValid, accountIds }) {
  // Index once, but revalidate the owner whenever a held view is used. Resolving
  // 1000 distinct models must not re-read all 1000 accounts for every model.
  for (const record of records.values()) {
    record.modelIndex = new Map();
    if (record.kind !== "extension") continue;
    for (const entry of record.entries) for (const model of entry.models) {
      const key = lower(model.id);
      if (!record.modelIndex.has(key)) record.modelIndex.set(key, []);
      record.modelIndex.get(key).push({ model, entry });
    }
  }
  const enabled = channel => {
    try { return proxy.channelEnabled?.[channel] !== false && (!context.channels || context.channels.includes(channel)) && context.authorizeChannel(channel) === true; }
    catch { return false; }
  };
  function modelsFor(channel) {
    const record = records.get(channel);
    return !valid(channel) ? [] : record.kind === "custom" ? record.models : record.entries.filter(entryValid).flatMap(entry => entry.models);
  }
  function modelFor(channel, model) {
    if (!valid(channel)) return null;
    const record = records.get(channel);
    if (record.kind === "custom") return record.models.find(entry => lower(entry.id) === lower(model));
    const candidates = (record.modelIndex.get(lower(model)) || []).filter(item => entryValid(item.entry));
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0].model;

    // Account catalogs can legitimately disagree. Do not let refresh order pick
    // a random price/capability/context limit for the merged channel model.
    const models = candidates.map(item => item.model);
    const common = key => {
      const values = models.map(item => item[key]);
      if (values.some(value => value === undefined || value === null) || values.some(value => value !== values[0])) return undefined;
      return values[0];
    };
    const capabilities = {};
    for (const capability of ["images", "tools", "reasoning", "audio", "video"]) {
      const values = models.map(item => item.capabilities?.[capability]);
      if (values.every(value => value === true)) capabilities[capability] = true;
      else if (values.some(value => value === false)) capabilities[capability] = false;
    }
    const conservativeLimit = key => {
      const values = models.map(item => Number(item[key]));
      if (values.some(value => !Number.isSafeInteger(value) || value <= 0)) return 0;
      return Math.min(...values);
    };
    return {
      id: models[0].id,
      name: common("name") || models[0].id,
      rate: common("rate"),
      capabilities,
      contextLength: conservativeLimit("contextLength"),
      maxOutputTokens: conservativeLimit("maxOutputTokens"),
    };
  }
  function nativeModel(channel, model) { return !!modelFor(channel, model); }
  function reverseAliasEntry(model) {
    return Object.entries(proxy.modelReverseAliases || {}).find(([key, value]) => lower(key) === lower(model) && value && typeof value === "object")?.[1] || null;
  }
  function resolveModelTarget(model, channel) {
    if (!valid(channel)) return null;
    if (records.get(channel).kind === "custom" && lower(model).startsWith(lower(channel) + "/")) model = model.slice(channel.length + 1);
    const entry = reverseAliasEntry(model);
    if (entry && Object.hasOwn(entry, channel)) {
      const target = typeof entry[channel] === "string" ? entry[channel].trim() : "";
      return target && (lower(target) !== lower(model) || nativeModel(channel, target)) ? target : null;
    }
    return modelFor(channel, model)?.id || null;
  }
  function modelMetadata(model, channel) {
    const record = records.get(channel), meta = valid(channel) && (record.kind === "custom" ? record.metadata.get(lower(model)) : modelFor(channel, model));
    return { rate: finiteRate(meta?.rate), capabilities: meta?.capabilities || {}, contextLength: meta?.contextLength || 0,
      maxOutputTokens: meta?.maxOutputTokens || 0, metadataScope: "binding", rateSource: record?.kind === "custom" ? "provider-config" : "catalog" };
  }
  function mergedModels() {
    const merged = new Map();
    function add(id, channel) {
      const key = lower(id);
      if (!merged.has(key)) merged.set(key, { id, sources: [] });
      const entry = merged.get(key);
      if (!entry.sources.includes(channel)) entry.sources.push(channel);
    }
    for (const [channel, record] of records) {
      if (!valid(channel) || !enabled(channel)) continue;
      for (const model of modelsFor(channel)) add(record.kind === "custom" ? `${channel}/${model.id}` : model.id, channel);
    }
    for (const [name, mappings] of Object.entries(proxy.modelReverseAliases || {})) {
      if (!mappings || typeof mappings !== "object") continue;
      for (const channel of Object.keys(mappings)) if (enabled(channel) && resolveModelTarget(name, channel)) add(name, channel);
    }
    return [...merged.values()];
  }
  function historicalBindings(model) {
    const result = [];
    for (const [channel, entries] of historical) {
      if (enabled(channel) && !nativeModel(channel, model) && entries.some(entry => lower(entry.id) === lower(model))) result.push({ channel, realModel: model });
    }
    for (const channel of persistedIndex?.get(lower(model)) || []) {
      if (enabled(channel) && !nativeModel(channel, model) && !result.some(item => item.channel === channel)) result.push({ channel, realModel: model });
    }
    return result;
  }
  return Object.freeze({ errors, completeness: Object.freeze(completeness), historyWarning,
    channelOn: enabled, resolveModelTarget, modelMetadata, mergedModels, historicalBindings,
    channelModelIds: channel => [...new Set(modelsFor(channel).map(entry => entry.id))],
    accountModels(channel, accountId) {
      const record = records.get(channel);
      if (record?.kind !== "extension") return undefined;
      return record.entries.filter(entry => (!entry.accountId || entry.accountId === accountId) && entryValid(entry))
        .flatMap(entry => entry.models).map(model => structuredClone(model));
    },
    // A known account-specific model may only use the accounts that advertised
    // it. Explicit unlisted user targets retain the original upstream validation.
    excludedAccounts(channel, model) {
      const record = records.get(channel);
      if (record?.kind !== "extension" || !record.entries.some(entry => entry.models.some(item => lower(item.id) === lower(model)))) return [];
      const entries = record.entries.filter(entryValid);
      if (entries.some(entry => !entry.accountId)) return [];
      const authorized = new Set(entries.filter(entry => entry.models.some(item => lower(item.id) === lower(model))).map(entry => entry.accountId));
      return accountIds(channel).filter(id => !authorized.has(id));
    },
    listableModels: () => mergedModels().filter(entry => !(proxy.disabledModels || []).some(id => lower(id) === lower(entry.id))),
    modelOwners: model => mergedModels().filter(entry => lower(entry.id) === lower(model)).flatMap(entry => entry.sources.filter(channel => records.get(channel)?.kind === "extension")),
    ready: channel => valid(channel),
  });
}
const catalog = createModelCatalog({ services: require("./services.cjs"), store: require("../proxy/store.cjs"), pool: require("../proxy/pool.cjs"),
  history: require("./catalog-history.cjs").createCatalogHistory({ filename: () => require("node:path").join(require("../config.cjs").dataDir(), "localgw-catalog-history.json") }),
  getProxy: () => require("../config.cjs").loadConfig()?.proxy || {} });
module.exports = { prepare: catalog.prepare, refresh: catalog.refresh, view: catalog.view, invalidate: catalog.invalidate, createModelCatalog, normalizeModels,
  get cacheSize() { return catalog.cacheSize; }, get pendingCount() { return catalog.pendingCount; } };

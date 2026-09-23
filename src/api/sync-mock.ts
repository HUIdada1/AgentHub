// 浏览器环境下的 mock 后端：让前端可脱离 Node 后端独立开发/预览 UI。
// 数据风格与 preview.html 保持一致，覆盖所有 IPC command。

function seed(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

const LOCAL_DEVICE = "f454fb59-a1b2-4c3d-9e8f-1234567890ab";

// 软件更新演示状态：有状态流转，浏览器里可预览「检查 → 下载 → 重启安装」完整链路
let mockUpdateStatus: any = {
  status: "available", isPortable: false, currentVersion: "1.0.0", latestVersion: "1.8.0",
  percent: 0, notes: "演示环境：新增应用内自动更新（安装版）\n便携版支持手动更新提示", message: "",
};

const models = [
  { model: "deepseek-v4-pro", provider: "deepseek" },
  { model: "GLM-5.3", provider: "智谱 GLM" },
  { model: "qwen3.7-max", provider: "Qwen" },
  { model: "MiniMax-M3", provider: "MiniMax" },
  { model: "deepseek-v4-flash", provider: "deepseek" },
  { model: "GLM-5-Turbo", provider: "智谱 GLM" },
];

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function genRecords(count: number) {
  const recs: any[] = [];
  for (let i = 0; i < count; i++) {
    const m = models[i % models.length];
    const d = new Date(2026, 8, 4 - (i % 60), Math.floor(8 + seed(i) * 12), Math.floor(seed(i * 2) * 60));
    const source = ["zcode", "codex", "dsh", "workbuddy", "workbuddy-ai", "reasonix", "codebuddy", "qoder", "qoder-cn", "antigravity", "antigravity-ide"][i % 11];
    // Qoder / Antigravity 系官方模型：本地按 credits 额度点计量（与真实口径一致），Antigravity 另有真实输出 token
    const official = source === "qoder" || source === "antigravity" || source === "antigravity-ide";
    const input = official ? 0 : Math.round(8000 + seed(i * 13) * 90000);
    const output = source === "qoder" ? 0 : Math.round(300 + seed(i * 7) * 4000);
    const reasoning = official ? 0 : (seed(i * 5) > 0.4 ? Math.round(seed(i * 9) * 6000) : 0);
    const cacheRead = official ? 0 : Math.round(input * (0.7 + seed(i * 3) * 0.28));
    recs.push({
      id: `${LOCAL_DEVICE}:${source}:${i}`,
      deviceId: LOCAL_DEVICE,
      deviceName: "这台电脑",
      source,
      providerId: official ? (source === "qoder" ? "Qoder" : "Google") : m.provider,
      modelId: source === "qoder" ? "qmodel-38max" : official ? "gemini-3.6-flash" : m.model,
      variant: "max",
      taskType: i % 2 ? "coding" : "chat",
      sessionId: `sess_${i}`,
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: reasoning,
      cacheCreationTokens: 0,
      cacheReadTokens: cacheRead,
      credits: official ? Math.round(seed(i * 17) * 800) / 100 : undefined,
      startedAt: d.getTime(),
      completedAt: d.getTime() + Math.round(seed(i) * 120000),
      status: seed(i * 11) > 0.9 ? "error" : "success",
    });
  }
  return recs;
}

const allRecords = genRecords(240);

function calcTotal(r: any, mode: string): number {
  const credits = r.credits || 0;
  if (mode === "compact") return r.inputTokens + r.outputTokens + credits;
  return r.inputTokens + r.outputTokens + r.reasoningTokens + credits;
}

// mock 价格表（元/$ 每百万 token），与内置默认价格口径一致
const mockPrices: Record<string, { i: number; o: number; cr: number; cur: "CNY" | "USD" }> = {
  "deepseek-v4-pro": { i: 2, o: 8, cr: 0.4, cur: "CNY" },
  "deepseek-v4-flash": { i: 1, o: 4, cr: 0.2, cur: "CNY" },
  "GLM-5.3": { i: 2, o: 8, cr: 0.4, cur: "CNY" },
  "GLM-5-Turbo": { i: 1, o: 4, cr: 0.2, cur: "CNY" },
  "qwen3.7-max": { i: 2.4, o: 9.6, cr: 0.5, cur: "CNY" },
  "MiniMax-M3": { i: 1, o: 4, cr: 0.2, cur: "CNY" },
};

/** mock 记录费用（原生币种；USD 按 7.2 折算为 CNY 显示） */
function calcCost(r: any): number {
  const p = mockPrices[r.modelId];
  if (!p) return 0;
  const native = ((r.inputTokens - r.cacheReadTokens) * p.i + r.cacheReadTokens * p.cr + (r.outputTokens + r.reasoningTokens) * p.o) / 1e6;
  return p.cur === "USD" ? native * 7.2 : native;
}

const mock = {
  invoke(cmd: string, args: any = {}): Promise<any> {
    return new Promise((resolve) => {
      setTimeout(() => {
        const mode = args.mode || "full";
        switch (cmd) {
          case "sync_load_config":
            resolve({
              deviceName: "这台电脑",
              webdav: { endpoint: "https://dav.example.com/dav", username: "admin", password: "••••••••", root: "/dosage-sync", preset: "feiniu" },
              localBackup: { dir: "" },
              sources: [
                { source: "zcode", enabled: true, dataDir: "C:\\Users\\YOUR_NAME\\.zcode" },
                { source: "codex", enabled: false, dataDir: null },
                { source: "dsh", enabled: false, dataDir: null },
                { source: "workbuddy", enabled: true, dataDir: null },
                { source: "workbuddy-ai", enabled: true, dataDir: null },
                { source: "reasonix", enabled: true, dataDir: null },
                { source: "codebuddy", enabled: false, dataDir: null },
                { source: "qoder", enabled: false, dataDir: null },
                { source: "qoder-cn", enabled: false, dataDir: null },
                { source: "antigravity", enabled: false, dataDir: null },
                { source: "antigravity-ide", enabled: false, dataDir: null },
              ],
              sourceVisibility: {
                order: ["zcode", "codex", "dsh", "workbuddy", "workbuddy-ai", "reasonix", "codebuddy", "qoder", "qoder-cn", "antigravity", "antigravity-ide"],
                hidden: [],
                initialized: true,
              },
              schedule: { hourly: false, hourlyInterval: 1, daily: false, dailyTime: "23:30", autoStart: false, minimizeToTray: true, notifyOnSuccess: false },
              totalMode: "full",
              billing: {
              enabled: true, displayCurrency: "CNY", usdToCny: 7.2, importProxy: "",
              remotePricing: {
                enabled: true,
                url: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json",
                hashUrl: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.sha256",
                intervalHours: 24,
              },
            },
            });
            break;
          case "sync_save_config": resolve({ ok: true, message: "设置保存成功" }); break;
          case "test_webdav": resolve({ ok: true, message: "连接正常" }); break;
          case "list_sources": resolve([
            { id: "zcode", name: "ZCode", enabled: true, visible: true },
            { id: "codex", name: "Codex", enabled: false, visible: true },
            { id: "dsh", name: "DeepSeek Harness", enabled: false, visible: true },
            { id: "workbuddy", name: "WorkBuddy", enabled: true, visible: true },
            { id: "workbuddy-ai", name: "WorkBuddy AI", enabled: true, visible: true },
            { id: "reasonix", name: "Reasonix", enabled: true, visible: true },
            { id: "codebuddy", name: "CodeBuddy", enabled: false, visible: true },
            { id: "qoder", name: "Qoder", enabled: false, visible: true },
            { id: "qoder-cn", name: "Qoder CN", enabled: false, visible: true },
            { id: "antigravity", name: "Antigravity", enabled: false, visible: true },
            { id: "antigravity-ide", name: "Antigravity IDE", enabled: false, visible: true },
          ]); break;
          case "detect_source": {
            const mockDirs: Record<string, string> = {
              antigravity: "C:\\Users\\YOUR_NAME\\.gemini\\antigravity",
              "antigravity-ide": "C:\\Users\\YOUR_NAME\\.gemini\\antigravity-ide",
            };
            const path = mockDirs[args.source] || `C:\\Users\\YOUR_NAME\\.${args.source}`;
            resolve({ ok: true, path, deviceId: LOCAL_DEVICE });
            break;
          }
          case "health_source": resolve([
            { source: "zcode", name: "ZCode", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\.zcode", readable: true, lastSyncAt: Date.now() - 60000 },
            { source: "codex", name: "Codex", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\.codex", readable: true, lastSyncAt: Date.now() - 60000 },
            { source: "dsh", name: "DeepSeek Harness", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\.dsh", readable: true, lastSyncAt: Date.now() - 60000 },
            { source: "workbuddy", name: "WorkBuddy", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\.workbuddy", readable: true, lastSyncAt: Date.now() - 60000 },
            { source: "workbuddy-ai", name: "WorkBuddy AI", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\.workbuddy-ai", readable: true, lastSyncAt: Date.now() - 60000 },
            { source: "reasonix", name: "Reasonix", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\AppData\\Roaming\\reasonix", readable: true, lastSyncAt: Date.now() - 60000 },
            { source: "codebuddy", name: "CodeBuddy", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\AppData\\Local\\CodeBuddyExtension", readable: true, lastSyncAt: Date.now() - 60000 },
            { source: "qoder", name: "Qoder", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\.qoder", readable: true, lastSyncAt: Date.now() - 60000 },
            { source: "qoder-cn", name: "Qoder CN", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\.qoder-cn", readable: true, lastSyncAt: Date.now() - 60000 },
            // 【暂时隐藏 Antigravity 系】
            // { source: "antigravity", name: "Antigravity", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\AppData\\Roaming\\Antigravity", readable: true, lastSyncAt: Date.now() - 60000 },
            // { source: "antigravity-ide", name: "Antigravity IDE", detected: true, dataDir: "C:\\Users\\YOUR_NAME\\AppData\\Roaming\\Antigravity IDE", readable: true, lastSyncAt: Date.now() - 60000 },
          ]); break;
          case "get_summary": {
            const localRecs = allRecords.filter((r) => r.deviceId === LOCAL_DEVICE && (!args.source || r.source === args.source));
            const local = localRecs.reduce((s, r) => s + calcTotal(r, mode), 0);
            const remote = 0;
            const input = localRecs.reduce((s, r) => s + r.inputTokens, 0);
            const output = localRecs.reduce((s, r) => s + r.outputTokens, 0);
            const reasoning = localRecs.reduce((s, r) => s + r.reasoningTokens, 0);
            const cacheRead = localRecs.reduce((s, r) => s + r.cacheReadTokens, 0);
            const cacheCreate = localRecs.reduce((s, r) => s + r.cacheCreationTokens, 0);
            resolve({
              totalTokens: local + remote, todayTokens: Math.round((local + remote) * 0.011),
              localTokens: local, remoteTokens: remote, allTotalTokens: local + remote,
              cacheHitRate: cacheRead / (input || 1), todayCacheHitRate: cacheRead / (input || 1),
              cacheReadTokens: cacheRead, inputTokens: input,
              outputTokens: output, reasoningTokens: reasoning, cacheCreationTokens: cacheCreate,
              todayInputTokens: Math.round(input * 0.011), todayCacheReadTokens: Math.round(cacheRead * 0.011),
              recordCount: localRecs.length,
              todayRecordCount: Math.max(0, Math.round(localRecs.length * 0.011)),
              totalCost: localRecs.reduce((n, r) => n + calcCost(r), 0),
              todayCost: localRecs.slice(0, 5).reduce((n, r) => n + calcCost(r), 0),
              monthCost: localRecs.filter((_, i) => i % 3 !== 2).reduce((n, r) => n + calcCost(r), 0),
              monthCostPrev: localRecs.filter((_, i) => i % 3 === 2).reduce((n, r) => n + calcCost(r), 0),
              unpricedRecords: 0,
              unpricedTokens: 0,
              unpricedModels: 0,
              selectedDeviceId: args.deviceId || null,
            });
            break;
          }
          case "get_devices": {
            const local = allRecords.filter((r) => r.deviceId === LOCAL_DEVICE && (!args.source || r.source === args.source)).reduce((s, r) => s + calcTotal(r, mode), 0);
            resolve([
              { deviceId: LOCAL_DEVICE, deviceName: "笔记本", source: "zcode,codex,dsh,workbuddy,workbuddy-ai,reasonix,codebuddy,qoder,qoder-cn", lastSyncAt: Date.now() - 60000, online: true, totalTokens: local, isLocal: true, cost: allRecords.reduce((n, r) => n + calcCost(r), 0) },
            ]);
            break;
          }
          case "get_device_breakdowns": {
            const localRecs = allRecords.filter((r) => r.deviceId === LOCAL_DEVICE && (!args.source || r.source === args.source));
            const sum = (key: string) => localRecs.reduce((n, r) => n + r[key], 0);
            resolve([{
              deviceId: LOCAL_DEVICE,
              deviceName: "笔记本",
              isLocal: true,
              totalTokens: Math.round(localRecs.reduce((n, r) => n + calcTotal(r, mode), 0)),
              inputTokens: sum("inputTokens"),
              outputTokens: sum("outputTokens"),
              reasoningTokens: sum("reasoningTokens"),
              cacheReadTokens: sum("cacheReadTokens"),
              cacheCreationTokens: sum("cacheCreationTokens"),
              recordCount: localRecs.length,
              cost: localRecs.reduce((n, r) => n + calcCost(r), 0),
            }]);
            break;
          }
          case "get_trend": {
            const out: any[] = [];
            if (args.day) {
              // 单日模式：0-23 时逐小时，含缓存命中率
              for (let h = 0; h < 24; h++) {
                const w = h >= 9 && h <= 22 ? 1 : 0.12;
                const v = Math.round(3.1e5 * w * (0.55 + seed(h * 13 + 5) * 0.75));
                const input = Math.round(v * 0.42);
                out.push({ date: `${String(h).padStart(2, "0")}:00`, total: v, cost: (v / 1e6) * 2.6, inputTokens: input, cacheReadTokens: Math.round(input * (0.5 + seed(h * 3 + 11) * 0.4)), cacheHitRate: 0, models: { "GPT-5": Math.round(v * 0.42), "Claude 4": Math.round(v * 0.33), "Gemini 2.5": Math.round(v * 0.25) } });
                out[h].cacheHitRate = out[h].inputTokens > 0 ? out[h].cacheReadTokens / out[h].inputTokens : 0;
              }
              resolve(out);
              break;
            }
            const days = args.days || 30;
            // 以真实今天为基准生成，避免预览日期随时间漂移
            for (let i = days - 1; i >= 0; i--) {
              const d = new Date(); d.setDate(d.getDate() - i);
              const dow = d.getDay(); const weekend = dow === 0 || dow === 6 ? 0.55 : 1;
              const v = Math.round(4.6e6 * weekend * (0.72 + seed(i * 7 + days) * 0.56) * (0.65 + (days - i) / days * 0.35));
              const input = Math.round(v * 0.42);
              const hit = 0.5 + seed(i * 5 + 3) * 0.4;
              out.push({ date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, total: v, cost: (v / 1e6) * 2.6, inputTokens: input, cacheReadTokens: Math.round(input * hit), cacheHitRate: hit, models: { "GPT-5": Math.round(v * 0.42), "Claude 4": Math.round(v * 0.33), "Gemini 2.5": Math.round(v * 0.25) } });
            }
            resolve(out);
            break;
          }
          case "get_heatmap": {
            const out: any[] = [];
            // 滚动一年窗口：按传入的 start/end 生成每日数据
            const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
            const endD = args.end ? parse(String(args.end)) : new Date(2026, 8, 4);
            const startD = args.start ? parse(String(args.start)) : new Date(endD.getFullYear(), endD.getMonth(), endD.getDate() - 364);
            const d = new Date(startD);
            while (d <= endD) {
              const h = seed(d.getMonth() * 31 + d.getDate());
              const v = Math.round(1500000 + h * 4.2e6);
              out.push({ date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, total: v, cost: (v / 1e6) * 2.6 });
              d.setDate(d.getDate() + 1);
            }
            resolve(out);
            break;
          }
          case "get_aggregate": {
            const dim = args.dim || "model";
            const map: Record<string, any> = {};
            allRecords.filter((r) => !args.source || r.source === args.source).forEach((r) => {
              // 设备维度按 deviceId 分组（与后端一致，防同名合并），展示时取 deviceName
              const key = dim === "provider" ? r.providerId : dim === "model" ? r.modelId : dim === "source" ? r.source : r.deviceId;
              if (!map[key]) map[key] = { key, name: r.deviceName, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, count: 0, cost: 0, unpricedRecords: 0 };
              map[key].inputTokens += r.inputTokens; map[key].outputTokens += r.outputTokens;
              map[key].reasoningTokens += r.reasoningTokens; map[key].cacheReadTokens += r.cacheReadTokens;
              map[key].cacheCreationTokens += r.cacheCreationTokens;
              map[key].totalTokens += calcTotal(r, mode); map[key].count++;
              map[key].cost += calcCost(r);
            });
            const out = Object.values(map).sort((a: any, b: any) => b.totalTokens - a.totalTokens);
            if (dim === "device") out.forEach((e: any) => { e.key = e.name; });
            resolve(out);
            break;
          }
          case "get_dimensions": {
            // 下拉选项：与后端 getDimensions 同口径（按出现次数降序，空值原样保留）
            const dim = args.dim || "model";
            const cnt: Record<string, number> = {};
            allRecords.filter((r) => !args.source || r.source === args.source).forEach((r) => {
              const key = dim === "provider" ? r.providerId : dim === "source" ? r.source : r.modelId;
              cnt[key] = (cnt[key] || 0) + 1;
            });
            resolve(Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || (a < b ? -1 : a > b ? 1 : 0)));
            break;
          }
          case "get_records": {
            const limit = args.limit || 50, offset = args.offset || 0;
            const filtered = allRecords.filter((r) =>
              (!args.source || r.source === args.source)
              && (!args.deviceId || r.deviceId === args.deviceId)
              && (!args.model || r.modelId === args.model)
              && (!args.provider || r.providerId === args.provider)
              && (!args.status || r.status === args.status)
            );
            resolve({
              records: filtered.slice(offset, offset + limit).map((r) => ({
                ...r,
                costNative: calcCost(r),
                costCurrency: "CNY" as const,
                costDisplay: calcCost(r),
                priced: !!mockPrices[r.modelId],
              })),
              total: filtered.length,
            });
            break;
          }
          case "start_sync": resolve(null); break;
          case "cancel_sync": resolve(null); break;
          case "get_sync_progress": resolve({ running: false, stage: "done", stageLabel: "同步完成", percent: 100, message: "最后同步 09:53" }); break;
          case "get_sync_logs": {
            const all = [
              { id: 1, time: Date.now() - 60000, kind: "upload", level: "ok", message: "上传完成", detail: "本机新增 1,204 条记录，上传 3 个分片" },
              { id: 2, time: Date.now() - 70000, kind: "download", level: "ok", message: "拉取完成", detail: "拉取「公司笔记本」2 个分片，合并 886 条" },
              { id: 3, time: Date.now() - 75000, kind: "extract", level: "ok", message: "抽取完成", detail: "ZCode 增量抽取 1,204 条新记录" },
              { id: 4, time: Date.now() - 3600000, kind: "download", level: "error", message: "拉取失败", detail: "WebDAV 返回 401 · 账号密码错误" },
              { id: 5, time: Date.now() - 4000000, kind: "merge", level: "ok", message: "合并完成", detail: "按 deviceId:source:记录id 幂等合并" },
            ] as const;
            const kind = (args.kind as string) || null;
            const level = (args.level as string) || null;
            const filtered = all.filter((l) => (!kind || l.kind === kind) && (!level || l.level === level));
            const limit = Number(args.limit ?? 20);
            const offset = Number(args.offset ?? 0);
            resolve({ total: filtered.length, rows: filtered.slice(offset, offset + limit) });
            break;
          }
          case "clear_sync_logs": resolve(null); break;
          // ===== 本机存储（备份压缩包，演示环境仅回假数据） =====
          case "get_backup_info":
            resolve({ ok: true, dir: "C:\\Users\\YOUR_NAME\\.Dosage_sync", isDefault: true, lastBackupAt: Date.now() - 3600000, archiveExists: true, archiveSize: 3355443 });
            break;
          case "browse_backup_file": resolve({ ok: true, canceled: false, path: "C:\\backup\\dosage-sync-backup.zip" }); break;
          case "restore_backup": resolve({ ok: true, message: "恢复完成（演示环境）", restoredConfig: true }); break;
          case "export_data": {
            const ext = args.format === "json" ? "json" : "csv";
            resolve({ ok: true, path: `C:\\Users\\YOUR_NAME\\Downloads\\dosage-export.${ext}`, message: "导出成功" });
            break;
          }
          case "delete_device": resolve({ ok: true, message: "设备已删除（演示环境）" }); break;
          case "sync_open_data_dir": resolve(null); break;
          case "sync_get_data_dir": resolve("C:\\Users\\YOUR_NAME\\.Dosage_sync"); break;
          case "get_data_dir_info":
            resolve({ dataDir: "C:\\Users\\YOUR_NAME\\.Dosage_sync", defaultDataDir: "C:\\Users\\YOUR_NAME\\.Dosage_sync", isCustom: false });
            break;
          case "browse_data_dir": resolve({ ok: true, canceled: false, path: "C:\\Users\\YOUR_NAME\\.Dosage_sync" }); break;
          case "set_data_dir":
            resolve({ ok: true, message: "目录已更改，重启应用后生效", migrated: false, dataDir: String(args.path || ""), defaultDataDir: "C:\\Users\\YOUR_NAME\\.Dosage_sync" });
            break;
          case "reset_data_dir":
            resolve({ ok: true, message: "已恢复默认目录，重启应用后生效", dataDir: "C:\\Users\\YOUR_NAME\\.Dosage_sync", defaultDataDir: "C:\\Users\\YOUR_NAME\\.Dosage_sync" });
            break;
          case "get_app_version": resolve("1.0.0"); break;
          case "get_is_portable": resolve(false); break;
          case "reset_local_cache": resolve({ ok: true, message: "本地缓存已清空（演示环境）" }); break;
          // ===== 软件更新（有状态演示：可预览 检查→下载→重启安装 完整链路） =====
          case "get_update_status":
          case "check_update":
            resolve(mockUpdateStatus);
            break;
          case "download_update":
            mockUpdateStatus = { ...mockUpdateStatus, status: "downloaded", percent: 100 };
            resolve(mockUpdateStatus);
            break;
          case "install_update":
            mockUpdateStatus = { ...mockUpdateStatus, status: "up-to-date", latestVersion: "", notes: "", percent: 0, message: "" };
            resolve(mockUpdateStatus);
            break;
          case "open_release_page": resolve(null); break;
          case "open_repo_page": resolve(null); break;
          // ===== 计费 =====
          case "get_prices":
            resolve(Object.entries(mockPrices).map(([model, p], idx) => ({
              id: idx + 1, providerId: null, modelId: model,
              inputPerM: p.i, outputPerM: p.o, cacheReadPerM: p.cr, cacheWritePerM: 0,
              currency: p.cur, effectiveFrom: 0, effectiveTo: null,
              updatedAt: Date.now() - 86400000, updatedBy: "内置默认",
              source: (idx % 3 === 0 ? "manual" : idx % 3 === 1 ? "remote" : "builtin") as "manual" | "remote" | "builtin",
              versions: 1, active: true,
            })));
            break;
          case "get_price_versions":
            resolve([{
              id: 1, providerId: null, modelId: args.modelId,
              inputPerM: 4, outputPerM: 16, cacheReadPerM: 0.8, cacheWritePerM: 0,
              currency: "CNY", effectiveFrom: 0, effectiveTo: Date.parse("2026-08-15"),
              updatedAt: Date.now() - 86400000 * 20, updatedBy: "内置默认",
            }]);
            break;
          case "save_price": resolve({ ok: true, message: "价格已保存，历史费用已按新版本重算" }); break;
          case "delete_model_prices": resolve({ ok: true, message: "已删除该模型的全部价格版本" }); break;
          case "get_unpriced_models":
            resolve([{ providerId: "Dots", modelId: "dots3-note-prev", records: 19, tokens: 428135, firstSeen: Date.parse("2026-06-20") }]);
            break;
          case "import_prices_preview":
            resolve({
              ok: true, sourceName: args.source === "openrouter" ? "OpenRouter" : "LiteLLM",
              resolvedUrl: "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json",
              additions: [{ providerId: null, modelId: "dots3-note-prev", inputPerM: 0.5, outputPerM: 2, cacheReadPerM: 0.1, cacheWritePerM: 0, currency: "USD" }],
              changes: [], missing: [],
            });
            break;
          case "import_prices_apply": resolve({ ok: true, message: `已导入 ${(args.items || []).length} 条价格，历史费用已重算` }); break;
          case "pull_remote_pricing": resolve({ ok: true, message: "拉取完成：新增 0 · 调价 2 · 未变 5（本地 7 个模型命中，远端共 3561 个）" }); break;
          case "get_remote_pricing_status":
            resolve({
              enabled: true,
              url: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json",
              hashUrl: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.sha256",
              intervalHours: 24, lastAt: Date.now() - 3600000, lastHash: "a1b2c3d4", lastModels: 7,
            });
            break;
          default: resolve(null);
        }
      }, 60);
    });
  },
};

export { mock, fmt };

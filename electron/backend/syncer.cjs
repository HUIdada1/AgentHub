// 同步状态机：扫描 -> 去重 -> 干跑预览 -> 执行 -> MD 报告
// 规矩：删除/覆盖先进 .trash；同名异容不自动选边；不认识的目录只标记
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const config = require("./config.cjs");
const adapter = require("./adapter.cjs");
const scanner = require("./scanner.cjs");
const dedup = require("./dedup.cjs");
const hub = require("./hub.cjs");
const mounter = require("./mounter.cjs");
const report = require("./report.cjs");

const emptySummary = () => ({ imported: 0, merged: 0, conflicts: 0, skipped: 0, mounted: 0, repaired: 0, cleaned: 0 });

function conflictsFile() {
  return path.join(config.hubDir(), "conflicts.json");
}

function loadConflicts() {
  try {
    return JSON.parse(fs.readFileSync(conflictsFile(), "utf-8"));
  } catch {
    return { items: [] };
  }
}

function saveConflicts(c) {
  config.ensureHub();
  fs.writeFileSync(conflictsFile(), JSON.stringify(c, null, 2), "utf-8");
}

function upsertConflict(item) {
  const store = loadConflicts();
  if (!store.items.some((x) => x.id === item.id && !x.resolved)) {
    store.items.push({ ...item, at: new Date().toISOString() });
    saveConflicts(store);
  }
}

// 技能库列表行：manifest 已收纳 + 扫描到的未收纳，两源合并去重。
// 收纳后工具目录里只剩挂载链接，扫描层不产技能行，不并 manifest 这源库页就空了
function librarySkills(survey) {
  const rows = survey.dedup.unique.map((e) => ({
    name: e.name,
    skillName: e.skillName,
    description: e.description,
    version: e.version,
    treeHash: e.treeHash,
    health: e.health,
    sources: e.sources,
    inManifest: !!survey.manifest.skills[e.name],
    mounts: survey.manifest.skills[e.name]?.mounts || [],
    mtimeMs: e.mtimeMs,
  }));
  const seen = new Set(rows.map((r) => r.name));
  for (const [name, entry] of Object.entries(survey.manifest.skills)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = path.join(hub.skillsDir(), name);
    const exists = fs.existsSync(dir);
    rows.push({
      name,
      skillName: entry.skillName || name,
      description: entry.description || "",
      version: entry.version || "",
      treeHash: entry.treeHash || "",
      health: exists ? scanner.healthCheck(dir) : [{ level: "bad", text: "中央真身丢失，去回收站还原或删除该条目" }],
      sources: (entry.sources || []).map((s) => ({ tool: s.tool, name: s.originalName })),
      inManifest: true,
      mounts: entry.mounts || [],
      mtimeMs: exists ? fs.statSync(dir).mtimeMs : 0,
    });
  }
  return rows;
}

// 全量扫描 + 去重，仪表盘/技能库/去重页共用
function survey(cfg) {
  const scanned = scanner.scanAll(cfg, adapter);
  // 工具自带系统技能（origin:"system"）不进去重收纳流程
  const d = dedup.dedupe({ ...scanned, skills: scanned.skills.filter((s) => s.origin !== "system") }, cfg);
  const manifest = hub.loadManifest();
  // 孤儿：工具目录里有，但既不是中央真身也不是任何已记录的来源/挂载名。
  // 系统自带技能在扫描层已标 origin，同样不算孤儿
  const known = new Set();
  for (const name of Object.keys(manifest.skills)) {
    known.add(name);
    for (const s of manifest.skills[name].sources || []) known.add(s.originalName);
    for (const mt of manifest.skills[name].mounts || []) known.add(mt.name);
  }
  const orphans = scanned.skills.filter((s) => s.origin !== "system" && !known.has(s.name)).map((s) => ({ name: s.name, tool: s.tool, dir: s.dir, mtimeMs: s.mtimeMs }));
  const mountHealth = mounter.verifyAll(manifest);
  return { scanned, dedup: d, manifest, orphans, mountHealth, hubExtra: hub.hubExtra() };
}

function planSync(cfg) {
  const { scanned, dedup: d, manifest, orphans } = survey(cfg);
  const mode = cfg.mountMode === "copy" ? "copy" : "junction";
  const actions = [];
  const targets = scanned.targets;

  // A) 中央没有的：收纳 + 所有来源原位转挂载。
  // simImported 模拟导入顺序——L2 归一同名的条目只有第一个能进中央，后面的走冲突
  const simImported = new Set();
  // "工具目录\0名字"，这些位置 A 段已经排了 mount，B 段跳过
  const importedSources = new Set();
  for (const e of d.unique) {
    if (manifest.skills[e.name]) continue;
    const canImport = !simImported.has(e.name);
    if (canImport) simImported.add(e.name);
    actions.push({
      type: "import",
      skill: e.name,
      note: `收纳 ${e.sources.map((s) => s.tool + ":" + s.name).join(", ")}`,
      sources: e.sources.map((s) => ({ tool: s.tool, name: s.name, dir: s.dir })),
      entry: { name: e.name, dir: e.dir, skillName: e.skillName, description: e.description, version: e.version, treeHash: e.treeHash, health: e.health, sources: e.sources },
    });
    for (const s of e.sources) {
      actions.push({ type: "mount", skill: e.name, mountName: s.name, toolId: s.tool, parentDir: path.dirname(s.dir), replaceReal: true, note: `${s.tool}:${s.name} 原位转挂载` });
      if (canImport) importedSources.add(`${path.dirname(s.dir)}\u0000${s.name}`);
    }
  }

  // B) 中央已有的（含这轮要收纳进来的）逐个工具目录判定。
  // 新收纳技能的来源目录上面处理过了，这里跳过；其他目录按发布走
  const importedNames = new Set(d.unique.filter((e) => !manifest.skills[e.name]).map((e) => e.name));
  const allNames = [...Object.keys(manifest.skills), ...importedNames];
  for (const name of allNames) {
    const target = path.join(hub.skillsDir(), name);
    const isNew = importedNames.has(name);
    if (!isNew && !fs.existsSync(target)) {
      actions.push({ type: "error", skill: name, note: "中央真身丢失（被手动删除？），请从回收站还原或删除该条目" });
      continue;
    }
    for (const t of targets) {
      if (isNew && importedSources.has(`${t.dir}\u0000${name}`)) continue;
      // 用户在技能详情页手动停用的挂载不重新发布，不然开关形同虚设
      if ((manifest.skills[name]?.mounts || []).some((m) => m.tool === t.id && m.enabled === false)) continue;
      const linkPath = path.join(t.dir, name);
      if (mounter.isLink(linkPath)) {
        if (mounter.pointsTo(linkPath, target) && fs.existsSync(linkPath)) {
          actions.push({ type: "skip", skill: name, dir: t.dir, note: `${t.id} 挂载有效` });
        } else {
          actions.push({ type: "conflict", skill: name, toolId: t.id, dir: t.dir, kind: "diff-link", title: `${t.id}:${name} 链接指向异常`, detail: "现有链接不指向中央真身，需人工确认" });
        }
        continue;
      }
      if (fs.existsSync(linkPath)) {
        const localHash = scanner.treeHash(linkPath);
        if (localHash === scanner.treeHash(target)) {
          actions.push({ type: "mount", skill: name, mountName: name, toolId: t.id, parentDir: t.dir, replaceReal: true, note: `${t.id} 版与中央一致，原位转挂载（原目录备份进回收站）` });
        } else {
          actions.push({ type: "conflict", skill: name, toolId: t.id, dir: t.dir, kind: "content", title: `${t.id}:${name} 内容冲突`, detail: "工具版与中央版内容不同，需人工裁决" });
        }
      } else {
        actions.push({ type: "mount", skill: name, mountName: name, toolId: t.id, parentDir: t.dir, replaceReal: false, note: `${t.id} 无此技能 → 发布挂载` });
      }
    }
  }

  // C) L2 归一疑似，只是提示，两边照常各自收纳
  const l2Conflicts = d.conflicts.map((c) => ({
    id: `norm:${c.key}`,
    kind: "norm",
    title: `${c.variants[0].name} ≈ ${c.variants[1].name}`,
    detail: `名称归一后疑似同一技能（${c.basis}），当前按两个技能分别收纳；如确认同一可合并`,
    a: c.variants[0].name, b: c.variants[1].name,
  }));

  // D) 冲突落库：没裁决过的旧项留着，norm 类一直保留到裁决为止，其余只留本轮还存在的
  const store = loadConflicts();
  const newItems = [];
  for (const a of actions.filter((x) => x.type === "conflict")) {
    const id = `${a.kind}:${a.skill}@${a.toolId}`;
    newItems.push({ id, kind: a.kind, skill: a.skill, toolId: a.toolId, dir: a.dir, title: a.title, detail: a.detail, at: new Date().toISOString() });
  }
  for (const c of l2Conflicts) {
    if (!store.items.some((x) => x.id === c.id) && !newItems.some((x) => x.id === c.id)) newItems.push({ ...c, at: new Date().toISOString() });
  }
  const kept = store.items.filter((x) => {
    if (x.resolved) return false;
    if (x.kind === "norm") return true;
    return newItems.some((n) => n.id === x.id);
  });
  const merged = [...kept];
  for (const n of newItems) if (!merged.some((x) => x.id === n.id)) merged.push(n);
  saveConflicts({ items: merged });

  return {
    mode,
    actions: actions.filter((a) => a.type !== "conflict"),
    conflicts: merged.filter((x) => !x.resolved),
    orphans,
    dedup: d,
    scannedSummary: scanned.targets.map((t) => ({ id: t.id, name: t.name, dir: t.dir, skillCount: t.skillCount, mountCount: scanned.mounts.filter((m) => m.tool === t.id).length })),
  };
}

function executeSync(cfg, planResult) {
  // 渲染层传来的 plan 只当占位：动文件前必须按当前磁盘状态重新规划，
  // 照着过期/被动手脚的快照执行，轻则重复备份，重则往任意目录建挂载
  const plan = planSync(cfg);
  const s = emptySummary();
  const result = { mode: "exec", summary: s, imports: [], merges: [], conflicts: [], mounts: [], manifestDiff: [] };

  for (const a of plan.actions) {
    if (a.type === "import") {
      const r = hub.importSkill(a.entry);
      if (r.action === "imported") {
        s.imported++;
        result.imports.push({ name: a.skill, sources: a.sources.map((x) => x.tool + ":" + x.name).join(", "), action: "收纳", path: path.join(hub.skillsDir(), a.skill) });
        result.manifestDiff.push(`+ skills/${a.skill} ← ${a.sources.map((x) => x.tool + ":" + x.name).join(", ")} (${(r.treeHash || a.entry.treeHash).slice(0, 12)})`);
      } else if (r.action === "source-added") {
        result.imports.push({ name: a.skill, sources: a.sources.map((x) => x.tool + ":" + x.name).join(", "), action: "补充来源", path: path.join(hub.skillsDir(), a.skill) });
      } else {
        s.conflicts++;
        result.conflicts.push({ title: `${a.skill} 收纳冲突`, detail: r.message || "中央已有同名不同内容" });
      }
    } else if (a.type === "mount") {
      doMount(cfg, a, result, s);
    } else if (a.type === "skip") {
      s.skipped++;
    } else if (a.type === "error") {
      result.conflicts.push({ title: a.skill, detail: a.note });
    }
  }

  s.cleaned = hub.purgeTrash(cfg.trashDays || 7);
  result.reportFile = report.writeSyncReport(result);
  return result;
}

function doMount(cfg, a, result, s) {
  const toolDir = a.parentDir || a.dir;
  if (!toolDir || !fs.existsSync(toolDir)) {
    result.mounts.push({ skill: a.skill, dir: toolDir || "?", action: "mount", outcome: "目录不存在，跳过" });
    return;
  }
  const mountName = a.mountName || a.skill;
  const linkPath = path.join(toolDir, mountName);
  const realExists = fs.existsSync(linkPath) && !mounter.isLink(linkPath);

  if (realExists) {
    if (!a.replaceReal) {
      s.conflicts++;
      result.conflicts.push({ title: `${mountName} 挂载冲突`, detail: "工具目录已有同名真实目录，需人工裁决" });
      return;
    }
    const central = path.join(hub.skillsDir(), a.skill);
    // 备份进回收站前先确认中央真身在：先 toTrash 再发现挂不了，技能就从工具目录消失了
    if (!fs.existsSync(central)) {
      s.conflicts++;
      result.conflicts.push({ title: `${a.skill} 无法原位转挂载`, detail: "中央真身不存在：" + central });
      return;
    }
    // 覆盖前再算一次哈希，内容不一致绝不静默替换
    if (scanner.treeHash(linkPath) !== scanner.treeHash(central)) {
      s.conflicts++;
      result.conflicts.push({ title: `${a.skill} 内容冲突`, detail: "工具版与中央版内容不同，需人工裁决" });
      upsertConflict({ id: `content:${a.skill}@${a.toolId || "custom"}`, kind: "content", skill: a.skill, toolId: a.toolId || "custom", dir: toolDir, title: `${a.toolId || "custom"}:${a.skill} 内容冲突`, detail: "工具版与中央版内容不同，需人工裁决" });
      return;
    }
    const backed = hub.toTrash(linkPath, mountName);
    result.manifestDiff.push(`~ ${mountName} @ ${toolDir} 原目录备份 → .trash/${path.basename(backed)}`);
    s.merged++;
    result.merges.push({ kept: a.skill, removed: `${a.toolId || "?"}:${mountName}`, basis: "内容一致，原位转挂载" });
  }

  const r = mounter.mount(a.skill, toolDir, cfg.mountMode, mountName);
  const outcomes = { mounted: "已挂载", already: "已是指向中央的挂载", copied: "已复制", error: r.message || "失败" };
  const outcome = outcomes[r.action] || r.action;

  if (r.action === "conflict-real-dir" || r.action === "conflict-diff-link" || r.action === "error") {
    // real-dir 冲突在上面已经计过数了
    if (r.action !== "conflict-real-dir") s.conflicts++;
    result.conflicts.push({ title: `${mountName} 挂载异常`, detail: r.message || outcome });
    result.mounts.push({ skill: a.skill, dir: toolDir, action: "mount", outcome });
    return;
  }
  if (r.action === "already") s.skipped++;
  else s.mounted++;
  result.mounts.push({ skill: a.skill, dir: toolDir, action: a.replaceReal && realExists ? "replace-mount" : "mount", outcome });
  hub.setMount(a.skill, a.toolId || "custom", linkPath, cfg.mountMode === "copy" ? "copy" : mounter.linkType(), true);
  if (r.action === "mounted") result.manifestDiff.push(`+ mount ${mountName} @ ${toolDir} → skills/${a.skill}`);
}

// 冲突裁决。keepHub: 工具版进回收站改挂中央；keepTool: 工具版覆盖中央；keepBoth: 工具版改名收纳
function resolveContentConflict(item, choice, cfg) {
  const { skill, dir, toolId } = item;
  const central = path.join(hub.skillsDir(), skill);
  const toolCopy = path.join(dir, skill);
  if (!fs.existsSync(toolCopy)) return { ok: false, message: "工具目录已不存在该技能" };

  if (choice === "keepHub") {
    if (!fs.existsSync(central)) return { ok: false, message: "中央版已不存在，无法保留中央版" };
    const backed = hub.toTrash(toolCopy, skill);
    const r = mounter.mount(skill, dir, cfg.mountMode, skill);
    if (r.action === "mounted" || r.action === "already") {
      hub.setMount(skill, toolId, path.join(dir, skill), cfg.mountMode === "copy" ? "copy" : mounter.linkType(), true);
      noteHistory(skill, `冲突裁决：保留中央版，${toolId} 版进回收站（${path.basename(backed)}）`);
      return { ok: true, message: "已保留中央版并挂载" };
    }
    return { ok: false, message: "挂载失败：" + (r.message || r.action) };
  }

  if (choice === "keepTool") {
    const oldBacked = fs.existsSync(central) ? hub.toTrash(central, skill) : "";
    fs.cpSync(toolCopy, central, { recursive: true });
    const m = hub.loadManifest();
    if (m.skills[skill]) {
      m.skills[skill].treeHash = scanner.treeHash(central);
      m.skills[skill].mergeHistory.push({ at: new Date().toISOString(), action: "conflict-keepTool", detail: `保留 ${toolId} 版覆盖中央${oldBacked ? `，旧中央版进回收站（${path.basename(oldBacked)}）` : ""}` });
      hub.saveManifest(m);
    }
    const r = mounter.mount(skill, dir, cfg.mountMode, skill);
    if (r.action === "mounted" || r.action === "already") hub.setMount(skill, toolId, path.join(dir, skill), cfg.mountMode === "copy" ? "copy" : mounter.linkType(), true);
    return { ok: true, message: "已用工具版覆盖中央并分发到其他挂载点" };
  }

  if (choice === "keepBoth") {
    const newName = `${skill}-${toolId}`;
    const entry = {
      name: newName,
      dir: toolCopy,
      skillName: newName,
      description: "",
      version: "",
      treeHash: scanner.treeHash(toolCopy),
      health: [],
      sources: [{ tool: toolId, name: skill, dir: toolCopy }],
    };
    const r = hub.importSkill(entry);
    if (r.action !== "imported") return { ok: false, message: r.message || "改名收纳失败" };
    noteHistory(skill, `冲突裁决：双保留，${toolId} 版改名收纳为 ${newName}`);
    return { ok: true, message: `工具版已改名收纳为 ${newName}` };
  }

  return { ok: false, message: "未知裁决选项：" + choice };
}

// L2 疑似冲突：确认同一就把 b 摘掉、原目录改挂到 a；判为不同就只撤销提示
function resolveNormConflict(item, choice, cfg) {
  const aName = item.a, bName = item.b;
  const manifest = hub.loadManifest();
  if (choice === "same") {
    if (manifest.skills[bName]) {
      hub.removeSkill(bName);
    }
    const bEntry = survey(cfg).scanned.skills.find((x) => x.name === bName);
    if (bEntry) {
      const r = mounter.mount(aName, path.dirname(bEntry.dir), cfg.mountMode, bName);
      if (r.action === "mounted" || r.action === "already") {
        hub.setMount(aName, bEntry.tool, path.join(path.dirname(bEntry.dir), bName), cfg.mountMode === "copy" ? "copy" : mounter.linkType(), true);
      }
    }
    noteHistory(aName, `L2 裁决：确认 ${bName} 为同一技能，原目录改挂到 ${aName}`);
    return { ok: true, message: `已合并：${bName} → ${aName}` };
  }
  if (choice === "different") {
    return { ok: true, message: "已标记为不同技能" };
  }
  return { ok: false, message: "未知裁决选项：" + choice };
}

function noteHistory(skill, detail) {
  const m = hub.loadManifest();
  if (!m.skills[skill]) return;
  m.skills[skill].mergeHistory.push({ at: new Date().toISOString(), action: "conflict-resolved", detail });
  hub.saveManifest(m);
}

// 启停开关就是摘掉/重建某个工具上的挂载
function toggleMount(skill, toolId, enable, cfg) {
  const m = hub.loadManifest();
  const s = m.skills[skill];
  if (!s) return { ok: false, message: "技能不存在" };
  const mt = (s.mounts || []).find((x) => x.tool === toolId);
  if (!mt) return { ok: false, message: "该工具未挂载此技能" };
  if (enable) {
    const r = mounter.mount(skill, path.dirname(mt.path), cfg.mountMode, mt.name);
    if (r.action === "error") return { ok: false, message: r.message };
    mt.enabled = true;
  } else {
    const r = mounter.unmount(mt.path);
    if (!r.ok) return { ok: false, message: r.message };
    mt.enabled = false;
  }
  hub.saveManifest(m);
  return { ok: true, message: enable ? "已启用" : "已停用" };
}

// 删除自定义工具适配器：先干跑报影响，confirm 后才动。挂载只摘链接，来源记录保留为历史档案。
// 有未裁决冲突一律拒绝——冲突裁决需要那个工具的目录还在
function removeCustomTool(cfg, id, doIt) {
  const entry = (cfg.tools || {})[id];
  if (!entry) return { ok: false, message: "工具不存在" };
  if (adapter.isBuiltinId(id)) return { ok: false, message: "内置工具不能删除，只能停用" };
  const manifest = hub.loadManifest();
  const store = loadConflicts();
  const mounts = [];
  let sourceCount = 0;
  for (const [name, s] of Object.entries(manifest.skills || {})) {
    for (const mt of s.mounts || []) {
      if (mt.tool === id && mt.enabled !== false) mounts.push({ skill: name, path: mt.path });
    }
    sourceCount += (s.sources || []).filter((x) => x.tool === id).length;
  }
  const openConflicts = store.items.filter((x) => !x.resolved && x.toolId === id).length;
  if (!doIt) return { ok: true, builtin: false, mounts, sourceCount, openConflicts };
  if (openConflicts > 0) return { ok: false, message: `该工具还有 ${openConflicts} 条未裁决冲突，请先去「去重与冲突」页处理` };
  let unmounted = 0;
  for (const mt of mounts) {
    const r = mounter.unmount(mt.path); // 只删链接，绝不碰真实目录
    if (!r.ok) return { ok: false, message: `摘除 ${mt.path} 失败：${r.message}` };
    unmounted++;
  }
  if (unmounted || sourceCount) {
    for (const [name, s] of Object.entries(manifest.skills || {})) {
      const before = (s.mounts || []).length;
      s.mounts = (s.mounts || []).filter((m) => m.tool !== id);
      const hasSource = (s.sources || []).some((x) => x.tool === id);
      const dropped = before - s.mounts.length;
      if (dropped || hasSource) {
        const parts = [`移除工具适配器 ${id}（${entry.name || id}）`];
        if (dropped) parts.push(`摘除挂载 ${dropped} 处`);
        if (hasSource) parts.push("该工具来源记录保留为历史");
        s.mergeHistory.push({ at: new Date().toISOString(), action: "tool-removed", detail: parts.join("，") });
      }
    }
    hub.saveManifest(manifest);
  }
  delete cfg.tools[id];
  config.saveConfig(cfg);
  return { ok: true, message: `已删除工具 ${id}${unmounted ? `，摘除挂载 ${unmounted} 处` : ""}`, unmounted };
}

function repairMounts(cfg) {
  const m = hub.loadManifest();
  const rows = mounter.verifyAll(m);
  let repaired = 0;
  const details = [];
  for (const row of rows) {
    if (row.valid) continue;
    if (mounter.isLink(row.path)) mounter.unmount(row.path);
    const r = mounter.mount(row.skill, path.dirname(row.path), cfg.mountMode, row.name);
    if (r.action === "mounted") {
      repaired++;
      details.push(`${row.skill}@${row.tool}`);
    } else {
      details.push(`${row.skill}@${row.tool} 失败：${r.message || r.action}`);
    }
  }
  return { repaired, details };
}

// 中央巡检发现未登记目录后的纳管：只补账、记录现成挂载，绝不移动/删除任何文件。
// WebDAV 同步占用中央仓库时不动账本
function adoptHubSkill(raw, cfg) {
  const name = path.basename(String(raw || ""));
  if (!name) return { ok: false, message: "非法技能名" };
  const dir = path.join(hub.skillsDir(), name);
  const m = hub.loadManifest();
  if (m.skills[name]) return { ok: false, message: `「${name}」已在库中` };
  if (!fs.existsSync(dir)) return { ok: false, message: "中央仓库里没有这个技能目录" };
  if (mounter.isLink(dir)) return { ok: false, message: "该条目是链接而非真身目录，无法纳管" };
  let parsed;
  try {
    parsed = scanner.parseSkillMd(dir);
  } catch {
    return { ok: false, message: "缺少可解析的 SKILL.md，可能不是技能，拒绝纳管" };
  }
  if (!parsed.ok) return { ok: false, message: "SKILL.md 缺少合法 frontmatter，拒绝纳管" };
  // 惰性 require：remotesync 反过来依赖 syncer，顶层引会循环
  if (require("./remotesync.cjs").isRunning()) return { ok: false, message: "WebDAV 同步进行中，稍后重试" };
  // 顺带把各工具目录已存在的挂载链接记进账（AI 可能只建链接没写账）
  const mounts = [];
  for (const t of adapter.resolveScanTargets(cfg)) {
    const lp = path.join(t.dir, name);
    if (mounter.pointsTo(lp, dir) && fs.existsSync(lp)) {
      mounts.push({ tool: t.id, name, path: lp, type: mounter.linkType(), enabled: true });
    }
  }
  m.skills[name] = {
    name,
    version: parsed.info.version || "",
    description: parsed.info.description || "",
    treeHash: scanner.treeHash(dir),
    skillName: parsed.info.name || name,
    sources: [],
    mounts,
    mergeHistory: [{ at: new Date().toISOString(), action: "adopt", detail: "中央仓库未登记目录纳管" }],
    health: scanner.healthCheck(dir),
  };
  hub.saveManifest(m);
  return { ok: true, name, mounts: mounts.length };
}

module.exports = { survey, librarySkills, planSync, executeSync, loadConflicts, saveConflicts, upsertConflict, resolveContentConflict, resolveNormConflict, toggleMount, removeCustomTool, repairMounts, adoptHubSkill };

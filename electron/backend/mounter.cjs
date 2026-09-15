// Junction 挂载：建/查/摘/重建，copy 模式兜底
// 底线两条：摘除只删链接本身；目标位置已有真实目录就报冲突，绝不静默替换
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const hub = require("./hub.cjs");

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Windows 用 junction（免管理员权限），其他平台用目录符号链接；记录到 manifest 的类型名随之走
function linkType() {
  return process.platform === "win32" ? "junction" : "symlink";
}

// junction 的 readlink 会带 \\?\ 前缀和尾部反斜杠，比较前去掉；Windows 不区分大小写
function normalizeTarget(t) {
  const s = String(t || "").replace(/^\\\?\\/, "").replace(/[\\/]+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

function pointsTo(linkPath, expectedTarget) {
  try {
    return normalizeTarget(fs.readlinkSync(linkPath)) === normalizeTarget(expectedTarget);
  } catch {
    return false;
  }
}

// mountName 可以和 skillName 不同（改名副本场景：codex 的 gpt-taste 指向中央 taste-skill）
function mount(skillName, toolDir, mode, mountName) {
  const name = mountName || skillName;
  const target = path.join(hub.skillsDir(), skillName);
  const linkPath = path.join(toolDir, name);
  if (!fs.existsSync(target)) return { action: "error", message: "中央真身不存在：" + target, linkPath };

  if (isLink(linkPath)) {
    if (pointsTo(linkPath, target)) return { action: "already", linkPath };
    return { action: "conflict-diff-link", linkPath, message: "现有链接指向别处：" + linkPath };
  }
  if (fs.existsSync(linkPath)) {
    return { action: "conflict-real-dir", linkPath, message: "工具目录已有同名真实目录：" + linkPath };
  }

  if (mode === "copy") {
    fs.cpSync(target, linkPath, { recursive: true });
    return { action: "copied", linkPath };
  }
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  return fs.existsSync(linkPath) ? { action: "mounted", linkPath } : { action: "error", message: "链接创建失败", linkPath };
}

function unmount(linkPath) {
  if (isLink(linkPath)) {
    fs.unlinkSync(linkPath);
    return { ok: true };
  }
  if (fs.existsSync(linkPath)) return { ok: false, message: "不是链接，拒绝删除真实目录：" + linkPath };
  return { ok: true }; // 本来就没有，当已摘除
}

function verifyAll(manifest) {
  const rows = [];
  for (const name of Object.keys(manifest.skills || {})) {
    for (const mt of manifest.skills[name].mounts || []) {
      if (mt.enabled === false) continue;
      const isLinkNow = isLink(mt.path);
      const valid = isLinkNow && pointsTo(mt.path, path.join(hub.skillsDir(), name)) && fs.existsSync(mt.path);
      rows.push({ skill: name, ...mt, isLink: isLinkNow, valid });
    }
  }
  return rows;
}

module.exports = { isLink, pointsTo, mount, unmount, verifyAll, linkType };

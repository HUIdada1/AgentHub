// 发版收尾：把 build/release-notes.md 写进 GitHub Release body。
// electron-builder 创建 Release 只传 tag/name/draft，不传 body（源码确认），
// body 为空时 Release 页无说明，atom feed 兜底路径也拿不到更新说明，必须补。
// 用法：node tools/patch-release-notes.cjs <version> <notes.md 路径>（CI 用，GH_TOKEN 环境变量）
"use strict";
const fs = require("node:fs");
const REPO = "HUIdada1/AgentHub";

const [version, notesPath] = process.argv.slice(2);
if (!version || !notesPath) {
  console.error("用法：node tools/patch-release-notes.cjs <version> <notes.md 路径>");
  process.exit(1);
}

function api(path, opts = {}) {
  return fetch("https://api.github.com" + path, {
    ...opts,
    headers: {
      Authorization: "Bearer " + process.env.GH_TOKEN,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

(async () => {
  const body = fs.readFileSync(notesPath, "utf8").trim();
  if (!body) throw new Error(notesPath + " 内容为空，拒绝写入");

  const relRes = await api(`/repos/${REPO}/releases/tags/v${version}`);
  if (!relRes.ok) throw new Error(`查询 Release v${version} 失败：HTTP ${relRes.status}`);
  const release = await relRes.json();

  const patchRes = await api(`/repos/${REPO}/releases/${release.id}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
  if (!patchRes.ok) throw new Error(`写入 Release body 失败：HTTP ${patchRes.status}`);
  console.log(`Release v${version}（id=${release.id}）更新说明已写入，共 ${body.length} 字符`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

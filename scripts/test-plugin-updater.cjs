"use strict";
const assert = require("node:assert/strict");
const { parseIndex, platformMatches, compareVersion, plan } = require("../electron/backend/plugin-feed.cjs");

const SHA = "a".repeat(64);
function entry(over = {}) {
  return { id: "com.agenthub.forwarding-suite", name: "Forwarding", version: "1.0.0",
    minimumVersion: "", minHostVersion: "", platforms: [{ os: "win32", arch: "x64" }],
    url: "https://example.test/pkg.zip", sha256: SHA, ...over };
}
function index(list) { return Buffer.from(JSON.stringify({ schema: 1, plugins: list })); }

function main() {
  // 解析：合法条目保留字段，非法条目整条拒绝
  assert.deepEqual(parseIndex(index([entry()])), [entry()]);
  assert.throws(() => parseIndex(Buffer.from("{}")), /格式不支持/);
  assert.throws(() => parseIndex(index([entry({ id: "Bad Id" })])), /id 非法/);
  assert.throws(() => parseIndex(index([entry({ version: "x" })])), /版本号非法/);
  assert.throws(() => parseIndex(index([entry({ url: "http://insecure.test/x.zip" })])), /下载地址非法/);
  assert.throws(() => parseIndex(index([entry({ sha256: "short" })])), /缺少 sha256/);

  // 平台：清单限定 win32/x64 时，其它平台不参与
  const target = { os: "win32", arch: "x64", libc: undefined };
  assert.equal(platformMatches(entry(), target), true);
  assert.equal(platformMatches(entry(), { os: "linux", arch: "x64", libc: "glibc" }), false);
  assert.equal(platformMatches(entry({ platforms: [] }), target), true, "未声明平台视为通用");

  // 版本比较
  assert.equal(compareVersion("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersion("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersion("0.9", "1.0.0"), -1);

  const installed = (version, id = "com.agenthub.forwarding-suite") => new Map([[id, { version }]]);

  // 未安装：自动下载开启才装
  assert.deepEqual(plan(parseIndex(index([entry()])), { installed: new Map(), settings: { autoDownload: true, autoUpdate: false }, target })
    .map(row => [row.action, row.required]), [["install", false]]);
  assert.deepEqual(plan(parseIndex(index([entry()])), { installed: new Map(), settings: { autoDownload: false, autoUpdate: true }, target }), []);

  // 已安装旧版：自动更新开启才升
  assert.deepEqual(plan(parseIndex(index([entry()])), { installed: installed("0.9.0"), settings: { autoUpdate: true }, target })
    .map(row => [row.action, row.currentVersion]), [["update", "0.9.0"]]);
  assert.deepEqual(plan(parseIndex(index([entry()])), { installed: installed("0.9.0"), settings: { autoUpdate: false }, target }), []);

  // 最低版本兜底：开关全关也要补齐
  assert.deepEqual(plan(parseIndex(index([entry({ minimumVersion: "1.0.0" })])), { installed: installed("0.9.0"), settings: { autoUpdate: false, autoDownload: false }, target })
    .map(row => [row.action, row.required]), [["update", true]]);
  assert.deepEqual(plan(parseIndex(index([entry({ minimumVersion: "0.5.0" })])), { installed: installed("0.9.0"), settings: { autoUpdate: false }, target }), []);

  // 已是最新、主程序版本不够、平台不符都不装
  assert.deepEqual(plan(parseIndex(index([entry()])), { installed: installed("1.0.0"), settings: { autoUpdate: true }, target }), []);
  assert.deepEqual(plan(parseIndex(index([entry({ minHostVersion: "2.0.0" })])), { installed: installed("0.1.0"), settings: { autoUpdate: true }, hostVersion: "1.99.0", target }), []);
  assert.deepEqual(plan(parseIndex(index([entry()])), { installed: new Map(), settings: { autoDownload: true }, target: { os: "linux", arch: "arm64", libc: "glibc" } }), []);

  // 同一 id 重复出现只算一次；minimumVersion 高于 version 是清单写错，不强制
  assert.equal(plan(parseIndex(index([entry(), entry()])), { installed: new Map(), settings: { autoDownload: true }, target }).length, 1);
  assert.deepEqual(plan(parseIndex(index([entry({ version: "1.0.0", minimumVersion: "2.0.0" })])), { installed: installed("0.9.0"), settings: { autoUpdate: false }, target }), []);

  console.log("PASS plugin feed: manifest parsing, platform gate, version compare, auto update/download and minimum-version floor");
}

main();

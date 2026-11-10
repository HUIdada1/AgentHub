"use strict";
const crypto = require("node:crypto");

// 官方发布公钥。内置在主程序里，不从网络或本地信任库加载 ——
// 「官方签名」这个判断必须由主程序自己固定，否则改一下源地址或本地 json 就能冒充。
// 私钥只在发布机上（AGENTHUB_PLUGIN_SIGNING_KEY），不入库、不进安装包。
const OFFICIAL_PLUGIN_KEYS = Object.freeze([
  Object.freeze({
    keyId: "agenthub-release-2026",
    publisher: "agenthub",
    pluginIds: Object.freeze(["com.agenthub.forwarding-suite"]),
    publicKey: [
      "-----BEGIN PUBLIC KEY-----",
      "MCowBQYDK2VwAyEAV6moCSNsjIQ8wsF4GecGAB0IM6ODZSqCOzrnIj6CW0o=",
      "-----END PUBLIC KEY-----",
      "",
    ].join("\n"),
  }),
]);

function officialTrustStore() {
  const store = new Map();
  for (const key of OFFICIAL_PLUGIN_KEYS) {
    store.set(key.keyId, Object.freeze({
      publisher: key.publisher,
      pluginIds: [...key.pluginIds],
      publicKey: crypto.createPublicKey(key.publicKey),
      revoked: false,
    }));
  }
  return store;
}

/** 官方公钥的 SPKI 指纹，用于和本地信任库比对同一个 keyId 是否被换过钥匙 */
function keyFingerprint(keyObject) {
  return crypto.createHash("sha256")
    .update(keyObject.export({ type: "spki", format: "der" }))
    .digest("hex");
}

module.exports = { OFFICIAL_PLUGIN_KEYS, officialTrustStore, keyFingerprint };

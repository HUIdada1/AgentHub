"use strict";
// Management-owned CatPaw model facts only. Request routing, effort and
// context-window interpretation live in the external forwarding plugin.
const MODELS = Object.freeze([
  Object.freeze({ id: "kimi-k3", name: "Kimi-K3", hostModelId: 83, supportImage: true, supportThinking: true, contextWindows: Object.freeze([]), defaultContextWindow: null }),
  Object.freeze({ id: "glm-5.3-flash", name: "GLM-5.3-Flash", hostModelId: 91, supportImage: true, supportThinking: true, contextWindows: Object.freeze(["204800", "512000", "1024000"]), defaultContextWindow: "1024000" }),
]);
function normalizeModelName(value) {
  return String(value || "").trim().replace(/[\s_.]/g, "-").toLowerCase();
}
module.exports = { MODELS, normalizeModelName };

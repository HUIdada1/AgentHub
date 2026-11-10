"use strict";
// Static evidence for the management/forwarding split. Never imports business modules.
// Usage: node tools/plugin-boundary-inventory.cjs [report.json]
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const backend = path.join(root, "electron", "backend");
const managementMethods = new Set([
  "queryCredits", "refreshToken", "checkin", "checkinStatus", "trial", "userInfo",
  "claimOnboarding", "solveCaptcha", "fetchModels", "fetchModelsPublic", "fetchModelsOnce", "probeChat"
]);
const forwardingMethods = new Set([
  "chat", "chatOnce", "chatOpenai", "chatSession", "rewriteBody", "mapModel", "stateful", "classifyError"
]);
// 用户明确冻结的管理探测例外：WorkBuddy 的原 probeChat 会在管理页做一次
// 最小上游探测，它不是本地网关的模型执行入口，也不能因为反代插件化而删除。
// 仍把它写入报告，供人工审计；这里只避免把已批准例外计为未审查 crossing。
const reviewedCrossings = new Set(["electron/backend/proxy/adapters.cjs:makeWorkBuddy:probeChat:chat"]);
function classification(name) {
  if (managementMethods.has(name)) return "M";
  if (forwardingMethods.has(name)) return "R";
  return "X-review";
}
function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? filesUnder(path.join(dir, item.name)) : item.name.endsWith(".cjs") ? [path.join(dir, item.name)] : []);
}
function normalize(file) { return path.relative(root, file).replace(/\\/g, "/"); }
function ownerOf(node, source) {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if ((ts.isFunctionDeclaration(ancestor) || ts.isVariableDeclaration(ancestor)) && ancestor.name) return ancestor.name.getText(source);
  }
  return "module";
}
function inspect(file) {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) throw new Error(`Cannot inventory malformed source: ${normalize(file)}`);
  const requires = [];
  const functions = [];
  const methods = [];
  const lineOf = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const arg = node.arguments[0];
      const spec = arg && ts.isStringLiteral(arg) ? arg.text : null;
      requires.push({ line: lineOf(node), spec, dynamic: spec === null, expression: node.getText(source), target: spec?.startsWith(".") ? normalize(path.resolve(path.dirname(file), spec)) : null });
    }
    if (ts.isFunctionDeclaration(node) && node.name) functions.push({ name: node.name.text, line: lineOf(node), endLine: source.getLineAndCharacterOfPosition(node.end).line + 1 });
    if (ts.isMethodDeclaration(node) || (ts.isPropertyAssignment(node) && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))) {
      const name = node.name.getText(source).replace(/^['"]|['"]$/g, "");
      const calls = new Set();
      function dependencies(child) {
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && child.expression.expression.kind === ts.SyntaxKind.ThisKeyword) calls.add(child.expression.name.text);
        ts.forEachChild(child, dependencies);
      }
      dependencies(node);
      methods.push({ name, owner: ownerOf(node, source), line: lineOf(node), classification: classification(name), thisCalls: [...calls].sort(), crossBoundaryCalls: [...calls].filter(call => managementMethods.has(name) && forwardingMethods.has(call)).sort() });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { file: normalize(file), requires, functions, methods };
}

const sources = [...filesUnder(path.join(backend, "proxy")), ...filesUnder(path.join(backend, "localgw")), ...filesUnder(path.join(backend, "network"))].sort().map(inspect);
const crossings = sources.flatMap(source => source.methods
  .filter(method => method.crossBoundaryCalls.length)
  .map(method => ({ file: source.file, ...method })));
const unreviewedCrossings = crossings.filter(crossing => crossing.crossBoundaryCalls.some(call =>
  !reviewedCrossings.has(`${crossing.file}:${crossing.owner}:${crossing.name}:${call}`)));
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  note: "M/R labels identify review candidates, not permission to delete code. Cross-file helpers, aliases, dynamic property access and resource consumers require manual dependency review. Standard custom execution remains core even when its method is named chat.",
  sources,
  crossings,
  reviewedCrossings: [...reviewedCrossings].sort(),
  unreviewedCrossings
};
if (process.argv[2]) {
  const destination = path.resolve(process.argv[2]);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`Inventory: ${sources.length} modules, ${sources.reduce((count, source) => count + source.methods.length, 0)} object methods, ${crossings.length} direct management-to-forwarding crossings, ${unreviewedCrossings.length} unreviewed`);
  for (const crossing of crossings) console.log(`${crossing.file}:${crossing.line} ${crossing.owner}.${crossing.name} -> ${crossing.crossBoundaryCalls.join(", ")}`);
} else process.stdout.write(JSON.stringify(report, null, 2) + "\n");

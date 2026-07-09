const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "console.html"), "utf8");
const js = fs.readFileSync(path.join(root, "public", "console.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

const requiredHtml = [
  "Threads 聯盟自動化",
  'id="profit-engine"',
  'id="factory"',
  'id="risk"',
  'id="affiliate"',
  'id="prompt"',
  'id="generateBtn"',
  'id="autoGenerateBtn"',
  'id="runBtn"',
  'id="profitRunBtn"',
  'id="postRows"',
  'id="riskRows"',
  'id="revenueFunnel"',
  'id="promptTemplate"',
  'id="profitModels"',
  'id="profitScripts"',
  "內容工廠",
  "合規 / 風險審核",
  "聯盟收益管道",
  '<script src="/console.js"></script>'
];

for (const marker of requiredHtml) {
  assert.equal(html.includes(marker), true, `Missing HTML marker: ${marker}`);
}

const requiredJs = [
  "/api/dashboard",
  "/api/automation/generate",
  "/api/automation/run",
  "/api/profit-engine/run",
  "/api/posts/",
  "已產生 5 則草稿"
];

for (const marker of requiredJs) {
  assert.equal(js.includes(marker), true, `Missing JS marker: ${marker}`);
}

const requiredCss = [
  ".ops-grid",
  ".profit-engine-panel",
  ".profit-layout",
  ".content-factory",
  ".risk-panel",
  ".revenue-panel",
  ".workflow-strip",
  ".funnel-flow",
  "@media (max-width: 1400px)"
];

for (const marker of requiredCss) {
  assert.equal(css.includes(marker), true, `Missing CSS marker: ${marker}`);
}

console.log("UI contract passed.");

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
  'id="readiness"',
  'id="timeline"',
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
  'id="profitSourceStatuses"',
  'id="profitSignals"',
  'id="profitBlockedScripts"',
  'id="sideConnectorList"',
  'id="commandStats"',
  'id="autopilotSummary"',
  'id="readinessMode"',
  'id="readinessSummary"',
  'id="readinessChecks"',
  'id="timelineCount"',
  'id="opTimeline"',
  'id="conversionEvents"',
  "內容工廠",
  "合規 / 風險審核",
  "聯盟收益管道",
  '<script src="/console.js?v=20260709-timeline"></script>'
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
  "sourceStatuses",
  "externalSignals",
  "script.source",
  "blockedScripts",
  "renderReadiness",
  "renderOpsTimeline",
  "buildTimelineItems",
  "data.profitEngine?.runs",
  "data.automationRuns",
  "data.recentEvents",
  "readiness.summary",
  "status-${escapeHtml(check.status)}",
  "已產生 5 則草稿"
];

for (const marker of requiredJs) {
  assert.equal(js.includes(marker), true, `Missing JS marker: ${marker}`);
}

const requiredCss = [
  ".ops-grid",
  ".profit-engine-panel",
  ".profit-layout",
  ".intel-strip",
  ".signal-row",
  ".command-strip",
  ".sidebar-connectors",
  ".autopilot-summary",
  ".readiness-panel",
  ".readiness-summary",
  ".readiness-checks",
  ".readiness-mode",
  ".timeline-panel",
  ".timeline-list",
  ".timeline-item",
  ".timeline-badge",
  ".blocked-script-feed",
  ".conversion-feed",
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

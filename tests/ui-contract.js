const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "console.html"), "utf8");
const js = fs.readFileSync(path.join(root, "public", "console.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

const requiredHtml = [
  "Threads 聯盟自動化",
  'id="control-tower"',
  'id="profit-engine"',
  'id="readiness"',
  'id="timeline"',
  'id="next-actions"',
  'id="decision-brief"',
  'id="worker-health"',
  'id="experiments"',
  'id="factory"',
  'id="risk"',
  'id="affiliate"',
  'id="prompt"',
  'id="generateBtn"',
  'id="autoGenerateBtn"',
  'id="cycleRunBtn"',
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
  'id="pipelineMode"',
  'id="pipelineSummary"',
  'id="pipelineSteps"',
  'id="autopilotSummary"',
  'id="readinessMode"',
  'id="readinessSummary"',
  'id="readinessChecks"',
  'id="timelineCount"',
  'id="opTimeline"',
  'id="nextActionCount"',
  'id="actionSummary"',
  'id="nextActionList"',
  'id="decisionConfidence"',
  'id="decisionBrief"',
  'id="workerHealthMode"',
  'id="workerHealthGrid"',
  'id="workerHealthNotes"',
  'id="experimentMode"',
  'id="experimentSummary"',
  'id="optimizerDecision"',
  'id="experimentCards"',
  'id="optimizationQueue"',
  'id="conversionEvents"',
  "內容工廠",
  "合規 / 風險審核",
  "聯盟收益管道",
  '<link rel="stylesheet" href="/styles.css?v=20260709-cycle" />',
  '<script src="/console.js?v=20260709-cycle"></script>'
];

for (const marker of requiredHtml) {
  assert.equal(html.includes(marker), true, `Missing HTML marker: ${marker}`);
}

const requiredJs = [
  "/api/dashboard",
  "/api/automation/generate",
  "/api/automation/run",
  "/api/autonomy/cycle",
  "/api/profit-engine/run",
  "/api/posts/",
  "sourceStatuses",
  "externalSignals",
  "script.source",
  "blockedScripts",
  "renderReadiness",
  "renderAutonomyPipeline",
  "buildPipelineFallback",
  "pipelineStatusScore",
  "runAutonomyCycle",
  "renderOpsTimeline",
  "renderNextActions",
  "renderDecisionBrief",
  "buildDecisionBrief",
  "renderWorkerHealth",
  "buildWorkerHealth",
  "renderExperimentLoop",
  "buildExperimentLoopFallback",
  "buildOptimizerDecisionFallback",
  "optimizationQueue",
  "optimizerDecision",
  "data-profit-experiment",
  "workerEnabled",
  "nextRunHint",
  "confidenceScore",
  "buildNextActions",
  "handleNextAction",
  "data-next-action",
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
  ".control-panel",
  ".pipeline-summary",
  ".pipeline-steps",
  ".pipeline-step",
  ".pipeline-mode",
  ".autopilot-summary",
  ".readiness-panel",
  ".readiness-summary",
  ".readiness-checks",
  ".readiness-mode",
  ".timeline-panel",
  ".timeline-list",
  ".timeline-item",
  ".timeline-badge",
  ".actions-panel",
  ".action-summary",
  ".next-action",
  ".decision-panel",
  ".decision-grid",
  ".decision-card",
  ".decision-confidence",
  ".worker-panel",
  ".worker-health-grid",
  ".worker-card",
  ".worker-mode",
  ".experiment-panel",
  ".experiment-summary",
  ".optimizer-decision",
  ".optimizer-card",
  ".experiment-card",
  ".optimization-queue",
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

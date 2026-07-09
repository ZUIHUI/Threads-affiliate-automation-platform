const state = {
  dashboard: null
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatMoney(value) {
  return `$${Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function statusBadge(status) {
  const map = {
    draft: ["草稿", "warn"],
    scheduled: ["待審核", "info"],
    container_created: ["待發佈", "info"],
    published: ["已發佈", "good"],
    simulated: ["已排程", "good"],
    failed: ["失敗", "bad"],
    blocked_credentials: ["缺憑證", "bad"],
    completed: ["完成", "good"],
    completed_with_errors: ["有錯誤", "warn"]
  };
  const [label, tone] = map[status] || [status, "info"];
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function riskBadge(level) {
  const map = {
    high: ["高風險", "bad"],
    medium: ["中風險", "warn"],
    low: ["低風險", "good"]
  };
  const [label, tone] = map[level] || ["未知", "info"];
  return `<span class="badge ${tone}">${label}</span>`;
}

function renderRuntime(data) {
  $("#updatedAt").textContent = formatDate(data.generatedAt);
  $("#runtimePill").textContent = data.runtime.dryRun ? "DRY RUN" : "LIVE";
  $("#runtimePill").className = `runtime-pill ${data.runtime.dryRun ? "" : "badge good"}`;
  $("#promptTemplate").textContent = data.promptTemplate || "";
  $("#sideAutonomyStatus").textContent = data.runtime.autonomyMode ? "自主運行中" : "手動監控";
  $("#sideRuntimeSummary").textContent = `${data.runtime.dryRun ? "Dry-run" : "Live"} · ${data.runtime.hasThreadsCredentials ? "Threads ready" : "Needs Threads token"}`;
  $("#cmdScripts").textContent = data.profitEngine?.generatedScripts?.length || 0;
  $("#cmdSignals").textContent = data.profitEngine?.externalSignals?.length || 0;
  $("#cmdOffers").textContent = data.profitEngine?.offerAutopilot?.activeSyncedProductCount || 0;
  $("#cmdConversions").textContent = data.metrics.conversions || 0;
  $("#cmdGuardrails").textContent = data.profitEngine?.blockedScripts?.length || 0;
}

function pipelineStatusScore(status) {
  const scores = { active: 100, dry_run: 78, watch: 64, manual: 48, paused: 40, blocked: 18 };
  return scores[status] || 0;
}

function buildPipelineFallback(data) {
  const runtime = data.runtime || {};
  const engine = data.profitEngine || {};
  const metrics = data.metrics || {};
  const connectedSources = (engine.sourceStatuses || []).filter((source) => source.status === "connected").length;
  const signalCount = (engine.externalSignals || []).length;
  const scriptCount = (engine.generatedScripts || []).length;
  const hasOptimizer = Boolean(engine.optimizer?.latestPolicy) || (engine.runs || []).some((run) => run.optimizerPolicy);
  const steps = [
    {
      id: "api_intake",
      label: "API / Ad Intake",
      status: connectedSources > 0 ? "active" : signalCount > 0 ? "watch" : "blocked",
      value: `${signalCount} signals`,
      detail: connectedSources > 0 ? `${connectedSources} source(s) connected` : "No live ad or offer feed is connected yet.",
      nextAction: connectedSources > 0 ? "Monitor signal freshness" : "Connect ad or offer feeds"
    },
    {
      id: "ai_scripts",
      label: "AI Script Engine",
      status: runtime.hasOpenAIApiKey ? "active" : scriptCount > 0 ? "watch" : "manual",
      value: `${scriptCount} scripts`,
      detail: runtime.hasOpenAIApiKey ? "AI provider ready" : "Template fallback is active.",
      nextAction: runtime.hasOpenAIApiKey ? "Generate variants" : "Set OPENAI_API_KEY"
    },
    {
      id: "profit_optimizer",
      label: "Profit Optimizer",
      status: hasOptimizer ? "active" : (engine.runs || []).length ? "watch" : "manual",
      value: engine.optimizer?.latestPolicy?.mode || "baseline",
      detail: engine.optimizer?.latestPolicy?.targetAction || "Optimizer will appear after a profit run.",
      nextAction: hasOptimizer ? "Let policy tune the next cycle" : "Run profit engine"
    },
    {
      id: "worker_loop",
      label: "Worker Loop",
      status: runtime.workerEnabled && runtime.autonomyMode ? "active" : runtime.workerEnabled ? "watch" : "blocked",
      value: runtime.autonomyMode ? "autonomous" : "manual",
      detail: runtime.workerEnabled ? "Worker process is enabled." : "Worker is disabled.",
      nextAction: runtime.workerEnabled && runtime.autonomyMode ? "Watch next heartbeat" : "Enable worker and autonomy mode"
    },
    {
      id: "threads_publish",
      label: "Threads Publishing",
      status: runtime.dryRun ? "dry_run" : runtime.hasThreadsCredentials ? "active" : "blocked",
      value: runtime.dryRun ? "dry-run" : "live",
      detail: runtime.dryRun ? "Publishing is simulated." : runtime.hasThreadsCredentials ? "Credentials ready" : "Missing Threads credentials.",
      nextAction: runtime.dryRun ? "Switch live after validation" : "Monitor publishing"
    },
    {
      id: "feedback_loop",
      label: "Conversion Feedback",
      status: Number(metrics.conversions || 0) > 0 ? "active" : "blocked",
      value: `${Number(metrics.conversions || 0)} conversions`,
      detail: Number(metrics.conversions || 0) > 0 ? "Revenue is feeding model scores." : "No conversion feedback yet.",
      nextAction: Number(metrics.conversions || 0) > 0 ? "Scale revenue-backed experiments" : "Connect conversion webhook"
    }
  ];
  const score = Math.round(steps.reduce((total, step) => total + pipelineStatusScore(step.status), 0) / steps.length);
  const blocked = steps.filter((step) => step.status === "blocked").length;
  const nextGate = steps.find((step) => step.status === "blocked") || steps.find((step) => step.status === "watch") || steps[0];
  return {
    summary: {
      mode: runtime.autonomyMode ? "autonomous" : "manual",
      score,
      active: steps.filter((step) => step.status === "active").length,
      blocked,
      readyForUnattended: blocked === 0 && runtime.workerEnabled && runtime.autonomyMode && !runtime.dryRun,
      nextGate: nextGate.label,
      nextAction: nextGate.nextAction
    },
    steps
  };
}

function buildPolicyFallback(data) {
  const metrics = data.metrics || {};
  const runtime = data.runtime || {};
  const queueDepth = Number(metrics.queued || 0);
  const rules = [
    {
      id: "queue_depth",
      label: "Queue depth",
      status: queueDepth <= 50 ? "pass" : "pause",
      value: queueDepth,
      limit: 50,
      action: "Process or review the queue before adding more scheduled posts."
    },
    {
      id: "publish_capacity",
      label: "Dry-run/live capacity",
      status: runtime.dryRun || runtime.hasThreadsCredentials ? "pass" : "pause",
      value: runtime.dryRun ? "dry-run" : "live",
      limit: "ready",
      action: "Set Threads credentials or keep dry-run enabled."
    },
    {
      id: "conversion_feedback",
      label: "Conversion feedback",
      status: Number(metrics.conversions || 0) > 0 ? "pass" : "watch",
      value: Number(metrics.conversions || 0),
      limit: "1+",
      action: "Connect conversion webhook for revenue learning."
    }
  ];
  const pausedRules = rules.filter((rule) => rule.status === "pause");
  return {
    mode: pausedRules.length ? "paused" : runtime.autonomyMode ? "autonomous" : "manual",
    canRunCycle: pausedRules.length === 0,
    canCreatePosts: pausedRules.length === 0,
    canPublishQueue: pausedRules.length === 0,
    nextAction: pausedRules[0]?.action || "Autonomy policy is clear.",
    rules
  };
}

function buildOperatingMapFallback(data) {
  const runtime = data.runtime || {};
  const engine = data.profitEngine || {};
  const metrics = data.metrics || {};
  const pipeline = data.autonomyPipeline || buildPipelineFallback(data);
  const policy = data.autonomyPolicy || buildPolicyFallback(data);
  const sources = engine.sources || [];
  const connectedSources = sources.filter((source) => source.runtimeStatus === "connected").length;
  const signalCount = (engine.externalSignals || []).length;
  const scriptCount = (engine.generatedScripts || []).length;
  const conversionRate = Number(metrics.clicks || 0)
    ? Number(((Number(metrics.conversions || 0) / Number(metrics.clicks || 0)) * 100).toFixed(1))
    : 0;
  const healthScore = Math.round(((pipeline.summary?.score || 0) * 0.7) + (policy.canRunCycle ? 30 : 12));
  const leader = engine.models?.[0] || {};

  return {
    summary: {
      mode: policy.mode === "paused" ? "policy_paused" : runtime.dryRun ? "dry_run" : runtime.autonomyMode ? "autonomous_setup" : "manual_build",
      healthScore,
      objective: engine.objective || "自然真實內容 -> 廣告情報 -> 聯盟成交",
      loopLabel: runtime.dryRun ? "dry-run validation loop" : "autonomy operating loop",
      nextAction: policy.nextAction || pipeline.summary?.nextAction || "Monitor loop",
      unattendedReady: Boolean(pipeline.summary?.readyForUnattended),
      revenue: metrics.revenue || 0,
      conversionRate
    },
    lanes: [
      {
        id: "market_api",
        label: "API / market intake",
        status: connectedSources > 0 ? "active" : signalCount > 0 ? "watch" : "blocked",
        value: `${signalCount} signals`,
        detail: connectedSources > 0 ? `${connectedSources} source(s) connected.` : "Connect ad or affiliate feeds.",
        action: "Sync market signals"
      },
      {
        id: "ai_script_agent",
        label: "AI natural script agent",
        status: runtime.hasOpenAIApiKey ? "active" : scriptCount > 0 ? "watch" : "manual",
        value: `${scriptCount} scripts`,
        detail: runtime.hasOpenAIApiKey ? "AI provider ready." : "Template fallback active.",
        action: runtime.hasOpenAIApiKey ? "Generate variants" : "Connect OpenAI"
      },
      {
        id: "threads_publish_api",
        label: "Threads publish API",
        status: runtime.dryRun ? "dry_run" : runtime.hasThreadsCredentials ? "active" : "blocked",
        value: runtime.dryRun ? "dry-run" : "live",
        detail: runtime.dryRun ? "Publishing is simulated." : "Live publish path.",
        action: "Watch queue"
      },
      {
        id: "conversion_feedback",
        label: "Conversion feedback",
        status: Number(metrics.conversions || 0) > 0 ? "active" : "blocked",
        value: `${Number(metrics.conversions || 0)} conversions`,
        detail: "Revenue events tune future model scoring.",
        action: "Connect postback"
      }
    ],
    flow: [
      {
        id: "research_profit_model",
        label: "Research profit model",
        status: (engine.runs || []).length ? "active" : "manual",
        value: `${(engine.models || []).length} models`,
        detail: leader.name ? `Leader: ${leader.name}` : "Run research to pick a model.",
        signal: engine.experiments?.confidence || "setup"
      },
      {
        id: "rewrite_natural",
        label: "Rewrite as natural Threads scripts",
        status: scriptCount > 0 ? "active" : "manual",
        value: `${scriptCount} scripts`,
        detail: "Turns offers into honest, low-risk posts.",
        signal: "guarded"
      },
      {
        id: "acquire_ads",
        label: "Acquire ad and offer evidence",
        status: signalCount > 0 ? "active" : "blocked",
        value: `${signalCount} signals`,
        detail: "Ads and offers become scoring evidence.",
        signal: connectedSources > 0 ? "live" : "setup"
      },
      {
        id: "schedule_publish",
        label: "Schedule and publish",
        status: Number(metrics.queued || 0) > 0 ? "active" : runtime.dryRun ? "dry_run" : "watch",
        value: `${Number(metrics.queued || 0)} queued`,
        detail: "Validated posts enter the publishing queue.",
        signal: `${Number(metrics.published || 0) + Number(metrics.simulated || 0)} sent`
      },
      {
        id: "learn_optimize",
        label: "Learn and optimize",
        status: Number(metrics.conversions || 0) > 0 ? "active" : Number(metrics.clicks || 0) > 0 ? "watch" : "manual",
        value: `${conversionRate}% CVR`,
        detail: "Feedback updates the next autonomous policy.",
        signal: engine.optimizer?.latestPolicy?.mode || "baseline"
      }
    ],
    decision: {
      title: engine.optimizer?.latestPolicy?.targetAction || "Continue highest scoring model",
      confidence: engine.experiments?.confidence || "setup",
      selectedModel: leader.name || "No model selected",
      selectedOffer: engine.generatedScripts?.[0]?.hook || "No active script",
      policyMode: policy.mode,
      guardrailState: (engine.blockedScripts || []).length ? "needs_review" : "clear",
      nextAction: policy.nextAction || "Run profit engine",
      reasons: [
        ...(engine.optimizer?.latestPolicy?.reasons || []),
        policy.nextAction || "",
        pipeline.summary?.nextAction || ""
      ].filter(Boolean).slice(0, 4)
    }
  };
}

function operatingStatusLabel(status) {
  const labels = {
    active: "active",
    dry_run: "dry-run",
    watch: "watch",
    manual: "manual",
    paused: "paused",
    blocked: "blocked"
  };
  return labels[status] || status || "unknown";
}

function renderOperatingMap(data) {
  const map = data.operatingMap || buildOperatingMapFallback(data);
  const summary = map.summary || {};
  const lanes = map.lanes || [];
  const flow = map.flow || [];
  const decision = map.decision || {};
  const modeClass = summary.unattendedReady ? "active" : summary.mode === "policy_paused" ? "paused" : summary.mode === "dry_run" ? "dry_run" : "watch";

  $("#operatingMapObjective").textContent = summary.objective || "自然真實內容 → 廣告情報 → 聯盟成交";
  $("#operatingMapMode").textContent = String(summary.mode || "manual").replaceAll("_", " ");
  $("#operatingMapMode").className = `status-${modeClass}`;
  $("#operatingMapScore").textContent = `${Number(summary.healthScore || 0)}%`;
  $("#operatingMapLoop").textContent = `${summary.loopLabel || "autonomy loop"} · ${formatMoney(summary.revenue || 0)} · ${Number(summary.conversionRate || 0)}% CVR`;
  $("#operatingMapNextAction").textContent = summary.nextAction || "Monitor loop";

  $("#operatingMapLanes").innerHTML = lanes.map((lane) => `
    <article class="agent-lane status-${escapeHtml(lane.status)}">
      <span>${escapeHtml(operatingStatusLabel(lane.status))}</span>
      <div>
        <strong>${escapeHtml(lane.label)}</strong>
        <p>${escapeHtml(lane.detail)}</p>
      </div>
      <small>${escapeHtml(lane.value)} · ${escapeHtml(lane.action)}</small>
    </article>
  `).join("");

  $("#operatingMapFlow").innerHTML = flow.map((step, index) => `
    <article class="flow-node status-${escapeHtml(step.status)}">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <div>
        <strong>${escapeHtml(step.label)}</strong>
        <p>${escapeHtml(step.detail)}</p>
      </div>
      <footer>
        <b>${escapeHtml(step.value)}</b>
        <small>${escapeHtml(step.signal)}</small>
      </footer>
    </article>
  `).join("");

  $("#operatingMapDecision").innerHTML = `
    <div class="decision-rail-head">
      <span>Autopilot decision</span>
      <strong>${escapeHtml(decision.title || "Monitor")}</strong>
    </div>
    <dl class="decision-facts">
      <div><dt>Confidence</dt><dd>${escapeHtml(decision.confidence || "setup")}</dd></div>
      <div><dt>Model</dt><dd>${escapeHtml(decision.selectedModel || "-")}</dd></div>
      <div><dt>Offer</dt><dd>${escapeHtml(decision.selectedOffer || "-")}</dd></div>
      <div><dt>Policy</dt><dd>${escapeHtml(decision.policyMode || "manual")}</dd></div>
      <div><dt>Guardrails</dt><dd>${escapeHtml(decision.guardrailState || "clear")}</dd></div>
    </dl>
    <div class="decision-reasons">
      ${(decision.reasons || []).map((reason) => `<p>${escapeHtml(reason)}</p>`).join("") || "<p>No decision evidence yet.</p>"}
    </div>
    <small>${escapeHtml(decision.nextAction || "Run profit engine")}</small>
  `;
}

function buildGrowthLoopFallback(data) {
  const runtime = data.runtime || {};
  const engine = data.profitEngine || {};
  const policy = data.autonomyPolicy || buildPolicyFallback(data);
  const metrics = data.metrics || {};
  const scriptCount = (engine.generatedScripts || []).length;
  const signalCount = (engine.externalSignals || []).length;
  const queueDepth = Number(metrics.queued || 0);
  const blockedScriptCount = (engine.blockedScripts || []).length;
  const workerWillRun = Boolean(runtime.workerEnabled && runtime.autonomyMode && policy.canRunCycle);
  const missions = [
    {
      id: "market_signal_ingest",
      lane: "research",
      title: "取得行銷廣告與 offer 訊號",
      priority: signalCount ? "medium" : "high",
      status: signalCount ? "auto" : "needs_config",
      automation: signalCount ? "worker_ingest" : "config_required",
      trigger: `${signalCount} signal(s)`,
      expectedImpact: "讓獲利模型從市場證據學習。",
      action: signalCount ? "Next cycle will ingest sources." : "Connect ad or offer feeds.",
      request: signalCount ? { path: "/api/autonomy/cycle", method: "POST", body: { source: "growth-loop.market", force: true, createPosts: false, publishQueue: false } } : null
    },
    {
      id: "natural_script_generation",
      lane: "content",
      title: "產生自然真實 Threads 腳本文案",
      priority: scriptCount ? "medium" : "high",
      status: policy.canCreatePosts ? "auto" : "paused",
      automation: runtime.hasOpenAIApiKey ? "ai_script_agent" : "template_fallback",
      trigger: `${scriptCount} script(s)`,
      expectedImpact: "產生有揭露、不誇大、可排程的推薦文。",
      action: policy.canCreatePosts ? "Generate scripts." : policy.nextAction,
      request: policy.canCreatePosts ? { path: "/api/profit-engine/run", method: "POST", body: { source: "growth-loop.scripts", force: true, createPosts: true, autoApprove: true } } : null
    },
    {
      id: "queue_publish",
      lane: "distribution",
      title: "發佈或 dry-run 佇列",
      priority: queueDepth ? "high" : "medium",
      status: queueDepth ? policy.canPublishQueue ? "auto" : "paused" : "waiting",
      automation: "queue_runner",
      trigger: `${queueDepth} queued post(s)`,
      expectedImpact: "把通過 guardrail 的內容送入發佈流程。",
      action: queueDepth ? "Process queue." : "Wait for generated scripts.",
      request: queueDepth && policy.canPublishQueue ? { path: "/api/automation/run", method: "POST", body: { source: "growth-loop.queue" } } : null
    },
    {
      id: "guardrail_repair",
      lane: "quality",
      title: "自動修復被擋腳本",
      priority: blockedScriptCount ? "high" : "low",
      status: blockedScriptCount ? "auto" : "waiting",
      automation: blockedScriptCount ? "optimizer_repair" : "observe",
      trigger: `${blockedScriptCount} blocked script(s)`,
      expectedImpact: "降低合規風險與重複發文。",
      action: blockedScriptCount ? "Regenerate safer copy." : "No repair needed.",
      request: blockedScriptCount ? { path: "/api/profit-engine/run", method: "POST", body: { source: "growth-loop.repair", force: true, createPosts: true, autoApprove: true } } : null
    }
  ];
  const autoExecutable = missions.filter((mission) => mission.status === "auto" && mission.request).length;
  const needsConfig = missions.filter((mission) => mission.status === "needs_config").length;
  const paused = missions.filter((mission) => mission.status === "paused").length;
  const waiting = missions.filter((mission) => mission.status === "waiting").length;
  return {
    summary: {
      mode: workerWillRun ? "self_running" : policy.mode === "paused" ? "policy_paused" : "operator_assisted",
      automationScore: Math.max(0, Math.min(100, Math.round(autoExecutable * 18 + (workerWillRun ? 25 : 0) - needsConfig * 8 - paused * 6))),
      workerWillRun,
      autoExecutable,
      needsConfig,
      paused,
      waiting,
      nextMissionTitle: missions.find((mission) => mission.status === "auto")?.title || missions[0]?.title || "Monitor growth loop",
      nextAction: missions.find((mission) => mission.status === "auto")?.action || missions[0]?.action || "Monitor growth loop",
      cadence: runtime.autonomyMode ? "scheduled" : "manual",
      dryRun: runtime.dryRun
    },
    missions,
    controls: {
      enableWorker: runtime.workerEnabled,
      autonomyMode: runtime.autonomyMode,
      policyMode: policy.mode,
      policyAction: policy.nextAction,
      canRunCycle: policy.canRunCycle,
      canCreatePosts: policy.canCreatePosts,
      canPublishQueue: policy.canPublishQueue
    }
  };
}

function renderGrowthLoop(data) {
  const loop = data.growthLoop || buildGrowthLoopFallback(data);
  const summary = loop.summary || {};
  const controls = loop.controls || {};
  const missions = loop.missions || [];
  const modeClass = summary.mode === "self_running" ? "active" : summary.mode === "policy_paused" ? "paused" : "watch";

  $("#growthLoopMode").textContent = `${String(summary.mode || "manual").replaceAll("_", " ")} · ${Number(summary.automationScore || 0)}%`;
  $("#growthLoopMode").className = `growth-mode status-${modeClass}`;
  $("#growthLoopSummary").innerHTML = [
    ["Auto missions", summary.autoExecutable || 0, "can run through API"],
    ["Needs config", summary.needsConfig || 0, "environment or feed setup"],
    ["Paused", summary.paused || 0, "policy guarded"],
    ["Waiting", summary.waiting || 0, "needs data"],
    ["Next", summary.nextMissionTitle || "Monitor", summary.nextAction || "No action"],
    ["Cadence", summary.cadence || "manual", summary.workerWillRun ? "worker scheduled" : "operator assisted"],
    ["Last", summary.lastExecution?.missionTitle || "none", summary.lastExecution ? `${summary.lastExecution.status} · ${formatDate(summary.lastExecution.createdAt)}` : "no executor event"]
  ].map(([label, value, hint]) => `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");

  $("#growthLoopControls").innerHTML = [
    ["Worker", controls.enableWorker ? "on" : "off", "ENABLE_WORKER"],
    ["Autonomy", controls.autonomyMode ? "on" : "off", "AUTONOMY_MODE"],
    ["Policy", controls.policyMode || "manual", controls.policyAction || "-"],
    ["Cycle", controls.canRunCycle ? "ready" : "paused", "run research loop"],
    ["Scripts", controls.canCreatePosts ? "ready" : "paused", "create content"],
    ["Queue", controls.canPublishQueue ? "ready" : "paused", "publish queue"]
  ].map(([label, value, hint]) => `
    <article class="growth-control ${String(value).includes("off") || String(value).includes("paused") ? "is-warn" : "is-ready"}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");

  $("#growthLoopMissions").innerHTML = missions.map((mission, index) => `
    <article class="growth-mission status-${escapeHtml(mission.status)} priority-${escapeHtml(mission.priority)}">
      <span>${escapeHtml(mission.priority)}</span>
      <div>
        <header>
          <strong>${escapeHtml(mission.title)}</strong>
          <small>${escapeHtml(mission.status)} · ${escapeHtml(mission.automation)}</small>
        </header>
        <p>${escapeHtml(mission.expectedImpact)}</p>
        <small>${escapeHtml(mission.trigger)} · ${escapeHtml(mission.action)}</small>
      </div>
      <button class="button ${mission.request ? "" : "secondary"}" type="button" data-growth-mission="${index}" ${mission.request ? "" : "disabled"}>
        ${mission.request ? "Run" : "Monitor"}
      </button>
    </article>
  `).join("");
  state.growthMissions = missions;
}

function renderAutonomyPipeline(data) {
  const pipeline = data.autonomyPipeline || buildPipelineFallback(data);
  const policy = data.autonomyPolicy || buildPolicyFallback(data);
  const summary = pipeline.summary || {};
  const steps = pipeline.steps || [];
  const latestCycle = pipeline.latestCycle || null;
  $("#pipelineMode").textContent = `${summary.mode || "manual"} · ${summary.score || 0}%`;
  $("#pipelineMode").className = `pipeline-mode status-${summary.readyForUnattended ? "active" : summary.blocked ? "blocked" : "watch"}`;
  $("#pipelineSummary").innerHTML = [
    ["Score", `${summary.score || 0}%`, "autonomy pipeline"],
    ["Active", summary.active || 0, "running stages"],
    ["Blocked", summary.blocked || 0, "must fix"],
    ["Next gate", summary.nextGate || "Monitor", summary.nextAction || "No action"],
    ["Last cycle", latestCycle ? `${latestCycle.createdPostCount || 0} posts` : "none", latestCycle ? `${latestCycle.source || "cycle"} · ${formatDate(latestCycle.createdAt)}` : "not run yet"]
  ].map(([label, value, hint]) => `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");
  $("#pipelineSteps").innerHTML = steps.map((step, index) => `
    <article class="pipeline-step status-${escapeHtml(step.status)}">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <div>
        <strong>${escapeHtml(step.label)}</strong>
        <p>${escapeHtml(step.detail)}</p>
        <small>${escapeHtml(step.nextAction)}</small>
      </div>
      <b>${escapeHtml(step.value)}</b>
    </article>
  `).join("");
  $("#policyMode").textContent = `${policy.mode || "manual"} · ${policy.canRunCycle ? "cycle ready" : "cycle paused"}`;
  $("#policyMode").className = `policy-mode status-${policy.canRunCycle ? "pass" : "pause"}`;
  $("#policyRules").innerHTML = (policy.rules || []).map((rule) => `
    <article class="policy-rule status-${escapeHtml(rule.status)}">
      <span>${escapeHtml(rule.status)}</span>
      <div>
        <strong>${escapeHtml(rule.label)}</strong>
        <small>${escapeHtml(rule.value)} / ${escapeHtml(rule.limit)}</small>
      </div>
    </article>
  `).join("");
}

function renderReadiness(data) {
  const readiness = data.readiness || {};
  const summary = readiness.summary || {};
  const modeLabels = {
    blocked: "Blocked",
    dry_run_ready: "Dry-run ready",
    needs_attention: "Needs attention",
    live_ready: "Live ready"
  };
  $("#readinessMode").textContent = modeLabels[summary.mode] || "Unknown";
  $("#readinessMode").className = `readiness-mode ${escapeHtml(summary.mode || "unknown")}`;

  $("#readinessSummary").innerHTML = [
    ["Score", `${summary.score || 0}%`, "autonomy readiness"],
    ["Ready", summary.ready || 0, "checks passing"],
    ["Warnings", summary.warning || 0, "safe but incomplete"],
    ["Blocked", summary.blocked || 0, "must fix"],
    ["Next", summary.nextAction || "-", "highest priority"]
  ].map(([label, value, hint]) => `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");

  const center = readiness.connectorCenter || {};
  const connectors = center.connectors || [];
  $("#connectorCenter").innerHTML = `
    <div class="connector-center-head">
      <div>
        <span>API / AI Connector Center</span>
        <strong>${Number(center.score || 0)}% ready</strong>
      </div>
      <p>${escapeHtml(center.nextAction || "Connect sources to unlock autonomous profit loops.")}</p>
      <small>${Number(center.configured || 0)}/${Number(center.total || connectors.length || 0)} configured · ${Number(center.blocked || 0)} blocked · ${Number(center.error || 0)} error · ${Number(center.backoff || 0)} cooling down</small>
    </div>
    <div class="connector-center-grid">
      ${connectors.map((item) => `
        <article class="connector-card status-${escapeHtml(item.status)}">
          <header>
            <span>${escapeHtml(item.status)}</span>
            <small>${escapeHtml(item.lane)}</small>
          </header>
          <strong>${escapeHtml(item.name)}</strong>
          <p>${escapeHtml(item.purpose)}</p>
          <div class="connector-meta">
            <span>${escapeHtml(item.signal || (item.configured ? "configured" : "setup"))}</span>
            <small>${(item.envKeys || []).map((key) => `<code>${escapeHtml(key)}</code>`).join("")}</small>
          </div>
          <footer>
            <span>${escapeHtml(item.nextRetryAt ? `retry ${formatDate(item.nextRetryAt)}` : item.nextAction || "Monitor")}</span>
            ${item.failureCount ? `<b>${Number(item.failureCount)} fail</b>` : ""}
          </footer>
        </article>
      `).join("") || `<div class="empty-state">No connector inventory available</div>`}
    </div>
  `;

  $("#readinessChecks").innerHTML = (readiness.checks || []).map((check) => `
    <article class="readiness-check status-${escapeHtml(check.status)}">
      <span>${escapeHtml(check.status)}</span>
      <div>
        <strong>${escapeHtml(check.label)}</strong>
        <p>${escapeHtml(check.detail)}</p>
        <small>${escapeHtml(check.action)}</small>
      </div>
    </article>
  `).join("");
}

function timelineBadge(label, tone = "info") {
  return `<span class="timeline-badge ${tone}">${escapeHtml(label)}</span>`;
}

function buildTimelineItems(data) {
  const profitRuns = (data.profitEngine?.runs || []).map((run) => ({
    type: "profit",
    tone: run.blockedScriptCount ? "warn" : "good",
    at: run.createdAt,
    title: `Profit engine selected ${run.selectedModelName || run.selectedModelId || "model"}`,
    detail: `${run.source || "manual"} run · score ${Number(run.score || 0)} · ${run.scriptSource || "template"} scripts`,
    badges: [
      timelineBadge(`${(run.createdPostIds || []).length} posts`, "info"),
      timelineBadge(`${run.blockedScriptCount || 0} blocked`, run.blockedScriptCount ? "warn" : "good"),
      timelineBadge(`${(run.syncedProductIds || []).length} offers`, "info")
    ]
  }));

  const automationRuns = (data.automationRuns || []).map((run) => ({
    type: "publish",
    tone: run.failed ? "warn" : "good",
    at: run.finishedAt || run.startedAt,
    title: `Publishing queue ${run.status || "run"}`,
    detail: `${run.source || "manual"} · processed ${Number(run.processed || 0)} · simulated ${Number(run.simulated || 0)} · published ${Number(run.published || 0)}`,
    badges: [
      timelineBadge(`${run.failed || 0} failed`, run.failed ? "warn" : "good"),
      timelineBadge(`${run.messages?.length || 0} messages`, "info")
    ]
  }));

  const events = (data.recentEvents || []).map((event) => ({
    type: "event",
    tone: "info",
    at: event.createdAt,
    title: String(event.type || "event").replaceAll("_", " "),
    detail: [event.runId, event.postId, event.affiliateLinkId, event.conversionId].filter(Boolean).join(" · ") || event.id,
    badges: [
      event.createdPostCount != null ? timelineBadge(`${event.createdPostCount} created`, "info") : "",
      event.revenueDelta != null ? timelineBadge(formatMoney(event.revenueDelta), "good") : ""
    ].filter(Boolean)
  }));

  return [...profitRuns, ...automationRuns, ...events]
    .filter((item) => item.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 10);
}

function renderOpsTimeline(data) {
  const items = buildTimelineItems(data);
  $("#timelineCount").textContent = `${items.length} events`;
  $("#opTimeline").innerHTML = items.map((item) => `
    <article class="timeline-item tone-${escapeHtml(item.tone)}">
      <div class="timeline-dot" aria-hidden="true"></div>
      <div>
        <div class="timeline-head">
          <strong>${escapeHtml(item.title)}</strong>
          <time>${escapeHtml(formatDate(item.at))}</time>
        </div>
        <p>${escapeHtml(item.detail)}</p>
        <div class="timeline-badges">${item.badges.join("")}</div>
      </div>
    </article>
  `).join("") || `<div class="empty-state">No autonomous operations recorded yet</div>`;
}

function nextAction(priority, title, detail, actionLabel, request = null) {
  return { priority, title, detail, actionLabel, request };
}

function buildNextActions(data) {
  const actions = [];
  const readinessChecks = data.readiness?.checks || [];
  const blockedReadiness = readinessChecks.filter((check) => check.status === "blocked");
  const warningReadiness = readinessChecks.filter((check) => check.status === "warning");
  const engine = data.profitEngine || {};
  const metrics = data.metrics || {};

  blockedReadiness.slice(0, 2).forEach((check) => {
    actions.push(nextAction("critical", check.label, check.detail, check.action));
  });

  if ((engine.externalSignals || []).length === 0) {
    actions.push(nextAction(
      "high",
      "Connect live market signals",
      "The profit engine is still using built-in playbooks. Connect ad or offer feeds so scoring can follow real market demand.",
      "Set AD_INTELLIGENCE_FEED_URLS or AFFILIATE_OFFER_FEED_URLS"
    ));
  }

  if ((engine.generatedScripts || []).length === 0 || (engine.runs || []).length === 0) {
    actions.push(nextAction(
      "high",
      "Run research-to-script cycle",
      "Generate a fresh profit model decision and natural affiliate scripts from the current offer inventory.",
      "Run profit engine",
      {
        path: "/api/profit-engine/run",
        method: "POST",
        body: { source: "next-actions", force: true, createPosts: true, autoApprove: true }
      }
    ));
  }

  if (Number(metrics.queued || 0) > 0) {
    actions.push(nextAction(
      "medium",
      "Process publishing queue",
      `${Number(metrics.queued || 0)} approved post(s) are queued for publishing or dry-run simulation.`,
      "Run queue",
      { path: "/api/automation/run", method: "POST", body: { source: "next-actions" } }
    ));
  }

  if (Number(metrics.drafts || 0) > 0) {
    actions.push(nextAction(
      "medium",
      "Review draft backlog",
      `${Number(metrics.drafts || 0)} draft post(s) are waiting for approval before the publishing loop can move them.`,
      "Review drafts in content factory"
    ));
  }

  if ((engine.blockedScripts || []).length > 0) {
    actions.push(nextAction(
      "high",
      "Inspect guardrail blocks",
      `${engine.blockedScripts.length} script(s) were blocked by compliance or Threads validation rules.`,
      "Open blocked scripts"
    ));
  }

  if (Number(metrics.clicks || 0) > 0 && Number(metrics.conversions || 0) === 0) {
    actions.push(nextAction(
      "medium",
      "Connect conversion feedback",
      "Clicks exist but no conversions are feeding back yet, so model scoring cannot learn from revenue quality.",
      "Configure /api/conversions webhook"
    ));
  }

  warningReadiness.slice(0, 2).forEach((check) => {
    if (!actions.some((action) => action.title === check.label)) {
      actions.push(nextAction("low", check.label, check.detail, check.action));
    }
  });

  if (!actions.length) {
    actions.push(nextAction(
      "low",
      "Monitor next autonomy cycle",
      "No urgent action is needed. Keep watching the timeline, conversion feed, and guardrail blocks.",
      "Continue monitoring"
    ));
  }

  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  return actions
    .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
    .slice(0, 7);
}

function renderNextActions(data) {
  const actions = buildNextActions(data);
  const counts = actions.reduce((acc, action) => {
    acc[action.priority] = (acc[action.priority] || 0) + 1;
    return acc;
  }, {});
  $("#nextActionCount").textContent = `${actions.length} actions`;
  $("#actionSummary").innerHTML = ["critical", "high", "medium", "low"].map((priority) => `
    <article>
      <span>${escapeHtml(priority)}</span>
      <strong>${Number(counts[priority] || 0)}</strong>
    </article>
  `).join("");
  $("#nextActionList").innerHTML = actions.map((action, index) => `
    <article class="next-action priority-${escapeHtml(action.priority)}">
      <span>${escapeHtml(action.priority)}</span>
      <div>
        <strong>${escapeHtml(action.title)}</strong>
        <p>${escapeHtml(action.detail)}</p>
      </div>
      <button class="button ${action.request ? "" : "secondary"}" type="button" data-next-action="${index}">
        ${escapeHtml(action.actionLabel)}
      </button>
    </article>
  `).join("");
  state.nextActions = actions;
}

function buildDecisionBrief(data) {
  const engine = data.profitEngine || {};
  const models = engine.models || [];
  const selected = models[0] || {};
  const runnerUp = models[1] || {};
  const latestRun = (engine.runs || [])[0] || {};
  const metrics = data.metrics || {};
  const readiness = data.readiness?.summary || {};
  const signalCount = (engine.externalSignals || []).length;
  const sourceCount = (engine.sourceStatuses || []).filter((source) => source.status === "connected").length;
  const conversionRate = Number(metrics.clicks || 0)
    ? ((Number(metrics.conversions || 0) / Number(metrics.clicks || 0)) * 100).toFixed(1)
    : "0.0";
  const scoreGap = Number(selected.score || 0) - Number(runnerUp.score || 0);
  const confidenceScore = Math.max(0, Math.min(100,
    Math.round(
      Number(selected.score || 0) * 0.45
      + Number(readiness.score || 0) * 0.25
      + Math.min(signalCount * 8, 16)
      + Math.min(Number(metrics.conversions || 0) * 3, 12)
      + Math.max(scoreGap, 0) * 0.15
    )
  ));
  const confidence = confidenceScore >= 82 ? "high" : confidenceScore >= 62 ? "medium" : "low";

  return {
    confidence,
    confidenceScore,
    selectedModel: selected.name || "No model selected",
    selectedScore: Number(selected.score || 0),
    runnerUp: runnerUp.name || "No runner-up",
    scoreGap,
    latestRunAt: latestRun.createdAt,
    scriptSource: latestRun.scriptSource || (engine.generatedScripts?.[0]?.source || "not generated"),
    evidence: [
      `${models.length} monetization models scored`,
      `${signalCount} external market signal(s), ${sourceCount} connected source(s)`,
      `${Number(metrics.clicks || 0)} clicks, ${Number(metrics.conversions || 0)} conversions, ${conversionRate}% conversion rate`,
      `${(engine.blockedScripts || []).length} guardrail block(s), ${Number(metrics.disclosureCoverage || 0)}% disclosure coverage`
    ],
    rationale: [
      selected.stage ? `Funnel fit: ${selected.stage}` : "Funnel fit is pending until the first profit run completes.",
      selected.monetization ? `Revenue mode: ${selected.monetization}` : "Revenue mode is not selected yet.",
      selected.adAngle ? `Natural ad rewrite angle: ${selected.adAngle}` : "Ad angle will improve after live market feeds are connected.",
      latestRun.source ? `Latest decision source: ${latestRun.source}` : "No autonomous decision run has been recorded yet."
    ],
    gaps: [
      signalCount === 0 ? "Connect ad or offer feeds for real market evidence." : "",
      sourceCount === 0 ? "No live source has reported connected status yet." : "",
      Number(metrics.conversions || 0) === 0 ? "Conversion feedback is still too thin for revenue learning." : "",
      readiness.blocked > 0 ? `${readiness.blocked} readiness blocker(s) remain before live autonomy.` : ""
    ].filter(Boolean)
  };
}

function renderDecisionBrief(data) {
  const brief = buildDecisionBrief(data);
  $("#decisionConfidence").textContent = `${brief.confidence} confidence · ${brief.confidenceScore}%`;
  $("#decisionConfidence").className = `decision-confidence confidence-${escapeHtml(brief.confidence)}`;
  $("#decisionBrief").innerHTML = `
    <article class="decision-card decision-primary">
      <span>Selected model</span>
      <strong>${escapeHtml(brief.selectedModel)}</strong>
      <p>Score ${brief.selectedScore} · gap ${brief.scoreGap >= 0 ? "+" : ""}${brief.scoreGap} vs runner-up</p>
      <small>Runner-up: ${escapeHtml(brief.runnerUp)}</small>
    </article>
    <article class="decision-card">
      <span>Latest run</span>
      <strong>${escapeHtml(brief.scriptSource)}</strong>
      <p>${escapeHtml(brief.latestRunAt ? formatDate(brief.latestRunAt) : "No run yet")}</p>
      <small>Script source and timing help detect fallback behavior.</small>
    </article>
    <article class="decision-card wide">
      <span>Evidence</span>
      <div class="decision-list">
        ${brief.evidence.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
      </div>
    </article>
    <article class="decision-card wide">
      <span>Rationale</span>
      <div class="decision-list">
        ${brief.rationale.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
      </div>
    </article>
    <article class="decision-card wide">
      <span>Evidence gaps</span>
      <div class="decision-list">
        ${(brief.gaps.length ? brief.gaps : ["No major evidence gap detected."]).map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
      </div>
    </article>
  `;
}

function ageLabel(value, referenceValue) {
  if (!value) return "No heartbeat yet";
  const then = new Date(value).getTime();
  const now = referenceValue ? new Date(referenceValue).getTime() : Date.now();
  if (Number.isNaN(then) || Number.isNaN(now)) return "Unknown";
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m ago` : `${hours}h ago`;
}

function buildWorkerHealth(data) {
  const runtime = data.runtime || {};
  const engine = data.profitEngine || {};
  const metrics = data.metrics || {};
  const readiness = data.readiness?.summary || {};
  const lease = data.workerLease || {};
  const automationRun = (data.automationRuns || [])[0] || {};
  const profitRun = (engine.runs || [])[0] || {};
  const recentEvent = (data.recentEvents || [])[0] || {};
  const heartbeatAt = lease.heartbeatAt
    || automationRun.finishedAt
    || automationRun.startedAt
    || profitRun.createdAt
    || engine.lastRunAt
    || recentEvent.createdAt;
  const scheduledAutonomyPosts = Number(engine.scheduledAutonomyPosts || 0);
  const queuedPosts = Number(metrics.queued || 0);
  const queuePressure = queuedPosts + scheduledAutonomyPosts;
  const workerMode = !runtime.workerEnabled
    ? "offline"
    : !runtime.autonomyMode
      ? "manual"
      : runtime.dryRun
        ? "dry_run"
        : "live";
  const modeLabels = {
    offline: "Worker off",
    manual: "Manual monitor",
    dry_run: "Dry-run loop",
    live: "Live autonomy"
  };
  const healthScore = Math.max(0, Math.min(100,
    (runtime.workerEnabled ? 25 : 0)
    + (runtime.autonomyMode ? 20 : 0)
    + (lease.active ? 10 : 0)
    + ((profitRun.createdAt || engine.lastRunAt) ? 15 : 0)
    + ((automationRun.finishedAt || automationRun.startedAt) ? 15 : 0)
    + (Number(readiness.blocked || 0) === 0 ? 10 : 0)
    + ((runtime.dryRun || runtime.hasThreadsCredentials) ? 15 : 0)
  ));
  const notes = [
    !runtime.workerEnabled ? "Enable ENABLE_WORKER=true so the platform can run without manual clicks." : "",
    runtime.workerEnabled && !runtime.autonomyMode ? "Enable AUTONOMY_MODE=true when you want research, scripts, and queue processing to run by schedule." : "",
    runtime.workerEnabled && runtime.autonomyMode && runtime.dryRun ? "Dry-run is protecting the system: it will simulate publishing until Threads credentials are ready." : "",
    !runtime.dryRun && !runtime.hasThreadsCredentials ? "Live mode needs valid Threads credentials before publishing can succeed." : "",
    runtime.workerEnabled && !lease.active ? "No active worker lease is present; another replica may be stale or the worker has not ticked yet." : "",
    lease.active ? `Worker lease is active for ${lease.ownerId || "current owner"}.` : "",
    !heartbeatAt ? "No worker heartbeat has been recorded yet; run the profit engine or queue once to seed history." : "",
    Number(readiness.blocked || 0) > 0 ? `${readiness.blocked} readiness blocker(s) remain before unattended live mode.` : "",
    queuePressure > 0 ? `${queuePressure} post(s) are waiting in autonomous or queue pressure.` : ""
  ].filter(Boolean);

  if (!notes.length) {
    notes.push("Worker health is clear; monitor the next scheduled autonomy loop.");
  }

  return {
    mode: workerMode,
    modeLabel: modeLabels[workerMode],
    healthScore,
    heartbeatAt,
    heartbeatAge: ageLabel(heartbeatAt, data.generatedAt),
    leaseStatus: lease.active ? "active" : lease.stale ? "stale" : "none",
    leaseOwner: lease.ownerId || "-",
    leaseExpiresAt: lease.expiresAt || "",
    leaseTtlSeconds: Number(lease.ttlSeconds || 0),
    nextRunHint: engine.nextRunHint || (runtime.workerEnabled ? "Configured interval" : "手動"),
    latestAutomationStatus: automationRun.status || "No automation run",
    latestProfitSource: profitRun.source || (engine.lastRunAt ? "profit engine" : "No profit run"),
    queuePressure,
    scheduledAutonomyPosts,
    queuedPosts,
    readinessMode: readiness.mode || "unknown",
    readinessBlocked: Number(readiness.blocked || 0),
    notes
  };
}

function renderWorkerHealth(data) {
  const health = buildWorkerHealth(data);
  $("#workerHealthMode").textContent = `${health.modeLabel} · ${health.healthScore}%`;
  $("#workerHealthMode").className = `worker-mode mode-${escapeHtml(health.mode)}`;
  $("#workerHealthGrid").innerHTML = [
    ["Health score", `${health.healthScore}%`, "scheduler readiness"],
    ["Last heartbeat", health.heartbeatAge, health.heartbeatAt ? formatDate(health.heartbeatAt) : "no run recorded"],
    ["Lease", health.leaseStatus, health.leaseExpiresAt ? `${health.leaseTtlSeconds}s ttl · ${health.leaseOwner}` : "no lease owner"],
    ["Next cycle", health.nextRunHint, "from profit engine config"],
    ["Queue pressure", health.queuePressure, `${health.queuedPosts} queued · ${health.scheduledAutonomyPosts} autonomous`],
    ["Automation run", health.latestAutomationStatus, "latest queue worker result"],
    ["Readiness", health.readinessMode, `${health.readinessBlocked} blocker(s)`]
  ].map(([label, value, hint]) => `
    <article class="worker-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");
  $("#workerHealthNotes").innerHTML = health.notes.map((note) => `
    <p>${escapeHtml(note)}</p>
  `).join("");
}

function buildExperimentLoopFallback(data) {
  const engine = data.profitEngine || {};
  const models = engine.models || [];
  const posts = data.posts || [];
  const linksById = new Map((data.affiliateLinks || []).map((link) => [link.id, link]));
  const runs = engine.runs || [];
  const signals = engine.externalSignals || [];
  const totalScore = models.reduce((total, model) => total + Number(model.score || 0), 0) || 1;
  const experiments = models.map((model, index) => {
    const modelPosts = posts.filter((post) => post.funnelRatio === model.id);
    const linkIds = new Set(modelPosts.map((post) => post.affiliateLinkId).filter(Boolean));
    const modelLinks = [...linkIds].map((id) => linksById.get(id)).filter(Boolean);
    const clicks = modelLinks.reduce((total, link) => total + Number(link.clicks || 0), 0);
    const conversions = modelLinks.reduce((total, link) => total + Number(link.conversions || 0), 0);
    const revenue = modelLinks.reduce((total, link) => total + Number(link.revenue || 0), 0);
    const blockedScriptCount = runs
      .filter((run) => run.selectedModelId === model.id)
      .reduce((total, run) => total + Number(run.blockedScriptCount || 0), 0);
    const status = blockedScriptCount > 0 && modelPosts.length === 0
      ? "blocked"
      : conversions > 0 && Number(model.score || 0) >= 82
        ? "scaling"
        : modelPosts.length > 0
          ? "learning"
          : index === 0
            ? "ready"
            : "watching";
    return {
      modelId: model.id,
      name: model.name,
      recommendation: model.recommendation,
      status,
      score: Number(model.score || 0),
      allocationPct: Math.max(index === 0 ? 25 : 8, Math.round((Number(model.score || 0) / totalScore) * 100)),
      hypothesis: model.adAngle,
      stage: model.stage,
      postCount: modelPosts.length,
      scheduledCount: modelPosts.filter((post) => ["draft", "scheduled", "container_created"].includes(post.status)).length,
      clicks,
      conversions,
      revenue,
      conversionRate: clicks ? Number(((conversions / clicks) * 100).toFixed(1)) : 0,
      epc: clicks ? Number((revenue / clicks).toFixed(2)) : 0,
      blockedScriptCount,
      nextAction: conversions > 0 ? "Scale adjacent hooks" : modelPosts.length > 0 ? "Collect publish data" : "Seed first scripts"
    };
  });
  const optimizationQueue = [
    !signals.length ? {
      priority: "high",
      modelId: "market_signals",
      title: "Connect market evidence",
      action: "Add ad or affiliate offer feeds so experiments optimize from real demand."
    } : null,
    ...experiments.map((experiment) => {
      if (experiment.blockedScriptCount > 0) {
        return {
          priority: "high",
          modelId: experiment.modelId,
          title: "Repair blocked scripts",
          action: "Regenerate safer scripts before the next publish cycle."
        };
      }
      if (experiment.postCount === 0) {
        return {
          priority: experiment.recommendation === "primary" ? "high" : "medium",
          modelId: experiment.modelId,
          title: "Seed first experiment",
          action: "Create natural scripts so this model can collect traffic evidence."
        };
      }
      return {
        priority: experiment.conversions > 0 ? "medium" : "low",
        modelId: experiment.modelId,
        title: experiment.conversions > 0 ? "Scale winning angle" : "Wait for publish data",
        action: experiment.nextAction
      };
    })
  ].filter(Boolean).slice(0, 6);
  const leader = experiments[0] || {};
  const totalExperimentPosts = experiments.reduce((total, item) => total + Number(item.postCount || 0), 0);
  const totalExperimentRevenue = experiments.reduce((total, item) => total + Number(item.revenue || 0), 0);
  const confidence = leader.conversions > 0
    ? "revenue-backed"
    : leader.clicks > 0
      ? "traffic-backed"
      : engine.lastRunAt
        ? "model-backed"
        : "setup";
  return {
    loopState: engine.autonomyEnabled ? "autonomous" : "manual",
    confidence,
    activeExperimentCount: experiments.filter((item) => ["ready", "learning", "scaling"].includes(item.status)).length,
    totalExperimentPosts,
    totalExperimentRevenue,
    leaderModelId: leader.modelId || "",
    leaderName: leader.name || "No experiment selected",
    learningVelocity: `${runs.length} run(s) · ${signals.length} signal(s)`,
    experiments,
    optimizationQueue
  };
}

function buildOptimizerDecisionFallback(loop) {
  const action = (loop.optimizationQueue || []).find((item) => item.modelId !== "market_signals")
    || (loop.optimizationQueue || [])[0]
    || null;
  const modeMap = {
    "Scale winning angle": "scale",
    "Rewrite offer bridge": "bridge_rewrite",
    "Repair blocked scripts": "repair_guardrails",
    "Seed first experiment": "explore"
  };
  return {
    mode: modeMap[action?.title] || "baseline",
    targetModelId: action?.modelId || loop.leaderModelId || "",
    targetAction: action?.title || "Continue leader",
    scriptCountDelta: action?.title === "Scale winning angle" ? 1 : action?.title === "Repair blocked scripts" ? -1 : 0,
    guardrailMode: action?.title === "Repair blocked scripts" ? "strict" : "standard",
    marketSignalGap: (loop.learningVelocity || "").includes("0 signal"),
    reasons: [
      action?.action || "No urgent optimizer action is pending.",
      (loop.learningVelocity || "").includes("0 signal") ? "No external market signal is connected yet." : ""
    ].filter(Boolean)
  };
}

function renderExperimentLoop(data) {
  const loop = data.profitEngine?.experiments?.experiments?.length
    ? data.profitEngine.experiments
    : buildExperimentLoopFallback(data);
  const experiments = loop.experiments || [];
  const queue = loop.optimizationQueue || [];
  const optimizer = data.profitEngine?.optimizer?.latestPolicy || buildOptimizerDecisionFallback(loop);
  $("#experimentMode").textContent = `${loop.loopState || "manual"} · ${loop.confidence || "setup"}`;
  $("#experimentMode").className = `experiment-mode confidence-${escapeHtml(loop.confidence || "setup")}`;
  $("#experimentSummary").innerHTML = [
    ["Leader", loop.leaderName || "No experiment", loop.leaderModelId || "not selected"],
    ["Active", loop.activeExperimentCount || 0, "models in play"],
    ["Posts", loop.totalExperimentPosts || 0, "experiment content"],
    ["Revenue", formatMoney(loop.totalExperimentRevenue || 0), "attributed links"],
    ["Velocity", loop.learningVelocity || "0 run(s)", "learning inputs"]
  ].map(([label, value, hint]) => `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");

  $("#optimizerDecision").innerHTML = `
    <article class="optimizer-card">
      <span>Optimizer mode</span>
      <strong>${escapeHtml(optimizer.mode || "baseline")}</strong>
      <p>${escapeHtml(optimizer.targetAction || "Continue leader")}</p>
    </article>
    <article class="optimizer-card">
      <span>Target model</span>
      <strong>${escapeHtml(optimizer.targetModelId || "leader")}</strong>
      <p>${escapeHtml(`scripts ${Number(optimizer.scriptCountDelta || 0) >= 0 ? "+" : ""}${Number(optimizer.scriptCountDelta || 0)} · ${optimizer.guardrailMode || "standard"} guardrails`)}</p>
    </article>
    <article class="optimizer-card wide">
      <span>Decision reasons</span>
      <div class="optimizer-reasons">
        ${(optimizer.reasons || ["No optimizer reason recorded."]).map((reason) => `<p>${escapeHtml(reason)}</p>`).join("")}
      </div>
    </article>
  `;

  $("#experimentCards").innerHTML = experiments.map((experiment) => `
    <article class="experiment-card status-${escapeHtml(experiment.status)}" data-profit-experiment="${escapeHtml(experiment.modelId)}">
      <div class="experiment-card-head">
        <span>${escapeHtml(experiment.status)}</span>
        <strong>${escapeHtml(experiment.name)}</strong>
      </div>
      <div class="experiment-score">
        <b style="width:${Math.max(4, Math.min(Number(experiment.allocationPct || 0), 100))}%"></b>
      </div>
      <p>${escapeHtml(experiment.hypothesis || experiment.stage)}</p>
      <div class="experiment-metrics">
        <span>Score <b>${Number(experiment.score || 0)}</b></span>
        <span>Alloc <b>${Number(experiment.allocationPct || 0)}%</b></span>
        <span>Posts <b>${Number(experiment.postCount || 0)}</b></span>
        <span>CVR <b>${Number(experiment.conversionRate || 0)}%</b></span>
        <span>EPC <b>${formatMoney(experiment.epc || 0)}</b></span>
      </div>
      <small>${escapeHtml(experiment.nextAction || "Monitor")}</small>
    </article>
  `).join("") || `<div class="empty-state">No experiments yet</div>`;

  $("#optimizationQueue").innerHTML = `
    <strong>Optimization queue</strong>
    ${queue.map((item) => `
      <article class="optimization-item priority-${escapeHtml(item.priority)}">
        <span>${escapeHtml(item.priority)}</span>
        <div>
          <strong>${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(item.action)}</p>
          <small>${escapeHtml(item.modelId)}</small>
        </div>
      </article>
    `).join("") || `<div class="empty-state">No optimization action pending</div>`}
  `;
}

function renderProfitEngine(data) {
  const engine = data.profitEngine || {};
  const sideConnectors = data.readiness?.connectorCenter?.connectors || engine.sources || [];
  $("#sideConnectorCount").textContent = sideConnectors.length;
  $("#sideConnectorList").innerHTML = sideConnectors.map((source) => `
    <div class="side-connector">
      <span class="status-${escapeHtml(source.status || source.runtimeStatus)} ${["ready", "connected"].includes(source.status || source.runtimeStatus) ? "is-on" : ""}"></span>
      <div>
        <strong>${escapeHtml(source.name)}</strong>
        <small>${escapeHtml(source.status || source.runtimeStatus || "setup")}</small>
      </div>
    </div>
  `).join("");

  const offer = engine.offerAutopilot || {};
  const recovery = engine.sourceRecovery || {};
  $("#autopilotSummary").innerHTML = [
    ["Sources", (engine.sourceStatuses || []).length, "API / feed checks"],
    ["Signals", (engine.externalSignals || []).length, "Ad + offer inputs"],
    ["Recovery", recovery.mode || "setup", recovery.nextRetryAt ? `next retry ${formatDate(recovery.nextRetryAt)}` : `${recovery.errors || 0} error(s)`],
    ["Offers", offer.activeSyncedProductCount || 0, `max ${offer.maxOffersPerRun || 0}/run`],
    ["Queued", engine.scheduledAutonomyPosts || 0, "autonomous posts"],
    ["Blocked", (engine.blockedScripts || []).length, "guardrail catches"]
  ].map(([label, value, hint]) => `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");

  $("#connectorList").innerHTML = (engine.sources || []).map((source) => `
    <article class="connector-item">
      <span>${escapeHtml(source.runtimeStatus || source.status)}</span>
      <strong>${escapeHtml(source.name)}</strong>
      <p>${escapeHtml(source.nextRetryAt ? `${source.message || source.role} Next retry ${formatDate(source.nextRetryAt)}.` : source.message || source.role)}</p>
    </article>
  `).join("");

  $("#profitModels").innerHTML = (engine.models || []).map((model) => `
    <article class="profit-model-card">
      <div>
        <span class="score-pill">${Number(model.score || 0)}</span>
        <strong>${escapeHtml(model.name)}</strong>
      </div>
      <p>${escapeHtml(model.stage)}</p>
      <small>${escapeHtml(model.monetization)} · ${escapeHtml(model.marginProfile)}</small>
    </article>
  `).join("");

  $("#profitScripts").innerHTML = (engine.generatedScripts || []).map((script) => {
    const body = String(script.post || "");
    return `
      <article class="script-card">
        <span>${escapeHtml(script.source || "template")}</span>
        <strong>${escapeHtml(script.hook)}</strong>
        <p>${escapeHtml(body).slice(0, 220)}${body.length > 220 ? "..." : ""}</p>
      </article>
    `;
  }).join("") || `<div class="empty-state">尚未產生自主腳本</div>`;

  $("#profitSourceStatuses").innerHTML = (engine.sourceStatuses || []).map((source) => `
    <article class="intel-row">
      <span class="badge ${source.status === "connected" ? "good" : source.status === "error" ? "bad" : "warn"}">
        ${escapeHtml(source.status)}
      </span>
      <div>
        <strong>${escapeHtml(source.name || source.id)}</strong>
        <p>${escapeHtml(source.nextRetryAt ? `${source.message || ""} Next retry ${formatDate(source.nextRetryAt)}.` : source.message || "")}</p>
      </div>
      <small>${Number(source.count || 0).toLocaleString()}${source.failureCount ? ` · ${Number(source.failureCount)} fail` : ""}</small>
    </article>
  `).join("") || `<div class="empty-state">No live source check yet</div>`;

  $("#profitSignals").innerHTML = (engine.externalSignals || []).map((signal) => `
    <article class="signal-row">
      <span>${escapeHtml(signal.kind || "signal")}</span>
      <div>
        <strong>${escapeHtml(signal.title || signal.productName || signal.source)}</strong>
        <p>${escapeHtml(signal.angle || signal.offer || "")}</p>
        ${signal.adSnapshotUrl ? `<a href="${escapeHtml(signal.adSnapshotUrl)}" target="_blank" rel="noreferrer">snapshot</a>` : ""}
      </div>
    </article>
  `).join("") || `<div class="empty-state">No external ad or offer signals yet</div>`;

  $("#profitGuardrails").innerHTML = (engine.guardrails || []).map((item) => `
    <span>${escapeHtml(item)}</span>
  `).join("");

  $("#profitBlockedScripts").innerHTML = (engine.blockedScripts || []).length ? `
    <strong>Blocked scripts</strong>
    ${(engine.blockedScripts || []).map((script) => `
      <article class="blocked-script-row">
        <span class="badge bad">blocked</span>
        <div>
          <strong>${escapeHtml(script.hook || script.type || "script")}</strong>
          <p>${escapeHtml(script.reason || "Guardrail blocked this script.")}</p>
          ${script.freshness ? `<small>Matched ${escapeHtml(script.freshness.matchedPostId)} · ${Math.round(Number(script.freshness.score || 0) * 100)}%</small>` : ""}
        </div>
      </article>
    `).join("")}
  ` : "";
}

function renderFactoryMetrics(data) {
  const metrics = data.metrics;
  const rows = [
    ["草稿", metrics.drafts],
    ["AI 生成中", data.posts.filter((post) => post.status === "draft" && post.contentType).length],
    ["待審核", data.posts.filter((post) => post.approved === false).length],
    ["待發佈", metrics.queued],
    ["已排程", metrics.published + metrics.simulated]
  ];
  $("#factoryMetrics").innerHTML = rows.map(([label, value]) => `
    <div class="mini-kpi">
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(label)}</span>
    </div>
  `).join("");
}

function linkById(data, id) {
  return data.affiliateLinks.find((link) => link.id === id);
}

function renderPosts(data) {
  const rows = data.posts.slice(0, 8).map((post) => {
    const link = linkById(data, post.affiliateLinkId);
    const approveDisabled = post.approved ? "disabled" : "";
    const publishDisabled = ["published", "simulated", "failed"].includes(post.status) ? "disabled" : "";
    return `
      <tr>
        <td>
          <p class="post-copy">${escapeHtml(post.hook || post.text)}</p>
          <div class="post-meta">
            <span>${escapeHtml(post.contentType || "手動")}</span>
            <span>${escapeHtml(post.validation.threadsUnits)} units</span>
          </div>
        </td>
        <td>${statusBadge(post.status)}</td>
        <td>${escapeHtml(post.topicTag || "-")}</td>
        <td>${escapeHtml(link ? link.slug : "-")}</td>
        <td>${escapeHtml(formatDate(post.scheduledAt))}</td>
        <td>
          <div class="row-actions">
            <button class="button secondary" data-action="approve" data-id="${post.id}" ${approveDisabled}>審核</button>
            <button class="button" data-action="publish" data-id="${post.id}" ${publishDisabled}>發佈</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
  $("#postRows").innerHTML = rows || `<tr><td colspan="6">No posts</td></tr>`;
}

function renderRisk(data) {
  const counts = data.posts.reduce((acc, post) => {
    acc[post.validation.risk.level] = (acc[post.validation.risk.level] || 0) + 1;
    return acc;
  }, { high: 0, medium: 0, low: 0 });
  const total = data.posts.length || 1;
  const highPct = Math.round((counts.high / total) * 100);
  const mediumPct = Math.round(((counts.high + counts.medium) / total) * 100);
  $("#riskCount").textContent = counts.high + counts.medium;
  $("#riskSummary").innerHTML = [
    ["全部", data.posts.length],
    ["高風險", counts.high],
    ["中風險", counts.medium],
    ["低風險", counts.low]
  ].map(([label, value]) => `<div class="risk-tab">${label} <strong>${value}</strong></div>`).join("");

  const riskRows = data.posts
    .slice()
    .sort((a, b) => {
      const score = { high: 0, medium: 1, low: 2 };
      return score[a.validation.risk.level] - score[b.validation.risk.level];
    })
    .slice(0, 5);
  $("#riskRows").innerHTML = riskRows.map((post) => {
    const note = post.validation.warnings[0] || post.riskNote || "低風險：未保證收益，無假見證。";
    return `
      <article class="risk-item">
        <div>
          <strong>${escapeHtml(post.hook || post.contentType || post.id)}</strong>
          <p>${escapeHtml(note)}</p>
        </div>
        ${riskBadge(post.validation.risk.level)}
      </article>
    `;
  }).join("");

  $("#riskDonut").style.background = `conic-gradient(var(--coral) 0 ${highPct}%, var(--amber) ${highPct}% ${mediumPct}%, var(--green) ${mediumPct}% 100%)`;
  $("#riskDonut").innerHTML = `<strong>${data.posts.length}</strong><span>總數</span>`;
  $("#riskLegend").innerHTML = `
    <div><span><b style="background:var(--coral)"></b>誇大宣稱</span><strong>${counts.high}</strong></div>
    <div><span><b style="background:var(--amber)"></b>收益保證</span><strong>${counts.medium}</strong></div>
    <div><span><b style="background:var(--green)"></b>標示建議</span><strong>${counts.low}</strong></div>
  `;
}

function renderRevenue(data) {
  const clicks = data.metrics.clicks;
  const conversions = data.metrics.conversions;
  const revenue = data.metrics.revenue;
  const attribution = data.attribution || {};
  const attributionSummary = attribution.summary || {};
  const exposure = clicks * 12 + 1540;
  const conversionRate = clicks ? ((conversions / clicks) * 100).toFixed(1) : "0.0";
  const refundRate = "2.1%";

  $("#revenueCards").innerHTML = [
    ["點擊數", clicks.toLocaleString(), "▲ 18.6%"],
    ["轉換數", conversions.toLocaleString(), "▲ 15.3%"],
    ["預估收益", formatMoney(revenue), "▲ 21.4%"],
    ["退款率", refundRate, "▼ 0.6%"]
  ].map(([label, value, delta]) => `
    <article class="revenue-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(delta)}</small>
    </article>
  `).join("");

  $("#revenueFunnel").innerHTML = [
    ["曝光", exposure],
    ["點擊", clicks],
    ["加購", Math.max(conversions * 4, 1)],
    ["轉換", conversions],
    ["預估收益", formatMoney(revenue)]
  ].map(([label, value]) => `
    <div class="funnel-step"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
  `).join("");

  $("#attributionGrid").innerHTML = `
    <article class="attribution-card">
      <span>Attributed revenue</span>
      <strong>${formatMoney(attributionSummary.attributedRevenue || 0)}</strong>
      <small>${Number(attributionSummary.attributedConversions || 0)} conversion(s), ${Number(attributionSummary.attributedClicks || 0)} click(s)</small>
    </article>
    <article class="attribution-card">
      <span>Top model</span>
      <strong>${escapeHtml(attribution.topModels?.[0]?.modelId || "learning")}</strong>
      <small>${formatMoney(attribution.topModels?.[0]?.revenue || 0)} · ${Number(attribution.topModels?.[0]?.conversions || 0)} conversion(s)</small>
    </article>
    <article class="attribution-list">
      <strong>Top attributed scripts</strong>
      ${(attribution.topPosts || []).map((post) => `
        <div>
          <span>${escapeHtml(post.hook || post.postId)}</span>
          <small>${escapeHtml(post.modelId || "manual")} · ${Number(post.clicks || 0)} click(s) · ${formatMoney(post.revenue || 0)}</small>
        </div>
      `).join("") || `<p>No post-level attribution yet</p>`}
    </article>
  `;

  $("#linkList").innerHTML = data.affiliateLinks.map((link) => `
    <div class="link-row">
      <strong>${escapeHtml(link.slug)}</strong>
      <span>${Number(link.clicks || 0).toLocaleString()}</span>
      <span>${Number(link.conversions || 0).toLocaleString()}</span>
      <span>${formatMoney(link.revenue)}</span>
    </div>
  `).join("");

  $("#conversionEvents").innerHTML = `
    <strong>Recent conversions</strong>
    ${(data.conversionEvents || []).map((event) => {
      const link = linkById(data, event.affiliateLinkId);
      return `
        <article class="conversion-row">
          <span class="badge ${event.status === "approved" || event.status === "paid" ? "good" : "warn"}">${escapeHtml(event.status)}</span>
          <div>
            <strong>${escapeHtml(link ? link.slug : event.affiliateLinkId)}</strong>
            <p>${escapeHtml(event.networkEventId || event.id)} · ${formatDate(event.occurredAt)} · ${escapeHtml(event.postId || event.modelId || "unattributed")}</p>
          </div>
          <small>${formatMoney(event.commissionValue)}</small>
        </article>
      `;
    }).join("") || `<div class="empty-state">No conversion webhook events yet</div>`}
  `;
}

function renderCampaigns(data) {
  $("#campaignList").innerHTML = data.campaigns.map((campaign) => {
    const products = data.products.filter((product) => product.campaignId === campaign.id);
    const posts = data.posts.filter((post) => post.campaignId === campaign.id);
    return `
      <article class="campaign-item">
        <header>
          <strong>${escapeHtml(campaign.name)}</strong>
          <span class="badge good">${escapeHtml(campaign.status)}</span>
        </header>
        <div class="mini-metrics">
          <span>${escapeHtml(campaign.targetPersona)}</span>
          <span>${products.length} products</span>
          <span>${posts.length} posts</span>
        </div>
      </article>
    `;
  }).join("");
}

function populateForm(data) {
  const campaignSelect = $("#campaignSelect");
  const productSelect = $("#productSelect");
  const selectedCampaign = campaignSelect.value || data.campaigns[0]?.id;
  campaignSelect.innerHTML = data.campaigns.map((campaign) => (
    `<option value="${campaign.id}" ${campaign.id === selectedCampaign ? "selected" : ""}>${escapeHtml(campaign.name)}</option>`
  )).join("");

  const products = data.products.filter((product) => product.campaignId === campaignSelect.value);
  productSelect.innerHTML = products.map((product) => (
    `<option value="${product.id}">${escapeHtml(product.name)}</option>`
  )).join("");

  if (!$("#scheduledAt").value) {
    const date = new Date(Date.now() + 30 * 60 * 1000);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    $("#scheduledAt").value = local;
  }
}

function render(data) {
  state.dashboard = data;
  renderRuntime(data);
  renderOperatingMap(data);
  renderGrowthLoop(data);
  renderAutonomyPipeline(data);
  renderReadiness(data);
  renderOpsTimeline(data);
  renderNextActions(data);
  renderDecisionBrief(data);
  renderWorkerHealth(data);
  renderExperimentLoop(data);
  renderProfitEngine(data);
  renderFactoryMetrics(data);
  renderPosts(data);
  renderRisk(data);
  renderRevenue(data);
  renderCampaigns(data);
  populateForm(data);
}

async function refresh() {
  render(await api("/api/dashboard"));
}

async function runQueue() {
  const result = await api("/api/automation/run", {
    method: "POST",
    body: { source: "dashboard" }
  });
  render(result.dashboard);
  showToast(`Queue finished: ${result.run.status}`);
}

async function generateDrafts(autoApprove) {
  const topic = $("#topicInput").value.trim() || "AI 自動化聯盟行銷";
  await api("/api/automation/generate", {
    method: "POST",
    body: {
      topic,
      autoApprove,
      campaignId: $("#campaignSelect").value,
      productId: $("#productSelect").value
    }
  });
  await refresh();
  showToast(autoApprove ? "已產生 5 則並排程" : "已產生 5 則草稿");
}

async function runProfitEngine() {
  const result = await api("/api/profit-engine/run", {
    method: "POST",
    body: {
      source: "dashboard",
      force: true,
      createPosts: true,
      autoApprove: true
    }
  });
  render(result.dashboard);
  const created = result.result.createdPosts?.length || 0;
  showToast(`自主獲利引擎完成，建立 ${created} 則排程文案`);
}

async function runAutonomyCycle() {
  const result = await api("/api/autonomy/cycle", {
    method: "POST",
    body: {
      source: "dashboard_cycle",
      force: true,
      createPosts: true,
      autoApprove: true,
      publishQueue: true
    }
  });
  render(result.dashboard);
  const cycle = result.cycle || {};
  showToast(`自主循環完成：${Number(cycle.createdPostCount || 0)} 則文案，處理 ${Number(cycle.processed || 0)} 則佇列`);
}

async function handlePostAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  button.disabled = true;
  if (action === "approve") {
    await api(`/api/posts/${id}/approve`, { method: "POST", body: {} });
    await refresh();
    showToast("Post approved");
  }
  if (action === "publish") {
    const result = await api(`/api/posts/${id}/publish-now`, { method: "POST", body: {} });
    render(result.dashboard);
    showToast(`Publish flow: ${result.run.status}`);
  }
}

async function submitCompose(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const scheduledAt = form.get("scheduledAt")
    ? new Date(form.get("scheduledAt")).toISOString()
    : new Date().toISOString();
  await api("/api/posts", {
    method: "POST",
    body: {
      campaignId: form.get("campaignId"),
      productId: form.get("productId"),
      text: form.get("text"),
      topicTag: form.get("topicTag"),
      scheduledAt,
      approved: form.get("approved") === "on"
    }
  });
  event.currentTarget.reset();
  await refresh();
  showToast("Post created");
}

async function handleNextAction(event) {
  const button = event.target.closest("button[data-next-action]");
  if (!button) return;
  const action = state.nextActions?.[Number(button.dataset.nextAction)];
  if (!action) return;
  if (!action.request) {
    showToast(action.actionLabel);
    return;
  }
  button.disabled = true;
  const result = await api(action.request.path, {
    method: action.request.method || "POST",
    body: action.request.body || {}
  });
  if (result.dashboard) render(result.dashboard);
  else await refresh();
  showToast(`${action.title} completed`);
}

async function handleGrowthMission(event) {
  const button = event.target.closest("button[data-growth-mission]");
  if (!button) return;
  const mission = state.growthMissions?.[Number(button.dataset.growthMission)];
  if (!mission?.request) return;
  button.disabled = true;
  const result = await api("/api/growth-loop/run", {
    method: "POST",
    body: {
      source: "dashboard_growth",
      missionId: mission.id,
      force: true
    }
  });
  if (result.dashboard) render(result.dashboard);
  else await refresh();
  showToast(`${mission.title} completed`);
}

function bindEvents() {
  $("#refreshBtn").addEventListener("click", refresh);
  $("#runBtn").addEventListener("click", runQueue);
  $("#profitRunBtn").addEventListener("click", () => {
    runProfitEngine().catch((error) => showToast(error.message));
  });
  $("#cycleRunBtn").addEventListener("click", () => {
    runAutonomyCycle().catch((error) => showToast(error.message));
  });
  $("#generateBtn").addEventListener("click", () => generateDrafts(false));
  $("#autoGenerateBtn").addEventListener("click", () => generateDrafts(true));
  $("#topicGenerateBtn").addEventListener("click", () => generateDrafts(false));
  $("#postRows").addEventListener("click", (event) => {
    handlePostAction(event).catch((error) => {
      showToast(error.message);
      refresh();
    });
  });
  $("#composeForm").addEventListener("submit", (event) => {
    submitCompose(event).catch((error) => showToast(error.message));
  });
  $("#nextActionList").addEventListener("click", (event) => {
    handleNextAction(event).catch((error) => {
      showToast(error.message);
      refresh();
    });
  });
  $("#growthLoopMissions").addEventListener("click", (event) => {
    handleGrowthMission(event).catch((error) => {
      showToast(error.message);
      refresh();
    });
  });
  $("#campaignSelect").addEventListener("change", () => populateForm(state.dashboard));
}

bindEvents();
refresh().catch((error) => showToast(error.message));

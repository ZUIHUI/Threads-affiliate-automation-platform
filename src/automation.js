const crypto = require("node:crypto");

const { validatePost } = require("./validators");
const { createTextContainer, publishContainer } = require("./threadsClient");
const { buildPrompt, generatePromptDrafts } = require("./contentTemplates");
const { generateOpenAIDrafts, shouldUseOpenAI } = require("./openaiClient");
const { buildProfitDashboard } = require("./profitEngine");
const { buildAutonomyReadiness, buildLivePublishingGate } = require("./readiness");
const {
  STATUS,
  approvePost,
  assertPublishable,
  buildReviewSummary,
  effectiveReviewStatus,
  prepareGeneratedPostForReview,
  refreshReviewMetadata
} = require("./postReview");
const { evaluateContentFatigue } = require("./contentFatigue");
const { assertMonetizablePost, isMonetizableLink } = require("./offerQuality");
const { publicContextSummary } = require("./offerPageContext");
const { resolveOfferResearchContext } = require("./offerWebResearch");
const {
  commercialPostText,
  editorialPostText,
  explicitTopicTag,
  hasCommercialDisclosure
} = require("./contentPolicy");

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function slugify(value) {
  return String(value || "link")
    .trim()
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `link-${Date.now()}`;
}

function trackingUrl(config, slug, attribution = {}) {
  const url = new URL(`${config.publicBaseUrl.replace(/\/$/, "")}/r/${slug}`);
  const params = {
    post: attribution.postId,
    model: attribution.modelId,
    campaign: attribution.campaignId,
    product: attribution.productId
  };
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  return url.toString();
}

function sum(items, picker) {
  return items.reduce((total, item) => total + Number(picker(item) || 0), 0);
}

function revenueByCurrency(links) {
  return links.reduce((totals, link) => {
    const currency = String(link.currency || "USD").toUpperCase();
    totals[currency] = Number(totals[currency] || 0) + Number(link.revenue || 0);
    return totals;
  }, {});
}

function formatMoney(value) {
  return `$${Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function formatDateTime(value) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString();
}

function findById(items, id) {
  return items.find((item) => item.id === id);
}

function attachConfiguredProductLink(post, link, config, baseUrl = "") {
  const base = baseUrl || trackingUrl(config, link.slug);
  const productUrl = String(link.targetUrl || "").trim();
  post.linkAttachment = productUrl;
  if (post.text && base && post.text.includes(base)) {
    post.text = post.text.replaceAll(base, productUrl);
  }
  post.trackingCode = post.id;
  return post;
}

function resolvePostCreator(value) {
  const creator = String(value || "").trim();
  return creator.length ? creator : null;
}

function pipelineStatusScore(status) {
  const scores = {
    active: 100,
    dry_run: 78,
    watch: 64,
    manual: 48,
    paused: 40,
    blocked: 18
  };
  return scores[status] || 0;
}

function isWithinLastDay(value) {
  const at = new Date(value || 0).getTime();
  return Number.isFinite(at) && at >= Date.now() - 24 * 60 * 60 * 1000;
}

function policyRule(id, label, status, value, limit, action) {
  return { id, label, status, value, limit, action };
}

function buildAutonomyPolicy(state, config) {
  const capacity = capacityRemaining(state);
  const cyclesToday = (state.events || []).filter((event) =>
    event.type === "autonomy.cycle.completed" && isWithinLastDay(event.createdAt)
  ).length;
  const createdAutonomyPostsToday = (state.posts || []).filter((post) =>
    post.contentType === "自然推薦腳本" && isWithinLastDay(post.createdAt)
  ).length;
  const queueDepth = (state.posts || []).filter((post) =>
    post.approved && [STATUS.scheduled, STATUS.containerCreated].includes(post.status)
  ).length;
  const failedRuns = (state.automationRuns || []).slice(0, config.autonomyMaxFailedRuns)
    .filter((run) => run.status === "failed" || Number(run.failed || 0) > 0).length;
  const blockedScriptsToday = ((state.profitEngine?.runs || [])).flatMap((run) =>
    (run.blockedScripts || []).map((script) => ({ ...script, runAt: run.createdAt }))
  ).filter((script) => isWithinLastDay(script.createdAt || script.runAt)).length;

  const rules = [
    policyRule(
      "cycle_budget",
      "Daily cycle budget",
      cyclesToday < config.autonomyMaxCyclesPerDay ? "pass" : "pause",
      cyclesToday,
      config.autonomyMaxCyclesPerDay,
      "Increase AUTONOMY_MAX_CYCLES_PER_DAY or wait for the next 24h window."
    ),
    policyRule(
      "content_budget",
      "Autonomous content budget",
      createdAutonomyPostsToday < config.autonomyMaxCreatedPostsPerDay ? "pass" : "pause",
      createdAutonomyPostsToday,
      config.autonomyMaxCreatedPostsPerDay,
      "Let queued posts gather feedback before creating more autonomous scripts."
    ),
    policyRule(
      "queue_depth",
      "Queue depth",
      queueDepth <= config.autonomyMaxQueueDepth ? "pass" : "pause",
      queueDepth,
      config.autonomyMaxQueueDepth,
      "Process or review the queue before adding more scheduled posts."
    ),
    policyRule(
      "publish_capacity",
      "24h publish capacity",
      capacity > 0 ? "pass" : "pause",
      capacity,
      state.settings.maxDailyApiPosts || 250,
      "Daily Threads publishing capacity is exhausted."
    ),
    policyRule(
      "failure_guard",
      "Recent failures",
      failedRuns < config.autonomyMaxFailedRuns ? "pass" : "pause",
      failedRuns,
      config.autonomyMaxFailedRuns,
      "Fix recent publish failures before the next unattended cycle."
    ),
    policyRule(
      "guardrail_guard",
      "Script guardrails",
      blockedScriptsToday <= config.autonomyMaxBlockedScriptsPerDay ? "pass" : "pause",
      blockedScriptsToday,
      config.autonomyMaxBlockedScriptsPerDay,
      "Too many scripts were blocked; tighten prompts or review offers."
    )
  ];
  const pausedRules = rules.filter((rule) => rule.status === "pause");
  const mode = pausedRules.length ? "paused" : config.autonomyMode ? "autonomous" : "manual";

  return {
    mode,
    canRunCycle: pausedRules.length === 0,
    canCreatePosts: pausedRules.length === 0,
    canPublishQueue: capacity > 0 && failedRuns < config.autonomyMaxFailedRuns,
    nextAction: pausedRules[0]?.action || "Autonomy policy is clear.",
    rules,
    limits: {
      cyclesToday,
      createdAutonomyPostsToday,
      queueDepth,
      capacity,
      failedRuns,
      blockedScriptsToday
    }
  };
}

function buildAutonomyPipeline(state, config, profitEngine, readiness, metrics) {
  const connectedSources = (profitEngine.sourceStatuses || []).filter((source) => source.status === "connected").length;
  const configuredSources = config.adIntelligenceFeedUrls.length
    + config.affiliateOfferFeedUrls.length
    + (config.metaAdLibraryAccessToken && config.metaAdLibraryQuery ? 1 : 0);
  const signalCount = (profitEngine.externalSignals || []).length;
  const scriptCount = (profitEngine.generatedScripts || []).length;
  const hasThreadsCredentials = Boolean(config.threadsUserId && config.threadsAccessToken);
  const conversionCount = metrics.conversions || 0;
  const hasConversionWebhook = Boolean(config.conversionWebhookSecret);
  const readinessBlocked = readiness.summary?.blocked || 0;
  const latestCycleEvent = (state.events || []).find((event) =>
    ["autonomy.cycle.completed", "autonomy.cycle.paused"].includes(event.type)
  ) || null;

  const steps = [
    {
      id: "api_intake",
      label: "API / Ad Intake",
      status: connectedSources > 0 ? "active" : configuredSources > 0 ? "watch" : "blocked",
      value: `${signalCount} signals`,
      detail: connectedSources > 0
        ? `${connectedSources} live source(s) connected`
        : configuredSources > 0
          ? "Feeds are configured; waiting for the next ingest."
          : "Connect ad or affiliate offer feeds.",
      nextAction: connectedSources > 0 ? "Monitor signal freshness" : "Set AD_INTELLIGENCE_FEED_URLS or AFFILIATE_OFFER_FEED_URLS"
    },
    {
      id: "ai_scripts",
      label: "AI Script Engine",
      status: config.openaiApiKey ? "active" : scriptCount > 0 ? "watch" : "manual",
      value: `${scriptCount} scripts`,
      detail: config.openaiApiKey
        ? `${config.profitScriptProvider} provider ready`
        : "Template fallback is available; OpenAI key improves autonomous copy.",
      nextAction: config.openaiApiKey ? "Keep generating natural scripts" : "Set OPENAI_API_KEY for AI-written variants"
    },
    {
      id: "profit_optimizer",
      label: "Profit Optimizer",
      status: profitEngine.optimizer?.latestPolicy ? "active" : profitEngine.runs?.length ? "watch" : "manual",
      value: profitEngine.optimizer?.latestPolicy?.mode || "baseline",
      detail: profitEngine.optimizer?.latestPolicy?.targetAction || "Run the profit engine to create the first optimizer policy.",
      nextAction: profitEngine.optimizer?.latestPolicy ? "Let policy tune the next cycle" : "Run profit engine"
    },
    {
      id: "worker_loop",
      label: "Worker Loop",
      status: config.enableWorker && config.autonomyMode ? "active" : config.enableWorker ? "watch" : "blocked",
      value: config.autonomyMode ? `${Math.round(config.autonomyIntervalMs / 60000)} min` : "manual",
      detail: config.enableWorker
        ? config.autonomyMode ? "Worker can run profit research and queue processing." : "Worker is enabled but autonomy mode is off."
        : "Worker is disabled; scheduled autonomy needs ENABLE_WORKER.",
      nextAction: config.enableWorker && config.autonomyMode ? "Watch next heartbeat" : "Enable ENABLE_WORKER and AUTONOMY_MODE"
    },
    {
      id: "threads_publish",
      label: "Threads Publishing",
      status: config.threadsDryRun ? "dry_run" : hasThreadsCredentials ? "active" : "blocked",
      value: config.threadsDryRun ? "dry-run" : "live",
      detail: config.threadsDryRun
        ? "Publishing is simulated until live credentials are ready."
        : hasThreadsCredentials ? "Threads credentials are present." : "Missing Threads user id or access token.",
      nextAction: config.threadsDryRun ? "Switch THREADS_DRY_RUN=false after validation" : "Monitor publish quota"
    },
    {
      id: "feedback_loop",
      label: "Conversion Feedback",
      status: conversionCount > 0 ? "active" : hasConversionWebhook ? "watch" : "blocked",
      value: `${conversionCount} conversions`,
      detail: conversionCount > 0
        ? "Revenue feedback is flowing into model scoring."
        : hasConversionWebhook ? "Webhook secret is set; waiting for conversion events." : "Conversion webhook is not protected/configured.",
      nextAction: conversionCount > 0 ? "Scale revenue-backed experiments" : "Configure CONVERSION_WEBHOOK_SECRET and network postback"
    }
  ];

  const active = steps.filter((step) => step.status === "active").length;
  const blocked = steps.filter((step) => step.status === "blocked").length + readinessBlocked;
  const score = Math.round(steps.reduce((total, step) => total + pipelineStatusScore(step.status), 0) / steps.length);
  const nextGate = steps.find((step) => step.status === "blocked")
    || steps.find((step) => step.status === "watch")
    || steps.find((step) => step.status === "dry_run")
    || steps[0];

  return {
    summary: {
      mode: config.autonomyMode ? "autonomous" : "manual",
      score,
      active,
      blocked,
      readyForUnattended: blocked === 0 && config.enableWorker && config.autonomyMode && !config.threadsDryRun,
      nextGate: nextGate?.label || "Monitor",
      nextAction: nextGate?.nextAction || "Monitor autonomous loop"
    },
    latestCycle: latestCycleEvent ? {
      id: latestCycleEvent.cycleId,
      source: latestCycleEvent.source,
      status: latestCycleEvent.status,
      policyMode: latestCycleEvent.policyMode || "",
      policyAction: latestCycleEvent.policyAction || "",
      optimizerMode: latestCycleEvent.optimizerMode,
      createdPostCount: latestCycleEvent.createdPostCount || 0,
      processed: latestCycleEvent.processed || 0,
      published: latestCycleEvent.published || 0,
      simulated: latestCycleEvent.simulated || 0,
      failed: latestCycleEvent.failed || 0,
      createdAt: latestCycleEvent.createdAt
    } : null,
    steps
  };
}

function buildOperatingMap(state, config, profitEngine, readiness, autonomyPolicy, autonomyPipeline, metrics) {
  const sources = profitEngine.sources || [];
  const connectedSources = sources.filter((source) => source.runtimeStatus === "connected").length;
  const configuredSources = config.adIntelligenceFeedUrls.length
    + config.affiliateOfferFeedUrls.length
    + (config.metaAdLibraryAccessToken && config.metaAdLibraryQuery ? 1 : 0);
  const signalCount = (profitEngine.externalSignals || []).length;
  const scriptCount = (profitEngine.generatedScripts || []).length;
  const runCount = (profitEngine.runs || []).length;
  const modelCount = (profitEngine.models || []).length;
  const blockedScriptCount = (profitEngine.blockedScripts || []).length;
  const policyClear = Boolean(autonomyPolicy.canRunCycle);
  const readinessScore = Number(readiness.summary?.score || 0);
  const pipelineScore = Number(autonomyPipeline.summary?.score || 0);
  const policyScore = policyClear ? 100 : 42;
  const healthScore = Math.round((pipelineScore * 0.45) + (readinessScore * 0.35) + (policyScore * 0.2));
  const optimizerPolicy = profitEngine.optimizer?.latestPolicy || null;
  const experiments = profitEngine.experiments || {};
  const leaderModel = (profitEngine.models || []).find((model) => model.id === experiments.leaderModelId)
    || (profitEngine.models || [])[0]
    || {};
  const selectedProduct = (state.products || []).find((product) =>
    product.id === profitEngine.generatedScripts?.[0]?.productId
  ) || (state.products || []).find((product) => product.status === "active") || {};
  const conversionRate = metrics.clicks ? Number(((metrics.conversions / metrics.clicks) * 100).toFixed(1)) : 0;
  const liveReady = Boolean(autonomyPipeline.summary?.readyForUnattended);
  const mode = autonomyPolicy.mode === "paused"
    ? "policy_paused"
    : liveReady
      ? "unattended_live"
      : config.threadsDryRun
        ? "dry_run"
        : config.autonomyMode
          ? "autonomous_setup"
          : "manual_build";

  const lanes = [
    {
      id: "market_api",
      label: "API / market intake",
      status: connectedSources > 0 ? "active" : configuredSources > 0 ? "watch" : "blocked",
      value: connectedSources > 0 ? `${connectedSources}/${sources.length || configuredSources}` : `${configuredSources} configured`,
      detail: connectedSources > 0
        ? "Ad and offer signals are feeding the engine."
        : configuredSources > 0
          ? "Sources are configured; waiting for ingest evidence."
          : "Connect ad intelligence or affiliate offer feeds.",
      action: connectedSources > 0 ? "Monitor freshness" : "Set market signal feeds"
    },
    {
      id: "ai_script_agent",
      label: "AI natural script agent",
      status: config.openaiApiKey ? "active" : scriptCount > 0 ? "watch" : "manual",
      value: config.openaiApiKey ? "OpenAI ready" : `${scriptCount} scripts`,
      detail: config.openaiApiKey
        ? "Can generate natural, compliant Threads scripts."
        : "Template fallback is operating until OPENAI_API_KEY is set.",
      action: config.openaiApiKey ? "Generate variants" : "Connect OpenAI"
    },
    {
      id: "offer_autopilot",
      label: "Offer autopilot",
      status: profitEngine.offerAutopilot?.activeSyncedProductCount > 0 ? "active" : "watch",
      value: `${profitEngine.offerAutopilot?.activeSyncedProductCount || 0} active`,
      detail: `Can import up to ${profitEngine.offerAutopilot?.maxOffersPerRun || 0} offer(s) per run.`,
      action: "Keep testing offer fit"
    },
    {
      id: "threads_publish_api",
      label: "Threads publish API",
      status: config.threadsDryRun ? "dry_run" : config.threadsUserId && config.threadsAccessToken ? "active" : "blocked",
      value: config.threadsDryRun ? "dry-run" : "live",
      detail: config.threadsDryRun
        ? "Queue processing is simulated."
        : config.threadsUserId && config.threadsAccessToken
          ? "Threads credentials are present for live publishing."
          : "Threads credentials are missing.",
      action: config.threadsDryRun ? "Validate then switch live" : "Watch quota"
    },
    {
      id: "conversion_feedback",
      label: "Conversion feedback",
      status: metrics.conversions > 0 ? "active" : config.conversionWebhookSecret ? "watch" : "blocked",
      value: `${metrics.conversions || 0} conversions`,
      detail: metrics.conversions > 0
        ? `${formatMoney(metrics.revenue)} revenue has fed back into scoring.`
        : config.conversionWebhookSecret
          ? "Webhook is protected; waiting for affiliate network events."
          : "Revenue learning needs a protected conversion webhook.",
      action: metrics.conversions > 0 ? "Scale winners" : "Connect postback"
    }
  ];

  const flow = [
    {
      id: "research_profit_model",
      label: "Research profit model",
      status: runCount > 0 ? "active" : "manual",
      value: `${modelCount} models`,
      detail: leaderModel.name ? `Leader: ${leaderModel.name}` : "Run research to pick the first model.",
      signal: experiments.confidence || "setup"
    },
    {
      id: "rewrite_natural",
      label: "Rewrite as natural Threads scripts",
      status: scriptCount > 0 ? "active" : config.openaiApiKey ? "watch" : "manual",
      value: `${scriptCount} scripts`,
      detail: scriptCount > 0 ? "Natural affiliate scripts are ready for queueing." : "Generate the first script set.",
      signal: blockedScriptCount ? `${blockedScriptCount} blocked` : "guarded"
    },
    {
      id: "acquire_ads",
      label: "Acquire ad and offer evidence",
      status: signalCount > 0 ? "active" : configuredSources > 0 ? "watch" : "blocked",
      value: `${signalCount} signals`,
      detail: signalCount > 0 ? "External market evidence is influencing scoring." : "Built-in playbooks are still carrying the model.",
      signal: connectedSources > 0 ? "live" : "setup"
    },
    {
      id: "schedule_publish",
      label: "Schedule and publish",
      status: metrics.queued > 0 ? "active" : config.threadsDryRun ? "dry_run" : "watch",
      value: `${metrics.queued || 0} queued`,
      detail: config.threadsDryRun ? "Dry-run protects live account while validating." : "Queue is ready for live processing.",
      signal: `${metrics.published + metrics.simulated} sent`
    },
    {
      id: "learn_optimize",
      label: "Learn and optimize",
      status: metrics.conversions > 0 ? "active" : metrics.clicks > 0 ? "watch" : "manual",
      value: `${conversionRate}% CVR`,
      detail: optimizerPolicy?.targetAction || "Collect clicks and conversions for the next policy.",
      signal: optimizerPolicy?.mode || "baseline"
    }
  ];

  const reasons = [
    ...(optimizerPolicy?.reasons || []),
    autonomyPolicy.nextAction,
    readiness.summary?.nextAction,
    blockedScriptCount ? `${blockedScriptCount} script(s) were blocked by guardrails.` : ""
  ].filter(Boolean).slice(0, 4);

  return {
    summary: {
      mode,
      healthScore,
      objective: profitEngine.objective || "自然真實內容 -> 廣告情報 -> 聯盟成交",
      loopLabel: liveReady ? "unattended live loop" : config.threadsDryRun ? "dry-run validation loop" : "autonomy setup loop",
      nextAction: autonomyPolicy.mode === "paused" ? autonomyPolicy.nextAction : autonomyPipeline.summary?.nextAction || "Monitor loop",
      unattendedReady: liveReady,
      revenue: metrics.revenue,
      conversionRate
    },
    lanes,
    flow,
    decision: {
      title: optimizerPolicy?.targetAction || "Continue highest scoring model",
      confidence: experiments.confidence || "setup",
      selectedModel: leaderModel.name || "No model selected",
      selectedOffer: selectedProduct.offer || selectedProduct.name || "No active offer",
      policyMode: autonomyPolicy.mode,
      guardrailState: blockedScriptCount > 0 ? "needs_review" : "clear",
      nextAction: autonomyPolicy.mode === "paused" ? autonomyPolicy.nextAction : optimizerPolicy?.targetAction || "Run profit engine",
      reasons
    }
  };
}

function growthMission(input) {
  return {
    id: input.id,
    lane: input.lane,
    title: input.title,
    priority: input.priority || "medium",
    status: input.status || "waiting",
    automation: input.automation || "observe",
    trigger: input.trigger || "",
    expectedImpact: input.expectedImpact || "",
    action: input.action || "",
    request: input.request || null
  };
}

function priorityRank(priority) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[priority] ?? 4;
}

function isDue(lastRunAt, intervalMs) {
  if (!lastRunAt) return true;
  const at = new Date(lastRunAt).getTime();
  return !Number.isFinite(at) || at <= Date.now() - Number(intervalMs || 0);
}

function buildAutonomousGrowthLoop(state, config, profitEngine, readiness, autonomyPolicy, autonomyPipeline, metrics) {
  const configuredSources = config.adIntelligenceFeedUrls.length
    + config.affiliateOfferFeedUrls.length
    + (config.metaAdLibraryAccessToken && config.metaAdLibraryQuery ? 1 : 0);
  const connectedSources = (profitEngine.sourceStatuses || []).filter((source) => source.status === "connected").length;
  const signalCount = (profitEngine.externalSignals || []).length;
  const scriptCount = (profitEngine.generatedScripts || []).length;
  const runCount = (profitEngine.runs || []).length;
  const latestRun = (profitEngine.runs || [])[0] || null;
  const blockedScriptCount = (profitEngine.blockedScripts || []).length;
  const queueDepth = Number(metrics.queued || 0);
  const clickCount = Number(metrics.clicks || 0);
  const conversionCount = Number(metrics.conversions || 0);
  const hasRevenueSignal = conversionCount > 0 || Number(metrics.revenue || 0) > 0;
  const due = isDue(latestRun?.createdAt || profitEngine.lastRunAt, config.autonomyIntervalMs);
  const workerWillRun = Boolean(config.enableWorker && config.autonomyMode && autonomyPolicy.canRunCycle);
  const latestGrowthEvent = (state.events || []).find((event) => String(event.type || "").startsWith("growth_loop.")) || null;
  const cycleRequest = {
    path: "/api/autonomy/cycle",
    method: "POST",
    body: {
      source: "growth-loop",
      force: due,
      createPosts: true,
      autoApprove: true,
      publishQueue: true
    }
  };

  const missions = [
    growthMission({
      id: "market_signal_ingest",
      lane: "research",
      title: "取得行銷廣告與 offer 訊號",
      priority: signalCount > 0 ? "medium" : "high",
      status: configuredSources > 0 ? "auto" : "needs_config",
      automation: configuredSources > 0 ? "worker_ingest" : "config_required",
      trigger: configuredSources > 0
        ? `${configuredSources} configured source(s), ${connectedSources} connected`
        : "No ad or offer feed is configured.",
      expectedImpact: "把 built-in playbook 升級成市場證據驅動的 scoring。",
      action: configuredSources > 0 ? "Next cycle ingests market signals." : "Set AD_INTELLIGENCE_FEED_URLS or AFFILIATE_OFFER_FEED_URLS.",
      request: configuredSources > 0 ? {
        path: "/api/profit-engine/run",
        method: "POST",
        body: { source: "growth-loop.market", force: true, createPosts: false, ingest: true }
      } : null
    }),
    growthMission({
      id: "profit_model_research",
      lane: "model",
      title: "研究並選出下一個獲利模式",
      priority: runCount > 0 ? "medium" : "high",
      status: autonomyPolicy.canRunCycle ? due ? "auto" : "waiting" : "paused",
      automation: workerWillRun ? "scheduled_worker" : autonomyPolicy.canRunCycle ? "manual_trigger_available" : "policy_guard",
      trigger: runCount > 0 ? `Latest run: ${formatDateTime(latestRun?.createdAt || profitEngine.lastRunAt)}` : "No profit run has selected a model yet.",
      expectedImpact: "自動比較 offer、廣告角度、EPC 與 conversion feedback，決定下一輪要推的模型。",
      action: autonomyPolicy.canRunCycle ? due ? "Run next autonomy cycle." : "Wait until autonomy interval is due." : autonomyPolicy.nextAction,
      request: autonomyPolicy.canRunCycle ? cycleRequest : null
    }),
    growthMission({
      id: "natural_script_generation",
      lane: "content",
      title: "產生自然真實 Threads 腳本文案",
      priority: scriptCount > 0 ? "medium" : "high",
      status: autonomyPolicy.canCreatePosts ? "auto" : "paused",
      automation: config.openaiApiKey ? "ai_script_agent" : "template_fallback",
      trigger: config.openaiApiKey ? "OpenAI provider configured." : "Template fallback is active until OPENAI_API_KEY is set.",
      expectedImpact: "把廣告承諾改寫成不誇大、有揭露、可驗證的 Threads 推薦文。",
      action: autonomyPolicy.canCreatePosts ? "Create approved scripts for the publishing queue." : autonomyPolicy.nextAction,
      request: autonomyPolicy.canCreatePosts ? {
        path: "/api/profit-engine/run",
        method: "POST",
        body: { source: "growth-loop.scripts", force: true, createPosts: true, autoApprove: true }
      } : null
    }),
    growthMission({
      id: "guardrail_repair",
      lane: "quality",
      title: "自動修復被擋腳本",
      priority: blockedScriptCount > 0 ? "high" : "low",
      status: blockedScriptCount > 0 ? autonomyPolicy.canCreatePosts ? "auto" : "paused" : "waiting",
      automation: blockedScriptCount > 0 ? "optimizer_repair" : "observe",
      trigger: `${blockedScriptCount} blocked script(s) in recent runs.`,
      expectedImpact: "降低合規風險，避免過度銷售、太多連結或缺少聯盟揭露。",
      action: blockedScriptCount > 0 ? "Regenerate safer bridge copy." : "No repair needed.",
      request: blockedScriptCount > 0 && autonomyPolicy.canCreatePosts ? {
        path: "/api/profit-engine/run",
        method: "POST",
        body: { source: "growth-loop.repair", force: true, createPosts: true, autoApprove: true }
      } : null
    }),
    growthMission({
      id: "queue_publish",
      lane: "distribution",
      title: "發佈或 dry-run 佇列",
      priority: queueDepth > 0 ? "high" : "medium",
      status: queueDepth > 0 ? autonomyPolicy.canPublishQueue ? "auto" : "paused" : "waiting",
      automation: queueDepth > 0 && workerWillRun ? "scheduled_worker" : "queue_runner",
      trigger: `${queueDepth} queued post(s).`,
      expectedImpact: "讓已通過 guardrail 的文案進入 Threads 發佈或 dry-run 驗證。",
      action: queueDepth > 0 ? autonomyPolicy.canPublishQueue ? "Process queue." : autonomyPolicy.nextAction : "Wait for generated scripts.",
      request: queueDepth > 0 && autonomyPolicy.canPublishQueue ? {
        path: "/api/automation/run",
        method: "POST",
        body: { source: "growth-loop.queue" }
      } : null
    }),
    growthMission({
      id: "conversion_learning",
      lane: "feedback",
      title: "用轉換資料優化下一輪",
      priority: hasRevenueSignal ? "medium" : clickCount > 0 ? "high" : "medium",
      status: hasRevenueSignal ? "auto" : config.conversionWebhookSecret ? "waiting" : "needs_config",
      automation: hasRevenueSignal ? "revenue_scoring" : config.conversionWebhookSecret ? "webhook_ready" : "config_required",
      trigger: `${clickCount} click(s), ${conversionCount} conversion(s), ${formatMoney(metrics.revenue)} revenue.`,
      expectedImpact: "把模型評分從點擊導向升級成 revenue-backed decision。",
      action: hasRevenueSignal ? "Scale winning experiments." : config.conversionWebhookSecret ? "Wait for affiliate postback events." : "Set CONVERSION_WEBHOOK_SECRET and network postback.",
      request: null
    }),
    growthMission({
      id: "scale_winner",
      lane: "scale",
      title: "擴張勝出的 hook / offer 組合",
      priority: hasRevenueSignal ? "high" : "low",
      status: hasRevenueSignal && autonomyPolicy.canRunCycle ? "auto" : "waiting",
      automation: hasRevenueSignal ? "optimizer_scale" : "observe",
      trigger: profitEngine.experiments?.leaderName
        ? `Leader: ${profitEngine.experiments.leaderName}`
        : "No revenue-backed leader yet.",
      expectedImpact: "把有轉換證據的角度延展成相近 hook，控制頻率並保留揭露。",
      action: hasRevenueSignal ? "Allocate next scripts to the winning model." : "Collect click and conversion feedback first.",
      request: hasRevenueSignal && autonomyPolicy.canRunCycle ? cycleRequest : null
    })
  ].sort((a, b) => {
    const statusRank = { auto: 0, paused: 1, needs_config: 2, waiting: 3, manual: 4 };
    return (statusRank[a.status] ?? 5) - (statusRank[b.status] ?? 5)
      || priorityRank(a.priority) - priorityRank(b.priority);
  });

  const autoExecutable = missions.filter((mission) => mission.status === "auto" && mission.request).length;
  const needsConfig = missions.filter((mission) => mission.status === "needs_config").length;
  const paused = missions.filter((mission) => mission.status === "paused").length;
  const waiting = missions.filter((mission) => mission.status === "waiting").length;
  const nextMission = missions.find((mission) => mission.status === "auto" && mission.request)
    || missions.find((mission) => mission.status === "paused")
    || missions.find((mission) => mission.status === "needs_config")
    || missions[0]
    || null;
  const automationScore = Math.max(0, Math.min(100, Math.round(
    (autoExecutable / Math.max(1, missions.length)) * 60
    + (workerWillRun ? 25 : 0)
    + (autonomyPipeline.summary?.readyForUnattended ? 15 : config.threadsDryRun ? 8 : 0)
    - (needsConfig * 8)
    - (paused * 6)
  )));
  const nextRunAt = latestRun?.createdAt || profitEngine.lastRunAt
    ? new Date(new Date(latestRun?.createdAt || profitEngine.lastRunAt).getTime() + config.autonomyIntervalMs).toISOString()
    : nowIso();

  return {
    summary: {
      mode: workerWillRun ? "self_running" : autonomyPolicy.mode === "paused" ? "policy_paused" : "operator_assisted",
      automationScore,
      workerWillRun,
      autoExecutable,
      needsConfig,
      paused,
      waiting,
      nextMissionId: nextMission?.id || "",
      nextMissionTitle: nextMission?.title || "Monitor growth loop",
      nextAction: nextMission?.action || "Monitor growth loop",
      cadence: config.autonomyMode ? `${Math.round(config.autonomyIntervalMs / 60000)} min` : "manual",
      nextRunAt,
      dryRun: config.threadsDryRun,
      lastExecution: latestGrowthEvent ? {
        type: latestGrowthEvent.type,
        missionId: latestGrowthEvent.missionId || "",
        missionTitle: latestGrowthEvent.missionTitle || "",
        status: latestGrowthEvent.status || "",
        createdAt: latestGrowthEvent.createdAt
      } : null
    },
    missions,
    controls: {
      enableWorker: config.enableWorker,
      autonomyMode: config.autonomyMode,
      policyMode: autonomyPolicy.mode,
      policyAction: autonomyPolicy.nextAction,
      canRunCycle: autonomyPolicy.canRunCycle,
      canCreatePosts: autonomyPolicy.canCreatePosts,
      canPublishQueue: autonomyPolicy.canPublishQueue,
      maxScriptsPerRun: config.autonomyMaxScriptsPerRun,
      maxOffersPerRun: config.autonomyMaxOffersPerRun,
      maxCyclesPerDay: config.autonomyMaxCyclesPerDay
    }
  };
}

function buildAttributionDashboard(state) {
  const posts = state.posts || [];
  const postMap = new Map(posts.map((post) => [post.id, post]));
  const clickEvents = state.clickEvents || [];
  const conversionEvents = state.conversionEvents || [];
  const revenueEvents = conversionEvents.filter((event) =>
    !["rejected", "refunded", "void", "cancelled"].includes(event.status)
  );
  const postStats = new Map();
  const modelStats = new Map();

  function ensurePost(postId) {
    if (!postId) return null;
    if (!postStats.has(postId)) {
      const post = postMap.get(postId) || {};
      postStats.set(postId, {
        postId,
        modelId: post.funnelRatio || "",
        hook: post.hook || post.topicTag || postId,
        contentType: post.contentType || "",
        clicks: 0,
        conversions: 0,
        revenue: 0,
        revenueByCurrency: {}
      });
    }
    return postStats.get(postId);
  }

  function ensureModel(modelId) {
    if (!modelId) return null;
    if (!modelStats.has(modelId)) {
      modelStats.set(modelId, {
        modelId,
        clicks: 0,
        conversions: 0,
        revenue: 0,
        revenueByCurrency: {}
      });
    }
    return modelStats.get(modelId);
  }

  for (const event of clickEvents) {
    const postStat = ensurePost(event.postId);
    if (postStat) postStat.clicks += 1;
    const modelId = event.modelId || postStat?.modelId || "";
    const modelStat = ensureModel(modelId);
    if (modelStat) modelStat.clicks += 1;
  }

  for (const event of revenueEvents) {
    const revenue = Number(event.commissionValue || 0);
    const currency = String(event.currency || "USD").toUpperCase();
    const postStat = ensurePost(event.postId);
    if (postStat) {
      postStat.conversions += 1;
      postStat.revenue += revenue;
      postStat.revenueByCurrency[currency] = Number(postStat.revenueByCurrency[currency] || 0) + revenue;
    }
    const modelId = event.modelId || postStat?.modelId || "";
    const modelStat = ensureModel(modelId);
    if (modelStat) {
      modelStat.conversions += 1;
      modelStat.revenue += revenue;
      modelStat.revenueByCurrency[currency] = Number(modelStat.revenueByCurrency[currency] || 0) + revenue;
    }
  }

  const topPosts = [...postStats.values()]
    .sort((a, b) => b.conversions - a.conversions || b.clicks - a.clicks)
    .slice(0, 5);
  const topModels = [...modelStats.values()]
    .sort((a, b) => b.conversions - a.conversions || b.clicks - a.clicks)
    .slice(0, 5);

  return {
    summary: {
      attributedClicks: clickEvents.filter((event) => event.postId || event.modelId).length,
      attributedConversions: revenueEvents.filter((event) => event.postId || event.modelId).length,
      attributedRevenue: revenueEvents
        .filter((event) => event.postId || event.modelId)
        .reduce((total, event) => total + Number(event.commissionValue || 0), 0),
      attributedRevenueByCurrency: revenueEvents
        .filter((event) => event.postId || event.modelId)
        .reduce((totals, event) => {
          const currency = String(event.currency || "USD").toUpperCase();
          totals[currency] = Number(totals[currency] || 0) + Number(event.commissionValue || 0);
          return totals;
        }, {}),
      unattributedConversions: revenueEvents.filter((event) => !event.postId && !event.modelId).length
    },
    topPosts,
    topModels
  };
}

function buildWorkerLeaseStatus(state, config) {
  const lease = state.runtime?.workerLease || null;
  if (!lease) {
    return {
      active: false,
      stale: false,
      ownerId: "",
      source: "",
      status: "none",
      heartbeatAt: "",
      acquiredAt: "",
      expiresAt: "",
      ttlSeconds: 0,
      leaseMs: config.workerLeaseMs || 0
    };
  }
  const expiresAt = new Date(lease.expiresAt || 0).getTime();
  const now = Date.now();
  const active = Number.isFinite(expiresAt) && expiresAt > now;
  return {
    active,
    stale: Boolean(lease.expiresAt) && !active,
    ownerId: lease.ownerId || "",
    source: lease.source || "",
    status: lease.status || (active ? "active" : "stale"),
    heartbeatAt: lease.heartbeatAt || "",
    acquiredAt: lease.acquiredAt || "",
    expiresAt: lease.expiresAt || "",
    ttlSeconds: active ? Math.max(0, Math.round((expiresAt - now) / 1000)) : 0,
    leaseMs: config.workerLeaseMs || 0,
    lastMissionId: lease.lastMissionId || "",
    lastMissionTitle: lease.lastMissionTitle || "",
    lastError: lease.lastError || ""
  };
}

function buildContentWorkflow(state, config, metrics, monetizableLinks) {
  const latestGeneration = (state.events || []).find((event) => event.type === "automation.drafts_generated");
  const latestProfitContext = state.profitEngine?.runs?.find((run) => run.sourceContext)?.sourceContext;
  const sourceContext = latestGeneration?.sourceContext || latestProfitContext || {};
  const aiReady = config.aiDraftProvider === "openai" && Boolean(config.openaiApiKey);
  const hasOffers = monetizableLinks.length > 0;
  const publishedCount = Number(metrics.published || 0) + Number(metrics.simulated || 0);
  const stages = [
    {
      id: "research",
      status: !hasOffers ? "blocked" : sourceContext.status === "ready" ? "completed" : sourceContext.status === "unavailable" ? "warning" : "ready",
      count: monetizableLinks.length,
      detail: !hasOffers
        ? "尚未建立真實聯盟商品"
        : sourceContext.status === "ready"
          ? sourceContext.researchMode === "openai_web_search"
            ? `AI 已查證 ${sourceContext.title || sourceContext.sourceDomain || "商品資料"}`
            : `已讀取 ${sourceContext.title || sourceContext.sourceDomain || "商品頁"}`
          : sourceContext.status === "unavailable"
            ? "商品頁無法讀取，使用已存優惠資料"
            : "真實商品連結已就緒"
    },
    {
      id: "generate",
      status: !aiReady ? "blocked" : metrics.needsReview > 0 ? "completed" : "ready",
      count: Number(metrics.needsReview || 0),
      detail: !aiReady ? "尚未設定 OpenAI" : metrics.needsReview > 0 ? `${metrics.needsReview} 則草稿等待審核` : "AI 文案服務已就緒"
    },
    {
      id: "review",
      status: metrics.needsReview > 0 ? "active" : (metrics.approved > 0 || metrics.queued > 0 || publishedCount > 0) ? "completed" : "waiting",
      count: Number(metrics.needsReview || 0),
      detail: metrics.needsReview > 0 ? "請確認事實、語氣與揭露" : "目前沒有待審核草稿"
    },
    {
      id: "publish",
      status: metrics.queued > 0 ? "active" : publishedCount > 0 ? "completed" : "waiting",
      count: Number(metrics.queued || 0),
      detail: metrics.queued > 0
        ? `${metrics.queued} 則已核准並排程`
        : config.threadsDryRun
          ? "目前為測試發布模式"
          : "目前沒有待發布貼文"
    }
  ];
  const nextAction = !hasOffers
    ? "add_offer"
    : !aiReady
      ? "configure_ai"
      : metrics.needsReview > 0
        ? "review"
        : metrics.queued > 0
          ? "publish"
          : "generate";
  return {
    nextAction,
    sourceContext,
    sourceProductId: latestGeneration?.productId || "",
    aiReady,
    hasOffers,
    dryRun: config.threadsDryRun,
    stages
  };
}

function buildDashboard(state, config) {
  const posts = state.posts;
  const affiliateLinks = state.affiliateLinks;
  const monetizableLinks = affiliateLinks.filter(isMonetizableLink);
  const published = posts.filter((post) => post.status === STATUS.published);
  const simulated = posts.filter((post) => post.status === STATUS.simulated);
  const queued = posts.filter((post) => post.approved && [STATUS.scheduled, STATUS.containerCreated].includes(post.status));
  const blocked = posts.filter((post) => [STATUS.failed, STATUS.blockedCredentials].includes(post.status));
  const reviewable = posts.filter((post) => [STATUS.generated, STATUS.needsReview, STATUS.draft].includes(post.status));
  const disclosureCovered = posts.filter((post) => {
    return hasCommercialDisclosure(post.text, config);
  }).length;
  const metrics = {
    drafts: reviewable.length,
    needsReview: posts.filter((post) => effectiveReviewStatus(post) === STATUS.needsReview).length,
    approved: posts.filter((post) => post.status === STATUS.approved && post.approved).length,
    rejected: posts.filter((post) => post.status === STATUS.rejected).length,
    queued: queued.length,
    published: published.length,
    simulated: simulated.length,
    blocked: blocked.length,
    clicks: sum(monetizableLinks, (link) => link.clicks),
    conversions: sum(monetizableLinks, (link) => link.conversions),
    revenue: sum(monetizableLinks, (link) => link.revenue),
    revenueByCurrency: revenueByCurrency(monetizableLinks),
    disclosureCoverage: posts.length ? Math.round((disclosureCovered / posts.length) * 100) : 100
  };
  const profitEngine = buildProfitDashboard(state, config);
  const readiness = buildAutonomyReadiness(state, config);
  const autonomyPolicy = buildAutonomyPolicy(state, config);
  const autonomyPipeline = buildAutonomyPipeline(state, config, profitEngine, readiness, metrics);
  const operatingMap = buildOperatingMap(state, config, profitEngine, readiness, autonomyPolicy, autonomyPipeline, metrics);
  const growthLoop = buildAutonomousGrowthLoop(state, config, profitEngine, readiness, autonomyPolicy, autonomyPipeline, metrics);
  const attribution = buildAttributionDashboard(state);
  const workerLease = buildWorkerLeaseStatus(state, config);
  const contentWorkflow = buildContentWorkflow(state, config, metrics, monetizableLinks);

  return {
    generatedAt: nowIso(),
    runtime: {
      dryRun: config.threadsDryRun,
      publicBaseUrl: config.publicBaseUrl,
      workerEnabled: config.enableWorker,
      graphBase: config.threadsGraphBase,
      hasThreadsCredentials: Boolean(config.threadsUserId && config.threadsAccessToken),
      aiDraftProvider: config.aiDraftProvider,
      hasOpenAIApiKey: Boolean(config.openaiApiKey),
      autonomyMode: config.autonomyMode
    },
    metrics,
    contentWorkflow,
    campaigns: state.campaigns,
    products: state.products,
    affiliateLinks: state.affiliateLinks.map((link) => ({
      ...link,
      monetizable: isMonetizableLink(link),
      trackingUrl: trackingUrl(config, link.slug)
    })),
    posts: posts
      .slice()
      .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)))
      .map((post) => {
        const validation = validatePost(post, config);
        const fatigue = evaluateContentFatigue(post, posts, config);
        const review = buildReviewSummary(post, validation, fatigue);
        return {
          ...post,
          validation,
          fatigue,
          review: {
            ...(post.review || {}),
            ...review
          },
          reviewStatus: review.status,
          riskLevel: review.riskLevel,
          disclosureStatus: review.disclosureStatus,
          claimWarnings: review.claimWarnings,
          testimonialRisk: review.testimonialRisk,
          fatigueStatus: fatigue.status,
          fatigueReasons: fatigue.reasons,
          similarityScore: fatigue.similarityScore,
          similarToPostId: fatigue.similarToPostId,
          commercialIntensity: fatigue.commercialIntensity,
          lastFatigueCheckedAt: fatigue.lastFatigueCheckedAt
        };
      }),
    automationRuns: state.automationRuns.slice(0, 10),
    recentEvents: state.events.slice(0, 12),
    clickEvents: state.clickEvents.slice(0, 8),
    conversionEvents: state.conversionEvents.slice(0, 8),
    promptTemplate: buildPrompt("AI 自動化聯盟行銷"),
    profitEngine,
    readiness,
    autonomyPolicy,
    autonomyPipeline,
    operatingMap,
    growthLoop,
    attribution,
    workerLease,
    settings: state.settings
  };
}

function ensureLinkForProduct(state, product, campaign, config) {
  let link = state.affiliateLinks.find((item) => item.productId === product.id);
  if (link) return link;

  const slug = slugify(`${campaign.name}-${product.name}`);
  const url = new URL(product.landingUrl);

  link = {
    id: makeId("aff"),
    slug,
    campaignId: campaign.id,
    productId: product.id,
    network: product.network,
    targetUrl: url.toString(),
    subIdParam: product.subIdParam || "subid",
    appendUtm: false,
    source: product.source || "generated",
    isDemo: product.isDemo === true,
    clicks: 0,
    conversions: 0,
    revenue: 0,
    currency: product.currency === "percent" ? "USD" : product.currency,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  state.affiliateLinks.push(link);
  return link;
}

function renderTemplate(product, campaign, link, config, index) {
  const question = [
    "你會先確認使用情境，還是先比較規格？",
    "你挑這類商品時最在意哪一點？",
    "這項商品最適合放進你的哪個日常情境？"
  ][index % 3];
  const variants = [
    `${product.name} 適不適合你，先看它是否真的對應日常需求。\n\n商品頁的重點是「${product.offer}」，先確認尺寸、使用方式與限制再決定。\n\n${question}`,
    `比較 ${product.name} 時，不用被一長串功能帶著走。\n\n先抓出自己每天會用到的功能，再確認「${product.offer}」是否符合實際情境。\n\n${question}`,
    `${product.name} 值不值得買，關鍵不是功能多，而是你會不會持續使用。\n\n先從商品頁核對「${product.offer}」和售後條件，再判斷是否適合。\n\n${question}`
  ];
  return commercialPostText({ post: variants[index % variants.length], cta: question }, link.targetUrl, config);
}

function ensureCommercialDisclosure(post, config) {
  if (post.funnelRatio !== "conversion" && !post.linkAttachment) return post;
  if (!hasCommercialDisclosure(post.text, config)) {
    post.text = commercialPostText({ post: post.text, cta: post.cta }, post.linkAttachment, config);
  }
  return post;
}

function createDraftPosts(state, input, config, drafts, campaign, product, link, topic, options = {}) {
  const createdBy = resolvePostCreator(options.createdBy);
  const now = new Date();
  const created = [];
  for (const draft of drafts) {
    const scheduled = new Date(now.getTime() + (created.length + 1) * 60 * 60 * 1000);
    const isConversion = draft.ratio === "conversion";
    const hasCommercialPlacement = isConversion;
    const text = hasCommercialPlacement
      ? commercialPostText(draft, link.targetUrl, config)
      : editorialPostText(draft, config);
    const post = {
      id: makeId("post"),
      accountId: "acct_primary",
      campaignId: campaign.id,
      productId: product.id,
      affiliateLinkId: link.id,
      contentType: draft.type,
      funnelRatio: draft.ratio,
      hook: draft.hook,
      cta: draft.cta,
      riskNote: draft.risk_note,
      topicTag: explicitTopicTag(input.topicTag),
      text,
      status: STATUS.needsReview,
      approved: false,
      scheduledAt: scheduled.toISOString(),
      createdBy,
      linkAttachment: hasCommercialPlacement ? link.targetUrl : "",
      sourceContext: options.sourceContext || {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    if (hasCommercialPlacement) {
      attachConfiguredProductLink(post, link, config);
      ensureCommercialDisclosure(post, config);
    }
    prepareGeneratedPostForReview(post, config, {
      source: "automation_generate",
      createdBy,
      recentPosts: state.posts,
      autoApproveRequested: input.autoApprove === true
    });
    state.posts.push(post);
    created.push(post);
  }

  state.events.unshift({
    id: makeId("evt"),
    type: "automation.drafts_generated",
    count: created.length,
    campaignId: campaign.id,
    productId: product.id,
    affiliateLinkId: link.id,
    sourceContext: options.sourceContext || {},
    createdAt: nowIso()
  });
  return { created };
}

function resolveDraftContext(state, input, config) {
  const eligibleProducts = config.allowDemoOffers
    ? state.products
    : state.products.filter((item) =>
        item.status === "active" && state.affiliateLinks.some((link) =>
          link.productId === item.id && isMonetizableLink(link)
        )
      );
  const campaign = input.campaignId
    ? findById(state.campaigns, input.campaignId)
    : state.campaigns.find((item) =>
        item.status === "active" && eligibleProducts.some((product) => product.campaignId === item.id)
      );
  if (!campaign) {
    const error = new Error("No active campaign is available for draft generation.");
    error.statusCode = 400;
    throw error;
  }
  const product = input.productId
    ? eligibleProducts.find((item) => item.id === input.productId)
    : eligibleProducts.find((item) => item.campaignId === campaign.id && item.status === "active");
  if (!product) {
    const error = new Error("No active product is available for this campaign.");
    error.statusCode = 400;
    throw error;
  }
  const link = ensureLinkForProduct(state, product, campaign, config);
  if (!config.allowDemoOffers && !isMonetizableLink(link)) {
    const error = new Error("Draft generation requires a real affiliate offer. Add a verified HTTPS affiliate URL first.");
    error.statusCode = 409;
    error.code = "MONETIZATION_NOT_READY";
    throw error;
  }
  const topic = String(input.topic || "").trim() || product.name;
  return { campaign, product, link, topic };
}

function generateDrafts(state, input, config, options = {}) {
  const { campaign, product, link, topic } = resolveDraftContext(state, input, config);
  const drafts = generatePromptDrafts({
    topic,
    productName: product.name
  });
  return createDraftPosts(state, input, config, drafts, campaign, product, link, topic, {
    ...options,
    sourceContext: publicContextSummary({ status: "ai_unavailable" })
  });
}

async function generateDraftsAsync(state, input, config, options = {}) {
  const { campaign, product, link, topic } = resolveDraftContext(state, input, config);
  const useOpenAI = shouldUseOpenAI(config, input);
  const offerContext = {
    campaignName: campaign.name,
    targetPersona: campaign.targetPersona,
    productName: product.name,
    offer: product.offer,
    network: product.network,
    commissionModel: product.commissionModel,
    commissionValue: product.commissionValue,
    currency: product.currency
  };
  const pageContext = useOpenAI
    ? await resolveOfferResearchContext(link.targetUrl, offerContext, config, {
        offerPageLoader: options.offerPageLoader,
        offerPageLoaderOptions: options.offerPageLoaderOptions,
        fetchImpl: options.researchFetchImpl
      })
    : { status: "ai_unavailable", contextText: "" };
  offerContext.pageContext = pageContext.contextText;
  const drafts = useOpenAI
    ? await generateOpenAIDrafts({ topic, offerContext, config, fetchImpl: options.fetchImpl })
      : generatePromptDrafts({
        topic,
        productName: product.name
      });
  const sourceContext = publicContextSummary(pageContext);
  return {
    ...createDraftPosts(state, input, config, drafts, campaign, product, link, topic, {
      ...options,
      sourceContext
    }),
    sourceContext
  };
}

function createPost(state, input, config, options = {}) {
  const campaign = findById(state.campaigns, input.campaignId);
  const product = findById(state.products, input.productId);
  if (!campaign || !product) {
    const error = new Error("A valid campaignId and productId are required.");
    error.statusCode = 400;
    throw error;
  }
  const link = input.affiliateLinkId
    ? findById(state.affiliateLinks, input.affiliateLinkId)
    : ensureLinkForProduct(state, product, campaign, config);
  if (!link) {
    const error = new Error("Affiliate link not found.");
    error.statusCode = 400;
    throw error;
  }
  if (!config.allowDemoOffers && !isMonetizableLink(link)) {
    const error = new Error("Post creation requires a real affiliate offer. Add a verified HTTPS affiliate URL first.");
    error.statusCode = 409;
    error.code = "MONETIZATION_NOT_READY";
    throw error;
  }
  const post = {
    id: makeId("post"),
    accountId: input.accountId || "acct_primary",
    campaignId: campaign.id,
    productId: product.id,
    affiliateLinkId: link.id,
    contentType: input.contentType || "手動",
    funnelRatio: input.funnelRatio || "manual",
    hook: input.hook || "",
    cta: input.cta || "",
    riskNote: input.riskNote || "",
    topicTag: explicitTopicTag(input.topicTag),
    text: input.text || renderTemplate(product, campaign, link, config, state.posts.length),
    status: STATUS.needsReview,
    approved: false,
    scheduledAt: input.scheduledAt || nowIso(),
    createdBy: resolvePostCreator(options.createdBy),
    linkAttachment: input.linkAttachment || link.targetUrl,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  if (!input.linkAttachment) attachConfiguredProductLink(post, link, config);
  const validation = refreshReviewMetadata(post, config, {
    recentPosts: state.posts
  });
  if (!validation.valid) {
    const error = new Error(validation.errors.join(" "));
    error.statusCode = 400;
    throw error;
  }
  if (input.approved) approvePost(post, config, { actor: options.createdBy, recentPosts: state.posts });
  state.posts.push(post);
  return { post, validation };
}

function upsertAffiliateLink(state, input, config) {
  const campaign = findById(state.campaigns, input.campaignId);
  const product = findById(state.products, input.productId);
  if (!campaign || !product || !input.targetUrl) {
    const error = new Error("campaignId, productId, and targetUrl are required.");
    error.statusCode = 400;
    throw error;
  }
  const slug = input.slug ? slugify(input.slug) : slugify(`${campaign.name}-${product.name}`);
  const existing = state.affiliateLinks.find((link) => link.slug === slug);
  let url;
  try {
    url = new URL(input.targetUrl);
  } catch {
    const error = new Error("targetUrl must be a valid HTTP or HTTPS URL.");
    error.statusCode = 400;
    throw error;
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    const error = new Error("targetUrl must use HTTP or HTTPS.");
    error.statusCode = 400;
    throw error;
  }
  const appendUtm = input.appendUtm !== false;
  if (appendUtm) {
    url.searchParams.set("utm_source", input.utmSource || config.defaultUtmSource);
    url.searchParams.set("utm_medium", input.utmMedium || config.defaultUtmMedium);
    url.searchParams.set("utm_campaign", campaign.id);
    url.searchParams.set("utm_content", product.id);
  }
  const subIdParam = input.subIdParam === null || String(input.subIdParam || "").toLowerCase() === "none"
    ? ""
    : String(input.subIdParam || "subid").trim();
  if (subIdParam && !/^[a-zA-Z0-9_.-]+$/.test(subIdParam)) {
    const error = new Error("subIdParam contains unsupported characters.");
    error.statusCode = 400;
    throw error;
  }

  const link = existing || {
    id: makeId("aff"),
    clicks: 0,
    conversions: 0,
    revenue: 0,
    currency: input.currency || "USD",
    createdAt: nowIso()
  };
  Object.assign(link, {
    slug,
    campaignId: campaign.id,
    productId: product.id,
    network: input.network || product.network,
    targetUrl: url.toString(),
    subIdParam,
    appendUtm,
    source: input.source || link.source || "affiliate",
    isDemo: input.isDemo === true,
    updatedAt: nowIso()
  });
  if (!existing) state.affiliateLinks.push(link);
  return { link, trackingUrl: trackingUrl(config, link.slug) };
}

function findPostForAttribution(state, value) {
  if (!value) return null;
  const id = String(value).trim();
  return (state.posts || []).find((post) => post.id === id || post.trackingCode === id) || null;
}

function resolveConversionAttribution(state, input) {
  const clickEventToken = input.clickEventId || input.click_event_id || "";
  const clickEvent = clickEventToken
    ? (state.clickEvents || []).find((event) => event.id === clickEventToken)
    : null;
  const postToken = input.postId
    || input.post_id
    || input.post
    || input.subid
    || input.sub_id
    || input.subId
    || input.click_id
    || input.clickid
    || input.utm_content
    || clickEvent?.postId
    || "";
  const post = findPostForAttribution(state, postToken);
  return { clickEvent, post };
}

function findLinkForConversion(state, input, attribution = null) {
  const links = state.affiliateLinks || [];
  const link = input.affiliateLinkId
    ? links.find((item) => item.id === input.affiliateLinkId)
    : attribution?.clickEvent?.affiliateLinkId
      ? links.find((item) => item.id === attribution.clickEvent.affiliateLinkId)
      : attribution?.post?.affiliateLinkId
        ? links.find((item) => item.id === attribution.post.affiliateLinkId)
        : links.find((item) => item.slug === input.slug || item.slug === input.affiliateSlug);
  if (!link) {
    const error = new Error("A valid affiliateLinkId or slug is required.");
    error.statusCode = 404;
    throw error;
  }
  return link;
}

function numberFrom(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function recordConversion(state, input) {
  const attribution = resolveConversionAttribution(state, input);
  const link = findLinkForConversion(state, input, attribution);
  const post = attribution.post || null;
  const clickEvent = attribution.clickEvent || null;
  const networkEventId = String(
    input.networkEventId
      || input.network_event_id
      || input.eventId
      || input.event_id
      || input.orderId
      || input.order_id
      || input.transactionId
      || input.transaction_id
      || input.conversionId
      || input.conversion_id
      || input.tid
      || ""
  ).trim();
  const duplicate = networkEventId
    ? (state.conversionEvents || []).find((event) =>
        event.affiliateLinkId === link.id && event.networkEventId === networkEventId
      )
    : null;
  if (duplicate) {
    return { conversion: duplicate, link, duplicate: true };
  }

  const commissionValue = numberFrom(
    input.commissionValue,
    input.commission_value,
    input.commission,
    input.commission_amount,
    input.payout,
    input.amount
  );
  const orderValue = numberFrom(input.orderValue, input.order_value, input.saleAmount, input.sale_amount, input.revenue);
  if (commissionValue < 0 || orderValue < 0) {
    const error = new Error("Conversion values cannot be negative.");
    error.statusCode = 400;
    throw error;
  }

  const status = String(input.status || "approved").toLowerCase();
  const conversion = {
    id: makeId("conv"),
    affiliateLinkId: link.id,
    postId: post?.id || clickEvent?.postId || "",
    campaignId: post?.campaignId || clickEvent?.campaignId || link.campaignId || "",
    productId: post?.productId || clickEvent?.productId || link.productId || "",
    modelId: post?.funnelRatio || clickEvent?.modelId || input.modelId || input.model || "",
    trackingCode: post?.trackingCode || post?.id || input.subid || input.sub_id || "",
    clickEventId: input.clickEventId || input.click_event_id || clickEvent?.id || "",
    networkEventId,
    orderValue,
    commissionValue,
    currency: input.currency || link.currency || "USD",
    status,
    occurredAt: input.occurredAt || input.occurred_at || nowIso(),
    createdAt: nowIso()
  };

  state.conversionEvents.unshift(conversion);
  const countsTowardRevenue = !["rejected", "refunded", "void", "cancelled"].includes(status);
  if (countsTowardRevenue) {
    link.conversions = Number(link.conversions || 0) + 1;
    link.revenue = Number(link.revenue || 0) + commissionValue;
    link.currency = conversion.currency;
    link.updatedAt = conversion.createdAt;
    if (post) {
      post.conversions = Number(post.conversions || 0) + 1;
      post.revenue = Number(post.revenue || 0) + commissionValue;
      post.updatedAt = conversion.createdAt;
    }
  }
  state.events.unshift({
    id: makeId("evt"),
    type: "conversion.recorded",
    affiliateLinkId: link.id,
    postId: conversion.postId,
    modelId: conversion.modelId,
    conversionId: conversion.id,
    revenueDelta: countsTowardRevenue ? commissionValue : 0,
    createdAt: conversion.createdAt
  });
  return { conversion, link, duplicate: false };
}

function capacityRemaining(state) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recentlyPublished = state.posts.filter((post) => {
    if (!["published", "simulated"].includes(post.status)) return false;
    const publishedAt = new Date(post.publishedAt || post.updatedAt || 0).getTime();
    return publishedAt >= cutoff;
  }).length;
  const max = Number(state.settings.maxDailyApiPosts || 250);
  return Math.max(0, max - recentlyPublished);
}

async function runAutomation(store, config, options = {}) {
  const startedAt = nowIso();
  const state = await store.read();
  const ignoreReadiness = options.ignoreReadiness === true;
  const run = {
    id: makeId("run"),
    source: options.source || "manual",
    status: "running",
    startedAt,
    finishedAt: null,
    processed: 0,
    published: 0,
    simulated: 0,
    failed: 0,
    messages: []
  };

  if (!config.threadsDryRun && !ignoreReadiness) {
    const readiness = buildAutonomyReadiness(state, config);
    const gate = buildLivePublishingGate(state, config, { readiness, autonomy: options.autonomy === true });
    if (!gate.allowed) {
      run.status = "blocked";
      run.readinessGate = gate;
      run.messages.push("Publishing is blocked by readiness checks before live execution.");
      run.messages.push(...gate.reasons.map((item) => `- ${item.label}: ${item.action}`));
      run.finishedAt = nowIso();
      state.automationRuns.unshift(run);
      state.events.unshift({
        id: makeId("evt"),
        type: "automation.run",
        runId: run.id,
        status: run.status,
        readinessBlocked: true,
        readinessReasons: gate.reasons,
        createdAt: run.finishedAt
      });
      await store.write(state);
      return { run, dashboard: buildDashboard(state, config) };
    }
  }

  const now = Date.now();
  let remaining = capacityRemaining(state);
  const duePosts = state.posts.filter((post) => {
    if (options.onlyPostId && post.id !== options.onlyPostId) return false;
    if (!post.approved) return false;
    if (![STATUS.scheduled, STATUS.containerCreated].includes(post.status)) return false;
    const dueTime = post.status === STATUS.containerCreated
      ? new Date(post.publishAfter || post.scheduledAt).getTime()
      : new Date(post.scheduledAt || 0).getTime();
    return dueTime <= now;
  });

  for (const post of duePosts) {
    if (remaining <= 0) {
      run.messages.push("Daily Threads API publishing quota is exhausted.");
      break;
    }
    run.processed += 1;
    const validation = refreshReviewMetadata(post, config, {
      recentPosts: state.posts
    });
    try {
      assertPublishable(post, validation, config, { allowContainerCreated: true });
    } catch (error) {
      post.status = STATUS.failed;
      post.error = error.message;
      post.updatedAt = nowIso();
      run.failed += 1;
      run.messages.push(`${post.id}: ${error.message}`);
      continue;
    }

    try {
      if (config.threadsDryRun) {
        post.status = STATUS.simulated;
        post.threadsMediaId = `dry_${Date.now()}`;
        post.publishedAt = nowIso();
        post.updatedAt = post.publishedAt;
        run.simulated += 1;
        remaining -= 1;
        continue;
      }

      assertMonetizablePost(state, post);

      if (post.status === STATUS.scheduled) {
        const container = await createTextContainer(config, post);
        post.status = STATUS.containerCreated;
        post.threadsContainerId = container.id;
        post.publishAfter = new Date(Date.now() + config.threadsPublishDelayMs).toISOString();
        post.updatedAt = nowIso();
        run.messages.push(`${post.id}: media container created.`);
        continue;
      }

      if (post.status === STATUS.containerCreated) {
        const result = await publishContainer(config, post.threadsContainerId);
        post.status = STATUS.published;
        post.threadsMediaId = result.id;
        post.publishedAt = nowIso();
        post.updatedAt = post.publishedAt;
        run.published += 1;
        remaining -= 1;
      }
    } catch (error) {
      console.error("Threads publishing operation failed:", {
        postId: post.id,
        phase: post.status,
        code: error.code || "",
        statusCode: error.statusCode || 0,
        message: error.message
      });
      post.status = error.message.includes("THREADS_USER_ID") ? STATUS.blockedCredentials : STATUS.failed;
      post.error = error.message;
      post.updatedAt = nowIso();
      run.failed += 1;
      run.messages.push(`${post.id}: ${error.message}`);
    }
  }

  run.status = run.failed > 0 ? "completed_with_errors" : "completed";
  run.finishedAt = nowIso();
  state.automationRuns.unshift(run);
  state.events.unshift({
    id: makeId("evt"),
    type: "automation.run",
    runId: run.id,
    status: run.status,
    createdAt: run.finishedAt
  });
  await store.write(state);
  return { run, dashboard: buildDashboard(state, config) };
}

module.exports = {
  buildDashboard,
  buildAutonomyPolicy,
  buildOperatingMap,
  buildAutonomousGrowthLoop,
  createPost,
  generateDrafts,
  generateDraftsAsync,
  recordConversion,
  runAutomation,
  upsertAffiliateLink,
  trackingUrl
};

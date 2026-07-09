function hasValue(value) {
  return String(value || "").trim().length > 0;
}

function isLocalPublicBaseUrl(value) {
  if (!hasValue(value)) return true;
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return true;
  }
}

function makeCheck(id, label, status, detail, action) {
  return { id, label, status, detail, action };
}

function activeItems(items) {
  return (items || []).filter((item) => item.status === "active");
}

function sourceCount(config) {
  const feedCount = (config.adIntelligenceFeedUrls || []).length;
  const offerCount = (config.affiliateOfferFeedUrls || []).length;
  const metaReady = hasValue(config.metaAdLibraryAccessToken) && hasValue(config.metaAdLibraryQuery);
  return feedCount + offerCount + (metaReady ? 1 : 0);
}

function configuredSourceStatuses(state) {
  const statuses = state.profitEngine?.sourceStatuses || [];
  return new Map(statuses.map((status) => [status.id, status]));
}

function sourceHealth(state, id) {
  return state.profitEngine?.sourceHealth?.[id] || {};
}

function sourceRuntimeStatus(state, id, configured) {
  const status = configuredSourceStatuses(state).get(id);
  const health = sourceHealth(state, id);
  if (status?.status === "connected") return "ready";
  if (status?.status === "backoff" || health.status === "backoff") return "backoff";
  if (status?.status === "error" || health.status === "error") return "error";
  return configured ? "ready" : "warning";
}

function connector(id, lane, name, purpose, status, envKeys, nextAction, meta = {}) {
  return {
    id,
    lane,
    name,
    purpose,
    status,
    envKeys,
    nextAction,
    configured: Boolean(meta.configured),
    signal: meta.signal || "",
    lastSuccessAt: meta.lastSuccessAt || "",
    lastError: meta.lastError || "",
    nextRetryAt: meta.nextRetryAt || "",
    failureCount: Number(meta.failureCount || 0)
  };
}

function connectorCenter(state, config) {
  const localBaseUrl = isLocalPublicBaseUrl(config.publicBaseUrl);
  const metaReady = hasValue(config.metaAdLibraryAccessToken) && hasValue(config.metaAdLibraryQuery);
  const customFeedReady = (config.adIntelligenceFeedUrls || []).length > 0;
  const offerFeedReady = (config.affiliateOfferFeedUrls || []).length > 0;
  const metaHealth = sourceHealth(state, "meta_ad_library");
  const customHealth = sourceHealth(state, "custom_ad_feed");
  const offerHealth = sourceHealth(state, "affiliate_offer_feed");
  const metaStatus = sourceRuntimeStatus(state, "meta_ad_library", metaReady);
  const customStatus = sourceRuntimeStatus(state, "custom_ad_feed", customFeedReady);
  const offerStatus = sourceRuntimeStatus(state, "affiliate_offer_feed", offerFeedReady);
  const threadsReady = hasValue(config.threadsUserId) && hasValue(config.threadsAccessToken);
  const aiReady = config.profitScriptProvider !== "openai" || hasValue(config.openaiApiKey);
  const workerReady = config.enableWorker && config.autonomyMode;

  const connectors = [
    connector(
      "database",
      "Infrastructure",
      "Postgres database",
      "Persistent state, migrations, campaigns, posts, and revenue events.",
      hasValue(config.databaseUrl) ? "ready" : "warning",
      ["DATABASE_URL", "DATABASE_AUTO_MIGRATE", "DATABASE_SSL"],
      hasValue(config.databaseUrl) ? "Monitor migrations on deploy." : "Add DATABASE_URL on Render or Railway.",
      {
        configured: hasValue(config.databaseUrl),
        signal: hasValue(config.databaseUrl) ? "postgres" : "local json"
      }
    ),
    connector(
      "tracking_domain",
      "Infrastructure",
      "Public tracking URL",
      "Redirect links, attribution parameters, and Threads link attachments.",
      localBaseUrl && !config.threadsDryRun ? "blocked" : localBaseUrl ? "warning" : "ready",
      ["PUBLIC_BASE_URL"],
      localBaseUrl ? "Set PUBLIC_BASE_URL to the deployed service URL." : "Public redirects are available.",
      {
        configured: !localBaseUrl,
        signal: config.publicBaseUrl
      }
    ),
    connector(
      "worker_autonomy",
      "Automation",
      "Autonomous worker",
      "Runs research, script generation, queue publishing, and feedback loops without clicks.",
      workerReady ? "ready" : "blocked",
      ["ENABLE_WORKER", "AUTONOMY_MODE", "AUTONOMY_INTERVAL_MS"],
      workerReady ? "Worker loop is armed." : "Enable worker and autonomy mode on the cloud service.",
      {
        configured: workerReady,
        signal: workerReady ? "armed" : "manual"
      }
    ),
    connector(
      "threads_api",
      "Distribution",
      "Threads publishing API",
      "Creates Threads media containers and publishes approved affiliate-safe posts.",
      config.threadsDryRun ? "warning" : threadsReady ? "ready" : "blocked",
      ["THREADS_USER_ID", "THREADS_ACCESS_TOKEN", "THREADS_DRY_RUN"],
      config.threadsDryRun ? "Dry-run is active; add credentials before live publishing." : threadsReady ? "Live publishing ready." : "Add Threads credentials or keep dry-run enabled.",
      {
        configured: threadsReady,
        signal: config.threadsDryRun ? "dry-run" : "live"
      }
    ),
    connector(
      "openai_scripts",
      "Creation",
      "AI script engine",
      "Turns profit research and offer evidence into natural Threads scripts.",
      aiReady ? "ready" : "warning",
      ["PROFIT_SCRIPT_PROVIDER", "OPENAI_API_KEY", "OPENAI_MODEL"],
      aiReady ? "AI or template script generation is available." : "Set OPENAI_API_KEY or switch PROFIT_SCRIPT_PROVIDER=template.",
      {
        configured: aiReady,
        signal: config.profitScriptProvider || config.aiDraftProvider
      }
    ),
    connector(
      "meta_ad_library",
      "Market",
      "Meta Ad Library",
      "Collects active ad hooks, angles, and creative evidence for model scoring.",
      metaStatus,
      ["META_AD_LIBRARY_ACCESS_TOKEN", "META_AD_LIBRARY_QUERY", "META_AD_LIBRARY_COUNTRIES"],
      metaReady ? "Watch source freshness and backoff." : "Add Meta Ad Library token and query.",
      {
        configured: metaReady,
        signal: metaReady ? config.metaAdLibraryQuery : "missing query",
        ...metaHealth
      }
    ),
    connector(
      "custom_ad_feed",
      "Market",
      "Custom ad feed",
      "Ingests owned JSON ad intelligence, competitor hooks, and landing evidence.",
      customStatus,
      ["AD_INTELLIGENCE_FEED_URLS", "AD_INTELLIGENCE_MAX_ITEMS"],
      customFeedReady ? "Keep feed format stable and monitor retries." : "Add one or more JSON ad feed URLs.",
      {
        configured: customFeedReady,
        signal: `${(config.adIntelligenceFeedUrls || []).length} feed(s)`,
        ...customHealth
      }
    ),
    connector(
      "affiliate_offer_feed",
      "Market",
      "Affiliate offer feed",
      "Syncs commission, EPC, landing URL, and offer risk into product inventory.",
      offerStatus,
      ["AFFILIATE_OFFER_FEED_URLS", "AUTONOMY_MAX_OFFERS_PER_RUN"],
      offerFeedReady ? "Offer autopilot can sync new products." : "Add affiliate network or curated offer feed URLs.",
      {
        configured: offerFeedReady,
        signal: `${(config.affiliateOfferFeedUrls || []).length} feed(s)`,
        ...offerHealth
      }
    ),
    connector(
      "conversion_webhook",
      "Revenue",
      "Conversion webhook",
      "Feeds approved commissions back into attribution and profit model scoring.",
      hasValue(config.conversionWebhookSecret) ? "ready" : "warning",
      ["CONVERSION_WEBHOOK_SECRET"],
      hasValue(config.conversionWebhookSecret) ? "Postbacks can be authenticated." : "Set a webhook secret before live network postbacks.",
      {
        configured: hasValue(config.conversionWebhookSecret),
        signal: hasValue(config.conversionWebhookSecret) ? "protected" : "unprotected"
      }
    )
  ];

  const counts = connectors.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    if (item.configured) acc.configured += 1;
    return acc;
  }, { ready: 0, warning: 0, blocked: 0, backoff: 0, error: 0, configured: 0 });
  const score = Math.round((((counts.ready || 0) + (counts.warning || 0) * 0.45 + (counts.backoff || 0) * 0.35) / connectors.length) * 100);
  const next = connectors.find((item) => item.status === "blocked")
    || connectors.find((item) => item.status === "error")
    || connectors.find((item) => item.status === "backoff")
    || connectors.find((item) => item.status === "warning")
    || connectors[0];

  return {
    score,
    ready: counts.ready || 0,
    warning: counts.warning || 0,
    blocked: counts.blocked || 0,
    backoff: counts.backoff || 0,
    error: counts.error || 0,
    configured: counts.configured,
    total: connectors.length,
    nextAction: next?.nextAction || "All connectors are ready.",
    automationReady: connectors.every((item) => !["blocked", "error"].includes(item.status)),
    connectors
  };
}

function summarizeChecks(checks, config) {
  const counts = checks.reduce((acc, check) => {
    acc[check.status] = (acc[check.status] || 0) + 1;
    return acc;
  }, { ready: 0, warning: 0, blocked: 0 });
  const score = Math.round(((counts.ready + counts.warning * 0.5) / checks.length) * 100);
  let mode = "live_ready";
  if (counts.blocked > 0) mode = "blocked";
  else if (config.threadsDryRun) mode = "dry_run_ready";
  else if (counts.warning > 0) mode = "needs_attention";

  const nextAction = checks.find((check) => check.status === "blocked")?.action
    || checks.find((check) => check.status === "warning")?.action
    || "System is ready for autonomous live operation.";

  return {
    mode,
    score,
    ready: counts.ready,
    warning: counts.warning,
    blocked: counts.blocked,
    nextAction
  };
}

function buildAutonomyReadiness(state, config) {
  const campaigns = activeItems(state.campaigns);
  const products = activeItems(state.products);
  const links = state.affiliateLinks || [];
  const marketSources = sourceCount(config);
  const localBaseUrl = isLocalPublicBaseUrl(config.publicBaseUrl);
  const checks = [
    makeCheck(
      "database",
      "Database persistence",
      hasValue(config.databaseUrl) ? "ready" : "warning",
      hasValue(config.databaseUrl)
        ? "DATABASE_URL is configured; startup can run the idempotent Postgres schema."
        : "Using the local JSON store. Good for development, but cloud autonomy needs persistent Postgres.",
      "Set DATABASE_URL on Render or Railway and keep DATABASE_AUTO_MIGRATE=true."
    ),
    makeCheck(
      "public_base_url",
      "Public tracking URL",
      localBaseUrl && !config.threadsDryRun ? "blocked" : localBaseUrl ? "warning" : "ready",
      localBaseUrl
        ? "PUBLIC_BASE_URL is still local, so affiliate tracking links are not public."
        : "PUBLIC_BASE_URL points to a public domain for redirects and link attachments.",
      "Set PUBLIC_BASE_URL to the deployed Render/Railway service URL."
    ),
    makeCheck(
      "worker",
      "Worker + autonomy loop",
      config.enableWorker && config.autonomyMode ? "ready" : "blocked",
      config.enableWorker && config.autonomyMode
        ? "ENABLE_WORKER and AUTONOMY_MODE are both on; the app can run without manual clicks."
        : "The app can run manually, but the no-human autonomous loop is not enabled.",
      "Set ENABLE_WORKER=true and AUTONOMY_MODE=true on the cloud service."
    ),
    makeCheck(
      "threads",
      "Threads publishing",
      config.threadsDryRun
        ? "warning"
        : hasValue(config.threadsUserId) && hasValue(config.threadsAccessToken) ? "ready" : "blocked",
      config.threadsDryRun
        ? "THREADS_DRY_RUN=true; posts will simulate instead of publishing live."
        : "Live publishing requires THREADS_USER_ID and THREADS_ACCESS_TOKEN.",
      "Add Threads credentials, verify the queue, then switch THREADS_DRY_RUN=false."
    ),
    makeCheck(
      "ai_scripts",
      "AI script generation",
      config.profitScriptProvider === "openai" && !hasValue(config.openaiApiKey) ? "warning" : "ready",
      config.profitScriptProvider === "openai" && hasValue(config.openaiApiKey)
        ? "OpenAI profit script generation is configured."
        : config.profitScriptProvider === "openai"
          ? "OpenAI is selected but no key is present; the engine will fall back to templates."
          : "Template script generation is selected.",
      "Set OPENAI_API_KEY or use PROFIT_SCRIPT_PROVIDER=template intentionally."
    ),
    makeCheck(
      "market_sources",
      "Ad and offer research",
      marketSources > 0 ? "ready" : "warning",
      marketSources > 0
        ? `${marketSources} live ad or offer source(s) are configured.`
        : "No live ad or offer source is configured; scoring will use only built-in playbooks and current revenue.",
      "Set AD_INTELLIGENCE_FEED_URLS, AFFILIATE_OFFER_FEED_URLS, or Meta Ad Library credentials."
    ),
    makeCheck(
      "offer_inventory",
      "Campaign and offer inventory",
      campaigns.length > 0 && products.length > 0 && links.length > 0 ? "ready" : "blocked",
      `${campaigns.length} active campaign(s), ${products.length} active product(s), ${links.length} tracking link(s).`,
      "Create at least one active campaign, active product, and affiliate tracking link."
    ),
    makeCheck(
      "conversion_feedback",
      "Conversion feedback",
      hasValue(config.conversionWebhookSecret) ? "ready" : "warning",
      hasValue(config.conversionWebhookSecret)
        ? "Conversion webhook secret is set; affiliate networks can feed revenue back into scoring."
        : "Conversion webhook is unprotected or not configured; revenue feedback will be manual or simulated.",
      "Set CONVERSION_WEBHOOK_SECRET and connect affiliate network postbacks to /api/conversions."
    ),
    makeCheck(
      "disclosure_guardrails",
      "Disclosure guardrails",
      hasValue(config.defaultDisclosureText) ? "ready" : "blocked",
      hasValue(config.defaultDisclosureText)
        ? "Commercial disclosure text is available for every generated post."
        : "Disclosure text is missing, so autonomous affiliate posting should not run.",
      "Set DEFAULT_DISCLOSURE_TEXT, for example: 含聯盟連結."
    ),
    makeCheck(
      "offer_autopilot",
      "Offer autopilot cap",
      Number(config.autonomyMaxOffersPerRun || 0) > 0 ? "ready" : "warning",
      `AUTONOMY_MAX_OFFERS_PER_RUN=${Number(config.autonomyMaxOffersPerRun || 0)}.`,
      "Set AUTONOMY_MAX_OFFERS_PER_RUN to 1-3 so new feed offers can enter the product pool safely."
    )
  ];

  return {
    generatedAt: new Date().toISOString(),
    summary: summarizeChecks(checks, config),
    connectorCenter: connectorCenter(state, config),
    checks
  };
}

module.exports = { buildAutonomyReadiness };

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
    checks
  };
}

module.exports = { buildAutonomyReadiness };

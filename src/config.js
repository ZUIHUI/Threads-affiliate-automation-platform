function asBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asList(value, fallback = []) {
  if (value == null || value === "") return fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getRuntimeConfig(env) {
  const production = String(env.NODE_ENV || "").toLowerCase() === "production";
  return {
    port: asNumber(env.PORT, 4173),
    publicBaseUrl: env.PUBLIC_BASE_URL || "http://localhost:4173",
    enableWorker: asBoolean(env.ENABLE_WORKER, production),
    automationIntervalMs: Math.max(10_000, asNumber(env.AUTOMATION_INTERVAL_MS, 60_000)),
    workerLeaseMs: Math.max(30_000, asNumber(env.WORKER_LEASE_MS, 180_000)),
    threadsGraphBase: env.THREADS_GRAPH_BASE || "https://graph.threads.net/v1.0",
    threadsUserId: env.THREADS_USER_ID || "",
    threadsAccessToken: env.THREADS_ACCESS_TOKEN || "",
    adminToken: env.ADMIN_TOKEN || "",
    adminPassword: env.ADMIN_PASSWORD || "",
    adminSessionSecret: env.ADMIN_SESSION_SECRET || "",
    adminSessionTtlMs: Math.max(30_000, asNumber(env.ADMIN_SESSION_TTL_MS, 24 * 60 * 60_000)),
    threadsDryRun: asBoolean(env.THREADS_DRY_RUN, true),
    threadsPublishDelayMs: Math.max(0, asNumber(env.THREADS_PUBLISH_DELAY_MS, 30_000)),
    adminTokenRole: env.ADMIN_TOKEN_ROLE || "admin",
    adminPasswordRole: env.ADMIN_PASSWORD_ROLE || env.ADMIN_TOKEN_ROLE || "admin",
    allowDemoOffers: asBoolean(env.ALLOW_DEMO_OFFERS, !production),
    aiDraftProvider: env.AI_DRAFT_PROVIDER || "openai",
    profitScriptProvider: env.PROFIT_SCRIPT_PROVIDER || env.AI_DRAFT_PROVIDER || "openai",
    openaiBaseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    openaiApiKey: env.OPENAI_API_KEY || "",
    openaiModel: env.OPENAI_MODEL || "gpt-5.2",
    openaiTimeoutMs: Math.max(10_000, Math.min(asNumber(env.OPENAI_TIMEOUT_MS, 90_000), 120_000)),
    offerPageContextEnabled: asBoolean(env.OFFER_PAGE_CONTEXT_ENABLED, true),
    offerPageTimeoutMs: Math.max(1000, Math.min(asNumber(env.OFFER_PAGE_TIMEOUT_MS, 8000), 15_000)),
    offerPageMaxBytes: Math.max(64 * 1024, Math.min(asNumber(env.OFFER_PAGE_MAX_BYTES, 512 * 1024), 1024 * 1024)),
    offerPageMaxChars: Math.max(1000, Math.min(asNumber(env.OFFER_PAGE_MAX_CHARS, 6000), 10_000)),
    aiWebResearchEnabled: asBoolean(env.AI_WEB_RESEARCH_ENABLED, false),
    aiWebResearchTimeoutMs: Math.max(5000, Math.min(asNumber(env.AI_WEB_RESEARCH_TIMEOUT_MS, 60_000), 90_000)),
    aiWebResearchMaxSources: Math.max(1, Math.min(asNumber(env.AI_WEB_RESEARCH_MAX_SOURCES, 6), 10)),
    databaseUrl: env.DATABASE_URL || "",
    databaseAutoMigrate: asBoolean(env.DATABASE_AUTO_MIGRATE, true),
    databaseSsl: asBoolean(env.DATABASE_SSL, false),
    autonomyMode: asBoolean(env.AUTONOMY_MODE, production),
    autonomyIntervalMs: Math.max(15 * 60_000, asNumber(env.AUTONOMY_INTERVAL_MS, 6 * 60 * 60_000)),
    autonomyMaxScriptsPerRun: Math.max(1, Math.min(asNumber(env.AUTONOMY_MAX_SCRIPTS_PER_RUN, 3), 5)),
    autonomyMaxOffersPerRun: Math.max(0, Math.min(asNumber(env.AUTONOMY_MAX_OFFERS_PER_RUN, 3), 10)),
    autonomyMaxCyclesPerDay: Math.max(1, Math.min(asNumber(env.AUTONOMY_MAX_CYCLES_PER_DAY, 8), 96)),
    autonomyMaxCreatedPostsPerDay: Math.max(1, Math.min(asNumber(env.AUTONOMY_MAX_CREATED_POSTS_PER_DAY, 24), 100)),
    autonomyMaxQueueDepth: Math.max(1, Math.min(asNumber(env.AUTONOMY_MAX_QUEUE_DEPTH, 50), 250)),
    autonomyMaxFailedRuns: Math.max(1, Math.min(asNumber(env.AUTONOMY_MAX_FAILED_RUNS, 3), 20)),
    autonomyMaxBlockedScriptsPerDay: Math.max(0, Math.min(asNumber(env.AUTONOMY_MAX_BLOCKED_SCRIPTS_PER_DAY, 6), 50)),
    contentFreshnessLookbackDays: Math.max(1, Math.min(asNumber(env.CONTENT_FRESHNESS_LOOKBACK_DAYS, 14), 90)),
    contentSimilarityThreshold: Math.max(0.5, Math.min(asNumber(env.CONTENT_SIMILARITY_THRESHOLD, 0.88), 0.98)),
    contentFatigueProductWindowHours: Math.max(1, Math.min(asNumber(env.CONTENT_FATIGUE_PRODUCT_WINDOW_HOURS, 24), 168)),
    contentFatigueMaxProductPostsPerWindow: Math.max(1, Math.min(asNumber(env.CONTENT_FATIGUE_MAX_PRODUCT_POSTS_PER_WINDOW, 1), 20)),
    contentFatigueHookWindowDays: Math.max(1, Math.min(asNumber(env.CONTENT_FATIGUE_HOOK_WINDOW_DAYS, 14), 90)),
    contentFatigueModelDailyCap: Math.max(1, Math.min(asNumber(env.CONTENT_FATIGUE_MODEL_DAILY_CAP, 3), 50)),
    contentFatigueCommercialWindowPosts: Math.max(2, Math.min(asNumber(env.CONTENT_FATIGUE_COMMERCIAL_WINDOW_POSTS, 3), 20)),
    contentFatigueMaxCommercialPostsPerWindow: Math.max(1, Math.min(asNumber(env.CONTENT_FATIGUE_MAX_COMMERCIAL_POSTS_PER_WINDOW, 1), 10)),
    adIntelligenceFeedUrls: asList(env.AD_INTELLIGENCE_FEED_URLS),
    affiliateOfferFeedUrls: asList(env.AFFILIATE_OFFER_FEED_URLS),
    adIntelligenceMaxItems: Math.max(1, Math.min(asNumber(env.AD_INTELLIGENCE_MAX_ITEMS, 24), 100)),
    adIntelligenceTimeoutMs: Math.max(1000, asNumber(env.AD_INTELLIGENCE_TIMEOUT_MS, 8000)),
    adIntelligenceRetryBaseMs: Math.max(60_000, asNumber(env.AD_INTELLIGENCE_RETRY_BASE_MS, 5 * 60_000)),
    adIntelligenceRetryMaxMs: Math.max(5 * 60_000, asNumber(env.AD_INTELLIGENCE_RETRY_MAX_MS, 60 * 60_000)),
    metaGraphBase: env.META_GRAPH_BASE || "https://graph.facebook.com/v25.0",
    metaAdLibraryAccessToken: env.META_AD_LIBRARY_ACCESS_TOKEN || "",
    metaAdLibraryQuery: env.META_AD_LIBRARY_QUERY || "",
    metaAdLibraryCountries: asList(env.META_AD_LIBRARY_COUNTRIES, ["US"]),
    metaAdLibraryAdType: env.META_AD_LIBRARY_AD_TYPE || "ALL",
    metaAdLibraryFields: env.META_AD_LIBRARY_FIELDS || "",
    metaAdLibraryLimit: Math.max(1, Math.min(asNumber(env.META_AD_LIBRARY_LIMIT, 10), 50)),
    conversionWebhookSecret: env.CONVERSION_WEBHOOK_SECRET || "",
    defaultDisclosureText: env.DEFAULT_DISCLOSURE_TEXT || "含聯盟連結",
    defaultUtmSource: env.DEFAULT_UTM_SOURCE || "threads",
    defaultUtmMedium: env.DEFAULT_UTM_MEDIUM || "affiliate_social"
  };
}

module.exports = { getRuntimeConfig };

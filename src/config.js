function asBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getRuntimeConfig(env) {
  return {
    port: asNumber(env.PORT, 4173),
    publicBaseUrl: env.PUBLIC_BASE_URL || "http://localhost:4173",
    enableWorker: asBoolean(env.ENABLE_WORKER, false),
    automationIntervalMs: Math.max(10_000, asNumber(env.AUTOMATION_INTERVAL_MS, 60_000)),
    threadsGraphBase: env.THREADS_GRAPH_BASE || "https://graph.threads.net/v1.0",
    threadsUserId: env.THREADS_USER_ID || "",
    threadsAccessToken: env.THREADS_ACCESS_TOKEN || "",
    threadsDryRun: asBoolean(env.THREADS_DRY_RUN, true),
    threadsPublishDelayMs: Math.max(0, asNumber(env.THREADS_PUBLISH_DELAY_MS, 30_000)),
    aiDraftProvider: env.AI_DRAFT_PROVIDER || "openai",
    openaiBaseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    openaiApiKey: env.OPENAI_API_KEY || "",
    openaiModel: env.OPENAI_MODEL || "gpt-5.2",
    databaseUrl: env.DATABASE_URL || "",
    databaseAutoMigrate: asBoolean(env.DATABASE_AUTO_MIGRATE, true),
    databaseSsl: asBoolean(env.DATABASE_SSL, false),
    defaultDisclosureText: env.DEFAULT_DISCLOSURE_TEXT || "含聯盟連結",
    defaultUtmSource: env.DEFAULT_UTM_SOURCE || "threads",
    defaultUtmMedium: env.DEFAULT_UTM_MEDIUM || "affiliate_social"
  };
}

module.exports = { getRuntimeConfig };

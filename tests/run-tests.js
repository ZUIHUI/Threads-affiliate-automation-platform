const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { getRuntimeConfig } = require("../src/config");
const { createStore } = require("../src/store");
const { extractUniqueUrls, validatePost } = require("../src/validators");
const { evaluateContentFatigue, similarityScore } = require("../src/contentFatigue");
const { buildAutonomyPolicy, buildDashboard, generateDrafts, generateDraftsAsync, recordConversion, runAutomation } = require("../src/automation");
const { buildProfitRunPreview, runProfitEngine } = require("../src/profitEngine");
const { buildAutonomyReadiness } = require("../src/readiness");
const { buildMetaAdLibraryUrl, collectAdIntelligence } = require("../src/adIntelligenceClient");
const { generateProfitScripts } = require("../src/profitScriptGenerator");
const { generateOpenAIDrafts, normalizeDrafts } = require("../src/openaiClient");
const { createTextContainer, publishContainer, getPublishingLimit } = require("../src/threadsClient");
const { upsertRealOffer } = require("../src/offerManagement");

async function main() {
  const config = getRuntimeConfig({
    PUBLIC_BASE_URL: "http://localhost:4173",
    THREADS_DRY_RUN: "true"
  });

  assert.deepEqual(extractUniqueUrls("a https://a.test x https://a.test, https://b.test"), [
    "https://a.test",
    "https://b.test"
  ]);

  const valid = validatePost({
    text: "含聯盟連結：hello https://example.com",
    linkAttachment: "https://example.com",
    topicTag: "效率工具"
  }, config);
  assert.equal(valid.valid, true);

  const invalid = validatePost({
    text: `${"x".repeat(501)}`,
    topicTag: "bad.tag"
  }, config);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes("500")));
  assert.ok(invalid.errors.some((error) => error.includes("periods")));

  const fatigueNow = new Date("2026-07-09T08:00:00.000Z").toISOString();
  const fatigueHistory = [
    {
      id: "hist_product",
      productId: "prd_a",
      campaignId: "cmp_a",
      funnelRatio: "model_trust_stack",
      hook: "Original trust hook",
      cta: "https://example.com/a",
      text: "含聯盟連結：A simple automation workflow for creators https://example.com/a?",
      linkAttachment: "https://example.com/a",
      status: "published",
      publishedAt: "2026-07-09T07:30:00.000Z"
    }
  ];
  assert.equal(similarityScore("A simple automation workflow for creators", "A simple automation workflow for creators."), 1);
  const similarityFatigue = evaluateContentFatigue({
    id: "post_similar",
    productId: "prd_b",
    campaignId: "cmp_a",
    funnelRatio: "model_conversion",
    hook: "Fresh hook",
    cta: "https://example.com/b",
    text: "含聯盟連結：A simple automation workflow for creators https://example.com/b?",
    linkAttachment: "https://example.com/b"
  }, fatigueHistory, { ...config, now: fatigueNow });
  assert.equal(similarityFatigue.status, "blocked");
  assert.equal(similarityFatigue.reasons.some((reason) => reason.id === "similarity"), true);
  assert.equal(similarityFatigue.similarToPostId, "hist_product");

  const productFatigue = evaluateContentFatigue({
    id: "post_product",
    productId: "prd_a",
    campaignId: "cmp_a",
    funnelRatio: "model_conversion",
    hook: "Different product hook",
    cta: "https://example.com/product-new",
    text: "含聯盟連結：Different content about testing a workflow https://example.com/product-new?",
    linkAttachment: "https://example.com/product-new"
  }, fatigueHistory, { ...config, now: fatigueNow });
  assert.equal(productFatigue.status, "blocked");
  assert.equal(productFatigue.reasons.some((reason) => reason.id === "same_product_frequency"), true);

  const hookFatigue = evaluateContentFatigue({
    id: "post_hook",
    productId: "prd_b",
    campaignId: "cmp_a",
    funnelRatio: "model_conversion",
    hook: "Original trust hook",
    cta: "https://example.com/hook",
    text: "含聯盟連結：Completely different body copy for hook repetition https://example.com/hook?",
    linkAttachment: "https://example.com/hook"
  }, fatigueHistory, { ...config, now: fatigueNow });
  assert.equal(hookFatigue.status, "blocked");
  assert.equal(hookFatigue.reasons.some((reason) => reason.id === "same_hook"), true);

  const ctaHistory = [
    { ...fatigueHistory[0], id: "hist_cta_1", productId: "prd_a", cta: "https://example.com/repeat", linkAttachment: "https://example.com/repeat", publishedAt: "2026-07-09T07:50:00.000Z" },
    { ...fatigueHistory[0], id: "hist_cta_2", productId: "prd_b", cta: "https://example.com/repeat", linkAttachment: "https://example.com/repeat", publishedAt: "2026-07-09T07:40:00.000Z" }
  ];
  const ctaFatigue = evaluateContentFatigue({
    id: "post_cta",
    productId: "prd_c",
    campaignId: "cmp_a",
    funnelRatio: "model_conversion",
    hook: "Unique CTA hook",
    cta: "https://example.com/repeat",
    text: "含聯盟連結：Unique CTA body https://example.com/repeat?",
    linkAttachment: "https://example.com/repeat"
  }, ctaHistory, { ...config, now: fatigueNow });
  assert.equal(ctaFatigue.status, "blocked");
  assert.equal(ctaFatigue.reasons.some((reason) => reason.id === "same_cta_consecutive"), true);

  const modelHistory = Array.from({ length: 3 }, (_, index) => ({
    ...fatigueHistory[0],
    id: `hist_model_${index}`,
    productId: `prd_model_${index}`,
    funnelRatio: "model_conversion",
    cta: `https://example.com/model-${index}`,
    linkAttachment: `https://example.com/model-${index}`,
    publishedAt: `2026-07-09T07:${String(20 + index).padStart(2, "0")}:00.000Z`
  }));
  const modelFatigue = evaluateContentFatigue({
    id: "post_model",
    productId: "prd_model_new",
    campaignId: "cmp_a",
    funnelRatio: "model_conversion",
    hook: "Unique model hook",
    cta: "https://example.com/model-new",
    text: "含聯盟連結：Unique model body https://example.com/model-new?",
    linkAttachment: "https://example.com/model-new"
  }, modelHistory, { ...config, now: fatigueNow });
  assert.equal(modelFatigue.status, "blocked");
  assert.equal(modelFatigue.reasons.some((reason) => reason.id === "same_profit_model_daily_cap"), true);

  const commercialFatigue = evaluateContentFatigue({
    id: "post_commercial",
    productId: "prd_commercial_new",
    campaignId: "cmp_a",
    funnelRatio: "model_soft",
    hook: "Unique commercial hook",
    cta: "https://example.com/commercial-new",
    text: "含聯盟連結：Commercial body https://example.com/commercial-new?",
    linkAttachment: "https://example.com/commercial-new"
  }, [
    { ...fatigueHistory[0], id: "hist_strong", productId: "prd_x", cta: "https://example.com/x", linkAttachment: "https://example.com/x", publishedAt: "2026-07-09T07:50:00.000Z" },
    { ...fatigueHistory[0], id: "hist_soft", productId: "prd_y", funnelRatio: "trust", cta: "", linkAttachment: "", text: "Soft education post?", publishedAt: "2026-07-09T07:45:00.000Z" }
  ], { ...config, now: fatigueNow });
  assert.equal(commercialFatigue.status, "warning");
  assert.equal(commercialFatigue.reasons.some((reason) => reason.id === "commercial_ratio"), true);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "threads-affiliate-ops-"));
  const store = createStore(path.join(tempDir, "store.json"));
  const localReadiness = buildAutonomyReadiness(store.read(), config);
  assert.equal(localReadiness.summary.mode, "blocked");
  assert.equal(localReadiness.checks.some((check) => check.id === "worker" && check.status === "blocked"), true);
  const clearPolicy = buildAutonomyPolicy(store.read(), config);
  assert.equal(clearPolicy.canRunCycle, true);
  const pausedPolicyState = store.read();
  pausedPolicyState.events.unshift({
    id: "evt_cycle_limit",
    type: "autonomy.cycle.completed",
    createdAt: new Date().toISOString()
  });
  const pausedPolicy = buildAutonomyPolicy(pausedPolicyState, getRuntimeConfig({
    PUBLIC_BASE_URL: "http://localhost:4173",
    THREADS_DRY_RUN: "true",
    AUTONOMY_MAX_CYCLES_PER_DAY: "1"
  }));
  assert.equal(pausedPolicy.canRunCycle, false);
  assert.equal(pausedPolicy.rules.find((rule) => rule.id === "cycle_budget").status, "pause");

  const liveReadyConfig = getRuntimeConfig({
    PUBLIC_BASE_URL: "https://threads-affiliate.example",
    ADMIN_TOKEN: "admin-token",
    ENABLE_WORKER: "true",
    AUTONOMY_MODE: "true",
    THREADS_DRY_RUN: "false",
    THREADS_USER_ID: "threads_user_1",
    THREADS_ACCESS_TOKEN: "threads-token",
    DATABASE_URL: "postgresql://user:pass@db.example:5432/app?sslmode=require",
    PROFIT_SCRIPT_PROVIDER: "openai",
    OPENAI_API_KEY: "test-key",
    AD_INTELLIGENCE_FEED_URLS: "https://feeds.test/ads.json",
    AFFILIATE_OFFER_FEED_URLS: "https://feeds.test/offers.json",
    CONVERSION_WEBHOOK_SECRET: "secret",
    DEFAULT_DISCLOSURE_TEXT: "含聯盟連結"
  });
  store.update((state) => upsertRealOffer(state, {
    campaignName: "Test monetizable campaign",
    targetPersona: "Test operators",
    productName: "Test affiliate offer",
    offer: "Test recurring commission",
    network: "ClickBank",
    targetUrl: "https://hop.clickbank.net/?affiliate=tester&vendor=offer",
    slug: "test-real-offer"
  }, liveReadyConfig));
  const liveReadiness = buildAutonomyReadiness(store.read(), liveReadyConfig);
  assert.equal(liveReadiness.summary.mode, "live_ready");
  assert.equal(liveReadiness.summary.blocked, 0);
  assert.equal(liveReadiness.liveGate.allowed, true);
  assert.equal(liveReadiness.summary.liveModeAllowed, true);
  const generated = store.update((state) => generateDrafts(state, { topic: "AI 自動化聯盟行銷", autoApprove: true }, config));
  assert.equal(generated.created.length, 5);
  assert.equal(generated.created[0].contentType, "教學型");
  assert.equal(generated.created[0].status, "needs_review");
  assert.equal(generated.created[0].approved, false);
  assert.equal(generated.created[0].review.status, "needs_review");
  assert.equal(generated.created[0].review.autoApproveIgnored, true);
  assert.equal(Boolean(generated.created[0].validationResult), true);
  assert.equal(["present", "missing", "not_required"].includes(generated.created[0].disclosureStatus), true);

  const intelligenceConfig = getRuntimeConfig({
    PUBLIC_BASE_URL: "http://localhost:4173",
    THREADS_DRY_RUN: "true",
    AD_INTELLIGENCE_FEED_URLS: "https://feeds.test/ads.json",
    AFFILIATE_OFFER_FEED_URLS: "https://feeds.test/offers.json",
    META_GRAPH_BASE: "https://graph.facebook.test/v25.0",
    META_AD_LIBRARY_ACCESS_TOKEN: "meta-secret",
    META_AD_LIBRARY_QUERY: "ai automation",
    META_AD_LIBRARY_COUNTRIES: "US,TW"
  });
  const metaUrl = buildMetaAdLibraryUrl(intelligenceConfig);
  assert.equal(metaUrl.pathname, "/v25.0/ads_archive");
  assert.equal(metaUrl.searchParams.get("search_terms"), "ai automation");
  assert.equal(JSON.parse(metaUrl.searchParams.get("ad_reached_countries"))[1], "TW");

  const requested = [];
  const intelligence = await collectAdIntelligence(intelligenceConfig, {
    fetchImpl: async (url) => {
      requested.push(String(url));
      if (String(url).includes("ads_archive")) {
        return {
          ok: true,
          async json() {
            return {
              data: [{
                id: "ad_123",
                page_name: "Automation Lab",
                ad_snapshot_url: "https://www.facebook.com/ads/archive/render_ad/?id=123&access_token=meta-secret",
                ad_creative_bodies: ["Compare tools before buying."]
              }]
            };
          }
        };
      }
      if (String(url).includes("offers")) {
        return {
          ok: true,
          async json() {
            return {
              offers: [{
                name: "Automation Toolkit",
                offer: "CPA payout for workflow builders",
                commissionValue: 25,
                landingUrl: "https://offer.example/toolkit?api_key=secret"
              }]
            };
          }
        };
      }
      return {
        ok: true,
        async json() {
          return {
            items: [{
              title: "AI workflow hook",
              angle: "Turn a messy process into a checklist.",
              landingUrl: "https://ads.example/hook"
            }]
          };
        }
      };
    }
  });
  assert.equal(requested.length, 3);
  assert.equal(intelligence.items.length, 3);
  assert.equal(intelligence.sourceStatuses.filter((source) => source.status === "connected").length, 3);
  assert.equal(intelligence.items.some((item) => item.kind === "offer" && item.commissionValue === 25), true);
  assert.equal(intelligence.items.some((item) => String(item.adSnapshotUrl).includes("access_token")), false);
  const failingSourceConfig = getRuntimeConfig({
    PUBLIC_BASE_URL: "http://localhost:4173",
    THREADS_DRY_RUN: "true",
    AD_INTELLIGENCE_FEED_URLS: "https://feeds.test/down.json",
    AD_INTELLIGENCE_RETRY_BASE_MS: "60000",
    AD_INTELLIGENCE_RETRY_MAX_MS: "60000"
  });
  const failingIntelligence = await collectAdIntelligence(failingSourceConfig, {
    fetchImpl: async () => ({ ok: false, status: 503, async json() { return {}; } })
  });
  assert.equal(failingIntelligence.sourceStatuses.find((source) => source.id === "custom_ad_feed").status, "error");
  const sourceHealthStore = createStore(path.join(tempDir, "source-health-store.json"));
  sourceHealthStore.update((state) => runProfitEngine(state, failingSourceConfig, {
    source: "source-health-test",
    force: true,
    createPosts: false,
    intelligence: failingIntelligence
  }));
  const sourceHealthState = sourceHealthStore.read();
  assert.equal(Boolean(sourceHealthState.profitEngine.sourceHealth.custom_ad_feed.nextRetryAt), true);
  const backoffIntelligence = await collectAdIntelligence(failingSourceConfig, {
    sourceHealth: sourceHealthState.profitEngine.sourceHealth,
    fetchImpl: async () => {
      throw new Error("backoff should skip fetch");
    }
  });
  assert.equal(backoffIntelligence.sourceStatuses.find((source) => source.id === "custom_ad_feed").status, "backoff");

  const result = await runAutomation(store, config, { source: "test" });
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.simulated > 0, true);
  assert.equal(result.dashboard.metrics.simulated > 0, true);

  const blockedLiveConfig = getRuntimeConfig({
    PUBLIC_BASE_URL: "https://threads-affiliate.example",
    THREADS_DRY_RUN: "false",
    ENABLE_WORKER: "true",
    AUTONOMY_MODE: "true",
    ADMIN_PASSWORD: "admin-secret"
  });
  blockedLiveConfig.defaultDisclosureText = "";
  const blockedLiveStore = createStore(path.join(tempDir, "blocked-live-store.json"));
  const blockedLiveReadiness = buildAutonomyReadiness(blockedLiveStore.read(), blockedLiveConfig);
  assert.equal(blockedLiveReadiness.liveGate.allowed, false);
  assert.equal(blockedLiveReadiness.liveGate.missingEnv.includes("THREADS_USER_ID"), true);
  assert.equal(blockedLiveReadiness.liveGate.missingEnv.includes("THREADS_ACCESS_TOKEN"), true);
  assert.equal(blockedLiveReadiness.liveGate.missingEnv.includes("DATABASE_URL"), true);
  assert.equal(blockedLiveReadiness.liveGate.missingEnv.includes("CONVERSION_WEBHOOK_SECRET"), true);
  assert.equal(blockedLiveReadiness.liveGate.missingEnv.includes("DEFAULT_DISCLOSURE_TEXT"), true);
  const blockedLiveRun = await runAutomation(blockedLiveStore, blockedLiveConfig, { source: "live-gate-test" });
  assert.equal(blockedLiveRun.run.status, "blocked");
  assert.equal(blockedLiveRun.run.readinessGate.allowed, false);
  assert.equal(blockedLiveRun.run.readinessGate.reasons.length > 0, true);

  const profitResult = store.update((state) => runProfitEngine(state, config, {
    source: "test",
    force: true,
    createPosts: true,
    autoApprove: true
  }));
  assert.equal(profitResult.skipped, false);
  assert.equal(profitResult.createdPosts.length > 0, true);
  assert.equal(profitResult.createdPosts[0].status, "needs_review");
  assert.equal(profitResult.createdPosts[0].approved, false);
  assert.equal(profitResult.createdPosts[0].review.autoApproveIgnored, true);
  assert.equal(store.read().profitEngine.runs.length > 0, true);
  assert.equal(profitResult.run.experimentSnapshot.leaderModelId, profitResult.run.selectedModelId);
  assert.equal(profitResult.run.experimentSnapshot.optimizerMode, profitResult.run.optimizerPolicy.mode);
  assert.equal(profitResult.run.optimizerPolicy.mode, "explore");
  assert.equal(profitResult.profitEngine.optimizer.latestPolicy.targetModelId, profitResult.run.optimizerPolicy.targetModelId);
  assert.equal(profitResult.profitEngine.experiments.experiments.length, 4);
  assert.equal(profitResult.profitEngine.experiments.optimizationQueue.length > 0, true);
  assert.equal(profitResult.scripts[0].post.includes("這輪系統會補齊尚未測過的獲利模式"), true);
  const attributedPost = profitResult.createdPosts[0];
  const attributedUrl = new URL(attributedPost.linkAttachment);
  assert.equal(attributedUrl.searchParams.get("post"), attributedPost.id);
  assert.equal(attributedUrl.searchParams.get("model"), attributedPost.funnelRatio);
  const attributedConversion = store.update((state) => recordConversion(state, {
    postId: attributedPost.id,
    networkEventId: "post-order-1",
    commissionValue: 11,
    orderValue: 55,
    status: "approved"
  }));
  assert.equal(attributedConversion.conversion.postId, attributedPost.id);
  assert.equal(attributedConversion.conversion.modelId, attributedPost.funnelRatio);
  const attributedDashboard = buildDashboard(store.read(), config);
  assert.equal(attributedDashboard.attribution.summary.attributedConversions >= 1, true);
  assert.equal(attributedDashboard.attribution.topPosts[0].postId, attributedPost.id);
  const duplicateScriptResult = store.update((state) => runProfitEngine(state, getRuntimeConfig({
    PUBLIC_BASE_URL: "http://localhost:4173",
    THREADS_DRY_RUN: "true",
    CONTENT_SIMILARITY_THRESHOLD: "0.6"
  }), {
    source: "freshness-test",
    force: true,
    createPosts: true,
    aiScripts: [{
      type: "duplicate",
      hook: attributedPost.hook,
      post: attributedPost.text,
      cta: "same idea",
      risk_note: "freshness test"
    }],
    aiScriptSource: "test"
  }));
  assert.equal(duplicateScriptResult.createdPosts.length, 0);
  assert.equal(duplicateScriptResult.blockedScripts[0].reason.includes("Content freshness blocked"), true);
  assert.equal(Boolean(duplicateScriptResult.blockedScripts[0].freshness.matchedPostId), true);

  const signalStore = createStore(path.join(tempDir, "signal-store.json"));
  const signalResult = signalStore.update((state) => runProfitEngine(state, intelligenceConfig, {
    source: "test",
    force: true,
    createPosts: false,
    intelligence
  }));
  const signalState = signalStore.read();
  assert.equal(signalResult.skipped, false);
  assert.equal(signalResult.run.ingestedSignalCount, 3);
  assert.equal(signalResult.run.syncedProductIds.length, 1);
  assert.equal(signalState.profitEngine.externalSignals.length, 3);
  assert.equal(signalState.profitEngine.sourceStatuses[0].status, "connected");
  assert.equal(signalState.products.some((product) => product.sourceSignalId && product.name === "Automation Toolkit"), true);
  assert.equal(signalState.affiliateLinks.some((link) => link.targetUrl.includes("offer.example/toolkit")), true);
  assert.equal(signalResult.scripts.some((script) => script.post.includes("這輪參考")), true);

  const syncedLink = signalState.affiliateLinks.find((link) => link.targetUrl.includes("offer.example/toolkit"));
  const conversionResult = signalStore.update((state) => recordConversion(state, {
    affiliateLinkId: syncedLink.id,
    networkEventId: "network-order-1",
    commissionValue: 25,
    orderValue: 99,
    status: "approved"
  }));
  assert.equal(conversionResult.duplicate, false);
  const duplicateConversion = signalStore.update((state) => recordConversion(state, {
    affiliateLinkId: syncedLink.id,
    networkEventId: "network-order-1",
    commissionValue: 25
  }));
  assert.equal(duplicateConversion.duplicate, true);
  const conversionState = signalStore.read();
  const updatedSyncedLink = conversionState.affiliateLinks.find((link) => link.id === syncedLink.id);
  assert.equal(updatedSyncedLink.conversions, 1);
  assert.equal(updatedSyncedLink.revenue, 25);

  const aiProfitConfig = getRuntimeConfig({
    PUBLIC_BASE_URL: "http://localhost:4173",
    THREADS_DRY_RUN: "true",
    AI_DRAFT_PROVIDER: "openai",
    PROFIT_SCRIPT_PROVIDER: "openai",
    OPENAI_API_KEY: "profit-key",
    OPENAI_BASE_URL: "https://api.openai.test/v1",
    OPENAI_MODEL: "gpt-5.2"
  });
  const aiPreview = buildProfitRunPreview(signalStore.read(), aiProfitConfig, {
    source: "test",
    force: true,
    intelligence
  });
  assert.equal(Boolean(aiPreview.optimizerPolicy.targetModelId), true);
  const aiProfitScripts = await generateProfitScripts({
    preview: aiPreview,
    config: aiProfitConfig,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.openai.test/v1/responses");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "gpt-5.2");
      assert.equal(body.text.format.name, "threads_profit_scripts");
      assert.equal(options.headers.authorization, "Bearer profit-key");
      return {
        ok: true,
        async json() {
          return {
            output_text: JSON.stringify({
              scripts: Array.from({ length: aiPreview.count }, (_, index) => ({
                type: "ai_profit",
                hook: `AI profit hook ${index + 1}`,
                post: `含聯盟連結：AI generated truthful script ${index + 1}. ${aiPreview.trackingUrl}\n\n你會先測哪一步？`,
                cta: "看延伸資源",
                risk_note: "truthful affiliate disclosure"
              }))
            })
          };
        }
      };
    }
  });
  assert.equal(aiProfitScripts.source, "openai");
  assert.equal(aiProfitScripts.scripts.length, aiPreview.count);
  const aiProfitResult = signalStore.update((state) => runProfitEngine(state, aiProfitConfig, {
    source: "test",
    force: true,
    createPosts: false,
    intelligence,
    aiScripts: aiProfitScripts.scripts,
    aiScriptSource: aiProfitScripts.source
  }));
  assert.equal(aiProfitResult.run.scriptSource, "openai");
  assert.equal(aiProfitResult.scripts[0].hook, "AI profit hook 1");
  assert.equal(aiProfitResult.profitEngine.generatedScripts[0].source, "openai");

  const postCountBeforeBlocked = signalStore.read().posts.length;
  const blockedResult = signalStore.update((state) => runProfitEngine(state, aiProfitConfig, {
    source: "test",
    force: true,
    createPosts: true,
    intelligence,
    aiScripts: [{
      type: "bad_links",
      hook: "Too many links",
      post: `含聯盟連結：這則故意放太多連結 https://a1.test https://a2.test https://a3.test https://a4.test https://a5.test https://a6.test\n\n你會先看哪個？`,
      cta: "bad",
      risk_note: "should be blocked"
    }],
    aiScriptSource: "openai"
  }));
  assert.equal(blockedResult.createdPosts.length, 0);
  assert.equal(blockedResult.run.blockedScriptCount, 1);
  assert.equal(blockedResult.blockedScripts[0].reason.includes("unique links"), true);
  assert.equal(signalStore.read().posts.length, postCountBeforeBlocked);

  const normalized = normalizeDrafts({
    drafts: Array.from({ length: 5 }, (_, index) => ({
      hook: `hook ${index + 1}`,
      post: `post ${index + 1}?`,
      cta: `cta ${index + 1}`,
      risk_note: "low"
    }))
  });
  assert.equal(normalized.length, 5);
  assert.equal(normalized[4].ratio, "conversion");

  const openAiDrafts = await generateOpenAIDrafts({
    topic: "AI 自動化聯盟行銷",
    config: {
      openaiApiKey: "test-key",
      openaiBaseUrl: "https://api.openai.test/v1",
      openaiModel: "gpt-5.2"
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.openai.test/v1/responses");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "gpt-5.2");
      assert.equal(body.text.format.type, "json_schema");
      return {
        ok: true,
        async json() {
          return {
            output_text: JSON.stringify({
              drafts: Array.from({ length: 5 }, (_, index) => ({
                hook: `AI hook ${index + 1}`,
                post: `AI post ${index + 1}?`,
                cta: `AI cta ${index + 1}`,
                risk_note: "low"
              }))
            })
          };
        }
      };
    }
  });
  assert.equal(openAiDrafts.length, 5);
  assert.equal(openAiDrafts[0].hook, "AI hook 1");

  const openAiStore = createStore(path.join(tempDir, "openai-store.json"));
  const openAiConfig = getRuntimeConfig({
    PUBLIC_BASE_URL: "http://localhost:4173",
    THREADS_DRY_RUN: "true",
    AI_DRAFT_PROVIDER: "openai",
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://api.openai.test/v1",
    OPENAI_MODEL: "gpt-5.2"
  });
  const openAiState = openAiStore.read();
  const asyncGenerated = await generateDraftsAsync(openAiState, { topic: "AI 自動化聯盟行銷" }, openAiConfig, {
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          output_text: JSON.stringify({
            drafts: Array.from({ length: 5 }, (_, index) => ({
              hook: `Async hook ${index + 1}`,
              post: `Async post ${index + 1}?`,
              cta: `Async cta ${index + 1}`,
              risk_note: "low"
            }))
          })
        };
      }
    })
  });
  assert.equal(asyncGenerated.created.length, 5);
  assert.equal(asyncGenerated.created[0].hook, "Async hook 1");
  assert.equal(asyncGenerated.created[0].status, "needs_review");
  assert.equal(asyncGenerated.created[0].approved, false);

  const originalFetch = global.fetch;
  try {
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async text() {
          return JSON.stringify({ id: calls.length === 1 ? "container_1" : "media_1" });
        },
        async json() {
          return { data: [{ quota_usage: 7, config: { quota_total: 250, quota_duration: 86400 } }] };
        }
      };
    };
    const liveConfig = getRuntimeConfig({
      THREADS_DRY_RUN: "false",
      THREADS_USER_ID: "threads_user_1",
      THREADS_ACCESS_TOKEN: "threads-token"
    });
    const container = await createTextContainer(liveConfig, {
      text: "含聯盟連結：測試內容？",
      topicTag: "AI自動化",
      linkAttachment: "https://example.com/link"
    });
    assert.equal(container.id, "container_1");
    const body1 = calls[0].options.body;
    assert.equal(calls[0].url, "https://graph.threads.net/v1.0/threads_user_1/threads");
    assert.equal(body1.get("media_type"), "TEXT");
    assert.equal(body1.get("access_token"), "threads-token");
    assert.equal(body1.get("link_attachment"), "https://example.com/link");

    const published = await publishContainer(liveConfig, "container_1");
    assert.equal(published.id, "media_1");
    assert.equal(calls[1].url, "https://graph.threads.net/v1.0/threads_user_1/threads_publish");
    assert.equal(calls[1].options.body.get("creation_id"), "container_1");
  } finally {
    global.fetch = originalFetch;
  }

  const dryLimit = await getPublishingLimit(config);
  assert.equal(dryLimit.dryRun, true);

  const { configureRuntime, runWorkerTick, startServer } = require("../server");
  const server = await startServer(0, { store, config });
  const address = server.address();
  const healthResponse = await fetch(`http://127.0.0.1:${address.port}/health`);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  const consoleResponse = await fetch(`http://127.0.0.1:${address.port}/`);
  const consoleHtml = await consoleResponse.text();
  assert.equal(consoleHtml.includes("Threads 聯盟自動化"), true);
  const dashboardResponse = await fetch(`http://127.0.0.1:${address.port}/api/dashboard`);
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.promptTemplate.includes("Threads 短文內容企劃"), true);
  assert.equal(dashboard.profitEngine.models.length > 0, true);
  assert.equal(dashboard.profitEngine.experiments.experiments.length > 0, true);
  assert.equal(Array.isArray(dashboard.profitEngine.experiments.optimizationQueue), true);
  assert.equal(dashboard.profitEngine.opportunityScanner.opportunities.length > 0, true);
  assert.equal(Boolean(dashboard.profitEngine.opportunityScanner.opportunities[0].automationAction), true);
  assert.equal(Boolean(dashboard.profitEngine.optimizer.latestPolicy), true);
  assert.equal(dashboard.autonomyPipeline.steps.length, 6);
  assert.equal(dashboard.autonomyPipeline.steps.some((step) => step.id === "worker_loop"), true);
  assert.equal(Boolean(dashboard.autonomyPipeline.summary.nextGate), true);
  assert.equal(Array.isArray(dashboard.autonomyPolicy.rules), true);
  assert.equal(dashboard.autonomyPolicy.canCreatePosts, true);
  assert.equal(dashboard.operatingMap.flow.some((step) => step.id === "research_profit_model"), true);
  assert.equal(dashboard.operatingMap.lanes.some((lane) => lane.id === "ai_script_agent"), true);
  assert.equal(Boolean(dashboard.operatingMap.decision.selectedModel), true);
  assert.equal(dashboard.growthLoop.missions.some((mission) => mission.id === "natural_script_generation"), true);
  assert.equal(Number.isFinite(dashboard.growthLoop.summary.automationScore), true);
  assert.equal(typeof dashboard.growthLoop.controls.canRunCycle, "boolean");
  assert.equal(typeof dashboard.workerLease.active, "boolean");
  assert.equal(dashboard.attribution.summary.attributedConversions >= 1, true);
  const trackedPost = dashboard.posts.find((post) => String(post.linkAttachment || "").includes("post="));
  assert.equal(Boolean(trackedPost), true);
  const localTrackingUrl = new URL(trackedPost.linkAttachment);
  localTrackingUrl.protocol = "http:";
  localTrackingUrl.host = `127.0.0.1:${address.port}`;
  const redirectResponse = await fetch(localTrackingUrl, { redirect: "manual" });
  assert.equal(redirectResponse.status, 302);
  const redirectLocation = new URL(redirectResponse.headers.get("location"));
  assert.equal(redirectLocation.searchParams.get("subid"), trackedPost.id);
  assert.equal(redirectLocation.searchParams.get("utm_term"), trackedPost.funnelRatio);
  assert.equal(dashboard.readiness.checks.some((check) => check.id === "worker"), true);
  assert.equal(dashboard.readiness.connectorCenter.connectors.some((item) => item.id === "threads_api"), true);
  assert.equal(dashboard.readiness.connectorCenter.connectors.some((item) => item.id === "affiliate_offer_feed"), true);
  assert.equal(Number.isFinite(dashboard.readiness.connectorCenter.score), true);
  const readinessResponse = await fetch(`http://127.0.0.1:${address.port}/api/readiness`);
  const readinessPayload = await readinessResponse.json();
  assert.equal(readinessResponse.status, 200);
  assert.equal(readinessPayload.summary.mode, "blocked");
  assert.equal(readinessPayload.checks.some((check) => check.id === "database"), true);
  assert.equal(readinessPayload.connectorCenter.connectors.some((item) => item.id === "conversion_webhook"), true);
  const conversionResponse = await fetch(`http://127.0.0.1:${address.port}/api/conversions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slug: "ai-affiliate-prompt-pack",
      networkEventId: "server-order-1",
      commissionValue: 8,
      orderValue: 49,
      status: "approved"
    })
  });
  const conversionPayload = await conversionResponse.json();
  assert.equal(conversionResponse.status, 201);
  assert.equal(conversionPayload.duplicate, false);
  const profitResponse = await fetch(`http://127.0.0.1:${address.port}/api/profit-engine/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "test", force: true })
  });
  const profitPayload = await profitResponse.json();
  assert.equal(profitPayload.result.skipped, false);
  assert.equal(profitPayload.result.run.ingestedSignalCount, 0);
  assert.equal(profitPayload.dashboard.profitEngine.sourceStatuses.length > 0, true);
  assert.equal(Boolean(profitPayload.dashboard.profitEngine.sourceRecovery.mode), true);
  assert.equal(profitPayload.dashboard.profitEngine.opportunityScanner.opportunities.length > 0, true);
  assert.equal(profitPayload.dashboard.profitEngine.generatedScripts.length > 0, true);
  assert.equal(profitPayload.dashboard.autonomyPipeline.steps.some((step) => step.id === "profit_optimizer"), true);
  assert.equal(profitPayload.dashboard.operatingMap.summary.objective.includes("聯盟成交"), true);
  assert.equal(profitPayload.dashboard.growthLoop.missions.some((mission) => mission.id === "queue_publish"), true);
  const cycleResponse = await fetch(`http://127.0.0.1:${address.port}/api/autonomy/cycle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "test-cycle",
      force: true,
      ingest: false,
      ai: false,
      createPosts: true,
      autoApprove: true,
      publishQueue: true
    })
  });
  const cyclePayload = await cycleResponse.json();
  assert.equal(cycleResponse.status, 200);
  assert.equal(cyclePayload.cycle.status, "completed");
  assert.equal(cyclePayload.cycle.source, "test-cycle");
  assert.equal(cyclePayload.policy.canRunCycle, true);
  assert.equal(cyclePayload.dashboard.autonomyPipeline.latestCycle.source, "test-cycle");
  assert.equal(cyclePayload.dashboard.autonomyPolicy.rules.some((rule) => rule.id === "cycle_budget"), true);
  assert.equal(cyclePayload.dashboard.operatingMap.summary.healthScore > 0, true);
  assert.equal(cyclePayload.dashboard.growthLoop.summary.autoExecutable >= 0, true);
  assert.equal(cyclePayload.dashboard.recentEvents.some((event) => event.type === "autonomy.cycle.completed"), true);
  const growthResponse = await fetch(`http://127.0.0.1:${address.port}/api/growth-loop/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "test-growth",
      force: true
    })
  });
  const growthPayload = await growthResponse.json();
  assert.equal(growthResponse.status, 200);
  assert.equal(growthPayload.status, "executed");
  assert.equal(Boolean(growthPayload.mission.id), true);
  assert.equal(growthPayload.dashboard.recentEvents.some((event) => event.type === "growth_loop.executed"), true);
  assert.equal(Boolean(growthPayload.dashboard.growthLoop.summary.lastExecution), true);

  const publicAuthConfig = getRuntimeConfig({
    PUBLIC_BASE_URL: "https://threads-affiliate.example",
    THREADS_DRY_RUN: "true"
  });
  const publicAuthStore = createStore(path.join(tempDir, "public-auth-store.json"));
  const publicAuthServer = await startServer(0, { store: publicAuthStore, config: publicAuthConfig });
  const publicAuthAddress = publicAuthServer.address();
  const publicAuthBase = `http://127.0.0.1:${publicAuthAddress.port}`;
  const publicAuthPage = await fetch(`${publicAuthBase}/`, { redirect: "manual" });
  assert.equal(publicAuthPage.status, 302);
  assert.equal(publicAuthPage.headers.get("location"), "/login");
  const publicAuthMe = await fetch(`${publicAuthBase}/api/me`);
  const publicAuthMePayload = await publicAuthMe.json();
  assert.equal(publicAuthMe.status, 200);
  assert.equal(publicAuthMePayload.authRequired, true);
  assert.equal(publicAuthMePayload.authenticated, false);
  assert.equal(publicAuthMePayload.methods.token, false);
  const publicAuthDashboard = await fetch(`${publicAuthBase}/api/dashboard`);
  assert.equal(publicAuthDashboard.status, 401);
  const publicAuthReadiness = await fetch(`${publicAuthBase}/api/readiness`);
  assert.equal(publicAuthReadiness.status, 200);
  await new Promise((resolve, reject) => {
    publicAuthServer.close((error) => error ? reject(error) : resolve());
  });

  const apiBlockedLiveConfig = getRuntimeConfig({
    PUBLIC_BASE_URL: "https://threads-affiliate.example",
    THREADS_DRY_RUN: "false",
    ADMIN_PASSWORD: "admin-secret"
  });
  apiBlockedLiveConfig.defaultDisclosureText = "";
  const apiBlockedLiveStore = createStore(path.join(tempDir, "api-blocked-live-store.json"));
  const apiBlockedLiveServer = await startServer(0, { store: apiBlockedLiveStore, config: apiBlockedLiveConfig });
  const apiBlockedLiveAddress = apiBlockedLiveServer.address();
  const apiBlockedLiveBase = `http://127.0.0.1:${apiBlockedLiveAddress.port}`;
  const apiBlockedReadiness = await fetch(`${apiBlockedLiveBase}/api/readiness`);
  const apiBlockedReadinessPayload = await apiBlockedReadiness.json();
  assert.equal(apiBlockedReadiness.status, 200);
  assert.equal(apiBlockedReadinessPayload.liveGate.allowed, false);
  assert.equal(apiBlockedReadinessPayload.liveGate.enforced, true);
  assert.equal(apiBlockedReadinessPayload.liveGate.missingEnv.includes("THREADS_USER_ID"), true);

  const apiBlockedAutomation = await fetch(`${apiBlockedLiveBase}/api/automation/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({ source: "blocked-live-api", ignoreReadiness: true })
  });
  const apiBlockedAutomationPayload = await apiBlockedAutomation.json();
  assert.equal(apiBlockedAutomation.status, 409);
  assert.equal(apiBlockedAutomationPayload.run.status, "blocked");
  assert.equal(apiBlockedAutomationPayload.run.readinessGate.allowed, false);

  const apiBlockedCycle = await fetch(`${apiBlockedLiveBase}/api/autonomy/cycle`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({ source: "blocked-live-cycle", force: true, publishQueue: true })
  });
  const apiBlockedCyclePayload = await apiBlockedCycle.json();
  assert.equal(apiBlockedCycle.status, 409);
  assert.equal(apiBlockedCyclePayload.cycle.status, "blocked");
  assert.equal(apiBlockedCyclePayload.cycle.readinessGate.allowed, false);

  const apiBlockedPublishNow = await fetch(`${apiBlockedLiveBase}/api/posts/post_seed_2/publish-now`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({})
  });
  const apiBlockedPublishNowPayload = await apiBlockedPublishNow.json();
  assert.equal(apiBlockedPublishNow.status, 409);
  assert.equal(apiBlockedPublishNowPayload.code, "READINESS_BLOCKED");
  assert.equal(apiBlockedPublishNowPayload.readinessGate.allowed, false);

  await new Promise((resolve, reject) => {
    apiBlockedLiveServer.close((error) => error ? reject(error) : resolve());
  });

  const roleConfig = getRuntimeConfig({
    PUBLIC_BASE_URL: "http://localhost:4173",
    THREADS_DRY_RUN: "true",
    ADMIN_TOKEN: "viewer-token",
    ADMIN_PASSWORD: "admin-secret",
    ADMIN_TOKEN_ROLE: "viewer",
    ADMIN_PASSWORD_ROLE: "admin",
    CONVERSION_WEBHOOK_SECRET: "conversion-secret"
  });
  const roleServerStore = createStore(path.join(tempDir, "role-server-store.json"));
  const roleServer = await startServer(0, { store: roleServerStore, config: roleConfig });
  const roleAddress = roleServer.address();
  const roleBase = `http://127.0.0.1:${roleAddress.port}`;
  const unauthDashboardPage = await fetch(`${roleBase}/`, { redirect: "manual" });
  assert.equal(unauthDashboardPage.status, 302);
  assert.equal(unauthDashboardPage.headers.get("location"), "/login");

  const loginPage = await fetch(`${roleBase}/login`);
  assert.equal(loginPage.status, 200);
  assert.equal((await loginPage.text()).includes("管理員登入"), true);

  const unauthMe = await fetch(`${roleBase}/api/me`);
  const unauthMePayload = await unauthMe.json();
  assert.equal(unauthMe.status, 200);
  assert.equal(unauthMePayload.authRequired, true);
  assert.equal(unauthMePayload.authenticated, false);

  const unauthDashboardApi = await fetch(`${roleBase}/api/dashboard`);
  assert.equal(unauthDashboardApi.status, 401);

  const publicReadiness = await fetch(`${roleBase}/api/readiness`);
  assert.equal(publicReadiness.status, 200);

  const publicRedirect = await fetch(`${roleBase}/r/ai-affiliate-prompt-pack`, { redirect: "manual" });
  assert.equal(publicRedirect.status, 302);

  const blockedConversion = await fetch(`${roleBase}/api/conversions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slug: "ai-affiliate-prompt-pack",
      networkEventId: "blocked-order-1",
      commissionValue: 8
    })
  });
  assert.equal(blockedConversion.status, 401);

  const allowedConversion = await fetch(`${roleBase}/api/conversions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-secret": "conversion-secret" },
    body: JSON.stringify({
      slug: "ai-affiliate-prompt-pack",
      networkEventId: "allowed-order-1",
      commissionValue: 8,
      orderValue: 49,
      status: "approved"
    })
  });
  assert.equal(allowedConversion.status, 201);

  const blockedExport = await fetch(`${roleBase}/api/export`);
  assert.equal(blockedExport.status, 401);

  const roleSession = await fetch(`${roleBase}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "viewer-token" })
  });
  const roleSessionPayload = await roleSession.json();
  assert.equal(roleSession.status, 200);
  assert.equal(roleSessionPayload.role, "viewer");
  const viewerCookie = String(roleSession.headers.get("set-cookie") || "").split(";")[0];
  assert.equal(Boolean(viewerCookie), true);

  const authedDashboardPage = await fetch(`${roleBase}/`, {
    headers: { cookie: viewerCookie }
  });
  assert.equal(authedDashboardPage.status, 200);

  const aliasLogin = await fetch(`${roleBase}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "admin-secret" })
  });
  const aliasLoginPayload = await aliasLogin.json();
  assert.equal(aliasLogin.status, 200);
  assert.equal(aliasLoginPayload.role, "admin");

  const adminMe = await fetch(`${roleBase}/api/me`, {
    headers: { authorization: "Bearer admin-secret" }
  });
  const adminMePayload = await adminMe.json();
  assert.equal(adminMe.status, 200);
  assert.equal(adminMePayload.authenticated, true);
  assert.equal(adminMePayload.role, "admin");

  const roleDashboard = await fetch(`${roleBase}/api/dashboard`, {
    headers: { "x-admin-token": "viewer-token" }
  });
  assert.equal(roleDashboard.status, 200);

  const roleViewerExport = await fetch(`${roleBase}/api/export`, {
    headers: { "x-admin-token": "viewer-token" }
  });
  assert.equal(roleViewerExport.status, 403);

  const roleAdminExport = await fetch(`${roleBase}/api/export`, {
    headers: { "x-admin-password": "admin-secret" }
  });
  assert.equal(roleAdminExport.status, 200);

  const roleUnauthRun = await fetch(`${roleBase}/api/automation/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "role-test" })
  });
  assert.equal(roleUnauthRun.status, 401);

  const roleBlockedRun = await fetch(`${roleBase}/api/automation/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": "viewer-token" },
    body: JSON.stringify({ source: "role-test" })
  });
  assert.equal(roleBlockedRun.status, 403);

  const roleAdminRun = await fetch(`${roleBase}/api/automation/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({ source: "role-test" })
  });
  assert.equal(roleAdminRun.status, 200);

  const unauthApprove = await fetch(`${roleBase}/api/posts/post_seed_1/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(unauthApprove.status, 401);

  const generatedReviewResponse = await fetch(`${roleBase}/api/automation/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({
      topic: "review workflow",
      campaignId: "cmp_ai_affiliate",
      productId: "prd_prompt_pack",
      autoApprove: true
    })
  });
  const generatedReviewPayload = await generatedReviewResponse.json();
  assert.equal(generatedReviewResponse.status, 201);
  assert.equal(generatedReviewPayload.created[0].status, "needs_review");
  assert.equal(generatedReviewPayload.created[0].approved, false);
  assert.equal(generatedReviewPayload.created[0].review.autoApproveIgnored, true);

  const unapprovedSchedule = await fetch(`${roleBase}/api/posts/${generatedReviewPayload.created[0].id}/schedule`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({})
  });
  assert.equal(unapprovedSchedule.status, 409);

  const approvedReview = await fetch(`${roleBase}/api/posts/${generatedReviewPayload.created[0].id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({})
  });
  const approvedReviewPayload = await approvedReview.json();
  assert.equal(approvedReview.status, 200);
  assert.equal(approvedReviewPayload.post.status, "approved");

  const unscheduledPublish = await fetch(`${roleBase}/api/posts/${generatedReviewPayload.created[0].id}/publish-now`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({})
  });
  const unscheduledPublishPayload = await unscheduledPublish.json();
  assert.equal(unscheduledPublish.status, 409);
  assert.equal(unscheduledPublishPayload.code, "POST_REVIEW_BLOCKED");

  const scheduledReview = await fetch(`${roleBase}/api/posts/${generatedReviewPayload.created[0].id}/schedule`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({ scheduledAt: new Date(Date.now() - 1000).toISOString() })
  });
  const scheduledReviewPayload = await scheduledReview.json();
  assert.equal(scheduledReview.status, 200);
  assert.equal(scheduledReviewPayload.post.status, "scheduled");

  const simulatedPublish = await fetch(`${roleBase}/api/posts/${generatedReviewPayload.created[0].id}/publish-now`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({})
  });
  const simulatedPublishPayload = await simulatedPublish.json();
  assert.equal(simulatedPublish.status, 200);
  assert.equal(simulatedPublishPayload.run.simulated >= 1, true);

  const editedReview = await fetch(`${roleBase}/api/posts/${generatedReviewPayload.created[1].id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({ text: `${roleConfig.defaultDisclosureText}：Edited safe review copy https://example.com/review\n\nWhich workflow would you test first?` })
  });
  const editedReviewPayload = await editedReview.json();
  assert.equal(editedReview.status, 200);
  assert.equal(editedReviewPayload.post.status, "needs_review");
  assert.equal(editedReviewPayload.validation.valid, true);

  const rejectedReview = await fetch(`${roleBase}/api/posts/${generatedReviewPayload.created[1].id}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({ reason: "Not suitable for campaign." })
  });
  const rejectedReviewPayload = await rejectedReview.json();
  assert.equal(rejectedReview.status, 200);
  assert.equal(rejectedReviewPayload.post.status, "rejected");

  const rejectedSchedule = await fetch(`${roleBase}/api/posts/${generatedReviewPayload.created[1].id}/schedule`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({})
  });
  assert.equal(rejectedSchedule.status, 409);

  const viewerReject = await fetch(`${roleBase}/api/posts/${generatedReviewPayload.created[2].id}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": "viewer-token" },
    body: JSON.stringify({})
  });
  assert.equal(viewerReject.status, 403);

  const highRiskCreate = await fetch(`${roleBase}/api/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({
      campaignId: "cmp_ai_affiliate",
      productId: "prd_prompt_pack",
      topicTag: "review",
      text: `${roleConfig.defaultDisclosureText}：Guaranteed profit $1000 every day with this affiliate tool https://example.com/risk?`
    })
  });
  const highRiskCreatePayload = await highRiskCreate.json();
  assert.equal(highRiskCreate.status, 201);
  assert.equal(highRiskCreatePayload.validation.risk.level, "high");
  const highRiskApprove = await fetch(`${roleBase}/api/posts/${highRiskCreatePayload.post.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({})
  });
  const highRiskApprovePayload = await highRiskApprove.json();
  assert.equal(highRiskApprove.status, 409);
  assert.equal(highRiskApprovePayload.code, "HIGH_RISK_REVIEW_REQUIRED");

  const fatigueProductCreate = await fetch(`${roleBase}/api/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({
      campaignId: "cmp_threads_ops",
      productId: "prd_n8n_course",
      topicTag: "review",
      hook: "Different product fatigue hook",
      text: `${roleConfig.defaultDisclosureText}：Different safe body for same product fatigue https://example.com/product-fatigue?`
    })
  });
  const fatigueProductPayload = await fatigueProductCreate.json();
  assert.equal(fatigueProductCreate.status, 201);
  assert.equal(fatigueProductPayload.post.fatigueStatus, "blocked");
  assert.equal(fatigueProductPayload.post.fatigueReasons.some((reason) => reason.id === "same_product_frequency"), true);

  const fatigueApprove = await fetch(`${roleBase}/api/posts/${fatigueProductPayload.post.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({})
  });
  const fatigueApprovePayload = await fatigueApprove.json();
  assert.equal(fatigueApprove.status, 409);
  assert.equal(fatigueApprovePayload.code, "CONTENT_FATIGUE_BLOCKED");
  assert.equal(fatigueApprovePayload.fatigue.status, "blocked");

  roleServerStore.update((state) => {
    state.posts.unshift({
      id: "post_fatigue_approved",
      accountId: "acct_primary",
      campaignId: "cmp_threads_ops",
      productId: "prd_n8n_course",
      affiliateLinkId: "aff_n8n_course",
      contentType: "manual",
      funnelRatio: "manual",
      hook: "Approved fatigue schedule",
      cta: "https://example.com/schedule-fatigue",
      riskNote: "low",
      topicTag: "review",
      text: `${roleConfig.defaultDisclosureText}：Approved but product fatigued https://example.com/schedule-fatigue?`,
      status: "approved",
      approved: true,
      scheduledAt: new Date().toISOString(),
      linkAttachment: "https://example.com/schedule-fatigue",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  });
  const fatigueSchedule = await fetch(`${roleBase}/api/posts/post_fatigue_approved/schedule`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({})
  });
  const fatigueSchedulePayload = await fatigueSchedule.json();
  assert.equal(fatigueSchedule.status, 409);
  assert.equal(fatigueSchedulePayload.code, "CONTENT_FATIGUE_BLOCKED");

  roleServerStore.update((state) => {
    state.products.push({
      id: "prd_hook_tool",
      campaignId: "cmp_ai_affiliate",
      name: "Hook Tool",
      offer: "Hook testing utility",
      network: "internal",
      commissionModel: "CPS",
      commissionValue: 10,
      currency: "USD",
      landingUrl: "https://example.com/hook-tool",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    state.posts.unshift({
      id: "post_hook_history",
      accountId: "acct_primary",
      campaignId: "cmp_ai_affiliate",
      productId: "prd_hook_tool",
      affiliateLinkId: "aff_prompt_pack",
      contentType: "manual",
      funnelRatio: "manual",
      hook: "Repeat review hook",
      cta: "",
      riskNote: "low",
      topicTag: "review",
      text: `${roleConfig.defaultDisclosureText}：Existing review hook body https://example.com/hook-history?`,
      status: "needs_review",
      approved: false,
      scheduledAt: new Date().toISOString(),
      linkAttachment: "https://example.com/hook-history",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  });
  const fatigueHookCreate = await fetch(`${roleBase}/api/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({
      campaignId: "cmp_ai_affiliate",
      productId: "prd_hook_tool",
      topicTag: "review",
      hook: "Repeat review hook",
      text: `${roleConfig.defaultDisclosureText}：A different post body but repeated hook https://example.com/hook-repeat?`
    })
  });
  const fatigueHookPayload = await fatigueHookCreate.json();
  assert.equal(fatigueHookCreate.status, 201);
  assert.equal(fatigueHookPayload.post.fatigueStatus, "blocked");
  assert.equal(fatigueHookPayload.post.fatigueReasons.some((reason) => reason.id === "same_hook"), true);

  const fatigueEdit = await fetch(`${roleBase}/api/posts/${fatigueHookPayload.post.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({
      hook: "Unique rewritten hook",
      text: `${roleConfig.defaultDisclosureText}：A rewritten body with a unique review hook https://example.com/hook-rewrite?`
    })
  });
  const fatigueEditPayload = await fatigueEdit.json();
  assert.equal(fatigueEdit.status, 200);
  assert.notEqual(fatigueEditPayload.post.fatigueStatus, "blocked");
  const fatigueEditedApprove = await fetch(`${roleBase}/api/posts/${fatigueHookPayload.post.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({})
  });
  assert.equal(fatigueEditedApprove.status, 200);

  await new Promise((resolve, reject) => {
    roleServer.close((error) => error ? reject(error) : resolve());
  });

  const automationFatigueStore = createStore(path.join(tempDir, "automation-fatigue-store.json"));
  automationFatigueStore.update((state) => {
    state.posts = [
      {
        id: "hist_product_published",
        accountId: "acct_primary",
        campaignId: "cmp_ai_affiliate",
        productId: "prd_prompt_pack",
        affiliateLinkId: "aff_prompt_pack",
        contentType: "manual",
        funnelRatio: "manual",
        hook: "History product",
        cta: "https://example.com/history",
        riskNote: "low",
        topicTag: "review",
        text: `${config.defaultDisclosureText}：History product post https://example.com/history?`,
        status: "published",
        approved: true,
        scheduledAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        publishedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        linkAttachment: "https://example.com/history",
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
      },
      {
        id: "post_fatigue_due",
        accountId: "acct_primary",
        campaignId: "cmp_ai_affiliate",
        productId: "prd_prompt_pack",
        affiliateLinkId: "aff_prompt_pack",
        contentType: "manual",
        funnelRatio: "manual",
        hook: "Due product fatigue",
        cta: "https://example.com/due",
        riskNote: "low",
        topicTag: "review",
        text: `${config.defaultDisclosureText}：Due product fatigue post https://example.com/due?`,
        status: "scheduled",
        approved: true,
        scheduledAt: new Date(Date.now() - 1000).toISOString(),
        linkAttachment: "https://example.com/due",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];
  });
  const automationFatigueRun = await runAutomation(automationFatigueStore, config, { source: "fatigue-skip-test" });
  assert.equal(automationFatigueRun.run.status, "completed_with_errors");
  assert.equal(automationFatigueRun.run.simulated, 0);
  assert.equal(automationFatigueRun.run.failed, 1);
  assert.equal(automationFatigueStore.read().posts.find((post) => post.id === "post_fatigue_due").status, "failed");
  assert.equal(automationFatigueRun.run.messages.some((message) => message.includes("Same product")), true);

  const liveDisclosureConfig = getRuntimeConfig({
    PUBLIC_BASE_URL: "https://threads-affiliate.example",
    THREADS_DRY_RUN: "false",
    THREADS_USER_ID: "threads-user",
    THREADS_ACCESS_TOKEN: "threads-token",
    ADMIN_PASSWORD: "admin-secret",
    ENABLE_WORKER: "true",
    AUTONOMY_MODE: "true",
    DATABASE_URL: "postgresql://user:pass@db.example:5432/app?sslmode=require",
    CONVERSION_WEBHOOK_SECRET: "secret",
    DEFAULT_DISCLOSURE_TEXT: "含聯盟連結"
  });
  const liveDisclosureStore = createStore(path.join(tempDir, "live-disclosure-store.json"));
  liveDisclosureStore.update((state) => {
    state.posts = [{
      id: "post_missing_disclosure",
      accountId: "acct_primary",
      campaignId: "cmp_ai_affiliate",
      productId: "prd_prompt_pack",
      affiliateLinkId: "aff_prompt_pack",
      contentType: "manual",
      funnelRatio: "conversion",
      hook: "Missing disclosure",
      cta: "https://example.com/review",
      riskNote: "low",
      topicTag: "review",
      text: "This affiliate tool can help organize your workflow https://example.com/review?",
      status: "scheduled",
      approved: true,
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      linkAttachment: "https://example.com/review",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }];
  });
  const liveDisclosureServer = await startServer(0, { store: liveDisclosureStore, config: liveDisclosureConfig, startWorker: false });
  const liveDisclosureAddress = liveDisclosureServer.address();
  const liveDisclosureBase = `http://127.0.0.1:${liveDisclosureAddress.port}`;
  const missingDisclosurePublish = await fetch(`${liveDisclosureBase}/api/posts/post_missing_disclosure/publish-now`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": "admin-secret" },
    body: JSON.stringify({})
  });
  const missingDisclosurePublishPayload = await missingDisclosurePublish.json();
  assert.equal(missingDisclosurePublish.status, 409);
  assert.equal(missingDisclosurePublishPayload.code, "MISSING_DISCLOSURE");

  const missingDisclosureRun = await runAutomation(liveDisclosureStore, liveDisclosureConfig, { source: "missing-disclosure-test" });
  assert.equal(missingDisclosureRun.run.status, "completed_with_errors");
  assert.equal(missingDisclosureRun.run.failed, 1);
  assert.equal(liveDisclosureStore.read().posts.find((post) => post.id === "post_missing_disclosure").status, "failed");

  await new Promise((resolve, reject) => {
    liveDisclosureServer.close((error) => error ? reject(error) : resolve());
  });

  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

  const blockedWorkerStore = createStore(path.join(tempDir, "blocked-worker-store.json"));
  const blockedWorkerConfig = getRuntimeConfig({
    PUBLIC_BASE_URL: "https://threads-affiliate.example",
    THREADS_DRY_RUN: "false",
    ENABLE_WORKER: "true",
    AUTONOMY_MODE: "false",
    ADMIN_PASSWORD: "admin-secret"
  });
  blockedWorkerConfig.defaultDisclosureText = "";
  await configureRuntime({ store: blockedWorkerStore, config: blockedWorkerConfig });
  const blockedWorkerTick = await runWorkerTick("blocked-live-worker");
  assert.equal(blockedWorkerTick.status, "blocked");
  assert.equal(blockedWorkerTick.result.cycle.status, "blocked");
  assert.equal(blockedWorkerTick.result.cycle.readinessGate.allowed, false);
  assert.equal(blockedWorkerTick.dashboard.workerLease.status, "blocked");

  const workerStore = createStore(path.join(tempDir, "worker-store.json"));
  const workerConfig = getRuntimeConfig({
    PUBLIC_BASE_URL: "http://localhost:4173",
    THREADS_DRY_RUN: "true",
    ENABLE_WORKER: "true",
    AUTONOMY_MODE: "true",
    WORKER_LEASE_MS: "120000"
  });
  await configureRuntime({ store: workerStore, config: workerConfig });
  const future = new Date(Date.now() + 120_000).toISOString();
  workerStore.update((state) => {
    state.runtime = state.runtime || {};
    state.runtime.workerLease = {
      ownerId: "other-worker",
      source: "test",
      status: "running",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      expiresAt: future
    };
    return {};
  });
  const skippedTick = await runWorkerTick("test-worker");
  assert.equal(skippedTick.status, "skipped_lease");
  assert.equal(skippedTick.lease.ownerId, "other-worker");
  workerStore.update((state) => {
    state.runtime.workerLease.expiresAt = new Date(Date.now() - 1000).toISOString();
    return {};
  });
  const workerTick = await runWorkerTick("test-worker");
  assert.equal(workerTick.status, "completed");
  assert.equal(workerTick.dashboard.workerLease.active, true);
  assert.equal(workerTick.dashboard.workerLease.status, "completed");
  assert.equal(workerTick.dashboard.recentEvents.some((event) => event.type === "worker.heartbeat"), true);

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("All tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

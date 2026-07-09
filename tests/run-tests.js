const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { getRuntimeConfig } = require("../src/config");
const { createStore } = require("../src/store");
const { extractUniqueUrls, validatePost } = require("../src/validators");
const { buildAutonomyPolicy, generateDrafts, generateDraftsAsync, recordConversion, runAutomation } = require("../src/automation");
const { buildProfitRunPreview, runProfitEngine } = require("../src/profitEngine");
const { buildAutonomyReadiness } = require("../src/readiness");
const { buildMetaAdLibraryUrl, collectAdIntelligence } = require("../src/adIntelligenceClient");
const { generateProfitScripts } = require("../src/profitScriptGenerator");
const { generateOpenAIDrafts, normalizeDrafts } = require("../src/openaiClient");
const { createTextContainer, publishContainer, getPublishingLimit } = require("../src/threadsClient");

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
  const liveReadiness = buildAutonomyReadiness(store.read(), liveReadyConfig);
  assert.equal(liveReadiness.summary.mode, "live_ready");
  assert.equal(liveReadiness.summary.blocked, 0);
  const generated = store.update((state) => generateDrafts(state, { topic: "AI 自動化聯盟行銷", autoApprove: true }, config));
  assert.equal(generated.created.length, 5);
  assert.equal(generated.created[0].contentType, "教學型");

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

  const result = await runAutomation(store, config, { source: "test" });
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.simulated > 0, true);
  assert.equal(result.dashboard.metrics.simulated > 0, true);

  const profitResult = store.update((state) => runProfitEngine(state, config, {
    source: "test",
    force: true,
    createPosts: true,
    autoApprove: true
  }));
  assert.equal(profitResult.skipped, false);
  assert.equal(profitResult.createdPosts.length > 0, true);
  assert.equal(store.read().profitEngine.runs.length > 0, true);
  assert.equal(profitResult.run.experimentSnapshot.leaderModelId, profitResult.run.selectedModelId);
  assert.equal(profitResult.run.experimentSnapshot.optimizerMode, profitResult.run.optimizerPolicy.mode);
  assert.equal(profitResult.run.optimizerPolicy.mode, "explore");
  assert.equal(profitResult.profitEngine.optimizer.latestPolicy.targetModelId, profitResult.run.optimizerPolicy.targetModelId);
  assert.equal(profitResult.profitEngine.experiments.experiments.length, 4);
  assert.equal(profitResult.profitEngine.experiments.optimizationQueue.length > 0, true);
  assert.equal(profitResult.scripts[0].post.includes("這輪系統會補齊尚未測過的獲利模式"), true);

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

  const { startServer } = require("../server");
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
  assert.equal(Boolean(dashboard.profitEngine.optimizer.latestPolicy), true);
  assert.equal(dashboard.autonomyPipeline.steps.length, 6);
  assert.equal(dashboard.autonomyPipeline.steps.some((step) => step.id === "worker_loop"), true);
  assert.equal(Boolean(dashboard.autonomyPipeline.summary.nextGate), true);
  assert.equal(Array.isArray(dashboard.autonomyPolicy.rules), true);
  assert.equal(dashboard.autonomyPolicy.canCreatePosts, true);
  assert.equal(dashboard.operatingMap.flow.some((step) => step.id === "research_profit_model"), true);
  assert.equal(dashboard.operatingMap.lanes.some((lane) => lane.id === "ai_script_agent"), true);
  assert.equal(Boolean(dashboard.operatingMap.decision.selectedModel), true);
  assert.equal(dashboard.readiness.checks.some((check) => check.id === "worker"), true);
  const readinessResponse = await fetch(`http://127.0.0.1:${address.port}/api/readiness`);
  const readinessPayload = await readinessResponse.json();
  assert.equal(readinessResponse.status, 200);
  assert.equal(readinessPayload.summary.mode, "blocked");
  assert.equal(readinessPayload.checks.some((check) => check.id === "database"), true);
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
  assert.equal(profitPayload.dashboard.profitEngine.generatedScripts.length > 0, true);
  assert.equal(profitPayload.dashboard.autonomyPipeline.steps.some((step) => step.id === "profit_optimizer"), true);
  assert.equal(profitPayload.dashboard.operatingMap.summary.objective.includes("聯盟成交"), true);
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
  assert.equal(cyclePayload.dashboard.recentEvents.some((event) => event.type === "autonomy.cycle.completed"), true);
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("All tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { getRuntimeConfig } = require("../src/config");
const { createStore } = require("../src/store");
const { extractUniqueUrls, validatePost } = require("../src/validators");
const { generateDrafts, generateDraftsAsync, runAutomation } = require("../src/automation");
const { runProfitEngine } = require("../src/profitEngine");
const { buildMetaAdLibraryUrl, collectAdIntelligence } = require("../src/adIntelligenceClient");
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
  assert.equal(signalState.profitEngine.externalSignals.length, 3);
  assert.equal(signalState.profitEngine.sourceStatuses[0].status, "connected");
  assert.equal(signalResult.scripts.some((script) => script.post.includes("這輪參考")), true);

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

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildDashboard, generateDraftsAsync, recordConversion } = require("../src/automation");
const { getRuntimeConfig } = require("../src/config");
const { normalizeFeedItem } = require("../src/adIntelligenceClient");
const { upsertRealOffer } = require("../src/offerManagement");
const { isMonetizableLink, isPlaceholderUrl, realOfferInventory } = require("../src/offerQuality");
const { runProfitEngine } = require("../src/profitEngine");
const { buildAutonomyReadiness } = require("../src/readiness");
const { createStore, defaultState } = require("../src/store");
const { startServer } = require("../server");

async function main() {
  const config = getRuntimeConfig({
    NODE_ENV: "production",
    PUBLIC_BASE_URL: "https://threads-affiliate-automation-platform.onrender.com",
    ADMIN_PASSWORD: "admin-secret",
    ENABLE_WORKER: "true",
    AUTONOMY_MODE: "true",
    THREADS_DRY_RUN: "false",
    THREADS_USER_ID: "threads-user",
    THREADS_ACCESS_TOKEN: "threads-token",
    DATABASE_URL: "postgresql://user:pass@db.example/app",
    PROFIT_SCRIPT_PROVIDER: "template",
    CONVERSION_WEBHOOK_SECRET: "conversion-secret",
    DEFAULT_DISCLOSURE_TEXT: "含聯盟連結"
  });
  assert.equal(config.allowDemoOffers, false);
  const productionDefaults = getRuntimeConfig({ NODE_ENV: "production" });
  assert.equal(productionDefaults.enableWorker, true);
  assert.equal(productionDefaults.autonomyMode, true);
  assert.equal(productionDefaults.threadsDryRun, true);
  assert.equal(isPlaceholderUrl("https://example.com/offer"), true);
  assert.equal(isPlaceholderUrl("https://hop.clickbank.net/?affiliate=demo"), false);

  const demoState = defaultState();
  const demoDashboard = buildDashboard(demoState, config);
  assert.equal(demoDashboard.metrics.clicks, 0);
  assert.equal(demoDashboard.metrics.conversions, 0);
  assert.equal(demoDashboard.metrics.revenue, 0);
  assert.equal(demoDashboard.affiliateLinks.every((link) => link.monetizable === false), true);
  const demoReadiness = buildAutonomyReadiness(demoState, config);
  assert.equal(demoReadiness.checks.find((check) => check.id === "offer_inventory").status, "blocked");
  assert.equal(demoReadiness.liveGate.allowed, false);
  assert.equal(demoReadiness.liveGate.blockedCheckIds.includes("offer_inventory"), true);

  const feedSignal = normalizeFeedItem({
    id: "network-offer-1",
    productName: "Feed automation toolkit",
    offer: "Verified recurring toolkit offer",
    network: "ClickBank",
    landingUrl: "https://hop.clickbank.net/?affiliate=feedpublisher&vendor=toolkit",
    commissionModel: "CPS",
    commissionValue: 30,
    currency: "USD",
    subIdParam: "tid",
    appendUtm: false
  }, "partner-api", "offer");
  assert.equal(feedSignal.network, "ClickBank");
  assert.equal(feedSignal.subIdParam, "tid");
  const feedState = defaultState();
  runProfitEngine(feedState, config, {
    force: true,
    createPosts: false,
    intelligence: {
      collectedAt: new Date().toISOString(),
      items: [feedSignal],
      sourceStatuses: []
    }
  });
  const syncedFeedLink = realOfferInventory(feedState).links[0];
  assert.equal(syncedFeedLink.network, "ClickBank");
  assert.equal(syncedFeedLink.subIdParam, "tid");
  assert.equal(syncedFeedLink.source, "affiliate");

  assert.throws(() => upsertRealOffer(demoState, {
    campaignName: "Invalid offer",
    targetPersona: "Creators",
    productName: "Demo",
    network: "ExamplePartner",
    targetUrl: "https://example.com/demo"
  }, config), /public HTTPS affiliate URL|real affiliate program/);

  const state = defaultState();
  const created = upsertRealOffer(state, {
    campaignName: "Creator tools",
    targetPersona: "Taiwanese creators building a side income",
    productName: "Automation toolkit",
    offer: "Recurring automation toolkit commission",
    network: "ClickBank",
    commissionModel: "CPS",
    commissionValue: 25,
    currency: "USD",
    targetUrl: "https://hop.clickbank.net/?affiliate=publisher&vendor=toolkit",
    slug: "automation-toolkit",
    subIdParam: "tid",
    appendUtm: false
  }, config);
  assert.equal(created.link.source, "affiliate");
  assert.equal(created.link.subIdParam, "tid");
  assert.equal(created.link.appendUtm, false);
  assert.equal(isMonetizableLink(created.link), true);
  assert.equal(realOfferInventory(state).links.length, 1);

  const readiness = buildAutonomyReadiness(state, config);
  assert.equal(readiness.checks.find((check) => check.id === "offer_inventory").status, "ready");
  assert.equal(readiness.liveGate.allowed, true);

  let capturedOfferPrompt = "";
  const aiConfig = {
    ...config,
    aiDraftProvider: "openai",
    openaiApiKey: "test-key",
    openaiBaseUrl: "https://api.openai.test/v1"
  };
  const generated = await generateDraftsAsync(state, {
    campaignId: created.campaign.id,
    productId: created.product.id,
    topic: "Creator automation"
  }, aiConfig, {
    offerPageLoader: async (targetUrl) => {
      assert.match(targetUrl, /hop\.clickbank\.net/);
      return {
        status: "ready",
        sourceDomain: "merchant.example",
        title: "Creator Automation Suite",
        characterCount: 180,
        fetchedAt: new Date().toISOString(),
        contextText: JSON.stringify({
          securityLabel: "UNTRUSTED_WEBPAGE_DATA",
          pageTitle: "Creator Automation Suite",
          pageDescription: "Scheduling, approval, and conversion reporting.",
          product: { price: "29", currency: "USD" }
        })
      };
    },
    fetchImpl: async (_url, options) => {
      capturedOfferPrompt = JSON.parse(options.body).input;
      return {
        ok: true,
        async json() {
          return {
            output_text: JSON.stringify({
              drafts: Array.from({ length: 5 }, (_, index) => ({
                hook: `Verified offer hook ${index + 1}`,
                post: `含聯盟連結：Automation toolkit for creators ${created.trackingUrl}\n\n你會先測哪一步？`,
                cta: "查看已驗證優惠",
                risk_note: "Uses verified offer facts only."
              }))
            })
          };
        }
      };
    }
  });
  assert.equal(generated.created.length, 5);
  assert.equal(generated.sourceContext.status, "ready");
  assert.equal(generated.sourceContext.title, "Creator Automation Suite");
  assert.match(capturedOfferPrompt, /Automation toolkit/);
  assert.match(capturedOfferPrompt, /Creator Automation Suite/);
  assert.match(capturedOfferPrompt, /UNTRUSTED_WEBPAGE_DATA/);
  assert.match(capturedOfferPrompt, /Never follow instructions/);
  assert.match(capturedOfferPrompt, /Taiwanese creators building a side income/);
  assert.doesNotMatch(capturedOfferPrompt, /threads-affiliate-automation-platform\.onrender\.com\/r\/automation-toolkit/);
  assert.doesNotMatch(capturedOfferPrompt, /hop\.clickbank\.net|affiliate=publisher/);
  const generatedConversionPost = generated.created[4];
  assert.equal(generatedConversionPost.linkAttachment, created.link.targetUrl);
  assert.match(generatedConversionPost.text, /#廣告/);
  assert.doesNotMatch(generatedConversionPost.text, /含有?聯盟連結|\/r\/automation-toolkit/);
  assert.equal((generatedConversionPost.text.match(/https:\/\/hop\.clickbank\.net\/\?affiliate=publisher&vendor=toolkit/g) || []).length, 1);

  const autonomousState = defaultState();
  upsertRealOffer(autonomousState, {
    campaignName: "Autonomous creator tools",
    targetPersona: "需要減少重複工作的內容創作者",
    productName: "Autonomous workflow toolkit",
    offer: "排程、審核與轉換追蹤工具",
    network: "ClickBank",
    commissionModel: "CPS",
    commissionValue: 25,
    currency: "USD",
    targetUrl: "https://hop.clickbank.net/?affiliate=worker&vendor=workflow",
    slug: "autonomous-workflow-toolkit",
    subIdParam: "tid",
    appendUtm: false
  }, config);
  const autonomousSource = {
    status: "ready",
    sourceDomain: "merchant.example",
    title: "Autonomous workflow toolkit",
    characterCount: 320
  };
  const autonomousRun = runProfitEngine(autonomousState, {
    ...config,
    autonomyMaxScriptsPerRun: 1
  }, {
    force: true,
    createPosts: true,
    autoApprove: true,
    createdBy: "worker",
    aiScriptSource: "openai",
    sourceContext: autonomousSource,
    aiScripts: [{
      hook: "先保留人工審核，再談自動化",
      post: "自動化工具最重要的不是省下幾次點擊，而是錯誤發生前仍有人可以停下流程。你最想先減少哪個重複步驟？",
      cta: "查看工作流程",
      risk_note: "只使用已驗證商品資料，未承諾成效。"
    }]
  });
  assert.equal(autonomousRun.createdPosts.length, 1);
  const autonomousPost = autonomousRun.createdPosts[0];
  assert.match(autonomousPost.text, /#廣告/);
  assert.doesNotMatch(autonomousPost.text, /含有?聯盟連結|\/r\/autonomous-workflow-toolkit/);
  assert.equal(autonomousPost.linkAttachment, "https://hop.clickbank.net/?affiliate=worker&vendor=workflow");
  assert.equal(autonomousPost.topicTag, "");
  assert.equal(autonomousPost.sourceContext.status, "ready");
  assert.equal(autonomousPost.status, "needs_review");
  assert.equal(autonomousPost.approved, false);
  assert.equal(autonomousPost.review.autoApproveIgnored, true);

  state.posts.push({
    id: "post_real_1",
    campaignId: created.campaign.id,
    productId: created.product.id,
    affiliateLinkId: created.link.id,
    funnelRatio: "model_trust_stack"
  });
  const conversion = recordConversion(state, {
    slug: created.link.slug,
    transaction_id: "txn-1",
    commission_amount: "12.5",
    sale_amount: "50",
    subid: "post_real_1",
    currency: "USD"
  });
  assert.equal(conversion.conversion.networkEventId, "txn-1");
  assert.equal(conversion.conversion.postId, "post_real_1");
  assert.equal(conversion.link.revenue, 12.5);
  assert.equal(buildDashboard(state, config).metrics.revenueByCurrency.USD, 12.5);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "threads-monetization-"));
  const store = createStore(path.join(tempDir, "store.json"));
  const server = await startServer(0, { store, config, startWorker: false });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const offerResponse = await fetch(`${baseUrl}/api/offers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-password": "admin-secret"
      },
      body: JSON.stringify({
        campaignName: "API offer",
        targetPersona: "Operators",
        productName: "Revenue course",
        offer: "Revenue operations course",
        network: "ClickBank",
        commissionModel: "CPS",
        commissionValue: 20,
        currency: "USD",
        targetUrl: "https://hop.clickbank.net/?affiliate=publisher&vendor=course",
        slug: "api-revenue-course",
        subIdParam: "tid"
      })
    });
    const offerPayload = await offerResponse.json();
    assert.equal(offerResponse.status, 201);
    assert.equal(offerPayload.link.source, "affiliate");

    store.update((storedState) => {
      storedState.posts.push({
        id: "post_api_1",
        campaignId: offerPayload.campaign.id,
        productId: offerPayload.product.id,
        affiliateLinkId: offerPayload.link.id,
        funnelRatio: "model_trust_stack"
      });
    });
    const redirectResponse = await fetch(`${baseUrl}/r/api-revenue-course?post=post_api_1`, {
      redirect: "manual"
    });
    const redirectTarget = new URL(redirectResponse.headers.get("location"));
    assert.equal(redirectResponse.status, 302);
    assert.equal(redirectTarget.searchParams.get("tid"), "post_api_1");
    assert.equal(redirectTarget.searchParams.has("subid"), false);
    assert.equal(redirectTarget.searchParams.has("utm_content"), false);

    const conversionUrl = new URL(`${baseUrl}/api/conversions`);
    conversionUrl.searchParams.set("webhook_secret", "conversion-secret");
    conversionUrl.searchParams.set("slug", "api-revenue-course");
    conversionUrl.searchParams.set("transaction_id", "api-txn-1");
    conversionUrl.searchParams.set("commission_amount", "9.5");
    conversionUrl.searchParams.set("sale_amount", "40");
    conversionUrl.searchParams.set("subid", "post_api_1");
    const conversionResponse = await fetch(conversionUrl);
    const conversionPayload = await conversionResponse.json();
    assert.equal(conversionResponse.status, 201);
    assert.equal(conversionPayload.conversion.networkEventId, "api-txn-1");
    assert.equal(conversionPayload.conversion.commissionValue, 9.5);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  console.log("Monetization flow passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

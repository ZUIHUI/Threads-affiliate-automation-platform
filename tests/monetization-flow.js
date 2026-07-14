const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildDashboard, recordConversion } = require("../src/automation");
const { getRuntimeConfig } = require("../src/config");
const { upsertRealOffer } = require("../src/offerManagement");
const { isMonetizableLink, isPlaceholderUrl, realOfferInventory } = require("../src/offerQuality");
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

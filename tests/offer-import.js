const assert = require("node:assert/strict");

const { getRuntimeConfig } = require("../src/config");
const { importOffers, parseCsv, parseOfferImport } = require("../src/offerImport");
const { realOfferInventory } = require("../src/offerQuality");
const { defaultState } = require("../src/store");

function main() {
  const config = getRuntimeConfig({
    NODE_ENV: "production",
    PUBLIC_BASE_URL: "https://threads-affiliate-automation-platform.onrender.com",
    DEFAULT_DISCLOSURE_TEXT: "含聯盟連結"
  });
  const csv = [
    "campaignName,targetPersona,productName,offer,network,commissionModel,commissionValue,currency,targetUrl,slug,subIdParam,appendUtm",
    "Creator tools,Taiwan creators,Automation toolkit,\"Automation, recurring offer\",ClickBank,CPS,25,USD,https://hop.clickbank.net/?affiliate=publisher&vendor=toolkit,automation-toolkit,tid,false",
    "Invalid campaign,Test audience,Invalid product,Invalid offer,ExamplePartner,CPS,10,USD,https://example.com/product,invalid-product,subid,false"
  ].join("\r\n");

  const parsedCsv = parseCsv(csv);
  assert.equal(parsedCsv.length, 2);
  assert.equal(parsedCsv[0].data.offer, "Automation, recurring offer");

  const state = defaultState();
  const beforePreview = JSON.stringify(state);
  const preview = importOffers(state, {
    fileName: "offers.csv",
    format: "csv",
    content: csv
  }, config, { dryRun: true });
  assert.equal(preview.summary.total, 2);
  assert.equal(preview.summary.valid, 1);
  assert.equal(preview.summary.failed, 1);
  assert.equal(preview.summary.imported, 0);
  assert.equal(preview.rows[0].status, "ready_create");
  assert.match(preview.rows[1].error, /public HTTPS affiliate URL|real affiliate program/);
  assert.equal(JSON.stringify(state), beforePreview, "Preview must not mutate persisted state.");

  const imported = importOffers(state, {
    fileName: "offers.csv",
    format: "csv",
    content: csv
  }, config);
  assert.equal(imported.summary.imported, 1);
  assert.equal(imported.summary.created, 1);
  assert.equal(imported.summary.failed, 1);
  assert.equal(realOfferInventory(state).links.length, 1);
  assert.equal(state.events[0].type, "offer.batch_imported");

  const repeated = importOffers(state, {
    fileName: "offers.csv",
    format: "csv",
    content: csv
  }, config);
  assert.equal(repeated.summary.imported, 1);
  assert.equal(repeated.summary.created, 0);
  assert.equal(repeated.summary.updated, 1);
  assert.equal(realOfferInventory(state).links.length, 1, "Repeated imports must update instead of duplicate.");

  const jsonRows = parseOfferImport({
    fileName: "offers.json",
    content: JSON.stringify({
      offers: [{
        campaign_name: "Second campaign",
        target_persona: "Small business operators",
        product_name: "Revenue course",
        offer: "Affiliate revenue operations course",
        network: "Impact",
        commission_model: "CPA",
        commission_value: 15,
        currency: "USD",
        affiliate_url: "https://impact.example-shop.com/tracking?publisher=123",
        tracking_slug: "revenue-course",
        sub_id_param: "subId1",
        append_utm: false
      }]
    })
  });
  assert.equal(jsonRows[0].data.campaignName, "Second campaign");
  assert.equal(jsonRows[0].data.subIdParam, "subId1");

  assert.throws(() => parseCsv('campaignName,targetUrl\n"broken,https://example.com'), /unterminated quoted field/);
  assert.throws(() => parseOfferImport({
    offers: Array.from({ length: 501 }, (_, index) => ({ productName: `Product ${index}` }))
  }), /limited to 500 rows/);

  console.log("Offer batch import passed.");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

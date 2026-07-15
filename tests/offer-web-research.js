const assert = require("node:assert/strict");

const { getRuntimeConfig } = require("../src/config");
const { buildPrompt } = require("../src/contentTemplates");
const { publicContextSummary } = require("../src/offerPageContext");
const {
  extractWebSources,
  researchOfferWithOpenAI,
  resolveOfferResearchContext
} = require("../src/offerWebResearch");

function researchPayload(exactProductMatch = true) {
  return {
    output_text: JSON.stringify({
      exact_product_match: exactProductMatch,
      title: "Magnetic USB-C motion sensor light",
      summary: "A slim rechargeable light for wardrobes and hallways.",
      facts: [
        { label: "Charging", value: "USB-C rechargeable" },
        { label: "Lighting", value: "Three color-temperature modes" },
        { label: "Mounting", value: "Magnetic removable body" }
      ],
      caveats: ["Runtime depends on usage and sensor frequency."]
    }),
    output: [{
      type: "web_search_call",
      action: {
        sources: [
          { title: "Merchant product listing", url: "https://merchant.example/products/sensor-light?tracking=secret" },
          { title: "Manufacturer specification", url: "https://brand.example/sensor-light#specification" },
          { title: "Duplicate merchant URL", url: "https://merchant.example/products/sensor-light?other=1" }
        ]
      }
    }]
  };
}

async function main() {
  const config = getRuntimeConfig({
    AI_DRAFT_PROVIDER: "openai",
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://api.openai.test/v1",
    OPENAI_MODEL: "gpt-5.2",
    AI_WEB_RESEARCH_ENABLED: "true",
    AI_WEB_RESEARCH_TIMEOUT_MS: "5000",
    AI_WEB_RESEARCH_MAX_SOURCES: "6",
    OFFER_PAGE_CONTEXT_ENABLED: "true"
  });
  const targetUrl = "https://affiliate.example/click?publisher=private-id";
  const offerContext = {
    campaignName: "Home lighting",
    productName: "Magnetic USB-C motion sensor light",
    offer: "Three color temperatures and a slim magnetic body",
    network: "Affiliate Network",
    currency: "TWD"
  };

  let capturedRequest;
  const researched = await researchOfferWithOpenAI({
    targetUrl,
    offerContext,
    config,
    fetchImpl: async (url, options) => {
      capturedRequest = { url, options, body: JSON.parse(options.body) };
      return { ok: true, async json() { return researchPayload(); } };
    }
  });

  assert.equal(capturedRequest.url, "https://api.openai.test/v1/responses");
  assert.equal(capturedRequest.body.tools[0].type, "web_search");
  assert.equal(capturedRequest.body.reasoning.effort, "low");
  assert.equal(capturedRequest.body.max_output_tokens, 1600);
  assert.equal(capturedRequest.body.tool_choice, "required");
  assert.deepEqual(capturedRequest.body.include, ["web_search_call.action.sources"]);
  assert.equal(capturedRequest.body.text.format.name, "affiliate_offer_research");
  assert.match(capturedRequest.body.input, /affiliate\.example\/click\?publisher=private-id/);
  assert.match(capturedRequest.body.input, /Magnetic USB-C motion sensor light/);
  assert.equal(researched.status, "ready");
  assert.equal(researched.researchMode, "openai_web_search");
  assert.equal(researched.sources.length, 2);
  assert.equal(researched.sources[0].url, "https://merchant.example/products/sensor-light");
  assert.doesNotMatch(researched.contextText, /publisher=private-id|tracking=secret/);
  assert.match(researched.contextText, /UNTRUSTED_WEB_RESEARCH_DATA/);
  assert.match(researched.contextText, /USB-C rechargeable/);

  const summary = publicContextSummary(researched);
  assert.equal(summary.researchMode, "openai_web_search");
  assert.equal(summary.sourceCount, 2);
  assert.equal(summary.sources[1].domain, "brand.example");
  const generationPrompt = buildPrompt("Small-space lighting", {
    ...offerContext,
    disclosureText: "Affiliate link",
    trackingUrl: "https://app.example/r/sensor-light",
    pageContext: researched.contextText
  });
  assert.match(generationPrompt, /UNTRUSTED_WEB_RESEARCH_DATA/);
  assert.match(generationPrompt, /Three color-temperature modes/);

  let fallbackCalls = 0;
  const resolved = await resolveOfferResearchContext(targetUrl, offerContext, config, {
    offerPageLoader: async () => { throw new Error("dynamic page has no readable HTML"); },
    fetchImpl: async () => {
      fallbackCalls += 1;
      return { ok: true, async json() { return researchPayload(); } };
    }
  });
  assert.equal(fallbackCalls, 1);
  assert.equal(resolved.status, "ready");
  assert.equal(resolved.researchMode, "openai_web_search");

  const directPage = await resolveOfferResearchContext(targetUrl, offerContext, config, {
    offerPageLoader: async () => ({
      status: "ready",
      sourceDomain: "merchant.example",
      title: offerContext.productName,
      contextText: "verified merchant page",
      characterCount: 22
    }),
    fetchImpl: async () => { throw new Error("web research should not run"); }
  });
  assert.equal(directPage.researchMode, "merchant_page");

  const unverified = await resolveOfferResearchContext(targetUrl, offerContext, config, {
    offerPageLoader: async () => { throw new Error("page blocked"); },
    fetchImpl: async () => ({ ok: true, async json() { return researchPayload(false); } })
  });
  assert.equal(unverified.status, "unavailable");
  assert.equal(unverified.researchMode, "stored_offer_fallback");
  assert.match(unverified.error, /exact product match/);

  const sources = extractWebSources(researchPayload(), 1);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].domain, "merchant.example");

  console.log("Offer web research passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

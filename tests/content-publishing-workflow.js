const assert = require("node:assert/strict");

const { buildDashboard, generateDraftsAsync, runAutomation } = require("../src/automation");
const { getRuntimeConfig } = require("../src/config");
const { upsertRealOffer } = require("../src/offerManagement");
const { approvePost, schedulePost, STATUS } = require("../src/postReview");
const { defaultState } = require("../src/store");
const { generateOpenAIDrafts } = require("../src/openaiClient");
const { buildPrompt } = require("../src/contentTemplates");

async function main() {
  const config = getRuntimeConfig({
    NODE_ENV: "production",
    PUBLIC_BASE_URL: "https://threads-affiliate.example",
    THREADS_DRY_RUN: "true",
    AI_DRAFT_PROVIDER: "openai",
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://api.openai.test/v1",
    OFFER_PAGE_CONTEXT_ENABLED: "true",
    DEFAULT_DISCLOSURE_TEXT: "含聯盟連結"
  });
  let persisted = defaultState();
  persisted.posts = [];
  const offer = upsertRealOffer(persisted, {
    campaignName: "Creator workflow",
    targetPersona: "需要減少重複工作的內容創作者",
    productName: "Creator Automation Suite",
    offer: "排程、審核與轉換追蹤工具",
    network: "Impact",
    commissionModel: "CPS",
    commissionValue: 20,
    currency: "USD",
    targetUrl: "https://affiliate.vendor-shop.com/click?publisher=secret",
    slug: "creator-automation-suite",
    subIdParam: "subid",
    appendUtm: false
  }, config);

  let capturedPrompt = "";
  const generated = await generateDraftsAsync(persisted, {
    campaignId: offer.campaign.id,
    productId: offer.product.id,
    topic: "內容創作者如何選擇自動化工具"
  }, config, {
    createdBy: "workflow-test",
    offerPageLoader: async () => ({
      status: "ready",
      sourceDomain: "merchant.example",
      title: "Creator Automation Suite",
      characterCount: 240,
      fetchedAt: new Date().toISOString(),
      contextText: JSON.stringify({
        securityLabel: "UNTRUSTED_WEBPAGE_DATA",
        pageTitle: "Creator Automation Suite",
        pageDescription: "排程、人工審核、成效追蹤",
        product: { price: "29", currency: "USD" }
      })
    }),
    fetchImpl: async (_url, options) => {
      capturedPrompt = JSON.parse(options.body).input;
      return {
        ok: true,
        async json() {
          return {
            output_text: JSON.stringify({
              drafts: Array.from({ length: 5 }, (_, index) => ({
                hook: `選擇自動化工具前先確認第 ${index + 1} 個條件`,
                post: `選擇自動化工具時，先確認流程是否保留人工審核。這是第 ${index + 1} 個檢查角度。`,
                cta: "你最想先改善哪個重複步驟？",
                risk_note: "僅使用商品頁可驗證資訊，未承諾成效。"
              }))
            })
          };
        }
      };
    }
  });

  assert.equal(generated.created.length, 5);
  assert.equal(generated.sourceContext.status, "ready");
  assert.match(capturedPrompt, /Creator Automation Suite/);
  assert.match(capturedPrompt, /UNTRUSTED_WEBPAGE_DATA/);
  assert.doesNotMatch(capturedPrompt, /publisher=secret|affiliate\.vendor-shop\.com/);
  assert.equal(generated.created.slice(0, 4).every((post) => post.linkAttachment === ""), true);
  assert.equal(generated.created.slice(0, 4).every((post) => post.commercialIntensity === "soft"), true);
  assert.equal(generated.created.slice(0, 4).every((post) => post.sourceContext.status === "ready"), true);
  assert.equal(generated.created.every((post) => post.topicTag === ""), true);
  const conversionPost = generated.created[4];
  assert.doesNotMatch(conversionPost.text, /含有?聯盟連結/);
  assert.match(conversionPost.text, /#廣告/);
  assert.equal(conversionPost.linkAttachment, "https://affiliate.vendor-shop.com/click?publisher=secret");
  assert.equal((conversionPost.text.match(/https:\/\/affiliate\.vendor-shop\.com\/click\?publisher=secret/g) || []).length, 1);
  assert.doesNotMatch(conversionPost.text, /\/r\/creator-automation-suite/);
  assert.equal(conversionPost.disclosureStatus, "present");
  assert.equal(conversionPost.commercialIntensity, "strong");

  const generatedDashboard = buildDashboard(persisted, config);
  assert.equal(generatedDashboard.contentWorkflow.hasOffers, true);
  assert.equal(generatedDashboard.contentWorkflow.aiReady, true);
  assert.equal(generatedDashboard.contentWorkflow.stages.find((stage) => stage.id === "research").status, "completed");
  assert.equal(generatedDashboard.contentWorkflow.stages.find((stage) => stage.id === "review").status, "active");
  assert.equal(generatedDashboard.contentWorkflow.nextAction, "review");

  const productPrompt = buildPrompt("小空間照明的選擇建議", {
    targetPersona: "租屋族與需要夜間柔和照明的人",
    productName: "USB-C 磁吸感應燈",
    offer: "人體感應、三種色溫、免拉線安裝",
    network: "Shopee",
    disclosureText: "含聯盟連結",
    trackingUrl: "https://threads-affiliate.example/r/sensor-light",
    pageContext: JSON.stringify({
      securityLabel: "UNTRUSTED_WEB_RESEARCH_DATA",
      facts: [{ label: "充電", value: "USB-C" }],
      caveats: ["續航時間依使用方式而異"]
    })
  });
  assert.match(productPrompt, /實際目標受眾：租屋族與需要夜間柔和照明的人/);
  assert.match(productPrompt, /不要把商品硬套進 AI、自動化、副業、創作者或賺錢情境/);
  assert.match(productPrompt, /第 1 到第 4 則是非導購內容/);
  assert.match(productPrompt, /第 5 則可以溫和推薦/);
  assert.match(productPrompt, /限制與取捨/);
  assert.doesNotMatch(productPrompt, /threads-affiliate\.example\/r\/sensor-light/);
  assert.doesNotMatch(productPrompt, /預設受眾：想了解 AI、自動化與聯盟行銷的初學者/);

  const post = conversionPost;
  approvePost(post, config, { actor: "workflow-test", recentPosts: [] });
  schedulePost(post, config, {
    actor: "workflow-test",
    recentPosts: [],
    scheduledAt: new Date(Date.now() - 1000).toISOString()
  });
  persisted.posts = [post];
  const store = {
    async read() { return persisted; },
    async write(nextState) { persisted = nextState; }
  };
  const published = await runAutomation(store, config, { source: "workflow-test" });
  assert.equal(published.run.processed, 1);
  assert.equal(published.run.simulated, 1);
  assert.equal(persisted.posts[0].status, STATUS.simulated);
  assert.equal(published.dashboard.contentWorkflow.stages.find((stage) => stage.id === "publish").status, "completed");

  await assert.rejects(
    generateOpenAIDrafts({
      topic: "timeout proof",
      config: { ...config, openaiTimeoutMs: 25 },
      fetchImpl: async (_url, options) => {
        assert.equal(options.signal instanceof AbortSignal, true);
        return new Promise(() => {});
      }
    }),
    (error) => error.code === "OPENAI_TIMEOUT" && error.statusCode === 504
  );

  console.log("Content publishing workflow passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

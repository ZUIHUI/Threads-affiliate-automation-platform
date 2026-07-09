const fs = require("node:fs");
const path = require("node:path");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStore(filePath) {
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  if (!fs.existsSync(absolutePath)) {
    fs.writeFileSync(absolutePath, JSON.stringify(defaultState(), null, 2), "utf8");
  }

  function read() {
    const raw = fs.readFileSync(absolutePath, "utf8");
    return JSON.parse(raw);
  }

  function write(state) {
    fs.writeFileSync(absolutePath, JSON.stringify(state, null, 2), "utf8");
  }

  function update(mutator) {
    const state = read();
    const result = mutator(state) || {};
    write(state);
    return result;
  }

  return {
    filePath: absolutePath,
    read,
    write,
    update
  };
}

function defaultState() {
  const now = new Date().toISOString();
  return {
    settings: {
      platformName: "Threads Affiliate Ops",
      timezone: "Asia/Taipei",
      disclosureText: "含聯盟連結",
      maxDailyApiPosts: 250,
      autoGenerateEnabled: true,
      maxLinksPerPost: 5,
      postCharacterLimitBytes: 500
    },
    threadsAccounts: [
      {
        id: "acct_primary",
        displayName: "Primary Threads Account",
        threadsUserId: "",
        status: "needs_credentials",
        quotaUsage: 0,
        quotaTotal: 250,
        createdAt: now,
        updatedAt: now
      }
    ],
    campaigns: [
      {
        id: "cmp_ai_affiliate",
        name: "AI 自動化聯盟行銷",
        status: "active",
        niche: "ai-side-hustle",
        targetPersona: "想用 AI 做副業、自動化、聯盟行銷的新手",
        dailyBudgetPosts: 3,
        disclosureRequired: true,
        createdAt: now,
        updatedAt: now
      },
      {
        id: "cmp_threads_ops",
        name: "Threads 內容自動化",
        status: "active",
        niche: "social-automation",
        targetPersona: "想穩定經營內容但不想每天手動發文的人",
        dailyBudgetPosts: 2,
        disclosureRequired: true,
        createdAt: now,
        updatedAt: now
      }
    ],
    products: [
      {
        id: "prd_prompt_pack",
        campaignId: "cmp_ai_affiliate",
        name: "AI 副業內容 Prompt Pack",
        offer: "把主題、草稿、審稿、排程整理成可重複流程",
        network: "ExamplePartner",
        commissionModel: "CPA",
        commissionValue: 8,
        currency: "USD",
        landingUrl: "https://example.com/ai-affiliate-prompt-pack",
        status: "active",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "prd_n8n_course",
        campaignId: "cmp_threads_ops",
        name: "n8n 社群自動化入門課",
        offer: "用低成本流程先驗證內容與互動",
        network: "ExamplePartner",
        commissionModel: "CPS",
        commissionValue: 12,
        currency: "percent",
        landingUrl: "https://example.com/n8n-social-automation",
        status: "active",
        createdAt: now,
        updatedAt: now
      }
    ],
    affiliateLinks: [
      {
        id: "aff_prompt_pack",
        slug: "ai-affiliate-prompt-pack",
        campaignId: "cmp_ai_affiliate",
        productId: "prd_prompt_pack",
        network: "ExamplePartner",
        targetUrl: "https://example.com/ai-affiliate-prompt-pack?utm_source=threads&utm_medium=affiliate_social&utm_campaign=cmp_ai_affiliate",
        clicks: 128,
        conversions: 9,
        revenue: 72,
        currency: "USD",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "aff_n8n_course",
        slug: "n8n-social-automation",
        campaignId: "cmp_threads_ops",
        productId: "prd_n8n_course",
        network: "ExamplePartner",
        targetUrl: "https://example.com/n8n-social-automation?utm_source=threads&utm_medium=affiliate_social&utm_campaign=cmp_threads_ops",
        clicks: 91,
        conversions: 5,
        revenue: 43,
        currency: "USD",
        createdAt: now,
        updatedAt: now
      }
    ],
    posts: [
      {
        id: "post_seed_1",
        accountId: "acct_primary",
        campaignId: "cmp_ai_affiliate",
        productId: "prd_prompt_pack",
        affiliateLinkId: "aff_prompt_pack",
        contentType: "教學型",
        funnelRatio: "trust",
        hook: "很多人做 AI 自動化副業，第一步就做錯。",
        cta: "你覺得最難的是產文，還是穩定發文？",
        riskNote: "低風險：教育型內容，未承諾收益。",
        topicTag: "AI 自動化聯盟行銷",
        text: "很多人做 AI 自動化副業，第一步就做錯。\n\n不是先開帳號，也不是先找商品。\n\n而是先設計內容資料流：主題、來源、審稿、排程、成效。\n\n沒有這條流程，自動化只會變成自動製造垃圾內容。\n\n你覺得最難的是產文，還是穩定發文？",
        status: "draft",
        approved: false,
        scheduledAt: now,
        linkAttachment: "",
        createdAt: now,
        updatedAt: now
      },
      {
        id: "post_seed_2",
        accountId: "acct_primary",
        campaignId: "cmp_threads_ops",
        productId: "prd_n8n_course",
        affiliateLinkId: "aff_n8n_course",
        contentType: "轉換型",
        funnelRatio: "conversion",
        hook: "聯盟連結不要急著每篇都放。",
        cta: "你比較能接受直接放連結，還是先導到整理頁？",
        riskNote: "低風險：有揭露聯盟連結，未保證收益。",
        topicTag: "Threads 內容自動化",
        text: "含聯盟連結：聯盟連結不要急著每篇都放。\n\n比較穩的做法是先用內容建立信任，再把工具或資源整理成一個入口。\n\n我會把連結放在少數幾篇真正需要延伸資源的內容裡：http://localhost:4173/r/n8n-social-automation\n\n你比較能接受直接放連結，還是先導到整理頁？",
        status: "scheduled",
        approved: true,
        scheduledAt: now,
        linkAttachment: "http://localhost:4173/r/n8n-social-automation",
        createdAt: now,
        updatedAt: now
      }
    ],
    automationRuns: [],
    clickEvents: [],
    conversionEvents: [],
    events: [],
    runtime: {
      workerLease: null
    },
    profitEngine: {
      autonomyEnabled: true,
      objective: "自然真實內容 -> 廣告情報 -> 聯盟成交",
      lastRunAt: null,
      runs: [],
      modelScores: [],
      adInsights: [],
      generatedScripts: [],
      externalSignals: [],
      sourceStatuses: [],
      optimizerPolicies: [],
      lastIngestAt: null
    },
    version: 1
  };
}

module.exports = { createStore, clone, defaultState };

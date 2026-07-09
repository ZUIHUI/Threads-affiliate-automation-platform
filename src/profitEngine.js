const crypto = require("node:crypto");

const PROFIT_MODELS = [
  {
    id: "model_trust_stack",
    name: "信任型工具組推薦",
    stage: "自然內容 -> 工具清單 -> 聯盟連結",
    monetization: "CPS / CPA",
    marginProfile: "中轉換率、低退訂、可長期累積",
    audienceSignal: "正在找 AI/自動化工具、但還不想被硬賣",
    adAngle: "把一個痛點拆成可執行 SOP，再推薦剛好用得到的工具",
    sourceHints: ["Meta Ad Library", "Google Ads Transparency Center", "Affiliate network EPC"],
    baseScore: 82
  },
  {
    id: "model_lead_magnet",
    name: "免費資源換名單",
    stage: "Threads 教學 -> 免費模板 -> Email/Nurture -> 聯盟成交",
    monetization: "Email affiliate / CPA",
    marginProfile: "短期收入較慢、長期 LTV 較高",
    audienceSignal: "願意下載範本、清單或 prompt pack",
    adAngle: "用免費範本降低信任門檻，再用後續內容推薦工具",
    sourceHints: ["Lead magnet ads", "SaaS onboarding offers", "Newsletter sponsors"],
    baseScore: 76
  },
  {
    id: "model_comparison",
    name: "比較型決策內容",
    stage: "問題比較 -> 選型標準 -> 工具推薦 -> 聯盟連結",
    monetization: "CPS / recurring commission",
    marginProfile: "高意圖、高佣金、需要更嚴謹證據",
    audienceSignal: "搜尋替代方案、比較價格、尋找最佳工具",
    adAngle: "把廣告主主張轉成可驗證評分表，避免誇大收益",
    sourceHints: ["Competitor landing pages", "Review ads", "Pricing pages"],
    baseScore: 79
  },
  {
    id: "model_micro_offer",
    name: "低價微產品導流",
    stage: "自然短文 -> 小額數位產品 -> Upsell affiliate",
    monetization: "Digital product + affiliate upsell",
    marginProfile: "初期最快驗證，但需要產品交付",
    audienceSignal: "想立刻拿到範例、腳本或流程包",
    adAngle: "先賣可立即使用的小結果，再推薦完整工具",
    sourceHints: ["Low-ticket creator ads", "Template marketplace", "Bundle offers"],
    baseScore: 73
  }
];

const AD_SOURCES = [
  {
    id: "meta_ad_library",
    name: "Meta Ad Library",
    role: "找同 niche 廣告角度、hook、CTA",
    input: "keyword / advertiser",
    status: "manual_or_api"
  },
  {
    id: "google_ads_transparency",
    name: "Google Ads Transparency Center",
    role: "觀察搜尋與 YouTube 廣告主張",
    input: "brand / domain",
    status: "manual_or_api"
  },
  {
    id: "affiliate_network",
    name: "Affiliate Network EPC",
    role: "篩選佣金、轉換率、退訂風險",
    input: "program feed / CSV / API",
    status: "api_ready"
  },
  {
    id: "landing_page_scan",
    name: "Landing Page Scan",
    role: "萃取 offer、保證、價格與風險字眼",
    input: "product landing URL",
    status: "api_ready"
  }
];

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function trackingUrl(config, slug) {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/r/${slug}`;
}

function slugify(value) {
  return String(value || "link")
    .trim()
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `link-${Date.now()}`;
}

function ensureProfitState(state) {
  if (!state.profitEngine) {
    state.profitEngine = {
      autonomyEnabled: true,
      objective: "自然真實內容 -> 廣告情報 -> 聯盟成交",
      lastRunAt: null,
      runs: [],
      modelScores: [],
      adInsights: [],
      generatedScripts: []
    };
  }
  if (!Array.isArray(state.profitEngine.runs)) state.profitEngine.runs = [];
  if (!Array.isArray(state.profitEngine.modelScores)) state.profitEngine.modelScores = [];
  if (!Array.isArray(state.profitEngine.adInsights)) state.profitEngine.adInsights = [];
  if (!Array.isArray(state.profitEngine.generatedScripts)) state.profitEngine.generatedScripts = [];
  return state.profitEngine;
}

function scoreProfitModel(model, state) {
  const campaigns = state.campaigns || [];
  const products = state.products || [];
  const links = state.affiliateLinks || [];
  const posts = state.posts || [];
  const conversionCount = links.reduce((total, link) => total + Number(link.conversions || 0), 0);
  const clickCount = links.reduce((total, link) => total + Number(link.clicks || 0), 0);
  const revenue = links.reduce((total, link) => total + Number(link.revenue || 0), 0);
  const activeCampaignBonus = campaigns.some((campaign) => campaign.status === "active") ? 6 : -8;
  const productBonus = products.some((product) => product.status === "active") ? 5 : -10;
  const signalBonus = Math.min(10, Math.round(clickCount / 30) + conversionCount);
  const revenueBonus = revenue > 0 ? 4 : 0;
  const fatiguePenalty = Math.min(8, posts.filter((post) => post.funnelRatio === model.id).length);

  return Math.max(0, Math.min(100,
    model.baseScore + activeCampaignBonus + productBonus + signalBonus + revenueBonus - fatiguePenalty
  ));
}

function pickActiveContext(state) {
  const campaign = (state.campaigns || []).find((item) => item.status === "active") || state.campaigns?.[0];
  const product = (state.products || []).find((item) => item.campaignId === campaign?.id && item.status === "active")
    || (state.products || []).find((item) => item.status === "active")
    || state.products?.[0];
  if (!campaign || !product) {
    const error = new Error("Profit engine requires at least one campaign and one product.");
    error.statusCode = 400;
    throw error;
  }
  return { campaign, product };
}

function ensureAffiliateLink(state, campaign, product, config) {
  let link = (state.affiliateLinks || []).find((item) => item.productId === product.id);
  if (link) return link;

  const url = new URL(product.landingUrl);
  url.searchParams.set("utm_source", config.defaultUtmSource);
  url.searchParams.set("utm_medium", config.defaultUtmMedium);
  url.searchParams.set("utm_campaign", campaign.id);
  url.searchParams.set("utm_content", product.id);

  link = {
    id: makeId("aff"),
    slug: slugify(`${campaign.name}-${product.name}`),
    campaignId: campaign.id,
    productId: product.id,
    network: product.network || "Direct",
    targetUrl: url.toString(),
    clicks: 0,
    conversions: 0,
    revenue: 0,
    currency: product.currency === "percent" ? "USD" : product.currency || "USD",
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  state.affiliateLinks.push(link);
  return link;
}

function buildNaturalScripts(model, campaign, product, link, config, count) {
  const cta = trackingUrl(config, link.slug);
  const disclosure = config.defaultDisclosureText;
  const scripts = [
    {
      type: "pain_point",
      hook: `很多人做 ${campaign.name} 會先卡在工具太多，不知道從哪個開始。`,
      post: `${disclosure}：很多人做 ${campaign.name} 會先卡在工具太多，不知道從哪個開始。\n\n我會先看一個小問題：這個工具能不能讓你今天少做一個重複步驟。\n\n${product.name} 的價值是「${product.offer}」。先用小任務驗證，不要一開始就把整套流程買滿。\n\n延伸資源：${cta}\n\n你現在最想自動化的是內容、名單，還是成交追蹤？`
    },
    {
      type: "decision_filter",
      hook: `我不會用「最強工具」當推薦標準，因為那通常太空泛。`,
      post: `${disclosure}：我不會用「最強工具」當推薦標準，因為那通常太空泛。\n\n比較實際的標準是：\n1. 能不能在 30 分鐘內跑出第一版\n2. 會不會降低手動整理時間\n3. 後面能不能接到追蹤連結和名單\n\n${product.name} 比較適合想先驗證 ${campaign.niche} 的人。連結：${cta}\n\n你選工具時最在意價格、上手速度，還是可串接性？`
    },
    {
      type: "ad_angle",
      hook: `我會把廣告裡很浮誇的承諾，改寫成可以自己驗證的小實驗。`,
      post: `${disclosure}：我會把廣告裡很浮誇的承諾，改寫成可以自己驗證的小實驗。\n\n這輪測的是「${model.adAngle}」。先不承諾收益，只看它能不能讓流程更短、資料更清楚。\n\n工具入口：${cta}\n\n如果你要我拆一個完整測試流程，你想看 Threads 發文、聯盟追蹤，還是自動回報？`
    }
  ];
  return scripts.slice(0, count);
}

function createAutonomousPosts(state, config, model, campaign, product, link, scripts, autoApprove) {
  const created = [];
  const baseTime = Date.now();
  for (const script of scripts) {
    const scheduledAt = new Date(baseTime + (created.length + 1) * 45 * 60 * 1000).toISOString();
    const post = {
      id: makeId("post"),
      accountId: "acct_primary",
      campaignId: campaign.id,
      productId: product.id,
      affiliateLinkId: link.id,
      contentType: "自然推薦腳本",
      funnelRatio: model.id,
      hook: script.hook,
      cta: trackingUrl(config, link.slug),
      riskNote: "自動獲利引擎：有揭露聯盟關係，未承諾收益，使用問題式互動結尾。",
      topicTag: campaign.name.replace(/[.#&]/g, "").slice(0, 50),
      text: script.post,
      status: autoApprove ? "scheduled" : "draft",
      approved: Boolean(autoApprove),
      scheduledAt,
      linkAttachment: trackingUrl(config, link.slug),
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    state.posts.push(post);
    created.push(post);
  }
  return created;
}

function shouldSkipRun(engine, config, force) {
  if (force || !engine.lastRunAt) return false;
  const interval = config.autonomyIntervalMs || 6 * 60 * 60 * 1000;
  return Date.now() - new Date(engine.lastRunAt).getTime() < interval;
}

function runProfitEngine(state, config, options = {}) {
  const engine = ensureProfitState(state);
  if (shouldSkipRun(engine, config, options.force)) {
    return {
      skipped: true,
      reason: "Autonomy interval has not elapsed.",
      profitEngine: buildProfitDashboard(state, config)
    };
  }

  const scores = PROFIT_MODELS
    .map((model) => ({
      ...model,
      score: scoreProfitModel(model, state),
      recommendation: model.baseScore >= 78 ? "primary" : "watch"
    }))
    .sort((a, b) => b.score - a.score);
  const selected = scores[0];
  const { campaign, product } = pickActiveContext(state);
  const link = ensureAffiliateLink(state, campaign, product, config);
  const count = Math.max(1, Math.min(Number(config.autonomyMaxScriptsPerRun || 3), 5));
  const scripts = buildNaturalScripts(selected, campaign, product, link, config, count);
  const createdPosts = options.createPosts === false
    ? []
    : createAutonomousPosts(state, config, selected, campaign, product, link, scripts, options.autoApprove !== false);

  const insight = {
    id: makeId("ad"),
    modelId: selected.id,
    source: selected.sourceHints[0],
    angle: selected.adAngle,
    naturalRewrite: "把廣告承諾改成可驗證的小實驗，避免保證收益。",
    targetCampaignId: campaign.id,
    targetProductId: product.id,
    createdAt: nowIso()
  };
  const run = {
    id: makeId("profit_run"),
    source: options.source || "manual",
    selectedModelId: selected.id,
    selectedModelName: selected.name,
    score: selected.score,
    createdPostIds: createdPosts.map((post) => post.id),
    createdInsightId: insight.id,
    status: "completed",
    createdAt: nowIso()
  };

  engine.lastRunAt = run.createdAt;
  engine.modelScores = scores;
  engine.adInsights.unshift(insight);
  engine.generatedScripts.unshift(...scripts.map((script) => ({
    id: makeId("script"),
    modelId: selected.id,
    productId: product.id,
    type: script.type,
    hook: script.hook,
    post: script.post,
    createdAt: run.createdAt
  })));
  engine.runs.unshift(run);
  engine.adInsights = engine.adInsights.slice(0, 12);
  engine.generatedScripts = engine.generatedScripts.slice(0, 12);
  engine.runs = engine.runs.slice(0, 12);
  state.events.unshift({
    id: makeId("evt"),
    type: "profit_engine.run",
    runId: run.id,
    createdPostCount: createdPosts.length,
    createdAt: run.createdAt
  });

  return {
    skipped: false,
    run,
    createdPosts,
    scripts,
    profitEngine: buildProfitDashboard(state, config)
  };
}

function buildProfitDashboard(state, config) {
  const engine = ensureProfitState(state);
  const scores = engine.modelScores.length
    ? engine.modelScores
    : PROFIT_MODELS.map((model) => ({ ...model, score: scoreProfitModel(model, state) }))
      .sort((a, b) => b.score - a.score);
  const scheduledAutonomyPosts = (state.posts || []).filter((post) =>
    post.contentType === "自然推薦腳本" && ["draft", "scheduled"].includes(post.status)
  ).length;

  return {
    autonomyEnabled: Boolean(config.autonomyMode),
    objective: engine.objective,
    lastRunAt: engine.lastRunAt,
    nextRunHint: config.autonomyMode ? `${Math.round((config.autonomyIntervalMs || 0) / 60000)} 分鐘循環` : "手動",
    sources: AD_SOURCES,
    models: scores.slice(0, 4),
    adInsights: engine.adInsights.slice(0, 6),
    generatedScripts: engine.generatedScripts.slice(0, 4),
    runs: engine.runs.slice(0, 5),
    scheduledAutonomyPosts,
    guardrails: [
      "每則商業推薦都要包含聯盟揭露。",
      "只允許自然語氣與可驗證承諾，不使用保證收益。",
      "優先使用 dry-run 驗證；切 live 前需填 Threads credentials。",
      "每次循環限制產文數，避免重複與過度發文。"
    ]
  };
}

module.exports = {
  AD_SOURCES,
  PROFIT_MODELS,
  buildProfitDashboard,
  ensureProfitState,
  runProfitEngine
};

const crypto = require("node:crypto");

const { countThreadsUnits, validatePost } = require("./validators");

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
    id: "custom_ad_feed",
    name: "Custom Ad Feed",
    role: "接入自有 JSON 廣告情報、競品 hook 與 CTA",
    input: "AD_INTELLIGENCE_FEED_URLS",
    status: "api_ready"
  },
  {
    id: "google_ads_transparency",
    name: "Google Ads Transparency Center",
    role: "觀察搜尋與 YouTube 廣告主張",
    input: "brand / domain",
    status: "manual_or_api"
  },
  {
    id: "affiliate_offer_feed",
    name: "Affiliate Offer Feed",
    role: "篩選佣金、轉換率、退訂風險",
    input: "AFFILIATE_OFFER_FEED_URLS",
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

function stableId(prefix, value) {
  const digest = crypto.createHash("sha1").update(String(value || prefix)).digest("hex").slice(0, 14);
  return `${prefix}_${digest}`;
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
      generatedScripts: [],
      externalSignals: [],
      sourceStatuses: [],
      lastIngestAt: null
    };
  }
  if (!Array.isArray(state.profitEngine.runs)) state.profitEngine.runs = [];
  if (!Array.isArray(state.profitEngine.modelScores)) state.profitEngine.modelScores = [];
  if (!Array.isArray(state.profitEngine.adInsights)) state.profitEngine.adInsights = [];
  if (!Array.isArray(state.profitEngine.generatedScripts)) state.profitEngine.generatedScripts = [];
  if (!Array.isArray(state.profitEngine.externalSignals)) state.profitEngine.externalSignals = [];
  if (!Array.isArray(state.profitEngine.sourceStatuses)) state.profitEngine.sourceStatuses = [];
  return state.profitEngine;
}

const MODEL_SIGNAL_KEYWORDS = {
  model_trust_stack: ["tool", "workflow", "automation", "ai", "sop", "tutorial", "stack", "工具", "自動化"],
  model_lead_magnet: ["template", "checklist", "free", "download", "email", "newsletter", "模板", "清單"],
  model_comparison: ["compare", "comparison", "vs", "alternative", "pricing", "review", "比較", "替代"],
  model_micro_offer: ["bundle", "mini", "low-ticket", "course", "pack", "template", "小額", "課程"]
};

function signalText(signal) {
  return [
    signal.title,
    signal.pageName,
    signal.angle,
    signal.offer,
    signal.productName,
    signal.cta,
    signal.source
  ].filter(Boolean).join(" ").toLowerCase();
}

function signalMatchCount(model, signals) {
  const keywords = MODEL_SIGNAL_KEYWORDS[model.id] || [];
  let count = 0;
  for (const signal of signals) {
    const text = signalText(signal);
    if (keywords.some((keyword) => text.includes(keyword.toLowerCase()))) count += 1;
    if (signal.kind === "offer" && Number(signal.commissionValue || 0) > 0) count += 1;
  }
  return count;
}

function scoreProfitModel(model, state, signals = []) {
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
  const marketSignalBonus = Math.min(12, signalMatchCount(model, signals) * 3);

  return Math.max(0, Math.min(100,
    model.baseScore + activeCampaignBonus + productBonus + signalBonus + revenueBonus + marketSignalBonus - fatiguePenalty
  ));
}

function pickActiveContext(state, preferredSignal, syncedProducts = []) {
  const preferredProduct = preferredSignal
    ? (state.products || []).find((item) => item.sourceSignalId === preferredSignal.id)
    : null;
  const syncedProduct = syncedProducts.find((item) => item.status === "active");
  const campaign = (state.campaigns || []).find((item) =>
    item.id === preferredProduct?.campaignId || item.id === syncedProduct?.campaignId
  ) || (state.campaigns || []).find((item) => item.status === "active") || state.campaigns?.[0];
  const product = preferredProduct
    || syncedProduct
    || (state.products || []).find((item) => item.campaignId === campaign?.id && item.status === "active")
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

function pickCampaignForSignal(state, signal) {
  const campaigns = state.campaigns || [];
  const text = signalText(signal);
  return campaigns.find((campaign) => {
    const campaignText = [campaign.name, campaign.niche, campaign.targetPersona].filter(Boolean).join(" ").toLowerCase();
    return campaignText && text.includes(campaign.niche?.toLowerCase?.() || campaignText);
  }) || campaigns.find((campaign) => campaign.status === "active") || campaigns[0];
}

function productIdForSignal(signal) {
  return stableId("prd", signal.id || `${signal.source}:${signal.title}:${signal.landingUrl}`);
}

function upsertProductFromSignal(state, signal, campaign, config) {
  if (!campaign || signal.kind !== "offer" || !signal.landingUrl) return null;
  const productId = productIdForSignal(signal);
  const existing = (state.products || []).find((product) =>
    product.id === productId || product.sourceSignalId === signal.id
  );
  const now = nowIso();
  const product = existing || {
    id: productId,
    campaignId: campaign.id,
    createdAt: now
  };
  Object.assign(product, {
    campaignId: campaign.id,
    name: signal.productName || signal.title || "Autonomous affiliate offer",
    offer: signal.offer || signal.angle || "External affiliate offer",
    network: signal.source || "ExternalFeed",
    sourceSignalId: signal.id,
    sourceKind: signal.kind,
    commissionModel: signal.commissionModel || (Number(signal.commissionValue || 0) > 0 ? "CPA" : "CPS"),
    commissionValue: Number(signal.commissionValue || 0),
    currency: signal.currency || "USD",
    landingUrl: signal.landingUrl,
    status: "active",
    updatedAt: now
  });
  if (!existing) state.products.push(product);
  const link = ensureAffiliateLink(state, campaign, product, config);
  return { product, link, created: !existing };
}

function syncOffersFromSignals(state, config, signals) {
  const maxOffers = Number(config.autonomyMaxOffersPerRun || 0);
  if (!maxOffers) return { syncedProducts: [], createdProductIds: [], updatedProductIds: [] };
  const syncedProducts = [];
  const createdProductIds = [];
  const updatedProductIds = [];
  for (const signal of signals.filter((item) => item.kind === "offer" && item.landingUrl)) {
    if (syncedProducts.length >= maxOffers) break;
    const campaign = pickCampaignForSignal(state, signal);
    const result = upsertProductFromSignal(state, signal, campaign, config);
    if (!result) continue;
    syncedProducts.push(result.product);
    if (result.created) createdProductIds.push(result.product.id);
    else updatedProductIds.push(result.product.id);
  }
  return { syncedProducts, createdProductIds, updatedProductIds };
}

function mergeExternalSignals(existing, incoming, limit = 24) {
  const seen = new Set();
  const merged = [];
  for (const signal of [...incoming, ...existing]) {
    const key = signal.id || `${signal.source}:${signal.title}:${signal.angle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(signal);
    if (merged.length >= limit) break;
  }
  return merged;
}

function updateIngestState(engine, intelligence) {
  if (!intelligence) return engine.externalSignals || [];
  const incoming = Array.isArray(intelligence.items) ? intelligence.items : [];
  engine.externalSignals = mergeExternalSignals(engine.externalSignals || [], incoming);
  engine.sourceStatuses = Array.isArray(intelligence.sourceStatuses) ? intelligence.sourceStatuses : [];
  engine.lastIngestAt = intelligence.collectedAt || nowIso();
  return engine.externalSignals;
}

function pickSignalForModel(model, signals) {
  if (!signals.length) return null;
  const keywords = MODEL_SIGNAL_KEYWORDS[model.id] || [];
  return signals.find((signal) => {
    const text = signalText(signal);
    return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
  }) || signals[0];
}

function signalSummary(signal) {
  if (!signal) {
    return {
      source: "built-in playbook",
      angle: "",
      offer: "",
      title: ""
    };
  }
  return {
    source: signal.source || "external signal",
    angle: signal.angle || "",
    offer: signal.offer || "",
    title: signal.title || signal.productName || ""
  };
}

function buildNaturalScripts(model, campaign, product, link, config, count, signal) {
  const cta = trackingUrl(config, link.slug);
  const disclosure = config.defaultDisclosureText;
  const market = signalSummary(signal);
  const observedAngle = market.angle || model.adAngle;
  const observedOffer = market.offer || product.offer;
  const observedTitle = market.title ? `「${market.title}」` : "這類工具";
  const sourceLine = signal
    ? `這輪參考 ${market.source} 看到的角度，但不照抄原廣告。`
    : "這輪先使用內建獲利 playbook，等外部 feed 接上後會自動改用市場訊號。";
  const scripts = [
    {
      type: "pain_point",
      hook: `很多人做 ${campaign.name} 會先卡在工具太多，不知道從哪個開始。`,
      post: `${disclosure}：很多人做 ${campaign.name} 會先卡在工具太多，不知道從哪個開始。\n\n${sourceLine}\n\n我會先看一個小問題：這個工具能不能讓你今天少做一個重複步驟。\n\n${product.name} 的價值是「${observedOffer}」。先用小任務驗證，不要一開始就把整套流程買滿。\n\n延伸資源：${cta}\n\n你現在最想自動化的是內容、名單，還是成交追蹤？`
    },
    {
      type: "decision_filter",
      hook: `我不會用「最強工具」當推薦標準，因為那通常太空泛。`,
      post: `${disclosure}：我不會用「最強工具」當推薦標準，因為那通常太空泛。\n\n看到 ${observedTitle} 這種 offer，我會先用三個條件過濾：\n1. 能不能在 30 分鐘內跑出第一版\n2. 會不會降低手動整理時間\n3. 後面能不能接到追蹤連結和名單\n\n${product.name} 比較適合想先驗證 ${campaign.niche} 的人。連結：${cta}\n\n你選工具時最在意價格、上手速度，還是可串接性？`
    },
    {
      type: "ad_angle",
      hook: `我會把廣告裡很浮誇的承諾，改寫成可以自己驗證的小實驗。`,
      post: `${disclosure}：我會把廣告裡很浮誇的承諾，改寫成可以自己驗證的小實驗。\n\n這輪測的是「${observedAngle}」。先不承諾收益，只看它能不能讓流程更短、資料更清楚。\n\n工具入口：${cta}\n\n如果你要我拆一個完整測試流程，你想看 Threads 發文、聯盟追蹤，還是自動回報？`
    }
  ];
  return scripts.slice(0, count);
}

function normalizeScriptOverrides(scripts, config, cta, count) {
  if (!Array.isArray(scripts)) return [];
  const disclosure = config.defaultDisclosureText || "含聯盟連結";
  return scripts.slice(0, count).map((script, index) => {
    let post = String(script.post || "").trim();
    if (!post) return null;
    if (!post.includes(disclosure) && !/#ad\b/i.test(post)) {
      post = `${disclosure}：${post}`;
    }
    if (cta && !post.includes(cta)) {
      post = `${post}\n\n延伸資源：${cta}`;
    }
    return {
      type: script.type || `ai_script_${index + 1}`,
      hook: String(script.hook || post.split(/\r?\n/)[0] || "自然推薦").trim(),
      post,
      cta: String(script.cta || "延伸資源").trim(),
      risk_note: String(script.risk_note || script.riskNote || "AI generated with disclosure, no guaranteed-profit claim.").trim()
    };
  }).filter(Boolean);
}

function truncateThreadsText(text, maxUnits) {
  let units = 0;
  let output = "";
  for (const char of Array.from(String(text || ""))) {
    const size = /\p{Extended_Pictographic}/u.test(char) ? Buffer.byteLength(char, "utf8") : 1;
    if (units + size > maxUnits) break;
    output += char;
    units += size;
  }
  return output.trim();
}

function repairPostText(post, config) {
  const maxUnits = Number(config.postCharacterLimitBytes || 500);
  if (countThreadsUnits(post.text) <= maxUnits) return post;
  const cta = post.linkAttachment || post.cta || "";
  const disclosure = config.defaultDisclosureText || "含聯盟連結";
  const suffix = cta ? `\n\n延伸資源：${cta}` : "";
  const prefix = post.text.includes(disclosure) || /#ad\b/i.test(post.text)
    ? ""
    : `${disclosure}：`;
  const allowedBodyUnits = Math.max(80, maxUnits - countThreadsUnits(`${prefix}${suffix}`) - 12);
  const body = truncateThreadsText(post.text.replace(cta, "").trim(), allowedBodyUnits);
  post.text = `${prefix}${body}${suffix}`.trim();
  return post;
}

function guardAutonomousPost(post, config) {
  const repaired = repairPostText(post, config);
  const validation = validatePost(repaired, config);
  const blocked = !validation.valid || validation.risk.level === "high";
  return {
    post: repaired,
    validation,
    blocked,
    reason: blocked
      ? [...validation.errors, ...validation.risk.warnings].join(" ") || "High-risk content was blocked."
      : ""
  };
}

function createAutonomousPosts(state, config, model, campaign, product, link, scripts, autoApprove) {
  const created = [];
  const blocked = [];
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
      riskNote: script.risk_note || "自動獲利引擎：有揭露聯盟關係，未承諾收益，使用問題式互動結尾。",
      topicTag: campaign.name.replace(/[.#&]/g, "").slice(0, 50),
      text: script.post,
      status: autoApprove ? "scheduled" : "draft",
      approved: Boolean(autoApprove),
      scheduledAt,
      linkAttachment: trackingUrl(config, link.slug),
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    const guarded = guardAutonomousPost(post, config);
    if (guarded.blocked) {
      blocked.push({
        hook: script.hook,
        type: script.type,
        reason: guarded.reason,
        validation: guarded.validation,
        createdAt: nowIso()
      });
      continue;
    }
    state.posts.push(guarded.post);
    created.push(guarded.post);
  }
  return { created, blocked };
}

function shouldSkipRun(engine, config, force) {
  if (force || !engine.lastRunAt) return false;
  const interval = config.autonomyIntervalMs || 6 * 60 * 60 * 1000;
  return Date.now() - new Date(engine.lastRunAt).getTime() < interval;
}

function buildProfitRunPreview(state, config, options = {}) {
  const previewState = JSON.parse(JSON.stringify(state));
  const engine = ensureProfitState(previewState);
  const signals = updateIngestState(engine, options.intelligence);
  if (shouldSkipRun(engine, config, options.force)) {
    return {
      skipped: true,
      reason: "Autonomy interval has not elapsed.",
      lastRunAt: engine.lastRunAt
    };
  }
  const offerSync = syncOffersFromSignals(previewState, config, signals);
  const scores = PROFIT_MODELS
    .map((model) => {
      const score = scoreProfitModel(model, previewState, signals);
      return {
        ...model,
        score,
        recommendation: score >= 82 ? "primary" : "watch"
      };
    })
    .sort((a, b) => b.score - a.score);
  const selected = scores[0];
  const selectedSignal = pickSignalForModel(selected, signals);
  const { campaign, product } = pickActiveContext(previewState, selectedSignal, offerSync.syncedProducts);
  const link = ensureAffiliateLink(previewState, campaign, product, config);
  const count = Math.max(1, Math.min(Number(config.autonomyMaxScriptsPerRun || 3), 5));
  return {
    skipped: false,
    selectedModel: selected,
    selectedSignal,
    campaign,
    product,
    link,
    count,
    trackingUrl: trackingUrl(config, link.slug),
    sourceStatuses: engine.sourceStatuses || [],
    externalSignalCount: signals.length,
    syncedProductIds: offerSync.syncedProducts.map((item) => item.id)
  };
}

function runProfitEngine(state, config, options = {}) {
  const engine = ensureProfitState(state);
  const signals = updateIngestState(engine, options.intelligence);
  const offerSync = syncOffersFromSignals(state, config, signals);
  if (shouldSkipRun(engine, config, options.force)) {
    return {
      skipped: true,
      reason: "Autonomy interval has not elapsed.",
      profitEngine: buildProfitDashboard(state, config)
    };
  }

  const scores = PROFIT_MODELS
    .map((model) => {
      const score = scoreProfitModel(model, state, signals);
      return {
        ...model,
        score,
        recommendation: score >= 82 ? "primary" : "watch"
      };
    })
    .sort((a, b) => b.score - a.score);
  const selected = scores[0];
  const selectedSignal = pickSignalForModel(selected, signals);
  const { campaign, product } = pickActiveContext(state, selectedSignal, offerSync.syncedProducts);
  const link = ensureAffiliateLink(state, campaign, product, config);
  const count = Math.max(1, Math.min(Number(config.autonomyMaxScriptsPerRun || 3), 5));
  const cta = trackingUrl(config, link.slug);
  const aiScripts = normalizeScriptOverrides(options.aiScripts, config, cta, count);
  const scripts = aiScripts.length
    ? aiScripts
    : buildNaturalScripts(selected, campaign, product, link, config, count, selectedSignal);
  const scriptSource = aiScripts.length ? (options.aiScriptSource || "openai") : "template";
  const postPlan = options.createPosts === false
    ? { created: [], blocked: [] }
    : createAutonomousPosts(state, config, selected, campaign, product, link, scripts, options.autoApprove !== false);
  const createdPosts = postPlan.created;
  const blockedScripts = postPlan.blocked;

  const insight = {
    id: makeId("ad"),
    modelId: selected.id,
    source: selectedSignal?.source || selected.sourceHints[0],
    sourceSignalId: selectedSignal?.id || "",
    sourceStatus: selectedSignal ? "external" : "built_in",
    angle: selectedSignal?.angle || selected.adAngle,
    naturalRewrite: "把廣告承諾改成可驗證的小實驗，避免保證收益。",
    snapshotUrl: selectedSignal?.adSnapshotUrl || "",
    landingUrl: selectedSignal?.landingUrl || "",
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
    ingestedSignalCount: options.intelligence?.items?.length || 0,
    syncedProductIds: offerSync.syncedProducts.map((product) => product.id),
    createdProductIds: offerSync.createdProductIds,
    updatedProductIds: offerSync.updatedProductIds,
    scriptSource,
    aiScriptError: options.aiScriptError || "",
    blockedScriptCount: blockedScripts.length,
    blockedScripts,
    sourceStatuses: engine.sourceStatuses,
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
    source: scriptSource,
    aiScriptError: options.aiScriptError || "",
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
    blockedScripts,
    scripts,
    intelligence: options.intelligence || null,
    profitEngine: buildProfitDashboard(state, config)
  };
}

function buildProfitDashboard(state, config) {
  const engine = ensureProfitState(state);
  const signals = engine.externalSignals || [];
  const scores = engine.modelScores.length
    ? engine.modelScores
    : PROFIT_MODELS.map((model) => {
      const score = scoreProfitModel(model, state, signals);
      return { ...model, score, recommendation: score >= 82 ? "primary" : "watch" };
    })
      .sort((a, b) => b.score - a.score);
  const scheduledAutonomyPosts = (state.posts || []).filter((post) =>
    post.contentType === "自然推薦腳本" && ["draft", "scheduled"].includes(post.status)
  ).length;
  const syncedOfferProducts = (state.products || []).filter((product) => product.sourceSignalId);
  const statusById = new Map((engine.sourceStatuses || []).map((status) => [status.id, status]));
  const sources = AD_SOURCES.map((source) => {
    const status = statusById.get(source.id);
    return {
      ...source,
      runtimeStatus: status?.status || source.status,
      message: status?.message || "",
      count: status?.count || 0
    };
  });

  return {
    autonomyEnabled: Boolean(config.autonomyMode),
    objective: engine.objective,
    lastRunAt: engine.lastRunAt,
    lastIngestAt: engine.lastIngestAt,
    nextRunHint: config.autonomyMode ? `${Math.round((config.autonomyIntervalMs || 0) / 60000)} 分鐘循環` : "手動",
    sources,
    sourceStatuses: engine.sourceStatuses || [],
    externalSignals: signals.slice(0, 8),
    offerAutopilot: {
      maxOffersPerRun: Number(config.autonomyMaxOffersPerRun || 0),
      syncedProductCount: syncedOfferProducts.length,
      activeSyncedProductCount: syncedOfferProducts.filter((product) => product.status === "active").length
    },
    models: scores.slice(0, 4),
    adInsights: engine.adInsights.slice(0, 6),
    generatedScripts: engine.generatedScripts.slice(0, 4),
    runs: engine.runs.slice(0, 5),
    blockedScripts: engine.runs.flatMap((run) => run.blockedScripts || []).slice(0, 6),
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
  buildProfitRunPreview,
  buildProfitDashboard,
  ensureProfitState,
  runProfitEngine
};

const crypto = require("node:crypto");

const { countThreadsUnits, validatePost } = require("./validators");
const { STATUS, prepareGeneratedPostForReview } = require("./postReview");
const { evaluateContentFatigue, evaluateProfitModelFatigue } = require("./contentFatigue");

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

function trackingUrl(config, slug, attribution = {}) {
  const url = new URL(`${config.publicBaseUrl.replace(/\/$/, "")}/r/${slug}`);
  const params = {
    post: attribution.postId,
    model: attribution.modelId,
    campaign: attribution.campaignId,
    product: attribution.productId
  };
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  return url.toString();
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
      optimizerPolicies: [],
      lastIngestAt: null
    };
  }
  if (!Array.isArray(state.profitEngine.runs)) state.profitEngine.runs = [];
  if (!Array.isArray(state.profitEngine.modelScores)) state.profitEngine.modelScores = [];
  if (!Array.isArray(state.profitEngine.adInsights)) state.profitEngine.adInsights = [];
  if (!Array.isArray(state.profitEngine.generatedScripts)) state.profitEngine.generatedScripts = [];
  if (!Array.isArray(state.profitEngine.externalSignals)) state.profitEngine.externalSignals = [];
  if (!Array.isArray(state.profitEngine.sourceStatuses)) state.profitEngine.sourceStatuses = [];
  if (!state.profitEngine.sourceHealth || typeof state.profitEngine.sourceHealth !== "object") state.profitEngine.sourceHealth = {};
  if (!Array.isArray(state.profitEngine.optimizerPolicies)) state.profitEngine.optimizerPolicies = [];
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

function scoreProfitModel(model, state, signals = [], config = {}) {
  const campaigns = state.campaigns || [];
  const products = state.products || [];
  const links = state.affiliateLinks || [];
  const posts = state.posts || [];
  const modelPostIds = new Set(posts.filter((post) => post.funnelRatio === model.id).map((post) => post.id));
  const attributedClicks = (state.clickEvents || []).filter((event) =>
    event.modelId === model.id || modelPostIds.has(event.postId)
  ).length;
  const attributedConversions = (state.conversionEvents || []).filter((event) =>
    event.modelId === model.id || modelPostIds.has(event.postId)
  );
  const attributedRevenue = attributedConversions
    .filter((event) => !["rejected", "refunded", "void", "cancelled"].includes(event.status))
    .reduce((total, event) => total + Number(event.commissionValue || 0), 0);
  const globalConversionCount = links.reduce((total, link) => total + Number(link.conversions || 0), 0);
  const globalClickCount = links.reduce((total, link) => total + Number(link.clicks || 0), 0);
  const globalRevenue = links.reduce((total, link) => total + Number(link.revenue || 0), 0);
  const conversionCount = attributedConversions.length || globalConversionCount;
  const clickCount = attributedClicks || globalClickCount;
  const revenue = attributedRevenue || globalRevenue;
  const activeCampaignBonus = campaigns.some((campaign) => campaign.status === "active") ? 6 : -8;
  const productBonus = products.some((product) => product.status === "active") ? 5 : -10;
  const signalBonus = Math.min(10, Math.round(clickCount / 30) + conversionCount);
  const revenueBonus = revenue > 0 ? 4 : 0;
  const modelFatigue = evaluateProfitModelFatigue(model.id, posts, config);
  const fatiguePenalty = Math.min(8, posts.filter((post) => post.funnelRatio === model.id).length) + modelFatigue.penalty;
  const marketSignalBonus = Math.min(12, signalMatchCount(model, signals) * 3);
  const score = modelFatigue.status === "blocked"
    ? 0
    : Math.max(0, Math.min(100,
      model.baseScore + activeCampaignBonus + productBonus + signalBonus + revenueBonus + marketSignalBonus - fatiguePenalty
    ));

  return { score, fatigue: modelFatigue };
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

function updateSourceHealth(engine, statuses, config) {
  const health = { ...(engine.sourceHealth || {}) };
  const now = Date.now();
  for (const status of statuses || []) {
    const id = status.id || status.name;
    if (!id) continue;
    const existing = health[id] || {};
    if (status.status === "connected") {
      health[id] = {
        ...existing,
        status: "connected",
        failureCount: 0,
        lastSuccessAt: nowIso(),
        lastError: "",
        nextRetryAt: "",
        backoffMs: 0
      };
      continue;
    }
    if (status.status === "error") {
      const failureCount = Number(existing.failureCount || 0) + 1;
      const backoffMs = Math.min(
        Number(config.adIntelligenceRetryMaxMs || 60 * 60_000),
        Number(config.adIntelligenceRetryBaseMs || 5 * 60_000) * (2 ** Math.max(0, failureCount - 1))
      );
      health[id] = {
        ...existing,
        status: "error",
        failureCount,
        lastError: status.message || "Source failed.",
        lastErrorAt: nowIso(),
        nextRetryAt: new Date(now + backoffMs).toISOString(),
        backoffMs
      };
      continue;
    }
    if (status.status === "backoff") {
      health[id] = {
        ...existing,
        status: "backoff",
        nextRetryAt: status.nextRetryAt || existing.nextRetryAt || "",
        lastError: status.lastError || existing.lastError || status.message || "",
        failureCount: Number(status.failureCount || existing.failureCount || 0),
        backoffMs: Number(existing.backoffMs || 0)
      };
      continue;
    }
    health[id] = {
      ...existing,
      status: status.status,
      lastObservedAt: nowIso()
    };
  }
  engine.sourceHealth = health;
  return health;
}

function mergeStatusHealth(statuses, sourceHealth) {
  return (statuses || []).map((status) => {
    const health = sourceHealth?.[status.id] || {};
    return {
      ...status,
      failureCount: Number(health.failureCount || status.failureCount || 0),
      nextRetryAt: health.nextRetryAt || status.nextRetryAt || "",
      lastSuccessAt: health.lastSuccessAt || "",
      lastErrorAt: health.lastErrorAt || "",
      backoffMs: Number(health.backoffMs || 0)
    };
  });
}

function buildSourceRecovery(sourceStatuses, sourceHealth) {
  const statuses = sourceStatuses || [];
  const connected = statuses.filter((source) => source.status === "connected").length;
  const backoff = statuses.filter((source) => source.status === "backoff").length;
  const errors = statuses.filter((source) => source.status === "error").length;
  const nextRetryAt = statuses
    .map((source) => source.nextRetryAt || sourceHealth?.[source.id]?.nextRetryAt || "")
    .filter(Boolean)
    .sort()[0] || "";
  const mode = errors > 0 ? "degraded" : backoff > 0 ? "cooling_down" : connected > 0 ? "healthy" : "setup";
  return {
    mode,
    connected,
    backoff,
    errors,
    nextRetryAt,
    total: statuses.length
  };
}

function updateIngestState(engine, intelligence, config) {
  if (!intelligence) return engine.externalSignals || [];
  const incoming = Array.isArray(intelligence.items) ? intelligence.items : [];
  engine.externalSignals = mergeExternalSignals(engine.externalSignals || [], incoming);
  const sourceHealth = updateSourceHealth(engine, intelligence.sourceStatuses || [], config);
  engine.sourceStatuses = mergeStatusHealth(Array.isArray(intelligence.sourceStatuses) ? intelligence.sourceStatuses : [], sourceHealth);
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

function optimizerGuidance(policy) {
  const mode = policy?.mode || "baseline";
  if (mode === "scale") return "這輪系統判斷這個角度已有成效，會延展相近 hook，但保留同一個 offer 證據。";
  if (mode === "bridge_rewrite") return "這輪系統偵測到有點擊但轉換不足，因此會把 CTA 與 offer bridge 寫得更清楚。";
  if (mode === "repair_guardrails") return "這輪系統會用更保守的合規寫法重生腳本，先修掉前一輪被擋的風險。";
  if (mode === "explore") return "這輪系統會補齊尚未測過的獲利模式，先取得第一批流量訊號。";
  return "";
}

function buildNaturalScripts(model, campaign, product, link, config, count, signal, policy = {}) {
  const cta = trackingUrl(config, link.slug);
  const disclosure = config.defaultDisclosureText;
  const market = signalSummary(signal);
  const observedAngle = market.angle || model.adAngle;
  const observedOffer = market.offer || product.offer;
  const observedTitle = market.title ? `「${market.title}」` : "這類工具";
  const sourceLine = signal
    ? `這輪參考 ${market.source} 看到的角度，但不照抄原廣告。`
    : "這輪先使用內建獲利 playbook，等外部 feed 接上後會自動改用市場訊號。";
  const optimizerLine = optimizerGuidance(policy);
  const strategyLine = optimizerLine ? `${sourceLine}\n\n${optimizerLine}` : sourceLine;
  const scripts = [
    {
      type: "pain_point",
      hook: `很多人做 ${campaign.name} 會先卡在工具太多，不知道從哪個開始。`,
      post: `${disclosure}：很多人做 ${campaign.name} 會先卡在工具太多，不知道從哪個開始。\n\n${strategyLine}\n\n我會先看一個小問題：這個工具能不能讓你今天少做一個重複步驟。\n\n${product.name} 的價值是「${observedOffer}」。先用小任務驗證，不要一開始就把整套流程買滿。\n\n延伸資源：${cta}\n\n你現在最想自動化的是內容、名單，還是成交追蹤？`
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

function normalizeForFreshness(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "")
    .trim();
}

function charShingles(value, size = 4) {
  const chars = Array.from(value);
  if (chars.length <= size) return new Set(value ? [value] : []);
  const shingles = new Set();
  for (let index = 0; index <= chars.length - size; index += 1) {
    shingles.add(chars.slice(index, index + size).join(""));
  }
  return shingles;
}

function similarityScore(a, b) {
  const left = charShingles(normalizeForFreshness(a));
  const right = charShingles(normalizeForFreshness(b));
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const item of left) {
    if (right.has(item)) overlap += 1;
  }
  return overlap / Math.max(left.size, right.size);
}

function findFreshnessConflict(post, posts, config) {
  const cutoff = Date.now() - Number(config.contentFreshnessLookbackDays || 14) * 24 * 60 * 60 * 1000;
  const threshold = Number(config.contentSimilarityThreshold || 0.88);
  const candidates = (posts || []).filter((item) => {
    if (item.id === post.id) return false;
    if (item.productId !== post.productId && item.campaignId !== post.campaignId) return false;
    if (![STATUS.draft, STATUS.needsReview, STATUS.approved, STATUS.scheduled, STATUS.containerCreated, STATUS.published, STATUS.simulated].includes(item.status)) return false;
    const createdAt = new Date(item.createdAt || item.scheduledAt || item.updatedAt || 0).getTime();
    return Number.isFinite(createdAt) && createdAt >= cutoff;
  });
  let best = null;
  for (const candidate of candidates) {
    const score = similarityScore(post.text, candidate.text);
    if (score >= threshold && (!best || score > best.score)) {
      best = { post: candidate, score };
    }
  }
  return best;
}

function guardAutonomousPost(post, config, existingPosts = []) {
  const repaired = repairPostText(post, config);
  const validation = validatePost(repaired, config);
  const fatigue = evaluateContentFatigue(repaired, existingPosts, config);
  const similarityReason = fatigue.reasons.find((reason) => reason.id === "similarity");
  const freshnessConflict = similarityReason ? {
    matchedPostId: similarityReason.matchedPostId,
    score: similarityReason.score
  } : null;
  const fatigueReasons = fatigue.reasons.map((reason) => reason.message);
  const blocked = !validation.valid || validation.risk.level === "high" || fatigue.status === "blocked";
  return {
    post: repaired,
    validation,
    fatigue,
    blocked,
    reason: blocked
      ? [...validation.errors, ...validation.risk.warnings, ...fatigueReasons].filter(Boolean).join(" ") || "High-risk or fatigued content was blocked."
      : "",
    freshness: freshnessConflict
  };
}

function createAutonomousPosts(state, config, model, campaign, product, link, scripts, autoApprove, options = {}) {
  const created = [];
  const blocked = [];
  const baseTime = Date.now();
  const baseTrackingUrl = trackingUrl(config, link.slug);
  const createdBy = String(options.createdBy || "").trim() || null;
  for (const script of scripts) {
    const scheduledAt = new Date(baseTime + (created.length + 1) * 45 * 60 * 1000).toISOString();
    const postId = makeId("post");
    const attributedUrl = trackingUrl(config, link.slug, {
      postId,
      modelId: model.id,
      campaignId: campaign.id,
      productId: product.id
    });
    const post = {
      id: postId,
      accountId: "acct_primary",
      campaignId: campaign.id,
      productId: product.id,
      affiliateLinkId: link.id,
      contentType: "自然推薦腳本",
      funnelRatio: model.id,
      hook: script.hook,
      cta: attributedUrl,
      riskNote: script.risk_note || "自動獲利引擎：有揭露聯盟關係，未承諾收益，使用問題式互動結尾。",
      topicTag: campaign.name.replace(/[.#&]/g, "").slice(0, 50),
      text: String(script.post || "").replaceAll(baseTrackingUrl, attributedUrl),
      status: STATUS.needsReview,
      approved: false,
      scheduledAt,
      createdBy,
      linkAttachment: attributedUrl,
      trackingCode: postId,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    const guarded = guardAutonomousPost(post, config, state.posts);
    if (guarded.blocked) {
      blocked.push({
        hook: script.hook,
        type: script.type,
        reason: guarded.reason,
        validation: guarded.validation,
        fatigue: guarded.fatigue,
        freshness: guarded.freshness,
        createdAt: nowIso()
      });
      continue;
    }
    prepareGeneratedPostForReview(guarded.post, config, {
      source: "profit_engine",
      createdBy,
      recentPosts: state.posts,
      autoApproveRequested: autoApprove === true
    });
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

function scoreModels(state, signals, config = {}) {
  return PROFIT_MODELS
    .map((model) => {
      const scored = scoreProfitModel(model, state, signals, config);
      const score = scored.score;
      return {
        ...model,
        rawScore: score,
        score,
        fatigue: scored.fatigue,
        optimizerAdjustment: 0,
        recommendation: scored.fatigue.status === "blocked" ? "blocked" : score >= 82 ? "primary" : "watch"
      };
    })
    .sort((a, b) => b.score - a.score);
}

function buildOptimizationQueue(experiments, signals) {
  const queue = [];
  for (const experiment of experiments) {
    if (experiment.blockedScriptCount > 0) {
      queue.push({
        priority: "high",
        modelId: experiment.modelId,
        title: "Repair blocked scripts",
        action: "Regenerate this model with stricter compliance prompts before the next publish cycle."
      });
      continue;
    }
    if (experiment.postCount === 0) {
      queue.push({
        priority: experiment.recommendation === "primary" ? "high" : "medium",
        modelId: experiment.modelId,
        title: "Seed first experiment",
        action: "Create natural scripts so this model can start collecting traffic and conversion evidence."
      });
      continue;
    }
    if (experiment.clicks >= 20 && experiment.conversions === 0) {
      queue.push({
        priority: "high",
        modelId: experiment.modelId,
        title: "Rewrite offer bridge",
        action: "Clicks exist without conversions; test a clearer CTA, proof point, or lower-friction offer."
      });
      continue;
    }
    if (experiment.conversions > 0 && experiment.score >= 82) {
      queue.push({
        priority: "medium",
        modelId: experiment.modelId,
        title: "Scale winning angle",
        action: "Allocate the next autonomy cycle to adjacent hooks while keeping the same offer proof."
      });
      continue;
    }
    if (experiment.scheduledCount > 0) {
      queue.push({
        priority: "low",
        modelId: experiment.modelId,
        title: "Wait for publish data",
        action: "Keep this variant active until scheduled posts gather enough click feedback."
      });
    }
  }
  if (!signals.length) {
    queue.unshift({
      priority: "high",
      modelId: "market_signals",
      title: "Connect market evidence",
      action: "Add ad or affiliate offer feeds so experiments optimize from real demand instead of built-in playbooks."
    });
  }
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  return queue
    .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
    .slice(0, 6);
}

function buildExperimentLoop(state, config, engine, scores) {
  const posts = state.posts || [];
  const linksById = new Map((state.affiliateLinks || []).map((link) => [link.id, link]));
  const clickEvents = state.clickEvents || [];
  const conversionEvents = state.conversionEvents || [];
  const signals = engine.externalSignals || [];
  const totalScore = scores.reduce((total, model) => total + Number(model.score || 0), 0) || 1;
  const runs = engine.runs || [];
  const experiments = scores.map((model, index) => {
    const modelPosts = posts.filter((post) => post.funnelRatio === model.id);
    const scheduledCount = modelPosts.filter((post) =>
      [STATUS.draft, STATUS.needsReview, STATUS.approved, STATUS.scheduled, STATUS.containerCreated].includes(post.status)
    ).length;
    const publishedCount = modelPosts.filter((post) => ["published", "simulated"].includes(post.status)).length;
    const linkIds = new Set(modelPosts.map((post) => post.affiliateLinkId).filter(Boolean));
    const modelLinks = [...linkIds].map((id) => linksById.get(id)).filter(Boolean);
    const postIds = new Set(modelPosts.map((post) => post.id));
    const attributedClicks = clickEvents.filter((event) =>
      event.modelId === model.id || postIds.has(event.postId)
    ).length;
    const attributedConversions = conversionEvents.filter((event) =>
      event.modelId === model.id || postIds.has(event.postId)
    );
    const fallbackClicks = modelLinks.reduce((total, link) => total + Number(link.clicks || 0), 0);
    const fallbackConversions = modelLinks.reduce((total, link) => total + Number(link.conversions || 0), 0);
    const fallbackRevenue = modelLinks.reduce((total, link) => total + Number(link.revenue || 0), 0);
    const clicks = attributedClicks || fallbackClicks;
    const conversions = attributedConversions.length || fallbackConversions;
    const revenue = attributedConversions.length
      ? attributedConversions
        .filter((event) => !["rejected", "refunded", "void", "cancelled"].includes(event.status))
        .reduce((total, event) => total + Number(event.commissionValue || 0), 0)
      : fallbackRevenue;
    const lastRun = runs.find((run) => run.selectedModelId === model.id) || null;
    const blockedScriptCount = runs
      .filter((run) => run.selectedModelId === model.id)
      .reduce((total, run) => total + Number(run.blockedScriptCount || 0), 0);
    const conversionRate = clicks ? Number(((conversions / clicks) * 100).toFixed(1)) : 0;
    const epc = clicks ? Number((revenue / clicks).toFixed(2)) : 0;
    const allocationPct = Math.max(index === 0 ? 25 : 8, Math.round((Number(model.score || 0) / totalScore) * 100));
    const status = blockedScriptCount > 0 && modelPosts.length === 0
      ? "blocked"
      : conversions > 0 && Number(model.score || 0) >= 82
        ? "scaling"
        : modelPosts.length > 0
          ? "learning"
          : index === 0
            ? "ready"
            : "watching";
    const nextAction = status === "blocked"
      ? "Regenerate safer scripts"
      : conversions > 0
        ? "Scale adjacent hooks"
        : clicks >= 20
          ? "Rewrite CTA bridge"
          : modelPosts.length > 0
            ? "Collect publish data"
            : "Seed first scripts";

    return {
      modelId: model.id,
      name: model.name,
      recommendation: model.recommendation,
      status,
      score: Number(model.score || 0),
      allocationPct,
      hypothesis: model.adAngle,
      stage: model.stage,
      monetization: model.monetization,
      postCount: modelPosts.length,
      scheduledCount,
      publishedCount,
      clicks,
      conversions,
      revenue,
      conversionRate,
      epc,
      blockedScriptCount,
      lastRunAt: lastRun?.createdAt || null,
      nextAction
    };
  });
  const leader = experiments[0] || null;
  const totalExperimentPosts = experiments.reduce((total, item) => total + item.postCount, 0);
  const totalExperimentRevenue = experiments.reduce((total, item) => total + item.revenue, 0);
  const confidence = leader?.conversions > 0
    ? "revenue-backed"
    : leader?.clicks > 0
      ? "traffic-backed"
      : engine.lastRunAt
        ? "model-backed"
        : "setup";

  return {
    loopState: config.autonomyMode ? "autonomous" : "manual",
    confidence,
    activeExperimentCount: experiments.filter((item) => ["ready", "learning", "scaling"].includes(item.status)).length,
    totalExperimentPosts,
    totalExperimentRevenue,
    leaderModelId: leader?.modelId || "",
    leaderName: leader?.name || "No experiment selected",
    learningVelocity: `${runs.length} run(s) · ${signals.length} signal(s)`,
    experiments,
    optimizationQueue: buildOptimizationQueue(experiments, signals)
  };
}

function buildOptimizerPolicy(experimentLoop, scores, signals, config) {
  const queue = experimentLoop.optimizationQueue || [];
  const actionable = queue.find((item) => item.modelId !== "market_signals" && item.title !== "Wait for publish data")
    || queue.find((item) => item.modelId !== "market_signals")
    || null;
  const targetModelId = actionable?.modelId || scores[0]?.id || "";
  const scoreAdjustments = {};
  let mode = "baseline";
  let scriptCountDelta = 0;
  let guardrailMode = "standard";
  const reasons = [];

  if (!signals.length) {
    reasons.push("No external market signals are connected yet, so the optimizer keeps a market-evidence task open.");
  }

  if (actionable) {
    reasons.push(actionable.action);
    if (actionable.title === "Scale winning angle") {
      mode = "scale";
      scoreAdjustments[targetModelId] = 8;
      scriptCountDelta = 1;
    } else if (actionable.title === "Rewrite offer bridge") {
      mode = "bridge_rewrite";
      scoreAdjustments[targetModelId] = 7;
    } else if (actionable.title === "Repair blocked scripts") {
      mode = "repair_guardrails";
      scoreAdjustments[targetModelId] = 4;
      guardrailMode = "strict";
      scriptCountDelta = -1;
    } else if (actionable.title === "Seed first experiment") {
      mode = "explore";
      scoreAdjustments[targetModelId] = 6;
    }
  } else {
    reasons.push("No urgent experiment action is pending; continue with the highest scoring model.");
  }

  return {
    id: makeId("optimizer"),
    mode,
    targetModelId,
    targetAction: actionable?.title || "Continue leader",
    scoreAdjustments,
    scriptCountDelta,
    guardrailMode,
    marketSignalGap: !signals.length,
    reasons,
    createdAt: nowIso()
  };
}

function applyOptimizerPolicy(scores, policy) {
  const adjusted = scores.map((model) => {
    const adjustment = Number(policy.scoreAdjustments?.[model.id] || 0);
    const score = Math.max(0, Math.min(100, Number(model.rawScore ?? model.score ?? 0) + adjustment));
    return {
      ...model,
      score,
      optimizerAdjustment: adjustment,
      recommendation: score >= 82 ? "primary" : "watch"
    };
  });
  return adjusted.sort((a, b) => b.score - a.score);
}

function activeProductForModel(state, model, signal) {
  if (signal?.id) {
    const signalProduct = (state.products || []).find((product) => product.sourceSignalId === signal.id);
    if (signalProduct) return signalProduct;
  }
  const text = [
    model.name,
    model.stage,
    model.monetization,
    model.audienceSignal,
    model.adAngle,
    signal?.title,
    signal?.productName,
    signal?.offer
  ].filter(Boolean).join(" ").toLowerCase();
  return (state.products || []).find((product) =>
    product.status === "active" && text.includes(String(product.name || "").toLowerCase())
  ) || (state.products || []).find((product) => product.status === "active")
    || (state.products || [])[0]
    || null;
}

function linkForProduct(state, product) {
  if (!product) return null;
  return (state.affiliateLinks || []).find((link) => link.productId === product.id) || null;
}

function opportunityPriority(score, queueItem) {
  if (queueItem?.priority === "high" || score >= 88) return "high";
  if (queueItem?.priority === "medium" || score >= 74) return "medium";
  return "watch";
}

function buildOpportunityEvidence(experiment, model, signal, product, link) {
  const evidence = [
    `model score ${Number(model.score || 0)}`,
    `${Number(experiment?.clicks || 0)} clicks`,
    `${Number(experiment?.conversions || 0)} conversions`
  ];
  if (Number(experiment?.revenue || 0) > 0) evidence.push(`$${Number(experiment.revenue || 0)} revenue`);
  if (signal) evidence.push(`${signal.kind || "signal"} from ${signal.source || "feed"}`);
  if (product) evidence.push(`offer ${product.name || product.id}`);
  if (link) evidence.push(`tracking ${link.slug}`);
  return evidence.slice(0, 5);
}

function buildProfitOpportunities(state, config, engine, scores, experimentLoop) {
  const signals = engine.externalSignals || [];
  const queue = experimentLoop.optimizationQueue || [];
  const experimentsByModel = new Map((experimentLoop.experiments || []).map((experiment) => [experiment.modelId, experiment]));
  const opportunities = scores.slice(0, 4).map((model, index) => {
    const experiment = experimentsByModel.get(model.id) || {};
    const signal = pickSignalForModel(model, signals);
    const product = activeProductForModel(state, model, signal);
    const link = linkForProduct(state, product);
    const queueItem = queue.find((item) => item.modelId === model.id);
    const marketBoost = signal ? 8 : 0;
    const revenueBoost = Number(experiment.revenue || 0) > 0 ? 10 : Number(experiment.conversions || 0) > 0 ? 7 : 0;
    const urgencyBoost = queueItem?.priority === "high" ? 8 : queueItem?.priority === "medium" ? 4 : 0;
    const guardrailPenalty = Number(experiment.blockedScriptCount || 0) > 0 ? 8 : 0;
    const score = Math.max(1, Math.min(100, Math.round(
      Number(model.score || 0) * 0.74 + marketBoost + revenueBoost + urgencyBoost - guardrailPenalty
    )));
    const automationAction = queueItem?.title
      || (Number(experiment.conversions || 0) > 0 ? "Scale winning angle" : signal ? "Generate market-backed scripts" : "Seed first experiment");
    const expectedImpact = Number(experiment.conversions || 0) > 0
      ? "Scale revenue-backed hooks while preserving the current offer proof."
      : signal
        ? "Turn live market evidence into natural scripts and collect conversion feedback."
        : "Start a controlled baseline so the optimizer has traffic data to learn from.";

    return {
      id: stableId("opp", `${model.id}:${signal?.id || "built_in"}:${product?.id || "no_product"}:${automationAction}`),
      rank: index + 1,
      priority: opportunityPriority(score, queueItem),
      score,
      modelId: model.id,
      modelName: model.name,
      offerId: product?.id || "",
      offerName: product?.name || "No active offer",
      offerNetwork: product?.network || "",
      signalId: signal?.id || "",
      signalSource: signal?.source || "built-in playbook",
      signalTitle: signal?.title || signal?.productName || model.adAngle,
      automationAction,
      expectedImpact,
      guardrailState: Number(experiment.blockedScriptCount || 0) > 0 ? "strict_repair" : link ? "ready" : "needs_tracking_link",
      experimentStatus: experiment.status || "setup",
      allocationPct: Number(experiment.allocationPct || 0),
      conversionRate: Number(experiment.conversionRate || 0),
      epc: Number(experiment.epc || 0),
      evidence: buildOpportunityEvidence(experiment, model, signal, product, link),
      runRequest: {
        path: "/api/profit-engine/run",
        method: "POST",
        body: {
          source: "opportunity_scanner",
          force: true,
          createPosts: true,
          autoApprove: true
        }
      }
    };
  });

  const marketGap = !signals.length ? [{
    id: "opp_market_evidence",
    rank: 0,
    priority: "high",
    score: 86,
    modelId: "market_signals",
    modelName: "Market evidence intake",
    offerId: "",
    offerName: "Ad and offer feeds",
    offerNetwork: "",
    signalId: "",
    signalSource: "connector center",
    signalTitle: "No external ad or offer signals are connected yet.",
    automationAction: "Connect market evidence",
    expectedImpact: "Unlock autonomous research from real demand instead of built-in playbooks.",
    guardrailState: "setup",
    experimentStatus: "setup",
    allocationPct: 0,
    conversionRate: 0,
    epc: 0,
    evidence: ["0 external signals", "custom ad feed or affiliate offer feed needed"],
    runRequest: null
  }] : [];

  const ranked = [...marketGap, ...opportunities]
    .sort((a, b) => b.score - a.score)
    .map((item, index) => ({ ...item, rank: index + 1 }))
    .slice(0, 5);
  const top = ranked[0] || null;
  return {
    generatedAt: nowIso(),
    mode: config.autonomyMode ? "autonomous" : "manual",
    confidence: experimentLoop.confidence || "setup",
    opportunityCount: ranked.length,
    topScore: top?.score || 0,
    nextAction: top?.automationAction || "Run profit engine",
    opportunities: ranked
  };
}

function buildProfitRunPreview(state, config, options = {}) {
  const previewState = JSON.parse(JSON.stringify(state));
  const engine = ensureProfitState(previewState);
  const signals = updateIngestState(engine, options.intelligence, config);
  if (shouldSkipRun(engine, config, options.force)) {
    return {
      skipped: true,
      reason: "Autonomy interval has not elapsed.",
      lastRunAt: engine.lastRunAt
    };
  }
  const offerSync = syncOffersFromSignals(previewState, config, signals);
  const rawScores = scoreModels(previewState, signals, config);
  const rawExperimentLoop = buildExperimentLoop(previewState, config, engine, rawScores);
  const optimizerPolicy = buildOptimizerPolicy(rawExperimentLoop, rawScores, signals, config);
  const scores = applyOptimizerPolicy(rawScores, optimizerPolicy);
  const selected = scores[0];
  const selectedSignal = pickSignalForModel(selected, signals);
  const { campaign, product } = pickActiveContext(previewState, selectedSignal, offerSync.syncedProducts);
  const link = ensureAffiliateLink(previewState, campaign, product, config);
  const count = Math.max(1, Math.min(Number(config.autonomyMaxScriptsPerRun || 3) + Number(optimizerPolicy.scriptCountDelta || 0), 5));
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
    optimizerPolicy,
    externalSignalCount: signals.length,
    syncedProductIds: offerSync.syncedProducts.map((item) => item.id)
  };
}

function runProfitEngine(state, config, options = {}) {
  const engine = ensureProfitState(state);
  const signals = updateIngestState(engine, options.intelligence, config);
  const offerSync = syncOffersFromSignals(state, config, signals);
  if (shouldSkipRun(engine, config, options.force)) {
    return {
      skipped: true,
      reason: "Autonomy interval has not elapsed.",
      profitEngine: buildProfitDashboard(state, config)
    };
  }

  const rawScores = scoreModels(state, signals, config);
  const rawExperimentLoop = buildExperimentLoop(state, config, engine, rawScores);
  const optimizerPolicy = buildOptimizerPolicy(rawExperimentLoop, rawScores, signals, config);
  const scores = applyOptimizerPolicy(rawScores, optimizerPolicy);
  const selected = scores[0];
  const selectedSignal = pickSignalForModel(selected, signals);
  const { campaign, product } = pickActiveContext(state, selectedSignal, offerSync.syncedProducts);
  const link = ensureAffiliateLink(state, campaign, product, config);
  const count = Math.max(1, Math.min(Number(config.autonomyMaxScriptsPerRun || 3) + Number(optimizerPolicy.scriptCountDelta || 0), 5));
  const cta = trackingUrl(config, link.slug);
  const aiScripts = normalizeScriptOverrides(options.aiScripts, config, cta, count);
  const scripts = aiScripts.length
    ? aiScripts
    : buildNaturalScripts(selected, campaign, product, link, config, count, selectedSignal, optimizerPolicy);
  const scriptSource = aiScripts.length ? (options.aiScriptSource || "openai") : "template";
  const postPlan = options.createPosts === false
    ? { created: [], blocked: [] }
    : createAutonomousPosts(
      state,
      config,
      selected,
      campaign,
      product,
      link,
      scripts,
      options.autoApprove !== false,
      { createdBy: options.createdBy }
    );
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
    optimizerPolicy,
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
  const experimentLoop = buildExperimentLoop(state, config, engine, scores);
  run.experimentSnapshot = {
    leaderModelId: selected.id,
    activeExperimentCount: experimentLoop.activeExperimentCount,
    optimizationActionCount: experimentLoop.optimizationQueue.length,
    optimizerMode: optimizerPolicy.mode,
    optimizerTargetModelId: optimizerPolicy.targetModelId
  };
  engine.optimizerPolicies.unshift(optimizerPolicy);
  engine.adInsights = engine.adInsights.slice(0, 12);
  engine.generatedScripts = engine.generatedScripts.slice(0, 12);
  engine.runs = engine.runs.slice(0, 12);
  engine.optimizerPolicies = engine.optimizerPolicies.slice(0, 12);
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
    : scoreModels(state, signals, config);
  const scheduledAutonomyPosts = (state.posts || []).filter((post) =>
    post.contentType === "自然推薦腳本"
      && [STATUS.draft, STATUS.needsReview, STATUS.approved, STATUS.scheduled].includes(post.status)
  ).length;
  const syncedOfferProducts = (state.products || []).filter((product) => product.sourceSignalId);
  const statusById = new Map((engine.sourceStatuses || []).map((status) => [status.id, status]));
  const sources = AD_SOURCES.map((source) => {
    const status = statusById.get(source.id);
    const health = engine.sourceHealth?.[source.id] || {};
    return {
      ...source,
      runtimeStatus: status?.status || source.status,
      message: status?.message || "",
      count: status?.count || 0,
      failureCount: Number(health.failureCount || status?.failureCount || 0),
      nextRetryAt: health.nextRetryAt || status?.nextRetryAt || "",
      lastSuccessAt: health.lastSuccessAt || "",
      lastError: health.lastError || ""
    };
  });
  const sourceStatuses = mergeStatusHealth(engine.sourceStatuses || [], engine.sourceHealth || {});
  const experimentLoop = buildExperimentLoop(state, config, engine, scores);
  const opportunityScanner = buildProfitOpportunities(state, config, engine, scores, experimentLoop);

  return {
    autonomyEnabled: Boolean(config.autonomyMode),
    objective: engine.objective,
    lastRunAt: engine.lastRunAt,
    lastIngestAt: engine.lastIngestAt,
    nextRunHint: config.autonomyMode ? `${Math.round((config.autonomyIntervalMs || 0) / 60000)} 分鐘循環` : "手動",
    sources,
    sourceStatuses,
    sourceHealth: engine.sourceHealth || {},
    sourceRecovery: buildSourceRecovery(sourceStatuses, engine.sourceHealth || {}),
    externalSignals: signals.slice(0, 8),
    experiments: experimentLoop,
    opportunityScanner,
    optimizer: {
      latestPolicy: engine.optimizerPolicies[0] || engine.runs.find((run) => run.optimizerPolicy)?.optimizerPolicy || null,
      policyHistory: engine.optimizerPolicies.slice(0, 5),
      adjustedModelCount: scores.filter((model) => Number(model.optimizerAdjustment || 0) !== 0).length
    },
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
      `自動封鎖 ${Number(config.contentFreshnessLookbackDays || 14)} 天內高度相似的腳本。`,
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
  buildExperimentLoop,
  ensureProfitState,
  runProfitEngine
};

const crypto = require("node:crypto");

const { isDemoNetwork, isPlaceholderUrl } = require("./offerQuality");

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function cleanText(value, maxLength = 160) {
  return String(value || "").trim().slice(0, maxLength);
}

function requiredText(value, field, maxLength) {
  const normalized = cleanText(value, maxLength);
  if (normalized) return normalized;
  const error = new Error(`${field} is required.`);
  error.statusCode = 400;
  throw error;
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

function normalizeTargetUrl(value) {
  const raw = requiredText(value, "targetUrl", 2048);
  let url;
  try {
    url = new URL(raw);
  } catch {
    const error = new Error("targetUrl must be a valid HTTPS affiliate URL.");
    error.statusCode = 400;
    throw error;
  }
  if (url.protocol !== "https:" || isPlaceholderUrl(url.toString())) {
    const error = new Error("targetUrl must be a public HTTPS affiliate URL, not a demo or local URL.");
    error.statusCode = 400;
    throw error;
  }
  return url.toString();
}

function normalizeSubIdParam(value) {
  if (value === null || value === false || String(value || "").trim().toLowerCase() === "none") return "";
  const normalized = cleanText(value || "subid", 64);
  if (!/^[a-zA-Z0-9_.-]+$/.test(normalized)) {
    const error = new Error("subIdParam may only contain letters, numbers, dot, underscore, or hyphen.");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizedName(value) {
  return String(value || "").trim().toLocaleLowerCase("en-US");
}

function publicTrackingUrl(config, slug) {
  return `${String(config.publicBaseUrl || "").replace(/\/$/, "")}/r/${slug}`;
}

function upsertRealOffer(state, input, config) {
  const campaignName = requiredText(input.campaignName, "campaignName", 120);
  const targetPersona = requiredText(input.targetPersona, "targetPersona", 240);
  const productName = requiredText(input.productName, "productName", 160);
  const network = requiredText(input.network, "network", 120);
  const targetUrl = normalizeTargetUrl(input.targetUrl);
  if (isDemoNetwork(network)) {
    const error = new Error("network must identify a real affiliate program.");
    error.statusCode = 400;
    throw error;
  }

  const commissionValue = Number(input.commissionValue || 0);
  if (!Number.isFinite(commissionValue) || commissionValue < 0) {
    const error = new Error("commissionValue must be zero or greater.");
    error.statusCode = 400;
    throw error;
  }

  const now = nowIso();
  let campaign = input.campaignId
    ? (state.campaigns || []).find((item) => item.id === input.campaignId)
    : (state.campaigns || []).find((item) => normalizedName(item.name) === normalizedName(campaignName));
  if (input.campaignId && !campaign) {
    const error = new Error("Campaign not found.");
    error.statusCode = 404;
    throw error;
  }
  const campaignCreated = !campaign;
  campaign ||= {
    id: makeId("cmp"),
    createdAt: now
  };
  Object.assign(campaign, {
    name: campaignName,
    status: "active",
    niche: cleanText(input.niche || "affiliate", 80),
    targetPersona,
    dailyBudgetPosts: Math.max(1, Math.min(Number(input.dailyBudgetPosts || 3), 20)),
    disclosureRequired: true,
    source: "affiliate",
    isDemo: false,
    updatedAt: now
  });
  if (campaignCreated) state.campaigns.push(campaign);

  let product = input.productId
    ? (state.products || []).find((item) => item.id === input.productId)
    : (state.products || []).find((item) =>
        item.campaignId === campaign.id && normalizedName(item.name) === normalizedName(productName)
      );
  if (input.productId && !product) {
    const error = new Error("Product not found.");
    error.statusCode = 404;
    throw error;
  }
  const productCreated = !product;
  product ||= {
    id: makeId("prd"),
    campaignId: campaign.id,
    createdAt: now
  };
  Object.assign(product, {
    campaignId: campaign.id,
    name: productName,
    offer: cleanText(input.offer || productName, 500),
    network,
    commissionModel: cleanText(input.commissionModel || "CPS", 20).toUpperCase(),
    commissionValue,
    currency: cleanText(input.currency || "USD", 12).toUpperCase(),
    landingUrl: targetUrl,
    status: "active",
    source: "affiliate",
    isDemo: false,
    updatedAt: now
  });
  if (productCreated) state.products.push(product);

  const slug = slugify(input.slug || `${campaign.name}-${product.name}`);
  let link = (state.affiliateLinks || []).find((item) => item.slug === slug)
    || (state.affiliateLinks || []).find((item) => item.productId === product.id && item.targetUrl === targetUrl);
  if (link && link.productId !== product.id) {
    const error = new Error("This tracking slug is already used by another product.");
    error.statusCode = 409;
    throw error;
  }
  const linkCreated = !link;
  link ||= {
    id: makeId("aff"),
    clicks: 0,
    conversions: 0,
    revenue: 0,
    createdAt: now
  };
  Object.assign(link, {
    slug,
    campaignId: campaign.id,
    productId: product.id,
    network,
    targetUrl,
    subIdParam: normalizeSubIdParam(input.subIdParam),
    appendUtm: input.appendUtm === true,
    source: "affiliate",
    isDemo: false,
    currency: product.currency === "PERCENT" ? "USD" : product.currency,
    updatedAt: now
  });
  if (linkCreated) state.affiliateLinks.push(link);

  state.events.unshift({
    id: makeId("evt"),
    type: linkCreated ? "offer.created" : "offer.updated",
    campaignId: campaign.id,
    productId: product.id,
    affiliateLinkId: link.id,
    createdAt: now
  });

  return {
    campaign,
    product,
    link,
    trackingUrl: publicTrackingUrl(config, link.slug),
    created: {
      campaign: campaignCreated,
      product: productCreated,
      link: linkCreated
    }
  };
}

module.exports = { upsertRealOffer };

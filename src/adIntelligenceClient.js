const crypto = require("node:crypto");

const DEFAULT_META_FIELDS = [
  "id",
  "page_id",
  "page_name",
  "ad_snapshot_url",
  "ad_creative_bodies",
  "ad_creative_link_titles",
  "ad_creative_link_descriptions",
  "ad_delivery_start_time"
].join(",");

function nowIso() {
  return new Date().toISOString();
}

function hashId(prefix, value) {
  const digest = crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
  return `${prefix}_${digest}`;
}

function firstValue(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstValue(...value);
      if (nested) return nested;
      continue;
    }
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function parseList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function stripSensitiveParams(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    for (const key of ["access_token", "token", "api_key", "apikey", "key"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return String(value);
  }
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["items", "offers", "ads", "data", "results"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [payload];
}

function numericValue(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function sourceNameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "custom_feed";
  }
}

function normalizeFeedItem(item, source, kind) {
  const title = firstValue(
    item.title,
    item.name,
    item.productName,
    item.product_name,
    item.page_name,
    item.brand
  );
  const angle = firstValue(
    item.angle,
    item.hook,
    item.adCopy,
    item.ad_copy,
    item.description,
    item.offer,
    item.body
  );
  const landingUrl = stripSensitiveParams(firstValue(
    item.landingUrl,
    item.landing_url,
    item.url,
    item.targetUrl,
    item.target_url
  ));
  const commissionValue = numericValue(item.commissionValue, item.commission_value, item.payout, item.epc);
  const idSeed = firstValue(item.id, item.sourceId, item.source_id, title, angle, landingUrl, JSON.stringify(item));

  return {
    id: hashId(kind === "offer" ? "offer" : "ad", `${source}:${idSeed}`),
    sourceId: kind === "offer" ? "affiliate_offer_feed" : "custom_ad_feed",
    source,
    kind,
    title: title || (kind === "offer" ? "Affiliate offer" : "Ad signal"),
    pageName: firstValue(item.pageName, item.page_name, item.brand),
    angle: angle || "Market signal available; review before publishing.",
    cta: firstValue(item.cta, item.callToAction, item.call_to_action),
    adSnapshotUrl: stripSensitiveParams(firstValue(item.adSnapshotUrl, item.ad_snapshot_url, item.snapshotUrl)),
    landingUrl,
    productName: firstValue(item.productName, item.product_name, item.name, title),
    offer: firstValue(item.offer, item.payoutDescription, item.payout_description, item.description),
    commissionModel: firstValue(item.commissionModel, item.commission_model, item.model),
    commissionValue,
    currency: firstValue(item.currency, "USD"),
    scoreSignal: numericValue(item.scoreSignal, item.score, item.epc, commissionValue),
    observedAt: firstValue(item.observedAt, item.observed_at, item.updatedAt, item.updated_at, nowIso())
  };
}

function normalizeMetaAd(item) {
  const title = firstValue(item.ad_creative_link_titles, item.page_name, item.page_id, item.id);
  const angle = firstValue(
    item.ad_creative_bodies,
    item.ad_creative_link_descriptions,
    item.body,
    "Ad Library signal"
  );
  const idSeed = firstValue(item.id, item.ad_archive_id, item.ad_snapshot_url, title, angle);
  return {
    id: hashId("meta_ad", idSeed),
    sourceId: "meta_ad_library",
    source: "Meta Ad Library",
    kind: "ad",
    title: title || "Meta ad signal",
    pageName: firstValue(item.page_name),
    angle,
    cta: "Study the hook, then rewrite truthfully.",
    adSnapshotUrl: stripSensitiveParams(item.ad_snapshot_url),
    landingUrl: "",
    productName: "",
    offer: "",
    commissionModel: "",
    commissionValue: 0,
    currency: "USD",
    scoreSignal: 8,
    observedAt: firstValue(item.ad_delivery_start_time, nowIso())
  };
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  if (typeof fetchImpl !== "function") {
    const error = new Error("fetch is not available in this runtime.");
    error.statusCode = "fetch_unavailable";
    throw error;
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller?.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status || "error"}`);
    }
    if (typeof response.json === "function") return response.json();
    const text = await response.text();
    return JSON.parse(text);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collectFeed(url, kind, fetchImpl, config) {
  try {
    const payload = await fetchJson(url, fetchImpl, config.adIntelligenceTimeoutMs);
    const source = sourceNameFromUrl(url);
    const items = extractItems(payload).map((item) => normalizeFeedItem(item, source, kind));
    return {
      items,
      status: {
        id: kind === "offer" ? "affiliate_offer_feed" : "custom_ad_feed",
        name: kind === "offer" ? "Affiliate offer feed" : "Custom ad feed",
        status: "connected",
        count: items.length,
        message: `${items.length} item(s) ingested from ${source}`
      }
    };
  } catch (error) {
    return {
      items: [],
      status: {
        id: kind === "offer" ? "affiliate_offer_feed" : "custom_ad_feed",
        name: kind === "offer" ? "Affiliate offer feed" : "Custom ad feed",
        status: "error",
        count: 0,
        message: `${sourceNameFromUrl(url)}: ${error.message}`
      }
    };
  }
}

function buildMetaAdLibraryUrl(config) {
  const base = String(config.metaGraphBase || "https://graph.facebook.com/v25.0").replace(/\/$/, "");
  const url = new URL(`${base}/ads_archive`);
  url.searchParams.set("fields", config.metaAdLibraryFields || DEFAULT_META_FIELDS);
  url.searchParams.set("search_terms", config.metaAdLibraryQuery);
  url.searchParams.set("ad_reached_countries", JSON.stringify(config.metaAdLibraryCountries || ["US"]));
  url.searchParams.set("ad_type", config.metaAdLibraryAdType || "ALL");
  url.searchParams.set("limit", String(Math.max(1, Math.min(Number(config.metaAdLibraryLimit || 10), 50))));
  url.searchParams.set("access_token", config.metaAdLibraryAccessToken);
  return url;
}

async function collectMetaAdLibrary(config, fetchImpl) {
  if (!config.metaAdLibraryAccessToken || !config.metaAdLibraryQuery) {
    return {
      items: [],
      status: {
        id: "meta_ad_library",
        name: "Meta Ad Library",
        status: "missing_credentials",
        count: 0,
        message: "Set META_AD_LIBRARY_ACCESS_TOKEN and META_AD_LIBRARY_QUERY to ingest live ads."
      }
    };
  }

  try {
    const url = buildMetaAdLibraryUrl(config);
    const payload = await fetchJson(url.toString(), fetchImpl, config.adIntelligenceTimeoutMs);
    const items = extractItems(payload).map(normalizeMetaAd);
    return {
      items,
      status: {
        id: "meta_ad_library",
        name: "Meta Ad Library",
        status: "connected",
        count: items.length,
        message: `${items.length} ad(s) matched "${config.metaAdLibraryQuery}".`
      }
    };
  } catch (error) {
    return {
      items: [],
      status: {
        id: "meta_ad_library",
        name: "Meta Ad Library",
        status: "error",
        count: 0,
        message: error.message
      }
    };
  }
}

function dedupeItems(items, maxItems) {
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const key = item.id || `${item.source}:${item.title}:${item.angle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= maxItems) break;
  }
  return deduped;
}

async function collectAdIntelligence(config, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const adFeedUrls = config.adIntelligenceFeedUrls || [];
  const offerFeedUrls = config.affiliateOfferFeedUrls || [];
  const maxItems = Math.max(1, Math.min(Number(config.adIntelligenceMaxItems || 24), 100));

  const results = [];
  for (const url of adFeedUrls) {
    results.push(await collectFeed(url, "ad", fetchImpl, config));
  }
  for (const url of offerFeedUrls) {
    results.push(await collectFeed(url, "offer", fetchImpl, config));
  }
  results.push(await collectMetaAdLibrary(config, fetchImpl));

  const sourceStatuses = results.map((result) => result.status);
  if (!adFeedUrls.length) {
    sourceStatuses.push({
      id: "custom_ad_feed",
      name: "Custom ad feed",
      status: "not_configured",
      count: 0,
      message: "Set AD_INTELLIGENCE_FEED_URLS to ingest custom ad signals."
    });
  }
  if (!offerFeedUrls.length) {
    sourceStatuses.push({
      id: "affiliate_offer_feed",
      name: "Affiliate offer feed",
      status: "not_configured",
      count: 0,
      message: "Set AFFILIATE_OFFER_FEED_URLS to ingest commission and EPC signals."
    });
  }

  return {
    collectedAt: nowIso(),
    items: dedupeItems(results.flatMap((result) => result.items), maxItems),
    sourceStatuses
  };
}

module.exports = {
  DEFAULT_META_FIELDS,
  buildMetaAdLibraryUrl,
  collectAdIntelligence,
  normalizeFeedItem,
  normalizeMetaAd,
  parseList,
  stripSensitiveParams
};

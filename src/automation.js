const crypto = require("node:crypto");

const { validatePost } = require("./validators");
const { createTextContainer, publishContainer } = require("./threadsClient");
const { buildPrompt, generatePromptDrafts } = require("./contentTemplates");
const { generateOpenAIDrafts, shouldUseOpenAI } = require("./openaiClient");
const { buildProfitDashboard } = require("./profitEngine");

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
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

function trackingUrl(config, slug) {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/r/${slug}`;
}

function sum(items, picker) {
  return items.reduce((total, item) => total + Number(picker(item) || 0), 0);
}

function findById(items, id) {
  return items.find((item) => item.id === id);
}

function buildDashboard(state, config) {
  const posts = state.posts;
  const affiliateLinks = state.affiliateLinks;
  const published = posts.filter((post) => post.status === "published");
  const simulated = posts.filter((post) => post.status === "simulated");
  const queued = posts.filter((post) => ["scheduled", "container_created"].includes(post.status));
  const blocked = posts.filter((post) => ["failed", "blocked_credentials"].includes(post.status));
  const disclosureCovered = posts.filter((post) => {
    const text = post.text || "";
    return text.includes(config.defaultDisclosureText) || /#ad\b/i.test(text);
  }).length;

  return {
    generatedAt: nowIso(),
    runtime: {
      dryRun: config.threadsDryRun,
      publicBaseUrl: config.publicBaseUrl,
      workerEnabled: config.enableWorker,
      graphBase: config.threadsGraphBase,
      hasThreadsCredentials: Boolean(config.threadsUserId && config.threadsAccessToken),
      aiDraftProvider: config.aiDraftProvider,
      hasOpenAIApiKey: Boolean(config.openaiApiKey),
      autonomyMode: config.autonomyMode
    },
    metrics: {
      drafts: posts.filter((post) => post.status === "draft").length,
      queued: queued.length,
      published: published.length,
      simulated: simulated.length,
      blocked: blocked.length,
      clicks: sum(affiliateLinks, (link) => link.clicks),
      conversions: sum(affiliateLinks, (link) => link.conversions),
      revenue: sum(affiliateLinks, (link) => link.revenue),
      disclosureCoverage: posts.length ? Math.round((disclosureCovered / posts.length) * 100) : 100
    },
    campaigns: state.campaigns,
    products: state.products,
    affiliateLinks: state.affiliateLinks.map((link) => ({
      ...link,
      trackingUrl: trackingUrl(config, link.slug)
    })),
    posts: posts
      .slice()
      .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)))
      .map((post) => ({
        ...post,
        validation: validatePost(post, config)
      })),
    automationRuns: state.automationRuns.slice(0, 10),
    recentEvents: state.events.slice(0, 12),
    clickEvents: state.clickEvents.slice(0, 8),
    conversionEvents: state.conversionEvents.slice(0, 8),
    promptTemplate: buildPrompt("AI 自動化聯盟行銷"),
    profitEngine: buildProfitDashboard(state, config),
    settings: state.settings
  };
}

function ensureLinkForProduct(state, product, campaign, config) {
  let link = state.affiliateLinks.find((item) => item.productId === product.id);
  if (link) return link;

  const slug = slugify(`${campaign.name}-${product.name}`);
  const url = new URL(product.landingUrl);
  url.searchParams.set("utm_source", config.defaultUtmSource);
  url.searchParams.set("utm_medium", config.defaultUtmMedium);
  url.searchParams.set("utm_campaign", campaign.id);
  url.searchParams.set("utm_content", product.id);

  link = {
    id: makeId("aff"),
    slug,
    campaignId: campaign.id,
    productId: product.id,
    network: product.network,
    targetUrl: url.toString(),
    clicks: 0,
    conversions: 0,
    revenue: 0,
    currency: product.currency === "percent" ? "USD" : product.currency,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  state.affiliateLinks.push(link);
  return link;
}

function renderTemplate(product, campaign, link, config, index) {
  const cta = trackingUrl(config, link.slug);
  const variants = [
    `${config.defaultDisclosureText}：${product.name} 適合${campaign.targetPersona}，重點是「${product.offer}」。我會先從這裡開始看：${cta}`,
    `${config.defaultDisclosureText}：如果你正在處理${campaign.name}，可以先用一個小測試驗證需求。${product.name} 的賣點是 ${product.offer}。連結：${cta}`,
    `${config.defaultDisclosureText}：今天的推薦不是要你多買東西，而是少踩一次坑。${product.name} 可以幫你做到：${product.offer}。${cta}`
  ];
  return variants[index % variants.length];
}

function createDraftPosts(state, input, config, drafts, campaign, product, link, topic) {
  const now = new Date();
  const created = [];
  for (const draft of drafts) {
    const scheduled = new Date(now.getTime() + (created.length + 1) * 60 * 60 * 1000);
    const isConversion = draft.ratio === "conversion";
    const post = {
      id: makeId("post"),
      accountId: "acct_primary",
      campaignId: campaign.id,
      productId: product.id,
      affiliateLinkId: link.id,
      contentType: draft.type,
      funnelRatio: draft.ratio,
      hook: draft.hook,
      cta: draft.cta,
      riskNote: draft.risk_note,
      topicTag: String(topic).replace(/[.#&]/g, "").slice(0, 50),
      text: draft.post,
      status: input.autoApprove ? "scheduled" : "draft",
      approved: Boolean(input.autoApprove),
      scheduledAt: scheduled.toISOString(),
      linkAttachment: isConversion ? trackingUrl(config, link.slug) : "",
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    state.posts.push(post);
    created.push(post);
  }

  state.events.unshift({
    id: makeId("evt"),
    type: "automation.drafts_generated",
    count: created.length,
    createdAt: nowIso()
  });
  return { created };
}

function resolveDraftContext(state, input, config) {
  const campaign = input.campaignId
    ? findById(state.campaigns, input.campaignId)
    : state.campaigns.find((item) => item.status === "active");
  if (!campaign) {
    const error = new Error("No active campaign is available for draft generation.");
    error.statusCode = 400;
    throw error;
  }
  const product = input.productId
    ? findById(state.products, input.productId)
    : state.products.find((item) => item.campaignId === campaign.id && item.status === "active");
  if (!product) {
    const error = new Error("No active product is available for this campaign.");
    error.statusCode = 400;
    throw error;
  }
  const link = ensureLinkForProduct(state, product, campaign, config);
  const topic = input.topic || campaign.name;
  return { campaign, product, link, topic };
}

function generateDrafts(state, input, config) {
  const { campaign, product, link, topic } = resolveDraftContext(state, input, config);
  const drafts = generatePromptDrafts({
    topic,
    productName: product.name,
    trackingLink: trackingUrl(config, link.slug),
    disclosureText: config.defaultDisclosureText
  });
  return createDraftPosts(state, input, config, drafts, campaign, product, link, topic);
}

async function generateDraftsAsync(state, input, config, options = {}) {
  const { campaign, product, link, topic } = resolveDraftContext(state, input, config);
  const drafts = shouldUseOpenAI(config, input)
    ? await generateOpenAIDrafts({ topic, config, fetchImpl: options.fetchImpl })
    : generatePromptDrafts({
        topic,
        productName: product.name,
        trackingLink: trackingUrl(config, link.slug),
        disclosureText: config.defaultDisclosureText
      });
  return createDraftPosts(state, input, config, drafts, campaign, product, link, topic);
}

function createPost(state, input, config) {
  const campaign = findById(state.campaigns, input.campaignId);
  const product = findById(state.products, input.productId);
  if (!campaign || !product) {
    const error = new Error("A valid campaignId and productId are required.");
    error.statusCode = 400;
    throw error;
  }
  const link = input.affiliateLinkId
    ? findById(state.affiliateLinks, input.affiliateLinkId)
    : ensureLinkForProduct(state, product, campaign, config);
  if (!link) {
    const error = new Error("Affiliate link not found.");
    error.statusCode = 400;
    throw error;
  }
  const post = {
    id: makeId("post"),
    accountId: input.accountId || "acct_primary",
    campaignId: campaign.id,
    productId: product.id,
    affiliateLinkId: link.id,
    contentType: input.contentType || "手動",
    funnelRatio: input.funnelRatio || "manual",
    hook: input.hook || "",
    cta: input.cta || "",
    riskNote: input.riskNote || "",
    topicTag: input.topicTag || campaign.name.replace(/[.#&]/g, "").slice(0, 50),
    text: input.text || renderTemplate(product, campaign, link, config, state.posts.length),
    status: input.approved ? "scheduled" : "draft",
    approved: Boolean(input.approved),
    scheduledAt: input.scheduledAt || nowIso(),
    linkAttachment: input.linkAttachment || trackingUrl(config, link.slug),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  const validation = validatePost(post, config);
  if (!validation.valid) {
    const error = new Error(validation.errors.join(" "));
    error.statusCode = 400;
    throw error;
  }
  state.posts.push(post);
  return { post, validation };
}

function upsertAffiliateLink(state, input, config) {
  const campaign = findById(state.campaigns, input.campaignId);
  const product = findById(state.products, input.productId);
  if (!campaign || !product || !input.targetUrl) {
    const error = new Error("campaignId, productId, and targetUrl are required.");
    error.statusCode = 400;
    throw error;
  }
  const slug = input.slug ? slugify(input.slug) : slugify(`${campaign.name}-${product.name}`);
  const existing = state.affiliateLinks.find((link) => link.slug === slug);
  const url = new URL(input.targetUrl);
  url.searchParams.set("utm_source", input.utmSource || config.defaultUtmSource);
  url.searchParams.set("utm_medium", input.utmMedium || config.defaultUtmMedium);
  url.searchParams.set("utm_campaign", campaign.id);
  url.searchParams.set("utm_content", product.id);

  const link = existing || {
    id: makeId("aff"),
    clicks: 0,
    conversions: 0,
    revenue: 0,
    currency: input.currency || "USD",
    createdAt: nowIso()
  };
  Object.assign(link, {
    slug,
    campaignId: campaign.id,
    productId: product.id,
    network: input.network || product.network,
    targetUrl: url.toString(),
    updatedAt: nowIso()
  });
  if (!existing) state.affiliateLinks.push(link);
  return { link, trackingUrl: trackingUrl(config, link.slug) };
}

function findLinkForConversion(state, input) {
  const links = state.affiliateLinks || [];
  const link = input.affiliateLinkId
    ? links.find((item) => item.id === input.affiliateLinkId)
    : links.find((item) => item.slug === input.slug || item.slug === input.affiliateSlug);
  if (!link) {
    const error = new Error("A valid affiliateLinkId or slug is required.");
    error.statusCode = 404;
    throw error;
  }
  return link;
}

function numberFrom(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function recordConversion(state, input) {
  const link = findLinkForConversion(state, input);
  const networkEventId = String(input.networkEventId || input.eventId || input.orderId || "").trim();
  const duplicate = networkEventId
    ? (state.conversionEvents || []).find((event) =>
        event.affiliateLinkId === link.id && event.networkEventId === networkEventId
      )
    : null;
  if (duplicate) {
    return { conversion: duplicate, link, duplicate: true };
  }

  const commissionValue = numberFrom(input.commissionValue, input.commission, input.payout, input.amount);
  const orderValue = numberFrom(input.orderValue, input.order_value, input.saleAmount);
  if (commissionValue < 0 || orderValue < 0) {
    const error = new Error("Conversion values cannot be negative.");
    error.statusCode = 400;
    throw error;
  }

  const status = String(input.status || "approved").toLowerCase();
  const conversion = {
    id: makeId("conv"),
    affiliateLinkId: link.id,
    clickEventId: input.clickEventId || "",
    networkEventId,
    orderValue,
    commissionValue,
    currency: input.currency || link.currency || "USD",
    status,
    occurredAt: input.occurredAt || input.occurred_at || nowIso(),
    createdAt: nowIso()
  };

  state.conversionEvents.unshift(conversion);
  const countsTowardRevenue = !["rejected", "refunded", "void", "cancelled"].includes(status);
  if (countsTowardRevenue) {
    link.conversions = Number(link.conversions || 0) + 1;
    link.revenue = Number(link.revenue || 0) + commissionValue;
    link.currency = conversion.currency;
    link.updatedAt = conversion.createdAt;
  }
  state.events.unshift({
    id: makeId("evt"),
    type: "conversion.recorded",
    affiliateLinkId: link.id,
    conversionId: conversion.id,
    revenueDelta: countsTowardRevenue ? commissionValue : 0,
    createdAt: conversion.createdAt
  });
  return { conversion, link, duplicate: false };
}

function capacityRemaining(state) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recentlyPublished = state.posts.filter((post) => {
    if (!["published", "simulated"].includes(post.status)) return false;
    const publishedAt = new Date(post.publishedAt || post.updatedAt || 0).getTime();
    return publishedAt >= cutoff;
  }).length;
  const max = Number(state.settings.maxDailyApiPosts || 250);
  return Math.max(0, max - recentlyPublished);
}

async function runAutomation(store, config, options = {}) {
  const startedAt = nowIso();
  const state = await store.read();
  const run = {
    id: makeId("run"),
    source: options.source || "manual",
    status: "running",
    startedAt,
    finishedAt: null,
    processed: 0,
    published: 0,
    simulated: 0,
    failed: 0,
    messages: []
  };

  const now = Date.now();
  let remaining = capacityRemaining(state);
  const duePosts = state.posts.filter((post) => {
    if (options.onlyPostId && post.id !== options.onlyPostId) return false;
    if (!post.approved) return false;
    if (!["scheduled", "container_created"].includes(post.status)) return false;
    const dueTime = post.status === "container_created"
      ? new Date(post.publishAfter || post.scheduledAt).getTime()
      : new Date(post.scheduledAt || 0).getTime();
    return dueTime <= now;
  });

  for (const post of duePosts) {
    if (remaining <= 0) {
      run.messages.push("Daily Threads API publishing quota is exhausted.");
      break;
    }
    run.processed += 1;
    const validation = validatePost(post, config);
    if (!validation.valid) {
      post.status = "failed";
      post.error = validation.errors.join(" ");
      post.updatedAt = nowIso();
      run.failed += 1;
      run.messages.push(`${post.id}: validation failed.`);
      continue;
    }

    try {
      if (config.threadsDryRun) {
        post.status = "simulated";
        post.threadsMediaId = `dry_${Date.now()}`;
        post.publishedAt = nowIso();
        post.updatedAt = post.publishedAt;
        run.simulated += 1;
        remaining -= 1;
        continue;
      }

      if (post.status === "scheduled") {
        const container = await createTextContainer(config, post);
        post.status = "container_created";
        post.threadsContainerId = container.id;
        post.publishAfter = new Date(Date.now() + config.threadsPublishDelayMs).toISOString();
        post.updatedAt = nowIso();
        run.messages.push(`${post.id}: media container created.`);
        continue;
      }

      if (post.status === "container_created") {
        const result = await publishContainer(config, post.threadsContainerId);
        post.status = "published";
        post.threadsMediaId = result.id;
        post.publishedAt = nowIso();
        post.updatedAt = post.publishedAt;
        run.published += 1;
        remaining -= 1;
      }
    } catch (error) {
      post.status = error.message.includes("THREADS_USER_ID") ? "blocked_credentials" : "failed";
      post.error = error.message;
      post.updatedAt = nowIso();
      run.failed += 1;
      run.messages.push(`${post.id}: ${error.message}`);
    }
  }

  run.status = run.failed > 0 ? "completed_with_errors" : "completed";
  run.finishedAt = nowIso();
  state.automationRuns.unshift(run);
  state.events.unshift({
    id: makeId("evt"),
    type: "automation.run",
    runId: run.id,
    status: run.status,
    createdAt: run.finishedAt
  });
  await store.write(state);
  return { run, dashboard: buildDashboard(state, config) };
}

module.exports = {
  buildDashboard,
  createPost,
  generateDrafts,
  generateDraftsAsync,
  recordConversion,
  runAutomation,
  upsertAffiliateLink,
  trackingUrl
};

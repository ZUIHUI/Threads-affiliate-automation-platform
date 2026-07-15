const URL_PATTERN = /https?:\/\/[^\s<>"')]+/gi;

const MAIN_HISTORY_STATUSES = new Set(["scheduled", "container_created", "published", "simulated"]);
const DEDUPE_HISTORY_STATUSES = new Set(["needs_review", "approved", "scheduled", "container_created", "published", "simulated", "draft"]);
const EXCLUDED_HISTORY_STATUSES = new Set(["rejected", "failed", "blocked_credentials"]);
const REVIEW_STAGE_STATUSES = new Set(["generated", "needs_review", "draft"]);

function nowMs(options = {}) {
  const value = options.now || Date.now();
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

function safeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function fatigueOptions(input = {}) {
  return {
    similarityThreshold: Math.max(0.5, Math.min(safeNumber(input.contentSimilarityThreshold ?? input.similarityThreshold, 0.88), 0.98)),
    lookbackDays: Math.max(1, Math.min(safeNumber(input.contentFreshnessLookbackDays ?? input.lookbackDays, 14), 90)),
    productWindowHours: Math.max(1, Math.min(safeNumber(input.contentFatigueProductWindowHours ?? input.productWindowHours, 24), 168)),
    maxProductPostsPerWindow: Math.max(1, Math.min(safeNumber(input.contentFatigueMaxProductPostsPerWindow ?? input.maxProductPostsPerWindow, 1), 20)),
    hookWindowDays: Math.max(1, Math.min(safeNumber(input.contentFatigueHookWindowDays ?? input.hookWindowDays, 14), 90)),
    modelDailyCap: Math.max(1, Math.min(safeNumber(input.contentFatigueModelDailyCap ?? input.modelDailyCap, 3), 50)),
    commercialWindowPosts: Math.max(2, Math.min(safeNumber(input.contentFatigueCommercialWindowPosts ?? input.commercialWindowPosts, 3), 20)),
    maxCommercialPostsPerWindow: Math.max(1, Math.min(safeNumber(input.contentFatigueMaxCommercialPostsPerWindow ?? input.maxCommercialPostsPerWindow, 1), 10))
  };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(URL_PATTERN, " ")
    .replace(/[^\p{Letter}\p{Number}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function charShingles(value, size = 4) {
  const compact = normalizeText(value).replace(/\s+/g, "");
  const chars = Array.from(compact);
  if (chars.length <= size) return new Set(compact ? [compact] : []);
  const shingles = new Set();
  for (let index = 0; index <= chars.length - size; index += 1) {
    shingles.add(chars.slice(index, index + size).join(""));
  }
  return shingles;
}

function tokenSet(value) {
  const normalized = normalizeText(value);
  if (!normalized) return new Set();
  const tokens = normalized.split(" ").filter((token) => token.length > 1);
  if (tokens.length > 1) return new Set(tokens);
  return charShingles(normalized, 3);
}

function jaccardSimilarity(leftSet, rightSet) {
  if (!leftSet.size || !rightSet.size) return 0;
  let intersection = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) intersection += 1;
  }
  const union = leftSet.size + rightSet.size - intersection;
  return union ? intersection / union : 0;
}

function similarityScore(left, right) {
  const tokenScore = jaccardSimilarity(tokenSet(left), tokenSet(right));
  const shingleScore = jaccardSimilarity(charShingles(left), charShingles(right));
  return Number(Math.max(tokenScore, shingleScore).toFixed(3));
}

function extractUrls(text) {
  return String(text || "").match(URL_PATTERN) || [];
}

function canonicalCta(post) {
  const raw = post?.cta || post?.linkAttachment || extractUrls(post?.text)[0] || "";
  return String(raw || "").trim().toLowerCase().replace(/[.,;:!?]+$/, "");
}

function normalizedHook(post) {
  const hook = String(post?.hook || "").trim() || String(post?.text || "").split(/\n/)[0] || "";
  return normalizeText(hook).slice(0, 160);
}

function getPostTime(post) {
  const candidates = [post?.publishedAt, post?.scheduledAt, post?.updatedAt, post?.createdAt];
  for (const value of candidates) {
    const time = new Date(value || 0).getTime();
    if (Number.isFinite(time) && time > 0) return time;
  }
  return 0;
}

function isHistoryPost(post, currentPost) {
  if (!post || post.id === currentPost?.id) return false;
  const status = String(post.status || "").toLowerCase();
  return !EXCLUDED_HISTORY_STATUSES.has(status);
}

function isMainHistoryPost(post, currentPost) {
  return isHistoryPost(post, currentPost) && MAIN_HISTORY_STATUSES.has(String(post.status || "").toLowerCase());
}

function isDedupeHistoryPost(post, currentPost) {
  return isHistoryPost(post, currentPost) && DEDUPE_HISTORY_STATUSES.has(String(post.status || "").toLowerCase());
}

function withinWindow(post, cutoffMs) {
  const time = getPostTime(post);
  return Number.isFinite(time) && time >= cutoffMs;
}

function commercialIntensity(post) {
  const hasUrl = extractUrls(post?.text).length > 0 || Boolean(post?.linkAttachment);
  if (post?.funnelRatio === "conversion" || hasUrl) return "strong";
  if (post?.affiliateLinkId || post?.productId || post?.cta) return "soft";
  return "none";
}

function addReason(reasons, severity, id, message, extra = {}) {
  reasons.push({
    id,
    severity,
    message,
    ...extra
  });
}

function strongestStatus(reasons) {
  if (reasons.some((reason) => reason.severity === "blocked")) return "blocked";
  if (reasons.some((reason) => reason.severity === "warning")) return "warning";
  return "clear";
}

function evaluateContentFatigue(post, recentPosts = [], inputOptions = {}) {
  const options = fatigueOptions(inputOptions);
  const now = nowMs(inputOptions);
  const dayMs = 24 * 60 * 60 * 1000;
  const mainHistory = (recentPosts || [])
    .filter((item) => isMainHistoryPost(item, post))
    .sort((a, b) => getPostTime(b) - getPostTime(a));
  const dedupeHistory = (recentPosts || [])
    .filter((item) => isDedupeHistoryPost(item, post))
    .sort((a, b) => getPostTime(b) - getPostTime(a));
  const currentStatus = String(post?.status || "").toLowerCase();
  const textHistory = REVIEW_STAGE_STATUSES.has(currentStatus) ? dedupeHistory : mainHistory;
  const reasons = [];
  let bestSimilarity = { score: 0, post: null };
  const intensity = commercialIntensity(post);

  const similarityCutoff = now - options.lookbackDays * dayMs;
  for (const candidate of textHistory.filter((item) => withinWindow(item, similarityCutoff))) {
    const score = similarityScore(post?.text, candidate.text);
    if (score > bestSimilarity.score) bestSimilarity = { score, post: candidate };
  }
  if (bestSimilarity.score >= options.similarityThreshold) {
    addReason(
      reasons,
      "blocked",
      "similarity",
      `Content freshness blocked: ${Math.round(bestSimilarity.score * 100)}% similar to ${bestSimilarity.post.id}.`,
      {
        score: bestSimilarity.score,
        matchedPostId: bestSimilarity.post.id,
        threshold: options.similarityThreshold
      }
    );
  }

  const productCutoff = now - options.productWindowHours * 60 * 60 * 1000;
  if (post?.productId) {
    const productMatches = mainHistory.filter((item) =>
      item.productId === post.productId && withinWindow(item, productCutoff)
    );
    if (productMatches.length >= options.maxProductPostsPerWindow) {
      const severity = intensity === "strong" ? "blocked" : "warning";
      addReason(
        reasons,
        severity,
        "same_product_frequency",
        severity === "blocked"
          ? `同一商品在 ${options.productWindowHours} 小時內已有 ${productMatches.length} 則導購或已排程內容，暫停再次導購。`
          : `同一商品在 ${options.productWindowHours} 小時內已有 ${productMatches.length} 則內容；這篇沒有購買連結，可審核但請確認角度不重複。`,
        {
          productId: post.productId,
          count: productMatches.length,
          limit: options.maxProductPostsPerWindow,
          windowHours: options.productWindowHours,
          matchedPostId: productMatches[0]?.id || ""
        }
      );
    }
  }

  const hook = normalizedHook(post);
  const hookCutoff = now - options.hookWindowDays * dayMs;
  if (hook) {
    const hookMatch = textHistory.find((item) =>
      normalizedHook(item) === hook && withinWindow(item, hookCutoff)
    );
    if (hookMatch) {
      addReason(
        reasons,
        "blocked",
        "same_hook",
        `Hook repeats ${hookMatch.id} within ${options.hookWindowDays} days.`,
        {
          matchedPostId: hookMatch.id,
          windowDays: options.hookWindowDays
        }
      );
    }
  }

  const cta = canonicalCta(post);
  if (cta) {
    const sameCtaRecent = mainHistory.filter((item) => canonicalCta(item) === cta);
    const lastRequired = Math.max(0, options.commercialWindowPosts - 1);
    const lastPosts = mainHistory.slice(0, lastRequired);
    if (lastPosts.length >= lastRequired && lastPosts.every((item) => canonicalCta(item) === cta)) {
      addReason(
        reasons,
        "blocked",
        "same_cta_consecutive",
        `CTA would repeat for ${options.commercialWindowPosts} consecutive posts.`,
        {
          cta,
          count: options.commercialWindowPosts,
          matchedPostId: lastPosts[0]?.id || ""
        }
      );
    } else if (sameCtaRecent.length > 0) {
      addReason(
        reasons,
        "warning",
        "same_cta_recent",
        `CTA was recently used by ${sameCtaRecent[0].id}.`,
        {
          cta,
          count: sameCtaRecent.length,
          matchedPostId: sameCtaRecent[0].id
        }
      );
    }
  }

  const modelId = String(post?.funnelRatio || "").trim();
  if (modelId && modelId !== "manual") {
    const modelCutoff = now - dayMs;
    const modelMatches = mainHistory.filter((item) =>
      item.funnelRatio === modelId && withinWindow(item, modelCutoff)
    );
    if (modelMatches.length >= options.modelDailyCap) {
      addReason(
        reasons,
        "blocked",
        "same_profit_model_daily_cap",
        `Profit model ${modelId} reached the daily cap of ${options.modelDailyCap}.`,
        {
          modelId,
          count: modelMatches.length,
          limit: options.modelDailyCap,
          windowHours: 24,
          matchedPostId: modelMatches[0]?.id || ""
        }
      );
    }
  }

  if (intensity === "strong") {
    const lastPosts = mainHistory.slice(0, Math.max(0, options.commercialWindowPosts - 1));
    const strongHistoryCount = lastPosts.filter((item) => commercialIntensity(item) === "strong").length;
    const projectedStrong = strongHistoryCount + 1;
    if (projectedStrong > options.maxCommercialPostsPerWindow) {
      addReason(
        reasons,
        "warning",
        "commercial_ratio",
        `Commercial ratio would be ${projectedStrong}/${options.commercialWindowPosts}; add softer content before another strong CTA.`,
        {
          count: projectedStrong,
          limit: options.maxCommercialPostsPerWindow,
          windowPosts: options.commercialWindowPosts,
          matchedPostId: lastPosts.find((item) => commercialIntensity(item) === "strong")?.id || ""
        }
      );
    }
  }

  return {
    status: strongestStatus(reasons),
    reasons,
    similarityScore: bestSimilarity.score,
    similarToPostId: bestSimilarity.post?.id || "",
    commercialIntensity: intensity,
    lastFatigueCheckedAt: new Date(now).toISOString(),
    ruleConfig: {
      sameProductWindowHours: options.productWindowHours,
      sameProductLimit: options.maxProductPostsPerWindow,
      hookWindowDays: options.hookWindowDays,
      sameCtaConsecutiveLimit: options.commercialWindowPosts,
      modelDailyCap: options.modelDailyCap,
      similarityThreshold: options.similarityThreshold,
      commercialWindowPosts: options.commercialWindowPosts,
      commercialMaxStrong: options.maxCommercialPostsPerWindow
    }
  };
}

function applyFatigueMetadata(post, evaluation) {
  post.fatigueStatus = evaluation.status;
  post.fatigueReasons = evaluation.reasons;
  post.similarityScore = evaluation.similarityScore;
  post.similarToPostId = evaluation.similarToPostId;
  post.commercialIntensity = evaluation.commercialIntensity;
  post.lastFatigueCheckedAt = evaluation.lastFatigueCheckedAt;
  post.fatigue = {
    status: evaluation.status,
    reasons: evaluation.reasons,
    similarityScore: evaluation.similarityScore,
    similarToPostId: evaluation.similarToPostId,
    commercialIntensity: evaluation.commercialIntensity,
    lastFatigueCheckedAt: evaluation.lastFatigueCheckedAt,
    ruleConfig: evaluation.ruleConfig
  };
  return post.fatigue;
}

function evaluateProfitModelFatigue(modelId, posts = [], inputOptions = {}) {
  const options = fatigueOptions(inputOptions);
  const now = nowMs(inputOptions);
  const cutoff = now - 24 * 60 * 60 * 1000;
  const matches = (posts || []).filter((post) =>
    isMainHistoryPost(post, null)
      && post.funnelRatio === modelId
      && withinWindow(post, cutoff)
  );
  const status = matches.length >= options.modelDailyCap
    ? "blocked"
    : matches.length >= Math.max(1, options.modelDailyCap - 1)
      ? "warning"
      : "clear";
  const reasons = status === "clear" ? [] : [{
    id: "same_profit_model_daily_cap",
    severity: status,
    message: status === "blocked"
      ? `Profit model ${modelId} reached the daily cap of ${options.modelDailyCap}.`
      : `Profit model ${modelId} is near the daily cap of ${options.modelDailyCap}.`,
    modelId,
    count: matches.length,
    limit: options.modelDailyCap,
    matchedPostId: matches[0]?.id || ""
  }];
  return {
    status,
    reasons,
    count: matches.length,
    limit: options.modelDailyCap,
    penalty: status === "blocked" ? 30 : status === "warning" ? 12 : Math.min(8, matches.length * 3)
  };
}

module.exports = {
  applyFatigueMetadata,
  commercialIntensity,
  evaluateContentFatigue,
  evaluateProfitModelFatigue,
  fatigueOptions,
  normalizeText,
  similarityScore
};

const { validatePost } = require("./validators");
const { applyFatigueMetadata, evaluateContentFatigue } = require("./contentFatigue");

const STATUS = {
  generated: "generated",
  needsReview: "needs_review",
  approved: "approved",
  scheduled: "scheduled",
  published: "published",
  simulated: "simulated",
  failed: "failed",
  rejected: "rejected",
  draft: "draft",
  containerCreated: "container_created",
  blockedCredentials: "blocked_credentials"
};

const REVIEWABLE_STATUSES = new Set([
  STATUS.generated,
  STATUS.needsReview,
  STATUS.draft
]);

const TERMINAL_STATUSES = new Set([
  STATUS.published,
  STATUS.simulated,
  STATUS.failed,
  STATUS.blockedCredentials
]);

function nowIso() {
  return new Date().toISOString();
}

function reviewError(message, statusCode = 409, code = "POST_REVIEW_BLOCKED") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function rawStatus(post) {
  return String(post?.status || "").trim().toLowerCase() || (post?.approved ? STATUS.approved : STATUS.needsReview);
}

function effectiveReviewStatus(post) {
  const status = rawStatus(post);
  if (status === STATUS.draft) return STATUS.needsReview;
  if (status === STATUS.containerCreated) return STATUS.scheduled;
  if (status === STATUS.blockedCredentials) return STATUS.failed;
  return status;
}

function hasCommercialPlacement(post, validation) {
  return Number(validation?.uniqueLinkCount || 0) > 0
    || Boolean(post?.linkAttachment)
    || post?.funnelRatio === "conversion";
}

function missingDisclosure(validation) {
  return (validation?.warnings || []).some((warning) =>
    /(?:affiliate|commercial) disclosure/i.test(String(warning || ""))
  );
}

function disclosureStatus(post, validation) {
  if (missingDisclosure(validation)) return "missing";
  return hasCommercialPlacement(post, validation) ? "present" : "not_required";
}

function claimWarnings(validation) {
  return (validation?.warnings || []).filter((warning) =>
    /exaggerated|earnings claim|guaranteed-profit|guaranteed profit/i.test(String(warning || ""))
  );
}

function isHighRisk(validation) {
  return validation?.risk?.level === "high";
}

function hasTestimonialRisk(validation) {
  return (validation?.risk?.flags || []).includes("testimonial_risk")
    || (validation?.warnings || []).some((warning) => /testimonial/i.test(String(warning || "")));
}

function buildReviewSummary(post, validation, fatigue = null) {
  return {
    status: effectiveReviewStatus(post),
    validationValid: Boolean(validation?.valid),
    riskLevel: validation?.risk?.level || "unknown",
    riskFlags: validation?.risk?.flags || [],
    disclosureStatus: disclosureStatus(post, validation),
    claimWarnings: claimWarnings(validation),
    testimonialRisk: hasTestimonialRisk(validation),
    fatigueStatus: fatigue?.status || post?.fatigueStatus || "clear",
    fatigueReasons: fatigue?.reasons || post?.fatigueReasons || [],
    similarityScore: fatigue?.similarityScore ?? post?.similarityScore ?? 0,
    similarToPostId: fatigue?.similarToPostId || post?.similarToPostId || "",
    commercialIntensity: fatigue?.commercialIntensity || post?.commercialIntensity || "none",
    errors: validation?.errors || [],
    warnings: validation?.warnings || []
  };
}

function applyReviewMetadata(post, validation, checkedAt = nowIso(), fatigue = null) {
  const summary = buildReviewSummary(post, validation, fatigue);
  post.validationResult = validation;
  post.riskLevel = summary.riskLevel;
  post.disclosureStatus = summary.disclosureStatus;
  post.claimWarnings = summary.claimWarnings;
  post.testimonialRisk = summary.testimonialRisk;
  post.review = {
    ...(post.review || {}),
    ...summary,
    checkedAt
  };
  return summary;
}

function refreshReviewMetadata(post, config, options = {}) {
  const validation = validatePost(post, config);
  const fatigue = evaluateContentFatigue(post, options.recentPosts || [], config);
  applyFatigueMetadata(post, fatigue);
  applyReviewMetadata(post, validation, nowIso(), fatigue);
  return validation;
}

function prepareGeneratedPostForReview(post, config, options = {}) {
  post.status = STATUS.needsReview;
  post.approved = false;
  const validation = refreshReviewMetadata(post, config, {
    recentPosts: options.recentPosts || []
  });
  post.review = {
    ...(post.review || {}),
    status: STATUS.needsReview,
    source: options.source || "ai_generated",
    createdBy: options.createdBy || post.createdBy || null,
    autoApproveIgnored: Boolean(options.autoApproveRequested)
  };
  return validation;
}

function assertReviewableForApproval(post, validation) {
  const status = rawStatus(post);
  if (!REVIEWABLE_STATUSES.has(status)) {
    throw reviewError(`Post must be needs_review before approval. Current status: ${status}.`);
  }
  if (!validation.valid) {
    throw reviewError(validation.errors.join(" ") || "Post validation failed.", 400, "POST_VALIDATION_FAILED");
  }
  if (isHighRisk(validation)) {
    throw reviewError("High-risk content cannot be directly approved.", 409, "HIGH_RISK_REVIEW_REQUIRED");
  }
  if (claimWarnings(validation).length > 0) {
    throw reviewError("Serious claim warnings require editing or rejection before approval.", 409, "CLAIM_WARNING_REVIEW_REQUIRED");
  }
  if (post.fatigueStatus === "blocked") {
    const reason = (post.fatigueReasons || []).find((item) => item.severity === "blocked") || {};
    const error = reviewError(reason.message || "Content fatigue is blocked; edit or rewrite before approval.", 409, "CONTENT_FATIGUE_BLOCKED");
    error.fatigue = post.fatigue || {
      status: post.fatigueStatus,
      reasons: post.fatigueReasons || []
    };
    throw error;
  }
}

function approvePost(post, config, options = {}) {
  const validation = refreshReviewMetadata(post, config, {
    recentPosts: options.recentPosts || []
  });
  assertReviewableForApproval(post, validation);
  const at = nowIso();
  post.status = STATUS.approved;
  post.approved = true;
  post.reviewedAt = at;
  post.reviewedBy = options.actor || null;
  post.rejectedAt = "";
  post.rejectedBy = "";
  post.rejectionReason = "";
  post.updatedAt = at;
  applyReviewMetadata(post, validation, at);
  post.review = {
    ...(post.review || {}),
    status: STATUS.approved,
    approvedAt: at,
    approvedBy: options.actor || null
  };
  return validation;
}

function rejectPost(post, config, options = {}) {
  const validation = refreshReviewMetadata(post, config, {
    recentPosts: options.recentPosts || []
  });
  const at = nowIso();
  post.status = STATUS.rejected;
  post.approved = false;
  post.reviewedAt = at;
  post.reviewedBy = options.actor || null;
  post.rejectedAt = at;
  post.rejectedBy = options.actor || null;
  post.rejectionReason = String(options.reason || "").trim();
  post.updatedAt = at;
  applyReviewMetadata(post, validation, at);
  post.review = {
    ...(post.review || {}),
    status: STATUS.rejected,
    rejectedAt: at,
    rejectedBy: options.actor || null,
    rejectionReason: post.rejectionReason
  };
  return validation;
}

function assertSchedulable(post, validation, config) {
  const status = rawStatus(post);
  if (status === STATUS.rejected) {
    throw reviewError("Rejected posts cannot be scheduled.", 409, "POST_REJECTED");
  }
  if (status !== STATUS.approved || !post.approved) {
    throw reviewError(`Post must be approved before scheduling. Current status: ${status}.`);
  }
  if (!validation.valid) {
    throw reviewError(validation.errors.join(" ") || "Post validation failed.", 400, "POST_VALIDATION_FAILED");
  }
  if (isHighRisk(validation)) {
    throw reviewError("High-risk content cannot be scheduled.", 409, "HIGH_RISK_REVIEW_REQUIRED");
  }
  if (!config.threadsDryRun && missingDisclosure(validation)) {
    throw reviewError("Affiliate disclosure is required before live scheduling.", 409, "MISSING_DISCLOSURE");
  }
  if (post.fatigueStatus === "blocked") {
    const reason = (post.fatigueReasons || []).find((item) => item.severity === "blocked") || {};
    const error = reviewError(reason.message || "Content fatigue is blocked; edit or rewrite before scheduling.", 409, "CONTENT_FATIGUE_BLOCKED");
    error.fatigue = post.fatigue || {
      status: post.fatigueStatus,
      reasons: post.fatigueReasons || []
    };
    throw error;
  }
}

function schedulePost(post, config, options = {}) {
  const validation = refreshReviewMetadata(post, config, {
    recentPosts: options.recentPosts || []
  });
  assertSchedulable(post, validation, config);
  const at = nowIso();
  post.status = STATUS.scheduled;
  post.approved = true;
  post.scheduledAt = options.scheduledAt || post.scheduledAt || at;
  post.scheduledBy = options.actor || null;
  post.updatedAt = at;
  applyReviewMetadata(post, validation, at);
  post.review = {
    ...(post.review || {}),
    status: STATUS.scheduled,
    scheduledAt: post.scheduledAt,
    scheduledBy: options.actor || null
  };
  return validation;
}

function assertPublishable(post, validation, config, options = {}) {
  const status = rawStatus(post);
  const allowedStatuses = options.allowContainerCreated
    ? new Set([STATUS.scheduled, STATUS.containerCreated])
    : new Set([STATUS.scheduled]);
  if (status === STATUS.rejected) {
    throw reviewError("Rejected posts cannot be published.", 409, "POST_REJECTED");
  }
  if (!post.approved || !allowedStatuses.has(status)) {
    throw reviewError(`Post must be scheduled before publishing. Current status: ${status}.`);
  }
  if (!validation.valid) {
    throw reviewError(validation.errors.join(" ") || "Post validation failed.", 400, "POST_VALIDATION_FAILED");
  }
  if (isHighRisk(validation)) {
    throw reviewError("High-risk content cannot be published.", 409, "HIGH_RISK_REVIEW_REQUIRED");
  }
  if (!config.threadsDryRun && missingDisclosure(validation)) {
    throw reviewError("Affiliate disclosure is required before live publishing.", 409, "MISSING_DISCLOSURE");
  }
  if (post.fatigueStatus === "blocked") {
    const reason = (post.fatigueReasons || []).find((item) => item.severity === "blocked") || {};
    const error = reviewError(reason.message || "Content fatigue is blocked; edit or rewrite before publishing.", 409, "CONTENT_FATIGUE_BLOCKED");
    error.fatigue = post.fatigue || {
      status: post.fatigueStatus,
      reasons: post.fatigueReasons || []
    };
    throw error;
  }
}

function applyPostPatch(post, input, config, options = {}) {
  const status = rawStatus(post);
  if (TERMINAL_STATUSES.has(status)) {
    throw reviewError(`Post cannot be edited after status ${status}.`);
  }
  const textFields = ["text", "hook", "cta", "riskNote", "topicTag", "linkAttachment", "contentType", "funnelRatio"];
  let contentChanged = false;
  for (const field of textFields) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const next = String(input[field] || "");
    if (post[field] !== next) contentChanged = true;
    post[field] = next;
  }
  if (Object.prototype.hasOwnProperty.call(input, "scheduledAt")) {
    post.scheduledAt = input.scheduledAt || post.scheduledAt;
  }
  if (contentChanged && [STATUS.approved, STATUS.scheduled, STATUS.containerCreated].includes(status)) {
    post.status = STATUS.needsReview;
    post.approved = false;
    post.reviewResetAt = nowIso();
    post.reviewResetReason = "Content changed after approval.";
  }
  post.updatedAt = nowIso();
  const validation = refreshReviewMetadata(post, config, {
    recentPosts: options.recentPosts || []
  });
  post.review = {
    ...(post.review || {}),
    editedAt: post.updatedAt,
    editedBy: options.actor || null,
    status: effectiveReviewStatus(post)
  };
  return validation;
}

module.exports = {
  STATUS,
  applyPostPatch,
  approvePost,
  assertPublishable,
  buildReviewSummary,
  effectiveReviewStatus,
  missingDisclosure,
  prepareGeneratedPostForReview,
  refreshReviewMetadata,
  rejectPost,
  schedulePost
};

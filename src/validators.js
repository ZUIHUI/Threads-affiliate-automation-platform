const URL_PATTERN = /https?:\/\/[^\s<>"')]+/gi;
const { hasCommercialDisclosure, socialDisclosureText } = require("./contentPolicy");
const HYPE_PATTERNS = [
  /guaranteed\s+(profit|profits|income|earnings|revenue)/i,
  /earn\s+\$?\d+[\d,]*(\.\d+)?\s*(per|a|every)\s*(day|week|month)/i,
  /\$\d+[\d,]*(\.\d+)?\s*(per|a|every)\s*(day|week|month)\s*(guaranteed|passive)/i,
  /保證賺/i,
  /一定賺/i,
  /穩賺/i,
  /躺賺/i,
  /暴利/i,
  /零風險/i,
  /月入\s*\d+/i,
  /財富自由/i
];
const TESTIMONIAL_PATTERNS = [
  /i\s+(made|earned)\s+\$?\d+[\d,]*/i,
  /my\s+(student|client|customer)s?\s+(made|earned)\s+\$?\d+[\d,]*/i,
  /學員.*賺/i,
  /學生.*賺/i,
  /客戶.*賺/i,
  /真實案例.*賺/i,
  /見證/i
];
const THREADS_AI_STYLE_PATTERNS = [
  /在這個快速變化的時代/u,
  /你是否曾經想過/u,
  /不僅[\s\S]{0,40}更/u,
  /無論[\s\S]{0,40}還是/u,
  /讓我們一起/u,
  /趕快把握機會/u,
  /千萬不要錯過/u
];

function extractUniqueUrls(text) {
  const matches = String(text || "").match(URL_PATTERN) || [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:!?]+$/, "")))];
}

function validateTopicTag(topicTag) {
  if (!topicTag) return [];
  const errors = [];
  if (topicTag.length > 50) errors.push("Topic tag must be 50 characters or less.");
  if (/[.&]/.test(topicTag)) errors.push("Topic tag cannot contain periods or ampersands.");
  return errors;
}

function validatePost(post, config) {
  const settings = {
    disclosureText: socialDisclosureText(config),
    maxLinksPerPost: 5,
    postCharacterLimitBytes: 500
  };
  const text = String(post.text || "");
  const byteLength = Buffer.byteLength(text, "utf8");
  const threadsUnits = countThreadsUnits(text);
  const uniqueUrls = extractUniqueUrls(text);
  const emojiCount = Array.from(text).filter((char) => /\p{Extended_Pictographic}/u.test(char)).length;
  if (post.linkAttachment && !uniqueUrls.includes(post.linkAttachment)) {
    uniqueUrls.push(post.linkAttachment);
  }

  const errors = [];
  const warnings = [];
  const risk = evaluateContentRisk(post);
  if (!text.trim()) errors.push("Post text is required.");
  if (threadsUnits > settings.postCharacterLimitBytes) {
    errors.push(`Post text is ${threadsUnits} Threads character units; Threads text posts are limited to ${settings.postCharacterLimitBytes}.`);
  }
  if (uniqueUrls.length > settings.maxLinksPerPost) {
    errors.push(`Post has ${uniqueUrls.length} unique links; Threads currently allows ${settings.maxLinksPerPost} or fewer.`);
  }
  if (emojiCount > 3) errors.push(`Post has ${emojiCount} emoji; use 3 or fewer.`);
  if (THREADS_AI_STYLE_PATTERNS.some((pattern) => pattern.test(text))) {
    errors.push("Post contains disallowed AI-style template language.");
  }
  const hasCommercialLink = uniqueUrls.length > 0 || Boolean(post.linkAttachment) || post.funnelRatio === "conversion";
  if (hasCommercialLink && !hasCommercialDisclosure(text, config)) {
    warnings.push(`Commercial disclosure "${settings.disclosureText}" should be visible in the post text.`);
  }
  warnings.push(...risk.warnings);
  errors.push(...validateTopicTag(post.topicTag || ""));

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    risk,
    byteLength,
    threadsUnits,
    emojiCount,
    uniqueLinkCount: uniqueUrls.length,
    uniqueUrls
  };
}

function countThreadsUnits(text) {
  return Array.from(String(text || "")).reduce((total, char) => {
    if (/\p{Extended_Pictographic}/u.test(char)) {
      return total + Buffer.byteLength(char, "utf8");
    }
    return total + 1;
  }, 0);
}

function evaluateContentRisk(post) {
  const text = String(post.text || "");
  const warnings = [];
  const matched = [];
  if (HYPE_PATTERNS.some((pattern) => pattern.test(text))) {
    matched.push("overstated_earnings");
    warnings.push("Avoid exaggerated earnings claims or guaranteed-profit language.");
  }
  if (TESTIMONIAL_PATTERNS.some((pattern) => pattern.test(text))) {
    matched.push("testimonial_risk");
    warnings.push("Avoid fake testimonials or unverified success stories.");
  }
  if (!/[?？]\s*$/.test(text.trim())) {
    matched.push("missing_interaction_question");
    warnings.push("End with one interaction question.");
  }
  const numberedItems = (text.match(/(^|\n)\s*\d+[.、]/g) || []).length;
  if (numberedItems > 6) {
    matched.push("too_many_points");
    warnings.push("Keep each Threads post focused on one core point.");
  }

  let level = "low";
  if (matched.includes("overstated_earnings") || matched.includes("testimonial_risk")) {
    level = "high";
  } else if (matched.length > 0) {
    level = "medium";
  }

  return {
    level,
    flags: matched,
    warnings
  };
}

module.exports = {
  countThreadsUnits,
  evaluateContentRisk,
  extractUniqueUrls,
  validatePost,
  validateTopicTag
};

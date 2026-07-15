const assert = require("node:assert/strict");

const { evaluateContentFatigue } = require("../src/contentFatigue");

const now = "2026-07-15T06:00:00.000Z";
const history = [{
  id: "post_previous_conversion",
  productId: "prd_sensor_light",
  campaignId: "cmp_lighting",
  funnelRatio: "conversion",
  hook: "Previous conversion post",
  cta: "https://example.com/r/sensor-light",
  text: "Affiliate disclosure: previous conversion post https://example.com/r/sensor-light",
  linkAttachment: "https://example.com/r/sensor-light",
  status: "published",
  publishedAt: "2026-07-15T05:00:00.000Z"
}];

const shared = {
  productId: "prd_sensor_light",
  campaignId: "cmp_lighting"
};

const conversion = evaluateContentFatigue({
  ...shared,
  id: "post_next_conversion",
  funnelRatio: "conversion",
  hook: "A different commercial hook",
  cta: "https://example.com/r/sensor-light-next",
  text: "Affiliate disclosure: a different conversion post https://example.com/r/sensor-light-next",
  linkAttachment: "https://example.com/r/sensor-light-next"
}, history, { now });

assert.equal(conversion.status, "blocked");
assert.equal(conversion.commercialIntensity, "strong");
assert.equal(
  conversion.reasons.find((reason) => reason.id === "same_product_frequency")?.severity,
  "blocked"
);

const trustPost = evaluateContentFatigue({
  ...shared,
  id: "post_trust_tip",
  funnelRatio: "trust",
  hook: "A distinct practical lighting tip",
  cta: "Which corner needs softer light?",
  text: "A practical lighting tip that contains no purchase link.",
  linkAttachment: ""
}, history, { now });

assert.equal(trustPost.status, "warning");
assert.equal(trustPost.commercialIntensity, "soft");
assert.equal(
  trustPost.reasons.find((reason) => reason.id === "same_product_frequency")?.severity,
  "warning"
);

console.log("Soft same-product fatigue rules passed.");

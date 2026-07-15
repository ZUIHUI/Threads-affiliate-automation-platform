const URL_PATTERN = /https?:\/\/[^\s<>"')]+/gi;
const LEGACY_DISCLOSURE_PATTERN = /含有?\s*聯盟連結\s*[：:]?/giu;
const STANDARD_DISCLOSURE_PATTERN = /#(?:ad|廣告|合作)(?=$|[\s，。！？、])/giu;

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function socialDisclosureText(config = {}) {
  const configured = String(config.defaultDisclosureText || "").trim();
  if (!configured || /^含有?\s*聯盟連結\s*[：:]?$/u.test(configured)) return "#廣告";
  return configured;
}

function hasCommercialDisclosure(text, config = {}) {
  const value = String(text || "");
  const disclosure = socialDisclosureText(config);
  return Boolean(disclosure && value.includes(disclosure))
    || /#ad\b/i.test(value)
    || /#(?:廣告|合作)(?=$|[\s，。！？、])/u.test(value);
}

function cleanPostLayout(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/^[：:]\s*/u, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripGeneratedLinks(text) {
  return cleanPostLayout(String(text || "").replace(URL_PATTERN, ""));
}

function stripGeneratedDisclosure(text, config = {}) {
  let value = String(text || "");
  const configured = String(config.defaultDisclosureText || "").trim();
  if (configured) {
    value = value.replace(new RegExp(`${escapeRegExp(configured)}\\s*[：:]?`, "giu"), "");
  }
  value = value
    .replace(LEGACY_DISCLOSURE_PATTERN, "")
    .replace(STANDARD_DISCLOSURE_PATTERN, "");
  return cleanPostLayout(value);
}

function editorialPostText(draft, config = {}) {
  return stripGeneratedDisclosure(stripGeneratedLinks(draft?.post), config);
}

function commercialPostText(draft, productUrl, config = {}) {
  const url = String(productUrl || "").trim();
  const cta = cleanPostLayout(draft?.cta);
  let body = editorialPostText(draft, config);
  if (cta && body.endsWith(cta)) {
    body = cleanPostLayout(body.slice(0, -cta.length));
  }
  const sections = [body];
  if (url) sections.push(`商品連結：\n${url}`);
  sections.push(socialDisclosureText(config));
  if (cta) sections.push(cta);
  return cleanPostLayout(sections.filter(Boolean).join("\n\n"));
}

function explicitTopicTag(value) {
  return String(value || "").trim().replace(/[.#&]/g, "").slice(0, 50);
}

module.exports = {
  commercialPostText,
  editorialPostText,
  explicitTopicTag,
  hasCommercialDisclosure,
  socialDisclosureText
};

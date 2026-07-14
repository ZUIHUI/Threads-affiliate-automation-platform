const RESERVED_HOSTS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "localhost",
  "127.0.0.1",
  "::1"
]);

function isPrivateIpv4(hostname) {
  const parts = String(hostname || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

function isPlaceholderUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!["http:", "https:"].includes(url.protocol)) return true;
    if (RESERVED_HOSTS.has(hostname) || isPrivateIpv4(hostname)) return true;
    if (["example.com", "example.net", "example.org"].some((domain) => hostname.endsWith(`.${domain}`))) return true;
    return [".example", ".invalid", ".localhost", ".test"].some((suffix) => hostname.endsWith(suffix));
  } catch {
    return true;
  }
}

function isDemoNetwork(value) {
  const network = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return !network || [
    "demo",
    "example",
    "examplepartner",
    "examplenetwork",
    "test",
    "testpartner",
    "testnetwork"
  ].includes(network);
}

function isMonetizableLink(link) {
  if (!link || link.isDemo === true) return false;
  if (isDemoNetwork(link.network)) return false;
  return !isPlaceholderUrl(link.targetUrl);
}

function isMonetizableProduct(product) {
  if (!product || product.isDemo === true) return false;
  if (isDemoNetwork(product.network)) return false;
  return !isPlaceholderUrl(product.landingUrl);
}

function realOfferInventory(state) {
  const activeCampaigns = new Map((state.campaigns || [])
    .filter((campaign) => campaign.status === "active")
    .map((campaign) => [campaign.id, campaign]));
  const activeProducts = new Map((state.products || [])
    .filter((product) => product.status === "active" && activeCampaigns.has(product.campaignId))
    .map((product) => [product.id, product]));
  const links = (state.affiliateLinks || []).filter((link) =>
    isMonetizableLink(link)
      && activeCampaigns.has(link.campaignId)
      && activeProducts.has(link.productId)
  );
  const productIds = new Set(links.map((link) => link.productId));
  const campaignIds = new Set(links.map((link) => link.campaignId));
  return {
    campaigns: [...activeCampaigns.values()].filter((campaign) => campaignIds.has(campaign.id)),
    products: [...activeProducts.values()].filter((product) => productIds.has(product.id)),
    links
  };
}

function monetizableLinkForProduct(state, productId) {
  return (state.affiliateLinks || []).find((link) =>
    link.productId === productId && isMonetizableLink(link)
  ) || null;
}

function assertMonetizablePost(state, post) {
  const link = (state.affiliateLinks || []).find((item) => item.id === post?.affiliateLinkId);
  if (link && isMonetizableLink(link)) return link;
  const error = new Error("This post does not have a real affiliate tracking URL and cannot be published live.");
  error.statusCode = 409;
  error.code = "MONETIZATION_NOT_READY";
  throw error;
}

module.exports = {
  assertMonetizablePost,
  isDemoNetwork,
  isMonetizableLink,
  isMonetizableProduct,
  isPlaceholderUrl,
  monetizableLinkForProduct,
  realOfferInventory
};

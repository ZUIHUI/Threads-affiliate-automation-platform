const dns = require("node:dns").promises;
const https = require("node:https");
const net = require("node:net");
const zlib = require("node:zlib");

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 8000;

function contextError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = "OFFER_PAGE_CONTEXT_FAILED";
  return error;
}

function ipv4Parts(address) {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

function ipv6Hextets(address) {
  let normalized = String(address || "").toLowerCase().split("%")[0];
  const dottedMatch = normalized.match(/((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dottedMatch) {
    const parts = ipv4Parts(dottedMatch[1]);
    if (!parts) return null;
    const high = ((parts[0] << 8) | parts[1]).toString(16);
    const low = ((parts[2] << 8) | parts[3]).toString(16);
    normalized = `${normalized.slice(0, dottedMatch.index)}${high}:${low}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const values = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right]
    .map((part) => Number.parseInt(part || "0", 16));
  if (values.length !== 8 || values.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffff)) return null;
  return values;
}

function isPrivateAddress(address) {
  const kind = net.isIP(String(address || "").split("%")[0]);
  if (kind === 4) {
    const parts = ipv4Parts(address);
    if (!parts) return true;
    const [a, b, c] = parts;
    return a === 0
      || a === 10
      || a === 127
      || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 168)
      || (a === 198 && [18, 19].includes(b))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113);
  }
  if (kind === 6) {
    const parts = ipv6Hextets(address);
    if (!parts) return true;
    const allZero = parts.every((part) => part === 0);
    const loopback = parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1;
    const uniqueLocal = (parts[0] & 0xfe00) === 0xfc00;
    const linkLocal = (parts[0] & 0xffc0) === 0xfe80;
    const multicast = (parts[0] & 0xff00) === 0xff00;
    const documentation = parts[0] === 0x2001 && parts[1] === 0x0db8;
    const mappedIpv4 = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff
      ? [parts[6] >> 8, parts[6] & 0xff, parts[7] >> 8, parts[7] & 0xff].join(".")
      : "";
    return allZero || loopback || uniqueLocal || linkLocal || multicast || documentation
      || Boolean(mappedIpv4 && isPrivateAddress(mappedIpv4));
  }
  return true;
}

function blockedHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal");
}

async function validatePublicHttpsUrl(value, options = {}) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(String(value || ""));
  } catch {
    throw contextError("Offer page URL is invalid.", 400);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || blockedHostname(hostname)) {
    throw contextError("Offer page URL must be a public HTTPS URL.", 400);
  }

  const directKind = net.isIP(hostname);
  if (directKind) {
    if (isPrivateAddress(hostname)) throw contextError("Offer page URL resolves to a blocked network.", 400);
    return { url, hostname, address: hostname, family: directKind };
  }

  const resolver = options.resolveImpl || dns.lookup;
  let addresses;
  try {
    addresses = await resolver(hostname, { all: true, verbatim: true });
  } catch {
    throw contextError("Offer page hostname could not be resolved.");
  }
  const candidates = Array.isArray(addresses) ? addresses : [addresses];
  if (!candidates.length || candidates.some((item) => !item?.address || isPrivateAddress(item.address))) {
    throw contextError("Offer page URL resolves to a blocked network.", 400);
  }
  return {
    url,
    hostname,
    address: candidates[0].address,
    family: Number(candidates[0].family || net.isIP(candidates[0].address))
  };
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : "";
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function requestOfferPage(validated, options = {}) {
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_BYTES);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const target = validated.url;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const request = https.request({
      protocol: "https:",
      hostname: validated.hostname,
      port: target.port || 443,
      path: `${target.pathname || "/"}${target.search}`,
      method: "GET",
      servername: net.isIP(validated.hostname) ? undefined : validated.hostname,
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions?.all) {
          callback(null, [{ address: validated.address, family: validated.family }]);
          return;
        }
        callback(null, validated.address, validated.family);
      },
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain;q=0.8",
        "accept-encoding": "gzip, deflate, br",
        "user-agent": "Mozilla/5.0 (compatible; ThreadsAffiliateOps/1.0)"
      }
    }, (response) => {
      const status = Number(response.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        finish(resolve, { status, headers: response.headers, body: "" });
        return;
      }
      const contentLength = Number(headerValue(response.headers, "content-length") || 0);
      const encoding = headerValue(response.headers, "content-encoding").toLowerCase();
      if (contentLength > maxBytes) {
        response.destroy();
        finish(reject, contextError("Offer page is larger than the allowed response size."));
        return;
      }
      if (encoding && !["identity", "gzip", "deflate", "br"].includes(encoding)) {
        response.destroy();
        finish(reject, contextError("Offer page returned an unsupported compressed response."));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy();
          finish(reject, contextError("Offer page is larger than the allowed response size."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const compressed = Buffer.concat(chunks);
          const decoderOptions = { maxOutputLength: maxBytes };
          const decoded = encoding === "gzip"
            ? zlib.gunzipSync(compressed, decoderOptions)
            : encoding === "deflate"
              ? zlib.inflateSync(compressed, decoderOptions)
              : encoding === "br"
                ? zlib.brotliDecompressSync(compressed, decoderOptions)
                : compressed;
          if (decoded.length > maxBytes) throw contextError("Offer page is larger than the allowed response size.");
          finish(resolve, { status, headers: response.headers, body: decoded.toString("utf8") });
        } catch (error) {
          finish(reject, error?.code === "OFFER_PAGE_CONTEXT_FAILED"
            ? error
            : contextError("Offer page compression could not be decoded safely."));
        }
      });
      response.on("error", (error) => finish(reject, contextError(error.message || "Offer page response failed.")));
    });
    request.setTimeout(timeoutMs, () => request.destroy(contextError("Offer page request timed out.")));
    request.on("error", (error) => finish(reject,
      error?.code === "OFFER_PAGE_CONTEXT_FAILED" ? error : contextError(error.message || "Offer page request failed.")
    ));
    request.end();
  });
}

const NAMED_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"'
};

function decodeHtml(value) {
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith("#")) {
      const codePoint = normalized.startsWith("#x")
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, normalized) ? NAMED_ENTITIES[normalized] : match;
  });
}

function cleanText(value, maxLength = 1000) {
  return decodeHtml(value)
    .replace(/https?:\/\/[^\s<>"']+/gi, "[link]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function tagAttributes(tag) {
  const attributes = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = pattern.exec(tag))) {
    attributes[String(match[1]).toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function metaValues(html) {
  const values = {};
  for (const tag of String(html || "").match(/<meta\b[^>]*>/gi) || []) {
    const attributes = tagAttributes(tag);
    const key = String(attributes.name || attributes.property || attributes.itemprop || "").toLowerCase();
    if (key && attributes.content && !values[key]) values[key] = cleanText(attributes.content, 1000);
  }
  return values;
}

function collectObjects(value, output = [], depth = 0) {
  if (depth > 6 || value == null) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjects(item, output, depth + 1));
    return output;
  }
  if (typeof value !== "object") return output;
  output.push(value);
  Object.values(value).forEach((item) => {
    if (item && typeof item === "object") collectObjects(item, output, depth + 1);
  });
  return output;
}

function structuredProduct(html) {
  const objects = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(String(html || "")))) {
    try {
      collectObjects(JSON.parse(match[1]), objects);
    } catch {
      // Invalid JSON-LD must not prevent the rest of the page from being used.
    }
  }
  const hasType = (item, expected) => {
    const types = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
    return types.some((type) => String(type || "").toLowerCase() === expected);
  };
  const product = objects.find((item) => hasType(item, "product") || hasType(item, "productgroup")) || {};
  const offerSource = Array.isArray(product.offers) ? product.offers[0] : product.offers;
  const offer = offerSource && typeof offerSource === "object"
    ? offerSource
    : objects.find((item) => hasType(item, "offer")) || {};
  const brand = typeof product.brand === "object" ? product.brand?.name : product.brand;
  return {
    name: cleanText(product.name, 200),
    description: cleanText(product.description, 1200),
    brand: cleanText(brand, 120),
    price: cleanText(offer.price || offer.lowPrice || offer.highPrice, 40),
    currency: cleanText(offer.priceCurrency, 12),
    availability: cleanText(offer.availability, 160)
  };
}

function visiblePageText(html, maxLength) {
  return cleanText(String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|section|article|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n"), maxLength);
}

function extractOfferPageContext(html, options = {}) {
  const maxChars = Number(options.maxChars || DEFAULT_MAX_CHARS);
  const meta = metaValues(html);
  const titleMatch = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const product = structuredProduct(html);
  const title = cleanText(meta["og:title"] || product.name || titleMatch?.[1], 200);
  const description = cleanText(meta.description || meta["og:description"] || product.description, 1400);
  const text = visiblePageText(html, maxChars);
  const evidence = {
    securityLabel: "UNTRUSTED_WEBPAGE_DATA",
    pageTitle: title,
    pageDescription: description,
    product,
    pageText: text
  };
  const contextText = JSON.stringify(evidence, null, 2).slice(0, maxChars);
  return { title, description, product, text, contextText, characterCount: contextText.length };
}

async function loadOfferPageContext(targetUrl, options = {}) {
  const maxRedirects = Number(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS);
  const requestImpl = options.requestImpl || requestOfferPage;
  let current = new URL(String(targetUrl || ""));
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const validated = await validatePublicHttpsUrl(current, options);
    const response = await requestImpl(validated, options);
    const status = Number(response.status || 0);
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = headerValue(response.headers, "location");
      if (!location) throw contextError("Offer page redirect did not include a destination.");
      current = new URL(location, current);
      continue;
    }
    if (status < 200 || status >= 300) throw contextError(`Offer page returned HTTP ${status || "error"}.`);
    const contentType = headerValue(response.headers, "content-type").toLowerCase();
    if (contentType && !/(text\/html|application\/xhtml\+xml|text\/plain)/.test(contentType)) {
      throw contextError("Offer page did not return readable text or HTML.");
    }
    const extracted = extractOfferPageContext(response.body, options);
    if (!extracted.title && !extracted.description && extracted.text.length < 40) {
      throw contextError("Offer page did not contain enough readable product information.");
    }
    return {
      status: "ready",
      sourceDomain: current.hostname,
      fetchedAt: new Date().toISOString(),
      ...extracted
    };
  }
  throw contextError("Offer page exceeded the redirect limit.");
}

function publicContextSummary(context) {
  return {
    status: context?.status || "unavailable",
    sourceDomain: String(context?.sourceDomain || ""),
    title: String(context?.title || ""),
    characterCount: Number(context?.characterCount || 0),
    fetchedAt: String(context?.fetchedAt || ""),
    error: String(context?.error || "").slice(0, 240)
  };
}

async function resolveOfferPageContext(targetUrl, config, options = {}) {
  if (!config.offerPageContextEnabled) return { status: "disabled", contextText: "" };
  try {
    const loader = options.loader || loadOfferPageContext;
    return await loader(targetUrl, {
      timeoutMs: config.offerPageTimeoutMs,
      maxBytes: config.offerPageMaxBytes,
      maxChars: config.offerPageMaxChars,
      ...options.loaderOptions
    });
  } catch (error) {
    return {
      status: "unavailable",
      contextText: "",
      error: String(error?.message || "Offer page could not be read.").slice(0, 240)
    };
  }
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_CHARS,
  extractOfferPageContext,
  isPrivateAddress,
  loadOfferPageContext,
  publicContextSummary,
  requestOfferPage,
  resolveOfferPageContext,
  validatePublicHttpsUrl
};

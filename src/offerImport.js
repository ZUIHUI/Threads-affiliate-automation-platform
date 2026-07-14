const crypto = require("node:crypto");

const { upsertRealOffer } = require("./offerManagement");

const MAX_IMPORT_BYTES = 256 * 1024;
const MAX_IMPORT_ROWS = 500;

const FIELD_ALIASES = {
  campaignName: ["campaignname", "campaign", "campaign_name"],
  targetPersona: ["targetpersona", "persona", "audience", "target_persona"],
  productName: ["productname", "product", "name", "product_name"],
  offer: ["offer", "description", "offerdetail", "offer_detail"],
  network: ["network", "affiliateplatform", "affiliate_network", "platform"],
  commissionModel: ["commissionmodel", "commission_model", "model"],
  commissionValue: ["commissionvalue", "commission_value", "commission", "payout"],
  currency: ["currency"],
  targetUrl: ["targeturl", "target_url", "landingurl", "landing_url", "affiliateurl", "affiliate_url", "url"],
  slug: ["slug", "trackingslug", "tracking_slug"],
  subIdParam: ["subidparam", "sub_id_param", "subidparameter", "trackingparameter", "tracking_parameter"],
  appendUtm: ["appendutm", "append_utm"]
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizedKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "");
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on", "y"].includes(String(value || "").trim().toLowerCase());
}

function parseCsvRows(content) {
  const text = String(content || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === "," && !quoted) {
      row.push(field);
      field = "";
      continue;
    }
    if ((character === "\n" || character === "\r") && !quoted) {
      row.push(field);
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      field = "";
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      continue;
    }
    field += character;
  }

  if (quoted) {
    const error = new Error("CSV contains an unterminated quoted field.");
    error.statusCode = 400;
    throw error;
  }
  row.push(field);
  if (row.some((value) => String(value).trim())) rows.push(row);
  return rows;
}

function parseCsv(content) {
  const csvRows = parseCsvRows(content);
  if (csvRows.length < 2) {
    const error = new Error("CSV must contain a header and at least one offer row.");
    error.statusCode = 400;
    throw error;
  }
  const headers = csvRows[0].map(normalizedKey);
  if (headers.some((header) => !header)) {
    const error = new Error("CSV contains an empty header.");
    error.statusCode = 400;
    throw error;
  }
  if (new Set(headers).size !== headers.length) {
    const error = new Error("CSV contains duplicate headers.");
    error.statusCode = 400;
    throw error;
  }
  return csvRows.slice(1).map((values, index) => ({
    rowNumber: index + 2,
    data: Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""]))
  }));
}

function extractJsonRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["offers", "items", "data", "results"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [payload];
}

function parseJson(content) {
  let payload;
  try {
    payload = JSON.parse(String(content || ""));
  } catch {
    const error = new Error("JSON import file is invalid.");
    error.statusCode = 400;
    throw error;
  }
  return extractJsonRows(payload).map((data, index) => ({ rowNumber: index + 1, data }));
}

function normalizeOfferRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return {};
  const normalized = new Map(Object.entries(row).map(([key, value]) => [normalizedKey(key), value]));
  const result = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const alias = aliases.find((key) => normalized.has(normalizedKey(key)));
    if (alias) result[field] = normalized.get(normalizedKey(alias));
  }
  result.appendUtm = parseBoolean(result.appendUtm);
  return result;
}

function detectFormat(input) {
  const requested = String(input.format || "").trim().toLowerCase();
  if (["csv", "json"].includes(requested)) return requested;
  const fileName = String(input.fileName || "").toLowerCase();
  if (fileName.endsWith(".csv")) return "csv";
  if (fileName.endsWith(".json")) return "json";
  const content = String(input.content || "").trim();
  if (content.startsWith("[") || content.startsWith("{")) return "json";
  return "csv";
}

function parseOfferImport(input = {}) {
  if (Array.isArray(input.offers)) {
    if (input.offers.length > MAX_IMPORT_ROWS) {
      const error = new Error(`Offer import is limited to ${MAX_IMPORT_ROWS} rows.`);
      error.statusCode = 413;
      throw error;
    }
    return input.offers.map((data, index) => ({ rowNumber: index + 1, data: normalizeOfferRow(data) }));
  }

  const content = String(input.content || "");
  if (!content.trim()) {
    const error = new Error("Import file content is required.");
    error.statusCode = 400;
    throw error;
  }
  if (Buffer.byteLength(content, "utf8") > MAX_IMPORT_BYTES) {
    const error = new Error(`Offer import files are limited to ${MAX_IMPORT_BYTES / 1024} KB.`);
    error.statusCode = 413;
    throw error;
  }
  const rows = detectFormat(input) === "json" ? parseJson(content) : parseCsv(content);
  if (rows.length > MAX_IMPORT_ROWS) {
    const error = new Error(`Offer import is limited to ${MAX_IMPORT_ROWS} rows.`);
    error.statusCode = 413;
    throw error;
  }
  return rows.map((row) => ({ ...row, data: normalizeOfferRow(row.data) }));
}

function replaceState(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function makeEventId() {
  return `evt_${crypto.randomBytes(6).toString("hex")}`;
}

function importOffers(state, input, config, options = {}) {
  const dryRun = options.dryRun === true;
  const parsedRows = parseOfferImport(input);
  let workingState = clone(state);
  const results = [];

  for (const row of parsedRows) {
    const candidate = clone(workingState);
    try {
      const result = upsertRealOffer(candidate, row.data, config);
      workingState = candidate;
      const action = result.created.link ? "create" : "update";
      results.push({
        rowNumber: row.rowNumber,
        status: dryRun ? `ready_${action}` : action,
        campaignName: result.campaign.name,
        productName: result.product.name,
        network: result.link.network,
        slug: result.link.slug,
        trackingUrl: result.trackingUrl,
        error: ""
      });
    } catch (error) {
      results.push({
        rowNumber: row.rowNumber,
        status: "error",
        campaignName: String(row.data.campaignName || ""),
        productName: String(row.data.productName || ""),
        network: String(row.data.network || ""),
        slug: String(row.data.slug || ""),
        trackingUrl: "",
        error: error.message || "Offer validation failed."
      });
    }
  }

  const validRows = results.filter((result) => result.status !== "error");
  const createdRows = validRows.filter((result) => result.status.endsWith("create"));
  const updatedRows = validRows.filter((result) => result.status.endsWith("update"));
  if (!dryRun && validRows.length) {
    workingState.events.unshift({
      id: makeEventId(),
      type: "offer.batch_imported",
      fileName: String(input.fileName || "batch"),
      total: results.length,
      imported: validRows.length,
      failed: results.length - validRows.length,
      createdAt: new Date().toISOString()
    });
    replaceState(state, workingState);
  }

  return {
    dryRun,
    summary: {
      fileName: String(input.fileName || "batch"),
      total: results.length,
      valid: validRows.length,
      created: createdRows.length,
      updated: updatedRows.length,
      failed: results.length - validRows.length,
      imported: dryRun ? 0 : validRows.length
    },
    rows: results
  };
}

module.exports = {
  FIELD_ALIASES,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  detectFormat,
  importOffers,
  normalizeOfferRow,
  parseCsv,
  parseOfferImport
};

const { buildPrompt } = require("./contentTemplates");

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    drafts: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          hook: { type: "string" },
          post: { type: "string" },
          cta: { type: "string" },
          risk_note: { type: "string" }
        },
        required: ["hook", "post", "cta", "risk_note"]
      }
    }
  },
  required: ["drafts"]
};

function shouldUseOpenAI(config, input = {}) {
  const provider = input.provider || config.aiDraftProvider;
  return provider === "openai" && Boolean(config.openaiApiKey);
}

function extractText(payload) {
  if (payload.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (content.type === "text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function normalizeDrafts(value) {
  const parsed = Array.isArray(value) ? { drafts: value } : value;
  if (!parsed || !Array.isArray(parsed.drafts)) {
    throw new Error("OpenAI response did not contain a drafts array.");
  }
  return parsed.drafts.slice(0, 5).map((draft, index) => ({
    type: draft.type || `AI 草稿 ${index + 1}`,
    ratio: draft.ratio || (index === 4 ? "conversion" : "trust"),
    hook: String(draft.hook || "").trim(),
    post: String(draft.post || "").trim(),
    cta: String(draft.cta || "").trim(),
    risk_note: String(draft.risk_note || "").trim() || "需人工複核風險。"
  }));
}

async function generateOpenAIDrafts({ topic, config, fetchImpl = fetch }) {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required for OpenAI draft generation.");
  }

  const response = await fetchImpl(`${config.openaiBaseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openaiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.openaiModel,
      input: buildPrompt(topic),
      text: {
        format: {
          type: "json_schema",
          name: "threads_affiliate_drafts",
          strict: true,
          schema: DRAFT_SCHEMA
        }
      }
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    const message = payload.error?.message || response.statusText || "OpenAI request failed.";
    throw new Error(message);
  }

  const text = extractText(payload);
  if (!text) {
    throw new Error("OpenAI response did not include output text.");
  }
  return normalizeDrafts(JSON.parse(text));
}

module.exports = {
  DRAFT_SCHEMA,
  extractText,
  generateOpenAIDrafts,
  normalizeDrafts,
  shouldUseOpenAI
};

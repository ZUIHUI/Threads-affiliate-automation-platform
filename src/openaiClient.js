const { buildPrompt } = require("./contentTemplates");

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    drafts: {
      type: "array",
      minItems: 3,
      maxItems: 3,
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
  if (parsed.drafts.length !== 3) {
    throw new Error("OpenAI response must contain exactly three Threads draft versions.");
  }
  const versionTypes = [
    "版本 A：日常自然版",
    "版本 B：活潑有梗版",
    "版本 C：互動討論版"
  ];
  return parsed.drafts.slice(0, 3).map((draft, index) => ({
    type: versionTypes[index],
    ratio: "conversion",
    hook: String(draft.hook || "").trim(),
    post: String(draft.post || "").trim(),
    cta: String(draft.cta || "").trim(),
    risk_note: String(draft.risk_note || "").trim() || "需人工複核風險。"
  }));
}

function openAITimeoutError(timeoutMs) {
  const seconds = Math.ceil(timeoutMs / 1000);
  const error = new Error(`OpenAI 產生文案逾時（${seconds} 秒），請稍後重試。`);
  error.code = "OPENAI_TIMEOUT";
  error.statusCode = 504;
  return error;
}

async function generateOpenAIDrafts({ topic, offerContext = {}, config, fetchImpl = fetch }) {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required for OpenAI draft generation.");
  }

  const timeoutMs = Math.max(1, Number(config.openaiTimeoutMs || 90_000));
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(openAITimeoutError(timeoutMs));
    }, timeoutMs);
  });
  const request = (async () => {
    const response = await fetchImpl(`${config.openaiBaseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.openaiApiKey}`,
        "content-type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.openaiModel,
        input: buildPrompt(topic, offerContext),
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
  })();

  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (error?.name === "AbortError") throw openAITimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  DRAFT_SCHEMA,
  extractText,
  generateOpenAIDrafts,
  normalizeDrafts,
  shouldUseOpenAI
};

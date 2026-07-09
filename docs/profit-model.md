# Autonomous Profit Model

## Goal

Build a self-running affiliate workflow for Threads:

1. Monitor offer and ad signals.
2. Select the best monetization model.
3. Generate natural, truthful scripts with affiliate disclosure.
4. Schedule low-risk posts.
5. Route clicks through owned tracking links.
6. Feed clicks, conversions, and revenue back into the next scoring cycle.

## Selected Operating Model

The default model is **信任型工具組推薦**:

- Mechanism: Threads educational content leads to a tool/resource recommendation.
- Revenue: CPS, CPA, or recurring affiliate commission.
- Why it fits: it can run with low production cost, avoids hard-sell copy, and can reuse the same dashboard signals.
- Guardrail: every commercial post must include `DEFAULT_DISCLOSURE_TEXT` or `#ad`.

## Profit Engine Scoring

The engine scores four playbooks:

| Model | Use Case | Revenue Mode |
| --- | --- | --- |
| 信任型工具組推薦 | Natural creator-style tool recommendations | CPS / CPA |
| 免費資源換名單 | Templates or prompt packs that lead to email nurturing | CPA / recurring affiliate |
| 比較型決策內容 | Comparison posts for high-intent buyers | CPS / recurring commission |
| 低價微產品導流 | Low-ticket digital product plus affiliate upsell | Product revenue + affiliate |

Scores use:

- Existing active campaign and product availability.
- Current click, conversion, and revenue signals.
- Content fatigue from repeated use of the same model.
- Live ad and offer signals from configured feeds or Meta Ad Library.
- A fixed base score derived from operating complexity and monetization fit.

## Ad Intelligence Inputs

The dashboard tracks four source classes:

- Meta Ad Library: observe hooks, CTA language, and product angles.
- Google Ads Transparency Center: observe search and video ad claims.
- Affiliate network EPC: rank offers by commission and conversion quality.
- Landing page scan: extract product offer, price, proof, and risk language.

The current implementation supports live ingestion through:

- `AD_INTELLIGENCE_FEED_URLS`: comma-separated JSON ad signal endpoints.
- `AFFILIATE_OFFER_FEED_URLS`: comma-separated JSON offer/program endpoints.
- `META_AD_LIBRARY_ACCESS_TOKEN` plus `META_AD_LIBRARY_QUERY`: Meta Ad Library
  API search using the official `ads_archive` endpoint.

Each run stores normalized `externalSignals`, `sourceStatuses`, `lastIngestAt`,
and the selected `adInsights` in the dashboard state. Secrets are read only from
environment variables; access tokens and common API-key query params are stripped
from URLs before they are shown in the admin UI.

Offer signals with a landing URL are also promoted into active products and
affiliate tracking links. `AUTONOMY_MAX_OFFERS_PER_RUN` caps how many new offers
can enter the product pool per run, so the engine can keep discovering offers
without flooding the queue.

## Revenue Feedback Loop

Affiliate networks or no-code routers can call `POST /api/conversions` with a
link slug or `affiliateLinkId`, a `networkEventId`, and commission values. The
endpoint is idempotent by `networkEventId`, updates link-level conversions and
revenue, and writes a conversion event for the dashboard. The next profit-engine
cycle uses those updated revenue signals when ranking models and offers.

## AI Script Generation

When `PROFIT_SCRIPT_PROVIDER=openai` and `OPENAI_API_KEY` are set, the autonomous
profit engine previews the selected model, offer, ad signal, tracking link, and
disclosure rule, then asks the OpenAI Responses API for natural Threads scripts
using a strict JSON schema. The engine still applies local guardrails before
scheduling: disclosure is inserted if missing, the tracking link is appended if
missing, and the script source is stored as `openai` in the dashboard.

If OpenAI is not configured or the request fails, the same run falls back to the
local deterministic script template and stores `scriptSource=template`, so the
worker can keep running without manual recovery.

Before a script is scheduled, the engine validates it with the local Threads
post validator. Overlong scripts are shortened while preserving disclosure and
the tracking link. Scripts that still exceed limits, contain too many links, or
trip high-risk claim checks are not scheduled; they are stored in
`blockedScripts` on the run and surfaced in the dashboard guardrail feed.

## Compliance Rules

The FTC says social endorsements need clear disclosure when there is a financial
or other material connection to a brand. It also says disclosure should be hard
to miss, in the same language as the endorsement, and not hidden behind profile
pages or vague abbreviations.

Sources:

- https://www.ftc.gov/business-guidance/resources/disclosures-101-social-media-influencers
- https://www.ftc.gov/business-guidance/advertising-marketing/endorsements-influencers-reviews
- https://developers.facebook.com/docs/graph-api/reference/ads_archive/
- https://developers.facebook.com/docs/threads/threads-api/guides/content-publishing/

## Runtime

Set these variables on the cloud service:

```env
AUTONOMY_MODE=true
AUTONOMY_INTERVAL_MS=21600000
AUTONOMY_MAX_SCRIPTS_PER_RUN=3
AUTONOMY_MAX_OFFERS_PER_RUN=3
THREADS_DRY_RUN=true
PROFIT_SCRIPT_PROVIDER=openai
AD_INTELLIGENCE_FEED_URLS=https://example.com/ad-signals.json
AFFILIATE_OFFER_FEED_URLS=https://example.com/offers.json
META_AD_LIBRARY_QUERY=ai automation
META_AD_LIBRARY_ACCESS_TOKEN=...
CONVERSION_WEBHOOK_SECRET=...
```

`THREADS_DRY_RUN=true` keeps the engine self-running without making live Threads
posts. Set `THREADS_DRY_RUN=false` only after Threads credentials, links, and
disclosure copy are verified.

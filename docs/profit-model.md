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
- A fixed base score derived from operating complexity and monetization fit.

## Ad Intelligence Inputs

The dashboard tracks four source classes:

- Meta Ad Library: observe hooks, CTA language, and product angles.
- Google Ads Transparency Center: observe search and video ad claims.
- Affiliate network EPC: rank offers by commission and conversion quality.
- Landing page scan: extract product offer, price, proof, and risk language.

The first implementation stores ad insights locally and uses deterministic scoring.
External APIs can be attached later without changing the dashboard contract.

## Compliance Rules

The FTC says social endorsements need clear disclosure when there is a financial
or other material connection to a brand. It also says disclosure should be hard
to miss, in the same language as the endorsement, and not hidden behind profile
pages or vague abbreviations.

Sources:

- https://www.ftc.gov/business-guidance/resources/disclosures-101-social-media-influencers
- https://www.ftc.gov/business-guidance/advertising-marketing/endorsements-influencers-reviews

## Runtime

Set these variables on the cloud service:

```env
AUTONOMY_MODE=true
AUTONOMY_INTERVAL_MS=21600000
AUTONOMY_MAX_SCRIPTS_PER_RUN=3
THREADS_DRY_RUN=true
```

`THREADS_DRY_RUN=true` keeps the engine self-running without making live Threads
posts. Set `THREADS_DRY_RUN=false` only after Threads credentials, links, and
disclosure copy are verified.

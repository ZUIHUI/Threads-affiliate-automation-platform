# Threads Affiliate Ops Architecture

Verified against Meta Threads documentation on 2026-07-08.

## Product Scope

Threads Affiliate Ops automates a compliant affiliate publishing loop:

1. Create campaigns and products.
2. Generate affiliate tracking links with UTM parameters.
3. Generate or write Threads post drafts.
4. Validate disclosure, text length, link count, and topic tag limits.
5. Approve and schedule posts.
6. Publish through the Threads API queue.
7. Track clicks, conversions, revenue, and automation runs in the dashboard.

## Threads Publishing Model

The Threads API publishes a text post in two steps:

1. `POST /{threads-user-id}/threads` creates a media container.
2. `POST /{threads-user-id}/threads_publish` publishes that container.

The app models that with post statuses:

`draft -> scheduled -> container_created -> published`

Local/demo mode uses:

`scheduled -> simulated`

Failures become `failed` or `blocked_credentials`.

## Current Threads Constraints

The queue enforces the operational constraints that matter for affiliate posts:

- Text posts are limited to 500 UTF-8 bytes.
- API-published posts are limited to 250 posts per rolling 24-hour period.
- Text-only link posts can use `link_attachment`.
- Threads posts containing more than 5 unique links will fail.
- Topic tags are limited to 50 characters and cannot contain periods or ampersands.
- Image/video media must be on a public URL if those post types are added later.

Official references:

- https://developers.facebook.com/docs/threads/
- https://developers.facebook.com/documentation/threads/posts
- https://developers.facebook.com/documentation/threads/overview
- https://developers.facebook.com/documentation/threads/reference

## Runtime Components

- `server.js`: HTTP server, API router, static admin UI, redirect tracking.
- `src/automation.js`: draft generation, queue processing, dashboard metrics.
- `src/profitEngine.js`: monetization scoring, offer autopilot, and autonomous script scheduling.
- `src/adIntelligenceClient.js`: ad, offer, and Meta Ad Library signal ingestion.
- `src/profitScriptGenerator.js`: OpenAI profit-script generation with template fallback.
- `src/readiness.js`: deployment and autonomy readiness checks for product operations.
- `src/openaiClient.js`: optional OpenAI Responses API draft generator with local template fallback.
- `src/threadsClient.js`: Threads Graph API calls.
- `src/validators.js`: post validation rules.
- `src/store.js`: JSON development store.
- `public/`: management dashboard.
- `db/schema.sql`: production PostgreSQL schema.

## Draft Generation

Draft generation uses OpenAI by default and has a local fallback:

- `AI_DRAFT_PROVIDER=openai`: calls the OpenAI Responses API when `OPENAI_API_KEY` is present, asking for a strict JSON schema with five drafts.
- `AI_DRAFT_PROVIDER=template`: deterministic local templates based on the requested prompt and five post types.

If OpenAI mode is selected without a key, the app falls back to local templates so the system remains runnable offline and in dry-run demos.

## Production Notes

The JSON store is intentionally simple for local MVP development. Production should use `db/schema.sql` on PostgreSQL and move `THREADS_ACCESS_TOKEN` into the deployment platform secret manager.

For real affiliate operation, keep a visible disclosure in every commercial post. The default is `含聯盟連結`, and `#ad` is also accepted by the validator.

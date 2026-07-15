# Production Dry-run Runbook

Use this runbook to deploy the Threads affiliate operations system safely. Production must start in dry-run mode. Live Threads publishing is allowed only after auth, tracking, conversion feedback, and readiness checks have been verified.

## 1. Purpose

The first production deployment should prove that the dashboard, admin APIs, redirect tracking, conversion webhook, AI draft generation, and publishing queue all work without creating live Threads posts.

Keep `THREADS_DRY_RUN=true` until:

- `/health` is healthy.
- `/api/readiness` reports no live publish blockers.
- dashboard login is confirmed.
- redirect tracking is tested.
- conversion webhook feedback is tested.
- a dry-run queue publish has completed.

## 2. Required Environment Variables

Set these on Render, Railway, Fly.io, or your chosen host. Do not commit secrets to Git.

```env
DATABASE_URL=postgresql://...
DATABASE_AUTO_MIGRATE=true
DATABASE_SSL=false

PUBLIC_BASE_URL=https://your-service.example

ADMIN_TOKEN=<long-random-secret>
ADMIN_PASSWORD=<optional-long-random-secret>
ADMIN_SESSION_SECRET=<long-random-cookie-secret>
ADMIN_SESSION_TTL_MS=86400000
ADMIN_TOKEN_ROLE=admin
ADMIN_PASSWORD_ROLE=admin

THREADS_DRY_RUN=true
THREADS_USER_ID=<threads-user-id-required-before-live>
THREADS_ACCESS_TOKEN=<long-lived-token-required-before-live>
THREADS_GRAPH_BASE=https://graph.threads.net/v1.0
THREADS_PUBLISH_DELAY_MS=30000

OPENAI_API_KEY=<optional-for-openai-drafts>
AI_DRAFT_PROVIDER=openai
PROFIT_SCRIPT_PROVIDER=openai
OPENAI_MODEL=gpt-5.2
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_TIMEOUT_MS=90000
AI_WEB_RESEARCH_ENABLED=true
AI_WEB_RESEARCH_TIMEOUT_MS=60000
AI_WEB_RESEARCH_MAX_SOURCES=6

CONVERSION_WEBHOOK_SECRET=<long-random-webhook-secret>

ENABLE_WORKER=false
AUTONOMY_MODE=false
AUTOMATION_INTERVAL_MS=60000
WORKER_LEASE_MS=180000
AUTONOMY_INTERVAL_MS=21600000
ALLOW_DEMO_OFFERS=false

CONTENT_SIMILARITY_THRESHOLD=0.88
CONTENT_FATIGUE_PRODUCT_WINDOW_HOURS=24
CONTENT_FATIGUE_MAX_PRODUCT_POSTS_PER_WINDOW=1
CONTENT_FATIGUE_HOOK_WINDOW_DAYS=14
CONTENT_FATIGUE_MODEL_DAILY_CAP=3
CONTENT_FATIGUE_COMMERCIAL_WINDOW_POSTS=3
CONTENT_FATIGUE_MAX_COMMERCIAL_POSTS_PER_WINDOW=1
```

### Monetizable Offer Setup

Use the System Settings form or the authenticated API. `targetUrl` must be the affiliate network tracking URL, not the merchant's ordinary product page.

```bash
curl -X POST https://<domain>/api/offers \
  -H "Content-Type: application/json" \
  -H "x-admin-token: <ADMIN_TOKEN>" \
  -d '{"campaignName":"Creator tools","targetPersona":"Taiwan creators","productName":"Automation toolkit","offer":"Recurring commission","network":"ClickBank","commissionModel":"CPS","commissionValue":25,"currency":"USD","targetUrl":"https://<affiliate-network-tracking-url>","slug":"automation-toolkit","subIdParam":"tid","appendUtm":false}'
```

The response returns the campaign, product, affiliate link, and public `/r/{slug}` tracking URL. Demo, local, and `example.com` links never satisfy the live publishing gate or revenue totals.

For an initial catalog or a manual network export, use **System Settings > Batch import affiliate offers**. Download the CSV template, select a CSV or JSON file, run preview validation, then confirm the import. The preview never writes data. Import accepts up to 500 rows and 256 KB per file; valid rows are committed while invalid rows are reported without leaving partial campaign, product, or link records. Re-importing the same network URL updates the existing offer instead of creating a duplicate.

The same workflow is available through the authenticated endpoints:

- `POST /api/offers/import/preview`
- `POST /api/offers/import`

Send `{ "fileName": "offers.csv", "format": "csv", "content": "..." }`, or send structured JSON as `{ "offers": [...] }`. Required offer fields are `campaignName`, `targetPersona`, `productName`, `network`, and an HTTPS `targetUrl`; optional columns use the defaults shown in `public/affiliate-offer-template.csv`. Automated affiliate-network synchronization remains configured separately through `AFFILIATE_OFFER_FEED_URLS`.

With `OFFER_PAGE_CONTEXT_ENABLED=true` (the default), manual AI draft generation and autonomous profit scripts read bounded product evidence from the selected affiliate landing page before writing. The server validates every HTTPS redirect and blocks local, private, metadata, oversized, unsupported, and non-text responses. Page content is marked as untrusted prompt data.

When `AI_WEB_RESEARCH_ENABLED=true`, an unreadable dynamic merchant page triggers a second research layer through the OpenAI Responses API `web_search` tool. The model must verify an exact product match, return at least two facts, and expose at least one HTTPS source before the evidence can be used for copy. Otherwise the system reports the failure and uses only verified database fields. Enabling this sends the public affiliate URL and offer fields to OpenAI and adds one paid API request when direct page extraction fails.

Notes:

- `ADMIN_TOKEN` or `ADMIN_PASSWORD` is required before exposing the dashboard.
- `ADMIN_SESSION_SECRET` signs the dashboard login cookie.
- `THREADS_USER_ID` and `THREADS_ACCESS_TOKEN` may be configured during dry-run, but live publishing must stay off until readiness passes.
- `ENABLE_WORKER=true` and `AUTONOMY_MODE=true` should be enabled only after dry-run verification is complete.
- `AUTOMATION_INTERVAL_MS` controls how often the worker checks for an executable mission. `AUTONOMY_INTERVAL_MS` remains the slower research/AI cadence, so a one-minute heartbeat does not imply a one-minute OpenAI request.
- `WORKER_LEASE_MS` prevents overlapping workers from executing the same mission during deploys or horizontal scaling.
- `AI_WEB_RESEARCH_TIMEOUT_MS` bounds the fallback research request; `AI_WEB_RESEARCH_MAX_SOURCES` limits stored source provenance.
- `CONTENT_FATIGUE_*` controls product, hook, CTA, model, similarity, and commercial-ratio guardrails. Keep conservative defaults until review queue quality is proven.

## 3. Initial Safe Deployment

1. Create a Render, Railway, or Fly.io web service from the GitHub repository.
2. Attach managed PostgreSQL and set `DATABASE_URL`.
3. Set `THREADS_DRY_RUN=true`.
4. Set `ADMIN_TOKEN` or `ADMIN_PASSWORD`.
5. Set `ADMIN_SESSION_SECRET`.
6. Set `CONVERSION_WEBHOOK_SECRET`.
7. Set `PUBLIC_BASE_URL` to the deployed service URL.
8. Deploy the app.
9. Check the health endpoint:

```bash
curl https://<domain>/health
```

Expected: `200` with `{ "ok": true }`.

10. Check readiness:

```bash
curl https://<domain>/api/readiness
```

Expected in the first safe deploy:

- `summary.mode` is usually `dry_run_ready`, `needs_attention`, or `blocked` depending on optional config.
- `liveGate.enforced` is `false` while `THREADS_DRY_RUN=true`.
- `liveGate.missingEnv` lists what must be fixed before live mode.

11. Open `https://<domain>/`.

Expected: the dashboard requires login or redirects to `/login`.

## 4. Dry-run Functional Test

Use the dashboard unless an API route already exists for the item.

1. Confirm at least one test campaign exists. The seeded demo campaign is acceptable for the first smoke test.
2. Confirm at least one test product exists. The seeded demo product is acceptable for the first smoke test.
3. Create or confirm an affiliate link from the dashboard.
4. Generate AI drafts from the dashboard.
5. Approve a low-risk draft if the current workflow allows it, or use the existing dry-run schedule flow.
6. Run automation while `THREADS_DRY_RUN=true`.

Example with an admin token:

```bash
curl -X POST https://<domain>/api/automation/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d "{\"source\":\"dry-run-smoke\"}"
```

Expected:

- no live Threads post is created.
- run status is `completed`.
- published output is counted as simulated.
- dashboard metrics show simulated publish activity.

7. Test redirect tracking:

```bash
curl -i https://<domain>/r/<slug>
```

Expected: `302` redirect to the affiliate target URL. Post attribution is written to the configured `subIdParam` only. UTM fields are added only when `appendUtm=true`.

8. Test conversion webhook:

```bash
curl -X POST https://<domain>/api/conversions \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: <CONVERSION_WEBHOOK_SECRET>" \
  -d "{\"slug\":\"<slug>\",\"networkEventId\":\"dry-run-order-001\",\"commissionValue\":8,\"orderValue\":49,\"currency\":\"USD\",\"status\":\"approved\"}"
```

Expected:

- response status is `201` for a new conversion.
- duplicate `networkEventId` returns duplicate-safe behavior.
- dashboard revenue/conversion metrics update.

For networks that only support query-string postbacks, use HTTPS and map their fields to the supported aliases:

```text
https://<domain>/api/conversions?webhook_secret=<CONVERSION_WEBHOOK_SECRET>&slug=<slug>&transaction_id={transaction_id}&commission_amount={commission}&sale_amount={sale_amount}&subid={subid}&currency=USD
```

Prefer the header-protected POST form when the affiliate network supports custom headers because URL secrets may appear in provider access logs.

## 5. Readiness Gate Test

Verify blocked readiness before live mode.

Suggested checks:

1. Remove or set an invalid public URL, for example leave `PUBLIC_BASE_URL` as localhost.
2. Remove `THREADS_ACCESS_TOKEN`.
3. Remove `THREADS_USER_ID`.
4. Remove `DEFAULT_DISCLOSURE_TEXT`.
5. For live autonomy, remove `DATABASE_URL` or `CONVERSION_WEBHOOK_SECRET`.
6. Set `THREADS_DRY_RUN=false` in a temporary test environment while readiness is blocked.

Then call:

```bash
curl https://<domain>/api/readiness
```

Expected:

- `liveGate.allowed=false`
- `liveGate.enforced=true` when `THREADS_DRY_RUN=false`
- `liveGate.reasons` contains machine-readable block reasons
- `liveGate.missingEnv` lists missing config keys
- the dashboard readiness panel shows live mode as blocked and displays the reason

Try to run the queue:

```bash
curl -X POST https://<domain>/api/automation/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d "{\"source\":\"blocked-live-check\",\"ignoreReadiness\":true}"
```

Expected:

- response status is `409`
- response includes `run.readinessGate.allowed=false`
- live publish does not happen
- `ignoreReadiness` from the API request does not bypass the backend gate

Try autonomy with queue publishing:

```bash
curl -X POST https://<domain>/api/autonomy/cycle \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d "{\"source\":\"blocked-live-cycle\",\"force\":true,\"publishQueue\":true}"
```

Expected:

- response status is `409`
- response includes `cycle.status="blocked"`
- response includes `cycle.readinessGate.reasons`

If a direct publish-now action is used, it should also return `409` with `code=READINESS_BLOCKED` while live readiness is blocked.

## 6. Switching To Live Mode

Switch to live only after all checks below are true:

- `/health` returns healthy.
- `/api/readiness` has no live gate blockers.
- dashboard authentication is confirmed.
- admin API calls require auth.
- `CONVERSION_WEBHOOK_SECRET` is set.
- at least one real affiliate offer passes the `offer_inventory` readiness check.
- dry-run publish flow has completed successfully.
- `/r/{slug}` redirect tracking has been tested.
- `/api/conversions` has been tested with `x-webhook-secret`.
- dashboard revenue feedback has been verified.
- Threads credentials are valid.

Then set:

```bash
THREADS_DRY_RUN=false
```

Redeploy, then run one small publish queue test. Watch:

- `/api/readiness`
- dashboard readiness panel
- worker heartbeat, if enabled
- automation run messages
- platform logs

## 7. Rollback

To immediately return to safe mode:

```bash
THREADS_DRY_RUN=true
```

To stop unattended automation:

```bash
ENABLE_WORKER=false
AUTONOMY_MODE=false
```

Redeploy after changing environment variables. Confirm `/api/readiness` shows dry-run mode and that queue processing simulates instead of publishing.

## 8. Security Checklist

Before live publishing:

- Dashboard is not public.
- `/` and `/console.html` require login when admin auth is configured or production-like public URL is used.
- Admin APIs require `Authorization: Bearer <ADMIN_TOKEN>`, `x-admin-token`, `x-admin-password`, or a valid session cookie.
- `/api/export` requires admin auth.
- `/api/conversions` requires `x-webhook-secret`.
- `/r/{slug}` remains public.
- `/health` remains public.
- `GET /api/readiness` remains public read-only.
- Live publish is blocked when readiness is blocked.
- API requests cannot bypass readiness with `ignoreReadiness`.
- Secrets are stored only in platform environment variables.
- Secrets are not committed to Git.

## 9. Local Verification Commands

Use the bundled or system Node runtime:

```bash
node tests/run-tests.js
node tests/ui-contract.js
```

On this Windows/Codex machine, if `node` is not on PATH, use the Codex bundled Node path reported by the workspace runtime.

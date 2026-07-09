# Production Runbook

Use this runbook after your first successful Render deployment from `main` to move safely from dry-run to live.

## 0) Before deployment

- Confirm deploy target is `main` and up-to-date.
- Confirm your service URL in Render:
  - `https://threads-affiliate-automation-platform.onrender.com`
- Open and verify service logs for startup success.

## 1) Core environment variables

Set these first in Render Environment.

### Required baseline

- `PUBLIC_BASE_URL=https://<your-render-domain>`
- `ADMIN_TOKEN=<long random secret>` or `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET=<long random secret>`
- `ADMIN_SESSION_TTL_MS=86400000` (optional)
- `DATABASE_URL=postgres://...` (provided by Render Postgres when attached)
- `DATABASE_AUTO_MIGRATE=true`

### Enable automation

- `ENABLE_WORKER=true`
- `AUTONOMY_MODE=true`
- `AUTONOMY_INTERVAL_MS=21600000`
- `THREADS_DRY_RUN=true` (start here)
- `CONVERSION_WEBHOOK_SECRET=<long random secret>`
- `PUBLIC_BASE_URL` must be a reachable public URL

### Threads publishing

- `THREADS_GRAPH_BASE=https://graph.threads.net/v1.0`
- `THREADS_USER_ID=<threads user id>`
- `THREADS_ACCESS_TOKEN=<long-lived token>`
- `THREADS_PUBLISH_DELAY_MS=30000`

### AI and score signals (optional)

- `OPENAI_API_KEY=<key>`
- `AI_DRAFT_PROVIDER=openai`
- `PROFIT_SCRIPT_PROVIDER=openai`
- `OPENAI_MODEL=gpt-4o`
- `AD_INTELLIGENCE_FEED_URLS=<comma separated URL list>`
- `AFFILIATE_OFFER_FEED_URLS=<comma separated URL list>`
- `META_AD_LIBRARY_ACCESS_TOKEN=<optional>`
- `META_AD_LIBRARY_QUERY=ai automation`

## 2) First smoke check (dry-run)

1. Hit `/health` should return 200.
2. Hit `/api/readiness` and confirm:
   - `admin: true`
   - `readiness.summary.mode == dry_run_ready`
3. Open dashboard at `/` and ensure auth gate works.
4. Login via admin endpoint (`POST /api/admin/login`) using configured token/password.
5. Run:
   - `POST /api/automation/generate`
   - `POST /api/automation/run`

## 3) Tracking and attribution sanity check

1. Copy one valid `affiliateLink.slug` from dashboard, e.g. `ai-affiliate-prompt-pack`.
2. Open:
   - `https://<domain>/<slug>`
   - expected redirect: `/r/<slug>`
3. Confirm UTM/subid parameters exist in redirect:
   - `utm_source`
   - `utm_medium`
   - `utm_campaign`
   - `utm_content`
   - `subid`
   - `sub_id`
4. In Dashboard, verify click count increases.

## 4) Conversion webhook validation

1. Call `POST /api/conversions` with:
   - Header: `x-webhook-secret: <CONVERSION_WEBHOOK_SECRET>`
   - JSON body includes `slug`, `networkEventId`, `commissionValue`, `status`
2. Confirm revenue/conversion fields increase for the matched affiliate link.
3. Confirm attribution summary reflects the update.

## 5) Shift to live publish

Precondition checklist:

- `/api/readiness` returns `live_ready` (or `needs_attention` with explicit acceptance).
- `THREADS_DRY_RUN=false`
- `THREADS_USER_ID` and `THREADS_ACCESS_TOKEN` configured.
- `admin_auth` not blocked.
- Public URL is set and not localhost.
- Postgres connector is `ready`.

Then:

1. Set `THREADS_DRY_RUN=false`.
2. Redeploy.
3. Run small sample cycle with one post.
4. Confirm queue and publish health:
   - publish success events
   - no queue backlog growth
   - `readiness.summary.blocked == 0`

## 6) Ongoing operations

- After every deploy verify:
  - `/health`
  - `/api/readiness`
  - `/api/dashboard`
- Monitor:
  - worker heartbeat (`workerLease`)
  - recent events (`recentEvents`)
  - autonomy/publish success/error rates
- If worker or autonomy stalls:
  - temporarily disable autonomous mode
  - switch to manual admin checks
  - re-enable after issue is fixed

## 7) Smoke command set (PowerShell/cmd)

```bash
curl https://<domain>/health
curl https://<domain>/api/readiness
curl https://<domain>/api/dashboard
```

```bash
curl -X POST ^
  -H "Content-Type: application/json" ^
  -d "{\"token\":\"<ADMIN_TOKEN>\"}" ^
  https://<domain>/api/admin/login
```

```bash
curl -H "Content-Type: application/json" ^
  -H "x-webhook-secret: <CONVERSION_WEBHOOK_SECRET>" ^
  -d "{\"slug\":\"<slug>\",\"networkEventId\":\"event-001\",\"commissionValue\":8,\"orderValue\":49,\"currency\":\"USD\",\"status\":\"approved\"}" ^
  https://<domain>/api/conversions
```

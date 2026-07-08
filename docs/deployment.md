# Deployment

## Recommended Platform

Use Railway or Fly.io for the first production deployment:

- Always-on Node process for the scheduler worker.
- Managed PostgreSQL available in the same platform or via Neon/Supabase.
- Environment variables and secrets are straightforward.
- Docker deployment works without framework-specific hosting assumptions.

Vercel can host the UI/API, but recurring background publishing is better handled with a worker or cron-capable platform.

This repository includes:

- `Dockerfile` for container platforms.
- `railway.json` for Railway.
- `render.yaml` for Render Blueprint deployment.
- `/health` as the platform health check endpoint.

## Environment Variables

Required for live publishing:

```env
PUBLIC_BASE_URL=https://your-domain.example
THREADS_DRY_RUN=false
THREADS_USER_ID=your_threads_user_id
THREADS_ACCESS_TOKEN=your_long_lived_access_token
ENABLE_WORKER=true
```

Recommended:

```env
THREADS_GRAPH_BASE=https://graph.threads.net/v1.0
THREADS_PUBLISH_DELAY_MS=30000
AUTOMATION_INTERVAL_MS=60000
DEFAULT_DISCLOSURE_TEXT=含聯盟連結
AI_DRAFT_PROVIDER=openai
```

OpenAI draft generation:

```env
AI_DRAFT_PROVIDER=openai
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5.2
OPENAI_BASE_URL=https://api.openai.com/v1
```

For offline demos, set `AI_DRAFT_PROVIDER=template`.

## Database

Runtime persistence is enabled when `DATABASE_URL` is present.

The app stores its live dashboard state in `app_settings.value` under the key
`json_store_state`, while `db/schema.sql` also creates normalized tables for
future reporting and webhook expansion.

Required database variables:

```env
DATABASE_URL=postgresql://user:password@host:5432/database
DATABASE_AUTO_MIGRATE=true
DATABASE_SSL=false
```

Notes:

- `DATABASE_AUTO_MIGRATE=true` runs `db/schema.sql` on startup. The schema is idempotent.
- Set `DATABASE_SSL=true` only when your external Postgres provider requires TLS and the URL does not already include `sslmode=require`.
- Without `DATABASE_URL`, the app falls back to the local JSON file store for development.
- Store Threads and OpenAI tokens in platform environment variables, not in database rows.

## Threads App Setup

1. Create a Meta app with the Threads use case.
2. Request the needed permissions:
   - `threads_basic`
   - `threads_content_publish`
3. Generate and store a long-lived access token.
4. Set `THREADS_USER_ID` and `THREADS_ACCESS_TOKEN`.
5. Start with `THREADS_DRY_RUN=true`; switch to `false` only after queue validation passes.

## Worker Mode

Set `ENABLE_WORKER=true` to let the Node process run `runAutomation()` on an interval. Use one worker replica to avoid duplicate publishing. If you scale the web app horizontally, split the worker into a separate process and add a database lock around queue selection.

## Docker

Build:

```bash
docker build -t threads-affiliate-ops .
```

Run:

```bash
docker run --env-file .env -p 4173:4173 threads-affiliate-ops
```

## Railway

1. Create a new Railway project from this repository.
2. Railway will use `railway.json` and the root `Dockerfile`.
3. Add a PostgreSQL service to the project.
4. Set `DATABASE_URL` to the PostgreSQL connection URL exposed by Railway.
5. Add the remaining environment variables from `.env.example`.
6. Start with `THREADS_DRY_RUN=true`.
7. Set `PUBLIC_BASE_URL` to the Railway public domain after the first deploy.
8. Switch `THREADS_DRY_RUN=false` only after Threads credentials are verified.

## Render

1. Create a new Render Blueprint from this repository.
2. Render will read `render.yaml`, create the free `threads-affiliate-ops-db`, and inject `DATABASE_URL`.
3. Fill the `sync: false` secrets in the Render dashboard.
4. Keep `THREADS_DRY_RUN=true` for the first smoke test.
5. Set `PUBLIC_BASE_URL` to the Render service URL after deploy.

## Verification

Core verification:

```bash
node tests/run-tests.js
node tests/ui-contract.js
```

`tests/browser-smoke.js` is available as an optional real-browser check, but it is not part of the default suite because browser launch can hang on some local Windows/Codex runtime combinations. It has a hard timeout to avoid long-running background processes.

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

1. Create a PostgreSQL database.
2. Run `db/schema.sql`.
3. Migrate the JSON store adapter to PostgreSQL queries table by table.
4. Store access tokens as secret references, not raw database values.

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
3. Add the environment variables from `.env.example`.
4. Start with `THREADS_DRY_RUN=true`.
5. Set `PUBLIC_BASE_URL` to the Railway public domain after the first deploy.
6. Switch `THREADS_DRY_RUN=false` only after Threads credentials are verified.

## Render

1. Create a new Render Blueprint from this repository.
2. Render will read `render.yaml`.
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

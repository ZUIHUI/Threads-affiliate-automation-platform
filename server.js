const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const { createStore } = require("./src/store");
const { createPostgresStore } = require("./src/postgresStore");
const {
  buildDashboard,
  createPost,
  generateDraftsAsync,
  generateDrafts,
  recordConversion,
  runAutomation,
  upsertAffiliateLink
} = require("./src/automation");
const { getRuntimeConfig } = require("./src/config");
const { validatePost } = require("./src/validators");
const { getPublishingLimit } = require("./src/threadsClient");
const { runProfitEngine } = require("./src/profitEngine");
const { collectAdIntelligence } = require("./src/adIntelligenceClient");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "store.json");
const SCHEMA_FILE = path.join(ROOT, "db", "schema.sql");
let store = null;
let config = null;
let storeReady = null;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}

function createConfiguredStore(runtimeConfig, options = {}) {
  if (runtimeConfig.databaseUrl) {
    return createPostgresStore({
      connectionString: runtimeConfig.databaseUrl,
      autoMigrate: runtimeConfig.databaseAutoMigrate,
      ssl: runtimeConfig.databaseSsl,
      schemaPath: options.schemaPath || SCHEMA_FILE
    });
  }
  return createStore(options.dataFile || DATA_FILE);
}

async function configureRuntime(options = {}) {
  if (options.config) config = options.config;
  if (options.store) {
    store = options.store;
    storeReady = null;
  }
  if (!config) config = getRuntimeConfig(options.env || process.env);
  if (!store) store = createConfiguredStore(config, options);
  if (store.ready && !storeReady) storeReady = Promise.resolve(store.ready());
  if (storeReady) await storeReady;
  return { store, config };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function authorizeConversionWebhook(req) {
  if (!config.conversionWebhookSecret) return;
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const provided = req.headers["x-webhook-secret"] || bearer;
  if (provided !== config.conversionWebhookSecret) {
    const error = new Error("Invalid conversion webhook secret.");
    error.statusCode = 401;
    throw error;
  }
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/console.html" : pathname;
  const absolutePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!absolutePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return true;
  }

  try {
    const stat = await fs.promises.stat(absolutePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(absolutePath).toLowerCase();
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600"
    });
    fs.createReadStream(absolutePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

async function readState() {
  await configureRuntime();
  return store.read();
}

function findPost(state, postId) {
  const post = state.posts.find((item) => item.id === postId);
  if (!post) {
    const error = new Error("Post not found.");
    error.statusCode = 404;
    throw error;
  }
  return post;
}

async function handleApi(req, res, url) {
  await configureRuntime();
  const route = url.pathname;

  if (req.method === "GET" && route === "/api/dashboard") {
    sendJson(res, 200, buildDashboard(await readState(), config));
    return;
  }

  if (req.method === "GET" && route === "/api/posts") {
    sendJson(res, 200, { posts: (await readState()).posts });
    return;
  }

  if (req.method === "POST" && route === "/api/posts") {
    const body = await parseBody(req);
    const result = await store.update((state) => createPost(state, body, config));
    sendJson(res, 201, result);
    return;
  }

  const approveMatch = route.match(/^\/api\/posts\/([^/]+)\/approve$/);
  if (req.method === "POST" && approveMatch) {
    const postId = approveMatch[1];
    const result = await store.update((state) => {
      const post = findPost(state, postId);
      post.approved = true;
      if (post.status === "draft") post.status = "scheduled";
      post.updatedAt = new Date().toISOString();
      state.events.unshift({
        id: `evt_${Date.now()}`,
        type: "post.approved",
        postId,
        createdAt: post.updatedAt
      });
      return { post };
    });
    sendJson(res, 200, result);
    return;
  }

  const publishNowMatch = route.match(/^\/api\/posts\/([^/]+)\/publish-now$/);
  if (req.method === "POST" && publishNowMatch) {
    const postId = publishNowMatch[1];
    await store.update((state) => {
      const post = findPost(state, postId);
      post.approved = true;
      post.scheduledAt = new Date().toISOString();
      if (post.status === "draft") post.status = "scheduled";
      post.updatedAt = post.scheduledAt;
      return { post };
    });
    const result = await runAutomation(store, config, { onlyPostId: postId });
    sendJson(res, 200, result);
    return;
  }

  const validateMatch = route.match(/^\/api\/posts\/([^/]+)\/validate$/);
  if (req.method === "GET" && validateMatch) {
    const state = await readState();
    const post = findPost(state, validateMatch[1]);
    sendJson(res, 200, validatePost(post, config));
    return;
  }

  if (req.method === "POST" && route === "/api/automation/generate") {
    const body = await parseBody(req);
    const state = await readState();
    const result = await generateDraftsAsync(state, body, config);
    await store.write(state);
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && route === "/api/automation/run") {
    const body = await parseBody(req);
    const result = await runAutomation(store, config, body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && route === "/api/profit-engine/run") {
    const body = await parseBody(req);
    const intelligence = body.ingest === false
      ? null
      : await collectAdIntelligence(config);
    const result = await store.update((state) => runProfitEngine(state, config, {
      source: body.source || "dashboard",
      force: body.force !== false,
      createPosts: body.createPosts !== false,
      autoApprove: body.autoApprove !== false,
      intelligence
    }));
    sendJson(res, 200, { result, dashboard: buildDashboard(await readState(), config) });
    return;
  }

  if (req.method === "POST" && route === "/api/links") {
    const body = await parseBody(req);
    const result = await store.update((state) => upsertAffiliateLink(state, body, config));
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && route === "/api/conversions") {
    authorizeConversionWebhook(req);
    const body = await parseBody(req);
    const result = await store.update((state) => recordConversion(state, body));
    sendJson(res, result.duplicate ? 200 : 201, result);
    return;
  }

  if (req.method === "GET" && route === "/api/threads/publishing-limit") {
    const result = await getPublishingLimit(config);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && route === "/api/export") {
    sendJson(res, 200, await readState());
    return;
  }

  if (req.method === "OPTIONS") {
    sendNoContent(res);
    return;
  }

  sendJson(res, 404, { error: "API route not found." });
}

async function handleRedirect(req, res, url) {
  await configureRuntime();
  const match = url.pathname.match(/^\/r\/([^/]+)$/);
  if (!match) return false;
  const slug = match[1];
  const result = await store.update((state) => {
    const link = state.affiliateLinks.find((item) => item.slug === slug);
    if (!link) {
      const error = new Error("Tracking link not found.");
      error.statusCode = 404;
      throw error;
    }
    const now = new Date().toISOString();
    link.clicks += 1;
    link.updatedAt = now;
    state.clickEvents.unshift({
      id: `clk_${Date.now()}`,
      affiliateLinkId: link.id,
      slug,
      userAgent: req.headers["user-agent"] || "",
      referer: req.headers.referer || "",
      createdAt: now
    });
    return { targetUrl: link.targetUrl };
  });
  res.writeHead(302, {
    location: result.targetUrl,
    "cache-control": "no-store"
  });
  res.end();
  return true;
}

async function requestHandler(req, res) {
  try {
    await configureRuntime();
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (await handleRedirect(req, res, url)) return;
    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "threads-affiliate-ops" });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    if (await serveStatic(req, res, url.pathname)) return;
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, {
      error: error.message || "Unexpected server error."
    });
  }
}

let workerActive = false;
let workerStarted = false;
async function startWorker() {
  await configureRuntime();
  if (!config.enableWorker || workerStarted) return;
  workerStarted = true;
  setInterval(async () => {
    if (workerActive) return;
    workerActive = true;
    try {
      if (config.autonomyMode) {
        const intelligence = await collectAdIntelligence(config);
        await store.update((state) => runProfitEngine(state, config, {
          source: "worker",
          createPosts: true,
          autoApprove: true,
          intelligence
        }));
      }
      await runAutomation(store, config, { source: "worker" });
    } catch (error) {
      await store.update((state) => {
        state.automationRuns.unshift({
          id: `run_${Date.now()}`,
          status: "failed",
          source: "worker",
          message: error.message,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString()
        });
        return {};
      });
    } finally {
      workerActive = false;
    }
  }, config.automationIntervalMs);
}

function startServer(port, options = {}) {
  if (typeof port === "object" && port !== null) {
    options = port;
    port = undefined;
  }
  return configureRuntime(options).then(() => {
    const listenPort = port ?? config.port;
    const server = http.createServer(requestHandler);
    return new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(listenPort, async () => {
        try {
          await startWorker();
        } catch (error) {
          reject(error);
          return;
        }
        const address = server.address();
        const actualPort = typeof address === "object" && address ? address.port : listenPort;
        console.log(`Threads Affiliate Ops is running on http://localhost:${actualPort}`);
        resolve(server);
      });
    });
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  configureRuntime,
  requestHandler,
  startServer
};

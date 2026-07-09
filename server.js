const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const { createStore } = require("./src/store");
const { createPostgresStore } = require("./src/postgresStore");
const {
  buildDashboard,
  buildAutonomyPolicy,
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
const { buildProfitRunPreview, runProfitEngine } = require("./src/profitEngine");
const { collectAdIntelligence } = require("./src/adIntelligenceClient");
const { generateProfitScripts } = require("./src/profitScriptGenerator");
const { buildAutonomyReadiness } = require("./src/readiness");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "store.json");
const SCHEMA_FILE = path.join(ROOT, "db", "schema.sql");
const WORKER_INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    const revalidate = [".html", ".js", ".css"].includes(ext);
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[ext] || "application/octet-stream",
      "cache-control": revalidate ? "no-store" : "public, max-age=3600"
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

async function sourceHealthSnapshot() {
  const state = await readState();
  return state.profitEngine?.sourceHealth || {};
}

async function buildProfitAiScripts(runOptions, requestOptions = {}) {
  const state = await readState();
  const preview = buildProfitRunPreview(state, config, runOptions);
  if (preview.skipped || requestOptions.ai === false) {
    return { preview, scripts: [], source: "template", error: "" };
  }
  try {
    const generated = await generateProfitScripts({
      preview,
      config,
      disabled: requestOptions.ai === false
    });
    return {
      preview,
      scripts: generated.scripts,
      source: generated.source,
      error: ""
    };
  } catch (error) {
    return {
      preview,
      scripts: [],
      source: "template",
      error: error.message || "AI script generation failed."
    };
  }
}

async function runProfitEngineRequest(body = {}) {
  const intelligence = body.ingest === false
    ? null
    : await collectAdIntelligence(config, { sourceHealth: await sourceHealthSnapshot() });
  const aiDraft = await buildProfitAiScripts({
    source: body.source || "growth-loop",
    force: body.force !== false,
    createPosts: body.createPosts !== false,
    autoApprove: body.autoApprove !== false,
    intelligence
  }, body);
  const result = await store.update((state) => runProfitEngine(state, config, {
    source: body.source || "growth-loop",
    force: body.force !== false,
    createPosts: body.createPosts !== false,
    autoApprove: body.autoApprove !== false,
    intelligence,
    aiScripts: aiDraft.scripts,
    aiScriptSource: aiDraft.source,
    aiScriptError: aiDraft.error
  }));
  return { result, dashboard: buildDashboard(await readState(), config) };
}

async function runAutonomyCycle(options = {}) {
  await configureRuntime();
  const startedAt = new Date().toISOString();
  const source = options.source || "cycle";
  const policy = buildAutonomyPolicy(await readState(), config);
  const ignorePolicy = Boolean(options.ignorePolicy);
  const shouldRunProfit = options.profit !== false;
  const shouldRunQueue = options.publishQueue !== false && (ignorePolicy || policy.canPublishQueue);
  let intelligence = null;
  let aiDraft = { scripts: [], source: "template", error: "" };
  let profitResult = null;
  let automationResult = null;

  if (!policy.canRunCycle && !ignorePolicy) {
    const finishedAt = new Date().toISOString();
    const cycle = {
      id: `cycle_${Date.now()}`,
      status: "paused",
      source,
      startedAt,
      finishedAt,
      policyMode: policy.mode,
      policyAction: policy.nextAction,
      profitSkipped: true,
      selectedModelId: "",
      optimizerMode: "",
      ingestedSignalCount: 0,
      aiScriptSource: "skipped",
      aiScriptError: "",
      createdPostCount: 0,
      blockedScriptCount: 0,
      queueStatus: "skipped",
      processed: 0,
      simulated: 0,
      published: 0,
      failed: 0
    };
    await store.update((state) => {
      state.events.unshift({
        id: `evt_${Date.now()}`,
        type: "autonomy.cycle.paused",
        cycleId: cycle.id,
        status: cycle.status,
        source: cycle.source,
        policyMode: policy.mode,
        policyAction: policy.nextAction,
        createdAt: cycle.finishedAt
      });
      return {};
    });
    return {
      cycle,
      policy,
      result: null,
      automation: null,
      dashboard: buildDashboard(await readState(), config)
    };
  }

  if (shouldRunProfit) {
    intelligence = options.ingest === false ? null : await collectAdIntelligence(config, { sourceHealth: await sourceHealthSnapshot() });
    aiDraft = await buildProfitAiScripts({
      source,
      force: options.force !== false,
      createPosts: options.createPosts !== false && (ignorePolicy || policy.canCreatePosts),
      autoApprove: options.autoApprove !== false,
      intelligence
    }, options);
    profitResult = await store.update((state) => runProfitEngine(state, config, {
      source,
      force: options.force !== false,
      createPosts: options.createPosts !== false && (ignorePolicy || policy.canCreatePosts),
      autoApprove: options.autoApprove !== false,
      intelligence,
      aiScripts: aiDraft.scripts,
      aiScriptSource: aiDraft.source,
      aiScriptError: aiDraft.error
    }));
  }

  if (shouldRunQueue) {
    automationResult = await runAutomation(store, config, { source });
  }

  const finishedAt = new Date().toISOString();
  const cycle = {
    id: `cycle_${Date.now()}`,
    status: "completed",
    source,
    startedAt,
    finishedAt,
    policyMode: policy.mode,
    policyAction: policy.nextAction,
    profitSkipped: Boolean(profitResult?.skipped),
    selectedModelId: profitResult?.run?.selectedModelId || "",
    optimizerMode: profitResult?.run?.optimizerPolicy?.mode || "",
    ingestedSignalCount: intelligence?.items?.length || 0,
    aiScriptSource: aiDraft.source || "template",
    aiScriptError: aiDraft.error || "",
    createdPostCount: profitResult?.createdPosts?.length || 0,
    blockedScriptCount: profitResult?.blockedScripts?.length || 0,
    queueStatus: automationResult?.run?.status || "skipped",
    processed: automationResult?.run?.processed || 0,
    simulated: automationResult?.run?.simulated || 0,
    published: automationResult?.run?.published || 0,
    failed: automationResult?.run?.failed || 0
  };

  await store.update((state) => {
    state.events.unshift({
      id: `evt_${Date.now()}`,
      type: "autonomy.cycle.completed",
      cycleId: cycle.id,
      status: cycle.status,
      source: cycle.source,
      policyMode: cycle.policyMode,
      policyAction: cycle.policyAction,
      selectedModelId: cycle.selectedModelId,
      optimizerMode: cycle.optimizerMode,
      createdPostCount: cycle.createdPostCount,
      processed: cycle.processed,
      published: cycle.published,
      simulated: cycle.simulated,
      failed: cycle.failed,
      createdAt: cycle.finishedAt
    });
    return {};
  });

  return {
    cycle,
    policy,
    result: profitResult,
    automation: automationResult,
    dashboard: buildDashboard(await readState(), config)
  };
}

async function recordGrowthLoopEvent(type, mission, status, source, metadata = {}) {
  const createdAt = new Date().toISOString();
  await store.update((state) => {
    state.events.unshift({
      id: `evt_${Date.now()}`,
      type,
      status,
      source,
      missionId: mission?.id || "",
      missionTitle: mission?.title || "",
      missionStatus: mission?.status || "",
      missionAutomation: mission?.automation || "",
      createdAt,
      ...metadata
    });
    return {};
  });
}

async function acquireWorkerLease(source = "worker") {
  await configureRuntime();
  const now = new Date();
  const leaseMs = Number(config.workerLeaseMs || 180_000);
  return store.update((state) => {
    state.runtime = state.runtime || {};
    const existing = state.runtime.workerLease || null;
    const existingExpiresAt = existing?.expiresAt ? new Date(existing.expiresAt).getTime() : 0;
    const heldByOther = existing
      && existing.ownerId
      && existing.ownerId !== WORKER_INSTANCE_ID
      && Number.isFinite(existingExpiresAt)
      && existingExpiresAt > now.getTime();
    if (heldByOther) {
      return { acquired: false, lease: existing };
    }

    const lease = {
      ownerId: WORKER_INSTANCE_ID,
      source,
      status: "running",
      acquiredAt: existing?.ownerId === WORKER_INSTANCE_ID ? existing.acquiredAt || now.toISOString() : now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      lastMissionId: existing?.lastMissionId || "",
      lastMissionTitle: existing?.lastMissionTitle || "",
      lastError: ""
    };
    state.runtime.workerLease = lease;
    state.events.unshift({
      id: `evt_${Date.now()}`,
      type: "worker.lease_acquired",
      ownerId: lease.ownerId,
      source,
      expiresAt: lease.expiresAt,
      createdAt: lease.heartbeatAt
    });
    return { acquired: true, lease };
  });
}

async function heartbeatWorkerLease(status, metadata = {}) {
  await configureRuntime();
  const now = new Date();
  const leaseMs = Number(config.workerLeaseMs || 180_000);
  return store.update((state) => {
    state.runtime = state.runtime || {};
    const existing = state.runtime.workerLease || {};
    if (existing.ownerId && existing.ownerId !== WORKER_INSTANCE_ID) {
      return { updated: false, lease: existing };
    }
    const lease = {
      ...existing,
      ownerId: WORKER_INSTANCE_ID,
      source: existing.source || metadata.source || "worker",
      status,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      lastMissionId: metadata.missionId || existing.lastMissionId || "",
      lastMissionTitle: metadata.missionTitle || existing.lastMissionTitle || "",
      lastError: metadata.error || ""
    };
    state.runtime.workerLease = lease;
    state.events.unshift({
      id: `evt_${Date.now()}`,
      type: "worker.heartbeat",
      ownerId: WORKER_INSTANCE_ID,
      status,
      missionId: lease.lastMissionId,
      missionTitle: lease.lastMissionTitle,
      createdAt: lease.heartbeatAt
    });
    return { updated: true, lease };
  });
}

async function executeGrowthMission(mission, source) {
  if (!mission?.request?.path) {
    const error = new Error("Growth mission has no executable request.");
    error.statusCode = 409;
    throw error;
  }
  const body = {
    ...(mission.request.body || {}),
    source: mission.request.body?.source || source
  };

  if (mission.request.path === "/api/autonomy/cycle") {
    return runAutonomyCycle({
      source: body.source,
      force: body.force !== false,
      ingest: body.ingest !== false,
      ai: body.ai !== false,
      createPosts: body.createPosts !== false,
      autoApprove: body.autoApprove !== false,
      publishQueue: body.publishQueue !== false,
      profit: body.profit !== false,
      ignorePolicy: body.ignorePolicy === true
    });
  }

  if (mission.request.path === "/api/profit-engine/run") {
    return runProfitEngineRequest(body);
  }

  if (mission.request.path === "/api/automation/run") {
    return runAutomation(store, config, body);
  }

  const error = new Error(`Unsupported growth mission request: ${mission.request.path}`);
  error.statusCode = 400;
  throw error;
}

async function runGrowthAutopilot(options = {}) {
  await configureRuntime();
  const startedAt = new Date().toISOString();
  const source = options.source || "growth-autopilot";
  const dashboard = buildDashboard(await readState(), config);
  const missions = dashboard.growthLoop?.missions || [];
  const requestedMission = options.missionId
    ? missions.find((mission) => mission.id === options.missionId)
    : null;
  const mission = requestedMission
    || missions.find((item) => item.status === "auto" && item.request)
    || null;

  if (!mission) {
    await recordGrowthLoopEvent("growth_loop.idle", null, "idle", source, {
      reason: dashboard.growthLoop?.summary?.nextAction || "No executable growth mission is ready."
    });
    return {
      status: "idle",
      source,
      startedAt,
      finishedAt: new Date().toISOString(),
      mission: null,
      reason: dashboard.growthLoop?.summary?.nextAction || "No executable growth mission is ready.",
      dashboard: buildDashboard(await readState(), config)
    };
  }

  if (!mission.request || (requestedMission && mission.status !== "auto" && options.force !== true)) {
    await recordGrowthLoopEvent("growth_loop.skipped", mission, "skipped", source, {
      reason: mission.action || "Mission is not currently executable."
    });
    return {
      status: "skipped",
      source,
      startedAt,
      finishedAt: new Date().toISOString(),
      mission,
      reason: mission.action || "Mission is not currently executable.",
      dashboard: buildDashboard(await readState(), config)
    };
  }

  try {
    const result = await executeGrowthMission(mission, source);
    await recordGrowthLoopEvent("growth_loop.executed", mission, "executed", source, {
      resultStatus: result?.cycle?.status
        || result?.run?.status
        || result?.result?.run?.status
        || (result?.result?.skipped ? "skipped" : "completed"),
      createdPostCount: result?.cycle?.createdPostCount || result?.result?.createdPosts?.length || 0,
      processed: result?.cycle?.processed || result?.run?.processed || 0,
      published: result?.cycle?.published || result?.run?.published || 0,
      simulated: result?.cycle?.simulated || result?.run?.simulated || 0
    });
    return {
      status: "executed",
      source,
      startedAt,
      finishedAt: new Date().toISOString(),
      mission,
      result,
      dashboard: buildDashboard(await readState(), config)
    };
  } catch (error) {
    await recordGrowthLoopEvent("growth_loop.failed", mission, "failed", source, {
      error: error.message || "Growth autopilot failed."
    });
    throw error;
  }
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

  if (req.method === "GET" && route === "/api/readiness") {
    sendJson(res, 200, buildAutonomyReadiness(await readState(), config));
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

  if (req.method === "POST" && route === "/api/autonomy/cycle") {
    const body = await parseBody(req);
    const result = await runAutonomyCycle({
      source: body.source || "dashboard_cycle",
      force: body.force !== false,
      ingest: body.ingest !== false,
      ai: body.ai !== false,
      createPosts: body.createPosts !== false,
      autoApprove: body.autoApprove !== false,
      publishQueue: body.publishQueue !== false,
      profit: body.profit !== false,
      ignorePolicy: body.ignorePolicy === true
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && route === "/api/growth-loop/run") {
    const body = await parseBody(req);
    const result = await runGrowthAutopilot({
      source: body.source || "dashboard_growth",
      missionId: body.missionId || "",
      force: body.force === true
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && route === "/api/profit-engine/run") {
    const body = await parseBody(req);
    const result = await runProfitEngineRequest({
      ...body,
      source: body.source || "dashboard"
    });
    sendJson(res, 200, result);
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
    const postId = url.searchParams.get("post") || "";
    const modelId = url.searchParams.get("model") || "";
    const campaignId = url.searchParams.get("campaign") || link.campaignId || "";
    const productId = url.searchParams.get("product") || link.productId || "";
    const post = postId ? state.posts.find((item) => item.id === postId) : null;
    link.clicks += 1;
    link.updatedAt = now;
    if (post) {
      post.clicks = Number(post.clicks || 0) + 1;
      post.updatedAt = now;
    }
    const click = {
      id: `clk_${Date.now()}`,
      affiliateLinkId: link.id,
      postId,
      campaignId,
      productId,
      modelId,
      trackingCode: postId,
      slug,
      userAgent: req.headers["user-agent"] || "",
      referer: req.headers.referer || "",
      createdAt: now
    };
    state.clickEvents.unshift(click);
    const target = new URL(link.targetUrl);
    if (postId) {
      target.searchParams.set("utm_content", postId);
      target.searchParams.set("subid", postId);
      target.searchParams.set("sub_id", postId);
    }
    if (modelId) target.searchParams.set("utm_term", modelId);
    if (campaignId) target.searchParams.set("utm_campaign", campaignId);
    return { targetUrl: target.toString() };
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
async function runWorkerTick(source = "worker") {
  await configureRuntime();
  if (!config.enableWorker) {
    return {
      status: "disabled",
      source,
      dashboard: buildDashboard(await readState(), config)
    };
  }

  const lease = await acquireWorkerLease(source);
  if (!lease.acquired) {
    return {
      status: "skipped_lease",
      source,
      lease: lease.lease,
      dashboard: buildDashboard(await readState(), config)
    };
  }

  try {
    const result = config.autonomyMode
      ? await runGrowthAutopilot({ source, force: false })
      : await runAutonomyCycle({
          source,
          force: false,
          profit: false,
          createPosts: true,
          autoApprove: true,
          publishQueue: true
        });
    await heartbeatWorkerLease("completed", {
      source,
      missionId: result?.mission?.id || "",
      missionTitle: result?.mission?.title || ""
    });
    return {
      status: "completed",
      source,
      lease: lease.lease,
      result,
      dashboard: buildDashboard(await readState(), config)
    };
  } catch (error) {
    await heartbeatWorkerLease("failed", {
      source,
      error: error.message || "Worker tick failed."
    });
    throw error;
  }
}

async function startWorker() {
  await configureRuntime();
  if (!config.enableWorker || workerStarted) return;
  workerStarted = true;
  setInterval(async () => {
    if (workerActive) return;
    workerActive = true;
    try {
      await runWorkerTick("worker");
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
  runAutonomyCycle,
  runGrowthAutopilot,
  runWorkerTick,
  startServer
};

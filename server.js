const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
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
const { buildAutonomyReadiness, buildLivePublishingGate } = require("./src/readiness");
const {
  STATUS,
  applyPostPatch,
  approvePost,
  assertPublishable,
  buildReviewSummary,
  refreshReviewMetadata,
  rejectPost,
  schedulePost
} = require("./src/postReview");
const { evaluateContentFatigue } = require("./src/contentFatigue");
const { upsertRealOffer } = require("./src/offerManagement");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "store.json");
const SCHEMA_FILE = path.join(ROOT, "db", "schema.sql");
const WORKER_INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ADMIN_SESSION_COOKIE_NAME = "threads_affiliate_admin";
const ADMIN_ROLES = ["admin", "viewer", "operator"];
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

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}

function sendRedirect(res, location) {
  res.writeHead(302, {
    location,
    "cache-control": "no-store"
  });
  res.end();
}

function createConfiguredStore(runtimeConfig, options = {}) {
  const adminUsers = [];
  if (hasAdminCredential(runtimeConfig.adminToken)) {
    adminUsers.push({
      email: "admin-token@local",
      displayName: "Token Admin",
      role: normalizeAdminRole(runtimeConfig.adminTokenRole, "admin")
    });
  }
  if (hasAdminCredential(runtimeConfig.adminPassword)) {
    adminUsers.push({
      email: "admin-password@local",
      displayName: "Password Admin",
      role: normalizeAdminRole(runtimeConfig.adminPasswordRole, normalizeAdminRole(runtimeConfig.adminTokenRole, "admin"))
    });
  }
  if (runtimeConfig.databaseUrl) {
    return createPostgresStore({
      connectionString: runtimeConfig.databaseUrl,
      autoMigrate: runtimeConfig.databaseAutoMigrate,
      ssl: runtimeConfig.databaseSsl,
      schemaPath: options.schemaPath || SCHEMA_FILE,
      adminUsers,
      threadsUserId: runtimeConfig.threadsUserId
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

function getAdminSecret() {
  if (!config) return "";
  return String(config.adminSessionSecret || config.adminToken || config.adminPassword || "");
}

function hasAdminCredential(value) {
  return String(value || "").trim().length > 0;
}

function isAdminAuthConfigured() {
  if (!config) return false;
  return hasAdminCredential(config.adminToken) || hasAdminCredential(config.adminPassword);
}

function isLocalPublicBaseUrl() {
  try {
    const host = new URL(config?.publicBaseUrl || "http://localhost").hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return true;
  }
}

function isAdminAuthRequired() {
  if (isAdminAuthConfigured()) return true;
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") return true;
  return !isLocalPublicBaseUrl();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizeAdminRole(value, fallback = "admin") {
  const role = String(value || "").trim().toLowerCase();
  return ADMIN_ROLES.includes(role) ? role : fallback;
}

function resolveAdminActorByCredential(candidate) {
  if (!isAdminAuthConfigured()) return "";
  if (!hasAdminCredential(candidate)) return "";
  const credential = String(candidate);
  if (hasAdminCredential(config.adminToken) && safeEqual(credential, config.adminToken)) {
    return "admin-token@local";
  }
  if (hasAdminCredential(config.adminPassword) && safeEqual(credential, config.adminPassword)) {
    return "admin-password@local";
  }
  return "";
}

function resolveAdminRoleByCredential(candidate) {
  if (!isAdminAuthConfigured()) return isAdminAuthRequired() ? "" : "admin";
  if (!hasAdminCredential(candidate)) return "";
  const credential = String(candidate);
  if (hasAdminCredential(config.adminToken) && safeEqual(credential, config.adminToken)) {
    return normalizeAdminRole(config.adminTokenRole, "admin");
  }
  if (hasAdminCredential(config.adminPassword) && safeEqual(credential, config.adminPassword)) {
    return normalizeAdminRole(config.adminPasswordRole, normalizeAdminRole(config.adminTokenRole, "admin"));
  }
  return "";
}

function hasRequiredRole(role, acceptedRoles) {
  if (!Array.isArray(acceptedRoles) || acceptedRoles.length === 0) return true;
  const normalizedRole = normalizeAdminRole(role, "admin");
  return acceptedRoles.map((item) => normalizeAdminRole(item)).includes(normalizedRole);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const pairs = header.split(";");
  const output = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    if (!key) continue;
    output[key] = decodeURIComponent((pair.slice(index + 1) || "").trim());
  }
  return output;
}

function isSecureRequest(req) {
  return String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https" || req.socket.encrypted === true;
}

function clearAdminCookie(req) {
  const cookieAttributes = [
    `${ADMIN_SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ];
  if (isSecureRequest(req)) cookieAttributes.push("Secure");
  return cookieAttributes.join("; ");
}

function parseAdminSession(req) {
  const cookie = parseCookies(req)[ADMIN_SESSION_COOKIE_NAME] || "";
  const parts = cookie.split(".");
  if (parts.length !== 3 && parts.length !== 4 && parts.length !== 5) return null;
  const sessionId = parts[0];
  const signature = parts[parts.length - 1];
  const role = parts.length >= 4 ? normalizeAdminRole(parts[1], "admin") : "admin";
  const expiresAt = parts.length === 5 ? parts[3] : parts.length === 4 ? parts[2] : parts[1];
  const actor = parts.length === 5 ? (parts[2] || "") : "";
  const encodedActor = actor ? encodeURIComponent(actor) : "";
  if (!sessionId || !expiresAt || !signature) return null;
  const secret = getAdminSecret();
  const expireTime = Number(expiresAt);
  if (!Number.isFinite(expireTime) || expireTime <= Date.now()) return null;
  const payload = parts.length === 5
    ? `${sessionId}.${parts[1]}.${encodedActor}.${expiresAt}`
    : parts.length === 4
      ? `${sessionId}.${parts[1]}.${expiresAt}`
      : `${sessionId}.${expiresAt}`;
  const expected = crypto.createHmac("sha256", secret || "threads-affiliate-admin").update(payload).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  try {
    return { sessionId, role, actor, expiresAt };
  } catch {
    return null;
  }
}

function getAdminPrincipal(req) {
  if (!isAdminAuthRequired()) return { authenticated: true, role: "admin", source: "open" };
  const headerSecret = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const credential = req.headers["x-admin-token"] || req.headers["x-admin-password"] || headerSecret || "";
  const role = resolveAdminRoleByCredential(credential);
  const actor = resolveAdminActorByCredential(credential);
  if (role) return { authenticated: true, role, actor, source: "credential" };
  const session = parseAdminSession(req);
  if (session) return { authenticated: true, role: session.role, actor: session.actor || "session", source: "session" };
  return null;
}

function authorizeAdminRequest(req, options = {}) {
  const acceptedRoles = options.requiredRoles || ["admin"];
  const principal = getAdminPrincipal(req);
  if (!principal) {
    const error = new Error("Admin authentication required.");
    error.statusCode = 401;
    throw error;
  }
  if (!hasRequiredRole(principal.role, acceptedRoles)) {
    const error = new Error("Admin role forbidden.");
    error.statusCode = 403;
    throw error;
  }
  return principal;
}

function buildAdminSession(req, role = "admin", actor = "") {
  const now = Date.now();
  const expiresAt = now + config.adminSessionTtlMs;
  const normalizedRole = normalizeAdminRole(role, "admin");
  const sessionId = crypto.randomBytes(12).toString("base64url");
  const normalizedActor = encodeURIComponent(String(actor || ""));
  const payload = normalizedActor
    ? `${sessionId}.${normalizedRole}.${normalizedActor}.${expiresAt}`
    : `${sessionId}.${normalizedRole}.${expiresAt}`;
  const secret = getAdminSecret() || "threads-affiliate-admin";
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const cookieAttributes = [
    `${ADMIN_SESSION_COOKIE_NAME}=${payload}.${signature}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (isSecureRequest(req)) cookieAttributes.push("Secure");
  cookieAttributes.push(`Max-Age=${Math.max(30, Math.floor((expiresAt - now) / 1000))}`);
  return {
    role: normalizedRole,
    expiresAt,
    header: cookieAttributes.join("; ")
  };
}

function buildAdminAuthStatus(req) {
  const principal = getAdminPrincipal(req);
  return {
    authRequired: isAdminAuthRequired(),
    authenticated: !isAdminAuthRequired() || Boolean(principal),
    role: principal?.role || null,
    actor: principal?.actor || null,
    source: principal?.source || null,
    methods: {
      token: hasAdminCredential(config.adminToken),
      password: hasAdminCredential(config.adminPassword)
    }
  };
}

function authorizeConversionWebhook(req, input = {}) {
  if (!config.conversionWebhookSecret) return;
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const provided = req.headers["x-webhook-secret"]
    || bearer
    || input.webhook_secret
    || input.webhookSecret
    || input.secret
    || "";
  if (!safeEqual(provided, config.conversionWebhookSecret)) {
    const error = new Error("Invalid conversion webhook secret.");
    error.statusCode = 401;
    throw error;
  }
}

function isDashboardPath(pathname) {
  return pathname === "/" || pathname === "/console.html";
}

function serveLoginPage(req, res) {
  if (isAdminAuthRequired() && getAdminPrincipal(req)) {
    sendRedirect(res, "/");
    return true;
  }
  const html = `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>管理員登入 | Threads 聯盟自動化</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: #f5f5f7; color: #1d1d1f; }
      main { width: min(100%, 420px); padding: 32px; border: 1px solid #d2d2d7; border-radius: 8px; background: #ffffff; }
      .brand { display: block; margin-bottom: 28px; color: #6e6e73; font-size: 13px; font-weight: 600; }
      h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.2; }
      p { margin: 0 0 24px; color: #6e6e73; line-height: 1.5; }
      label { display: grid; gap: 8px; margin-bottom: 16px; color: #1d1d1f; font-size: 14px; font-weight: 600; }
      input { width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid #86868b; border-radius: 8px; background: #ffffff; color: #1d1d1f; font: inherit; }
      input:focus-visible { outline: 2px solid #0071e3; outline-offset: 2px; }
      button { width: 100%; min-height: 44px; padding: 11px 22px; border: 0; border-radius: 9999px; background: #0066cc; color: #ffffff; font: inherit; font-weight: 600; cursor: pointer; }
      button:active { transform: scale(.98); }
      button:focus-visible { outline: 2px solid #0071e3; outline-offset: 2px; }
      small { display: block; min-height: 20px; margin-top: 14px; color: #b42318; line-height: 1.4; }
    </style>
  </head>
  <body>
    <main>
      <span class="brand">Threads 聯盟自動化</span>
      <h1>管理員登入</h1>
      <p>請輸入管理員權杖或密碼以開啟營運介面。</p>
      <form id="loginForm">
        <label>
          管理員憑證
          <input id="credential" type="password" autocomplete="current-password" autofocus />
        </label>
        <button type="submit">登入管理介面</button>
        <small id="message"></small>
      </form>
    </main>
    <script>
      document.getElementById("loginForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const credential = document.getElementById("credential").value.trim();
        const message = document.getElementById("message");
        message.textContent = "";
        if (!credential) return;
        const response = await fetch("/api/login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: credential, password: credential })
        });
        if (response.ok) {
          window.location.assign("/");
          return;
        }
        const payload = await response.json().catch(() => ({}));
        message.textContent = response.status === 401 ? "管理員憑證錯誤。" : payload.error || "管理員登入失敗。";
      });
    </script>
  </body>
</html>`;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(html);
  return true;
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

function readinessBlockedError(gate, message = "Live publishing is blocked by readiness checks.") {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = "READINESS_BLOCKED";
  error.readinessGate = gate;
  return error;
}

function throwIfLivePublishingBlocked(state, options = {}) {
  if (config.threadsDryRun || options.ignoreReadiness === true) return null;
  const readiness = buildAutonomyReadiness(state, config);
  const gate = buildLivePublishingGate(state, config, {
    readiness,
    autonomy: options.autonomy === true
  });
  if (!gate.allowed) throw readinessBlockedError(gate, options.message);
  return gate;
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

async function runProfitEngineRequest(body = {}, principal = {}) {
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
    createdBy: principal?.actor || principal?.role || "admin",
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
  const state = await readState();
  const policy = buildAutonomyPolicy(state, config);
  const ignorePolicy = Boolean(options.ignorePolicy);
  const actor = options.actor || "admin";
  const shouldRunProfit = options.profit !== false;
  const shouldRunQueue = options.publishQueue !== false && (ignorePolicy || policy.canPublishQueue);
  let intelligence = null;
  let aiDraft = { scripts: [], source: "template", error: "" };
  let profitResult = null;
  let automationResult = null;

  if (options.publishQueue !== false && !config.threadsDryRun) {
    const gate = buildLivePublishingGate(state, config, { autonomy: true });
    if (!gate.allowed) {
      const finishedAt = new Date().toISOString();
      const cycle = {
        id: `cycle_${Date.now()}`,
        status: "blocked",
        source,
        startedAt,
        finishedAt,
        policyMode: policy.mode,
        policyAction: gate.nextAction,
        readinessGate: gate,
        profitSkipped: true,
        selectedModelId: "",
        optimizerMode: "",
        ingestedSignalCount: 0,
        aiScriptSource: "skipped",
        aiScriptError: "",
        createdPostCount: 0,
        blockedScriptCount: 0,
        queueStatus: "blocked",
        processed: 0,
        simulated: 0,
        published: 0,
        failed: 0
      };
      await store.update((currentState) => {
        currentState.events.unshift({
          id: `evt_${Date.now()}`,
          type: "autonomy.cycle.blocked",
          cycleId: cycle.id,
          status: cycle.status,
          source: cycle.source,
          policyMode: cycle.policyMode,
          policyAction: cycle.policyAction,
          readinessBlocked: true,
          readinessReasons: gate.reasons,
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
  }

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
      createdBy: actor,
      intelligence,
      aiScripts: aiDraft.scripts,
      aiScriptSource: aiDraft.source,
      aiScriptError: aiDraft.error
    }));
  }

  if (shouldRunQueue) {
    automationResult = await runAutomation(store, config, { source, autonomy: true });
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
  const actor = body.actor || source || "growth-loop";

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
      ignorePolicy: body.ignorePolicy === true,
      actor
    });
  }

  if (mission.request.path === "/api/profit-engine/run") {
    return runProfitEngineRequest(body, {
      role: "admin",
      actor: "growth-loop"
    });
  }

  if (mission.request.path === "/api/automation/run") {
    return runAutomation(store, config, {
      ...body,
      ignoreReadiness: false,
      autonomy: true
    });
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
  const isAdminPublicRoute = route === "/api/admin/session"
    || route === "/api/admin/login"
    || route === "/api/admin/logout"
    || route === "/api/me"
    || route === "/api/login"
    || route === "/api/logout";
  const isPublicReadinessRoute = route === "/api/readiness" && req.method === "GET";
  const isReadOnlyAdminRoute = (route === "/api/dashboard" && req.method === "GET")
    || (route === "/api/posts" && req.method === "GET")
    || (route === "/api/threads/publishing-limit" && req.method === "GET")
    || (route.match(/^\/api\/posts\/([^/]+)\/validate$/) && req.method === "GET");

  if (!isAdminPublicRoute && !isPublicReadinessRoute && route !== "/api/conversions" && req.method !== "OPTIONS") {
    authorizeAdminRequest(req, { requiredRoles: isReadOnlyAdminRoute ? ["admin", "operator", "viewer"] : ["admin"] });
  }

  if (req.method === "GET" && (route === "/api/admin/session" || route === "/api/me")) {
    sendJson(res, 200, buildAdminAuthStatus(req));
    return;
  }

  if (req.method === "POST" && (route === "/api/admin/login" || route === "/api/login")) {
    const body = await parseBody(req);
    const candidate = body.password || body.token || "";
    const role = resolveAdminRoleByCredential(candidate);
    const actor = resolveAdminActorByCredential(candidate);
    if (!role) {
      const error = new Error("Invalid admin credential.");
      error.statusCode = 401;
      throw error;
    }
    const session = buildAdminSession(req, role, actor);
    sendJson(res, 200, {
      authRequired: true,
      authenticated: true,
      role,
      actor,
      methods: {
        token: hasAdminCredential(config.adminToken),
        password: hasAdminCredential(config.adminPassword)
      }
    }, { "Set-Cookie": session.header });
    return;
  }

  if (req.method === "POST" && (route === "/api/admin/logout" || route === "/api/logout")) {
    sendJson(res, 200, {
      authRequired: isAdminAuthConfigured(),
      authenticated: false,
      methods: {
        token: hasAdminCredential(config.adminToken),
        password: hasAdminCredential(config.adminPassword)
      }
    }, { "Set-Cookie": clearAdminCookie(req) });
    return;
  }

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
    const principal = getAdminPrincipal(req);
    const result = await store.update((state) => createPost(state, body, config, {
      createdBy: principal?.actor || null
    }));
    sendJson(res, 201, result);
    return;
  }

  const approveMatch = route.match(/^\/api\/posts\/([^/]+)\/approve$/);
  if (req.method === "POST" && approveMatch) {
    const postId = approveMatch[1];
    const principal = getAdminPrincipal(req);
    const result = await store.update((state) => {
      const post = findPost(state, postId);
      const validation = approvePost(post, config, {
        actor: principal?.actor || principal?.role || "admin",
        recentPosts: state.posts
      });
      state.events.unshift({
        id: `evt_${Date.now()}`,
        type: "post.approved",
        postId,
        createdAt: post.updatedAt
      });
      return { post, validation };
    });
    sendJson(res, 200, result);
    return;
  }

  const rejectMatch = route.match(/^\/api\/posts\/([^/]+)\/reject$/);
  if (req.method === "POST" && rejectMatch) {
    const postId = rejectMatch[1];
    const body = await parseBody(req);
    const principal = getAdminPrincipal(req);
    const result = await store.update((state) => {
      const post = findPost(state, postId);
      const validation = rejectPost(post, config, {
        actor: principal?.actor || principal?.role || "admin",
        recentPosts: state.posts,
        reason: body.reason
      });
      state.events.unshift({
        id: `evt_${Date.now()}`,
        type: "post.rejected",
        postId,
        createdAt: post.updatedAt
      });
      return { post, validation };
    });
    sendJson(res, 200, result);
    return;
  }

  const scheduleMatch = route.match(/^\/api\/posts\/([^/]+)\/schedule$/);
  if (req.method === "POST" && scheduleMatch) {
    const postId = scheduleMatch[1];
    const body = await parseBody(req);
    const principal = getAdminPrincipal(req);
    const result = await store.update((state) => {
      const post = findPost(state, postId);
      const validation = schedulePost(post, config, {
        actor: principal?.actor || principal?.role || "admin",
        recentPosts: state.posts,
        scheduledAt: body.scheduledAt
      });
      state.events.unshift({
        id: `evt_${Date.now()}`,
        type: "post.scheduled",
        postId,
        createdAt: post.updatedAt
      });
      return { post, validation };
    });
    sendJson(res, 200, result);
    return;
  }

  const patchMatch = route.match(/^\/api\/posts\/([^/]+)$/);
  if (req.method === "PATCH" && patchMatch) {
    const postId = patchMatch[1];
    const body = await parseBody(req);
    const principal = getAdminPrincipal(req);
    const result = await store.update((state) => {
      const post = findPost(state, postId);
      const validation = applyPostPatch(post, body, config, {
        actor: principal?.actor || principal?.role || "admin",
        recentPosts: state.posts
      });
      state.events.unshift({
        id: `evt_${Date.now()}`,
        type: "post.edited",
        postId,
        createdAt: post.updatedAt
      });
      return { post, validation };
    });
    sendJson(res, 200, result);
    return;
  }

  const publishNowMatch = route.match(/^\/api\/posts\/([^/]+)\/publish-now$/);
  if (req.method === "POST" && publishNowMatch) {
    const postId = publishNowMatch[1];
    const state = await readState();
    throwIfLivePublishingBlocked(state, {
      message: "Publish-now is blocked by readiness checks before live execution."
    });
    await store.update((state) => {
      const post = findPost(state, postId);
      const validation = refreshReviewMetadata(post, config, {
        recentPosts: state.posts
      });
      assertPublishable(post, validation, config, { allowContainerCreated: true });
      const now = new Date().toISOString();
      if (post.status === STATUS.scheduled) post.scheduledAt = now;
      if (post.status === STATUS.containerCreated) post.publishAfter = now;
      post.updatedAt = now;
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
    const validation = validatePost(post, config);
    const fatigue = evaluateContentFatigue(post, state.posts, config);
    sendJson(res, 200, {
      ...validation,
      fatigue,
      review: buildReviewSummary(post, validation, fatigue)
    });
    return;
  }

  if (req.method === "POST" && route === "/api/automation/generate") {
    const body = await parseBody(req);
    const state = await readState();
    const principal = getAdminPrincipal(req);
    const result = await generateDraftsAsync(state, body, config, {
      createdBy: principal?.actor || principal?.role || "admin"
    });
    await store.write(state);
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && route === "/api/automation/run") {
    const body = await parseBody(req);
    const result = await runAutomation(store, config, {
      ...body,
      ignoreReadiness: false
    });
    sendJson(res, result.run?.status === "blocked" ? 409 : 200, result);
    return;
  }

  if (req.method === "POST" && route === "/api/autonomy/cycle") {
    const body = await parseBody(req);
    const principal = getAdminPrincipal(req);
    const result = await runAutonomyCycle({
      source: body.source || "dashboard_cycle",
      force: body.force !== false,
      ingest: body.ingest !== false,
      ai: body.ai !== false,
      createPosts: body.createPosts !== false,
      autoApprove: body.autoApprove !== false,
      publishQueue: body.publishQueue !== false,
      profit: body.profit !== false,
      ignorePolicy: body.ignorePolicy === true,
      actor: principal?.actor || principal?.role || "admin"
    });
    sendJson(res, result.cycle?.status === "blocked" ? 409 : 200, result);
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
    }, getAdminPrincipal(req));
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && route === "/api/links") {
    const body = await parseBody(req);
    const result = await store.update((state) => upsertAffiliateLink(state, body, config));
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && route === "/api/offers") {
    const body = await parseBody(req);
    const result = await store.update((state) => upsertRealOffer(state, body, config));
    sendJson(res, result.created.link ? 201 : 200, result);
    return;
  }

  if (["GET", "POST"].includes(req.method) && route === "/api/conversions") {
    const body = req.method === "GET"
      ? Object.fromEntries(url.searchParams.entries())
      : await parseBody(req);
    authorizeConversionWebhook(req, body);
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
    link.clicks = Number(link.clicks || 0) + 1;
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
    const subIdParam = Object.prototype.hasOwnProperty.call(link, "subIdParam")
      ? String(link.subIdParam || "")
      : "subid";
    if (postId && subIdParam) {
      target.searchParams.set(subIdParam, postId);
    }
    if (link.appendUtm === true) {
      if (postId) target.searchParams.set("utm_content", postId);
      if (modelId) target.searchParams.set("utm_term", modelId);
      if (campaignId) target.searchParams.set("utm_campaign", campaignId);
    }
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
    if (url.pathname === "/login") {
      serveLoginPage(req, res);
      return;
    }
    if (isDashboardPath(url.pathname) && isAdminAuthRequired() && !getAdminPrincipal(req)) {
      sendRedirect(res, "/login");
      return;
    }
    if (await serveStatic(req, res, url.pathname)) return;
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const status = error.statusCode || 500;
    const payload = {
      code: error.code || undefined,
      error: error.message || "Unexpected server error."
    };
    if (error.readinessGate) payload.readinessGate = error.readinessGate;
    if (error.fatigue) payload.fatigue = error.fatigue;
    sendJson(res, status, payload);
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
      ? await runGrowthAutopilot({ source, force: false, actor: "worker" })
      : await runAutonomyCycle({
          source,
          force: false,
          profit: false,
          createPosts: true,
          autoApprove: true,
          publishQueue: true,
          actor: "worker"
        });
    const tickStatus = result?.cycle?.status === "blocked" || result?.run?.status === "blocked"
      ? "blocked"
      : "completed";
    await heartbeatWorkerLease(tickStatus, {
      source,
      missionId: result?.mission?.id || "",
      missionTitle: result?.mission?.title || ""
    });
    return {
      status: tickStatus,
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
          if (options.startWorker !== false) await startWorker();
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

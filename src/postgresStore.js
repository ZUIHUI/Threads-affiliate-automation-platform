const crypto = require("node:crypto");
const fs = require("node:fs");

const { clone, defaultState } = require("./store");

const STATE_KEY = "json_store_state";
const STARTUP_MIGRATION_LOCK_ID = 1_784_082_944;
const TRANSIENT_MIGRATION_CODES = new Set(["40P01", "55P03", "40001"]);

function loadPg() {
  try {
    return require("pg");
  } catch (error) {
    error.message = `PostgreSQL storage requires the "pg" package. ${error.message}`;
    throw error;
  }
}

function sslOptions(connectionString, explicitSsl) {
  if (explicitSsl) return { rejectUnauthorized: false };
  try {
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get("sslmode");
    return sslMode && sslMode !== "disable" ? { rejectUnauthorized: false } : undefined;
  } catch {
    return undefined;
  }
}

function stableUuid(value) {
  const seed = String(value || "");
  const raw = crypto.createHash("sha1").update(seed).digest("hex");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`;
}

function safeString(value, fallback = "") {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text.length ? text : fallback;
}

function safeJson(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function safeNormalizedText(value, fallback = "") {
  const normalized = safeString(value).toLowerCase();
  return normalized.length ? normalized : fallback;
}

function isRoleValue(value, fallback = "admin") {
  const role = String(value || "").trim().toLowerCase();
  return role === "admin" || role === "operator" || role === "viewer" ? role : fallback;
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeDate(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function isUuid(value) {
  return /^[0-9a-fA-F-]{36}$/.test(String(value || ""));
}

async function getExistingTables(client) {
  const result = await client.query("select tablename from pg_tables where schemaname = 'public'");
  return new Set(result.rows.map((row) => row.tablename));
}

async function writeAppSetting(connection, state) {
  await connection.query(
    `
      insert into app_settings (key, value, updated_at)
      values ($1, $2::jsonb, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `,
    [STATE_KEY, JSON.stringify(state)]
  );
}

async function ensureSeed(connection) {
  await connection.query(
    `
      insert into app_settings (key, value, updated_at)
      values ($1, $2::jsonb, now())
      on conflict (key) do nothing
    `,
    [STATE_KEY, JSON.stringify(defaultState())]
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStartupMigration(pool, schema, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 6));
  const lockTimeoutMs = Math.max(1000, Number(options.lockTimeoutMs || 5000));
  const sleep = options.sleep || wait;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const client = await pool.connect();
    let advisoryLockHeld = false;
    try {
      await client.query("select pg_advisory_lock($1)", [STARTUP_MIGRATION_LOCK_ID]);
      advisoryLockHeld = true;
      await client.query("select set_config('lock_timeout', $1, false)", [`${lockTimeoutMs}ms`]);
      await client.query(schema);
      await ensureSeed(client);
      return;
    } catch (error) {
      lastError = error;
      const retryable = TRANSIENT_MIGRATION_CODES.has(String(error?.code || ""));
      if (!retryable || attempt >= attempts) throw error;
    } finally {
      if (advisoryLockHeld) {
        try {
          await client.query("select pg_advisory_unlock($1)", [STARTUP_MIGRATION_LOCK_ID]);
        } catch {
          // Releasing the connection also releases a session advisory lock.
        }
      }
      client.release();
    }
    await sleep(Math.min(250 * (2 ** (attempt - 1)), 2000));
  }
  throw lastError;
}

async function syncPostgresState(client, existingTables, state, options = {}) {
  const now = new Date().toISOString();
  const campaigns = state.campaigns || [];
  const products = state.products || [];
  const links = state.affiliateLinks || [];
  const posts = state.posts || [];
  const events = state.events || [];
  const conversionEvents = state.conversionEvents || [];
  const clickEvents = state.clickEvents || [];
  const automationRuns = state.automationRuns || [];
  const profitRuns = state.profitEngine?.runs || [];
  const adInsights = state.profitEngine?.adInsights || [];
  const accounts = Array.isArray(state.threadsAccounts) ? [...state.threadsAccounts] : [];
  const accountIds = new Set(accounts.map((account) => account?.id).filter(Boolean));
  for (const post of posts) {
    if (!post?.accountId || accountIds.has(post.accountId)) continue;
    accounts.push({
      id: post.accountId,
      displayName: post.accountId === "acct_primary" ? "Primary Threads Account" : "Threads account",
      threadsUserId: "",
      status: "needs_credentials",
      quotaUsage: 0,
      quotaTotal: 250,
      createdAt: post.createdAt || now,
      updatedAt: post.updatedAt || now
    });
    accountIds.add(post.accountId);
  }
  const configuredThreadsUserId = safeString(options.threadsUserId);

  const campaignIdMap = new Map(campaigns.map((campaign) => [campaign.id, stableUuid(campaign.id)]));
  const productIdMap = new Map(products.map((product) => [product.id, stableUuid(product.id)]));
  const linkIdMap = new Map(links.map((link) => [link.id, stableUuid(link.id)]));
  const postIdMap = new Map(posts.map((post) => [post.id, stableUuid(post.id)]));
  const clickIdMap = new Map(clickEvents.map((event) => [event.id, stableUuid(event.id)]));
  const accountIdMap = new Map(accounts.map((item) => [item.id, stableUuid(item.id)]));
  const seedAdminUsers = Array.isArray(options.adminUsers) ? options.adminUsers : [];
  const adminUserIdByKey = new Map();

  if (existingTables.has("admin_users")) {
    for (const adminUser of seedAdminUsers) {
      const email = safeNormalizedText(adminUser?.email);
      if (!email) continue;
      const userId = stableUuid(`admin-user:${email}`);
      await client.query(`
        insert into admin_users (
          id, email, display_name, role, updated_at
        ) values (
          $1, $2, $3, $4, now()
        )
        on conflict (email) do update set
          display_name = excluded.display_name,
          role = excluded.role,
          updated_at = now()
      `, [
        userId,
        email,
        safeString(adminUser?.displayName, "Admin"),
        isRoleValue(adminUser?.role, "admin")
      ]);
      adminUserIdByKey.set(email, userId);
      adminUserIdByKey.set(userId, userId);
    }
  }

  function resolveAdminUserId(value) {
    const creator = safeString(value);
    if (!creator) return null;
    if (isUuid(creator)) return creator;
    return adminUserIdByKey.get(safeNormalizedText(creator)) || null;
  }

  const clearOrder = [
    "conversion_events",
    "click_events",
    "posts",
    "affiliate_links",
    "products",
    "campaigns",
    "threads_accounts",
    "ad_intelligence_insights",
    "profit_engine_runs",
    "automation_runs",
    "audit_logs"
  ];
  for (const tableName of clearOrder) {
    if (existingTables.has(tableName)) {
      await client.query(`delete from ${tableName}`);
    }
  }

  if (existingTables.has("threads_accounts")) {
    for (const account of accounts) {
      if (!account?.id) continue;
      const threadsUserId = account.id === "acct_primary" && configuredThreadsUserId
        ? configuredThreadsUserId
        : safeString(account.threadsUserId, null);
      await client.query(
        `
          insert into threads_accounts (
            id, display_name, threads_user_id, token_secret_ref, status, quota_usage,
            quota_total, last_quota_checked_at, created_at, updated_at
          ) values (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10
          )
        `,
        [
          accountIdMap.get(account.id),
          safeString(account.displayName, "Threads account"),
          threadsUserId,
          account.tokenSecretRef || null,
          safeString(account.status, "needs_credentials"),
          safeNumber(account.quotaUsage, 0),
          safeNumber(account.quotaTotal, 250),
          null,
          safeDate(account.createdAt, now),
          safeDate(account.updatedAt, now)
        ]
      );
    }
  }

  if (existingTables.has("campaigns")) {
    for (const campaign of campaigns) {
      if (!campaign?.id) continue;
      await client.query(
        `
          insert into campaigns (
            id, name, status, niche, target_persona, daily_budget_posts, disclosure_required,
            created_at, updated_at
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9
          )
        `,
        [
          campaignIdMap.get(campaign.id),
          safeString(campaign.name, "Campaign"),
          safeString(campaign.status, "draft"),
          safeString(campaign.niche, "general"),
          safeString(campaign.targetPersona, "audience"),
          safeNumber(campaign.dailyBudgetPosts, 3),
          Boolean(campaign.disclosureRequired),
          safeDate(campaign.createdAt, now),
          safeDate(campaign.updatedAt, now)
        ]
      );
    }
  }

  if (existingTables.has("products")) {
    for (const product of products) {
      if (!product?.id) continue;
      const campaignId = campaignIdMap.get(product.campaignId);
      if (!campaignId) continue;
      await client.query(
        `
          insert into products (
            id, campaign_id, affiliate_program_id, name, offer, commission_model, commission_value,
            currency, landing_url, status, created_at, updated_at
          ) values (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12
          )
        `,
        [
          productIdMap.get(product.id),
          campaignId,
          null,
          safeString(product.name, "Product"),
          safeString(product.offer, ""),
          safeString(product.commissionModel, "CPA"),
          safeNumber(product.commissionValue, 0),
          safeString(product.currency, "USD"),
          safeString(product.landingUrl, "https://example.com"),
          safeString(product.status, "active"),
          safeDate(product.createdAt, now),
          safeDate(product.updatedAt, now)
        ]
      );
    }
  }

  if (existingTables.has("affiliate_links")) {
    for (const link of links) {
      if (!link?.id) continue;
      const campaignId = campaignIdMap.get(link.campaignId);
      const productId = productIdMap.get(link.productId);
      if (!campaignId || !productId) continue;
      await client.query(
        `
          insert into affiliate_links (
            id, campaign_id, product_id, slug, network, target_url,
            utm_source, utm_medium, utm_campaign, utm_content,
            sub_id_param, append_utm, source, is_demo, created_at, updated_at
          ) values (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16
          )
        `,
        [
          linkIdMap.get(link.id),
          campaignId,
          productId,
          safeString(link.slug, `link_${link.id}`),
          safeString(link.network, "affiliate"),
          safeString(link.targetUrl, ""),
          safeString(state.settings?.utmSource, "threads"),
          safeString(state.settings?.utmMedium, "affiliate_social"),
          safeString(link.campaignId, ""),
          safeString(link.slug || link.id, ""),
          Object.prototype.hasOwnProperty.call(link, "subIdParam") ? safeString(link.subIdParam, "") : "subid",
          link.appendUtm === true,
          safeString(link.source, "affiliate"),
          link.isDemo === true,
          safeDate(link.createdAt, now),
          safeDate(link.updatedAt, now)
        ]
      );
    }
  }

  if (existingTables.has("posts")) {
    for (const post of posts) {
      if (!post?.id) continue;
      const accountId = post.accountId ? accountIdMap.get(post.accountId) : null;
      const campaignId = campaignIdMap.get(post.campaignId);
      if (!accountId || !campaignId) continue;
      const linkId = post.affiliateLinkId ? linkIdMap.get(post.affiliateLinkId) : null;
      if (post.affiliateLinkId && !linkId) continue;
      await client.query(
        `
          insert into posts (
            id, account_id, campaign_id, product_id, affiliate_link_id, topic_tag, text,
            status, approved, scheduled_at, link_attachment, threads_container_id, publish_after,
            threads_media_id, published_at, error, created_by, reviewed_at, reviewed_by,
            rejected_at, rejected_by, rejection_reason, review_reset_at, review_reset_reason,
            validation_result, risk_level, disclosure_status, claim_warnings, testimonial_risk,
            fatigue_status, fatigue_reasons, similarity_score, similar_to_post_id,
            commercial_intensity, last_fatigue_checked_at,
            updated_at, created_at
          ) values (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19,
            $20, $21, $22, $23, $24,
            $25::jsonb, $26, $27, $28::jsonb, $29,
            $30, $31::jsonb, $32, $33,
            $34, $35,
            $36, $37
          )
        `,
        [
          stableUuid(post.id),
          accountId,
          campaignId,
          productIdMap.get(post.productId) || null,
          linkId,
          safeString(post.topicTag, ""),
          safeString(post.text, ""),
          safeString(post.status, "draft"),
          Boolean(post.approved),
          safeDate(post.scheduledAt, now),
          safeString(post.linkAttachment, null),
          post.threadsContainerId || null,
          post.publishAfter ? safeDate(post.publishAfter, null) : null,
          post.threadsMediaId || null,
          post.publishedAt ? safeDate(post.publishedAt, null) : null,
          safeString(post.error, ""),
          resolveAdminUserId(post.createdBy),
          post.reviewedAt ? safeDate(post.reviewedAt, null) : null,
          resolveAdminUserId(post.reviewedBy),
          post.rejectedAt ? safeDate(post.rejectedAt, null) : null,
          resolveAdminUserId(post.rejectedBy),
          safeString(post.rejectionReason, ""),
          post.reviewResetAt ? safeDate(post.reviewResetAt, null) : null,
          safeString(post.reviewResetReason, ""),
          safeJson(post.validationResult || post.validation || null),
          safeString(post.riskLevel || post.review?.riskLevel, ""),
          safeString(post.disclosureStatus || post.review?.disclosureStatus, ""),
          safeJson(post.claimWarnings || post.review?.claimWarnings || []),
          Boolean(post.testimonialRisk || post.review?.testimonialRisk),
          safeString(post.fatigueStatus || post.fatigue?.status, ""),
          safeJson(post.fatigueReasons || post.fatigue?.reasons || []),
          safeNumber(post.similarityScore || post.fatigue?.similarityScore, 0),
          safeString(post.similarToPostId || post.fatigue?.similarToPostId, ""),
          safeString(post.commercialIntensity || post.fatigue?.commercialIntensity, ""),
          post.lastFatigueCheckedAt || post.fatigue?.lastFatigueCheckedAt
            ? safeDate(post.lastFatigueCheckedAt || post.fatigue?.lastFatigueCheckedAt, null)
            : null,
          safeDate(post.updatedAt, now),
          safeDate(post.createdAt, now)
        ]
      );
    }
  }

  if (existingTables.has("click_events")) {
    for (const click of clickEvents) {
      if (!click?.id) continue;
      const affiliateLinkId = click.affiliateLinkId ? linkIdMap.get(click.affiliateLinkId) : null;
      if (!affiliateLinkId) continue;
      await client.query(
        `
          insert into click_events (
            id, affiliate_link_id, post_id, campaign_id, product_id, model_id,
            tracking_code, user_agent, referer, ip_hash, created_at
          ) values (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11
          )
        `,
        [
          stableUuid(click.id),
          affiliateLinkId,
          click.postId ? postIdMap.get(click.postId) || null : null,
          campaignIdMap.get(click.campaignId) || null,
          productIdMap.get(click.productId) || null,
          click.modelId || null,
          click.trackingCode || null,
          safeString(click.userAgent, ""),
          safeString(click.referer, ""),
          null,
          safeDate(click.createdAt, now)
        ]
      );
    }
  }

  if (existingTables.has("conversion_events")) {
    for (const conversion of conversionEvents) {
      if (!conversion?.id) continue;
      const affiliateLinkId = linkIdMap.get(conversion.affiliateLinkId);
      if (!affiliateLinkId) continue;
      await client.query(
        `
          insert into conversion_events (
            id, affiliate_link_id, click_event_id, post_id, campaign_id, product_id,
            model_id, tracking_code, network_event_id, order_value, commission_value,
            currency, status, occurred_at, created_at
          ) values (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10,
            $11, $12, $13, $14, $15
          )
        `,
        [
          stableUuid(conversion.id),
          affiliateLinkId,
          conversion.clickEventId ? clickIdMap.get(conversion.clickEventId) : null,
          postIdMap.get(conversion.postId) || null,
          campaignIdMap.get(conversion.campaignId) || null,
          productIdMap.get(conversion.productId) || null,
          conversion.modelId || null,
          conversion.trackingCode || null,
          conversion.networkEventId || null,
          safeNumber(conversion.orderValue, null),
          safeNumber(conversion.commissionValue, 0),
          safeString(conversion.currency, "USD"),
          safeString(conversion.status, "pending"),
          safeDate(conversion.occurredAt, now),
          safeDate(conversion.createdAt, now)
        ]
      );
    }
  }

  if (existingTables.has("automation_runs")) {
    for (const run of automationRuns) {
      const id = run.id ? stableUuid(run.id) : stableUuid(`${Date.now()}_${Math.random()}`);
      await client.query(
        `
          insert into automation_runs (
            id, source, status, processed, published, simulated, failed,
            messages, started_at, finished_at
          ) values (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10
          )
        `,
        [
          id,
          safeString(run.source, "manual"),
          safeString(run.status, "completed"),
          safeNumber(run.processed, 0),
          safeNumber(run.published, 0),
          safeNumber(run.simulated, 0),
          safeNumber(run.failed, 0),
          JSON.stringify(run.messages || []),
          safeDate(run.startedAt, now),
          run.finishedAt ? safeDate(run.finishedAt, now) : null
        ]
      );
    }
  }

  if (existingTables.has("profit_engine_runs")) {
    for (const run of profitRuns) {
      const source = safeString(run.source, "profit-engine");
      const selectedModelId = safeString(run.selectedModelId, run.modelId || "unknown");
      const selectedModelName = safeString(run.selectedModelName, selectedModelId);
      await client.query(
        `
          insert into profit_engine_runs (
            id, source, selected_model_id, selected_model_name, score, created_post_ids,
            status, created_at
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8
          )
        `,
        [
          stableUuid(run.id || `${source}_${safeDate(run.startedAt, now)}`),
          source,
          selectedModelId,
          selectedModelName,
          safeNumber(run.score, 0),
          JSON.stringify(run.createdPostIds || []),
          safeString(run.status, "completed"),
          safeDate(run.createdAt || run.startedAt, now)
        ]
      );
    }
  }

  if (existingTables.has("ad_intelligence_insights")) {
    for (const insight of adInsights) {
      const modelId = safeString(insight.modelId, "default");
      const angle = safeString(insight.angle || insight.hook, "no angle");
      const naturalRewrite = safeString(insight.naturalRewrite || insight.post, angle);
      await client.query(
        `
          insert into ad_intelligence_insights (
            id, model_id, source, angle, natural_rewrite,
            target_campaign_id, target_product_id, created_at
          ) values (
            $1, $2, $3, $4, $5,
            $6, $7, $8
          )
        `,
        [
          stableUuid(`${modelId}_${angle}`),
          modelId,
          safeString(insight.source, "off-platform"),
          angle,
          naturalRewrite,
          campaignIdMap.get(insight.campaignId) || null,
          productIdMap.get(insight.productId) || null,
          safeDate(insight.createdAt, now)
        ]
      );
    }
  }

  if (existingTables.has("audit_logs")) {
    for (const event of events) {
      await client.query(
        `
          insert into audit_logs (
            action, entity_type, entity_id, metadata, created_at
          ) values (
            $1, $2, $3, $4, $5
          )
        `,
        [
          safeString(event.action, "event"),
          safeString(event.entityType, "state"),
          safeString(event.entityId || event.postId || event.type || event.id, "unknown"),
          JSON.stringify(event),
          safeDate(event.createdAt, now)
        ]
      );
    }
  }
}

function createPostgresStore(options) {
  const normalizedOptions = options || {};
  const { Pool } = loadPg();
  const pool = new Pool({
    connectionString: normalizedOptions.connectionString,
    ssl: sslOptions(normalizedOptions.connectionString, normalizedOptions.ssl)
  });
  let readyPromise = null;

  async function ensureReady() {
    if (!readyPromise) {
      readyPromise = (async () => {
        const schema = normalizedOptions.autoMigrate && normalizedOptions.schemaPath
          ? fs.readFileSync(normalizedOptions.schemaPath, "utf8")
          : `
            create table if not exists app_settings (
              key text primary key,
              value jsonb not null,
              updated_at timestamptz not null default now()
            )
          `;
        await runStartupMigration(pool, schema);
      })();
    }
    return readyPromise;
  }

  async function read() {
    await ensureReady();
    const result = await pool.query("select value from app_settings where key = $1", [STATE_KEY]);
    return clone(result.rows[0]?.value || defaultState());
  }

  async function write(state) {
    await ensureReady();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await writeAppSetting(client, state);
      const existingTables = await getExistingTables(client);
      await syncPostgresState(client, existingTables, state, normalizedOptions);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async function update(mutator) {
    await ensureReady();
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        "select value from app_settings where key = $1 for update",
        [STATE_KEY]
      );
      const state = clone(result.rows[0]?.value || defaultState());
      const mutationResult = mutator(state) || {};
      await writeAppSetting(client, state);
      const existingTables = await getExistingTables(client);
      await syncPostgresState(client, existingTables, state, normalizedOptions);
      await client.query("commit");
      return mutationResult;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    type: "postgres",
    ready: ensureReady,
    read,
    write,
    update,
    close: () => pool.end()
  };
}

module.exports = { createPostgresStore, runStartupMigration, syncPostgresState, STATE_KEY };

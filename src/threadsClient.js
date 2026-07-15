async function parseGraphResponse(response) {
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const message = payload.error?.message || payload.error || response.statusText;
    const error = new Error(`Threads API error (${response.status}): ${message}`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function requireThreadsCredentials(config) {
  if (!config.threadsUserId || !config.threadsAccessToken) {
    throw new Error("THREADS_USER_ID and THREADS_ACCESS_TOKEN are required when THREADS_DRY_RUN=false.");
  }
}

async function fetchGraph(config, url, options, operation) {
  const timeoutMs = Number(config.threadsApiTimeoutMs || 20_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
    const timeoutError = new Error(`Threads API ${operation} timed out after ${timeoutMs}ms.`);
    timeoutError.code = operation === "publish" ? "THREADS_PUBLISH_TIMEOUT" : "THREADS_API_TIMEOUT";
    timeoutError.statusCode = 504;
    throw timeoutError;
  } finally {
    clearTimeout(timeout);
  }
}

async function createTextContainer(config, post) {
  requireThreadsCredentials(config);
  const params = new URLSearchParams();
  params.set("media_type", "TEXT");
  params.set("text", post.text);
  params.set("access_token", config.threadsAccessToken);
  if (post.linkAttachment) params.set("link_attachment", post.linkAttachment);
  if (post.topicTag) params.set("topic_tag", post.topicTag);

  const response = await fetchGraph(config, `${config.threadsGraphBase}/${config.threadsUserId}/threads`, {
    method: "POST",
    body: params
  }, "container creation");
  return parseGraphResponse(response);
}

async function publishContainer(config, creationId) {
  requireThreadsCredentials(config);
  const params = new URLSearchParams();
  params.set("creation_id", creationId);
  params.set("access_token", config.threadsAccessToken);

  const response = await fetchGraph(config, `${config.threadsGraphBase}/${config.threadsUserId}/threads_publish`, {
    method: "POST",
    body: params
  }, "publish");
  return parseGraphResponse(response);
}

async function getPublishingLimit(config) {
  if (config.threadsDryRun || !config.threadsUserId || !config.threadsAccessToken) {
    return {
      dryRun: true,
      quota_usage: 0,
      config: {
        quota_total: 250,
        quota_duration: 86400
      }
    };
  }

  const fields = "quota_usage,config";
  const url = `${config.threadsGraphBase}/${config.threadsUserId}/threads_publishing_limit?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(config.threadsAccessToken)}`;
  const response = await fetchGraph(config, url, {}, "publishing limit check");
  const payload = await parseGraphResponse(response);
  return payload.data?.[0] || payload;
}

module.exports = {
  createTextContainer,
  publishContainer,
  getPublishingLimit
};

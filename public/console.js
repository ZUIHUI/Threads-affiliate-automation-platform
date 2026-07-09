const state = {
  dashboard: null
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatMoney(value) {
  return `$${Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function statusBadge(status) {
  const map = {
    draft: ["草稿", "warn"],
    scheduled: ["待審核", "info"],
    container_created: ["待發佈", "info"],
    published: ["已發佈", "good"],
    simulated: ["已排程", "good"],
    failed: ["失敗", "bad"],
    blocked_credentials: ["缺憑證", "bad"],
    completed: ["完成", "good"],
    completed_with_errors: ["有錯誤", "warn"]
  };
  const [label, tone] = map[status] || [status, "info"];
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function riskBadge(level) {
  const map = {
    high: ["高風險", "bad"],
    medium: ["中風險", "warn"],
    low: ["低風險", "good"]
  };
  const [label, tone] = map[level] || ["未知", "info"];
  return `<span class="badge ${tone}">${label}</span>`;
}

function renderRuntime(data) {
  $("#updatedAt").textContent = formatDate(data.generatedAt);
  $("#runtimePill").textContent = data.runtime.dryRun ? "DRY RUN" : "LIVE";
  $("#runtimePill").className = `runtime-pill ${data.runtime.dryRun ? "" : "badge good"}`;
  $("#promptTemplate").textContent = data.promptTemplate || "";
  $("#sideAutonomyStatus").textContent = data.runtime.autonomyMode ? "自主運行中" : "手動監控";
  $("#sideRuntimeSummary").textContent = `${data.runtime.dryRun ? "Dry-run" : "Live"} · ${data.runtime.hasThreadsCredentials ? "Threads ready" : "Needs Threads token"}`;
  $("#cmdScripts").textContent = data.profitEngine?.generatedScripts?.length || 0;
  $("#cmdSignals").textContent = data.profitEngine?.externalSignals?.length || 0;
  $("#cmdOffers").textContent = data.profitEngine?.offerAutopilot?.activeSyncedProductCount || 0;
  $("#cmdConversions").textContent = data.metrics.conversions || 0;
  $("#cmdGuardrails").textContent = data.profitEngine?.blockedScripts?.length || 0;
}

function renderProfitEngine(data) {
  const engine = data.profitEngine || {};
  $("#sideConnectorCount").textContent = (engine.sources || []).length;
  $("#sideConnectorList").innerHTML = (engine.sources || []).map((source) => `
    <div class="side-connector">
      <span class="${source.runtimeStatus === "connected" ? "is-on" : ""}"></span>
      <div>
        <strong>${escapeHtml(source.name)}</strong>
        <small>${escapeHtml(source.runtimeStatus || source.status)}</small>
      </div>
    </div>
  `).join("");

  const offer = engine.offerAutopilot || {};
  $("#autopilotSummary").innerHTML = [
    ["Sources", (engine.sourceStatuses || []).length, "API / feed checks"],
    ["Signals", (engine.externalSignals || []).length, "Ad + offer inputs"],
    ["Offers", offer.activeSyncedProductCount || 0, `max ${offer.maxOffersPerRun || 0}/run`],
    ["Queued", engine.scheduledAutonomyPosts || 0, "autonomous posts"],
    ["Blocked", (engine.blockedScripts || []).length, "guardrail catches"]
  ].map(([label, value, hint]) => `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");

  $("#connectorList").innerHTML = (engine.sources || []).map((source) => `
    <article class="connector-item">
      <span>${escapeHtml(source.runtimeStatus || source.status)}</span>
      <strong>${escapeHtml(source.name)}</strong>
      <p>${escapeHtml(source.message || source.role)}</p>
    </article>
  `).join("");

  $("#profitModels").innerHTML = (engine.models || []).map((model) => `
    <article class="profit-model-card">
      <div>
        <span class="score-pill">${Number(model.score || 0)}</span>
        <strong>${escapeHtml(model.name)}</strong>
      </div>
      <p>${escapeHtml(model.stage)}</p>
      <small>${escapeHtml(model.monetization)} · ${escapeHtml(model.marginProfile)}</small>
    </article>
  `).join("");

  $("#profitScripts").innerHTML = (engine.generatedScripts || []).map((script) => {
    const body = String(script.post || "");
    return `
      <article class="script-card">
        <span>${escapeHtml(script.source || "template")}</span>
        <strong>${escapeHtml(script.hook)}</strong>
        <p>${escapeHtml(body).slice(0, 220)}${body.length > 220 ? "..." : ""}</p>
      </article>
    `;
  }).join("") || `<div class="empty-state">尚未產生自主腳本</div>`;

  $("#profitSourceStatuses").innerHTML = (engine.sourceStatuses || []).map((source) => `
    <article class="intel-row">
      <span class="badge ${source.status === "connected" ? "good" : source.status === "error" ? "bad" : "warn"}">
        ${escapeHtml(source.status)}
      </span>
      <div>
        <strong>${escapeHtml(source.name || source.id)}</strong>
        <p>${escapeHtml(source.message || "")}</p>
      </div>
      <small>${Number(source.count || 0).toLocaleString()}</small>
    </article>
  `).join("") || `<div class="empty-state">No live source check yet</div>`;

  $("#profitSignals").innerHTML = (engine.externalSignals || []).map((signal) => `
    <article class="signal-row">
      <span>${escapeHtml(signal.kind || "signal")}</span>
      <div>
        <strong>${escapeHtml(signal.title || signal.productName || signal.source)}</strong>
        <p>${escapeHtml(signal.angle || signal.offer || "")}</p>
        ${signal.adSnapshotUrl ? `<a href="${escapeHtml(signal.adSnapshotUrl)}" target="_blank" rel="noreferrer">snapshot</a>` : ""}
      </div>
    </article>
  `).join("") || `<div class="empty-state">No external ad or offer signals yet</div>`;

  $("#profitGuardrails").innerHTML = (engine.guardrails || []).map((item) => `
    <span>${escapeHtml(item)}</span>
  `).join("");

  $("#profitBlockedScripts").innerHTML = (engine.blockedScripts || []).length ? `
    <strong>Blocked scripts</strong>
    ${(engine.blockedScripts || []).map((script) => `
      <article class="blocked-script-row">
        <span class="badge bad">blocked</span>
        <div>
          <strong>${escapeHtml(script.hook || script.type || "script")}</strong>
          <p>${escapeHtml(script.reason || "Guardrail blocked this script.")}</p>
        </div>
      </article>
    `).join("")}
  ` : "";
}

function renderFactoryMetrics(data) {
  const metrics = data.metrics;
  const rows = [
    ["草稿", metrics.drafts],
    ["AI 生成中", data.posts.filter((post) => post.status === "draft" && post.contentType).length],
    ["待審核", data.posts.filter((post) => post.approved === false).length],
    ["待發佈", metrics.queued],
    ["已排程", metrics.published + metrics.simulated]
  ];
  $("#factoryMetrics").innerHTML = rows.map(([label, value]) => `
    <div class="mini-kpi">
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(label)}</span>
    </div>
  `).join("");
}

function linkById(data, id) {
  return data.affiliateLinks.find((link) => link.id === id);
}

function renderPosts(data) {
  const rows = data.posts.slice(0, 8).map((post) => {
    const link = linkById(data, post.affiliateLinkId);
    const approveDisabled = post.approved ? "disabled" : "";
    const publishDisabled = ["published", "simulated", "failed"].includes(post.status) ? "disabled" : "";
    return `
      <tr>
        <td>
          <p class="post-copy">${escapeHtml(post.hook || post.text)}</p>
          <div class="post-meta">
            <span>${escapeHtml(post.contentType || "手動")}</span>
            <span>${escapeHtml(post.validation.threadsUnits)} units</span>
          </div>
        </td>
        <td>${statusBadge(post.status)}</td>
        <td>${escapeHtml(post.topicTag || "-")}</td>
        <td>${escapeHtml(link ? link.slug : "-")}</td>
        <td>${escapeHtml(formatDate(post.scheduledAt))}</td>
        <td>
          <div class="row-actions">
            <button class="button secondary" data-action="approve" data-id="${post.id}" ${approveDisabled}>審核</button>
            <button class="button" data-action="publish" data-id="${post.id}" ${publishDisabled}>發佈</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
  $("#postRows").innerHTML = rows || `<tr><td colspan="6">No posts</td></tr>`;
}

function renderRisk(data) {
  const counts = data.posts.reduce((acc, post) => {
    acc[post.validation.risk.level] = (acc[post.validation.risk.level] || 0) + 1;
    return acc;
  }, { high: 0, medium: 0, low: 0 });
  const total = data.posts.length || 1;
  const highPct = Math.round((counts.high / total) * 100);
  const mediumPct = Math.round(((counts.high + counts.medium) / total) * 100);
  $("#riskCount").textContent = counts.high + counts.medium;
  $("#riskSummary").innerHTML = [
    ["全部", data.posts.length],
    ["高風險", counts.high],
    ["中風險", counts.medium],
    ["低風險", counts.low]
  ].map(([label, value]) => `<div class="risk-tab">${label} <strong>${value}</strong></div>`).join("");

  const riskRows = data.posts
    .slice()
    .sort((a, b) => {
      const score = { high: 0, medium: 1, low: 2 };
      return score[a.validation.risk.level] - score[b.validation.risk.level];
    })
    .slice(0, 5);
  $("#riskRows").innerHTML = riskRows.map((post) => {
    const note = post.validation.warnings[0] || post.riskNote || "低風險：未保證收益，無假見證。";
    return `
      <article class="risk-item">
        <div>
          <strong>${escapeHtml(post.hook || post.contentType || post.id)}</strong>
          <p>${escapeHtml(note)}</p>
        </div>
        ${riskBadge(post.validation.risk.level)}
      </article>
    `;
  }).join("");

  $("#riskDonut").style.background = `conic-gradient(var(--coral) 0 ${highPct}%, var(--amber) ${highPct}% ${mediumPct}%, var(--green) ${mediumPct}% 100%)`;
  $("#riskDonut").innerHTML = `<strong>${data.posts.length}</strong><span>總數</span>`;
  $("#riskLegend").innerHTML = `
    <div><span><b style="background:var(--coral)"></b>誇大宣稱</span><strong>${counts.high}</strong></div>
    <div><span><b style="background:var(--amber)"></b>收益保證</span><strong>${counts.medium}</strong></div>
    <div><span><b style="background:var(--green)"></b>標示建議</span><strong>${counts.low}</strong></div>
  `;
}

function renderRevenue(data) {
  const clicks = data.metrics.clicks;
  const conversions = data.metrics.conversions;
  const revenue = data.metrics.revenue;
  const exposure = clicks * 12 + 1540;
  const conversionRate = clicks ? ((conversions / clicks) * 100).toFixed(1) : "0.0";
  const refundRate = "2.1%";

  $("#revenueCards").innerHTML = [
    ["點擊數", clicks.toLocaleString(), "▲ 18.6%"],
    ["轉換數", conversions.toLocaleString(), "▲ 15.3%"],
    ["預估收益", formatMoney(revenue), "▲ 21.4%"],
    ["退款率", refundRate, "▼ 0.6%"]
  ].map(([label, value, delta]) => `
    <article class="revenue-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(delta)}</small>
    </article>
  `).join("");

  $("#revenueFunnel").innerHTML = [
    ["曝光", exposure],
    ["點擊", clicks],
    ["加購", Math.max(conversions * 4, 1)],
    ["轉換", conversions],
    ["預估收益", formatMoney(revenue)]
  ].map(([label, value]) => `
    <div class="funnel-step"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
  `).join("");

  $("#linkList").innerHTML = data.affiliateLinks.map((link) => `
    <div class="link-row">
      <strong>${escapeHtml(link.slug)}</strong>
      <span>${Number(link.clicks || 0).toLocaleString()}</span>
      <span>${Number(link.conversions || 0).toLocaleString()}</span>
      <span>${formatMoney(link.revenue)}</span>
    </div>
  `).join("");

  $("#conversionEvents").innerHTML = `
    <strong>Recent conversions</strong>
    ${(data.conversionEvents || []).map((event) => {
      const link = linkById(data, event.affiliateLinkId);
      return `
        <article class="conversion-row">
          <span class="badge ${event.status === "approved" || event.status === "paid" ? "good" : "warn"}">${escapeHtml(event.status)}</span>
          <div>
            <strong>${escapeHtml(link ? link.slug : event.affiliateLinkId)}</strong>
            <p>${escapeHtml(event.networkEventId || event.id)} · ${formatDate(event.occurredAt)}</p>
          </div>
          <small>${formatMoney(event.commissionValue)}</small>
        </article>
      `;
    }).join("") || `<div class="empty-state">No conversion webhook events yet</div>`}
  `;
}

function renderCampaigns(data) {
  $("#campaignList").innerHTML = data.campaigns.map((campaign) => {
    const products = data.products.filter((product) => product.campaignId === campaign.id);
    const posts = data.posts.filter((post) => post.campaignId === campaign.id);
    return `
      <article class="campaign-item">
        <header>
          <strong>${escapeHtml(campaign.name)}</strong>
          <span class="badge good">${escapeHtml(campaign.status)}</span>
        </header>
        <div class="mini-metrics">
          <span>${escapeHtml(campaign.targetPersona)}</span>
          <span>${products.length} products</span>
          <span>${posts.length} posts</span>
        </div>
      </article>
    `;
  }).join("");
}

function populateForm(data) {
  const campaignSelect = $("#campaignSelect");
  const productSelect = $("#productSelect");
  const selectedCampaign = campaignSelect.value || data.campaigns[0]?.id;
  campaignSelect.innerHTML = data.campaigns.map((campaign) => (
    `<option value="${campaign.id}" ${campaign.id === selectedCampaign ? "selected" : ""}>${escapeHtml(campaign.name)}</option>`
  )).join("");

  const products = data.products.filter((product) => product.campaignId === campaignSelect.value);
  productSelect.innerHTML = products.map((product) => (
    `<option value="${product.id}">${escapeHtml(product.name)}</option>`
  )).join("");

  if (!$("#scheduledAt").value) {
    const date = new Date(Date.now() + 30 * 60 * 1000);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    $("#scheduledAt").value = local;
  }
}

function render(data) {
  state.dashboard = data;
  renderRuntime(data);
  renderProfitEngine(data);
  renderFactoryMetrics(data);
  renderPosts(data);
  renderRisk(data);
  renderRevenue(data);
  renderCampaigns(data);
  populateForm(data);
}

async function refresh() {
  render(await api("/api/dashboard"));
}

async function runQueue() {
  const result = await api("/api/automation/run", {
    method: "POST",
    body: { source: "dashboard" }
  });
  render(result.dashboard);
  showToast(`Queue finished: ${result.run.status}`);
}

async function generateDrafts(autoApprove) {
  const topic = $("#topicInput").value.trim() || "AI 自動化聯盟行銷";
  await api("/api/automation/generate", {
    method: "POST",
    body: {
      topic,
      autoApprove,
      campaignId: $("#campaignSelect").value,
      productId: $("#productSelect").value
    }
  });
  await refresh();
  showToast(autoApprove ? "已產生 5 則並排程" : "已產生 5 則草稿");
}

async function runProfitEngine() {
  const result = await api("/api/profit-engine/run", {
    method: "POST",
    body: {
      source: "dashboard",
      force: true,
      createPosts: true,
      autoApprove: true
    }
  });
  render(result.dashboard);
  const created = result.result.createdPosts?.length || 0;
  showToast(`自主獲利引擎完成，建立 ${created} 則排程文案`);
}

async function handlePostAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  button.disabled = true;
  if (action === "approve") {
    await api(`/api/posts/${id}/approve`, { method: "POST", body: {} });
    await refresh();
    showToast("Post approved");
  }
  if (action === "publish") {
    const result = await api(`/api/posts/${id}/publish-now`, { method: "POST", body: {} });
    render(result.dashboard);
    showToast(`Publish flow: ${result.run.status}`);
  }
}

async function submitCompose(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const scheduledAt = form.get("scheduledAt")
    ? new Date(form.get("scheduledAt")).toISOString()
    : new Date().toISOString();
  await api("/api/posts", {
    method: "POST",
    body: {
      campaignId: form.get("campaignId"),
      productId: form.get("productId"),
      text: form.get("text"),
      topicTag: form.get("topicTag"),
      scheduledAt,
      approved: form.get("approved") === "on"
    }
  });
  event.currentTarget.reset();
  await refresh();
  showToast("Post created");
}

function bindEvents() {
  $("#refreshBtn").addEventListener("click", refresh);
  $("#runBtn").addEventListener("click", runQueue);
  $("#profitRunBtn").addEventListener("click", () => {
    runProfitEngine().catch((error) => showToast(error.message));
  });
  $("#generateBtn").addEventListener("click", () => generateDrafts(false));
  $("#autoGenerateBtn").addEventListener("click", () => generateDrafts(true));
  $("#topicGenerateBtn").addEventListener("click", () => generateDrafts(false));
  $("#postRows").addEventListener("click", (event) => {
    handlePostAction(event).catch((error) => {
      showToast(error.message);
      refresh();
    });
  });
  $("#composeForm").addEventListener("submit", (event) => {
    submitCompose(event).catch((error) => showToast(error.message));
  });
  $("#campaignSelect").addEventListener("change", () => populateForm(state.dashboard));
}

bindEvents();
refresh().catch((error) => showToast(error.message));

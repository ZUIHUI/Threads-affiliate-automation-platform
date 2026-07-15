const state = {
  dashboard: null,
  auth: {
    authRequired: false,
    authenticated: false,
    methods: { token: false, password: false }
  },
  offerImport: {
    fileName: "",
    format: "",
    content: "",
    preview: null,
    canImport: false
  },
  workflow: {
    selectedProductId: ""
  }
};

const $ = (selector) => document.querySelector(selector);
const OFFER_IMPORT_MAX_BYTES = 256 * 1024;

const WORKSPACE_MODE_KEY = "threads-affiliate-workspace-mode";
const WORKSPACE_MODES = {
  operate: {
    title: "內容發布",
    subtitle: "商品研究、AI 文案、審核與發布",
    target: "#workflow-overview"
  },
  insights: {
    title: "成效分析",
    subtitle: "收益、轉換與內容優化",
    target: "#commandStats"
  },
  system: {
    title: "系統設定",
    subtitle: "上線檢查、排程與服務連線",
    target: "#readiness"
  }
};

function setButtonBusy(button, busy, busyLabel = "處理中") {
  if (!button) return;
  if (busy) {
    button.dataset.idleLabel = button.textContent;
    button.textContent = busyLabel;
    button.classList.add("is-busy");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    return;
  }
  button.textContent = button.dataset.idleLabel || button.textContent;
  delete button.dataset.idleLabel;
  button.classList.remove("is-busy");
  button.disabled = false;
  button.removeAttribute("aria-busy");
}

async function runButtonAction(button, action, busyLabel) {
  setButtonBusy(button, true, busyLabel);
  try {
    await action();
  } finally {
    setButtonBusy(button, false);
  }
}

function setNavigationOpen(open) {
  document.body.classList.toggle("nav-open", open);
  const toggle = $("#sidebarToggle");
  if (toggle) toggle.setAttribute("aria-expanded", String(open));
}

function elementSupportsMode(element, mode, attribute) {
  return String(element.dataset[attribute] || "")
    .split(/\s+/)
    .filter(Boolean)
    .includes(mode);
}

function setWorkspaceMode(mode, { persist = true, scroll = false } = {}) {
  const config = WORKSPACE_MODES[mode] || WORKSPACE_MODES.operate;
  const activeMode = WORKSPACE_MODES[mode] ? mode : "operate";
  document.body.dataset.workspaceMode = activeMode;

  document.querySelectorAll("[data-workspace-mode]").forEach((button) => {
    const active = button.dataset.workspaceMode === activeMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-mode-nav]").forEach((group) => {
    group.hidden = group.dataset.modeNav !== activeMode;
  });
  document.querySelectorAll("[data-workspace-section]").forEach((section) => {
    section.hidden = !elementSupportsMode(section, activeMode, "workspaceSection");
  });
  document.querySelectorAll("[data-action-modes]").forEach((action) => {
    action.hidden = !elementSupportsMode(action, activeMode, "actionModes");
  });

  const title = $("#workspaceModeTitle");
  const subtitle = $("#workspaceModeSubtitle");
  if (title) title.textContent = config.title;
  if (subtitle) subtitle.textContent = config.subtitle;

  const firstVisibleLink = document.querySelector(`[data-mode-nav="${activeMode}"] .nav-item`);
  if (firstVisibleLink) setActiveNavigation(firstVisibleLink);
  setNavigationOpen(false);

  if (persist) {
    try {
      window.localStorage.setItem(WORKSPACE_MODE_KEY, activeMode);
    } catch {
      // Browser storage is optional; the default mode remains available.
    }
  }
  if (scroll) {
    const target = document.querySelector(config.target);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function setupWorkspaceModes() {
  let initialMode = "operate";
  try {
    const storedMode = window.localStorage.getItem(WORKSPACE_MODE_KEY);
    if (storedMode && WORKSPACE_MODES[storedMode]) initialMode = storedMode;
  } catch {
    // Browser storage is optional; use the daily operations mode.
  }

  const modeButtons = [...document.querySelectorAll("[data-workspace-mode]")];
  modeButtons.forEach((button, index) => {
    button.addEventListener("click", () => {
      setWorkspaceMode(button.dataset.workspaceMode, { scroll: true });
    });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? modeButtons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + modeButtons.length) % modeButtons.length;
      const nextButton = modeButtons[nextIndex];
      setWorkspaceMode(nextButton.dataset.workspaceMode);
      nextButton.focus();
    });
  });
  setWorkspaceMode(initialMode, { persist: false });
}

function setActiveNavigation(link) {
  document.querySelectorAll(".nav-item").forEach((item) => {
    const active = item === link;
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
}

function arrangeDashboardSections() {
  const main = $(".main");
  const operationsGrid = $(".ops-grid");
  if (!main || !operationsGrid) return;

  ["#factory", "#risk", "#affiliate", "#profit-engine"].forEach((selector) => {
    const section = $(selector);
    if (section) operationsGrid.appendChild(section);
  });

  [
    ".topbar",
    "#workflow-overview",
    ".command-strip",
    "#readiness",
    "#next-actions",
    ".ops-grid",
    "#decision-brief",
    "#control-tower",
    "#operating-map",
    "#growth-loop",
    "#timeline",
    "#worker-health",
    "#experiments",
    ".lower-grid",
    "#settings"
  ].forEach((selector) => {
    const section = $(selector);
    if (section) main.appendChild(section);
  });
}

function setupNavigation() {
  const toggle = $("#sidebarToggle");
  const backdrop = $("#sidebarBackdrop");
  const links = [...document.querySelectorAll('.nav-item[href^="#"]')];

  toggle?.addEventListener("click", () => {
    setNavigationOpen(!document.body.classList.contains("nav-open"));
  });
  backdrop?.addEventListener("click", () => setNavigationOpen(false));
  links.forEach((link) => {
    link.addEventListener("click", () => {
      setActiveNavigation(link);
      setNavigationOpen(false);
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setNavigationOpen(false);
  });

  if (!("IntersectionObserver" in window)) return;
  const targets = links
    .map((link) => ({
      link,
      section: document.querySelector(link.getAttribute("href"))
    }))
    .filter((item) => item.section);
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
    if (!visible.length) return;
    const match = targets.find((item) => item.section === visible[0].target);
    if (match) setActiveNavigation(match.link);
  }, { rootMargin: "-18% 0px -72% 0px" });
  targets.forEach((item) => observer.observe(item.section));
  window.addEventListener("resize", () => {
    if (window.innerWidth > 1180) setNavigationOpen(false);
  });
}

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

function formatMoney(value, currency = "USD") {
  try {
    return new Intl.NumberFormat("zh-TW", {
      style: "currency",
      currency: String(currency || "USD").toUpperCase(),
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(Number(value || 0));
  } catch {
    return `${String(currency || "USD").toUpperCase()} ${Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
}

function formatRevenueTotals(totals) {
  const entries = Object.entries(totals || {}).filter(([, value]) => Number(value || 0) !== 0);
  return entries.length
    ? entries.map(([currency, value]) => formatMoney(value, currency)).join(" / ")
    : formatMoney(0);
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
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({ error: "伺服器回應格式無效。" }));
  if (!response.ok) {
    const error = new Error(payload.error || "請求失敗");
    error.statusCode = response.status;
    if (response.status === 401 && options.skipAuth !== true) {
      setAuthGateVisible(true, error.message);
    }
    throw error;
  }
  return payload;
}

function setAuthGateVisible(visible, message = "") {
  const gate = $("#authGate");
  if (!gate) return;
  gate.classList.toggle("is-hidden", !visible);
  const messageNode = $("#authMessage");
  if (messageNode) {
    messageNode.textContent = message || "請輸入管理員權杖或密碼";
  }
}

async function refreshAdminSession() {
  try {
    const session = await api("/api/admin/session", { skipAuth: true });
    state.auth = session;
    const logoutBtn = $("#adminLogoutBtn");
    if (logoutBtn) {
      logoutBtn.classList.toggle("is-hidden", !session.authRequired || !session.authenticated);
    }
    setAuthGateVisible(session.authRequired && !session.authenticated, "需要管理員權限。");
    return session;
  } catch (error) {
    state.auth = { authRequired: false, authenticated: true, methods: { token: false, password: false } };
    const logoutBtn = $("#adminLogoutBtn");
    if (logoutBtn) logoutBtn.classList.add("is-hidden");
    setAuthGateVisible(false);
    return state.auth;
  }
}

async function adminLogin(event) {
  event.preventDefault();
  const input = $("#adminSecretInput");
  const credential = input ? input.value.trim() : "";
  if (!credential) return;
  try {
    await api("/api/admin/login", {
      method: "POST",
      skipAuth: true,
      body: {
        token: credential,
        password: credential
      }
    });
    setAuthGateVisible(false);
    if (input) input.value = "";
    await refresh();
  } catch (error) {
    setAuthGateVisible(true, error.message || "管理員登入失敗。");
    if (input) input.focus();
  }
}

async function adminLogout() {
  try {
    await api("/api/admin/logout", { method: "POST", skipAuth: true });
  } catch {
    // ignore
  }
  await refreshAdminSession();
}

function statusBadge(status) {
  const map = {
    generated: ["已生成", "info"],
    needs_review: ["待審核", "warn"],
    draft: ["草稿", "warn"],
    approved: ["已核准", "good"],
    scheduled: ["已排程", "info"],
    container_created: ["待發佈", "info"],
    published: ["已發佈", "good"],
    simulated: ["已模擬", "good"],
    failed: ["失敗", "bad"],
    rejected: ["已拒絕", "bad"],
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

function reviewStatusOf(post) {
  if (post.reviewStatus) return post.reviewStatus;
  if (post.status === "draft") return "needs_review";
  if (post.status === "container_created") return "scheduled";
  if (post.status === "blocked_credentials") return "failed";
  return post.status || (post.approved ? "approved" : "needs_review");
}

function reviewStatusLabel(status) {
  const labels = {
    generated: "已生成",
    needs_review: "待審核",
    draft: "草稿",
    approved: "已核准",
    scheduled: "已排程",
    container_created: "待發佈",
    published: "已發佈",
    simulated: "已模擬",
    failed: "失敗",
    rejected: "已拒絕",
    blocked_credentials: "缺少憑證",
    completed: "完成",
    completed_with_errors: "完成但有錯誤",
    paid: "已付款",
    pending: "處理中"
  };
  return labels[status] || status || "未知";
}

function isReviewable(post) {
  return ["generated", "needs_review", "draft"].includes(post.status || post.reviewStatus);
}

function disclosureBadge(status) {
  const map = {
    present: ["揭露已存在", "good"],
    missing: ["缺揭露", "bad"],
    not_required: ["無商業連結", "info"],
    unknown: ["未知", "warn"]
  };
  const [label, tone] = map[status || "unknown"] || [status || "unknown", "info"];
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function postSourceBadge(post) {
  const context = post.sourceContext || {};
  if (context.status === "ready") {
    const detail = context.title || context.sourceDomain || "已讀取商品頁";
    const label = context.researchMode === "openai_web_search" ? "AI 查證資料" : "商品頁依據";
    return `<span class="badge good" title="${escapeHtml(detail)}">${label}</span>`;
  }
  if (context.status === "unavailable") {
    const detail = context.error || "商品頁無法讀取，使用資料表優惠內容";
    return `<span class="badge warn" title="${escapeHtml(detail)}">資料表備援</span>`;
  }
  if (context.status === "ai_unavailable") {
    return `<span class="badge info">範本文案</span>`;
  }
  return "";
}

function fatigueBadge(status) {
  const map = {
    clear: ["疲勞檢查通過", "good"],
    warning: ["疲勞提醒", "warn"],
    blocked: ["疲勞阻擋", "bad"]
  };
  const [label, tone] = map[status || "clear"] || [status || "clear", "info"];
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function fatigueSummary(post) {
  const fatigue = post.fatigue || {};
  const status = post.fatigueStatus || fatigue.status || "clear";
  const reasons = post.fatigueReasons || fatigue.reasons || [];
  const score = Number(post.similarityScore ?? fatigue.similarityScore ?? 0);
  const similarTo = post.similarToPostId || fatigue.similarToPostId || "";
  const lines = reasons.map((reason) => reason.message || reason.id).filter(Boolean);
  if (score > 0 && similarTo) {
    lines.unshift(`與 ${similarTo} 相似度 ${Math.round(score * 100)}%`);
  }
  return { status, reasons, lines, score, similarTo };
}

function firstClaimWarning(post) {
  const warnings = post.claimWarnings || post.review?.claimWarnings || [];
  if (warnings.length) return warnings[0];
  return (post.validation?.warnings || []).find((warning) =>
    /exaggerated|earnings claim|guaranteed-profit|guaranteed profit|testimonial/i.test(String(warning || ""))
  ) || "";
}

function approvalBlockReason(post, validation, riskLevel, warning, fatigue) {
  if (!isReviewable(post)) return "此貼文已離開待審核狀態。";
  if (!validation.valid) return validation.errors?.[0] || "內容驗證未通過，請先編輯後重新檢查。";
  if (riskLevel === "high") return "高風險內容不可直接核准，請先編輯或拒絕。";
  if (warning) return `嚴重聲明警告：${warning}`;
  if (fatigue.status === "blocked") return fatigue.lines[0] || "內容疲勞規則阻擋核准，請先改寫。";
  return "";
}

function terminalPostHint(post) {
  const hints = {
    simulated: "此貼文已完成模擬發佈，不需再次審核；若要重跑，請建立新草稿。",
    published: "此貼文已正式發佈，不可再次審核。",
    rejected: "此貼文已拒絕；請修改內容或建立新草稿後重新送審。",
    failed: "此貼文處理失敗；請先檢查錯誤原因，再建立新草稿重新送審。"
  };
  return hints[post.status] || "";
}

function blockedActionAttributes(reason) {
  if (!reason) return "";
  const escapedReason = escapeHtml(reason);
  return `aria-disabled="true" data-blocked-reason="${escapedReason}" title="${escapedReason}"`;
}

function renderRuntime(data) {
  $("#updatedAt").textContent = formatDate(data.generatedAt);
  $("#runtimePill").textContent = data.runtime.dryRun ? "測試模式" : "正式模式";
  $("#runtimePill").className = `runtime-pill ${data.runtime.dryRun ? "" : "badge good"}`;
  $("#promptTemplate").textContent = data.promptTemplate || "";
  $("#sideAutonomyStatus").textContent = data.runtime.autonomyMode ? "自主運行中" : "手動監控";
  $("#sideRuntimeSummary").textContent = `${data.runtime.dryRun ? "測試發佈" : "正式發佈"} · ${data.runtime.hasThreadsCredentials ? "Threads 已連線" : "Threads 憑證未完成"}`;
  $("#workflowModeBadge").textContent = data.runtime.dryRun ? "測試模式" : "正式模式";
  $("#cmdScripts").textContent = data.profitEngine?.generatedScripts?.length || 0;
  $("#cmdSignals").textContent = data.profitEngine?.externalSignals?.length || 0;
  $("#cmdOffers").textContent = data.profitEngine?.offerAutopilot?.activeSyncedProductCount || 0;
  $("#cmdConversions").textContent = data.metrics.conversions || 0;
  $("#cmdGuardrails").textContent = data.profitEngine?.blockedScripts?.length || 0;
}

function renderWorkflowSummary(data) {
  const metrics = data.metrics || {};
  $("#workflowDraftCount").textContent = Number(metrics.needsReview ?? metrics.drafts ?? 0);
  $("#workflowApprovedCount").textContent = Number(metrics.approved || 0);
  $("#workflowQueuedCount").textContent = Number(metrics.queued || 0);
  $("#workflowSentCount").textContent = Number(metrics.published || 0) + Number(metrics.simulated || 0);
}

function workflowStatusBadge(status) {
  if (["completed", "ready"].includes(status)) return "good";
  if (["active", "warning", "waiting"].includes(status)) return "warn";
  return "bad";
}

function renderContentWorkflow(data) {
  const workflow = data.contentWorkflow || {};
  const metrics = data.metrics || {};
  const stages = new Map((workflow.stages || []).map((stage) => [stage.id, stage]));
  document.querySelectorAll("[data-workflow-stage]").forEach((node) => {
    const stage = stages.get(node.dataset.workflowStage) || {};
    node.className = `status-${stage.status || "waiting"}`;
  });
  const researchStage = stages.get("research");
  if (researchStage) $("#workflowResearchDetail").textContent = researchStage.detail;

  const monetizableProductIds = new Set((data.affiliateLinks || [])
    .filter((link) => link.monetizable)
    .map((link) => link.productId));
  const products = (data.products || []).filter((product) => monetizableProductIds.has(product.id));
  const campaigns = new Map((data.campaigns || []).map((campaign) => [campaign.id, campaign]));
  const select = $("#workflowProductSelect");
  const selectedId = state.workflow.selectedProductId || select.value || products[0]?.id || "";
  select.innerHTML = products.map((product) => {
    const campaign = campaigns.get(product.campaignId);
    const label = campaign ? `${product.name} · ${campaign.name}` : product.name;
    return `<option value="${escapeHtml(product.id)}" ${product.id === selectedId ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("") || `<option value="">請先建立真實聯盟商品</option>`;
  state.workflow.selectedProductId = select.value;

  const product = products.find((item) => item.id === select.value);
  const link = (data.affiliateLinks || []).find((item) => item.productId === product?.id && item.monetizable);
  const sourceContext = workflow.sourceProductId === product?.id ? workflow.sourceContext || {} : {};
  const sourceStatus = $("#workflowSourceStatus");
  const sourceTitle = $("#workflowSourceTitle");
  const sourceDetail = $("#workflowSourceDetail");
  let status = "waiting";
  let statusLabel = "等待研究";

  if (!product) {
    status = "blocked";
    statusLabel = "缺少商品";
    sourceTitle.textContent = "先建立真實聯盟商品";
    sourceDetail.textContent = "請到系統設定新增或批次匯入 HTTPS 聯盟連結";
  } else if (!workflow.aiReady) {
    status = "blocked";
    statusLabel = "AI 未設定";
    sourceTitle.textContent = product.name;
    sourceDetail.textContent = "Render 尚未設定 OPENAI_API_KEY";
  } else if (sourceContext.status === "ready") {
    status = "completed";
    statusLabel = sourceContext.researchMode === "openai_web_search" ? "AI 已查證" : "資料已讀取";
    sourceTitle.textContent = sourceContext.title || product.name;
    const sourceCount = Number(sourceContext.sourceCount || 0);
    sourceDetail.textContent = sourceContext.researchMode === "openai_web_search"
      ? `${sourceCount} 個網路來源 · ${Number(sourceContext.characterCount || 0)} 字元證據`
      : `${sourceContext.sourceDomain || link?.network || "商品頁"} · ${Number(sourceContext.characterCount || 0)} 字元資料`;
  } else if (sourceContext.status === "unavailable") {
    status = "warning";
    statusLabel = "使用備援";
    sourceTitle.textContent = product.name;
    sourceDetail.textContent = sourceContext.error || "商品頁無法讀取，使用資料表優惠內容";
  } else {
    status = "ready";
    statusLabel = "商品已就緒";
    sourceTitle.textContent = product.name;
    sourceDetail.textContent = `${link?.network || product.network || "聯盟平台"} · 等待 AI 讀取商品頁`;
  }
  sourceStatus.className = `badge ${workflowStatusBadge(status)}`;
  sourceStatus.textContent = statusLabel;

  const generateButton = $("#generateBtn");
  generateButton.disabled = !product || !workflow.aiReady;
  const runButton = $("#runBtn");
  runButton.disabled = Number(metrics.queued || 0) === 0;
  $("#workflowReviewLink").textContent = metrics.needsReview > 0
    ? `審核 ${Number(metrics.needsReview)} 則草稿`
    : "查看貼文佇列";
  $("#workflowModeBadge").textContent = workflow.dryRun ? "測試發布" : "正式發布";
}

function pipelineStatusScore(status) {
  const scores = { active: 100, dry_run: 78, watch: 64, manual: 48, paused: 40, blocked: 18 };
  return scores[status] || 0;
}

function buildPipelineFallback(data) {
  const runtime = data.runtime || {};
  const engine = data.profitEngine || {};
  const metrics = data.metrics || {};
  const connectedSources = (engine.sourceStatuses || []).filter((source) => source.status === "connected").length;
  const signalCount = (engine.externalSignals || []).length;
  const scriptCount = (engine.generatedScripts || []).length;
  const hasOptimizer = Boolean(engine.optimizer?.latestPolicy) || (engine.runs || []).some((run) => run.optimizerPolicy);
  const steps = [
    {
      id: "api_intake",
      label: "API / 廣告資料匯入",
      status: connectedSources > 0 ? "active" : signalCount > 0 ? "watch" : "blocked",
      value: `${signalCount} 筆訊號`,
      detail: connectedSources > 0 ? `${connectedSources} 個資料來源已連線` : "尚未連接即時廣告或優惠資料來源。",
      nextAction: connectedSources > 0 ? "監控訊號時效" : "連接廣告或優惠資料來源"
    },
    {
      id: "ai_scripts",
      label: "AI 文案引擎",
      status: runtime.hasOpenAIApiKey ? "active" : scriptCount > 0 ? "watch" : "manual",
      value: `${scriptCount} 則文案`,
      detail: runtime.hasOpenAIApiKey ? "AI 服務已就緒" : "目前使用範本備援。",
      nextAction: runtime.hasOpenAIApiKey ? "產生文案變體" : "設定 OPENAI_API_KEY"
    },
    {
      id: "profit_optimizer",
      label: "獲利優化器",
      status: hasOptimizer ? "active" : (engine.runs || []).length ? "watch" : "manual",
      value: engine.optimizer?.latestPolicy?.mode || "baseline",
      detail: engine.optimizer?.latestPolicy?.targetAction || "完成一次獲利循環後會顯示優化策略。",
      nextAction: hasOptimizer ? "依策略調整下次循環" : "執行獲利引擎"
    },
    {
      id: "worker_loop",
      label: "背景程序循環",
      status: runtime.workerEnabled && runtime.autonomyMode ? "active" : runtime.workerEnabled ? "watch" : "blocked",
      value: runtime.autonomyMode ? "自主" : "手動",
      detail: runtime.workerEnabled ? "背景程序已啟用。" : "背景程序目前關閉。",
      nextAction: runtime.workerEnabled && runtime.autonomyMode ? "觀察下次心跳" : "啟用背景程序與自主模式"
    },
    {
      id: "threads_publish",
      label: "Threads 發佈",
      status: runtime.dryRun ? "dry_run" : runtime.hasThreadsCredentials ? "active" : "blocked",
      value: runtime.dryRun ? "測試模式" : "正式模式",
      detail: runtime.dryRun ? "目前只會模擬發佈。" : runtime.hasThreadsCredentials ? "憑證已就緒" : "缺少 Threads 憑證。",
      nextAction: runtime.dryRun ? "驗證完成後切換正式模式" : "監控發佈"
    },
    {
      id: "feedback_loop",
      label: "轉換回饋",
      status: Number(metrics.conversions || 0) > 0 ? "active" : "blocked",
      value: `${Number(metrics.conversions || 0)} 次轉換`,
      detail: Number(metrics.conversions || 0) > 0 ? "收益正在回饋模型評分。" : "尚無轉換回饋。",
      nextAction: Number(metrics.conversions || 0) > 0 ? "擴大收益驗證實驗" : "連接轉換 Webhook"
    }
  ];
  const score = Math.round(steps.reduce((total, step) => total + pipelineStatusScore(step.status), 0) / steps.length);
  const blocked = steps.filter((step) => step.status === "blocked").length;
  const nextGate = steps.find((step) => step.status === "blocked") || steps.find((step) => step.status === "watch") || steps[0];
  return {
    summary: {
      mode: runtime.autonomyMode ? "autonomous" : "manual",
      score,
      active: steps.filter((step) => step.status === "active").length,
      blocked,
      readyForUnattended: blocked === 0 && runtime.workerEnabled && runtime.autonomyMode && !runtime.dryRun,
      nextGate: nextGate.label,
      nextAction: nextGate.nextAction
    },
    steps
  };
}

function buildPolicyFallback(data) {
  const metrics = data.metrics || {};
  const runtime = data.runtime || {};
  const queueDepth = Number(metrics.queued || 0);
  const rules = [
    {
      id: "queue_depth",
      label: "佇列深度",
      status: queueDepth <= 50 ? "pass" : "pause",
      value: queueDepth,
      limit: 50,
      action: "新增排程前，請先處理或審核現有佇列。"
    },
    {
      id: "publish_capacity",
      label: "測試與正式發佈能力",
      status: runtime.dryRun || runtime.hasThreadsCredentials ? "pass" : "pause",
      value: runtime.dryRun ? "測試模式" : "正式模式",
      limit: "就緒",
      action: "設定 Threads 憑證，或維持測試模式。"
    },
    {
      id: "conversion_feedback",
      label: "轉換回饋",
      status: Number(metrics.conversions || 0) > 0 ? "pass" : "watch",
      value: Number(metrics.conversions || 0),
      limit: "1+",
      action: "連接轉換 Webhook 以啟用收益學習。"
    }
  ];
  const pausedRules = rules.filter((rule) => rule.status === "pause");
  return {
    mode: pausedRules.length ? "paused" : runtime.autonomyMode ? "autonomous" : "manual",
    canRunCycle: pausedRules.length === 0,
    canCreatePosts: pausedRules.length === 0,
    canPublishQueue: pausedRules.length === 0,
    nextAction: pausedRules[0]?.action || "自主規則檢查已通過。",
    rules
  };
}

function buildOperatingMapFallback(data) {
  const runtime = data.runtime || {};
  const engine = data.profitEngine || {};
  const metrics = data.metrics || {};
  const pipeline = data.autonomyPipeline || buildPipelineFallback(data);
  const policy = data.autonomyPolicy || buildPolicyFallback(data);
  const sources = engine.sources || [];
  const connectedSources = sources.filter((source) => source.runtimeStatus === "connected").length;
  const signalCount = (engine.externalSignals || []).length;
  const scriptCount = (engine.generatedScripts || []).length;
  const conversionRate = Number(metrics.clicks || 0)
    ? Number(((Number(metrics.conversions || 0) / Number(metrics.clicks || 0)) * 100).toFixed(1))
    : 0;
  const healthScore = Math.round(((pipeline.summary?.score || 0) * 0.7) + (policy.canRunCycle ? 30 : 12));
  const leader = engine.models?.[0] || {};

  return {
    summary: {
      mode: policy.mode === "paused" ? "policy_paused" : runtime.dryRun ? "dry_run" : runtime.autonomyMode ? "autonomous_setup" : "manual_build",
      healthScore,
      objective: engine.objective || "自然真實內容 -> 廣告情報 -> 聯盟成交",
      loopLabel: runtime.dryRun ? "測試驗證循環" : "自主營運循環",
      nextAction: policy.nextAction || pipeline.summary?.nextAction || "持續監控",
      unattendedReady: Boolean(pipeline.summary?.readyForUnattended),
      revenue: metrics.revenue || 0,
      conversionRate
    },
    lanes: [
      {
        id: "market_api",
        label: "API / 市場資料匯入",
        status: connectedSources > 0 ? "active" : signalCount > 0 ? "watch" : "blocked",
        value: `${signalCount} 筆訊號`,
        detail: connectedSources > 0 ? `${connectedSources} 個資料來源已連線。` : "請連接廣告或聯盟資料來源。",
        action: "同步市場訊號"
      },
      {
        id: "ai_script_agent",
        label: "AI 自然文案代理",
        status: runtime.hasOpenAIApiKey ? "active" : scriptCount > 0 ? "watch" : "manual",
        value: `${scriptCount} 則文案`,
        detail: runtime.hasOpenAIApiKey ? "AI 服務已就緒。" : "目前使用範本備援。",
        action: runtime.hasOpenAIApiKey ? "產生文案變體" : "連接 OpenAI"
      },
      {
        id: "threads_publish_api",
        label: "Threads 發佈 API",
        status: runtime.dryRun ? "dry_run" : runtime.hasThreadsCredentials ? "active" : "blocked",
        value: runtime.dryRun ? "測試模式" : "正式模式",
        detail: runtime.dryRun ? "目前只會模擬發佈。" : "正式發佈路徑。",
        action: "監控佇列"
      },
      {
        id: "conversion_feedback",
        label: "轉換回饋",
        status: Number(metrics.conversions || 0) > 0 ? "active" : "blocked",
        value: `${Number(metrics.conversions || 0)} 次轉換`,
        detail: "收益事件會調整後續模型評分。",
        action: "連接回傳事件"
      }
    ],
    flow: [
      {
        id: "research_profit_model",
        label: "研究獲利模型",
        status: (engine.runs || []).length ? "active" : "manual",
        value: `${(engine.models || []).length} 個模型`,
        detail: leader.name ? `領先模型：${leader.name}` : "執行研究以選擇模型。",
        signal: operatingStatusLabel(engine.experiments?.confidence || "setup")
      },
      {
        id: "rewrite_natural",
        label: "改寫自然 Threads 文案",
        status: scriptCount > 0 ? "active" : "manual",
        value: `${scriptCount} 則文案`,
        detail: "將優惠轉為誠實且低風險的推薦貼文。",
        signal: "安全檢查"
      },
      {
        id: "acquire_ads",
        label: "取得廣告與優惠依據",
        status: signalCount > 0 ? "active" : "blocked",
        value: `${signalCount} 筆訊號`,
        detail: "廣告與優惠資料會成為評分依據。",
        signal: connectedSources > 0 ? "即時" : "待設定"
      },
      {
        id: "schedule_publish",
        label: "排程與發佈",
        status: Number(metrics.queued || 0) > 0 ? "active" : runtime.dryRun ? "dry_run" : "watch",
        value: `${Number(metrics.queued || 0)} 則等待中`,
        detail: "通過驗證的貼文會進入發佈佇列。",
        signal: `${Number(metrics.published || 0) + Number(metrics.simulated || 0)} 則已送出`
      },
      {
        id: "learn_optimize",
        label: "學習與優化",
        status: Number(metrics.conversions || 0) > 0 ? "active" : Number(metrics.clicks || 0) > 0 ? "watch" : "manual",
        value: `${conversionRate}% 轉換率`,
        detail: "回饋資料會更新下一次自主策略。",
        signal: engine.optimizer?.latestPolicy?.mode || "基準"
      }
    ],
    decision: {
      title: engine.optimizer?.latestPolicy?.targetAction || "維持最高分模型",
      confidence: engine.experiments?.confidence || "setup",
      selectedModel: leader.name || "尚未選擇模型",
      selectedOffer: engine.generatedScripts?.[0]?.hook || "尚無有效文案",
      policyMode: policy.mode,
      guardrailState: (engine.blockedScripts || []).length ? "needs_review" : "clear",
      nextAction: policy.nextAction || "執行獲利引擎",
      reasons: [
        ...(engine.optimizer?.latestPolicy?.reasons || []),
        policy.nextAction || "",
        pipeline.summary?.nextAction || ""
      ].filter(Boolean).slice(0, 4)
    }
  };
}

function operatingStatusLabel(status) {
  const labels = {
    active: "正常",
    dry_run: "測試模式",
    watch: "觀察中",
    manual: "手動",
    paused: "已暫停",
    blocked: "已阻擋",
    pass: "通過",
    pause: "暫停",
    warning: "警告",
    ready: "就緒",
    connected: "已連線",
    configured: "已設定",
    setup: "待設定",
    error: "錯誤",
    backoff: "等待重試",
    on: "開啟",
    off: "關閉",
    autonomous: "自主",
    live: "正式",
    high: "高",
    medium: "中",
    low: "低",
    critical: "緊急",
    auto: "自動",
    waiting: "等待中",
    needs_config: "待設定",
    self_running: "自主運行",
    operator_assisted: "人工輔助",
    policy_paused: "規則暫停",
    clear: "通過",
    needs_review: "待審核",
    scaling: "擴大中",
    learning: "學習中",
    watching: "觀察中",
    revenue_backed: "收益驗證",
    traffic_backed: "流量驗證",
    model_backed: "模型驗證",
    unknown: "未知"
  };
  const key = String(status || "unknown").replaceAll("-", "_");
  return labels[key] || status || "未知";
}

function renderOperatingMap(data) {
  const map = data.operatingMap || buildOperatingMapFallback(data);
  const summary = map.summary || {};
  const lanes = map.lanes || [];
  const flow = map.flow || [];
  const decision = map.decision || {};
  const modeClass = summary.unattendedReady ? "active" : summary.mode === "policy_paused" ? "paused" : summary.mode === "dry_run" ? "dry_run" : "watch";

  $("#operatingMapObjective").textContent = summary.objective || "自然真實內容 → 廣告情報 → 聯盟成交";
  $("#operatingMapMode").textContent = operatingStatusLabel(summary.mode || "manual");
  $("#operatingMapMode").className = `status-${modeClass}`;
  $("#operatingMapScore").textContent = `${Number(summary.healthScore || 0)}%`;
  $("#operatingMapLoop").textContent = `${summary.loopLabel || "自主循環"} · ${formatMoney(summary.revenue || 0)} · ${Number(summary.conversionRate || 0)}% 轉換率`;
  $("#operatingMapNextAction").textContent = summary.nextAction || "持續監控";

  $("#operatingMapLanes").innerHTML = lanes.map((lane) => `
    <article class="agent-lane status-${escapeHtml(lane.status)}">
      <span>${escapeHtml(operatingStatusLabel(lane.status))}</span>
      <div>
        <strong>${escapeHtml(lane.label)}</strong>
        <p>${escapeHtml(lane.detail)}</p>
      </div>
      <small>${escapeHtml(lane.value)} · ${escapeHtml(lane.action)}</small>
    </article>
  `).join("");

  $("#operatingMapFlow").innerHTML = flow.map((step, index) => `
    <article class="flow-node status-${escapeHtml(step.status)}">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <div>
        <strong>${escapeHtml(step.label)}</strong>
        <p>${escapeHtml(step.detail)}</p>
      </div>
      <footer>
        <b>${escapeHtml(step.value)}</b>
        <small>${escapeHtml(step.signal)}</small>
      </footer>
    </article>
  `).join("");

  $("#operatingMapDecision").innerHTML = `
    <div class="decision-rail-head">
      <span>自主決策</span>
      <strong>${escapeHtml(decision.title || "持續監控")}</strong>
    </div>
    <dl class="decision-facts">
      <div><dt>信心程度</dt><dd>${escapeHtml(operatingStatusLabel(decision.confidence || "setup"))}</dd></div>
      <div><dt>獲利模型</dt><dd>${escapeHtml(decision.selectedModel || "-")}</dd></div>
      <div><dt>推薦內容</dt><dd>${escapeHtml(decision.selectedOffer || "-")}</dd></div>
      <div><dt>執行規則</dt><dd>${escapeHtml(operatingStatusLabel(decision.policyMode || "manual"))}</dd></div>
      <div><dt>安全檢查</dt><dd>${escapeHtml(operatingStatusLabel(decision.guardrailState || "clear"))}</dd></div>
    </dl>
    <div class="decision-reasons">
      ${(decision.reasons || []).map((reason) => `<p>${escapeHtml(reason)}</p>`).join("") || "<p>尚無決策依據。</p>"}
    </div>
    <small>${escapeHtml(decision.nextAction || "執行獲利引擎")}</small>
  `;
}

function buildGrowthLoopFallback(data) {
  const runtime = data.runtime || {};
  const engine = data.profitEngine || {};
  const policy = data.autonomyPolicy || buildPolicyFallback(data);
  const metrics = data.metrics || {};
  const scriptCount = (engine.generatedScripts || []).length;
  const signalCount = (engine.externalSignals || []).length;
  const queueDepth = Number(metrics.queued || 0);
  const blockedScriptCount = (engine.blockedScripts || []).length;
  const workerWillRun = Boolean(runtime.workerEnabled && runtime.autonomyMode && policy.canRunCycle);
  const missions = [
    {
      id: "market_signal_ingest",
      lane: "research",
      title: "取得行銷廣告與優惠訊號",
      priority: signalCount ? "medium" : "high",
      status: signalCount ? "auto" : "needs_config",
      automation: signalCount ? "worker_ingest" : "config_required",
      trigger: `${signalCount} 筆訊號`,
      expectedImpact: "讓獲利模型從市場證據學習。",
      action: signalCount ? "下次循環會匯入資料來源。" : "請連接廣告或優惠資料來源。",
      request: signalCount ? { path: "/api/autonomy/cycle", method: "POST", body: { source: "growth-loop.market", force: true, createPosts: false, publishQueue: false } } : null
    },
    {
      id: "natural_script_generation",
      lane: "content",
      title: "產生自然真實 Threads 腳本文案",
      priority: scriptCount ? "medium" : "high",
      status: policy.canCreatePosts ? "auto" : "paused",
      automation: runtime.hasOpenAIApiKey ? "ai_script_agent" : "template_fallback",
      trigger: `${scriptCount} 則文案`,
      expectedImpact: "產生有揭露、不誇大、可排程的推薦文。",
      action: policy.canCreatePosts ? "產生文案。" : policy.nextAction,
      request: policy.canCreatePosts ? { path: "/api/profit-engine/run", method: "POST", body: { source: "growth-loop.scripts", force: true, createPosts: true, autoApprove: true } } : null
    },
    {
      id: "queue_publish",
      lane: "distribution",
      title: "執行發佈或測試佇列",
      priority: queueDepth ? "high" : "medium",
      status: queueDepth ? policy.canPublishQueue ? "auto" : "paused" : "waiting",
      automation: "queue_runner",
      trigger: `${queueDepth} 則貼文等待中`,
      expectedImpact: "把通過 guardrail 的內容送入發佈流程。",
      action: queueDepth ? "處理佇列。" : "等待產生文案。",
      request: queueDepth && policy.canPublishQueue ? { path: "/api/automation/run", method: "POST", body: { source: "growth-loop.queue" } } : null
    },
    {
      id: "guardrail_repair",
      lane: "quality",
      title: "自動修復被擋腳本",
      priority: blockedScriptCount ? "high" : "low",
      status: blockedScriptCount ? "auto" : "waiting",
      automation: blockedScriptCount ? "optimizer_repair" : "observe",
      trigger: `${blockedScriptCount} 則文案被阻擋`,
      expectedImpact: "降低合規風險與重複發文。",
      action: blockedScriptCount ? "重新產生較安全的文案。" : "目前不需修復。",
      request: blockedScriptCount ? { path: "/api/profit-engine/run", method: "POST", body: { source: "growth-loop.repair", force: true, createPosts: true, autoApprove: true } } : null
    }
  ];
  const autoExecutable = missions.filter((mission) => mission.status === "auto" && mission.request).length;
  const needsConfig = missions.filter((mission) => mission.status === "needs_config").length;
  const paused = missions.filter((mission) => mission.status === "paused").length;
  const waiting = missions.filter((mission) => mission.status === "waiting").length;
  return {
    summary: {
      mode: workerWillRun ? "self_running" : policy.mode === "paused" ? "policy_paused" : "operator_assisted",
      automationScore: Math.max(0, Math.min(100, Math.round(autoExecutable * 18 + (workerWillRun ? 25 : 0) - needsConfig * 8 - paused * 6))),
      workerWillRun,
      autoExecutable,
      needsConfig,
      paused,
      waiting,
      nextMissionTitle: missions.find((mission) => mission.status === "auto")?.title || missions[0]?.title || "監控成長循環",
      nextAction: missions.find((mission) => mission.status === "auto")?.action || missions[0]?.action || "監控成長循環",
      cadence: runtime.autonomyMode ? "scheduled" : "manual",
      dryRun: runtime.dryRun
    },
    missions,
    controls: {
      enableWorker: runtime.workerEnabled,
      autonomyMode: runtime.autonomyMode,
      policyMode: policy.mode,
      policyAction: policy.nextAction,
      canRunCycle: policy.canRunCycle,
      canCreatePosts: policy.canCreatePosts,
      canPublishQueue: policy.canPublishQueue
    }
  };
}

function renderGrowthLoop(data) {
  const loop = data.growthLoop || buildGrowthLoopFallback(data);
  const summary = loop.summary || {};
  const controls = loop.controls || {};
  const missions = loop.missions || [];
  const modeClass = summary.mode === "self_running" ? "active" : summary.mode === "policy_paused" ? "paused" : "watch";

  $("#growthLoopMode").textContent = `${operatingStatusLabel(summary.mode || "manual")} · ${Number(summary.automationScore || 0)}%`;
  $("#growthLoopMode").className = `growth-mode status-${modeClass}`;
  $("#growthLoopSummary").innerHTML = [
    ["自動任務", summary.autoExecutable || 0, "可透過 API 執行"],
    ["待設定", summary.needsConfig || 0, "環境變數或資料來源"],
    ["已暫停", summary.paused || 0, "受規則保護"],
    ["等待中", summary.waiting || 0, "等待資料"],
    ["下一步", summary.nextMissionTitle || "持續監控", summary.nextAction || "無需動作"],
    ["執行週期", operatingStatusLabel(summary.cadence || "manual"), summary.workerWillRun ? "已排程自動執行" : "人工輔助"],
    ["上次執行", summary.lastExecution?.missionTitle || "尚無", summary.lastExecution ? `${operatingStatusLabel(summary.lastExecution.status)} · ${formatDate(summary.lastExecution.createdAt)}` : "尚無執行紀錄"]
  ].map(([label, value, hint]) => `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");

  $("#growthLoopControls").innerHTML = [
    ["背景程序", controls.enableWorker ? "開啟" : "關閉", "ENABLE_WORKER"],
    ["自主模式", controls.autonomyMode ? "開啟" : "關閉", "AUTONOMY_MODE"],
    ["執行規則", operatingStatusLabel(controls.policyMode || "manual"), controls.policyAction || "-"],
    ["研究循環", controls.canRunCycle ? "就緒" : "已暫停", "執行研究循環"],
    ["內容建立", controls.canCreatePosts ? "就緒" : "已暫停", "建立貼文內容"],
    ["發佈佇列", controls.canPublishQueue ? "就緒" : "已暫停", "執行發佈佇列"]
  ].map(([label, value, hint]) => `
    <article class="growth-control ${String(value).includes("關閉") || String(value).includes("暫停") ? "is-warn" : "is-ready"}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");

  $("#growthLoopMissions").innerHTML = missions.map((mission, index) => `
    <article class="growth-mission status-${escapeHtml(mission.status)} priority-${escapeHtml(mission.priority)}">
      <span>${escapeHtml(operatingStatusLabel(mission.priority))}</span>
      <div>
        <header>
          <strong>${escapeHtml(mission.title)}</strong>
          <small>${escapeHtml(operatingStatusLabel(mission.status))} · ${escapeHtml(mission.automation)}</small>
        </header>
        <p>${escapeHtml(mission.expectedImpact)}</p>
        <small>${escapeHtml(mission.trigger)} · ${escapeHtml(mission.action)}</small>
      </div>
      <button class="button ${mission.request ? "" : "secondary"}" type="button" data-growth-mission="${index}" ${mission.request ? "" : "disabled"}>
        ${mission.request ? "執行" : "監控"}
      </button>
    </article>
  `).join("");
  state.growthMissions = missions;
}

function renderAutonomyPipeline(data) {
  const pipeline = data.autonomyPipeline || buildPipelineFallback(data);
  const policy = data.autonomyPolicy || buildPolicyFallback(data);
  const summary = pipeline.summary || {};
  const steps = pipeline.steps || [];
  const latestCycle = pipeline.latestCycle || null;
  $("#pipelineMode").textContent = `${operatingStatusLabel(summary.mode || "manual")} · ${summary.score || 0}%`;
  $("#pipelineMode").className = `pipeline-mode status-${summary.readyForUnattended ? "active" : summary.blocked ? "blocked" : "watch"}`;
  $("#pipelineSummary").innerHTML = [
    ["完成度", `${summary.score || 0}%`, "自動化流程"],
    ["執行中", summary.active || 0, "正常階段"],
    ["已阻擋", summary.blocked || 0, "必須處理"],
    ["下一關卡", summary.nextGate || "持續監控", summary.nextAction || "無需動作"],
    ["上次循環", latestCycle ? `${latestCycle.createdPostCount || 0} 則貼文` : "尚無", latestCycle ? `${latestCycle.source || "循環"} · ${formatDate(latestCycle.createdAt)}` : "尚未執行"]
  ].map(([label, value, hint]) => `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");
  $("#pipelineSteps").innerHTML = steps.map((step, index) => `
    <article class="pipeline-step status-${escapeHtml(step.status)}">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <div>
        <strong>${escapeHtml(step.label)}</strong>
        <p>${escapeHtml(step.detail)}</p>
        <small>${escapeHtml(step.nextAction)}</small>
      </div>
      <b>${escapeHtml(step.value)}</b>
    </article>
  `).join("");
  $("#policyMode").textContent = `${operatingStatusLabel(policy.mode || "manual")} · ${policy.canRunCycle ? "循環就緒" : "循環暫停"}`;
  $("#policyMode").className = `policy-mode status-${policy.canRunCycle ? "pass" : "pause"}`;
  $("#policyRules").innerHTML = (policy.rules || []).map((rule) => `
    <article class="policy-rule status-${escapeHtml(rule.status)}">
      <span>${escapeHtml(operatingStatusLabel(rule.status))}</span>
      <div>
        <strong>${escapeHtml(rule.label)}</strong>
        <small>${escapeHtml(rule.value)} / ${escapeHtml(rule.limit)}</small>
      </div>
    </article>
  `).join("");
}

function renderReadiness(data) {
  const readiness = data.readiness || {};
  const summary = readiness.summary || {};
  const liveGate = readiness.liveGate || {};
  const liveAllowed = liveGate.allowed === true;
  const liveGateLabel = liveAllowed ? "允許" : "阻擋";
  const liveGateHint = liveGate.enforced ? "目前強制檢查" : "可繼續測試模式";
  const missingEnv = (liveGate.missingEnv || []).join(", ") || "無";
  const modeLabels = {
    blocked: "已阻擋",
    dry_run_ready: "測試模式就緒",
    needs_attention: "需要處理",
    live_ready: "正式模式就緒"
  };
  $("#readinessMode").textContent = modeLabels[summary.mode] || "未知";
  $("#readinessMode").className = `readiness-mode ${escapeHtml(summary.mode || "unknown")}`;

  $("#readinessSummary").innerHTML = [
    ["準備度", `${summary.score || 0}%`, "自動化上線狀態"],
    ["正式發佈", liveGateLabel, liveGateHint],
    ["已通過", summary.ready || 0, "檢查通過"],
    ["警告", summary.warning || 0, "安全但尚未完整"],
    ["已阻擋", summary.blocked || 0, "必須處理"],
    ["缺少設定", missingEnv, "正式模式前必填"],
    ["下一步", summary.nextAction || "-", "最高優先"]
  ].map(([label, value, hint]) => `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");

  const center = readiness.connectorCenter || {};
  const connectors = center.connectors || [];
  $("#connectorCenter").innerHTML = `
    <div class="connector-center-head">
      <div>
        <span>API / AI 服務連線</span>
        <strong>${Number(center.score || 0)}% 就緒</strong>
      </div>
      <p>${escapeHtml(center.nextAction || "Connect sources to unlock autonomous profit loops.")}</p>
      <small>${Number(center.configured || 0)}/${Number(center.total || connectors.length || 0)} 已設定 · ${Number(center.blocked || 0)} 阻擋 · ${Number(center.error || 0)} 錯誤 · ${Number(center.backoff || 0)} 等待重試</small>
    </div>
    <div class="connector-center-grid">
      ${connectors.map((item) => `
        <article class="connector-card status-${escapeHtml(item.status)}">
          <header>
            <span>${escapeHtml(operatingStatusLabel(item.status))}</span>
            <small>${escapeHtml(item.lane)}</small>
          </header>
          <strong>${escapeHtml(item.name)}</strong>
          <p>${escapeHtml(item.purpose)}</p>
          <div class="connector-meta">
            <span>${escapeHtml(operatingStatusLabel(item.signal || (item.configured ? "configured" : "setup")))}</span>
            <small>${(item.envKeys || []).map((key) => `<code>${escapeHtml(key)}</code>`).join("")}</small>
          </div>
          <footer>
            <span>${escapeHtml(item.nextRetryAt ? `重試 ${formatDate(item.nextRetryAt)}` : item.nextAction || "持續監控")}</span>
            ${item.failureCount ? `<b>${Number(item.failureCount)} 次失敗</b>` : ""}
          </footer>
        </article>
      `).join("") || `<div class="empty-state">尚無服務連線資料</div>`}
    </div>
  `;

  const liveGateRows = (liveGate.reasons || []).map((reason) => `
    <article class="readiness-check status-blocked">
      <span>正式發佈阻擋</span>
      <div>
        <strong>${escapeHtml(reason.label)}</strong>
        <p>${escapeHtml(reason.detail)}</p>
        <small>${escapeHtml(reason.action)}${(reason.envKeys || []).length ? ` · ${reason.envKeys.map((key) => escapeHtml(key)).join(", ")}` : ""}</small>
      </div>
    </article>
  `).join("");

  $("#readinessChecks").innerHTML = `${liveGateRows}${(readiness.checks || []).map((check) => `
    <article class="readiness-check status-${escapeHtml(check.status)}">
      <span>${escapeHtml(operatingStatusLabel(check.status))}</span>
      <div>
        <strong>${escapeHtml(check.label)}</strong>
        <p>${escapeHtml(check.detail)}</p>
        <small>${escapeHtml(check.action)}</small>
      </div>
    </article>
  `).join("")}`;
}

function timelineBadge(label, tone = "info") {
  return `<span class="timeline-badge ${tone}">${escapeHtml(label)}</span>`;
}

function buildTimelineItems(data) {
  const profitRuns = (data.profitEngine?.runs || []).map((run) => ({
    type: "profit",
    tone: run.blockedScriptCount ? "warn" : "good",
    at: run.createdAt,
    title: `獲利引擎選擇 ${run.selectedModelName || run.selectedModelId || "模型"}`,
    detail: `${run.source || "手動"}執行 · 分數 ${Number(run.score || 0)} · ${run.scriptSource || "範本"}文案`,
    badges: [
      timelineBadge(`${(run.createdPostIds || []).length} 則貼文`, "info"),
      timelineBadge(`${run.blockedScriptCount || 0} 則阻擋`, run.blockedScriptCount ? "warn" : "good"),
      timelineBadge(`${(run.syncedProductIds || []).length} 筆優惠`, "info")
    ]
  }));

  const automationRuns = (data.automationRuns || []).map((run) => ({
    type: "publish",
    tone: run.failed ? "warn" : "good",
    at: run.finishedAt || run.startedAt,
    title: `發佈佇列${reviewStatusLabel(run.status || "completed")}`,
    detail: `${run.source || "手動"} · 已處理 ${Number(run.processed || 0)} · 已模擬 ${Number(run.simulated || 0)} · 已發佈 ${Number(run.published || 0)}`,
    badges: [
      timelineBadge(`${run.failed || 0} 次失敗`, run.failed ? "warn" : "good"),
      timelineBadge(`${run.messages?.length || 0} 則訊息`, "info")
    ]
  }));

  const events = (data.recentEvents || []).map((event) => ({
    type: "event",
    tone: "info",
    at: event.createdAt,
    title: String(event.type || "事件").replaceAll("_", " "),
    detail: [event.runId, event.postId, event.affiliateLinkId, event.conversionId].filter(Boolean).join(" · ") || event.id,
    badges: [
      event.createdPostCount != null ? timelineBadge(`${event.createdPostCount} 則已建立`, "info") : "",
      event.revenueDelta != null ? timelineBadge(formatMoney(event.revenueDelta), "good") : ""
    ].filter(Boolean)
  }));

  return [...profitRuns, ...automationRuns, ...events]
    .filter((item) => item.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 10);
}

function renderOpsTimeline(data) {
  const items = buildTimelineItems(data);
  $("#timelineCount").textContent = `${items.length} 筆`;
  $("#opTimeline").innerHTML = items.map((item) => `
    <article class="timeline-item tone-${escapeHtml(item.tone)}">
      <div class="timeline-dot" aria-hidden="true"></div>
      <div>
        <div class="timeline-head">
          <strong>${escapeHtml(item.title)}</strong>
          <time>${escapeHtml(formatDate(item.at))}</time>
        </div>
        <p>${escapeHtml(item.detail)}</p>
        <div class="timeline-badges">${item.badges.join("")}</div>
      </div>
    </article>
  `).join("") || `<div class="empty-state">尚無自主營運紀錄</div>`;
}

function nextAction(priority, title, detail, actionLabel, request = null) {
  return { priority, title, detail, actionLabel, request };
}

function buildNextActions(data) {
  const actions = [];
  const readinessChecks = data.readiness?.checks || [];
  const blockedReadiness = readinessChecks.filter((check) => check.status === "blocked");
  const warningReadiness = readinessChecks.filter((check) => check.status === "warning");
  const engine = data.profitEngine || {};
  const metrics = data.metrics || {};

  blockedReadiness.slice(0, 2).forEach((check) => {
    actions.push(nextAction("critical", check.label, check.detail, check.action));
  });

  if ((engine.externalSignals || []).length === 0) {
    actions.push(nextAction(
      "high",
      "連接即時市場訊號",
      "獲利引擎目前仍使用內建資料。連接廣告或優惠資料來源後，評分才能反映真實市場需求。",
      "設定 AD_INTELLIGENCE_FEED_URLS 或 AFFILIATE_OFFER_FEED_URLS"
    ));
  }

  if ((engine.generatedScripts || []).length === 0 || (engine.runs || []).length === 0) {
    actions.push(nextAction(
      "high",
      "執行研究與文案循環",
      "根據目前優惠資料重新選擇獲利模型，並產生自然的聯盟行銷文案。",
      "執行獲利引擎",
      {
        path: "/api/profit-engine/run",
        method: "POST",
        body: { source: "next-actions", force: true, createPosts: true, autoApprove: true }
      }
    ));
  }

  if (Number(metrics.queued || 0) > 0) {
    actions.push(nextAction(
      "medium",
      "處理發佈佇列",
      `${Number(metrics.queued || 0)} 則已核准貼文正在等待正式發佈或測試模擬。`,
      "執行佇列",
      { path: "/api/automation/run", method: "POST", body: { source: "next-actions" } }
    ));
  }

  if (Number(metrics.drafts || 0) > 0) {
    actions.push(nextAction(
      "medium",
      "審核待處理草稿",
      `${Number(metrics.drafts || 0)} 則草稿正在等待核准，完成後才能進入發佈流程。`,
      "前往內容審核"
    ));
  }

  if ((engine.blockedScripts || []).length > 0) {
    actions.push(nextAction(
      "high",
      "檢查安全規則阻擋",
      `${engine.blockedScripts.length} 則文案被合規或 Threads 驗證規則阻擋。`,
      "查看被阻擋文案"
    ));
  }

  if (Number(metrics.clicks || 0) > 0 && Number(metrics.conversions || 0) === 0) {
    actions.push(nextAction(
      "medium",
      "連接轉換回饋",
      "目前已有點擊但尚無轉換回傳，因此模型還無法依收益品質學習。",
      "設定 /api/conversions Webhook"
    ));
  }

  warningReadiness.slice(0, 2).forEach((check) => {
    if (!actions.some((action) => action.title === check.label)) {
      actions.push(nextAction("low", check.label, check.detail, check.action));
    }
  });

  if (!actions.length) {
    actions.push(nextAction(
      "low",
      "監控下一次自主循環",
      "目前沒有緊急事項，持續觀察營運紀錄、轉換回饋與安全阻擋即可。",
      "持續監控"
    ));
  }

  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  return actions
    .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
    .slice(0, 7);
}

function renderNextActions(data) {
  const actions = buildNextActions(data);
  const counts = actions.reduce((acc, action) => {
    acc[action.priority] = (acc[action.priority] || 0) + 1;
    return acc;
  }, {});
  $("#nextActionCount").textContent = `${actions.length} 項`;
  $("#actionSummary").innerHTML = ["critical", "high", "medium", "low"].map((priority) => `
    <article>
      <span>${escapeHtml(operatingStatusLabel(priority))}</span>
      <strong>${Number(counts[priority] || 0)}</strong>
    </article>
  `).join("");
  $("#nextActionList").innerHTML = actions.map((action, index) => `
    <article class="next-action priority-${escapeHtml(action.priority)}">
      <span>${escapeHtml(operatingStatusLabel(action.priority))}</span>
      <div>
        <strong>${escapeHtml(action.title)}</strong>
        <p>${escapeHtml(action.detail)}</p>
      </div>
      <button class="button ${action.request ? "" : "secondary"}" type="button" data-next-action="${index}">
        ${escapeHtml(action.actionLabel)}
      </button>
    </article>
  `).join("");
  state.nextActions = actions;
}

function buildDecisionBrief(data) {
  const engine = data.profitEngine || {};
  const models = engine.models || [];
  const selected = models[0] || {};
  const runnerUp = models[1] || {};
  const latestRun = (engine.runs || [])[0] || {};
  const metrics = data.metrics || {};
  const readiness = data.readiness?.summary || {};
  const signalCount = (engine.externalSignals || []).length;
  const sourceCount = (engine.sourceStatuses || []).filter((source) => source.status === "connected").length;
  const conversionRate = Number(metrics.clicks || 0)
    ? ((Number(metrics.conversions || 0) / Number(metrics.clicks || 0)) * 100).toFixed(1)
    : "0.0";
  const scoreGap = Number(selected.score || 0) - Number(runnerUp.score || 0);
  const confidenceScore = Math.max(0, Math.min(100,
    Math.round(
      Number(selected.score || 0) * 0.45
      + Number(readiness.score || 0) * 0.25
      + Math.min(signalCount * 8, 16)
      + Math.min(Number(metrics.conversions || 0) * 3, 12)
      + Math.max(scoreGap, 0) * 0.15
    )
  ));
  const confidence = confidenceScore >= 82 ? "high" : confidenceScore >= 62 ? "medium" : "low";

  return {
    confidence,
    confidenceScore,
    selectedModel: selected.name || "尚未選擇模型",
    selectedScore: Number(selected.score || 0),
    runnerUp: runnerUp.name || "尚無次選模型",
    scoreGap,
    latestRunAt: latestRun.createdAt,
    scriptSource: latestRun.scriptSource || (engine.generatedScripts?.[0]?.source || "尚未產生"),
    evidence: [
      `${models.length} 個獲利模型已評分`,
      `${signalCount} 筆外部市場訊號，${sourceCount} 個資料來源已連線`,
      `${Number(metrics.clicks || 0)} 次點擊，${Number(metrics.conversions || 0)} 次轉換，轉換率 ${conversionRate}%`,
      `${(engine.blockedScripts || []).length} 次安全阻擋，揭露完整率 ${Number(metrics.disclosureCoverage || 0)}%`
    ],
    rationale: [
      selected.stage ? `漏斗階段：${selected.stage}` : "首次獲利循環完成後才會判斷漏斗階段。",
      selected.monetization ? `收益模式：${selected.monetization}` : "尚未選擇收益模式。",
      selected.adAngle ? `自然文案角度：${selected.adAngle}` : "連接即時市場資料後，文案角度會更準確。",
      latestRun.source ? `最新決策來源：${latestRun.source}` : "尚無自主決策執行紀錄。"
    ],
    gaps: [
      signalCount === 0 ? "請連接廣告或優惠資料來源以取得真實市場依據。" : "",
      sourceCount === 0 ? "目前尚無即時資料來源回報已連線。" : "",
      Number(metrics.conversions || 0) === 0 ? "轉換回饋仍不足，暫時無法依收益學習。" : "",
      readiness.blocked > 0 ? `正式自主運行前仍有 ${readiness.blocked} 個阻擋項目。` : ""
    ].filter(Boolean)
  };
}

function renderDecisionBrief(data) {
  const brief = buildDecisionBrief(data);
  $("#decisionConfidence").textContent = `${operatingStatusLabel(brief.confidence)}信心 · ${brief.confidenceScore}%`;
  $("#decisionConfidence").className = `decision-confidence confidence-${escapeHtml(brief.confidence)}`;
  $("#decisionBrief").innerHTML = `
    <article class="decision-card decision-primary">
      <span>選定模型</span>
      <strong>${escapeHtml(brief.selectedModel)}</strong>
      <p>分數 ${brief.selectedScore} · 與次選差距 ${brief.scoreGap >= 0 ? "+" : ""}${brief.scoreGap}</p>
      <small>次選模型：${escapeHtml(brief.runnerUp)}</small>
    </article>
    <article class="decision-card">
      <span>最新執行</span>
      <strong>${escapeHtml(brief.scriptSource)}</strong>
      <p>${escapeHtml(brief.latestRunAt ? formatDate(brief.latestRunAt) : "尚未執行")}</p>
      <small>文案來源與執行時間可協助判斷是否使用備援流程。</small>
    </article>
    <article class="decision-card wide">
      <span>決策依據</span>
      <div class="decision-list">
        ${brief.evidence.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
      </div>
    </article>
    <article class="decision-card wide">
      <span>選擇理由</span>
      <div class="decision-list">
        ${brief.rationale.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
      </div>
    </article>
    <article class="decision-card wide">
      <span>資料缺口</span>
      <div class="decision-list">
        ${(brief.gaps.length ? brief.gaps : ["目前沒有重大資料缺口。"]).map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
      </div>
    </article>
  `;
}

function ageLabel(value, referenceValue) {
  if (!value) return "尚無心跳紀錄";
  const then = new Date(value).getTime();
  const now = referenceValue ? new Date(referenceValue).getTime() : Date.now();
  if (Number.isNaN(then) || Number.isNaN(now)) return "未知";
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小時 ${rest} 分鐘前` : `${hours} 小時前`;
}

function buildWorkerHealth(data) {
  const runtime = data.runtime || {};
  const engine = data.profitEngine || {};
  const metrics = data.metrics || {};
  const readiness = data.readiness?.summary || {};
  const lease = data.workerLease || {};
  const automationRun = (data.automationRuns || [])[0] || {};
  const profitRun = (engine.runs || [])[0] || {};
  const recentEvent = (data.recentEvents || [])[0] || {};
  const heartbeatAt = lease.heartbeatAt
    || automationRun.finishedAt
    || automationRun.startedAt
    || profitRun.createdAt
    || engine.lastRunAt
    || recentEvent.createdAt;
  const scheduledAutonomyPosts = Number(engine.scheduledAutonomyPosts || 0);
  const queuedPosts = Number(metrics.queued || 0);
  const queuePressure = queuedPosts + scheduledAutonomyPosts;
  const workerMode = !runtime.workerEnabled
    ? "offline"
    : !runtime.autonomyMode
      ? "manual"
      : runtime.dryRun
        ? "dry_run"
        : "live";
  const modeLabels = {
    offline: "背景程序關閉",
    manual: "手動監控",
    dry_run: "測試循環",
    live: "正式自主運行"
  };
  const healthScore = Math.max(0, Math.min(100,
    (runtime.workerEnabled ? 25 : 0)
    + (runtime.autonomyMode ? 20 : 0)
    + (lease.active ? 10 : 0)
    + ((profitRun.createdAt || engine.lastRunAt) ? 15 : 0)
    + ((automationRun.finishedAt || automationRun.startedAt) ? 15 : 0)
    + (Number(readiness.blocked || 0) === 0 ? 10 : 0)
    + ((runtime.dryRun || runtime.hasThreadsCredentials) ? 15 : 0)
  ));
  const notes = [
    !runtime.workerEnabled ? "設定 ENABLE_WORKER=true 後，平台才能在無人點擊時持續執行。" : "",
    runtime.workerEnabled && !runtime.autonomyMode ? "需要排程研究、產稿與佇列處理時，請設定 AUTONOMY_MODE=true。" : "",
    runtime.workerEnabled && runtime.autonomyMode && runtime.dryRun ? "目前由測試模式保護，只會模擬發佈，不會送出正式貼文。" : "",
    !runtime.dryRun && !runtime.hasThreadsCredentials ? "正式模式需要有效的 Threads 憑證才能發佈。" : "",
    runtime.workerEnabled && !lease.active ? "目前沒有有效的工作租約，背景程序可能尚未執行或先前執行個體已失效。" : "",
    lease.active ? `工作租約目前由 ${lease.ownerId || "目前執行個體"} 持有。` : "",
    !heartbeatAt ? "尚無背景程序心跳紀錄，請先執行一次獲利引擎或發佈佇列。" : "",
    Number(readiness.blocked || 0) > 0 ? `正式無人運行前仍有 ${readiness.blocked} 個阻擋項目。` : "",
    queuePressure > 0 ? `目前有 ${queuePressure} 則貼文等待自主流程或發佈佇列處理。` : ""
  ].filter(Boolean);

  if (!notes.length) {
    notes.push("背景程序狀態正常，請持續觀察下一次自主循環。");
  }

  return {
    mode: workerMode,
    modeLabel: modeLabels[workerMode],
    healthScore,
    heartbeatAt,
    heartbeatAge: ageLabel(heartbeatAt, data.generatedAt),
    leaseStatus: lease.active ? "正常" : lease.stale ? "已失效" : "無",
    leaseOwner: lease.ownerId || "-",
    leaseExpiresAt: lease.expiresAt || "",
    leaseTtlSeconds: Number(lease.ttlSeconds || 0),
    nextRunHint: engine.nextRunHint || (runtime.workerEnabled ? "依設定週期" : "手動"),
    latestAutomationStatus: automationRun.status || "尚無自動化執行",
    latestProfitSource: profitRun.source || (engine.lastRunAt ? "獲利引擎" : "尚無獲利執行"),
    queuePressure,
    scheduledAutonomyPosts,
    queuedPosts,
    readinessMode: readiness.mode || "未知",
    readinessBlocked: Number(readiness.blocked || 0),
    notes
  };
}

function renderWorkerHealth(data) {
  const health = buildWorkerHealth(data);
  $("#workerHealthMode").textContent = `${health.modeLabel} · ${health.healthScore}%`;
  $("#workerHealthMode").className = `worker-mode mode-${escapeHtml(health.mode)}`;
  $("#workerHealthGrid").innerHTML = [
    ["健康度", `${health.healthScore}%`, "排程程序準備度"],
    ["最近心跳", health.heartbeatAge, health.heartbeatAt ? formatDate(health.heartbeatAt) : "尚無執行紀錄"],
    ["工作租約", health.leaseStatus, health.leaseExpiresAt ? `${health.leaseTtlSeconds} 秒有效期 · ${health.leaseOwner}` : "目前無持有者"],
    ["下次循環", health.nextRunHint, "依獲利引擎設定"],
    ["佇列壓力", health.queuePressure, `${health.queuedPosts} 則排隊 · ${health.scheduledAutonomyPosts} 則自主排程`],
    ["自動化執行", operatingStatusLabel(health.latestAutomationStatus), "最近一次佇列處理結果"],
    ["上線準備", operatingStatusLabel(health.readinessMode), `${health.readinessBlocked} 個阻擋項目`]
  ].map(([label, value, hint]) => `
    <article class="worker-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");
  $("#workerHealthNotes").innerHTML = health.notes.map((note) => `
    <p>${escapeHtml(note)}</p>
  `).join("");
}

function buildExperimentLoopFallback(data) {
  const engine = data.profitEngine || {};
  const models = engine.models || [];
  const posts = data.posts || [];
  const linksById = new Map((data.affiliateLinks || []).map((link) => [link.id, link]));
  const runs = engine.runs || [];
  const signals = engine.externalSignals || [];
  const totalScore = models.reduce((total, model) => total + Number(model.score || 0), 0) || 1;
  const experiments = models.map((model, index) => {
    const modelPosts = posts.filter((post) => post.funnelRatio === model.id);
    const linkIds = new Set(modelPosts.map((post) => post.affiliateLinkId).filter(Boolean));
    const modelLinks = [...linkIds].map((id) => linksById.get(id)).filter(Boolean);
    const clicks = modelLinks.reduce((total, link) => total + Number(link.clicks || 0), 0);
    const conversions = modelLinks.reduce((total, link) => total + Number(link.conversions || 0), 0);
    const revenue = modelLinks.reduce((total, link) => total + Number(link.revenue || 0), 0);
    const blockedScriptCount = runs
      .filter((run) => run.selectedModelId === model.id)
      .reduce((total, run) => total + Number(run.blockedScriptCount || 0), 0);
    const status = blockedScriptCount > 0 && modelPosts.length === 0
      ? "blocked"
      : conversions > 0 && Number(model.score || 0) >= 82
        ? "scaling"
        : modelPosts.length > 0
          ? "learning"
          : index === 0
            ? "ready"
            : "watching";
    return {
      modelId: model.id,
      name: model.name,
      recommendation: model.recommendation,
      status,
      score: Number(model.score || 0),
      allocationPct: Math.max(index === 0 ? 25 : 8, Math.round((Number(model.score || 0) / totalScore) * 100)),
      hypothesis: model.adAngle,
      stage: model.stage,
      postCount: modelPosts.length,
      scheduledCount: modelPosts.filter((post) => ["draft", "needs_review", "approved", "scheduled", "container_created"].includes(post.status)).length,
      clicks,
      conversions,
      revenue,
      conversionRate: clicks ? Number(((conversions / clicks) * 100).toFixed(1)) : 0,
      epc: clicks ? Number((revenue / clicks).toFixed(2)) : 0,
      blockedScriptCount,
      nextAction: conversions > 0 ? "Scale adjacent hooks" : modelPosts.length > 0 ? "Collect publish data" : "Seed first scripts"
    };
  });
  const optimizationQueue = [
    !signals.length ? {
      priority: "high",
      modelId: "market_signals",
      title: "Connect market evidence",
      action: "Add ad or affiliate offer feeds so experiments optimize from real demand."
    } : null,
    ...experiments.map((experiment) => {
      if (experiment.blockedScriptCount > 0) {
        return {
          priority: "high",
          modelId: experiment.modelId,
          title: "Repair blocked scripts",
          action: "Regenerate safer scripts before the next publish cycle."
        };
      }
      if (experiment.postCount === 0) {
        return {
          priority: experiment.recommendation === "primary" ? "high" : "medium",
          modelId: experiment.modelId,
          title: "Seed first experiment",
          action: "Create natural scripts so this model can collect traffic evidence."
        };
      }
      return {
        priority: experiment.conversions > 0 ? "medium" : "low",
        modelId: experiment.modelId,
        title: experiment.conversions > 0 ? "Scale winning angle" : "Wait for publish data",
        action: experiment.nextAction
      };
    })
  ].filter(Boolean).slice(0, 6);
  const leader = experiments[0] || {};
  const totalExperimentPosts = experiments.reduce((total, item) => total + Number(item.postCount || 0), 0);
  const totalExperimentRevenue = experiments.reduce((total, item) => total + Number(item.revenue || 0), 0);
  const confidence = leader.conversions > 0
    ? "revenue-backed"
    : leader.clicks > 0
      ? "traffic-backed"
      : engine.lastRunAt
        ? "model-backed"
        : "setup";
  return {
    loopState: engine.autonomyEnabled ? "autonomous" : "manual",
    confidence,
    activeExperimentCount: experiments.filter((item) => ["ready", "learning", "scaling"].includes(item.status)).length,
    totalExperimentPosts,
    totalExperimentRevenue,
    leaderModelId: leader.modelId || "",
    leaderName: leader.name || "No experiment selected",
    learningVelocity: `${runs.length} run(s) · ${signals.length} signal(s)`,
    experiments,
    optimizationQueue
  };
}

function buildOptimizerDecisionFallback(loop) {
  const action = (loop.optimizationQueue || []).find((item) => item.modelId !== "market_signals")
    || (loop.optimizationQueue || [])[0]
    || null;
  const modeMap = {
    "Scale winning angle": "scale",
    "Rewrite offer bridge": "bridge_rewrite",
    "Repair blocked scripts": "repair_guardrails",
    "Seed first experiment": "explore"
  };
  return {
    mode: modeMap[action?.title] || "baseline",
    targetModelId: action?.modelId || loop.leaderModelId || "",
    targetAction: action?.title || "Continue leader",
    scriptCountDelta: action?.title === "Scale winning angle" ? 1 : action?.title === "Repair blocked scripts" ? -1 : 0,
    guardrailMode: action?.title === "Repair blocked scripts" ? "strict" : "standard",
    marketSignalGap: (loop.learningVelocity || "").includes("0 signal"),
    reasons: [
      action?.action || "No urgent optimizer action is pending.",
      (loop.learningVelocity || "").includes("0 signal") ? "No external market signal is connected yet." : ""
    ].filter(Boolean)
  };
}

function renderExperimentLoop(data) {
  const loop = data.profitEngine?.experiments?.experiments?.length
    ? data.profitEngine.experiments
    : buildExperimentLoopFallback(data);
  const experiments = loop.experiments || [];
  const queue = loop.optimizationQueue || [];
  const optimizer = data.profitEngine?.optimizer?.latestPolicy || buildOptimizerDecisionFallback(loop);
  $("#experimentMode").textContent = `${operatingStatusLabel(loop.loopState || "manual")} · ${operatingStatusLabel(loop.confidence || "setup")}`;
  $("#experimentMode").className = `experiment-mode confidence-${escapeHtml(loop.confidence || "setup")}`;
  $("#experimentSummary").innerHTML = [
    ["領先模型", loop.leaderName || "尚無實驗", loop.leaderModelId || "尚未選擇"],
    ["進行中", loop.activeExperimentCount || 0, "執行中的模型"],
    ["貼文", loop.totalExperimentPosts || 0, "實驗內容"],
    ["收益", formatMoney(loop.totalExperimentRevenue || 0), "已歸因連結"],
    ["學習速度", loop.learningVelocity || "0 次執行", "學習輸入"]
  ].map(([label, value, hint]) => `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");

  $("#optimizerDecision").innerHTML = `
    <article class="optimizer-card">
      <span>優化模式</span>
      <strong>${escapeHtml(optimizer.mode || "baseline")}</strong>
      <p>${escapeHtml(optimizer.targetAction || "維持領先模型")}</p>
    </article>
    <article class="optimizer-card">
      <span>目標模型</span>
      <strong>${escapeHtml(optimizer.targetModelId || "領先模型")}</strong>
      <p>${escapeHtml(`文案 ${Number(optimizer.scriptCountDelta || 0) >= 0 ? "+" : ""}${Number(optimizer.scriptCountDelta || 0)} · ${optimizer.guardrailMode || "standard"} 安全規則`)}</p>
    </article>
    <article class="optimizer-card wide">
      <span>決策理由</span>
      <div class="optimizer-reasons">
        ${(optimizer.reasons || ["尚無優化決策理由。"]).map((reason) => `<p>${escapeHtml(reason)}</p>`).join("")}
      </div>
    </article>
  `;

  $("#experimentCards").innerHTML = experiments.map((experiment) => `
    <article class="experiment-card status-${escapeHtml(experiment.status)}" data-profit-experiment="${escapeHtml(experiment.modelId)}">
      <div class="experiment-card-head">
        <span>${escapeHtml(operatingStatusLabel(experiment.status))}</span>
        <strong>${escapeHtml(experiment.name)}</strong>
      </div>
      <div class="experiment-score">
        <b style="width:${Math.max(4, Math.min(Number(experiment.allocationPct || 0), 100))}%"></b>
      </div>
      <p>${escapeHtml(experiment.hypothesis || experiment.stage)}</p>
      <div class="experiment-metrics">
        <span>分數 <b>${Number(experiment.score || 0)}</b></span>
        <span>配比 <b>${Number(experiment.allocationPct || 0)}%</b></span>
        <span>貼文 <b>${Number(experiment.postCount || 0)}</b></span>
        <span>轉換率 <b>${Number(experiment.conversionRate || 0)}%</b></span>
        <span>單次點擊收益 <b>${formatMoney(experiment.epc || 0)}</b></span>
      </div>
      <small>${escapeHtml(experiment.nextAction || "Monitor")}</small>
    </article>
  `).join("") || `<div class="empty-state">尚無實驗資料</div>`;

  $("#optimizationQueue").innerHTML = `
    <strong>優化佇列</strong>
    ${queue.map((item) => `
      <article class="optimization-item priority-${escapeHtml(item.priority)}">
        <span>${escapeHtml(operatingStatusLabel(item.priority))}</span>
        <div>
          <strong>${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(item.action)}</p>
          <small>${escapeHtml(item.modelId)}</small>
        </div>
      </article>
    `).join("") || `<div class="empty-state">目前沒有待處理的優化項目</div>`}
  `;
}

function renderProfitEngine(data) {
  const engine = data.profitEngine || {};
  const sideConnectors = data.readiness?.connectorCenter?.connectors || engine.sources || [];
  $("#sideConnectorCount").textContent = sideConnectors.length;
  $("#sideConnectorList").innerHTML = sideConnectors.map((source) => `
    <div class="side-connector">
      <span class="status-${escapeHtml(source.status || source.runtimeStatus)} ${["ready", "connected"].includes(source.status || source.runtimeStatus) ? "is-on" : ""}"></span>
      <div>
        <strong>${escapeHtml(source.name)}</strong>
        <small>${escapeHtml(operatingStatusLabel(source.status || source.runtimeStatus || "setup"))}</small>
      </div>
    </div>
  `).join("");

  const offer = engine.offerAutopilot || {};
  const recovery = engine.sourceRecovery || {};
  $("#autopilotSummary").innerHTML = [
    ["資料來源", (engine.sourceStatuses || []).length, "API / Feed 檢查"],
    ["市場訊號", (engine.externalSignals || []).length, "廣告與優惠輸入"],
    ["來源復原", operatingStatusLabel(recovery.mode || "setup"), recovery.nextRetryAt ? `下次重試 ${formatDate(recovery.nextRetryAt)}` : `${recovery.errors || 0} 個錯誤`],
    ["有效優惠", offer.activeSyncedProductCount || 0, `每次最多 ${offer.maxOffersPerRun || 0} 筆`],
    ["等待處理", engine.scheduledAutonomyPosts || 0, "自主排程貼文"],
    ["安全阻擋", (engine.blockedScripts || []).length, "規則阻擋次數"]
  ].map(([label, value, hint]) => `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");

  const scanner = engine.opportunityScanner || {};
  $("#opportunityScanner").innerHTML = `
    <div class="opportunity-head">
      <div>
        <span>自主機會掃描</span>
        <strong>${escapeHtml(scanner.nextAction || "執行獲利引擎")}</strong>
      </div>
      <small>最高分 ${Number(scanner.topScore || 0)} · ${escapeHtml(operatingStatusLabel(scanner.confidence || "setup"))}信心 · ${Number(scanner.opportunityCount || 0)} 個候選</small>
    </div>
    <div class="opportunity-list">
      ${(scanner.opportunities || []).map((item) => `
        <article class="opportunity-card priority-${escapeHtml(item.priority)}">
          <header>
            <span>#${Number(item.rank || 0)}</span>
            <b>${escapeHtml(operatingStatusLabel(item.priority))}</b>
          </header>
          <div class="opportunity-main">
            <strong>${escapeHtml(item.modelName)}</strong>
            <p>${escapeHtml(item.expectedImpact)}</p>
          </div>
          <dl>
            <div><dt>分數</dt><dd>${Number(item.score || 0)}</dd></div>
            <div><dt>優惠</dt><dd>${escapeHtml(item.offerName || "-")}</dd></div>
            <div><dt>訊號</dt><dd>${escapeHtml(item.signalSource || "-")}</dd></div>
            <div><dt>動作</dt><dd>${escapeHtml(item.automationAction || "-")}</dd></div>
          </dl>
          <footer>
            <span>${escapeHtml(operatingStatusLabel(item.guardrailState || "ready"))}</span>
            <small>${(item.evidence || []).slice(0, 3).map((line) => escapeHtml(line)).join(" · ")}</small>
          </footer>
        </article>
      `).join("") || `<div class="empty-state">尚無自主獲利機會</div>`}
    </div>
  `;

  $("#connectorList").innerHTML = (engine.sources || []).map((source) => `
    <article class="connector-item">
      <span>${escapeHtml(operatingStatusLabel(source.runtimeStatus || source.status))}</span>
      <strong>${escapeHtml(source.name)}</strong>
      <p>${escapeHtml(source.nextRetryAt ? `${source.message || source.role} Next retry ${formatDate(source.nextRetryAt)}.` : source.message || source.role)}</p>
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
        ${escapeHtml(operatingStatusLabel(source.status))}
      </span>
      <div>
        <strong>${escapeHtml(source.name || source.id)}</strong>
        <p>${escapeHtml(source.nextRetryAt ? `${source.message || ""} Next retry ${formatDate(source.nextRetryAt)}.` : source.message || "")}</p>
      </div>
      <small>${Number(source.count || 0).toLocaleString()}${source.failureCount ? ` · ${Number(source.failureCount)} 次失敗` : ""}</small>
    </article>
  `).join("") || `<div class="empty-state">尚無即時資料來源檢查</div>`;

  $("#profitSignals").innerHTML = (engine.externalSignals || []).map((signal) => `
    <article class="signal-row">
      <span>${escapeHtml(signal.kind || "signal")}</span>
      <div>
        <strong>${escapeHtml(signal.title || signal.productName || signal.source)}</strong>
        <p>${escapeHtml(signal.angle || signal.offer || "")}</p>
        ${signal.adSnapshotUrl ? `<a href="${escapeHtml(signal.adSnapshotUrl)}" target="_blank" rel="noreferrer">查看快照</a>` : ""}
      </div>
    </article>
  `).join("") || `<div class="empty-state">尚無外部廣告或優惠訊號</div>`;

  $("#profitGuardrails").innerHTML = (engine.guardrails || []).map((item) => `
    <span>${escapeHtml(item)}</span>
  `).join("");

  $("#profitBlockedScripts").innerHTML = (engine.blockedScripts || []).length ? `
    <strong>被阻擋文案</strong>
    ${(engine.blockedScripts || []).map((script) => `
      <article class="blocked-script-row">
        <span class="badge bad">已阻擋</span>
        <div>
          <strong>${escapeHtml(script.hook || script.type || "文案")}</strong>
          <p>${escapeHtml(script.reason || "安全規則阻擋此文案。")}</p>
          ${script.freshness ? `<small>相符貼文 ${escapeHtml(script.freshness.matchedPostId)} · ${Math.round(Number(script.freshness.score || 0) * 100)}%</small>` : ""}
        </div>
      </article>
    `).join("")}
  ` : "";
}

function renderFactoryMetrics(data) {
  const metrics = data.metrics;
  const rows = [
    ["待審核", metrics.needsReview ?? metrics.drafts],
    ["已核准", metrics.approved || 0],
    ["待發佈", metrics.queued],
    ["已拒絕", metrics.rejected || 0],
    ["已發佈/模擬", metrics.published + metrics.simulated]
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
  const rows = data.posts
    .slice()
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    .slice(0, 8)
    .map((post) => {
    const link = linkById(data, post.affiliateLinkId);
    const reviewStatus = reviewStatusOf(post);
    const validation = post.validation || post.validationResult || {};
    const riskLevel = post.riskLevel || post.review?.riskLevel || validation.risk?.level || "unknown";
    const disclosureStatus = post.disclosureStatus || post.review?.disclosureStatus || "unknown";
    const fatigue = fatigueSummary(post);
    const warning = firstClaimWarning(post);
    const fatigueBlocked = fatigue.status === "blocked";
    const terminalHint = terminalPostHint(post);
    const approveBlockReason = terminalHint || approvalBlockReason(post, validation, riskLevel, warning, fatigue);
    const rejectBlockReason = ["rejected", "published", "simulated", "failed"].includes(post.status)
      ? "此貼文目前狀態不可拒絕。"
      : "";
    const scheduleBlockReason = post.status === "approved" && post.approved && !fatigueBlocked
      ? ""
      : fatigueBlocked
        ? fatigue.lines[0] || "內容疲勞規則阻擋排程，請先改寫。"
        : "請先完成審核核准。";
    const publishBlockReason = post.status === "scheduled" && !fatigueBlocked
      ? ""
      : fatigueBlocked
        ? fatigue.lines[0] || "內容疲勞規則阻擋發佈，請先改寫。"
        : "請先完成審核並排程。";
    const visibleBlockReason = isReviewable(post) ? approveBlockReason : terminalHint;
    return `
      <tr>
        <td>
          <p class="post-copy">${escapeHtml(post.hook || post.text)}</p>
          <div class="post-meta">
            <span>${escapeHtml(post.contentType || "手動")}</span>
            <span>${escapeHtml(validation.threadsUnits || 0)} 字元單位</span>
            ${riskBadge(riskLevel)}
            ${disclosureBadge(disclosureStatus)}
            ${fatigueBadge(fatigue.status)}
            ${postSourceBadge(post)}
          </div>
          ${warning ? `<p class="claim-warning">${escapeHtml(warning)}</p>` : ""}
          ${fatigue.lines.length ? `
            <div class="fatigue-detail">
              ${fatigue.lines.slice(0, 3).map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
            </div>
          ` : ""}
          <details class="post-review-editor">
            <summary>編輯後重新檢查</summary>
            <textarea data-edit-text="${escapeHtml(post.id)}" rows="4">${escapeHtml(post.text || "")}</textarea>
            <button class="button secondary" data-action="save" data-id="${escapeHtml(post.id)}" type="button">儲存修改</button>
          </details>
        </td>
        <td>
          ${statusBadge(post.status)}
          <small class="review-status">審核：${escapeHtml(reviewStatusLabel(reviewStatus))}</small>
        </td>
        <td>${escapeHtml(post.topicTag || "-")}</td>
        <td>${escapeHtml(link ? link.slug : "-")}</td>
        <td>${escapeHtml(formatDate(post.scheduledAt))}</td>
        <td>
          <div class="row-actions">
            <button class="button secondary" type="button" data-action="approve" data-id="${post.id}" ${blockedActionAttributes(approveBlockReason)}>審核</button>
            <button class="button secondary" type="button" data-action="reject" data-id="${post.id}" ${blockedActionAttributes(rejectBlockReason)}>拒絕</button>
            <button class="button secondary" type="button" data-action="schedule" data-id="${post.id}" ${blockedActionAttributes(scheduleBlockReason)}>排程</button>
            <button class="button" type="button" data-action="publish" data-id="${post.id}" ${blockedActionAttributes(publishBlockReason)}>發佈</button>
          </div>
          ${visibleBlockReason ? `<small class="action-block-reason">${escapeHtml(visibleBlockReason)}</small>` : ""}
        </td>
      </tr>
    `;
    }).join("");
  $("#postRows").innerHTML = rows || `<tr><td colspan="6"><div class="empty-state">目前沒有貼文</div></td></tr>`;
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
  const revenue = formatRevenueTotals(data.metrics.revenueByCurrency);
  const attribution = data.attribution || {};
  const attributionSummary = attribution.summary || {};
  const conversionRate = clicks ? ((conversions / clicks) * 100).toFixed(1) : "0.0";

  $("#revenueCards").innerHTML = [
    ["追蹤點擊", clicks.toLocaleString()],
    ["已記錄轉換", conversions.toLocaleString()],
    ["成交率", `${conversionRate}%`],
    ["已記錄佣金", revenue]
  ].map(([label, value]) => `
    <article class="revenue-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `).join("");

  $("#revenueFunnel").innerHTML = [
    ["追蹤點擊", clicks],
    ["已記錄轉換", conversions],
    ["成交率", `${conversionRate}%`],
    ["已記錄佣金", revenue]
  ].map(([label, value]) => `
    <div class="funnel-step"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
  `).join("");

  $("#attributionGrid").innerHTML = `
    <article class="attribution-card">
      <span>歸因收益</span>
      <strong>${formatRevenueTotals(attributionSummary.attributedRevenueByCurrency)}</strong>
      <small>${Number(attributionSummary.attributedConversions || 0)} 次轉換，${Number(attributionSummary.attributedClicks || 0)} 次點擊</small>
    </article>
    <article class="attribution-card">
      <span>最佳模型</span>
      <strong>${escapeHtml(attribution.topModels?.[0]?.modelId || "學習中")}</strong>
      <small>${formatRevenueTotals(attribution.topModels?.[0]?.revenueByCurrency)} · ${Number(attribution.topModels?.[0]?.conversions || 0)} 次轉換</small>
    </article>
    <article class="attribution-list">
      <strong>最佳歸因文案</strong>
      ${(attribution.topPosts || []).map((post) => `
        <div>
          <span>${escapeHtml(post.hook || post.postId)}</span>
          <small>${escapeHtml(post.modelId || "手動")} · ${Number(post.clicks || 0)} 次點擊 · ${formatRevenueTotals(post.revenueByCurrency)}</small>
        </div>
      `).join("") || `<p>尚無貼文層級歸因資料</p>`}
    </article>
  `;

  const monetizableLinks = data.affiliateLinks.filter((link) => link.monetizable);
  $("#linkList").innerHTML = monetizableLinks.map((link) => `
    <div class="link-row">
      <strong>${escapeHtml(link.slug)}</strong>
      <span>${Number(link.clicks || 0).toLocaleString()}</span>
      <span>${Number(link.conversions || 0).toLocaleString()}</span>
      <span>${formatMoney(link.revenue, link.currency)}</span>
    </div>
  `).join("") || `<div class="empty-state">尚未建立真實聯盟追蹤連結</div>`;

  $("#conversionEvents").innerHTML = `
    <strong>最近轉換</strong>
    ${(data.conversionEvents || []).map((event) => {
      const link = linkById(data, event.affiliateLinkId);
      return `
        <article class="conversion-row">
          <span class="badge ${event.status === "approved" || event.status === "paid" ? "good" : "warn"}">${escapeHtml(reviewStatusLabel(event.status))}</span>
          <div>
            <strong>${escapeHtml(link ? link.slug : event.affiliateLinkId)}</strong>
            <p>${escapeHtml(event.networkEventId || event.id)} · ${formatDate(event.occurredAt)} · ${escapeHtml(event.postId || event.modelId || "未歸因")}</p>
          </div>
          <small>${formatMoney(event.commissionValue, event.currency)}</small>
        </article>
      `;
    }).join("") || `<div class="empty-state">尚無轉換 Webhook 事件</div>`}
  `;
}

function renderCampaigns(data) {
  $("#campaignList").innerHTML = data.campaigns.map((campaign) => {
    const products = data.products.filter((product) => product.campaignId === campaign.id);
    const posts = data.posts.filter((post) => post.campaignId === campaign.id);
    const productIds = new Set(products.map((product) => product.id));
    const verifiedLinks = data.affiliateLinks.filter((link) => productIds.has(link.productId) && link.monetizable);
    return `
      <article class="campaign-item">
        <header>
          <strong>${escapeHtml(campaign.name)}</strong>
          <span class="badge ${verifiedLinks.length ? "good" : "warn"}">${verifiedLinks.length ? "收益已連接" : "示範／未連接"}</span>
        </header>
        <div class="mini-metrics">
          <span>${escapeHtml(campaign.targetPersona)}</span>
          <span>${products.length} 個產品</span>
          <span>${posts.length} 則貼文</span>
          <span>${verifiedLinks.length} 個真實追蹤連結</span>
        </div>
      </article>
    `;
  }).join("");
}

function populateForm(data) {
  const campaignSelect = $("#campaignSelect");
  const productSelect = $("#productSelect");
  const monetizableProductIds = new Set(data.affiliateLinks
    .filter((link) => link.monetizable)
    .map((link) => link.productId));
  const eligibleProducts = data.products.filter((product) => monetizableProductIds.has(product.id));
  const eligibleCampaignIds = new Set(eligibleProducts.map((product) => product.campaignId));
  const eligibleCampaigns = data.campaigns.filter((campaign) => eligibleCampaignIds.has(campaign.id));
  const selectedCampaign = campaignSelect.value || eligibleCampaigns[0]?.id;
  campaignSelect.innerHTML = eligibleCampaigns.map((campaign) => (
    `<option value="${campaign.id}" ${campaign.id === selectedCampaign ? "selected" : ""}>${escapeHtml(campaign.name)}</option>`
  )).join("") || `<option value="">請先建立真實聯盟優惠</option>`;

  const products = eligibleProducts.filter((product) => product.campaignId === campaignSelect.value);
  productSelect.innerHTML = products.map((product) => (
    `<option value="${product.id}">${escapeHtml(product.name)}</option>`
  )).join("") || `<option value="">沒有可發佈的產品</option>`;
  const canCreateContent = eligibleCampaigns.length > 0 && eligibleProducts.length > 0;
  const composeButton = $("#composeForm button[type='submit']");
  if (composeButton) composeButton.disabled = !canCreateContent;

  if (!$("#scheduledAt").value) {
    const date = new Date(Date.now() + 30 * 60 * 1000);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    $("#scheduledAt").value = local;
  }
}

function render(data) {
  state.dashboard = data;
  renderRuntime(data);
  renderWorkflowSummary(data);
  renderOperatingMap(data);
  renderGrowthLoop(data);
  renderAutonomyPipeline(data);
  renderReadiness(data);
  renderOpsTimeline(data);
  renderNextActions(data);
  renderDecisionBrief(data);
  renderWorkerHealth(data);
  renderExperimentLoop(data);
  renderProfitEngine(data);
  renderFactoryMetrics(data);
  renderPosts(data);
  renderRisk(data);
  renderRevenue(data);
  renderCampaigns(data);
  populateForm(data);
  renderContentWorkflow(data);
}

async function refresh() {
  const auth = await refreshAdminSession();
  if (auth.authRequired && !auth.authenticated) return;
  render(await api("/api/dashboard"));
}

async function runQueue() {
  const result = await api("/api/automation/run", {
    method: "POST",
    body: { source: "dashboard" }
  });
  render(result.dashboard);
  showToast(`發佈佇列完成：${reviewStatusLabel(result.run.status)}`);
}

function sourceContextMessage(context, completedMessage) {
  if (context?.status === "ready") {
    const source = context.title || context.sourceDomain || "聯盟商品頁";
    return context.researchMode === "openai_web_search"
      ? `${completedMessage}，AI 已用 ${Number(context.sourceCount || 0)} 個來源查證「${source}」`
      : `${completedMessage}，AI 已讀取「${source}」`;
  }
  if (context?.status === "unavailable") {
    return `${completedMessage}；商品頁無法讀取，已使用資料表中的優惠內容`;
  }
  if (["ai_unavailable", "ai_disabled"].includes(context?.status)) {
    return `${completedMessage}；目前使用文案範本，設定 OpenAI 後才會讀取商品頁`;
  }
  return completedMessage;
}

async function generateDrafts() {
  const topic = $("#topicInput").value.trim() || "AI 自動化聯盟行銷";
  const product = (state.dashboard?.products || []).find((item) => item.id === $("#workflowProductSelect").value);
  if (!product) throw new Error("請先選擇真實聯盟商品。");
  const result = await api("/api/automation/generate", {
    method: "POST",
    body: {
      topic,
      autoApprove: false,
      campaignId: product.campaignId,
      productId: product.id
    }
  });
  await refresh();
  showToast(sourceContextMessage(result.sourceContext, "已產生 5 則待審核草稿"));
}

async function runProfitEngine() {
  const result = await api("/api/profit-engine/run", {
    method: "POST",
    body: {
      source: "dashboard",
      force: true,
      createPosts: true,
      autoApprove: false
    }
  });
  render(result.dashboard);
  const created = result.result.createdPosts?.length || 0;
  showToast(sourceContextMessage(result.sourceContext, `自主獲利引擎完成，建立 ${created} 則待審核文案`));
}

async function runAutonomyCycle() {
  const result = await api("/api/autonomy/cycle", {
    method: "POST",
    body: {
      source: "dashboard_cycle",
      force: true,
      createPosts: true,
      autoApprove: false,
      publishQueue: true
    }
  });
  render(result.dashboard);
  const cycle = result.cycle || {};
  showToast(sourceContextMessage(result.sourceContext, `自主循環完成：${Number(cycle.createdPostCount || 0)} 則文案，處理 ${Number(cycle.processed || 0)} 則佇列`));
}

async function handlePostAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  if (button.dataset.blockedReason) {
    showToast(button.dataset.blockedReason);
    return;
  }
  const busyLabels = {
    approve: "核准中",
    reject: "拒絕中",
    schedule: "排程中",
    save: "儲存中",
    publish: "發佈中"
  };
  setButtonBusy(button, true, busyLabels[action] || "處理中");
  try {
    if (action === "approve") {
      await api(`/api/posts/${id}/approve`, { method: "POST", body: {} });
      await refresh();
      showToast("貼文已核准");
    }
    if (action === "reject") {
      await api(`/api/posts/${id}/reject`, { method: "POST", body: { reason: "由管理介面審核佇列拒絕。" } });
      await refresh();
      showToast("貼文已拒絕");
    }
    if (action === "schedule") {
      await api(`/api/posts/${id}/schedule`, { method: "POST", body: {} });
      await refresh();
      showToast("貼文已排程");
    }
    if (action === "save") {
      const row = button.closest("tr");
      const textarea = row ? row.querySelector("textarea[data-edit-text]") : null;
      await api(`/api/posts/${id}`, {
        method: "PATCH",
        body: { text: textarea ? textarea.value : "" }
      });
      await refresh();
      showToast("修改已儲存並送回審核");
    }
    if (action === "publish") {
      const result = await api(`/api/posts/${id}/publish-now`, { method: "POST", body: {} });
      render(result.dashboard);
      showToast(`發佈流程：${reviewStatusLabel(result.run.status)}`);
    }
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
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
  showToast("貼文已建立");
}

async function submitOffer(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const button = $("#offerSaveBtn");
  setButtonBusy(button, true, "建立中");
  try {
    const result = await api("/api/offers", {
      method: "POST",
      body: {
        campaignName: form.get("campaignName"),
        targetPersona: form.get("targetPersona"),
        productName: form.get("productName"),
        network: form.get("network"),
        commissionModel: form.get("commissionModel"),
        commissionValue: Number(form.get("commissionValue") || 0),
        currency: form.get("currency"),
        subIdParam: form.get("subIdParam"),
        targetUrl: form.get("targetUrl"),
        offer: form.get("offer"),
        slug: form.get("slug"),
        appendUtm: form.get("appendUtm") === "on"
      }
    });
    formElement.reset();
    await refresh();
    showToast(`已建立 ${result.product.name} 的聯盟追蹤連結`);
  } finally {
    setButtonBusy(button, false);
  }
}

function offerImportStatus(status) {
  const statuses = {
    ready_create: { label: "可新增", badge: "good" },
    ready_update: { label: "可更新", badge: "warn" },
    create: { label: "已新增", badge: "good" },
    update: { label: "已更新", badge: "good" },
    error: { label: "錯誤", badge: "bad" }
  };
  return statuses[status] || { label: status || "未知", badge: "warn" };
}

function renderOfferImportResult(result) {
  const summary = result?.summary || {};
  const summaryNode = $("#offerImportSummary");
  const tableWrap = $("#offerImportTableWrap");
  summaryNode.hidden = false;
  tableWrap.hidden = false;
  summaryNode.classList.toggle("has-errors", Number(summary.failed || 0) > 0);
  summaryNode.innerHTML = `
    <strong>${result.dryRun ? "預覽完成" : "匯入完成"}</strong>
    <span>共 ${Number(summary.total || 0)} 列</span>
    <span>${result.dryRun ? "有效" : "已匯入"} ${Number(result.dryRun ? summary.valid : (summary.imported || 0))} 列</span>
    <span>錯誤 ${Number(summary.failed || 0)} 列</span>
  `;
  $("#offerImportRows").innerHTML = (result.rows || []).map((row) => {
    const status = offerImportStatus(row.status);
    const detail = row.error || row.slug || row.trackingUrl || "";
    return `
      <tr class="status-${escapeHtml(row.status)}">
        <td>${Number(row.rowNumber || 0)}</td>
        <td>
          <strong>${escapeHtml(row.productName || "未命名產品")}</strong>
          <small>${escapeHtml(row.campaignName || "")}</small>
        </td>
        <td>${escapeHtml(row.network || "-")}</td>
        <td>
          <span class="badge ${status.badge}">${status.label}</span>
          <small>${escapeHtml(detail)}</small>
        </td>
      </tr>
    `;
  }).join("");
}

function renderOfferImportError(message) {
  const summaryNode = $("#offerImportSummary");
  summaryNode.hidden = false;
  summaryNode.classList.add("has-errors");
  summaryNode.innerHTML = `<strong>無法讀取檔案</strong><span>${escapeHtml(message)}</span>`;
  $("#offerImportTableWrap").hidden = true;
}

function resetOfferImportSelection(file) {
  state.offerImport = {
    fileName: file?.name || "",
    format: file?.name?.toLowerCase().endsWith(".json") ? "json" : "csv",
    content: "",
    preview: null,
    canImport: false
  };
  $("#offerImportFileMeta").textContent = file
    ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB`
    : "尚未選擇檔案";
  $("#offerImportPreviewBtn").disabled = !file;
  $("#offerImportConfirmBtn").disabled = true;
  $("#offerImportSummary").hidden = true;
  $("#offerImportTableWrap").hidden = true;
}

async function readOfferImportFile() {
  const file = $("#offerImportFile").files?.[0];
  if (!file) throw new Error("請先選擇 CSV 或 JSON 檔案。");
  if (file.size > OFFER_IMPORT_MAX_BYTES) throw new Error("匯入檔案不可超過 256 KB。");
  const content = await file.text();
  state.offerImport.fileName = file.name;
  state.offerImport.format = file.name.toLowerCase().endsWith(".json") ? "json" : "csv";
  state.offerImport.content = content;
  return {
    fileName: state.offerImport.fileName,
    format: state.offerImport.format,
    content
  };
}

async function previewOfferImport() {
  const payload = await readOfferImportFile();
  const result = await api("/api/offers/import/preview", {
    method: "POST",
    body: payload
  });
  state.offerImport.preview = result;
  state.offerImport.canImport = Number(result.summary?.valid || 0) > 0;
  $("#offerImportConfirmBtn").disabled = !state.offerImport.canImport;
  renderOfferImportResult(result);
}

async function confirmOfferImport() {
  if (!state.offerImport.canImport || !state.offerImport.content) {
    throw new Error("請先完成預覽驗證。");
  }
  const result = await api("/api/offers/import", {
    method: "POST",
    body: {
      fileName: state.offerImport.fileName,
      format: state.offerImport.format,
      content: state.offerImport.content
    }
  });
  state.offerImport.preview = result;
  state.offerImport.canImport = false;
  renderOfferImportResult(result);
  await refresh();
  showToast(`已匯入 ${Number(result.summary?.imported || 0)} 個聯盟優惠`);
}

async function handleNextAction(event) {
  const button = event.target.closest("button[data-next-action]");
  if (!button) return;
  const action = state.nextActions?.[Number(button.dataset.nextAction)];
  if (!action) return;
  if (!action.request) {
    showToast(action.actionLabel);
    return;
  }
  button.disabled = true;
  const result = await api(action.request.path, {
    method: action.request.method || "POST",
    body: action.request.body || {}
  });
  if (result.dashboard) render(result.dashboard);
  else await refresh();
  showToast(`${action.title}已完成`);
}

async function handleGrowthMission(event) {
  const button = event.target.closest("button[data-growth-mission]");
  if (!button) return;
  const mission = state.growthMissions?.[Number(button.dataset.growthMission)];
  if (!mission?.request) return;
  button.disabled = true;
  const result = await api("/api/growth-loop/run", {
    method: "POST",
    body: {
      source: "dashboard_growth",
      missionId: mission.id,
      force: true
    }
  });
  if (result.dashboard) render(result.dashboard);
  else await refresh();
  showToast(`${mission.title}已完成`);
}

function bindEvents() {
  const bindAsyncButton = (selector, action, busyLabel) => {
    const button = $(selector);
    button?.addEventListener("click", () => {
      runButtonAction(button, action, busyLabel)
        .catch((error) => showToast(error.message))
        .finally(() => {
          if (state.dashboard) renderContentWorkflow(state.dashboard);
        });
    });
  };

  arrangeDashboardSections();
  setupWorkspaceModes();
  setupNavigation();
  bindAsyncButton("#refreshBtn", refresh, "更新中");
  bindAsyncButton("#runBtn", runQueue, "發佈中");
  bindAsyncButton("#profitRunBtn", runProfitEngine, "研究中");
  bindAsyncButton("#cycleRunBtn", runAutonomyCycle, "執行中");
  bindAsyncButton("#generateBtn", generateDrafts, "產生中");
  $("#postRows").addEventListener("click", (event) => {
    handlePostAction(event).catch((error) => {
      showToast(error.message);
      refresh();
    });
  });
  $("#composeForm").addEventListener("submit", (event) => {
    submitCompose(event).catch((error) => showToast(error.message));
  });
  $("#offerForm").addEventListener("submit", (event) => {
    submitOffer(event).catch((error) => showToast(error.message));
  });
  $("#offerImportFile").addEventListener("change", (event) => {
    resetOfferImportSelection(event.currentTarget.files?.[0]);
  });
  const offerImportPreviewBtn = $("#offerImportPreviewBtn");
  offerImportPreviewBtn.addEventListener("click", () => {
    runButtonAction(offerImportPreviewBtn, previewOfferImport, "驗證中").catch((error) => {
      state.offerImport.canImport = false;
      $("#offerImportConfirmBtn").disabled = true;
      renderOfferImportError(error.message);
      showToast(error.message);
    });
  });
  const offerImportConfirmBtn = $("#offerImportConfirmBtn");
  offerImportConfirmBtn.addEventListener("click", () => {
    runButtonAction(offerImportConfirmBtn, confirmOfferImport, "匯入中")
      .catch((error) => {
        renderOfferImportError(error.message);
        showToast(error.message);
      })
      .finally(() => {
        offerImportConfirmBtn.disabled = !state.offerImport.canImport;
      });
  });
  const adminLoginForm = $("#adminLoginForm");
  if (adminLoginForm) {
    adminLoginForm.addEventListener("submit", (event) => {
      adminLogin(event).catch((error) => {
        setAuthGateVisible(true, error.message || "管理員登入失敗。");
      });
    });
  }
  const adminLogoutBtn = $("#adminLogoutBtn");
  if (adminLogoutBtn) {
    adminLogoutBtn.addEventListener("click", () => {
      adminLogout().catch((error) => {
        showToast(error.message);
      });
    });
  }
  $("#nextActionList").addEventListener("click", (event) => {
    handleNextAction(event).catch((error) => {
      showToast(error.message);
      refresh();
    });
  });
  $("#growthLoopMissions").addEventListener("click", (event) => {
    handleGrowthMission(event).catch((error) => {
      showToast(error.message);
      refresh();
    });
  });
  $("#campaignSelect").addEventListener("change", () => populateForm(state.dashboard));
  $("#workflowProductSelect").addEventListener("change", (event) => {
    state.workflow.selectedProductId = event.currentTarget.value;
    if (state.dashboard) renderContentWorkflow(state.dashboard);
  });
  $("#topicInput").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || $("#generateBtn").disabled) return;
    event.preventDefault();
    $("#generateBtn").click();
  });
}

bindEvents();
refreshAdminSession().then(() => refresh()).catch((error) => showToast(error.message));

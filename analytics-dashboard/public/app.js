const numberFmt = new Intl.NumberFormat("en-US");
const timeFmt = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short"
});
const manualBuilderState = {
  busy: false,
  enabled: false,
  result: null
};

function formatNumber(value) {
  return numberFmt.format(Number(value || 0));
}

function formatTime(value) {
  if (!value) return "n/a";
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? "n/a" : timeFmt.format(new Date(timestamp));
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function countsLine(counts) {
  return `${formatNumber(counts.posts)} posts · ${formatNumber(counts.comments)} comments · ${formatNumber(counts.replies)} replies · ${formatNumber(counts.upvotes)} upvotes · ${formatNumber(counts.follows)} follows`;
}

function badgeClass(ok) {
  return ok ? "" : "warn";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function agentNameMarkup(agent) {
  const name = escapeHtml(agent.displayName);
  if (!agent.profileUrl) {
    return `<div class="agent-name">${name}</div>`;
  }
  return `<div class="agent-name"><a href="${escapeHtml(agent.profileUrl)}" target="_blank" rel="noreferrer">${name}</a></div>`;
}

function card(label, value, detail = "") {
  return `
    <article class="card">
      <div class="card-label">${label}</div>
      <div class="card-value">${value}</div>
      <div class="card-detail">${detail}</div>
    </article>
  `;
}

function messageWindowLine(windowStats) {
  return `${formatNumber(windowStats.totalChunks)} chunks · ${formatNumber(windowStats.totalUsageUnits)} usage units`;
}

function renderEngagementCards(summary) {
  const root = document.getElementById("engagement-cards");
  root.innerHTML = [
    card("Last 2 hours", formatNumber(summary.windows.last2Hours.total), countsLine(summary.windows.last2Hours)),
    card("Last day", formatNumber(summary.windows.lastDay.total), countsLine(summary.windows.lastDay)),
    card("Last week", formatNumber(summary.windows.lastWeek.total), countsLine(summary.windows.lastWeek)),
    card("All time", formatNumber(summary.total.total), countsLine(summary.total))
  ].join("");
}

function renderAgents(agents) {
  const root = document.getElementById("agents-table");
  if (!agents.length) {
    root.innerHTML = `<tr><td colspan="9" class="subtle">No agent runtime folders discovered.</td></tr>`;
    return;
  }

  root.innerHTML = agents
    .map((agent) => {
      const summary = agent.engagementSummary;
      const schedulerFresh = agent.schedulerHealth === "fresh";
      const lastRunOk = agent.latestStatus === "ok";
      return `
        <tr>
          <td>
            ${agentNameMarkup(agent)}
            <div class="agent-id">${agent.agentId}</div>
          </td>
          <td><span class="badge ${badgeClass(schedulerFresh)}">${agent.schedulerHealth || "unknown"}</span></td>
          <td><span class="badge ${badgeClass(lastRunOk)}">${agent.latestStatus || "unknown"}</span></td>
          <td>${formatNumber(summary.windows.last2Hours.total)}</td>
          <td>${formatNumber(summary.windows.lastDay.total)}</td>
          <td>${formatNumber(summary.windows.lastWeek.total)}</td>
          <td>${formatNumber(summary.total.total)}</td>
          <td>${formatNumber(agent.pendingWrites)}</td>
          <td>${formatTime(agent.lastSuccessfulHeartbeatAt)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderCoti(coti) {
  const windowCards = document.getElementById("coti-window-cards");
  const cards = document.getElementById("coti-cards");
  const routes = document.getElementById("route-list");

  if (coti.error || !coti.stats) {
    windowCards.innerHTML = "";
    cards.innerHTML = card("COTI stats", "Unavailable", coti.error || "No data");
    routes.innerHTML = "";
    return;
  }

  const stats = coti.stats;
  windowCards.innerHTML = [
    card("Last 2 hours", formatNumber(stats.windows.last2Hours.messages), messageWindowLine(stats.windows.last2Hours)),
    card("Last day", formatNumber(stats.windows.lastDay.messages), messageWindowLine(stats.windows.lastDay)),
    card("Last week", formatNumber(stats.windows.lastWeek.messages), messageWindowLine(stats.windows.lastWeek)),
    card("All time", formatNumber(stats.windows.allTime.messages), messageWindowLine(stats.windows.allTime))
  ].join("");
  cards.innerHTML = [
    card("Messages", formatNumber(stats.totals.messages), `${formatNumber(stats.totals.uniqueAgents)} active addresses`),
    card("Senders", formatNumber(stats.totals.uniqueSenders), `${formatNumber(stats.averages.messagesPerSender)} avg messages`),
    card("Recipients", formatNumber(stats.totals.uniqueRecipients), `${formatNumber(stats.averages.messagesPerRecipient)} avg messages`),
    card("Chunks", formatNumber(stats.totals.totalChunks), `${formatNumber(stats.averages.chunksPerMessage)} per message`),
    card("Usage units", formatNumber(stats.totals.totalUsageUnits), `${formatNumber(stats.averages.usageUnitsPerMessage)} per message`)
  ].join("");

  routes.innerHTML = (stats.topRoutes || [])
    .slice(0, 5)
    .map(
      (route) => `
      <div class="route">
        <span>${route.from} → ${route.to}</span>
        <strong>${formatNumber(route.messages)}</strong>
      </div>
    `
    )
    .join("");
}

function buildTrackedCtaUrl(baseUrl, ref) {
  if (!baseUrl) {
    return undefined;
  }
  try {
    const url = new URL(baseUrl);
    if (ref.utm?.source) url.searchParams.set("utm_source", ref.utm.source);
    if (ref.utm?.medium) url.searchParams.set("utm_medium", ref.utm.medium);
    if (ref.utm?.campaign) url.searchParams.set("utm_campaign", ref.utm.campaign);
    if (ref.utm?.content) url.searchParams.set("utm_content", ref.utm.content);
    url.searchParams.set("ref", ref.refId);
    return url.toString();
  } catch {
    return undefined;
  }
}

function attributionLink(label, href) {
  if (!href) {
    return `<span class="subtle">${escapeHtml(label)}</span>`;
  }
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function promptChip(label, value) {
  if (!value) {
    return "";
  }
  return `<span class="prompt-chip"><span class="subtle">${escapeHtml(label)}</span> ${escapeHtml(value)}</span>`;
}

function promptSummaryMarkup(ref) {
  const chips = [
    promptChip("profile", ref.promptProfileId),
    promptChip("style", ref.messageStyle),
    promptChip("layout", ref.layout),
    promptChip("cta", ref.ctaStyle),
    promptChip("promo", ref.promotionLevel),
    promptChip("product", ref.productSpecificity),
    promptChip("reward", ref.rewardEmphasis),
    promptChip("audience", ref.audience)
  ]
    .filter(Boolean)
    .join("");
  return chips || '<span class="subtle">No prompt params</span>';
}

function setBuilderStatus(message, isWarn = false) {
  const status = document.getElementById("cta-builder-status");
  status.textContent = message;
  status.classList.toggle("warn", Boolean(isWarn));
}

function setBuilderFormDisabled(disabled) {
  const elements = document.querySelectorAll("#cta-builder-form input, #cta-builder-form select, #cta-builder-form button");
  elements.forEach((element) => {
    element.disabled = disabled;
  });
}

function renderBuilderResult() {
  const panel = document.getElementById("cta-builder-result");
  const refInput = document.getElementById("cta-builder-ref");
  const urlInput = document.getElementById("cta-builder-url");
  if (!manualBuilderState.result) {
    panel.hidden = true;
    refInput.value = "";
    urlInput.value = "";
    return;
  }

  refInput.value = manualBuilderState.result.ref || "";
  urlInput.value = manualBuilderState.result.trackedUrl || "";
  panel.hidden = false;
}

function renderManualBuilder(config = {}) {
  const note = document.getElementById("cta-builder-note");
  manualBuilderState.enabled = Boolean(config.manualRefBuilderEnabled && config.trackingBaseUrl);
  if (!manualBuilderState.enabled) {
    note.textContent = "Builder needs both STARTER_GRANT_SERVICE_URL and OUTREACH_TRACKING_BASE_URL.";
    setBuilderStatus("Builder unavailable", true);
    setBuilderFormDisabled(true);
    renderBuilderResult();
    return;
  }

  note.textContent = `Links use ${config.trackingBaseUrl}. Landing-page visits log click events automatically.`;
  setBuilderStatus(manualBuilderState.busy ? "Creating link..." : "Ready");
  setBuilderFormDisabled(manualBuilderState.busy);
  renderBuilderResult();
}

async function copyBuilderValue(targetId) {
  const input = document.getElementById(targetId);
  if (!input?.value) {
    return;
  }
  await navigator.clipboard.writeText(input.value);
  setBuilderStatus(targetId === "cta-builder-url" ? "Link copied" : "Ref copied");
}

async function submitManualBuilder(event) {
  event.preventDefault();
  if (!manualBuilderState.enabled || manualBuilderState.busy) {
    return;
  }

  const form = document.getElementById("cta-builder-form");
  const formData = new FormData(form);
  const payload = Object.fromEntries(
    Array.from(formData.entries()).filter(([, value]) => String(value ?? "").trim().length > 0)
  );

  manualBuilderState.busy = true;
  renderManualBuilder(window.__dashboardConfig || {});

  try {
    const response = await fetch("/api/attribution/ref", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || `Builder request failed (${response.status})`);
    }
    manualBuilderState.result = body;
    setBuilderStatus("Link ready");
    await refresh();
  } catch (error) {
    setBuilderStatus(error.message || "Failed to create tracked link.", true);
  } finally {
    manualBuilderState.busy = false;
    renderManualBuilder(window.__dashboardConfig || {});
  }
}

function bindManualBuilder() {
  document.getElementById("cta-builder-form").addEventListener("submit", (event) => {
    submitManualBuilder(event).catch((error) => {
      setBuilderStatus(error.message || "Failed to create tracked link.", true);
    });
  });
  document.querySelectorAll("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", () => {
      copyBuilderValue(button.dataset.copyTarget).catch((error) => {
        setBuilderStatus(error.message || "Copy failed.", true);
      });
    });
  });
}

function renderAttribution(attribution, config = {}) {
  const subtitle = document.getElementById("attribution-subtitle");
  const cards = document.getElementById("attribution-cards");
  const groups = document.getElementById("attribution-groups");
  const refs = document.getElementById("attribution-refs");

  if (!attribution?.configured) {
    subtitle.textContent = "Set OUTREACH_ATTRIBUTION_DB_PATH to show shared attribution data.";
    cards.innerHTML = card("Attribution", "Not configured", "No shared DB path");
    groups.innerHTML = `<tr><td colspan="7" class="subtle">No attribution database configured.</td></tr>`;
    refs.innerHTML = `<tr><td colspan="5" class="subtle">No ref drilldown available.</td></tr>`;
    return;
  }

  if (attribution.error) {
    subtitle.textContent = attribution.error;
  } else {
    subtitle.textContent = `Read-only shared DB snapshot from ${formatTime(attribution.generatedAt)}.`;
  }

  const totals = attribution.totals || {};
  cards.innerHTML = [
    card("Refs", formatNumber(totals.refs), `${formatNumber(totals.unresolvedEvents)} unresolved events`),
    card("Clicks", formatNumber(totals.clicks), `${formatPercent(attribution.conversionRates?.clickToGrantChallenge)} click→grant`),
    card("Private messages", formatNumber(totals.privateMessagesReceived), `${formatPercent(attribution.conversionRates?.clickToPrivateMessage)} click→PM`),
    card("Grant successes", formatNumber(totals.grantClaimsSucceeded), `${formatNumber(totals.grantClaimsQueued)} queued`),
    card("Skill usage", formatNumber(totals.skillUsages), `${formatPercent(attribution.conversionRates?.refToSkillUsage)} ref→skill`)
  ].join("");

  if (!attribution.groups?.length) {
    groups.innerHTML = `<tr><td colspan="7" class="subtle">No attributed refs found yet.</td></tr>`;
  } else {
    groups.innerHTML = attribution.groups
      .map((group) => `
        <tr>
          <td>
            <div class="agent-name">${escapeHtml(group.messageStyle)} · ${escapeHtml(group.layout)}</div>
            <div class="agent-id">${escapeHtml(group.venue)} / ${escapeHtml(group.campaignId)} / ${escapeHtml(group.promptProfileId)}</div>
            <div class="card-detail">CTA ${escapeHtml(group.ctaStyle || "n/a")} · promo ${escapeHtml(group.promotionLevel || "n/a")} · reward ${escapeHtml(group.rewardEmphasis || "n/a")}</div>
          </td>
          <td>${formatNumber(group.refCount)}</td>
          <td>${formatNumber(group.totals.clicks)}</td>
          <td>${formatNumber(group.totals.privateMessagesReceived)}</td>
          <td>${formatNumber(group.totals.grantClaimsSucceeded)} / ${formatNumber(group.totals.grantClaimsQueued)}</td>
          <td>${formatNumber(group.totals.skillUsages)}</td>
          <td>
            <div>${formatPercent(group.conversionRates.clickToSkillUsage)} click→skill</div>
            <div class="subtle">${formatPercent(group.conversionRates.refToSkillUsage)} ref→skill</div>
          </td>
        </tr>
      `)
      .join("");
  }

  if (!attribution.topRefs?.length) {
    refs.innerHTML = `<tr><td colspan="5" class="subtle">No refs found yet.</td></tr>`;
    return;
  }

  refs.innerHTML = attribution.topRefs
    .map((ref) => {
      const promptParams = JSON.stringify(ref.promptParameters || {}, null, 2);
      const ctaUrl = buildTrackedCtaUrl(config.trackingBaseUrl, ref);
      const contentUrl = ref.remoteContentUrl;
      const utm = Object.entries(ref.utm || {})
        .map(([key, value]) => `${escapeHtml(key)}=${escapeHtml(value)}`)
        .join("<br>");
      return `
        <tr>
          <td>
            <div class="agent-name">${escapeHtml(ref.refId)}</div>
            <div class="agent-id">${escapeHtml(ref.venue)} / ${escapeHtml(ref.surface || "n/a")}</div>
            <div class="card-detail">${escapeHtml(ref.contentType)} · remote ${escapeHtml(ref.remoteContentId || "n/a")}</div>
            <div class="card-detail">generated ${escapeHtml(ref.generatedContentId)}</div>
            <div class="inline-links">
              ${attributionLink(ref.contentType === "post" ? "View post" : "View thread", contentUrl)}
            </div>
          </td>
          <td>
            <div class="prompt-chips">${promptSummaryMarkup(ref)}</div>
            <details>
              <summary>Full prompt params</summary>
              <pre class="prompt-json">${escapeHtml(promptParams)}</pre>
            </details>
          </td>
          <td>
            ${utm || '<span class="subtle">n/a</span>'}
            <div class="inline-links">${attributionLink("Open CTA", ctaUrl)}</div>
          </td>
          <td>
            <div>${formatNumber(ref.totals.clicks)} clicks · ${formatNumber(ref.totals.privateMessagesReceived)} PMs</div>
            <div>${formatNumber(ref.totals.grantClaimsSucceeded)} grants · ${formatNumber(ref.totals.skillUsages)} skills</div>
          </td>
          <td>${formatTime(ref.lastEventAt)}</td>
        </tr>
      `;
    })
    .join("");
}

async function refresh() {
  const response = await fetch("/api/summary");
  const payload = await response.json();
  window.__dashboardConfig = payload.config || {};
  document.getElementById("last-refresh").textContent = `Updated ${formatTime(payload.generatedAt)}`;
  renderEngagementCards(payload.aggregateEngagements);
  renderAgents(payload.agents);
  renderCoti(payload.coti);
  renderAttribution(payload.attribution, payload.config);
  renderManualBuilder(payload.config);
}

bindManualBuilder();

refresh().catch((error) => {
  document.getElementById("last-refresh").textContent = `Error: ${error.message}`;
});

setInterval(() => {
  refresh().catch((error) => {
    document.getElementById("last-refresh").textContent = `Error: ${error.message}`;
  });
}, 30_000);

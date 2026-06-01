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

function agentIdMarkup(agent) {
  const agentId = escapeHtml(agent.agentId);
  if (!agent.profileUrl) {
    return `<div class="agent-id">${agentId}</div>`;
  }
  return `<div class="agent-id"><a href="${escapeHtml(agent.profileUrl)}" target="_blank" rel="noreferrer" class="agent-id-link">${agentId}</a></div>`;
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

const expandedAgentIds = new Set();

function runStatusClass(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "ok") {
    return "";
  }
  if (normalized === "failed" || normalized === "degraded") {
    return "warn";
  }
  return "warn";
}

function renderRunCounts(counts, scope = "lifetime") {
  const prefix = scope === "lifetime" ? "Lifetime: " : "This run: ";
  return `${prefix}${formatNumber(counts.posts)} posts · ${formatNumber(counts.comments)} comments · ${formatNumber(counts.replies)} replies`;
}

function formatRunIdDisplay(run) {
  if (!run.runId) {
    return "";
  }
  return String(run.runId).replace(/^(heartbeat|executor):/, "");
}

function renderRunDetailList(items, emptyLabel) {
  if (!items.length) {
    return `<div class="run-detail-line subtle">${emptyLabel}</div>`;
  }
  return items
    .map((item) => `<div class="run-detail-line">${escapeHtml(item)}</div>`)
    .join("");
}

function renderRunErrors(errors) {
  if (!errors.length) {
    return `<div class="run-detail-line subtle">No errors recorded.</div>`;
  }
  return errors
    .map((error) => {
      const phase = error.phase ? `${error.phase}: ` : "";
      return `<div class="run-detail-line run-detail-error">${escapeHtml(`${phase}${error.message}`)}</div>`;
    })
    .join("");
}

function renderAgentRunsPanel(agent) {
  const runs = Array.isArray(agent.recentRuns) ? agent.recentRuns : [];
  if (!runs.length) {
    return `<div class="agent-runs-panel subtle">No run history yet. Heartbeat reports will appear after the next successful run.</div>`;
  }

  return `
    <div class="agent-runs-panel">
      <div class="agent-runs-heading">Last ${runs.length} run${runs.length === 1 ? "" : "s"}</div>
      <div class="agent-runs-list">
        ${runs
          .map((run) => {
            const dryRunLabel = run.dryRun ? " · dry-run" : "";
            const runIdLine = formatRunIdDisplay(run);
            const countsScope = run.countsScope === "run" ? "run" : "lifetime";
            return `
              <article class="agent-run-card">
                <div class="agent-run-card-head">
                  <div class="agent-run-main">
                    <div class="agent-run-title">
                      <span class="badge ${badgeClass(run.status === "ok")} ${runStatusClass(run.status)}">${escapeHtml(run.status)}</span>
                      <span class="agent-run-time">${formatTime(run.finishedAt ?? run.startedAt)}</span>
                    </div>
                    ${runIdLine ? `<div class="agent-run-id subtle">${escapeHtml(runIdLine)}${escapeHtml(dryRunLabel)}</div>` : ""}
                    <div class="agent-run-summary">${escapeHtml(run.summary || "No summary recorded.")}</div>
                    ${
                      run.activityThisRun
                        ? `<div class="agent-run-activity subtle">${escapeHtml(run.activityThisRun)}</div>`
                        : ""
                    }
                  </div>
                  <div class="agent-run-metrics">
                    <div>${renderRunCounts(run.runCounts, countsScope)}</div>
                    <div class="subtle">${formatNumber(run.errorCount)} errors · ${formatNumber(run.skipCount)} skipped · ${formatNumber(run.queuedActionJobs ?? 0)} queued</div>
                  </div>
                </div>
                ${
                  run.performed.length
                    ? `<div class="run-detail-block"><div class="run-detail-label">Performed</div>${renderRunDetailList(run.performed, "No performed actions recorded.")}</div>`
                    : ""
                }
                ${
                  run.skipped.length
                    ? `<div class="run-detail-block"><div class="run-detail-label">Skipped</div>${renderRunDetailList(run.skipped.slice(0, 10), "No skipped actions recorded.")}${run.skipped.length > 10 ? `<div class="run-detail-line subtle">+${run.skipped.length - 10} more</div>` : ""}</div>`
                    : ""
                }
                ${
                  run.errors.length
                    ? `<div class="run-detail-block"><div class="run-detail-label">Errors</div>${renderRunErrors(run.errors)}</div>`
                    : ""
                }
                ${
                  run.ingestionSummary
                    ? `<div class="run-detail-block"><div class="run-detail-label">Ingestion</div><div class="run-detail-line">${escapeHtml(run.ingestionSummary)}</div></div>`
                    : ""
                }
              </article>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function toggleAgentRuns(agentId) {
  if (expandedAgentIds.has(agentId)) {
    expandedAgentIds.delete(agentId);
  } else {
    expandedAgentIds.add(agentId);
  }
  const detailRow = document.querySelector(`tr.agent-runs-row[data-agent-id="${agentId}"]`);
  const mainRow = document.querySelector(`tr.agent-row[data-agent-id="${agentId}"]`);
  if (!detailRow || !mainRow) {
    return;
  }
  const expanded = expandedAgentIds.has(agentId);
  detailRow.hidden = !expanded;
  mainRow.classList.toggle("expanded", expanded);
  mainRow.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function bindAgentRowHandlers() {
  document.querySelectorAll("tr.agent-row[data-agent-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("a")) {
        return;
      }
      toggleAgentRuns(row.dataset.agentId);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleAgentRuns(row.dataset.agentId);
      }
    });
  });
}

function renderAgents(agents) {
  const root = document.getElementById("agents-table");
  if (!agents.length) {
    root.innerHTML = `<tr><td colspan="9" class="subtle">No agent runtime folders discovered.</td></tr>`;
    return;
  }

  const knownIds = new Set(agents.map((agent) => agent.agentId));
  for (const agentId of [...expandedAgentIds]) {
    if (!knownIds.has(agentId)) {
      expandedAgentIds.delete(agentId);
    }
  }

  root.innerHTML = agents
    .flatMap((agent) => {
      const summary = agent.engagementSummary;
      const schedulerFresh = agent.schedulerHealth === "fresh";
      const lastRunOk = agent.latestStatus === "ok";
      const expanded = expandedAgentIds.has(agent.agentId);
      return [
        `
        <tr class="agent-row ${expanded ? "expanded" : ""}" data-agent-id="${escapeHtml(agent.agentId)}" tabindex="0" role="button" aria-expanded="${expanded ? "true" : "false"}">
          <td>
            <div class="agent-row-label">
              <span class="agent-expand-indicator" aria-hidden="true">${expanded ? "▼" : "▶"}</span>
              <div>
                ${agentNameMarkup(agent)}
                ${agentIdMarkup(agent)}
              </div>
            </div>
          </td>
          <td><span class="badge ${badgeClass(schedulerFresh)}">${agent.schedulerHealth || "unknown"}</span></td>
          <td><span class="badge ${badgeClass(lastRunOk)}">${agent.latestStatus || "unknown"}</span></td>
          <td>${formatNumber(summary.windows.last2Hours.total)}</td>
          <td>${formatNumber(summary.windows.lastDay.total)}</td>
          <td>${formatNumber(summary.windows.lastWeek.total)}</td>
          <td>${formatNumber(summary.total.total)}</td>
          <td>${formatNumber(agent.pendingWrites)}</td>
          <td>${formatTime(agent.lastSuccessfulHeartbeatAt ?? agent.lastHeartbeatAt)}</td>
        </tr>
        `,
        `
        <tr class="agent-runs-row" data-agent-id="${escapeHtml(agent.agentId)}" ${expanded ? "" : "hidden"}>
          <td colspan="9">${renderAgentRunsPanel(agent)}</td>
        </tr>
        `
      ];
    })
    .join("");

  bindAgentRowHandlers();
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

function collectRecentPublished(agents) {
  const rows = [];
  for (const agent of agents || []) {
    for (const item of agent.recentPublished || []) {
      rows.push({
        ...item,
        agentId: agent.agentId,
        displayName: agent.displayName,
        profileUrl: agent.profileUrl
      });
    }
  }
  return rows.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function enrichRecentPublishedUrls(rows, attribution) {
  if (!attribution?.configured) {
    return rows;
  }
  const refsById = new Map();
  for (const ref of [...(attribution.recentRefs || []), ...(attribution.topRefs || [])]) {
    if (ref?.refId) {
      refsById.set(ref.refId, ref);
    }
  }
  return rows.map((row) => {
    if (!row.refId || row.contentUrl) {
      return row;
    }
    const ref = refsById.get(row.refId);
    if (!ref?.remoteContentUrl) {
      return row;
    }
    return { ...row, contentUrl: ref.remoteContentUrl };
  });
}

function contentSnippetMarkup(item) {
  const preview = escapeHtml(item.contentPreview || "");
  const target = item.targetSummary
    ? `<div class="content-meta">target ${escapeHtml(item.targetSummary)}</div>`
    : "";
  const variant = item.promptVariantId
    ? `<div class="content-meta">variant ${escapeHtml(item.promptVariantId)}</div>`
    : "";
  return `
    <div>${preview}</div>
    ${target}
    ${variant}
  `;
}

function promptBucketSummary(prompt) {
  const buckets = Array.isArray(prompt.buckets) ? prompt.buckets : [];
  if (!buckets.length) {
    return '<span class="subtle">No scoped buckets</span>';
  }
  return buckets
    .map((bucket) => {
      const label = bucket.promptVariantLabel || bucket.promptVariantId || "n/a";
      return `<div class="rotation-line"><strong>${escapeHtml(bucket.scopeKey)}</strong><span>${escapeHtml(label)} · ${formatNumber(bucket.actionsSinceRotation)} / ${formatNumber(bucket.rotateAfterActions || 0)}</span></div>`;
    })
    .join("");
}

function promptRecentHistoryMarkup(prompt) {
  const recentHistory = Array.isArray(prompt.recentHistory) ? prompt.recentHistory : [];
  if (!recentHistory.length) {
    return '<span class="subtle">No recent rotation events</span>';
  }
  return recentHistory
    .slice(-6)
    .reverse()
    .map((entry) => {
      const variant = entry.promptVariantLabel || entry.promptVariantId || "n/a";
      const summary = [
        entry.eventType || "event",
        entry.scopeKey || "unknown-scope",
        variant
      ].join(" · ");
      const detail = [
        entry.selectionSource,
        entry.reusedExisting === undefined ? "" : entry.reusedExisting ? "reused" : "rotated",
        entry.actionsSinceRotation === undefined || entry.rotateAfterActions === undefined
          ? ""
          : `${formatNumber(entry.actionsSinceRotation)} / ${formatNumber(entry.rotateAfterActions)}`
      ]
        .filter(Boolean)
        .join(" · ");
      return `
        <div class="rotation-event">
          <div>${escapeHtml(summary)}</div>
          <div class="content-meta">${escapeHtml(detail || "no extra detail")} · ${escapeHtml(formatTime(entry.createdAt))}</div>
        </div>
      `;
    })
    .join("");
}

function collectAgentsWithPrompt(agents) {
  return (agents || []).filter((agent) => agent.currentPrompt);
}

function collectPromptRotationEvents(agents) {
  const rows = [];
  for (const agent of collectAgentsWithPrompt(agents)) {
    for (const entry of agent.currentPrompt.recentHistory || []) {
      rows.push({
        ...entry,
        agentId: agent.agentId,
        displayName: agent.displayName,
        profileUrl: agent.profileUrl
      });
    }
  }
  return rows.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function renderPromptRotation(agents) {
  const subtitle = document.getElementById("prompt-rotation-subtitle");
  const cards = document.getElementById("prompt-rotation-cards");
  const root = document.getElementById("prompt-rotation-agents");
  const agentsWithPrompt = collectAgentsWithPrompt(agents);
  const events = collectPromptRotationEvents(agents);

  if (!agentsWithPrompt.length) {
    subtitle.textContent = "No prompt rotation state discovered.";
    cards.innerHTML = card("Prompt rotation", "Unavailable", "No agents exposed current prompt state");
    root.innerHTML = `<div class="rotation-empty subtle">No rotation state found.</div>`;
    return;
  }

  const bucketCount = agentsWithPrompt.reduce(
    (sum, agent) => sum + ((agent.currentPrompt?.buckets || []).length || 0),
    0
  );
  const scopedAgents = agentsWithPrompt.filter((agent) => agent.currentPrompt?.currentScopeKey).length;
  const llmSelections = events.filter((entry) => entry.selectionSource === "llm").length;
  const publishedEvents = events.filter((entry) => entry.eventType === "published").length;

  subtitle.textContent = `Scoped rotation across ${formatNumber(scopedAgents)} agents, ${formatNumber(bucketCount)} buckets, and ${formatNumber(events.length)} recent visible events.`;
  cards.innerHTML = [
    card("Agents with state", formatNumber(agentsWithPrompt.length), `${formatNumber(scopedAgents)} with active scope`),
    card("Scoped buckets", formatNumber(bucketCount), `${formatNumber(events.length)} recent visible events`),
    card("LLM selections", formatNumber(llmSelections), `${formatNumber(publishedEvents)} published events`),
    card(
      "Latest event",
      events[0]?.eventType ? escapeHtml(events[0].eventType) : "n/a",
      events[0]?.createdAt ? formatTime(events[0].createdAt) : "No recent history"
    ),
    card(
      "Latest scope",
      escapeHtml(events[0]?.scopeKey || agentsWithPrompt[0]?.currentPrompt?.currentScopeKey || "n/a"),
      escapeHtml(events[0]?.promptVariantLabel || events[0]?.promptVariantId || "No recent variant")
    )
  ].join("");

  root.innerHTML = agentsWithPrompt
    .map((agent) => {
      const prompt = agent.currentPrompt;
      const eventList = (prompt.recentHistory || [])
        .slice(-5)
        .reverse()
        .map((entry) => {
          const variant = entry.promptVariantLabel || entry.promptVariantId || "n/a";
          return `
            <div class="rotation-event">
              <div>${escapeHtml(entry.eventType || "event")} · ${escapeHtml(entry.scopeKey || "unknown-scope")} · ${escapeHtml(variant)}</div>
              <div class="content-meta">${escapeHtml(entry.selectionSource || "unknown source")} · ${escapeHtml(entry.status || "no status")} · ${escapeHtml(formatTime(entry.createdAt))}</div>
            </div>
          `;
        })
        .join("");
      const pathList = [prompt.statePath, prompt.auditPath].filter(Boolean);
      return `
        <article class="rotation-agent-card">
          <div class="rotation-agent-header">
            <div>
              ${agentNameMarkup(agent)}
              ${agentIdMarkup(agent)}
            </div>
            <div class="prompt-chips">
              ${promptChip("scope", prompt.currentScopeKey)}
              ${promptChip("source", prompt.lastSelectionSource)}
            </div>
          </div>
          <div class="rotation-agent-grid">
            <div>
              <div class="agent-name">${escapeHtml(prompt.promptVariantLabel || prompt.promptVariantId || "n/a")}</div>
              <div class="content-meta">${escapeHtml(prompt.lastSelectionRationale || "No rationale stored.")}</div>
              <div class="content-meta">window ${formatNumber(prompt.actionsSinceRotation)} / ${formatNumber(prompt.rotateAfterActions || 0)} · last rotation ${escapeHtml(formatTime(prompt.lastRotationAt))}</div>
            </div>
            <div>
              <div class="subtle">Buckets</div>
              <div class="rotation-stack">${promptBucketSummary(prompt)}</div>
            </div>
            <div>
              <div class="subtle">Recent events</div>
              <div class="rotation-stack">${eventList || '<span class="subtle">No recent rotation events</span>'}</div>
            </div>
          </div>
          <details>
            <summary>Paths and full params</summary>
            <div class="rotation-agent-grid rotation-agent-grid-tight">
              <pre class="prompt-json">${escapeHtml(pathList.join("\n") || "No prompt rotation paths stored.")}</pre>
              <pre class="prompt-json">${escapeHtml(JSON.stringify(prompt.promptParameters || {}, null, 2))}</pre>
            </div>
          </details>
        </article>
      `;
    })
    .join("");
}

function renderContent(agents, attribution) {
  const subtitle = document.getElementById("content-subtitle");
  const currentTable = document.getElementById("content-current-table");
  const recentTable = document.getElementById("content-recent-table");
  const agentsWithPrompt = collectAgentsWithPrompt(agents);

  if (!agentsWithPrompt.length) {
    currentTable.innerHTML = `<tr><td colspan="6" class="subtle">No current prompt rotation state found.</td></tr>`;
  } else {
    currentTable.innerHTML = agentsWithPrompt
      .map((agent) => {
        const prompt = agent.currentPrompt;
        const promptJson = JSON.stringify(prompt.promptParameters || {}, null, 2);
        const debugPaths = [
          prompt.statePath ? `state ${prompt.statePath}` : "",
          prompt.auditPath ? `audit ${prompt.auditPath}` : ""
        ]
          .filter(Boolean)
          .join("\n");
        return `
          <tr>
            <td>
              ${agentNameMarkup(agent)}
              ${agentIdMarkup(agent)}
            </td>
            <td>
              <div class="agent-name">${escapeHtml(prompt.promptVariantLabel || prompt.promptVariantId || "n/a")}</div>
              <div class="agent-id">${escapeHtml(prompt.promptProfileId || "no profile")}</div>
              <div class="content-meta">${escapeHtml(prompt.lastSelectionRationale || "No rationale stored.")}</div>
            </td>
            <td>
              <div class="prompt-chips">
                ${promptChip("scope", prompt.currentScopeKey)}
                ${promptChip("source", prompt.lastSelectionSource)}
              </div>
              <div class="content-meta">selected ${escapeHtml(formatTime(prompt.lastSelectedAt))}</div>
              <details>
                <summary>Scoped buckets</summary>
                <div class="rotation-stack">${promptBucketSummary(prompt)}</div>
              </details>
            </td>
            <td>
              <div>${formatNumber(prompt.actionsSinceRotation)} / ${formatNumber(prompt.rotateAfterActions || 0)} actions</div>
              <div class="subtle">last action ${formatTime(prompt.lastActionAt)}</div>
            </td>
            <td>
              <div class="prompt-chips">${promptSummaryMarkup(prompt)}</div>
              <details>
                <summary>Full current params</summary>
                <pre class="prompt-json">${escapeHtml(promptJson)}</pre>
              </details>
            </td>
            <td>
              <div>${formatTime(prompt.lastRotationAt)}</div>
              <div class="content-meta">last selected ${formatTime(prompt.lastSelectedAt)}</div>
              <details>
                <summary>Recent rotation activity</summary>
                <div class="rotation-stack">${promptRecentHistoryMarkup(prompt)}</div>
              </details>
              <details>
                <summary>Paths</summary>
                <pre class="prompt-json">${escapeHtml(debugPaths || "No prompt rotation paths stored.")}</pre>
              </details>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  const recentPublished = enrichRecentPublishedUrls(collectRecentPublished(agents), attribution);
  subtitle.textContent = `Current scoped prompt rotation state plus ${formatNumber(recentPublished.length)} published posts, comments, and replies from agent runtime state.`;
  if (!recentPublished.length) {
    recentTable.innerHTML = `<tr><td colspan="5" class="subtle">No published posts, comments, or replies recorded in agent state yet.</td></tr>`;
    return;
  }

  recentTable.innerHTML = recentPublished
    .map((item) => {
      const promptParams = JSON.stringify(item.promptParameters || {}, null, 2);
      const linkLabel = item.type === "post" ? "Open post" : "Open thread";
      const links = [
        attributionLink(linkLabel, item.contentUrl),
        item.ctaUrl && item.ctaUrl !== item.contentUrl
          ? attributionLink("Open CTA", item.ctaUrl)
          : ""
      ].filter(Boolean);
      return `
        <tr>
          <td>
            <div>${formatTime(item.createdAt)}</div>
            <div class="content-meta">${escapeHtml(item.type)}${item.refId ? ` · ${escapeHtml(item.refId)}` : ""}</div>
          </td>
          <td>
            ${agentNameMarkup(item)}
            <div class="agent-id">${escapeHtml(item.agentId)}</div>
          </td>
          <td>${contentSnippetMarkup(item)}</td>
          <td>
            <div class="prompt-chips">${promptSummaryMarkup(item)}</div>
            <details>
              <summary>Full params</summary>
              <pre class="prompt-json">${escapeHtml(promptParams)}</pre>
            </details>
          </td>
          <td>
            <div class="inline-links">${links.join("") || '<span class="subtle">No links stored</span>'}</div>
          </td>
        </tr>
      `;
    })
    .join("");
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
  const disclosure = document.getElementById("cta-builder-disclosure");
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
  disclosure.open = true;
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
    const response = await fetch("api/attribution/ref", {
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
  const response = await fetch("api/summary");
  const payload = await response.json();
  window.__dashboardConfig = payload.config || {};
  document.getElementById("last-refresh").textContent = `Updated ${formatTime(payload.generatedAt)}`;
  renderEngagementCards(payload.aggregateEngagements);
  renderAgents(payload.agents);
  renderCoti(payload.coti);
  renderAttribution(payload.attribution, payload.config);
  renderContent(payload.agents, payload.attribution);
  renderPromptRotation(payload.agents);
  renderManualBuilder(payload.config);
}

const COLLAPSE_STORAGE_KEY = "outreach-analytics-collapsed";

function initCollapsibleSections() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY) || "{}");
  } catch {
    stored = {};
  }

  document.querySelectorAll("details.collapsible[data-section]").forEach((section) => {
    const sectionId = section.dataset.section;
    if (!sectionId) {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(stored, sectionId)) {
      section.open = !stored[sectionId];
    }
    section.addEventListener("toggle", () => {
      stored[sectionId] = !section.open;
      localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(stored));
    });
  });
}

bindManualBuilder();
initCollapsibleSections();

refresh().catch((error) => {
  document.getElementById("last-refresh").textContent = `Error: ${error.message}`;
});

setInterval(() => {
  refresh().catch((error) => {
    document.getElementById("last-refresh").textContent = `Error: ${error.message}`;
  });
}, 30_000);

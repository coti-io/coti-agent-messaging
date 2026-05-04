const numberFmt = new Intl.NumberFormat("en-US");
const timeFmt = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short"
});

function formatNumber(value) {
  return numberFmt.format(Number(value || 0));
}

function formatTime(value) {
  if (!value) return "n/a";
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? "n/a" : timeFmt.format(new Date(timestamp));
}

function countsLine(counts) {
  return `${formatNumber(counts.posts)} posts · ${formatNumber(counts.comments)} comments · ${formatNumber(counts.replies)} replies`;
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
    root.innerHTML = `<tr><td colspan="8" class="subtle">No agent runtime folders discovered.</td></tr>`;
    return;
  }

  root.innerHTML = agents
    .map((agent) => {
      const summary = agent.engagementSummary;
      const unhealthy = agent.latestStatus && agent.latestStatus !== "ok";
      return `
        <tr>
          <td>
            <div class="agent-name">${agent.displayName}</div>
            <div class="agent-id">${agent.agentId}</div>
          </td>
          <td><span class="badge ${unhealthy ? "warn" : ""}">${agent.latestStatus || "unknown"}</span></td>
          <td>${formatNumber(summary.windows.last2Hours.total)}</td>
          <td>${formatNumber(summary.windows.lastDay.total)}</td>
          <td>${formatNumber(summary.windows.lastWeek.total)}</td>
          <td>${formatNumber(summary.total.total)}</td>
          <td>${formatNumber(agent.pendingWrites)}</td>
          <td>${formatTime(agent.lastHeartbeatAt)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderCoti(coti) {
  const cards = document.getElementById("coti-cards");
  const routes = document.getElementById("route-list");

  if (coti.error || !coti.stats) {
    cards.innerHTML = card("COTI stats", "Unavailable", coti.error || "No data");
    routes.innerHTML = "";
    return;
  }

  const stats = coti.stats;
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

async function refresh() {
  const response = await fetch("/api/summary");
  const payload = await response.json();
  document.getElementById("last-refresh").textContent = `Updated ${formatTime(payload.generatedAt)}`;
  renderEngagementCards(payload.aggregateEngagements);
  renderAgents(payload.agents);
  renderCoti(payload.coti);
}

refresh().catch((error) => {
  document.getElementById("last-refresh").textContent = `Error: ${error.message}`;
});

setInterval(() => {
  refresh().catch((error) => {
    document.getElementById("last-refresh").textContent = `Error: ${error.message}`;
  });
}, 30_000);

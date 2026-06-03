import type { AgentAccountStatus, AgentHeartbeatRun } from "./types";

const KILL_SWITCH_BAN = /Kill switch: a ban was recorded/i;
const KILL_SWITCH_SPAM = /Kill switch: spam accusation/i;
const KILL_SWITCH_MOD = /Kill switch: repeated removals/i;
const ACCOUNT_HEALTH = /Account health check failed \(([^)]+)\):\s*(.+)/i;

const ACCOUNT_STATE_LABELS: Record<AgentAccountStatus["state"], string> = {
  active: "Active",
  banned: "Banned",
  suspended: "Suspended",
  session_invalid: "Session invalid",
  misconfigured: "Misconfigured",
  disabled: "Disabled",
  unknown: "Unknown"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(String).filter(Boolean);
}

function parseSessionLimitLine(line: string): AgentAccountStatus | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  if (KILL_SWITCH_BAN.test(trimmed)) {
    return { state: "banned", label: ACCOUNT_STATE_LABELS.banned, reason: trimmed };
  }
  if (KILL_SWITCH_SPAM.test(trimmed)) {
    return { state: "suspended", label: "Spam flagged", reason: trimmed };
  }
  if (KILL_SWITCH_MOD.test(trimmed)) {
    return { state: "suspended", label: "Mod warnings", reason: trimmed };
  }

  const healthMatch = trimmed.match(ACCOUNT_HEALTH);
  if (healthMatch) {
    const status = healthMatch[1]!.trim().toLowerCase();
    const reason = healthMatch[2]!.trim();
    if (status === "session_invalid") {
      return { state: "session_invalid", label: ACCOUNT_STATE_LABELS.session_invalid, reason };
    }
    if (status === "suspended") {
      return { state: "suspended", label: ACCOUNT_STATE_LABELS.suspended, reason };
    }
    if (status === "misconfigured") {
      return { state: "misconfigured", label: ACCOUNT_STATE_LABELS.misconfigured, reason };
    }
    return { state: "disabled", label: ACCOUNT_STATE_LABELS.disabled, reason: trimmed };
  }

  if (/^Kill switch:/i.test(trimmed) || /^Daily Reddit action cap/i.test(trimmed)) {
    return { state: "disabled", label: ACCOUNT_STATE_LABELS.disabled, reason: trimmed };
  }

  return undefined;
}

function fromAccountHealthRecord(value: unknown): AgentAccountStatus | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const status = asOptionalString(value.status)?.toLowerCase();
  const reason = asOptionalString(value.reason);
  if (!status) {
    return undefined;
  }

  if (status === "active") {
    return { state: "active", label: ACCOUNT_STATE_LABELS.active, reason };
  }
  if (status === "banned") {
    return { state: "banned", label: ACCOUNT_STATE_LABELS.banned, reason };
  }
  if (status === "session_invalid") {
    return { state: "session_invalid", label: ACCOUNT_STATE_LABELS.session_invalid, reason };
  }
  if (status === "suspended") {
    return { state: "suspended", label: ACCOUNT_STATE_LABELS.suspended, reason };
  }
  if (status === "misconfigured") {
    return { state: "misconfigured", label: ACCOUNT_STATE_LABELS.misconfigured, reason };
  }

  return { state: "unknown", label: ACCOUNT_STATE_LABELS.unknown, reason };
}

function collectSessionLimitLines(input: {
  report?: Record<string, unknown>;
  recentRuns?: AgentHeartbeatRun[];
}): string[] {
  const lines: string[] = [];
  const planner = isRecord(input.report?.planner) ? input.report.planner : undefined;
  lines.push(...parseStringArray(planner?.sessionLimits));

  for (const run of input.recentRuns ?? []) {
    for (const line of run.filteringSummary ?? []) {
      if (line.startsWith("Session limit: ")) {
        lines.push(line.slice("Session limit: ".length));
      }
    }
  }

  return lines;
}

function isRedditAgent(input: {
  agentId: string;
  serviceName?: string;
  state?: Record<string, unknown>;
}): boolean {
  if (asOptionalString(input.state?.venue) === "reddit") {
    return true;
  }
  const haystack = `${input.agentId} ${input.serviceName ?? ""}`.toLowerCase();
  return haystack.includes("reddit");
}

export function resolveAgentAccountStatus(input: {
  agentId: string;
  serviceName?: string;
  state?: Record<string, unknown>;
  report?: Record<string, unknown>;
  recentRuns?: AgentHeartbeatRun[];
}): AgentAccountStatus | undefined {
  if (!isRedditAgent(input)) {
    return undefined;
  }

  const fromReportHealth = fromAccountHealthRecord(input.report?.accountHealth);
  if (fromReportHealth && fromReportHealth.state !== "active") {
    return fromReportHealth;
  }

  for (const line of collectSessionLimitLines(input)) {
    const parsed = parseSessionLimitLine(line);
    if (parsed && parsed.state !== "active") {
      return parsed;
    }
  }

  if (fromReportHealth) {
    return fromReportHealth;
  }

  return { state: "active", label: ACCOUNT_STATE_LABELS.active };
}

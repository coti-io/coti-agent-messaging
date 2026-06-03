import type { RedditSessionReport } from "./reddit-types.js";
import type { RedditPlannerSession, RedditPlannerWorkspace } from "./reddit-cycle-strategy.js";

export function requireRedditPlannerSessionReport(session: RedditPlannerSession): RedditSessionReport {
  if (session.workspace.terminalReport) {
    session.report = session.workspace.terminalReport;
  }
  if (!session.report) {
    throw new Error("Reddit planner finished without a session report.");
  }
  return session.report;
}

export function workspace(session: RedditPlannerSession): RedditPlannerWorkspace {
  return session.workspace;
}

export function stopped(ws: RedditPlannerWorkspace): boolean {
  return ws.terminalReport !== undefined;
}

export function setTerminal(ws: RedditPlannerWorkspace, report: import("./reddit-types.js").RedditSessionReport): void {
  ws.terminalReport = report;
}

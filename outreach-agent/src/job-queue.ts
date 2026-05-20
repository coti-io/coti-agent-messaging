import type { ActionJob } from "./action-planning.js";

export interface ActionJobSummary {
  id: string;
  type: string;
  candidateId: string;
  status: ActionJob["status"];
  notBefore: string;
}

export function enqueueActionJobs(
  existingJobs: readonly ActionJob[],
  jobs: readonly ActionJob[]
): ActionJob[] {
  return [...existingJobs, ...jobs];
}

export function removeActionJob(
  existingJobs: readonly ActionJob[],
  jobId: string
): ActionJob[] {
  return existingJobs.filter((job) => job.id !== jobId);
}

export function updateActionJob(
  existingJobs: readonly ActionJob[],
  jobId: string,
  updater: (job: ActionJob) => ActionJob
): ActionJob[] {
  return existingJobs.map((job) => (job.id === jobId ? updater(job) : job));
}

export function summarizeActionJobs(
  jobs: readonly ActionJob[]
): ActionJobSummary[] {
  return jobs.map((job) => ({
    id: job.id,
    type: job.type,
    candidateId: job.candidateId,
    status: job.status,
    notBefore: job.notBefore
  }));
}

export function countPendingWork(input: {
  pendingWrites?: readonly unknown[];
  queuedJobs?: readonly ActionJob[];
}): number {
  return (input.pendingWrites?.length ?? 0) + (input.queuedJobs?.length ?? 0);
}

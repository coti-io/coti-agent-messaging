export function redditJsonJobsLegacyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REDDIT_JSON_JOBS_LEGACY === "1";
}

const ACTIVE_BATCH_JOB_STATUSES = new Set([
  "pending",
  "queued",
  "running",
  "cancel_requested",
]);

const TERMINAL_BATCH_JOB_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export function isActiveBatchJobStatus(status: string): boolean {
  return ACTIVE_BATCH_JOB_STATUSES.has(status);
}

export function isTerminalBatchJobStatus(status: string): boolean {
  return TERMINAL_BATCH_JOB_STATUSES.has(status);
}

export function hasActiveBatchJobs(jobs: { status: string }[]): boolean {
  return jobs.some((job) => isActiveBatchJobStatus(job.status));
}

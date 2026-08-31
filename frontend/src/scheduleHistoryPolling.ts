const ACTIVE_SCHEDULE_RUN_STATUSES = new Set([
  "pending",
  "dispatched",
  "running",
]);

const TERMINAL_SCHEDULE_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);

export function isActiveScheduleRunStatus(status: string): boolean {
  return ACTIVE_SCHEDULE_RUN_STATUSES.has(status);
}

export function isTerminalScheduleRunStatus(status: string): boolean {
  return TERMINAL_SCHEDULE_RUN_STATUSES.has(status);
}

export function hasActiveScheduleRuns(runs: { status: string }[]): boolean {
  return runs.some((run) => isActiveScheduleRunStatus(run.status));
}

export const SCHEDULE_HISTORY_POLL_INTERVAL_MS = 2500;

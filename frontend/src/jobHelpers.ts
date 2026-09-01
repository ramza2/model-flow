import type { Job } from "./api";

export function effectiveTargetColumns(
  job: Pick<Job, "target_column" | "target_columns">,
): string[] {
  if (job.target_columns?.length) return job.target_columns;
  if (job.target_column) return [job.target_column];
  return [];
}

export function formatJobTargets(job: Pick<Job, "target_column" | "target_columns">): string {
  return effectiveTargetColumns(job).join(", ");
}

export function isMultiOutputJob(job: Pick<Job, "target_column" | "target_columns">): boolean {
  return effectiveTargetColumns(job).length > 1;
}

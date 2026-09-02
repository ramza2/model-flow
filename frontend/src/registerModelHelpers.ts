import type { Job } from "./api";

export function defaultModelNameFromJob(job: Pick<Job, "name">): string {
  const normalized = job.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "model";
}

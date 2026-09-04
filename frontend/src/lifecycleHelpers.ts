/** Shared ML lifecycle presentation helpers (Phase 1.5-C). */

export const MODEL_LIFECYCLES = [
  "CANDIDATE",
  "VALIDATING",
  "PENDING_APPROVAL",
  "APPROVED",
  "PRODUCTION",
  "REJECTED",
  "ARCHIVED",
] as const;

export type ModelLifecycle = (typeof MODEL_LIFECYCLES)[number];

export const LIFECYCLE_LABELS: Record<string, string> = {
  CANDIDATE: "Candidate",
  VALIDATING: "Validating",
  PENDING_APPROVAL: "Pending Approval",
  APPROVED: "Approved",
  PRODUCTION: "Production",
  REJECTED: "Rejected",
  ARCHIVED: "Archived",
};

/** Primary promotion path (excludes Rejected / Archived). */
export const PRIMARY_LIFECYCLE_PATH: ModelLifecycle[] = [
  "CANDIDATE",
  "VALIDATING",
  "PENDING_APPROVAL",
  "APPROVED",
  "PRODUCTION",
];

export function lifecycleLabel(value: string | null | undefined): string {
  if (!value) return "Unknown";
  return LIFECYCLE_LABELS[value] || value.replaceAll("_", " ");
}

export type LifecycleStepState = "complete" | "current" | "upcoming" | "rejected" | "inactive";

/**
 * Build stepper steps for the actual lifecycle path.
 * Rejected models stop at Pending Approval → Rejected (never imply Production).
 * Archived is shown as an inactive terminal note outside the primary path.
 */
export function lifecycleStepperStates(
  lifecycle: string,
): { id: string; label: string; state: LifecycleStepState }[] {
  if (lifecycle === "ARCHIVED") {
    return PRIMARY_LIFECYCLE_PATH.map((id) => ({
      id,
      label: lifecycleLabel(id),
      state: "inactive" as const,
    })).concat([{ id: "ARCHIVED", label: "Archived", state: "current" }]);
  }

  if (lifecycle === "REJECTED") {
    const path = ["CANDIDATE", "VALIDATING", "PENDING_APPROVAL", "REJECTED"] as const;
    const currentIndex = path.indexOf("REJECTED");
    return path.map((id, index) => ({
      id,
      label: lifecycleLabel(id),
      state:
        index < currentIndex ? ("complete" as const)
          : index === currentIndex ? ("rejected" as const)
            : ("upcoming" as const),
    }));
  }

  const currentIndex = PRIMARY_LIFECYCLE_PATH.indexOf(lifecycle as ModelLifecycle);
  const activeIndex = currentIndex >= 0 ? currentIndex : 0;
  return PRIMARY_LIFECYCLE_PATH.map((id, index) => ({
    id,
    label: lifecycleLabel(id),
    state:
      index < activeIndex ? ("complete" as const)
        : index === activeIndex ? ("current" as const)
          : ("upcoming" as const),
  }));
}

export type LineageItem = {
  label: string;
  value: string;
  to?: string;
  mono?: boolean;
};

function parseTargetValue(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw !== "string" || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      /* fall through */
    }
  }
  if (trimmed.includes(",")) {
    return trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  }
  return [trimmed];
}

export function parseTargetColumns(metadata: Record<string, unknown> | null | undefined): string[] {
  if (!metadata) return [];
  const fromColumns = parseTargetValue(metadata.target_columns);
  if (fromColumns.length) return fromColumns;
  return parseTargetValue(metadata.target_column);
}

/** Parse targets from MLflow run params (string values). */
export function parseTargetsFromParams(params: Record<string, string> | null | undefined): string[] {
  if (!params) return [];
  return parseTargetValue(params.target_columns || params.target_column || "");
}

export function formatMetricKeyLabel(key: string): string {
  return key.replaceAll("_", " ");
}

export function problemTypeLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  return value.replaceAll("_", " ");
}

export function runDisplayName(run: {
  run_id: string;
  tags?: Record<string, string>;
}): string {
  return run.tags?.["mlflow.runName"] || run.run_id.slice(0, 12);
}

export function suggestModelNameFromRun(run: {
  run_id: string;
  tags?: Record<string, string>;
  params?: Record<string, string>;
}): string {
  const fromTag = run.tags?.["mlflow.runName"];
  const source = fromTag || run.params?.algorithm || "model";
  return source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "model";
}

/** Human-readable prediction summary preferring named target keys. */
export function formatNamedPrediction(prediction: unknown): string {
  if (prediction !== null && typeof prediction === "object" && !Array.isArray(prediction)) {
    const entries = Object.entries(prediction as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, value]) => `${key}: ${typeof value === "number" ? Number(value).toFixed(4) : String(value)}`)
      .join("\n");
  }
  if (Array.isArray(prediction)) {
    return prediction
      .map((item, index) => `item ${index + 1}: ${formatNamedPrediction(item)}`)
      .join("\n\n");
  }
  return String(prediction);
}

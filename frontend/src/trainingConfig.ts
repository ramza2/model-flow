export type HyperparameterSpec = {
  name: string;
  type: "integer" | "number" | "boolean" | "string" | string;
  default: unknown;
  description?: string;
  minimum?: number | null;
  maximum?: number | null;
  nullable?: boolean;
};

export type AlgorithmSpec = {
  id: string;
  display_name: string;
  problem_types: string[];
  default_hyperparameters: Record<string, unknown>;
  supported_hyperparameters: string[];
  hyperparameters: HyperparameterSpec[];
};

export function formatHyperparameters(values: Record<string, unknown>): string {
  return `${JSON.stringify(values, null, 2)}\n`;
}

export function algorithmsForProblemType(
  catalog: AlgorithmSpec[],
  problemType: string,
): AlgorithmSpec[] {
  if (!problemType || problemType === "auto") return catalog;
  return catalog.filter((item) => item.problem_types.includes(problemType));
}

export function defaultAlgorithmId(
  catalog: AlgorithmSpec[],
  problemType: string,
): string {
  const filtered = algorithmsForProblemType(catalog, problemType);
  if (problemType === "regression") {
    return filtered.find((item) => item.id === "ridge")?.id || filtered[0]?.id || "ridge";
  }
  return filtered.find((item) => item.id === "random_forest")?.id || filtered[0]?.id || "random_forest";
}

export function validateHyperparametersText(
  text: string,
  algorithm: AlgorithmSpec | undefined,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: "Hyperparameters must be valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "Hyperparameters must be a JSON object." };
  }
  const value = parsed as Record<string, unknown>;
  if (!algorithm) {
    return { ok: false, message: "Select a supported algorithm." };
  }
  const specs = Object.fromEntries(algorithm.hyperparameters.map((item) => [item.name, item]));
  const unknown = Object.keys(value).filter((key) => !specs[key]);
  if (unknown.length) {
    return {
      ok: false,
      message: `Unsupported hyperparameters for ${algorithm.id}: ${unknown.join(", ")}`,
    };
  }
  for (const [key, raw] of Object.entries(value)) {
    const spec = specs[key];
    if (raw === null) {
      if (!spec.nullable) {
        return { ok: false, message: `Hyperparameter '${key}' cannot be null.` };
      }
      continue;
    }
    if (spec.type === "integer") {
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        return { ok: false, message: `Hyperparameter '${key}' must be an integer.` };
      }
      if (spec.minimum != null && raw < spec.minimum) {
        return { ok: false, message: `Hyperparameter '${key}' must be >= ${spec.minimum}.` };
      }
      if (spec.maximum != null && raw > spec.maximum) {
        return { ok: false, message: `Hyperparameter '${key}' must be <= ${spec.maximum}.` };
      }
    } else if (spec.type === "number") {
      if (typeof raw !== "number") {
        return { ok: false, message: `Hyperparameter '${key}' must be a number.` };
      }
      if (spec.minimum != null && raw < spec.minimum) {
        return { ok: false, message: `Hyperparameter '${key}' must be >= ${spec.minimum}.` };
      }
      if (spec.maximum != null && raw > spec.maximum) {
        return { ok: false, message: `Hyperparameter '${key}' must be <= ${spec.maximum}.` };
      }
    } else if (spec.type === "boolean") {
      if (typeof raw !== "boolean") {
        return { ok: false, message: `Hyperparameter '${key}' must be a boolean.` };
      }
    } else if (typeof raw !== "string") {
      return { ok: false, message: `Hyperparameter '${key}' must be a string.` };
    }
  }
  return { ok: true, value };
}

export function sampleValueForDtype(dtype: string, example?: unknown): unknown {
  if (example !== undefined && example !== null) return example;
  const lower = dtype.toLowerCase();
  if (/(bool|boolean)/.test(lower)) return false;
  if (/(datetime|date|timestamp|timedelta)/.test(lower)) return "2026-01-01T00:00:00";
  if (/(str|string|text|object|category|categorical)/.test(lower)) return "sample";
  if (/(int|int8|int16|int32|int64|long|uint)/.test(lower)) return 0;
  if (/(float|double|decimal|number|numeric)/.test(lower)) return 0.0;
  // Unknown dtype must not be treated as float (avoids all-zero regression).
  return "sample";
}

export function buildPredictionSamplePayload(
  featureSchema: Array<string | Record<string, unknown>>,
  previewRow?: Record<string, unknown> | null,
  dtypes?: Record<string, string> | null,
): Record<string, unknown>[] {
  const instance = Object.fromEntries(
    featureSchema.map((field, index) => {
      if (typeof field === "string") {
        const example = previewRow?.[field];
        const dtype = String(dtypes?.[field] ?? "");
        return [field, sampleValueForDtype(dtype, example)];
      }
      const name = String(field.name || field.field || `feature_${index + 1}`);
      const dtype = String(field.dtype || field.type || dtypes?.[name] || "");
      const example =
        previewRow?.[name]
        ?? field.example
        ?? field.sample
        ?? field.default;
      return [name, sampleValueForDtype(dtype, example)];
    }),
  );
  return [instance];
}

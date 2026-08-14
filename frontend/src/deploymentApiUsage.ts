import { API_BASE, type Endpoint, type ServiceApiKey } from "./api";
import { buildPredictionSamplePayload } from "./trainingConfig";

export type FeatureSchemaField = {
  name: string;
  type: string;
};

export type ExternalPredictRequestBody = {
  instances: Record<string, unknown>[];
};

export type ServiceKeyUiStatus = "Active" | "Revoked" | "Expired";

const CURL_KEY_PLACEHOLDER = "$MODELFLOW_API_KEY";

/** Same-origin absolute URL for external inference (browser origin + /api proxy). */
export function absoluteApiUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (typeof window === "undefined") {
    return `${API_BASE}${normalized}`;
  }
  return `${window.location.origin}${API_BASE}${normalized}`;
}

export function externalPredictPath(endpointId: number): string {
  return `/inference/endpoints/${endpointId}/predict`;
}

export function externalPredictUrl(endpointId: number): string {
  return absoluteApiUrl(externalPredictPath(endpointId));
}

export function buildExternalPredictRequestBody(endpoint: Endpoint): ExternalPredictRequestBody {
  if (endpoint.prediction_sample && Object.keys(endpoint.prediction_sample).length > 0) {
    return { instances: [endpoint.prediction_sample] };
  }
  return { instances: buildPredictionSamplePayload(endpoint.feature_schema || []) };
}

export function formatExternalPredictRequestJson(endpoint: Endpoint, indent = 2): string {
  return JSON.stringify(buildExternalPredictRequestBody(endpoint), null, indent);
}

export function parseFeatureSchemaFields(
  featureSchema: Array<string | Record<string, unknown>>,
): FeatureSchemaField[] {
  return featureSchema.map((field, index) => {
    if (typeof field === "string") {
      return { name: field, type: "string" };
    }
    const name = String(field.name || field.field || `feature_${index + 1}`);
    const rawType = String(field.dtype || field.type || "unknown");
    return { name, type: humanizeSchemaType(rawType) };
  });
}

function humanizeSchemaType(dtype: string): string {
  const lower = dtype.toLowerCase();
  if (/(bool|boolean)/.test(lower)) return "boolean";
  if (/(int|int8|int16|int32|int64|long|uint)/.test(lower)) return "integer";
  if (/(float|double|decimal|number|numeric)/.test(lower)) return "double";
  if (/(str|string|text|object|category|categorical)/.test(lower)) return "string";
  if (/(datetime|date|timestamp)/.test(lower)) return "datetime";
  return dtype || "unknown";
}

/** Escape JSON for single-quoted bash argument (Git Bash / Linux / macOS). */
export function shellQuoteSingle(json: string): string {
  return `'${json.replace(/'/g, "'\\''")}'`;
}

export function buildExternalPredictCurl(endpoint: Endpoint): string {
  const url = externalPredictUrl(endpoint.id);
  const body = formatExternalPredictRequestJson(endpoint, 2);
  const quoted = shellQuoteSingle(body);
  return [
    `curl -X POST "${url}" \\`,
    `  -H "Authorization: Bearer ${CURL_KEY_PLACEHOLDER}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d ${quoted}`,
  ].join("\n");
}

export async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document === "undefined") {
    throw new Error("Clipboard is not available in this environment.");
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!ok) throw new Error("Clipboard copy failed.");
}

export function serviceKeyStatus(key: ServiceApiKey): ServiceKeyUiStatus {
  if (key.revoked_at || !key.is_active) return "Revoked";
  if (key.expires_at) {
    const expires = new Date(key.expires_at);
    if (!Number.isNaN(expires.getTime()) && expires.getTime() <= Date.now()) {
      return "Expired";
    }
  }
  return "Active";
}

export function keysForDeployment(keys: ServiceApiKey[], endpointId: number): ServiceApiKey[] {
  return keys.filter((key) => key.endpoint_id === null || key.endpoint_id === endpointId);
}

export function serviceKeyScopeLabel(key: ServiceApiKey, endpointId: number): string {
  if (key.endpoint_id === endpointId) return "This deployment";
  if (key.endpoint_id === null) return "All deployments in project";
  return "Other deployment";
}

/** Convert datetime-local value to ISO UTC for backend, or null if empty. */
export function datetimeLocalToIsoUtc(value: string): string | null {
  if (!value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Expiration must be a valid date and time.");
  }
  if (parsed.getTime() <= Date.now()) {
    throw new Error("Expiration must be in the future.");
  }
  return parsed.toISOString();
}

export { CURL_KEY_PLACEHOLDER };

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Endpoint, ServiceApiKey } from "./api";
import {
  absoluteApiUrl,
  buildExternalPredictCurl,
  buildExternalPredictRequestBody,
  copyToClipboard,
  CURL_KEY_PLACEHOLDER,
  externalPredictUrl,
  formatExternalPredictRequestJson,
  keysForDeployment,
  parseFeatureSchemaFields,
  serviceKeyScopeLabel,
  serviceKeyStatus,
  shellQuoteSingle,
} from "./deploymentApiUsage";

const baseEndpoint: Endpoint = {
  id: 7,
  project_id: 1,
  name: "heat-model",
  model_name: "heat",
  model_version: "1",
  model_version_id: 2,
  model_uri: "models:/heat/1",
  status: "ready",
  request_count: 0,
  success_count: 0,
  error_count: 0,
  success_rate: null,
  average_latency_ms: null,
  latency_p95_ms: 0,
  feature_schema: [
    { name: "site_id", dtype: "object" },
    { name: "supply_temp", dtype: "double" },
  ],
  prediction_sample: { site_id: "SITE-001", supply_temp: 75 },
  recent_errors: [],
  created_at: "2026-08-01T00:00:00Z",
};

describe("deploymentApiUsage helpers", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      location: { origin: "http://localhost:3001" },
    } as Window & typeof globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds external URL from current origin and API base", () => {
    expect(externalPredictUrl(7)).toBe(
      "http://localhost:3001/api/v1/inference/endpoints/7/predict",
    );
    expect(absoluteApiUrl("/inference/endpoints/7/predict")).toBe(
      "http://localhost:3001/api/v1/inference/endpoints/7/predict",
    );
  });

  it("wraps sample payload with instances for external API body", () => {
    const body = buildExternalPredictRequestBody(baseEndpoint);
    expect(body).toHaveProperty("instances");
    expect(Array.isArray(body.instances)).toBe(true);
    expect(body.instances[0]).toEqual({ site_id: "SITE-001", supply_temp: 75 });
    const json = formatExternalPredictRequestJson(baseEndpoint);
    expect(json).toContain('"instances"');
    expect(json).not.toMatch(/^\[\s*\{/);
  });

  it("falls back to feature_schema when prediction_sample is missing", () => {
    const body = buildExternalPredictRequestBody({
      ...baseEndpoint,
      prediction_sample: null,
      feature_schema: ["site_id", "hour"],
    });
    expect(body.instances[0]).toMatchObject({ site_id: "sample", hour: "sample" });
  });

  it("parses string and object feature schema entries", () => {
    expect(parseFeatureSchemaFields(["site_id", { name: "supply_temp", dtype: "float64" }])).toEqual([
      { name: "site_id", type: "string" },
      { name: "supply_temp", type: "double" },
    ]);
  });

  it("builds cURL with placeholder and instances wrapper", () => {
    const curl = buildExternalPredictCurl(baseEndpoint);
    expect(curl).toContain("curl -X POST");
    expect(curl).toContain(CURL_KEY_PLACEHOLDER);
    expect(curl).toContain('"instances"');
    expect(curl).not.toContain("mfk_");
  });

  it("shell-quotes JSON safely for apostrophes", () => {
    expect(shellQuoteSingle(`{"x":"it's fine"}`)).toBe(`'{"x":"it'\\''s fine"}'`);
  });

  it("filters service keys for current deployment scope", () => {
    const keys: ServiceApiKey[] = [
      {
        id: 1,
        project_id: 1,
        endpoint_id: 7,
        name: "ep-key",
        key_prefix: "mfk_aaa",
        is_active: true,
        created_at: "2026-08-01T00:00:00Z",
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
      },
      {
        id: 2,
        project_id: 1,
        endpoint_id: null,
        name: "project-key",
        key_prefix: "mfk_bbb",
        is_active: true,
        created_at: "2026-08-01T00:00:00Z",
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
      },
      {
        id: 3,
        project_id: 1,
        endpoint_id: 99,
        name: "other-key",
        key_prefix: "mfk_ccc",
        is_active: true,
        created_at: "2026-08-01T00:00:00Z",
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
      },
    ];
    const filtered = keysForDeployment(keys, 7);
    expect(filtered.map((k) => k.id)).toEqual([1, 2]);
    expect(serviceKeyScopeLabel(keys[0], 7)).toBe("This deployment");
    expect(serviceKeyScopeLabel(keys[1], 7)).toBe("All deployments in project");
  });

  it("derives service key UI status", () => {
    const active: ServiceApiKey = {
      id: 1,
      project_id: 1,
      endpoint_id: 7,
      name: "k",
      key_prefix: "mfk_x",
      is_active: true,
      created_at: "2026-08-01T00:00:00Z",
      expires_at: null,
      last_used_at: null,
      revoked_at: null,
    };
    expect(serviceKeyStatus(active)).toBe("Active");
    expect(serviceKeyStatus({ ...active, revoked_at: "2026-08-02T00:00:00Z", is_active: false })).toBe(
      "Revoked",
    );
    expect(
      serviceKeyStatus({
        ...active,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).toBe("Expired");
  });

  it("copies text via navigator.clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyToClipboard("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
  });
});

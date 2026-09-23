import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import QualityPolicies from "./QualityPolicies";

const apiMock = vi.fn();

vi.mock("../api", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, email: "admin@example.com", is_system_admin: true } }),
}));

const canWriteRef = { value: true };
vi.mock("../ProjectContext", () => ({
  useProject: () => ({ selectedProject: { id: 7, name: "demo", role: "PROJECT_ADMIN" } }),
  userCanProject: () => canWriteRef.value,
}));

const legacyPolicy = {
  id: 1,
  project_id: 7,
  endpoint_id: 9,
  name: "Legacy F1",
  is_active: true,
  window_hours: 24,
  evaluation_delay_hours: 0,
  minimum_matched_samples: 20,
  minimum_match_rate: null,
  primary_metric: "f1_macro",
  warning_threshold: 0.7,
  critical_threshold: 0.5,
  consecutive_breaches: 2,
  cooldown_hours: 24,
  auto_retrain: true,
  revision: 1,
  rule_logic: "any",
  rules: [],
  mode: "legacy",
  effective_rules: [
    {
      metric: "f1_macro",
      target: null,
      comparison: "absolute",
      warning_threshold: 0.7,
      critical_threshold: 0.5,
    },
  ],
  baseline: null,
};

const advancedPolicy = {
  id: 2,
  project_id: 7,
  endpoint_id: 9,
  name: "Advanced multi-rule",
  is_active: true,
  window_hours: 48,
  evaluation_delay_hours: 2,
  minimum_matched_samples: 30,
  minimum_match_rate: 0.8,
  primary_metric: "f1_macro",
  warning_threshold: 0.05,
  critical_threshold: 0.1,
  consecutive_breaches: 2,
  cooldown_hours: 12,
  auto_retrain: true,
  revision: 3,
  rule_logic: "all",
  rules: [
    {
      metric: "f1_macro",
      target: null,
      comparison: "baseline_delta",
      warning_threshold: 0.05,
      critical_threshold: 0.1,
    },
    {
      metric: "accuracy",
      target: "cool_load",
      comparison: "absolute",
      warning_threshold: 0.9,
      critical_threshold: 0.8,
    },
  ],
  mode: "advanced",
  effective_rules: [
    {
      metric: "f1_macro",
      target: null,
      comparison: "baseline_delta",
      warning_threshold: 0.05,
      critical_threshold: 0.1,
    },
    {
      metric: "accuracy",
      target: "cool_load",
      comparison: "absolute",
      warning_threshold: 0.9,
      critical_threshold: 0.8,
    },
  ],
  baseline: null,
};

const endpoints = [
  {
    id: 9,
    project_id: 7,
    name: "prod-iris",
    model_name: "iris",
    model_version: "1",
    model_version_id: 44,
    model_uri: "models:/iris/1",
    status: "ready",
    request_count: 0,
    success_count: 0,
    error_count: 0,
    success_rate: null,
    average_latency_ms: null,
    latency_p95_ms: 0,
    feature_schema: [],
    recent_errors: [],
    created_at: "2026-01-01T00:00:00Z",
    output_targets: ["cool_load", "power_usage"],
  },
];

const okRun = {
  id: 11,
  policy_id: 2,
  endpoint_id: 9,
  model_version_id: 44,
  status: "succeeded",
  quality_status: "ok",
  matched_ground_truth_count: 40,
  prediction_count: 45,
  match_rate: 40 / 45,
  finished_at: "2026-01-02T00:00:00Z",
  policy_revision: 3,
};

function mockDefaultApis(policies = [legacyPolicy, advancedPolicy]) {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/model-quality/policies") && (!init || !init.method || init.method === "GET")) {
      return policies;
    }
    if (path.endsWith("/endpoints")) return endpoints;
    if (path.includes("/endpoints/9")) return endpoints[0];
    if (path.includes("/model-quality/runs")) return [okRun];
    if (path.endsWith("/model-quality/policies") && init?.method === "POST") {
      return { ...advancedPolicy, id: 99, name: "Created", revision: 1, baseline: null };
    }
    if (path.includes("/policies/") && init?.method === "PATCH") {
      return { ...advancedPolicy, revision: 4, is_active: false };
    }
    if (path.includes("/baseline") && init?.method === "POST") {
      return {
        policy: {
          ...advancedPolicy,
          baseline: {
            id: 1,
            policy_id: 2,
            quality_run_id: 11,
            endpoint_id: 9,
            model_version_id: 44,
            metrics: {},
            matched_ground_truth_count: 40,
            match_rate: 40 / 45,
            created_at: "2026-01-02T00:00:00Z",
          },
        },
        baseline: {
          id: 1,
          policy_id: 2,
          quality_run_id: 11,
          endpoint_id: 9,
          model_version_id: 44,
          metrics: {},
          matched_ground_truth_count: 40,
          match_rate: 40 / 45,
          created_at: "2026-01-02T00:00:00Z",
        },
      };
    }
    if (path.includes("/baseline") && init?.method === "DELETE") {
      return { ...advancedPolicy, baseline: null };
    }
    throw new Error(`unexpected ${path} ${init?.method || "GET"}`);
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/model-quality/policies"]}>
      <Routes>
        <Route path="/projects/:projectId/model-quality/policies" element={<QualityPolicies />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("QualityPolicies", () => {
  beforeEach(() => {
    apiMock.mockReset();
    canWriteRef.value = true;
  });

  it("lists policies with revision, mode, and rule count", async () => {
    mockDefaultApis();
    renderPage();
    expect(await screen.findByTestId("quality-policies-page")).toBeInTheDocument();
    expect(screen.getByTestId("policy-row-1")).toHaveTextContent("Legacy F1");
    expect(screen.getByTestId("policy-row-1")).toHaveTextContent("legacy");
    expect(screen.getByTestId("policy-row-2")).toHaveTextContent("Advanced multi-rule");
    expect(screen.getByTestId("policy-row-2")).toHaveTextContent("advanced");
    expect(screen.getByTestId("policy-row-2")).toHaveTextContent("3");
    expect(screen.getByTestId("policy-row-2")).toHaveTextContent("2");
  });

  it("opens legacy policy edit with effective absolute rule", async () => {
    mockDefaultApis([legacyPolicy]);
    renderPage();
    await screen.findByTestId("policy-row-1");
    fireEvent.click(screen.getByTestId("edit-policy-1"));
    expect(await screen.findByTestId("quality-policy-form")).toBeInTheDocument();
    expect(screen.getByTestId("rule-row-0")).toBeInTheDocument();
    expect(screen.getByTestId("rule-metric-0")).toHaveValue("f1_macro");
    expect(screen.getByTestId("rule-comparison-0")).toHaveValue("absolute");
    expect(screen.getByTestId("policy-revision")).toHaveTextContent("Revision 1");
  });

  it("supports advanced rule builder with ANY/ALL and add/remove", async () => {
    mockDefaultApis([]);
    renderPage();
    await screen.findByTestId("quality-policies-page");
    fireEvent.click(screen.getByTestId("create-policy-btn"));
    expect(await screen.findByTestId("quality-policy-form")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("policy-rule-logic"), { target: { value: "all" } });
    expect(screen.getByTestId("policy-rule-logic")).toHaveValue("all");

    fireEvent.click(screen.getByTestId("add-rule"));
    expect(screen.getByTestId("rule-row-1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("remove-rule-1"));
    expect(screen.queryByTestId("rule-row-1")).not.toBeInTheDocument();
  });

  it("shows baseline_delta help and baseline required warning", async () => {
    mockDefaultApis([]);
    renderPage();
    await screen.findByTestId("quality-policies-page");
    fireEvent.click(screen.getByTestId("create-policy-btn"));
    await screen.findByTestId("quality-policy-form");

    fireEvent.change(screen.getByTestId("rule-comparison-0"), {
      target: { value: "baseline_delta" },
    });
    expect(screen.getByTestId("baseline-delta-help-0")).toHaveTextContent(
      "Positive delta means the production metric became worse than the pinned baseline.",
    );
    expect(screen.getByTestId("baseline-required-warning")).toBeInTheDocument();
  });

  it("sets and clears baseline from eligible runs", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let policies: any[] = [advancedPolicy];
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/model-quality/policies") && (!init || !init.method || init.method === "GET")) {
        return policies;
      }
      if (path.endsWith("/endpoints")) return endpoints;
      if (path.includes("/endpoints/9")) return endpoints[0];
      if (path.includes("/model-quality/runs")) return [okRun];
      if (path.includes("/baseline") && init?.method === "POST") {
        const baseline = {
          id: 1,
          policy_id: 2,
          quality_run_id: 11,
          endpoint_id: 9,
          model_version_id: 44,
          metrics: {},
          matched_ground_truth_count: 40,
          match_rate: 40 / 45,
          created_at: "2026-01-02T00:00:00Z",
        };
        policies = [{ ...advancedPolicy, baseline }];
        return { policy: policies[0], baseline };
      }
      if (path.includes("/baseline") && init?.method === "DELETE") {
        policies = [{ ...advancedPolicy, baseline: null }];
        return policies[0];
      }
      throw new Error(`unexpected ${path} ${init?.method || "GET"}`);
    });

    renderPage();
    await screen.findByTestId("policy-row-2");
    fireEvent.click(screen.getByTestId("select-policy-2"));
    expect(await screen.findByTestId("baseline-section")).toBeInTheDocument();
    expect(screen.getByTestId("set-baseline-btn")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("set-baseline-btn"));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/model-quality/policies/2/baseline",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByTestId("clear-baseline-btn")).toBeInTheDocument();
    expect(screen.getByTestId("baseline-summary")).toHaveTextContent("#11");

    fireEvent.click(screen.getByTestId("clear-baseline-btn"));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/model-quality/policies/2/baseline",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId("clear-baseline-btn")).not.toBeInTheDocument();
    });
  });

  it("allows cross-policy absolute OK run as baseline for baseline_delta policy", async () => {
    const absoluteOkRun = {
      id: 10,
      policy_id: 1,
      endpoint_id: 9,
      model_version_id: 44,
      status: "succeeded",
      quality_status: "ok",
      matched_ground_truth_count: 40,
      prediction_count: 45,
      match_rate: 40 / 45,
      finished_at: "2026-01-02T00:00:00Z",
      policy_revision: 1,
    };
    const otherEndpointRun = {
      ...absoluteOkRun,
      id: 20,
      endpoint_id: 99,
    };
    const oldModelRun = {
      ...absoluteOkRun,
      id: 21,
      model_version_id: 999,
    };
    const insufficientRun = {
      ...absoluteOkRun,
      id: 22,
      quality_status: "insufficient_data",
    };
    const warningRun = {
      ...absoluteOkRun,
      id: 23,
      quality_status: "warning",
    };
    const lowSampleRun = {
      ...absoluteOkRun,
      id: 24,
      matched_ground_truth_count: 1,
    };
    const lowRateRun = {
      ...absoluteOkRun,
      id: 25,
      match_rate: 0.1,
    };
    const policyB = {
      ...advancedPolicy,
      minimum_match_rate: 0.5,
    };
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/model-quality/policies") && (!init || !init.method || init.method === "GET")) {
        return [legacyPolicy, policyB];
      }
      if (path.endsWith("/endpoints")) return endpoints;
      if (path.includes("/endpoints/9")) return endpoints[0];
      if (path.includes("/model-quality/runs")) {
        return [
          absoluteOkRun,
          otherEndpointRun,
          oldModelRun,
          insufficientRun,
          warningRun,
          lowSampleRun,
          lowRateRun,
        ];
      }
      if (path.includes("/baseline") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ quality_run_id: 10 });
        return {
          policy: { ...policyB, revision: 4, baseline: { quality_run_id: 10 } },
          baseline: { quality_run_id: 10 },
        };
      }
      throw new Error(`unexpected ${path} ${init?.method || "GET"}`);
    });

    renderPage();
    await screen.findByTestId("policy-row-2");
    fireEvent.click(screen.getByTestId("select-policy-2"));
    expect(await screen.findByTestId("baseline-section")).toBeInTheDocument();
    expect(screen.getByTestId("baseline-run-10")).toBeInTheDocument();
    expect(screen.getByTestId("baseline-run-source-10")).toHaveTextContent("Legacy F1");
    expect(screen.getByTestId("baseline-run-source-10")).toHaveTextContent("#1");
    expect(screen.queryByTestId("baseline-run-20")).not.toBeInTheDocument();
    expect(screen.queryByTestId("baseline-run-21")).not.toBeInTheDocument();
    expect(screen.queryByTestId("baseline-run-22")).not.toBeInTheDocument();
    expect(screen.queryByTestId("baseline-run-23")).not.toBeInTheDocument();
    expect(screen.queryByTestId("baseline-run-24")).not.toBeInTheDocument();
    expect(screen.queryByTestId("baseline-run-25")).not.toBeInTheDocument();
    expect(screen.getByTestId("set-baseline-btn")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("set-baseline-btn"));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/model-quality/policies/2/baseline",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ quality_run_id: 10 }),
        }),
      );
    });
  });

  it("preserves legacy mode payload when editing a single absolute rule", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/model-quality/policies") && (!init || !init.method || init.method === "GET")) {
        return [legacyPolicy];
      }
      if (path.endsWith("/endpoints")) return endpoints;
      if (path.includes("/endpoints/9")) return endpoints[0];
      if (path.includes("/model-quality/runs")) return [];
      if (path.includes("/policies/1") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        expect(body.rules).toEqual([]);
        expect(body.primary_metric).toBe("f1_macro");
        expect(body.warning_threshold).toBe(0.7);
        expect(body.critical_threshold).toBe(0.5);
        expect(body).not.toHaveProperty("endpoint_id");
        return { ...legacyPolicy, name: "Legacy F1 renamed", revision: 1 };
      }
      throw new Error(`unexpected ${path} ${init?.method || "GET"}`);
    });

    renderPage();
    await screen.findByTestId("policy-row-1");
    fireEvent.click(screen.getByTestId("edit-policy-1"));
    await screen.findByTestId("quality-policy-form");
    fireEvent.change(screen.getByTestId("policy-name"), { target: { value: "Legacy F1 renamed" } });
    fireEvent.click(screen.getByTestId("save-policy"));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/model-quality/policies/1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
  });

  it("hides mutations for read-only users", async () => {
    canWriteRef.value = false;
    mockDefaultApis();
    renderPage();
    await screen.findByTestId("quality-policies-page");
    expect(screen.queryByTestId("create-policy-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("toggle-policy-1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("edit-policy-2"));
    await screen.findByTestId("quality-policy-form");
    expect(screen.queryByTestId("add-rule")).not.toBeInTheDocument();
    expect(screen.queryByTestId("save-policy")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("select-policy-2"));
    await screen.findByTestId("baseline-section");
    expect(screen.queryByTestId("set-baseline-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("clear-baseline-btn")).not.toBeInTheDocument();
  });

  it("shows multi-output target selector options from endpoint", async () => {
    mockDefaultApis([]);
    renderPage();
    await screen.findByTestId("quality-policies-page");
    fireEvent.click(screen.getByTestId("create-policy-btn"));
    await screen.findByTestId("quality-policy-form");
    fireEvent.change(screen.getByTestId("policy-endpoint"), { target: { value: "9" } });
    await waitFor(() => {
      expect(screen.getByTestId("rule-target-0")).toContainHTML("cool_load");
    });
    expect(screen.getByTestId("rule-target-0")).toContainHTML("power_usage");
  });

  it("surfaces exact backend validation errors", async () => {
    mockDefaultApis([]);
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/model-quality/policies") && (!init || !init.method || init.method === "GET")) {
        return [];
      }
      if (path.endsWith("/endpoints")) return endpoints;
      if (path.includes("/endpoints/9")) return endpoints[0];
      if (path.includes("/model-quality/runs")) return [];
      if (init?.method === "POST") {
        throw new Error(
          "For baseline_delta rules, warning_threshold must be <= critical_threshold.",
        );
      }
      throw new Error(`unexpected ${path}`);
    });
    renderPage();
    await screen.findByTestId("quality-policies-page");
    fireEvent.click(screen.getByTestId("create-policy-btn"));
    await screen.findByTestId("quality-policy-form");
    fireEvent.change(screen.getByTestId("policy-name"), { target: { value: "Bad policy" } });
    fireEvent.change(screen.getByTestId("policy-endpoint"), { target: { value: "9" } });
    fireEvent.click(screen.getByTestId("save-policy"));
    expect(
      await screen.findByText(
        "For baseline_delta rules, warning_threshold must be <= critical_threshold.",
      ),
    ).toBeInTheDocument();
  });
});

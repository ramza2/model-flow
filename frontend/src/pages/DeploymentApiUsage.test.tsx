import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DeploymentApiUsage from "./DeploymentApiUsage";

const apiMock = vi.fn();
const copyMock = vi.fn();
let canManageKeys = true;

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

vi.mock("../deploymentApiUsage", async () => {
  const actual = await vi.importActual<typeof import("../deploymentApiUsage")>(
    "../deploymentApiUsage",
  );
  return {
    ...actual,
    copyToClipboard: (...args: unknown[]) => copyMock(...args),
    externalPredictUrl: (id: number) =>
      `http://localhost:3001/api/v1/inference/endpoints/${id}/predict`,
  };
});

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, is_system_admin: false, email: "viewer@b.c" } }),
}));

vi.mock("../ProjectContext", () => ({
  useProject: () => ({ selectedProject: { id: 1, role: canManageKeys ? "PROJECT_ADMIN" : "VIEWER" } }),
  userCanProject: () => canManageKeys,
}));

const endpoint = {
  id: 7,
  project_id: 1,
  name: "postgres-e2e-prediction",
  model_name: "heat-model",
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
  feature_schema: [{ name: "site_id", dtype: "object" }, { name: "supply_temp", dtype: "double" }],
  prediction_sample: { site_id: "SITE-001", supply_temp: 75 },
  recent_errors: [],
  created_at: "2026-08-01T00:00:00Z",
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/1/deployments/7/api"]}>
      <Routes>
        <Route
          path="/projects/:projectId/deployments/:endpointId/api"
          element={<DeploymentApiUsage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DeploymentApiUsage page", () => {
  beforeEach(() => {
    canManageKeys = true;
    apiMock.mockReset();
    copyMock.mockReset();
    copyMock.mockResolvedValue(undefined);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/endpoints/7") return endpoint;
      if (path === "/projects/1/service-api-keys" && !init?.method) return [];
      if (path === "/projects/1/service-api-keys" && init?.method === "POST") {
        return {
          id: 11,
          project_id: 1,
          endpoint_id: 7,
          name: "erp-production",
          key_prefix: "mfk_abcd1234",
          key: "mfk_abcd1234_secret-value-not-for-logs",
          is_active: true,
          created_at: "2026-08-14T00:00:00Z",
          expires_at: null,
          last_used_at: null,
          revoked_at: null,
        };
      }
      if (path.endsWith("/revoke")) {
        return {
          id: 11,
          project_id: 1,
          endpoint_id: 7,
          name: "erp-production",
          key_prefix: "mfk_abcd1234",
          is_active: false,
          created_at: "2026-08-14T00:00:00Z",
          expires_at: null,
          last_used_at: null,
          revoked_at: "2026-08-14T01:00:00Z",
        };
      }
      throw new Error(`unexpected api ${path}`);
    });
  });

  it("shows external URL, instances wrapper, and cURL placeholder", async () => {
    renderPage();
    expect(await screen.findByTestId("api-usage-method")).toHaveTextContent("POST");
    expect(screen.getByTestId("api-usage-url")).toHaveTextContent(
      "/api/v1/inference/endpoints/7/predict",
    );
    const sample = screen.getByTestId("api-usage-sample-json").textContent || "";
    expect(sample).toContain('"instances"');
    expect(sample).toContain("SITE-001");
    expect(screen.getByTestId("api-usage-curl-text").textContent).toContain("$MODELFLOW_API_KEY");
    expect(screen.getByTestId("api-usage-curl-text").textContent).not.toContain("mfk_");
  });

  it("copies URL and JSON via clipboard helper", async () => {
    renderPage();
    await screen.findByTestId("copy-url");
    fireEvent.click(screen.getByTestId("copy-url"));
    await waitFor(() => expect(copyMock).toHaveBeenCalled());
    expect(copyMock.mock.calls[0][0]).toContain("/inference/endpoints/7/predict");
    fireEvent.click(screen.getByTestId("copy-json"));
    await waitFor(() => expect(copyMock.mock.calls.length).toBeGreaterThan(1));
    expect(copyMock.mock.calls[1][0]).toContain('"instances"');
  });

  it("shows one-time plaintext after create and clears on Done", async () => {
    let listReturned = false;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/endpoints/7") return endpoint;
      if (path === "/projects/1/service-api-keys" && init?.method === "POST") {
        return {
          id: 11,
          project_id: 1,
          endpoint_id: 7,
          name: "erp-production",
          key_prefix: "mfk_abcd1234",
          key: "mfk_abcd1234_secret-value-not-for-logs",
          is_active: true,
          created_at: "2026-08-14T00:00:00Z",
          expires_at: null,
          last_used_at: null,
          revoked_at: null,
        };
      }
      if (path === "/projects/1/service-api-keys" && !init?.method) {
        if (!listReturned) {
          listReturned = true;
          return [];
        }
        return [
          {
            id: 11,
            project_id: 1,
            endpoint_id: 7,
            name: "erp-production",
            key_prefix: "mfk_abcd1234",
            is_active: true,
            created_at: "2026-08-14T00:00:00Z",
            expires_at: null,
            last_used_at: null,
            revoked_at: null,
          },
        ];
      }
      throw new Error(`unexpected api ${path}`);
    });
    renderPage();
    await screen.findByTestId("create-service-key");
    fireEvent.click(screen.getByTestId("create-service-key"));
    fireEvent.change(screen.getByTestId("service-key-name"), {
      target: { value: "erp-production" },
    });
    fireEvent.click(screen.getByTestId("service-key-submit"));
    const panel = await screen.findByTestId("service-key-once-panel");
    expect(within(panel).getByTestId("service-key-plaintext")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("copy-service-key"));
    await waitFor(() => expect(copyMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("service-key-done"));
    await waitFor(() =>
      expect(screen.queryByTestId("service-key-plaintext")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("service-key-prefix")).toHaveTextContent("mfk_abcd1234");
    expect(screen.queryByText("secret-value-not-for-logs")).not.toBeInTheDocument();
  });

  it("revokes an active key after confirmation", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/endpoints/7") return endpoint;
      if (path === "/projects/1/service-api-keys" && !init?.method) {
        return [
          {
            id: 11,
            project_id: 1,
            endpoint_id: 7,
            name: "erp-production",
            key_prefix: "mfk_abcd1234",
            is_active: true,
            created_at: "2026-08-14T00:00:00Z",
            expires_at: null,
            last_used_at: null,
            revoked_at: null,
          },
        ];
      }
      if (path.endsWith("/revoke")) {
        return {
          id: 11,
          project_id: 1,
          endpoint_id: 7,
          name: "erp-production",
          key_prefix: "mfk_abcd1234",
          is_active: false,
          created_at: "2026-08-14T00:00:00Z",
          expires_at: null,
          last_used_at: null,
          revoked_at: "2026-08-14T01:00:00Z",
        };
      }
      throw new Error(`unexpected api ${path}`);
    });
    renderPage();
    await screen.findByTestId("revoke-service-key-11");
    fireEvent.click(screen.getByTestId("revoke-service-key-11"));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      "/projects/1/service-api-keys/11/revoke",
      expect.objectContaining({ method: "POST" }),
    ));
    await waitFor(() => expect(screen.getByText(/Revoked/i)).toBeInTheDocument());
  });

  it("hides key management without deploy write permission", async () => {
    canManageKeys = false;
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/endpoints/7") return endpoint;
      throw new Error(`unexpected api ${path}`);
    });
    renderPage();
    await screen.findByTestId("api-usage-url");
    expect(screen.getByTestId("api-usage-keys-permission")).toBeInTheDocument();
    expect(screen.queryByTestId("create-service-key")).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalledWith("/projects/1/service-api-keys");
  });
});

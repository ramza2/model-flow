import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Endpoints from "./Endpoints";

const apiMock = vi.fn();
const confirmMock = vi.fn();
let canDeploy = true;

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, is_system_admin: false, email: "eng@example.com" } }),
}));

vi.mock("../ProjectContext", () => ({
  useProject: () => ({ selectedProject: { id: 7, role: "ML_ENGINEER" } }),
  userCanProject: () => canDeploy,
}));

vi.mock("../components", async () => {
  const actual = await vi.importActual<typeof import("../components")>("../components");
  return {
    ...actual,
    confirmAction: (message: string) => confirmMock(message),
  };
});

const endpointV1 = {
  id: 6,
  project_id: 7,
  name: "online-service",
  model_name: "demand",
  model_version: "1",
  model_version_id: 11,
  model_uri: "models:/demand/1",
  previous_model_version: null,
  previous_model_uri: null,
  can_rollback: false,
  status: "ready",
  request_count: 3,
  success_count: 3,
  error_count: 0,
  success_rate: 1,
  average_latency_ms: 12,
  latency_p95_ms: 20,
  feature_schema: ["x"],
  recent_errors: [],
  created_at: "2026-07-01T00:00:00Z",
};

const models = [
  {
    id: 11,
    project_id: 7,
    name: "demand",
    version: "1",
    lifecycle: "PRODUCTION",
    model_uri: "models:/demand/1",
  },
  {
    id: 12,
    project_id: 7,
    name: "demand",
    version: "2",
    lifecycle: "APPROVED",
    model_uri: "models:/demand/2",
  },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/deployments"]}>
      <Routes>
        <Route path="/projects/:projectId/deployments" element={<Endpoints />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Endpoints model switch and recover UX", () => {
  beforeEach(() => {
    apiMock.mockReset();
    confirmMock.mockReset();
    canDeploy = true;
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/endpoints") && !path.includes("/endpoints/")) {
        return [{ ...endpointV1 }];
      }
      if (path.endsWith("/models")) {
        return models;
      }
      return {};
    });
  });

  it("hides switch and recover actions for viewers", async () => {
    canDeploy = false;
    renderPage();
    expect(await screen.findByText("online-service")).toBeInTheDocument();
    expect(screen.queryByTestId("endpoint-swap-6")).not.toBeInTheDocument();
    expect(screen.queryByTestId("endpoint-rollback-6")).not.toBeInTheDocument();
    expect(screen.getByTestId("endpoint-predict-6")).toBeInTheDocument();
  });

  it("shows previous-model empty state and disables recover until a swap exists", async () => {
    renderPage();
    expect(await screen.findByTestId("endpoint-previous-empty-6")).toHaveTextContent(
      "기록된 이전 모델이 없습니다",
    );
    expect(screen.getByTestId("endpoint-rollback-6")).toBeDisabled();
  });

  it("requires an explicit model choice and does not auto-select the first candidate", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("endpoint-swap-6"));
    const dialog = await screen.findByTestId("endpoint-swap-dialog");
    const select = screen.getByTestId("endpoint-swap-model") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(within(dialog).getByTestId("endpoint-swap-confirm")).toBeDisabled();
    fireEvent.change(select, { target: { value: "12" } });
    expect(select.value).toBe("12");
    expect(screen.getByTestId("endpoint-swap-confirm")).toBeEnabled();
  });

  it("warns that a stopped endpoint becomes ready after a successful swap", async () => {
    confirmMock.mockReturnValue(false);
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/endpoints") || path.includes("/projects/7/endpoints")) {
        return [{ ...endpointV1, status: "stopped" }];
      }
      if (path.endsWith("/models")) return models;
      return {};
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("endpoint-swap-6"));
    expect(await screen.findByTestId("endpoint-swap-stopped-notice")).toHaveTextContent(
      "배포 상태가 ready로 변경",
    );
    expect(screen.getByTestId("endpoint-swap-status")).toHaveTextContent("stopped");
    fireEvent.change(screen.getByTestId("endpoint-swap-model"), { target: { value: "12" } });
    fireEvent.click(screen.getByTestId("endpoint-swap-confirm"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock.mock.calls[confirmMock.mock.calls.length - 1]?.[0]).toContain(
      "배포 상태가 ready로 변경됩니다",
    );
  });

  it("opens switch dialog, cancels without calling swap, then confirms swap", async () => {
    confirmMock.mockReturnValue(false);
    let swapped = false;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/swap") && init?.method === "POST") {
        swapped = true;
        return {
          ...endpointV1,
          model_version: "2",
          model_version_id: 12,
          previous_model_version: "1",
          previous_model_uri: "models:/demand/1",
          can_rollback: true,
        };
      }
      if (path.endsWith("/endpoints") || path.includes("/projects/7/endpoints")) {
        return [
          swapped
            ? {
                ...endpointV1,
                model_version: "2",
                model_version_id: 12,
                previous_model_version: "1",
                previous_model_uri: "models:/demand/1",
                can_rollback: true,
              }
            : { ...endpointV1 },
        ];
      }
      if (path.endsWith("/models")) return models;
      return {};
    });

    renderPage();
    fireEvent.click(await screen.findByTestId("endpoint-swap-6"));
    const dialog = await screen.findByTestId("endpoint-swap-dialog");
    expect(within(dialog).getByTestId("endpoint-swap-current")).toHaveTextContent("demand · v1");
    expect((screen.getByTestId("endpoint-swap-model") as HTMLSelectElement).value).toBe("");
    fireEvent.change(screen.getByTestId("endpoint-swap-model"), { target: { value: "12" } });
    fireEvent.click(screen.getByTestId("endpoint-swap-cancel"));
    await waitFor(() => expect(screen.queryByTestId("endpoint-swap-dialog")).not.toBeInTheDocument());
    expect(swapped).toBe(false);

    fireEvent.click(screen.getByTestId("endpoint-swap-6"));
    await screen.findByTestId("endpoint-swap-dialog");
    fireEvent.change(screen.getByTestId("endpoint-swap-model"), { target: { value: "12" } });
    confirmMock.mockReturnValue(true);
    fireEvent.click(screen.getByTestId("endpoint-swap-confirm"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() => expect(swapped).toBe(true));
    const confirmText = String(confirmMock.mock.calls[confirmMock.mock.calls.length - 1]?.[0] || "");
    expect(confirmText).toContain("운영 모델을 전환할까요");
    expect(confirmText).toContain("복구 성공이 보장되지는 않습니다");
    expect(await screen.findByTestId("endpoint-previous-6")).toHaveTextContent("이전 모델 있음");
    expect(screen.getByTestId("endpoint-previous-6")).toHaveTextContent("복구 성공이 보장되지는 않습니다");
    expect(screen.getByTestId("endpoint-rollback-6")).toBeEnabled();
  });

  it("shows swap API failures without changing the current model label", async () => {
    confirmMock.mockReturnValue(true);
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/swap") && init?.method === "POST") {
        throw new Error("교체 모델을 불러오지 못했습니다.");
      }
      if (path.endsWith("/endpoints") || path.includes("/projects/7/endpoints")) {
        return [{ ...endpointV1 }];
      }
      if (path.endsWith("/models")) return models;
      return {};
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("endpoint-swap-6"));
    await screen.findByTestId("endpoint-swap-dialog");
    fireEvent.change(screen.getByTestId("endpoint-swap-model"), { target: { value: "12" } });
    fireEvent.click(screen.getByTestId("endpoint-swap-confirm"));
    expect(await screen.findByText("교체 모델을 불러오지 못했습니다.")).toBeInTheDocument();
    expect(screen.getByTestId("endpoint-swap-current")).toHaveTextContent("demand · v1");
    expect(screen.getByTestId("endpoint-previous-empty-6")).toBeInTheDocument();
  });

  it("cancels rollback without calling the API, then recovers on confirm", async () => {
    const withPrevious = {
      ...endpointV1,
      model_version: "2",
      model_version_id: 12,
      previous_model_version: "1",
      previous_model_uri: "models:/demand/1",
      can_rollback: true,
    };
    let rolledBack = false;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/rollback") && init?.method === "POST") {
        rolledBack = true;
        return {
          ...endpointV1,
          previous_model_version: "2",
          previous_model_uri: "models:/demand/2",
          can_rollback: true,
        };
      }
      if (path.endsWith("/endpoints") || path.includes("/projects/7/endpoints")) {
        return [
          rolledBack
            ? {
                ...endpointV1,
                previous_model_version: "2",
                previous_model_uri: "models:/demand/2",
                can_rollback: true,
              }
            : withPrevious,
        ];
      }
      if (path.endsWith("/models")) return models;
      return {};
    });

    renderPage();
    expect(await screen.findByTestId("endpoint-previous-6")).toHaveTextContent("이전 모델 있음");
    confirmMock.mockReturnValueOnce(false);
    fireEvent.click(screen.getByTestId("endpoint-rollback-6"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(rolledBack).toBe(false);

    confirmMock.mockReturnValueOnce(true);
    fireEvent.click(screen.getByTestId("endpoint-rollback-6"));
    await waitFor(() => expect(rolledBack).toBe(true));
    const rollbackConfirm = String(confirmMock.mock.calls[confirmMock.mock.calls.length - 1]?.[0] || "");
    expect(rollbackConfirm).toContain("이전 모델로 복구할까요");
    expect(rollbackConfirm).toContain("복구는 실패할 수 있습니다");
    expect(await screen.findByText(/복구했습니다/)).toBeInTheDocument();
  });

  it("surfaces rollback API failures", async () => {
    confirmMock.mockReturnValue(true);
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/rollback") && init?.method === "POST") {
        throw new Error("복구 모델을 불러오지 못했습니다.");
      }
      if (path.endsWith("/endpoints") || path.includes("/projects/7/endpoints")) {
        return [
          {
            ...endpointV1,
            model_version: "2",
            model_version_id: 12,
            previous_model_version: "1",
            previous_model_uri: "models:/demand/1",
            can_rollback: true,
          },
        ];
      }
      if (path.endsWith("/models")) return models;
      return {};
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("endpoint-rollback-6"));
    expect(await screen.findByText("복구 모델을 불러오지 못했습니다.")).toBeInTheDocument();
  });
});

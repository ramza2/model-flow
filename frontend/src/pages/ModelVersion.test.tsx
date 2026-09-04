import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModelVersion from "./ModelVersion";

const apiMock = vi.fn();
const canWriteRef = { value: true };
const canApproveRef = { value: true };

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, is_system_admin: true, email: "a@b.c" } }),
}));

vi.mock("../ProjectContext", () => ({
  useProject: () => ({ selectedProject: { id: 7, role: "PROJECT_ADMIN" } }),
  userCanProject: (_user: unknown, _project: unknown, ...roles: string[]) => {
    if (roles.length === 1 && roles[0] === "PROJECT_ADMIN") return canApproveRef.value;
    if (roles.includes("ML_ENGINEER") || roles.includes("PROJECT_ADMIN")) {
      return canWriteRef.value || canApproveRef.value;
    }
    return false;
  },
}));

const baseModel = {
  id: 5,
  project_id: 7,
  name: "multi_output_smoke_training",
  version: "1",
  lifecycle: "CANDIDATE",
  gates_passed: false,
  gate_results: { accuracy_gate: { passed: false } },
  approval_comment: "Looks solid",
  metrics: { val_rmse: 1.2, val_target_0_rmse: 1.0, val_target_1_rmse: 1.4 },
  metadata: {
    problem_type: "regression",
    target_columns: ["cooling_load", "power_usage"],
  },
  training_job_id: 42,
  mlflow_run_id: "run-abc",
  dataset_version_id: 11,
  pipeline_run_id: null,
  model_uri: "models:/multi_output_smoke_training/1",
  created_at: "2026-08-01T00:00:00Z",
};

function renderPage(modelId = "5") {
  return render(
    <MemoryRouter initialEntries={[`/projects/7/models/${modelId}`]}>
      <Routes>
        <Route path="/projects/:projectId/models/:modelVersionId" element={<ModelVersion />} />
        <Route path="/projects/:projectId/jobs/:jobId" element={<div>Job page</div>} />
        <Route path="/projects/:projectId/deployments" element={<div>Deployments</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ModelVersion lifecycle UX", () => {
  beforeEach(() => {
    apiMock.mockReset();
    canWriteRef.value = true;
    canApproveRef.value = true;
  });

  it("renders rejected path without implying production", async () => {
    apiMock.mockResolvedValue({ ...baseModel, lifecycle: "REJECTED", gates_passed: true });
    renderPage();
    const stepper = await screen.findByTestId("lifecycle-stepper");
    expect(stepper).toHaveTextContent("Rejected");
    expect(stepper).not.toHaveTextContent("Production");
    expect(screen.getByTestId("approval-comment-value")).toHaveTextContent("Looks solid");
  });

  it("renders archived as terminal inactive path", async () => {
    apiMock.mockResolvedValue({ ...baseModel, lifecycle: "ARCHIVED" });
    renderPage();
    const stepper = await screen.findByTestId("lifecycle-stepper");
    expect(stepper).toHaveTextContent("Archived");
  });

  it("blocks approval request when gates have not passed", async () => {
    apiMock.mockResolvedValue({ ...baseModel, lifecycle: "CANDIDATE", gates_passed: false });
    renderPage();
    await screen.findByTestId("lifecycle-stepper");
    expect(screen.getByTestId("approval-blocked-hint")).toHaveTextContent(/Validation gates must pass/i);
    expect(screen.queryByTestId("request-approval")).not.toBeInTheDocument();
    expect(screen.getByTestId("rerun-validation")).toBeInTheDocument();
  });

  it("shows request approval when gates passed", async () => {
    apiMock.mockResolvedValue({ ...baseModel, lifecycle: "CANDIDATE", gates_passed: true });
    renderPage();
    expect(await screen.findByTestId("request-approval")).toBeInTheDocument();
  });

  it("links lineage to training job and experiment run", async () => {
    apiMock.mockResolvedValue(baseModel);
    renderPage();
    await screen.findByTestId("entity-lineage");
    expect(screen.getByRole("link", { name: /Job #42/i })).toHaveAttribute("href", "/projects/7/jobs/42");
    expect(screen.getByRole("link", { name: /run-abc/i })).toHaveAttribute(
      "href",
      "/projects/7/experiments/runs/run-abc",
    );
    expect(screen.getByTestId("model-target-chips")).toHaveTextContent("cooling_load");
    expect(screen.getByTestId("model-target-chips")).toHaveTextContent("power_usage");
  });

  it("hides mutation actions for read-only users", async () => {
    canWriteRef.value = false;
    canApproveRef.value = false;
    apiMock.mockResolvedValue({ ...baseModel, lifecycle: "CANDIDATE", gates_passed: true });
    renderPage();
    await screen.findByTestId("lifecycle-stepper");
    await waitFor(() => {
      expect(screen.queryByTestId("request-approval")).not.toBeInTheDocument();
      expect(screen.queryByTestId("rerun-validation")).not.toBeInTheDocument();
    });
  });

  it("offers create deployment from production with modelVersionId state", async () => {
    apiMock.mockResolvedValue({ ...baseModel, lifecycle: "PRODUCTION", gates_passed: true });
    renderPage();
    const link = await screen.findByTestId("create-deployment");
    expect(link).toHaveAttribute("href", "/projects/7/deployments");
  });
});

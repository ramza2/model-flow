import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, ModelVersion } from "../api";
import RetrainReviewPanel from "./RetrainReviewPanel";

const apiMock = vi.fn();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

const retrainedJob: Job = {
  id: 21,
  project_id: 7,
  dataset_id: 8,
  dataset_version_id: 15,
  name: "iris-classifier-feedback-v2-e2e",
  description: "",
  target_column: "target",
  problem_type: "classification",
  algorithm: "random_forest",
  hyperparameters: {},
  feature_columns: ["a", "b"],
  status: "succeeded",
  logs: "Training succeeded.",
  mlflow_run_id: "new-run",
  model_uri: "runs:/new-run/model",
  metrics: { val_accuracy: 1, val_f1_weighted: 1 },
  error_message: null,
  retry_count: 0,
  max_retries: 1,
  parent_job_id: null,
  retrain_source_job_id: 20,
  is_retrain: true,
  created_at: "2026-11-09T00:00:00Z",
  started_at: "2026-11-09T00:00:01Z",
  finished_at: "2026-11-09T00:00:05Z",
};

const sourceJob: Job = {
  ...retrainedJob,
  id: 20,
  name: "iris-rf-baseline-v1",
  dataset_version_id: 14,
  mlflow_run_id: "old-run",
  metrics: { val_accuracy: 0.95 },
  is_retrain: false,
  retrain_source_job_id: null,
};

function renderPanel({
  job = retrainedJob,
  canRegister = true,
  registeredModel = null,
  onRegister = vi.fn(),
}: {
  job?: Job;
  canRegister?: boolean;
  registeredModel?: ModelVersion | null;
  onRegister?: () => void;
} = {}) {
  render(
    <MemoryRouter>
      <RetrainReviewPanel
        job={job}
        projectId="7"
        canRegister={canRegister}
        onRegister={onRegister}
        registeredModel={registeredModel}
      />
    </MemoryRouter>,
  );
}

describe("RetrainReviewPanel", () => {
  beforeEach(() => apiMock.mockReset());

  it("compares the original with the retrained run and warns about different data versions", async () => {
    apiMock.mockResolvedValue(sourceJob);
    renderPanel();

    expect(await screen.findByTestId("retrain-review-summary")).toHaveTextContent("iris-rf-baseline-v1");
    expect(screen.getByTestId("retrain-review-summary")).toHaveTextContent("0.950");
    expect(screen.getByTestId("retrain-review-summary")).toHaveTextContent("1.000");
    expect(screen.getByTestId("retrain-shared-metric")).toHaveTextContent("val accuracy");
    expect(screen.getByTestId("retrain-version-caution")).toHaveTextContent("데이터 버전이 다릅니다");
    expect(screen.getByTestId("retrain-compare-runs")).toHaveAttribute(
      "href", "/projects/7/experiments/compare?run_ids=old-run%2Cnew-run",
    );
    expect(screen.getByText(/자동으로 교체하지 않습니다/)).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith("/projects/7/jobs/20");
  });

  it("does not infer comparability when the dataset version matches", async () => {
    apiMock.mockResolvedValue({ ...sourceJob, dataset_version_id: 15 });
    renderPanel();
    await screen.findByTestId("retrain-review-summary");
    expect(screen.queryByTestId("retrain-version-caution")).not.toBeInTheDocument();
    expect(screen.getByText(/평가 표본이 다르면 점수를 직접 비교하기 어렵습니다/)).toBeInTheDocument();
  });

  it("shows a fallback without a comparison action when source lookup returns the wrong source", async () => {
    apiMock.mockResolvedValue({ ...sourceJob, id: 999 });
    renderPanel();
    expect(await screen.findByTestId("retrain-source-unavailable")).toHaveTextContent("원본 작업 정보를 불러오지 못했습니다");
    expect(screen.getByTestId("retrain-compare-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("retrain-compare-runs")).not.toBeInTheDocument();
    expect(screen.getByTestId("retrain-source-unavailable").querySelector("a")).toHaveAttribute(
      "href", "/projects/7/jobs/20",
    );
  });

  it("does not offer next steps for unfinished or normal training jobs", async () => {
    renderPanel({ job: { ...retrainedJob, status: "running" } });
    expect(screen.queryByTestId("job-retrain-review")).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("hides candidate registration for read-only users", async () => {
    apiMock.mockResolvedValue(sourceJob);
    const onRegister = vi.fn();
    renderPanel({ canRegister: false, onRegister });
    await screen.findByTestId("retrain-review-summary");
    expect(screen.getByText(/프로젝트 관리자가 할 수 있습니다/)).toBeInTheDocument();
    expect(screen.queryByTestId("retrain-register-model")).not.toBeInTheDocument();
    expect(onRegister).not.toHaveBeenCalled();
  });

  it("opens candidate registration without performing a lifecycle transition", async () => {
    apiMock.mockResolvedValue(sourceJob);
    const onRegister = vi.fn();
    renderPanel({ onRegister });
    await screen.findByTestId("retrain-review-summary");
    fireEvent.click(screen.getByTestId("retrain-register-model"));
    expect(onRegister).toHaveBeenCalledOnce();
    // Registering a candidate never triggers a lifecycle transition from this panel.
    expect(apiMock.mock.calls.some(([path]) => String(path).includes("promote-production"))).toBe(false);
  });

  it("links a registered candidate to its governance page", async () => {
    apiMock.mockResolvedValue(sourceJob);
    const registeredModel = {
      id: 88,
      training_job_id: 21,
      name: "iris-model",
      version: "2",
    } as ModelVersion;
    renderPanel({ registeredModel });
    await screen.findByTestId("retrain-review-summary");
    expect(screen.getByTestId("retrain-registered-model")).toHaveAttribute("href", "/projects/7/models/88");
    expect(screen.queryByTestId("retrain-register-model")).not.toBeInTheDocument();
  });
});

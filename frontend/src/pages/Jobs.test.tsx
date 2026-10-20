import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../api";
import Jobs from "./Jobs";

const apiMock = vi.fn();
const canTrainRef = { value: true };

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
  userCanProject: () => canTrainRef.value,
}));

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    project_id: 7,
    dataset_id: 6,
    dataset_version_id: 11,
    split_id: null,
    name: "baseline-iris",
    description: "first run",
    target_column: "target",
    target_columns: ["target"],
    problem_type: "classification",
    algorithm: "random_forest",
    hyperparameters: {},
    feature_columns: ["sepal length (cm)"],
    status: "succeeded",
    logs: "",
    mlflow_run_id: "run-1",
    model_uri: null,
    metrics: { val_accuracy: 0.955 },
    error_message: null,
    retry_count: 0,
    max_retries: 1,
    parent_job_id: null,
    retrain_source_job_id: null,
    is_retrain: false,
    created_at: "2026-01-01T10:00:00Z",
    started_at: "2026-01-01T10:01:00Z",
    finished_at: "2026-01-01T10:02:00Z",
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/jobs"]}>
      <Routes>
        <Route path="/projects/:projectId/jobs" element={<Jobs />} />
        <Route path="/projects/:projectId/jobs/:jobId" element={<div>Job detail</div>} />
        <Route path="/projects/:projectId/jobs/new" element={<div>Job create</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Jobs list", () => {
  beforeEach(() => {
    canTrainRef.value = true;
    apiMock.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows Korean title, new-job action, and nine-job summary", async () => {
    const rows = Array.from({ length: 9 }, (_, index) =>
      makeJob({
        id: index + 1,
        name: `job-${index + 1}`,
        status: index % 2 === 0 ? "succeeded" : "failed",
      }),
    );
    apiMock.mockResolvedValue(rows);

    renderPage();

    expect(await screen.findByRole("heading", { name: "모델 학습" })).toBeInTheDocument();
    expect(
      screen.getByText(/학습 상태와 주요 평가 지표를 확인하고/),
    ).toBeInTheDocument();
    const createLink = screen.getByRole("link", { name: /새 모델 학습/ });
    expect(createLink).toHaveAttribute("href", "/projects/7/jobs/new");
    expect(await screen.findByTestId("jobs-summary")).toHaveTextContent("학습 작업 9건");
    expect(apiMock).toHaveBeenCalledWith("/projects/7/jobs");
  });

  it("keeps filter option values while showing Korean labels and status in summary", async () => {
    apiMock.mockResolvedValue([makeJob({ id: 2, status: "running", name: "running-job" })]);

    renderPage();
    await screen.findByTestId("jobs-table");

    const filter = screen.getByTestId("jobs-status-filter") as HTMLSelectElement;
    expect(within(filter).getByRole("option", { name: "전체 상태" })).toHaveValue("");
    expect(within(filter).getByRole("option", { name: "대기 중" })).toHaveValue("pending");
    expect(within(filter).getByRole("option", { name: "학습 중" })).toHaveValue("running");
    expect(within(filter).getByRole("option", { name: "완료" })).toHaveValue("succeeded");
    expect(within(filter).getByRole("option", { name: "실패" })).toHaveValue("failed");
    expect(within(filter).getByRole("option", { name: "취소됨" })).toHaveValue("cancelled");

    fireEvent.change(filter, { target: { value: "running" } });
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith("/projects/7/jobs?status=running");
    });
    expect(await screen.findByTestId("jobs-summary")).toHaveTextContent("학습 작업 1건 · 학습 중");
  });

  it("renders Korean status labels while preserving badge tones and raw data values", async () => {
    apiMock.mockResolvedValue([
      makeJob({
        id: 10,
        name: "keep-name",
        description: "keep-description",
        status: "succeeded",
        problem_type: "classification",
        algorithm: "random_forest",
        target_columns: ["species"],
        metrics: { val_accuracy: 0.912 },
        dataset_id: 6,
      }),
      makeJob({
        id: 11,
        name: "failed-job",
        status: "failed",
        problem_type: "regression",
        algorithm: "ridge",
        target_columns: ["demand"],
        metrics: { val_rmse: 1.234 },
      }),
      makeJob({
        id: 12,
        name: "running-job",
        status: "running",
        problem_type: "auto",
        algorithm: "sgd_classifier",
        target_columns: ["label"],
        metrics: {},
      }),
    ]);

    renderPage();
    const table = await screen.findByTestId("jobs-table");

    expect(within(table).getByRole("columnheader", { name: "학습 작업" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "상태" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "예측 유형" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "학습 알고리즘" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "예측 대상" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "주요 평가 지표" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "생성일시" })).toBeInTheDocument();
    expect(
      within(table).queryByLabelText(/도움말: 모델이 얼마나 잘 예측했는지/),
    ).not.toBeInTheDocument();

    const succeeded = within(table).getByTestId("job-row-10");
    expect(within(succeeded).getByText("완료")).toBeInTheDocument();
    expect(succeeded.querySelector(".badge.ok")).toBeTruthy();
    expect(within(succeeded).getByText("keep-name")).toBeInTheDocument();
    expect(within(succeeded).getByText(/keep-description/)).toBeInTheDocument();
    expect(within(succeeded).getByText("데이터셋 #6")).toBeInTheDocument();
    expect(within(succeeded).getByText("분류 (Classification)")).toBeInTheDocument();
    expect(within(succeeded).getByText("random forest")).toBeInTheDocument();
    expect(within(succeeded).getByText("species")).toBeInTheDocument();
    expect(within(succeeded).getByText("val accuracy: 0.912")).toBeInTheDocument();
    expect(within(succeeded).getByRole("link", { name: "keep-name" })).toHaveAttribute(
      "href",
      "/projects/7/jobs/10",
    );

    const failed = within(table).getByTestId("job-row-11");
    expect(within(failed).getByText("실패")).toBeInTheDocument();
    expect(failed.querySelector(".badge.err")).toBeTruthy();
    expect(within(failed).getByText("수치 예측·회귀 (Regression)")).toBeInTheDocument();
    expect(within(failed).getByText("ridge")).toBeInTheDocument();
    expect(within(failed).getByText("demand")).toBeInTheDocument();
    expect(within(failed).getByText("val rmse: 1.234")).toBeInTheDocument();

    const running = within(table).getByTestId("job-row-12");
    expect(within(running).getByText("학습 중")).toBeInTheDocument();
    expect(running.querySelector(".badge.run")).toBeTruthy();
    expect(within(running).getByText("자동 판별 (Auto)")).toBeInTheDocument();
    expect(within(running).getByText("sgd classifier")).toBeInTheDocument();
  });

  it("resolves auto problem type from metrics for display only", async () => {
    apiMock.mockResolvedValue([
      makeJob({
        id: 20,
        problem_type: "auto",
        metrics: { val_rmse: 0.42 },
        algorithm: "ridge",
        target_columns: ["y"],
      }),
    ]);

    renderPage();
    const row = await screen.findByTestId("job-row-20");
    expect(within(row).getByText("수치 예측·회귀 (Regression)")).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith("/projects/7/jobs");
  });

  it("shows empty list CTA and hides it when a status filter is active", async () => {
    apiMock.mockResolvedValue([]);

    renderPage();
    expect(await screen.findByRole("heading", { name: "아직 모델 학습 작업이 없습니다" })).toBeInTheDocument();
    expect(
      screen.getByText("새 모델 학습을 만들어 데이터셋으로 학습을 시작할 수 있습니다."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "새 모델 학습" })).toHaveAttribute(
      "href",
      "/projects/7/jobs/new",
    );

    fireEvent.change(screen.getByTestId("jobs-status-filter"), { target: { value: "failed" } });
    expect(
      await screen.findByRole("heading", { name: "선택한 상태의 학습 작업이 없습니다" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "새 모델 학습" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith("/projects/7/jobs?status=failed");
    });
  });

  it("preserves backend error messages and Koreanizes app fallback", async () => {
    apiMock.mockRejectedValue(new Error("Jobs service unavailable"));

    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Jobs service unavailable");
  });

  it("hides the new training action for viewers", async () => {
    canTrainRef.value = false;
    apiMock.mockResolvedValue([makeJob()]);

    renderPage();
    await screen.findByTestId("jobs-table");
    expect(screen.queryByRole("link", { name: /새 모델 학습/ })).not.toBeInTheDocument();
  });
});

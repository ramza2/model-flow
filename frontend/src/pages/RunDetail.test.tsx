import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "../api";
import RunDetail from "./RunDetail";

const apiMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: "run-abc",
    experiment_id: "1",
    status: "FINISHED",
    start_time: Date.parse("2026-01-01T00:00:00Z"),
    end_time: Date.parse("2026-01-01T00:00:05Z"),
    params: {
      algorithm: "ridge",
      problem_type: "regression",
      target_columns: '["power_usage","cooling_load"]',
      job_id: "99",
    },
    metrics: { val_rmse: 1.23, val_target_0_rmse: 1.1 },
    artifact_uri: "s3://bucket/artifacts/run-abc",
    tags: { "mlflow.runName": "multi-output-ridge" },
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/experiments/runs/run-abc"]}>
      <Routes>
        <Route path="/projects/:projectId/experiments/runs/:runId" element={<RunDetail />} />
        <Route path="/projects/:projectId/jobs/:jobId" element={<div>Job</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RunDetail", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("shows Korean title, description, summary labels, and preserves run data", async () => {
    apiMock.mockResolvedValue(makeRun());
    renderPage();

    expect(await screen.findByRole("heading", { name: "multi-output-ridge" })).toBeInTheDocument();
    expect(
      screen.getByText("모델 학습 실행의 상태와 성능, 연결된 학습 작업 및 기록된 설정을 확인합니다."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /실험 비교로 돌아가기/ })).toHaveAttribute(
      "href",
      "/projects/7/experiments",
    );
    expect(screen.getByRole("heading", { name: "실행 요약" })).toBeInTheDocument();
    expect(screen.getByText("상태")).toBeInTheDocument();
    expect(screen.getByText("학습 알고리즘")).toBeInTheDocument();
    expect(screen.getByText("예측 문제 유형")).toBeInTheDocument();
    expect(screen.getByText("예측 대상")).toBeInTheDocument();
    expect(screen.getByText("시작 시각")).toBeInTheDocument();
    expect(screen.getByText("완료 시각")).toBeInTheDocument();
    expect(screen.getByText("수치 예측·회귀 (Regression)")).toBeInTheDocument();
    expect(screen.getByText("ridge")).toBeInTheDocument();

    const finishedBadges = screen.getAllByText("완료");
    expect(finishedBadges.length).toBeGreaterThanOrEqual(2);
    expect(document.querySelectorAll(".badge.ok").length).toBeGreaterThanOrEqual(2);

    expect(screen.getByText("전체 평가 지표 기록")).toBeInTheDocument();
    expect(screen.getByText("val_rmse")).toBeInTheDocument();
    expect(screen.getAllByText("s3://bucket/artifacts/run-abc").length).toBeGreaterThan(0);
    expect(screen.getByTestId("run-params-json")).toHaveTextContent('"algorithm": "ridge"');
    expect(screen.getByTestId("run-targets")).toHaveTextContent("power_usage");
    expect(screen.getByTestId("run-targets")).toHaveTextContent("cooling_load");
    expect(screen.getByText("실행 ID (Run ID)")).toBeInTheDocument();
    expect(screen.getAllByText("run-abc").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("실험 ID (Experiment ID)")).toBeInTheDocument();
    expect(screen.getByText("실험 ID (Experiment ID)").closest("div")?.querySelector("dd")).toHaveTextContent("1");
    expect(screen.queryByRole("link", { name: /compare this run/i })).not.toBeInTheDocument();
  });

  it("maps MLflow run statuses to Korean labels and tones", async () => {
    apiMock.mockResolvedValue(makeRun({ status: "RUNNING", tags: { "mlflow.runName": "running-run" } }));
    const { unmount } = renderPage();
    await screen.findByRole("heading", { name: "running-run" });
    expect(screen.getAllByText("실행 중").length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector(".badge.run")).toBeTruthy();
    unmount();

    apiMock.mockResolvedValue(makeRun({ status: "FAILED", tags: { "mlflow.runName": "failed-run" } }));
    renderPage();
    await screen.findByRole("heading", { name: "failed-run" });
    expect(screen.getAllByText("실패").length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector(".badge.err")).toBeTruthy();
  });

  it("links to training job from params.job_id (production shape)", async () => {
    apiMock.mockResolvedValue(
      makeRun({
        params: { job_id: "99", algorithm: "ridge" },
        metrics: {},
        artifact_uri: null,
        tags: { "mlflow.runName": "linked-run" },
      }),
    );
    renderPage();
    const openJob = await screen.findByTestId("open-training-job");
    expect(openJob).toHaveAttribute("href", "/projects/7/jobs/99");
    expect(openJob).toHaveTextContent("학습 작업 보기");
    expect(screen.getByText("학습 작업 #99")).toBeInTheDocument();
  });

  it("falls back to numeric training_job_id tag when params.job_id is absent", async () => {
    apiMock.mockResolvedValue(
      makeRun({
        params: {},
        metrics: {},
        artifact_uri: null,
        tags: {
          "mlflow.runName": "legacy-tag-run",
          "modelflow.training_job_id": "77",
        },
      }),
    );
    renderPage();
    expect(await screen.findByTestId("open-training-job")).toHaveAttribute("href", "/projects/7/jobs/77");
    expect(screen.getByText("학습 작업 #77")).toBeInTheDocument();
  });

  it("does not invent a training job link from non-numeric values", async () => {
    apiMock.mockResolvedValue(
      makeRun({
        params: { job_id: "run-abc" },
        metrics: {},
        artifact_uri: null,
        tags: { "mlflow.runName": "no-link" },
      }),
    );
    renderPage();
    await screen.findByRole("heading", { name: "no-link" });
    expect(screen.queryByTestId("open-training-job")).not.toBeInTheDocument();
    expect(screen.getByText("연결된 학습 작업 정보가 없습니다.")).toBeInTheDocument();
  });

  it("shows per-metric help tips and Korean primary metric hint", async () => {
    apiMock.mockResolvedValue(
      makeRun({
        params: {
          algorithm: "ridge",
          problem_type: "regression",
          target_columns: '["y"]',
        },
        metrics: {
          val_rmse: 18.128,
          val_mae: 12.4,
          val_r2: 0.91,
          test_rmse: 19.2,
        },
        tags: { "mlflow.runName": "metric-help-run" },
      }),
    );
    renderPage();
    await screen.findByRole("heading", { name: "metric-help-run" });
    expect(screen.getByRole("heading", { name: "평가 지표 (Metrics)" })).toBeInTheDocument();
    expect(screen.getByLabelText("실험 실행 평가 지표")).toBeInTheDocument();

    const rmseHelp = within(screen.getByTestId("metric-card-val_rmse")).getByLabelText(/도움말:/);
    const maeHelp = within(screen.getByTestId("metric-card-val_mae")).getByLabelText(/도움말:/);
    const r2Help = within(screen.getByTestId("metric-card-val_r2")).getByLabelText(/도움말:/);
    const testRmseHelp = within(screen.getByTestId("metric-card-test_rmse")).getByLabelText(/도움말:/);

    expect(rmseHelp.getAttribute("aria-label")).toMatch(/검증 데이터/);
    expect(rmseHelp.getAttribute("aria-label")).toMatch(/제곱 오차/);
    expect(maeHelp.getAttribute("aria-label")).toMatch(/절댓값/);
    expect(r2Help.getAttribute("aria-label")).toMatch(/1에 가까울수록/);
    expect(testRmseHelp.getAttribute("aria-label")).toMatch(/테스트 데이터/);
    expect(rmseHelp.getAttribute("aria-label")).not.toEqual(maeHelp.getAttribute("aria-label"));
    expect(rmseHelp.getAttribute("aria-label")).not.toEqual(testRmseHelp.getAttribute("aria-label"));

    expect(screen.getByTestId("metric-primary-hint")).toHaveTextContent("대표 지표:");
    expect(screen.getByTestId("metric-primary-hint")).toHaveTextContent("val rmse: 18.128");
  });

  it("preserves logged metrics table raw keys, labels, and 6-digit values", async () => {
    apiMock.mockResolvedValue(
      makeRun({
        params: { target_columns: '["cooling_load","power_usage"]' },
        metrics: { val_target_0_rmse: 1.1, val_rmse: 1.23456789 },
        tags: { "mlflow.runName": "metric-labels" },
      }),
    );
    renderPage();
    await screen.findByText("val_target_0_rmse");
    expect(screen.getByRole("columnheader", { name: "지표 키" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "표시 이름" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "측정값" })).toBeInTheDocument();
    expect(screen.getByText("1.100000")).toBeInTheDocument();
    expect(screen.getByText("1.234568")).toBeInTheDocument();

    const labels = screen.getAllByText(/val cooling load rmse/i);
    expect(labels.length).toBeGreaterThan(0);
    for (const node of labels) {
      expect(node.textContent || "").not.toMatch(/target 0/i);
    }
  });

  it("preserves params JSON, tags, and identifiers", async () => {
    apiMock.mockResolvedValue(
      makeRun({
        params: { algorithm: "random_forest", custom_param: "keep-me" },
        tags: {
          "mlflow.runName": "preserve-run",
          "modelflow.source": "unit-test",
        },
        artifact_uri: "s3://keep/uri",
        experiment_id: "exp-42",
      }),
    );
    renderPage();
    await screen.findByRole("heading", { name: "preserve-run" });
    expect(screen.getByRole("heading", { name: "실행 설정 원문 (Parameters)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "실행 태그 (Tags)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "기술 식별자 (Identifiers)" })).toBeInTheDocument();
    expect(screen.getByText(/학습 실행 시 기록된 설정입니다/)).toBeInTheDocument();
    expect(screen.getByTestId("run-params-json")).toHaveTextContent('"custom_param": "keep-me"');
    expect(screen.getByText("modelflow.source")).toBeInTheDocument();
    expect(screen.getByText("unit-test")).toBeInTheDocument();
    expect(screen.getByText("exp-42")).toBeInTheDocument();
    expect(screen.getAllByText("s3://keep/uri").length).toBeGreaterThan(0);
  });

  it("shows Korean loading and empty metrics states", async () => {
    let resolveRun: (value: Run) => void = () => undefined;
    apiMock.mockImplementation(
      () =>
        new Promise<Run>((resolve) => {
          resolveRun = resolve;
        }),
    );
    renderPage();
    expect(screen.getByRole("status")).toHaveTextContent(/실험 실행 정보 불러오는 중/);

    resolveRun(
      makeRun({
        metrics: {},
        tags: { "mlflow.runName": "empty-metrics" },
      }),
    );
    await screen.findByRole("heading", { name: "empty-metrics" });
    expect(screen.getByText("평가 지표")).toBeInTheDocument();
    expect(screen.getByText("실행 결과에 기록된 평가 지표가 없습니다.")).toBeInTheDocument();
  });

  it("preserves backend error messages and Koreanizes app fallback", async () => {
    apiMock.mockRejectedValue(new Error("Run service unavailable"));
    const { unmount } = renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Run service unavailable");
    unmount();

    apiMock.mockRejectedValue("not-an-error");
    renderPage();
    expect(await screen.findByText("실험 실행 정보를 불러오지 못했습니다.")).toBeInTheDocument();
  });

  it("shows 실험 실행 title while loading before run data arrives", async () => {
    apiMock.mockImplementation(() => new Promise(() => undefined));
    renderPage();
    expect(screen.getByRole("heading", { name: "실험 실행" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/실험 실행 정보 불러오는 중/);
  });
});

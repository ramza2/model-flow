import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "../api";
import Runs from "./Runs";

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
    run_id: "run-abc-001",
    experiment_id: "exp-1",
    status: "FINISHED",
    start_time: 1704067200000,
    end_time: 1704067260000,
    params: {
      algorithm: "random_forest",
      problem_type: "classification",
      target_column: "species",
    },
    metrics: { val_accuracy: 0.955 },
    artifact_uri: null,
    tags: { "mlflow.runName": "baseline-iris" },
    ...overrides,
  };
}

function renderPage(initialEntry = "/projects/7/experiments") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/projects/:projectId/experiments" element={<Runs />} />
        <Route
          path="/projects/:projectId/experiments/runs/:runId"
          element={<div>Run detail</div>}
        />
        <Route
          path="/projects/:projectId/experiments/compare"
          element={<div>Compare view</div>}
        />
        <Route path="/projects/:projectId/jobs/new" element={<div>Job create</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Runs list (실험 비교)", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("shows Korean title, description, search, and table headers", async () => {
    apiMock.mockResolvedValue([makeRun()]);

    renderPage();

    expect(await screen.findByRole("heading", { name: "실험 비교" })).toBeInTheDocument();
    expect(
      screen.getByText(/학습 실행 결과를 확인하고, 2개 이상 선택해 성능 지표와 설정을 비교할 수 있습니다/),
    ).toBeInTheDocument();
    expect(screen.getByText("실험 실행 검색")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("실행 이름 또는 ID")).toBeInTheDocument();

    const table = await screen.findByTestId("runs-table");
    expect(within(table).getByRole("columnheader", { name: "실행 이름" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "상태" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "학습 알고리즘" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "예측 대상" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "주요 평가 지표" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "시작 시각" })).toBeInTheDocument();
    expect(
      within(table).queryByLabelText(/도움말/),
    ).not.toBeInTheDocument();
  });

  it("renders runs with detail links and preserves raw metrics, targets, and run IDs", async () => {
    apiMock.mockResolvedValue([
      makeRun({
        run_id: "run-keep-id-99",
        status: "FINISHED",
        params: {
          algorithm: "random_forest",
          problem_type: "classification",
          target_column: "species",
        },
        metrics: { val_accuracy: 0.912 },
        tags: { "mlflow.runName": "keep-name" },
      }),
    ]);

    renderPage();
    const row = await screen.findByTestId("run-row-run-keep-id-99");

    expect(within(row).getByText("keep-name")).toBeInTheDocument();
    expect(within(row).getByText("run-keep-id-99")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "keep-name" })).toHaveAttribute(
      "href",
      "/projects/7/experiments/runs/run-keep-id-99",
    );
    expect(within(row).getByText("완료")).toBeInTheDocument();
    expect(row.querySelector(".badge.ok")).toBeTruthy();
    expect(within(row).getByText("random forest")).toBeInTheDocument();
    expect(within(row).getByText("species")).toBeInTheDocument();
    expect(within(row).getByText("val accuracy: 0.912")).toBeInTheDocument();
    expect(within(row).getByLabelText("실행 선택: keep-name")).toBeInTheDocument();
  });

  it("disables compare with 0–1 selections and enables with exact run_ids for 2+", async () => {
    apiMock.mockResolvedValue([
      makeRun({ run_id: "run-a", tags: { "mlflow.runName": "run-a-name" } }),
      makeRun({ run_id: "run-b", tags: { "mlflow.runName": "run-b-name" } }),
      makeRun({ run_id: "run-c", tags: { "mlflow.runName": "run-c-name" } }),
    ]);

    renderPage();
    await screen.findByTestId("runs-table");

    const compare = screen.getByTestId("compare-selected");
    expect(compare).toHaveClass("is-disabled");
    expect(compare).toHaveAttribute("aria-disabled", "true");
    expect(compare).toHaveTextContent("선택한 실행 비교 (0개)");
    expect(compare).toHaveAttribute(
      "href",
      "/projects/7/experiments/compare?run_ids=",
    );

    fireEvent.click(screen.getByLabelText("실행 선택: run-a-name"));
    expect(compare).toHaveClass("is-disabled");
    expect(compare).toHaveTextContent("선택한 실행 비교 (1개)");
    expect(screen.getByText(/개 선택됨 · 2개 이상 선택하면 비교할 수 있습니다/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("실행 선택: run-b-name"));
    expect(compare).not.toHaveClass("is-disabled");
    expect(compare).toHaveAttribute("aria-disabled", "false");
    expect(compare).toHaveTextContent("선택한 실행 비교 (2개)");
    expect(compare).toHaveAttribute(
      "href",
      "/projects/7/experiments/compare?run_ids=run-a,run-b",
    );

    fireEvent.click(screen.getByLabelText("실행 선택: run-a-name"));
    expect(compare).toHaveClass("is-disabled");
    expect(compare).toHaveTextContent("선택한 실행 비교 (1개)");
    expect(compare).toHaveAttribute(
      "href",
      "/projects/7/experiments/compare?run_ids=run-b",
    );
  });

  it("preselects the run from ?run= query", async () => {
    apiMock.mockResolvedValue([
      makeRun({ run_id: "run-pre", tags: { "mlflow.runName": "preselected" } }),
      makeRun({ run_id: "run-other", tags: { "mlflow.runName": "other" } }),
    ]);

    renderPage("/projects/7/experiments?run=run-pre");
    await screen.findByTestId("runs-table");

    expect(screen.getByLabelText("실행 선택: preselected")).toBeChecked();
    expect(screen.getByLabelText("실행 선택: other")).not.toBeChecked();
    expect(screen.getByTestId("compare-selected")).toHaveTextContent("선택한 실행 비교 (1개)");
    expect(screen.getByTestId("compare-selected")).toHaveClass("is-disabled");
  });

  it("preserves search API query parameter", async () => {
    apiMock.mockResolvedValue([makeRun()]);

    renderPage();
    await screen.findByTestId("runs-table");
    expect(apiMock).toHaveBeenCalledWith("/projects/7/experiments/runs");

    fireEvent.change(screen.getByPlaceholderText("실행 이름 또는 ID"), {
      target: { value: "baseline" },
    });

    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith("/projects/7/experiments/runs?search=baseline");
    });
  });

  it("shows Korean empty and loading states", async () => {
    let resolveRuns: (value: Run[]) => void = () => undefined;
    apiMock.mockImplementation(
      () =>
        new Promise<Run[]>((resolve) => {
          resolveRuns = resolve;
        }),
    );

    renderPage();
    expect(screen.getByRole("status")).toHaveTextContent(/실험 실행 목록 불러오는 중/);

    resolveRuns([]);
    expect(await screen.findByRole("heading", { name: "실험 실행 기록이 없습니다" })).toBeInTheDocument();
    expect(
      screen.getByText("모델 학습을 시작하면 실행 결과가 이곳에 자동으로 기록됩니다."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "새 모델 학습" })).toHaveAttribute(
      "href",
      "/projects/7/jobs/new",
    );
  });

  it("preserves backend error messages and Koreanizes app fallback", async () => {
    apiMock.mockRejectedValue(new Error("Experiment service unavailable"));
    const { unmount } = renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Experiment service unavailable");
    unmount();

    apiMock.mockRejectedValue("not-an-error");
    renderPage();
    expect(await screen.findByText("실험 실행 목록을 불러오지 못했습니다.")).toBeInTheDocument();
  });

  it("maps MLflow statuses to Korean labels and tones", async () => {
    apiMock.mockResolvedValue([
      makeRun({
        run_id: "r-finished",
        status: "FINISHED",
        tags: { "mlflow.runName": "finished-run" },
      }),
      makeRun({
        run_id: "r-running",
        status: "RUNNING",
        tags: { "mlflow.runName": "running-run" },
      }),
      makeRun({
        run_id: "r-failed",
        status: "FAILED",
        tags: { "mlflow.runName": "failed-run" },
      }),
      makeRun({
        run_id: "r-killed",
        status: "KILLED",
        tags: { "mlflow.runName": "killed-run" },
      }),
      makeRun({
        run_id: "r-scheduled",
        status: "SCHEDULED",
        tags: { "mlflow.runName": "scheduled-run" },
      }),
      makeRun({
        run_id: "r-unknown",
        status: "CUSTOM_STATE",
        tags: { "mlflow.runName": "unknown-run" },
      }),
    ]);

    renderPage();
    await screen.findByTestId("runs-table");

    const finished = screen.getByTestId("run-row-r-finished");
    expect(within(finished).getByText("완료")).toBeInTheDocument();
    expect(finished.querySelector(".badge.ok")).toBeTruthy();

    const running = screen.getByTestId("run-row-r-running");
    expect(within(running).getByText("실행 중")).toBeInTheDocument();
    expect(running.querySelector(".badge.run")).toBeTruthy();

    const failed = screen.getByTestId("run-row-r-failed");
    expect(within(failed).getByText("실패")).toBeInTheDocument();
    expect(failed.querySelector(".badge.err")).toBeTruthy();

    const killed = screen.getByTestId("run-row-r-killed");
    expect(within(killed).getByText("중지됨")).toBeInTheDocument();
    expect(killed.querySelector(".badge.neutral")).toBeTruthy();

    const scheduled = screen.getByTestId("run-row-r-scheduled");
    expect(within(scheduled).getByText("대기 중")).toBeInTheDocument();
    expect(scheduled.querySelector(".badge.run")).toBeTruthy();

    const unknown = screen.getByTestId("run-row-r-unknown");
    expect(within(unknown).getByText("CUSTOM STATE")).toBeInTheDocument();
    expect(unknown.querySelector(".badge.warn")).toBeTruthy();
  });
});

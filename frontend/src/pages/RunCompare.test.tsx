import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "../api";
import RunCompare from "./RunCompare";

const apiMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

function makeRun(overrides: Partial<Run> & { run_id: string }): Run {
  return {
    experiment_id: "1",
    status: "FINISHED",
    start_time: null,
    end_time: null,
    params: { algorithm: "ridge", problem_type: "regression" },
    metrics: {},
    artifact_uri: null,
    tags: { "mlflow.runName": overrides.run_id },
    ...overrides,
  };
}

function renderPage(entry = "/projects/7/experiments/compare?run_ids=run-a,run-b") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/projects/:projectId/experiments/compare" element={<RunCompare />} />
        <Route path="/projects/:projectId/experiments" element={<div>Experiments list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RunCompare", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("shows Korean title, description, and back link", async () => {
    apiMock.mockResolvedValue({
      runs: [
        makeRun({ run_id: "run-a", tags: { "mlflow.runName": "alpha" } }),
        makeRun({ run_id: "run-b", tags: { "mlflow.runName": "beta" } }),
      ],
      metric_keys: ["val_rmse"],
      param_keys: ["algorithm"],
    });
    renderPage();

    expect(await screen.findByRole("heading", { name: "학습 실행 비교" })).toBeInTheDocument();
    expect(
      screen.getByText(/선택한 학습 실행의 평가 지표와 설정을 나란히 비교합니다/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /실험 비교로 돌아가기/ })).toHaveAttribute(
      "href",
      "/projects/7/experiments",
    );
    expect(apiMock).toHaveBeenCalledWith(
      "/projects/7/experiments/runs/compare?run_ids=run-a%2Crun-b",
    );
  });

  it("preserves run order, names, raw IDs, and MLflow status badges", async () => {
    apiMock.mockResolvedValue({
      runs: [
        makeRun({
          run_id: "run-finished-01",
          status: "FINISHED",
          tags: { "mlflow.runName": "finished-run" },
        }),
        makeRun({
          run_id: "run-running-02",
          status: "RUNNING",
          tags: { "mlflow.runName": "running-run" },
        }),
        makeRun({
          run_id: "run-failed-03",
          status: "FAILED",
          tags: { "mlflow.runName": "failed-run" },
        }),
      ],
      metric_keys: [],
      param_keys: [],
    });
    renderPage("/projects/7/experiments/compare?run_ids=run-finished-01,run-running-02,run-failed-03");

    const header = await screen.findByTestId("compare-header");
    const cards = header.querySelectorAll(".compare-run-card");
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveTextContent("finished-run");
    expect(cards[0]).toHaveTextContent("run-finished-01");
    expect(within(cards[0] as HTMLElement).getByText("완료")).toBeInTheDocument();
    expect(cards[0].querySelector(".badge.ok")).toBeTruthy();

    expect(cards[1]).toHaveTextContent("running-run");
    expect(cards[1]).toHaveTextContent("run-running-02");
    expect(within(cards[1] as HTMLElement).getByText("실행 중")).toBeInTheDocument();
    expect(cards[1].querySelector(".badge.run")).toBeTruthy();

    expect(cards[2]).toHaveTextContent("failed-run");
    expect(cards[2]).toHaveTextContent("run-failed-03");
    expect(within(cards[2] as HTMLElement).getByText("실패")).toBeInTheDocument();
    expect(cards[2].querySelector(".badge.err")).toBeTruthy();

    expect(apiMock).toHaveBeenCalledWith(
      "/projects/7/experiments/runs/compare?run_ids=run-finished-01%2Crun-running-02%2Crun-failed-03",
    );
  });

  it("shows Korean identity rows and problem type labels", async () => {
    apiMock.mockResolvedValue({
      runs: [
        makeRun({
          run_id: "run-a",
          status: "KILLED",
          params: {
            algorithm: "random_forest",
            problem_type: "classification",
            target_columns: '["species"]',
          },
          tags: { "mlflow.runName": "clf-run" },
        }),
        makeRun({
          run_id: "run-b",
          status: "SCHEDULED",
          params: {
            algorithm: "ridge",
            problem_type: "regression",
            target_columns: '["demand"]',
          },
          tags: { "mlflow.runName": "reg-run" },
        }),
      ],
      metric_keys: [],
      param_keys: [],
    });
    renderPage();

    const table = await screen.findByTestId("compare-identity-table");
    expect(within(table).getByRole("columnheader", { name: "비교 항목" })).toBeInTheDocument();
    expect(within(table).getByText("실행 이름")).toBeInTheDocument();
    expect(within(table).getByText("상태")).toBeInTheDocument();
    expect(within(table).getByText("학습 알고리즘")).toBeInTheDocument();
    expect(within(table).getByText("예측 문제 유형")).toBeInTheDocument();
    expect(within(table).getByText("예측 대상")).toBeInTheDocument();
    expect(within(table).getByText("분류 (Classification)")).toBeInTheDocument();
    expect(within(table).getByText("수치 예측·회귀 (Regression)")).toBeInTheDocument();
    expect(within(table).getByText("random_forest")).toBeInTheDocument();
    expect(within(table).getByText("ridge")).toBeInTheDocument();
    expect(within(table).getByText("중지됨")).toBeInTheDocument();
    expect(within(table).getByText("대기 중")).toBeInTheDocument();
    expect(table.querySelector(".badge.neutral")).toBeTruthy();
    expect(table.querySelector(".badge.run")).toBeTruthy();
    expect(within(table).getByText("species")).toBeInTheDocument();
    expect(within(table).getByText("demand")).toBeInTheDocument();
  });

  it("does not map target_0 to the first run target when compared runs disagree", async () => {
    apiMock.mockResolvedValue({
      runs: [
        {
          run_id: "run-a",
          experiment_id: "1",
          status: "FINISHED",
          start_time: null,
          end_time: null,
          params: { target_columns: '["cooling_load","power_usage"]', algorithm: "ridge" },
          metrics: { val_target_0_rmse: 1.1 },
          artifact_uri: null,
          tags: { "mlflow.runName": "run-a" },
        },
        {
          run_id: "run-b",
          experiment_id: "1",
          status: "FINISHED",
          start_time: null,
          end_time: null,
          params: { target_columns: '["temperature","humidity"]', algorithm: "ridge" },
          metrics: { val_target_0_rmse: 2.2 },
          artifact_uri: null,
          tags: { "mlflow.runName": "run-b" },
        },
      ],
      metric_keys: ["val_target_0_rmse"],
      param_keys: ["target_columns", "algorithm"],
    });
    renderPage();
    await screen.findByText("val_target_0_rmse");
    expect(screen.queryByText(/cooling load/i)).not.toBeInTheDocument();
    expect(screen.getByText(/val target 0 rmse/i)).toBeInTheDocument();
  });

  it("humanizes per-target metrics when all compared runs share targets", async () => {
    apiMock.mockResolvedValue({
      runs: [
        {
          run_id: "run-a",
          experiment_id: "1",
          status: "FINISHED",
          start_time: null,
          end_time: null,
          params: { target_columns: '["cooling_load","power_usage"]', algorithm: "ridge" },
          metrics: { val_target_0_rmse: 1.1 },
          artifact_uri: null,
          tags: { "mlflow.runName": "run-a" },
        },
        {
          run_id: "run-b",
          experiment_id: "1",
          status: "FINISHED",
          start_time: null,
          end_time: null,
          params: { target_columns: '["cooling_load","power_usage"]', algorithm: "lasso" },
          metrics: { val_target_0_rmse: 2.2 },
          artifact_uri: null,
          tags: { "mlflow.runName": "run-b" },
        },
      ],
      metric_keys: ["val_target_0_rmse"],
      param_keys: ["target_columns", "algorithm"],
    });
    renderPage();
    await screen.findByText("val_target_0_rmse");
    expect(screen.getByText(/val cooling load rmse/i)).toBeInTheDocument();
  });

  it("shows distinct per-metric help tips and preserves metric order/precision", async () => {
    apiMock.mockResolvedValue({
      runs: [
        makeRun({
          run_id: "run-a",
          tags: { "mlflow.runName": "alpha" },
          metrics: {
            val_rmse: 1.23456,
            val_mae: 0.5,
            val_r2: 0.91,
            val_accuracy: 0.88,
            test_rmse: 1.5,
            custom_score: 3,
          },
        }),
        makeRun({
          run_id: "run-b",
          tags: { "mlflow.runName": "beta" },
          metrics: {
            val_rmse: 2.0,
            val_mae: 0.6,
            val_r2: 0.8,
            // accuracy missing on run-b
            test_rmse: 2.1,
            custom_score: 4,
          },
        }),
      ],
      metric_keys: ["val_mae", "custom_score", "val_rmse", "test_rmse", "val_accuracy", "val_r2"],
      param_keys: [],
    });
    renderPage();

    const table = await screen.findByTestId("compare-metrics-table");
    expect(within(table).getByRole("columnheader", { name: "평가 지표" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "평가 지표 비교 (Metrics)" })).toBeInTheDocument();

    const rows = within(table).getAllByRole("row").slice(1);
    // preferred order: val_rmse, val_accuracy, val_r2, then remaining metric_keys order
    expect(rows[0]).toHaveClass("compare-primary-metric-row");
    expect(rows[0]).toHaveTextContent("val_rmse");
    expect(rows[1]).toHaveTextContent("val_accuracy");
    expect(rows[2]).toHaveTextContent("val_r2");
    expect(rows[3]).toHaveTextContent("val_mae");
    expect(rows[4]).toHaveTextContent("custom_score");
    expect(rows[5]).toHaveTextContent("test_rmse");

    expect(within(rows[0]).getByText("1.2346")).toBeInTheDocument();
    expect(within(rows[0]).getByText("2.0000")).toBeInTheDocument();
    expect(within(rows[1]).getByText("—")).toBeInTheDocument();

    const rmseHelp = within(screen.getByTestId("compare-metric-row-val_rmse")).getByLabelText(/도움말:/);
    const maeHelp = within(screen.getByTestId("compare-metric-row-val_mae")).getByLabelText(/도움말:/);
    const r2Help = within(screen.getByTestId("compare-metric-row-val_r2")).getByLabelText(/도움말:/);
    const accHelp = within(screen.getByTestId("compare-metric-row-val_accuracy")).getByLabelText(/도움말:/);
    const testHelp = within(screen.getByTestId("compare-metric-row-test_rmse")).getByLabelText(/도움말:/);
    const customHelp = within(screen.getByTestId("compare-metric-row-custom_score")).getByLabelText(/도움말:/);

    expect(rmseHelp.getAttribute("aria-label")).toMatch(/검증 데이터/);
    expect(rmseHelp.getAttribute("aria-label")).toMatch(/제곱 오차/);
    expect(maeHelp.getAttribute("aria-label")).toMatch(/절댓값/);
    expect(r2Help.getAttribute("aria-label")).toMatch(/1에 가까울수록/);
    expect(accHelp.getAttribute("aria-label")).toMatch(/정답인 비율/);
    expect(testHelp.getAttribute("aria-label")).toMatch(/테스트 데이터/);
    expect(customHelp.getAttribute("aria-label")).toMatch(/기록된 평가 지표/);

    expect(rmseHelp.getAttribute("aria-label")).not.toEqual(maeHelp.getAttribute("aria-label"));
    expect(rmseHelp.getAttribute("aria-label")).not.toEqual(testHelp.getAttribute("aria-label"));
    expect(accHelp.getAttribute("aria-label")).not.toEqual(r2Help.getAttribute("aria-label"));
  });

  it("keeps technical parameters collapsed by default and preserves keys/values/order", async () => {
    apiMock.mockResolvedValue({
      runs: [
        makeRun({
          run_id: "abcdefghijkl",
          params: { algorithm: "ridge", alpha: "0.1", missing_on_b: "yes" },
          tags: { "mlflow.runName": "alpha" },
        }),
        makeRun({
          run_id: "mnopqrstuvwx",
          params: { algorithm: "lasso", alpha: "0.2" },
          tags: { "mlflow.runName": "beta" },
        }),
      ],
      metric_keys: [],
      param_keys: ["alpha", "algorithm", "missing_on_b"],
    });
    renderPage();

    const details = await screen.findByTestId("compare-params-details");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText(/실행 설정 비교 \(고급\)/)).toBeInTheDocument();

    fireEvent.click(within(details).getByText(/실행 설정 비교 \(고급\)/));
    expect(details).toHaveAttribute("open");
    expect(
      screen.getByText(/각 학습 실행에 기록된 설정값입니다/),
    ).toBeInTheDocument();

    const table = screen.getByTestId("compare-params-table");
    expect(within(table).getByRole("columnheader", { name: "설정 키" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "abcdefgh" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "mnopqrst" })).toBeInTheDocument();

    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("alpha");
    expect(rows[0]).toHaveTextContent("0.1");
    expect(rows[0]).toHaveTextContent("0.2");
    expect(rows[1]).toHaveTextContent("algorithm");
    expect(rows[1]).toHaveTextContent("ridge");
    expect(rows[1]).toHaveTextContent("lasso");
    expect(rows[2]).toHaveTextContent("missing_on_b");
    expect(rows[2]).toHaveTextContent("yes");
    expect(within(rows[2]).getByText("—")).toBeInTheDocument();
  });

  it("shows Korean loading and missing-run_ids fallback errors", async () => {
    apiMock.mockImplementation(() => new Promise(() => undefined));
    const { unmount } = renderPage();
    expect(screen.getByRole("status")).toHaveTextContent(/실험 비교 결과 불러오는 중/);
    unmount();

    apiMock.mockReset();
    renderPage("/projects/7/experiments/compare");
    expect(await screen.findByRole("alert")).toHaveTextContent("비교할 학습 실행을 선택해주세요.");
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("preserves backend error messages and Koreanizes app fallback", async () => {
    apiMock.mockRejectedValue(new Error("Compare service unavailable"));
    const { unmount } = renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Compare service unavailable");
    unmount();

    apiMock.mockRejectedValue("not-an-error");
    renderPage();
    expect(await screen.findByText("학습 실행 비교 결과를 불러오지 못했습니다.")).toBeInTheDocument();
  });
});

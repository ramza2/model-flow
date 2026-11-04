import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Monitoring, { formatRuleEvidence } from "./Monitoring";

const apiMock = vi.fn();
let noQualityChecks = false;

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

describe("formatRuleEvidence", () => {
  it("formats baseline delta evidence compactly", () => {
    expect(
      formatRuleEvidence({
        metric: "f1_macro",
        comparison: "baseline_delta",
        degradation_delta: 0.12,
        status: "critical",
      }),
    ).toBe("F1 baseline delta 0.12 → CRITICAL");
  });
});

describe("Monitoring", () => {
  beforeEach(() => {
    apiMock.mockReset();
    noQualityChecks = false;
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes("/monitoring/service")) {
        return {
          request_count: 12,
          success_count: 10,
          error_count: 2,
          success_rate: 10 / 12,
          average_latency_ms: 18.2,
          p95_latency_ms: 25.1,
          series: [],
        };
      }
      if (path.endsWith("/monitoring/data")) {
        if (noQualityChecks) {
          return {
            dataset_count: 1,
            dataset_version_count: 1,
            quality_check_count: 0,
            failed_quality_check_count: 0,
            latest_quality_status: null,
          };
        }
        return {
          dataset_count: 2,
          dataset_version_count: 4,
          quality_check_count: 3,
          failed_quality_check_count: 1,
          latest_quality_status: "failed",
        };
      }
      if (path.endsWith("/monitoring/models")) {
        return {
          model_version_count: 5,
          lifecycle_counts: { PRODUCTION: 1, CANDIDATE: 4 },
          endpoint_count: 2,
          ready_endpoint_count: 1,
          total_requests: 100,
          total_errors: 4,
          latest_drift_status: null,
        };
      }
      if (path.endsWith("/model-quality/summary")) {
        return {
          items: [
            {
              policy_id: 1,
              policy_name: "Endpoint quality",
              endpoint_id: 9,
              endpoint_name: "prod-iris",
              current_model_version_id: 3,
              current_model_name: "iris",
              current_model_version: "1",
              latest_quality_status: "critical",
              primary_metric: "f1_macro",
              primary_metric_value: 0.4,
              matched_ground_truth_count: 25,
              prediction_count: 30,
              match_rate: 25 / 30,
              window_start: null,
              window_end: null,
              last_evaluated_at: "2026-01-01T00:00:00Z",
              closed_loop_state: "Candidate ready",
              closed_loop: {
                code: "candidate_ready",
                label: "Candidate ready",
                reason: "critical_degradation",
                reason_label: "Critical quality degradation triggered retraining",
                next_action: "Review the candidate ModelVersion before requesting approval.",
                quality_run_id: 11,
                candidate_model_version_id: 91,
                policy_id: 1,
              },
              latest_run_id: 11,
              revision: 4,
              mode: "advanced",
              rule_logic: "any",
              rule_count: 2,
              evaluation_delay_hours: 2,
              minimum_match_rate: 0.75,
              baseline_quality_run_id: null,
              baseline_required: true,
              latest_evaluation: {
                rules: [
                  {
                    metric: "f1_macro",
                    comparison: "baseline_delta",
                    degradation_delta: 0.12,
                    status: "critical",
                  },
                ],
              },
              latest_policy_revision: 4,
            },
          ],
        };
      }
      if (path.includes("/model-quality/runs")) {
        return {
          items: [
            {
              id: 11,
              quality_status: "critical",
              status: "succeeded",
              matched_ground_truth_count: 25,
              prediction_count: 30,
              match_rate: 25 / 30,
              policy_revision: 4,
              model_version_id: 3,
              finished_at: "2026-01-01T00:00:00Z",
              trigger_decision: { reason: "retrain_triggered" },
              evaluation: {
                reason: null,
                rules: [
                  {
                    metric: "f1_macro",
                    comparison: "baseline_delta",
                    degradation_delta: 0.12,
                    status: "critical",
                  },
                ],
              },
            },
          ],
          total: 1,
          skip: 0,
          limit: 10,
        };
      }
      throw new Error(`unexpected ${path}`);
    });
  });

  it("renders Service/Data/Model sections with factual attention", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/7/monitoring"]}>
        <Routes>
          <Route path="/projects/:projectId/monitoring" element={<Monitoring />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("monitoring-attention")).toHaveTextContent("예측 오류 2건");
    expect(screen.getByTestId("monitoring-attention")).toHaveTextContent("품질 검사 1건");
    expect(screen.getByTestId("monitoring-attention")).toHaveTextContent("배포 준비 완료 1/2건");
    expect(screen.getByTestId("monitoring-service")).toBeInTheDocument();
    expect(screen.getByTestId("monitoring-data")).toBeInTheDocument();
    expect(screen.getByTestId("monitoring-models")).toBeInTheDocument();
    expect(screen.getByTestId("monitoring-production-quality")).toBeInTheDocument();
    expect(screen.getByTestId("review-feedback-9")).toHaveAttribute(
      "href",
      "/projects/7/feedback?endpoint_id=9",
    );
    expect(screen.getByTestId("matched-gt-1")).toHaveTextContent("25");
    expect(screen.getByTestId("closed-loop-state-9")).toHaveTextContent("Candidate ready");
    expect(await screen.findByTestId("closed-loop-detail-1")).toBeInTheDocument();
    expect(screen.getByTestId("recovery-candidate-1")).toHaveAttribute(
      "href",
      "/projects/7/registry?modelVersionId=91",
    );
    expect(screen.getByTestId("view-quality-history-1")).toBeInTheDocument();
    expect(screen.getByText("예측 요청 이력이 없습니다")).toBeInTheDocument();
    expect(screen.getByText("모니터링 (Monitoring)")).toBeInTheDocument();
    expect(screen.getByText("평균 응답시간")).toBeInTheDocument();
    expect(screen.getByTestId("monitoring-models")).toHaveTextContent("미확인 (Unknown)");
    expect(screen.getByTestId("monitoring-model-unknown-help")).toHaveTextContent("배포 장애를 뜻하지 않습니다");
    expect(screen.getByTestId("monitoring-models")).toHaveTextContent("운영 중 · 1");
    fireEvent.change(screen.getByTestId("monitoring-window"), { target: { value: "168" } });
    expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("hours=168"));
  });

  it("shows advanced policy summary fields and evidence", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/7/monitoring"]}>
        <Routes>
          <Route path="/projects/:projectId/monitoring" element={<Monitoring />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("quality-revision-1")).toHaveTextContent("4");
    expect(screen.getByTestId("quality-rule-count-1")).toHaveTextContent("2");
    expect(screen.getByTestId("quality-rule-count-1")).toHaveTextContent("ANY");
    expect(screen.getByTestId("baseline-required-1")).toHaveTextContent("기준 평가 필요");
    expect(screen.getByTestId("quality-policies-link")).toHaveAttribute(
      "href",
      "/projects/7/model-quality/policies",
    );
    expect(screen.getByTestId("run-policy-rev-11")).toHaveTextContent("4");
    expect(screen.getByTestId("run-matched-preds-11")).toHaveTextContent("25 / 30");
    expect(screen.getByTestId("run-breached-11")).toHaveTextContent("1");
    expect(screen.getByTestId("run-evidence-11")).toHaveTextContent(
      "F1 baseline delta 0.12 → CRITICAL",
    );
    expect(screen.getByTestId("monitoring-quality-trend")).toHaveTextContent("품질 평가 이력");
    expect(screen.getByRole("columnheader", { name: /연결률/ })).toBeInTheDocument();
    expect(screen.getByTestId("quality-history-next")).toBeDisabled();
    fireEvent.click(screen.getByTestId("expand-quality-run-11"));
    expect(screen.getByTestId("quality-run-detail-11")).toHaveTextContent("평가 데이터 충분 여부");
    expect(screen.getByTestId("expand-quality-run-11")).toHaveTextContent("접기");
    expect(screen.getByText("고급 정보 (JSON)")).toBeInTheDocument();
  });

  it("explains missing data checks and drift evaluations without treating Unknown as a failure", async () => {
    noQualityChecks = true;
    render(
      <MemoryRouter initialEntries={["/projects/7/monitoring"]}>
        <Routes>
          <Route path="/projects/:projectId/monitoring" element={<Monitoring />} />
        </Routes>
      </MemoryRouter>,
    );
    const dataSection = await screen.findByTestId("monitoring-data");
    expect(dataSection).toHaveTextContent("미확인 (Unknown)");
    expect(dataSection).toHaveTextContent("품질 검사");
    expect(screen.getByTestId("monitoring-data-unknown-help")).toHaveTextContent(
      "아직 품질 검사를 실행하지 않아 판정할 결과가 없습니다",
    );
    expect(screen.getByTestId("monitoring-model-unknown-help")).toHaveTextContent(
      "최근 데이터 분포 변화(Drift) 평가 결과가 없어",
    );
    expect(screen.getByRole("link", { name: "데이터셋 열기" })).toHaveAttribute(
      "href",
      "/projects/7/datasets",
    );
    expect(screen.getByRole("link", { name: "배포 관리 열기" })).toHaveAttribute(
      "href",
      "/projects/7/deployments",
    );
    expect(screen.getByTestId("monitoring-data").querySelector(".badge")).toHaveClass("neutral");
    expect(screen.getByTestId("monitoring-models").querySelector(".badge")).toHaveClass("neutral");
  });
});

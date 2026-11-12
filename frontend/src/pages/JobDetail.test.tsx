import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JobDetail from "./JobDetail";

const apiMock = vi.fn();
const navigateMock = vi.fn();
const canManageRef = { value: true };

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

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
  useProject: () => ({ selectedProject: { id: 7, role: "ML_ENGINEER" } }),
  userCanProject: () => canManageRef.value,
}));

const succeededJob = {
  id: 42,
  project_id: 7,
  dataset_id: 3,
  dataset_version_id: 30,
  split_id: null,
  name: "baseline",
  description: "",
  target_column: "target",
  problem_type: "classification",
  algorithm: "random_forest",
  hyperparameters: { n_estimators: 50 },
  preprocessing: {},
  feature_columns: ["a", "b"],
  metrics_config: [],
  resources: {},
  ratios: { train: 0.7, validation: 0.15, test: 0.15 },
  random_seed: 42,
  status: "succeeded",
  logs: "done",
  mlflow_run_id: "run-1",
  model_uri: "runs:/run-1/model",
  metrics: { accuracy: 0.9 },
  error_message: null,
  retry_count: 0,
  max_retries: 1,
  parent_job_id: null,
  retrain_source_job_id: 10,
  is_retrain: true,
  created_at: "2026-01-01T00:00:00Z",
  started_at: "2026-01-01T00:00:01Z",
  finished_at: "2026-01-01T00:00:05Z",
};

const pendingJob = { ...succeededJob, id: 43, status: "pending", is_retrain: false, retrain_source_job_id: null };

function renderPage(jobId = "42") {
  return render(
    <MemoryRouter initialEntries={[`/projects/7/jobs/${jobId}`]}>
      <Routes>
        <Route path="/projects/:projectId/jobs/:jobId" element={<JobDetail />} />
        <Route path="/projects/:projectId/jobs/:newJobId" element={<JobDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("JobDetail retrain", () => {
  beforeEach(() => {
    apiMock.mockReset();
    navigateMock.mockReset();
    canManageRef.value = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("guides failed training to its raw error and logs without changing retry or clone routes", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/44")) return {
        ...succeededJob,
        id: 44,
        status: "failed",
        logs: "ValueError: missing feature column",
        error_message: "Missing feature: temperature",
      };
      return [];
    });
    renderPage("44");

    const guidance = await screen.findByTestId("job-failure-guidance");
    expect(guidance).toHaveTextContent("학습이 실패했습니다 — 먼저 확인하세요");
    expect(guidance).toHaveTextContent("설정 복제");
    expect(screen.getByRole("alert")).toHaveTextContent("Missing feature: temperature");
    expect(within(guidance).getByRole("link", { name: "실행 로그 보기" })).toHaveAttribute("href", "#job-execution-logs");
    expect(screen.getByTestId("job-logs")).toHaveAttribute("id", "job-execution-logs");
    expect(screen.getByTestId("job-logs")).toHaveTextContent("ValueError: missing feature column");
    expect(screen.getByTestId("job-retry")).toBeInTheDocument();
    expect(screen.getByTestId("job-clone")).toHaveAttribute("href", "/projects/7/jobs/new?cloneFrom=44");
  });

  it("does not invent a failure cause and keeps log navigation for read-only viewers", async () => {
    canManageRef.value = false;
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/45")) return {
        ...succeededJob,
        id: 45,
        status: "failed",
        logs: "worker exited",
        error_message: null,
      };
      return [];
    });
    renderPage("45");

    const guidance = await screen.findByTestId("job-failure-guidance");
    expect(guidance).toHaveTextContent("오류 메시지가 제공되지 않았습니다.");
    expect(within(guidance).getByRole("link", { name: "실행 로그 보기" })).toHaveAttribute("href", "#job-execution-logs");
    expect(screen.queryByTestId("job-retry")).not.toBeInTheDocument();
    expect(screen.queryByTestId("job-clone")).not.toBeInTheDocument();
    expect(screen.getByTestId("job-logs")).toHaveTextContent("worker exited");
  });

  it("does not show failure guidance for cancelled, pending, or succeeded jobs", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/46")) return { ...succeededJob, id: 46, status: "cancelled" };
      if (path.endsWith("/jobs/43")) return pendingJob;
      if (path.endsWith("/jobs/42")) return succeededJob;
      return [];
    });
    const view = renderPage("46");
    await screen.findByTestId("job-logs");
    expect(screen.queryByTestId("job-failure-guidance")).not.toBeInTheDocument();

    view.unmount();
    const pendingView = renderPage("43");
    await screen.findByTestId("job-logs");
    expect(screen.queryByTestId("job-failure-guidance")).not.toBeInTheDocument();

    pendingView.unmount();
    renderPage("42");
    await screen.findByTestId("job-retrain");
    expect(screen.queryByTestId("job-failure-guidance")).not.toBeInTheDocument();
  });

  it("does not expose unavailable retry actions to viewers and shows a useful empty-log fallback", async () => {
    canManageRef.value = false;
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/47")) return {
        ...succeededJob,
        id: 47,
        status: "failed",
        logs: "",
        error_message: "Training failed: invalid feature",
      };
      return [];
    });
    renderPage("47");

    const guidance = await screen.findByTestId("job-failure-guidance");
    expect(guidance).toHaveTextContent("학습 권한이 있는 담당자에게 문의하세요.");
    expect(guidance).not.toHaveTextContent("동일 설정으로 다시 시도할 경우");
    expect(screen.getByRole("alert")).toHaveTextContent("Training failed: invalid feature");
    expect(screen.getByTestId("job-logs")).toHaveTextContent("기록된 실행 로그가 없습니다.");
    expect(screen.queryByTestId("job-retry")).not.toBeInTheDocument();
    expect(screen.queryByTestId("job-clone")).not.toBeInTheDocument();
  });

  it("shows Retrain on succeeded jobs only", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/42")) return succeededJob;
      return [];
    });
    renderPage("42");
    expect(await screen.findByTestId("job-retrain")).toBeInTheDocument();
    expect(screen.queryByTestId("job-retry")).not.toBeInTheDocument();
    expect(screen.getAllByText(/데이터셋 #3/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/버전 ID #30/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/· v30/)).not.toBeInTheDocument();
  });

  it("hides Retrain on non-succeeded jobs", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/43")) return pendingJob;
      return [];
    });
    renderPage("43");
    await screen.findByText("baseline");
    expect(screen.queryByTestId("job-retrain")).not.toBeInTheDocument();
  });

  it("opens retrain dialog with read-only source summary and submits", async () => {
    const versions = [
      {
        id: 30,
        dataset_id: 3,
        project_id: 7,
        version: 1,
        original_filename: "v1.csv",
        format: "csv",
        row_count: 10,
        column_count: 3,
        columns: ["a", "b", "target"],
        dtypes: {},
        stats: {},
        source_type: "upload",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: 31,
        dataset_id: 3,
        project_id: 7,
        version: 2,
        original_filename: "v2.csv",
        format: "csv",
        row_count: 12,
        column_count: 3,
        columns: ["a", "b", "target"],
        dtypes: {},
        stats: {},
        source_type: "feedback_materialization",
        created_at: "2026-01-02T00:00:00Z",
      },
    ];
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/jobs/42") && (!init || init.method === undefined)) return succeededJob;
      if (path.endsWith("/datasets/3/versions")) return versions;
      if (path.endsWith("/dataset-versions/31/splits")) return [];
      if (path.endsWith("/retrain")) {
        return { ...succeededJob, id: 99, name: "baseline (retrain)", dataset_version_id: 31, is_retrain: true, retrain_source_job_id: 42, status: "pending" };
      }
      return [];
    });
    renderPage("42");
    const trigger = await screen.findByTestId("job-retrain");
    trigger.focus();
    fireEvent.click(trigger);
    const drawer = await screen.findByTestId("job-retrain-dialog");
    expect(within(drawer).getByRole("dialog", { name: /전체 재학습.*학습 작업 #42/ })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("drawer-panel")).toBeVisible();
    expect(screen.getByRole("button", { name: "닫기" })).toBeInTheDocument();
    expect(screen.getByText(/기존 학습 데이터 버전이 선택되어 있습니다/)).toBeInTheDocument();
    expect(screen.getByText("원본 학습 설정 보기 (고급)")).toBeInTheDocument();
    expect(screen.getByTestId("retrain-dataset-version")).toHaveTextContent("피드백 반영");
    await waitFor(() => expect(screen.getByTestId("retrain-dataset-version")).toHaveFocus());
    expect(await screen.findByTestId("retrain-source-summary")).toHaveTextContent("target");
    expect(screen.getByTestId("retrain-targets")).toHaveTextContent("target");
    expect(screen.getByTestId("retrain-source-summary")).toHaveTextContent("random forest");
    fireEvent.change(screen.getByTestId("retrain-dataset-version"), { target: { value: "31" } });
    expect(screen.queryByText(/기존 학습 데이터 버전이 선택되어 있습니다/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("retrain-name"), { target: { value: "baseline v2 retrain" } });
    fireEvent.click(screen.getByTestId("retrain-submit"));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/jobs/42/retrain",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            dataset_version_id: 31,
            split_id: null,
            name: "baseline v2 retrain",
          }),
        }),
      );
    });
    expect(navigateMock).toHaveBeenCalledWith("/projects/7/jobs/99");
  });

  it("closes the retrain drawer with Escape and restores focus to the trigger", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/42")) return succeededJob;
      if (path.endsWith("/datasets/3/versions")) return [];
      return [];
    });
    renderPage("42");
    const trigger = await screen.findByTestId("job-retrain");
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByTestId("job-retrain-dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("job-retrain-dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("shows retrain lineage link on retrained jobs", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/42")) return succeededJob;
      return [];
    });
    renderPage("42");
    const lineage = await screen.findByTestId("job-retrain-lineage");
    expect(lineage).toHaveTextContent("학습 작업 #10");
    expect(lineage.querySelector("a")).toHaveAttribute("href", "/projects/7/jobs/10");
  });

  it("shows target columns label for multi-output jobs", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/42")) {
        return {
          ...succeededJob,
          target_column: "target_a",
          target_columns: ["target_a", "target_b"],
          problem_type: "regression",
        };
      }
      return [];
    });
    renderPage("42");
    const targetRow = await screen.findByTestId("job-target-columns");
    expect(targetRow).toHaveTextContent("Targets");
    expect(targetRow).toHaveTextContent("target_a");
    expect(targetRow).toHaveTextContent("target_b");
    expect(targetRow.textContent).not.toMatch(/target 0|target\[0\]/i);
  });

  it("opens register dialog with default model name and submits custom name", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/jobs/42") && (!init || init.method === undefined)) return succeededJob;
      if (path.endsWith("/models/register") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return {
          id: 5,
          project_id: 7,
          name: body.name,
          version: "1",
          lifecycle: "CANDIDATE",
          mlflow_run_id: "run-1",
          model_uri: "runs:/run-1/model",
          metrics: {},
          metadata: {},
          gates_passed: false,
          gate_results: {},
          approval_comment: null,
          training_job_id: 42,
          created_at: "2026-01-01T00:00:00Z",
        };
      }
      return [];
    });
    renderPage("42");
    fireEvent.click(await screen.findByTestId("register-model"));
    const dialog = await screen.findByTestId("register-model-dialog");
    expect(dialog).toBeInTheDocument();
    const nameInput = screen.getByTestId("register-model-name") as HTMLInputElement;
    expect(nameInput.value).toBe("baseline");
    fireEvent.change(nameInput, { target: { value: "ridge-multi-output" } });
    fireEvent.click(screen.getByTestId("register-model-submit"));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/models/register",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            training_job_id: 42,
            name: "ridge-multi-output",
          }),
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId("register-model-dialog")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("job-registered-model-link")).toHaveTextContent("운영 모델은 자동으로 변경되지 않습니다");
    expect(within(screen.getByTestId("job-registered-model-link")).getByRole("link")).toHaveAttribute(
      "href", "/projects/7/models/5",
    );
    expect(screen.getByTestId("retrain-registered-model")).toHaveAttribute("href", "/projects/7/models/5");
  });

  it("shows resolved problem type for succeeded auto regression jobs", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/42")) {
        return {
          ...succeededJob,
          problem_type: "auto",
          metrics: { val_rmse: 0.42, rmse: 0.5, val_r2: 0.81 },
          is_retrain: false,
          retrain_source_job_id: null,
        };
      }
      return [];
    });
    renderPage("42");
    expect(await screen.findByTestId("job-problem-type")).toHaveTextContent("Regression");
  });

  it("shows Continue training for eligible SGD jobs and submits continue endpoint", async () => {
    const sgdJob = {
      ...succeededJob,
      algorithm: "sgd_classifier",
      is_retrain: false,
      retrain_source_job_id: null,
      continued_from_job_id: null,
      is_continued_training: false,
      training_mode: "fresh",
    };
    const versions = [
      {
        id: 30,
        dataset_id: 3,
        project_id: 7,
        version: 1,
        original_filename: "v1.csv",
        format: "csv",
        row_count: 10,
        column_count: 3,
        columns: ["a", "b", "target"],
        dtypes: {},
        stats: {},
        source_type: "upload",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: 31,
        dataset_id: 3,
        project_id: 7,
        version: 2,
        original_filename: "v2.csv",
        format: "csv",
        row_count: 12,
        column_count: 3,
        columns: ["a", "b", "target"],
        dtypes: {},
        stats: {},
        source_type: "upload",
        created_at: "2026-01-02T00:00:00Z",
      },
    ];
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes("/training/algorithms")) {
        return {
          algorithms: [
            {
              id: "sgd_classifier",
              display_name: "SGD classifier",
              problem_types: ["classification"],
              supports_continued_training: true,
              continued_training_strategy: "partial_fit",
              default_hyperparameters: {},
              supported_hyperparameters: [],
              hyperparameters: [],
            },
          ],
        };
      }
      if (path.endsWith("/jobs/42") && (!init || init.method === undefined)) return sgdJob;
      if (path.endsWith("/datasets/3/versions")) return versions;
      if (path.endsWith("/dataset-versions/31/splits")) return [];
      if (path.endsWith("/continue") && init?.method === "POST") {
        return {
          ...sgdJob,
          id: 88,
          name: "baseline (continued)",
          dataset_version_id: 31,
          continued_from_job_id: 42,
          is_continued_training: true,
          training_mode: "continued",
          status: "pending",
        };
      }
      return [];
    });
    renderPage("42");
    expect(await screen.findByTestId("job-retrain")).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId("job-continue"));
    expect(await screen.findByTestId("job-continue-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("continue-strategy")).toHaveTextContent("partial_fit");
    expect(screen.getByTestId("continue-batch-hint")).toHaveTextContent("update batch");
    const versionSelect = screen.getByTestId("continue-dataset-version") as HTMLSelectElement;
    expect(versionSelect.value).toBe("31");
    expect(Array.from(versionSelect.options).map((o) => o.value)).not.toContain("30");
    fireEvent.change(screen.getByTestId("continue-name"), {
      target: { value: "sgd continued v2" },
    });
    fireEvent.click(screen.getByTestId("continue-submit"));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/jobs/42/continue",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            dataset_version_id: 31,
            split_id: null,
            name: "sgd continued v2",
          }),
        }),
      );
    });
    expect(navigateMock).toHaveBeenCalledWith("/projects/7/jobs/88");
  });

  it("hides Continue training for unsupported algorithms", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes("/training/algorithms")) {
        return {
          algorithms: [
            {
              id: "random_forest",
              display_name: "Random forest",
              problem_types: ["classification"],
              supports_continued_training: false,
              continued_training_strategy: "unsupported",
              default_hyperparameters: {},
              supported_hyperparameters: [],
              hyperparameters: [],
            },
          ],
        };
      }
      if (path.endsWith("/jobs/42")) return succeededJob;
      return [];
    });
    renderPage("42");
    expect(await screen.findByTestId("job-retrain")).toBeInTheDocument();
    expect(screen.queryByTestId("job-continue")).not.toBeInTheDocument();
    expect(screen.getByTestId("retrain-continue-hint")).toHaveTextContent(
      "이어서 학습을 지원하지 않습니다",
    );
  });

  it("shows continued lineage on continued jobs", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/42")) {
        return {
          ...succeededJob,
          algorithm: "sgd_classifier",
          is_retrain: false,
          retrain_source_job_id: null,
          continued_from_job_id: 10,
          is_continued_training: true,
          training_mode: "continued",
        };
      }
      if (path.includes("/training/algorithms")) {
        return {
          algorithms: [
            {
              id: "sgd_classifier",
              display_name: "SGD classifier",
              problem_types: ["classification"],
              supports_continued_training: true,
              continued_training_strategy: "partial_fit",
              default_hyperparameters: {},
              supported_hyperparameters: [],
              hyperparameters: [],
            },
          ],
        };
      }
      return [];
    });
    renderPage("42");
    const lineage = await screen.findByTestId("job-continue-lineage");
    expect(lineage).toHaveTextContent("학습 작업 #10");
    expect(lineage.querySelector("a")).toHaveAttribute("href", "/projects/7/jobs/10");
    expect(screen.getByTestId("job-training-mode")).toHaveTextContent("이어서 학습");
    expect(screen.getByTestId("job-continue-lineage")).toHaveTextContent("이어서 학습 원본");
    expect(screen.getByTestId("entity-lineage")).toHaveTextContent("이어서 학습 원본");
  });

  it("shows time-ordered split metadata on job detail", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/42")) {
        return {
          ...succeededJob,
          split_id: 12,
          split_strategy: "time",
          time_column: "event_time",
          is_retrain: false,
          retrain_source_job_id: null,
        };
      }
      return [];
    });
    renderPage("42");
    expect(await screen.findByTestId("job-split-strategy-label")).toHaveTextContent("Time ordered");
    expect(screen.getByTestId("job-time-column-label")).toHaveTextContent("event_time");
    expect(screen.getByTestId("job-data-split")).toHaveTextContent("저장된 분할 #12");
  });

  it("shows forecasting contract fields on job detail", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/42")) {
        return {
          ...succeededJob,
          target_column: "sales",
          target_columns: ["sales"],
          problem_type: "regression",
          algorithm: "ridge",
          metrics: { rmse: 1.2, mae: 0.8, r2: 0.9 },
          split_strategy: "time",
          time_column: "event_time",
          training_task: "forecasting",
          forecast_strategy: "direct_multioutput",
          forecast_horizons: [1, 2, 3],
          forecast_output_names: ["sales__t_plus_1", "sales__t_plus_2", "sales__t_plus_3"],
          is_retrain: false,
          retrain_source_job_id: null,
        };
      }
      return [];
    });
    renderPage("42");
    expect(await screen.findByTestId("job-training-task")).toHaveTextContent("Forecasting");
    expect(screen.getByTestId("job-forecast-strategy")).toHaveTextContent(
      "직접 다중 출력 (Direct multi-output)",
    );
    expect(screen.getByTestId("job-forecast-horizons")).toHaveTextContent("1, 2, 3");
    expect(screen.getByTestId("job-forecast-outputs")).toHaveTextContent("sales__t_plus_1");
    expect(screen.getByTestId("job-target-columns")).toHaveTextContent("sales");
  });

  it("keeps tabular job detail without forecasting fields", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/42")) {
        return {
          ...succeededJob,
          training_task: "tabular",
          forecast_strategy: null,
          forecast_horizons: [],
          forecast_output_names: [],
          is_retrain: false,
          retrain_source_job_id: null,
        };
      }
      return [];
    });
    renderPage("42");
    expect(await screen.findByTestId("job-training-task")).toHaveTextContent("Tabular");
    expect(screen.queryByTestId("job-forecast-strategy")).not.toBeInTheDocument();
    expect(screen.queryByTestId("job-forecast-horizons")).not.toBeInTheDocument();
  });

  it("shows distinct per-metric help tips on evaluation cards", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/42")) {
        return {
          ...succeededJob,
          problem_type: "regression",
          algorithm: "ridge",
          metrics: {
            val_rmse: 18.128,
            val_mae: 12.4,
            val_r2: 0.81,
            test_rmse: 19.05,
          },
          is_retrain: false,
          retrain_source_job_id: null,
        };
      }
      return [];
    });
    renderPage("42");

    const summary = await screen.findByTestId("metric-summary");
    const cards = Array.from(summary.querySelectorAll("[data-testid^='metric-card-']"));
    expect(cards.map((card) => card.getAttribute("data-testid"))).toEqual([
      "metric-card-val_rmse",
      "metric-card-val_mae",
      "metric-card-val_r2",
      "metric-card-test_rmse",
    ]);
    expect(within(cards[0] as HTMLElement).getByText("18.128")).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText("12.400")).toBeInTheDocument();
    expect(within(cards[2] as HTMLElement).getByText("0.810")).toBeInTheDocument();
    expect(within(cards[3] as HTMLElement).getByText("19.050")).toBeInTheDocument();

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
    expect(screen.getByTestId("metric-primary-hint")).toHaveTextContent("검증 · RMSE: 18.128");
    expect(within(cards[0] as HTMLElement).getByText("검증 · RMSE")).toBeInTheDocument();
    expect(within(cards[3] as HTMLElement).getByText("테스트 · RMSE")).toBeInTheDocument();
  });

  it("uses the same Korean classification metric names as the model registry", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/jobs/42")) {
        return {
          ...succeededJob,
          metrics: {
            val_accuracy: 0.95,
            val_f1_weighted: 0.94,
            val_precision_weighted: 0.93,
            val_recall_weighted: 0.92,
          },
        };
      }
      return [];
    });
    renderPage("42");

    expect(await screen.findByTestId("metric-card-val_accuracy")).toHaveTextContent("검증 · 정확도");
    expect(screen.getByTestId("metric-card-val_f1_weighted")).toHaveTextContent("검증 · 가중 F1 점수");
    expect(screen.getByTestId("metric-card-val_precision_weighted")).toHaveTextContent("검증 · 가중 정밀도");
    expect(screen.getByTestId("metric-card-val_recall_weighted")).toHaveTextContent("검증 · 가중 재현율");
    expect(screen.getByTestId("metric-primary-hint")).toHaveTextContent("검증 · 정확도: 0.950");
  });

});

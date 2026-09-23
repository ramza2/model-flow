import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import JobContinueTrainingDialog from "./JobContinueTrainingDialog";

const apiMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

const sourceJob = {
  id: 42,
  project_id: 7,
  dataset_id: 3,
  dataset_version_id: 30,
  split_id: null,
  name: "sgd-baseline",
  description: "",
  target_column: "target",
  problem_type: "classification",
  algorithm: "sgd_classifier",
  hyperparameters: { alpha: 0.0001 },
  feature_columns: ["a", "b"],
  status: "succeeded",
  logs: "",
  mlflow_run_id: "run-1",
  model_uri: "runs:/run-1/model",
  metrics: {},
  error_message: null,
  retry_count: 0,
  max_retries: 1,
  parent_job_id: null,
  retrain_source_job_id: null,
  is_retrain: false,
  continued_from_job_id: null,
  is_continued_training: false,
  training_mode: "fresh",
  created_at: "2026-01-01T00:00:00Z",
  started_at: null,
  finished_at: null,
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
    id: 29,
    dataset_id: 3,
    project_id: 7,
    version: 0,
    original_filename: "old.csv",
    format: "csv",
    row_count: 8,
    column_count: 3,
    columns: ["a", "b", "target"],
    dtypes: {},
    stats: {},
    source_type: "upload",
    created_at: "2025-12-01T00:00:00Z",
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

describe("JobContinueTrainingDialog", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("filters to newer DatasetVersions and posts /continue", async () => {
    const onCreated = vi.fn();
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
      if (path.endsWith("/datasets/3/versions")) return versions;
      if (path.includes("/splits")) return [];
      if (path.endsWith("/continue") && init?.method === "POST") {
        return { ...sourceJob, id: 99, continued_from_job_id: 42, is_continued_training: true };
      }
      return [];
    });

    render(
      <JobContinueTrainingDialog
        projectId="7"
        sourceJob={sourceJob as never}
        onClose={() => undefined}
        onCreated={onCreated}
      />,
    );

    expect(await screen.findByTestId("continue-strategy")).toHaveTextContent("partial_fit");
    const select = screen.getByTestId("continue-dataset-version") as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value).filter(Boolean);
    expect(values).toEqual(["31"]);
    fireEvent.click(screen.getByTestId("continue-submit"));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/jobs/42/continue",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            dataset_version_id: 31,
            split_id: null,
            name: "sgd-baseline (continued)",
          }),
        }),
      );
    });
    expect(onCreated).toHaveBeenCalled();
  });

  it("disables submit when algorithm capability is unsupported", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes("/training/algorithms")) {
        return {
          algorithms: [
            {
              id: "sgd_classifier",
              display_name: "SGD classifier",
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
      if (path.endsWith("/datasets/3/versions")) return versions;
      return [];
    });

    render(
      <JobContinueTrainingDialog
        projectId="7"
        sourceJob={sourceJob as never}
        onClose={() => undefined}
        onCreated={() => undefined}
      />,
    );

    expect(await screen.findByTestId("continue-unsupported-reason")).toBeInTheDocument();
    expect(screen.getByTestId("continue-submit")).toBeDisabled();
  });
});

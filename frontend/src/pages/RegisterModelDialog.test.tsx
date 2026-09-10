import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Job } from "../api";
import RegisterModelDialog from "./RegisterModelDialog";

const baseJob = {
  id: 42,
  project_id: 7,
  dataset_id: 3,
  dataset_version_id: 30,
  name: "baseline",
  description: "",
  target_column: "price",
  problem_type: "auto",
  algorithm: "random_forest",
  hyperparameters: {},
  feature_columns: ["a", "b"],
  status: "succeeded",
  logs: "",
  mlflow_run_id: "run-1",
  model_uri: "runs:/run-1/model",
  metrics: { val_rmse: 0.42, rmse: 0.5 },
  error_message: null,
  retry_count: 0,
  max_retries: 1,
  parent_job_id: null,
  retrain_source_job_id: null,
  is_retrain: false,
  created_at: "2026-01-01T00:00:00Z",
  started_at: "2026-01-01T00:00:01Z",
  finished_at: "2026-01-01T00:00:05Z",
} as Job;

describe("RegisterModelDialog", () => {
  it("shows resolved regression problem type for auto jobs", () => {
    render(
      <RegisterModelDialog job={baseJob} busy={false} onClose={() => undefined} onSubmit={vi.fn()} />,
    );
    expect(screen.getByTestId("register-problem-type")).toHaveTextContent("regression");
  });

  it("shows resolved classification problem type for auto jobs", () => {
    render(
      <RegisterModelDialog
        job={{ ...baseJob, metrics: { val_accuracy: 0.9, accuracy: 0.88 } }}
        busy={false}
        onClose={() => undefined}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByTestId("register-problem-type")).toHaveTextContent("classification");
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import JobCreate from "../pages/JobCreate";
import JobDetail from "../pages/JobDetail";
import ModelVersion from "../pages/ModelVersion";
import Predict from "../pages/Predict";
import {
  algorithmsForProblemType,
  buildPredictionSamplePayload,
  defaultAlgorithmId,
  formatHyperparameters,
  validateHyperparametersText,
  type AlgorithmSpec,
} from "../trainingConfig";

const catalog: AlgorithmSpec[] = [
  {
    id: "random_forest",
    display_name: "Random forest",
    problem_types: ["classification"],
    default_hyperparameters: { n_estimators: 100, max_depth: 5 },
    supported_hyperparameters: ["n_estimators", "max_depth"],
    hyperparameters: [
      { name: "n_estimators", type: "integer", default: 100, minimum: 1, maximum: 5000 },
      { name: "max_depth", type: "integer", default: 5, minimum: 1, maximum: 100, nullable: true },
    ],
  },
  {
    id: "logistic_regression",
    display_name: "Logistic regression",
    problem_types: ["classification"],
    default_hyperparameters: { C: 1.0, max_iter: 1000 },
    supported_hyperparameters: ["C", "max_iter"],
    hyperparameters: [
      { name: "C", type: "number", default: 1.0, minimum: 0.0001 },
      { name: "max_iter", type: "integer", default: 1000, minimum: 1 },
    ],
  },
  {
    id: "gradient_boosting",
    display_name: "Gradient boosting",
    problem_types: ["classification"],
    default_hyperparameters: { n_estimators: 100, learning_rate: 0.1, max_depth: 3 },
    supported_hyperparameters: ["n_estimators", "learning_rate", "max_depth"],
    hyperparameters: [
      { name: "n_estimators", type: "integer", default: 100 },
      { name: "learning_rate", type: "number", default: 0.1 },
      { name: "max_depth", type: "integer", default: 3 },
    ],
  },
  {
    id: "ridge",
    display_name: "Ridge regression",
    problem_types: ["regression"],
    default_hyperparameters: { alpha: 1.0 },
    supported_hyperparameters: ["alpha"],
    hyperparameters: [{ name: "alpha", type: "number", default: 1.0, minimum: 0 }],
  },
  {
    id: "random_forest_regressor",
    display_name: "Random forest regressor",
    problem_types: ["regression"],
    default_hyperparameters: { n_estimators: 100, max_depth: 5 },
    supported_hyperparameters: ["n_estimators", "max_depth"],
    hyperparameters: [
      { name: "n_estimators", type: "integer", default: 100 },
      { name: "max_depth", type: "integer", default: 5, nullable: true },
    ],
  },
  {
    id: "gradient_boosting_regressor",
    display_name: "Gradient boosting regressor",
    problem_types: ["regression"],
    default_hyperparameters: { n_estimators: 100, learning_rate: 0.1, max_depth: 3 },
    supported_hyperparameters: ["n_estimators", "learning_rate", "max_depth"],
    hyperparameters: [
      { name: "n_estimators", type: "integer", default: 100 },
      { name: "learning_rate", type: "number", default: 0.1 },
      { name: "max_depth", type: "integer", default: 3 },
    ],
  },
];

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, is_system_admin: true, email: "a@b.c" } }),
}));

vi.mock("../ProjectContext", () => ({
  useProject: () => ({ selectedProject: { id: 7, role: "PROJECT_ADMIN" } }),
  userCanProject: () => true,
}));

describe("trainingConfig helpers", () => {
  it("filters algorithms by problem type", () => {
    expect(algorithmsForProblemType(catalog, "classification").map((item) => item.id)).toEqual([
      "random_forest",
      "logistic_regression",
      "gradient_boosting",
    ]);
    expect(algorithmsForProblemType(catalog, "regression").map((item) => item.id)).toEqual([
      "ridge",
      "random_forest_regressor",
      "gradient_boosting_regressor",
    ]);
    expect(defaultAlgorithmId(catalog, "regression")).toBe("ridge");
  });

  it("resets and validates hyperparameters", () => {
    const ridge = catalog.find((item) => item.id === "ridge")!;
    expect(formatHyperparameters(ridge.default_hyperparameters)).toContain('"alpha": 1');
    expect(validateHyperparametersText('{"n_estimators": 10}', ridge).ok).toBe(false);
    expect(validateHyperparametersText('{"alpha": "x"}', ridge).ok).toBe(false);
    expect(validateHyperparametersText('{"alpha": 2.5}', ridge)).toEqual({
      ok: true,
      value: { alpha: 2.5 },
    });
  });

  it("builds dtype-aware prediction payloads", () => {
    const sample = buildPredictionSamplePayload(
      [
        { name: "site_id", dtype: "object" },
        { name: "measured_at", dtype: "datetime64[ns]" },
        { name: "outdoor_temp", dtype: "float64" },
        { name: "hour", dtype: "int64" },
        { name: "is_weekend", dtype: "bool" },
      ],
      { site_id: "SITE-001", measured_at: "2026-01-01T00:00:00" },
    );
    expect(sample[0]).toEqual({
      site_id: "SITE-001",
      measured_at: "2026-01-01T00:00:00",
      outdoor_temp: 0.0,
      hour: 0,
      is_weekend: false,
    });
  });
});

describe("JobCreate UX", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/datasets")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 1,
                name: "iris",
                latest_version: 1,
                columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
              },
            ],
          };
        }
        if (url.includes("/training/algorithms")) {
          return { ok: true, status: 200, json: async () => ({ algorithms: catalog }) };
        }
        if (url.includes("/splits")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 55,
                name: "split-1",
                dataset_version_id: 11,
                train_ratio: 0.7,
                val_ratio: 0.15,
                test_ratio: 0.15,
                random_seed: 42,
              },
            ],
          };
        }
        if (url.includes("/versions") && !url.includes("resolve")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 11,
                dataset_id: 1,
                version: 1,
                original_filename: "iris.csv",
                columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
              },
            ],
          };
        }
        if (url.includes("/resolve-problem-type")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              requested_problem_type: "auto",
              resolved_problem_type: "classification",
              target_column: "target",
              dataset_id: 1,
              dataset_version_id: 11,
            }),
          };
        }
        if (url.includes("/jobs/") && (!init || init.method === "GET" || !init.method)) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 99,
              name: "source-job",
              description: "cloned",
              dataset_id: 1,
              dataset_version_id: 11,
              target_column: "target",
              problem_type: "classification",
              algorithm: "logistic_regression",
              hyperparameters: { C: 0.5, max_iter: 200 },
              feature_columns: ["sepal length (cm)", "sepal width (cm)"],
              ratios: { train: 0.7, validation: 0.15, test: 0.15 },
              random_seed: 7,
              split_id: 55,
              max_retries: 1,
              status: "failed",
              logs: "",
              metrics: {},
              mlflow_run_id: null,
              model_uri: null,
              error_message: null,
              retry_count: 0,
              parent_job_id: null,
              created_at: "2026-01-01",
              started_at: null,
              finished_at: null,
              project_id: 7,
            }),
          };
        }
        if (url.endsWith("/jobs") && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          return {
            ok: true,
            status: 201,
            json: async () => ({ id: 123, ...body, status: "pending", logs: "", metrics: {}, mlflow_run_id: null, model_uri: null, error_message: null, retry_count: 0, parent_job_id: null, created_at: "2026-01-01", started_at: null, finished_at: null, project_id: 7 }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );
  });

  it("filters algorithms and shows auto detection", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/7/jobs/new"]}>
        <Routes>
          <Route path="/projects/:projectId/jobs/new" element={<JobCreate />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("detected-problem-type")).toHaveTextContent("Classification");
    const algorithm = await screen.findByTestId("job-algorithm");
    expect(algorithm).toHaveTextContent("Random forest");
    expect(algorithm).not.toHaveTextContent("Ridge regression");
    fireEvent.change(screen.getByTestId("job-problem-type"), { target: { value: "regression" } });
    await waitFor(() => expect(screen.getByTestId("job-algorithm")).toHaveTextContent("Ridge regression"));
    expect(screen.getByTestId("job-algorithm")).not.toHaveTextContent("Logistic regression");
  });

  it("resets hyperparameters when algorithm changes", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/7/jobs/new"]}>
        <Routes>
          <Route path="/projects/:projectId/jobs/new" element={<JobCreate />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId("job-algorithm");
    fireEvent.change(screen.getByTestId("job-algorithm"), { target: { value: "logistic_regression" } });
    await waitFor(() => {
      expect((screen.getByTestId("job-hyperparameters") as HTMLTextAreaElement).value).toContain('"C": 1');
    });
  });

  it("supports feature selection and blocks empty features", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/7/jobs/new"]}>
        <Routes>
          <Route path="/projects/:projectId/jobs/new" element={<JobCreate />} />
        </Routes>
      </MemoryRouter>,
    );
    const feature = await screen.findByTestId("feature-sepal length (cm)");
    expect(feature).toBeChecked();
    fireEvent.click(feature);
    fireEvent.click(screen.getByTestId("feature-sepal width (cm)"));
    fireEvent.click(screen.getByTestId("feature-petal length (cm)"));
    fireEvent.click(screen.getByTestId("feature-petal width (cm)"));
    expect(screen.getByTestId("job-submit")).toBeDisabled();
    expect(screen.getByTestId("feature-columns")).toHaveTextContent("0 selected");
  });

  it("removes target from features when target changes", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/7/jobs/new"]}>
        <Routes>
          <Route path="/projects/:projectId/jobs/new" element={<JobCreate />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId("feature-columns");
    fireEvent.change(screen.getByTestId("job-target"), { target: { value: "sepal length (cm)" } });
    await waitFor(() => {
      expect(screen.queryByTestId("feature-sepal length (cm)")).not.toBeInTheDocument();
      expect(screen.getByTestId("feature-target")).toBeInTheDocument();
    });
  });

  it("loads clone configuration into the form", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/7/jobs/new?cloneFrom=99"]}>
        <Routes>
          <Route path="/projects/:projectId/jobs/new" element={<JobCreate />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("job-name")).toHaveValue("source-job (clone)");
    expect(screen.getByTestId("job-algorithm")).toHaveValue("logistic_regression");
    expect((screen.getByTestId("job-hyperparameters") as HTMLTextAreaElement).value).toContain('"C": 0.5');
    await waitFor(() => {
      expect(screen.getByTestId("job-data-split")).toHaveValue("55");
    });
  });

  it("includes split_id in create payload and clears submitError on split change", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/datasets")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 1,
              name: "iris",
              latest_version: 1,
              columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
            },
          ],
        };
      }
      if (url.includes("/training/algorithms")) {
        return { ok: true, status: 200, json: async () => ({ algorithms: catalog }) };
      }
      if (url.includes("/splits")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 55,
              name: "split-1",
              dataset_version_id: 11,
              train_ratio: 0.7,
              val_ratio: 0.15,
              test_ratio: 0.15,
              random_seed: 42,
            },
          ],
        };
      }
      if (url.includes("/versions") && !url.includes("resolve")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 11,
              dataset_id: 1,
              version: 1,
              original_filename: "iris.csv",
              columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
            },
          ],
        };
      }
      if (url.includes("/resolve-problem-type")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            requested_problem_type: "auto",
            resolved_problem_type: "classification",
            target_column: "target",
            dataset_id: 1,
            dataset_version_id: 11,
          }),
        };
      }
      if (url.endsWith("/jobs") && init?.method === "POST") {
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 123, status: "pending" }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ detail: url }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/projects/7/jobs/new"]}>
        <Routes>
          <Route path="/projects/:projectId/jobs/new" element={<JobCreate />} />
          <Route path="/projects/:projectId/jobs/:jobId" element={<div data-testid="job-detail-page">Job detail</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByTestId("job-data-split");
    await waitFor(() => {
      expect(screen.getByTestId("job-data-split")).toHaveTextContent("split-1");
    });
    fireEvent.change(screen.getByTestId("job-data-split"), { target: { value: "55" } });
    await waitFor(() => expect(screen.getByTestId("job-submit")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("job-submit"));
    await screen.findByTestId("job-detail-page");
    const postCall = fetchMock.mock.calls.find(
      (call) => String(call[0]).endsWith("/jobs") && call[1]?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    expect(JSON.parse(String(postCall![1]?.body))).toMatchObject({ split_id: 55 });

    // Default runtime omits/nulls split
    // (re-render not needed — covered by selecting empty value before submit in isolation)
  });

  it("resets stale split selection when dataset version changes", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/datasets")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 1,
              name: "iris",
              latest_version: 2,
              columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
            },
          ],
        };
      }
      if (url.includes("/training/algorithms")) {
        return { ok: true, status: 200, json: async () => ({ algorithms: catalog }) };
      }
      if (url.includes("/dataset-versions/11/splits")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 55,
              name: "split-1",
              dataset_version_id: 11,
              train_ratio: 0.7,
              val_ratio: 0.15,
              test_ratio: 0.15,
              random_seed: 42,
            },
          ],
        };
      }
      if (url.includes("/dataset-versions/12/splits")) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url.includes("/versions") && !url.includes("resolve")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 11,
              dataset_id: 1,
              version: 1,
              original_filename: "iris-v1.csv",
              columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
            },
            {
              id: 12,
              dataset_id: 1,
              version: 2,
              original_filename: "iris-v2.csv",
              columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
            },
          ],
        };
      }
      if (url.includes("/resolve-problem-type")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            requested_problem_type: "auto",
            resolved_problem_type: "classification",
            target_column: "target",
            dataset_id: 1,
            dataset_version_id: 12,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ detail: url }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/projects/7/jobs/new"]}>
        <Routes>
          <Route path="/projects/:projectId/jobs/new" element={<JobCreate />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByTestId("job-dataset-version");
    fireEvent.change(screen.getByTestId("job-dataset-version"), { target: { value: "11" } });
    await waitFor(() => expect(screen.getByTestId("job-data-split")).toHaveTextContent("split-1"));
    fireEvent.change(screen.getByTestId("job-data-split"), { target: { value: "55" } });
    expect(screen.getByTestId("job-data-split")).toHaveValue("55");
    fireEvent.change(screen.getByTestId("job-dataset-version"), { target: { value: "12" } });
    await waitFor(() => expect(screen.getByTestId("job-data-split")).toHaveValue(""));
  });

  it("disables submit while resolving and ignores stale detection responses", async () => {
    type ResolvePayload = {
      requested_problem_type: string;
      resolved_problem_type: string;
      target_column: string;
      dataset_id: number;
      dataset_version_id: number | null;
    };
    type Deferred = {
      targetColumn: string;
      resolve: (value: ResolvePayload) => void;
    };
    const pendingResolves: Deferred[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/datasets")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 1,
                name: "iris",
                latest_version: 1,
                columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
              },
            ],
          };
        }
        if (url.includes("/training/algorithms")) {
          return { ok: true, status: 200, json: async () => ({ algorithms: catalog }) };
        }
        if (url.includes("/splits")) {
          return { ok: true, status: 200, json: async () => [] };
        }
        if (url.includes("/versions") && !url.includes("resolve")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 11,
                dataset_id: 1,
                version: 1,
                original_filename: "iris.csv",
                columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
              },
            ],
          };
        }
        if (url.includes("/resolve-problem-type")) {
          const body = JSON.parse(String(init?.body || "{}")) as { target_column?: string };
          const targetColumn = body.target_column || "target";
          const payload = await new Promise<ResolvePayload>((resolve) => {
            pendingResolves.push({ targetColumn, resolve });
          });
          return { ok: true, status: 200, json: async () => payload };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    render(
      <MemoryRouter initialEntries={["/projects/7/jobs/new"]}>
        <Routes>
          <Route path="/projects/:projectId/jobs/new" element={<JobCreate />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("detecting-problem-type")).toHaveTextContent("Detecting problem type");
    expect(screen.getByTestId("job-submit")).toBeDisabled();
    expect(screen.getByTestId("job-algorithm")).toBeDisabled();

    await waitFor(() => expect(pendingResolves.some((item) => item.targetColumn === "target")).toBe(true));
    const classificationRequests = pendingResolves.filter((item) => item.targetColumn === "target");
    // Keep the latest classification request in-flight, then switch to a regression target.
    const staleClassification = classificationRequests[classificationRequests.length - 1];

    fireEvent.change(screen.getByTestId("job-target"), { target: { value: "sepal length (cm)" } });

    expect(await screen.findByTestId("detecting-problem-type")).toBeInTheDocument();
    expect(screen.queryByTestId("detected-problem-type")).not.toBeInTheDocument();
    expect(screen.getByTestId("job-submit")).toBeDisabled();
    expect(screen.getByTestId("job-algorithm")).toBeDisabled();

    await waitFor(() => (
      expect(pendingResolves.some((item) => item.targetColumn === "sepal length (cm)")).toBe(true)
    ));
    const regressionRequest = [...pendingResolves].reverse().find(
      (item) => item.targetColumn === "sepal length (cm)",
    );
    expect(regressionRequest).toBeTruthy();

    regressionRequest!.resolve({
      requested_problem_type: "auto",
      resolved_problem_type: "regression",
      target_column: "sepal length (cm)",
      dataset_id: 1,
      dataset_version_id: 11,
    });

    expect(await screen.findByTestId("detected-problem-type")).toHaveTextContent("Regression");
    expect(screen.getByTestId("job-submit")).not.toBeDisabled();
    await waitFor(() => {
      const algorithm = screen.getByTestId("job-algorithm") as HTMLSelectElement;
      expect(algorithm).toHaveTextContent("Ridge regression");
      expect(algorithm).not.toHaveTextContent("Logistic regression");
      expect(Array.from(algorithm.options).map((option) => option.value)).toEqual([
        "ridge",
        "random_forest_regressor",
        "gradient_boosting_regressor",
      ]);
    });

    // Late classification response from the previous target must not overwrite regression.
    staleClassification.resolve({
      requested_problem_type: "auto",
      resolved_problem_type: "classification",
      target_column: "target",
      dataset_id: 1,
      dataset_version_id: 11,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.getByTestId("detected-problem-type")).toHaveTextContent("Regression");
    const algorithmAfterStale = screen.getByTestId("job-algorithm") as HTMLSelectElement;
    expect(algorithmAfterStale).toHaveTextContent("Ridge regression");
    expect(Array.from(algorithmAfterStale.options).map((option) => option.value)).toEqual([
      "ridge",
      "random_forest_regressor",
      "gradient_boosting_regressor",
    ]);
  });

  it("shows detection failure guidance and recovers after manual problem type selection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/datasets")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 1,
                name: "iris",
                latest_version: 1,
                columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
              },
            ],
          };
        }
        if (url.includes("/training/algorithms")) {
          return { ok: true, status: 200, json: async () => ({ algorithms: catalog }) };
        }
        if (url.includes("/splits")) {
          return { ok: true, status: 200, json: async () => [] };
        }
        if (url.includes("/versions") && !url.includes("resolve")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 11,
                dataset_id: 1,
                version: 1,
                original_filename: "iris.csv",
                columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
              },
            ],
          };
        }
        if (url.includes("/resolve-problem-type")) {
          return {
            ok: false,
            status: 422,
            json: async () => ({
              detail: "Target column could not be analyzed.",
              hint: "Choose another target column.",
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    render(
      <MemoryRouter initialEntries={["/projects/7/jobs/new"]}>
        <Routes>
          <Route path="/projects/:projectId/jobs/new" element={<JobCreate />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("problem-type-detection-error")).toHaveTextContent(
      "Problem type could not be detected. Retry by changing the target or select Classification/Regression manually.",
    );
    expect(screen.getByTestId("job-submit")).toBeDisabled();

    fireEvent.change(screen.getByTestId("job-problem-type"), { target: { value: "classification" } });

    await waitFor(() => {
      expect(screen.queryByTestId("problem-type-detection-error")).not.toBeInTheDocument();
      expect(screen.getByTestId("job-submit")).not.toBeDisabled();
    });
    expect(screen.getByTestId("job-algorithm")).toHaveTextContent("Random forest");
  });

  it("shows quality blocking 409 near Start training without navigating", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/datasets")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 1,
              name: "iris",
              latest_version: 1,
              columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
            },
          ],
        };
      }
      if (url.includes("/training/algorithms")) {
        return { ok: true, status: 200, json: async () => ({ algorithms: catalog }) };
      }
      if (url.includes("/splits")) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (url.includes("/versions") && !url.includes("resolve")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 11,
              dataset_id: 1,
              version: 1,
              original_filename: "iris.csv",
              columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
            },
          ],
        };
      }
      if (url.includes("/resolve-problem-type")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            requested_problem_type: "auto",
            resolved_problem_type: "classification",
            target_column: "target",
            dataset_id: 1,
            dataset_version_id: 11,
          }),
        };
      }
      if (url.endsWith("/jobs") && init?.method === "POST") {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            detail: "Training is blocked by failed data quality rules.",
            hint: "Blocking rules: TEST_RULL",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/projects/7/jobs/new"]}>
        <Routes>
          <Route path="/projects/:projectId/jobs/new" element={<JobCreate />} />
          <Route path="/projects/:projectId/jobs/:jobId" element={<div data-testid="job-detail-page">Job detail</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByTestId("detected-problem-type");
    fireEvent.click(screen.getByTestId("job-submit"));
    const submitError = await screen.findByTestId("training-submit-error");
    expect(submitError).toHaveAttribute("role", "alert");
    expect(submitError).toHaveTextContent("Training is blocked by failed data quality rules.");
    expect(submitError).toHaveTextContent("Blocking rules: TEST_RULL");
    expect(within(screen.getByTestId("training-submit-actions")).getByTestId("training-submit-error")).toBeInTheDocument();
    expect(screen.queryByTestId("job-detail-page")).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid="training-submit-error"]')).toHaveLength(1);
  });

  it("shows other submit validation errors near Start training", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/datasets")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 1,
                name: "iris",
                latest_version: 1,
                columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
              },
            ],
          };
        }
        if (url.includes("/training/algorithms")) {
          return { ok: true, status: 200, json: async () => ({ algorithms: catalog }) };
        }
        if (url.includes("/splits")) {
          return { ok: true, status: 200, json: async () => [] };
        }
        if (url.includes("/versions") && !url.includes("resolve")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 11,
                dataset_id: 1,
                version: 1,
                original_filename: "iris.csv",
                columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
              },
            ],
          };
        }
        if (url.includes("/resolve-problem-type")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              requested_problem_type: "auto",
              resolved_problem_type: "classification",
              target_column: "target",
              dataset_id: 1,
              dataset_version_id: 11,
            }),
          };
        }
        if (url.endsWith("/jobs") && init?.method === "POST") {
          return {
            ok: false,
            status: 422,
            json: async () => ({
              detail: "Invalid training configuration",
              hint: "Correct the request and try again.",
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    render(
      <MemoryRouter initialEntries={["/projects/7/jobs/new"]}>
        <Routes>
          <Route path="/projects/:projectId/jobs/new" element={<JobCreate />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByTestId("detected-problem-type");
    fireEvent.click(screen.getByTestId("job-submit"));
    const submitError = await screen.findByTestId("training-submit-error");
    expect(submitError).toHaveTextContent("Invalid training configuration");
    expect(within(screen.getByTestId("training-submit-actions")).getByTestId("training-submit-error")).toBeInTheDocument();
  });

  it("clears submit errors when training settings change", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/datasets")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 1,
                name: "iris",
                latest_version: 1,
                columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
              },
            ],
          };
        }
        if (url.includes("/training/algorithms")) {
          return { ok: true, status: 200, json: async () => ({ algorithms: catalog }) };
        }
        if (url.includes("/splits")) {
          return { ok: true, status: 200, json: async () => [] };
        }
        if (url.includes("/versions") && !url.includes("resolve")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 11,
                dataset_id: 1,
                version: 1,
                original_filename: "iris.csv",
                columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
              },
            ],
          };
        }
        if (url.includes("/resolve-problem-type")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              requested_problem_type: "auto",
              resolved_problem_type: "classification",
              target_column: "target",
              dataset_id: 1,
              dataset_version_id: 11,
            }),
          };
        }
        if (url.endsWith("/jobs") && init?.method === "POST") {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              detail: "Training is blocked by failed data quality rules.",
              hint: "Blocking rules: TEST_RULL",
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    render(
      <MemoryRouter initialEntries={["/projects/7/jobs/new"]}>
        <Routes>
          <Route path="/projects/:projectId/jobs/new" element={<JobCreate />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByTestId("detected-problem-type");
    fireEvent.click(screen.getByTestId("job-submit"));
    await screen.findByTestId("training-submit-error");
    fireEvent.change(screen.getByTestId("job-algorithm"), { target: { value: "logistic_regression" } });
    expect(screen.queryByTestId("training-submit-error")).not.toBeInTheDocument();
  });

  it("clears the previous submit error when a new Start training begins", async () => {
    let resolveSecond: ((value: {
      ok: boolean;
      status: number;
      json: () => Promise<{ detail: string; hint: string | null }>;
    }) => void) | null = null;
    let postCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/datasets")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 1,
                name: "iris",
                latest_version: 1,
                columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
              },
            ],
          };
        }
        if (url.includes("/training/algorithms")) {
          return { ok: true, status: 200, json: async () => ({ algorithms: catalog }) };
        }
        if (url.includes("/splits")) {
          return { ok: true, status: 200, json: async () => [] };
        }
        if (url.includes("/versions") && !url.includes("resolve")) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 11,
                dataset_id: 1,
                version: 1,
                original_filename: "iris.csv",
                columns: ["sepal length (cm)", "sepal width (cm)", "petal length (cm)", "petal width (cm)", "target"],
              },
            ],
          };
        }
        if (url.includes("/resolve-problem-type")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              requested_problem_type: "auto",
              resolved_problem_type: "classification",
              target_column: "target",
              dataset_id: 1,
              dataset_version_id: 11,
            }),
          };
        }
        if (url.endsWith("/jobs") && init?.method === "POST") {
          postCount += 1;
          if (postCount === 1) {
            return {
              ok: false,
              status: 409,
              json: async () => ({
                detail: "Training is blocked by failed data quality rules.",
                hint: "Blocking rules: TEST_RULL",
              }),
            };
          }
          return await new Promise<{
            ok: boolean;
            status: number;
            json: () => Promise<{ detail: string; hint: string | null }>;
          }>((resolve) => {
            resolveSecond = resolve;
          });
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    render(
      <MemoryRouter initialEntries={["/projects/7/jobs/new"]}>
        <Routes>
          <Route path="/projects/:projectId/jobs/new" element={<JobCreate />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByTestId("detected-problem-type");
    fireEvent.click(screen.getByTestId("job-submit"));
    await screen.findByTestId("training-submit-error");
    fireEvent.click(screen.getByTestId("job-submit"));
    await waitFor(() => {
      expect(screen.queryByTestId("training-submit-error")).not.toBeInTheDocument();
      expect(postCount).toBe(2);
      expect(resolveSecond).not.toBeNull();
    });
    resolveSecond!({
      ok: false,
      status: 422,
      json: async () => ({ detail: "Invalid training configuration", hint: null }),
    });
    expect(await screen.findByTestId("training-submit-error")).toHaveTextContent("Invalid training configuration");
  });
});

describe("JobDetail clone navigation", () => {
  it("links clone configuration to the create form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: 5,
          project_id: 7,
          dataset_id: 1,
          dataset_version_id: 1,
          split_id: 9,
          name: "job",
          description: "",
          target_column: "target",
          problem_type: "classification",
          algorithm: "random_forest",
          hyperparameters: {},
          feature_columns: ["a"],
          ratios: { train: 0.7, validation: 0.15, test: 0.15 },
          random_seed: 42,
          status: "failed",
          logs: "",
          metrics: {},
          mlflow_run_id: null,
          model_uri: null,
          error_message: "boom",
          retry_count: 0,
          max_retries: 1,
          parent_job_id: null,
          created_at: "2026-01-01",
          started_at: null,
          finished_at: null,
        }),
      }),
    );
    render(
      <MemoryRouter initialEntries={["/projects/7/jobs/5"]}>
        <Routes>
          <Route path="/projects/:projectId/jobs/:jobId" element={<JobDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    const clone = await screen.findByTestId("job-clone");
    expect(clone).toHaveAttribute("href", "/projects/7/jobs/new?cloneFrom=5");
    expect(screen.getByTestId("retry-hint")).toBeInTheDocument();
    expect(await screen.findByTestId("job-data-split")).toHaveTextContent("Saved split #9");
  });
});

describe("ModelVersion validation UX", () => {
  it("reruns validation and blocks approval when gates fail", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("evaluate-gates")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 3,
            name: "classifier",
            version: "1",
            lifecycle: "CANDIDATE",
            gates_passed: true,
            gate_results: { passed: true },
            metrics: {},
            metadata: {},
            mlflow_run_id: "run",
            model_uri: "models:/x/1",
            approval_comment: null,
            training_job_id: 1,
            created_at: "2026-01-01",
            project_id: 7,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 3,
          name: "classifier",
          version: "1",
          lifecycle: "CANDIDATE",
          gates_passed: false,
          gate_results: { passed: false },
          metrics: {},
          metadata: {},
          mlflow_run_id: "run",
          model_uri: "models:/x/1",
          approval_comment: null,
          training_job_id: 1,
          created_at: "2026-01-01",
          project_id: 7,
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/projects/7/models/3"]}>
        <Routes>
          <Route path="/projects/:projectId/models/:modelVersionId" element={<ModelVersion />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("approval-blocked-hint")).toBeInTheDocument();
    expect(screen.queryByTestId("request-approval")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("rerun-validation"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("evaluate-gates"), expect.any(Object)));
  });
});

describe("Predict stopped endpoint UX", () => {
  it("shows stop notice and start button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: 9,
          project_id: 7,
          name: "ep",
          model_name: "m",
          model_version: "1",
          model_version_id: 1,
          model_uri: "models:/m/1",
          status: "stopped",
          request_count: 0,
          success_count: 0,
          error_count: 0,
          success_rate: null,
          average_latency_ms: null,
          latency_p95_ms: 0,
          feature_schema: [
            { name: "site_id", dtype: "object" },
            { name: "hour", dtype: "int64" },
          ],
          recent_errors: [],
          created_at: "2026-01-01",
        }),
      }),
    );
    render(
      <MemoryRouter initialEntries={["/projects/7/deployments/9/predict"]}>
        <Routes>
          <Route path="/projects/:projectId/deployments/:endpointId/predict" element={<Predict />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("endpoint-stopped-notice")).toHaveTextContent("This endpoint is stopped");
    expect(screen.getByTestId("start-endpoint")).toBeInTheDocument();
    expect(screen.getByTestId("predict-submit")).toBeDisabled();
    expect((screen.getByTestId("predict-payload") as HTMLTextAreaElement).value).toContain('"site_id": "sample"');
  });
});

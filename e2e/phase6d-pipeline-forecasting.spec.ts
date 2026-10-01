import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

function requiredEnv(name: "E2E_ADMIN_EMAIL" | "E2E_ADMIN_PASSWORD"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Run Playwright through ./scripts/verify.sh.`);
  }
  return value;
}

const adminEmail = requiredEnv("E2E_ADMIN_EMAIL");
const adminPassword = requiredEnv("E2E_ADMIN_PASSWORD");

function writeForecastCsv(): string {
  const filePath = path.join(os.tmpdir(), `phase6d-forecast-${Date.now()}.csv`);
  const rows = ["event_time,sales,sales_lag_1,sales_roll_avg_3"];
  for (let day = 1; day <= 36; day += 1) {
    const month = day <= 31 ? "01" : "02";
    const dd = String(day <= 31 ? day : day - 31).padStart(2, "0");
    const sales = 10 * day;
    const lag = day === 1 ? "" : String(10 * (day - 1));
    const roll =
      day < 3 ? String(sales) : String((10 * (day - 2) + 10 * (day - 1) + sales) / 3);
    rows.push(`2024-${month}-${dd},${sales},${lag},${roll}`);
  }
  fs.writeFileSync(filePath, `${rows.join("\n")}\n`, "utf8");
  return filePath;
}

async function loginToken(request: APIRequestContext): Promise<string> {
  const login = await request.post("/api/v1/auth/login", {
    data: { email: adminEmail, password: adminPassword },
  });
  expect(login.ok()).toBeTruthy();
  return (await login.json()).access_token as string;
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible({
    timeout: 30_000,
  });
}

test("pipeline forecasting training and registration succeeds", async ({ page, request }) => {
  const tag = Date.now();
  const token = await loginToken(request);
  const headers = { Authorization: `Bearer ${token}` };
  const csvPath = writeForecastCsv();

  const project = await request.post("/api/v1/projects", {
    headers,
    data: { name: `e2e-pipe-fc-${tag}`, description: "Phase 6-D pipeline forecasting E2E" },
  });
  expect(project.status()).toBe(201);
  const projectId = (await project.json()).id as number;

  const upload = await request.post(`/api/v1/projects/${projectId}/datasets`, {
    headers,
    multipart: {
      file: {
        name: path.basename(csvPath),
        mimeType: "text/csv",
        buffer: fs.readFileSync(csvPath),
      },
      name: `phase6d-forecast-${tag}.csv`,
    },
  });
  expect(upload.status()).toBe(201);
  const dataset = await upload.json();
  const datasetId = dataset.id as number;
  const versionId = dataset.version.id as number;

  const graph = {
    nodes: [
      {
        id: "dataset_load-1",
        position: { x: 0, y: 0 },
        data: {
          label: "Load forecast CSV",
          node_type: "dataset_load",
          config: {
            dataset_id: datasetId,
            dataset_version_id: versionId,
          },
        },
      },
      {
        id: "training-1",
        position: { x: 280, y: 0 },
        data: {
          label: "Forecast train",
          node_type: "training",
          config: {
            training_task: "forecasting",
            target_column: "sales",
            problem_type: "regression",
            algorithm: "ridge",
            feature_columns: ["sales_lag_1", "sales_roll_avg_3"],
            hyperparameters: {},
            split_strategy: "time",
            time_column: "event_time",
            forecast_strategy: "direct_multioutput",
            forecast_horizons: [1, 2, 3],
          },
        },
      },
      {
        id: "model_registration-1",
        position: { x: 560, y: 0 },
        data: {
          label: "Register forecast model",
          node_type: "model_registration",
          config: { model_name: `e2e-forecast-model-${tag}` },
        },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "dataset_load-1",
        target: "training-1",
        sourceHandle: "data",
        targetHandle: "data",
        data: { branch: "always" },
      },
      {
        id: "e2",
        source: "training-1",
        target: "model_registration-1",
        sourceHandle: "model",
        targetHandle: "model",
        data: { branch: "always" },
      },
    ],
  };

  const pipeline = await request.post(`/api/v1/projects/${projectId}/pipelines`, {
    headers,
    data: {
      name: `e2e-forecast-pipeline-${tag}`,
      description: "Phase 6-D forecasting pipeline",
      graph,
    },
  });
  expect(pipeline.status()).toBe(201);
  const pipelineId = (await pipeline.json()).id as number;

  await login(page);
  await page.goto(`/projects/${projectId}/pipelines/${pipelineId}`);
  await expect(page.getByTestId("pipeline-library-dataset_load")).toBeVisible({ timeout: 30_000 });

  const trainingNode = page
    .getByTestId("pipeline-step-node")
    .filter({ hasText: "Forecast train" });
  await expect(trainingNode).toBeVisible({ timeout: 30_000 });
  await expect(trainingNode).toContainText(/Forecasting · t\+1, t\+2, t\+3/i);

  await trainingNode.click();
  await expect(page.getByTestId("node-config-training-task")).toHaveValue("forecasting");
  await expect(page.getByTestId("node-config-problem-type")).toHaveValue("regression");
  await expect(page.getByTestId("node-config-split-strategy")).toHaveValue("time");
  await expect(page.getByTestId("node-config-target")).toHaveValue("sales");
  await expect(page.getByTestId("node-config-time-column")).toHaveValue("event_time");
  await expect(page.getByTestId("node-config-forecast-horizons")).toHaveValue("1, 2, 3");
  await expect(page.getByTestId("node-config-algorithm")).toHaveValue("ridge");
  await expect(page.getByTestId("node-config-features")).toContainText("sales_lag_1");
  await expect(page.getByTestId("node-config-features")).toContainText("sales_roll_avg_3");
  await expect(page.getByTestId("node-config-features")).not.toContainText("event_time");
  await expect(page.getByTestId("node-config-forecast-horizons-help")).toContainText(
    /observation steps/i,
  );

  await page.getByTestId("pipeline-validate").click();
  await expect(page.getByText(/valid|Validation passed|Graph is valid/i).first()).toBeVisible({
    timeout: 30_000,
  });

  await page.getByTestId("pipeline-run").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/pipeline-runs/\\d+`), {
    timeout: 30_000,
  });
  await expect(page.getByText(/succeeded/i).first()).toBeVisible({ timeout: 180_000 });
  const runTrainingNode = page
    .getByTestId("pipeline-step-node")
    .filter({ hasText: "Forecast train" });
  await expect(runTrainingNode).toContainText(/Forecasting · t\+1, t\+2, t\+3/i);
  await expect(page.getByTestId("pipeline-run-step-training-1")).toBeVisible();
  await expect(page.getByTestId("pipeline-run-step-model_registration-1")).toBeVisible();
});

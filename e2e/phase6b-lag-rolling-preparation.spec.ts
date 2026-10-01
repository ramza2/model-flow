import { expect, test, type APIRequestContext } from "@playwright/test";
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

function writeUnorderedTimedCsv(): string {
  const filePath = path.join(os.tmpdir(), `phase6b-ts-${Date.now()}.csv`);
  // Intentionally unordered chronological rows.
  const rows = [
    "event_time,sales",
    "2024-01-05,50",
    "2024-01-01,10",
    "2024-01-04,40",
    "2024-01-02,20",
    "2024-01-03,30",
  ];
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

test("lag and rolling preparation preview and materialize", async ({ page, request }) => {
  const tag = Date.now();
  const token = await loginToken(request);
  const headers = { Authorization: `Bearer ${token}` };
  const csvPath = writeUnorderedTimedCsv();

  const project = await request.post("/api/v1/projects", {
    headers,
    data: { name: `e2e-phase6b-${tag}`, description: "Phase 6-B lag/rolling E2E" },
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
      name: `phase6b-ts-${tag}.csv`,
    },
  });
  expect(upload.status()).toBe(201);
  const dataset = await upload.json();
  const datasetId = dataset.id as number;
  const versionId = dataset.version.id as number;

  const graph = {
    schema_version: 1,
    nodes: [
      {
        id: "src",
        type: "source",
        config: {
          dataset_id: datasetId,
          version_strategy: "fixed",
          dataset_version_id: versionId,
        },
        position: { x: 0, y: 0 },
      },
      {
        id: "lag-1",
        type: "lag",
        config: {
          time_column: "event_time",
          source_column: "sales",
          lags: [{ periods: 1, output: "sales_lag_1" }],
        },
        position: { x: 220, y: 0 },
      },
      {
        id: "roll-1",
        type: "rolling_window",
        config: {
          time_column: "event_time",
          source_column: "sales",
          windows: [{ window: 3, aggregation: "avg", output: "sales_roll_avg_3" }],
        },
        position: { x: 440, y: 0 },
      },
      {
        id: "out",
        type: "output",
        config: {},
        position: { x: 660, y: 0 },
      },
    ],
    edges: [
      { id: "e1", source: "src", target: "lag-1" },
      { id: "e2", source: "lag-1", target: "roll-1" },
      { id: "e3", source: "roll-1", target: "out" },
    ],
  };

  const prep = await request.post(`/api/v1/projects/${projectId}/dataset-preparations`, {
    headers,
    data: {
      name: `e2e-lag-roll-${tag}`,
      description: "Phase 6-B lag + rolling",
      graph,
    },
  });
  expect(prep.status()).toBe(201);
  const preparation = await prep.json();
  const preparationId = preparation.id as number;

  const output = await request.post(
    `/api/v1/projects/${projectId}/dataset-preparations/${preparationId}/output-dataset`,
    {
      headers,
      data: { name: `e2e-lag-roll-out-${tag}`, description: "prepared" },
    },
  );
  expect(output.status()).toBe(201);

  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();

  await page.goto(`/projects/${projectId}/preparations/${preparationId}`);
  await expect(page.getByTestId("preparation-builder")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-testid="preparation-step-node"][data-node-type="lag"]'),
  ).toBeVisible({ timeout: 30_000 });

  await page.locator('[data-testid="preparation-step-node"][data-node-type="lag"]').click();
  await expect(page.getByTestId("preparation-lag-inspector")).toBeVisible();
  await expect(page.getByTestId("preparation-lag-time-column")).toHaveValue("event_time");
  await expect(page.getByTestId("preparation-lag-source-column")).toHaveValue("sales");
  await expect(page.getByTestId("preparation-lag-help")).toContainText(
    "Lag uses only earlier rows",
  );

  await page
    .locator('[data-testid="preparation-step-node"][data-node-type="rolling_window"]')
    .click();
  await expect(page.getByTestId("preparation-rolling-inspector")).toBeVisible();
  await expect(page.getByTestId("preparation-rolling-time-column")).toHaveValue("event_time");
  await expect(page.getByTestId("preparation-rolling-help")).toContainText("past rows only");

  await page.getByTestId("preparation-preview").click();
  await expect(page.getByTestId("preparation-preview-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("preparation-preview-warning")).toContainText(
    "Temporal feature preview",
  );
  await expect(page.getByTestId("preparation-preview-table")).toContainText("sales_lag_1");
  await expect(page.getByTestId("preparation-preview-table")).toContainText("sales_roll_avg_3");

  await page.getByTestId("preparation-run").click();
  await expect(page.getByTestId("preparation-run-table")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("preparation-run-table")).toContainText(/succeeded/i, {
    timeout: 180_000,
  });

  await expect(page.getByTestId("preparation-open-output-dataset")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("preparation-open-output-dataset").click();
  await expect(page.getByText(/Column statistics/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("sales_lag_1")).toBeVisible();
  await expect(page.getByText("sales_roll_avg_3")).toBeVisible();
});

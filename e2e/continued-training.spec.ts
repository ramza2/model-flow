import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";

const sampleCsv = path.resolve(__dirname, "../samples/iris.csv");

function requiredEnv(name: "E2E_ADMIN_EMAIL" | "E2E_ADMIN_PASSWORD"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Run Playwright through ./scripts/verify.sh.`);
  }
  return value;
}

const adminEmail = requiredEnv("E2E_ADMIN_EMAIL");
const adminPassword = requiredEnv("E2E_ADMIN_PASSWORD");

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("continued training UX wires Continue action and lineage", async ({ page, request }) => {
  const projectName = `e2e-continued-${Date.now()}`;
  await login(page);
  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  const token = await page.evaluate(() => localStorage.getItem("modelflow_token"));
  const projectId = page.url().match(/projects\/(\d+)/)?.[1];
  expect(projectId).toBeTruthy();
  const auth = { Authorization: `Bearer ${token}` };
  const csvBytes = fs.readFileSync(sampleCsv);

  const upload1 = await request.post(`/api/v1/projects/${projectId}/datasets`, {
    headers: auth,
    multipart: {
      name: "continued-ds",
      file: {
        name: "iris-v1.csv",
        mimeType: "text/csv",
        buffer: csvBytes,
      },
    },
  });
  expect(upload1.ok()).toBeTruthy();
  const ds1 = await upload1.json();
  const datasetId = ds1.id as number;
  const version1Id = ds1.version.id as number;
  const featureColumns = (ds1.version.columns as string[]).filter((c) => c !== "target");

  const upload2 = await request.post(`/api/v1/projects/${projectId}/datasets`, {
    headers: auth,
    multipart: {
      name: "continued-ds",
      file: {
        name: "iris-v2.csv",
        mimeType: "text/csv",
        buffer: csvBytes,
      },
    },
  });
  expect(upload2.ok()).toBeTruthy();
  const version2Id = (await upload2.json()).version.id as number;

  const createJob = await request.post(`/api/v1/projects/${projectId}/jobs`, {
    headers: { ...auth, "Content-Type": "application/json" },
    data: {
      name: "e2e-sgd-source",
      dataset_id: datasetId,
      dataset_version_id: version1Id,
      target_column: "target",
      algorithm: "sgd_classifier",
      hyperparameters: { max_iter: 50 },
      feature_columns: featureColumns,
    },
  });
  expect(createJob.ok()).toBeTruthy();
  const sourceJob = await createJob.json();

  let succeeded = false;
  for (let i = 0; i < 90; i += 1) {
    const detail = await request.get(`/api/v1/projects/${projectId}/jobs/${sourceJob.id}`, {
      headers: auth,
    });
    const body = await detail.json();
    if (body.status === "succeeded" && body.model_uri) {
      succeeded = true;
      break;
    }
    if (body.status === "failed") {
      throw new Error(`Source job failed: ${body.error_message}`);
    }
    await page.waitForTimeout(2000);
  }
  expect(succeeded).toBeTruthy();

  await page.goto(`/projects/${projectId}/jobs/${sourceJob.id}`);
  await expect(page.getByTestId("job-continue")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("job-retrain")).toBeVisible();
  await page.getByTestId("job-continue").click();
  await expect(page.getByTestId("job-continue-dialog")).toBeVisible();
  await expect(page.getByTestId("continue-strategy")).toHaveTextContent("partial_fit");
  await page.getByTestId("continue-dataset-version").selectOption(String(version2Id));
  await page.getByTestId("continue-name").fill("e2e-sgd-continued");
  await page.getByTestId("continue-submit").click();

  await expect(page.getByTestId("job-continue-lineage")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("job-continue-lineage")).toContainText(`Job #${sourceJob.id}`);
  await expect(page.getByTestId("job-training-mode")).toHaveTextContent("continued");
});

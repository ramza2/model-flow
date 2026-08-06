import { expect, test } from "@playwright/test";
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

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();
}

async function createProject(page: import("@playwright/test").Page, projectName: string) {
  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
}

function writeTempCsv(name: string, contents: string) {
  const filePath = path.join(os.tmpdir(), name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

async function uploadDataset(
  page: import("@playwright/test").Page,
  filePath: string,
  linkName: string,
) {
  const projectId = page.url().match(/projects\/(\d+)/)?.[1];
  expect(projectId).toBeTruthy();
  await page.goto(`/projects/${projectId}/datasets`);
  await expect(page.getByRole("heading", { name: "Datasets", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "↑ Upload dataset", exact: true }).click();
  await expect(page.getByTestId("dataset-file")).toBeVisible();
  await page.getByTestId("dataset-file").setInputFiles(filePath);
  await page.getByTestId("dataset-upload").click();
  await expect(page.getByRole("link", { name: linkName })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("link", { name: linkName }).click();
  await expect(page.getByTestId("quality-panel")).toBeVisible();
}

test("dataset quality blocking scopes fail to dataset and clears on deactivate", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const projectName = `e2e-quality-${stamp}`;
  const dupCsv = writeTempCsv(
    `dup-sites-${stamp}.csv`,
    "site_id,a,b,target\nS1,1,2,0\nS1,2,3,1\nS2,3,4,0\nS3,4,5,1\n",
  );
  const cleanCsv = writeTempCsv(
    `clean-sites-${stamp}.csv`,
    "site_id,a,b,target\nS1,1,2,0\nS2,2,3,1\nS3,3,4,0\nS4,4,5,1\n",
  );

  await login(page);
  await createProject(page, projectName);

  await uploadDataset(page, dupCsv, path.basename(dupCsv));
  await page.getByTestId("quality-create").click();
  await page.getByTestId("quality-rule-name").fill("Unique site ID");
  await page.getByTestId("quality-rule-blocking").check();
  await page.getByTestId("quality-condition-type-0").selectOption("unique");
  await page.locator('select[aria-label="Condition 1 column"]').selectOption("site_id");
  await page.getByTestId("quality-save-rule").click();
  await expect(page.getByText("Quality rule created.")).toBeVisible();

  await page.getByTestId("quality-run-all").click();
  await expect(page.getByTestId("quality-latest-result")).toContainText("FAIL", {
    timeout: 30_000,
  });

  const token = await page.evaluate(() => localStorage.getItem("modelflow_token"));
  const projectId = page.url().match(/projects\/(\d+)/)?.[1];
  expect(projectId).toBeTruthy();
  const headers = { Authorization: `Bearer ${token}` };

  const datasets = await request.get(`/api/v1/projects/${projectId}/datasets`, { headers });
  const rows = await datasets.json();
  const datasetA = rows.find((row: { name: string }) => row.name.includes(`dup-sites-${stamp}`));
  expect(datasetA).toBeTruthy();
  const versionsA = await request.get(
    `/api/v1/projects/${projectId}/datasets/${datasetA.id}/versions`,
    { headers },
  );
  const versionA = (await versionsA.json())[0];
  expect(versionA).toBeTruthy();

  const beforeJobs = await request.get(`/api/v1/projects/${projectId}/jobs`, { headers });
  const beforeCount = (await beforeJobs.json()).length;

  const blocked = await request.post(`/api/v1/projects/${projectId}/jobs`, {
    headers,
    data: {
      name: "blocked-by-quality",
      dataset_id: datasetA.id,
      dataset_version_id: versionA.id,
      target_column: "target",
      feature_columns: ["a", "b"],
      algorithm: "random_forest",
      hyperparameters: { n_estimators: 10, max_depth: 3 },
    },
  });
  expect(blocked.status()).toBe(409);
  const blockedBody = await blocked.json();
  expect(String(blockedBody.hint || "")).toContain("Unique site ID");

  const afterBlocked = await request.get(`/api/v1/projects/${projectId}/jobs`, { headers });
  expect((await afterBlocked.json()).length).toBe(beforeCount);

  await page.getByRole("button", { name: "Deactivate", exact: true }).click();
  await expect(page.getByText("Rule deactivated.")).toBeVisible();

  const allowed = await request.post(`/api/v1/projects/${projectId}/jobs`, {
    headers,
    data: {
      name: "after-deactivate",
      dataset_id: datasetA.id,
      dataset_version_id: versionA.id,
      target_column: "target",
      feature_columns: ["a", "b"],
      algorithm: "random_forest",
      hyperparameters: { n_estimators: 10, max_depth: 3 },
    },
  });
  expect(allowed.status()).toBe(201);

  // Dataset B remains trainable despite Dataset A historical FAIL.
  await uploadDataset(page, cleanCsv, path.basename(cleanCsv));
  const datasets2 = await request.get(`/api/v1/projects/${projectId}/datasets`, { headers });
  const datasetB = (await datasets2.json()).find((row: { name: string }) =>
    row.name.includes(`clean-sites-${stamp}`),
  );
  expect(datasetB).toBeTruthy();
  const versionsB = await request.get(
    `/api/v1/projects/${projectId}/datasets/${datasetB.id}/versions`,
    { headers },
  );
  const versionB = (await versionsB.json())[0];
  const bJob = await request.post(`/api/v1/projects/${projectId}/jobs`, {
    headers,
    data: {
      name: "dataset-b-ok",
      dataset_id: datasetB.id,
      dataset_version_id: versionB.id,
      target_column: "target",
      feature_columns: ["a", "b"],
      algorithm: "random_forest",
      hyperparameters: { n_estimators: 10, max_depth: 3 },
    },
  });
  expect(bJob.status()).toBe(201);
});

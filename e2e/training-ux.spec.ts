import { expect, test } from "@playwright/test";
import path from "path";

const iris = path.resolve(__dirname, "../samples/iris.csv");

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

async function uploadIrisAndOpenTrain(page: import("@playwright/test").Page) {
  await page.getByRole("link", { name: "Datasets", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Datasets", exact: true })).toBeVisible();
  const uploadToggle = page.getByRole("button", { name: "↑ Upload dataset", exact: true });
  await uploadToggle.click();
  await expect(page.getByTestId("dataset-file")).toBeVisible();
  await page.getByTestId("dataset-file").setInputFiles(iris);
  await page.getByTestId("dataset-upload").click();
  await expect(page.getByRole("link", { name: "iris.csv" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("link", { name: "iris.csv" }).click();
  await page.getByRole("link", { name: "Train on this dataset" }).click();
  await expect(page.getByTestId("job-submit")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("training auto detection filters classification algorithms", async ({ page }) => {
  const projectName = `e2e-train-ux-${Date.now()}`;
  await login(page);
  await createProject(page, projectName);
  await uploadIrisAndOpenTrain(page);

  await expect(page.getByTestId("detected-problem-type")).toContainText("Classification", { timeout: 30_000 });
  const algorithm = page.getByTestId("job-algorithm");
  await expect(algorithm.locator("option")).toHaveCount(3);
  await expect(algorithm).toContainText("Random forest");
  await expect(algorithm).not.toContainText("Ridge regression");
  await page.getByTestId("job-name").fill("e2e-auto-cls");
  await page.getByTestId("job-submit").click();
  await expect(page.getByTestId("job-logs")).toBeVisible();
});

test("invalid algorithm API combination does not create a job", async ({ page, request }) => {
  const projectName = `e2e-api-422-${Date.now()}`;
  await login(page);
  await createProject(page, projectName);
  await uploadIrisAndOpenTrain(page);
  // Leave the create form; we only needed a dataset for the API call.
  await page.getByRole("link", { name: "Datasets", exact: true }).click();

  const token = await page.evaluate(() => localStorage.getItem("modelflow_token"));
  const projectId = page.url().match(/projects\/(\d+)/)?.[1];
  expect(projectId).toBeTruthy();

  const datasets = await request.get(`/api/v1/projects/${projectId}/datasets`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const dataset = (await datasets.json())[0];
  const before = await request.get(`/api/v1/projects/${projectId}/jobs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const beforeCount = (await before.json()).length;

  const created = await request.post(`/api/v1/projects/${projectId}/jobs`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: "should-fail",
      dataset_id: dataset.id,
      target_column: "target",
      problem_type: "classification",
      algorithm: "ridge",
      feature_columns: dataset.columns.filter((column: string) => column !== "target"),
    },
  });
  expect(created.status()).toBe(422);

  const after = await request.get(`/api/v1/projects/${projectId}/jobs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect((await after.json()).length).toBe(beforeCount);
});

test("clone configuration opens editable create form", async ({ page }) => {
  const projectName = `e2e-clone-${Date.now()}`;
  await login(page);
  await createProject(page, projectName);
  await uploadIrisAndOpenTrain(page);
  await page.getByTestId("job-name").fill("clone-source");
  await page.getByTestId("job-submit").click();
  await expect(page.getByTestId("job-logs")).toBeVisible();

  const stop = page.getByRole("button", { name: "Stop job" });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  page.once("dialog", (dialog) => dialog.accept());
  await stop.click();
  await expect(page.getByTestId("job-clone")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("job-clone").click();
  await expect(page).toHaveURL(/jobs\/new\?cloneFrom=/);
  await expect(page.getByTestId("job-name")).toHaveValue("clone-source (clone)");
  await page.getByTestId("job-name").fill("clone-edited");
  await page.getByTestId("job-submit").click();
  await expect(page.getByTestId("job-logs")).toBeVisible();
  await expect(page.getByRole("heading", { name: "clone-edited" })).toBeVisible();
});

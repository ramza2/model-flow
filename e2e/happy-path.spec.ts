import { expect, test } from "@playwright/test";
import path from "path";

const iris = path.resolve(__dirname, "../samples/iris.csv");

test("full MLOps happy path", async ({ page }) => {
  const projectName = `e2e-${Date.now()}`;

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();
  await page.screenshot({ path: "artifacts/screenshots/01-home.png", fullPage: true });

  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-description").fill("Playwright E2E project");
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  await page.screenshot({ path: "artifacts/screenshots/02-project.png", fullPage: true });

  await page.getByRole("link", { name: "Datasets" }).click();
  await page.getByTestId("dataset-file").setInputFiles(iris);
  await page.getByTestId("dataset-upload").click();
  await expect(page.getByText("iris.csv")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "iris.csv" }).click();
  await expect(page.getByText(/Column statistics/i)).toBeVisible();
  await page.screenshot({ path: "artifacts/screenshots/03-dataset.png", fullPage: true });

  await page.getByRole("link", { name: "Train on this dataset" }).click();
  await page.getByTestId("job-name").fill("e2e-rf");
  await page.getByTestId("job-submit").click();
  await expect(page.getByTestId("job-logs")).toBeVisible();

  // Wait until training succeeds and register button appears
  await expect(page.getByTestId("register-model")).toBeVisible({ timeout: 180_000 });
  await page.screenshot({ path: "artifacts/screenshots/04-job.png", fullPage: true });
  await page.getByTestId("register-model").click();
  await expect(page.getByText(/Registered/i)).toBeVisible({ timeout: 60_000 });

  await page.getByRole("link", { name: "Models" }).click();
  await expect(page.getByText(/project-.*-classifier/)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "artifacts/screenshots/05-registry.png", fullPage: true });

  await page.getByRole("link", { name: "Endpoints" }).click();
  await page.getByTestId("endpoint-name").fill("e2e-endpoint");
  await page.getByTestId("endpoint-create").click();
  await expect(page.getByRole("link", { name: "Test inference" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "Test inference" }).click();
  await page.getByTestId("predict-submit").click();
  await expect(page.getByTestId("predict-result")).toContainText("predictions", { timeout: 60_000 });
  await page.screenshot({ path: "artifacts/screenshots/06-predict.png", fullPage: true });

  await page.goto("/system");
  await expect(page.getByRole("heading", { name: /System status/i })).toBeVisible();
  await page.screenshot({ path: "artifacts/screenshots/07-system.png", fullPage: true });
});

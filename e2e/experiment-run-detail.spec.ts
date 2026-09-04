import { expect, test } from "@playwright/test";
import path from "path";

const dataset = path.resolve(__dirname, "../samples/multi_output_regression.csv");

function requiredEnv(name: "E2E_ADMIN_EMAIL" | "E2E_ADMIN_PASSWORD"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Run Playwright through ./scripts/verify.sh.`);
  }
  return value;
}

const adminEmail = requiredEnv("E2E_ADMIN_EMAIL");
const adminPassword = requiredEnv("E2E_ADMIN_PASSWORD");

test("experiment run detail navigation from training job", async ({ page }) => {
  const projectName = `e2e-run-detail-${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();

  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Datasets", exact: true }).click();
  await page.getByRole("button", { name: "↑ Upload dataset", exact: true }).click();
  await page.getByTestId("dataset-file").setInputFiles(dataset);
  await page.getByTestId("dataset-upload").click();
  await expect(page.getByText("multi_output_regression.csv")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "multi_output_regression.csv" }).click();

  await page.getByTestId("train-on-dataset").click();
  await page.getByTestId("job-name").fill("e2e-run-detail");
  await page.getByTestId("target-power_usage").check();
  await page.getByTestId("job-submit").click();
  await expect(page.getByTestId("job-logs")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open experiment" })).toBeVisible({ timeout: 180_000 });
  await page.getByRole("link", { name: "Open experiment" }).click();
  await expect(page.getByRole("heading", { name: /e2e-run-detail|run/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Logged metrics")).toBeVisible();
  await expect(page.getByText("Run parameters")).toBeVisible();
});

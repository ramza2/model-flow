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

test("multi-output regression training job create", async ({ page }) => {
  const projectName = `e2e-mo-${Date.now()}`;

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
  await page.getByTestId("job-name").fill("e2e-multi-output");
  await page.getByTestId("target-power_usage").check();
  await page.getByTestId("target-cooling_load").check();
  await expect(page.getByTestId("multi-target-hint")).toBeVisible();
  await page.getByTestId("job-submit").click();
  await expect(page.getByTestId("job-logs")).toBeVisible();
  await expect(page.getByTestId("job-target-columns")).toContainText("power_usage");
  await expect(page.getByTestId("job-target-columns")).toContainText("cooling_load");
  await expect(page.getByTestId("register-model")).toBeVisible({ timeout: 180_000 });
});

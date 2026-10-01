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

function writeForecastCsv(): string {
  const filePath = path.join(os.tmpdir(), `phase6c-forecast-${Date.now()}.csv`);
  const rows = ["event_time,sales,sales_lag_1,sales_roll_avg_3"];
  for (let day = 1; day <= 36; day += 1) {
    const month = day <= 31 ? "01" : "02";
    const dd = String(day <= 31 ? day : day - 31).padStart(2, "0");
    const sales = 10 * day;
    const lag = day === 1 ? "" : String(10 * (day - 1));
    const roll =
      day < 3
        ? String(sales)
        : String((10 * (day - 2) + 10 * (day - 1) + sales) / 3);
    rows.push(`2024-${month}-${dd},${sales},${lag},${roll}`);
  }
  fs.writeFileSync(filePath, `${rows.join("\n")}\n`, "utf8");
  return filePath;
}

test("forecasting training job succeeds with multi-horizon outputs", async ({ page }) => {
  const projectName = `e2e-forecast-${Date.now()}`;
  const csvPath = writeForecastCsv();

  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();

  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-description").fill("Phase 6-C forecasting E2E");
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Datasets", exact: true }).click();
  await page.getByRole("button", { name: "↑ Upload dataset", exact: true }).click();
  await page.getByTestId("dataset-file").setInputFiles(csvPath);
  await page.getByTestId("dataset-upload").click();
  await expect(page.getByText(/phase6c-forecast-/i)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: /phase6c-forecast-/i }).click();
  await expect(page.getByText(/Column statistics/i)).toBeVisible();

  await page.getByTestId("train-on-dataset").click();
  await page.getByTestId("job-name").fill("e2e-forecast-job");
  await page.getByTestId("job-training-task").selectOption("forecasting");
  await expect(page.getByTestId("job-problem-type")).toHaveValue("regression");
  await expect(page.getByTestId("job-split-strategy")).toHaveValue("time");
  await page.getByTestId("target-sales").check();
  await page.getByTestId("job-time-column").selectOption("event_time");
  await page.getByTestId("feature-sales_lag_1").check();
  await page.getByTestId("feature-sales_roll_avg_3").check();
  await page.getByTestId("job-forecast-horizons").fill("1, 2, 3");
  await page.getByTestId("job-algorithm").selectOption("ridge");
  await page.getByTestId("job-submit").click();

  await expect(page.getByTestId("job-logs")).toBeVisible();
  await expect(page.getByTestId("job-training-task")).toContainText(/Forecasting/i, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("job-forecast-strategy")).toContainText(/Direct multi-output/i);
  await expect(page.getByTestId("job-forecast-horizons")).toContainText("1, 2, 3");
  await expect(page.getByTestId("job-forecast-outputs")).toContainText("sales__t_plus_1");
  await expect(page.getByTestId("register-model")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("job-finished-at")).not.toHaveText("—");
});

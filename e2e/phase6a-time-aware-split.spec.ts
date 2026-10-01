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

function writeTimedCsv(): string {
  const filePath = path.join(os.tmpdir(), `phase6a-timed-${Date.now()}.csv`);
  const rows = ["event_time,a,b,target"];
  for (let day = 1; day <= 20; day += 1) {
    const dd = String(day).padStart(2, "0");
    rows.push(`2024-01-${dd},${day},${day + 1},${day % 2}`);
  }
  fs.writeFileSync(filePath, `${rows.join("\n")}\n`, "utf8");
  return filePath;
}

test("time-ordered dataset split drives training job detail", async ({ page }) => {
  const projectName = `e2e-time-split-${Date.now()}`;
  const csvPath = writeTimedCsv();

  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();

  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-description").fill("Phase 6-A time-ordered split E2E");
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Datasets", exact: true }).click();
  await page.getByRole("button", { name: "↑ Upload dataset", exact: true }).click();
  await page.getByTestId("dataset-file").setInputFiles(csvPath);
  await page.getByTestId("dataset-upload").click();
  await expect(page.getByText(/phase6a-timed-/i)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: /phase6a-timed-/i }).click();
  await expect(page.getByText(/Column statistics/i)).toBeVisible();

  await page.getByTestId("open-create-split").click();
  await expect(page.getByTestId("create-split-form")).toBeVisible();
  await page.getByTestId("split-name").fill("e2e-time-split");
  await page.getByTestId("split-strategy").selectOption("time");
  await page.getByTestId("split-time-column").selectOption("event_time");
  await expect(page.getByTestId("split-time-seed-hint")).toBeVisible();
  await page.getByTestId("create-split-submit").click();
  await expect(page.getByTestId("saved-splits-list")).toContainText("Time ordered · event_time", {
    timeout: 30_000,
  });

  await page.getByTestId("train-on-dataset").click();
  await page.getByTestId("job-name").fill("e2e-time-ordered-job");
  await expect(page.getByTestId("job-data-split")).toBeVisible();
  await page.getByTestId("job-data-split").selectOption({
    label: "e2e-time-split · Time ordered · event_time · 70/15/15",
  });
  await expect(page.getByTestId("job-saved-split-summary")).toContainText(/Time ordered · event_time/i);
  await page.getByTestId("job-submit").click();

  await expect(page.getByTestId("job-logs")).toBeVisible();
  await expect(page.getByTestId("job-split-strategy-label")).toContainText(/Time ordered/i, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("job-time-column-label")).toContainText("event_time");
  await expect(page.getByTestId("register-model")).toBeVisible({ timeout: 180_000 });
});

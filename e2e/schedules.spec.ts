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

test("schedules run-now creates history entry", async ({ page }) => {
  const projectName = `e2e-schedules-${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();

  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Pipelines", exact: true }).click();
  await page.getByRole("button", { name: /New pipeline/i }).click();
  await page.getByTestId("pipeline-name").fill(`sched-pipe-${Date.now()}`);
  await page.getByTestId("pipeline-create-submit").click();
  await expect(page.getByTestId("pipeline-save")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("pipeline-save").click();
  await expect(page.getByText(/Pipeline version saved/i)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /Publish/i }).click();
  await expect(page.getByText(/published/i)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: "Schedules", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Schedules", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create schedule" }).click();
  await page.getByLabel("Name").fill(`nightly-${Date.now()}`);
  await page.getByLabel("Type").selectOption("pipeline_run");
  await page.getByLabel("Published pipeline").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Create schedule" }).click();
  await expect(page.getByText(/Schedule created/i)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Run now" }).first().click();
  await expect(page.getByText(/Run now queued/i)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "History" }).first().click();
  await expect(page.getByText("manual")).toBeVisible({ timeout: 30_000 });
});

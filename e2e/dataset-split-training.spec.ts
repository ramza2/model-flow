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

test("saved dataset split drives training job", async ({ page }) => {
  const projectName = `e2e-split-${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();

  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-description").fill("Saved split training E2E");
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Datasets", exact: true }).click();
  await page.getByRole("button", { name: "↑ Upload dataset", exact: true }).click();
  await page.getByTestId("dataset-file").setInputFiles(iris);
  await page.getByTestId("dataset-upload").click();
  await expect(page.getByText("iris.csv")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "iris.csv" }).click();
  await expect(page.getByText(/Column statistics/i)).toBeVisible();

  await page.getByTestId("open-create-split").click();
  await expect(page.getByTestId("create-split-form")).toBeVisible();
  await page.getByTestId("split-name").fill("e2e-split");
  await page.getByTestId("create-split-submit").click();
  await expect(page.getByTestId("saved-splits-list")).toContainText("e2e-split", {
    timeout: 30_000,
  });

  await page.getByRole("link", { name: "Train on this dataset" }).click();
  await page.getByTestId("job-name").fill("e2e-saved-split");
  await expect(page.getByTestId("job-data-split")).toBeVisible();
  await expect(page.getByTestId("job-data-split")).toContainText("e2e-split");
  await page.getByTestId("job-data-split").selectOption({ label: "e2e-split · 70/15/15 · seed 42" });
  await page.getByTestId("job-submit").click();

  await expect(page.getByTestId("job-logs")).toBeVisible();
  await expect(page.getByTestId("job-data-split")).toContainText(/Saved split/i, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("register-model")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("job-data-split")).toContainText(/Saved split/i);
  await expect(page.getByTestId("job-logs")).toContainText(/saved split/i);
});

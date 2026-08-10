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

test("pipeline builder form UX saves dataset load step", async ({ page }) => {
  const projectName = `e2e-pipeline-${Date.now()}`;

  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
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
  await page.getByTestId("dataset-file").setInputFiles(iris);
  await page.getByTestId("dataset-upload").click();
  await expect(page.getByText("iris.csv")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: "Pipelines", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pipelines", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /New pipeline/i }).click();
  await page.getByTestId("pipeline-name").fill(`builder-${Date.now()}`);
  await page.getByTestId("pipeline-create-submit").click();

  await expect(page.getByTestId("pipeline-add-node")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("pipeline-node-type").selectOption("dataset_load");
  await page.getByTestId("pipeline-add-node").click();

  await expect(page.getByTestId("pipeline-dirty-badge")).toBeVisible();
  await expect(page.getByTestId("node-config-dataset")).toBeVisible();
  await page.getByTestId("node-config-dataset").selectOption({ label: "iris.csv" });
  await expect(page.getByTestId("node-config-version")).not.toBeDisabled({ timeout: 15_000 });
  await page.getByTestId("node-config-version").selectOption({ index: 1 });

  await page.getByTestId("pipeline-step-name").fill("Load iris CSV");
  await expect(page.getByTestId("pipeline-step-name")).toHaveValue("Load iris CSV");

  await page.getByTestId("pipeline-save").click();
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(/Pipeline version saved/i)).toBeVisible({ timeout: 30_000 });
});

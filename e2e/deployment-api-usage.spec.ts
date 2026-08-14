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

test("deployment API usage and service key management UX", async ({ page }) => {
  const projectName = `api-usage-${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();

  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-description").fill("API usage E2E");
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Datasets", exact: true }).click();
  await page.getByRole("button", { name: "↑ Upload dataset", exact: true }).click();
  await page.getByTestId("dataset-file").setInputFiles(iris);
  await page.getByTestId("dataset-upload").click();
  await expect(page.getByText("iris.csv")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "Train on this dataset" }).click();
  await page.getByTestId("job-name").fill("api-usage-rf");
  await page.getByTestId("job-submit").click();
  await expect(page.getByTestId("register-model")).toBeVisible({ timeout: 180_000 });
  await page.getByTestId("register-model").click();
  await expect(page.getByText(/Registered/i)).toBeVisible({ timeout: 60_000 });

  await page.getByRole("link", { name: "Model Registry" }).click();
  await page.getByRole("link", { name: "classifier" }).click();
  await page.getByRole("button", { name: "Request approval" }).click();
  await page.getByTestId("approve-model").click();
  await expect(page.getByText("Model approved.")).toBeVisible();

  await page.getByRole("link", { name: "Deployments" }).click();
  await page.getByRole("button", { name: "New deployment" }).click();
  await page.getByTestId("endpoint-name").fill("api-usage-endpoint");
  await page.getByTestId("endpoint-create").click();
  await expect(page.getByRole("link", { name: "API usage" })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: "API usage" }).click();
  await expect(page.getByRole("heading", { name: "API usage" })).toBeVisible();
  await expect(page.getByTestId("api-usage-method")).toHaveText("POST");
  await expect(page.getByTestId("api-usage-url")).toContainText(
    "/api/v1/inference/endpoints/",
  );
  await expect(page.getByTestId("api-usage-url")).toContainText("/predict");
  await expect(page.getByTestId("api-usage-sample-json")).toContainText('"instances"');
  await expect(page.getByTestId("api-usage-curl-text")).toContainText("$MODELFLOW_API_KEY");
  await expect(page.getByTestId("api-usage-curl-text")).not.toContainText("mfk_");

  await page.getByTestId("create-service-key").click();
  await page.getByTestId("service-key-name").fill(`erp-${Date.now()}`);
  await page.getByTestId("service-key-submit").click();
  const oncePanel = page.getByTestId("service-key-once-panel");
  await expect(oncePanel).toBeVisible();
  const plaintext = await page.getByTestId("service-key-plaintext").innerText();
  expect(plaintext).toMatch(/^mfk_/);
  await page.getByTestId("copy-service-key").click();
  await page.getByTestId("service-key-done").click();
  await expect(page.getByTestId("service-key-plaintext")).toHaveCount(0);
  await expect(page.getByTestId("service-key-prefix")).toBeVisible();
  await expect(page.getByText(plaintext, { exact: false })).toHaveCount(0);

  const revokeButton = page.locator("[data-testid^='revoke-service-key-']").first();
  await expect(revokeButton).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await revokeButton.click();
  await expect(page.getByText("Revoked")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("service-key-plaintext")).toHaveCount(0);
  await expect(page.getByText(plaintext, { exact: false })).toHaveCount(0);
});

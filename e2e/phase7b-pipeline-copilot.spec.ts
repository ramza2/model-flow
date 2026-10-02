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

test("Phase 7-B Copilot preview requires confirmation and Apply marks dirty until Save", async ({
  page,
}) => {
  const projectName = `e2e-copilot-${Date.now()}`;
  let versionPosts = 0;

  await page.route("**/api/v1/projects/*/pipeline-copilot/draft", async (route) => {
    const body = route.request().postDataJSON() as { prompt?: string };
    expect(Object.keys(body || {})).toEqual(["prompt"]);
    expect(typeof body.prompt).toBe("string");
    expect((body.prompt || "").trim().length).toBeGreaterThan(0);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        summary: "Forecasting pipeline for sales",
        model: "e2e-mock-model",
        warnings: [],
        validation: {
          valid: true,
          errors: [],
          order: ["dataset_load-1", "training-1"],
        },
        graph: {
          nodes: [
            {
              id: "dataset_load-1",
              position: { x: 40, y: 40 },
              data: {
                label: "Load sales",
                node_type: "dataset_load",
                config: { dataset_id: 1, dataset_version_id: 1 },
              },
            },
            {
              id: "training-1",
              position: { x: 320, y: 40 },
              data: {
                label: "Forecast train",
                node_type: "training",
                config: {
                  training_task: "forecasting",
                  target_column: "sales",
                  problem_type: "regression",
                  algorithm: "ridge",
                  feature_columns: ["sales_lag_1", "sales_roll_avg_3"],
                  hyperparameters: {},
                  split_strategy: "time",
                  time_column: "event_time",
                  forecast_strategy: "direct_multioutput",
                  forecast_horizons: [1, 2, 3],
                },
              },
            },
          ],
          edges: [
            {
              id: "edge-1",
              source: "dataset_load-1",
              target: "training-1",
              sourceHandle: "data",
              targetHandle: "data",
              data: { branch: "always" },
            },
          ],
        },
      }),
    });
  });

  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/v1\/projects\/\d+\/pipelines\/\d+\/versions$/.test(request.url())
    ) {
      versionPosts += 1;
    }
  });

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
  await page.getByRole("button", { name: /New pipeline/i }).click();
  await page.getByTestId("pipeline-name").fill(`copilot-${Date.now()}`);
  await page.getByTestId("pipeline-create-submit").click();

  await expect(page.getByTestId("pipeline-copilot-open")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0);
  await expect(page.getByTestId("pipeline-canvas")).toBeVisible();

  await page.getByTestId("pipeline-copilot-open").click();
  await expect(page.getByTestId("pipeline-copilot-drawer")).toBeVisible();
  await page.getByTestId("pipeline-copilot-prompt").fill(
    "Create a forecasting pipeline for sales with ridge regression and time ordered splitting.",
  );
  await page.getByTestId("pipeline-copilot-generate").click();

  await expect(page.getByTestId("pipeline-copilot-preview")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("pipeline-copilot-summary")).toContainText(/Forecasting pipeline/i);
  await expect(page.getByTestId("pipeline-copilot-validation-status")).toContainText(/Valid draft/i);
  await expect(page.getByTestId("pipeline-copilot-preview-canvas")).toBeVisible();

  // Preview must not mutate the live Builder yet.
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0);
  await expect(
    page.getByTestId("pipeline-canvas").getByTestId("pipeline-step-node"),
  ).toHaveCount(0);
  expect(versionPosts).toBe(0);

  await page.getByTestId("pipeline-copilot-apply").click();
  await expect(page.getByTestId("pipeline-copilot-confirm")).toBeVisible();
  await expect(page.getByTestId("pipeline-copilot-confirm")).toContainText(
    /replaces the current in-memory Builder graph/i,
  );

  await page.getByTestId("pipeline-copilot-confirm-apply").click();
  await expect(page.getByTestId("pipeline-copilot-drawer")).toHaveCount(0);
  await expect(page.getByTestId("pipeline-dirty-badge")).toBeVisible();
  await expect(page.getByTestId("pipeline-publish")).toBeDisabled();
  await expect(page.getByTestId("pipeline-run")).toBeDisabled();
  await expect(
    page.getByTestId("pipeline-canvas").getByTestId("pipeline-step-node"),
  ).toHaveCount(2);
  await expect(
    page.getByTestId("pipeline-canvas").getByText("Forecast train", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId("pipeline-canvas").getByText("Load sales", { exact: true }),
  ).toBeVisible();
  expect(versionPosts).toBe(0);

  await page.getByTestId("pipeline-save").click();
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(/Pipeline version saved/i)).toBeVisible({
    timeout: 30_000,
  });
  expect(versionPosts).toBe(1);
});

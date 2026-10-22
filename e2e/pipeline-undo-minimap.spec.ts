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

async function openPipelineBuilder(page: import("@playwright/test").Page) {
  const projectName = `e2e-undo-mm-${Date.now()}`;
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

  await page.getByRole("link", { name: "데이터셋", exact: true }).click();
  await page.getByRole("button", { name: "↑ Upload dataset", exact: true }).click();
  await page.getByTestId("dataset-file").setInputFiles(iris);
  await page.getByTestId("dataset-upload").click();
  await expect(page.getByText("iris.csv")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: "파이프라인", exact: true }).click();
  await page.getByRole("button", { name: /New pipeline|새 파이프라인/i }).click();
  await page.getByTestId("pipeline-name").fill(`undo-mm-${Date.now()}`);
  await page.getByTestId("pipeline-create-submit").click();
  await expect(page.getByTestId("pipeline-library-dataset_load")).toBeVisible({ timeout: 30_000 });
}

test("pipeline builder undo/redo and MiniMap pannable navigation affordances", async ({ page }) => {
  await openPipelineBuilder(page);

  await expect(page.getByTestId("pipeline-undo")).toBeDisabled();
  await expect(page.getByTestId("pipeline-redo")).toBeDisabled();

  await page.getByTestId("pipeline-library-dataset_load").click();
  await expect(page.getByTestId("pipeline-dirty-badge")).toBeVisible();
  await expect(page.getByTestId("pipeline-undo")).toBeEnabled();

  const minimap = page.locator(".react-flow__minimap");
  await expect(minimap).toBeVisible();
  await expect(minimap).toHaveAttribute("aria-label", /미니맵/);

  // Click a point inside the MiniMap SVG; viewport should move without dirty/history churn.
  const box = await minimap.boundingBox();
  expect(box).toBeTruthy();
  if (box) {
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3);
  }
  await expect(page.getByTestId("pipeline-dirty-badge")).toBeVisible();
  await expect(page.getByTestId("pipeline-undo")).toBeEnabled();

  await page.getByTestId("pipeline-undo").click();
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0);
  await expect(page.getByTestId("pipeline-redo")).toBeEnabled();
  await page.getByTestId("pipeline-redo").click();
  await expect(page.getByTestId("pipeline-dirty-badge")).toBeVisible();
});

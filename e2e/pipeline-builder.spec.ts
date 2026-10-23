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

  await page.getByRole("link", { name: "데이터셋", exact: true }).click();
  await page.getByRole("button", { name: "↑ Upload dataset", exact: true }).click();
  await page.getByTestId("dataset-file").setInputFiles(iris);
  await page.getByTestId("dataset-upload").click();
  await expect(page.getByText("iris.csv")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: "파이프라인", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^(Pipelines|파이프라인)$/ })).toBeVisible();
  await page.getByRole("button", { name: /^(＋ )?New pipeline|^(＋ )?새 파이프라인$/ }).click();
  await page.getByTestId("pipeline-name").fill(`builder-${Date.now()}`);
  await page.getByTestId("pipeline-create-submit").click();

  await expect(page.getByTestId("pipeline-library-dataset_load")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("pipeline-library-dataset_load").click();

  await expect(page.getByTestId("pipeline-dirty-badge")).toBeVisible();
  await expect(page.getByTestId("node-config-dataset")).toBeVisible();
  await page.getByTestId("node-config-dataset").selectOption({ label: "iris.csv" });
  await expect(page.getByTestId("node-config-version")).not.toBeDisabled({ timeout: 15_000 });
  await page.getByTestId("node-config-version").selectOption({ index: 1 });

  await page.getByTestId("pipeline-step-name").fill("Load iris CSV");
  await expect(page.getByTestId("pipeline-step-name")).toHaveValue("Load iris CSV");

  await page.getByTestId("pipeline-save").click();
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(/파이프라인 버전을 저장했습니다/)).toBeVisible({ timeout: 30_000 });
});

async function gridTrackCount(locator: {
  evaluate: (fn: (el: Element) => number) => Promise<number>;
}): Promise<number> {
  return locator.evaluate((el) => {
    const value = getComputedStyle(el).gridTemplateColumns;
    if (!value || value === "none") return 0;
    return value.trim().split(/\s+/).length;
  });
}

async function firstGridTrackPx(locator: {
  evaluate: (fn: (el: Element) => number) => Promise<number>;
}): Promise<number> {
  return locator.evaluate((el) => {
    const value = getComputedStyle(el).gridTemplateColumns;
    const first = value.trim().split(/\s+/)[0] || "0px";
    return Number.parseFloat(first);
  });
}

test("pipeline builder responsive columns and Copilot drawer fit viewport", async ({ page }) => {
  const projectName = `e2e-pipe-responsive-${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();

  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "파이프라인", exact: true }).click();
  await page.getByRole("button", { name: /^(＋ )?New pipeline|^(＋ )?새 파이프라인$/ }).click();
  await page.getByTestId("pipeline-name").fill(`responsive-${Date.now()}`);
  await page.getByTestId("pipeline-create-submit").click();

  const layout = page.getByTestId("pipeline-builder-layout");
  await expect(layout).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pipeline-library-dataset_load")).toBeVisible();
  await expect(page.getByTestId("pipeline-canvas")).toBeVisible();
  await expect(page.getByTestId("pipeline-inspector").or(page.locator(".pipeline-inspector"))).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await gridTrackCount(layout)).toBe(3);
  expect(await firstGridTrackPx(layout)).toBeGreaterThan(240);
  expect(await firstGridTrackPx(layout)).toBeLessThan(280);

  await page.setViewportSize({ width: 800, height: 900 });
  expect(await gridTrackCount(layout)).toBe(3);
  expect(await firstGridTrackPx(layout)).toBeGreaterThan(200);
  expect(await firstGridTrackPx(layout)).toBeLessThan(240);

  for (const width of [740, 390] as const) {
    await page.setViewportSize({ width, height: 900 });
    expect(await gridTrackCount(layout)).toBe(1);
    await expect(page.getByTestId("pipeline-canvas")).toBeVisible();
    await expect(page.getByTestId("pipeline-library-dataset_load")).toBeVisible();
    const inspector = page.getByTestId("pipeline-inspector").or(page.locator(".pipeline-inspector"));
    await expect(inspector).toBeVisible();
    const canvasBox = await page.getByTestId("pipeline-canvas").boundingBox();
    const libraryBox = await page.getByTestId("pipeline-library-dataset_load").boundingBox();
    const inspectorBox = await inspector.boundingBox();
    expect(canvasBox).toBeTruthy();
    expect(libraryBox).toBeTruthy();
    expect(inspectorBox).toBeTruthy();
    expect(canvasBox!.width).toBeLessThanOrEqual(width + 1);
    expect(libraryBox!.x + libraryBox!.width).toBeLessThanOrEqual(width + 8);
    expect(inspectorBox!.x + inspectorBox!.width).toBeLessThanOrEqual(width + 8);
  }

  await page.setViewportSize({ width: 390, height: 900 });
  await layout.evaluate((el) => el.classList.add("is-readonly"));
  expect(await gridTrackCount(layout)).toBe(1);
  await layout.evaluate((el) => el.classList.remove("is-readonly"));

  await page.getByTestId("pipeline-copilot-open").click();
  const drawer = page.getByTestId("drawer-panel");
  await expect(drawer).toBeVisible();
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox).toBeTruthy();
  expect(drawerBox!.width).toBeLessThanOrEqual(390 + 1);
  await page.getByTestId("drawer-close").click();
  await expect(page.getByTestId("pipeline-copilot-drawer")).toHaveCount(0);

  // Restore desktop shell nav (collapsed behind "Open navigation" at 390px) before leaving Builder.
  await page.setViewportSize({ width: 1280, height: 900 });
  // Preparation Builder keeps the shared 190px desktop rail (not the pipeline 260px override).
  await page.getByRole("link", { name: "데이터 가공", exact: true }).click();
  await page.getByRole("button", { name: /새 데이터 가공|New preparation/i }).click();
  await page.getByTestId("preparation-name").fill(`prep-responsive-${Date.now()}`);
  await page.getByTestId("preparation-create-submit").click();
  const prepLayout = page.getByTestId("preparation-builder-layout");
  await expect(prepLayout).toBeVisible({ timeout: 30_000 });

  expect(await gridTrackCount(prepLayout)).toBe(3);
  expect(await firstGridTrackPx(prepLayout)).toBeGreaterThan(170);
  expect(await firstGridTrackPx(prepLayout)).toBeLessThan(210);

  await page.setViewportSize({ width: 390, height: 900 });
  expect(await gridTrackCount(prepLayout)).toBe(1);
});

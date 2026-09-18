import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

function requiredEnv(name: "E2E_ADMIN_EMAIL" | "E2E_ADMIN_PASSWORD"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Run Playwright through ./scripts/verify.sh.`);
  }
  return value;
}

const adminEmail = requiredEnv("E2E_ADMIN_EMAIL");
const adminPassword = requiredEnv("E2E_ADMIN_PASSWORD");
const runTag = `${Date.now()}-${process.pid}`;
const viewerEmail = `e2e-phase3-viewer-${runTag}@example.com`;
const viewerPassword = `Phase3-${runTag}-Strong!`;

let projectAId: number;
let projectBId: number;
let pipelineId: number;

async function adminToken(request: APIRequestContext): Promise<string> {
  const response = await request.post("/api/v1/auth/login", {
    data: { email: adminEmail, password: adminPassword },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).access_token as string;
}

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  const home = page.getByRole("heading", { name: /Workspace home/i });
  const rateLimited = page.getByText(/Rate limit exceeded/i);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await home.isVisible().catch(() => false)) return;
    if (await rateLimited.isVisible().catch(() => false)) {
      await page.waitForTimeout(5_000);
      await page.getByTestId("login-submit").click();
      continue;
    }
    await page.waitForTimeout(500);
  }
  await expect(home).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async ({ request }) => {
  const token = await adminToken(request);
  const headers = { Authorization: `Bearer ${token}` };

  const projectA = await request.post("/api/v1/projects", {
    headers,
    data: { name: `Phase 3 Hardening A ${runTag}` },
  });
  const projectB = await request.post("/api/v1/projects", {
    headers,
    data: { name: `Phase 3 Hardening B ${runTag}` },
  });
  expect(projectA.status()).toBe(201);
  expect(projectB.status()).toBe(201);
  projectAId = (await projectA.json()).id as number;
  projectBId = (await projectB.json()).id as number;

  const pipeline = await request.post(`/api/v1/projects/${projectAId}/pipelines`, {
    headers,
    data: {
      name: `Phase 3 lifecycle ${runTag}`,
      description: "Phase 3-D browser regression fixture",
      graph: { nodes: [], edges: [] },
    },
  });
  expect(pipeline.status()).toBe(201);
  pipelineId = (await pipeline.json()).id as number;

  const viewer = await request.post("/api/v1/users", {
    headers,
    data: {
      email: viewerEmail,
      password: viewerPassword,
      full_name: "Phase 3 E2E Viewer",
    },
  });
  expect(viewer.status()).toBe(201);
  const membership = await request.post(`/api/v1/projects/${projectAId}/members`, {
    headers,
    data: { user_id: (await viewer.json()).id, role: "VIEWER" },
  });
  expect(membership.status()).toBe(201);
});

test("unsaved pipeline edits guard sidebar navigation and project switching", async ({ page }) => {
  await login(page, adminEmail, adminPassword);
  await page.goto(`/projects/${projectAId}/pipelines/${pipelineId}`);
  await expect(page.getByTestId("pipeline-builder-lifecycle-summary")).toBeVisible();
  await expect(page.getByTestId("pipeline-library-dataset_load")).toBeVisible();

  const projectSelect = page.locator("#project-select");
  await expect(projectSelect).toHaveValue(String(projectAId));

  await page.getByTestId("pipeline-library-dataset_load").click();
  await expect(page.getByTestId("pipeline-dirty-badge")).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Unsaved pipeline changes");
    await dialog.dismiss();
  });
  await page.getByRole("link", { name: "Datasets", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectAId}/pipelines/${pipelineId}$`));
  await expect(page.getByTestId("pipeline-dirty-badge")).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Unsaved pipeline changes");
    await dialog.dismiss();
  });
  await projectSelect.selectOption(String(projectBId));
  await expect(projectSelect).toHaveValue(String(projectAId));
  await expect(page).toHaveURL(new RegExp(`/projects/${projectAId}/pipelines/${pipelineId}$`));

  page.once("dialog", async (dialog) => dialog.accept());
  await projectSelect.selectOption(String(projectBId));
  await expect(page).toHaveURL(new RegExp(`/projects/${projectBId}$`));
});

test("viewer can inspect lifecycle builder but cannot mutate it", async ({ page }) => {
  await login(page, viewerEmail, viewerPassword);
  await page.goto(`/projects/${projectAId}/pipelines/${pipelineId}`);

  await expect(page.getByTestId("pipeline-builder-lifecycle-summary")).toBeVisible();
  await expect(page.getByTestId("pipeline-builder-layout")).toHaveAttribute("data-readonly", "true");
  await expect(page.getByTestId("pipeline-library-dataset_load")).toHaveCount(0);
  await expect(page.getByTestId("pipeline-save")).toHaveCount(0);
  await expect(page.getByTestId("pipeline-publish")).toHaveCount(0);
  await expect(page.getByTestId("pipeline-run")).toHaveCount(0);
});

test("pipeline lifecycle UX remains usable in drawer viewport", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await login(page, adminEmail, adminPassword);
  await page.goto(`/projects/${projectAId}/pipelines/${pipelineId}`);

  await expect(page.getByTestId("pipeline-builder-lifecycle-summary")).toBeVisible();
  const toggle = page.getByRole("button", { name: "Open navigation" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await toggle.click();
  await expect(page.getByRole("button", { name: "Close navigation" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.locator("#app-sidebar")).not.toHaveAttribute("aria-hidden", "true");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(hasHorizontalOverflow).toBe(false);
});

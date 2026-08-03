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
const memberPassword = `RBAC-${runTag}-Strong!`;

let projectAId: number;
let projectBId: number;
const emails = {
  viewer: `e2e-viewer-${runTag}@example.com`,
  dataScientist: `e2e-data-scientist-${runTag}@example.com`,
};

async function adminToken(request: APIRequestContext): Promise<string> {
  const response = await request.post("/api/v1/auth/login", {
    data: { email: adminEmail, password: adminPassword },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).access_token as string;
}

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(memberPassword);
  await page.getByTestId("login-submit").click();
  const home = page.getByRole("heading", { name: /Workspace home/i });
  const rateLimited = page.getByText(/Rate limit exceeded/i);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await home.isVisible().catch(() => false)) {
      return;
    }
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
    data: { name: `RBAC E2E A ${runTag}` },
  });
  const projectB = await request.post("/api/v1/projects", {
    headers,
    data: { name: `RBAC E2E B ${runTag}` },
  });
  expect(projectA.status()).toBe(201);
  expect(projectB.status()).toBe(201);
  projectAId = (await projectA.json()).id as number;
  projectBId = (await projectB.json()).id as number;

  for (const [role, email] of [
    ["VIEWER", emails.viewer],
    ["DATA_SCIENTIST", emails.dataScientist],
  ] as const) {
    const created = await request.post("/api/v1/users", {
      headers,
      data: {
        email,
        password: memberPassword,
        full_name: role === "VIEWER" ? "E2E Viewer" : "E2E Data Scientist",
      },
    });
    expect(created.status()).toBe(201);
    const membership = await request.post(`/api/v1/projects/${projectAId}/members`, {
      headers,
      data: { user_id: (await created.json()).id, role },
    });
    expect(membership.status()).toBe(201);
  }
});

test("viewer menus and project actions are read-only", async ({ page }) => {
  await login(page, emails.viewer);

  await expect(page.getByRole("link", { name: /Administration/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Audit Logs/ })).toHaveCount(0);

  await page.goto(`/projects/${projectAId}/datasets`);
  await expect(page.getByRole("heading", { name: "Datasets", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Upload dataset/ })).toHaveCount(0);

  await page.goto(`/projects/${projectAId}/pipelines`);
  await expect(page.getByRole("heading", { name: "Pipelines", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /New pipeline/ })).toHaveCount(0);

  await page.goto(`/projects/${projectAId}/deployments`);
  await expect(page.getByRole("heading", { name: "Deployments", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /New deployment/ })).toHaveCount(0);
});

test("data scientist sees training but no approval controls", async ({ page }) => {
  await login(page, emails.dataScientist);

  await page.goto(`/projects/${projectAId}/jobs`);
  await expect(page.getByRole("heading", { name: "Training Jobs", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /New training job/ })).toBeVisible();

  await page.goto(`/projects/${projectAId}/models`);
  await expect(page.getByRole("heading", { name: "Model Registry", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Register from run/ })).toHaveCount(0);
});

test("direct navigation to another project is denied", async ({ page }) => {
  await login(page, emails.viewer);

  await page.goto(`/projects/${projectBId}`);
  await expect(page.getByRole("alert")).toContainText("not a member of this project");
  await expect(page.getByRole("heading", { name: "RBAC E2E B" })).toHaveCount(0);
});

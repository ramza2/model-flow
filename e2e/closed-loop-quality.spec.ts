import { expect, test } from "@playwright/test";

function requiredEnv(name: "E2E_ADMIN_EMAIL" | "E2E_ADMIN_PASSWORD"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Run Playwright through ./scripts/verify.sh.`);
  }
  return value;
}

const adminEmail = requiredEnv("E2E_ADMIN_EMAIL");
const adminPassword = requiredEnv("E2E_ADMIN_PASSWORD");

test("monitoring shows Production Quality and quality APIs stay candidate-bound", async ({
  page,
  request,
}) => {
  const tag = Date.now();
  const login = await request.post("/api/v1/auth/login", {
    data: { email: adminEmail, password: adminPassword },
  });
  expect(login.ok()).toBeTruthy();
  const token = (await login.json()).access_token as string;
  const headers = { Authorization: `Bearer ${token}` };

  const project = await request.post("/api/v1/projects", {
    headers,
    data: { name: `closed-loop-${tag}`, description: "phase 5-a monitoring e2e" },
  });
  expect(project.status()).toBe(201);
  const projectId = (await project.json()).id as number;

  const summary = await request.get(`/api/v1/projects/${projectId}/model-quality/summary`, {
    headers,
  });
  expect(summary.ok()).toBeTruthy();
  expect((await summary.json()).items).toEqual([]);

  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();

  await page.goto(`/projects/${projectId}/monitoring`);
  await expect(page.getByTestId("monitoring-production-quality")).toBeVisible();
  await expect(page.getByText("No production quality policies")).toBeVisible();

  // Explicit regression: quality APIs must not invent PRODUCTION promotion endpoints.
  const bogusPromote = await request.post(
    `/api/v1/projects/${projectId}/model-quality/policies/1/promote-production`,
    { headers },
  );
  expect([404, 405]).toContain(bogusPromote.status());
});

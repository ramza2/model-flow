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

test("feedback review page is reachable from project navigation", async ({ page, request }) => {
  const tag = Date.now();
  const login = await request.post("/api/v1/auth/login", {
    data: { email: adminEmail, password: adminPassword },
  });
  expect(login.ok()).toBeTruthy();
  const token = (await login.json()).access_token as string;
  const headers = { Authorization: `Bearer ${token}` };

  const project = await request.post("/api/v1/projects", {
    headers,
    data: { name: `feedback-${tag}`, description: "phase 5-b feedback e2e" },
  });
  expect(project.status()).toBe(201);
  const projectId = (await project.json()).id as number;

  const queue = await request.get(`/api/v1/projects/${projectId}/feedback`, { headers });
  expect(queue.ok()).toBeTruthy();
  expect(await queue.json()).toEqual([]);

  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();

  await page.goto(`/projects/${projectId}/feedback`);
  await expect(page.getByTestId("feedback-review-page")).toBeVisible();
  await expect(page.getByTestId("feedback-materialization-history")).toBeVisible();
});

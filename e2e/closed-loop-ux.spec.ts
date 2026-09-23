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

test("closed-loop operator hub: monitoring, feedback filters, quality policies", async ({
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
    data: { name: `closed-loop-ux-${tag}`, description: "phase 5-d operator hub e2e" },
  });
  expect(project.status()).toBe(201);
  const projectId = (await project.json()).id as number;

  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();

  await page.goto(`/projects/${projectId}/monitoring`);
  await expect(page.getByTestId("monitoring-production-quality")).toBeVisible();
  await expect(page.getByTestId("quality-history-filters")).toBeVisible();
  await expect(page.getByTestId("quality-history-pagination")).toBeVisible();
  await expect(page.getByTestId("quality-policies-link")).toHaveAttribute(
    "href",
    `/projects/${projectId}/model-quality/policies`,
  );

  await page.goto(`/projects/${projectId}/feedback?endpoint_id=99&review_status=PENDING`);
  await expect(page.getByTestId("feedback-review-page")).toBeVisible();
  await expect(page.getByTestId("feedback-endpoint-filter")).toHaveValue("99");
  await expect(page.getByTestId("feedback-status-filter")).toHaveValue("PENDING");
  await expect(page.getByTestId("feedback-materializable-filter")).toBeVisible();
  await expect(page.getByTestId("materialization-history-pagination")).toBeVisible();

  await page.goto(`/projects/${projectId}/model-quality/policies`);
  await expect(page.getByTestId("quality-policies-page")).toBeVisible();
  await expect(page.getByTestId("create-policy-btn")).toBeVisible();
});

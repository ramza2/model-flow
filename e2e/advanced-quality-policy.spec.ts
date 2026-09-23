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

test("quality policies page is reachable and supports admin write UI", async ({
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
    data: { name: `quality-policies-${tag}`, description: "phase 5-c quality policies e2e" },
  });
  expect(project.status()).toBe(201);
  const projectId = (await project.json()).id as number;

  const policies = await request.get(`/api/v1/projects/${projectId}/model-quality/policies`, {
    headers,
  });
  expect(policies.ok()).toBeTruthy();
  expect(await policies.json()).toEqual([]);

  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();

  await page.goto(`/projects/${projectId}/model-quality/policies`);
  await expect(page.getByTestId("quality-policies-page")).toBeVisible();
  await expect(page.getByRole("link", { name: /Quality Policies/i }).first()).toBeVisible();
  await expect(page.getByTestId("create-policy-btn")).toBeVisible();

  await page.getByTestId("create-policy-btn").click();
  await expect(page.getByTestId("quality-policy-form")).toBeVisible();
  await expect(page.getByTestId("add-rule")).toBeVisible();
  await expect(page.getByTestId("rule-row-0")).toBeVisible();
  await expect(page.getByTestId("policy-rule-logic")).toBeVisible();

  await page.getByTestId("rule-comparison-0").selectOption("baseline_delta");
  await expect(page.getByTestId("baseline-delta-help-0")).toContainText(
    "Positive delta means the production metric became worse than the pinned baseline.",
  );
  await expect(page.getByTestId("baseline-required-warning")).toBeVisible();

  // Optional: seed advanced policy via API when an endpoint exists; otherwise Monitoring
  // empty state still links to quality policies.
  await page.goto(`/projects/${projectId}/monitoring`);
  await expect(page.getByTestId("monitoring-production-quality")).toBeVisible();
  await expect(page.getByTestId("quality-policies-link")).toHaveAttribute(
    "href",
    `/projects/${projectId}/model-quality/policies`,
  );
});

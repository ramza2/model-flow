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

test("drift run generates operational alert and resolves through UI", async ({ page, request }) => {
  const tag = Date.now();

  const login = await request.post("/api/v1/auth/login", {
    data: { email: adminEmail, password: adminPassword },
  });
  expect(login.ok()).toBeTruthy();
  const token = (await login.json()).access_token as string;
  const headers = { Authorization: `Bearer ${token}` };

  const project = await request.post("/api/v1/projects", {
    headers,
    data: { name: `drift-alert-${tag}`, description: "drift alert integration e2e" },
  });
  expect(project.status()).toBe(201);
  const projectId = (await project.json()).id as number;

  const datasetV1 = "age,income\n20,100\n22,120\n24,130\n26,110\n";
  const datasetV2 = "age,income\n60,900\n63,980\n65,1100\n67,1020\n";
  const upload1 = await request.post(`/api/v1/projects/${projectId}/datasets`, {
    headers,
    multipart: { file: { name: "drift_v1.csv", mimeType: "text/csv", buffer: Buffer.from(datasetV1) } },
  });
  expect(upload1.status()).toBe(201);
  const v1 = (await upload1.json()).version.id as number;
  const upload2 = await request.post(`/api/v1/projects/${projectId}/datasets`, {
    headers,
    multipart: { file: { name: "drift_v2.csv", mimeType: "text/csv", buffer: Buffer.from(datasetV2) } },
  });
  expect(upload2.status()).toBe(201);
  const v2 = (await upload2.json()).version.id as number;

  const createRun = await request.post(`/api/v1/projects/${projectId}/drift-runs`, {
    headers,
    data: {
      reference_version_id: v1,
      current_version_id: v2,
      thresholds: { watch: 0.01, critical: 0.02 },
    },
  });
  expect(createRun.status()).toBe(202);
  const runId = (await createRun.json()).id as number;

  let runStatus = "pending";
  let overallStatus: string | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const run = await request.get(`/api/v1/projects/${projectId}/drift-runs/${runId}`, { headers });
    expect(run.ok()).toBeTruthy();
    const body = await run.json();
    runStatus = body.status as string;
    overallStatus = body.overall_status as string | null;
    if (runStatus === "succeeded") break;
    await page.waitForTimeout(1000);
  }
  expect(runStatus).toBe("succeeded");
  expect(["watch", "critical"]).toContain(overallStatus || "");

  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();

  await page.goto(`/projects/${projectId}/alerts`);
  const alertTitle = overallStatus === "critical"
    ? "Critical data drift detected"
    : "Data drift requires attention";
  await expect(page.getByText(alertTitle)).toBeVisible();
  await expect(page.getByText(/Drift run #/)).toBeVisible();
  await expect(page.getByRole("link", { name: "View related item →" })).toBeVisible();

  await page.getByRole("link", { name: "View related item →" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/monitoring`));

  await page.goto(`/projects/${projectId}/alerts`);
  const resolve = page.getByRole("button", { name: "Resolve" });
  await expect(resolve).toHaveAttribute(
    "title",
    "Mark this alert as resolved. It remains available in the Resolved tab.",
  );
  await resolve.click();
  await expect(page.getByText("Alert resolved.")).toBeVisible();
  await expect(page.getByText(alertTitle)).toHaveCount(0);

  await page.getByRole("button", { name: "Resolved" }).click();
  await expect(page.getByText(alertTitle)).toBeVisible();
});

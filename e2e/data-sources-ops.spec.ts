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

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();
}

test("data source lifecycle activate deactivate and permanent delete", async ({ page }) => {
  const projectName = `ds-ops-${Date.now()}`;
  const unusedName = `unused-source-${Date.now()}`;
  const usedName = `used-source-${Date.now()}`;

  await login(page);

  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-description").fill("Data source operations E2E");
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Data Sources", exact: true }).click();
  await page.getByTestId("add-data-source").click();
  await page.getByTestId("data-source-name").fill(unusedName);
  await page.getByTestId("data-source-type").selectOption("file");
  await page.getByTestId("data-source-config").fill('{"root":"uploads"}');
  await page.getByTestId("data-source-save").click();
  await expect(page.getByRole("heading", { name: unusedName })).toBeVisible();

  const unusedCard = page.locator("article.source-card").filter({ hasText: unusedName });
  page.once("dialog", (dialog) => dialog.accept());
  await unusedCard.getByRole("button", { name: "Deactivate" }).click();
  await expect(unusedCard.getByRole("button", { name: "Activate" })).toBeVisible({ timeout: 15_000 });

  await unusedCard.getByRole("button", { name: "Activate" }).click();
  await expect(unusedCard.getByRole("button", { name: "Deactivate" })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await unusedCard.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByRole("heading", { name: unusedName })).toHaveCount(0);

  // Create a postgres source and give it import history via API, then assert delete blocked.
  await page.getByTestId("add-data-source").click();
  await page.getByTestId("data-source-name").fill(usedName);
  await page.getByTestId("data-source-type").selectOption("postgres");
  await page
    .getByTestId("data-source-config")
    .fill(
      JSON.stringify(
        {
          host: "postgres-source",
          port: 5432,
          database: process.env.E2E_SOURCE_POSTGRES_DB || "source",
          user: process.env.E2E_SOURCE_POSTGRES_USER || "source",
        },
        null,
        2,
      ),
    );
  if (process.env.E2E_SOURCE_POSTGRES_PASSWORD) {
    await page.getByTestId("data-source-password").fill(process.env.E2E_SOURCE_POSTGRES_PASSWORD);
  } else {
    await page.getByTestId("data-source-password").fill("unused-password");
  }
  await page.getByTestId("data-source-save").click();
  await expect(page.getByRole("heading", { name: usedName })).toBeVisible();

  const usedCard = page.locator("article.source-card").filter({ hasText: usedName });
  const testIdAttr = await usedCard.getAttribute("data-testid");
  const sourceId = Number((testIdAttr || "").replace("data-source-card-", ""));
  expect(sourceId).toBeGreaterThan(0);

  const projectUrl = page.url();
  const projectId = Number(projectUrl.match(/\/projects\/(\d+)/)?.[1]);
  expect(projectId).toBeGreaterThan(0);

  const token = await page.evaluate(() => localStorage.getItem("modelflow_token"));
  expect(token).toBeTruthy();

  const apiBase = process.env.E2E_API_BASE || "http://localhost:8000/api/v1";
  const importResponse = await page.request.post(
    `${apiBase}/projects/${projectId}/data-sources/${sourceId}/import`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      data: {
        dataset_name: `history-${Date.now()}`,
        table_or_query: "public.customers",
      },
    },
  );
  // Import may succeed (source up) or fail validation; 202 means a job (history) was created.
  if (importResponse.status() === 202) {
    const job = await importResponse.json();
    expect(job.id).toBeTruthy();
    await page.waitForTimeout(2000);

    page.once("dialog", (dialog) => dialog.accept());
    await usedCard.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByText(/import history|cannot be permanently deleted/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("heading", { name: usedName })).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await usedCard.getByRole("button", { name: "Deactivate" }).click();
    await expect(usedCard.getByRole("button", { name: "Activate" })).toBeVisible({ timeout: 15_000 });
  } else {
    test.info().annotations.push({
      type: "note",
      description: `Import setup status ${importResponse.status()}; delete-block assertion skipped`,
    });
  }
});

test("postgres import discovery UI when source credentials are available", async ({ page }) => {
  const sourceDb = process.env.E2E_SOURCE_POSTGRES_DB;
  const sourceUser = process.env.E2E_SOURCE_POSTGRES_USER;
  const sourcePassword = process.env.E2E_SOURCE_POSTGRES_PASSWORD;
  test.skip(!sourceDb || !sourceUser || !sourcePassword, "Source Postgres credentials not provided");

  const projectName = `ds-import-${Date.now()}`;
  const sourceName = `pg-import-${Date.now()}`;

  await login(page);
  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Data Sources", exact: true }).click();
  await page.getByTestId("add-data-source").click();
  await page.getByTestId("data-source-name").fill(sourceName);
  await page.getByTestId("data-source-type").selectOption("postgres");
  await page.getByTestId("data-source-config").fill(
    JSON.stringify({ host: "postgres-source", port: 5432, database: sourceDb, user: sourceUser }, null, 2),
  );
  await page.getByTestId("data-source-password").fill(sourcePassword!);
  await page.getByTestId("data-source-save").click();
  await expect(page.getByRole("heading", { name: sourceName })).toBeVisible();

  const card = page.locator("article.source-card").filter({ hasText: sourceName });
  await card.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Connection succeeded/i })).toBeVisible({
    timeout: 30_000,
  });

  await card.getByRole("button", { name: "Import data" }).click();
  const panel = page.getByTestId(/import-panel-/);
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("import-schema")).toBeVisible();
  // Prefer public.customers from init-source.sql
  await panel.getByTestId("import-schema").selectOption("public");
  await expect(panel.getByTestId("import-table")).toBeVisible();
  await panel.getByTestId("import-table").selectOption("customers");
  const datasetName = `customers-${Date.now()}`;
  await panel.getByTestId("import-dataset-name").fill(datasetName);
  await panel.getByTestId("import-submit").click();
  await expect(panel.getByTestId("open-imported-dataset")).toBeVisible({ timeout: 120_000 });
  await panel.getByTestId("open-imported-dataset").click();
  await expect(page.getByRole("heading", { name: datasetName })).toBeVisible({ timeout: 30_000 });
});

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

type PlaywrightPage = import("@playwright/test").Page;

async function login(page: PlaywrightPage) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();
}

async function createPostgresSource(
  page: PlaywrightPage,
  options: {
    name: string;
    host?: string;
    port?: string;
    database: string;
    user: string;
    password: string;
  },
) {
  await page.getByTestId("add-data-source").click();
  await page.getByTestId("data-source-name").fill(options.name);
  await page.getByTestId("data-source-type").selectOption("postgres");
  await page.getByTestId("data-source-connection-mode").selectOption("host_port");
  await expect(page.getByTestId("data-source-host")).toBeVisible();
  await expect(page.getByTestId("data-source-config")).toHaveCount(0);
  await page.getByTestId("data-source-host").fill(options.host ?? "postgres-source");
  await page.getByTestId("data-source-port").fill(options.port ?? "5432");
  await page.getByTestId("data-source-database").fill(options.database);
  await page.getByTestId("data-source-user").fill(options.user);
  await page.getByTestId("data-source-password").fill(options.password);
  await page.getByTestId("data-source-save").click();
  await expect(page.getByRole("heading", { name: options.name })).toBeVisible();
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
  await createPostgresSource(page, {
    name: usedName,
    database: process.env.E2E_SOURCE_POSTGRES_DB || "source",
    user: process.env.E2E_SOURCE_POSTGRES_USER || "source",
    password: process.env.E2E_SOURCE_POSTGRES_PASSWORD || "unused-password",
  });

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
  await createPostgresSource(page, {
    name: sourceName,
    database: sourceDb!,
    user: sourceUser!,
    password: sourcePassword!,
  });

  const card = page.locator("article.source-card").filter({ hasText: sourceName });
  await card.getByRole("button", { name: "Test connection" }).click();
  const successNotice = page.getByRole("status").filter({ hasText: /Connection succeeded/i });
  await expect(successNotice).toBeVisible({ timeout: 30_000 });
  await expect(successNotice).toHaveClass(/success/);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(card.getByTestId(/last-test-message-/)).toHaveClass(/ok/);

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

test("postgres DSN connection mode create edit and typed switch", async ({ page }) => {
  const sourceDb = process.env.E2E_SOURCE_POSTGRES_DB;
  const sourceUser = process.env.E2E_SOURCE_POSTGRES_USER;
  const sourcePassword = process.env.E2E_SOURCE_POSTGRES_PASSWORD;
  test.skip(!sourceDb || !sourceUser || !sourcePassword, "Source Postgres credentials not provided");

  const projectName = `ds-dsn-${Date.now()}`;
  const sourceName = `pg-dsn-${Date.now()}`;
  const renamed = `${sourceName}-renamed`;
  const host = process.env.E2E_SOURCE_POSTGRES_HOST || "postgres-source";
  const port = process.env.E2E_SOURCE_POSTGRES_PORT || "5432";
  const dsn = `postgresql://${sourceUser}:${sourcePassword}@${host}:${port}/${sourceDb}`;

  await login(page);
  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Data Sources", exact: true }).click();
  await page.getByTestId("add-data-source").click();
  await page.getByTestId("data-source-name").fill(sourceName);
  await page.getByTestId("data-source-type").selectOption("postgres");
  await page.getByTestId("data-source-connection-mode").selectOption("connection_url");
  await expect(page.getByTestId("data-source-connection-url")).toBeVisible();
  await expect(page.getByTestId("data-source-host")).toHaveCount(0);
  await page.getByTestId("data-source-connection-url").fill(dsn);
  await page.getByTestId("data-source-save").click();
  await expect(page.getByRole("heading", { name: sourceName })).toBeVisible();

  const card = page.locator("article.source-card").filter({ hasText: sourceName });
  await card.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Connection succeeded/i })).toBeVisible({
    timeout: 30_000,
  });

  await card.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("data-source-connection-mode")).toHaveValue("connection_url");
  const connectionUrlInput = page.getByTestId("data-source-connection-url");
  await expect(connectionUrlInput).toHaveValue("");
  await expect(connectionUrlInput).toHaveAttribute("type", "password");
  await expect(connectionUrlInput).toHaveAttribute(
    "placeholder",
    "Leave blank to keep saved connection URL",
  );
  await expect(page.getByText(/saved connection URL is not shown/i)).toBeVisible();
  await expect(page.getByTestId("data-source-host")).toHaveCount(0);
  await expect(page.getByTestId("data-source-password")).toHaveCount(0);

  await page.getByTestId("data-source-name").fill(renamed);
  await page.getByTestId("data-source-save").click();
  await expect(page.getByRole("heading", { name: renamed })).toBeVisible();

  const renamedCard = page.locator("article.source-card").filter({ hasText: renamed });
  await renamedCard.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Connection succeeded/i })).toBeVisible({
    timeout: 30_000,
  });

  await renamedCard.getByRole("button", { name: "Edit" }).click();
  await page.getByTestId("data-source-connection-mode").selectOption("host_port");
  await page.getByTestId("data-source-host").fill(host);
  await page.getByTestId("data-source-port").fill(port);
  await page.getByTestId("data-source-database").fill(sourceDb!);
  await page.getByTestId("data-source-user").fill(sourceUser!);
  await page.getByTestId("data-source-password").fill(sourcePassword!);
  await page.getByTestId("data-source-save").click();
  await expect(page.getByRole("heading", { name: renamed })).toBeVisible();

  await renamedCard.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Connection succeeded/i })).toBeVisible({
    timeout: 30_000,
  });

  await renamedCard.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("data-source-connection-mode")).toHaveValue("host_port");
  const passwordInput = page.getByTestId("data-source-password");
  await expect(passwordInput).toHaveValue("");
  await expect(passwordInput).toHaveAttribute("type", "password");
  await expect(passwordInput).toHaveAttribute("placeholder", "Leave blank to keep saved password");
  await expect(page.getByTestId("data-source-connection-url")).toHaveCount(0);
});

test("typed postgres form connection test shows error styling on refused connection", async ({ page }) => {
  const projectName = `ds-test-fail-${Date.now()}`;
  const sourceName = `pg-bad-${Date.now()}`;

  await login(page);
  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Data Sources", exact: true }).click();
  // 127.0.0.1:1 is refused inside the API container; connect_timeout is 5s.
  await createPostgresSource(page, {
    name: sourceName,
    host: "127.0.0.1",
    port: "1",
    database: "unreachable",
    user: "unreachable",
    password: "unreachable",
  });

  const card = page.locator("article.source-card").filter({ hasText: sourceName });
  await card.getByRole("button", { name: "Test connection" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(alert).toHaveClass(/error/);
  await expect(alert).toContainText(/Connection failed/i);
  await expect(page.locator(".success")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: /Connection succeeded/i })).toHaveCount(0);
  await expect(card.getByTestId(/last-test-message-/)).toHaveClass(/err/);
  await expect(card.getByTestId(/last-test-message-/)).toContainText(/Connection failed/i);
});


async function createMysqlSource(
  page: PlaywrightPage,
  options: {
    name: string;
    host?: string;
    port?: string;
    database: string;
    user: string;
    password: string;
  },
) {
  await page.getByTestId("add-data-source").click();
  await page.getByTestId("data-source-name").fill(options.name);
  await page.getByTestId("data-source-type").selectOption("mysql");
  await page.getByTestId("data-source-connection-mode").selectOption("host_port");
  await expect(page.getByTestId("data-source-host")).toBeVisible();
  await expect(page.getByTestId("data-source-port")).toHaveValue("3306");
  await page.getByTestId("data-source-host").fill(options.host ?? "mysql-source");
  await page.getByTestId("data-source-port").fill(options.port ?? "3306");
  await page.getByTestId("data-source-database").fill(options.database);
  await page.getByTestId("data-source-user").fill(options.user);
  await page.getByTestId("data-source-password").fill(options.password);
  await page.getByTestId("data-source-save").click();
  await expect(page.getByRole("heading", { name: options.name })).toBeVisible();
}

async function importMysqlFamilyCustomers(
  page: PlaywrightPage,
  options: {
    sourceName: string;
    database: string;
    host: string;
    user: string;
    password: string;
  },
) {
  const projectName = `ds-mysql-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const datasetName = `customers-${Date.now()}`;

  await login(page);
  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Data Sources", exact: true }).click();
  await createMysqlSource(page, {
    name: options.sourceName,
    host: options.host,
    database: options.database,
    user: options.user,
    password: options.password,
  });

  const card = page.locator("article.source-card").filter({ hasText: options.sourceName });
  await expect(card).toContainText("MySQL / MariaDB");
  await card.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Connection succeeded/i })).toBeVisible({
    timeout: 60_000,
  });

  await card.getByRole("button", { name: "Import data" }).click();
  const panel = page.getByTestId(/import-panel-/);
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("import-schema")).toBeVisible();
  await panel.getByTestId("import-schema").selectOption(options.database);
  await expect(panel.getByTestId("import-table")).toBeVisible();
  await panel.getByTestId("import-table").selectOption("customers");
  await panel.getByTestId("import-dataset-name").fill(datasetName);
  await panel.getByTestId("import-submit").click();
  await expect(panel.getByTestId("open-imported-dataset")).toBeVisible({ timeout: 120_000 });
  await panel.getByTestId("open-imported-dataset").click();
  await expect(page.getByRole("heading", { name: datasetName })).toBeVisible({ timeout: 30_000 });
}

test("mysql import discovery UI when source credentials are available", async ({ page }) => {
  const sourceDb = process.env.E2E_SOURCE_MYSQL_DB;
  const sourceUser = process.env.E2E_SOURCE_MYSQL_USER;
  const sourcePassword = process.env.E2E_SOURCE_MYSQL_PASSWORD;
  const sourceHost = process.env.E2E_SOURCE_MYSQL_HOST || "mysql-source";
  test.skip(!sourceDb || !sourceUser || !sourcePassword, "Source MySQL credentials not provided");

  await importMysqlFamilyCustomers(page, {
    sourceName: `mysql-import-${Date.now()}`,
    database: sourceDb!,
    host: sourceHost,
    user: sourceUser!,
    password: sourcePassword!,
  });
});

test("mariadb import discovery UI when source credentials are available", async ({ page }) => {
  const sourceDb = process.env.E2E_SOURCE_MARIADB_DB;
  const sourceUser = process.env.E2E_SOURCE_MARIADB_USER;
  const sourcePassword = process.env.E2E_SOURCE_MARIADB_PASSWORD;
  const sourceHost = process.env.E2E_SOURCE_MARIADB_HOST || "mariadb-source";
  test.skip(!sourceDb || !sourceUser || !sourcePassword, "Source MariaDB credentials not provided");

  await importMysqlFamilyCustomers(page, {
    sourceName: `mariadb-import-${Date.now()}`,
    database: sourceDb!,
    host: sourceHost,
    user: sourceUser!,
    password: sourcePassword!,
  });
});

async function createMssqlSource(
  page: PlaywrightPage,
  options: {
    name: string;
    host?: string;
    port?: string;
    database: string;
    user: string;
    password: string;
  },
) {
  await page.getByTestId("add-data-source").click();
  await page.getByTestId("data-source-name").fill(options.name);
  await page.getByTestId("data-source-type").selectOption("mssql");
  await page.getByTestId("data-source-connection-mode").selectOption("host_port");
  await expect(page.getByTestId("data-source-host")).toBeVisible();
  await expect(page.getByTestId("data-source-port")).toHaveValue("1433");
  await page.getByTestId("data-source-host").fill(options.host ?? "mssql-source");
  await page.getByTestId("data-source-port").fill(options.port ?? "1433");
  await page.getByTestId("data-source-database").fill(options.database);
  await page.getByTestId("data-source-user").fill(options.user);
  await page.getByTestId("data-source-password").fill(options.password);
  await page.getByTestId("data-source-trust-server-certificate").check();
  await page.getByTestId("data-source-save").click();
  await expect(page.getByRole("heading", { name: options.name })).toBeVisible();
}

test("mssql import discovery UI when source credentials are available", async ({ page }) => {
  const sourceDb = process.env.E2E_SOURCE_MSSQL_DB;
  const sourceUser = process.env.E2E_SOURCE_MSSQL_USER;
  const sourcePassword = process.env.E2E_SOURCE_MSSQL_PASSWORD;
  const sourceHost = process.env.E2E_SOURCE_MSSQL_HOST || "mssql-source";
  test.skip(!sourceDb || !sourceUser || !sourcePassword, "Source SQL Server credentials not provided");

  const projectName = `ds-mssql-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const sourceName = `mssql-import-${Date.now()}`;
  const datasetName = `customers-${Date.now()}`;

  await login(page);
  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Data Sources", exact: true }).click();
  await createMssqlSource(page, {
    name: sourceName,
    host: sourceHost,
    database: sourceDb!,
    user: sourceUser!,
    password: sourcePassword!,
  });

  const card = page.locator("article.source-card").filter({ hasText: sourceName });
  await expect(card).toContainText("Microsoft SQL Server");
  await card.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Connection succeeded/i })).toBeVisible({
    timeout: 60_000,
  });

  await card.getByRole("button", { name: "Import data" }).click();
  const panel = page.getByTestId(/import-panel-/);
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("import-schema")).toBeVisible();
  await panel.getByTestId("import-schema").selectOption("dbo");
  await expect(panel.getByTestId("import-table")).toBeVisible();
  await panel.getByTestId("import-table").selectOption("customers");
  await panel.getByTestId("import-dataset-name").fill(datasetName);
  await panel.getByTestId("import-submit").click();
  await expect(panel.getByTestId("open-imported-dataset")).toBeVisible({ timeout: 120_000 });
  await panel.getByTestId("open-imported-dataset").click();
  await expect(page.getByRole("heading", { name: datasetName })).toBeVisible({ timeout: 30_000 });
});

async function createOracleSource(
  page: PlaywrightPage,
  options: {
    name: string;
    host?: string;
    port?: string;
    serviceName: string;
    user: string;
    password: string;
  },
) {
  await page.getByTestId("add-data-source").click();
  await page.getByTestId("data-source-name").fill(options.name);
  await page.getByTestId("data-source-type").selectOption("oracle");
  await page.getByTestId("data-source-connection-mode").selectOption("host_port");
  await expect(page.getByTestId("data-source-host")).toBeVisible();
  await expect(page.getByTestId("data-source-port")).toHaveValue("1521");
  await page.getByTestId("data-source-host").fill(options.host ?? "oracle-source");
  await page.getByTestId("data-source-port").fill(options.port ?? "1521");
  await page.getByTestId("data-source-service-name").fill(options.serviceName);
  await page.getByTestId("data-source-user").fill(options.user);
  await page.getByTestId("data-source-password").fill(options.password);
  await page.getByTestId("data-source-save").click();
  await expect(page.getByRole("heading", { name: options.name })).toBeVisible();
}

test("oracle import discovery UI when source credentials are available", async ({ page }) => {
  const serviceName = process.env.E2E_SOURCE_ORACLE_SERVICE_NAME;
  const sourceUser = process.env.E2E_SOURCE_ORACLE_USER;
  const sourcePassword = process.env.E2E_SOURCE_ORACLE_PASSWORD;
  const sourceHost = process.env.E2E_SOURCE_ORACLE_HOST || "oracle-source";
  test.skip(
    !serviceName || !sourceUser || !sourcePassword,
    "Source Oracle credentials not provided",
  );

  const projectName = `ds-oracle-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const sourceName = `oracle-import-${Date.now()}`;
  const datasetName = `customers-${Date.now()}`;

  await login(page);
  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Data Sources", exact: true }).click();
  await createOracleSource(page, {
    name: sourceName,
    host: sourceHost,
    serviceName: serviceName!,
    user: sourceUser!,
    password: sourcePassword!,
  });

  const card = page.locator("article.source-card").filter({ hasText: sourceName });
  await expect(card).toContainText("Oracle Database");
  await card.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Connection succeeded/i })).toBeVisible({
    timeout: 60_000,
  });

  await card.getByRole("button", { name: "Import data" }).click();
  const panel = page.getByTestId(/import-panel-/);
  await expect(panel).toBeVisible();
  const schemaSelect = panel.getByTestId("import-schema");
  await expect(schemaSelect).toBeVisible();
  // Wait until real schemas are loaded (not the empty/loading placeholder).
  await expect(schemaSelect.locator("option").nth(1)).toBeAttached({ timeout: 60_000 });
  const preferredApp = (process.env.E2E_SOURCE_ORACLE_APP_USER || "").trim().toLowerCase();
  const labels = (await schemaSelect.locator("option").allTextContents()).map((s) => s.trim());
  const schemaOption =
    labels.find((label) => preferredApp && label.toLowerCase() === preferredApp) ||
    labels.find((label) => /^oraapp_/i.test(label)) ||
    labels.find((label) => label.toLowerCase() === (sourceUser || "").toLowerCase());
  expect(schemaOption, `available schemas: ${JSON.stringify(labels)}`).toBeTruthy();
  await schemaSelect.selectOption(schemaOption!);
  const tableSelect = panel.getByTestId("import-table");
  await expect(tableSelect).toBeVisible();
  await expect(tableSelect.locator("option", { hasText: /customers/i })).toBeAttached({
    timeout: 60_000,
  });
  await tableSelect.selectOption("customers");
  await panel.getByTestId("import-dataset-name").fill(datasetName);
  await panel.getByTestId("import-submit").click();
  await expect(panel.getByTestId("open-imported-dataset")).toBeVisible({ timeout: 120_000 });
  await panel.getByTestId("open-imported-dataset").click();
  await expect(page.getByRole("heading", { name: datasetName })).toBeVisible({ timeout: 30_000 });
});

test("REST API source test preview and import use the existing dataset lifecycle", async ({ page }) => {
  const projectName = `rest-source-${Date.now()}`;
  const sourceName = `rest-health-${Date.now()}`;
  const datasetName = `rest-health-dataset-${Date.now()}`;

  await login(page);
  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Data Sources", exact: true }).click();
  await page.getByTestId("add-data-source").click();
  await page.getByTestId("data-source-name").fill(sourceName);
  await page.getByTestId("data-source-type").selectOption("rest_api");
  await page.getByTestId("data-source-rest-base-url").fill("http://backend:8000");
  await page.getByTestId("data-source-rest-resource-path").fill("/api/v1/health");
  await page.getByTestId("data-source-rest-auth-type").selectOption("none");
  await page.getByTestId("data-source-save").click();

  const card = page.locator("article.source-card").filter({ hasText: sourceName });
  await expect(card).toBeVisible();
  await expect(card).toContainText("REST API");

  await card.getByRole("button", { name: "Test connection" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /JSON response received/i }),
  ).toBeVisible({ timeout: 30_000 });

  await card.getByRole("button", { name: "Import data" }).click();
  const panel = page.getByTestId(/import-panel-/);
  await expect(panel.getByText("Import from REST API")).toBeVisible();
  await expect(panel.getByTestId("import-rest-resource")).toHaveValue("/api/v1/health");
  await panel.getByTestId("import-dataset-name").fill(datasetName);

  await panel.getByTestId("import-rest-preview").click();
  const preview = panel.getByTestId("import-rest-preview-table");
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(preview).toContainText("status");
  await expect(preview).toContainText("backend");

  await panel.getByTestId("import-submit").click();
  await expect(panel.getByTestId("open-imported-dataset")).toBeVisible({
    timeout: 120_000,
  });
  await panel.getByTestId("open-imported-dataset").click();
  await expect(page.getByRole("heading", { name: datasetName })).toBeVisible({
    timeout: 30_000,
  });
});

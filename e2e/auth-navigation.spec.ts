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

test("login protects routes and restores the authenticated shell", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill("incorrect-password");
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("alert")).toContainText("Invalid email or password");

  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Projects/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Audit Logs/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Administration/ })).toBeVisible();
  await page.screenshot({ path: "artifacts/screenshots/00-authenticated-shell.png", fullPage: true });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();

  await page.locator("details.user-menu summary").click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});

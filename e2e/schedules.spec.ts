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

test("schedules run-now creates history entry", async ({ page }) => {
  const projectName = `e2e-schedules-${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /작업 공간 홈/ })).toBeVisible();

  await page.getByRole("link", { name: "프로젝트 만들기" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "파이프라인", exact: true }).click();
  await page.getByRole("button", { name: /^(＋ )?New pipeline|^(＋ )?새 파이프라인$/ }).click();
  await page.getByTestId("pipeline-name").fill(`sched-pipe-${Date.now()}`);
  await page.getByTestId("pipeline-create-submit").click();
  await expect(page.getByTestId("pipeline-library-notification")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("pipeline-library-notification").click();
  await expect(page.getByTestId("pipeline-dirty-badge")).toBeVisible();
  await page.getByTestId("pipeline-save").click();
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(/파이프라인 버전을 저장했습니다/)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("pipeline-publish").click();
  await expect(page.getByText(/파이프라인을 게시했습니다/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: "스케줄", exact: true }).click();
  await expect(page.getByRole("heading", { name: "스케줄", exact: true })).toBeVisible();
  await page.getByTestId("schedule-create-open").click();
  await expect(page.getByTestId("schedule-drawer")).toBeVisible();
  await page.getByLabel("이름").fill(`nightly-${Date.now()}`);
  await page.getByLabel("실행 대상 유형").selectOption("pipeline_run");
  await page.getByTestId("schedule-pipeline-select").selectOption({ index: 1 });
  await page.getByTestId("schedule-submit").click();
  await expect(page.getByText(/스케줄을 생성했습니다/i)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "지금 실행" }).first().click();
  await expect(page.getByText(/즉시 실행을 요청했습니다/i)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "실행 이력" }).first().click();
  await expect(page.getByText("수동")).toBeVisible({ timeout: 30_000 });
});

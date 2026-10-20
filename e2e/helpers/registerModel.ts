import { expect, type Page } from "@playwright/test";

export async function registerTrainedModel(page: Page, expectedModelName: string) {
  await expect(page.getByTestId("register-model")).toBeVisible({ timeout: 180_000 });
  await page.getByTestId("register-model").click();
  await expect(page.getByTestId("register-model-dialog")).toBeVisible();
  await expect(page.getByTestId("register-model-name")).toHaveValue(expectedModelName);
  await page.getByTestId("register-model-submit").click();
  await expect(
    page.getByText(new RegExp(`모델 ${expectedModelName} v\\d+을 등록했습니다`)),
  ).toBeVisible({
    timeout: 60_000,
  });
}

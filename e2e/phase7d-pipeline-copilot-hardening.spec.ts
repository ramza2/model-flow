import { expect, test, type Page } from "@playwright/test";
import path from "path";

const iris = path.resolve(__dirname, "../samples/iris.csv");

function requiredEnv(name: "E2E_ADMIN_EMAIL" | "E2E_ADMIN_PASSWORD"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Run Playwright through ./scripts/verify.sh.`);
  }
  return value;
}

const adminEmail = requiredEnv("E2E_ADMIN_EMAIL");
const adminPassword = requiredEnv("E2E_ADMIN_PASSWORD");

async function loginAndOpenBuilder(page: Page, projectName: string): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByTestId("login-email").fill(adminEmail);
  await page.getByTestId("login-password").fill(adminPassword);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /Workspace home/i })).toBeVisible();

  await page.getByRole("link", { name: "Create project" }).click();
  await page.getByTestId("project-name").fill(projectName);
  await page.getByTestId("project-submit").click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: "Datasets", exact: true }).click();
  await page.getByRole("button", { name: "↑ Upload dataset", exact: true }).click();
  await page.getByTestId("dataset-file").setInputFiles(iris);
  await page.getByTestId("dataset-upload").click();
  await expect(page.getByText("iris.csv")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: "Pipelines", exact: true }).click();
  await page.getByRole("button", { name: /New pipeline/i }).click();
  await page.getByTestId("pipeline-name").fill(`copilot-hard-${Date.now()}`);
  await page.getByTestId("pipeline-create-submit").click();
  await expect(page.getByTestId("pipeline-copilot-open")).toBeVisible({ timeout: 30_000 });
}

function mockDraftGraph(summary: string) {
  return {
    summary,
    model: "e2e-mock-model",
    warnings: [],
    validation: { valid: true, errors: [], order: ["notification-1"] },
    graph: {
      nodes: [
        {
          id: "notification-1",
          position: { x: 40, y: 40 },
          data: {
            label: "Notify",
            node_type: "notification",
            config: {
              alert_type: "pipeline",
              severity: "info",
              title: "ok",
              message: "ok",
            },
          },
        },
      ],
      edges: [],
    },
  };
}

test("Phase 7-D: stale draft response after close and 502 leave Builder unchanged", async ({
  page,
}) => {
  const projectName = `e2e-copilot-7d-stale-${Date.now()}`;
  let versionPosts = 0;
  let publishPosts = 0;
  let runPosts = 0;
  let releaseStale: (() => void) | null = null;
  let draftCalls = 0;

  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const url = request.url();
    if (/\/api\/v1\/projects\/\d+\/pipelines\/\d+\/versions$/.test(url)) versionPosts += 1;
    if (/\/api\/v1\/projects\/\d+\/pipelines\/\d+\/publish$/.test(url)) publishPosts += 1;
    if (/\/api\/v1\/projects\/\d+\/pipelines\/\d+\/run$/.test(url)) runPosts += 1;
  });

  await page.route("**/api/v1/projects/*/pipeline-copilot/draft", async (route) => {
    draftCalls += 1;
    if (draftCalls === 1) {
      await new Promise<void>((resolve) => {
        releaseStale = () => {
          resolve();
        };
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockDraftGraph("STALE_DRAFT_MUST_NOT_APPEAR")),
      });
      return;
    }
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        detail: "Pipeline Copilot provider returned an invalid PipelineGraph proposal.",
        hint: "The provider returned an invalid PipelineGraph proposal.",
      }),
    });
  });

  await loginAndOpenBuilder(page, projectName);
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0);
  await expect(
    page.getByTestId("pipeline-canvas").getByTestId("pipeline-step-node"),
  ).toHaveCount(0);

  await page.getByTestId("pipeline-copilot-open").click();
  await page.getByTestId("pipeline-copilot-prompt").fill("Create a notification step");
  await page.getByTestId("pipeline-copilot-generate").click();
  await expect(page.getByTestId("pipeline-copilot-loading")).toBeVisible();

  await page.getByTestId("drawer-close").click();
  await expect(page.getByTestId("pipeline-copilot-drawer")).toHaveCount(0);

  // Release the in-flight stale response after close — must not reopen preview or mutate canvas.
  expect(releaseStale).toBeTruthy();
  releaseStale!();
  await page.waitForTimeout(300);
  await expect(page.getByText(/STALE_DRAFT_MUST_NOT_APPEAR/i)).toHaveCount(0);
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0);
  await expect(
    page.getByTestId("pipeline-canvas").getByTestId("pipeline-step-node"),
  ).toHaveCount(0);

  // 502 path: live graph and dirty remain unchanged; no persistence side effects.
  await page.getByTestId("pipeline-copilot-open").click();
  await page.getByTestId("pipeline-copilot-prompt").fill("Try again after failure");
  await page.getByTestId("pipeline-copilot-generate").click();
  await expect(page.getByTestId("pipeline-copilot-error")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("pipeline-copilot-preview")).toHaveCount(0);
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0);
  await expect(
    page.getByTestId("pipeline-canvas").getByTestId("pipeline-step-node"),
  ).toHaveCount(0);
  expect(versionPosts).toBe(0);
  expect(publishPosts).toBe(0);
  expect(runPosts).toBe(0);
});

test("Phase 7-D: stale patch after close is ignored; cancel confirm and Apply stay in-memory only", async ({
  page,
}) => {
  const projectName = `e2e-copilot-7d-patch-${Date.now()}`;
  let versionPosts = 0;
  let publishPosts = 0;
  let runPosts = 0;
  let patchCalls = 0;
  let releaseFirst: (() => void) | null = null;

  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const url = request.url();
    if (/\/api\/v1\/projects\/\d+\/pipelines\/\d+\/versions$/.test(url)) versionPosts += 1;
    if (/\/api\/v1\/projects\/\d+\/pipelines\/\d+\/publish$/.test(url)) publishPosts += 1;
    if (/\/api\/v1\/projects\/\d+\/pipelines\/\d+\/run$/.test(url)) runPosts += 1;
  });

  await page.route("**/api/v1/projects/*/pipeline-copilot/patch", async (route) => {
    patchCalls += 1;
    const body = route.request().postDataJSON() as {
      prompt?: string;
      current_graph?: {
        nodes: Array<{
          id: string;
          data?: { label?: string; node_type?: string; config?: Record<string, unknown> };
        }>;
        edges: unknown[];
      };
    };
    expect(Object.keys(body || {}).sort()).toEqual(["current_graph", "prompt"]);

    const nodes = body.current_graph?.nodes || [];
    const training = nodes.find(
      (node) => node.data?.node_type === "training" || node.id.startsWith("training"),
    );
    expect(training).toBeTruthy();

    const fulfill = async (summary: string, label: string) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          summary,
          model: "e2e-mock-model",
          warnings: [],
          validation: { valid: true, errors: [], order: nodes.map((n) => n.id) },
          patch: {
            operations: [
              {
                op: "update_node",
                node_id: training!.id,
                label,
                config_patch: { algorithm: "ridge" },
              },
            ],
          },
          graph: {
            nodes: nodes.map((node) =>
              node.id === training!.id
                ? {
                    ...node,
                    position: { x: 320, y: 40 },
                    data: {
                      label,
                      node_type: "training",
                      config: { ...(node.data?.config || {}), algorithm: "ridge" },
                    },
                  }
                : {
                    ...node,
                    position: node.id.includes("dataset")
                      ? { x: 40, y: 40 }
                      : { x: 600, y: 40 },
                    data: {
                      label: node.data?.label || node.id,
                      node_type: node.data?.node_type || "notification",
                      config: node.data?.config || {},
                    },
                  },
            ),
            edges: (body.current_graph?.edges || []).map((edge, index) => {
              const row = edge as {
                id?: string;
                source: string;
                target: string;
                data?: { branch?: string };
              };
              return {
                id: row.id || `edge-${index + 1}`,
                source: row.source,
                target: row.target,
                data: { branch: row.data?.branch || "always" },
              };
            }),
          },
        }),
      });
    };

    // First in-flight request is held until after Drawer close + newer Generate.
    if (patchCalls === 1) {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      await fulfill("FIRST_PATCH_STALE", "Stale Patched Training");
      return;
    }
    await fulfill("SECOND_PATCH_WINS", "Sales Forecast Training");
  });

  await loginAndOpenBuilder(page, projectName);
  await page.getByTestId("pipeline-library-dataset_load").click();
  await page.getByTestId("pipeline-library-training").click();
  await expect(
    page.getByTestId("pipeline-canvas").getByTestId("pipeline-step-node"),
  ).toHaveCount(2);
  await page.getByTestId("pipeline-save").click();
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0, { timeout: 30_000 });
  const postsAfterInitialSave = versionPosts;

  await page.getByTestId("pipeline-copilot-patch-open").click();
  await page.getByTestId("pipeline-copilot-prompt").fill("First slow modification");
  await page.getByTestId("pipeline-copilot-generate").click();
  await expect(page.getByTestId("pipeline-copilot-loading")).toBeVisible();

  // Close invalidates in-flight response; reopen + Generate is the practical "newer request".
  await page.getByTestId("drawer-close").click();
  await expect(page.getByTestId("pipeline-copilot-drawer")).toHaveCount(0);

  await page.getByTestId("pipeline-copilot-patch-open").click();
  await page.getByTestId("pipeline-copilot-prompt").fill("Second modification after close");
  await page.getByTestId("pipeline-copilot-generate").click();
  await expect(page.getByTestId("pipeline-copilot-summary")).toContainText(/SECOND_PATCH_WINS/i, {
    timeout: 15_000,
  });

  expect(releaseFirst).toBeTruthy();
  releaseFirst!();
  await page.waitForTimeout(300);
  await expect(page.getByTestId("pipeline-copilot-summary")).toContainText(/SECOND_PATCH_WINS/i);
  await expect(page.getByText(/FIRST_PATCH_STALE/i)).toHaveCount(0);
  // Preview must not mutate live Builder yet.
  await expect(
    page.getByTestId("pipeline-canvas").getByText("Sales Forecast Training", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0);

  await page.getByTestId("pipeline-copilot-apply").click();
  await expect(page.getByTestId("pipeline-copilot-confirm")).toBeVisible();
  await page.getByTestId("pipeline-copilot-confirm-back").click();
  await expect(page.getByTestId("pipeline-copilot-confirm")).toHaveCount(0);
  await expect(
    page.getByTestId("pipeline-canvas").getByText("Sales Forecast Training", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0);
  expect(versionPosts).toBe(postsAfterInitialSave);
  expect(publishPosts).toBe(0);
  expect(runPosts).toBe(0);

  await page.getByTestId("pipeline-copilot-apply").click();
  await page.getByTestId("pipeline-copilot-confirm-apply").click();
  await expect(page.getByTestId("pipeline-copilot-drawer")).toHaveCount(0);
  await expect(page.getByTestId("pipeline-dirty-badge")).toBeVisible();
  await expect(page.getByTestId("pipeline-publish")).toBeDisabled();
  await expect(page.getByTestId("pipeline-run")).toBeDisabled();
  await expect(
    page.getByTestId("pipeline-canvas").getByText("Sales Forecast Training", { exact: true }),
  ).toBeVisible();
  // Apply is in-memory only — no automatic Save/Publish/Run.
  expect(versionPosts).toBe(postsAfterInitialSave);
  expect(publishPosts).toBe(0);
  expect(runPosts).toBe(0);
});

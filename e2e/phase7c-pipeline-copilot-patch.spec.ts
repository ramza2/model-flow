import { expect, test } from "@playwright/test";
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

test("Phase 7-C Copilot patch previews operations and Apply marks dirty until Save", async ({
  page,
}) => {
  const projectName = `e2e-copilot-patch-${Date.now()}`;
  let versionPosts = 0;
  let capturedCurrentGraph: {
    nodes?: Array<{ id?: string; data?: { label?: string; config?: Record<string, unknown> } }>;
  } | null = null;

  await page.route("**/api/v1/projects/*/pipeline-copilot/patch", async (route) => {
    const body = route.request().postDataJSON() as {
      prompt?: string;
      current_graph?: {
        nodes: Array<{
          id: string;
          data: { label?: string; node_type?: string; config?: Record<string, unknown> };
        }>;
        edges: unknown[];
      };
      pipeline_id?: unknown;
      model?: unknown;
    };
    expect(Object.keys(body || {}).sort()).toEqual(["current_graph", "prompt"]);
    expect(typeof body.prompt).toBe("string");
    expect((body.prompt || "").trim().length).toBeGreaterThan(0);
    expect(body.pipeline_id).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect(Array.isArray(body.current_graph?.nodes)).toBe(true);
    expect(Array.isArray(body.current_graph?.edges)).toBe(true);
    capturedCurrentGraph = body.current_graph || null;

    const training = (body.current_graph?.nodes || []).find(
      (node) => node.data?.node_type === "training" || node.id?.startsWith("training"),
    );
    expect(training).toBeTruthy();
    const datasetLoad = (body.current_graph?.nodes || []).find(
      (node) => node.data?.node_type === "dataset_load" || node.id?.startsWith("dataset_load"),
    );
    expect(datasetLoad).toBeTruthy();

    const proposedTraining = {
      id: training!.id,
      position: { x: 320, y: 40 },
      data: {
        label: "Sales Forecast Training",
        node_type: "training",
        config: {
          ...(training!.data.config || {}),
          algorithm: "ridge",
          target_column: training!.data.config?.target_column || "target",
        },
      },
    };
    const proposedLoad = {
      id: datasetLoad!.id,
      position: { x: 40, y: 40 },
      data: {
        label: datasetLoad!.data.label || "Dataset Load",
        node_type: "dataset_load",
        config: { ...(datasetLoad!.data.config || {}) },
      },
    };

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        summary: "Changed training algorithm to ridge and renamed the node.",
        model: "e2e-mock-model",
        warnings: [],
        validation: {
          valid: true,
          errors: [],
          order: [proposedLoad.id, proposedTraining.id],
        },
        patch: {
          operations: [
            {
              op: "update_node",
              node_id: training!.id,
              label: "Sales Forecast Training",
              config_patch: { algorithm: "ridge" },
            },
          ],
        },
        graph: {
          nodes: [proposedLoad, proposedTraining],
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
  });

  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/v1\/projects\/\d+\/pipelines\/\d+\/versions$/.test(request.url())
    ) {
      versionPosts += 1;
    }
  });

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
  await page.getByTestId("pipeline-name").fill(`copilot-patch-${Date.now()}`);
  await page.getByTestId("pipeline-create-submit").click();

  await expect(page.getByTestId("pipeline-copilot-patch-open")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pipeline-canvas")).toBeVisible();

  await page.getByTestId("pipeline-library-dataset_load").click();
  await page.getByTestId("pipeline-library-training").click();
  await expect(
    page.getByTestId("pipeline-canvas").getByTestId("pipeline-step-node"),
  ).toHaveCount(2);

  // Configure training algorithm so current_graph carries real config.
  await page
    .getByTestId("pipeline-canvas")
    .getByTestId("pipeline-step-node")
    .filter({ hasText: /Training/i })
    .first()
    .click();
  const algorithm = page.locator(
    '[data-testid="node-config-algorithm"], select[name="algorithm"], #algorithm',
  );
  if (await algorithm.count()) {
    await algorithm.first().selectOption("random_forest").catch(async () => {
      await algorithm.first().fill("random_forest");
    });
  }

  await page.getByTestId("pipeline-save").click();
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0, { timeout: 30_000 });
  expect(versionPosts).toBe(1);
  const postsAfterSave = versionPosts;

  await page.getByTestId("pipeline-copilot-patch-open").click();
  await expect(page.getByTestId("pipeline-copilot-drawer")).toBeVisible();
  await page.getByTestId("pipeline-copilot-prompt").fill(
    "Change training algorithm to ridge and rename it Sales Forecast Training",
  );
  await page.getByTestId("pipeline-copilot-generate").click();

  await expect(page.getByTestId("pipeline-copilot-preview")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("pipeline-copilot-operations")).toContainText(/Update node/i);
  await expect(page.getByTestId("pipeline-copilot-operations")).toContainText(/ridge/i);
  expect(capturedCurrentGraph?.nodes?.length).toBeGreaterThanOrEqual(2);

  // Live canvas still shows pre-Apply labels.
  await expect(
    page.getByTestId("pipeline-canvas").getByText("Sales Forecast Training", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0);
  expect(versionPosts).toBe(postsAfterSave);

  await page.getByTestId("pipeline-copilot-apply").click();
  await expect(page.getByTestId("pipeline-copilot-confirm")).toBeVisible();
  await expect(page.getByTestId("pipeline-copilot-confirm")).toContainText(
    /Apply these Copilot changes/i,
  );
  await page.getByTestId("pipeline-copilot-confirm-apply").click();
  await expect(page.getByTestId("pipeline-copilot-drawer")).toHaveCount(0);

  await expect(page.getByTestId("pipeline-dirty-badge")).toBeVisible();
  await expect(page.getByTestId("pipeline-publish")).toBeDisabled();
  await expect(page.getByTestId("pipeline-run")).toBeDisabled();
  await expect(
    page.getByTestId("pipeline-canvas").getByText("Sales Forecast Training", { exact: true }),
  ).toBeVisible();
  expect(versionPosts).toBe(postsAfterSave);

  await page.getByTestId("pipeline-save").click();
  await expect(page.getByTestId("pipeline-dirty-badge")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(/Pipeline version saved/i)).toBeVisible({
    timeout: 30_000,
  });
  expect(versionPosts).toBe(postsAfterSave + 1);
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../api";
import DatasetDetail from "./DatasetDetail";

const apiMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, is_system_admin: true, email: "a@b.c" } }),
}));

const canWriteRef = { value: true };

vi.mock("../ProjectContext", () => ({
  useProject: () => ({ selectedProject: { id: 7, role: "PROJECT_ADMIN" } }),
  userCanProject: () => canWriteRef.value,
}));

const dataset = {
  id: 3,
  name: "sites",
  row_count: 3,
  column_count: 3,
  columns: ["site_id", "a", "target"],
  latest_version: 1,
};

const version = {
  id: 11,
  dataset_id: 3,
  version: 1,
  original_filename: "sites.csv",
  source_type: "upload",
  row_count: 3,
  column_count: 3,
  columns: ["site_id", "a", "target"],
  dtypes: { site_id: "object", a: "int64", target: "int64" },
  stats: {},
  created_at: "2026-08-06T10:00:00Z",
};

const activeRule = {
  id: 12,
  project_id: 7,
  dataset_id: 3,
  dataset_name: "sites",
  name: "Unique site ID",
  rules: [{ type: "unique", column: "site_id", severity: "fail" }],
  block_training_on_fail: true,
  is_active: true,
  created_at: "2026-08-06T10:01:00Z",
};

const inactiveRule = {
  ...activeRule,
  id: 13,
  name: "Inactive target",
  is_active: false,
  rules: [{ type: "not_null", column: "target", severity: "fail" }],
};

const legacyRule = {
  id: 99,
  project_id: 7,
  dataset_id: null,
  dataset_name: null,
  name: "Legacy rule",
  rules: [{ type: "not_null", column: "target", severity: "fail" }],
  block_training_on_fail: true,
  is_active: false,
  created_at: "2026-08-01T10:00:00Z",
};

const check = {
  id: 15,
  dataset_version_id: 11,
  result: "FAIL",
  created_at: "2026-08-06T10:30:00Z",
  details: [
    {
      quality_rule_id: 12,
      quality_rule_name: "Unique site ID",
      rule: { type: "unique", column: "site_id", severity: "fail" },
      severity: "fail",
      block_training_on_fail: true,
      passed: false,
      message: "24 duplicate values",
    },
  ],
};

function stubQualityApi() {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    if (path === "/projects/7/datasets/3") return dataset;
    if (path === "/projects/7/datasets/3/versions") return [version];
    if (path.includes("/quality-rules?") && path.includes("include_unassigned=true") && !path.includes("dataset_id=")) {
      return [activeRule, inactiveRule, legacyRule];
    }
    if (path.includes("/quality-rules?dataset_id=3")) {
      return [activeRule, inactiveRule];
    }
    if (path.includes("/versions/1/preview")) {
      return { columns: dataset.columns, rows: [{ site_id: "S1", a: 1, target: 0 }] };
    }
    if (path.includes("/quality-checks?dataset_version_id=11")) return [check];
    if (path.includes("/splits")) return [];
    if (path === "/projects/7/quality-rules" && method === "POST") {
      const body = JSON.parse(String(init?.body || "{}"));
      return { ...activeRule, id: 50, name: body.name, rules: body.rules, is_active: body.is_active };
    }
    if (path.startsWith("/projects/7/quality-rules/") && method === "PATCH") {
      const body = JSON.parse(String(init?.body || "{}"));
      const id = Number(path.split("/").pop());
      if (id === 99) {
        return { ...legacyRule, dataset_id: 3, dataset_name: "sites", is_active: true, ...body };
      }
      return { ...activeRule, id, ...body };
    }
    if (path.startsWith("/projects/7/quality-rules/") && method === "DELETE") {
      throw new ApiRequestError(409, "This quality rule has check history and cannot be deleted.", "Deactivate the rule instead of deleting it.");
    }
    if (path.includes("/quality-checks") && method === "POST") {
      const body = JSON.parse(String(init?.body || "{}"));
      return { ...check, id: 16, quality_rule_id: body.quality_rule_id ?? null, result: "FAIL" };
    }
    throw new Error(`Unhandled api call ${method} ${path}`);
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/datasets/3"]}>
      <Routes>
        <Route path="/projects/:projectId/datasets/:datasetId" element={<DatasetDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DatasetDetail quality management", () => {
  beforeEach(() => {
    canWriteRef.value = true;
    apiMock.mockReset();
    stubQualityApi();
  });

  it("filters dataset rules, shows badges, and expands check details", async () => {
    renderPage();
    await screen.findByTestId("quality-rule-12");
    expect(within(screen.getByTestId("quality-rule-12")).getByText("Unique site ID")).toBeInTheDocument();
    expect(within(screen.getByTestId("quality-rule-12")).getByText("Active")).toBeInTheDocument();
    expect(within(screen.getByTestId("quality-rule-13")).getByText("Inactive")).toBeInTheDocument();
    expect(screen.getByTestId("quality-active-count")).toHaveTextContent("1");
    expect(screen.getByTestId("legacy-quality-rules")).toHaveTextContent("Legacy unassigned rules");
    expect(screen.getByTestId("legacy-quality-rules")).toHaveTextContent("Needs dataset assignment");

    const checkItem = await screen.findByTestId("quality-check-15");
    fireEvent.click(within(checkItem).getByText(/Check #15/));
    await waitFor(() => {
      expect(checkItem).toHaveTextContent("24 duplicate values");
      expect(checkItem).toHaveTextContent("Blocks training: Yes");
    });
    const ruleName = screen.getByTestId("quality-check-rule-name-15-0");
    const condition = screen.getByTestId("quality-check-condition-15-0");
    expect(ruleName.tagName).toBe("STRONG");
    expect(condition.tagName).toBe("SMALL");
    expect(ruleName).toHaveTextContent("Unique site ID");
    expect(condition).toHaveTextContent("site_id · Unique · fail · FAIL");
    expect(ruleName.parentElement).toHaveClass("quality-check-detail-heading");
    expect(ruleName.nextElementSibling).toBe(condition);
  });

  it("creates rules with multiple dynamic conditions", async () => {
    renderPage();
    await screen.findByTestId("quality-create");
    fireEvent.click(screen.getByTestId("quality-create"));
    fireEvent.change(screen.getByTestId("quality-rule-name"), { target: { value: "Multi" } });
    fireEvent.click(screen.getByTestId("quality-add-condition"));
    expect(screen.getByTestId("quality-condition-1")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("quality-condition-type-1"), { target: { value: "regex" } });
    expect(screen.getByTestId("quality-condition-pattern-1")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("quality-condition-type-0"), { target: { value: "allowed_values" } });
    expect(screen.getByTestId("quality-condition-values-0")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("quality-remove-condition-1"));
    expect(screen.queryByTestId("quality-condition-1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("quality-save-rule"));
    await waitFor(() => {
      const createCall = apiMock.mock.calls.find(
        ([path, init]) => path === "/projects/7/quality-rules" && init?.method === "POST",
      );
      expect(createCall).toBeTruthy();
      const body = JSON.parse(String(createCall![1].body));
      expect(body.dataset_id).toBe(3);
      expect(body.rules[0].type).toBe("allowed_values");
    });
  });

  it("pre-fills edit form and runs individual / all checks", async () => {
    renderPage();
    await screen.findByTestId("quality-edit-12");
    fireEvent.click(screen.getByTestId("quality-edit-12"));
    expect(screen.getByTestId("quality-rule-name")).toHaveValue("Unique site ID");
    expect(screen.getByTestId("quality-rule-blocking")).toBeChecked();

    fireEvent.click(screen.getByTestId("quality-run-12"));
    await waitFor(() => {
      const runCall = apiMock.mock.calls.find(
        ([path, init]) =>
          String(path).includes("/quality-checks") &&
          init?.method === "POST" &&
          String(init.body).includes('"quality_rule_id":12'),
      );
      expect(runCall).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("quality-run-all"));
    await waitFor(() => {
      const runAll = apiMock.mock.calls.find(
        ([path, init]) =>
          String(path).includes("/quality-checks") &&
          init?.method === "POST" &&
          init.body === "{}",
      );
      expect(runAll).toBeTruthy();
    });
  });

  it("shows delete 409 on the rule card and clears it on the next action", async () => {
    renderPage();
    await screen.findByTestId("quality-delete-12");
    fireEvent.click(screen.getByTestId("quality-delete-12"));
    const ruleError = await screen.findByTestId("quality-rule-error-12");
    expect(ruleError).toHaveAttribute("role", "alert");
    expect(ruleError).toHaveTextContent("This rule has check history. Deactivate it instead.");
    expect(within(screen.getByTestId("quality-rule-12")).getByTestId("quality-rule-error-12")).toBeInTheDocument();
    expect(screen.queryByTestId("quality-rule-error-13")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quality-action-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("quality-rule-12")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("quality-toggle-12"));
    await waitFor(() => {
      expect(screen.queryByTestId("quality-rule-error-12")).not.toBeInTheDocument();
      const patch = apiMock.mock.calls.find(
        ([path, init]) =>
          path === "/projects/7/quality-rules/12" &&
          init?.method === "PATCH" &&
          String(init.body).includes('"is_active":false'),
      );
      expect(patch).toBeTruthy();
    });
  });

  it("shows legacy assign failures on the legacy rule card only", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/datasets/3") return dataset;
      if (path === "/projects/7/datasets/3/versions") return [version];
      if (path.includes("/quality-rules?") && path.includes("include_unassigned=true") && !path.includes("dataset_id=")) {
        return [activeRule, inactiveRule, legacyRule];
      }
      if (path.includes("/quality-rules?dataset_id=3")) return [activeRule, inactiveRule];
      if (path.includes("/versions/1/preview")) {
        return { columns: dataset.columns, rows: [{ site_id: "S1", a: 1, target: 0 }] };
      }
      if (path.includes("/quality-checks?dataset_version_id=11")) return [check];
      if (path.includes("/splits")) return [];
      if (path === "/projects/7/quality-rules/99" && method === "PATCH") {
        throw new ApiRequestError(422, "Column 'heat_demand' was not found in the dataset.");
      }
      throw new Error(`Unhandled api call ${method} ${path}`);
    });

    renderPage();
    await screen.findByTestId("quality-assign-99");
    fireEvent.click(screen.getByTestId("quality-assign-99"));
    const legacyError = await screen.findByTestId("quality-rule-error-99");
    expect(legacyError).toHaveTextContent("Column 'heat_demand' was not found in the dataset.");
    expect(within(screen.getByTestId("quality-rule-99")).getByTestId("quality-rule-error-99")).toBeInTheDocument();
    expect(screen.queryByTestId("quality-rule-error-12")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quality-action-error")).not.toBeInTheDocument();
  });

  it("shows run-all failures at the panel top", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/datasets/3") return dataset;
      if (path === "/projects/7/datasets/3/versions") return [version];
      if (path.includes("/quality-rules?") && path.includes("include_unassigned=true") && !path.includes("dataset_id=")) {
        return [activeRule, inactiveRule, legacyRule];
      }
      if (path.includes("/quality-rules?dataset_id=3")) return [activeRule, inactiveRule];
      if (path.includes("/versions/1/preview")) {
        return { columns: dataset.columns, rows: [{ site_id: "S1", a: 1, target: 0 }] };
      }
      if (path.includes("/quality-checks?dataset_version_id=11") && method === "GET") return [check];
      if (path.includes("/splits")) return [];
      if (path.includes("/quality-checks") && method === "POST") {
        throw new ApiRequestError(400, "No active quality rules are configured for this dataset.");
      }
      throw new Error(`Unhandled api call ${method} ${path}`);
    });

    renderPage();
    await screen.findByTestId("quality-run-all");
    fireEvent.click(screen.getByTestId("quality-run-all"));
    const panelError = await screen.findByTestId("quality-action-error");
    expect(panelError).toHaveTextContent("No active quality rules are configured for this dataset.");
    expect(within(screen.getByTestId("quality-panel")).getByTestId("quality-action-error")).toBeInTheDocument();
    expect(screen.queryByTestId("quality-rule-error-12")).not.toBeInTheDocument();
  });

  it("keeps dataset load failures in the global error notice", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/datasets/3") {
        throw new Error("Dataset could not be loaded.");
      }
      return [];
    });
    renderPage();
    await screen.findByText("Dataset could not be loaded.");
    expect(screen.queryByTestId("quality-action-error")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Dataset could not be loaded.");
  });

  it("hides write actions without DATA_WRITE permission", async () => {
    canWriteRef.value = false;
    renderPage();
    await screen.findByTestId("quality-rule-12");
    expect(screen.queryByTestId("quality-create")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quality-run-all")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quality-edit-12")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quality-delete-12")).not.toBeInTheDocument();
  });
});

describe("DatasetDetail saved splits", () => {
  beforeEach(() => {
    canWriteRef.value = true;
    apiMock.mockReset();
    stubQualityApi();
  });

  it("validates create-split ratios before posting", async () => {
    renderPage();
    await screen.findByTestId("open-create-split");
    fireEvent.click(screen.getByTestId("open-create-split"));
    fireEvent.change(screen.getByTestId("split-train-ratio"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByTestId("split-val-ratio"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByTestId("split-test-ratio"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByTestId("create-split-submit"));
    expect(await screen.findByTestId("split-form-error")).toHaveTextContent("must equal 1.0");
    expect(apiMock.mock.calls.some((call) => String(call[0]).includes("/splits") && call[1]?.method === "POST")).toBe(false);
  });

  it("creates a configurable split and refreshes the list", async () => {
    stubQualityApi();
    const base = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path.includes("/splits") && method === "POST") {
        const body = JSON.parse(String(init?.body || "{}"));
        return {
          id: 77,
          name: body.name,
          dataset_version_id: 11,
          train_ratio: body.train_ratio,
          val_ratio: body.val_ratio,
          test_ratio: body.test_ratio,
          random_seed: body.random_seed,
          config_signature: "0.700000:0.150000:0.150000:42",
          created_at: "2026-08-10T00:00:00Z",
        };
      }
      return base(path, init);
    });

    renderPage();
    await screen.findByTestId("open-create-split");
    fireEvent.click(screen.getByTestId("open-create-split"));
    fireEvent.change(screen.getByTestId("split-name"), { target: { value: "split-custom" } });
    fireEvent.click(screen.getByTestId("create-split-submit"));
    expect(await screen.findByTestId("saved-split-77")).toHaveTextContent("split-custom");
    const post = apiMock.mock.calls.find(
      (call) => String(call[0]).includes("/splits") && (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({
      name: "split-custom",
      train_ratio: 0.7,
      val_ratio: 0.15,
      test_ratio: 0.15,
      random_seed: 42,
    });
  });
});

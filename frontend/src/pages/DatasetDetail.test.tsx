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
  stats: {
    a: { min: 0, max: 10, mean: 5.123, null_count: 0, unique_count: 3 },
  },
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
    if (path.includes("/versions/1/lineage")) {
      return {
        dataset_version: version,
        upstream: null,
        training_jobs: [],
        model_versions: [],
      };
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
    const train = screen.getByTestId("train-on-dataset");
    expect(train).toHaveAttribute("href", "/projects/7/jobs/new?datasetId=3&datasetVersionId=11");
    expect(train).toHaveTextContent(/이 데이터셋으로 학습/);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("sites");
    expect(screen.getByText(/3행 · 3컬럼 · 1개 버전/)).toBeInTheDocument();
    expect(screen.getByText("데이터셋 버전")).toBeInTheDocument();
    expect(screen.getByText("행", { selector: ".stat .label" })).toBeInTheDocument();
    expect(screen.getByText("컬럼", { selector: ".stat .label" })).toBeInTheDocument();
    expect(screen.getByText("저장된 분할")).toBeInTheDocument();
    expect(screen.getByTestId("dataset-lifecycle-entry")).toHaveTextContent("학습 흐름");
    expect(screen.getByTestId("dataset-lifecycle-entry")).toHaveTextContent("이 데이터셋으로 학습 시작");
    expect(screen.getByRole("heading", { name: "컬럼 통계" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "자료형" })).toBeInTheDocument();
    expect(screen.getByText("최소값 0 · 최대값 10 · 평균 5.123")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "데이터 미리보기" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "버전" })).toBeInTheDocument();
    expect(screen.getByText("버전 1")).toBeInTheDocument();
    expect(screen.getByText("3행")).toBeInTheDocument();
    expect(screen.getByTestId("quality-panel")).toHaveTextContent("데이터 품질");
    expect(screen.getByTestId("quality-panel")).toHaveTextContent("Data quality");
    expect(screen.getByTestId("quality-run-all")).toHaveTextContent("전체 검사 실행");
    expect(screen.getByTestId("quality-create")).toHaveTextContent("새 규칙");
    expect(screen.getByTestId("quality-active-count")).toHaveTextContent("활성 규칙");
    expect(screen.getByTestId("quality-latest-result")).toHaveTextContent("최근 품질 결과");
    await waitFor(() => {
      expect(screen.getByTestId("quality-latest-result")).toHaveTextContent("실패 (FAIL)");
    });
    expect(screen.getByTestId("quality-check-count")).toHaveTextContent("품질 검사");
    expect(within(screen.getByTestId("quality-rule-12")).getByText("Unique site ID")).toBeInTheDocument();
    expect(within(screen.getByTestId("quality-rule-12")).getByText("활성")).toBeInTheDocument();
    expect(within(screen.getByTestId("quality-rule-12")).getByText("학습 차단")).toBeInTheDocument();
    expect(within(screen.getByTestId("quality-rule-12")).getByText("site_id · 중복 금지 (Unique) · 실패 (Fail)")).toBeInTheDocument();
    expect(within(screen.getByTestId("quality-rule-13")).getByText("비활성")).toBeInTheDocument();
    expect(screen.getByTestId("quality-active-count")).toHaveTextContent("1");
    expect(screen.getByTestId("legacy-quality-rules")).toHaveTextContent("기존 미할당 규칙");
    expect(screen.getByTestId("legacy-quality-rules")).toHaveTextContent("데이터셋 연결 필요");

    const checkItem = await screen.findByTestId("quality-check-15");
    fireEvent.click(within(checkItem).getByText(/검사 #15/));
    await waitFor(() => {
      expect(checkItem).toHaveTextContent("24 duplicate values");
      expect(checkItem).toHaveTextContent("학습 차단: 예");
    });
    const ruleName = screen.getByTestId("quality-check-rule-name-15-0");
    const condition = screen.getByTestId("quality-check-condition-15-0");
    expect(ruleName.tagName).toBe("STRONG");
    expect(condition.tagName).toBe("SMALL");
    expect(ruleName).toHaveTextContent("Unique site ID");
    expect(condition).toHaveTextContent("site_id · 중복 금지 (Unique) · 실패 (Fail) · 실패 (FAIL)");
    expect(checkItem).toHaveTextContent("심각도: 실패 (Fail)");
    expect(ruleName.parentElement).toHaveClass("quality-check-detail-heading");
    expect(ruleName.nextElementSibling).toBe(condition);
  });

  it("creates rules with multiple dynamic conditions", async () => {
    renderPage();
    await screen.findByTestId("quality-create");
    fireEvent.click(screen.getByTestId("quality-create"));
    expect(screen.getByTestId("quality-rule-form")).toHaveTextContent("품질 규칙 만들기");
    expect(screen.getByTestId("quality-save-rule")).toHaveTextContent("규칙 저장");
    fireEvent.change(screen.getByTestId("quality-rule-name"), { target: { value: "Multi" } });
    fireEvent.click(screen.getByTestId("quality-add-condition"));
    expect(screen.getByTestId("quality-condition-1")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("quality-condition-type-1"), { target: { value: "regex" } });
    expect(screen.getByTestId("quality-condition-type-1")).toHaveValue("regex");
    expect(screen.getByTestId("quality-condition-pattern-1")).toBeInTheDocument();
    expect(screen.getByLabelText("조건 2 검사 유형")).toHaveDisplayValue("정규식 검사 (Regex)");
    fireEvent.change(screen.getByTestId("quality-condition-pattern-1"), { target: { value: "^S\\d+$" } });
    fireEvent.change(screen.getByTestId("quality-condition-type-0"), { target: { value: "allowed_values" } });
    expect(screen.getByTestId("quality-condition-type-0")).toHaveValue("allowed_values");
    expect(screen.getByTestId("quality-condition-values-0")).toBeInTheDocument();
    expect(screen.getByLabelText("조건 1 검사 유형")).toHaveDisplayValue("허용 값 검사 (Allowed values)");
    fireEvent.change(screen.getByTestId("quality-condition-values-0"), { target: { value: "a, b" } });
    fireEvent.change(screen.getByLabelText("조건 1 심각도"), { target: { value: "warning" } });
    expect(screen.getByLabelText("조건 1 심각도")).toHaveValue("warning");
    expect(screen.getByLabelText("조건 1 심각도")).toHaveDisplayValue("경고 (Warning)");
    fireEvent.change(screen.getByLabelText("조건 2 심각도"), { target: { value: "fail" } });
    expect(screen.getByLabelText("조건 2 심각도")).toHaveValue("fail");
    fireEvent.click(screen.getByTestId("quality-add-condition"));
    expect(screen.getByTestId("quality-condition-2")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("quality-remove-condition-2"));
    expect(screen.queryByTestId("quality-condition-2")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("quality-save-rule"));
    await waitFor(() => {
      const createCall = apiMock.mock.calls.find(
        ([path, init]) => path === "/projects/7/quality-rules" && init?.method === "POST",
      );
      expect(createCall).toBeTruthy();
      const body = JSON.parse(String(createCall![1].body));
      expect(body.dataset_id).toBe(3);
      expect(body.rules).toHaveLength(2);
      expect(body.rules[0].type).toBe("allowed_values");
      expect(body.rules[0].severity).toBe("warning");
      expect(body.rules[0].values).toEqual(["a", "b"]);
      expect(body.rules[1].type).toBe("regex");
      expect(body.rules[1].severity).toBe("fail");
      expect(body.rules[1].pattern).toBe("^S\\d+$");
      expect(body.block_training_on_fail).toBe(true);
      expect(body.is_active).toBe(true);
    });
  });

  it("shows Korean min/max labels for range rules and keeps payload field names", async () => {
    renderPage();
    await screen.findByTestId("quality-create");
    fireEvent.click(screen.getByTestId("quality-create"));
    fireEvent.change(screen.getByTestId("quality-rule-name"), { target: { value: "Range a" } });
    fireEvent.change(screen.getByTestId("quality-condition-type-0"), { target: { value: "range" } });
    const minInput = screen.getByLabelText("조건 1 최소값");
    const maxInput = screen.getByLabelText("조건 1 최대값");
    expect(minInput).toHaveAttribute("placeholder", "최소값");
    expect(maxInput).toHaveAttribute("placeholder", "최대값");
    fireEvent.change(screen.getByLabelText("조건 1 컬럼"), { target: { value: "a" } });
    fireEvent.change(minInput, { target: { value: "1" } });
    fireEvent.change(maxInput, { target: { value: "9" } });
    fireEvent.click(screen.getByTestId("quality-save-rule"));
    await waitFor(() => {
      const createCall = apiMock.mock.calls.find(
        ([path, init]) => path === "/projects/7/quality-rules" && init?.method === "POST",
      );
      expect(createCall).toBeTruthy();
      const body = JSON.parse(String(createCall![1].body));
      expect(body.rules).toEqual([
        { type: "range", column: "a", severity: "fail", min: 1, max: 9 },
      ]);
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
    expect(ruleError).toHaveTextContent("이 규칙에는 검사 기록이 있어 삭제할 수 없습니다. 대신 비활성화하세요.");
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
      if (path.includes("/versions/1/lineage")) {
        return {
          dataset_version: version,
          upstream: null,
          training_jobs: [],
          model_versions: [],
        };
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
      if (path.includes("/versions/1/lineage")) {
        return {
          dataset_version: version,
          upstream: null,
          training_jobs: [],
          model_versions: [],
        };
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
    expect(screen.queryByTestId("train-on-dataset")).not.toBeInTheDocument();
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
    expect(await screen.findByTestId("split-form-error")).toHaveTextContent(
      "학습 + 검증 + 테스트 비율의 합은 1.0이어야 합니다.",
    );
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
          split_strategy: body.split_strategy || "random",
          time_column: body.time_column ?? null,
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
    expect(screen.getByTestId("saved-split-77")).toHaveTextContent("무작위 (Random)");
    expect(screen.getByTestId("saved-split-77")).toHaveTextContent("시드 42");
    expect(screen.getByText(/데이터 분할 #77을 저장했습니다/)).toBeInTheDocument();
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
      split_strategy: "random",
      time_column: null,
    });
  });

  it("creates a time-ordered split with required time column", async () => {
    stubQualityApi();
    const base = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path.includes("/splits") && method === "POST") {
        const body = JSON.parse(String(init?.body || "{}"));
        return {
          id: 88,
          name: body.name,
          dataset_version_id: 11,
          train_ratio: body.train_ratio,
          val_ratio: body.val_ratio,
          test_ratio: body.test_ratio,
          random_seed: body.random_seed,
          split_strategy: body.split_strategy,
          time_column: body.time_column,
          config_signature: "0.700000:0.150000:0.150000:42:time:abc",
          created_at: "2026-08-10T00:00:00Z",
        };
      }
      return base(path, init);
    });

    renderPage();
    await screen.findByTestId("open-create-split");
    fireEvent.click(screen.getByTestId("open-create-split"));
    fireEvent.change(screen.getByTestId("split-strategy"), { target: { value: "time" } });
    expect(screen.getByTestId("split-time-column")).toBeInTheDocument();
    expect(screen.getByTestId("split-time-seed-hint")).toHaveTextContent(
      "시간 순서 분할에서는 난수 시드가 행 순서를 섞지 않습니다.",
    );
    fireEvent.click(screen.getByTestId("create-split-submit"));
    expect(await screen.findByTestId("split-form-error")).toHaveTextContent(
      "시간 순서 분할에 사용할 시간 기준 컬럼을 선택하세요.",
    );

    fireEvent.change(screen.getByTestId("split-time-column"), { target: { value: "site_id" } });
    fireEvent.change(screen.getByTestId("split-name"), { target: { value: "timed-split" } });
    fireEvent.click(screen.getByTestId("create-split-submit"));
    expect(await screen.findByTestId("saved-split-88")).toHaveTextContent("시간 순서 (Time ordered) · site_id");
    expect(screen.getByText(/데이터 분할 #88을 저장했습니다/)).toBeInTheDocument();
    const post = apiMock.mock.calls.find(
      (call) => String(call[0]).includes("/splits") && (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({
      split_strategy: "time",
      time_column: "site_id",
    });
  });
});

describe("DatasetDetail upstream lineage", () => {
  beforeEach(() => {
    canWriteRef.value = true;
    apiMock.mockReset();
  });

  it("shows upstream card for preparation-sourced versions", async () => {
    const preparedVersion = {
      ...version,
      id: 22,
      version: 2,
      source_type: "preparation",
      original_filename: "prepared.parquet",
    };
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/datasets/3") return { ...dataset, latest_version: 2 };
      if (path === "/projects/7/datasets/3/versions") return [preparedVersion, version];
      if (path.includes("/quality-rules?")) return [];
      if (path.includes("/versions/2/preview")) {
        return { columns: dataset.columns, rows: [{ site_id: "S1", a: 1, target: 0 }] };
      }
      if (path.includes("/versions/2/lineage")) {
        return {
          dataset_version: preparedVersion,
          upstream: {
            preparation: { id: 9, name: "Demo prep" },
            preparation_version: { id: 1, version: 1 },
            preparation_run: { id: 44, status: "succeeded" },
            input_versions: [
              {
                node_id: "source-1",
                dataset_id: 2,
                dataset_name: "iris",
                dataset_version_id: 11,
                version: 1,
              },
            ],
          },
          training_jobs: [],
          model_versions: [],
        };
      }
      if (path.includes("/quality-checks?")) return [];
      if (path.includes("/splits")) return [];
      throw new Error(`Unhandled api call ${method} ${path}`);
    });

    render(
      <MemoryRouter initialEntries={["/projects/7/datasets/3"]}>
        <Routes>
          <Route path="/projects/:projectId/datasets/:datasetId" element={<DatasetDetail />} />
          <Route path="/projects/:projectId/preparations/:preparationId" element={<div>Prep</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const card = await screen.findByTestId("dataset-upstream-lineage");
    expect(card).toHaveTextContent("데이터 가공으로 생성됨");
    expect(card).toHaveTextContent("데이터 가공");
    expect(card).toHaveTextContent("Demo prep");
    expect(card).toHaveTextContent("v1");
    expect(card).toHaveTextContent("성공");
    expect(screen.getByTestId("dataset-upstream-preparation-link")).toHaveAttribute(
      "href",
      "/projects/7/preparations/9",
    );
    expect(screen.getByTestId("dataset-upstream-inputs")).toHaveTextContent("iris");
    expect(screen.getByTestId("dataset-upstream-inputs")).toHaveTextContent("source-1");
    expect(screen.getByTestId("dataset-upstream-inputs")).toHaveTextContent("노드");
    expect(screen.getByText("데이터 가공", { selector: ".badge-label" })).toBeInTheDocument();
  });

  it("keeps normal lineage unchanged for upload versions", async () => {
    stubQualityApi();
    renderPage();
    await screen.findByTestId("quality-rule-12");
    expect(screen.queryByTestId("dataset-upstream-lineage")).not.toBeInTheDocument();
    expect(screen.getByTestId("dataset-lifecycle-entry")).toBeInTheDocument();
    expect(screen.getByText("업로드", { selector: ".badge-label" })).toBeInTheDocument();
  });

  it("keeps Train on dataset pinned to the selected non-latest version", async () => {
    const older = { ...version, id: 11, version: 1 };
    const newer = {
      ...version,
      id: 22,
      version: 2,
      original_filename: "sites-v2.csv",
      columns: ["site_id", "a", "target", "extra"],
    };
    stubQualityApi();
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/projects/7/datasets/3") return { ...dataset, latest_version: 2 };
      if (path === "/projects/7/datasets/3/versions") return [newer, older];
      if (path.includes("/versions/2/preview")) {
        return { columns: newer.columns, rows: [{ site_id: "S1", a: 1, target: 0, extra: 9 }] };
      }
      if (path.includes("/versions/2/lineage")) {
        return { dataset_version: newer, upstream: null, training_jobs: [], model_versions: [] };
      }
      if (path.includes("/versions/1/preview")) {
        return { columns: older.columns, rows: [{ site_id: "S1", a: 1, target: 0 }] };
      }
      if (path.includes("/versions/1/lineage")) {
        return { dataset_version: older, upstream: null, training_jobs: [], model_versions: [] };
      }
      if (path.includes("/quality-rules?")) return [activeRule, inactiveRule];
      if (path.includes("/quality-checks?")) return [];
      if (path.includes("/splits")) return [];
      throw new Error(`Unhandled api call ${path}`);
    });
    renderPage();
    const train = await screen.findByTestId("train-on-dataset");
    expect(train).toHaveAttribute("href", "/projects/7/jobs/new?datasetId=3&datasetVersionId=22");
    fireEvent.change(screen.getByDisplayValue(/v2 /), { target: { value: "11" } });
    await waitFor(() => {
      expect(screen.getByTestId("train-on-dataset")).toHaveAttribute(
        "href",
        "/projects/7/jobs/new?datasetId=3&datasetVersionId=11",
      );
    });
  });

  it("hides navigable Train link until a DatasetVersion is selected", async () => {
    let resolveVersions: ((value: unknown) => void) | null = null;
    const versionsPromise = new Promise((resolve) => {
      resolveVersions = resolve;
    });
    stubQualityApi();
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/projects/7/datasets/3") return { ...dataset, latest_version: 2 };
      if (path === "/projects/7/datasets/3/versions") return versionsPromise;
      if (path.includes("/quality-rules?")) return [activeRule, inactiveRule];
      if (path.includes("/quality-checks?")) return [];
      if (path.includes("/splits")) return [];
      if (path.includes("/preview")) {
        return { columns: version.columns, rows: [{ site_id: "S1", a: 1, target: 0 }] };
      }
      if (path.includes("/lineage")) {
        return { dataset_version: version, upstream: null, training_jobs: [], model_versions: [] };
      }
      throw new Error(`Unhandled api call ${path}`);
    });
    renderPage();
    expect(screen.queryByTestId("train-on-dataset")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /이 데이터셋으로 학습/ })).not.toBeInTheDocument();

    resolveVersions!([
      { ...version, id: 22, version: 2, original_filename: "sites-v2.csv" },
      { ...version, id: 11, version: 1 },
    ]);
    const train = await screen.findByTestId("train-on-dataset");
    expect(train).toHaveAttribute("href", "/projects/7/jobs/new?datasetId=3&datasetVersionId=22");
    fireEvent.change(screen.getByDisplayValue(/v2 /), { target: { value: "11" } });
    await waitFor(() => {
      expect(screen.getByTestId("train-on-dataset")).toHaveAttribute(
        "href",
        "/projects/7/jobs/new?datasetId=3&datasetVersionId=11",
      );
    });
  });

  it("selects exact DatasetVersion from ?version= query even when not latest", async () => {
    const older = { ...version, id: 11, version: 1 };
    const mid = {
      ...version,
      id: 18,
      version: 2,
      original_filename: "sites-v2.parquet",
      source_type: "feedback_materialization",
    };
    const newer = {
      ...version,
      id: 22,
      version: 3,
      original_filename: "sites-v3.parquet",
      source_type: "feedback_materialization",
    };
    stubQualityApi();
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/datasets/3") return { ...dataset, latest_version: 3 };
      if (path === "/projects/7/datasets/3/versions") return [newer, mid, older];
      if (path.includes("/versions/2/preview")) {
        return { columns: mid.columns, rows: [{ site_id: "S1", a: 1, target: 0 }] };
      }
      if (path.includes("/versions/2/lineage")) {
        return { dataset_version: mid, upstream: null, training_jobs: [], model_versions: [] };
      }
      if (path.includes("/quality-rules?")) return [];
      if (path.includes("/quality-checks?")) return [];
      if (path.includes("/splits")) return [];
      throw new Error(`Unhandled api call ${path}`);
    });

    render(
      <MemoryRouter initialEntries={["/projects/7/datasets/3?version=2"]}>
        <Routes>
          <Route path="/projects/:projectId/datasets/:datasetId" element={<DatasetDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    const train = await screen.findByTestId("train-on-dataset");
    expect(train).toHaveAttribute("href", "/projects/7/jobs/new?datasetId=3&datasetVersionId=18");
    expect(screen.getByDisplayValue(/v2 /)).toBeInTheDocument();
  });

});

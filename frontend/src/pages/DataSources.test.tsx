import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../api";
import DataSources from "./DataSources";

const apiMock = vi.fn();
const confirmMock = vi.fn((_message?: string) => true);

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

vi.mock("../components", async () => {
  const actual = await vi.importActual<typeof import("../components")>("../components");
  return {
    ...actual,
    confirmAction: (message: string) => confirmMock(message),
  };
});

const activePostgres = {
  id: 3,
  project_id: 7,
  name: "postgres-prod",
  source_type: "postgres" as const,
  config: { host: "postgres-source", port: 5432, database: "db", user: "u" },
  has_secrets: true,
  connection_mode: "host_port" as const,
  is_active: true,
  last_test_status: "ok",
  last_test_message: "Connection succeeded.",
  last_tested_at: "2026-08-11T05:00:00Z",
  created_at: "2026-08-11T04:00:00Z",
};

const dsnPostgres = {
  id: 5,
  project_id: 7,
  name: "postgres-dsn",
  source_type: "postgres" as const,
  config: {},
  has_secrets: true,
  connection_mode: "connection_url" as const,
  is_active: true,
  last_test_status: "ok",
  last_test_message: "Connection succeeded.",
  last_tested_at: "2026-08-11T05:00:00Z",
  created_at: "2026-08-11T04:00:00Z",
};

const inactivePostgres = {
  ...activePostgres,
  id: 4,
  name: "postgres-old",
  is_active: false,
  last_test_status: "ok",
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/data-sources"]}>
      <Routes>
        <Route path="/projects/:projectId/data-sources" element={<DataSources />} />
        <Route path="/projects/:projectId/datasets/:datasetId" element={<div>Dataset page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DataSources operations UX", () => {
  beforeEach(() => {
    apiMock.mockReset();
    confirmMock.mockReset();
    confirmMock.mockReturnValue(true);
    canWriteRef.value = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows deactivate for active and activate for inactive sources", async () => {
    apiMock.mockResolvedValueOnce([activePostgres, inactivePostgres]);
    renderPage();
    expect(await screen.findByTestId("deactivate-3")).toBeInTheDocument();
    expect(screen.getByTestId("activate-4")).toBeInTheDocument();
    expect(screen.queryByTestId("activate-3")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deactivate-4")).not.toBeInTheDocument();
    expect(screen.getByTestId("import-data-3")).toBeInTheDocument();
    expect(screen.queryByTestId("import-data-4")).not.toBeInTheDocument();
  });

  it("activates an inactive source", async () => {
    apiMock
      .mockResolvedValueOnce([inactivePostgres])
      .mockResolvedValueOnce({ ...inactivePostgres, is_active: true })
      .mockResolvedValueOnce([{ ...inactivePostgres, is_active: true }]);
    renderPage();
    fireEvent.click(await screen.findByTestId("activate-4"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/projects/7/data-sources/4/activate", { method: "POST" }),
    );
  });

  it("opens import panel and loads schemas/tables for table mode", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7/data-sources") return [activePostgres];
      if (path.includes("/data-import-jobs?")) return [];
      if (path.endsWith("/schemas")) return ["public", "modelflow_e2e"];
      if (path.includes("/tables?schema=public")) return [{ schema: "public", name: "customers" }];
      if (path.includes("/tables?schema=modelflow_e2e")) {
        return [{ schema: "modelflow_e2e", name: "heat_demand_training" }];
      }
      return [];
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("import-data-3"));
    expect(await screen.findByTestId("import-panel-3")).toBeInTheDocument();
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/projects/7/data-sources/3/schemas"),
    );
    const schema = await screen.findByTestId("import-schema");
    await waitFor(() => expect(within(schema).getByText("public")).toBeInTheDocument());
    fireEvent.change(schema, { target: { value: "modelflow_e2e" } });
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/data-sources/3/tables?schema=modelflow_e2e",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("import-table")).toHaveDisplayValue("heat_demand_training"),
    );
  });

  it("submits schema-qualified table import and polls until success", async () => {
    const pending = {
      id: 9,
      project_id: 7,
      data_source_id: 3,
      dataset_id: 21,
      dataset_version_id: null,
      table_or_query: "public.customers",
      status: "pending",
      error_message: null,
      created_at: "2026-08-11T06:00:00Z",
      finished_at: null,
    };
    const succeeded = {
      ...pending,
      status: "succeeded",
      dataset_version_id: 31,
      finished_at: "2026-08-11T06:00:05Z",
    };

    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/data-sources") return [activePostgres];
      if (path.includes("/data-import-jobs?data_source_id=3")) return [];
      if (path.endsWith("/schemas")) return ["public"];
      if (path.includes("/tables?")) return [{ schema: "public", name: "customers" }];
      if (path.endsWith("/import") && method === "POST") {
        const body = JSON.parse(String(init?.body || "{}"));
        expect(body).toEqual({
          dataset_name: "customers",
          table_or_query: "public.customers",
        });
        return pending;
      }
      if (path === "/projects/7/data-import-jobs/9") return succeeded;
      return [];
    });

    renderPage();
    fireEvent.click(await screen.findByTestId("import-data-3"));
    await screen.findByTestId("import-table");
    await waitFor(() => expect(screen.getByTestId("import-dataset-name")).toHaveValue("customers"));
    fireEvent.click(screen.getByTestId("import-submit"));
    await waitFor(() => expect(screen.getByTestId("import-status")).toHaveTextContent(/Pending|pending/i));
    await vi.advanceTimersByTimeAsync(2100);
    await waitFor(() => expect(screen.getByTestId("open-imported-dataset")).toBeInTheDocument());
    expect(screen.getByTestId("open-imported-dataset")).toHaveAttribute(
      "href",
      "/projects/7/datasets/21",
    );
  });

  it("submits SQL query import body", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/data-sources") return [activePostgres];
      if (path.includes("/data-import-jobs?data_source_id=3")) return [];
      if (path.endsWith("/schemas")) return ["public"];
      if (path.includes("/tables?")) return [{ schema: "public", name: "customers" }];
      if (path.endsWith("/import") && method === "POST") {
        const body = JSON.parse(String(init?.body || "{}"));
        expect(body.dataset_name).toBe("site-slice");
        expect(body.table_or_query).toContain("SELECT");
        return {
          id: 10,
          project_id: 7,
          data_source_id: 3,
          dataset_id: 22,
          dataset_version_id: 32,
          table_or_query: body.table_or_query,
          status: "succeeded",
          error_message: null,
          created_at: "2026-08-11T06:00:00Z",
          finished_at: "2026-08-11T06:00:01Z",
        };
      }
      return [];
    });

    renderPage();
    fireEvent.click(await screen.findByTestId("import-data-3"));
    fireEvent.click(await screen.findByTestId("import-mode-sql"));
    fireEvent.change(screen.getByTestId("import-dataset-name"), {
      target: { value: "site-slice" },
    });
    fireEvent.change(screen.getByTestId("import-sql"), {
      target: { value: "SELECT * FROM public.customers WHERE segment = 'growth'" },
    });
    fireEvent.click(screen.getByTestId("import-submit"));
    await waitFor(() => expect(screen.getByTestId("open-imported-dataset")).toBeInTheDocument());
  });

  it("shows failed import error and allows retry", async () => {
    const failed = {
      id: 11,
      project_id: 7,
      data_source_id: 3,
      dataset_id: 23,
      dataset_version_id: null,
      table_or_query: "public.missing",
      status: "failed",
      error_message: 'relation "public.missing" does not exist',
      created_at: "2026-08-11T06:00:00Z",
      finished_at: "2026-08-11T06:00:01Z",
    };
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      if (path === "/projects/7/data-sources") return [activePostgres];
      if (path.includes("/data-import-jobs?")) return [];
      if (path.endsWith("/schemas")) return ["public"];
      if (path.includes("/tables?")) return [{ schema: "public", name: "missing" }];
      if (path.endsWith("/import") && method === "POST") return failed;
      return [];
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("import-data-3"));
    await screen.findByTestId("import-table");
    fireEvent.click(screen.getByTestId("import-submit"));
    expect(await screen.findByText(/relation "public.missing" does not exist/i)).toBeInTheDocument();
    expect(screen.getByTestId("import-submit")).toHaveTextContent(/Retry import/i);
  });

  it("confirms permanent delete and surfaces 409 lineage protection", async () => {
    apiMock
      .mockResolvedValueOnce([activePostgres])
      .mockRejectedValueOnce(
        new ApiRequestError(
          409,
          "This data source has import history and cannot be permanently deleted.",
          "Deactivate it to prevent future imports while preserving lineage.",
        ),
      );
    renderPage();
    fireEvent.click(await screen.findByTestId("delete-3"));
    expect(confirmMock).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText(/import history/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Deactivate it to prevent future imports/i)).toBeInTheDocument();
  });

  it("hides write controls for viewers", async () => {
    canWriteRef.value = false;
    apiMock.mockResolvedValueOnce([activePostgres, inactivePostgres]);
    renderPage();
    await screen.findByText("postgres-prod");
    expect(screen.queryByTestId("import-data-3")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deactivate-3")).not.toBeInTheDocument();
    expect(screen.queryByTestId("activate-4")).not.toBeInTheDocument();
    expect(screen.queryByTestId("delete-3")).not.toBeInTheDocument();
    expect(screen.queryByTestId("add-data-source")).not.toBeInTheDocument();
  });

  it("shows typed PostgreSQL fields instead of raw JSON", async () => {
    apiMock.mockResolvedValueOnce([]);
    renderPage();
    fireEvent.click(await screen.findByTestId("add-data-source"));
    expect(screen.getByTestId("data-source-connection-mode")).toHaveValue("host_port");
    expect(screen.getByTestId("data-source-host")).toBeInTheDocument();
    expect(screen.getByTestId("data-source-port")).toHaveAttribute("type", "number");
    expect(screen.getByTestId("data-source-port")).toHaveValue(5432);
    expect(screen.getByTestId("data-source-database")).toBeInTheDocument();
    expect(screen.getByTestId("data-source-user")).toBeInTheDocument();
    expect(screen.getByTestId("data-source-password")).toHaveAttribute("type", "password");
    expect(screen.queryByTestId("data-source-config")).not.toBeInTheDocument();
  });

  it("keeps JSON configuration for managed file sources", async () => {
    apiMock.mockResolvedValueOnce([]);
    renderPage();
    fireEvent.click(await screen.findByTestId("add-data-source"));
    fireEvent.change(screen.getByTestId("data-source-type"), { target: { value: "file" } });
    expect(screen.getByTestId("data-source-config")).toBeInTheDocument();
    expect(screen.queryByTestId("data-source-host")).not.toBeInTheDocument();
  });

  it("converts typed PostgreSQL fields into the existing API configuration payload", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/projects/7/data-sources" && (init?.method || "GET") === "GET") return [];
      if (path === "/projects/7/data-sources" && init?.method === "POST") {
        const body = JSON.parse(String(init.body || "{}"));
        expect(body).toEqual({
          name: "warehouse",
          source_type: "postgres",
          config: { host: "db.internal", port: 5433, database: "analytics", user: "reader" },
          secrets: { password: "s3cret" },
        });
        return { ...activePostgres, id: 8, name: "warehouse", config: body.config };
      }
      return [];
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("add-data-source"));
    fireEvent.change(screen.getByTestId("data-source-name"), { target: { value: "warehouse" } });
    fireEvent.change(screen.getByTestId("data-source-host"), { target: { value: "db.internal" } });
    fireEvent.change(screen.getByTestId("data-source-port"), { target: { value: "5433" } });
    fireEvent.change(screen.getByTestId("data-source-database"), { target: { value: "analytics" } });
    fireEvent.change(screen.getByTestId("data-source-user"), { target: { value: "reader" } });
    fireEvent.change(screen.getByTestId("data-source-password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByTestId("data-source-save"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/data-sources",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("loads saved non-secret values into the edit form without exposing a password", async () => {
    apiMock.mockResolvedValueOnce([activePostgres]);
    renderPage();
    fireEvent.click(await screen.findByTestId("edit-3"));
    expect(screen.getByTestId("data-source-host")).toHaveValue("postgres-source");
    expect(screen.getByTestId("data-source-port")).toHaveValue(5432);
    expect(screen.getByTestId("data-source-database")).toHaveValue("db");
    expect(screen.getByTestId("data-source-user")).toHaveValue("u");
    expect(screen.getByTestId("data-source-password")).toHaveValue("");
    expect(screen.getByTestId("data-source-password")).toHaveAttribute(
      "placeholder",
      "Leave blank to keep saved password",
    );
    expect(screen.queryByDisplayValue("super-secret-password")).not.toBeInTheDocument();
    expect(screen.queryByText(/super-secret-password/)).not.toBeInTheDocument();
  });

  it("keeps the saved password when the edit form password is left blank", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/projects/7/data-sources") return [activePostgres];
      if (path === "/projects/7/data-sources/3" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body || "{}"));
        expect(body.secrets).toEqual({});
        expect(body.config).toEqual({
          host: "postgres-source",
          port: 5432,
          database: "db",
          user: "u",
        });
        expect(body.clear_secrets).toEqual(["dsn", "url"]);
        return activePostgres;
      }
      return [];
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("edit-3"));
    fireEvent.click(screen.getByTestId("data-source-save"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/data-sources/3",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
  });

  it("edits an existing DSN source without exposing the URL and allows name-only save", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/projects/7/data-sources" && (init?.method || "GET") === "GET") {
        return [dsnPostgres];
      }
      if (path === "/projects/7/data-sources/5" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body || "{}"));
        expect(body).toEqual({
          name: "postgres-dsn-renamed",
          config: {},
          secrets: {},
        });
        expect(JSON.stringify(body)).not.toMatch(/postgresql:\/\//i);
        return { ...dsnPostgres, name: "postgres-dsn-renamed" };
      }
      return [];
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("edit-5"));
    expect(screen.getByTestId("data-source-connection-mode")).toHaveValue("connection_url");
    expect(screen.getByTestId("data-source-connection-url")).toHaveValue("");
    expect(screen.getByTestId("data-source-connection-url")).toHaveAttribute(
      "placeholder",
      "Leave blank to keep saved connection URL",
    );
    expect(screen.getByText(/saved connection URL is not shown/i)).toBeInTheDocument();
    expect(screen.queryByTestId("data-source-host")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(/postgresql:/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("data-source-name"), {
      target: { value: "postgres-dsn-renamed" },
    });
    fireEvent.click(screen.getByTestId("data-source-save"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/data-sources/5",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
  });

  it("clears DSN secrets when switching connection mode to Host / Port", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/projects/7/data-sources") return [dsnPostgres];
      if (path === "/projects/7/data-sources/5" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body || "{}"));
        expect(body.clear_secrets).toEqual(["dsn", "url"]);
        expect(body.config).toEqual({
          host: "db.internal",
          port: 5432,
          database: "analytics",
          user: "reader",
        });
        expect(body.secrets).toEqual({ password: "typed-pass" });
        return {
          ...dsnPostgres,
          connection_mode: "host_port",
          config: body.config,
        };
      }
      return [];
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("edit-5"));
    fireEvent.change(screen.getByTestId("data-source-connection-mode"), {
      target: { value: "host_port" },
    });
    fireEvent.change(screen.getByTestId("data-source-host"), { target: { value: "db.internal" } });
    fireEvent.change(screen.getByTestId("data-source-database"), {
      target: { value: "analytics" },
    });
    fireEvent.change(screen.getByTestId("data-source-user"), { target: { value: "reader" } });
    fireEvent.change(screen.getByTestId("data-source-password"), {
      target: { value: "typed-pass" },
    });
    fireEvent.click(screen.getByTestId("data-source-save"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/data-sources/5",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
  });

  it("shows connection test success with success styling", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/projects/7/data-sources") return [activePostgres];
      if (path.endsWith("/test") && init?.method === "POST") {
        return { status: "ok", message: "Connection succeeded." };
      }
      return [];
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("test-connection-3"));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveClass("success");
    expect(notice).toHaveTextContent(/Connection succeeded/i);
    expect(screen.getByTestId("last-test-message-3")).toHaveClass("ok");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows connection test failure with error styling instead of success", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/projects/7/data-sources") {
        return [
          {
            ...activePostgres,
            last_test_status: "error",
            last_test_message: "Connection failed. Check the host, database, and credentials.",
          },
        ];
      }
      if (path.endsWith("/test") && init?.method === "POST") {
        return {
          status: "error",
          message: "Connection failed. Check the host, database, and credentials.",
        };
      }
      return [];
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("test-connection-3"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("error");
    expect(alert).toHaveTextContent(/Connection failed/i);
    expect(screen.queryByRole("status", { name: /Connection succeeded/i })).toBeNull();
    expect(document.querySelector(".success")).toBeNull();
    expect(screen.getByTestId("last-test-message-3")).toHaveClass("err");
    expect(screen.getByTestId("last-test-message-3")).toHaveTextContent(/Connection failed/i);
  });
});

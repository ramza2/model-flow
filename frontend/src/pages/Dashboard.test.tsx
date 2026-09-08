import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ProjectProvider } from "../ProjectContext";
import Dashboard from "../pages/Dashboard";

function stubHomeFetch(alerts: Array<Record<string, unknown>>, jobs?: Array<Record<string, unknown>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: string) => {
      const payload = input.endsWith("/projects")
        ? [{ id: 7, name: "Iris", description: "", is_active: true, role: "PROJECT_ADMIN", created_at: "2026-01-01" }]
        : input.includes("/datasets")
          ? [{ id: 1 }, { id: 2 }]
          : input.includes("/jobs")
            ? (jobs ?? [{ id: 3, name: "baseline", algorithm: "random_forest", status: "running", metrics: {} }])
            : input.includes("/endpoints")
              ? [{ id: 1 }]
              : input.includes("/alerts")
                ? alerts
                : [];
      return { ok: true, status: 200, json: async () => payload };
    }),
  );
}

describe("Dashboard", () => {
  it("renders warning alerts as attention while keeping unread inventory", async () => {
    stubHomeFetch([
      {
        id: 1,
        severity: "warning",
        title: "Alert",
        message: "msg",
        is_read: false,
        is_resolved: false,
        link_path: null,
        created_at: "2026-01-01",
      },
    ]);
    render(
      <MemoryRouter>
        <ProjectProvider>
          <Dashboard />
        </ProjectProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText(/Workspace home/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Create project/ })).toBeInTheDocument();
    expect(await screen.findByText("Iris")).toBeInTheDocument();
    expect((await screen.findByText("Datasets")).closest(".stat")?.querySelector(".value")?.textContent).toBe("2");
    expect((await screen.findByText("Unread alerts")).closest(".stat")?.querySelector(".value")?.textContent).toBe("1");
    expect(await screen.findByTestId("home-attention")).toHaveTextContent("1 alert needing attention");
    expect(screen.getByTestId("home-next-action-alerts")).toBeInTheDocument();
  });

  it("keeps info-only unread alerts out of Needs attention", async () => {
    stubHomeFetch(
      Array.from({ length: 17 }, (_, index) => ({
        id: index + 1,
        severity: "info",
        title: "Pipeline completed",
        message: "Phase1 pipeline execution completed successfully.",
        is_read: false,
        is_resolved: false,
        link_path: null,
        created_at: "2026-01-01",
      })),
    );
    render(
      <MemoryRouter>
        <ProjectProvider>
          <Dashboard />
        </ProjectProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Iris")).toBeInTheDocument();
    expect((await screen.findByText("Unread alerts")).closest(".stat")?.querySelector(".value")?.textContent).toBe("17");
    expect(screen.queryByTestId("home-attention")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-next-action-alerts")).not.toBeInTheDocument();
  });

  it("counts mixed severities with unread inventory and attention separately", async () => {
    stubHomeFetch([
      { id: 1, severity: "info", title: "ok", message: "done", is_read: false, is_resolved: false, link_path: null, created_at: "2026-01-01" },
      { id: 2, severity: "info", title: "ok2", message: "done", is_read: false, is_resolved: false, link_path: null, created_at: "2026-01-01" },
      { id: 3, severity: "error", title: "bad", message: "failed", is_read: false, is_resolved: false, link_path: null, created_at: "2026-01-01" },
    ]);
    render(
      <MemoryRouter>
        <ProjectProvider>
          <Dashboard />
        </ProjectProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Iris")).toBeInTheDocument();
    expect((await screen.findByText("Unread alerts")).closest(".stat")?.querySelector(".value")?.textContent).toBe("3");
    expect(await screen.findByTestId("home-attention")).toHaveTextContent("1 alert needing attention");
    expect(screen.getByTestId("home-next-action-alerts")).toBeInTheDocument();
  });

  it("keeps failed-job attention when alerts are info-only", async () => {
    stubHomeFetch(
      [
        {
          id: 1,
          severity: "info",
          title: "ok",
          message: "done",
          is_read: false,
          is_resolved: false,
          link_path: null,
          created_at: "2026-01-01",
        },
      ],
      [{ id: 3, name: "baseline", algorithm: "random_forest", status: "failed", metrics: {} }],
    );
    render(
      <MemoryRouter>
        <ProjectProvider>
          <Dashboard />
        </ProjectProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("home-attention")).toHaveTextContent("1 failed training job");
    expect(screen.getByTestId("home-attention")).not.toHaveTextContent("needing attention");
    expect(screen.getByTestId("home-next-action-failed-jobs")).toBeInTheDocument();
    expect(screen.queryByTestId("home-next-action-alerts")).not.toBeInTheDocument();
    expect((await screen.findByText("Unread alerts")).closest(".stat")?.querySelector(".value")?.textContent).toBe("1");
  });

  it("shows guided empty state when no project is selected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: string) => {
        const payload = input.endsWith("/projects") ? [] : [];
        return { ok: true, status: 200, json: async () => payload };
      }),
    );
    render(
      <MemoryRouter>
        <ProjectProvider>
          <Dashboard />
        </ProjectProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Create your first project")).toBeInTheDocument();
  });
});

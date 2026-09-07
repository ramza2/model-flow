import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ProjectProvider } from "../ProjectContext";
import Dashboard from "../pages/Dashboard";

describe("Dashboard", () => {
  it("renders live project statistics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: string) => {
        const payload = input.endsWith("/projects")
          ? [{ id: 7, name: "Iris", description: "", is_active: true, role: "PROJECT_ADMIN", created_at: "2026-01-01" }]
          : input.includes("/datasets")
            ? [{ id: 1 }, { id: 2 }]
            : input.includes("/jobs")
              ? [{ id: 3, name: "baseline", algorithm: "random_forest", status: "running", metrics: {} }]
              : input.includes("/endpoints")
                ? []
                : input.includes("/alerts")
                  ? [{ id: 1, severity: "warning", title: "Alert", message: "msg", is_read: false, is_resolved: false, link_path: null, created_at: "2026-01-01" }]
                  : [];
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
    expect(screen.getByText(/Workspace home/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Create project/ })).toBeInTheDocument();
    expect(await screen.findByText("Iris")).toBeInTheDocument();
    expect((await screen.findByText("Datasets")).closest(".stat")?.querySelector(".value")?.textContent).toBe("2");
    expect(await screen.findByTestId("home-attention")).toHaveTextContent("1 unread open alert");
    expect(screen.getByTestId("home-next-action-alerts")).toBeInTheDocument();
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

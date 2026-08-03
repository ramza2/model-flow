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
  });
});

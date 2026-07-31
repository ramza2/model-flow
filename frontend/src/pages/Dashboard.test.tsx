import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import Dashboard from "../pages/Dashboard";

describe("Dashboard", () => {
  it("renders workspace home", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          projects: 1,
          datasets: 2,
          jobs: 3,
          endpoints: 0,
          succeeded_jobs: 1,
          failed_jobs: 0,
        }),
      }),
    );
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Workspace home/i)).toBeInTheDocument();
    expect(await screen.findByText("Create project")).toBeInTheDocument();
    expect(screen.getByText("Projects").closest(".stat")?.querySelector(".value")?.textContent).toBe("1");
  });
});

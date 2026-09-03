import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppShell from "./AppShell";
import { AuthProvider } from "./AuthContext";
import { ProjectProvider } from "./ProjectContext";
import { TOKEN_KEY } from "./api";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function mockFetch(options?: { systemAdmin?: boolean; role?: string }) {
  const systemAdmin = options?.systemAdmin ?? true;
  const role = options?.role ?? "PROJECT_ADMIN";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 1,
            email: "admin@example.com",
            full_name: "Administrator",
            is_active: true,
            is_system_admin: systemAdmin,
            created_at: "2026-01-01",
            updated_at: "2026-01-01",
          }),
        };
      }
      if (url.endsWith("/projects") || url.includes("/projects?")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { id: 9, name: "Production", description: "", is_active: true, role, created_at: "2026-01-01" },
            { id: 11, name: "Staging", description: "", is_active: true, role, created_at: "2026-01-01" },
          ],
        };
      }
      if (url.includes("/alerts")) {
        return { ok: true, status: 200, json: async () => [] };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
}

function renderShell(path = "/projects/9/datasets") {
  localStorage.setItem(TOKEN_KEY, "test-token");
  localStorage.setItem("modelflow_project_id", "9");
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <ProjectProvider>
          <Routes>
            <Route
              path="*"
              element={(
                <AppShell>
                  <div>Shell content</div>
                </AppShell>
              )}
            />
          </Routes>
        </ProjectProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("AppShell Phase 1.5-A navigation", () => {
  it("renders grouped sidebar IA with Overview and dual audit scopes for system admins", async () => {
    mockFetch({ systemAdmin: true });
    renderShell("/projects/9/jobs");

    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getByText("Workspace")).toBeInTheDocument();
    expect(within(nav).getByText("Data")).toBeInTheDocument();
    expect(within(nav).getByText("Build")).toBeInTheDocument();
    expect(within(nav).getByText("Models & Serving")).toBeInTheDocument();
    expect(within(nav).getByText("Operations")).toBeInTheDocument();
    expect(within(nav).getByText("Governance")).toBeInTheDocument();
    expect(within(nav).getByText("System")).toBeInTheDocument();

    expect(within(nav).getByRole("link", { name: /Overview/ })).toHaveAttribute("href", "/projects/9");
    expect(within(nav).getByRole("link", { name: /^Pipelines$/ })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /Training Jobs/ })).toHaveClass("active");
    expect(within(nav).getByRole("link", { name: /^Audit Logs$/ })).toHaveAttribute("href", "/projects/9/audit");
    expect(within(nav).getByRole("link", { name: /Global Audit Logs/ })).toHaveAttribute("href", "/audit");
    expect(within(nav).getByRole("link", { name: /Administration/ })).toHaveAttribute("href", "/admin");
    expect(within(nav).getByRole("link", { name: /^Projects$/ })).not.toHaveClass("active");
  });

  it("hides system navigation for project admins while keeping project audit logs", async () => {
    mockFetch({ systemAdmin: false, role: "PROJECT_ADMIN" });
    renderShell("/projects/9");

    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getByRole("link", { name: /^Audit Logs$/ })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: /Global Audit Logs/ })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: /Administration/ })).not.toBeInTheDocument();
    expect(within(nav).queryByText("System")).not.toBeInTheDocument();
  });

  it("switches project to Overview instead of preserving entity routes", async () => {
    mockFetch({ systemAdmin: true });
    renderShell("/projects/9/jobs/3");

    const picker = await screen.findByLabelText("Project");
    fireEvent.change(picker, { target: { value: "11" } });
    expect(picker).toHaveValue("11");
    expect(await screen.findByRole("link", { name: /Overview/ })).toHaveAttribute("href", "/projects/11");
  });
});

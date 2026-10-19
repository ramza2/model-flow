import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    expect(within(nav).getByText("작업공간")).toBeInTheDocument();
    expect(within(nav).getByText("데이터")).toBeInTheDocument();
    expect(within(nav).getByText("모델 개발")).toBeInTheDocument();
    expect(within(nav).getByText("모델 운영")).toBeInTheDocument();
    expect(within(nav).getByText("운영 관리")).toBeInTheDocument();
    expect(within(nav).getByText("거버넌스")).toBeInTheDocument();
    expect(within(nav).getByText("시스템")).toBeInTheDocument();

    expect(within(nav).getByRole("link", { name: /개요/ })).toHaveAttribute("href", "/projects/9");
    expect(within(nav).getByRole("link", { name: /^데이터셋$/ })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /^데이터 가공$/ })).toHaveAttribute(
      "href",
      "/projects/9/preparations",
    );
    expect(within(nav).getByRole("link", { name: /^파이프라인$/ })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /모니터링/ })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /품질 정책/ })).toHaveAttribute(
      "href",
      "/projects/9/model-quality/policies",
    );
    expect(within(nav).getByRole("link", { name: /모델 학습/ })).toHaveClass("active");
    expect(within(nav).getByRole("link", { name: /^감사 로그$/ })).toHaveAttribute("href", "/projects/9/audit");
    expect(within(nav).getByRole("link", { name: /전체 감사 로그/ })).toHaveAttribute("href", "/audit");
    expect(within(nav).getByRole("link", { name: /시스템 관리/ })).toHaveAttribute("href", "/admin");
    expect(within(nav).getByRole("link", { name: /^프로젝트$/ })).not.toHaveClass("active");
  });

  it("hides system navigation for project admins while keeping project audit logs", async () => {
    mockFetch({ systemAdmin: false, role: "PROJECT_ADMIN" });
    renderShell("/projects/9");

    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getByRole("link", { name: /^감사 로그$/ })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: /전체 감사 로그/ })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: /시스템 관리/ })).not.toBeInTheDocument();
    expect(within(nav).queryByText("시스템")).not.toBeInTheDocument();
  });

  it("switches project to Overview instead of preserving entity routes", async () => {
    mockFetch({ systemAdmin: true });
    renderShell("/projects/9/jobs/3");

    const picker = await screen.findByLabelText("프로젝트");
    fireEvent.change(picker, { target: { value: "11" } });
    expect(picker).toHaveValue("11");
    expect(await screen.findByRole("link", { name: /개요/ })).toHaveAttribute("href", "/projects/11");
  });
});

describe("AppShell drawer accessibility", () => {
  const originalMatchMedia = window.matchMedia;

  function mockDrawerViewport(matches: boolean) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("1023") ? matches : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("keeps closed drawer navigation out of the keyboard tab order", async () => {
    mockDrawerViewport(true);
    mockFetch({ systemAdmin: true });
    renderShell("/projects/9/datasets");

    const toggle = await screen.findByRole("button", { name: /Open navigation/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const sidebar = document.getElementById("app-sidebar");
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(sidebar?.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
  });

  it("moves focus into the drawer when opened and restores it on Escape", async () => {
    mockDrawerViewport(true);
    mockFetch({ systemAdmin: true });
    renderShell("/projects/9/datasets");

    const toggle = await screen.findByRole("button", { name: /Open navigation/i });
    toggle.focus();
    fireEvent.click(toggle);

    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("app-sidebar")?.hasAttribute("inert")).toBe(false);
    await waitFor(() => {
      expect(within(nav).getByRole("link", { name: /^홈$/ })).toHaveFocus();
    });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open navigation/i })).toHaveFocus();
    });
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
  });

  it("closes the drawer from the backdrop and restores toggle focus", async () => {
    mockDrawerViewport(true);
    mockFetch({ systemAdmin: true });
    renderShell("/projects/9/datasets");

    fireEvent.click(await screen.findByRole("button", { name: /Open navigation/i }));
    expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss navigation overlay" }));
    expect(await screen.findByRole("button", { name: /Open navigation/i })).toHaveFocus();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
  });

  it("moves focus out of the sidebar before closing on nav link click", async () => {
    mockDrawerViewport(true);
    mockFetch({ systemAdmin: true });
    renderShell("/projects/9/datasets");

    fireEvent.click(await screen.findByRole("button", { name: /Open navigation/i }));
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    const trainingJobs = within(nav).getByRole("link", { name: /모델 학습/ });
    await waitFor(() => {
      expect(within(nav).getByRole("link", { name: /^홈$/ })).toHaveFocus();
    });

    fireEvent.click(trainingJobs);

    const sidebar = document.getElementById("app-sidebar");
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(sidebar?.hasAttribute("inert")).toBe(true);
    expect(sidebar?.contains(document.activeElement)).toBe(false);
    expect(screen.getByRole("button", { name: /Open navigation/i })).toHaveFocus();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
  });
});

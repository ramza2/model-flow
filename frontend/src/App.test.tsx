import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./AuthContext";
import { TOKEN_KEY } from "./api";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function renderApp(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("authentication and navigation", () => {
  it("redirects unauthenticated users to login", async () => {
    renderApp("/projects");
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(screen.getByTestId("login-email")).toHaveValue("");
  });

  it("shows administration navigation only to system administrators", async () => {
    localStorage.setItem(TOKEN_KEY, "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: string) => {
        const payload = input.endsWith("/auth/me")
          ? {
              id: 1,
              email: "admin@example.com",
              full_name: "Administrator",
              is_active: true,
              is_system_admin: true,
              created_at: "2026-01-01",
              updated_at: "2026-01-01",
            }
          : input.endsWith("/projects")
            ? [{ id: 9, name: "Production", description: "", is_active: true, role: "PROJECT_ADMIN", created_at: "2026-01-01" }]
            : [];
        return { ok: true, status: 200, json: async () => payload };
      }),
    );

    renderApp("/projects");

    expect(await screen.findByRole("link", { name: /시스템 관리/ })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Production" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^감사 로그$/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /전체 감사 로그/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /파이프라인/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /개요/ })).toBeInTheDocument();
    expect(screen.getByText("모델 개발")).toBeInTheDocument();
    expect(screen.getByText("모델 운영")).toBeInTheDocument();
    expect(screen.getByText("운영 관리")).toBeInTheDocument();
    expect(screen.getByText("시스템")).toBeInTheDocument();
  });
});

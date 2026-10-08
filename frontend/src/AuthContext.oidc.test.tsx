import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, LoginPage, OidcCallbackPage } from "./AuthContext";
import { TOKEN_KEY } from "./api";

const fetchMock = vi.fn();

describe("OIDC login UX", () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("keeps the classic login form when OIDC is disabled", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ local: true, oidc: { enabled: false, display_name: null } }),
    });
    render(
      <MemoryRouter>
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("login-email")).toBeInTheDocument();
    expect(screen.queryByTestId("login-sso")).not.toBeInTheDocument();
  });

  it("shows the SSO button when OIDC is enabled", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        local: true,
        oidc: { enabled: true, display_name: "Acme SSO" },
      }),
    });
    render(
      <MemoryRouter>
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("login-sso")).toHaveTextContent("Sign in with Acme SSO");
    expect(screen.getByTestId("login-email")).toBeInTheDocument();
  });

  it("exchanges the one-time code and enters the workspace", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/auth/oidc/exchange")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "mf-token",
            token_type: "bearer",
            user: {
              id: 1,
              email: "sso@example.com",
              full_name: "SSO",
              is_active: true,
              is_system_admin: false,
              local_login_enabled: false,
              created_at: "",
              updated_at: "",
            },
          }),
        };
      }
      if (url.includes("/auth/me")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 1,
            email: "sso@example.com",
            full_name: "SSO",
            is_active: true,
            is_system_admin: false,
            local_login_enabled: false,
            created_at: "",
            updated_at: "",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      <MemoryRouter initialEntries={["/login/oidc/callback?code=one-time&return_to=/projects"]}>
        <AuthProvider>
          <Routes>
            <Route path="/login/oidc/callback" element={<OidcCallbackPage />} />
            <Route path="/projects" element={<div data-testid="workspace">Workspace</div>} />
            <Route path="/login" element={<div data-testid="login">Login</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId("workspace")).toBeInTheDocument());
    expect(localStorage.getItem(TOKEN_KEY)).toBe("mf-token");
  });

  it("routes exchange failures back to login with a friendly error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ detail: { detail: "Sign-in could not be completed.", hint: null } }),
    });

    render(
      <MemoryRouter initialEntries={["/login/oidc/callback?code=bad"]}>
        <AuthProvider>
          <Routes>
            <Route path="/login/oidc/callback" element={<OidcCallbackPage />} />
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    // LoginPage also fetches /auth/methods
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ local: true, oidc: { enabled: false, display_name: null } }),
    });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Sign-in could not be completed."),
    );
  });

  it("keeps local email/password sign-in working", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/methods")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ local: true, oidc: { enabled: true, display_name: "SSO" } }),
        };
      }
      if (url.includes("/auth/login") && init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "local-token",
            token_type: "bearer",
            user: {
              id: 2,
              email: "local@example.com",
              full_name: "Local",
              is_active: true,
              is_system_admin: false,
              local_login_enabled: true,
              created_at: "",
              updated_at: "",
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      <MemoryRouter>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<LoginPage />} />
            <Route path="*" element={<div data-testid="home">Home</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findByTestId("login-sso");
    fireEvent.change(screen.getByTestId("login-email"), {
      target: { value: "local@example.com" },
    });
    fireEvent.change(screen.getByTestId("login-password"), {
      target: { value: "Password123!" },
    });
    fireEvent.click(screen.getByTestId("login-submit"));
    await waitFor(() => expect(localStorage.getItem(TOKEN_KEY)).toBe("local-token"));
  });
});

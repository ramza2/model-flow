import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Alerts from "./Alerts";

const apiMock = vi.fn();
let canResolve = true;

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, is_system_admin: false, email: "admin@example.com" } }),
}));

vi.mock("../ProjectContext", () => ({
  useProject: () => ({
    selectedProject: { id: 1, role: canResolve ? "PROJECT_ADMIN" : "VIEWER" },
  }),
  userCanProject: () => canResolve,
}));

const driftWarning = {
  id: 11,
  severity: "warning",
  title: "Data drift requires attention",
  message: "Drift run #12 detected watch drift between dataset versions #7 and #9.",
  is_read: false,
  is_resolved: false,
  link_path: "/projects/1/monitoring",
  created_at: "2026-08-18T07:00:00Z",
};

const driftCritical = {
  id: 12,
  severity: "critical",
  title: "Critical data drift detected",
  message: "Drift run #13 detected critical drift between dataset versions #7 and #10.",
  is_read: false,
  is_resolved: false,
  link_path: "/projects/1/monitoring",
  created_at: "2026-08-18T07:01:00Z",
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/1/alerts"]}>
      <Routes>
        <Route path="/projects/:projectId/alerts" element={<Alerts />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Alerts page", () => {
  beforeEach(() => {
    canResolve = true;
    apiMock.mockReset();
  });

  it("renders drift warning/critical alerts with related links", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/1/alerts?is_resolved=false") {
        return [driftWarning, driftCritical];
      }
      throw new Error(`unexpected api ${path}`);
    });
    renderPage();
    expect(await screen.findByText(driftWarning.title)).toBeInTheDocument();
    expect(screen.getByText(driftCritical.title)).toBeInTheDocument();
    expect(screen.getAllByText("View related item →")).toHaveLength(2);
    const monitoringLink = screen.getAllByRole("link", { name: "View related item →" })[0];
    expect(monitoringLink.getAttribute("href")).toBe("/projects/1/monitoring");
  });

  it("adds resolve tooltip and accessible description", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/1/alerts?is_resolved=false") return [driftWarning];
      throw new Error(`unexpected api ${path}`);
    });
    renderPage();
    const resolveButton = await screen.findByTitle(
      "Mark this alert as resolved. It remains available in the Resolved tab.",
    );
    expect(resolveButton.getAttribute("title")).toContain("Resolved tab");
    expect(resolveButton.getAttribute("aria-label")).toContain("Mark this alert as resolved");
  });

  it("keeps resolved filter behavior while resolving", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/projects/1/alerts?is_resolved=false") return [driftWarning];
      if (path === "/projects/1/alerts/11/resolve" && init?.method === "POST") {
        return { ...driftWarning, is_resolved: true, is_read: true };
      }
      if (path === "/projects/1/alerts?is_resolved=true") {
        return [{ ...driftWarning, is_resolved: true, is_read: true }];
      }
      return [];
    });
    renderPage();
    const resolveButton = await screen.findByTitle(
      "Mark this alert as resolved. It remains available in the Resolved tab.",
    );
    fireEvent.click(resolveButton);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/1/alerts/11/resolve",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
    expect(await screen.findByText(driftWarning.title)).toBeInTheDocument();
  });
});

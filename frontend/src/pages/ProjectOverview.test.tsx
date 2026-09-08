import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectOverview from "./ProjectOverview";

const apiMock = vi.fn();
let canManage = true;

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

vi.mock("../AuthContext", () => ({
  useAuth: () => ({
    user: { id: 1, is_system_admin: false, email: "admin@example.com" },
  }),
}));

vi.mock("../ProjectContext", () => ({
  useProject: () => ({
    selectProject: vi.fn(),
    refreshProjects: vi.fn(),
  }),
  userCanProject: (_user: unknown, _project: unknown, ...roles: string[]) => {
    if (roles.includes("PROJECT_ADMIN")) return canManage;
    return true;
  },
}));

describe("ProjectOverview", () => {
  beforeEach(() => {
    canManage = true;
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/7") {
        return {
          id: 7,
          name: "Ops Project",
          description: "Lifecycle control",
          is_active: true,
          role: canManage ? "PROJECT_ADMIN" : "VIEWER",
          created_at: "2026-01-01",
        };
      }
      if (path.endsWith("/jobs")) {
        return [
          { id: 1, name: "train-a", algorithm: "ridge", status: "running", metrics: {} },
          { id: 2, name: "train-b", algorithm: "rf", status: "failed", metrics: {} },
        ];
      }
      if (path.endsWith("/monitoring/data")) {
        return {
          dataset_count: 2,
          dataset_version_count: 3,
          quality_check_count: 1,
          failed_quality_check_count: 0,
          latest_quality_status: "passed",
        };
      }
      if (path.endsWith("/monitoring/models")) {
        return {
          model_version_count: 4,
          lifecycle_counts: { PRODUCTION: 1, CANDIDATE: 3 },
          endpoint_count: 1,
          ready_endpoint_count: 1,
          total_requests: 10,
          total_errors: 0,
          latest_drift_status: null,
        };
      }
      if (path.includes("/alerts")) {
        return [
          {
            id: 9,
            severity: "warning",
            title: "Open alert",
            message: "Something needs review",
            is_read: false,
            is_resolved: false,
            link_path: "/projects/7/monitoring",
            created_at: "2026-01-02T00:00:00Z",
          },
        ];
      }
      if (path.endsWith("/members")) {
        return [
          {
            id: 1,
            user_id: 1,
            email: "admin@example.com",
            full_name: "Admin",
            role: "PROJECT_ADMIN",
            created_at: "2026-01-01",
          },
        ];
      }
      throw new Error(`unexpected ${path}`);
    });
  });

  it("renders factual lifecycle signals and keeps admin controls for PROJECT_ADMIN", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/7"]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectOverview />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("overview-signals")).toHaveTextContent("No failed quality checks");
    expect(screen.getByTestId("overview-signals")).toHaveTextContent("1 active training job");
    expect(screen.getByTestId("overview-signals")).toHaveTextContent("1 production model");
    expect(screen.getByTestId("overview-signals")).toHaveTextContent("1 / 1 deployments ready");
    expect(screen.getByTestId("overview-signals")).toHaveTextContent("1 open alert");
    expect(screen.getByTestId("overview-data")).toBeInTheDocument();
    expect(screen.getByTestId("overview-build")).toBeInTheDocument();
    expect(screen.getByTestId("overview-models")).toBeInTheDocument();
    expect(screen.getByTestId("overview-serving")).toBeInTheDocument();
    expect(screen.getByText("Open alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit project" })).toBeInTheDocument();
    expect(screen.getByTestId("overview-members")).toBeInTheDocument();
  });

  it("hides member and delete controls for read-only users", async () => {
    canManage = false;
    render(
      <MemoryRouter initialEntries={["/projects/7"]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectOverview />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("overview-signals")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit project" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("overview-members")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overview-danger")).not.toBeInTheDocument();
  });
});

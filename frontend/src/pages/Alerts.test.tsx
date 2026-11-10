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
    expect(await screen.findByText("데이터 분포 변화 확인 필요")).toBeInTheDocument();
    expect(screen.getByText("심각한 데이터 분포 변화 감지")).toBeInTheDocument();
    expect(screen.getByText("데이터 분포 평가 #12에서 데이터셋 기준 버전 (#7)과 비교 버전 (#9) 사이에 주의가 필요한 분포 변화가 발견됐습니다.")).toBeInTheDocument();
    expect(screen.getByText("데이터 분포 평가 #13에서 데이터셋 기준 버전 (#7)과 비교 버전 (#10) 사이에 심각한 분포 변화가 발견됐습니다.")).toBeInTheDocument();
    expect(screen.getAllByText("관련 항목 보기 →")).toHaveLength(2);
    const monitoringLink = screen.getAllByRole("link", { name: "관련 항목 보기 →" })[0];
    expect(monitoringLink.getAttribute("href")).toBe("/projects/1/monitoring");
  });

  it("hides Resolve for read-only users while keeping alert content", async () => {
    canResolve = false;
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/1/alerts?is_resolved=false") return [driftWarning];
      throw new Error(`unexpected api ${path}`);
    });
    renderPage();
    expect(await screen.findByText("데이터 분포 변화 확인 필요")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /알림 해결 완료 처리/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "읽음 처리" })).toBeInTheDocument();
  });

  it("adds resolve tooltip and accessible description", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/projects/1/alerts?is_resolved=false") return [driftWarning];
      throw new Error(`unexpected api ${path}`);
    });
    renderPage();
    const resolveButton = await screen.findByTitle(
      "이 알림을 해결 완료로 표시합니다. 해결 완료 탭에서 계속 확인할 수 있습니다.",
    );
    expect(resolveButton.getAttribute("title")).toContain("해결 완료 탭");
    expect(resolveButton.getAttribute("aria-label")).toContain("알림 해결 완료 처리");
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
      "이 알림을 해결 완료로 표시합니다. 해결 완료 탭에서 계속 확인할 수 있습니다.",
    );
    fireEvent.click(resolveButton);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/1/alerts/11/resolve",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "해결 완료" }));
    expect(await screen.findByText("데이터 분포 변화 확인 필요")).toBeInTheDocument();
  });

  it("translates persisted feedback-dataset alerts and preserves unfamiliar messages", async () => {
    apiMock.mockResolvedValue([
      {
        ...driftWarning,
        id: 21,
        title: "Feedback dataset ready: Iris 붓꽃 데이터 v2",
        message: "Materialized 3 approved feedback row(s) onto base DatasetVersion #14 creating DatasetVersion #15 (v2).",
      },
      { ...driftWarning, id: 22, title: "Custom alert title", message: "Custom alert details" },
      {
        ...driftWarning, id: 23,
        title: "Data drift requires attention",
        message: "Drift run #23 detected watch drift between dataset versions #4 and #5. Affected columns: temperature (watch, 0.31).",
      },
    ]);
    renderPage();
    expect(await screen.findByText("피드백 데이터셋 준비 완료: Iris 붓꽃 데이터 v2")).toBeInTheDocument();
    expect(screen.getByText("승인된 피드백 3건을 데이터셋 버전 #14에 반영하여 새 버전 #15 (v2)를 생성했습니다.")).toBeInTheDocument();
    expect(screen.getByText("Custom alert title")).toBeInTheDocument();
    expect(screen.getByText("Custom alert details")).toBeInTheDocument();
    expect(
      screen.getByText("데이터 분포 평가 #23에서 데이터셋 기준 버전 (#4)과 비교 버전 (#5) 사이에 주의가 필요한 분포 변화가 발견됐습니다. 영향받은 컬럼: temperature (watch, 0.31)."),
    ).toBeInTheDocument();
  });
});

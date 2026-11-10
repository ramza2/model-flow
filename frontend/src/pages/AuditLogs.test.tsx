import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuditLogs from "./AuditLogs";

const apiMock = vi.fn();
vi.mock("../api", () => ({ api: (...args: unknown[]) => apiMock(...args) }));

const sampleEvent = {
  id: 10, created_at: "2026-11-09T02:00:00Z", user_email: "admin@example.com",
  action: "model.approve", resource_type: "model_version", resource_id: "9",
  success: true, failure_reason: null,
};

function renderPage(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:projectId/audit" element={<AuditLogs />} />
        <Route path="/audit" element={<AuditLogs />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Korean audit log screens", () => {
  beforeEach(() => { apiMock.mockReset(); apiMock.mockResolvedValue([sampleEvent]); });

  it("keeps project scope and raw action while translating visible labels", async () => {
    renderPage("/projects/1/audit");
    expect(await screen.findByText("감사 로그")).toBeInTheDocument();
    expect(screen.getByText("모델 버전 승인")).toBeInTheDocument();
    expect(screen.getByText("model.approve")).toBeInTheDocument();
    expect(screen.getByText("성공")).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith("/projects/1/audit");
  });

  it("keeps global scope and API filters untranslated", async () => {
    renderPage("/audit");
    expect(await screen.findByText("전체 감사 로그")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("예: model.approve (내부 작업 코드)"), { target: { value: "model.approve" } });
    fireEvent.change(screen.getByLabelText("대상 유형"), { target: { value: "model_version" } });
    fireEvent.click(screen.getByRole("button", { name: "필터 적용" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/admin/audit?action=model.approve&resource_type=model_version"));
  });

  it("shows known stored action/resource codes in Korean without losing the raw audit code", async () => {
    apiMock.mockResolvedValue([
      { ...sampleEvent, id: 11, action: "auth.login", resource_type: "user", resource_id: "1" },
      { ...sampleEvent, id: 12, action: "endpoint.swap", resource_type: "endpoint", resource_id: "6" },
      { ...sampleEvent, id: 13, action: "feedback_materialization.succeed", resource_type: "feedback_materialization_run", resource_id: "3" },
      { ...sampleEvent, id: 14, action: "unfamiliar.custom", resource_type: "unfamiliar_resource", resource_id: "7" },
    ]);
    renderPage("/audit");
    expect(await screen.findByText("사용자 로그인")).toBeInTheDocument();
    expect(screen.getByText("배포 모델 교체")).toBeInTheDocument();
    expect(screen.getByText("피드백 데이터셋 생성 완료")).toBeInTheDocument();
    expect(screen.getByText("피드백 데이터셋 생성 작업")).toBeInTheDocument();
    expect(screen.getByText("endpoint.swap")).toBeInTheDocument();
    expect(screen.getAllByText("unfamiliar.custom")).toHaveLength(1);
  });
});

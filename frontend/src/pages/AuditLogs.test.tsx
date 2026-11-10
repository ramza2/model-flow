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
});

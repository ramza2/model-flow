import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Administration from "./Administration";

const apiMock = vi.fn();

vi.mock("../api", () => ({ api: (...args: unknown[]) => apiMock(...args) }));
vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, email: "admin@example.com", is_system_admin: true } }),
}));

const retention = { enabled: true, days: 14, minimum_verified_keep: 2 };

function mockEndpoints() {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/users") return { items: [] };
    if (path === "/admin/status") return {
      api: "ok", version: "1.0.0", database: "ok", minio: "ok", mlflow: "ok",
      healthy_worker_count: 1, workers: [], queue_depths: {}, storage: null,
    };
    if (path === "/admin/settings") return {
      allow_train_on_quality_fail: false, store_inference_payloads: false,
      max_upload_bytes: 1, rate_limit_per_minute: 1, worker_max_concurrent_jobs: 1,
    };
    if (path === "/admin/backup-retention") {
      if (init?.method === "PUT") return { ...retention, ...JSON.parse(String(init.body)) };
      return retention;
    }
    throw new Error(`Unexpected API: ${path}`);
  });
}

describe("Administration backup retention", () => {
  beforeEach(() => { apiMock.mockReset(); vi.restoreAllMocks(); mockEndpoints(); });

  it("shows Korean settings and current 14-day backup policy", async () => {
    render(<Administration />);
    fireEvent.click(await screen.findByRole("button", { name: "환경 설정" }));
    expect(await screen.findByTestId("backup-retention-form")).toBeInTheDocument();
    expect(screen.getByTestId("backup-retention-days")).toHaveValue(14);
    expect(screen.getByTestId("backup-retention-enabled")).toBeChecked();
    expect(screen.getByText(/최신 검증 완료 자동 백업 2개/)).toBeInTheDocument();
  });

  it("requires confirmation for shortening retention and saves through admin API", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Administration />);
    fireEvent.click(await screen.findByRole("button", { name: "환경 설정" }));
    await screen.findByTestId("backup-retention-form");
    fireEvent.change(screen.getByTestId("backup-retention-days"), { target: { value: "7" } });
    fireEvent.click(screen.getByTestId("backup-retention-save"));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      "/admin/backup-retention",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: true, days: 7 }) }),
    ));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByTestId("backup-retention-days")).toHaveValue(7);
  });

  it("rejects invalid retention without sending a request", async () => {
    render(<Administration />);
    fireEvent.click(await screen.findByRole("button", { name: "환경 설정" }));
    await screen.findByTestId("backup-retention-form");
    fireEvent.change(screen.getByTestId("backup-retention-days"), { target: { value: "5" } });
    fireEvent.submit(screen.getByTestId("backup-retention-form"));
    expect(await screen.findByText("백업 보존 기간은 7~365일 사이의 정수로 입력해 주세요.")).toBeInTheDocument();
    expect(apiMock.mock.calls.filter(([path, init]) => path === "/admin/backup-retention" && init?.method === "PUT")).toHaveLength(0);
  });

  it("keeps user management available if the retention API fails", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/admin/backup-retention") throw new Error("policy unavailable");
      if (path === "/users") return { items: [] };
      if (path === "/admin/settings") return { allow_train_on_quality_fail: false, store_inference_payloads: false, max_upload_bytes: 1, rate_limit_per_minute: 1, worker_max_concurrent_jobs: 1 };
      if (path === "/admin/status") return { api: "ok", version: "1.0", database: "ok", minio: "ok", mlflow: "ok", healthy_worker_count: 0, workers: [], queue_depths: {}, storage: null };
      throw new Error(`Unexpected API: ${path}`);
    });
    render(<Administration />);
    expect(await screen.findByText("백업 보존 정책을 불러오지 못했습니다. 나머지 시스템 관리 기능은 사용할 수 있습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /사용자 추가/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "환경 설정" }));
    expect(screen.getByText("시스템 환경 설정")).toBeInTheDocument();
    expect(screen.queryByTestId("backup-retention-form")).not.toBeInTheDocument();
  });
});

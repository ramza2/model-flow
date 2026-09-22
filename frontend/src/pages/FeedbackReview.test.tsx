import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FeedbackReview from "./FeedbackReview";

const apiMock = vi.fn();

vi.mock("../api", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, email: "admin@example.com", is_system_admin: true } }),
}));

const canWriteRef = { value: true };
vi.mock("../ProjectContext", () => ({
  useProject: () => ({ selectedProject: { id: 7, name: "demo", role: "PROJECT_ADMIN" } }),
  userCanProject: () => canWriteRef.value,
}));

describe("FeedbackReview", () => {
  beforeEach(() => {
    apiMock.mockReset();
    canWriteRef.value = true;
  });

  it("lists feedback, filters, and shows materializable state", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes("/feedback-materializations")) {
        return [
          {
            id: 3,
            status: "succeeded",
            endpoint_id: 12,
            source_model_version_id: 44,
            base_dataset_version_id: 17,
            output_dataset_version_id: 18,
            dataset_id: 5,
            feedback_count: 1,
            finished_at: "2026-09-22T00:00:00Z",
          },
        ];
      }
      return [
        {
          id: 101,
          prediction_id: "p1",
          endpoint_id: 12,
          endpoint_name: "prod",
          model_version_id: 44,
          model_name: "iris",
          model_version: "1",
          predicted_value: 0,
          actual_value: 1,
          predicted_at: "2026-09-22T00:00:00Z",
          review_status: "APPROVED",
          input_snapshot_available: true,
          materializable: true,
        },
        {
          id: 102,
          prediction_id: "p2",
          endpoint_id: 12,
          endpoint_name: "prod",
          model_version_id: 44,
          model_name: "iris",
          model_version: "1",
          predicted_value: 1,
          actual_value: 0,
          predicted_at: "2026-09-22T00:00:00Z",
          review_status: "PENDING",
          input_snapshot_available: false,
          materializable: false,
        },
      ];
    });

    render(
      <MemoryRouter initialEntries={["/projects/7/feedback"]}>
        <Routes>
          <Route path="/projects/:projectId/feedback" element={<FeedbackReview />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("feedback-review-page")).toBeInTheDocument();
    expect(screen.getByTestId("feedback-queue")).toBeInTheDocument();
    expect(screen.getByTestId("feedback-snapshot-102")).toHaveTextContent("Not materializable");
    expect(screen.getByTestId("materialization-output-3")).toHaveAttribute(
      "href",
      "/projects/7/datasets/5",
    );

    fireEvent.change(screen.getByTestId("feedback-status-filter"), { target: { value: "PENDING" } });
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("review_status=PENDING"));
    });
  });

  it("hides write actions for read-only users", async () => {
    canWriteRef.value = false;
    apiMock.mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={["/projects/7/feedback"]}>
        <Routes>
          <Route path="/projects/:projectId/feedback" element={<FeedbackReview />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId("feedback-review-page");
    expect(screen.queryByTestId("feedback-approve")).not.toBeInTheDocument();
    expect(screen.queryByTestId("feedback-materialize")).not.toBeInTheDocument();
  });
});

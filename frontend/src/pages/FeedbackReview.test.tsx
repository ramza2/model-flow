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
        return {
          items: [
            {
              id: 3,
              status: "succeeded",
              endpoint_id: 12,
              source_model_version_id: 44,
              base_dataset_version_id: 17,
              base_dataset_version: 1,
              output_dataset_version_id: 18,
              output_dataset_version: 2,
              dataset_id: 5,
              feedback_count: 1,
              row_count_added: 1,
              finished_at: "2026-09-22T00:00:00Z",
            },
            {
              id: 4,
              status: "failed",
              endpoint_id: 12,
              source_model_version_id: 44,
              base_dataset_version_id: 17,
              dataset_id: 5,
              feedback_count: 1,
              error_message: "Base DatasetVersion was not found",
              finished_at: "2026-09-22T01:00:00Z",
            },
          ],
          total: 2,
          skip: 0,
          limit: 10,
        };
      }
      return {
        items: [
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
        ],
        total: 2,
        skip: 0,
        limit: 25,
      };
    });

    render(
      <MemoryRouter initialEntries={["/projects/7/feedback?endpoint_id=12"]}>
        <Routes>
          <Route path="/projects/:projectId/feedback" element={<FeedbackReview />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("feedback-review-page")).toBeInTheDocument();
    expect(screen.getByTestId("feedback-queue")).toBeInTheDocument();
    expect(screen.getByTestId("feedback-endpoint-filter")).toHaveValue("12");
    expect(screen.getByTestId("feedback-snapshot-102")).toHaveTextContent("생성 불가");
    expect(screen.getByTestId("materialization-output-3")).toHaveAttribute(
      "href",
      "/projects/7/datasets/5?version=2",
    );
    expect(screen.getByTestId("materialization-rows-added-3")).toHaveTextContent("1");
    expect(screen.getByTestId("materialization-error-4")).toHaveTextContent(
      "Base DatasetVersion was not found",
    );
    expect(screen.getByTestId("feedback-pagination")).toBeInTheDocument();
    expect(screen.getByTestId("feedback-materializable-filter")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("feedback-status-filter"), { target: { value: "PENDING" } });
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("review_status=PENDING"));
    });
  });

  it("selects only pending editable feedback on the current page and confirms bulk review", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes("/feedback/review")) return { count: 2, results: [] };
      if (path.includes("/feedback-materializations")) return { items: [], total: 0 };
      return {
        items: [
          { id: 201, review_status: "PENDING", materializable: true, input_snapshot_available: true },
          { id: 202, review_status: "PENDING", materializable: false, input_snapshot_available: false },
          { id: 203, review_status: "APPROVED", materializable: true, input_snapshot_available: true },
          {
            id: 204,
            review_status: "PENDING",
            materializable: false,
            input_snapshot_available: true,
            materialization_run_id: 13,
          },
        ],
        total: 4,
      };
    });

    try {
      render(
        <MemoryRouter initialEntries={["/projects/7/feedback"]}>
          <Routes>
            <Route path="/projects/:projectId/feedback" element={<FeedbackReview />} />
          </Routes>
        </MemoryRouter>,
      );
      const selectPage = await screen.findByTestId("feedback-select-page");
      fireEvent.click(selectPage);

      expect(screen.getByTestId("feedback-select-201")).toBeChecked();
      expect(screen.getByTestId("feedback-select-202")).toBeChecked();
      expect(screen.getByTestId("feedback-select-203")).not.toBeChecked();
      expect(screen.getByTestId("feedback-select-204")).toBeDisabled();
      expect(selectPage).toBeChecked();

      fireEvent.click(screen.getByTestId("feedback-approve"));
      await waitFor(() =>
        expect(apiMock).toHaveBeenCalledWith(
          "/projects/7/feedback/review",
          expect.objectContaining({ method: "POST" }),
        ),
      );
      const reviewCall = apiMock.mock.calls.find(
        ([path]) => path === "/projects/7/feedback/review",
      );
      expect(JSON.parse(reviewCall?.[1].body)).toEqual({
        items: [
          { feedback_id: 201, decision: "approved" },
          { feedback_id: 202, decision: "approved" },
        ],
      });
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("2건"));
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("does not submit selected rows from a previous page", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes("/feedback/review")) return { count: 1, results: [] };
      if (path.includes("/feedback-materializations")) return { items: [], total: 0 };
      const skip = Number(new URLSearchParams(path.split("?")[1]).get("skip"));
      return {
        items: skip === 0
          ? [{ id: 301, review_status: "PENDING", materializable: false, input_snapshot_available: true }]
          : [{ id: 401, review_status: "PENDING", materializable: false, input_snapshot_available: true }],
        total: 26,
      };
    });

    render(
      <MemoryRouter initialEntries={["/projects/7/feedback"]}>
        <Routes>
          <Route path="/projects/:projectId/feedback" element={<FeedbackReview />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTestId("feedback-select-301"));
    expect(screen.getByTestId("feedback-select-301")).toBeChecked();
    fireEvent.click(screen.getByTestId("feedback-next"));
    await screen.findByTestId("feedback-select-401");
    expect(screen.getByTestId("feedback-select-401")).not.toBeChecked();
    fireEvent.click(screen.getByTestId("feedback-select-401"));
    fireEvent.click(screen.getByTestId("feedback-approve"));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/projects/7/feedback/review",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const reviewCall = apiMock.mock.calls.find(
      ([path]) => path === "/projects/7/feedback/review",
    );
    expect(JSON.parse(reviewCall?.[1].body)).toEqual({
      items: [{ feedback_id: 401, decision: "approved" }],
    });
  });

  it("hides write actions for read-only users", async () => {
    canWriteRef.value = false;
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes("paged=true")) {
        return { items: [], total: 0, skip: 0, limit: 25 };
      }
      return { items: [], total: 0, skip: 0, limit: 10 };
    });
    render(
      <MemoryRouter initialEntries={["/projects/7/feedback"]}>
        <Routes>
          <Route path="/projects/:projectId/feedback" element={<FeedbackReview />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId("feedback-review-page");
    expect(screen.queryByTestId("feedback-approve")).not.toBeInTheDocument();
    expect(screen.queryByTestId("feedback-select-page")).not.toBeInTheDocument();
    expect(screen.queryByTestId("feedback-materialize")).not.toBeInTheDocument();
  });
});

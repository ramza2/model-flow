import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../api";
import Preparations from "./Preparations";

const apiMock = vi.fn();
const navigateMock = vi.fn();
const canWriteRef = { value: true };

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, is_system_admin: true, email: "a@b.c" } }),
}));

vi.mock("../ProjectContext", () => ({
  useProject: () => ({ selectedProject: { id: 7, role: "PROJECT_ADMIN" } }),
  userCanProject: () => canWriteRef.value,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const preparations = [
  {
    id: 3,
    project_id: 7,
    name: "Join customers",
    description: "Customer + orders",
    output_dataset_id: null,
    latest_version: 2,
    created_at: "2026-09-01T10:00:00Z",
  },
  {
    id: 4,
    project_id: 7,
    name: "Union sales",
    description: "",
    output_dataset_id: 12,
    latest_version: 1,
    created_at: "2026-09-02T10:00:00Z",
  },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/preparations"]}>
      <Routes>
        <Route path="/projects/:projectId/preparations" element={<Preparations />} />
        <Route
          path="/projects/:projectId/preparations/:preparationId"
          element={<div>Builder</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Preparations list", () => {
  beforeEach(() => {
    canWriteRef.value = true;
    navigateMock.mockReset();
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/projects/7/dataset-preparations" && (!init || !init.method || init.method === "GET")) {
        return preparations;
      }
      throw new Error(`Unexpected ${init?.method || "GET"} ${path}`);
    });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
  });

  it("loads the preparations table with output labels", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Preparations" })).toBeInTheDocument();
    expect(
      screen.getByText("Combine and inspect datasets before training."),
    ).toBeInTheDocument();
    const table = await screen.findByTestId("preparations-table");
    expect(within(table).getByText("Join customers")).toBeInTheDocument();
    expect(within(table).getByText("Not configured")).toBeInTheDocument();
    expect(within(table).getByText("#12")).toBeInTheDocument();
    expect(within(table).getByText("v2")).toBeInTheDocument();
  });

  it("creates a preparation with an empty graph and opens the builder", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/projects/7/dataset-preparations" && (!init || !init.method || init.method === "GET")) {
        return preparations;
      }
      if (path === "/projects/7/dataset-preparations" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({
          name: "New prep",
          description: "Demo",
          graph: { schema_version: 1, nodes: [], edges: [] },
        });
        return { id: 99, ...body, latest_version: 1, output_dataset_id: null, created_at: "2026-09-11" };
      }
      throw new Error(`Unexpected ${init?.method || "GET"} ${path}`);
    });

    renderPage();
    fireEvent.click(await screen.findByTestId("preparation-create-toggle"));
    fireEvent.change(screen.getByTestId("preparation-name"), { target: { value: "New prep" } });
    fireEvent.change(screen.getByTestId("preparation-description"), {
      target: { value: "Demo" },
    });
    fireEvent.click(screen.getByTestId("preparation-create"));
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/projects/7/preparations/99");
    });
  });

  it("hides create and delete for viewers", async () => {
    canWriteRef.value = false;
    renderPage();
    await screen.findByTestId("preparations-table");
    expect(screen.queryByTestId("preparation-create-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("preparation-delete-3")).not.toBeInTheDocument();
  });

  it("surfaces 409 when deleting a preparation with run history", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/projects/7/dataset-preparations" && (!init || !init.method || init.method === "GET")) {
        return preparations;
      }
      if (path === "/projects/7/dataset-preparations/3" && init?.method === "DELETE") {
        throw new ApiRequestError(409, "A preparation with run history cannot be deleted.");
      }
      throw new Error(`Unexpected ${init?.method || "GET"} ${path}`);
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("preparation-delete-3"));
    expect(
      await screen.findByText(/A preparation with run history cannot be deleted/),
    ).toBeInTheDocument();
  });
});

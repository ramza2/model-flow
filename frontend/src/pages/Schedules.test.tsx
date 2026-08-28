import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import Schedules from "./Schedules";

const apiMock = vi.fn(async (path: string) => {
  if (path.endsWith("/schedules")) return [];
  if (path.endsWith("/data-sources")) return [];
  if (path.endsWith("/datasets")) return [];
  if (path.endsWith("/endpoints")) return [];
  if (path.endsWith("/models")) return [];
  if (path.endsWith("/pipelines")) return [];
  return [];
});

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: (path: string, init?: RequestInit) => apiMock(path, init),
  };
});

vi.mock("../AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, is_system_admin: true, email: "a@b.c" } }),
}));

vi.mock("../ProjectContext", () => ({
  useProject: () => ({ selectedProject: { id: 7, role: "ML_ENGINEER" } }),
  userCanProject: () => true,
}));

describe("Schedules page", () => {
  it("renders empty state", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/7/schedules"]}>
        <Routes>
          <Route path="/projects/:projectId/schedules" element={<Schedules />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("No schedules yet")).toBeInTheDocument();
    expect(
      screen.getByText(/automate data imports, batch predictions, or pipeline runs/i),
    ).toBeInTheDocument();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UNSAVED_CHANGES_MESSAGE,
  confirmUnsavedNavigation,
  hasUnsavedChanges,
  setUnsavedChangesActive,
  shouldGuardAnchorNavigation,
} from "./unsavedChanges";

afterEach(() => {
  setUnsavedChangesActive(false);
});

describe("unsaved pipeline navigation guard", () => {
  it("does not prompt when there are no unsaved changes", () => {
    const confirm = vi.fn(() => false);
    expect(confirmUnsavedNavigation(confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("uses one consistent confirmation message when changes are active", () => {
    setUnsavedChangesActive(true);
    expect(hasUnsavedChanges()).toBe(true);
    const confirm = vi.fn(() => false);
    expect(confirmUnsavedNavigation(confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(UNSAVED_CHANGES_MESSAGE);
  });

  it("guards same-origin route changes but not in-page anchors or the builder back link", () => {
    setUnsavedChangesActive(true);
    const current = {
      origin: "https://modelflow.example",
      pathname: "/projects/5/pipelines/3",
      search: "",
    } as Pick<Location, "origin" | "pathname" | "search">;

    const route = document.createElement("a");
    route.href = "https://modelflow.example/projects/5/datasets";
    expect(shouldGuardAnchorNavigation(route, current)).toBe(true);

    const hash = document.createElement("a");
    hash.href = "https://modelflow.example/projects/5/pipelines/3#details";
    expect(shouldGuardAnchorNavigation(hash, current)).toBe(false);

    const back = document.createElement("a");
    back.href = "https://modelflow.example/projects/5/pipelines";
    back.className = "pipeline-back-link";
    expect(shouldGuardAnchorNavigation(back, current)).toBe(false);

    const external = document.createElement("a");
    external.href = "https://example.org/elsewhere";
    expect(shouldGuardAnchorNavigation(external, current)).toBe(false);
  });
});

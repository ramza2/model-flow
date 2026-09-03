import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState, ErrorNotice, Notice, StatusBadge } from "./components";

describe("shared status and notice presentation", () => {
  it("maps lifecycle and operational statuses to semantic tones with icon + text", () => {
    const { rerender } = render(<StatusBadge status="pending_approval" />);
    expect(screen.getByText("pending approval")).toBeInTheDocument();
    expect(document.querySelector(".badge.run")).toBeTruthy();

    rerender(<StatusBadge status="inactive" />);
    expect(document.querySelector(".badge.neutral")).toBeTruthy();

    rerender(<StatusBadge status="dispatched" />);
    expect(document.querySelector(".badge.run")).toBeTruthy();

    rerender(<StatusBadge status="archived" />);
    expect(document.querySelector(".badge.neutral")).toBeTruthy();

    rerender(<StatusBadge status="critical" />);
    expect(document.querySelector(".badge.err")).toBeTruthy();

    rerender(<StatusBadge status="reused" />);
    expect(document.querySelector(".badge.warn")).toBeTruthy();
  });

  it("renders notice variants with optional next-step action", () => {
    render(
      <Notice
        variant="warning"
        title="Pipeline validation failed"
        message="3 steps need configuration."
        action={<button type="button">View issues</button>}
      />,
    );
    expect(screen.getByText("Pipeline validation failed")).toBeInTheDocument();
    expect(screen.getByText("3 steps need configuration.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View issues" })).toBeInTheDocument();
  });

  it("keeps ErrorNotice alert semantics", () => {
    render(<ErrorNotice message="Dataset upload failed." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Dataset upload failed.");
  });

  it("supports empty-state next actions", () => {
    render(
      <EmptyState
        title="No datasets yet"
        description="Upload a CSV to start training."
        action={<button type="button">Upload dataset</button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "No datasets yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload dataset" })).toBeInTheDocument();
  });
});

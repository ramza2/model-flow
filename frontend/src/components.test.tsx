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

  it("keeps tone from status when an optional display label is provided", () => {
    const { rerender } = render(<StatusBadge status="FAIL" label="실패 (FAIL)" />);
    expect(screen.getByText("실패 (FAIL)")).toBeInTheDocument();
    expect(screen.queryByText("fail")).not.toBeInTheDocument();
    expect(document.querySelector(".badge.err")).toBeTruthy();

    rerender(<StatusBadge status="preparation" label="데이터 가공" />);
    expect(screen.getByText("데이터 가공")).toBeInTheDocument();
    expect(screen.queryByText("preparation")).not.toBeInTheDocument();

    rerender(<StatusBadge status="succeeded" />);
    expect(screen.getByText("succeeded")).toBeInTheDocument();
    expect(document.querySelector(".badge.ok")).toBeTruthy();
  });

  it("maps MLflow run statuses to semantic tones", () => {
    const { rerender } = render(<StatusBadge status="FINISHED" label="완료" />);
    expect(screen.getByText("완료")).toBeInTheDocument();
    expect(document.querySelector(".badge.ok")).toBeTruthy();

    rerender(<StatusBadge status="RUNNING" label="실행 중" />);
    expect(screen.getByText("실행 중")).toBeInTheDocument();
    expect(document.querySelector(".badge.run")).toBeTruthy();

    rerender(<StatusBadge status="FAILED" label="실패" />);
    expect(screen.getByText("실패")).toBeInTheDocument();
    expect(document.querySelector(".badge.err")).toBeTruthy();

    rerender(<StatusBadge status="KILLED" label="중지됨" />);
    expect(screen.getByText("중지됨")).toBeInTheDocument();
    expect(document.querySelector(".badge.neutral")).toBeTruthy();

    rerender(<StatusBadge status="SCHEDULED" label="대기 중" />);
    expect(screen.getByText("대기 중")).toBeInTheDocument();
    expect(document.querySelector(".badge.run")).toBeTruthy();

    rerender(<StatusBadge status="finished" />);
    expect(document.querySelector(".badge.ok")).toBeTruthy();
    rerender(<StatusBadge status="killed" />);
    expect(document.querySelector(".badge.neutral")).toBeTruthy();
    rerender(<StatusBadge status="scheduled" />);
    expect(document.querySelector(".badge.run")).toBeTruthy();
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

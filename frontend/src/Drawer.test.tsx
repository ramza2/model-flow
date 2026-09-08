import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Drawer } from "./Drawer";

function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("pipeline_run");
  return (
    <div>
      <button type="button" data-testid="open-trigger" onClick={() => setOpen(true)}>
        Create schedule
      </button>
      <Drawer
        open={open}
        title={open ? `Create schedule ${name.length}` : "Create schedule"}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        testId="schedule-drawer"
        footer={(
          <button type="button" data-testid="drawer-footer-submit">
            Save
          </button>
        )}
      >
        <label>
          Name
          <input
            data-drawer-initial-focus
            data-testid="drawer-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Target type
          <select
            data-testid="drawer-target"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="pipeline_run">Pipeline run</option>
            <option value="data_import">Data import</option>
          </select>
        </label>
      </Drawer>
    </div>
  );
}

describe("Drawer focus lifecycle", () => {
  it("keeps field focus across parent rerenders and restores trigger on close", async () => {
    render(<Harness />);
    const trigger = screen.getByTestId("open-trigger");
    trigger.focus();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    const name = await screen.findByTestId("drawer-name");
    await waitFor(() => expect(name).toHaveFocus());

    const target = screen.getByTestId("drawer-target");
    target.focus();
    expect(target).toHaveFocus();
    fireEvent.change(target, { target: { value: "data_import" } });
    expect(target).toHaveFocus();
    expect(name).not.toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("schedule-drawer")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("contains Tab and Shift+Tab within the dialog including footer controls", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("open-trigger"));
    const name = await screen.findByTestId("drawer-name");
    await waitFor(() => expect(name).toHaveFocus());

    const panel = screen.getByTestId("drawer-panel");
    const close = screen.getByTestId("drawer-close");
    const target = screen.getByTestId("drawer-target");
    const footer = screen.getByTestId("drawer-footer-submit");

    // Cycle forward from the last focusable back to the first.
    footer.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();

    // Cycle backward from the first focusable to the last.
    close.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(footer).toHaveFocus();

    // Backdrop is not part of the tab order.
    expect(screen.getByTestId("drawer-backdrop").tabIndex).toBeLessThan(0);
    expect(panel.contains(document.activeElement)).toBe(true);
    target.focus();
    expect(target).toHaveFocus();
  });
});

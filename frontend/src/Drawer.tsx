import {
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";

type DrawerProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: "default" | "large";
  testId?: string;
  footer?: ReactNode;
};

/**
 * Right-side overlay drawer for create/edit flows (e.g. Schedules).
 * Preserves focus restore and Escape-to-close without a heavy dialog library.
 */
export function Drawer({
  open,
  title,
  onClose,
  children,
  size = "large",
  testId,
  footer,
}: DrawerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const preferred = panel.querySelector<HTMLElement>("[data-drawer-initial-focus]");
      const fallback = panel.querySelector<HTMLElement>(
        'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (preferred ?? fallback)?.focus();
    });

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="drawer-root" data-testid={testId ?? "drawer"}>
      <button
        type="button"
        className="drawer-backdrop"
        aria-label="Close drawer"
        data-testid="drawer-backdrop"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className={`drawer-panel drawer-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="drawer-panel"
      >
        <div className="drawer-header">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="btn secondary drawer-close"
            aria-label="Close"
            data-testid="drawer-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

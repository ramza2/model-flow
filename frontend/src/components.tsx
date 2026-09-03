import type { ButtonHTMLAttributes, ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-copy">
        <h1>{title}</h1>
        {description && <p className="lead">{description}</p>}
      </div>
      {actions && <div className="row-actions page-header-actions">{actions}</div>}
    </header>
  );
}

type NoticeVariant = "info" | "success" | "warning" | "error";

export function Notice({
  variant = "info",
  title,
  message,
  action,
  role,
}: {
  variant?: NoticeVariant;
  title?: string;
  message?: string;
  action?: ReactNode;
  role?: "alert" | "status";
}) {
  if (!message && !title) return null;
  const resolvedRole = role ?? (variant === "error" ? "alert" : "status");
  const legacyClass = variant === "error" ? " error" : variant === "success" ? " success" : "";
  return (
    <div className={`notice notice-${variant}${legacyClass}`} role={resolvedRole}>
      <div className="notice-body">
        {title && <strong className="notice-title">{title}</strong>}
        {message && <p className="notice-message">{message}</p>}
      </div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}

export function ErrorNotice({ message }: { message?: string }) {
  if (!message) return null;
  return <Notice variant="error" message={message} role="alert" />;
}

export function SuccessNotice({ message }: { message?: string }) {
  if (!message) return null;
  return <Notice variant="success" message={message} />;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true">◇</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

type StatusTone = "neutral" | "progress" | "success" | "warning" | "negative";

const statusCatalog: Record<StatusTone, { values: Set<string>; icon: string; className: string }> = {
  success: {
    className: "ok",
    icon: "✓",
    values: new Set([
      "ok",
      "ready",
      "healthy",
      "active",
      "succeeded",
      "pass",
      "passed",
      "approved",
      "production",
      "published",
    ]),
  },
  negative: {
    className: "err",
    icon: "!",
    values: new Set([
      "error",
      "failed",
      "fail",
      "rejected",
      "cancelled",
      "unhealthy",
      "blocked",
      "critical",
    ]),
  },
  progress: {
    className: "run",
    icon: "◷",
    values: new Set([
      "pending",
      "queued",
      "dispatched",
      "running",
      "candidate",
      "validating",
      "pending_approval",
      "cancel_requested",
      "waiting",
    ]),
  },
  warning: {
    className: "warn",
    icon: "▲",
    values: new Set([
      "warning",
      "warn",
      "partial",
      "degraded",
      "attention",
      "skipped",
      "reused",
    ]),
  },
  neutral: {
    className: "neutral",
    icon: "•",
    values: new Set([
      "draft",
      "stopped",
      "archived",
      "unknown",
      "inactive",
    ]),
  },
};

function resolveStatusTone(value: string): StatusTone {
  for (const tone of ["success", "negative", "progress", "warning", "neutral"] as const) {
    if (statusCatalog[tone].values.has(value)) {
      return tone;
    }
  }
  return "warning";
}

export function StatusBadge({ status }: { status?: string | null }) {
  const raw = status || "unknown";
  const value = raw.toLowerCase();
  const tone = resolveStatusTone(value);
  const { className, icon } = statusCatalog[tone];
  const label = value.replaceAll("_", " ");
  return (
    <span className={`badge ${className}`} title={label}>
      <span aria-hidden="true">{icon}</span>
      <span className="badge-label">{label}</span>
    </span>
  );
}

type ButtonVariant = "primary" | "secondary" | "tertiary" | "danger" | "icon";

export function Button({
  variant = "primary",
  loading = false,
  className = "",
  children,
  disabled,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
}) {
  const variantClass =
    variant === "primary"
      ? "btn"
      : variant === "secondary"
        ? "btn secondary"
        : variant === "tertiary"
          ? "btn link"
          : variant === "danger"
            ? "btn danger"
            : "btn icon-btn";
  return (
    <button
      type={type}
      className={`${variantClass}${loading ? " is-loading" : ""}${className ? ` ${className}` : ""}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <span className="btn-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function formatDate(value?: string | number | null) {
  if (!value) return "—";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function metric(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined ? "—" : Number(value).toFixed(digits);
}

export function confirmAction(message: string) {
  return window.confirm(message);
}

import type { ReactNode } from "react";

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
      <div>
        <h1>{title}</h1>
        {description && <p className="lead">{description}</p>}
      </div>
      {actions && <div className="row-actions">{actions}</div>}
    </header>
  );
}

export function ErrorNotice({ message }: { message?: string }) {
  if (!message) return null;
  return <div className="error" role="alert">{message}</div>;
}

export function SuccessNotice({ message }: { message?: string }) {
  if (!message) return null;
  return <div className="success" role="status">✓ {message}</div>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
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

const positive = new Set([
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
]);
const negative = new Set([
  "error",
  "failed",
  "fail",
  "rejected",
  "cancelled",
  "inactive",
  "unhealthy",
]);
const progress = new Set([
  "pending",
  "queued",
  "running",
  "candidate",
  "validating",
  "pending_approval",
  "cancel_requested",
]);

export function StatusBadge({ status }: { status?: string | null }) {
  const value = (status || "unknown").toLowerCase();
  const className = positive.has(value)
    ? "ok"
    : negative.has(value)
      ? "err"
      : progress.has(value)
        ? "run"
        : "warn";
  const icon = positive.has(value) ? "✓" : negative.has(value) ? "!" : progress.has(value) ? "◷" : "•";
  return (
    <span className={`badge ${className}`}>
      <span aria-hidden="true">{icon}</span>
      {value.replaceAll("_", " ")}
    </span>
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

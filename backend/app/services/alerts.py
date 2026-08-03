from __future__ import annotations

from sqlalchemy.orm import Session

from app.db.models import Alert, AlertSeverity


def create_alert(
    db: Session,
    *,
    alert_type: str,
    title: str,
    project_id: int | None = None,
    severity: AlertSeverity | str = AlertSeverity.info,
    message: str = "",
    resource_type: str | None = None,
    resource_id: str | int | None = None,
    link_path: str | None = None,
    assignee_id: int | None = None,
) -> Alert:
    if isinstance(severity, str):
        try:
            severity = AlertSeverity(severity.lower())
        except ValueError as exc:
            choices = ", ".join(item.value for item in AlertSeverity)
            raise ValueError(f"Unknown alert severity '{severity}'; expected one of: {choices}") from exc

    alert = Alert(
        project_id=project_id,
        alert_type=alert_type,
        severity=severity,
        title=title,
        message=message,
        resource_type=resource_type,
        resource_id=str(resource_id) if resource_id is not None else None,
        link_path=link_path,
        assignee_id=assignee_id,
    )
    db.add(alert)
    db.flush()
    return alert

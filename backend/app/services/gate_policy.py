from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.audit import write_audit
from app.db.models import ModelGatePolicy

FORBIDDEN_METADATA_KEYS = frozenset(
    {
        "gates",
        "test_instance",
        "metric_threshold",
        "max_inference_latency_ms",
    }
)

FORBIDDEN_PIPELINE_GATE_KEYS = frozenset(
    {
        "gates",
        "test_instance",
        "metric_threshold",
        "max_inference_latency_ms",
        "metric_minimum",
        "metric_maximum",
        "metric",
    }
)


def sanitize_registration_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    """Reject client-supplied gate policy controls in registration metadata."""
    data = dict(metadata or {})
    banned = sorted(FORBIDDEN_METADATA_KEYS.intersection(data))
    if banned:
        raise ValueError(
            "Metadata must not include gate policy controls: "
            + ", ".join(banned)
            + ". Configure ModelGatePolicy instead."
        )
    return data


def policy_out(row: ModelGatePolicy) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "name": row.name,
        "version": row.version,
        "is_active": row.is_active,
        "metric_name": row.metric_name,
        "metric_minimum": row.metric_minimum,
        "metric_maximum": row.metric_maximum,
        "max_inference_latency_ms": row.max_inference_latency_ms,
        "require_artifact": row.require_artifact,
        "require_schema": row.require_schema,
        "require_model_load": row.require_model_load,
        "require_test_inference": row.require_test_inference,
        "require_mlflow_project": row.require_mlflow_project,
        "created_by": row.created_by,
        "updated_by": row.updated_by,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def ensure_default_gate_policy(
    db: Session, project_id: int, *, actor_id: int | None = None
) -> ModelGatePolicy:
    existing = db.scalar(
        select(ModelGatePolicy)
        .where(
            ModelGatePolicy.project_id == project_id,
            ModelGatePolicy.is_active.is_(True),
        )
        .order_by(ModelGatePolicy.id.asc())
    )
    if existing:
        return existing
    policy = ModelGatePolicy(
        project_id=project_id,
        name="default",
        version=1,
        is_active=True,
        metric_name=None,
        metric_minimum=None,
        metric_maximum=None,
        max_inference_latency_ms=5000.0,
        require_artifact=True,
        require_schema=True,
        require_model_load=True,
        require_test_inference=True,
        require_mlflow_project=True,
        created_by=actor_id,
        updated_by=actor_id,
    )
    db.add(policy)
    db.flush()
    write_audit(
        db,
        action="gate_policy.create",
        resource_type="model_gate_policy",
        resource_id=policy.id,
        user_id=actor_id,
        after=policy_out(policy),
    )
    return policy


def get_active_gate_policy(db: Session, project_id: int) -> ModelGatePolicy:
    policy = db.scalar(
        select(ModelGatePolicy)
        .where(
            ModelGatePolicy.project_id == project_id,
            ModelGatePolicy.is_active.is_(True),
        )
        .order_by(ModelGatePolicy.version.desc(), ModelGatePolicy.id.desc())
    )
    if policy is None:
        return ensure_default_gate_policy(db, project_id)
    return policy


def get_gate_policy_for_project(
    db: Session, project_id: int, policy_id: int
) -> ModelGatePolicy:
    policy = db.get(ModelGatePolicy, policy_id)
    if policy is None or policy.project_id != project_id:
        raise ValueError("Gate policy was not found in this project.")
    return policy


def list_gate_policies(db: Session, project_id: int) -> list[ModelGatePolicy]:
    return list(
        db.scalars(
            select(ModelGatePolicy)
            .where(ModelGatePolicy.project_id == project_id)
            .order_by(ModelGatePolicy.name.asc(), ModelGatePolicy.version.desc())
        ).all()
    )


def update_active_gate_policy(
    db: Session,
    project_id: int,
    updates: dict[str, Any],
    *,
    actor_id: int | None = None,
) -> ModelGatePolicy:
    """Create a new version of the active policy and mark it active."""
    current = get_active_gate_policy(db, project_id)
    before = policy_out(current)
    db.execute(
        update(ModelGatePolicy)
        .where(
            ModelGatePolicy.project_id == project_id,
            ModelGatePolicy.is_active.is_(True),
        )
        .values(is_active=False, updated_at=datetime.now(timezone.utc))
    )
    allowed = {
        "metric_name",
        "metric_minimum",
        "metric_maximum",
        "max_inference_latency_ms",
        "require_artifact",
        "require_schema",
        "require_model_load",
        "require_test_inference",
        "require_mlflow_project",
        "name",
    }
    payload = {key: updates[key] for key in allowed if key in updates}
    next_version = int(current.version) + 1
    policy = ModelGatePolicy(
        project_id=project_id,
        name=str(payload.get("name") or current.name),
        version=next_version,
        is_active=True,
        metric_name=payload.get("metric_name", current.metric_name),
        metric_minimum=payload.get("metric_minimum", current.metric_minimum),
        metric_maximum=payload.get("metric_maximum", current.metric_maximum),
        max_inference_latency_ms=float(
            payload.get("max_inference_latency_ms", current.max_inference_latency_ms)
        ),
        require_artifact=bool(payload.get("require_artifact", current.require_artifact)),
        require_schema=bool(payload.get("require_schema", current.require_schema)),
        require_model_load=bool(
            payload.get("require_model_load", current.require_model_load)
        ),
        require_test_inference=bool(
            payload.get("require_test_inference", current.require_test_inference)
        ),
        require_mlflow_project=bool(
            payload.get("require_mlflow_project", current.require_mlflow_project)
        ),
        created_by=current.created_by,
        updated_by=actor_id,
    )
    db.add(policy)
    db.flush()
    write_audit(
        db,
        action="gate_policy.update",
        resource_type="model_gate_policy",
        resource_id=policy.id,
        user_id=actor_id,
        before=before,
        after=policy_out(policy),
    )
    return policy


def policy_to_config(policy: ModelGatePolicy) -> dict[str, Any]:
    metric: dict[str, Any] = {}
    if policy.metric_name:
        metric["name"] = policy.metric_name
    if policy.metric_minimum is not None:
        metric["minimum"] = policy.metric_minimum
    if policy.metric_maximum is not None:
        metric["maximum"] = policy.metric_maximum
    return {
        "metric": metric,
        "max_inference_latency_ms": policy.max_inference_latency_ms,
        "require_artifact": policy.require_artifact,
        "require_schema": policy.require_schema,
        "require_model_load": policy.require_model_load,
        "require_test_inference": policy.require_test_inference,
        "require_mlflow_project": policy.require_mlflow_project,
        "policy_id": policy.id,
        "policy_version": policy.version,
        "policy_name": policy.name,
    }


def assert_pipeline_node_gate_config(
    project_id: int, node_type: str, config: dict[str, Any], db: Session
) -> None:
    """Reject pipeline node configs that try to override gate criteria."""
    if node_type not in {"approval_request", "model_registration"}:
        return
    banned = sorted(FORBIDDEN_PIPELINE_GATE_KEYS.intersection(config))
    if banned:
        raise ValueError(
            f"Pipeline node '{node_type}' must not set gate criteria fields: "
            + ", ".join(banned)
            + ". Use gate_policy_id from this project."
        )
    policy_id = config.get("gate_policy_id")
    if policy_id is None:
        return
    get_gate_policy_for_project(db, project_id, int(policy_id))

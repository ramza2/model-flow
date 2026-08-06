from __future__ import annotations

import json
from enum import Enum
from typing import Any, TypeVar

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.audit import write_audit
from app.core.deps import AuthContext
from app.db.models import (
    BatchInferenceJob,
    DataImportJob,
    DataSource,
    Dataset,
    DatasetSplit,
    DatasetVersion,
    DriftRun,
    Endpoint,
    ModelVersion,
    Pipeline,
    PipelineRun,
    PipelineVersion,
    Project,
    ProjectMembership,
    QualityCheck,
    QualityRule,
    RetrainTrigger,
    TrainingJob,
    User,
)

T = TypeVar("T")


def friendly(status_code: int, detail: str, hint: str | None = None) -> HTTPException:
    return HTTPException(
        status_code=status_code, detail={"detail": detail, "hint": hint}
    )


def loads(value: str | None, default: T) -> T:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def dumps(value: Any) -> str:
    return json.dumps(value, default=str, separators=(",", ":"))


def enum_value(value: Any) -> Any:
    return value.value if isinstance(value, Enum) else value


def get_project_row(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if not project or project.deleted_at is not None:
        raise friendly(
            404, f"Project {project_id} was not found.", "Check the project list."
        )
    return project


def get_owned(
    db: Session, model: type[T], row_id: int, project_id: int, label: str
) -> T:
    row = db.get(model, row_id)
    if not row or getattr(row, "project_id", None) != project_id:
        raise friendly(404, f"{label} {row_id} was not found in this project.")
    return row


def audit_event(
    db: Session,
    auth: AuthContext,
    action: str,
    resource_type: str,
    resource_id: int | str | None = None,
    *,
    before: Any = None,
    after: Any = None,
    success: bool = True,
    failure_reason: str | None = None,
) -> None:
    write_audit(
        db,
        action=action,
        resource_type=resource_type,
        resource_id=str(resource_id) if resource_id is not None else None,
        user_id=auth.user.id,
        user_email=auth.user.email,
        success=success,
        ip_address=auth.ip,
        request_id=auth.request_id,
        before=before,
        after=after,
        failure_reason=failure_reason,
    )


def user_out(row: User) -> dict[str, Any]:
    return {
        "id": row.id,
        "email": row.email,
        "full_name": row.full_name,
        "is_active": row.is_active,
        "is_system_admin": row.is_system_admin,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def project_out(row: Project, role: Any = None) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "is_active": row.is_active,
        "created_by": row.created_by,
        "role": enum_value(role) if role is not None else None,
        "created_at": row.created_at,
    }


def membership_out(row: ProjectMembership) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "user_id": row.user_id,
        "email": row.user.email if row.user else None,
        "full_name": row.user.full_name if row.user else None,
        "role": enum_value(row.role),
        "created_at": row.created_at,
    }


def data_source_out(row: DataSource) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "name": row.name,
        "source_type": enum_value(row.source_type),
        "config": loads(row.config_json, {}),
        "has_secrets": bool(row.secret_encrypted),
        "is_active": row.is_active,
        "last_test_status": row.last_test_status,
        "last_test_message": row.last_test_message,
        "last_tested_at": row.last_tested_at,
        "created_by": row.created_by,
        "created_at": row.created_at,
    }


def import_job_out(row: DataImportJob) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "data_source_id": row.data_source_id,
        "dataset_id": row.dataset_id,
        "dataset_version_id": row.dataset_version_id,
        "table_or_query": row.query_or_table,
        "status": enum_value(row.status),
        "error_message": row.error_message,
        "created_by": row.created_by,
        "created_at": row.created_at,
        "finished_at": row.finished_at,
    }


def dataset_out(row: Dataset) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "name": row.name,
        "description": row.description,
        "latest_version": row.latest_version,
        "object_key": row.object_key,
        "row_count": row.row_count,
        "column_count": row.column_count,
        "columns": loads(row.columns_json, []),
        "stats": loads(row.stats_json, {}),
        "created_by": row.created_by,
        "created_at": row.created_at,
    }


def dataset_version_out(
    row: DatasetVersion, include_preview: bool = False
) -> dict[str, Any]:
    result = {
        "id": row.id,
        "dataset_id": row.dataset_id,
        "project_id": row.project_id,
        "version": row.version,
        "object_key": row.object_key,
        "original_filename": row.original_filename,
        "format": row.format,
        "row_count": row.row_count,
        "column_count": row.column_count,
        "columns": loads(row.columns_json, []),
        "dtypes": loads(row.dtypes_json, {}),
        "stats": loads(row.stats_json, {}),
        "source_type": row.source_type,
        "data_source_id": row.data_source_id,
        "import_job_id": row.import_job_id,
        "created_by": row.created_by,
        "created_at": row.created_at,
    }
    if include_preview:
        result["preview"] = loads(row.preview_json, [])
    return result


def quality_rule_out(row: QualityRule) -> dict[str, Any]:
    dataset = getattr(row, "dataset", None)
    return {
        "id": row.id,
        "project_id": row.project_id,
        "dataset_id": row.dataset_id,
        "dataset_name": dataset.name if dataset is not None else None,
        "name": row.name,
        "rules": loads(row.rules_json, []),
        "block_training_on_fail": row.block_training_on_fail,
        "is_active": row.is_active,
        "created_at": row.created_at,
    }


def quality_check_out(row: QualityCheck) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "dataset_version_id": row.dataset_version_id,
        "quality_rule_id": row.quality_rule_id,
        "result": enum_value(row.result),
        "details": loads(row.details_json, []),
        "created_by": row.created_by,
        "created_at": row.created_at,
    }


def split_out(row: DatasetSplit) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "dataset_version_id": row.dataset_version_id,
        "name": row.name,
        "train_ratio": row.train_ratio,
        "val_ratio": row.val_ratio,
        "test_ratio": row.test_ratio,
        "random_seed": row.random_seed,
        "object_keys": {
            "train": row.train_object_key,
            "validation": row.val_object_key,
            "test": row.test_object_key,
        },
        "created_at": row.created_at,
    }


def job_out(row: TrainingJob) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "dataset_id": row.dataset_id,
        "dataset_version_id": row.dataset_version_id,
        "split_id": row.split_id,
        "name": row.name,
        "description": row.description,
        "target_column": row.target_column,
        "problem_type": row.problem_type,
        "algorithm": row.algorithm,
        "hyperparameters": loads(row.hyperparameters_json, {}),
        "preprocessing": loads(row.preprocessing_json, {}),
        "feature_columns": loads(row.feature_columns_json, []),
        "metrics_config": loads(row.metrics_config_json, []),
        "resources": loads(row.resource_json, {}),
        "random_seed": row.random_seed,
        "ratios": {
            "train": row.train_ratio,
            "validation": row.val_ratio,
            "test": row.test_ratio,
        },
        "status": enum_value(row.status),
        "logs": row.logs or "",
        "mlflow_run_id": row.mlflow_run_id,
        "model_uri": row.model_uri,
        "metrics": loads(row.metrics_json, {}),
        "error_message": row.error_message,
        "retry_count": row.retry_count,
        "max_retries": row.max_retries,
        "created_by": row.created_by,
        "parent_job_id": row.parent_job_id,
        "created_at": row.created_at,
        "started_at": row.started_at,
        "finished_at": row.finished_at,
    }


def pipeline_out(row: Pipeline) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "name": row.name,
        "description": row.description,
        "status": enum_value(row.status),
        "latest_version": row.latest_version,
        "is_template": row.is_template,
        "created_by": row.created_by,
        "created_at": row.created_at,
    }


def pipeline_version_out(row: PipelineVersion) -> dict[str, Any]:
    return {
        "id": row.id,
        "pipeline_id": row.pipeline_id,
        "project_id": row.project_id,
        "version": row.version,
        "graph": loads(row.graph_json, {}),
        "created_by": row.created_by,
        "created_at": row.created_at,
    }


def pipeline_run_out(row: PipelineRun) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "pipeline_id": row.pipeline_id,
        "pipeline_version_id": row.pipeline_version_id,
        "status": enum_value(row.status),
        "parameters": loads(row.parameters_json, {}),
        "node_states": loads(row.node_states_json, {}),
        "node_artifacts": loads(row.node_artifacts_json, {}),
        "logs": row.logs or "",
        "error_message": row.error_message,
        "fail_policy": row.fail_policy,
        "scheduled_for": row.scheduled_for,
        "created_by": row.created_by,
        "created_at": row.created_at,
        "started_at": row.started_at,
        "finished_at": row.finished_at,
    }


def model_version_out(row: ModelVersion) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "name": row.name,
        "version": row.version,
        "lifecycle": enum_value(row.lifecycle),
        "mlflow_model_name": row.mlflow_model_name,
        "mlflow_version": row.mlflow_version,
        "mlflow_run_id": row.mlflow_run_id,
        "model_uri": row.model_uri,
        "metrics": loads(row.metrics_json, {}),
        "metadata": loads(row.metadata_json, {}),
        "dataset_version_id": row.dataset_version_id,
        "training_job_id": row.training_job_id,
        "pipeline_run_id": row.pipeline_run_id,
        "gate_policy_id": row.gate_policy_id,
        "gate_results": loads(row.gate_results_json, {}),
        "gates_passed": row.gates_passed,
        "approval_comment": row.approval_comment,
        "approved_by": row.approved_by,
        "approved_at": row.approved_at,
        "created_by": row.created_by,
        "created_at": row.created_at,
    }


def endpoint_out(row: Endpoint) -> dict[str, Any]:
    count = row.request_count or 0
    return {
        "id": row.id,
        "project_id": row.project_id,
        "name": row.name,
        "model_name": row.model_name,
        "model_version": row.model_version,
        "model_version_id": row.model_version_id,
        "model_uri": row.model_uri,
        "status": row.status,
        "request_count": count,
        "success_count": row.success_count or 0,
        "error_count": row.error_count or 0,
        "success_rate": (row.success_count or 0) / count if count else None,
        "average_latency_ms": (row.latency_sum_ms or 0.0) / count if count else None,
        "latency_p95_ms": row.latency_p95_ms or 0.0,
        "feature_schema": loads(row.feature_schema_json, []),
        "recent_errors": loads(row.recent_errors_json, []),
        "created_by": row.created_by,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def batch_out(row: BatchInferenceJob) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "dataset_version_id": row.dataset_version_id,
        "endpoint_id": row.endpoint_id,
        "model_version_id": row.model_version_id,
        "status": enum_value(row.status),
        "result_object_key": row.result_object_key,
        "result_format": row.result_format,
        "error_message": row.error_message,
        "failure_details": loads(row.failure_details_json, []),
        "row_count": row.row_count,
        "created_by": row.created_by,
        "created_at": row.created_at,
        "finished_at": row.finished_at,
    }


def drift_out(row: DriftRun) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "reference_version_id": row.reference_version_id,
        "current_version_id": row.current_version_id,
        "endpoint_id": row.endpoint_id,
        "status": enum_value(row.status),
        "overall_status": row.overall_status,
        "results": loads(row.results_json, {}),
        "thresholds": loads(row.thresholds_json, {}),
        "error_message": row.error_message,
        "created_by": row.created_by,
        "created_at": row.created_at,
        "finished_at": row.finished_at,
    }


def retrain_out(row: RetrainTrigger) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "trigger_type": row.trigger_type,
        "config": loads(row.config_json, {}),
        "last_triggered_at": row.last_triggered_at,
        "created_training_job_id": row.created_training_job_id,
        "created_at": row.created_at,
    }


def validate_graph(graph: dict[str, Any]) -> list[str]:
    """Compatibility wrapper — prefer pipeline_engine.validate_graph."""
    from app.services.pipeline_engine import validate_graph as engine_validate

    return list(engine_validate(graph).get("errors") or [])

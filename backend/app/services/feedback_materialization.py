"""Feedback → immutable DatasetVersion materialization (Phase 5-B)."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import write_audit
from app.core.config import settings
from app.core.security import safe_filename
from app.db.models import (
    AlertSeverity,
    Dataset,
    DatasetVersion,
    Endpoint,
    FeedbackMaterializationRun,
    FeedbackReviewStatus,
    GroundTruthFeedback,
    JobStatus,
    ModelVersion,
    PredictionObservation,
    TrainingJob,
)
from app.schemas.v1 import JobRetrainRequest
from app.services import datasets, storage
from app.services.alerts import create_alert
from app.services.dataset_preparation_materialization import (
    serialize_frame_to_parquet_bytes,
)
from app.services import model_quality as quality_service
from app.services.retrain_service import RetrainConfigError, prepare_retrain_job
from app.services.target_columns import effective_target_columns_from_job
from app.services.training_validation import TrainingConfigError
from app.services.closed_loop import find_newer_compatible_dataset_version


class FeedbackMaterializationError(Exception):
    def __init__(self, status_code: int, message: str, detail: str | None = None):
        self.status_code = status_code
        self.message = message
        self.detail = detail
        super().__init__(message)


def _loads(value: str | None, default: Any = None) -> Any:
    if default is None:
        default = {}
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def _dumps(value: Any) -> str:
    return json.dumps(value, default=str)


def run_out(run: FeedbackMaterializationRun) -> dict[str, Any]:
    return {
        "id": run.id,
        "project_id": run.project_id,
        "endpoint_id": run.endpoint_id,
        "source_model_version_id": run.source_model_version_id,
        "source_training_job_id": run.source_training_job_id,
        "dataset_id": run.dataset_id,
        "base_dataset_version_id": run.base_dataset_version_id,
        "output_dataset_version_id": run.output_dataset_version_id,
        "status": run.status.value if hasattr(run.status, "value") else str(run.status),
        "feedback_count": run.feedback_count,
        "feedback_ids": _loads(run.feedback_ids_json, []),
        "row_count_before": run.row_count_before,
        "row_count_added": run.row_count_added,
        "row_count_after": run.row_count_after,
        "error_message": run.error_message,
        "created_by": run.created_by,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }


def resolve_feature_columns(
    job: TrainingJob, base_version: DatasetVersion, target_columns: list[str]
) -> list[str]:
    features = _loads(job.feature_columns_json, [])
    if isinstance(features, list) and features:
        return [str(c) for c in features]
    columns = _loads(base_version.columns_json, [])
    if not isinstance(columns, list):
        columns = []
    selected = [str(c) for c in columns if str(c) not in set(target_columns)]
    if not selected:
        raise FeedbackMaterializationError(
            422, "Could not resolve feature columns for materialization."
        )
    return selected


def select_latest_compatible_base(
    db: Session, *, project_id: int, source_job: TrainingJob
) -> DatasetVersion:
    """Pin the latest DatasetVersion compatible with source TrainingJob.

    Prefer newer versions on the same logical Dataset when still retrain-compatible.
    Always at least the source TrainingJob DatasetVersion.
    """
    if source_job.dataset_version_id is None or source_job.dataset_id is None:
        raise FeedbackMaterializationError(
            422, "Source training job is missing dataset version lineage."
        )
    source_version = db.get(DatasetVersion, source_job.dataset_version_id)
    if source_version is None or source_version.project_id != project_id:
        raise FeedbackMaterializationError(
            422, "Source dataset version was not found."
        )

    newer, _reason = find_newer_compatible_dataset_version(
        db, project_id=project_id, source_job=source_job
    )
    if newer is not None:
        return newer

    # Validate source itself is still usable as base.
    try:
        prepare_retrain_job(
            db,
            project_id,
            source_job,
            JobRetrainRequest(
                dataset_version_id=source_version.id,
                name=f"{source_job.name} (feedback materialization base check)",
            ),
        )
    except (RetrainConfigError, TrainingConfigError) as exc:
        raise FeedbackMaterializationError(
            422,
            "Source dataset version is not compatible for feedback materialization.",
            getattr(exc, "detail", str(exc)),
        ) from exc
    return source_version


def build_training_row(
    *,
    observation: PredictionObservation,
    feedback: GroundTruthFeedback,
    feature_columns: list[str],
    target_columns: list[str],
    base_columns: list[str],
    problem_type: str,
) -> dict[str, Any]:
    features = _loads(observation.input_json, None)
    if not isinstance(features, dict):
        raise FeedbackMaterializationError(
            422,
            f"Feedback #{feedback.id} is missing a valid input feature snapshot.",
        )
    missing = [col for col in feature_columns if col not in features]
    if missing:
        raise FeedbackMaterializationError(
            422,
            f"Feedback #{feedback.id} is missing required features: {', '.join(missing)}.",
        )

    actual = quality_service.normalize_actual(
        _loads(feedback.actual_json, None),
        target_columns=target_columns,
        problem_type=problem_type,
    )
    row: dict[str, Any] = {col: None for col in base_columns}
    for col in feature_columns:
        if col in row:
            row[col] = features[col]
    if len(target_columns) == 1:
        target = target_columns[0]
        if target in row:
            row[target] = actual
    else:
        if not isinstance(actual, dict):
            raise FeedbackMaterializationError(
                422, f"Feedback #{feedback.id} multi-output actual must be an object."
            )
        for col in target_columns:
            if col in row:
                row[col] = actual[col]
    return row


def create_materialization_run(
    db: Session,
    *,
    project_id: int,
    endpoint_id: int,
    feedback_ids: list[int],
    created_by: int | None,
) -> FeedbackMaterializationRun:
    if not feedback_ids:
        raise FeedbackMaterializationError(422, "feedback_ids must not be empty.")
    if len(feedback_ids) != len(set(feedback_ids)):
        raise FeedbackMaterializationError(422, "feedback_ids must be unique.")

    endpoint = db.get(Endpoint, endpoint_id)
    if endpoint is None or endpoint.project_id != project_id:
        raise FeedbackMaterializationError(404, "Endpoint was not found.")
    if not endpoint.model_version_id:
        raise FeedbackMaterializationError(
            422, "Endpoint has no deployed model version."
        )
    model = db.get(ModelVersion, endpoint.model_version_id)
    ready, reason, source_job = quality_service.production_model_ready_for_retrain(
        db, model
    )
    if not ready or source_job is None or model is None:
        raise FeedbackMaterializationError(
            422,
            "Endpoint model is not ready for feedback materialization.",
            reason,
        )

    base_version = select_latest_compatible_base(
        db, project_id=project_id, source_job=source_job
    )
    dataset = db.get(Dataset, source_job.dataset_id)
    if dataset is None or dataset.project_id != project_id:
        raise FeedbackMaterializationError(422, "Source dataset was not found.")

    # Lock selected feedback rows for reservation.
    locked = list(
        db.scalars(
            select(GroundTruthFeedback)
            .where(
                GroundTruthFeedback.project_id == project_id,
                GroundTruthFeedback.id.in_(feedback_ids),
            )
            .order_by(GroundTruthFeedback.id.asc())
            .with_for_update()
        ).all()
    )
    if len(locked) != len(feedback_ids):
        found = {row.id for row in locked}
        missing = [fid for fid in feedback_ids if fid not in found]
        raise FeedbackMaterializationError(
            404, f"Feedback not found: {', '.join(str(x) for x in missing)}."
        )

    for feedback in locked:
        if feedback.review_status != FeedbackReviewStatus.APPROVED.value:
            raise FeedbackMaterializationError(
                422,
                f"Feedback #{feedback.id} must be APPROVED before materialization.",
            )
        if feedback.materialized_dataset_version_id is not None:
            raise FeedbackMaterializationError(
                409,
                f"Feedback #{feedback.id} was already materialized.",
            )
        if feedback.materialization_run_id is not None:
            raise FeedbackMaterializationError(
                409,
                f"Feedback #{feedback.id} is already reserved by another materialization run.",
            )
        observation = db.get(PredictionObservation, feedback.prediction_observation_id)
        if observation is None:
            raise FeedbackMaterializationError(
                422, f"Feedback #{feedback.id} observation was not found."
            )
        if observation.endpoint_id != endpoint.id:
            raise FeedbackMaterializationError(
                422,
                f"Feedback #{feedback.id} does not belong to the selected endpoint.",
            )
        if observation.model_version_id != model.id:
            raise FeedbackMaterializationError(
                422,
                f"Feedback #{feedback.id} does not belong to the current production model.",
            )
        if not observation.input_json:
            raise FeedbackMaterializationError(
                422,
                f"Feedback #{feedback.id} is not materializable (input snapshot unavailable).",
            )

    run = FeedbackMaterializationRun(
        project_id=project_id,
        endpoint_id=endpoint.id,
        source_model_version_id=model.id,
        source_training_job_id=source_job.id,
        dataset_id=dataset.id,
        base_dataset_version_id=base_version.id,
        status=JobStatus.pending,
        feedback_count=len(feedback_ids),
        feedback_ids_json=_dumps(list(feedback_ids)),
        created_by=created_by,
    )
    db.add(run)
    db.flush()

    for feedback in locked:
        feedback.materialization_run_id = run.id

    write_audit(
        db,
        action="feedback_materialization.create",
        resource_type="feedback_materialization_run",
        resource_id=run.id,
        user_id=created_by,
        after=run_out(run),
    )
    db.flush()
    return run


def release_reservation(db: Session, run: FeedbackMaterializationRun) -> None:
    """Clear reservation for a failed run that never produced an output version."""
    if run.output_dataset_version_id is not None:
        return
    rows = db.scalars(
        select(GroundTruthFeedback).where(
            GroundTruthFeedback.materialization_run_id == run.id,
            GroundTruthFeedback.materialized_dataset_version_id.is_(None),
        )
    ).all()
    for row in rows:
        row.materialization_run_id = None
    db.flush()


def execute_materialization_run(
    db: Session, run: FeedbackMaterializationRun
) -> FeedbackMaterializationRun:
    """Execute a claimed (running) materialization. Raises on failure."""
    if run.status == JobStatus.succeeded and run.output_dataset_version_id:
        return run

    write_audit(
        db,
        action="feedback_materialization.start",
        resource_type="feedback_materialization_run",
        resource_id=run.id,
        after={"status": run.status.value},
    )

    feedback_ids = _loads(run.feedback_ids_json, [])
    if not isinstance(feedback_ids, list) or not feedback_ids:
        raise ValueError("Materialization run has no feedback_ids snapshot.")

    source_job = db.get(TrainingJob, run.source_training_job_id)
    base_version = db.get(DatasetVersion, run.base_dataset_version_id)
    dataset = db.get(Dataset, run.dataset_id)
    model = db.get(ModelVersion, run.source_model_version_id)
    if source_job is None or base_version is None or dataset is None or model is None:
        raise ValueError("Materialization run lineage was not found.")
    if base_version.dataset_id != dataset.id:
        raise ValueError("Pinned base dataset version does not belong to the dataset.")

    target_columns = effective_target_columns_from_job(source_job)
    feature_columns = resolve_feature_columns(source_job, base_version, target_columns)
    problem_type = str(source_job.problem_type or "classification").lower()
    base_columns = _loads(base_version.columns_json, [])
    if not isinstance(base_columns, list) or not base_columns:
        base_columns = list(feature_columns) + list(target_columns)

    feedback_rows = list(
        db.scalars(
            select(GroundTruthFeedback)
            .where(
                GroundTruthFeedback.project_id == run.project_id,
                GroundTruthFeedback.id.in_(feedback_ids),
                GroundTruthFeedback.materialization_run_id == run.id,
            )
            .order_by(GroundTruthFeedback.id.asc())
        ).all()
    )
    if len(feedback_rows) != len(feedback_ids):
        raise ValueError("Reserved feedback rows do not match the run snapshot.")

    appended: list[dict[str, Any]] = []
    for feedback in feedback_rows:
        if feedback.review_status != FeedbackReviewStatus.APPROVED.value:
            raise ValueError(f"Feedback #{feedback.id} is no longer APPROVED.")
        observation = db.get(PredictionObservation, feedback.prediction_observation_id)
        if observation is None:
            raise ValueError(f"Observation for feedback #{feedback.id} was not found.")
        appended.append(
            build_training_row(
                observation=observation,
                feedback=feedback,
                feature_columns=feature_columns,
                target_columns=target_columns,
                base_columns=[str(c) for c in base_columns],
                problem_type=problem_type,
            )
        )

    base_frame = datasets.load_dataset_version_dataframe(base_version)
    # Preserve base column order.
    ordered_columns = [str(c) for c in base_columns if str(c) in base_frame.columns]
    for col in base_frame.columns:
        name = str(col)
        if name not in ordered_columns:
            ordered_columns.append(name)
    base_frame = base_frame.reindex(columns=ordered_columns)
    add_frame = pd.DataFrame(appended).reindex(columns=ordered_columns)
    combined = pd.concat([base_frame, add_frame], ignore_index=True)

    row_before = int(len(base_frame))
    row_added = int(len(add_frame))
    row_after = int(len(combined))
    if row_after != row_before + row_added:
        raise ValueError("Materialized row counts are inconsistent.")

    # Compatibility check before committing a new DatasetVersion.
    # Validate against an in-memory profile by creating then rolling back on failure.
    locked = (
        db.query(Dataset)
        .filter(Dataset.id == dataset.id)
        .with_for_update()
        .one()
    )
    if locked.project_id != run.project_id:
        raise ValueError("Output dataset was not found in this project.")

    payload = serialize_frame_to_parquet_bytes(combined)
    filename = safe_filename(f"feedback-materialization-run-{run.id}.parquet")
    from sqlalchemy import func

    latest = db.scalar(
        select(func.max(DatasetVersion.version)).where(
            DatasetVersion.dataset_id == locked.id
        )
    )
    version_number = int(latest or 0) + 1
    object_key = (
        f"project-{locked.project_id}/dataset-{locked.id}/"
        f"v{version_number}-{uuid.uuid4().hex}/{filename}"
    )
    try:
        output = datasets.create_dataset_version_from_bytes(
            db,
            locked,
            payload,
            filename,
            file_format="parquet",
            created_by=run.created_by,
            source_type="feedback_materialization",
            object_key=object_key,
        )
        # Verify retrain compatibility with the new version before success.
        try:
            prepare_retrain_job(
                db,
                run.project_id,
                source_job,
                JobRetrainRequest(
                    dataset_version_id=output.id,
                    name=f"{source_job.name} (feedback materialization check)",
                ),
            )
        except (RetrainConfigError, TrainingConfigError) as exc:
            # Roll back version + mirror + uploaded object.
            db.delete(output)
            db.flush()
            # Restore dataset mirror to base version.
            datasets.update_dataset_mirror(locked, base_version)
            db.flush()
            try:
                storage.delete_object(settings.minio_datasets_bucket, object_key)
            except Exception:
                pass
            raise ValueError(
                f"Materialized dataset is incompatible with source training job: {exc}"
            ) from exc
    except Exception:
        try:
            storage.delete_object(settings.minio_datasets_bucket, object_key)
        except Exception:
            pass
        raise

    run.output_dataset_version_id = output.id
    run.row_count_before = row_before
    run.row_count_added = row_added
    run.row_count_after = row_after
    run.status = JobStatus.succeeded
    run.finished_at = datetime.now(timezone.utc)
    run.error_message = None

    for feedback in feedback_rows:
        feedback.materialization_run_id = run.id
        feedback.materialized_dataset_version_id = output.id

    create_alert(
        db,
        alert_type="feedback_dataset_ready",
        title=f"Feedback dataset ready: {dataset.name} v{output.version}",
        project_id=run.project_id,
        severity=AlertSeverity.info,
        message=(
            f"Materialized {row_added} approved feedback row(s) onto "
            f"base DatasetVersion #{base_version.id} creating "
            f"DatasetVersion #{output.id} (v{output.version})."
        ),
        resource_type="dataset_version",
        resource_id=str(output.id),
        link_path=(
            f"/projects/{run.project_id}/datasets/{dataset.id}"
            f"?version={output.version}"
        ),
    )
    write_audit(
        db,
        action="feedback_materialization.succeed",
        resource_type="feedback_materialization_run",
        resource_id=run.id,
        after=run_out(run),
    )
    db.flush()
    return run


def feedback_materialization_lineage(
    db: Session, dataset_version: DatasetVersion
) -> dict[str, Any] | None:
    run = db.scalar(
        select(FeedbackMaterializationRun).where(
            FeedbackMaterializationRun.output_dataset_version_id == dataset_version.id,
            FeedbackMaterializationRun.status == JobStatus.succeeded,
        )
    )
    if run is None:
        return None
    return {
        "type": "feedback_materialization",
        "materialization_run": {
            "id": run.id,
            "status": run.status.value if hasattr(run.status, "value") else str(run.status),
        },
        "endpoint_id": run.endpoint_id,
        "source_model_version_id": run.source_model_version_id,
        "source_training_job_id": run.source_training_job_id,
        "base_dataset_version_id": run.base_dataset_version_id,
        "feedback_count": run.feedback_count,
    }


def list_runs(
    db: Session,
    *,
    project_id: int,
    skip: int = 0,
    limit: int = 100,
) -> list[dict[str, Any]]:
    rows = db.scalars(
        select(FeedbackMaterializationRun)
        .where(FeedbackMaterializationRun.project_id == project_id)
        .order_by(FeedbackMaterializationRun.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [run_out(row) for row in rows]

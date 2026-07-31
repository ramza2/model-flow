from __future__ import annotations

import json
import logging
import re
import time
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from io import BytesIO
from urllib.parse import quote_plus

import pandas as pd
from sqlalchemy import create_engine, or_, select, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import decrypt_secret
from app.db.models import (
    BatchInferenceJob,
    DataImportJob,
    DataSource,
    DataSourceType,
    Dataset,
    DatasetVersion,
    DriftRun,
    Endpoint,
    JobStatus,
    ModelVersion,
    PipelineRun,
    TrainingJob,
    WorkerHeartbeat,
)
from app.db.session import SessionLocal
from app.services import datasets, drift, inference, pipeline_engine, storage
from app.services.alerts import create_alert
from app.services.training import TrainingJobContext, get_training_runner

logger = logging.getLogger(__name__)
PENDING_STATUSES = (JobStatus.pending, JobStatus.queued)
STALE_TRAINING_AGE = timedelta(hours=1)
_TABLE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?$")


def beat() -> None:
    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)
        row = db.get(WorkerHeartbeat, settings.worker_id)
        if row is None:
            db.add(WorkerHeartbeat(worker_id=settings.worker_id, last_seen_at=now))
        else:
            row.last_seen_at = now
        db.commit()
    finally:
        db.close()


def _claim_next(model, *conditions):
    db = SessionLocal()
    try:
        job = db.scalar(
            select(model)
            .where(model.status.in_(PENDING_STATUSES), *conditions)
            .order_by(model.id.asc())
            .with_for_update(skip_locked=True)
        )
        if not job:
            db.rollback()
            return None
        job.status = JobStatus.running
        if hasattr(job, "started_at"):
            job.started_at = datetime.now(timezone.utc)
        if hasattr(job, "logs"):
            job.logs = (job.logs or "") + "Worker claimed job.\n"
        db.commit()
        db.refresh(job)
        db.expunge(job)
        return job
    finally:
        db.close()


def claim_next_job() -> TrainingJob | None:
    """Claim the next training job (kept for compatibility with the MVP worker)."""

    return _claim_next(TrainingJob)


def claim_next_pipeline_run() -> PipelineRun | None:
    now = datetime.now(timezone.utc)
    return _claim_next(
        PipelineRun,
        or_(PipelineRun.scheduled_for.is_(None), PipelineRun.scheduled_for <= now),
    )


def claim_next_batch_job() -> BatchInferenceJob | None:
    return _claim_next(BatchInferenceJob)


def claim_next_drift_run() -> DriftRun | None:
    return _claim_next(DriftRun)


def claim_next_import_job() -> DataImportJob | None:
    return _claim_next(DataImportJob)


def _failure_alert(
    db: Session,
    *,
    project_id: int,
    job_id: int,
    job_kind: str,
    message: str,
) -> None:
    create_alert(
        db,
        project_id=project_id,
        alert_type=f"{job_kind}_failure",
        severity="error",
        title=f"{job_kind.replace('_', ' ').title()} {job_id} failed",
        message=message,
        resource_type=job_kind,
        resource_id=job_id,
    )


def _cancel_training_job(db: Session, job: TrainingJob, message: str) -> None:
    job.status = JobStatus.cancelled
    job.finished_at = datetime.now(timezone.utc)
    job.error_message = None
    job.logs = (job.logs or "") + f"{message}\n"
    db.commit()


def process_job(job: TrainingJob) -> None:
    db = SessionLocal()
    try:
        live = db.get(TrainingJob, job.id)
        if live is None:
            raise RuntimeError(f"Training job {job.id} no longer exists")
        db.refresh(live)
        if live.status == JobStatus.cancel_requested:
            _cancel_training_job(db, live, "Cancellation honored before training started.")
            return
        ds = db.get(Dataset, live.dataset_id)
        if not ds:
            raise RuntimeError("Dataset missing for job")
        version = (
            db.get(DatasetVersion, live.dataset_version_id)
            if live.dataset_version_id is not None
            else None
        )
        object_key = version.object_key if version else ds.object_key
        data_format = version.format if version else "csv"
        data_bytes = storage.download_bytes(settings.minio_datasets_bucket, object_key)
        ctx = TrainingJobContext(
            job_id=live.id,
            project_id=live.project_id,
            job_name=live.name,
            target_column=live.target_column,
            algorithm=live.algorithm,
            hyperparameters=json.loads(live.hyperparameters_json or "{}"),
            csv_bytes=data_bytes,
            experiment_name=f"project-{live.project_id}",
            problem_type=live.problem_type,
            preprocessing=json.loads(live.preprocessing_json or "{}"),
            feature_columns=json.loads(live.feature_columns_json or "[]"),
            train_ratio=live.train_ratio,
            val_ratio=live.val_ratio,
            test_ratio=live.test_ratio,
            random_seed=live.random_seed,
            data_format=data_format,
        )
        live.logs = (live.logs or "") + "Starting SklearnTrainingRunner...\n"
        db.commit()
        result = get_training_runner().run(ctx)
        live = db.get(TrainingJob, job.id)
        if live is None:
            raise RuntimeError(f"Training job {job.id} no longer exists")
        db.refresh(live)
        if live.status == JobStatus.cancel_requested:
            _cancel_training_job(
                db,
                live,
                "Cancellation honored after the training runner reached a safe stopping point.",
            )
            return
        live.status = JobStatus.succeeded
        live.mlflow_run_id = result.mlflow_run_id
        live.model_uri = result.model_uri
        live.metrics_json = json.dumps(result.metrics)
        live.logs = (live.logs or "") + result.logs + "\nTraining succeeded.\n"
        live.finished_at = datetime.now(timezone.utc)
        live.error_message = None
        db.commit()
    except Exception as exc:
        db.rollback()
        live = db.get(TrainingJob, job.id)
        if live:
            live.status = JobStatus.failed
            live.error_message = str(exc)
            live.logs = (live.logs or "") + f"ERROR: {exc}\n{traceback.format_exc()}\n"
            live.finished_at = datetime.now(timezone.utc)
            _failure_alert(
                db,
                project_id=live.project_id,
                job_id=live.id,
                job_kind="training_job",
                message=str(exc),
            )
            db.commit()
    finally:
        db.close()


def process_pipeline_run(run: PipelineRun) -> None:
    db = SessionLocal()
    try:
        result = pipeline_engine.execute_pipeline_run(db, run.id)
        if result.status == JobStatus.failed:
            _failure_alert(
                db,
                project_id=result.project_id,
                job_id=result.id,
                job_kind="pipeline_run",
                message=result.error_message or "Pipeline execution failed.",
            )
            db.commit()
    except Exception as exc:
        db.rollback()
        live = db.get(PipelineRun, run.id)
        if live:
            live.status = JobStatus.failed
            live.error_message = str(exc)
            live.logs = (live.logs or "") + f"ERROR: {exc}\n{traceback.format_exc()}\n"
            live.finished_at = datetime.now(timezone.utc)
            _failure_alert(
                db,
                project_id=live.project_id,
                job_id=live.id,
                job_kind="pipeline_run",
                message=str(exc),
            )
            db.commit()
    finally:
        db.close()


def _schema_columns(value: str | None) -> list[str]:
    try:
        schema = json.loads(value or "[]")
    except (TypeError, json.JSONDecodeError):
        return []
    if isinstance(schema, dict):
        schema = schema.get("features", schema.get("columns", []))
    if not isinstance(schema, list):
        return []
    return [
        str(item["name"] if isinstance(item, dict) else item)
        for item in schema
        if (isinstance(item, str) and item) or (isinstance(item, dict) and item.get("name"))
    ]


def _batch_features(
    db: Session,
    frame: pd.DataFrame,
    endpoint: Endpoint | None,
    model_version: ModelVersion | None,
) -> pd.DataFrame:
    columns = _schema_columns(endpoint.feature_schema_json if endpoint else None)
    if not columns and model_version is not None:
        try:
            metadata = json.loads(model_version.metadata_json or "{}")
        except json.JSONDecodeError:
            metadata = {}
        schema = metadata.get("feature_schema", metadata.get("features", []))
        columns = _schema_columns(json.dumps(schema))
    training_job = (
        db.get(TrainingJob, model_version.training_job_id)
        if model_version is not None and model_version.training_job_id
        else None
    )
    if not columns and training_job is not None:
        columns = _schema_columns(training_job.feature_columns_json)
    if columns:
        missing = sorted(set(columns) - set(map(str, frame.columns)))
        if missing:
            raise ValueError(f"Batch dataset is missing model features: {missing}")
        return frame.loc[:, columns]
    if training_job is not None and training_job.target_column in frame.columns:
        return frame.drop(columns=[training_job.target_column])
    return frame


def _encode_batch_result(frame: pd.DataFrame, result_format: str) -> tuple[bytes, str]:
    if result_format == "csv":
        return frame.to_csv(index=False).encode(), "text/csv"
    if result_format == "json":
        return frame.to_json(orient="records").encode(), "application/json"
    if result_format == "parquet":
        buffer = BytesIO()
        frame.to_parquet(buffer, index=False)
        return buffer.getvalue(), "application/vnd.apache.parquet"
    raise ValueError(f"Unsupported batch result format '{result_format}'.")


def process_batch_job(job: BatchInferenceJob) -> None:
    db = SessionLocal()
    try:
        live = db.get(BatchInferenceJob, job.id)
        if live is None:
            raise RuntimeError(f"Batch inference job {job.id} no longer exists")
        version = db.get(DatasetVersion, live.dataset_version_id)
        if version is None or version.project_id != live.project_id:
            raise ValueError("Batch dataset version was not found in this project.")
        endpoint = db.get(Endpoint, live.endpoint_id) if live.endpoint_id else None
        if live.endpoint_id and (endpoint is None or endpoint.project_id != live.project_id):
            raise ValueError("Batch endpoint was not found in this project.")
        model_version = (
            db.get(ModelVersion, live.model_version_id) if live.model_version_id else None
        )
        if model_version is None and endpoint is not None and endpoint.model_version_id:
            model_version = db.get(ModelVersion, endpoint.model_version_id)
        if live.model_version_id and (
            model_version is None or model_version.project_id != live.project_id
        ):
            raise ValueError("Batch model version was not found in this project.")
        model_uri = endpoint.model_uri if endpoint is not None else None
        if model_uri is None and model_version is not None:
            model_uri = model_version.model_uri
        if not model_uri:
            raise ValueError("Batch inference requires an endpoint or model version.")

        frame = datasets.load_dataset_version_dataframe(version)
        features = _batch_features(db, frame, endpoint, model_version)
        predictions = inference.load_model(model_uri).predict(features)
        if len(predictions) != len(frame):
            raise RuntimeError("Model returned a different number of predictions than input rows.")
        result_frame = frame.copy()
        result_frame["prediction"] = [
            value.item() if hasattr(value, "item") else value for value in predictions
        ]
        payload, content_type = _encode_batch_result(result_frame, live.result_format)
        key = (
            f"project-{live.project_id}/batch-jobs/{live.id}/"
            f"{uuid.uuid4().hex}.{live.result_format}"
        )
        storage.ensure_buckets()
        storage.upload_bytes(settings.minio_batch_bucket, key, payload, content_type)

        live.status = JobStatus.succeeded
        live.result_object_key = key
        live.row_count = len(result_frame)
        live.failure_details_json = "[]"
        live.error_message = None
        live.finished_at = datetime.now(timezone.utc)
        db.commit()
    except Exception as exc:
        db.rollback()
        live = db.get(BatchInferenceJob, job.id)
        if live:
            live.status = JobStatus.failed
            live.error_message = str(exc)
            live.failure_details_json = json.dumps(
                [{"error_class": exc.__class__.__name__, "message": str(exc)}]
            )
            live.finished_at = datetime.now(timezone.utc)
            _failure_alert(
                db,
                project_id=live.project_id,
                job_id=live.id,
                job_kind="batch_inference_job",
                message=str(exc),
            )
            db.commit()
    finally:
        db.close()


def process_drift_run(run: DriftRun) -> None:
    db = SessionLocal()
    try:
        live = db.get(DriftRun, run.id)
        if live is None:
            raise RuntimeError(f"Drift run {run.id} no longer exists")
        reference = db.get(DatasetVersion, live.reference_version_id)
        current = db.get(DatasetVersion, live.current_version_id)
        if (
            reference is None
            or current is None
            or reference.project_id != live.project_id
            or current.project_id != live.project_id
        ):
            raise ValueError("Drift dataset versions were not found in this project.")
        try:
            thresholds = json.loads(live.thresholds_json or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError("Drift thresholds are not valid JSON.") from exc
        if not isinstance(thresholds, dict):
            raise ValueError("Drift thresholds must be a JSON object.")
        result = drift.compute_drift(
            datasets.load_dataset_version_dataframe(reference),
            datasets.load_dataset_version_dataframe(current),
            thresholds=thresholds,
        )
        live.status = JobStatus.succeeded
        live.overall_status = result["overall_status"]
        live.results_json = json.dumps(result, default=str)
        live.error_message = None
        live.finished_at = datetime.now(timezone.utc)
        db.commit()
    except Exception as exc:
        db.rollback()
        live = db.get(DriftRun, run.id)
        if live:
            live.status = JobStatus.failed
            live.error_message = str(exc)
            live.finished_at = datetime.now(timezone.utc)
            db.commit()
    finally:
        db.close()


def _json_dict(value: str | None) -> dict:
    try:
        result = json.loads(value or "{}")
    except json.JSONDecodeError:
        return {}
    return result if isinstance(result, dict) else {}


def _source_url(source: DataSource) -> str:
    config = _json_dict(source.config_json)
    secrets = (
        _json_dict(decrypt_secret(source.secret_encrypted))
        if source.secret_encrypted
        else {}
    )
    if secrets.get("url") or secrets.get("dsn"):
        return str(secrets.get("url") or secrets.get("dsn"))
    required = ("host", "database", "user")
    missing = [key for key in required if not (config.get(key) or secrets.get(key))]
    if missing:
        raise ValueError(f"Data source is missing: {', '.join(missing)}.")
    user = quote_plus(str(config.get("user") or secrets.get("user")))
    password = quote_plus(str(secrets.get("password", "")))
    auth = f"{user}:{password}" if password else user
    host = str(config.get("host") or secrets.get("host"))
    port = int(config.get("port") or secrets.get("port") or 5432)
    database = quote_plus(str(config.get("database") or secrets.get("database")))
    return f"postgresql+psycopg2://{auth}@{host}:{port}/{database}"


def _import_query(engine, query_or_table: str) -> str:
    value = query_or_table.strip()
    if value.endswith(";"):
        value = value[:-1].rstrip()
    if not value or ";" in value:
        raise ValueError("Data imports accept one read-only SELECT or table name.")
    if _TABLE_NAME.fullmatch(value):
        parts = value.split(".", 1)
        quoted = [engine.dialect.identifier_preparer.quote_identifier(part) for part in parts]
        return f"SELECT * FROM {'.'.join(quoted)}"
    if not re.match(r"^(select|with)\b", value, flags=re.IGNORECASE):
        raise ValueError("Data imports accept only a read-only SELECT or table name.")
    return value


def process_import_job(job: DataImportJob) -> None:
    db = SessionLocal()
    engine = None
    try:
        live = db.get(DataImportJob, job.id)
        if live is None:
            raise RuntimeError(f"Data import job {job.id} no longer exists")
        source = db.get(DataSource, live.data_source_id)
        dataset = db.get(Dataset, live.dataset_id) if live.dataset_id else None
        if (
            source is None
            or dataset is None
            or source.project_id != live.project_id
            or dataset.project_id != live.project_id
        ):
            raise ValueError("Import source or target dataset was not found in this project.")
        if not source.is_active:
            raise ValueError("Import source is inactive.")
        if source.source_type != DataSourceType.postgres:
            raise ValueError("Worker imports currently support PostgreSQL data sources.")
        engine = create_engine(
            _source_url(source),
            pool_pre_ping=True,
            connect_args={"connect_timeout": 5},
        )
        query = _import_query(engine, live.query_or_table)
        with engine.connect() as connection, connection.begin():
            connection.execute(text("SET TRANSACTION READ ONLY"))
            frame = pd.read_sql_query(text(query), connection)
        if frame.empty and not len(frame.columns):
            raise ValueError("Data source query returned no columns.")
        payload = frame.to_csv(index=False).encode()
        version = datasets.create_dataset_version_from_bytes(
            db,
            dataset,
            payload,
            f"{source.name}-import-{live.id}.csv",
            file_format="csv",
            created_by=live.created_by,
            source_type="postgres",
            data_source_id=source.id,
            import_job_id=live.id,
        )
        live.dataset_version_id = version.id
        live.status = JobStatus.succeeded
        live.error_message = None
        live.finished_at = datetime.now(timezone.utc)
        db.commit()
    except Exception as exc:
        db.rollback()
        live = db.get(DataImportJob, job.id)
        if live:
            live.status = JobStatus.failed
            live.error_message = str(exc)
            live.finished_at = datetime.now(timezone.utc)
            db.commit()
    finally:
        if engine is not None:
            engine.dispose()
        db.close()


def recover_stale_training_jobs(max_age: timedelta = STALE_TRAINING_AGE) -> int:
    db = SessionLocal()
    try:
        cutoff = datetime.now(timezone.utc) - max_age
        jobs = db.scalars(
            select(TrainingJob).where(
                TrainingJob.status == JobStatus.running,
                TrainingJob.started_at.is_not(None),
                TrainingJob.started_at < cutoff,
            )
        ).all()
        for job in jobs:
            message = f"Training job exceeded the worker timeout ({max_age})."
            job.status = JobStatus.failed
            job.error_message = message
            job.logs = (job.logs or "") + f"ERROR: {message}\n"
            job.finished_at = datetime.now(timezone.utc)
            _failure_alert(
                db,
                project_id=job.project_id,
                job_id=job.id,
                job_kind="training_job",
                message=message,
            )
        db.commit()
        return len(jobs)
    finally:
        db.close()


def honor_cancel_requested_training_jobs() -> int:
    """Finish cancellation requests at the worker's between-job safe point."""

    db = SessionLocal()
    try:
        jobs = db.scalars(
            select(TrainingJob).where(TrainingJob.status == JobStatus.cancel_requested)
        ).all()
        for job in jobs:
            job.status = JobStatus.cancelled
            job.finished_at = datetime.now(timezone.utc)
            job.error_message = None
            job.logs = (job.logs or "") + "Cancellation honored at worker safe point.\n"
        db.commit()
        return len(jobs)
    finally:
        db.close()


def _wait_for_database() -> None:
    for _ in range(60):
        db = SessionLocal()
        try:
            db.execute(text("SELECT 1"))
            return
        except Exception:
            time.sleep(2)
        finally:
            db.close()
    raise RuntimeError("Database did not become ready for the worker.")


def run_forever() -> None:
    _wait_for_database()
    logger.info("ModelFlow worker started worker_id=%s", settings.worker_id)
    while True:
        processed = False
        try:
            beat()
            work = (
                ("training job", claim_next_job, process_job),
                ("pipeline run", claim_next_pipeline_run, process_pipeline_run),
                ("batch inference job", claim_next_batch_job, process_batch_job),
                ("drift run", claim_next_drift_run, process_drift_run),
                ("data import job", claim_next_import_job, process_import_job),
            )
            for label, claim, process in work:
                item = claim()
                if item is None:
                    continue
                processed = True
                logger.info("Processing %s id=%s", label, item.id)
                process(item)
                beat()
            recovered = recover_stale_training_jobs()
            cancelled = honor_cancel_requested_training_jobs()
            if recovered:
                logger.warning("Recovered %s stale training job(s)", recovered)
            if cancelled:
                logger.info("Cancelled %s training job(s)", cancelled)
        except Exception:
            logger.exception("Worker poll cycle failed")
        if not processed:
            time.sleep(settings.worker_poll_seconds)


if __name__ == "__main__":
    run_forever()

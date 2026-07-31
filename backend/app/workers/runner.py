from __future__ import annotations

import json
import time
import traceback
from datetime import datetime, timezone

from sqlalchemy import select, text

from app.core.config import settings
from app.db.models import Dataset, JobStatus, TrainingJob
from app.db.session import SessionLocal
from app.services import storage
from app.services.training import TrainingJobContext, get_training_runner


def claim_next_job() -> TrainingJob | None:
    db = SessionLocal()
    try:
        job = db.scalar(
            select(TrainingJob)
            .where(TrainingJob.status == JobStatus.pending)
            .order_by(TrainingJob.id.asc())
            .with_for_update(skip_locked=True)
        )
        if not job:
            db.rollback()
            return None
        job.status = JobStatus.running
        job.started_at = datetime.now(timezone.utc)
        job.logs = (job.logs or "") + "Worker claimed job.\n"
        db.commit()
        db.refresh(job)
        # Detach values needed outside session
        db.expunge(job)
        return job
    finally:
        db.close()


def process_job(job: TrainingJob) -> None:
    db = SessionLocal()
    try:
        live = db.get(TrainingJob, job.id)
        ds = db.get(Dataset, live.dataset_id)
        if not ds:
            raise RuntimeError("Dataset missing for job")
        csv_bytes = storage.download_bytes(settings.minio_datasets_bucket, ds.object_key)
        ctx = TrainingJobContext(
            job_id=live.id,
            project_id=live.project_id,
            job_name=live.name,
            target_column=live.target_column,
            algorithm=live.algorithm,
            hyperparameters=json.loads(live.hyperparameters_json or "{}"),
            csv_bytes=csv_bytes,
            experiment_name=f"project-{live.project_id}",
        )
        live.logs = (live.logs or "") + "Starting SklearnTrainingRunner...\n"
        db.commit()
        result = get_training_runner().run(ctx)
        live = db.get(TrainingJob, job.id)
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
            db.commit()
    finally:
        db.close()


def run_forever() -> None:
    # Wait for DB
    for _ in range(60):
        try:
            db = SessionLocal()
            db.execute(text("SELECT 1"))
            db.close()
            break
        except Exception:
            time.sleep(2)
    print("ModelFlow worker started", flush=True)
    while True:
        job = claim_next_job()
        if job:
            print(f"Processing job {job.id}", flush=True)
            process_job(job)
        else:
            time.sleep(settings.worker_poll_seconds)


if __name__ == "__main__":
    run_forever()

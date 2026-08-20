from datetime import datetime, timedelta, timezone
from io import BytesIO

import pandas as pd
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.models import (
    Alert,
    AlertSeverity,
    Base,
    BatchInferenceJob,
    Dataset,
    DatasetVersion,
    DriftRun,
    Endpoint,
    JobStatus,
    ModelVersion,
    Pipeline,
    PipelineRun,
    PipelineVersion,
    Project,
    TrainingJob,
)
from app.workers import runner


engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


@pytest.fixture(autouse=True)
def setup_worker_db(monkeypatch):
    Base.metadata.create_all(engine)
    monkeypatch.setattr(runner, "SessionLocal", TestingSessionLocal)
    yield
    Base.metadata.drop_all(engine)


def _seed_dataset(db):
    project = Project(name="worker-test")
    db.add(project)
    db.flush()
    dataset = Dataset(
        project_id=project.id,
        name="iris",
        object_key="iris.csv",
        latest_version=1,
    )
    db.add(dataset)
    db.flush()
    version = DatasetVersion(
        dataset_id=dataset.id,
        project_id=project.id,
        version=1,
        object_key="iris.csv",
        original_filename="iris.csv",
        format="csv",
    )
    db.add(version)
    db.flush()
    return project, dataset, version


def test_process_batch_job_uses_training_target_and_writes_csv(monkeypatch):
    uploaded = {}
    with TestingSessionLocal() as db:
        project, dataset, version = _seed_dataset(db)
        training = TrainingJob(
            project_id=project.id,
            dataset_id=dataset.id,
            dataset_version_id=version.id,
            name="train",
            target_column="target",
            status=JobStatus.succeeded,
        )
        db.add(training)
        db.flush()
        model = ModelVersion(
            project_id=project.id,
            name="classifier",
            version="1",
            mlflow_model_name="project-1-classifier",
            mlflow_version="1",
            model_uri="models:/classifier/1",
            training_job_id=training.id,
        )
        db.add(model)
        db.flush()
        endpoint = Endpoint(
            project_id=project.id,
            name="endpoint",
            model_name=model.name,
            model_version=model.version,
            model_version_id=model.id,
            model_uri=model.model_uri,
        )
        db.add(endpoint)
        db.flush()
        job = BatchInferenceJob(
            project_id=project.id,
            dataset_version_id=version.id,
            endpoint_id=endpoint.id,
            status=JobStatus.running,
        )
        db.add(job)
        db.commit()
        job_id = job.id

    frame = pd.DataFrame({"feature": [1.0, 2.0], "target": [0, 1]})
    monkeypatch.setattr(
        runner.datasets,
        "load_dataset_version_dataframe",
        lambda _: frame,
    )

    class Model:
        def predict(self, features):
            assert list(features.columns) == ["feature"]
            return [1, 0]

    monkeypatch.setattr(runner.inference, "load_model", lambda _: Model())
    monkeypatch.setattr(runner.storage, "ensure_buckets", lambda: None)
    monkeypatch.setattr(
        runner.storage,
        "upload_bytes",
        lambda bucket, key, data, content_type: uploaded.update(
            bucket=bucket,
            key=key,
            data=data,
            content_type=content_type,
        ),
    )

    runner.process_batch_job(type("Claim", (), {"id": job_id})())

    with TestingSessionLocal() as db:
        job = db.get(BatchInferenceJob, job_id)
        assert job.status == JobStatus.succeeded
        assert job.row_count == 2
        assert job.result_object_key == uploaded["key"]
    result = pd.read_csv(BytesIO(uploaded["data"]))
    assert result["prediction"].tolist() == [1, 0]


def test_process_drift_run_persists_result(monkeypatch):
    with TestingSessionLocal() as db:
        project, dataset, reference = _seed_dataset(db)
        current = DatasetVersion(
            dataset_id=dataset.id,
            project_id=project.id,
            version=2,
            object_key="iris-v2.csv",
            original_filename="iris-v2.csv",
            format="csv",
        )
        db.add(current)
        db.flush()
        run = DriftRun(
            project_id=project.id,
            reference_version_id=reference.id,
            current_version_id=current.id,
            status=JobStatus.running,
        )
        db.add(run)
        db.commit()
        run_id = run.id
        reference_id = reference.id

    monkeypatch.setattr(
        runner.datasets,
        "load_dataset_version_dataframe",
        lambda version: pd.DataFrame(
            {"value": [1, 2, 3] if version.id == reference_id else [1, 2, 4]}
        ),
    )
    runner.process_drift_run(type("Claim", (), {"id": run_id})())

    with TestingSessionLocal() as db:
        run = db.get(DriftRun, run_id)
        assert run.status == JobStatus.succeeded
        assert run.overall_status in {"ok", "watch", "critical"}
        assert '"columns"' in run.results_json


def test_process_drift_run_ok_creates_no_alert(monkeypatch):
    with TestingSessionLocal() as db:
        project, dataset, reference = _seed_dataset(db)
        current = DatasetVersion(
            dataset_id=dataset.id,
            project_id=project.id,
            version=2,
            object_key="same.csv",
            original_filename="same.csv",
            format="csv",
        )
        db.add(current)
        db.flush()
        run = DriftRun(
            project_id=project.id,
            reference_version_id=reference.id,
            current_version_id=current.id,
            status=JobStatus.running,
        )
        db.add(run)
        db.commit()
        run_id = run.id

    monkeypatch.setattr(
        runner.datasets,
        "load_dataset_version_dataframe",
        lambda _: pd.DataFrame({"value": [1, 2, 3]}),
    )
    monkeypatch.setattr(
        runner.drift,
        "compute_drift",
        lambda *_args, **_kwargs: {
            "overall_status": "ok",
            "columns": {"value": {"status": "ok", "score": 0.0}},
        },
    )
    runner.process_drift_run(type("Claim", (), {"id": run_id})())

    with TestingSessionLocal() as db:
        run = db.get(DriftRun, run_id)
        assert run.status == JobStatus.succeeded
        alerts = db.scalars(select(Alert).where(Alert.resource_id == str(run_id))).all()
        assert alerts == []


def test_process_drift_run_watch_creates_warning_alert(monkeypatch):
    with TestingSessionLocal() as db:
        project, dataset, reference = _seed_dataset(db)
        current = DatasetVersion(
            dataset_id=dataset.id,
            project_id=project.id,
            version=2,
            object_key="watch.csv",
            original_filename="watch.csv",
            format="csv",
        )
        db.add(current)
        db.flush()
        run = DriftRun(
            project_id=project.id,
            reference_version_id=reference.id,
            current_version_id=current.id,
            status=JobStatus.running,
        )
        db.add(run)
        db.commit()
        run_id = run.id

    monkeypatch.setattr(
        runner.datasets,
        "load_dataset_version_dataframe",
        lambda _: pd.DataFrame({"a": [1, 2], "b": [3, 4]}),
    )
    monkeypatch.setattr(
        runner.drift,
        "compute_drift",
        lambda *_args, **_kwargs: {
            "overall_status": "watch",
            "columns": {
                "income": {"status": "watch", "score": 0.18},
                "age": {"status": "ok", "score": 0.01},
            },
        },
    )
    runner.process_drift_run(type("Claim", (), {"id": run_id})())

    with TestingSessionLocal() as db:
        alert = db.scalar(
            select(Alert).where(
                Alert.alert_type == "drift",
                Alert.resource_type == "drift_run",
                Alert.resource_id == str(run_id),
            )
        )
        assert alert is not None
        assert alert.severity == AlertSeverity.warning
        assert alert.title == "Data drift requires attention"
        assert alert.link_path == f"/projects/{alert.project_id}/monitoring"
        assert "Drift run" in alert.message
        assert "income (watch, 0.18)" in alert.message


def test_process_drift_run_critical_creates_single_critical_alert_with_summary(monkeypatch):
    with TestingSessionLocal() as db:
        project, dataset, reference = _seed_dataset(db)
        current = DatasetVersion(
            dataset_id=dataset.id,
            project_id=project.id,
            version=2,
            object_key="critical.csv",
            original_filename="critical.csv",
            format="csv",
        )
        db.add(current)
        db.flush()
        run = DriftRun(
            project_id=project.id,
            reference_version_id=reference.id,
            current_version_id=current.id,
            status=JobStatus.running,
        )
        db.add(run)
        db.commit()
        run_id = run.id

    monkeypatch.setattr(
        runner.datasets,
        "load_dataset_version_dataframe",
        lambda _: pd.DataFrame({"a": [1, 2], "b": [3, 4]}),
    )
    monkeypatch.setattr(
        runner.drift,
        "compute_drift",
        lambda *_args, **_kwargs: {
            "overall_status": "critical",
            "columns": {
                "age": {"status": "critical", "score": 0.41},
                "income": {"status": "watch", "score": 0.18},
                "zip": {"status": "critical", "score": 0.22},
                "city": {"status": "ok", "score": 0.05},
            },
        },
    )

    # Simulate worker retry / duplicate processing on the same drift run.
    runner.process_drift_run(type("Claim", (), {"id": run_id})())
    runner.process_drift_run(type("Claim", (), {"id": run_id})())

    with TestingSessionLocal() as db:
        alerts = db.scalars(
            select(Alert).where(
                Alert.alert_type == "drift",
                Alert.resource_type == "drift_run",
                Alert.resource_id == str(run_id),
            )
        ).all()
        assert len(alerts) == 1
        alert = alerts[0]
        assert alert.severity == AlertSeverity.critical
        assert alert.title == "Critical data drift detected"
        assert "age (critical, 0.41)" in alert.message
        assert "zip (critical, 0.22)" in alert.message
        assert "income (watch, 0.18)" in alert.message


def test_process_drift_run_failure_does_not_create_drift_success_alert(monkeypatch):
    with TestingSessionLocal() as db:
        project, dataset, reference = _seed_dataset(db)
        current = DatasetVersion(
            dataset_id=dataset.id,
            project_id=project.id,
            version=2,
            object_key="broken.csv",
            original_filename="broken.csv",
            format="csv",
        )
        db.add(current)
        db.flush()
        run = DriftRun(
            project_id=project.id,
            reference_version_id=reference.id,
            current_version_id=current.id,
            status=JobStatus.running,
        )
        db.add(run)
        db.commit()
        run_id = run.id

    monkeypatch.setattr(
        runner.datasets,
        "load_dataset_version_dataframe",
        lambda _: (_ for _ in ()).throw(RuntimeError("dataset unavailable")),
    )
    runner.process_drift_run(type("Claim", (), {"id": run_id})())

    with TestingSessionLocal() as db:
        run = db.get(DriftRun, run_id)
        assert run.status == JobStatus.failed
        alerts = db.scalars(
            select(Alert).where(
                Alert.resource_type == "drift_run",
                Alert.resource_id == str(run_id),
            )
        ).all()
        assert alerts == []


def test_training_recovery_and_cancellation_create_terminal_states():
    with TestingSessionLocal() as db:
        project, dataset, version = _seed_dataset(db)
        stale = TrainingJob(
            project_id=project.id,
            dataset_id=dataset.id,
            dataset_version_id=version.id,
            name="stale",
            target_column="target",
            status=JobStatus.running,
            started_at=datetime.now(timezone.utc) - timedelta(hours=2),
        )
        cancelled = TrainingJob(
            project_id=project.id,
            dataset_id=dataset.id,
            dataset_version_id=version.id,
            name="cancel",
            target_column="target",
            status=JobStatus.cancel_requested,
        )
        db.add_all([stale, cancelled])
        db.commit()
        stale_id, cancelled_id = stale.id, cancelled.id

    assert runner.recover_stale_training_jobs() == 1
    assert runner.honor_cancel_requested_training_jobs() == 1

    with TestingSessionLocal() as db:
        assert db.get(TrainingJob, stale_id).status == JobStatus.failed
        assert db.get(TrainingJob, cancelled_id).status == JobStatus.cancelled
        alert = db.scalar(select(Alert).where(Alert.resource_id == str(stale_id)))
        assert alert is not None
        assert alert.alert_type == "training_job_failure"


def test_pipeline_claim_respects_schedule_and_limit():
    with TestingSessionLocal() as db:
        project = Project(name="pipeline-schedule-test")
        db.add(project)
        db.flush()
        pipeline = Pipeline(project_id=project.id, name="scheduled")
        db.add(pipeline)
        db.flush()
        version = PipelineVersion(
            pipeline_id=pipeline.id,
            project_id=project.id,
            version=1,
        )
        db.add(version)
        db.flush()
        due = PipelineRun(
            project_id=project.id,
            pipeline_id=pipeline.id,
            pipeline_version_id=version.id,
            status=JobStatus.pending,
            scheduled_for=datetime.now(timezone.utc) - timedelta(minutes=1),
        )
        future = PipelineRun(
            project_id=project.id,
            pipeline_id=pipeline.id,
            pipeline_version_id=version.id,
            status=JobStatus.pending,
            scheduled_for=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        db.add_all([due, future])
        db.commit()
        due_id, future_id = due.id, future.id

    claimed = runner.claim_pipeline_runs(1)
    assert [run.id for run in claimed] == [due_id]
    assert runner.claim_pipeline_runs(1) == []

    with TestingSessionLocal() as db:
        assert db.get(PipelineRun, due_id).status == JobStatus.running
        future = db.get(PipelineRun, future_id)
        assert future.status == JobStatus.pending
        future.scheduled_for = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.commit()

    assert [run.id for run in runner.claim_pipeline_runs(1)] == [future_id]


def test_import_query_only_allows_table_or_read_only_query():
    assert runner._import_query(engine, "public.customers") == (
        'SELECT * FROM "public"."customers"'
    )
    assert runner._import_query(engine, "SELECT id FROM customers;") == (
        "SELECT id FROM customers"
    )
    with pytest.raises(ValueError, match="read-only"):
        runner._import_query(engine, "DELETE FROM customers")
    with pytest.raises(ValueError, match="one read-only"):
        runner._import_query(engine, "SELECT 1; DROP TABLE customers")

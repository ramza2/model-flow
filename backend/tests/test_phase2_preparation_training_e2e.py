"""Phase 2-G end-to-end Dataset Preparation -> exact-version Training regression."""

from __future__ import annotations

import io
import json
import secrets

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import (
    Base,
    Dataset,
    DatasetPreparationRun,
    DatasetPreparationRunStatus,
    DatasetVersion,
    JobStatus,
    TrainingJob,
    User,
)
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import mlflow_service, registry_service, storage
from app.services.training import TrainingJobContext, TrainingResult
from app.workers import runner


engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
ADMIN_PASSWORD = secrets.token_urlsafe(24)
artifact_store: dict[str, bytes] = {}


@pytest.fixture(autouse=True)
def setup_api(monkeypatch):
    Base.metadata.create_all(engine)
    artifact_store.clear()
    _rate_windows.clear()

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr(storage, "ensure_buckets", lambda: None)
    monkeypatch.setattr(
        storage,
        "upload_bytes",
        lambda bucket, key, data, content_type="application/octet-stream": artifact_store.__setitem__(
            key, data
        ),
    )
    monkeypatch.setattr(storage, "download_bytes", lambda bucket, key: artifact_store[key])
    monkeypatch.setattr(storage, "delete_object", lambda bucket, key: artifact_store.pop(key, None))
    monkeypatch.setattr(mlflow_service, "ensure_experiment", lambda name: "exp-phase2-g")
    monkeypatch.setattr(registry_service, "_mlflow_logged_feature_schema", lambda run_id: [])
    monkeypatch.setattr(runner, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr("app.db.session.SessionLocal", TestingSessionLocal)

    with TestingSessionLocal() as db:
        db.add(
            User(
                email="admin@example.com",
                full_name="Admin",
                password_hash=hash_password(ADMIN_PASSWORD),
                is_active=True,
                is_system_admin=True,
            )
        )
        db.commit()

    yield
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def auth_headers(client):
    response = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@example.com", "password": ADMIN_PASSWORD},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _create_project(client: TestClient, auth_headers: dict[str, str]) -> int:
    response = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": f"phase2-g-{secrets.token_hex(4)}", "description": ""},
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _upload_dataset(
    client: TestClient,
    auth_headers: dict[str, str],
    project_id: int,
    name: str,
    csv: bytes,
) -> dict:
    response = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": (name, csv, "text/csv")},
        data={"name": name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _create_preparation(
    client: TestClient,
    auth_headers: dict[str, str],
    project_id: int,
    graph: dict,
) -> dict:
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={
            "name": "Phase 2 Golden Path",
            "description": "Join -> Filter -> Derived -> Group By -> Unpivot -> Pivot",
            "graph": graph,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _create_output_dataset(
    client: TestClient,
    auth_headers: dict[str, str],
    project_id: int,
    preparation_id: int,
) -> int:
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{preparation_id}/output-dataset",
        headers=auth_headers,
        json={"name": "Phase 2 Prepared Output", "description": "phase 2 e2e"},
    )
    assert response.status_code == 201, response.text
    return response.json()["output_dataset"]["id"]


def _create_and_process_run(
    client: TestClient,
    auth_headers: dict[str, str],
    project_id: int,
    preparation_id: int,
) -> tuple[dict, DatasetPreparationRun]:
    created = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{preparation_id}/runs",
        headers=auth_headers,
        json={},
    )
    assert created.status_code == 201, created.text
    run_body = created.json()

    queued = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparation-runs/{run_body['id']}/execute",
        headers=auth_headers,
    )
    assert queued.status_code == 202, queued.text

    claimed = runner.claim_next_preparation_run()
    assert claimed is not None
    assert claimed.id == run_body["id"]
    runner.process_preparation_run(claimed)

    with TestingSessionLocal() as db:
        live = db.get(DatasetPreparationRun, run_body["id"])
        assert live is not None
        db.expunge(live)
    return run_body, live


def _phase2_graph(orders_dataset_id: int, segments_dataset_id: int, segments_version_id: int) -> dict:
    return {
        "schema_version": 1,
        "nodes": [
            {
                "id": "orders",
                "type": "source",
                "config": {
                    "dataset_id": orders_dataset_id,
                    "version_strategy": "latest",
                },
            },
            {
                "id": "segments",
                "type": "source",
                "config": {
                    "dataset_id": segments_dataset_id,
                    "version_strategy": "fixed",
                    "dataset_version_id": segments_version_id,
                },
            },
            {
                "id": "join-1",
                "type": "join",
                "config": {
                    "how": "left",
                    "left_on": ["region"],
                    "right_on": ["region"],
                },
            },
            {
                "id": "filter-1",
                "type": "filter",
                "config": {
                    "combine": "and",
                    "conditions": [
                        {"column": "sales", "operator": "gt", "value": 0}
                    ],
                },
            },
            {
                "id": "derived-1",
                "type": "derived_column",
                "config": {
                    "name": "adjusted_sales",
                    "operation": "add",
                    "left": {"kind": "column", "value": "sales"},
                    "right": {"kind": "column", "value": "margin"},
                },
            },
            {
                "id": "group-by-1",
                "type": "group_by",
                "config": {
                    "group_by": ["segment", "category"],
                    "aggregations": [
                        {
                            "column": "adjusted_sales",
                            "op": "sum",
                            "output": "adjusted_total",
                        },
                        {
                            "column": "margin",
                            "op": "avg",
                            "output": "margin_avg",
                        },
                    ],
                },
            },
            {
                "id": "unpivot-1",
                "type": "unpivot",
                "config": {
                    "id_columns": ["segment", "category"],
                    "value_columns": ["adjusted_total", "margin_avg"],
                    "variable_column": "metric",
                    "value_column": "amount",
                },
            },
            {
                "id": "pivot-1",
                "type": "pivot",
                "config": {
                    "index_columns": ["segment", "category"],
                    "columns_column": "metric",
                    "value_column": "amount",
                    "aggregation": "sum",
                    "pivot_values": [
                        {"value": "adjusted_total", "output": "adjusted_total"},
                        {"value": "margin_avg", "output": "margin_avg"},
                    ],
                },
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {
                "id": "e-orders",
                "source": "orders",
                "target": "join-1",
                "target_port": "left",
            },
            {
                "id": "e-segments",
                "source": "segments",
                "target": "join-1",
                "target_port": "right",
            },
            {"id": "e-filter", "source": "join-1", "target": "filter-1"},
            {"id": "e-derived", "source": "filter-1", "target": "derived-1"},
            {"id": "e-group", "source": "derived-1", "target": "group-by-1"},
            {"id": "e-unpivot", "source": "group-by-1", "target": "unpivot-1"},
            {"id": "e-pivot", "source": "unpivot-1", "target": "pivot-1"},
            {"id": "e-out", "source": "pivot-1", "target": "out"},
        ],
    }


def _version_frame(version: DatasetVersion) -> pd.DataFrame:
    return pd.read_parquet(io.BytesIO(artifact_store[version.object_key]))


def test_phase2_full_preparation_versions_and_training_pin_exact_v1(
    client,
    auth_headers,
    monkeypatch,
):
    """Phase 2 golden path stays reproducible after a newer prepared version exists."""
    project_id = _create_project(client, auth_headers)

    orders_v1 = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "orders.csv",
        b"order_id,region,category,sales,margin\n"
        b"1,Seoul,A,100,10\n"
        b"2,Seoul,A,150,15\n"
        b"3,Busan,B,200,20\n"
        b"4,Busan,B,250,25\n"
        b"5,Incheon,A,300,30\n"
        b"6,Incheon,A,350,35\n"
        b"7,Daegu,B,400,40\n"
        b"8,Daegu,B,450,45\n",
    )
    segments_v1 = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "segments.csv",
        b"region,segment\n"
        b"Seoul,metro\n"
        b"Busan,regional\n"
        b"Incheon,coastal\n"
        b"Daegu,inland\n",
    )

    graph = _phase2_graph(
        orders_v1["id"],
        segments_v1["id"],
        segments_v1["version"]["id"],
    )
    preparation = _create_preparation(client, auth_headers, project_id, graph)
    output_dataset_id = _create_output_dataset(
        client, auth_headers, project_id, preparation["id"]
    )

    run1_body, run1 = _create_and_process_run(
        client, auth_headers, project_id, preparation["id"]
    )
    assert run1.status == DatasetPreparationRunStatus.succeeded, run1.error_message
    assert run1.output_dataset_version_id is not None

    run1_pins = {row["dataset_id"]: row["dataset_version_id"] for row in run1_body["inputs"]}
    assert run1_pins == {
        orders_v1["id"]: orders_v1["version"]["id"],
        segments_v1["id"]: segments_v1["version"]["id"],
    }

    with TestingSessionLocal() as db:
        v1 = db.get(DatasetVersion, run1.output_dataset_version_id)
        assert v1 is not None
        assert v1.dataset_id == output_dataset_id
        assert v1.version == 1
        assert v1.format == "parquet"
        assert v1.source_type == "preparation"
        assert v1.row_count == 4
        assert v1.column_count == 4
        assert json.loads(v1.columns_json) == [
            "segment",
            "category",
            "adjusted_total",
            "margin_avg",
        ]
        v1_key = v1.object_key
        v1_bytes = bytes(artifact_store[v1_key])
        v1_frame = _version_frame(v1)
        v1_version_number = v1.version

    assert v1_frame["segment"].tolist() == ["metro", "regional", "coastal", "inland"]
    assert v1_frame["category"].tolist() == ["A", "B", "A", "B"]
    assert v1_frame["adjusted_total"].tolist() == pytest.approx([275, 495, 715, 935])
    assert v1_frame["margin_avg"].tolist() == pytest.approx([12.5, 22.5, 32.5, 42.5])

    lineage = client.get(
        f"/api/v1/projects/{project_id}/datasets/{output_dataset_id}/versions/{v1_version_number}/lineage",
        headers=auth_headers,
    )
    assert lineage.status_code == 200, lineage.text
    upstream = lineage.json()["upstream"]
    assert upstream["preparation"]["id"] == preparation["id"]
    assert upstream["preparation_run"]["id"] == run1.id
    lineage_pins = {
        row["dataset_id"]: row["dataset_version_id"]
        for row in upstream["input_versions"]
    }
    assert lineage_pins == run1_pins

    orders_v2 = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "orders.csv",
        b"order_id,region,category,sales,margin\n"
        b"1,Seoul,A,1000,10\n"
        b"2,Seoul,A,150,15\n"
        b"3,Busan,B,200,20\n"
        b"4,Busan,B,250,25\n"
        b"5,Incheon,A,300,30\n"
        b"6,Incheon,A,350,35\n"
        b"7,Daegu,B,400,40\n"
        b"8,Daegu,B,450,45\n",
    )
    assert orders_v2["id"] == orders_v1["id"]
    assert orders_v2["version"]["id"] != orders_v1["version"]["id"]
    assert orders_v2["latest_version"] == 2

    run2_body, run2 = _create_and_process_run(
        client, auth_headers, project_id, preparation["id"]
    )
    assert run2.status == DatasetPreparationRunStatus.succeeded, run2.error_message
    assert run2.output_dataset_version_id is not None
    assert run2.output_dataset_version_id != run1.output_dataset_version_id

    run2_pins = {row["dataset_id"]: row["dataset_version_id"] for row in run2_body["inputs"]}
    assert run2_pins == {
        orders_v1["id"]: orders_v2["version"]["id"],
        segments_v1["id"]: segments_v1["version"]["id"],
    }

    with TestingSessionLocal() as db:
        v2 = db.get(DatasetVersion, run2.output_dataset_version_id)
        assert v2 is not None
        assert v2.dataset_id == output_dataset_id
        assert v2.version == 2
        assert v2.object_key != v1_key
        v2_key = v2.object_key
        v2_frame = _version_frame(v2)
        output_dataset = db.get(Dataset, output_dataset_id)
        assert output_dataset is not None
        assert output_dataset.latest_version == 2

        historical_v1 = db.get(DatasetVersion, run1.output_dataset_version_id)
        assert historical_v1 is not None
        assert historical_v1.version == 1
        assert historical_v1.object_key == v1_key
        assert artifact_store[v1_key] == v1_bytes
        historical_v1_frame = _version_frame(historical_v1)

    pd.testing.assert_frame_equal(historical_v1_frame, v1_frame)
    assert v2_frame["adjusted_total"].tolist() == pytest.approx([1175, 495, 715, 935])
    assert v2_frame["margin_avg"].tolist() == pytest.approx([12.5, 22.5, 32.5, 42.5])
    assert not v2_frame.equals(v1_frame)

    captured: list[TrainingJobContext] = []

    class _FakeRunner:
        def run(self, ctx: TrainingJobContext) -> TrainingResult:
            captured.append(ctx)
            return TrainingResult(
                mlflow_run_id="phase2-g-train-v1",
                model_uri="models:/phase2-g/1",
                metrics={"rmse": 0.0},
                logs="ok",
                params={},
            )

    monkeypatch.setattr(runner, "get_training_runner", lambda: _FakeRunner())

    create_job = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json={
            "name": "train-historical-prepared-v1",
            "dataset_id": output_dataset_id,
            "dataset_version_id": run1.output_dataset_version_id,
            "target_column": "adjusted_total",
            "feature_columns": ["margin_avg"],
            "algorithm": "random_forest",
            "problem_type": "regression",
            "hyperparameters": {"n_estimators": 5, "max_depth": 2},
        },
    )
    assert create_job.status_code == 201, create_job.text
    job_body = create_job.json()
    assert job_body["dataset_version_id"] == run1.output_dataset_version_id
    assert job_body["dataset_id"] == output_dataset_id

    runner.process_job(type("Claim", (), {"id": job_body["id"]})())

    with TestingSessionLocal() as db:
        job = db.get(TrainingJob, job_body["id"])
        assert job is not None
        assert job.status == JobStatus.succeeded, getattr(job, "error_message", None)
        assert job.dataset_version_id == run1.output_dataset_version_id
        assert db.get(Dataset, output_dataset_id).latest_version == 2

    assert len(captured) == 1
    ctx = captured[0]
    assert ctx.dataset_version_id == run1.output_dataset_version_id
    assert ctx.data_format == "parquet"
    assert ctx.csv_bytes == v1_bytes
    assert ctx.csv_bytes == artifact_store[v1_key]
    assert ctx.csv_bytes != artifact_store[v2_key]

    training_frame = pd.read_parquet(io.BytesIO(ctx.csv_bytes))
    pd.testing.assert_frame_equal(training_frame, v1_frame)
    assert training_frame["adjusted_total"].tolist() == pytest.approx([275, 495, 715, 935])
    assert training_frame["adjusted_total"].tolist() != v2_frame["adjusted_total"].tolist()

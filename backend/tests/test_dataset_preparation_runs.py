"""Phase 2-C Dataset Preparation run APIs + worker materialization tests."""

from __future__ import annotations

import importlib.util
import secrets
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import (
    Base,
    Dataset,
    DatasetPreparationRun,
    DatasetPreparationRunStatus,
    DatasetVersion,
    ProjectMembership,
    ProjectRole,
    User,
)
from app.db.session import get_db
from app.main import app
from app.services import mlflow_service, registry_service, storage
from app.workers import runner

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
ADMIN_PASSWORD = secrets.token_urlsafe(24)
VIEWER_PASSWORD = secrets.token_urlsafe(24)
SCIENTIST_PASSWORD = secrets.token_urlsafe(24)

artifact_store: dict[str, bytes] = {}

BACKEND = Path(__file__).resolve().parents[1]
MIGRATION_013 = (
    BACKEND / "alembic" / "versions" / "013_prep_run_output_dataset.py"
)


def _csv_n(n: int) -> bytes:
    lines = ["id,value"] + [f"{i},{i * 10}" for i in range(n)]
    return ("\n".join(lines) + "\n").encode()


@pytest.fixture(autouse=True)
def setup_api(monkeypatch):
    Base.metadata.create_all(engine)
    artifact_store.clear()

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
    monkeypatch.setattr(
        storage, "download_bytes", lambda bucket, key: artifact_store[key]
    )
    monkeypatch.setattr(
        storage, "delete_object", lambda bucket, key: artifact_store.pop(key, None)
    )
    monkeypatch.setattr(mlflow_service, "ensure_experiment", lambda name: "exp-1")
    monkeypatch.setattr(
        registry_service, "_mlflow_logged_feature_schema", lambda run_id: []
    )
    monkeypatch.setattr(runner, "SessionLocal", TestingSessionLocal)
    monkeypatch.setattr("app.db.session.SessionLocal", TestingSessionLocal)

    with TestingSessionLocal() as db:
        admin = User(
            email="admin@example.com",
            full_name="Admin",
            password_hash=hash_password(ADMIN_PASSWORD),
            is_active=True,
            is_system_admin=True,
        )
        viewer = User(
            email="viewer@example.com",
            full_name="Viewer",
            password_hash=hash_password(VIEWER_PASSWORD),
            is_active=True,
        )
        scientist = User(
            email="scientist@example.com",
            full_name="Scientist",
            password_hash=hash_password(SCIENTIST_PASSWORD),
            is_active=True,
        )
        db.add_all([admin, viewer, scientist])
        db.commit()
    yield
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)


@pytest.fixture
def client():
    return TestClient(app)


def _login(client, email: str, password: str) -> dict[str, str]:
    response = client.post(
        "/api/v1/auth/login", json={"email": email, "password": password}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture
def auth_headers(client):
    return _login(client, "admin@example.com", ADMIN_PASSWORD)


def _create_project(client, auth_headers, *, role: ProjectRole | None = None) -> int:
    response = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": f"prep-run-{secrets.token_hex(4)}", "description": ""},
    )
    assert response.status_code == 201, response.text
    project_id = response.json()["id"]
    if role is not None:
        email = (
            "viewer@example.com"
            if role == ProjectRole.VIEWER
            else "scientist@example.com"
        )
        with TestingSessionLocal() as db:
            user = db.scalar(select(User).where(User.email == email))
            db.add(
                ProjectMembership(
                    project_id=project_id, user_id=user.id, role=role
                )
            )
            db.commit()
    return project_id


def _upload_dataset(
    client, auth_headers, project_id: int, name: str, csv: bytes
) -> dict:
    response = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": (name, csv, "text/csv")},
        data={"name": name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _source_output(
    dataset_id: int, *, strategy: str = "latest", version_id: int | None = None
) -> dict:
    config: dict = {"dataset_id": dataset_id, "version_strategy": strategy}
    if strategy == "fixed":
        config["dataset_version_id"] = version_id
    return {
        "schema_version": 1,
        "nodes": [
            {"id": "src-a", "type": "source", "config": config},
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [{"id": "e1", "source": "src-a", "target": "out"}],
    }


def _create_prep(client, auth_headers, project_id: int, graph: dict, name: str = "Prep"):
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={"name": name, "description": "", "graph": graph},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _create_output_dataset(client, auth_headers, project_id: int, prep_id: int, name: str):
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/output-dataset",
        headers=auth_headers,
        json={"name": name, "description": "prepared"},
    )
    return response


def _create_run(client, auth_headers, project_id: int, prep_id: int):
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/runs",
        headers=auth_headers,
        json={},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _execute_run(client, auth_headers, project_id: int, run_id: int):
    return client.post(
        f"/api/v1/projects/{project_id}/dataset-preparation-runs/{run_id}/execute",
        headers=auth_headers,
    )


def _claim_and_process():
    claimed = runner.claim_next_preparation_run()
    assert claimed is not None
    runner.process_preparation_run(claimed)
    return claimed


def _join_graph(left_id: int, left_vid: int, right_id: int, right_vid: int) -> dict:
    return {
        "schema_version": 1,
        "nodes": [
            {
                "id": "left",
                "type": "source",
                "config": {
                    "dataset_id": left_id,
                    "version_strategy": "fixed",
                    "dataset_version_id": left_vid,
                },
            },
            {
                "id": "right",
                "type": "source",
                "config": {
                    "dataset_id": right_id,
                    "version_strategy": "fixed",
                    "dataset_version_id": right_vid,
                },
            },
            {
                "id": "join-1",
                "type": "join",
                "config": {
                    "how": "left",
                    "left_on": ["customer_id"],
                    "right_on": ["customer_id"],
                },
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e-left", "source": "left", "target": "join-1", "target_port": "left"},
            {
                "id": "e-right",
                "source": "right",
                "target": "join-1",
                "target_port": "right",
            },
            {"id": "e-out", "source": "join-1", "target": "out"},
        ],
    }


def _union_graph(
    a_id: int,
    a_vid: int,
    b_id: int,
    b_vid: int,
    *,
    mode: str,
) -> dict:
    return {
        "schema_version": 1,
        "nodes": [
            {
                "id": "a",
                "type": "source",
                "config": {
                    "dataset_id": a_id,
                    "version_strategy": "fixed",
                    "dataset_version_id": a_vid,
                },
            },
            {
                "id": "b",
                "type": "source",
                "config": {
                    "dataset_id": b_id,
                    "version_strategy": "fixed",
                    "dataset_version_id": b_vid,
                },
            },
            {"id": "union-1", "type": "union", "config": {"mode": mode}},
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e-a", "source": "a", "target": "union-1"},
            {"id": "e-b", "source": "b", "target": "union-1"},
            {"id": "e-out", "source": "union-1", "target": "out"},
        ],
    }


# ---------------------------------------------------------------------------
# A. Migration 013
# ---------------------------------------------------------------------------


def _load_migration_013():
    spec = importlib.util.spec_from_file_location(
        "migration_013_prep_run_output_dataset", MIGRATION_013
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_013_module_contract():
    migration = _load_migration_013()
    assert migration.revision == "013_prep_run_output_dataset"
    assert migration.down_revision == "012_dataset_prep_foundation"
    assert callable(migration.upgrade)
    assert callable(migration.downgrade)

    source = MIGRATION_013.read_text()
    assert "output_dataset_id" in source
    assert "batch_alter_table" in source or "op.add_column" in source
    assert "fk_dataset_preparation_runs_output_dataset_id" in source
    assert "ix_dataset_preparation_runs_output_dataset_id" in source
    assert "drop_column" in source and "output_dataset_id" in source


def test_migration_013_model_has_output_dataset_pin():
    """ORM model includes the Phase 2-C run output pin column."""
    from app.db.models import DatasetPreparationRun

    assert "output_dataset_id" in DatasetPreparationRun.__table__.c
    assert DatasetPreparationRun.__table__.c.output_dataset_id.nullable is True


# ---------------------------------------------------------------------------
# B / C. Output dataset create + assign
# ---------------------------------------------------------------------------


def test_output_dataset_create_api(client, auth_headers):
    project_id = _create_project(client, auth_headers, role=ProjectRole.VIEWER)
    source = _upload_dataset(
        client, auth_headers, project_id, "src.csv", b"a,b\n1,2\n"
    )
    prep = _create_prep(
        client, auth_headers, project_id, _source_output(source["id"]), name="OutPrep"
    )

    created = _create_output_dataset(
        client, auth_headers, project_id, prep["id"], "Prepared Out"
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["output_dataset"]["latest_version"] == 0
    assert body["preparation"]["output_dataset_id"] == body["output_dataset"]["id"]

    dup = _create_output_dataset(
        client, auth_headers, project_id, prep["id"], "Prepared Out"
    )
    assert dup.status_code == 409

    viewer = _login(client, "viewer@example.com", VIEWER_PASSWORD)
    denied = _create_output_dataset(
        client, viewer, project_id, prep["id"], "Viewer Out"
    )
    assert denied.status_code == 403


def test_assign_existing_output_via_patch(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    other_project = _create_project(client, auth_headers)
    source = _upload_dataset(
        client, auth_headers, project_id, "src.csv", b"a,b\n1,2\n"
    )
    same_project_ds = _upload_dataset(
        client, auth_headers, project_id, "out.csv", b"a,b\n1,2\n"
    )
    cross_ds = _upload_dataset(
        client, auth_headers, other_project, "cross.csv", b"a,b\n1,2\n"
    )
    prep = _create_prep(
        client, auth_headers, project_id, _source_output(source["id"]), name="Assign"
    )

    ok = client.patch(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}",
        headers=auth_headers,
        json={"output_dataset_id": same_project_ds["id"]},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["output_dataset_id"] == same_project_ds["id"]

    cross = client.patch(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}",
        headers=auth_headers,
        json={"output_dataset_id": cross_ds["id"]},
    )
    assert cross.status_code == 404


# ---------------------------------------------------------------------------
# D / E / F. Run create, legacy pin, queue lifecycle
# ---------------------------------------------------------------------------


def test_run_create_copies_output_dataset_id(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    source = _upload_dataset(
        client, auth_headers, project_id, "src.csv", b"a,b\n1,2\n"
    )
    prep = _create_prep(
        client, auth_headers, project_id, _source_output(source["id"]), name="CopyOut"
    )
    out = _create_output_dataset(
        client, auth_headers, project_id, prep["id"], "Out DS"
    )
    assert out.status_code == 201
    output_id = out.json()["output_dataset"]["id"]

    run = _create_run(client, auth_headers, project_id, prep["id"])
    assert run["output_dataset_id"] == output_id
    assert run["status"] == "created"


def test_legacy_run_output_null_pins_on_execute(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    source = _upload_dataset(
        client, auth_headers, project_id, "src.csv", b"a,b\n1,2\n"
    )
    prep = _create_prep(
        client, auth_headers, project_id, _source_output(source["id"]), name="Legacy"
    )
    out = _create_output_dataset(
        client, auth_headers, project_id, prep["id"], "Legacy Out"
    )
    output_id = out.json()["output_dataset"]["id"]
    run = _create_run(client, auth_headers, project_id, prep["id"])

    with TestingSessionLocal() as db:
        row = db.get(DatasetPreparationRun, run["id"])
        row.output_dataset_id = None
        db.commit()

    queued = _execute_run(client, auth_headers, project_id, run["id"])
    assert queued.status_code == 202, queued.text
    body = queued.json()
    assert body["status"] == "queued"
    assert body["output_dataset_id"] == output_id


def test_created_to_queued_and_double_execute_409(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    source = _upload_dataset(
        client, auth_headers, project_id, "src.csv", b"a,b\n1,2\n"
    )
    prep = _create_prep(
        client, auth_headers, project_id, _source_output(source["id"]), name="Queue"
    )
    _create_output_dataset(client, auth_headers, project_id, prep["id"], "Q Out")
    run = _create_run(client, auth_headers, project_id, prep["id"])
    assert run["status"] == "created"

    first = _execute_run(client, auth_headers, project_id, run["id"])
    assert first.status_code == 202
    assert first.json()["status"] == "queued"

    second = _execute_run(client, auth_headers, project_id, run["id"])
    assert second.status_code == 409


# ---------------------------------------------------------------------------
# G. claim_next_preparation_run
# ---------------------------------------------------------------------------


def test_claim_next_preparation_run_skips_created(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    source = _upload_dataset(
        client, auth_headers, project_id, "src.csv", b"a,b\n1,2\n"
    )
    prep = _create_prep(
        client, auth_headers, project_id, _source_output(source["id"]), name="Claim"
    )
    _create_output_dataset(client, auth_headers, project_id, prep["id"], "Claim Out")
    run = _create_run(client, auth_headers, project_id, prep["id"])

    assert runner.claim_next_preparation_run() is None

    queued = _execute_run(client, auth_headers, project_id, run["id"])
    assert queued.status_code == 202

    claimed = runner.claim_next_preparation_run()
    assert claimed is not None
    assert claimed.id == run["id"]
    assert claimed.status == DatasetPreparationRunStatus.running

    with TestingSessionLocal() as db:
        live = db.get(DatasetPreparationRun, run["id"])
        assert live.status == DatasetPreparationRunStatus.running


# ---------------------------------------------------------------------------
# H. Full materialization 150+ rows
# ---------------------------------------------------------------------------


def test_full_materialization_150_rows(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    source = _upload_dataset(
        client, auth_headers, project_id, "big.csv", _csv_n(150)
    )
    assert source["version"]["row_count"] == 150
    # Upload stores at most 100 preview rows; full artifact still has 150.
    with TestingSessionLocal() as db:
        version_row = db.get(DatasetVersion, source["version"]["id"])
        preview_rows = __import__("json").loads(version_row.preview_json or "[]")
        assert len(preview_rows) == 100

    prep = _create_prep(
        client,
        auth_headers,
        project_id,
        _source_output(source["id"], strategy="latest"),
        name="Full150",
    )
    out = _create_output_dataset(
        client, auth_headers, project_id, prep["id"], "Full Out"
    )
    output_id = out.json()["output_dataset"]["id"]
    run = _create_run(client, auth_headers, project_id, prep["id"])
    assert _execute_run(client, auth_headers, project_id, run["id"]).status_code == 202

    _claim_and_process()

    with TestingSessionLocal() as db:
        live = db.get(DatasetPreparationRun, run["id"])
        assert live.status == DatasetPreparationRunStatus.succeeded, live.error_message
        assert live.output_dataset_version_id is not None
        version = db.get(DatasetVersion, live.output_dataset_version_id)
        assert version is not None
        assert version.row_count == 150
        assert version.format == "parquet"
        assert version.source_type == "preparation"
        dataset = db.get(Dataset, output_id)
        assert dataset.latest_version == 1


# ---------------------------------------------------------------------------
# I. Pinned latest stability
# ---------------------------------------------------------------------------


def test_pinned_latest_stability_uses_v1_after_v2_upload(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    v1 = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "pin.csv",
        b"id,value\n1,100\n2,200\n",
    )
    prep = _create_prep(
        client,
        auth_headers,
        project_id,
        _source_output(v1["id"], strategy="latest"),
        name="PinStable",
    )
    _create_output_dataset(client, auth_headers, project_id, prep["id"], "Pin Out")
    run = _create_run(client, auth_headers, project_id, prep["id"])
    assert run["inputs"][0]["dataset_version_id"] == v1["version"]["id"]

    v2 = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "pin.csv",
        b"id,value\n9,999\n",
    )
    assert v2["latest_version"] == 2
    assert v2["version"]["id"] != v1["version"]["id"]

    assert _execute_run(client, auth_headers, project_id, run["id"]).status_code == 202
    _claim_and_process()

    with TestingSessionLocal() as db:
        live = db.get(DatasetPreparationRun, run["id"])
        assert live.status == DatasetPreparationRunStatus.succeeded, live.error_message
        out_version = db.get(DatasetVersion, live.output_dataset_version_id)
        assert out_version.row_count == 2
        frame = pd.read_parquet(
            __import__("io").BytesIO(artifact_store[out_version.object_key])
        )
        assert set(frame["value"].tolist()) == {100, 200}


# ---------------------------------------------------------------------------
# J / K. Join + Union full execution
# ---------------------------------------------------------------------------


def test_join_full_execution(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    left = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "left.csv",
        b"customer_id,amount\n1,10\n2,20\n",
    )
    right = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "right.csv",
        b"customer_id,name\n1,Ada\n2,Bob\n",
    )
    graph = _join_graph(
        left["id"], left["version"]["id"], right["id"], right["version"]["id"]
    )
    prep = _create_prep(client, auth_headers, project_id, graph, name="JoinFull")
    _create_output_dataset(client, auth_headers, project_id, prep["id"], "Join Out")
    run = _create_run(client, auth_headers, project_id, prep["id"])
    assert _execute_run(client, auth_headers, project_id, run["id"]).status_code == 202
    _claim_and_process()

    with TestingSessionLocal() as db:
        live = db.get(DatasetPreparationRun, run["id"])
        assert live.status == DatasetPreparationRunStatus.succeeded, live.error_message
        out_version = db.get(DatasetVersion, live.output_dataset_version_id)
        assert out_version.row_count == 2
        assert out_version.column_count >= 3


def test_union_strict_and_align_by_name_full(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    a = _upload_dataset(
        client, auth_headers, project_id, "a.csv", b"id,value\n1,10\n"
    )
    b_strict = _upload_dataset(
        client, auth_headers, project_id, "b.csv", b"id,value\n2,20\n"
    )
    c_align = _upload_dataset(
        client, auth_headers, project_id, "c.csv", b"id,extra\n3,99\n"
    )

    strict_graph = _union_graph(
        a["id"], a["version"]["id"], b_strict["id"], b_strict["version"]["id"], mode="strict"
    )
    prep_strict = _create_prep(
        client, auth_headers, project_id, strict_graph, name="UnionStrict"
    )
    _create_output_dataset(
        client, auth_headers, project_id, prep_strict["id"], "Union Strict Out"
    )
    run_strict = _create_run(client, auth_headers, project_id, prep_strict["id"])
    assert (
        _execute_run(client, auth_headers, project_id, run_strict["id"]).status_code
        == 202
    )
    _claim_and_process()
    with TestingSessionLocal() as db:
        live = db.get(DatasetPreparationRun, run_strict["id"])
        assert live.status == DatasetPreparationRunStatus.succeeded, live.error_message
        assert db.get(DatasetVersion, live.output_dataset_version_id).row_count == 2

    align_graph = _union_graph(
        a["id"], a["version"]["id"], c_align["id"], c_align["version"]["id"], mode="align_by_name"
    )
    prep_align = _create_prep(
        client, auth_headers, project_id, align_graph, name="UnionAlign"
    )
    _create_output_dataset(
        client, auth_headers, project_id, prep_align["id"], "Union Align Out"
    )
    run_align = _create_run(client, auth_headers, project_id, prep_align["id"])
    assert (
        _execute_run(client, auth_headers, project_id, run_align["id"]).status_code
        == 202
    )
    _claim_and_process()
    with TestingSessionLocal() as db:
        live = db.get(DatasetPreparationRun, run_align["id"])
        assert live.status == DatasetPreparationRunStatus.succeeded, live.error_message
        out_version = db.get(DatasetVersion, live.output_dataset_version_id)
        assert out_version.row_count == 2
        cols = set(__import__("json").loads(out_version.columns_json))
        assert "id" in cols
        assert "value" in cols or "extra" in cols


# ---------------------------------------------------------------------------
# L / M. Success parquet + failure invalid cast
# ---------------------------------------------------------------------------


def test_success_parquet_source_type_and_latest_version(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    source = _upload_dataset(
        client, auth_headers, project_id, "ok.csv", b"a,b\n1,2\n3,4\n"
    )
    prep = _create_prep(
        client, auth_headers, project_id, _source_output(source["id"]), name="Success"
    )
    out = _create_output_dataset(
        client, auth_headers, project_id, prep["id"], "Success Out"
    )
    output_id = out.json()["output_dataset"]["id"]
    run = _create_run(client, auth_headers, project_id, prep["id"])
    assert _execute_run(client, auth_headers, project_id, run["id"]).status_code == 202
    _claim_and_process()

    with TestingSessionLocal() as db:
        live = db.get(DatasetPreparationRun, run["id"])
        assert live.status == DatasetPreparationRunStatus.succeeded
        version = db.get(DatasetVersion, live.output_dataset_version_id)
        assert version.format == "parquet"
        assert version.source_type == "preparation"
        assert version.object_key in artifact_store
        dataset = db.get(Dataset, output_id)
        assert dataset.latest_version == version.version == 1


def test_failure_invalid_cast_no_partial_version(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    source = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "bad.csv",
        b"label,value\nok,abc\n",
    )
    graph = {
        "schema_version": 1,
        "nodes": [
            {
                "id": "src",
                "type": "source",
                "config": {
                    "dataset_id": source["id"],
                    "version_strategy": "fixed",
                    "dataset_version_id": source["version"]["id"],
                },
            },
            {
                "id": "cast",
                "type": "cast",
                "config": {"casts": {"value": "integer"}},
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "src", "target": "cast"},
            {"id": "e2", "source": "cast", "target": "out"},
        ],
    }
    prep = _create_prep(client, auth_headers, project_id, graph, name="FailCast")
    out = _create_output_dataset(
        client, auth_headers, project_id, prep["id"], "Fail Out"
    )
    output_id = out.json()["output_dataset"]["id"]
    run = _create_run(client, auth_headers, project_id, prep["id"])
    assert _execute_run(client, auth_headers, project_id, run["id"]).status_code == 202
    _claim_and_process()

    with TestingSessionLocal() as db:
        live = db.get(DatasetPreparationRun, run["id"])
        assert live.status == DatasetPreparationRunStatus.failed
        assert live.finished_at is not None
        assert live.error_message
        assert live.output_dataset_version_id is None
        versions = db.scalars(
            select(DatasetVersion).where(DatasetVersion.dataset_id == output_id)
        ).all()
        assert versions == []
        dataset = db.get(Dataset, output_id)
        assert dataset.latest_version == 0


# ---------------------------------------------------------------------------
# N / O. Collision + repeat runs
# ---------------------------------------------------------------------------


def test_source_output_collision_execute_409(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    source = _upload_dataset(
        client, auth_headers, project_id, "both.csv", b"a,b\n1,2\n"
    )
    prep = _create_prep(
        client, auth_headers, project_id, _source_output(source["id"]), name="Collide"
    )
    # Assign the same dataset as output.
    patched = client.patch(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}",
        headers=auth_headers,
        json={"output_dataset_id": source["id"]},
    )
    assert patched.status_code == 200
    run = _create_run(client, auth_headers, project_id, prep["id"])
    resp = _execute_run(client, auth_headers, project_id, run["id"])
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    message = detail["detail"] if isinstance(detail, dict) else detail
    assert "source" in str(message).lower()


def test_repeat_run_versions_v1_v2_v3(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    source = _upload_dataset(
        client, auth_headers, project_id, "rep.csv", b"a,b\n1,2\n"
    )
    prep = _create_prep(
        client, auth_headers, project_id, _source_output(source["id"]), name="Repeat"
    )
    out = _create_output_dataset(
        client, auth_headers, project_id, prep["id"], "Repeat Out"
    )
    output_id = out.json()["output_dataset"]["id"]

    versions = []
    for _ in range(3):
        run = _create_run(client, auth_headers, project_id, prep["id"])
        assert (
            _execute_run(client, auth_headers, project_id, run["id"]).status_code == 202
        )
        _claim_and_process()
        with TestingSessionLocal() as db:
            live = db.get(DatasetPreparationRun, run["id"])
            assert live.status == DatasetPreparationRunStatus.succeeded
            version = db.get(DatasetVersion, live.output_dataset_version_id)
            versions.append(version.version)
            dataset = db.get(Dataset, output_id)
            assert dataset.latest_version == version.version

    assert versions == [1, 2, 3]


# ---------------------------------------------------------------------------
# P. Lineage upstream
# ---------------------------------------------------------------------------


def test_lineage_upstream_for_derived_null_for_upload(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    source = _upload_dataset(
        client, auth_headers, project_id, "lin.csv", b"a,b\n1,2\n"
    )
    upload_lineage = client.get(
        f"/api/v1/projects/{project_id}/datasets/{source['id']}/versions/"
        f"{source['version']['version']}/lineage",
        headers=auth_headers,
    )
    assert upload_lineage.status_code == 200, upload_lineage.text
    assert upload_lineage.json().get("upstream") is None

    prep = _create_prep(
        client, auth_headers, project_id, _source_output(source["id"]), name="Lineage"
    )
    out = _create_output_dataset(
        client, auth_headers, project_id, prep["id"], "Lineage Out"
    )
    output_id = out.json()["output_dataset"]["id"]
    run = _create_run(client, auth_headers, project_id, prep["id"])
    assert _execute_run(client, auth_headers, project_id, run["id"]).status_code == 202
    _claim_and_process()

    with TestingSessionLocal() as db:
        live = db.get(DatasetPreparationRun, run["id"])
        out_version = db.get(DatasetVersion, live.output_dataset_version_id)
        version_number = out_version.version

    derived_lineage = client.get(
        f"/api/v1/projects/{project_id}/datasets/{output_id}/versions/"
        f"{version_number}/lineage",
        headers=auth_headers,
    )
    assert derived_lineage.status_code == 200, derived_lineage.text
    upstream = derived_lineage.json()["upstream"]
    assert upstream is not None
    assert upstream["preparation"]["id"] == prep["id"]
    assert upstream["preparation_run"]["id"] == run["id"]
    assert len(upstream["input_versions"]) == 1
    assert upstream["input_versions"][0]["dataset_id"] == source["id"]


# ---------------------------------------------------------------------------
# Q. RBAC viewer / scientist
# ---------------------------------------------------------------------------


def test_rbac_viewer_read_runs_execute_denied_scientist_ok(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    with TestingSessionLocal() as db:
        viewer = db.scalar(select(User).where(User.email == "viewer@example.com"))
        scientist = db.scalar(
            select(User).where(User.email == "scientist@example.com")
        )
        db.add_all(
            [
                ProjectMembership(
                    project_id=project_id, user_id=viewer.id, role=ProjectRole.VIEWER
                ),
                ProjectMembership(
                    project_id=project_id,
                    user_id=scientist.id,
                    role=ProjectRole.DATA_SCIENTIST,
                ),
            ]
        )
        db.commit()

    source = _upload_dataset(
        client, auth_headers, project_id, "rbac.csv", b"a,b\n1,2\n"
    )
    prep = _create_prep(
        client, auth_headers, project_id, _source_output(source["id"]), name="RBAC"
    )
    _create_output_dataset(client, auth_headers, project_id, prep["id"], "RBAC Out")
    run = _create_run(client, auth_headers, project_id, prep["id"])

    viewer_headers = _login(client, "viewer@example.com", VIEWER_PASSWORD)
    scientist_headers = _login(client, "scientist@example.com", SCIENTIST_PASSWORD)

    listed = client.get(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/runs",
        headers=viewer_headers,
    )
    assert listed.status_code == 200

    denied = _execute_run(client, viewer_headers, project_id, run["id"])
    assert denied.status_code == 403

    allowed = _execute_run(client, scientist_headers, project_id, run["id"])
    assert allowed.status_code == 202
    assert allowed.json()["status"] == "queued"


# ---------------------------------------------------------------------------
# Worker regression smoke
# ---------------------------------------------------------------------------


def test_worker_claim_functions_still_exist():
    assert callable(runner.claim_next_job)
    assert callable(runner.claim_next_pipeline_run)
    assert callable(runner.claim_next_batch_job)
    assert callable(runner.claim_next_drift_run)
    assert callable(runner.claim_next_import_job)
    assert callable(runner.claim_next_preparation_run)
    assert callable(runner.process_preparation_run)

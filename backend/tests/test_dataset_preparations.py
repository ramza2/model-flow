"""Phase 2-A Dataset Preparation foundation API tests."""

from __future__ import annotations

import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import (
    Base,
    DatasetPreparationRun,
    DatasetPreparationRunInput,
    ProjectMembership,
    ProjectRole,
    User,
)
from app.db.session import get_db
from app.main import app
from app.services import mlflow_service, registry_service, storage

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
ADMIN_PASSWORD = secrets.token_urlsafe(24)
VIEWER_PASSWORD = secrets.token_urlsafe(24)
SCIENTIST_PASSWORD = secrets.token_urlsafe(24)


@pytest.fixture(autouse=True)
def setup_api(monkeypatch):
    Base.metadata.create_all(engine)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr(storage, "ensure_buckets", lambda: None)
    monkeypatch.setattr(storage, "upload_bytes", lambda *args, **kwargs: None)
    monkeypatch.setattr(mlflow_service, "ensure_experiment", lambda name: "exp-1")
    monkeypatch.setattr(
        registry_service, "_mlflow_logged_feature_schema", lambda run_id: []
    )
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
        json={"name": f"prep-{secrets.token_hex(4)}", "description": ""},
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


def _upload_dataset(client, auth_headers, project_id: int, name: str = "data.csv"):
    csv = b"customer_id,amount\n1,10\n2,20\n"
    response = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": (name, csv, "text/csv")},
        data={"name": name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _empty_graph():
    return {"schema_version": 1, "nodes": [], "edges": []}


def _source_output_graph(dataset_id: int, *, strategy: str = "latest", version_id: int | None = None):
    config: dict = {"dataset_id": dataset_id, "version_strategy": strategy}
    if strategy == "fixed":
        config["dataset_version_id"] = version_id
    return {
        "schema_version": 1,
        "nodes": [
            {"id": "src-a", "type": "source", "config": config},
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [{"id": "e1", "source": "src-a", "target": "out", "target_port": None}],
    }


def _join_graph(dataset_a: int, version_a: int, dataset_b: int, version_b: int):
    return {
        "schema_version": 1,
        "nodes": [
            {
                "id": "left",
                "type": "source",
                "config": {
                    "dataset_id": dataset_a,
                    "version_strategy": "fixed",
                    "dataset_version_id": version_a,
                },
            },
            {
                "id": "right",
                "type": "source",
                "config": {
                    "dataset_id": dataset_b,
                    "version_strategy": "fixed",
                    "dataset_version_id": version_b,
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
            {
                "id": "e-left",
                "source": "left",
                "target": "join-1",
                "target_port": "left",
            },
            {
                "id": "e-right",
                "source": "right",
                "target": "join-1",
                "target_port": "right",
            },
            {"id": "e-out", "source": "join-1", "target": "out"},
        ],
    }


def test_preparation_crud_and_duplicate_names(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    dataset = _upload_dataset(client, auth_headers, project_id)
    created = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={
            "name": "Prep One",
            "description": "desc",
            "output_dataset_id": dataset["id"],
            "graph": _empty_graph(),
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["latest_version"] == 1
    assert body["version"]["version"] == 1
    assert body["version"]["graph"]["schema_version"] == 1
    prep_id = body["id"]

    listed = client.get(
        f"/api/v1/projects/{project_id}/dataset-preparations", headers=auth_headers
    )
    assert listed.status_code == 200
    assert any(row["id"] == prep_id for row in listed.json())

    got = client.get(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}",
        headers=auth_headers,
    )
    assert got.status_code == 200
    assert got.json()["version"]["version"] == 1

    patched = client.patch(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}",
        headers=auth_headers,
        json={"description": "updated"},
    )
    assert patched.status_code == 200
    assert patched.json()["description"] == "updated"

    dup = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={"name": "Prep One", "graph": _empty_graph()},
    )
    assert dup.status_code == 409

    dup_case = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={"name": "prep one", "graph": _empty_graph()},
    )
    assert dup_case.status_code == 409

    other = _create_project(client, auth_headers)
    other_ds = _upload_dataset(client, auth_headers, other, name="other.csv")
    cross = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={
            "name": "Cross",
            "output_dataset_id": other_ds["id"],
            "graph": _empty_graph(),
        },
    )
    assert cross.status_code == 404

    deleted = client.delete(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}",
        headers=auth_headers,
    )
    assert deleted.status_code == 200


def test_immutable_versioning(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    created = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={
            "name": "Vers",
            "graph": {
                "schema_version": 1,
                "nodes": [{"id": "a", "type": "output", "config": {}}],
                "edges": [],
            },
        },
    )
    assert created.status_code == 201
    prep_id = created.json()["id"]
    v1_graph = created.json()["version"]["graph"]

    v2 = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/versions",
        headers=auth_headers,
        json={
            "graph": {
                "schema_version": 1,
                "nodes": [{"id": "b", "type": "output", "config": {}}],
                "edges": [],
            }
        },
    )
    assert v2.status_code == 201
    v3 = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/versions",
        headers=auth_headers,
        json={"graph": _empty_graph()},
    )
    assert v3.status_code == 201
    assert v3.json()["version"] == 3

    got = client.get(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}",
        headers=auth_headers,
    )
    assert got.json()["latest_version"] == 3

    versions = client.get(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/versions",
        headers=auth_headers,
    ).json()
    assert [row["version"] for row in versions] == [3, 2, 1]
    assert versions[2]["graph"] == v1_graph

    historical = client.get(
        f"/api/v1/projects/{project_id}/dataset-preparation-versions/{versions[2]['id']}",
        headers=auth_headers,
    )
    assert historical.status_code == 200
    assert historical.json()["graph"]["nodes"][0]["id"] == "a"


def test_structural_validation_errors(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    created = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={"name": "Val", "graph": _empty_graph()},
    )
    prep_id = created.json()["id"]

    cases = [
        {
            "nodes": [
                {"id": "a", "type": "source", "config": {}},
                {"id": "a", "type": "output", "config": {}},
            ],
            "edges": [],
        },
        {
            "nodes": [{"id": "a", "type": "output", "config": {}}],
            "edges": [
                {"id": "e", "source": "a", "target": "a"},
                {"id": "e", "source": "a", "target": "a"},
            ],
        },
        {
            "nodes": [{"id": "a", "type": "output", "config": {}}],
            "edges": [{"id": "e", "source": "missing", "target": "a"}],
        },
        {
            "nodes": [{"id": "a", "type": "output", "config": {}}],
            "edges": [{"id": "e", "source": "a", "target": "a"}],
        },
        {
            "nodes": [
                {"id": "a", "type": "source", "config": {}},
                {"id": "b", "type": "output", "config": {}},
            ],
            "edges": [
                {"id": "e1", "source": "a", "target": "b"},
                {"id": "e2", "source": "b", "target": "a"},
            ],
        },
        {
            "nodes": [{"id": "a", "type": "magic", "config": {}}],
            "edges": [],
        },
        {
            "nodes": [
                {
                    "id": "a",
                    "type": "source",
                    "config": {"dataset_id": 1, "version_strategy": "nope"},
                }
            ],
            "edges": [],
        },
        {
            "nodes": [
                {
                    "id": "j",
                    "type": "join",
                    "config": {"how": "outer", "left_on": ["a"], "right_on": ["a"]},
                }
            ],
            "edges": [],
        },
        {
            "nodes": [{"id": "u", "type": "union", "config": {"mode": "weird"}}],
            "edges": [],
        },
    ]
    for graph_body in cases:
        response = client.post(
            f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/versions",
            headers=auth_headers,
            json={"graph": {"schema_version": 1, **graph_body}},
        )
        assert response.status_code in (400, 422), (graph_body, response.text)


def test_strict_validation_and_validate_endpoint(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    dataset = _upload_dataset(client, auth_headers, project_id)
    created = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={"name": "Strict", "graph": _empty_graph()},
    )
    prep_id = created.json()["id"]

    incomplete = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/validate",
        headers=auth_headers,
        json={"graph": _empty_graph()},
    )
    assert incomplete.status_code == 200
    assert incomplete.json()["valid"] is False
    assert incomplete.json()["errors"]

    good = _source_output_graph(dataset["id"], strategy="latest")
    ok = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/validate",
        headers=auth_headers,
        json={"graph": good},
    )
    assert ok.status_code == 200
    assert ok.json()["valid"] is True

    # save incomplete non-strict ok
    saved = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/versions",
        headers=auth_headers,
        json={
            "graph": {
                "schema_version": 1,
                "nodes": [
                    {
                        "id": "src",
                        "type": "source",
                        "config": {
                            "dataset_id": dataset["id"],
                            "version_strategy": "latest",
                        },
                    },
                    {"id": "out", "type": "output", "config": {}},
                    {"id": "orphan", "type": "union", "config": {"mode": "strict"}},
                ],
                "edges": [{"id": "e1", "source": "src", "target": "out"}],
            }
        },
    )
    assert saved.status_code == 201

    strict_fail = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/validate",
        headers=auth_headers,
    )
    assert strict_fail.status_code == 200
    assert strict_fail.json()["valid"] is False


def test_source_ownership_and_pinning(client, auth_headers):
    project_a = _create_project(client, auth_headers)
    project_b = _create_project(client, auth_headers)
    ds_a = _upload_dataset(client, auth_headers, project_a, name="a.csv")
    ds_b = _upload_dataset(client, auth_headers, project_b, name="b.csv")
    version_a1 = ds_a["version"]["id"]

    # upload second version for latest pinning
    second = client.post(
        f"/api/v1/projects/{project_a}/datasets",
        headers=auth_headers,
        files={"file": ("a.csv", b"customer_id,amount\n3,30\n", "text/csv")},
        data={"name": "a.csv"},
    )
    assert second.status_code == 201
    version_a2 = second.json()["version"]["id"]
    assert second.json()["latest_version"] == 2

    created = client.post(
        f"/api/v1/projects/{project_a}/dataset-preparations",
        headers=auth_headers,
        json={
            "name": "Pins",
            "graph": _source_output_graph(ds_a["id"], strategy="latest"),
        },
    )
    assert created.status_code == 201
    prep_id = created.json()["id"]

    # cross-project dataset rejected on version save
    bad = client.post(
        f"/api/v1/projects/{project_a}/dataset-preparations/{prep_id}/versions",
        headers=auth_headers,
        json={"graph": _source_output_graph(ds_b["id"], strategy="latest")},
    )
    assert bad.status_code == 400

    # mismatched fixed version
    mismatch = client.post(
        f"/api/v1/projects/{project_a}/dataset-preparations/{prep_id}/versions",
        headers=auth_headers,
        json={
            "graph": _source_output_graph(
                ds_a["id"], strategy="fixed", version_id=ds_b["version"]["id"]
            )
        },
    )
    assert mismatch.status_code == 400

    # Run #1 latest -> v2
    run1 = client.post(
        f"/api/v1/projects/{project_a}/dataset-preparations/{prep_id}/runs",
        headers=auth_headers,
        json={"version": None},
    )
    assert run1.status_code == 201, run1.text
    assert run1.json()["status"] == "created"
    assert run1.json()["inputs"][0]["dataset_version_id"] == version_a2
    assert run1.json()["inputs"][0]["version_strategy"] == "latest"
    run1_id = run1.json()["id"]

    # upload v3
    third = client.post(
        f"/api/v1/projects/{project_a}/datasets",
        headers=auth_headers,
        files={"file": ("a.csv", b"customer_id,amount\n4,40\n", "text/csv")},
        data={"name": "a.csv"},
    )
    assert third.status_code == 201
    version_a3 = third.json()["version"]["id"]

    run2 = client.post(
        f"/api/v1/projects/{project_a}/dataset-preparations/{prep_id}/runs",
        headers=auth_headers,
        json={},
    )
    assert run2.status_code == 201
    assert run2.json()["inputs"][0]["dataset_version_id"] == version_a3

    # run1 unchanged
    got = client.get(
        f"/api/v1/projects/{project_a}/dataset-preparation-runs/{run1_id}",
        headers=auth_headers,
    )
    assert got.json()["inputs"][0]["dataset_version_id"] == version_a2

    # fixed always pins v1 even if latest is v3
    fixed_version = client.post(
        f"/api/v1/projects/{project_a}/dataset-preparations/{prep_id}/versions",
        headers=auth_headers,
        json={
            "graph": _source_output_graph(
                ds_a["id"], strategy="fixed", version_id=version_a1
            )
        },
    )
    assert fixed_version.status_code == 201
    fixed_run = client.post(
        f"/api/v1/projects/{project_a}/dataset-preparations/{prep_id}/runs",
        headers=auth_headers,
        json={"version": fixed_version.json()["version"]},
    )
    assert fixed_run.status_code == 201
    assert fixed_run.json()["inputs"][0]["dataset_version_id"] == version_a1
    assert fixed_run.json()["inputs"][0]["version_strategy"] == "fixed"


def test_repeated_source_and_historical_version_run(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    ds = _upload_dataset(client, auth_headers, project_id)
    version_id = ds["version"]["id"]
    graph_v1 = {
        "schema_version": 1,
        "nodes": [
            {
                "id": "source-a",
                "type": "source",
                "config": {
                    "dataset_id": ds["id"],
                    "version_strategy": "fixed",
                    "dataset_version_id": version_id,
                },
            },
            {
                "id": "source-b",
                "type": "source",
                "config": {
                    "dataset_id": ds["id"],
                    "version_strategy": "fixed",
                    "dataset_version_id": version_id,
                },
            },
            {
                "id": "union-1",
                "type": "union",
                "config": {"mode": "align_by_name"},
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "source-a", "target": "union-1"},
            {"id": "e2", "source": "source-b", "target": "union-1"},
            {"id": "e3", "source": "union-1", "target": "out"},
        ],
    }
    created = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={"name": "Repeat", "graph": graph_v1},
    )
    assert created.status_code == 201
    prep_id = created.json()["id"]
    v1_id = created.json()["version"]["id"]

    # v2 different graph
    v2 = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/versions",
        headers=auth_headers,
        json={
            "graph": _source_output_graph(
                ds["id"], strategy="fixed", version_id=version_id
            )
        },
    )
    assert v2.status_code == 201

    run = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/runs",
        headers=auth_headers,
        json={"version": 1},
    )
    assert run.status_code == 201
    assert run.json()["preparation_version_id"] == v1_id
    inputs = run.json()["inputs"]
    assert len(inputs) == 2
    assert {row["node_id"] for row in inputs} == {"source-a", "source-b"}
    assert all(row["dataset_version_id"] == version_id for row in inputs)

    listed = client.get(
        f"/api/v1/projects/{project_id}/dataset-preparation-runs/{run.json()['id']}/inputs",
        headers=auth_headers,
    )
    assert [row["node_id"] for row in listed.json()] == ["source-a", "source-b"]


def _assert_no_run_rows():
    with TestingSessionLocal() as db:
        run_count = db.scalar(select(func.count()).select_from(DatasetPreparationRun))
        input_count = db.scalar(
            select(func.count()).select_from(DatasetPreparationRunInput)
        )
        assert run_count == 0
        assert input_count == 0


def test_run_create_latest_missing_when_latest_version_zero(client, auth_headers):
    from app.db.models import Dataset

    project_id = _create_project(client, auth_headers)
    ds = _upload_dataset(client, auth_headers, project_id)
    created = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={
            "name": "LatestZero",
            "graph": _source_output_graph(ds["id"], strategy="latest"),
        },
    )
    assert created.status_code == 201
    prep_id = created.json()["id"]

    with TestingSessionLocal() as db:
        dataset = db.get(Dataset, ds["id"])
        dataset.latest_version = 0
        db.commit()

    failed = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/runs",
        headers=auth_headers,
        json={},
    )
    assert failed.status_code == 409, failed.text
    _assert_no_run_rows()


def test_run_create_latest_missing_when_version_row_absent(client, auth_headers):
    from app.db.models import Dataset

    project_id = _create_project(client, auth_headers)
    ds = _upload_dataset(client, auth_headers, project_id)
    created = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={
            "name": "LatestMissingRow",
            "graph": _source_output_graph(ds["id"], strategy="latest"),
        },
    )
    assert created.status_code == 201
    prep_id = created.json()["id"]

    with TestingSessionLocal() as db:
        dataset = db.get(Dataset, ds["id"])
        dataset.latest_version = 99
        db.commit()

    failed = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/runs",
        headers=auth_headers,
        json={},
    )
    assert failed.status_code == 409, failed.text
    _assert_no_run_rows()


def test_strict_validation_case_matrix(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    ds = _upload_dataset(client, auth_headers, project_id)
    created = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={"name": "StrictMatrix", "graph": _empty_graph()},
    )
    assert created.status_code == 201
    prep_id = created.json()["id"]
    dataset_id = ds["id"]
    version_id = ds["version"]["id"]

    cases = {
        "no_source": {
            "schema_version": 1,
            "nodes": [{"id": "out", "type": "output", "config": {}}],
            "edges": [],
        },
        "no_output": {
            "schema_version": 1,
            "nodes": [
                {
                    "id": "src",
                    "type": "source",
                    "config": {
                        "dataset_id": dataset_id,
                        "version_strategy": "fixed",
                        "dataset_version_id": version_id,
                    },
                }
            ],
            "edges": [],
        },
        "multiple_outputs": {
            "schema_version": 1,
            "nodes": [
                {
                    "id": "src",
                    "type": "source",
                    "config": {
                        "dataset_id": dataset_id,
                        "version_strategy": "fixed",
                        "dataset_version_id": version_id,
                    },
                },
                {"id": "out1", "type": "output", "config": {}},
                {"id": "out2", "type": "output", "config": {}},
            ],
            "edges": [
                {"id": "e1", "source": "src", "target": "out1"},
                {"id": "e2", "source": "src", "target": "out2"},
            ],
        },
        "disconnected_node": {
            "schema_version": 1,
            "nodes": [
                {
                    "id": "src",
                    "type": "source",
                    "config": {
                        "dataset_id": dataset_id,
                        "version_strategy": "fixed",
                        "dataset_version_id": version_id,
                    },
                },
                {"id": "out", "type": "output", "config": {}},
                {
                    "id": "orphan",
                    "type": "union",
                    "config": {"mode": "strict"},
                },
            ],
            "edges": [{"id": "e1", "source": "src", "target": "out"}],
        },
        "join_incoming_lt_2": {
            "schema_version": 1,
            "nodes": [
                {
                    "id": "src",
                    "type": "source",
                    "config": {
                        "dataset_id": dataset_id,
                        "version_strategy": "fixed",
                        "dataset_version_id": version_id,
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
                {
                    "id": "e1",
                    "source": "src",
                    "target": "join-1",
                    "target_port": "left",
                },
                {"id": "e2", "source": "join-1", "target": "out"},
            ],
        },
        "join_bad_ports": {
            "schema_version": 1,
            "nodes": [
                {
                    "id": "left",
                    "type": "source",
                    "config": {
                        "dataset_id": dataset_id,
                        "version_strategy": "fixed",
                        "dataset_version_id": version_id,
                    },
                },
                {
                    "id": "right",
                    "type": "source",
                    "config": {
                        "dataset_id": dataset_id,
                        "version_strategy": "fixed",
                        "dataset_version_id": version_id,
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
                {
                    "id": "e1",
                    "source": "left",
                    "target": "join-1",
                    "target_port": "left",
                },
                {
                    "id": "e2",
                    "source": "right",
                    "target": "join-1",
                    "target_port": "left",
                },
                {"id": "e3", "source": "join-1", "target": "out"},
            ],
        },
        "join_same_upstream": {
            "schema_version": 1,
            "nodes": [
                {
                    "id": "src",
                    "type": "source",
                    "config": {
                        "dataset_id": dataset_id,
                        "version_strategy": "fixed",
                        "dataset_version_id": version_id,
                    },
                },
                {
                    "id": "join-1",
                    "type": "join",
                    "config": {
                        "how": "inner",
                        "left_on": ["customer_id"],
                        "right_on": ["customer_id"],
                    },
                },
                {"id": "out", "type": "output", "config": {}},
            ],
            "edges": [
                {
                    "id": "e1",
                    "source": "src",
                    "target": "join-1",
                    "target_port": "left",
                },
                {
                    "id": "e2",
                    "source": "src",
                    "target": "join-1",
                    "target_port": "right",
                },
                {"id": "e3", "source": "join-1", "target": "out"},
            ],
        },
        "union_incoming_lt_2": {
            "schema_version": 1,
            "nodes": [
                {
                    "id": "src",
                    "type": "source",
                    "config": {
                        "dataset_id": dataset_id,
                        "version_strategy": "fixed",
                        "dataset_version_id": version_id,
                    },
                },
                {
                    "id": "union-1",
                    "type": "union",
                    "config": {"mode": "align_by_name"},
                },
                {"id": "out", "type": "output", "config": {}},
            ],
            "edges": [
                {"id": "e1", "source": "src", "target": "union-1"},
                {"id": "e2", "source": "union-1", "target": "out"},
            ],
        },
        "output_incoming_ne_1": {
            "schema_version": 1,
            "nodes": [
                {
                    "id": "src-a",
                    "type": "source",
                    "config": {
                        "dataset_id": dataset_id,
                        "version_strategy": "fixed",
                        "dataset_version_id": version_id,
                    },
                },
                {
                    "id": "src-b",
                    "type": "source",
                    "config": {
                        "dataset_id": dataset_id,
                        "version_strategy": "fixed",
                        "dataset_version_id": version_id,
                    },
                },
                {"id": "out", "type": "output", "config": {}},
            ],
            "edges": [
                {"id": "e1", "source": "src-a", "target": "out"},
                {"id": "e2", "source": "src-b", "target": "out"},
            ],
        },
        "output_has_outgoing": {
            "schema_version": 1,
            "nodes": [
                {
                    "id": "src",
                    "type": "source",
                    "config": {
                        "dataset_id": dataset_id,
                        "version_strategy": "fixed",
                        "dataset_version_id": version_id,
                    },
                },
                {"id": "out", "type": "output", "config": {}},
                {
                    "id": "union-1",
                    "type": "union",
                    "config": {"mode": "strict"},
                },
            ],
            "edges": [
                {"id": "e1", "source": "src", "target": "out"},
                {"id": "e2", "source": "out", "target": "union-1"},
            ],
        },
    }

    for name, graph in cases.items():
        response = client.post(
            f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/validate",
            headers=auth_headers,
            json={"graph": graph},
        )
        assert response.status_code == 200, (name, response.text)
        body = response.json()
        assert body["valid"] is False, name
        assert body["errors"], name

    # non-strict save still accepts incomplete topology as warnings
    incomplete = {
        "schema_version": 1,
        "nodes": [
            {
                "id": "src",
                "type": "source",
                "config": {
                    "dataset_id": dataset_id,
                    "version_strategy": "fixed",
                    "dataset_version_id": version_id,
                },
            },
            {"id": "out", "type": "output", "config": {}},
            {"id": "orphan", "type": "union", "config": {"mode": "strict"}},
        ],
        "edges": [{"id": "e1", "source": "src", "target": "out"}],
    }
    saved = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/versions",
        headers=auth_headers,
        json={"graph": incomplete},
    )
    assert saved.status_code == 201, saved.text


def test_delete_blocked_with_run_history(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    ds = _upload_dataset(client, auth_headers, project_id)
    created = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={
            "name": "Del",
            "graph": _source_output_graph(ds["id"], strategy="latest"),
        },
    )
    prep_id = created.json()["id"]
    run = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/runs",
        headers=auth_headers,
        json={},
    )
    assert run.status_code == 201
    deleted = client.delete(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}",
        headers=auth_headers,
    )
    assert deleted.status_code == 409
    detail = deleted.json()["detail"]
    message = detail["detail"] if isinstance(detail, dict) else detail
    assert "run history" in str(message).lower()


def test_rbac_viewer_and_scientist(client, auth_headers):
    project_id = _create_project(client, auth_headers, role=ProjectRole.VIEWER)
    _create_project(client, auth_headers, role=ProjectRole.DATA_SCIENTIST)
    # recreate cleanly
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

    viewer_headers = _login(client, "viewer@example.com", VIEWER_PASSWORD)
    scientist_headers = _login(client, "scientist@example.com", SCIENTIST_PASSWORD)

    listed = client.get(
        f"/api/v1/projects/{project_id}/dataset-preparations", headers=viewer_headers
    )
    assert listed.status_code == 200

    denied = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=viewer_headers,
        json={"name": "Nope", "graph": _empty_graph()},
    )
    assert denied.status_code == 403

    allowed = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=scientist_headers,
        json={"name": "Yes", "graph": _empty_graph()},
    )
    assert allowed.status_code == 201


def test_worker_does_not_claim_preparation_runs():
    import inspect

    from app.workers import runner

    source = inspect.getsource(runner)
    assert "DatasetPreparationRun" not in source
    assert "dataset_preparation" not in source.lower()


def test_join_graph_run_snapshot(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    left = _upload_dataset(client, auth_headers, project_id, name="left.csv")
    right = _upload_dataset(client, auth_headers, project_id, name="right.csv")
    graph = _join_graph(
        left["id"], left["version"]["id"], right["id"], right["version"]["id"]
    )
    created = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={"name": "JoinPrep", "graph": graph},
    )
    assert created.status_code == 201, created.text
    prep_id = created.json()["id"]
    run = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/runs",
        headers=auth_headers,
        json={},
    )
    assert run.status_code == 201, run.text
    assert run.json()["status"] == "created"
    assert len(run.json()["inputs"]) == 2

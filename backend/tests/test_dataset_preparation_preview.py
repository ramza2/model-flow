"""Phase 2-B Dataset Preparation position persistence + sampled preview tests."""

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
    Dataset,
    DatasetPreparationRun,
    DatasetPreparationRunInput,
    DatasetPreparationVersion,
    DatasetVersion,
    ProjectMembership,
    ProjectRole,
    User,
)
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import mlflow_service, registry_service, storage

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
ADMIN_PASSWORD = secrets.token_urlsafe(24)
VIEWER_PASSWORD = secrets.token_urlsafe(24)
OUTSIDER_PASSWORD = secrets.token_urlsafe(24)


@pytest.fixture(autouse=True)
def setup_api(monkeypatch):
    Base.metadata.create_all(engine)
    _rate_windows.clear()

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
        outsider = User(
            email="outsider@example.com",
            full_name="Outsider",
            password_hash=hash_password(OUTSIDER_PASSWORD),
            is_active=True,
        )
        db.add_all([admin, viewer, outsider])
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
        json={"name": f"prep-b-{secrets.token_hex(4)}", "description": ""},
    )
    assert response.status_code == 201, response.text
    project_id = response.json()["id"]
    if role is not None:
        with TestingSessionLocal() as db:
            user = db.scalar(select(User).where(User.email == "viewer@example.com"))
            db.add(
                ProjectMembership(
                    project_id=project_id, user_id=user.id, role=role
                )
            )
            db.commit()
    return project_id


def _upload_dataset(client, auth_headers, project_id: int, name: str, csv: bytes):
    response = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": (name, csv, "text/csv")},
        data={"name": name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _create_prep(client, auth_headers, project_id: int, name: str = "Prep"):
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={
            "name": name,
            "description": "",
            "graph": {"schema_version": 1, "nodes": [], "edges": []},
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _source_output(dataset_id: int, *, strategy: str = "latest", version_id: int | None = None, position=None):
    config: dict = {"dataset_id": dataset_id, "version_strategy": strategy}
    if strategy == "fixed":
        config["dataset_version_id"] = version_id
    node = {"id": "src-a", "type": "source", "config": config}
    out = {"id": "out", "type": "output", "config": {}}
    if position is not None:
        node["position"] = position
        out["position"] = {"x": position["x"] + 240, "y": position["y"]}
    return {
        "schema_version": 1,
        "nodes": [node, out],
        "edges": [{"id": "e1", "source": "src-a", "target": "out", "target_port": None}],
    }


def _join_graph(dataset_a: int, version_a: int, dataset_b: int, version_b: int, *, how: str = "left"):
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
                    "how": how,
                    "left_on": ["customer_id"],
                    "right_on": ["customer_id"],
                },
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e-left", "source": "left", "target": "join-1", "target_port": "left"},
            {"id": "e-right", "source": "right", "target": "join-1", "target_port": "right"},
            {"id": "e-out", "source": "join-1", "target": "out", "target_port": None},
        ],
    }


def test_graph_position_round_trip(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    dataset = _upload_dataset(
        client, auth_headers, project_id, "a.csv", b"customer_id,amount\n1,10\n"
    )
    prep = _create_prep(client, auth_headers, project_id)
    graph = _source_output(
        dataset["id"],
        strategy="fixed",
        version_id=dataset["version"]["id"],
        position={"x": 12.5, "y": 40},
    )
    plain = _source_output(
        dataset["id"], strategy="fixed", version_id=dataset["version"]["id"]
    )
    assert "position" not in plain["nodes"][0]

    saved = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/versions",
        headers=auth_headers,
        json={"graph": graph},
    )
    assert saved.status_code == 201, saved.text
    nodes = {n["id"]: n for n in saved.json()["graph"]["nodes"]}
    assert nodes["src-a"]["position"] == {"x": 12.5, "y": 40.0}

    fetched = client.get(
        f"/api/v1/projects/{project_id}/dataset-preparation-versions/{saved.json()['id']}",
        headers=auth_headers,
    )
    assert fetched.status_code == 200
    assert fetched.json()["graph"]["nodes"][0]["position"]["x"] == 12.5

    saved_plain = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/versions",
        headers=auth_headers,
        json={"graph": plain},
    )
    assert saved_plain.status_code == 201, saved_plain.text
    assert saved_plain.json()["graph"]["nodes"][0].get("position") is None


def test_source_preview_fixed_and_latest(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    v1 = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "cust.csv",
        b"customer_id,name\n1,Ada\n2,Bob\n",
    )
    prep = _create_prep(client, auth_headers, project_id)

    fixed = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={
            "graph": _source_output(
                v1["id"], strategy="fixed", version_id=v1["version"]["id"]
            ),
            "limit": 20,
        },
    )
    assert fixed.status_code == 200, fixed.text
    fixed_body = fixed.json()
    assert fixed_body["sampled"] is True
    assert fixed_body["source_versions"][0]["dataset_version_id"] == v1["version"]["id"]
    assert fixed_body["columns"] == ["customer_id", "name"]
    assert len(fixed_body["rows"]) == 2
    assert fixed_body["warnings"]

    latest_v1 = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": _source_output(v1["id"], strategy="latest"), "limit": 20},
    )
    assert latest_v1.status_code == 200, latest_v1.text
    assert (
        latest_v1.json()["source_versions"][0]["dataset_version_id"]
        == v1["version"]["id"]
    )

    v2_upload = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={
            "file": (
                "cust.csv",
                b"customer_id,name\n1,Ada\n2,Bob\n3,Cara\n",
                "text/csv",
            )
        },
        data={"name": "cust.csv"},
    )
    assert v2_upload.status_code == 201, v2_upload.text
    v2_id = v2_upload.json()["version"]["id"]

    latest_v2 = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": _source_output(v1["id"], strategy="latest"), "limit": 20},
    )
    assert latest_v2.status_code == 200, latest_v2.text
    assert latest_v2.json()["source_versions"][0]["dataset_version_id"] == v2_id
    assert len(latest_v2.json()["rows"]) == 3


def test_preview_no_mutation(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    dataset = _upload_dataset(
        client, auth_headers, project_id, "a.csv", b"customer_id,amount\n1,10\n"
    )
    prep = _create_prep(client, auth_headers, project_id)

    def counts():
        with TestingSessionLocal() as db:
            return {
                "versions": db.scalar(
                    select(func.count()).select_from(DatasetPreparationVersion)
                ),
                "runs": db.scalar(
                    select(func.count()).select_from(DatasetPreparationRun)
                ),
                "inputs": db.scalar(
                    select(func.count()).select_from(DatasetPreparationRunInput)
                ),
                "dataset_versions": db.scalar(
                    select(func.count()).select_from(DatasetVersion)
                ),
            }

    before = counts()
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={
            "graph": _source_output(
                dataset["id"],
                strategy="fixed",
                version_id=dataset["version"]["id"],
            )
        },
    )
    assert response.status_code == 200, response.text
    assert counts() == before


def test_join_preview_full_and_missing_key(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    left = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "left.csv",
        b"customer_id,name,score\n1,Ada,10\n2,Bob,20\n",
    )
    right = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "right.csv",
        b"customer_id,name,amount\n1,AdaX,100\n3,Cara,300\n",
    )
    prep = _create_prep(client, auth_headers, project_id)
    graph = _join_graph(
        left["id"],
        left["version"]["id"],
        right["id"],
        right["version"]["id"],
        how="left",
    )
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": graph, "node_id": "join-1"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["node_id"] == "join-1"
    assert "name_left" in body["columns"]
    assert "name_right" in body["columns"]
    assert "amount" in body["columns"]
    assert len(body["rows"]) == 2

    full = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={
            "graph": _join_graph(
                left["id"],
                left["version"]["id"],
                right["id"],
                right["version"]["id"],
                how="full",
            )
        },
    )
    assert full.status_code == 200, full.text
    assert len(full.json()["rows"]) == 3

    bad_nodes = []
    for node in graph["nodes"]:
        if node["id"] == "join-1":
            node = {
                **node,
                "config": {
                    "how": "left",
                    "left_on": ["missing"],
                    "right_on": ["customer_id"],
                },
            }
        bad_nodes.append(node)
    missing = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": {**graph, "nodes": bad_nodes}},
    )
    assert missing.status_code == 400
    assert "missing" in missing.text.lower()


def test_union_strict_and_align(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    a = _upload_dataset(
        client, auth_headers, project_id, "a.csv", b"customer_id,amount\n1,10\n"
    )
    b = _upload_dataset(
        client, auth_headers, project_id, "b.csv", b"customer_id,amount\n2,20\n"
    )
    c = _upload_dataset(
        client, auth_headers, project_id, "c.csv", b"customer_id,name\n3,Cara\n"
    )
    prep = _create_prep(client, auth_headers, project_id)

    strict_graph = {
        "schema_version": 1,
        "nodes": [
            {
                "id": "s1",
                "type": "source",
                "config": {
                    "dataset_id": a["id"],
                    "version_strategy": "fixed",
                    "dataset_version_id": a["version"]["id"],
                },
            },
            {
                "id": "s2",
                "type": "source",
                "config": {
                    "dataset_id": b["id"],
                    "version_strategy": "fixed",
                    "dataset_version_id": b["version"]["id"],
                },
            },
            {"id": "u1", "type": "union", "config": {"mode": "strict"}},
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "s1", "target": "u1", "target_port": None},
            {"id": "e2", "source": "s2", "target": "u1", "target_port": None},
            {"id": "e3", "source": "u1", "target": "out", "target_port": None},
        ],
    }
    ok = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": strict_graph},
    )
    assert ok.status_code == 200, ok.text
    assert len(ok.json()["rows"]) == 2

    mismatch = {
        **strict_graph,
        "nodes": [
            strict_graph["nodes"][0],
            {
                "id": "s2",
                "type": "source",
                "config": {
                    "dataset_id": c["id"],
                    "version_strategy": "fixed",
                    "dataset_version_id": c["version"]["id"],
                },
            },
            strict_graph["nodes"][2],
            strict_graph["nodes"][3],
        ],
    }
    bad = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": mismatch},
    )
    assert bad.status_code == 400

    align = {
        **mismatch,
        "nodes": [
            mismatch["nodes"][0],
            mismatch["nodes"][1],
            {"id": "u1", "type": "union", "config": {"mode": "align_by_name"}},
            mismatch["nodes"][3],
        ],
    }
    aligned = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": align, "node_id": "u1"},
    )
    assert aligned.status_code == 200, aligned.text
    assert aligned.json()["columns"] == ["customer_id", "amount", "name"]
    assert aligned.json()["rows"][0]["name"] is None
    assert aligned.json()["rows"][1]["amount"] is None


def test_preview_node_id_and_invalid_graph(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    left = _upload_dataset(
        client, auth_headers, project_id, "left.csv", b"customer_id,x\n1,1\n"
    )
    right = _upload_dataset(
        client, auth_headers, project_id, "right.csv", b"customer_id,y\n1,2\n"
    )
    prep = _create_prep(client, auth_headers, project_id)
    graph = _join_graph(
        left["id"], left["version"]["id"], right["id"], right["version"]["id"]
    )

    mid = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": graph, "node_id": "join-1"},
    )
    assert mid.status_code == 200
    assert mid.json()["node_id"] == "join-1"

    missing = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": graph, "node_id": "nope"},
    )
    assert missing.status_code == 400

    invalid = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": {"schema_version": 1, "nodes": [], "edges": []}},
    )
    assert invalid.status_code == 400


def test_preview_latest_missing_409(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    dataset = _upload_dataset(
        client, auth_headers, project_id, "a.csv", b"customer_id,amount\n1,10\n"
    )
    prep = _create_prep(client, auth_headers, project_id)
    with TestingSessionLocal() as db:
        row = db.get(Dataset, dataset["id"])
        row.latest_version = 99
        db.add(row)
        db.commit()

    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": _source_output(dataset["id"], strategy="latest")},
    )
    assert response.status_code == 409, response.text


def test_preview_rbac(client, auth_headers):
    project_id = _create_project(client, auth_headers, role=ProjectRole.VIEWER)
    dataset = _upload_dataset(
        client, auth_headers, project_id, "a.csv", b"customer_id,amount\n1,10\n"
    )
    prep = _create_prep(client, auth_headers, project_id)
    viewer = _login(client, "viewer@example.com", VIEWER_PASSWORD)
    ok = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=viewer,
        json={
            "graph": _source_output(
                dataset["id"],
                strategy="fixed",
                version_id=dataset["version"]["id"],
            )
        },
    )
    assert ok.status_code == 200, ok.text

    outsider = _login(client, "outsider@example.com", OUTSIDER_PASSWORD)
    denied = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=outsider,
        json={
            "graph": _source_output(
                dataset["id"],
                strategy="fixed",
                version_id=dataset["version"]["id"],
            )
        },
    )
    assert denied.status_code in {403, 404}


def test_preview_incompatible_fill_returns_400_with_node_and_column(
    client, auth_headers, monkeypatch
):
    """Preview must map fillna TypeError to friendly 400 with node id + column."""
    import pandas as pd

    from app.services import dataset_preparation_execution as execution

    project_id = _create_project(client, auth_headers)
    dataset = _upload_dataset(
        client, auth_headers, project_id, "cat.csv", b"cat\na\n"
    )
    prep = _create_prep(client, auth_headers, project_id)

    def _categorical_preview(*, columns, preview_rows):
        return pd.DataFrame({"cat": pd.Series(pd.Categorical(["a", None]))})

    monkeypatch.setattr(execution, "frame_from_preview", _categorical_preview)

    graph = {
        "schema_version": 1,
        "nodes": [
            {
                "id": "src",
                "type": "source",
                "config": {
                    "dataset_id": dataset["id"],
                    "version_strategy": "fixed",
                    "dataset_version_id": dataset["version"]["id"],
                },
            },
            {
                "id": "fill-1",
                "type": "fill_constant",
                "config": {"values": {"cat": 1}},
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "src", "target": "fill-1"},
            {"id": "e2", "source": "fill-1", "target": "out"},
        ],
    }
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": graph},
    )
    assert response.status_code == 400, response.text
    assert response.status_code != 500
    text = response.text.lower()
    assert "fill-1" in text
    assert "cat" in text


def test_group_by_preview_warning_and_incompatible_sum(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    dataset = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "sales.csv",
        b"region,sales,label\nwest,10,a\neast,20,b\nwest,30,c\n",
    )
    prep = _create_prep(client, auth_headers, project_id)
    group_config = {
        "group_by": ["region"],
        "aggregations": [
            {"column": "sales", "op": "sum", "output": "sales_sum"},
            {"column": "sales", "op": "count", "output": "sales_count"},
        ],
    }
    graph = {
        "schema_version": 1,
        "nodes": [
            {
                "id": "src",
                "type": "source",
                "config": {
                    "dataset_id": dataset["id"],
                    "version_strategy": "fixed",
                    "dataset_version_id": dataset["version"]["id"],
                },
            },
            {"id": "group_by-1", "type": "group_by", "config": group_config},
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "src", "target": "group_by-1"},
            {"id": "e2", "source": "group_by-1", "target": "out"},
        ],
    }

    preview_out = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": graph},
    )
    assert preview_out.status_code == 200, preview_out.text
    body = preview_out.json()
    assert any("Group By preview is computed from sampled source rows" in w for w in body["warnings"])
    assert body["columns"] == ["region", "sales_sum", "sales_count"]

    preview_group = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": graph, "node_id": "group_by-1"},
    )
    assert preview_group.status_code == 200, preview_group.text
    assert any(
        "Group By preview is computed from sampled source rows" in w
        for w in preview_group.json()["warnings"]
    )

    preview_src = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": graph, "node_id": "src"},
    )
    assert preview_src.status_code == 200, preview_src.text
    assert not any(
        "Group By preview is computed from sampled source rows" in w
        for w in preview_src.json()["warnings"]
    )

    bad = {
        **graph,
        "nodes": [
            graph["nodes"][0],
            {
                "id": "group_by-1",
                "type": "group_by",
                "config": {
                    "group_by": ["region"],
                    "aggregations": [
                        {"column": "label", "op": "sum", "output": "label_sum"}
                    ],
                },
            },
            graph["nodes"][2],
        ],
    }
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": bad},
    )
    assert response.status_code == 400, response.text
    text = response.text.lower()
    assert "group_by-1" in text
    assert "label" in text
    assert "sum" in text


def test_unpivot_preview_and_missing_column_400(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    dataset = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "wide.csv",
        b"customer_id,region,jan,feb,ignored\n1,Seoul,10,20,A\n2,Busan,30,,B\n",
    )
    prep = _create_prep(client, auth_headers, project_id)
    graph = {
        "schema_version": 1,
        "nodes": [
            {
                "id": "src",
                "type": "source",
                "config": {
                    "dataset_id": dataset["id"],
                    "version_strategy": "fixed",
                    "dataset_version_id": dataset["version"]["id"],
                },
            },
            {
                "id": "unpivot-1",
                "type": "unpivot",
                "config": {
                    "id_columns": ["customer_id", "region"],
                    "value_columns": ["jan", "feb"],
                    "variable_column": "month",
                    "value_column": "sales",
                },
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "src", "target": "unpivot-1"},
            {"id": "e2", "source": "unpivot-1", "target": "out"},
        ],
    }

    preview = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": graph},
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["columns"] == ["customer_id", "region", "month", "sales"]
    assert len(body["rows"]) == 4
    assert not any("Group By preview" in w for w in body["warnings"])
    assert any("sample" in w.lower() or "Sample" in w or "Preview" in w for w in body["warnings"])

    # Group By ancestor warning still fires when Group By precedes Unpivot.
    chained = {
        "schema_version": 1,
        "nodes": [
            graph["nodes"][0],
            {
                "id": "group_by-1",
                "type": "group_by",
                "config": {
                    "group_by": ["region"],
                    "aggregations": [{"column": "jan", "op": "sum", "output": "jan"}],
                },
            },
            {
                "id": "unpivot-1",
                "type": "unpivot",
                "config": {
                    "id_columns": ["region"],
                    "value_columns": ["jan"],
                    "variable_column": "metric",
                    "value_column": "amount",
                },
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "src", "target": "group_by-1"},
            {"id": "e2", "source": "group_by-1", "target": "unpivot-1"},
            {"id": "e3", "source": "unpivot-1", "target": "out"},
        ],
    }
    chained_preview = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": chained},
    )
    assert chained_preview.status_code == 200, chained_preview.text
    assert any(
        "Group By preview is computed from sampled source rows" in w
        for w in chained_preview.json()["warnings"]
    )

    bad = {
        **graph,
        "nodes": [
            graph["nodes"][0],
            {
                "id": "unpivot-1",
                "type": "unpivot",
                "config": {
                    "id_columns": ["customer_id"],
                    "value_columns": ["missing_col"],
                    "variable_column": "month",
                    "value_column": "sales",
                },
            },
            graph["nodes"][2],
        ],
    }
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": bad},
    )
    assert response.status_code == 400, response.text
    text = response.text.lower()
    assert "unpivot-1" in text
    assert "missing_col" in text


def test_pivot_preview_schema_stability_and_warning(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    dataset = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "long.csv",
        b"customer_id,region,month,sales\n"
        b"1,Seoul,jan,10\n"
        b"1,Seoul,feb,20\n"
        b"2,Busan,jan,30\n",
    )
    prep = _create_prep(client, auth_headers, project_id)
    graph = {
        "schema_version": 1,
        "nodes": [
            {
                "id": "src",
                "type": "source",
                "config": {
                    "dataset_id": dataset["id"],
                    "version_strategy": "fixed",
                    "dataset_version_id": dataset["version"]["id"],
                },
            },
            {
                "id": "pivot-1",
                "type": "pivot",
                "config": {
                    "index_columns": ["customer_id", "region"],
                    "columns_column": "month",
                    "value_column": "sales",
                    "aggregation": "sum",
                    "pivot_values": [
                        {"value": "jan", "output": "jan_sales"},
                        {"value": "feb", "output": "feb_sales"},
                        {"value": "mar", "output": "mar_sales"},
                    ],
                },
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "src", "target": "pivot-1"},
            {"id": "e2", "source": "pivot-1", "target": "out"},
        ],
    }
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": graph},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["columns"] == ["customer_id", "region", "jan_sales", "feb_sales", "mar_sales"]
    assert any("Pivot preview" in w for w in body["warnings"])
    # mar is configured but absent from sample -> null column retained
    for row in body["rows"]:
        assert "mar_sales" in row
        assert row["mar_sales"] is None

    # Group By ancestor warning still fires when Group By precedes Pivot.
    chained = {
        "schema_version": 1,
        "nodes": [
            graph["nodes"][0],
            {
                "id": "group_by-1",
                "type": "group_by",
                "config": {
                    "group_by": ["region"],
                    "aggregations": [{"column": "sales", "op": "sum", "output": "sales"}],
                },
            },
            {
                "id": "pivot-1",
                "type": "pivot",
                "config": {
                    "index_columns": ["region"],
                    "columns_column": "month",
                    "value_column": "sales",
                    "aggregation": "sum",
                    "pivot_values": [{"value": "jan", "output": "jan_sales"}],
                },
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "src", "target": "group_by-1"},
            {"id": "e2", "source": "group_by-1", "target": "pivot-1"},
            {"id": "e3", "source": "pivot-1", "target": "out"},
        ],
    }
    # Rebuild chain with month still present for a workable demo path is not required;
    # instead verify missing column 400 normalization.
    bad = {
        **graph,
        "nodes": [
            graph["nodes"][0],
            {
                "id": "pivot-1",
                "type": "pivot",
                "config": {
                    "index_columns": ["customer_id"],
                    "columns_column": "missing_month",
                    "value_column": "sales",
                    "aggregation": "sum",
                    "pivot_values": [{"value": "jan", "output": "jan_sales"}],
                },
            },
            graph["nodes"][2],
        ],
    }
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": bad},
    )
    assert response.status_code == 400, response.text
    text = response.text.lower()
    assert "pivot-1" in text
    assert "missing_month" in text


def test_group_by_then_pivot_preview_warnings(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    dataset = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "long2.csv",
        b"region,month,sales\nwest,jan,10\nwest,jan,5\neast,feb,7\n",
    )
    prep = _create_prep(client, auth_headers, project_id)
    graph = {
        "schema_version": 1,
        "nodes": [
            {
                "id": "src",
                "type": "source",
                "config": {
                    "dataset_id": dataset["id"],
                    "version_strategy": "fixed",
                    "dataset_version_id": dataset["version"]["id"],
                },
            },
            {
                "id": "group_by-1",
                "type": "group_by",
                "config": {
                    "group_by": ["region", "month"],
                    "aggregations": [{"column": "sales", "op": "sum", "output": "sales"}],
                },
            },
            {
                "id": "pivot-1",
                "type": "pivot",
                "config": {
                    "index_columns": ["region"],
                    "columns_column": "month",
                    "value_column": "sales",
                    "aggregation": "sum",
                    "pivot_values": [
                        {"value": "jan", "output": "jan_sales"},
                        {"value": "feb", "output": "feb_sales"},
                    ],
                },
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "src", "target": "group_by-1"},
            {"id": "e2", "source": "group_by-1", "target": "pivot-1"},
            {"id": "e3", "source": "pivot-1", "target": "out"},
        ],
    }
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": graph},
    )
    assert response.status_code == 200, response.text
    warnings = response.json()["warnings"]
    assert any("Group By preview" in w for w in warnings)
    assert any("Pivot preview" in w for w in warnings)

def test_pivot_preview_unrelated_path_and_error_normalization(client, auth_headers):
    project_id = _create_project(client, auth_headers)
    dataset = _upload_dataset(
        client,
        auth_headers,
        project_id,
        "pivot_err.csv",
        b"customer_id,month,sales,label\n"
        b"1,jan,10,a\n"
        b"1,feb,20,b\n",
    )
    prep = _create_prep(client, auth_headers, project_id)

    # Previewing an ancestor that does not include Pivot must omit the Pivot warning.
    pivot_graph = {
        "schema_version": 1,
        "nodes": [
            {
                "id": "src",
                "type": "source",
                "config": {
                    "dataset_id": dataset["id"],
                    "version_strategy": "fixed",
                    "dataset_version_id": dataset["version"]["id"],
                },
            },
            {
                "id": "pivot-1",
                "type": "pivot",
                "config": {
                    "index_columns": ["customer_id"],
                    "columns_column": "month",
                    "value_column": "sales",
                    "aggregation": "sum",
                    "pivot_values": [{"value": "jan", "output": "jan_sales"}],
                },
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "src", "target": "pivot-1"},
            {"id": "e2", "source": "pivot-1", "target": "out"},
        ],
    }
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": pivot_graph, "node_id": "src"},
    )
    assert response.status_code == 200, response.text
    warnings = response.json()["warnings"]
    assert not any("Pivot preview" in w for w in warnings)
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": pivot_graph, "node_id": "pivot-1"},
    )
    assert response.status_code == 200, response.text
    assert any("Pivot preview" in w for w in response.json()["warnings"])

    base_nodes = [
        {
            "id": "src",
            "type": "source",
            "config": {
                "dataset_id": dataset["id"],
                "version_strategy": "fixed",
                "dataset_version_id": dataset["version"]["id"],
            },
        },
        {"id": "out", "type": "output", "config": {}},
    ]
    edges = [
        {"id": "e1", "source": "src", "target": "pivot-1"},
        {"id": "e2", "source": "pivot-1", "target": "out"},
    ]

    missing_value = {
        "schema_version": 1,
        "nodes": [
            base_nodes[0],
            {
                "id": "pivot-1",
                "type": "pivot",
                "config": {
                    "index_columns": ["customer_id"],
                    "columns_column": "month",
                    "value_column": "missing_sales",
                    "aggregation": "sum",
                    "pivot_values": [{"value": "jan", "output": "jan_sales"}],
                },
            },
            base_nodes[1],
        ],
        "edges": edges,
    }
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": missing_value},
    )
    assert response.status_code == 400, response.text
    text_l = response.text.lower()
    assert "pivot-1" in text_l
    assert "missing_sales" in text_l

    bad_sum = {
        "schema_version": 1,
        "nodes": [
            base_nodes[0],
            {
                "id": "pivot-1",
                "type": "pivot",
                "config": {
                    "index_columns": ["customer_id"],
                    "columns_column": "month",
                    "value_column": "label",
                    "aggregation": "sum",
                    "pivot_values": [{"value": "jan", "output": "jan_label"}],
                },
            },
            base_nodes[1],
        ],
        "edges": edges,
    }
    response = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep['id']}/preview",
        headers=auth_headers,
        json={"graph": bad_sum},
    )
    assert response.status_code == 400, response.text
    text_l = response.text.lower()
    assert "pivot-1" in text_l
    assert "label" in text_l
    assert "sum" in text_l
    # raw pandas / numpy noise should not leak
    assert "traceback" not in text_l
    assert "dtype" not in text_l


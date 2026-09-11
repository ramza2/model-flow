"""Phase 2-C Dataset Preparation transform validation + execution unit tests."""

from __future__ import annotations

import secrets

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import Base, User
from app.db.session import get_db
from app.main import app
from app.services import mlflow_service, registry_service, storage
from app.services.dataset_preparation import _validate_transform_config
from app.services.dataset_preparation_execution import (
    PreparationExecutionError,
    execute_preparation_graph,
)

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
ADMIN_PASSWORD = secrets.token_urlsafe(24)


def _frame(**columns):
    return pd.DataFrame(columns)


def _run(node_type: str, config: dict, frame: pd.DataFrame) -> pd.DataFrame:
    graph = {
        "schema_version": 1,
        "nodes": [
            {"id": "src", "type": "source", "config": {"dataset_id": 1}},
            {"id": "t", "type": node_type, "config": config},
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "src", "target": "t"},
            {"id": "e2", "source": "t", "target": "out"},
        ],
    }
    return execute_preparation_graph(graph, {"src": frame})


# ---------------------------------------------------------------------------
# Select / Drop / Rename
# ---------------------------------------------------------------------------


def test_select_preserves_order_and_missing_fails():
    frame = _frame(a=[1, 2], b=[3, 4], c=[5, 6])
    out = _run("select", {"columns": ["c", "a"]}, frame)
    assert list(out.columns) == ["c", "a"]
    assert out["c"].tolist() == [5, 6]

    with pytest.raises(PreparationExecutionError, match="missing"):
        _run("select", {"columns": ["a", "missing"]}, frame)


def test_drop_and_missing():
    frame = _frame(a=[1], b=[2], c=[3])
    out = _run("drop", {"columns": ["b"]}, frame)
    assert list(out.columns) == ["a", "c"]

    with pytest.raises(PreparationExecutionError, match="missing"):
        _run("drop", {"columns": ["nope"]}, frame)


def test_rename_success_and_duplicate_failure():
    frame = _frame(a=[1], b=[2])
    out = _run("rename", {"mapping": {"a": "alpha"}}, frame)
    assert list(out.columns) == ["alpha", "b"]

    with pytest.raises(PreparationExecutionError, match="duplicate"):
        _run("rename", {"mapping": {"a": "b"}}, frame)

    errors, _ = _validate_transform_config(
        "r",
        "rename",
        {"mapping": {"a": "x", "b": "x"}},
        strict=True,
    )
    assert any("unique" in err for err in errors)


# ---------------------------------------------------------------------------
# Filter
# ---------------------------------------------------------------------------


def test_filter_and_or_eq_neq_numeric_contains_null_in():
    frame = _frame(
        name=["Ada", "Bob", None, "Cara"],
        amount=[10, 20, 30, 40],
        tag=["x", "y", "x", "z"],
    )

    and_out = _run(
        "filter",
        {
            "combine": "and",
            "conditions": [
                {"column": "amount", "operator": "gte", "value": 20},
                {"column": "tag", "operator": "eq", "value": "x"},
            ],
        },
        frame,
    )
    assert and_out["amount"].tolist() == [30]

    or_out = _run(
        "filter",
        {
            "combine": "or",
            "conditions": [
                {"column": "name", "operator": "eq", "value": "Ada"},
                {"column": "amount", "operator": "eq", "value": 40},
            ],
        },
        frame,
    )
    assert set(or_out["name"].dropna().tolist()) == {"Ada", "Cara"}

    neq = _run(
        "filter",
        {
            "combine": "and",
            "conditions": [{"column": "tag", "operator": "neq", "value": "x"}],
        },
        frame,
    )
    assert set(neq["tag"].tolist()) == {"y", "z"}

    gt = _run(
        "filter",
        {
            "combine": "and",
            "conditions": [{"column": "amount", "operator": "gt", "value": 25}],
        },
        frame,
    )
    assert gt["amount"].tolist() == [30, 40]

    contains = _run(
        "filter",
        {
            "combine": "and",
            "conditions": [{"column": "name", "operator": "contains", "value": "a"}],
        },
        frame,
    )
    assert set(contains["name"].tolist()) == {"Ada", "Cara"}

    nulls = _run(
        "filter",
        {
            "combine": "and",
            "conditions": [{"column": "name", "operator": "is_null"}],
        },
        frame,
    )
    assert len(nulls) == 1 and pd.isna(nulls.iloc[0]["name"])

    not_null = _run(
        "filter",
        {
            "combine": "and",
            "conditions": [{"column": "name", "operator": "not_null"}],
        },
        frame,
    )
    assert len(not_null) == 3

    in_out = _run(
        "filter",
        {
            "combine": "and",
            "conditions": [{"column": "tag", "operator": "in", "value": ["y", "z"]}],
        },
        frame,
    )
    assert set(in_out["tag"].tolist()) == {"y", "z"}


def test_filter_invalid_operator_validation():
    errors, _ = _validate_transform_config(
        "f",
        "filter",
        {
            "combine": "and",
            "conditions": [{"column": "a", "operator": "bogus", "value": 1}],
        },
        strict=True,
    )
    assert any("unsupported operator" in err for err in errors)

    with pytest.raises(PreparationExecutionError, match="unsupported filter operator"):
        _run(
            "filter",
            {
                "combine": "and",
                "conditions": [{"column": "a", "operator": "bogus", "value": 1}],
            },
            _frame(a=[1]),
        )


# ---------------------------------------------------------------------------
# Cast
# ---------------------------------------------------------------------------


def test_cast_integer_float_string_boolean_datetime_and_invalid():
    frame = _frame(
        i=["1", "2"],
        f=["1.5", "2.5"],
        s=[1, 2],
        b=["true", "false"],
        d=["2024-01-01", "2024-02-01"],
    )
    out = _run(
        "cast",
        {
            "casts": {
                "i": "integer",
                "f": "float",
                "s": "string",
                "b": "boolean",
                "d": "datetime",
            }
        },
        frame,
    )
    assert str(out["i"].dtype) == "Int64"
    assert out["i"].tolist() == [1, 2]
    assert out["f"].tolist() == [1.5, 2.5]
    assert str(out["s"].dtype) == "string"
    assert out["b"].tolist() == [True, False]
    assert pd.api.types.is_datetime64_any_dtype(out["d"])

    with pytest.raises(PreparationExecutionError, match="could not cast|cannot cast"):
        _run("cast", {"casts": {"i": "integer"}}, _frame(i=["not-a-number"]))

    errors, _ = _validate_transform_config(
        "c",
        "cast",
        {"casts": {"a": "uuid"}},
        strict=True,
    )
    assert any("unsupported type" in err for err in errors)


# ---------------------------------------------------------------------------
# Deduplicate
# ---------------------------------------------------------------------------


def test_deduplicate_subset_all_first_last():
    frame = _frame(k=["a", "a", "b"], v=[1, 2, 3])

    first = _run("deduplicate", {"columns": ["k"], "keep": "first"}, frame)
    assert first["v"].tolist() == [1, 3]

    last = _run("deduplicate", {"columns": ["k"], "keep": "last"}, frame)
    assert last["v"].tolist() == [2, 3]

    all_rows = _frame(a=[1, 1], b=[2, 2])
    out = _run("deduplicate", {"columns": [], "keep": "first"}, all_rows)
    assert len(out) == 1


# ---------------------------------------------------------------------------
# Fill constant
# ---------------------------------------------------------------------------


def test_fill_constant_string_number_boolean_and_invalid_null():
    frame = _frame(
        s=[None, "x"],
        n=[None, 2.0],
        b=[None, True],
    )
    out = _run(
        "fill_constant",
        {"values": {"s": "filled", "n": 0, "b": False}},
        frame,
    )
    assert out["s"].tolist() == ["filled", "x"]
    assert out["n"].tolist() == [0.0, 2.0]
    assert out["b"].tolist() == [False, True]

    errors, _ = _validate_transform_config(
        "fill",
        "fill_constant",
        {"values": {"s": None}},
        strict=True,
    )
    assert any("null fill value is not allowed" in err for err in errors)


# ---------------------------------------------------------------------------
# Derived column
# ---------------------------------------------------------------------------


def test_derived_add_sub_mul_div_concat_literal_missing_conflict_divzero():
    frame = _frame(a=[10, 20], b=[2, 4], name=["A", "B"])

    add = _run(
        "derived_column",
        {
            "name": "sum",
            "operation": "add",
            "left": {"kind": "column", "value": "a"},
            "right": {"kind": "column", "value": "b"},
        },
        frame,
    )
    assert add["sum"].tolist() == [12, 24]

    sub = _run(
        "derived_column",
        {
            "name": "diff",
            "operation": "subtract",
            "left": {"kind": "column", "value": "a"},
            "right": {"kind": "literal", "value": 5},
        },
        frame,
    )
    assert sub["diff"].tolist() == [5, 15]

    mul = _run(
        "derived_column",
        {
            "name": "prod",
            "operation": "multiply",
            "left": {"kind": "column", "value": "a"},
            "right": {"kind": "column", "value": "b"},
        },
        frame,
    )
    assert mul["prod"].tolist() == [20, 80]

    div = _run(
        "derived_column",
        {
            "name": "quot",
            "operation": "divide",
            "left": {"kind": "column", "value": "a"},
            "right": {"kind": "column", "value": "b"},
        },
        frame,
    )
    assert div["quot"].tolist() == [5.0, 5.0]

    concat = _run(
        "derived_column",
        {
            "name": "label",
            "operation": "concat",
            "left": {"kind": "column", "value": "name"},
            "right": {"kind": "literal", "value": "-ok"},
        },
        frame,
    )
    assert concat["label"].tolist() == ["A-ok", "B-ok"]

    with pytest.raises(PreparationExecutionError, match="missing"):
        _run(
            "derived_column",
            {
                "name": "x",
                "operation": "add",
                "left": {"kind": "column", "value": "missing"},
                "right": {"kind": "literal", "value": 1},
            },
            frame,
        )

    with pytest.raises(PreparationExecutionError, match="already exists"):
        _run(
            "derived_column",
            {
                "name": "a",
                "operation": "add",
                "left": {"kind": "column", "value": "a"},
                "right": {"kind": "literal", "value": 1},
            },
            frame,
        )

    with pytest.raises(PreparationExecutionError, match="division by zero"):
        _run(
            "derived_column",
            {
                "name": "bad",
                "operation": "divide",
                "left": {"kind": "column", "value": "a"},
                "right": {"kind": "literal", "value": 0},
            },
            frame,
        )


# ---------------------------------------------------------------------------
# Chain integration
# ---------------------------------------------------------------------------


def test_chain_source_filter_select_derived_rename_cast_dedupe_output():
    frame = pd.DataFrame(
        {
            "id": [1, 1, 2, 3],
            "amount": [10, 10, 20, 5],
            "flag": ["1", "1", "0", "1"],
            "note": ["keep", "keep", "keep", "drop"],
        }
    )
    graph = {
        "schema_version": 1,
        "nodes": [
            {"id": "src", "type": "source", "config": {"dataset_id": 1}},
            {
                "id": "flt",
                "type": "filter",
                "config": {
                    "combine": "and",
                    "conditions": [
                        {"column": "note", "operator": "neq", "value": "drop"}
                    ],
                },
            },
            {
                "id": "sel",
                "type": "select",
                "config": {"columns": ["id", "amount", "flag"]},
            },
            {
                "id": "der",
                "type": "derived_column",
                "config": {
                    "name": "amount2",
                    "operation": "multiply",
                    "left": {"kind": "column", "value": "amount"},
                    "right": {"kind": "literal", "value": 2},
                },
            },
            {
                "id": "ren",
                "type": "rename",
                "config": {"mapping": {"amount2": "doubled"}},
            },
            {
                "id": "cst",
                "type": "cast",
                "config": {"casts": {"flag": "integer", "doubled": "float"}},
            },
            {
                "id": "ded",
                "type": "deduplicate",
                "config": {"columns": ["id"], "keep": "first"},
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "src", "target": "flt"},
            {"id": "e2", "source": "flt", "target": "sel"},
            {"id": "e3", "source": "sel", "target": "der"},
            {"id": "e4", "source": "der", "target": "ren"},
            {"id": "e5", "source": "ren", "target": "cst"},
            {"id": "e6", "source": "cst", "target": "ded"},
            {"id": "e7", "source": "ded", "target": "out"},
        ],
    }
    result = execute_preparation_graph(graph, {"src": frame})
    assert list(result.columns) == ["id", "amount", "flag", "doubled"]
    assert len(result) == 2
    assert result["id"].tolist() == [1, 2]
    assert result["doubled"].tolist() == [20.0, 40.0]
    assert result["flag"].tolist() == [1, 0]


# ---------------------------------------------------------------------------
# Preview API (HTTP) — one transform flow
# ---------------------------------------------------------------------------


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
        db.add(admin)
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


def test_preview_api_one_transform_flow(client, auth_headers):
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"name": f"prep-tx-{secrets.token_hex(4)}", "description": ""},
    )
    assert project.status_code == 201, project.text
    project_id = project.json()["id"]

    upload = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={
            "file": (
                "tx.csv",
                b"customer_id,amount\n1,10\n2,20\n3,30\n",
                "text/csv",
            )
        },
        data={"name": "tx.csv"},
    )
    assert upload.status_code == 201, upload.text
    dataset_id = upload.json()["id"]
    version_id = upload.json()["version"]["id"]

    prep = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations",
        headers=auth_headers,
        json={
            "name": "TxPrep",
            "description": "",
            "graph": {"schema_version": 1, "nodes": [], "edges": []},
        },
    )
    assert prep.status_code == 201, prep.text
    prep_id = prep.json()["id"]

    graph = {
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
                "id": "flt",
                "type": "filter",
                "config": {
                    "combine": "and",
                    "conditions": [
                        {"column": "amount", "operator": "gte", "value": 20}
                    ],
                },
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "src", "target": "flt"},
            {"id": "e2", "source": "flt", "target": "out"},
        ],
    }
    preview = client.post(
        f"/api/v1/projects/{project_id}/dataset-preparations/{prep_id}/preview",
        headers=auth_headers,
        json={"graph": graph, "limit": 20},
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["sampled"] is True
    assert body["columns"] == ["customer_id", "amount"]
    assert len(body["rows"]) == 2
    assert {row["amount"] for row in body["rows"]} == {20, 30}

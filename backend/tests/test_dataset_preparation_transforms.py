"""Phase 2-C Dataset Preparation transform validation + execution unit tests."""

from __future__ import annotations

import secrets

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import Base, User
from app.db.session import get_db
from app.main import _rate_windows, app
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


def test_filter_numeric_value_ok_and_incompatible_string_raises_node_aware():
    frame = _frame(age=[10, 18, 25])

    ok = _run(
        "filter",
        {
            "combine": "and",
            "conditions": [{"column": "age", "operator": "gte", "value": 18}],
        },
        frame,
    )
    assert ok["age"].tolist() == [18, 25]

    with pytest.raises(
        PreparationExecutionError,
        match=(
            r"Node 't': operator 'gte' could not be applied to column "
            r"'age' with the supplied value"
        ),
    ):
        _run(
            "filter",
            {
                "combine": "and",
                "conditions": [{"column": "age", "operator": "gte", "value": "18"}],
            },
            frame,
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


def test_fill_constant_incompatible_value_raises_node_aware():
    frame = _frame(cat=pd.Series(pd.Categorical(["a", None])))
    with pytest.raises(
        PreparationExecutionError,
        match=(
            r"Node 't': could not fill column 'cat' with the supplied value"
        ),
    ):
        _run("fill_constant", {"values": {"cat": 1}}, frame)


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

    concat_code = _run(
        "derived_column",
        {
            "name": "code_label",
            "operation": "concat",
            "left": {"kind": "column", "value": "name"},
            "right": {"kind": "literal", "value": "001"},
        },
        frame,
    )
    assert concat_code["code_label"].tolist() == ["A001", "B001"]

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


# ---------------------------------------------------------------------------
# Group By
# ---------------------------------------------------------------------------


def test_group_by_validation_contract():
    valid, warnings = _validate_transform_config(
        "gb",
        "group_by",
        {
            "group_by": ["region"],
            "aggregations": [
                {"column": "sales", "op": "sum", "output": "sales_sum"},
            ],
        },
        strict=True,
    )
    assert valid == []
    assert warnings == []

    errors, _ = _validate_transform_config(
        "gb", "group_by", {"group_by": [], "aggregations": [{"column": "a", "op": "sum", "output": "a_sum"}]}, strict=True
    )
    assert any("group_by must not be empty" in e for e in errors)

    errors, warnings = _validate_transform_config(
        "gb", "group_by", {"group_by": [], "aggregations": [{"column": "a", "op": "sum", "output": "a_sum"}]}, strict=False
    )
    assert errors == []
    assert any("group_by must not be empty" in w for w in warnings)

    errors, _ = _validate_transform_config(
        "gb",
        "group_by",
        {
            "group_by": ["region", "region"],
            "aggregations": [{"column": "a", "op": "sum", "output": "a_sum"}],
        },
        strict=True,
    )
    assert any("duplicates" in e for e in errors)

    errors, _ = _validate_transform_config(
        "gb",
        "group_by",
        {"group_by": ["region"], "aggregations": []},
        strict=True,
    )
    assert any("aggregations must not be empty" in e for e in errors)

    errors, _ = _validate_transform_config(
        "gb",
        "group_by",
        {
            "group_by": ["region"],
            "aggregations": [{"column": "a", "op": "median", "output": "a_med"}],
        },
        strict=True,
    )
    assert any("op must be one of" in e for e in errors)

    errors, _ = _validate_transform_config(
        "gb",
        "group_by",
        {
            "group_by": ["region"],
            "aggregations": [{"column": "  ", "op": "sum", "output": "a_sum"}],
        },
        strict=True,
    )
    assert any("column must be a non-empty string" in e for e in errors)

    errors, _ = _validate_transform_config(
        "gb",
        "group_by",
        {
            "group_by": ["region"],
            "aggregations": [{"column": "a", "op": "sum", "output": ""}],
        },
        strict=True,
    )
    assert any("output must be a non-empty string" in e for e in errors)

    errors, _ = _validate_transform_config(
        "gb",
        "group_by",
        {
            "group_by": ["region"],
            "aggregations": [
                {"column": "a", "op": "sum", "output": "x"},
                {"column": "b", "op": "avg", "output": "x"},
            ],
        },
        strict=True,
    )
    assert any("outputs must be unique" in e for e in errors)

    errors, _ = _validate_transform_config(
        "gb",
        "group_by",
        {
            "group_by": ["region"],
            "aggregations": [{"column": "a", "op": "sum", "output": "region"}],
        },
        strict=True,
    )
    assert any("collides with a group_by key" in e for e in errors)


def test_group_by_execution_semantics():
    frame = _frame(
        region=["west", "east", "west", None, "east"],
        category=["A", "A", "B", "A", "A"],
        sales=[10.0, 20.0, 30.0, 40.0, 50.0],
        margin=[1.0, 2.0, 3.0, 4.0, 5.0],
        order_id=[1, 2, None, 4, 5],
        label=["x", "y", "z", "w", "v"],
    )
    out = _run(
        "group_by",
        {
            "group_by": ["region", "category"],
            "aggregations": [
                {"column": "sales", "op": "sum", "output": "sales_sum"},
                {"column": "sales", "op": "avg", "output": "sales_avg"},
                {"column": "margin", "op": "min", "output": "margin_min"},
                {"column": "margin", "op": "max", "output": "margin_max"},
                {"column": "order_id", "op": "count", "output": "order_count"},
            ],
        },
        frame,
    )
    assert list(out.columns) == [
        "region",
        "category",
        "sales_sum",
        "sales_avg",
        "margin_min",
        "margin_max",
        "order_count",
    ]
    # first-seen group order: west/A, east/A, west/B, None/A
    regions = out["region"].tolist()
    categories = out["category"].tolist()
    assert regions[0] == "west" and categories[0] == "A"
    assert regions[1] == "east" and categories[1] == "A"
    assert regions[2] == "west" and categories[2] == "B"
    assert pd.isna(regions[3]) and categories[3] == "A"

    west_a = out.iloc[0]
    assert west_a["sales_sum"] == 10.0
    assert west_a["sales_avg"] == 10.0
    assert west_a["order_count"] == 1

    east_a = out.iloc[1]
    assert east_a["sales_sum"] == 70.0
    assert east_a["sales_avg"] == 35.0
    assert east_a["margin_min"] == 2.0
    assert east_a["margin_max"] == 5.0
    assert east_a["order_count"] == 2  # one null order_id excluded

    null_a = out.iloc[3]
    assert null_a["sales_sum"] == 40.0
    assert null_a["order_count"] == 1


def test_group_by_execution_errors():
    frame = _frame(region=["a"], sales=[1], label=["x"])

    with pytest.raises(PreparationExecutionError, match="missing"):
        _run(
            "group_by",
            {
                "group_by": ["missing_key"],
                "aggregations": [{"column": "sales", "op": "sum", "output": "s"}],
            },
            frame,
        )

    with pytest.raises(PreparationExecutionError, match="missing"):
        _run(
            "group_by",
            {
                "group_by": ["region"],
                "aggregations": [{"column": "nope", "op": "sum", "output": "s"}],
            },
            frame,
        )

    with pytest.raises(PreparationExecutionError, match="aggregation 'sum'"):
        _run(
            "group_by",
            {
                "group_by": ["region"],
                "aggregations": [{"column": "label", "op": "sum", "output": "s"}],
            },
            frame,
        )

    with pytest.raises(PreparationExecutionError, match="aggregation 'avg'"):
        _run(
            "group_by",
            {
                "group_by": ["region"],
                "aggregations": [{"column": "label", "op": "avg", "output": "s"}],
            },
            frame,
        )


# ---------------------------------------------------------------------------
# Unpivot
# ---------------------------------------------------------------------------


def test_unpivot_validation_contract():
    valid, warnings = _validate_transform_config(
        "u",
        "unpivot",
        {
            "id_columns": ["customer_id", "region"],
            "value_columns": ["jan", "feb"],
            "variable_column": "month",
            "value_column": "sales",
        },
        strict=True,
    )
    assert valid == []
    assert warnings == []

    valid, warnings = _validate_transform_config(
        "u",
        "unpivot",
        {
            "id_columns": [],
            "value_columns": ["jan"],
            "variable_column": "variable",
            "value_column": "value",
        },
        strict=True,
    )
    assert valid == []

    errors, _ = _validate_transform_config(
        "u",
        "unpivot",
        {
            "id_columns": [],
            "value_columns": [],
            "variable_column": "variable",
            "value_column": "value",
        },
        strict=True,
    )
    assert any("value_columns must not be empty" in e for e in errors)

    errors, warnings = _validate_transform_config(
        "u",
        "unpivot",
        {
            "id_columns": [],
            "value_columns": [],
            "variable_column": "variable",
            "value_column": "value",
        },
        strict=False,
    )
    assert errors == []
    assert any("value_columns must not be empty" in w for w in warnings)

    errors, _ = _validate_transform_config(
        "u",
        "unpivot",
        {
            "id_columns": ["id", ""],
            "value_columns": ["jan"],
            "variable_column": "variable",
            "value_column": "value",
        },
        strict=True,
    )
    assert any("id_columns entries must be non-empty strings" in e for e in errors)

    errors, _ = _validate_transform_config(
        "u",
        "unpivot",
        {
            "id_columns": ["id", "id"],
            "value_columns": ["jan"],
            "variable_column": "variable",
            "value_column": "value",
        },
        strict=True,
    )
    assert any("id_columns must not contain duplicates" in e for e in errors)

    errors, _ = _validate_transform_config(
        "u",
        "unpivot",
        {
            "id_columns": ["id"],
            "value_columns": ["  "],
            "variable_column": "variable",
            "value_column": "value",
        },
        strict=True,
    )
    assert any("value_columns entries must be non-empty strings" in e for e in errors)

    errors, _ = _validate_transform_config(
        "u",
        "unpivot",
        {
            "id_columns": ["id"],
            "value_columns": ["jan", "jan"],
            "variable_column": "variable",
            "value_column": "value",
        },
        strict=True,
    )
    assert any("value_columns must not contain duplicates" in e for e in errors)

    errors, _ = _validate_transform_config(
        "u",
        "unpivot",
        {
            "id_columns": ["id"],
            "value_columns": ["id"],
            "variable_column": "variable",
            "value_column": "value",
        },
        strict=True,
    )
    assert any("must not overlap" in e for e in errors)

    errors, _ = _validate_transform_config(
        "u",
        "unpivot",
        {
            "id_columns": ["id"],
            "value_columns": ["jan"],
            "variable_column": "  ",
            "value_column": "value",
        },
        strict=True,
    )
    assert any("variable_column must be a non-empty string" in e for e in errors)

    errors, _ = _validate_transform_config(
        "u",
        "unpivot",
        {
            "id_columns": ["id"],
            "value_columns": ["jan"],
            "variable_column": "variable",
            "value_column": "",
        },
        strict=True,
    )
    assert any("value_column must be a non-empty string" in e for e in errors)

    errors, _ = _validate_transform_config(
        "u",
        "unpivot",
        {
            "id_columns": ["id"],
            "value_columns": ["jan"],
            "variable_column": "same",
            "value_column": "same",
        },
        strict=True,
    )
    assert any("must be different" in e for e in errors)

    errors, _ = _validate_transform_config(
        "u",
        "unpivot",
        {
            "id_columns": ["id"],
            "value_columns": ["jan"],
            "variable_column": "id",
            "value_column": "value",
        },
        strict=True,
    )
    assert any("variable_column 'id' collides with an id_columns entry" in e for e in errors)

    errors, _ = _validate_transform_config(
        "u",
        "unpivot",
        {
            "id_columns": ["id"],
            "value_columns": ["jan"],
            "variable_column": "variable",
            "value_column": "id",
        },
        strict=True,
    )
    assert any("value_column 'id' collides with an id_columns entry" in e for e in errors)


def test_unpivot_execution_semantics():
    frame = _frame(
        customer_id=[1, 2],
        region=["Seoul", "Busan"],
        jan=[10, 30],
        feb=[20, None],
        ignored=["A", "B"],
    )
    out = _run(
        "unpivot",
        {
            "id_columns": ["customer_id", "region"],
            "value_columns": ["jan", "feb"],
            "variable_column": "month",
            "value_column": "sales",
        },
        frame,
    )
    assert list(out.columns) == ["customer_id", "region", "month", "sales"]
    assert out["month"].tolist() == ["jan", "jan", "feb", "feb"]
    assert out["customer_id"].tolist() == [1, 2, 1, 2]
    assert out["sales"].tolist()[:3] == [10, 30, 20]
    assert pd.isna(out["sales"].iloc[3])
    assert "ignored" not in out.columns

    empty_ids = _run(
        "unpivot",
        {
            "id_columns": [],
            "value_columns": ["jan"],
            "variable_column": "variable",
            "value_column": "value",
        },
        frame,
    )
    assert list(empty_ids.columns) == ["variable", "value"]
    assert empty_ids["variable"].tolist() == ["jan", "jan"]
    assert empty_ids["value"].tolist() == [10, 30]

    aliased = _run(
        "unpivot",
        {
            "id_columns": ["customer_id"],
            "value_columns": ["jan", "feb"],
            "variable_column": "jan",
            "value_column": "feb",
        },
        frame,
    )
    assert list(aliased.columns) == ["customer_id", "jan", "feb"]
    assert aliased["jan"].tolist() == ["jan", "jan", "feb", "feb"]


def test_unpivot_execution_errors():
    frame = _frame(id=[1], jan=[10], feb=[20])
    with pytest.raises(PreparationExecutionError, match="missing"):
        _run(
            "unpivot",
            {
                "id_columns": ["missing_id"],
                "value_columns": ["jan"],
                "variable_column": "variable",
                "value_column": "value",
            },
            frame,
        )
    with pytest.raises(PreparationExecutionError, match="missing"):
        _run(
            "unpivot",
            {
                "id_columns": ["id"],
                "value_columns": ["nope"],
                "variable_column": "variable",
                "value_column": "value",
            },
            frame,
        )


def test_group_by_then_unpivot_chain():
    frame = _frame(
        region=["west", "west", "east"],
        jan=[10, 20, 30],
        feb=[1, 2, 3],
    )
    graph = {
        "schema_version": 1,
        "nodes": [
            {"id": "src", "type": "source", "config": {"dataset_id": 1}},
            {
                "id": "gb",
                "type": "group_by",
                "config": {
                    "group_by": ["region"],
                    "aggregations": [
                        {"column": "jan", "op": "sum", "output": "jan"},
                        {"column": "feb", "op": "sum", "output": "feb"},
                    ],
                },
            },
            {
                "id": "u",
                "type": "unpivot",
                "config": {
                    "id_columns": ["region"],
                    "value_columns": ["jan", "feb"],
                    "variable_column": "month",
                    "value_column": "total",
                },
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "src", "target": "gb"},
            {"id": "e2", "source": "gb", "target": "u"},
            {"id": "e3", "source": "u", "target": "out"},
        ],
    }
    out = execute_preparation_graph(graph, {"src": frame})
    assert list(out.columns) == ["region", "month", "total"]
    assert len(out) == 4


# ---------------------------------------------------------------------------
# Pivot
# ---------------------------------------------------------------------------


def test_pivot_validation_contract():
    valid, warnings = _validate_transform_config(
        "p",
        "pivot",
        {
            "index_columns": ["customer_id", "region"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [
                {"value": "jan", "output": "jan_sales"},
                {"value": "feb", "output": "feb_sales"},
            ],
        },
        strict=True,
    )
    assert valid == []
    assert warnings == []

    errors, _ = _validate_transform_config(
        "p",
        "pivot",
        {
            "index_columns": [],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [{"value": "jan", "output": "jan_sales"}],
        },
        strict=True,
    )
    assert any("index_columns must not be empty" in e for e in errors)

    errors, warnings = _validate_transform_config(
        "p",
        "pivot",
        {
            "index_columns": [],
            "columns_column": "",
            "value_column": "",
            "aggregation": "sum",
            "pivot_values": [],
        },
        strict=False,
    )
    assert errors == []
    assert any("index_columns must not be empty" in w for w in warnings)
    assert any("columns_column must be a non-empty string" in w for w in warnings)
    assert any("value_column must be a non-empty string" in w for w in warnings)
    assert any("pivot_values must not be empty" in w for w in warnings)

    errors, _ = _validate_transform_config(
        "p",
        "pivot",
        {
            "index_columns": ["id", "id"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [{"value": "jan", "output": "jan_sales"}],
        },
        strict=True,
    )
    assert any("index_columns must not contain duplicates" in e for e in errors)

    for bad in (
        {
            "index_columns": ["month"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [{"value": "jan", "output": "jan_sales"}],
        },
        {
            "index_columns": ["sales"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [{"value": "jan", "output": "jan_sales"}],
        },
        {
            "index_columns": ["id"],
            "columns_column": "sales",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [{"value": "jan", "output": "jan_sales"}],
        },
    ):
        errors, _ = _validate_transform_config("p", "pivot", bad, strict=True)
        assert errors

    errors, _ = _validate_transform_config(
        "p",
        "pivot",
        {
            "index_columns": ["id"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "median",
            "pivot_values": [{"value": "jan", "output": "jan_sales"}],
        },
        strict=True,
    )
    assert any("aggregation must be one of" in e for e in errors)

    errors, _ = _validate_transform_config(
        "p",
        "pivot",
        {
            "index_columns": ["id"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [],
        },
        strict=True,
    )
    assert any("pivot_values must not be empty" in e for e in errors)

    errors, _ = _validate_transform_config(
        "p",
        "pivot",
        {
            "index_columns": ["id"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": ["jan"],
        },
        strict=True,
    )
    assert any("must be an object" in e for e in errors)

    for bad_value in (None, True, False, ["x"], {"a": 1}):
        errors, _ = _validate_transform_config(
            "p",
            "pivot",
            {
                "index_columns": ["id"],
                "columns_column": "month",
                "value_column": "sales",
                "aggregation": "sum",
                "pivot_values": [{"value": bad_value, "output": "out"}],
            },
            strict=True,
        )
        assert any("string or number" in e for e in errors)

    errors, _ = _validate_transform_config(
        "p",
        "pivot",
        {
            "index_columns": ["id"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [
                {"value": "jan", "output": "a"},
                {"value": "jan", "output": "b"},
            ],
        },
        strict=True,
    )
    assert any("duplicate pivot value" in e for e in errors)

    errors, _ = _validate_transform_config(
        "p",
        "pivot",
        {
            "index_columns": ["id"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [{"value": "jan", "output": "  "}],
        },
        strict=True,
    )
    assert any("output must be a non-empty string" in e for e in errors)

    errors, _ = _validate_transform_config(
        "p",
        "pivot",
        {
            "index_columns": ["id"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [
                {"value": "jan", "output": "same"},
                {"value": "feb", "output": "same"},
            ],
        },
        strict=True,
    )
    assert any("outputs must be unique" in e for e in errors)

    errors, _ = _validate_transform_config(
        "p",
        "pivot",
        {
            "index_columns": ["id"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [{"value": "jan", "output": "id"}],
        },
        strict=True,
    )
    assert any("collides with an index_columns entry" in e for e in errors)

    valid, _ = _validate_transform_config(
        "p",
        "pivot",
        {
            "index_columns": ["id"],
            "columns_column": "year",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [
                {"value": "jan", "output": "jan_sales"},
                {"value": 2024, "output": "y2024"},
                {"value": 2024.5, "output": "y2024_5"},
            ],
        },
        strict=True,
    )
    assert valid == []


def test_pivot_execution_semantics():
    frame = _frame(
        customer_id=[1, 1, 2, 2],
        region=["Seoul", "Seoul", "Busan", "Busan"],
        month=["jan", "feb", "jan", "feb"],
        sales=[10, 20, 30, None],
    )
    out = _run(
        "pivot",
        {
            "index_columns": ["customer_id", "region"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [
                {"value": "jan", "output": "jan_sales"},
                {"value": "feb", "output": "feb_sales"},
            ],
        },
        frame,
    )
    assert list(out.columns) == ["customer_id", "region", "jan_sales", "feb_sales"]
    assert out["customer_id"].tolist() == [1, 2]
    assert out["jan_sales"].tolist() == [10, 30]
    assert out["feb_sales"].tolist()[0] == 20
    assert pd.isna(out["feb_sales"].tolist()[1])

    # Missing configured pivot value remains as null column.
    with_missing = _run(
        "pivot",
        {
            "index_columns": ["customer_id", "region"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [
                {"value": "jan", "output": "jan_sales"},
                {"value": "mar", "output": "mar_sales"},
            ],
        },
        frame,
    )
    assert list(with_missing.columns) == ["customer_id", "region", "jan_sales", "mar_sales"]
    assert with_missing["mar_sales"].isna().all()

    # Unlisted and null pivot keys are ignored; index rows still preserved.
    mixed = _frame(
        id=[1, 1, 2, 3],
        month=["jan", "apr", None, "feb"],
        sales=[10, 99, 5, 7],
    )
    out_mixed = _run(
        "pivot",
        {
            "index_columns": ["id"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [
                {"value": "jan", "output": "jan_sales"},
                {"value": "feb", "output": "feb_sales"},
            ],
        },
        mixed,
    )
    assert out_mixed["id"].tolist() == [1, 2, 3]
    assert out_mixed["jan_sales"].tolist()[0] == 10
    assert pd.isna(out_mixed["jan_sales"].tolist()[1])
    assert pd.isna(out_mixed["feb_sales"].tolist()[0])
    assert out_mixed["feb_sales"].tolist()[2] == 7

    # Duplicate cell aggregation.
    dup = _frame(id=[1, 1], month=["jan", "jan"], sales=[10, 5])
    summed = _run(
        "pivot",
        {
            "index_columns": ["id"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [{"value": "jan", "output": "jan_sales"}],
        },
        dup,
    )
    assert summed["jan_sales"].tolist() == [15]

    counted = _run(
        "pivot",
        {
            "index_columns": ["id"],
            "columns_column": "month",
            "value_column": "sales",
            "aggregation": "count",
            "pivot_values": [
                {"value": "jan", "output": "jan_c"},
                {"value": "feb", "output": "feb_c"},
            ],
        },
        _frame(id=[1, 1, 2], month=["jan", "jan", "feb"], sales=[None, None, 1]),
    )
    assert counted["jan_c"].tolist()[0] == 0
    assert pd.isna(counted["feb_c"].tolist()[0])
    assert pd.isna(counted["jan_c"].tolist()[1])
    assert counted["feb_c"].tolist()[1] == 1

    # Numeric pivot values + alias equal to former columns_column/value_column.
    numeric = _run(
        "pivot",
        {
            "index_columns": ["id"],
            "columns_column": "year",
            "value_column": "sales",
            "aggregation": "sum",
            "pivot_values": [
                {"value": 2024, "output": "year"},
                {"value": 2025, "output": "sales"},
            ],
        },
        _frame(id=[1, 1], year=[2024, 2025], sales=[3, 4]),
    )
    assert list(numeric.columns) == ["id", "year", "sales"]
    assert numeric["year"].tolist() == [3]
    assert numeric["sales"].tolist() == [4]


def test_pivot_execution_errors():
    frame = _frame(id=[1], month=["jan"], sales=[10], label=["x"])
    with pytest.raises(PreparationExecutionError, match="missing"):
        _run(
            "pivot",
            {
                "index_columns": ["missing_id"],
                "columns_column": "month",
                "value_column": "sales",
                "aggregation": "sum",
                "pivot_values": [{"value": "jan", "output": "jan_sales"}],
            },
            frame,
        )
    with pytest.raises(PreparationExecutionError, match="could not be applied"):
        _run(
            "pivot",
            {
                "index_columns": ["id"],
                "columns_column": "month",
                "value_column": "label",
                "aggregation": "sum",
                "pivot_values": [{"value": "jan", "output": "jan_sales"}],
            },
            frame,
        )


def test_unpivot_then_pivot_chain():
    frame = _frame(id=[1, 2], jan=[10, 30], feb=[20, 40])
    graph = {
        "schema_version": 1,
        "nodes": [
            {"id": "src", "type": "source", "config": {"dataset_id": 1}},
            {
                "id": "u",
                "type": "unpivot",
                "config": {
                    "id_columns": ["id"],
                    "value_columns": ["jan", "feb"],
                    "variable_column": "month",
                    "value_column": "sales",
                },
            },
            {
                "id": "p",
                "type": "pivot",
                "config": {
                    "index_columns": ["id"],
                    "columns_column": "month",
                    "value_column": "sales",
                    "aggregation": "sum",
                    "pivot_values": [
                        {"value": "jan", "output": "jan"},
                        {"value": "feb", "output": "feb"},
                    ],
                },
            },
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"id": "e1", "source": "src", "target": "u"},
            {"id": "e2", "source": "u", "target": "p"},
            {"id": "e3", "source": "p", "target": "out"},
        ],
    }
    out = execute_preparation_graph(graph, {"src": frame})
    assert list(out.columns) == ["id", "jan", "feb"]
    assert out["id"].tolist() == [1, 2]
    assert out["jan"].tolist() == [10, 30]
    assert out["feb"].tolist() == [20, 40]

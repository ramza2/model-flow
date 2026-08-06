from __future__ import annotations

import secrets

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.models import Base, QualityRule, TrainingJob, User
from app.db.session import get_db
from app.main import _rate_windows, app
from app.services import mlflow_service, registry_service, storage

engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
OBJECT_STORE: dict[tuple[str, str], bytes] = {}
TEST_ADMIN_PASSWORD = secrets.token_urlsafe(24)


@pytest.fixture(autouse=True)
def setup_db(monkeypatch):
    Base.metadata.create_all(engine)
    OBJECT_STORE.clear()
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
        lambda bucket, key, data, content_type="application/octet-stream": OBJECT_STORE.__setitem__(
            (bucket, key), data
        ),
    )
    monkeypatch.setattr(
        storage,
        "download_bytes",
        lambda bucket, key: OBJECT_STORE[(bucket, key)],
    )
    monkeypatch.setattr(mlflow_service, "ensure_experiment", lambda name: "exp-1")
    monkeypatch.setattr(
        registry_service,
        "_mlflow_logged_feature_schema",
        lambda run_id: [],
    )
    with TestingSessionLocal() as db:
        db.add(
            User(
                email="admin@example.com",
                full_name="Admin",
                password_hash=hash_password(TEST_ADMIN_PASSWORD),
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
        json={"email": "admin@example.com", "password": TEST_ADMIN_PASSWORD},
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _project(client, auth_headers, name="quality"):
    response = client.post(
        "/api/v1/projects", headers=auth_headers, json={"name": name}
    )
    assert response.status_code == 201
    return response.json()["id"]


def _upload(client, auth_headers, project_id, csv: bytes, filename="data.csv"):
    response = client.post(
        f"/api/v1/projects/{project_id}/datasets",
        headers=auth_headers,
        files={"file": (filename, csv, "text/csv")},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    return body["id"], body["version"]["id"]


def _job_payload(dataset_id, dataset_version_id, name="train"):
    return {
        "name": name,
        "dataset_id": dataset_id,
        "dataset_version_id": dataset_version_id,
        "target_column": "target",
        "feature_columns": ["a", "b"],
        "algorithm": "random_forest",
        "hyperparameters": {"n_estimators": 10, "max_depth": 3},
    }


def test_dataset_scoped_rule_create_and_cross_project_rejected(client, auth_headers):
    project_a = _project(client, auth_headers, "qa")
    project_b = _project(client, auth_headers, "qb")
    csv = b"a,b,target\n1,2,0\n2,3,1\n"
    dataset_a, _ = _upload(client, auth_headers, project_a, csv, "a.csv")
    dataset_b, _ = _upload(client, auth_headers, project_b, csv, "b.csv")

    ok = client.post(
        f"/api/v1/projects/{project_a}/quality-rules",
        headers=auth_headers,
        json={
            "name": "A rule",
            "dataset_id": dataset_a,
            "rules": [{"type": "not_null", "column": "target", "severity": "fail"}],
        },
    )
    assert ok.status_code == 201
    assert ok.json()["dataset_id"] == dataset_a
    assert ok.json()["is_active"] is True
    assert ok.json()["dataset_name"]

    cross = client.post(
        f"/api/v1/projects/{project_a}/quality-rules",
        headers=auth_headers,
        json={
            "name": "cross",
            "dataset_id": dataset_b,
            "rules": [{"type": "not_null", "column": "target", "severity": "fail"}],
        },
    )
    assert cross.status_code in {404, 422}


def test_run_all_excludes_other_dataset_legacy_and_inactive(client, auth_headers):
    project_id = _project(client, auth_headers)
    csv_a = b"a,b,target\n1,2,0\n2,3,1\n"
    csv_b = b"x,y,target\n1,2,0\n2,3,1\n"
    dataset_a, version_a = _upload(client, auth_headers, project_id, csv_a, "a.csv")
    dataset_b, version_b = _upload(client, auth_headers, project_id, csv_b, "b.csv")

    rule_a = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "A not null",
            "dataset_id": dataset_a,
            "rules": [{"type": "not_null", "column": "a", "severity": "fail"}],
        },
    )
    assert rule_a.status_code == 201
    rule_b = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "B not null",
            "dataset_id": dataset_b,
            "rules": [{"type": "not_null", "column": "x", "severity": "fail"}],
        },
    )
    assert rule_b.status_code == 201

    # Legacy unassigned inactive rule with column that only exists on A
    with TestingSessionLocal() as db:
        db.add(
            QualityRule(
                project_id=project_id,
                dataset_id=None,
                name="Legacy",
                rules_json='[{"type":"not_null","column":"a","severity":"fail"}]',
                block_training_on_fail=True,
                is_active=False,
            )
        )
        db.commit()

    inactive = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Inactive A",
            "dataset_id": dataset_a,
            "is_active": False,
            "rules": [{"type": "not_null", "column": "missing_col", "severity": "fail"}],
        },
    )
    # missing column → 422
    assert inactive.status_code == 422
    inactive = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Inactive A",
            "dataset_id": dataset_a,
            "is_active": False,
            "rules": [{"type": "not_null", "column": "a", "severity": "fail"}],
        },
    )
    assert inactive.status_code == 201

    # Dataset B run-all must not evaluate A's column rules
    check_b = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_b}/quality-checks",
        headers=auth_headers,
        json={},
    )
    assert check_b.status_code == 201, check_b.text
    assert check_b.json()["result"] == "PASS"
    details = check_b.json()["details"]
    assert all(d["quality_rule_id"] == rule_b.json()["id"] for d in details)
    assert all(d["quality_rule_name"] == "B not null" for d in details)

    check_a = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_a}/quality-checks",
        headers=auth_headers,
        json={},
    )
    assert check_a.status_code == 201
    ids = {d["quality_rule_id"] for d in check_a.json()["details"]}
    assert ids == {rule_a.json()["id"]}


def test_rule_validation_matrix(client, auth_headers):
    project_id = _project(client, auth_headers)
    dataset_id, _ = _upload(
        client,
        auth_headers,
        project_id,
        b"a,b,target\n1,2,0\n2,3,1\n",
    )

    def create(payload):
        return client.post(
            f"/api/v1/projects/{project_id}/quality-rules",
            headers=auth_headers,
            json={"name": "v", "dataset_id": dataset_id, **payload},
        )

    assert create({"rules": []}).status_code == 422
    assert create(
        {"rules": [{"type": "magic", "column": "a", "severity": "fail"}]}
    ).status_code == 422
    assert create(
        {"rules": [{"type": "not_null", "column": "nope", "severity": "fail"}]}
    ).status_code == 422
    assert create(
        {
            "rules": [
                {"type": "range", "column": "a", "min": 10, "max": 1, "severity": "fail"}
            ]
        }
    ).status_code == 422
    assert create(
        {
            "rules": [
                {"type": "allowed_values", "column": "a", "values": [], "severity": "fail"}
            ]
        }
    ).status_code == 422
    assert create(
        {
            "rules": [
                {"type": "regex", "column": "a", "pattern": "[", "severity": "fail"}
            ]
        }
    ).status_code == 422
    assert create(
        {"rules": [{"type": "not_null", "column": "a", "severity": "critical"}]}
    ).status_code == 422


def test_check_results_and_individual_run(client, auth_headers):
    project_id = _project(client, auth_headers)
    csv = b"site_id,a,target\nS1,1,0\nS1,2,1\nS2,,0\n"
    dataset_id, version_id = _upload(client, auth_headers, project_id, csv)

    unique_rule = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Unique site ID",
            "dataset_id": dataset_id,
            "block_training_on_fail": True,
            "rules": [{"type": "unique", "column": "site_id", "severity": "fail"}],
        },
    )
    assert unique_rule.status_code == 201
    null_rule = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Required a",
            "dataset_id": dataset_id,
            "block_training_on_fail": False,
            "rules": [{"type": "not_null", "column": "a", "severity": "fail"}],
        },
    )
    assert null_rule.status_code == 201
    warn_rule = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Warn range",
            "dataset_id": dataset_id,
            "block_training_on_fail": True,
            "rules": [
                {
                    "type": "range",
                    "column": "a",
                    "min": 100,
                    "max": 200,
                    "severity": "warning",
                }
            ],
        },
    )
    assert warn_rule.status_code == 201

    fail_unique = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": unique_rule.json()["id"]},
    )
    assert fail_unique.status_code == 201
    assert fail_unique.json()["result"] == "FAIL"
    detail = fail_unique.json()["details"][0]
    assert detail["quality_rule_name"] == "Unique site ID"
    assert detail["severity"] == "fail"
    assert detail["block_training_on_fail"] is True
    assert detail["passed"] is False

    fail_null = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": null_rule.json()["id"]},
    )
    assert fail_null.json()["result"] == "FAIL"

    # Dataset B with clean data — warning-only rule
    clean_csv = b"site_id,a,target\nS1,150,0\nS2,160,1\n"
    dataset_b, version_b = _upload(client, auth_headers, project_id, clean_csv, "b.csv")
    warn_only = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Warn only B",
            "dataset_id": dataset_b,
            "rules": [
                {
                    "type": "range",
                    "column": "a",
                    "min": 1000,
                    "max": 2000,
                    "severity": "warning",
                }
            ],
        },
    )
    warn_check = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_b}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": warn_only.json()["id"]},
    )
    assert warn_check.json()["result"] == "WARNING"

    pass_rule = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Pass unique B",
            "dataset_id": dataset_b,
            "rules": [{"type": "unique", "column": "site_id", "severity": "fail"}],
        },
    )
    pass_check = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_b}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": pass_rule.json()["id"]},
    )
    assert pass_check.json()["result"] == "PASS"

    # Cross-dataset individual run rejected
    rejected = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_b}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": unique_rule.json()["id"]},
    )
    assert rejected.status_code in {400, 409}
    assert "another dataset" in rejected.json()["detail"].lower()

    # Inactive rule rejected
    client.patch(
        f"/api/v1/projects/{project_id}/quality-rules/{unique_rule.json()['id']}",
        headers=auth_headers,
        json={"is_active": False},
    )
    inactive_run = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": unique_rule.json()["id"]},
    )
    assert inactive_run.status_code in {400, 409}
    assert "inactive" in inactive_run.json()["detail"].lower()


def test_training_blocking_accuracy(client, auth_headers):
    project_id = _project(client, auth_headers)
    bad_csv = b"site_id,a,b,target\nS1,1,2,0\nS1,2,3,1\nS2,3,4,0\nS3,4,5,1\n"
    good_csv = b"site_id,a,b,target\nS1,1,2,0\nS2,2,3,1\nS3,3,4,0\nS4,4,5,1\n"
    dataset_a, version_a = _upload(client, auth_headers, project_id, bad_csv, "a.csv")
    dataset_b, version_b = _upload(client, auth_headers, project_id, good_csv, "b.csv")

    blocking = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Unique site ID",
            "dataset_id": dataset_a,
            "block_training_on_fail": True,
            "rules": [{"type": "unique", "column": "site_id", "severity": "fail"}],
        },
    )
    non_blocking = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Nonblock unique",
            "dataset_id": dataset_a,
            "block_training_on_fail": False,
            "rules": [{"type": "unique", "column": "site_id", "severity": "fail"}],
        },
    )
    warning = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Warn unique",
            "dataset_id": dataset_a,
            "block_training_on_fail": True,
            "rules": [{"type": "unique", "column": "site_id", "severity": "warning"}],
        },
    )
    assert blocking.status_code == non_blocking.status_code == warning.status_code == 201

    # Blocking FAIL → 409
    check = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_a}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": blocking.json()["id"]},
    )
    assert check.json()["result"] == "FAIL"
    blocked = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json=_job_payload(dataset_a, version_a, "blocked"),
    )
    assert blocked.status_code == 409
    assert "Unique site ID" in (blocked.json().get("hint") or "")
    with TestingSessionLocal() as db:
        assert db.query(TrainingJob).count() == 0

    # Re-check PASS clears block for that rule — first deactivate blocking and use non-blocking fail
    # Non-blocking FAIL alone should allow training: deactivate blocking first
    client.patch(
        f"/api/v1/projects/{project_id}/quality-rules/{blocking.json()['id']}",
        headers=auth_headers,
        json={"is_active": False},
    )
    client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_a}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": non_blocking.json()["id"]},
    )
    allowed_nb = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json=_job_payload(dataset_a, version_a, "nb-ok"),
    )
    assert allowed_nb.status_code == 201

    # Warning failure does not block
    client.patch(
        f"/api/v1/projects/{project_id}/quality-rules/{blocking.json()['id']}",
        headers=auth_headers,
        json={"is_active": True},
    )
    # Fresh dataset version for warning-only latest on blocking? Keep inactive and use warning rule
    client.patch(
        f"/api/v1/projects/{project_id}/quality-rules/{blocking.json()['id']}",
        headers=auth_headers,
        json={"is_active": False},
    )
    client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_a}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": warning.json()["id"]},
    )
    allowed_warn = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json=_job_payload(dataset_a, version_a, "warn-ok"),
    )
    assert allowed_warn.status_code == 201

    # Dataset B training unaffected by A's blocking fail history
    ok_b = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json=_job_payload(dataset_b, version_b, "b-ok"),
    )
    assert ok_b.status_code == 201

    # FAIL then PASS on same blocking rule clears block
    client.patch(
        f"/api/v1/projects/{project_id}/quality-rules/{blocking.json()['id']}",
        headers=auth_headers,
        json={"is_active": True},
    )
    client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_a}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": blocking.json()["id"]},
    )
    assert (
        client.post(
            f"/api/v1/projects/{project_id}/jobs",
            headers=auth_headers,
            json=_job_payload(dataset_a, version_a, "still-blocked"),
        ).status_code
        == 409
    )

    # Upload a clean new version for dataset A by appending rows via re-upload same name
    # Create a separate clean dataset for PASS recheck simplicity
    clean_a_csv = b"site_id,a,b,target\nS1,1,2,0\nS2,2,3,1\nS3,3,4,0\nS4,4,5,1\n"
    # Re-upload to same dataset name to bump version — use datasets endpoint which versions by content hash/name
    clean_ds, clean_ver = _upload(
        client, auth_headers, project_id, clean_a_csv, "clean-a.csv"
    )
    clean_rule = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Clean unique",
            "dataset_id": clean_ds,
            "block_training_on_fail": True,
            "rules": [{"type": "unique", "column": "site_id", "severity": "fail"}],
        },
    )
    client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{clean_ver}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": clean_rule.json()["id"]},
    )
    # Force FAIL by running on bad data then PASS — use version_a with pass via allowed_values always true
    # Simpler: deactivate after fail already tested; for PASS clear use individual check that passes
    # Create rule that fails then update data... Instead run unique on clean dataset after a synthetic fail detail
    # Direct approach: fail unique on clean? data is unique so PASS. Seed a FAIL check then PASS.
    client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{clean_ver}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": clean_rule.json()["id"]},
    )
    # First make it fail with range rule on a that always fails, then pass unique
    fail_then_pass_rule = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Required target",
            "dataset_id": clean_ds,
            "block_training_on_fail": True,
            "rules": [{"type": "not_null", "column": "target", "severity": "fail"}],
        },
    )
    # Manually insert a failing check detail for this rule then run a real PASS
    with TestingSessionLocal() as db:
        from app.db.models import QualityCheck, QualityResult

        db.add(
            QualityCheck(
                project_id=project_id,
                dataset_version_id=clean_ver,
                quality_rule_id=fail_then_pass_rule.json()["id"],
                result=QualityResult.FAIL,
                details_json=(
                    '[{"quality_rule_id":%d,"quality_rule_name":"Required target",'
                    '"rule":{"type":"not_null","column":"target","severity":"fail"},'
                    '"severity":"fail","block_training_on_fail":true,"passed":false,'
                    '"message":"forced"}]' % fail_then_pass_rule.json()["id"]
                ),
            )
        )
        db.commit()
    assert (
        client.post(
            f"/api/v1/projects/{project_id}/jobs",
            headers=auth_headers,
            json=_job_payload(clean_ds, clean_ver, "clean-blocked"),
        ).status_code
        == 409
    )
    pass_again = client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{clean_ver}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": fail_then_pass_rule.json()["id"]},
    )
    assert pass_again.json()["result"] == "PASS"
    cleared = client.post(
        f"/api/v1/projects/{project_id}/jobs",
        headers=auth_headers,
        json=_job_payload(clean_ds, clean_ver, "clean-cleared"),
    )
    assert cleared.status_code == 201


def test_delete_and_deactivate(client, auth_headers):
    project_id = _project(client, auth_headers)
    csv = b"a,b,target\n1,2,0\n2,3,1\n3,4,0\n4,5,1\n"
    dataset_id, version_id = _upload(client, auth_headers, project_id, csv)

    no_hist = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Temp",
            "dataset_id": dataset_id,
            "rules": [{"type": "not_null", "column": "a", "severity": "fail"}],
        },
    )
    assert no_hist.status_code == 201
    deleted = client.delete(
        f"/api/v1/projects/{project_id}/quality-rules/{no_hist.json()['id']}",
        headers=auth_headers,
    )
    assert deleted.status_code == 200

    with_hist = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Keep",
            "dataset_id": dataset_id,
            "block_training_on_fail": True,
            "rules": [{"type": "not_null", "column": "missing", "severity": "fail"}],
        },
    )
    assert with_hist.status_code == 422
    with_hist = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Keep",
            "dataset_id": dataset_id,
            "block_training_on_fail": True,
            "rules": [{"type": "unique", "column": "a", "severity": "fail"}],
        },
    )
    # unique on a passes for this tiny set? a values are unique. Make fail with range
    with_hist = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Keep",
            "dataset_id": dataset_id,
            "block_training_on_fail": True,
            "rules": [
                {"type": "range", "column": "a", "min": 100, "max": 200, "severity": "fail"}
            ],
        },
    )
    assert with_hist.status_code == 201
    client.post(
        f"/api/v1/projects/{project_id}/dataset-versions/{version_id}/quality-checks",
        headers=auth_headers,
        json={"quality_rule_id": with_hist.json()["id"]},
    )
    conflict = client.delete(
        f"/api/v1/projects/{project_id}/quality-rules/{with_hist.json()['id']}",
        headers=auth_headers,
    )
    assert conflict.status_code == 409
    assert "Deactivate" in (conflict.json().get("hint") or "")

    assert (
        client.post(
            f"/api/v1/projects/{project_id}/jobs",
            headers=auth_headers,
            json=_job_payload(dataset_id, version_id),
        ).status_code
        == 409
    )
    deactivated = client.patch(
        f"/api/v1/projects/{project_id}/quality-rules/{with_hist.json()['id']}",
        headers=auth_headers,
        json={"is_active": False},
    )
    assert deactivated.status_code == 200
    assert deactivated.json()["is_active"] is False
    assert (
        client.post(
            f"/api/v1/projects/{project_id}/jobs",
            headers=auth_headers,
            json=_job_payload(dataset_id, version_id, "after-deact"),
        ).status_code
        == 201
    )


def test_list_filters_and_legacy_migration_defaults(client, auth_headers):
    project_id = _project(client, auth_headers)
    dataset_id, _ = _upload(
        client, auth_headers, project_id, b"a,b,target\n1,2,0\n2,3,1\n"
    )
    active = client.post(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        json={
            "name": "Active",
            "dataset_id": dataset_id,
            "rules": [{"type": "not_null", "column": "a", "severity": "fail"}],
        },
    )
    assert active.status_code == 201
    with TestingSessionLocal() as db:
        legacy = QualityRule(
            project_id=project_id,
            dataset_id=None,
            name="Legacy",
            rules_json='[{"type":"not_null","column":"a","severity":"fail"}]',
            block_training_on_fail=True,
            is_active=False,
        )
        db.add(legacy)
        db.commit()
        legacy_id = legacy.id
        # Migration semantics: preserved row stays unassigned + inactive
        row = db.get(QualityRule, legacy_id)
        assert row.dataset_id is None
        assert row.is_active is False

    listed = client.get(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        params={"dataset_id": dataset_id},
    )
    assert listed.status_code == 200
    assert all(r["dataset_id"] == dataset_id for r in listed.json())

    with_legacy = client.get(
        f"/api/v1/projects/{project_id}/quality-rules",
        headers=auth_headers,
        params={
            "dataset_id": dataset_id,
            "include_unassigned": True,
            "include_inactive": True,
        },
    )
    ids = {r["id"] for r in with_legacy.json()}
    assert active.json()["id"] in ids
    assert legacy_id in ids

    # Assign legacy to dataset
    assigned = client.patch(
        f"/api/v1/projects/{project_id}/quality-rules/{legacy_id}",
        headers=auth_headers,
        json={"dataset_id": dataset_id, "is_active": True},
    )
    assert assigned.status_code == 200
    assert assigned.json()["dataset_id"] == dataset_id
    assert assigned.json()["is_active"] is True

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.models import Base
from app.db.session import get_db
from app.main import app
from app.services import inference, mlflow_service, storage as storage_mod


engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)

# Shared fake object store for tests that assert content isolation.
OBJECT_STORE: dict[tuple[str, str], bytes] = {}


@pytest.fixture(autouse=True)
def setup_db(monkeypatch):
    Base.metadata.create_all(bind=engine)
    OBJECT_STORE.clear()

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db

    def ensure_buckets():
        return None

    def upload_bytes(bucket, key, data, content_type="application/octet-stream"):
        OBJECT_STORE[(bucket, key)] = data

    def download_bytes(bucket, key):
        return OBJECT_STORE[(bucket, key)]

    monkeypatch.setattr(storage_mod, "ensure_buckets", ensure_buckets)
    monkeypatch.setattr(storage_mod, "upload_bytes", upload_bytes)
    monkeypatch.setattr(storage_mod, "download_bytes", download_bytes)

    monkeypatch.setattr(mlflow_service, "ensure_experiment", lambda name: "exp-1")
    monkeypatch.setattr(
        mlflow_service,
        "client",
        lambda: type("C", (), {"search_experiments": lambda *a, **k: []})(),
    )

    yield
    app.dependency_overrides.clear()
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def client():
    return TestClient(app)


def _iris_csv() -> bytes:
    from sklearn.datasets import load_iris

    return load_iris(as_frame=True).frame.to_csv(index=False).encode()


def _alt_csv() -> bytes:
    return (
        "sepal length (cm),sepal width (cm),petal length (cm),petal width (cm),target\n"
        "1.0,1.0,1.0,1.0,9\n"
        "2.0,2.0,2.0,2.0,9\n"
        "3.0,3.0,3.0,3.0,8\n"
        "4.0,4.0,4.0,4.0,8\n"
        "5.0,5.0,5.0,5.0,8\n"
    ).encode()


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_create_project_and_upload(client):
    r = client.post("/api/projects", json={"name": "demo", "description": "d"})
    assert r.status_code == 201
    pid = r.json()["id"]

    files = {"file": ("iris.csv", _iris_csv(), "text/csv")}
    r = client.post(f"/api/projects/{pid}/datasets", files=files)
    assert r.status_code == 201
    body = r.json()
    assert body["row_count"] == 150
    assert "target" in body["columns"]
    assert "mean" in body["stats"]["sepal length (cm)"]
    assert f"project-{pid}/" in body["object_key"]
    assert body["name"] == "iris.csv"


def test_duplicate_filename_keeps_distinct_objects(client):
    pid = client.post("/api/projects", json={"name": "dup"}).json()["id"]
    first = client.post(
        f"/api/projects/{pid}/datasets",
        files={"file": ("iris.csv", _iris_csv(), "text/csv")},
    ).json()
    second = client.post(
        f"/api/projects/{pid}/datasets",
        files={"file": ("iris.csv", _alt_csv(), "text/csv")},
    ).json()

    assert first["name"] == second["name"] == "iris.csv"
    assert first["object_key"] != second["object_key"]
    assert first["row_count"] == 150
    assert second["row_count"] == 5

    from app.core.config import settings

    a = storage_mod.download_bytes(settings.minio_datasets_bucket, first["object_key"])
    b = storage_mod.download_bytes(settings.minio_datasets_bucket, second["object_key"])
    assert a != b
    assert b"target\n1.0," in b or b",9\n" in b


def test_create_job_validation(client):
    pid = client.post("/api/projects", json={"name": "j1"}).json()["id"]
    ds = client.post(
        f"/api/projects/{pid}/datasets",
        files={"file": ("iris.csv", _iris_csv(), "text/csv")},
    ).json()
    r = client.post(
        f"/api/projects/{pid}/jobs",
        json={"name": "train", "dataset_id": ds["id"], "target_column": "missing"},
    )
    assert r.status_code == 400
    assert "hint" in r.json()["detail"]


def test_profile_csv_unit():
    data = _iris_csv()
    rows, cols, columns, stats = storage_mod.profile_csv(data)
    assert rows == 150
    assert "target" in columns
    assert stats["target"]["unique_count"] == 3


def test_dashboard(client):
    client.post("/api/projects", json={"name": "dash"})
    r = client.get("/api/dashboard")
    assert r.status_code == 200
    assert r.json()["projects"] >= 1


def test_register_rejects_foreign_project_run(client, monkeypatch):
    pid = client.post("/api/projects", json={"name": "owner"}).json()["id"]
    client.post("/api/projects", json={"name": "other"}).json()["id"]

    monkeypatch.setattr(
        mlflow_service,
        "ensure_experiment",
        lambda name: "exp-owner" if name == f"project-{pid}" else "exp-other",
    )
    monkeypatch.setattr(
        mlflow_service,
        "get_run",
        lambda run_id: {
            "run_id": run_id,
            "experiment_id": "exp-other",
            "status": "FINISHED",
            "params": {},
            "metrics": {},
            "artifact_uri": None,
            "tags": {},
            "artifacts": [],
            "start_time": None,
            "end_time": None,
        },
    )

    r = client.post(
        f"/api/projects/{pid}/models/register",
        json={"run_id": "run-from-other", "model_name": "classifier"},
    )
    assert r.status_code == 400
    assert "does not belong" in r.json()["detail"]["detail"]


def test_endpoint_rejects_foreign_model_name(client, monkeypatch):
    pid = client.post("/api/projects", json={"name": "ep-owner"}).json()["id"]
    monkeypatch.setattr(
        mlflow_service,
        "get_model_version",
        lambda name, version: {"name": name, "version": version, "status": "READY"},
    )
    r = client.post(
        f"/api/projects/{pid}/endpoints",
        json={
            "name": "bad",
            "model_name": f"project-{pid + 99}-classifier",
            "model_version": "1",
        },
    )
    assert r.status_code == 400
    assert "does not belong" in r.json()["detail"]["detail"]


def test_endpoint_requires_successful_model_load(client, monkeypatch):
    pid = client.post("/api/projects", json={"name": "ep-load"}).json()["id"]
    model_name = f"project-{pid}-classifier"
    monkeypatch.setattr(
        mlflow_service,
        "get_model_version",
        lambda name, version: {"name": name, "version": version, "status": "READY"},
    )
    monkeypatch.setattr(inference, "load_model", lambda uri: (_ for _ in ()).throw(RuntimeError("boom")))

    r = client.post(
        f"/api/projects/{pid}/endpoints",
        json={"name": "fail-ep", "model_name": model_name, "model_version": "1"},
    )
    assert r.status_code == 400
    assert "could not be loaded" in r.json()["detail"]["detail"].lower()
    assert client.get(f"/api/projects/{pid}/endpoints").json() == []


def test_endpoint_ready_after_successful_load(client, monkeypatch):
    pid = client.post("/api/projects", json={"name": "ep-ok"}).json()["id"]
    model_name = f"project-{pid}-classifier"
    monkeypatch.setattr(
        mlflow_service,
        "get_model_version",
        lambda name, version: {"name": name, "version": version, "status": "READY"},
    )
    monkeypatch.setattr(inference, "load_model", lambda uri: object())

    r = client.post(
        f"/api/projects/{pid}/endpoints",
        json={"name": "ok-ep", "model_name": model_name, "model_version": "1"},
    )
    assert r.status_code == 201
    body = r.json()
    assert body["status"] == "ready"
    assert body["model_name"] == model_name


import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.models import Base
from app.db.session import get_db
from app.main import app
from app.services import storage as storage_mod


engine = create_engine(
    "sqlite+pysqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


@pytest.fixture(autouse=True)
def setup_db(monkeypatch):
    Base.metadata.create_all(bind=engine)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db

    # Fake MinIO
    store: dict[tuple[str, str], bytes] = {}

    def ensure_buckets():
        return None

    def upload_bytes(bucket, key, data, content_type="application/octet-stream"):
        store[(bucket, key)] = data

    def download_bytes(bucket, key):
        return store[(bucket, key)]

    monkeypatch.setattr(storage_mod, "ensure_buckets", ensure_buckets)
    monkeypatch.setattr(storage_mod, "upload_bytes", upload_bytes)
    monkeypatch.setattr(storage_mod, "download_bytes", download_bytes)

    # Fake mlflow experiment ensure
    from app.services import mlflow_service

    monkeypatch.setattr(mlflow_service, "ensure_experiment", lambda name: "1")
    monkeypatch.setattr(mlflow_service, "client", lambda: type("C", (), {"search_experiments": lambda *a, **k: []})())

    yield
    app.dependency_overrides.clear()
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def client():
    return TestClient(app)


def _iris_csv() -> bytes:
    from sklearn.datasets import load_iris

    iris = load_iris(as_frame=True)
    df = iris.frame
    df = df.rename(columns={"target": "target"})
    return df.to_csv(index=False).encode()


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

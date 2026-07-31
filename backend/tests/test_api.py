from fastapi.testclient import TestClient

from app.main import app


def test_compose_health_is_retained():
    response = TestClient(app).get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_legacy_api_removed():
    response = TestClient(app).get("/api/projects")

    assert response.status_code == 404

"""Phase 8-A — inference runtime, client, and architecture regressions."""

from __future__ import annotations

import ast
import math
from pathlib import Path

import httpx
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.services import inference, inference_client

pytestmark = pytest.mark.no_inference_stub

RUNTIME_TOKEN = "test-inference-service-token-phase8a-32b"


@pytest.fixture
def runtime_settings(monkeypatch):
    monkeypatch.setattr(settings, "inference_service_token", RUNTIME_TOKEN)
    monkeypatch.setattr(settings, "inference_runtime_url", "http://testserver")
    monkeypatch.setattr(settings, "inference_timeout_seconds", 5.0)
    monkeypatch.setattr(settings, "inference_batch_chunk_size", 2)


@pytest.fixture
def runtime_client(runtime_settings):
    from app.inference_runtime import app

    return TestClient(app)


def _auth_headers(token: str = RUNTIME_TOKEN) -> dict[str, str]:
    return {inference_client.SERVICE_TOKEN_HEADER: token}


def test_runtime_health_and_ready(runtime_client):
    health = runtime_client.get("/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    ready = runtime_client.get("/ready")
    assert ready.status_code == 200
    assert ready.json()["status"] == "ready"


def test_runtime_rejects_missing_and_wrong_token(runtime_client, monkeypatch):
    missing = runtime_client.post(
        "/v1/models/load-check", json={"model_uri": "models:/demo/1"}
    )
    assert missing.status_code == 401
    assert "Unauthorized" in missing.json()["detail"]
    assert RUNTIME_TOKEN not in missing.text

    wrong = runtime_client.post(
        "/v1/models/load-check",
        headers=_auth_headers("wrong-token-value-not-the-real-one"),
        json={"model_uri": "models:/demo/1"},
    )
    assert wrong.status_code == 401
    assert RUNTIME_TOKEN not in wrong.text


def test_runtime_load_check_and_predict_success(runtime_client, monkeypatch):
    class FakeModel:
        metadata = None

        def predict(self, frame):
            return [float(row["x"]) * 2 for _, row in frame.iterrows()]

    monkeypatch.setattr(inference, "load_model", lambda uri: FakeModel())
    load = runtime_client.post(
        "/v1/models/load-check",
        headers=_auth_headers(),
        json={"model_uri": "models:/demo/1"},
    )
    assert load.status_code == 200
    assert load.json()["ok"] is True

    predict = runtime_client.post(
        "/v1/models/predict",
        headers=_auth_headers(),
        json={
            "model_uri": "models:/demo/1",
            "instances": [{"x": 1.5}, {"x": 2.0}],
            "feature_schema": [{"name": "x", "dtype": "float"}],
        },
    )
    assert predict.status_code == 200
    assert predict.json()["predictions"] == [3.0, 4.0]


def test_runtime_input_error_does_not_leak_secrets(runtime_client, monkeypatch):
    class FakeModel:
        metadata = None

        def predict(self, frame):
            raise inference.PredictionInputError(
                "Feature 'x' must be numeric for model type 'double'."
            )

    monkeypatch.setattr(inference, "load_model", lambda uri: FakeModel())
    response = runtime_client.post(
        "/v1/models/predict",
        headers=_auth_headers(),
        json={
            "model_uri": "models:/secret-uri/1",
            "instances": [{"x": "bad"}],
        },
    )
    assert response.status_code == 422
    body = response.text
    assert RUNTIME_TOKEN not in body
    assert "http://" not in body
    assert "inference-runtime" not in body


def _patch_client_to_runtime(monkeypatch, runtime_app):
    """Route inference_client HTTP calls through FastAPI TestClient."""

    test_client = TestClient(runtime_app)

    class _Bridge:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def request(self, method, path, headers=None, json=None):
            response = test_client.request(
                method, path, headers=headers or {}, json=json
            )
            return httpx.Response(
                status_code=response.status_code,
                content=response.content,
                headers=response.headers,
                request=httpx.Request(method, f"http://testserver{path}"),
            )

    monkeypatch.setattr(inference_client, "_client", lambda: _Bridge())
    return test_client


def test_client_uses_runtime_and_sanitizes_failures(runtime_settings, monkeypatch):
    from app.inference_runtime import app as runtime_app

    _patch_client_to_runtime(monkeypatch, runtime_app)

    class FakeModel:
        metadata = None

        def predict(self, frame):
            return [1]

    monkeypatch.setattr(inference, "load_model", lambda uri: FakeModel())
    info = inference_client.check_model_loadable("models:/demo/1")
    assert info["ok"] is True
    preds = inference_client.predict("models:/demo/1", [{"x": 1}])
    assert preds == [1]


def test_client_chunked_dataframe_preserves_order(runtime_settings, monkeypatch):
    from app.inference_runtime import app as runtime_app

    _patch_client_to_runtime(monkeypatch, runtime_app)
    monkeypatch.setattr(settings, "inference_batch_chunk_size", 2)

    class FakeModel:
        metadata = None

        def predict(self, frame):
            return [float(v) for v in frame["x"].tolist()]

    monkeypatch.setattr(inference, "load_model", lambda uri: FakeModel())
    frame = pd.DataFrame(
        {
            "x": [1.0, 2.0, 3.0, 4.0, 5.0],
            "ts": pd.to_datetime(
                [
                    "2026-01-01",
                    "2026-01-02",
                    "2026-01-03",
                    "2026-01-04",
                    "2026-01-05",
                ]
            ),
            "missing": [1.0, math.nan, 3.0, None, 5.0],
        }
    )
    preds = inference_client.predict_dataframe(
        "models:/demo/1",
        frame[["x"]],
        chunk_size=2,
    )
    assert preds == [1.0, 2.0, 3.0, 4.0, 5.0]


def test_client_hides_connection_details(runtime_settings, monkeypatch):
    class BoomClient:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def request(self, *args, **kwargs):
            raise httpx.ConnectError("connection to http://inference-runtime:8080 failed")

    monkeypatch.setattr(inference_client, "_client", lambda: BoomClient())
    with pytest.raises(inference_client.InferenceRuntimeError, match="unavailable") as exc:
        inference_client.check_model_loadable("models:/demo/1")
    message = str(exc.value)
    assert "inference-runtime" not in message
    assert RUNTIME_TOKEN not in message
    assert settings.inference_service_token not in message


def test_control_plane_modules_do_not_call_local_model_execution():
    root = Path(__file__).resolve().parents[1] / "app"
    forbidden_files = [
        root / "api" / "v1" / "endpoints.py",
        root / "workers" / "runner.py",
        root / "services" / "pipeline_engine.py",
        root / "services" / "registry_service.py",
        root / "api" / "routes.py",
    ]
    for path in forbidden_files:
        source = path.read_text(encoding="utf-8")
        assert "inference.load_model(" not in source, path.name
        assert "inference.predict(" not in source, path.name
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Attribute):
                continue
            if node.attr not in {"load_model", "predict"}:
                continue
            if isinstance(node.value, ast.Name) and node.value.id == "inference":
                raise AssertionError(
                    f"{path.name} still references inference.{node.attr}"
                )


def test_endpoints_module_wires_inference_client():
    from app.api.v1 import endpoints as endpoints_mod
    from app.workers import runner as runner_mod

    assert endpoints_mod.inference_client is inference_client
    assert hasattr(endpoints_mod.inference_client, "check_model_loadable")
    assert hasattr(endpoints_mod.inference_client, "predict")
    assert runner_mod.inference_client is inference_client
    assert hasattr(runner_mod.inference_client, "predict_dataframe")
    assert not hasattr(runner_mod, "inference")


def test_json_safe_boundary_helpers():
    assert inference_client.json_safe_value(float("nan")) is None
    assert inference_client.json_safe_value(float("inf")) is None
    frame = pd.DataFrame({"a": [1, None], "b": [math.nan, 2.5]})
    rows = inference_client.dataframe_to_instances(frame)
    assert rows[0]["a"] == 1
    assert rows[0]["b"] is None
    assert rows[1]["a"] is None
    assert rows[1]["b"] == 2.5

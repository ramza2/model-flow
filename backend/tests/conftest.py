import secrets
from typing import Any

import pytest

from app.core.config import settings


@pytest.fixture(autouse=True)
def secure_test_signing_key(monkeypatch):
    """PyJWT rejects empty HMAC keys even before application startup."""
    monkeypatch.setattr(settings, "secret_key", secrets.token_urlsafe(48))
    monkeypatch.setattr(settings, "inference_service_token", secrets.token_urlsafe(48))
    monkeypatch.setattr(
        settings, "inference_runtime_url", "http://inference-runtime.test"
    )


@pytest.fixture(autouse=True)
def stub_inference_runtime_client(request, monkeypatch):
    """Unit tests exercise control-plane logic without a live runtime.

    New Phase 8-A runtime/client tests opt out with ``@pytest.mark.no_inference_stub``.
    """

    if request.node.get_closest_marker("no_inference_stub"):
        return

    from app.services import inference, inference_client

    def check_model_loadable(model_uri: str) -> dict[str, Any]:
        model = inference.load_model(model_uri)
        features: list[dict[str, str]] = []
        try:
            metadata = getattr(model, "metadata", None)
            signature = (
                getattr(metadata, "signature", None) if metadata is not None else None
            )
            inputs = getattr(signature, "inputs", None) if signature is not None else None
            if inputs:
                for column in inputs:
                    name = getattr(column, "name", None)
                    if not name:
                        continue
                    features.append(
                        {
                            "name": str(name),
                            "dtype": str(getattr(column, "type", "") or ""),
                        }
                    )
        except Exception:
            features = []
        return {"ok": True, "input_features": features}

    def predict(
        model_uri: str,
        instances: list[dict[str, Any]],
        feature_schema=None,
        target_columns=None,
    ) -> list[Any]:
        return inference.predict(
            model_uri,
            instances,
            feature_schema,
            target_columns=target_columns,
        )

    def predict_dataframe(
        model_uri: str,
        frame,
        *,
        feature_schema=None,
        target_columns=None,
        chunk_size=None,
    ) -> list[Any]:
        size = max(1, int(chunk_size or settings.inference_batch_chunk_size or 256))
        if getattr(frame, "empty", False):
            return []
        instances = inference_client.dataframe_to_instances(frame)
        predictions: list[Any] = []
        for start in range(0, len(instances), size):
            chunk = instances[start : start + size]
            chunk_preds = predict(
                model_uri,
                chunk,
                feature_schema=feature_schema,
                target_columns=target_columns,
            )
            predictions.extend(chunk_preds)
        return predictions

    monkeypatch.setattr(inference_client, "check_model_loadable", check_model_loadable)
    monkeypatch.setattr(inference_client, "predict", predict)
    monkeypatch.setattr(inference_client, "predict_dataframe", predict_dataframe)

"""Internal HTTP client for the Phase 8-A inference runtime.

Backend and worker call this module instead of loading models in-process.
Errors are sanitized so tokens, internal URLs, and stack details never leak
into public API responses.
"""

from __future__ import annotations

import logging
import math
from datetime import date, datetime
from typing import Any

import httpx
import pandas as pd

from app.core.config import settings

logger = logging.getLogger(__name__)

SERVICE_TOKEN_HEADER = "X-ModelFlow-Inference-Token"


class InferenceRuntimeError(RuntimeError):
    """Sanitized failure talking to the inference runtime."""


class InferenceRuntimeInputError(ValueError):
    """Prediction input rejected by the runtime (public 422 semantics)."""


def _runtime_base_url() -> str:
    return (settings.inference_runtime_url or "").rstrip("/")


def _service_token() -> str:
    return (settings.inference_service_token or "").strip()


def _timeout() -> httpx.Timeout:
    read = max(1.0, float(settings.inference_timeout_seconds or 60.0))
    # Fail closed quickly when the runtime hostname is unreachable.
    return httpx.Timeout(read, connect=min(5.0, read))


def _chunk_size() -> int:
    value = int(settings.inference_batch_chunk_size or 256)
    return max(1, value)


def _auth_headers() -> dict[str, str]:
    token = _service_token()
    if not token:
        raise InferenceRuntimeError("Inference runtime is not configured.")
    return {SERVICE_TOKEN_HEADER: token}


def _client() -> httpx.Client:
    base = _runtime_base_url()
    if not base:
        raise InferenceRuntimeError("Inference runtime is not configured.")
    return httpx.Client(base_url=base, timeout=_timeout())


def _raise_for_response(response: httpx.Response, *, action: str) -> None:
    if response.status_code == 401:
        raise InferenceRuntimeError("Inference runtime authentication failed.")
    if response.status_code == 422:
        detail = _response_detail(response) or "Prediction payload was rejected."
        raise InferenceRuntimeInputError(detail)
    if response.status_code >= 500:
        raise InferenceRuntimeError(f"Inference runtime could not {action}.")
    if response.status_code >= 400:
        detail = _response_detail(response)
        if detail:
            raise InferenceRuntimeError(detail)
        raise InferenceRuntimeError(f"Inference runtime could not {action}.")


def _response_detail(response: httpx.Response) -> str | None:
    try:
        payload = response.json()
    except Exception:
        return None
    if isinstance(payload, dict):
        detail = payload.get("detail")
        if isinstance(detail, str) and detail.strip():
            return detail.strip()
    return None


def _request(method: str, path: str, *, json_body: dict[str, Any] | None = None) -> Any:
    headers = _auth_headers()
    try:
        with _client() as client:
            response = client.request(method, path, headers=headers, json=json_body)
    except InferenceRuntimeError:
        raise
    except httpx.TimeoutException as exc:
        logger.warning("inference_client_timeout action=%s", path)
        raise InferenceRuntimeError("Inference runtime timed out.") from exc
    except httpx.HTTPError as exc:
        logger.warning(
            "inference_client_connection_error action=%s error_class=%s",
            path,
            exc.__class__.__name__,
        )
        raise InferenceRuntimeError("Inference runtime is unavailable.") from exc
    _raise_for_response(response, action=path.strip("/").replace("/", " "))
    try:
        return response.json()
    except Exception as exc:
        raise InferenceRuntimeError("Inference runtime returned an invalid response.") from exc


def json_safe_value(value: Any) -> Any:
    """Convert a cell value into JSON-safe form for the runtime boundary."""

    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, str):
        return value
    if hasattr(value, "item"):
        try:
            return json_safe_value(value.item())
        except (ValueError, TypeError):
            pass
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            pass
    return str(value)


def dataframe_to_instances(frame: pd.DataFrame) -> list[dict[str, Any]]:
    columns = [str(col) for col in frame.columns]
    instances: list[dict[str, Any]] = []
    for record in frame.to_dict(orient="records"):
        instances.append({col: json_safe_value(record.get(col)) for col in columns})
    return instances


def check_model_loadable(model_uri: str) -> dict[str, Any]:
    """Ensure ``model_uri`` can be loaded by the runtime.

    Returns ``{"ok": True, "input_features": [...]}`` on success.
    """

    payload = _request(
        "POST",
        "/v1/models/load-check",
        json_body={"model_uri": model_uri},
    )
    if not isinstance(payload, dict) or not payload.get("ok"):
        raise InferenceRuntimeError("The model could not be loaded for inference.")
    features = payload.get("input_features") or []
    if not isinstance(features, list):
        features = []
    return {"ok": True, "input_features": features}


def predict(
    model_uri: str,
    instances: list[dict[str, Any]],
    feature_schema: str | list[str] | list[dict[str, Any]] | dict[str, Any] | None = None,
    target_columns: list[str] | None = None,
) -> list[Any]:
    """Run online/batch prediction via the inference runtime."""

    payload = _request(
        "POST",
        "/v1/models/predict",
        json_body={
            "model_uri": model_uri,
            "instances": instances,
            "feature_schema": feature_schema,
            "target_columns": target_columns,
        },
    )
    if not isinstance(payload, dict):
        raise InferenceRuntimeError("Inference runtime returned an invalid response.")
    predictions = payload.get("predictions")
    if not isinstance(predictions, list):
        raise InferenceRuntimeError("Inference runtime returned an invalid response.")
    return predictions


def predict_dataframe(
    model_uri: str,
    frame: pd.DataFrame,
    *,
    feature_schema: str | list[str] | list[dict[str, Any]] | dict[str, Any] | None = None,
    target_columns: list[str] | None = None,
    chunk_size: int | None = None,
) -> list[Any]:
    """Predict over a DataFrame in bounded chunks, preserving row order."""

    if frame.empty:
        return []
    size = max(1, int(chunk_size or _chunk_size()))
    instances = dataframe_to_instances(frame)
    predictions: list[Any] = []
    for start in range(0, len(instances), size):
        chunk = instances[start : start + size]
        chunk_preds = predict(
            model_uri,
            chunk,
            feature_schema=feature_schema,
            target_columns=target_columns,
        )
        if len(chunk_preds) != len(chunk):
            raise InferenceRuntimeError(
                "Inference runtime returned a different number of predictions than input rows."
            )
        predictions.extend(chunk_preds)
    if len(predictions) != len(instances):
        raise InferenceRuntimeError(
            "Inference runtime returned a different number of predictions than input rows."
        )
    return predictions

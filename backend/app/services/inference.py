from __future__ import annotations

from typing import Any

import mlflow
import pandas as pd

from app.core.config import settings

_cache: dict[str, Any] = {}


def load_model(model_uri: str):
    if model_uri not in _cache:
        mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
        _cache[model_uri] = mlflow.pyfunc.load_model(model_uri)
    return _cache[model_uri]


def predict(model_uri: str, instances: list[dict[str, Any]]) -> list[Any]:
    if not instances:
        raise ValueError("Provide at least one instance in 'instances'.")
    model = load_model(model_uri)
    frame = pd.DataFrame(instances)
    preds = model.predict(frame)
    return [p.item() if hasattr(p, "item") else p for p in preds]

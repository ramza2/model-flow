"""Internal inference runtime service (Phase 8-A).

Not a public API: no ModelFlow user/session/RBAC, no application DB ownership.
Reuses ``app.services.inference`` for model load/cache/predict.
"""

from __future__ import annotations

import logging
import secrets
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.core.config import settings
from app.services import inference

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s level=%(levelname)s logger=%(name)s message=%(message)s",
)
logger = logging.getLogger(__name__)

SERVICE_TOKEN_HEADER = "X-ModelFlow-Inference-Token"


def _configured_token() -> str:
    return (settings.inference_service_token or "").strip()


def validate_inference_runtime_settings() -> None:
    token = _configured_token()
    if not token or len(token) < 32:
        raise RuntimeError(
            "MODELFLOW_INFERENCE_SERVICE_TOKEN is missing or too short. "
            "Run scripts/init-env.sh before starting the inference runtime."
        )


def _extract_input_features(model: Any) -> list[dict[str, str]]:
    features: list[dict[str, str]] = []
    try:
        metadata = getattr(model, "metadata", None)
        signature = getattr(metadata, "signature", None) if metadata is not None else None
        inputs = getattr(signature, "inputs", None) if signature is not None else None
        if not inputs:
            return features
        for column in inputs:
            name = getattr(column, "name", None)
            if not name:
                continue
            type_name = str(getattr(column, "type", "") or "")
            features.append({"name": str(name), "dtype": type_name})
    except Exception:
        return []
    return features


@asynccontextmanager
async def lifespan(_: FastAPI):
    validate_inference_runtime_settings()
    logger.info(
        "inference_runtime_startup version=%s git_sha=%s",
        settings.app_version,
        settings.git_sha,
    )
    yield
    logger.info("inference_runtime_shutdown")


app = FastAPI(
    title="ModelFlow Inference Runtime",
    version=settings.app_version,
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


async def require_service_token(
    request: Request,
    x_modelflow_inference_token: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> None:
    expected = _configured_token()
    provided = (x_modelflow_inference_token or "").strip()
    if not provided and authorization:
        scheme, _, remainder = authorization.partition(" ")
        if scheme.lower() == "bearer":
            provided = remainder.strip()
    if not expected or not provided:
        raise HTTPException(status_code=401, detail="Unauthorized.")
    # compare_digest requires equal-length inputs; pad via hash-length check first.
    if len(provided) != len(expected) or not secrets.compare_digest(provided, expected):
        # Do not echo tokens or internal URLs.
        raise HTTPException(status_code=401, detail="Unauthorized.")


class LoadCheckRequest(BaseModel):
    model_uri: str = Field(min_length=1)


class PredictRequest(BaseModel):
    model_uri: str = Field(min_length=1)
    instances: list[dict[str, Any]]
    feature_schema: str | list[str] | list[dict[str, Any]] | dict[str, Any] | None = None
    target_columns: list[str] | None = None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
def ready() -> dict[str, str]:
    if not _configured_token():
        raise HTTPException(status_code=503, detail="Inference runtime is not configured.")
    return {"status": "ready"}


@app.post("/v1/models/load-check", dependencies=[Depends(require_service_token)])
def load_check(body: LoadCheckRequest) -> dict[str, Any]:
    try:
        model = inference.load_model(body.model_uri)
    except Exception:
        logger.warning(
            "inference_runtime_load_failed error_class=%s",
            "ModelLoadError",
        )
        raise HTTPException(
            status_code=502,
            detail="The model could not be loaded for inference.",
        ) from None
    return {"ok": True, "input_features": _extract_input_features(model)}


@app.post("/v1/models/predict", dependencies=[Depends(require_service_token)])
def predict(body: PredictRequest) -> dict[str, Any]:
    try:
        predictions = inference.predict(
            body.model_uri,
            body.instances,
            body.feature_schema,
            target_columns=body.target_columns,
        )
    except inference.PredictionInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    except ValueError as exc:
        # Schema validation failures from validate_instances.
        raise HTTPException(status_code=422, detail=str(exc)) from None
    except Exception:
        logger.warning(
            "inference_runtime_predict_failed error_class=%s",
            "PredictionError",
        )
        raise HTTPException(
            status_code=400,
            detail="Prediction failed.",
        ) from None
    return {"predictions": predictions}


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

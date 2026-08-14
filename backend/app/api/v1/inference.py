"""External inference API authenticated with Service API Keys.

User JWTs are rejected. Responses expose predictions only (no model_uri).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.v1.endpoints import _record_prediction
from app.core.deps import (
    ServiceApiKeyContext,
    authenticate_service_api_key,
    authorize_service_key_for_endpoint,
)
from app.db.session import get_db
from app.schemas.v1 import PredictRequest

router = APIRouter(tags=["external-inference"])


@router.post("/inference/endpoints/{endpoint_id}/predict")
def external_predict(
    endpoint_id: int,
    body: PredictRequest,
    ctx: ServiceApiKeyContext = Depends(authenticate_service_api_key),
    db: Session = Depends(get_db),
):
    endpoint = authorize_service_key_for_endpoint(db, ctx, endpoint_id)
    result = _record_prediction(db, endpoint, body)
    return {"predictions": result["predictions"]}

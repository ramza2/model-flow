from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.common import (
    audit_event,
    dumps,
    endpoint_out,
    friendly,
    get_owned,
    loads,
)
from app.core.config import settings
from app.core.deps import AuthContext, get_auth, get_membership, require_project_perm
from app.core.rbac import Permission, role_has
from app.db.models import (
    Endpoint,
    InferenceStat,
    ModelLifecycle,
    ModelVersion,
    TrainingJob,
)
from app.db.session import get_db
from app.schemas.v1 import (
    EndpointCreate,
    EndpointSwapRequest,
    EndpointUpdate,
    PredictRequest,
)
from app.services import inference

router = APIRouter(tags=["endpoints"])


def _authorize_endpoint(
    db: Session,
    endpoint_id: int,
    auth: AuthContext,
    permission: Permission,
) -> Endpoint:
    endpoint = db.get(Endpoint, endpoint_id)
    if not endpoint:
        raise friendly(404, f"Endpoint {endpoint_id} was not found.")
    if auth.is_system_admin:
        return endpoint
    membership = get_membership(db, endpoint.project_id, auth.user.id)
    if not membership or not role_has(membership.role, permission):
        raise friendly(403, "You do not have permission for this endpoint.")
    return endpoint


def _deployable_model(
    db: Session, project_id: int, model_version_id: int
) -> ModelVersion:
    model = get_owned(db, ModelVersion, model_version_id, project_id, "Model version")
    if model.lifecycle not in {ModelLifecycle.APPROVED, ModelLifecycle.PRODUCTION}:
        raise friendly(
            409, "Only approved or production model versions can be deployed."
        )
    return model


def _inferred_schema(db: Session, model: ModelVersion) -> list[Any]:
    if not model.training_job_id:
        return []
    job = db.get(TrainingJob, model.training_job_id)
    return loads(job.feature_columns_json, []) if job else []


def _record_prediction(
    db: Session,
    endpoint: Endpoint,
    body: PredictRequest,
) -> dict:
    try:
        inference.validate_instances(body.instances, endpoint.feature_schema_json)
    except ValueError as exc:
        raise friendly(
            422,
            "Prediction payload does not match the feature schema.",
            str(exc),
        ) from exc
    if endpoint.status != "ready":
        raise friendly(
            409,
            f"Endpoint is {endpoint.status}.",
            "Start the endpoint before predicting.",
        )
    started = time.perf_counter()
    try:
        predictions = inference.predict(endpoint.model_uri, body.instances)
        latency_ms = (time.perf_counter() - started) * 1000
        endpoint.success_count = (endpoint.success_count or 0) + 1
        stat = InferenceStat(
            endpoint_id=endpoint.id,
            project_id=endpoint.project_id,
            success=True,
            latency_ms=latency_ms,
            payload_json=dumps(body.instances)
            if settings.store_inference_payloads
            else None,
            prediction_summary=dumps(predictions[:20]),
        )
        db.add(stat)
        result = {"predictions": predictions, "model_uri": endpoint.model_uri}
    except Exception as exc:
        latency_ms = (time.perf_counter() - started) * 1000
        endpoint.error_count = (endpoint.error_count or 0) + 1
        recent = loads(endpoint.recent_errors_json, [])
        recent.append(
            {
                "at": datetime.now(timezone.utc).isoformat(),
                "error_class": exc.__class__.__name__,
            }
        )
        endpoint.recent_errors_json = dumps(recent[-20:])
        db.add(
            InferenceStat(
                endpoint_id=endpoint.id,
                project_id=endpoint.project_id,
                success=False,
                latency_ms=latency_ms,
                error_class=exc.__class__.__name__,
                payload_json=dumps(body.instances)
                if settings.store_inference_payloads
                else None,
            )
        )
        endpoint.request_count = (endpoint.request_count or 0) + 1
        endpoint.latency_sum_ms = (endpoint.latency_sum_ms or 0) + latency_ms
        db.commit()
        raise friendly(
            400,
            "Prediction failed.",
            "Verify feature names and values match the deployed model.",
        ) from exc
    endpoint.request_count = (endpoint.request_count or 0) + 1
    endpoint.latency_sum_ms = (endpoint.latency_sum_ms or 0) + latency_ms
    latencies = list(
        db.scalars(
            select(InferenceStat.latency_ms)
            .where(InferenceStat.endpoint_id == endpoint.id)
            .order_by(InferenceStat.latency_ms)
        ).all()
    )
    if latencies:
        endpoint.latency_p95_ms = latencies[
            min(len(latencies) - 1, int(len(latencies) * 0.95))
        ]
    db.commit()
    return result


@router.get("/projects/{project_id}/endpoints")
def list_endpoints(
    project_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.DEPLOY_READ)),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(Endpoint)
        .where(Endpoint.project_id == project_id)
        .order_by(Endpoint.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [endpoint_out(row) for row in rows]


@router.post("/projects/{project_id}/endpoints", status_code=201)
def create_endpoint(
    project_id: int,
    body: EndpointCreate,
    access=Depends(require_project_perm(Permission.DEPLOY_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    model = _deployable_model(db, project_id, body.model_version_id)
    try:
        inference.load_model(model.model_uri)
    except Exception as exc:
        raise friendly(502, "The model could not be loaded for inference.") from exc
    endpoint = Endpoint(
        project_id=project_id,
        name=body.name.strip(),
        model_name=model.name,
        model_version=model.version,
        model_version_id=model.id,
        model_uri=model.model_uri,
        status="ready",
        feature_schema_json=dumps(body.feature_schema or _inferred_schema(db, model)),
        created_by=auth.user.id,
    )
    db.add(endpoint)
    db.flush()
    audit_event(db, auth, "endpoint.create", "endpoint", endpoint.id)
    db.commit()
    db.refresh(endpoint)
    return endpoint_out(endpoint)


@router.get("/endpoints/{endpoint_id}")
def get_endpoint(
    endpoint_id: int,
    auth: AuthContext = Depends(get_auth),
    db: Session = Depends(get_db),
):
    return endpoint_out(
        _authorize_endpoint(db, endpoint_id, auth, Permission.DEPLOY_READ)
    )


@router.patch("/endpoints/{endpoint_id}")
def update_endpoint(
    endpoint_id: int,
    body: EndpointUpdate,
    auth: AuthContext = Depends(get_auth),
    db: Session = Depends(get_db),
):
    endpoint = _authorize_endpoint(db, endpoint_id, auth, Permission.DEPLOY_WRITE)
    if body.name is not None:
        endpoint.name = body.name.strip()
    audit_event(db, auth, "endpoint.update", "endpoint", endpoint.id)
    db.commit()
    return endpoint_out(endpoint)


@router.post("/endpoints/{endpoint_id}/start")
def start_endpoint(
    endpoint_id: int,
    auth: AuthContext = Depends(get_auth),
    db: Session = Depends(get_db),
):
    endpoint = _authorize_endpoint(db, endpoint_id, auth, Permission.DEPLOY_WRITE)
    try:
        inference.load_model(endpoint.model_uri)
    except Exception as exc:
        endpoint.status = "error"
        db.commit()
        raise friendly(502, "The endpoint model could not be loaded.") from exc
    endpoint.status = "ready"
    audit_event(db, auth, "endpoint.start", "endpoint", endpoint.id)
    db.commit()
    return endpoint_out(endpoint)


@router.post("/endpoints/{endpoint_id}/stop")
def stop_endpoint(
    endpoint_id: int,
    auth: AuthContext = Depends(get_auth),
    db: Session = Depends(get_db),
):
    endpoint = _authorize_endpoint(db, endpoint_id, auth, Permission.DEPLOY_WRITE)
    endpoint.status = "stopped"
    audit_event(db, auth, "endpoint.stop", "endpoint", endpoint.id)
    db.commit()
    return endpoint_out(endpoint)


@router.post("/endpoints/{endpoint_id}/swap")
def swap_endpoint(
    endpoint_id: int,
    body: EndpointSwapRequest,
    auth: AuthContext = Depends(get_auth),
    db: Session = Depends(get_db),
):
    endpoint = _authorize_endpoint(db, endpoint_id, auth, Permission.DEPLOY_WRITE)
    model = _deployable_model(db, endpoint.project_id, body.model_version_id)
    try:
        inference.load_model(model.model_uri)
    except Exception as exc:
        raise friendly(502, "The replacement model could not be loaded.") from exc
    endpoint.previous_model_version = endpoint.model_version
    endpoint.previous_model_uri = endpoint.model_uri
    endpoint.model_name = model.name
    endpoint.model_version = model.version
    endpoint.model_version_id = model.id
    endpoint.model_uri = model.model_uri
    endpoint.status = "ready"
    endpoint.feature_schema_json = dumps(_inferred_schema(db, model))
    audit_event(
        db,
        auth,
        "endpoint.swap",
        "endpoint",
        endpoint.id,
        after={"model_version_id": model.id},
    )
    db.commit()
    return endpoint_out(endpoint)


@router.post("/endpoints/{endpoint_id}/rollback")
def rollback_endpoint(
    endpoint_id: int,
    auth: AuthContext = Depends(get_auth),
    db: Session = Depends(get_db),
):
    endpoint = _authorize_endpoint(db, endpoint_id, auth, Permission.DEPLOY_WRITE)
    if not endpoint.previous_model_uri or not endpoint.previous_model_version:
        raise friendly(409, "This endpoint does not have a rollback version.")
    try:
        inference.load_model(endpoint.previous_model_uri)
    except Exception as exc:
        raise friendly(502, "The rollback model could not be loaded.") from exc
    endpoint.model_version, endpoint.previous_model_version = (
        endpoint.previous_model_version,
        endpoint.model_version,
    )
    endpoint.model_uri, endpoint.previous_model_uri = (
        endpoint.previous_model_uri,
        endpoint.model_uri,
    )
    previous_row = db.scalar(
        select(ModelVersion).where(
            ModelVersion.project_id == endpoint.project_id,
            ModelVersion.model_uri == endpoint.model_uri,
        )
    )
    if previous_row:
        endpoint.model_name = previous_row.name
        endpoint.model_version_id = previous_row.id
        endpoint.feature_schema_json = dumps(_inferred_schema(db, previous_row))
    else:
        endpoint.model_version_id = None
    endpoint.status = "ready"
    audit_event(db, auth, "endpoint.rollback", "endpoint", endpoint.id)
    db.commit()
    return endpoint_out(endpoint)


@router.get("/endpoints/{endpoint_id}/health")
def endpoint_health(
    endpoint_id: int,
    auth: AuthContext = Depends(get_auth),
    db: Session = Depends(get_db),
):
    endpoint = _authorize_endpoint(db, endpoint_id, auth, Permission.DEPLOY_READ)
    return {
        "status": endpoint.status,
        "healthy": endpoint.status == "ready",
        "request_count": endpoint.request_count or 0,
        "success_count": endpoint.success_count or 0,
        "error_count": endpoint.error_count or 0,
        "latency_p95_ms": endpoint.latency_p95_ms or 0.0,
    }


@router.post("/endpoints/{endpoint_id}/test")
def test_endpoint(
    endpoint_id: int,
    body: PredictRequest,
    auth: AuthContext = Depends(get_auth),
    db: Session = Depends(get_db),
):
    endpoint = _authorize_endpoint(db, endpoint_id, auth, Permission.DEPLOY_WRITE)
    return _record_prediction(db, endpoint, body)


@router.post("/endpoints/{endpoint_id}/predict")
def predict(
    endpoint_id: int,
    body: PredictRequest,
    auth: AuthContext = Depends(get_auth),
    db: Session = Depends(get_db),
):
    endpoint = _authorize_endpoint(db, endpoint_id, auth, Permission.DEPLOY_READ)
    return _record_prediction(db, endpoint, body)

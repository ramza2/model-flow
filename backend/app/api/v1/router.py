from fastapi import APIRouter

from app.api.v1 import (
    admin,
    alerts,
    audit,
    auth,
    batch,
    data_sources,
    datasets,
    drift,
    endpoints,
    experiments,
    health,
    jobs,
    monitoring,
    pipelines,
    projects,
    quality,
    registry,
    retrain,
    splits,
    users,
    gate_policies,
)

router = APIRouter()

for child_router in (
    health.router,
    auth.router,
    users.router,
    projects.router,
    data_sources.router,
    datasets.router,
    quality.router,
    splits.router,
    jobs.router,
    experiments.router,
    pipelines.router,
    registry.router,
    gate_policies.router,
    endpoints.router,
    batch.router,
    monitoring.router,
    drift.router,
    retrain.router,
    alerts.router,
    audit.router,
    admin.router,
):
    router.include_router(child_router)

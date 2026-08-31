from __future__ import annotations

import json

from fastapi import APIRouter, Body, Depends, Query
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.api.v1.common import (
    audit_event,
    dumps,
    friendly,
    get_owned,
    pipeline_out,
    pipeline_run_out,
    pipeline_version_out,
)
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.models import (
    JobStatus,
    Pipeline,
    PipelineRun,
    PipelineStatus,
    PipelineVersion,
)
from app.db.session import get_db
from app.schemas.v1 import (
    PipelineCreate,
    PipelineGraphRequest,
    PipelineImportRequest,
    PipelineRunRequest,
    PipelineUpdate,
)
from app.services import job_factories, pipeline_engine
from app.services.pipeline_engine import validate_graph

router = APIRouter(tags=["pipelines"])


def _latest_version(db: Session, pipeline: Pipeline) -> PipelineVersion:
    row = db.scalar(
        select(PipelineVersion).where(
            PipelineVersion.pipeline_id == pipeline.id,
            PipelineVersion.version == pipeline.latest_version,
        )
    )
    if not row:
        raise friendly(409, "Pipeline does not have a saved graph.")
    return row


def _save_version(
    db: Session,
    pipeline: Pipeline,
    graph: dict,
    user_id: int,
) -> PipelineVersion:
    validation = validate_graph(graph, strict=False)
    if not validation["valid"]:
        raise friendly(
            400, "Pipeline graph is invalid.", "; ".join(validation["errors"])
        )
    from app.services.gate_policy import assert_pipeline_node_gate_config
    from app.services.pipeline_engine import _node_config, _node_type

    for node in graph.get("nodes") or []:
        try:
            assert_pipeline_node_gate_config(
                pipeline.project_id, _node_type(node), _node_config(node), db
            )
        except ValueError as exc:
            raise friendly(400, str(exc)) from exc
    pipeline.latest_version = (pipeline.latest_version or 0) + 1
    pipeline.status = PipelineStatus.draft
    version = PipelineVersion(
        pipeline_id=pipeline.id,
        project_id=pipeline.project_id,
        version=pipeline.latest_version,
        graph_json=dumps(graph),
        created_by=user_id,
    )
    db.add(version)
    db.flush()
    return version


@router.get("/projects/{project_id}/pipelines")
def list_pipelines(
    project_id: int,
    templates_only: bool = False,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.PIPELINE_READ)),
    db: Session = Depends(get_db),
):
    statement = select(Pipeline).where(Pipeline.project_id == project_id)
    if templates_only:
        statement = statement.where(Pipeline.is_template.is_(True))
    rows = db.scalars(
        statement.order_by(Pipeline.id.desc()).offset(skip).limit(limit)
    ).all()
    return [pipeline_out(row) for row in rows]


@router.post("/projects/{project_id}/pipelines", status_code=201)
def create_pipeline(
    project_id: int,
    body: PipelineCreate,
    access=Depends(require_project_perm(Permission.PIPELINE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    pipeline = Pipeline(
        project_id=project_id,
        name=body.name.strip(),
        description=body.description,
        is_template=body.is_template,
        created_by=auth.user.id,
    )
    db.add(pipeline)
    db.flush()
    version = _save_version(db, pipeline, body.graph, auth.user.id)
    audit_event(db, auth, "pipeline.create", "pipeline", pipeline.id)
    db.commit()
    db.refresh(pipeline)
    result = pipeline_out(pipeline)
    result["version"] = pipeline_version_out(version)
    return result


@router.post("/projects/{project_id}/pipelines/import", status_code=201)
def import_pipeline(
    project_id: int,
    body: PipelineImportRequest,
    access=Depends(require_project_perm(Permission.PIPELINE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    payload = body.pipeline
    graph = payload.get("graph", payload.get("version", {}).get("graph", {}))
    name = (body.name or payload.get("name") or "Imported pipeline").strip()
    pipeline = Pipeline(
        project_id=project_id,
        name=name,
        description=str(payload.get("description", "")),
        is_template=bool(payload.get("is_template", False)),
        created_by=auth.user.id,
    )
    db.add(pipeline)
    db.flush()
    version = _save_version(db, pipeline, graph, auth.user.id)
    audit_event(db, auth, "pipeline.import", "pipeline", pipeline.id)
    db.commit()
    result = pipeline_out(pipeline)
    result["version"] = pipeline_version_out(version)
    return result


@router.get("/projects/{project_id}/pipelines/{pipeline_id}")
def get_pipeline(
    project_id: int,
    pipeline_id: int,
    _=Depends(require_project_perm(Permission.PIPELINE_READ)),
    db: Session = Depends(get_db),
):
    pipeline = get_owned(db, Pipeline, pipeline_id, project_id, "Pipeline")
    result = pipeline_out(pipeline)
    result["version"] = pipeline_version_out(_latest_version(db, pipeline))
    return result


@router.patch("/projects/{project_id}/pipelines/{pipeline_id}")
def update_pipeline(
    project_id: int,
    pipeline_id: int,
    body: PipelineUpdate,
    access=Depends(require_project_perm(Permission.PIPELINE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    pipeline = get_owned(db, Pipeline, pipeline_id, project_id, "Pipeline")
    before = pipeline_out(pipeline)
    if body.name is not None:
        pipeline.name = body.name.strip()
    if body.description is not None:
        pipeline.description = body.description
    if body.is_template is not None:
        pipeline.is_template = body.is_template
    audit_event(
        db,
        auth,
        "pipeline.update",
        "pipeline",
        pipeline.id,
        before=before,
        after=pipeline_out(pipeline),
    )
    db.commit()
    return pipeline_out(pipeline)


@router.delete("/projects/{project_id}/pipelines/{pipeline_id}")
def delete_pipeline(
    project_id: int,
    pipeline_id: int,
    access=Depends(require_project_perm(Permission.PIPELINE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    pipeline = get_owned(db, Pipeline, pipeline_id, project_id, "Pipeline")
    run_count = db.scalar(
        select(func.count())
        .select_from(PipelineRun)
        .where(PipelineRun.pipeline_id == pipeline.id)
    )
    if run_count:
        raise friendly(409, "A pipeline with run history cannot be deleted.")
    db.execute(
        delete(PipelineVersion).where(PipelineVersion.pipeline_id == pipeline.id)
    )
    db.delete(pipeline)
    audit_event(db, auth, "pipeline.delete", "pipeline", pipeline.id)
    db.commit()
    return {"detail": "Pipeline deleted.", "hint": None}


@router.post("/projects/{project_id}/pipelines/{pipeline_id}/versions", status_code=201)
def save_graph(
    project_id: int,
    pipeline_id: int,
    body: PipelineGraphRequest,
    access=Depends(require_project_perm(Permission.PIPELINE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    pipeline = get_owned(db, Pipeline, pipeline_id, project_id, "Pipeline")
    version = _save_version(db, pipeline, body.graph, auth.user.id)
    audit_event(db, auth, "pipeline.version.create", "pipeline_version", version.id)
    db.commit()
    db.refresh(version)
    return pipeline_version_out(version)


@router.post("/projects/{project_id}/pipelines/{pipeline_id}/validate")
def validate_pipeline(
    project_id: int,
    pipeline_id: int,
    body: PipelineGraphRequest | None = Body(default=None),
    _=Depends(require_project_perm(Permission.PIPELINE_READ)),
    db: Session = Depends(get_db),
):
    pipeline = get_owned(db, Pipeline, pipeline_id, project_id, "Pipeline")
    graph = (
        body.graph
        if body
        else pipeline_version_out(_latest_version(db, pipeline))["graph"]
    )
    return validate_graph(graph)


@router.post("/projects/{project_id}/pipelines/{pipeline_id}/publish")
def publish_pipeline(
    project_id: int,
    pipeline_id: int,
    access=Depends(require_project_perm(Permission.PIPELINE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    pipeline = get_owned(db, Pipeline, pipeline_id, project_id, "Pipeline")
    graph = pipeline_version_out(_latest_version(db, pipeline))["graph"]
    result = validate_graph(graph)
    if not result["valid"]:
        raise friendly(400, "Pipeline graph is invalid.", "; ".join(result["errors"]))
    pipeline.status = PipelineStatus.published
    audit_event(db, auth, "pipeline.publish", "pipeline", pipeline.id)
    db.commit()
    return pipeline_out(pipeline)


@router.post("/projects/{project_id}/pipelines/{pipeline_id}/clone", status_code=201)
def clone_pipeline(
    project_id: int,
    pipeline_id: int,
    body: dict | None = Body(default=None),
    access=Depends(require_project_perm(Permission.PIPELINE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    source = get_owned(db, Pipeline, pipeline_id, project_id, "Pipeline")
    source_version = _latest_version(db, source)
    clone = Pipeline(
        project_id=project_id,
        name=str((body or {}).get("name") or f"{source.name} (copy)")[:200],
        description=source.description,
        is_template=False,
        created_by=auth.user.id,
    )
    db.add(clone)
    db.flush()
    _save_version(
        db, clone, pipeline_version_out(source_version)["graph"], auth.user.id
    )
    audit_event(
        db,
        auth,
        "pipeline.clone",
        "pipeline",
        clone.id,
        after={"source_pipeline_id": source.id},
    )
    db.commit()
    db.refresh(clone)
    return pipeline_out(clone)


@router.post("/projects/{project_id}/pipelines/{pipeline_id}/template")
def mark_template(
    project_id: int,
    pipeline_id: int,
    access=Depends(require_project_perm(Permission.PIPELINE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    pipeline = get_owned(db, Pipeline, pipeline_id, project_id, "Pipeline")
    pipeline.is_template = True
    audit_event(db, auth, "pipeline.template", "pipeline", pipeline.id)
    db.commit()
    return pipeline_out(pipeline)


@router.get("/projects/{project_id}/pipelines/{pipeline_id}/export")
def export_pipeline(
    project_id: int,
    pipeline_id: int,
    _=Depends(require_project_perm(Permission.PIPELINE_READ)),
    db: Session = Depends(get_db),
):
    pipeline = get_owned(db, Pipeline, pipeline_id, project_id, "Pipeline")
    return {
        "format": "modelflow.pipeline.v1",
        **pipeline_out(pipeline),
        "version": pipeline_version_out(_latest_version(db, pipeline)),
    }


@router.post("/projects/{project_id}/pipelines/{pipeline_id}/run", status_code=202)
def run_pipeline(
    project_id: int,
    pipeline_id: int,
    body: PipelineRunRequest | None = None,
    access=Depends(require_project_perm(Permission.PIPELINE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    body = body or PipelineRunRequest()
    pipeline = get_owned(db, Pipeline, pipeline_id, project_id, "Pipeline")
    if body.version is None:
        version = _latest_version(db, pipeline)
    else:
        version = db.scalar(
            select(PipelineVersion).where(
                PipelineVersion.pipeline_id == pipeline.id,
                PipelineVersion.version == body.version,
            )
        )
        if not version:
            raise friendly(404, f"Pipeline version {body.version} was not found.")
    validation = validate_graph(pipeline_version_out(version)["graph"])
    if not validation["valid"]:
        raise friendly(
            400, "Pipeline graph is invalid.", "; ".join(validation["errors"])
        )
    run = job_factories.create_pipeline_run(
        db,
        project_id=project_id,
        pipeline_id=pipeline.id,
        pipeline_version_id=version.id,
        parameters=body.parameters,
        fail_policy=body.fail_policy,
        scheduled_for=body.scheduled_for,
        created_by=auth.user.id,
    )
    audit_event(db, auth, "pipeline.run", "pipeline_run", run.id)
    db.commit()
    db.refresh(run)
    return pipeline_run_out(run)


@router.get("/projects/{project_id}/pipelines/{pipeline_id}/runs")
def list_pipeline_runs(
    project_id: int,
    pipeline_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.PIPELINE_READ)),
    db: Session = Depends(get_db),
):
    get_owned(db, Pipeline, pipeline_id, project_id, "Pipeline")
    rows = db.scalars(
        select(PipelineRun)
        .where(PipelineRun.pipeline_id == pipeline_id)
        .order_by(PipelineRun.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [pipeline_run_out(row) for row in rows]


@router.get("/projects/{project_id}/pipeline-runs/{run_id}")
def get_pipeline_run(
    project_id: int,
    run_id: int,
    _=Depends(require_project_perm(Permission.PIPELINE_READ)),
    db: Session = Depends(get_db),
):
    return pipeline_run_out(
        get_owned(db, PipelineRun, run_id, project_id, "Pipeline run")
    )


@router.post(
    "/projects/{project_id}/pipeline-runs/{run_id}/rerun-from-failed",
    status_code=202,
)
def rerun_pipeline_from_failed(
    project_id: int,
    run_id: int,
    access=Depends(require_project_perm(Permission.PIPELINE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    run = get_owned(db, PipelineRun, run_id, project_id, "Pipeline run")
    if run.status != JobStatus.failed:
        raise friendly(409, "Only a failed pipeline run can be restarted.")
    version = db.get(PipelineVersion, run.pipeline_version_id)
    if version is None:
        raise friendly(409, "The pipeline version for this run no longer exists.")
    restarted = pipeline_engine.prepare_rerun_from_failed(
        run, pipeline_version_out(version)["graph"]
    )
    if not restarted:
        raise friendly(409, "This run does not contain a failed node to restart.")
    audit_event(
        db,
        auth,
        "pipeline_run.rerun_from_failed",
        "pipeline_run",
        run.id,
        after={"restarted_nodes": restarted},
    )
    db.commit()
    db.refresh(run)
    return pipeline_run_out(run)


@router.post("/projects/{project_id}/pipeline-runs/{run_id}/cancel")
def cancel_pipeline_run(
    project_id: int,
    run_id: int,
    access=Depends(require_project_perm(Permission.PIPELINE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    run = get_owned(db, PipelineRun, run_id, project_id, "Pipeline run")
    states = json.loads(run.node_states_json or "{}")
    if run.status in {JobStatus.pending, JobStatus.queued}:
        run.status = JobStatus.cancelled
        run.finished_at = func.now()
        for state in states.values():
            if state.get("status") == "pending":
                state["status"] = "cancelled"
        run.node_states_json = dumps(states)
    elif run.status == JobStatus.running:
        run.status = JobStatus.cancel_requested
    else:
        raise friendly(409, f"A {run.status.value} pipeline run cannot be cancelled.")
    run.logs = (run.logs or "") + "Cancellation requested.\n"
    audit_event(db, auth, "pipeline_run.cancel", "pipeline_run", run.id)
    db.commit()
    db.refresh(run)
    return pipeline_run_out(run)

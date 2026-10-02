"""Phase 7-A — LLM Pipeline Copilot draft endpoint (stateless)."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.v1.common import audit_event, friendly
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.session import get_db
from app.schemas.v1 import PipelineCopilotDraftRequest
from app.services import pipeline_copilot as copilot

router = APIRouter(tags=["pipeline-copilot"])


@router.post("/projects/{project_id}/pipeline-copilot/draft")
def draft_pipeline_graph(
    project_id: int,
    body: PipelineCopilotDraftRequest,
    access=Depends(require_project_perm(Permission.PIPELINE_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    try:
        result = copilot.draft_pipeline(db, project_id, body.prompt)
    except copilot.CopilotError as exc:
        audit_event(
            db,
            auth,
            "pipeline.copilot.draft",
            "project",
            project_id,
            after={
                "project_id": project_id,
                "model": None,
                "node_count": 0,
                "edge_count": 0,
                "validation_valid": False,
                "error": exc.detail,
            },
            success=False,
            failure_reason=exc.detail,
        )
        db.commit()
        raise friendly(exc.status_code, exc.detail, exc.hint) from exc

    nodes = result.get("graph", {}).get("nodes") or []
    edges = result.get("graph", {}).get("edges") or []
    audit_event(
        db,
        auth,
        "pipeline.copilot.draft",
        "project",
        project_id,
        after={
            "project_id": project_id,
            "model": result.get("model"),
            "node_count": len(nodes),
            "edge_count": len(edges),
            "validation_valid": bool(result.get("validation", {}).get("valid")),
        },
        success=True,
    )
    db.commit()
    return result

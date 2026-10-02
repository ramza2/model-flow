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

_STABLE_FAILURE_REASON = "Pipeline Copilot draft failed."


def _failure_audit_after(project_id: int, exc: copilot.CopilotError) -> dict:
    """Bounded audit metadata — never store provider-derived detail/graph/prompt."""
    model_name = None
    if not isinstance(exc, copilot.CopilotNotConfiguredError):
        configured = str(getattr(copilot.settings, "llm_model", "") or "").strip()
        model_name = configured or None
    return {
        "project_id": project_id,
        "model": model_name,
        "node_count": 0,
        "edge_count": 0,
        "validation_valid": False,
        "status_code": exc.status_code,
        "error_type": type(exc).__name__,
    }


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
            after=_failure_audit_after(project_id, exc),
            success=False,
            failure_reason=_STABLE_FAILURE_REASON,
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

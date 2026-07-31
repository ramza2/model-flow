from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v1.common import (
    audit_event,
    dumps,
    friendly,
    get_owned,
    quality_check_out,
    quality_rule_out,
)
from app.api.v1.datasets import _read_frame
from app.core.config import settings
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.models import DatasetVersion, QualityCheck, QualityResult, QualityRule
from app.db.session import get_db
from app.schemas.v1 import QualityRuleCreate, QualityRuleUpdate, QualityRunRequest
from app.services import storage

router = APIRouter(tags=["quality"])


def _evaluate_rule(frame, rule: dict) -> tuple[bool, str]:
    rule_type = str(rule.get("type", "")).lower()
    column = rule.get("column")
    if column not in frame.columns:
        return False, f"Column '{column}' was not found"
    series = frame[column]
    if rule_type in {"not_null", "nonnull"}:
        count = int(series.isna().sum())
        return count == 0, f"{count} null values"
    if rule_type == "unique":
        count = int(series.duplicated().sum())
        return count == 0, f"{count} duplicate values"
    if rule_type in {"range", "between"}:
        minimum, maximum = rule.get("min"), rule.get("max")
        invalid = series.notna() & (
            ((series < minimum) if minimum is not None else False)
            | ((series > maximum) if maximum is not None else False)
        )
        count = int(invalid.sum())
        return count == 0, f"{count} values outside the configured range"
    if rule_type in {"allowed_values", "in"}:
        invalid = series.notna() & ~series.isin(rule.get("values", []))
        count = int(invalid.sum())
        return count == 0, f"{count} values are not allowed"
    if rule_type == "regex":
        invalid = series.notna() & ~series.astype(str).str.match(
            str(rule.get("pattern", ""))
        )
        count = int(invalid.sum())
        return count == 0, f"{count} values do not match"
    return False, f"Unsupported rule type '{rule_type}'"


@router.get("/projects/{project_id}/quality-rules")
def list_rules(
    project_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(QualityRule)
        .where(QualityRule.project_id == project_id)
        .order_by(QualityRule.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [quality_rule_out(row) for row in rows]


@router.post("/projects/{project_id}/quality-rules", status_code=201)
def create_rule(
    project_id: int,
    body: QualityRuleCreate,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    row = QualityRule(
        project_id=project_id,
        name=body.name.strip(),
        rules_json=dumps(body.rules),
        block_training_on_fail=body.block_training_on_fail,
    )
    db.add(row)
    db.flush()
    audit_event(db, auth, "quality_rule.create", "quality_rule", row.id)
    db.commit()
    db.refresh(row)
    return quality_rule_out(row)


@router.get("/projects/{project_id}/quality-rules/{rule_id}")
def get_rule(
    project_id: int,
    rule_id: int,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    return quality_rule_out(
        get_owned(db, QualityRule, rule_id, project_id, "Quality rule")
    )


@router.patch("/projects/{project_id}/quality-rules/{rule_id}")
def update_rule(
    project_id: int,
    rule_id: int,
    body: QualityRuleUpdate,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    row = get_owned(db, QualityRule, rule_id, project_id, "Quality rule")
    before = quality_rule_out(row)
    if body.name is not None:
        row.name = body.name.strip()
    if body.rules is not None:
        row.rules_json = dumps(body.rules)
    if body.block_training_on_fail is not None:
        row.block_training_on_fail = body.block_training_on_fail
    audit_event(
        db,
        auth,
        "quality_rule.update",
        "quality_rule",
        row.id,
        before=before,
        after=quality_rule_out(row),
    )
    db.commit()
    return quality_rule_out(row)


@router.delete("/projects/{project_id}/quality-rules/{rule_id}")
def delete_rule(
    project_id: int,
    rule_id: int,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    row = get_owned(db, QualityRule, rule_id, project_id, "Quality rule")
    usage = db.scalar(
        select(func.count())
        .select_from(QualityCheck)
        .where(QualityCheck.quality_rule_id == row.id)
    )
    if usage:
        raise friendly(
            409, "This quality rule has check history and cannot be deleted."
        )
    db.delete(row)
    audit_event(db, auth, "quality_rule.delete", "quality_rule", row.id)
    db.commit()
    return {"detail": "Quality rule deleted.", "hint": None}


@router.post(
    "/projects/{project_id}/dataset-versions/{dataset_version_id}/quality-checks",
    status_code=201,
)
def run_check(
    project_id: int,
    dataset_version_id: int,
    body: QualityRunRequest | None = None,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    body = body or QualityRunRequest()
    auth, _, _ = access
    version = get_owned(
        db,
        DatasetVersion,
        dataset_version_id,
        project_id,
        "Dataset version",
    )
    if body.quality_rule_id is not None:
        rules = [
            get_owned(db, QualityRule, body.quality_rule_id, project_id, "Quality rule")
        ]
    else:
        rules = db.scalars(
            select(QualityRule).where(QualityRule.project_id == project_id)
        ).all()
    if not rules:
        raise friendly(400, "No quality rules are configured for this project.")
    try:
        data = storage.download_bytes(
            settings.minio_datasets_bucket, version.object_key
        )
        frame = _read_frame(data, version.format)
    except Exception as exc:
        raise friendly(
            502, "The dataset version could not be loaded for checking."
        ) from exc

    details = []
    has_failure = False
    has_warning = False
    for rule_set in rules:
        for rule in __import__("json").loads(rule_set.rules_json or "[]"):
            passed, message = _evaluate_rule(frame, rule)
            severity = str(rule.get("severity", "fail")).lower()
            if not passed and severity == "warning":
                has_warning = True
            elif not passed:
                has_failure = True
            details.append(
                {
                    "quality_rule_id": rule_set.id,
                    "rule": rule,
                    "passed": passed,
                    "message": message,
                }
            )
    result = (
        QualityResult.FAIL
        if has_failure
        else QualityResult.WARNING
        if has_warning
        else QualityResult.PASS
    )
    check = QualityCheck(
        project_id=project_id,
        dataset_version_id=version.id,
        quality_rule_id=body.quality_rule_id,
        result=result,
        details_json=dumps(details),
        created_by=auth.user.id,
    )
    db.add(check)
    db.flush()
    audit_event(
        db,
        auth,
        "quality_check.run",
        "quality_check",
        check.id,
        after={"result": result.value},
    )
    db.commit()
    db.refresh(check)
    return quality_check_out(check)


@router.get("/projects/{project_id}/quality-checks")
def check_history(
    project_id: int,
    dataset_version_id: int | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    statement = select(QualityCheck).where(QualityCheck.project_id == project_id)
    if dataset_version_id is not None:
        statement = statement.where(
            QualityCheck.dataset_version_id == dataset_version_id
        )
    rows = db.scalars(
        statement.order_by(QualityCheck.id.desc()).offset(skip).limit(limit)
    ).all()
    return [quality_check_out(row) for row in rows]

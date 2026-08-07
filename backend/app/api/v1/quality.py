from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, joinedload

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
from app.services.quality import (
    QualityRuleValidationError,
    evaluate_api_rule,
    quality_rule_has_check_history,
    validate_quality_rule_write,
)

router = APIRouter(tags=["quality"])


def _validation_error(exc: QualityRuleValidationError):
    message = str(exc)
    # Missing dataset in project → 404; other validation → 422
    if "was not found in this project" in message:
        raise friendly(404, message) from exc
    raise friendly(422, message) from exc


@router.get("/projects/{project_id}/quality-rules")
def list_rules(
    project_id: int,
    dataset_id: int | None = None,
    include_inactive: bool = Query(default=True),
    include_unassigned: bool = Query(default=False),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    statement = (
        select(QualityRule)
        .options(joinedload(QualityRule.dataset))
        .where(QualityRule.project_id == project_id)
    )
    if dataset_id is not None:
        if include_unassigned:
            statement = statement.where(
                or_(
                    QualityRule.dataset_id == dataset_id,
                    QualityRule.dataset_id.is_(None),
                )
            )
        else:
            statement = statement.where(QualityRule.dataset_id == dataset_id)
    elif not include_unassigned:
        statement = statement.where(QualityRule.dataset_id.is_not(None))
    if not include_inactive:
        statement = statement.where(QualityRule.is_active.is_(True))
    rows = db.scalars(
        statement.order_by(QualityRule.id.desc()).offset(skip).limit(limit)
    ).unique().all()
    return [quality_rule_out(row) for row in rows]


@router.post("/projects/{project_id}/quality-rules", status_code=201)
def create_rule(
    project_id: int,
    body: QualityRuleCreate,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    try:
        dataset, normalized_rules = validate_quality_rule_write(
            db,
            project_id=project_id,
            name=body.name,
            dataset_id=body.dataset_id,
            rules=body.rules,
            require_dataset=True,
            require_rules=True,
        )
    except QualityRuleValidationError as exc:
        _validation_error(exc)

    assert dataset is not None and normalized_rules is not None
    row = QualityRule(
        project_id=project_id,
        dataset_id=dataset.id,
        name=body.name.strip(),
        rules_json=dumps(normalized_rules),
        block_training_on_fail=body.block_training_on_fail,
        is_active=body.is_active,
    )
    db.add(row)
    db.flush()
    audit_event(
        db,
        auth,
        "quality_rule.create",
        "quality_rule",
        row.id,
        after={
            "dataset_id": row.dataset_id,
            "name": row.name,
            "is_active": row.is_active,
            "block_training_on_fail": row.block_training_on_fail,
        },
    )
    db.commit()
    db.refresh(row)
    row = db.scalar(
        select(QualityRule)
        .options(joinedload(QualityRule.dataset))
        .where(QualityRule.id == row.id)
    )
    return quality_rule_out(row)


@router.get("/projects/{project_id}/quality-rules/{rule_id}")
def get_rule(
    project_id: int,
    rule_id: int,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    row = db.scalar(
        select(QualityRule)
        .options(joinedload(QualityRule.dataset))
        .where(QualityRule.id == rule_id, QualityRule.project_id == project_id)
    )
    if not row:
        raise friendly(404, f"Quality rule {rule_id} was not found in this project.")
    return quality_rule_out(row)


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
    before_active = row.is_active

    # Reject clearing dataset_id once assigned (explicit null on assigned rule).
    fields_set = body.model_fields_set
    if "dataset_id" in fields_set and body.dataset_id is None and row.dataset_id is not None:
        raise friendly(
            422,
            "dataset_id cannot be cleared once a rule is assigned to a dataset.",
        )

    target_dataset_id = (
        body.dataset_id
        if "dataset_id" in fields_set and body.dataset_id is not None
        else row.dataset_id
    )
    # When reassigning dataset without new conditions, re-validate existing rules
    # against the target dataset columns.
    rules_to_validate = body.rules
    if (
        rules_to_validate is None
        and "dataset_id" in fields_set
        and body.dataset_id is not None
        and body.dataset_id != row.dataset_id
    ):
        try:
            rules_to_validate = json.loads(row.rules_json or "[]")
        except (TypeError, ValueError):
            rules_to_validate = []
    try:
        dataset, normalized_rules = validate_quality_rule_write(
            db,
            project_id=project_id,
            name=body.name if body.name is not None else row.name,
            dataset_id=body.dataset_id if "dataset_id" in fields_set else None,
            rules=rules_to_validate,
            require_dataset=False,
            require_rules=False,
            existing_dataset_id=target_dataset_id,
        )
    except QualityRuleValidationError as exc:
        _validation_error(exc)

    final_dataset_id = (
        dataset.id
        if dataset is not None and "dataset_id" in fields_set
        else row.dataset_id
    )
    final_is_active = (
        body.is_active if body.is_active is not None else row.is_active
    )
    if final_dataset_id is None and final_is_active:
        raise friendly(
            422,
            "Assign a dataset before activating this quality rule.",
        )

    if body.name is not None:
        row.name = body.name.strip()
    if dataset is not None and "dataset_id" in fields_set:
        row.dataset_id = dataset.id
    if normalized_rules is not None:
        row.rules_json = dumps(normalized_rules)
    if body.block_training_on_fail is not None:
        row.block_training_on_fail = body.block_training_on_fail
    if body.is_active is not None:
        row.is_active = body.is_active

    after = {
        "dataset_id": row.dataset_id,
        "name": row.name,
        "is_active": row.is_active,
        "block_training_on_fail": row.block_training_on_fail,
        "rules": json.loads(row.rules_json or "[]"),
    }
    if body.is_active is not None and body.is_active != before_active:
        action = "quality_rule.activate" if row.is_active else "quality_rule.deactivate"
        audit_event(
            db,
            auth,
            action,
            "quality_rule",
            row.id,
            before=before,
            after=after,
        )
    else:
        audit_event(
            db,
            auth,
            "quality_rule.update",
            "quality_rule",
            row.id,
            before=before,
            after=after,
        )
    db.commit()
    row = db.scalar(
        select(QualityRule)
        .options(joinedload(QualityRule.dataset))
        .where(QualityRule.id == row.id)
    )
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
    if quality_rule_has_check_history(db, project_id, row.id):
        raise friendly(
            409,
            "This quality rule has check history and cannot be deleted.",
            "Deactivate the rule instead of deleting it.",
        )
    db.delete(row)
    audit_event(
        db,
        auth,
        "quality_rule.delete",
        "quality_rule",
        row.id,
        before={
            "dataset_id": row.dataset_id,
            "name": row.name,
            "is_active": row.is_active,
        },
    )
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
        rule = get_owned(
            db, QualityRule, body.quality_rule_id, project_id, "Quality rule"
        )
        if rule.dataset_id != version.dataset_id:
            raise friendly(
                409,
                "This quality rule belongs to another dataset.",
                "Choose a rule assigned to this dataset.",
            )
        if not rule.is_active:
            raise friendly(
                409,
                "This quality rule is inactive.",
                "Activate it before running the check.",
            )
        rules = [rule]
    else:
        rules = db.scalars(
            select(QualityRule).where(
                QualityRule.project_id == project_id,
                QualityRule.dataset_id == version.dataset_id,
                QualityRule.is_active.is_(True),
            )
        ).all()
    if not rules:
        raise friendly(
            400,
            "No active quality rules are configured for this dataset.",
            "Create or activate a rule for this dataset first.",
        )
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
        try:
            conditions = json.loads(rule_set.rules_json or "[]")
        except (TypeError, ValueError):
            conditions = []
        if not isinstance(conditions, list):
            conditions = []
        for rule in conditions:
            if not isinstance(rule, dict):
                passed, message = False, "Invalid rule condition"
                severity = "fail"
            else:
                passed, message = evaluate_api_rule(frame, rule)
                severity = str(rule.get("severity", "fail")).lower()
            if not passed and severity == "warning":
                has_warning = True
            elif not passed:
                has_failure = True
            details.append(
                {
                    "quality_rule_id": rule_set.id,
                    "quality_rule_name": rule_set.name,
                    "rule": rule if isinstance(rule, dict) else {"type": "unknown"},
                    "severity": severity,
                    "block_training_on_fail": rule_set.block_training_on_fail,
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
        after={
            "result": result.value,
            "dataset_id": version.dataset_id,
            "quality_rule_id": body.quality_rule_id,
            "dataset_version_id": version.id,
        },
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

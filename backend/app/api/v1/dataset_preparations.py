"""Dataset Preparation CRUD, versioning, validation, and run-snapshot APIs (Phase 2-A)."""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, selectinload

from app.api.v1.common import (
    audit_event,
    dataset_preparation_out,
    dataset_preparation_run_input_out,
    dataset_preparation_run_out,
    dataset_preparation_version_out,
    dumps,
    friendly,
    get_owned,
)
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.db.models import (
    Dataset,
    DatasetPreparation,
    DatasetPreparationRun,
    DatasetPreparationRunInput,
    DatasetPreparationRunStatus,
    DatasetPreparationVersion,
)
from app.db.session import get_db
from app.schemas.v1 import (
    DatasetPreparationCreate,
    DatasetPreparationGraph,
    DatasetPreparationGraphRequest,
    DatasetPreparationRunCreate,
    DatasetPreparationUpdate,
)
from app.services.dataset_preparation import (
    PreparationValidationError,
    find_preparation_by_name,
    graph_to_dict,
    parse_graph_json,
    resolve_source_pins,
    validate_preparation_graph,
)

router = APIRouter(tags=["dataset-preparations"])


def _latest_version(db: Session, preparation: DatasetPreparation) -> DatasetPreparationVersion:
    row = db.scalar(
        select(DatasetPreparationVersion).where(
            DatasetPreparationVersion.preparation_id == preparation.id,
            DatasetPreparationVersion.version == preparation.latest_version,
        )
    )
    if not row:
        raise friendly(409, "Preparation does not have a saved version.")
    return row


def _validate_output_dataset(db: Session, project_id: int, output_dataset_id: int | None) -> None:
    if output_dataset_id is None:
        return
    dataset = db.get(Dataset, output_dataset_id)
    if not dataset or dataset.project_id != project_id:
        raise friendly(404, "Dataset was not found in this project.")


def _save_version(
    db: Session,
    preparation: DatasetPreparation,
    graph: DatasetPreparationGraph | dict,
    user_id: int,
) -> DatasetPreparationVersion:
    validation = validate_preparation_graph(
        db, preparation.project_id, graph, strict=False
    )
    if not validation["valid"]:
        raise friendly(
            400,
            "Preparation graph is invalid.",
            "; ".join(validation["errors"]),
        )
    preparation.latest_version = (preparation.latest_version or 0) + 1
    version = DatasetPreparationVersion(
        preparation_id=preparation.id,
        project_id=preparation.project_id,
        version=preparation.latest_version,
        schema_version=1,
        graph_json=dumps(graph_to_dict(graph)),
        created_by=user_id,
    )
    db.add(version)
    db.flush()
    return version


@router.get("/projects/{project_id}/dataset-preparations")
def list_preparations(
    project_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(DatasetPreparation)
        .where(DatasetPreparation.project_id == project_id)
        .order_by(DatasetPreparation.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [dataset_preparation_out(row) for row in rows]


@router.post("/projects/{project_id}/dataset-preparations", status_code=201)
def create_preparation(
    project_id: int,
    body: DatasetPreparationCreate,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    name = body.name.strip()
    if find_preparation_by_name(db, project_id, name):
        raise friendly(409, "A preparation with this name already exists in the project.")
    _validate_output_dataset(db, project_id, body.output_dataset_id)

    preparation = DatasetPreparation(
        project_id=project_id,
        name=name,
        description=body.description or "",
        output_dataset_id=body.output_dataset_id,
        latest_version=0,
        created_by=auth.user.id,
    )
    db.add(preparation)
    db.flush()
    version = _save_version(db, preparation, body.graph, auth.user.id)
    audit_event(
        db,
        auth,
        "dataset_preparation.create",
        "dataset_preparation",
        preparation.id,
        after=dataset_preparation_out(preparation),
    )
    db.commit()
    db.refresh(preparation)
    db.refresh(version)
    result = dataset_preparation_out(preparation)
    result["version"] = dataset_preparation_version_out(version)
    return result


@router.get("/projects/{project_id}/dataset-preparations/{preparation_id}")
def get_preparation(
    project_id: int,
    preparation_id: int,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    preparation = get_owned(
        db, DatasetPreparation, preparation_id, project_id, "Preparation"
    )
    result = dataset_preparation_out(preparation)
    result["version"] = dataset_preparation_version_out(_latest_version(db, preparation))
    return result


@router.patch("/projects/{project_id}/dataset-preparations/{preparation_id}")
def update_preparation(
    project_id: int,
    preparation_id: int,
    body: DatasetPreparationUpdate,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    preparation = get_owned(
        db, DatasetPreparation, preparation_id, project_id, "Preparation"
    )
    before = dataset_preparation_out(preparation)
    fields = body.model_fields_set
    if "name" in fields and body.name is not None:
        name = body.name.strip()
        if find_preparation_by_name(db, project_id, name, exclude_id=preparation.id):
            raise friendly(
                409, "A preparation with this name already exists in the project."
            )
        preparation.name = name
    if "description" in fields and body.description is not None:
        preparation.description = body.description
    if "output_dataset_id" in fields:
        _validate_output_dataset(db, project_id, body.output_dataset_id)
        preparation.output_dataset_id = body.output_dataset_id
    audit_event(
        db,
        auth,
        "dataset_preparation.update",
        "dataset_preparation",
        preparation.id,
        before=before,
        after=dataset_preparation_out(preparation),
    )
    db.commit()
    db.refresh(preparation)
    return dataset_preparation_out(preparation)


@router.delete("/projects/{project_id}/dataset-preparations/{preparation_id}")
def delete_preparation(
    project_id: int,
    preparation_id: int,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    preparation = get_owned(
        db, DatasetPreparation, preparation_id, project_id, "Preparation"
    )
    run_count = db.scalar(
        select(func.count())
        .select_from(DatasetPreparationRun)
        .where(DatasetPreparationRun.preparation_id == preparation.id)
    )
    if run_count:
        raise friendly(409, "A preparation with run history cannot be deleted.")
    db.execute(
        delete(DatasetPreparationVersion).where(
            DatasetPreparationVersion.preparation_id == preparation.id
        )
    )
    db.delete(preparation)
    audit_event(
        db, auth, "dataset_preparation.delete", "dataset_preparation", preparation_id
    )
    db.commit()
    return {"detail": "Preparation deleted.", "hint": None}


@router.get("/projects/{project_id}/dataset-preparations/{preparation_id}/versions")
def list_versions(
    project_id: int,
    preparation_id: int,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    get_owned(db, DatasetPreparation, preparation_id, project_id, "Preparation")
    rows = db.scalars(
        select(DatasetPreparationVersion)
        .where(
            DatasetPreparationVersion.preparation_id == preparation_id,
            DatasetPreparationVersion.project_id == project_id,
        )
        .order_by(DatasetPreparationVersion.version.desc())
    ).all()
    return [dataset_preparation_version_out(row) for row in rows]


@router.post(
    "/projects/{project_id}/dataset-preparations/{preparation_id}/versions",
    status_code=201,
)
def create_version(
    project_id: int,
    preparation_id: int,
    body: DatasetPreparationGraphRequest,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    preparation = get_owned(
        db, DatasetPreparation, preparation_id, project_id, "Preparation"
    )
    version = _save_version(db, preparation, body.graph, auth.user.id)
    audit_event(
        db,
        auth,
        "dataset_preparation.version.create",
        "dataset_preparation_version",
        version.id,
        after={"preparation_id": preparation.id, "version": version.version},
    )
    db.commit()
    db.refresh(version)
    return dataset_preparation_version_out(version)


@router.get("/projects/{project_id}/dataset-preparation-versions/{version_id}")
def get_version(
    project_id: int,
    version_id: int,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    version = db.get(DatasetPreparationVersion, version_id)
    if not version or version.project_id != project_id:
        raise friendly(404, "Preparation version not found.")
    get_owned(db, DatasetPreparation, version.preparation_id, project_id, "Preparation")
    return dataset_preparation_version_out(version)


@router.post("/projects/{project_id}/dataset-preparations/{preparation_id}/validate")
def validate_preparation(
    project_id: int,
    preparation_id: int,
    body: DatasetPreparationGraphRequest | None = Body(default=None),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    preparation = get_owned(
        db, DatasetPreparation, preparation_id, project_id, "Preparation"
    )
    if body is not None:
        graph = body.graph
    else:
        version = _latest_version(db, preparation)
        graph = parse_graph_json(version.graph_json)
    return validate_preparation_graph(
        db, project_id, graph, strict=True, resolve_latest=True
    )


@router.post(
    "/projects/{project_id}/dataset-preparations/{preparation_id}/runs",
    status_code=201,
)
def create_run(
    project_id: int,
    preparation_id: int,
    body: DatasetPreparationRunCreate,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    preparation = get_owned(
        db, DatasetPreparation, preparation_id, project_id, "Preparation"
    )
    if preparation.latest_version < 1:
        raise friendly(409, "Preparation does not have a saved version.")

    version_number = (
        preparation.latest_version if body.version is None else body.version
    )
    version = db.scalar(
        select(DatasetPreparationVersion).where(
            DatasetPreparationVersion.preparation_id == preparation.id,
            DatasetPreparationVersion.project_id == project_id,
            DatasetPreparationVersion.version == version_number,
        )
    )
    if not version:
        raise friendly(404, "Preparation version not found.")

    graph = parse_graph_json(version.graph_json)
    try:
        pins = resolve_source_pins(db, project_id, graph)
    except PreparationValidationError as exc:
        raise friendly(
            exc.status_code,
            "Preparation graph is invalid for run snapshot.",
            "; ".join(exc.errors),
        ) from exc

    run = DatasetPreparationRun(
        project_id=project_id,
        preparation_id=preparation.id,
        preparation_version_id=version.id,
        status=DatasetPreparationRunStatus.created,
        output_dataset_version_id=None,
        logs="",
        created_by=auth.user.id,
    )
    db.add(run)
    db.flush()
    for pin in pins:
        db.add(
            DatasetPreparationRunInput(
                run_id=run.id,
                project_id=project_id,
                node_id=pin["node_id"],
                dataset_id=pin["dataset_id"],
                dataset_version_id=pin["dataset_version_id"],
                version_strategy=pin["version_strategy"],
            )
        )
    db.flush()
    audit_event(
        db,
        auth,
        "dataset_preparation.run.create",
        "dataset_preparation_run",
        run.id,
        after={
            "preparation_id": preparation.id,
            "preparation_version_id": version.id,
            "input_count": len(pins),
        },
    )
    db.commit()
    run = db.scalar(
        select(DatasetPreparationRun)
        .where(DatasetPreparationRun.id == run.id)
        .options(selectinload(DatasetPreparationRun.inputs))
    )
    return dataset_preparation_run_out(run, include_inputs=True)


@router.get("/projects/{project_id}/dataset-preparations/{preparation_id}/runs")
def list_runs(
    project_id: int,
    preparation_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    get_owned(db, DatasetPreparation, preparation_id, project_id, "Preparation")
    rows = db.scalars(
        select(DatasetPreparationRun)
        .where(
            DatasetPreparationRun.preparation_id == preparation_id,
            DatasetPreparationRun.project_id == project_id,
        )
        .order_by(DatasetPreparationRun.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [dataset_preparation_run_out(row) for row in rows]


@router.get("/projects/{project_id}/dataset-preparation-runs/{run_id}")
def get_run(
    project_id: int,
    run_id: int,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    run = db.scalar(
        select(DatasetPreparationRun)
        .where(DatasetPreparationRun.id == run_id)
        .options(selectinload(DatasetPreparationRun.inputs))
    )
    if not run or run.project_id != project_id:
        raise friendly(404, "Preparation run not found.")
    get_owned(db, DatasetPreparation, run.preparation_id, project_id, "Preparation")
    return dataset_preparation_run_out(run, include_inputs=True)


@router.get("/projects/{project_id}/dataset-preparation-runs/{run_id}/inputs")
def list_run_inputs(
    project_id: int,
    run_id: int,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    run = db.get(DatasetPreparationRun, run_id)
    if not run or run.project_id != project_id:
        raise friendly(404, "Preparation run not found.")
    get_owned(db, DatasetPreparation, run.preparation_id, project_id, "Preparation")
    rows = db.scalars(
        select(DatasetPreparationRunInput)
        .where(
            DatasetPreparationRunInput.run_id == run_id,
            DatasetPreparationRunInput.project_id == project_id,
        )
        .order_by(DatasetPreparationRunInput.node_id.asc())
    ).all()
    return [dataset_preparation_run_input_out(row) for row in rows]

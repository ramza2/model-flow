from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import quote_plus

from fastapi import APIRouter, Depends, Query
from sqlalchemy import create_engine, func, inspect, select, text
from sqlalchemy.orm import Session

from app.api.v1.common import (
    audit_event,
    data_source_out,
    dumps,
    enum_value,
    friendly,
    get_owned,
    import_job_out,
    loads,
)
from app.core.deps import require_project_perm
from app.core.rbac import Permission
from app.core.security import decrypt_secret, encrypt_secret
from app.db.models import (
    DataImportJob,
    DataSource,
    DataSourceType,
    Dataset,
    DatasetVersion,
    JobStatus,
)
from app.db.session import get_db
from app.schemas.v1 import DataImportRequest, DataSourceCreate, DataSourceUpdate

router = APIRouter(tags=["data-sources"])
_SECRET_KEYS = {"password", "passwd", "secret", "token", "api_key", "url", "dsn"}


def _source_has_usage(db: Session, source_id: int) -> bool:
    """True when any import job or dataset version references this source."""
    if db.scalar(
        select(DataImportJob.id).where(DataImportJob.data_source_id == source_id).limit(1)
    ):
        return True
    if db.scalar(
        select(DatasetVersion.id)
        .where(DatasetVersion.data_source_id == source_id)
        .limit(1)
    ):
        return True
    return False


def _audit_source_meta(source: DataSource) -> dict:
    """Minimal metadata for audits — never includes secrets or connection creds."""
    return {
        "id": source.id,
        "name": source.name,
        "source_type": enum_value(source.source_type),
    }


def _separate_secrets(
    config: dict,
    secrets: dict,
) -> tuple[dict, dict]:
    public, private = {}, dict(secrets)
    for key, value in config.items():
        if key.lower() in _SECRET_KEYS:
            private[key] = value
        else:
            public[key] = value
    return public, private


def _secret_dict(source: DataSource) -> dict:
    if not source.secret_encrypted:
        return {}
    return loads(decrypt_secret(source.secret_encrypted), {})


def _connection_url(source: DataSource) -> str:
    config = loads(source.config_json, {})
    secrets = _secret_dict(source)
    if secrets.get("url") or secrets.get("dsn"):
        return str(secrets.get("url") or secrets.get("dsn"))
    if source.source_type != DataSourceType.postgres:
        raise friendly(400, "This data source does not support database operations.")
    required = ["host", "database", "user"]
    missing = [key for key in required if not (config.get(key) or secrets.get(key))]
    if missing:
        raise friendly(400, f"Data source is missing: {', '.join(missing)}.")
    user = quote_plus(str(config.get("user") or secrets.get("user")))
    password = quote_plus(str(secrets.get("password", "")))
    auth = f"{user}:{password}" if password else user
    host = config.get("host")
    port = int(config.get("port", 5432))
    database = quote_plus(str(config.get("database")))
    return f"postgresql+psycopg2://{auth}@{host}:{port}/{database}"


def _source_engine(source: DataSource):
    return create_engine(
        _connection_url(source), pool_pre_ping=True, connect_args={"connect_timeout": 5}
    )


@router.get("/projects/{project_id}/data-sources")
def list_data_sources(
    project_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(DataSource)
        .where(DataSource.project_id == project_id)
        .order_by(DataSource.id.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [data_source_out(row) for row in rows]


@router.post("/projects/{project_id}/data-sources", status_code=201)
def create_data_source(
    project_id: int,
    body: DataSourceCreate,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    public, private = _separate_secrets(body.config, body.secrets)
    source = DataSource(
        project_id=project_id,
        name=body.name.strip(),
        source_type=body.source_type,
        config_json=dumps(public),
        secret_encrypted=encrypt_secret(dumps(private)) if private else None,
        created_by=auth.user.id,
    )
    db.add(source)
    db.flush()
    audit_event(
        db,
        auth,
        "data_source.create",
        "data_source",
        source.id,
        after=data_source_out(source),
    )
    db.commit()
    db.refresh(source)
    return data_source_out(source)


@router.get("/projects/{project_id}/data-sources/{source_id}")
def get_data_source(
    project_id: int,
    source_id: int,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    return data_source_out(
        get_owned(db, DataSource, source_id, project_id, "Data source")
    )


@router.patch("/projects/{project_id}/data-sources/{source_id}")
def update_data_source(
    project_id: int,
    source_id: int,
    body: DataSourceUpdate,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    source = get_owned(db, DataSource, source_id, project_id, "Data source")
    before = data_source_out(source)
    if body.name is not None:
        source.name = body.name.strip()
    if body.config is not None:
        public, private_from_config = _separate_secrets(body.config, {})
        source.config_json = dumps(public)
        if private_from_config:
            existing = _secret_dict(source)
            existing.update(private_from_config)
            source.secret_encrypted = encrypt_secret(dumps(existing))
    if body.secrets is not None:
        existing = _secret_dict(source)
        existing.update(body.secrets)
        source.secret_encrypted = encrypt_secret(dumps(existing)) if existing else None
    if body.is_active is not None:
        source.is_active = body.is_active
    audit_event(
        db,
        auth,
        "data_source.update",
        "data_source",
        source.id,
        before=before,
        after=data_source_out(source),
    )
    db.commit()
    return data_source_out(source)


@router.post("/projects/{project_id}/data-sources/{source_id}/activate")
def activate_data_source(
    project_id: int,
    source_id: int,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    source = get_owned(db, DataSource, source_id, project_id, "Data source")
    if source.is_active:
        return data_source_out(source)
    source.is_active = True
    audit_event(
        db,
        auth,
        "data_source.activate",
        "data_source",
        source.id,
        after=_audit_source_meta(source),
    )
    db.commit()
    db.refresh(source)
    return data_source_out(source)


@router.post("/projects/{project_id}/data-sources/{source_id}/deactivate")
def deactivate_data_source(
    project_id: int,
    source_id: int,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    source = get_owned(db, DataSource, source_id, project_id, "Data source")
    if not source.is_active:
        return data_source_out(source)
    source.is_active = False
    audit_event(
        db,
        auth,
        "data_source.deactivate",
        "data_source",
        source.id,
        after=_audit_source_meta(source),
    )
    db.commit()
    db.refresh(source)
    return data_source_out(source)


@router.delete("/projects/{project_id}/data-sources/{source_id}")
def delete_data_source(
    project_id: int,
    source_id: int,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    source = get_owned(db, DataSource, source_id, project_id, "Data source")
    if _source_has_usage(db, source.id):
        raise friendly(
            409,
            "This data source has import history and cannot be permanently deleted.",
            "Deactivate it to prevent future imports while preserving lineage.",
        )
    meta = _audit_source_meta(source)
    audit_event(
        db,
        auth,
        "data_source.delete",
        "data_source",
        source.id,
        before=meta,
    )
    db.delete(source)
    db.commit()
    return {"detail": "Data source permanently deleted.", "hint": None}


@router.post("/projects/{project_id}/data-sources/{source_id}/test")
def test_data_source(
    project_id: int,
    source_id: int,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    source = get_owned(db, DataSource, source_id, project_id, "Data source")
    if not source.is_active:
        raise friendly(
            409,
            "This data source is inactive.",
            "Activate it before testing the connection.",
        )
    engine = None
    try:
        if source.source_type == DataSourceType.file:
            message = "File source configuration is valid."
        else:
            engine = _source_engine(source)
            with engine.connect() as connection:
                connection.execute(text("SELECT 1"))
            message = "Connection succeeded."
        source.last_test_status = "ok"
        source.last_test_message = message
        success = True
    except Exception as exc:
        source.last_test_status = "error"
        source.last_test_message = (
            "Connection failed. Check the host, database, and credentials."
        )
        message = source.last_test_message
        success = False
        failure = exc.__class__.__name__
    finally:
        if engine is not None:
            engine.dispose()
    source.last_tested_at = datetime.now(timezone.utc)
    audit_event(
        db,
        auth,
        "data_source.test",
        "data_source",
        source.id,
        success=success,
        failure_reason=failure if not success else None,
    )
    db.commit()
    return {"status": source.last_test_status, "message": message}


@router.get("/projects/{project_id}/data-sources/{source_id}/schemas")
def list_schemas(
    project_id: int,
    source_id: int,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    source = get_owned(db, DataSource, source_id, project_id, "Data source")
    if source.source_type == DataSourceType.file:
        return []
    engine = _source_engine(source)
    try:
        return inspect(engine).get_schema_names()
    except Exception as exc:
        raise friendly(
            502, "Could not list schemas.", "Test the data source connection."
        ) from exc
    finally:
        engine.dispose()


@router.get("/projects/{project_id}/data-sources/{source_id}/tables")
def list_tables(
    project_id: int,
    source_id: int,
    schema: str | None = None,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    source = get_owned(db, DataSource, source_id, project_id, "Data source")
    if source.source_type == DataSourceType.file:
        return []
    engine = _source_engine(source)
    try:
        inspector = inspect(engine)
        return [
            {"schema": schema, "name": name}
            for name in inspector.get_table_names(schema=schema)
        ]
    except Exception as exc:
        raise friendly(
            502, "Could not list tables.", "Test the data source connection."
        ) from exc
    finally:
        engine.dispose()


@router.post("/projects/{project_id}/data-sources/{source_id}/import", status_code=202)
def import_data(
    project_id: int,
    source_id: int,
    body: DataImportRequest,
    access=Depends(require_project_perm(Permission.DATA_WRITE)),
    db: Session = Depends(get_db),
):
    auth, _, _ = access
    source = get_owned(db, DataSource, source_id, project_id, "Data source")
    if not source.is_active:
        raise friendly(409, "This data source is inactive.")
    dataset = db.scalar(
        select(Dataset).where(
            Dataset.project_id == project_id,
            func.lower(Dataset.name) == body.dataset_name.strip().lower(),
        )
    )
    if not dataset:
        dataset = Dataset(
            project_id=project_id,
            name=body.dataset_name.strip(),
            created_by=auth.user.id,
        )
        db.add(dataset)
        db.flush()
    job = DataImportJob(
        project_id=project_id,
        data_source_id=source.id,
        dataset_id=dataset.id,
        query_or_table=body.table_or_query,
        status=JobStatus.pending,
        created_by=auth.user.id,
    )
    db.add(job)
    db.flush()
    audit_event(db, auth, "data_source.import", "data_import_job", job.id)
    db.commit()
    db.refresh(job)
    return import_job_out(job)


@router.get("/projects/{project_id}/data-import-jobs")
def list_import_jobs(
    project_id: int,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    data_source_id: int | None = Query(default=None),
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    statement = select(DataImportJob).where(DataImportJob.project_id == project_id)
    if data_source_id is not None:
        get_owned(db, DataSource, data_source_id, project_id, "Data source")
        statement = statement.where(DataImportJob.data_source_id == data_source_id)
    rows = db.scalars(
        statement.order_by(DataImportJob.id.desc()).offset(skip).limit(limit)
    ).all()
    return [import_job_out(row) for row in rows]


@router.get("/projects/{project_id}/data-import-jobs/{job_id}")
def get_import_job(
    project_id: int,
    job_id: int,
    _=Depends(require_project_perm(Permission.DATA_READ)),
    db: Session = Depends(get_db),
):
    return import_job_out(
        get_owned(db, DataImportJob, job_id, project_id, "Data import job")
    )

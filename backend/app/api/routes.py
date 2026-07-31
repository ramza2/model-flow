import json
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.models import Dataset, Endpoint, JobStatus, Project, TrainingJob
from app.db.session import get_db
from app.schemas import (
    DashboardStats,
    DatasetOut,
    EndpointCreate,
    EndpointOut,
    JobCreate,
    JobOut,
    PredictRequest,
    PredictResponse,
    ProjectCreate,
    ProjectOut,
    RegisterModelRequest,
    SystemStatus,
)
from app.services import inference, mlflow_service, storage

router = APIRouter()


def _friendly(status: int, detail: str, hint: str | None = None) -> HTTPException:
    return HTTPException(status_code=status, detail={"detail": detail, "hint": hint})


def _dataset_out(d: Dataset) -> DatasetOut:
    return DatasetOut(
        id=d.id,
        project_id=d.project_id,
        name=d.name,
        object_key=d.object_key,
        row_count=d.row_count,
        column_count=d.column_count,
        columns=json.loads(d.columns_json or "[]"),
        stats=json.loads(d.stats_json or "{}"),
        created_at=d.created_at,
    )


def _job_out(j: TrainingJob) -> JobOut:
    return JobOut(
        id=j.id,
        project_id=j.project_id,
        dataset_id=j.dataset_id,
        name=j.name,
        target_column=j.target_column,
        algorithm=j.algorithm,
        hyperparameters=json.loads(j.hyperparameters_json or "{}"),
        status=j.status.value if hasattr(j.status, "value") else str(j.status),
        logs=j.logs or "",
        mlflow_run_id=j.mlflow_run_id,
        model_uri=j.model_uri,
        metrics=json.loads(j.metrics_json or "{}"),
        error_message=j.error_message,
        created_at=j.created_at,
        started_at=j.started_at,
        finished_at=j.finished_at,
    )


def _get_project(db: Session, project_id: int) -> Project:
    p = db.get(Project, project_id)
    if not p:
        raise _friendly(404, f"Project {project_id} was not found.", "Check the project list and try again.")
    return p


@router.get("/health")
def health():
    return {"status": "ok", "service": "backend"}


@router.get("/system/status", response_model=SystemStatus)
def system_status(db: Session = Depends(get_db)):
    db_status = "ok"
    try:
        db.execute(select(func.now()))
    except Exception:
        db_status = "error"

    minio_status = "ok"
    try:
        storage.ensure_buckets()
    except Exception:
        minio_status = "error"

    mlflow_status = "ok"
    try:
        mlflow_service.client().search_experiments(max_results=1)
    except Exception:
        mlflow_status = "error"

    pending = db.scalar(select(func.count()).select_from(TrainingJob).where(TrainingJob.status == JobStatus.pending)) or 0
    running = db.scalar(select(func.count()).select_from(TrainingJob).where(TrainingJob.status == JobStatus.running)) or 0
    return SystemStatus(
        api="ok",
        database=db_status,
        minio=minio_status,
        mlflow=mlflow_status,
        pending_jobs=pending,
        running_jobs=running,
    )


@router.get("/dashboard", response_model=DashboardStats)
def dashboard(db: Session = Depends(get_db)):
    return DashboardStats(
        projects=db.scalar(select(func.count()).select_from(Project)) or 0,
        datasets=db.scalar(select(func.count()).select_from(Dataset)) or 0,
        jobs=db.scalar(select(func.count()).select_from(TrainingJob)) or 0,
        endpoints=db.scalar(select(func.count()).select_from(Endpoint)) or 0,
        succeeded_jobs=db.scalar(select(func.count()).select_from(TrainingJob).where(TrainingJob.status == JobStatus.succeeded)) or 0,
        failed_jobs=db.scalar(select(func.count()).select_from(TrainingJob).where(TrainingJob.status == JobStatus.failed)) or 0,
    )


@router.get("/projects", response_model=list[ProjectOut])
def list_projects(db: Session = Depends(get_db)):
    return db.scalars(select(Project).order_by(Project.id.desc())).all()


@router.post("/projects", response_model=ProjectOut, status_code=201)
def create_project(body: ProjectCreate, db: Session = Depends(get_db)):
    existing = db.scalar(select(Project).where(Project.name == body.name))
    if existing:
        raise _friendly(409, f"A project named '{body.name}' already exists.", "Choose a unique project name.")
    p = Project(name=body.name.strip(), description=body.description or "")
    db.add(p)
    db.commit()
    db.refresh(p)
    mlflow_service.ensure_experiment(f"project-{p.id}")
    return p


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: int, db: Session = Depends(get_db)):
    return _get_project(db, project_id)


@router.get("/projects/{project_id}/datasets", response_model=list[DatasetOut])
def list_datasets(project_id: int, db: Session = Depends(get_db)):
    _get_project(db, project_id)
    rows = db.scalars(select(Dataset).where(Dataset.project_id == project_id).order_by(Dataset.id.desc())).all()
    return [_dataset_out(d) for d in rows]


@router.post("/projects/{project_id}/datasets", response_model=DatasetOut, status_code=201)
async def upload_dataset(
    project_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    _get_project(db, project_id)
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise _friendly(400, "Only CSV files are supported.", "Upload a .csv file with a header row.")
    data = await file.read()
    if not data:
        raise _friendly(400, "The uploaded file is empty.", "Export your dataset again and retry.")
    try:
        rows, cols, columns, stats = storage.profile_csv(data)
    except Exception as exc:
        raise _friendly(400, f"Could not parse CSV: {exc}", "Ensure the file is valid UTF-8 CSV.") from exc

    storage.ensure_buckets()
    # Unique object key so re-uploads with the same filename never overwrite prior objects.
    key = f"project-{project_id}/{uuid.uuid4().hex}/{file.filename}"
    storage.upload_bytes(settings.minio_datasets_bucket, key, data, "text/csv")
    d = Dataset(
        project_id=project_id,
        name=file.filename,
        object_key=key,
        row_count=rows,
        column_count=cols,
        columns_json=storage.dumps(columns),
        stats_json=storage.dumps(stats),
    )
    db.add(d)
    db.commit()
    db.refresh(d)
    return _dataset_out(d)


@router.get("/datasets/{dataset_id}", response_model=DatasetOut)
def get_dataset(dataset_id: int, db: Session = Depends(get_db)):
    d = db.get(Dataset, dataset_id)
    if not d:
        raise _friendly(404, f"Dataset {dataset_id} was not found.")
    return _dataset_out(d)


@router.get("/projects/{project_id}/jobs", response_model=list[JobOut])
def list_jobs(project_id: int, db: Session = Depends(get_db)):
    _get_project(db, project_id)
    rows = db.scalars(select(TrainingJob).where(TrainingJob.project_id == project_id).order_by(TrainingJob.id.desc())).all()
    return [_job_out(j) for j in rows]


@router.post("/projects/{project_id}/jobs", response_model=JobOut, status_code=201)
def create_job(project_id: int, body: JobCreate, db: Session = Depends(get_db)):
    _get_project(db, project_id)
    ds = db.get(Dataset, body.dataset_id)
    if not ds or ds.project_id != project_id:
        raise _friendly(400, "Dataset does not belong to this project.", "Pick a dataset from this project.")
    columns = json.loads(ds.columns_json or "[]")
    if body.target_column not in columns:
        raise _friendly(
            400,
            f"Target column '{body.target_column}' is not in the dataset.",
            f"Available columns: {', '.join(columns)}",
        )
    job = TrainingJob(
        project_id=project_id,
        dataset_id=body.dataset_id,
        name=body.name,
        target_column=body.target_column,
        algorithm=body.algorithm or "random_forest",
        hyperparameters_json=storage.dumps(body.hyperparameters or {}),
        status=JobStatus.pending,
        logs="Queued for training.\n",
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return _job_out(job)


@router.get("/jobs/{job_id}", response_model=JobOut)
def get_job(job_id: int, db: Session = Depends(get_db)):
    job = db.get(TrainingJob, job_id)
    if not job:
        raise _friendly(404, f"Training job {job_id} was not found.")
    return _job_out(job)


@router.get("/projects/{project_id}/runs")
def list_runs(project_id: int, db: Session = Depends(get_db)):
    _get_project(db, project_id)
    return mlflow_service.list_runs(f"project-{project_id}")


@router.get("/runs/{run_id}")
def get_run(run_id: str):
    try:
        return mlflow_service.get_run(run_id)
    except Exception as exc:
        raise _friendly(404, f"Run '{run_id}' was not found.", str(exc)) from exc


@router.get("/projects/{project_id}/runs/compare")
def compare_runs(project_id: int, run_ids: str, db: Session = Depends(get_db)):
    _get_project(db, project_id)
    ids = [x.strip() for x in run_ids.split(",") if x.strip()]
    if len(ids) < 2:
        raise _friendly(400, "Provide at least two run IDs.", "Use ?run_ids=id1,id2")
    runs = []
    for rid in ids:
        try:
            runs.append(mlflow_service.get_run(rid))
        except Exception:
            raise _friendly(404, f"Run '{rid}' was not found.")
    metric_keys = sorted({k for r in runs for k in r["metrics"].keys()})
    param_keys = sorted({k for r in runs for k in r["params"].keys()})
    return {"runs": runs, "metric_keys": metric_keys, "param_keys": param_keys}


@router.post("/projects/{project_id}/models/register")
def register_model(project_id: int, body: RegisterModelRequest, db: Session = Depends(get_db)):
    _get_project(db, project_id)
    experiment_name = f"project-{project_id}"
    try:
        run = mlflow_service.get_run(body.run_id)
    except Exception as exc:
        raise _friendly(404, f"Run '{body.run_id}' was not found.", str(exc)) from exc
    try:
        exp_id = mlflow_service.ensure_experiment(experiment_name)
    except Exception as exc:
        raise _friendly(400, f"Could not resolve experiment for this project: {exc}") from exc
    if str(run.get("experiment_id")) != str(exp_id):
        raise _friendly(
            400,
            "That experiment run does not belong to this project.",
            f"Register models only from runs under experiment '{experiment_name}'.",
        )
    name = (
        body.model_name
        if body.model_name.startswith(f"project-{project_id}-")
        else f"project-{project_id}-{body.model_name}"
    )
    try:
        return mlflow_service.register_model(body.run_id, name, body.artifact_path)
    except Exception as exc:
        raise _friendly(
            400,
            f"Could not register model: {exc}",
            "Ensure the run finished and logged a 'model' artifact.",
        ) from exc


@router.get("/projects/{project_id}/models")
def list_models(project_id: int, db: Session = Depends(get_db)):
    _get_project(db, project_id)
    return mlflow_service.list_registered_models(prefix=f"project-{project_id}-")


@router.get("/models/{model_name}/versions/{version}")
def model_version(model_name: str, version: str):
    try:
        return mlflow_service.get_model_version(model_name, version)
    except Exception as exc:
        raise _friendly(404, f"Model version not found: {model_name} v{version}", str(exc)) from exc


@router.get("/projects/{project_id}/endpoints", response_model=list[EndpointOut])
def list_endpoints(project_id: int, db: Session = Depends(get_db)):
    _get_project(db, project_id)
    return db.scalars(select(Endpoint).where(Endpoint.project_id == project_id).order_by(Endpoint.id.desc())).all()


@router.post("/projects/{project_id}/endpoints", response_model=EndpointOut, status_code=201)
def create_endpoint(project_id: int, body: EndpointCreate, db: Session = Depends(get_db)):
    _get_project(db, project_id)
    expected_prefix = f"project-{project_id}-"
    if not body.model_name.startswith(expected_prefix):
        raise _friendly(
            400,
            "That model does not belong to this project.",
            f"Model names for this project must start with '{expected_prefix}'.",
        )
    try:
        mlflow_service.get_model_version(body.model_name, body.model_version)
    except Exception as exc:
        raise _friendly(
            400,
            f"Unknown model version: {body.model_name} v{body.model_version}",
            str(exc),
        ) from exc
    uri = f"models:/{body.model_name}/{body.model_version}"
    try:
        inference.load_model(uri)
    except Exception as exc:
        raise _friendly(
            400,
            "The model could not be loaded for inference.",
            "Confirm the registered version has a valid model artifact, then try again.",
        ) from exc
    ep = Endpoint(
        project_id=project_id,
        name=body.name,
        model_name=body.model_name,
        model_version=body.model_version,
        model_uri=uri,
        status="ready",
    )
    db.add(ep)
    db.commit()
    db.refresh(ep)
    return ep


@router.get("/endpoints/{endpoint_id}", response_model=EndpointOut)
def get_endpoint(endpoint_id: int, db: Session = Depends(get_db)):
    ep = db.get(Endpoint, endpoint_id)
    if not ep:
        raise _friendly(404, f"Endpoint {endpoint_id} was not found.")
    return ep


@router.post("/endpoints/{endpoint_id}/predict", response_model=PredictResponse)
def predict(endpoint_id: int, body: PredictRequest, db: Session = Depends(get_db)):
    ep = db.get(Endpoint, endpoint_id)
    if not ep:
        raise _friendly(404, f"Endpoint {endpoint_id} was not found.")
    try:
        preds = inference.predict(ep.model_uri, body.instances, ep.feature_schema_json)
    except Exception as exc:
        raise _friendly(
            400,
            f"Prediction failed: {exc}",
            "Send numeric feature columns matching the training dataset (excluding the target).",
        ) from exc
    ep.request_count = (ep.request_count or 0) + 1
    db.commit()
    return PredictResponse(predictions=preds, model_uri=ep.model_uri)

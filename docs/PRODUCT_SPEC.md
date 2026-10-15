# ModelFlow Product Spec

Status: GA-candidate documentation under Phase 10. This is **not** a claim that
`v1.0.0` has been tagged or published.

## One-liner

**ModelFlow** — Self-hosted tabular MLOps platform for collaboration, data
governance, training, visual pipelines, model registry, serving, monitoring,
and closed-loop retrain with human approval for production.

## Problem

Teams need one self-hosted system to manage tabular classification/regression
from data ingestion through production inference — with auth, project isolation,
auditability, and operable deployment modes — without assembling MLflow, object
storage, queues, and UIs by hand.

## Goals

1. Bootstrap admin, login/logout, password change, user admin, RBAC, project membership; optional OIDC SSO.
2. Register managed file uploads and connectors (PostgreSQL, MySQL/MariaDB, Microsoft SQL Server, Oracle, REST); encrypt connection secrets.
3. Manage datasets as immutable versions with profiling, quality rules, splits, and lineage; visual multi-dataset preparation where shipped.
4. Run classification and regression training jobs (including time-aware / forecasting support actually shipped) with MLflow tracking.
5. Design, validate, publish, and execute visual ML pipelines (DAG worker engine); optional LLM Pipeline Copilot assist where enabled.
6. Operate Model Registry with evaluation gates and approval workflow (candidate → production).
7. Serve realtime endpoints and batch inference via a dedicated internal `inference-runtime`; schema validation and metrics on the control plane.
8. Monitor service/data/model health; detect drift; closed-loop quality/feedback/retrain that never auto-promotes to PRODUCTION.
9. Scheduling/automation for imports, batch prediction, and pipeline runs.
10. In-app alerts, audit logs, admin retention/settings, backup/restore scripts.
11. Deploy with Docker Compose (local/self-hosted) and/or Helm/Kubernetes (replicated stateless services with external durable state).
12. GitHub Actions verification: PR Fast Gate on pull requests; Full `./scripts/verify.sh` gate on `main` / `workflow_dispatch`.

## Non-goals

- Multi-cluster orchestration
- LDAP directory integration (OIDC is optional; LDAP is not)
- GPU / distributed training productization (GPU worker profiles are routing-only)
- Vision / audio / LLM-specialized training productization
- Arbitrary unrestricted user code execution
- Full AutoML
- Automatic PRODUCTION promotion or deploy without human approval
- Managed multi-cloud auto-deploy
- Claiming HA from a single embedded PostgreSQL/MinIO instance (Kubernetes HA requires operator-managed external Postgres and S3-compatible object storage)
- Replacing Airflow/Prefect as a general workflow product

Interfaces remain replaceable for future runners, identity providers, and orchestrators.

## Primary users

| Role | Intent |
|------|--------|
| SYSTEM_ADMIN | Users, system health, retention, audit |
| PROJECT_ADMIN | Project members, data, models, deployments |
| ML_ENGINEER | Pipelines, training, registry, serving |
| DATA_SCIENTIST | Datasets, experiments, training |
| VIEWER | Read-only |

## Core entities

| Entity | Description |
|--------|-------------|
| User / Role | Authenticated principal; system or project role |
| Project / Membership | Isolation boundary for all project resources |
| DataSource | File or connector-backed source (Postgres, MySQL/MariaDB, MSSQL, Oracle, REST); secrets encrypted |
| Dataset / DatasetVersion | Immutable versioned tabular asset in object storage |
| QualityRule / QualityCheck | Data quality policy + run history |
| DatasetSplit | Train/val/test split with seed + ratios |
| TrainingJob / ExperimentRun | Async train + MLflow-linked run metadata |
| Pipeline / PipelineVersion / PipelineRun | Visual DAG definition + execution |
| ModelVersion | Registry entry with lifecycle state + gates |
| Endpoint | Realtime inference binding to a model version (execution via inference-runtime) |
| BatchInferenceJob | Offline prediction over a dataset version |
| DriftRun / Alert / AuditLog | Monitoring, notifications, governance |
| AutomationSchedule | Cron/timezone schedules for import, batch, and pipeline work |

## Required end-to-end flows

1. **Admin & access:** bootstrap → create user → project → membership → login (local and/or OIDC) → project-scoped access.
2. **Data:** connector or upload → version → stats → quality → split / preparation as applicable.
3. **Train:** job → worker → MLflow metrics/artifacts → compare runs.
4. **Pipeline:** design → publish → run → registry step.
5. **Approve & serve:** approve → endpoint → predict (via inference-runtime) → version change → rollback.
6. **Monitor:** traffic → metrics → drift / quality → alert → retrain request (approval required for prod).
7. **Batch:** dataset → batch job → artifact download.
8. **Schedule:** enable automation → history / run-now without auto-PRODUCTION.
9. **Clean install:** empty volumes → migrate → bootstrap → healthy → core E2E (Compose); or Helm with external durable state for replicated deploys.

## Success metric (GA candidate)

Clean Compose volumes + `./scripts/verify.sh` PASS on the release tip, acceptance criteria refreshed for the tip (Phase 10-C), GitHub Actions Full verification gate green on the packaging SHA before tag (Phase 10-D), README-only Compose install works, and GA release documentation matches the tagged tip. Phase 10 tracks readiness; it does not by itself publish `v1.0.0`.

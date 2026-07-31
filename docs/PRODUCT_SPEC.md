# ModelFlow Product Spec (v1.0 RC)

## One-liner

**ModelFlow** — Self-hosted general-purpose tabular MLOps platform for collaboration, data governance, training, visual pipelines, model registry, serving, monitoring, and drift-driven retrain.

## Problem

Teams need one self-hosted system to manage tabular classification/regression from data ingestion through production inference — with auth, project isolation, auditability, and Compose-based operations — without assembling MLflow, object storage, queues, and UIs by hand.

## Goals (v1.0)

1. Bootstrap admin, login/logout, password change, user admin, RBAC, project membership.
2. Register file (CSV/JSON/Parquet) and PostgreSQL data sources; encrypt connection secrets.
3. Manage datasets as immutable versions with profiling, quality rules, splits, and lineage.
4. Run classification and regression training jobs with rich preprocessing and MLflow tracking.
5. Design, validate, publish, and execute visual ML pipelines (DAG worker engine).
6. Operate Model Registry with evaluation gates and approval workflow (candidate → production).
7. Serve realtime endpoints and batch inference with schema validation and metrics.
8. Monitor service/data/model health; detect drift; trigger retrain without auto-promoting to production.
9. In-app alerts, audit logs, admin retention/settings, backup/restore scripts.
10. Docker Compose self-host + GitHub Actions full verification gate.

## Non-goals (v1.0)

- Kubernetes / multi-cluster
- GPU distributed training
- Vision / audio / LLM-specialized training
- SSO / LDAP
- Multi-cloud auto-deploy
- HA clustering
- Usage-based billing
- Arbitrary unrestricted user code execution
- Full AutoML
- Automatic deploy to production servers outside Compose

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
| DataSource | File or Postgres connection (secrets encrypted) |
| Dataset / DatasetVersion | Immutable versioned tabular asset in MinIO |
| QualityRule / QualityCheck | Data quality policy + run history |
| DatasetSplit | Train/val/test split with seed + ratios |
| TrainingJob / ExperimentRun | Async train + MLflow-linked run metadata |
| Pipeline / PipelineVersion / PipelineRun | Visual DAG definition + execution |
| ModelVersion | Registry entry with lifecycle state + gates |
| Endpoint | Realtime inference binding to a model version |
| BatchInferenceJob | Offline prediction over a dataset version |
| DriftRun / Alert / AuditLog | Monitoring, notifications, governance |

## Required end-to-end flows

1. **Admin & access:** bootstrap → create user → project → membership → login → project-scoped access.
2. **Data:** source or upload → version → stats → quality → split.
3. **Train:** job → worker → MLflow metrics/artifacts → compare runs.
4. **Pipeline:** design → publish → run → registry step.
5. **Approve & serve:** approve → endpoint → predict → version change → rollback.
6. **Monitor:** traffic → metrics → drift → alert → retrain request (approval required for prod).
7. **Batch:** dataset → batch job → artifact download.
8. **Clean install:** empty volumes → migrate → bootstrap → healthy → core E2E.

## Success metric for v1.0 RC

Clean Compose volumes + `./scripts/verify.sh` PASS, all Acceptance Criteria PASS, GitHub Actions Full verification gate green, README-only install works, evidence (screenshots/video) attached to Draft PR.

# ModelFlow Product Spec (MVP)

## One-liner

**ModelFlow** — End-to-End MLOps Platform for local/self-hosted experiment tracking, training, registry, and inference.

## Problem

Teams need a single place to upload tabular data, train a model, track experiments, register versions, and call a local inference endpoint — without assembling MLflow, object storage, and APIs by hand.

## Goals (MVP)

1. Create projects and upload CSV datasets.
2. Inspect dataset columns and basic statistics.
3. Create and run asynchronous training jobs (scikit-learn).
4. Record runs in MLflow (params, metrics, artifacts).
5. Register models in MLflow Model Registry and list versions.
6. Create a local inference endpoint and run sample predictions.
7. Provide a task-oriented UI (no Kubernetes jargon on primary screens).

## Non-goals (MVP)

- Apache Airflow / complex orchestration
- Multi-tenant auth / SSO
- GPU training
- Streaming / online feature store
- Production deployment to cloud Kubernetes
- Paid external SaaS dependencies

## Primary users

- ML engineers and data scientists running experiments locally or on a shared Compose stack
- Cloud agents verifying the full MLOps loop

## Core entities

| Entity | Description |
|--------|-------------|
| Project | Workspace container for datasets, jobs, runs, models, endpoints |
| Dataset | Uploaded CSV stored in MinIO; metadata + column stats in Postgres |
| TrainingJob | Async job definition + status/logs |
| ExperimentRun | Mirror/link to an MLflow run |
| RegisteredModel | MLflow Model Registry entry |
| Endpoint | Local HTTP inference target bound to a model version |

## Required user flow

Project create → CSV upload → column stats → training job → sklearn train → status/logs → MLflow run → params/metrics/artifacts → registry → versions → inference endpoint → sample predict → result.

## Success metric for MVP

A clean Compose environment can complete the flow above with real Postgres, MLflow, MinIO, and scikit-learn — verified by automated tests and `scripts/verify.sh`.

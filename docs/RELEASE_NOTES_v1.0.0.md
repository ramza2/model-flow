# ModelFlow v1.0.0

ModelFlow v1.0.0 is the first GA release of the self-hosted tabular MLOps
platform delivered through the MVP/RC baseline and Enhancement Phases 1–9.

- **Git tag:** `v1.0.0`
- **GitHub Release:** [ModelFlow v1.0.0](https://github.com/ramza2/model-flow/releases/tag/v1.0.0)
- **Release commit:** `78abe33bf1ef8e153fc1dc108575e1f06ecdbad0`
- **Release verification:** CI #521 / run `38708716981` — Full verification gate **SUCCESS** on the exact release commit

## Highlights

- End-to-end dataset → training → experiment → registry → serving → monitoring lifecycle
- Visual pipelines with scheduling / automation and auditable execution
- Multi-dataset visual preparation, reshape, aggregation, and materialized lineage
- Data connectors for PostgreSQL, MySQL / MariaDB, Microsoft SQL Server, Oracle, and REST APIs
- Closed-loop quality, feedback materialization, and retraining with human approval boundaries
- Continued training for supported incremental estimators
- Time-aware training, lag / rolling preparation, and direct multi-step forecasting
- LLM Pipeline Copilot with proposal, preview, validation, confirmation, and safe apply boundaries
- Dedicated internal `inference-runtime` for realtime and batch model execution
- Multi-worker execution with safe work claiming, runner profiles, heartbeats, and scheduler leadership
- Optional OIDC Authorization Code + PKCE SSO
- Vendor-neutral `*_FILE` external secret loading
- Helm / Kubernetes deployment for replicated stateless ModelFlow services
- Phase 9 product-wide visual, accessibility, responsive, and browser-regression closeout

## Safety and governance invariants

- Automation and closed-loop retraining never auto-promote a model to **PRODUCTION**.
- Registry approval remains an explicit governed action.
- Pipeline Copilot produces ModelFlow pipeline proposals / graph changes only; it does
  not execute arbitrary code, auto-save, auto-publish, or auto-run pipelines.
- The `inference-runtime` is an internal service boundary, not a public serving mesh.
- Project isolation, RBAC, audit logging, secret masking, and server-side model gates
  remain authoritative.

## Deployment

ModelFlow continues to support Docker Compose for local and self-hosted deployments.

Helm / Kubernetes supports replicated **stateless** application services. Real high
availability depends on operator-managed external PostgreSQL and S3-compatible object
storage; replica counts do not make embedded single-node state highly available.

See:

- [Kubernetes / Helm deployment](./DEPLOYMENT_KUBERNETES.md)
- [Known limitations](./KNOWN_LIMITATIONS.md)

## Known limitations

Major accepted v1.0 boundaries include:

- sklearn / tabular training focus
- no GPU / distributed training productization
- no LDAP integration (optional OIDC SSO is supported)
- DB-worker DAG execution rather than Airflow / Prefect
- no automatic PRODUCTION promotion
- external durable state required for Kubernetes HA

The complete current list is maintained in
[KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md).

## Verification and release evidence

The final packaging commit
`78abe33bf1ef8e153fc1dc108575e1f06ecdbad0` passed the `main` Full verification
gate in **CI #521** / run `38708716981`. Only after that SUCCESS result was the
annotated `v1.0.0` tag created on the same commit and the GitHub GA Release
published.

This file on `main` records the post-release closeout state; the immutable release
tag continues to identify the verified release commit above.

## Historical release

The previous published pre-release remains
[ModelFlow v1.0.0-rc.1](./RELEASE_NOTES_v1.0.0-rc.1.md).

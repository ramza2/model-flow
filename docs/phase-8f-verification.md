# Phase 8-F — Final Hardening / Scale Regression Verification

Phase 8-F closes the Enterprise / Scale phase with regression evidence. It does
not add new product features or pull Phase 9 visual redesign into Phase 8.

## Baseline

- Phase 8-E squash merge: `main@a6f31e65527f1271410edd02bc1d094f1ddd57c7`
- Phase 8-E exact-head CI: #460 PASS
- Phase 8-E post-merge main CI: #461 PASS
- Alembic head: `024_oidc_enterprise_identity`
- Phase 8-F PR: #86 (merged)
- No ModelFlow database migration is introduced by 8-F.

## Acceptance matrix

| Phase 8-F requirement | Regression evidence |
|---|---|
| Multi-replica inference consistency / failure recovery | `backend/tests/test_inference_runtime.py`, `backend/tests/test_inference_runtime_endpoints.py`; 8-F adds transient runtime failure followed by successful next-request recovery while preserving endpoint counters/statistics. Full verify additionally scales Compose `inference-runtime` to two healthy replicas, sends the same registered model/input directly to each replica, requires identical prediction JSON, then scales back to one healthy replica. |
| Multi-worker no-double-claim | `backend/tests/test_worker_scaleout_postgres.py::test_skip_locked_no_double_claim_generic_path`; `scripts/verify-worker-scale.sh` scales Compose workers and validates distinct healthy heartbeats. |
| Scheduler singleton | PostgreSQL advisory-lock regressions in `test_worker_scaleout_postgres.py`, plus non-Postgres helper coverage in `test_worker_leadership.py`. |
| Runner profile fail-closed routing | `backend/tests/test_runner_profiles.py`; general/GPU cross-claim and unknown profile cases fail closed. |
| OIDC happy/failure/token/local break-glass | `backend/tests/test_oidc.py` covers PKCE, issuer/audience/azp/signature, replay/failure, JIT and local-login/bootstrap regression; `test_oidc_postgres.py` covers concurrent one-time state/exchange claims. |
| Secret redaction / file precedence | `backend/tests/test_config.py` and `test_runtime_secrets.py`; file-over-env precedence, fail-closed reads, Pydantic redaction/serialization, and MLflow/boto3 credential bridge. |
| Migration / multi-backend startup safety | `backend/tests/test_bootstrap_admin.py` covers concurrent bootstrap unique-email race; `scripts/test-kubernetes-helm.sh` covers dedicated ModelFlow Alembic and MLflow migration hook Jobs. |
| Kubernetes render / HA boundaries | `scripts/test-kubernetes-helm.sh`; Helm lint/render, PDBs, probes, GPU resources, service-scoped secrets, external-state boundary, frontend-only Ingress, and no default NodePort/LoadBalancer. |
| Internal-service network/auth boundary | `test_inference_runtime.py` validates service token auth and sanitized failures. 8-F full verify additionally proves `inference-runtime` has no host-published port and rejects missing/wrong service tokens over the real Compose network. |
| Public API compatibility | `scripts/verify.sh` runs authenticated API release flow, training, registry lifecycle, realtime + external API-key inference, batch inference, drift/audit, pipeline execution, and backup/restore against the built stack. |
| Representative browser regression | `scripts/verify.sh` runs the repository Playwright suite in the official Playwright container, including authenticated navigation and product workflows. |
| Compose + Traefik regression | Compose config/host-port regressions, isolated full-stack startup, service health checks, worker scale-out, and the 8-F internal-runtime non-public-port assertion. |
| Full verification + exact PR HEAD CI | PR #86 is intentionally configured to run both the normal PR Fast Gate and the same `./scripts/verify.sh` Full verification gate on its exact head before merge. |

## New 8-F hardening

### Transient inference recovery

A runtime outage must fail the current public prediction cleanly without leaving
the Endpoint unusable. The next successful runtime response must succeed through
the same Endpoint and durable counters must show one failure followed by one
success.

### Multi-replica inference consistency

After the release-flow model is registered, full verification scales
`inference-runtime` from one to two Compose replicas. It resolves both container
IDs, waits for both health checks, sends the same model URI and input directly to
each authenticated runtime, and requires byte-equivalent normalized prediction
JSON. Verification then scales back to one replica and waits for health recovery.

### Compose internal runtime boundary

The full verification stack asserts:

- `inference-runtime:8080` is not published to a host port;
- backend can reach the runtime on the private Compose network;
- runtime readiness succeeds;
- model routes reject both missing and incorrect service tokens.

The real service credential is never written to verification artifacts.

### Kubernetes public exposure boundary

The Helm render gate renders Ingress independently and asserts that it references
the frontend Service only. Backend, inference runtime, MLflow, and worker
components must not appear in the Ingress, and default rendered Services must not
use `NodePort` or `LoadBalancer`.

## Completion rule

Phase 8 completion evidence:

1. PR #86 actual-diff final review: PASS / no blocker.
2. Exact PR HEAD Fast Gate: PASS.
3. Exact PR HEAD Full verification gate including `./scripts/verify.sh`: CI #472 PASS.
4. PR #86 squash-merged to `2669c996872df30a905b3e298740e3ffd36bac5e`.
5. Post-merge `main` Full verification gate: CI #473 PASS.

Phase 8 is complete and the roadmap advances to Phase 9.

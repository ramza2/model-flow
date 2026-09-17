# Phase 2-G Verification Coverage

Phase 2-G is a final hardening and end-to-end regression slice. It does not add a new Dataset Preparation feature.

## Reproducibility contract

ModelFlow keeps multi-dataset composition inside Dataset Preparation and materializes one rectangular immutable `DatasetVersion`. A `TrainingJob` consumes one exact `dataset_version_id`; it does not resolve the prepared Dataset to `latest` at training time.

The representative Phase 2-G regression covers:

`Source A(latest) + Source B(fixed) -> Join -> Filter -> Derived Column -> Group By -> Unpivot -> Pivot -> Output -> Parquet DatasetVersion`

It then proves:

1. Run 1 resolves exact source pins and materializes output V1.
2. Source A advances to A2 while Source B remains fixed at B1.
3. Run 2 resolves A2/B1 and materializes output V2.
4. V1 remains readable and unchanged after V2 exists.
5. The output Dataset reports V2 as latest.
6. A TrainingJob explicitly pinned to V1 still passes V1 bytes/version metadata to `TrainingRunner`.
7. No fallback from historical V1 to latest V2 occurs.

## Coverage matrix

| Contract | Coverage |
| --- | --- |
| Graph validation / source pinning | Existing Preparation tests + Phase 2-G golden path |
| Join / Union | Existing focused/full-run tests; golden path exercises Join |
| Select / Drop / Rename / Cast / Deduplicate / Fill Constant | Existing focused transform tests |
| Filter / Derived Column | Existing focused tests + golden path |
| Group By | Existing focused/materialization tests + golden path |
| Unpivot | Existing focused/materialization tests + golden path |
| Pivot | Existing focused/materialization tests + golden path |
| Preview sample boundary / Group By and Pivot warnings | Existing preview tests |
| Full Parquet materialization | Existing run tests + golden path |
| Source version pins | Existing pin tests + golden path Run 1/Run 2 assertions |
| Output Dataset version increment | Existing repeat-run tests + golden path V1/V2 |
| Historical output immutability | Phase 2-G golden path |
| Lineage | Existing lineage tests + golden path multi-source lineage |
| Historical `Train this result` | Existing `PreparationBuilder` regression |
| Dataset Detail exact-version Train link | Existing Phase 2-D frontend regression |
| JobCreate explicit exact-version handoff / no fallback | Existing Phase 2-D frontend/backend regression |
| TrainingJob exact `dataset_version_id` | Existing Phase 2-D test + golden path |
| TrainingRunner exact artifact | Existing Phase 2-D test + golden path with differing V1/V2 contents |
| Failure-no-partial | Existing Cast / Fill / Group By / Unpivot / Pivot run tests |
| RBAC / Viewer read-only | Existing Preparation backend/frontend regressions |

## Retained limitations

- Dataset Preparation execution remains Pandas in-memory; Spark/Dask/distributed/chunked execution is out of scope.
- The known Phase 2-C object-store atomicity limitation remains: if an artifact upload succeeds but the final DB transaction fails, an orphaned object may require later cleanup/reconciliation. Phase 2-G does not introduce a new GC/reconciliation subsystem.
- Training remains an explicit user action; a successful Preparation Run does not automatically start training.
- TrainingJob remains single-input: one `dataset_id` plus one exact `dataset_version_id`.

## Phase transition

Phase 2-A through Phase 2-F are complete on `main`. Phase 2-G is the current final hardening phase. Phase 2 is complete only after the Phase 2-G PR merges and the merge commit CI succeeds.

The planned next product phase is **Phase 3 — End-to-End Pipeline UX**.

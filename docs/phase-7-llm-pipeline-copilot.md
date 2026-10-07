# Phase 7 — LLM Pipeline Copilot

Phase 7 adds a natural-language path to ModelFlow Pipeline drafts and modifications. The LLM may propose a `PipelineGraph` (7-A/7-B) or allowlisted structured patch operations (7-C). A user-gated action may apply that proposal to the in-memory Builder. Copilot never automatically saves, publishes, runs, deploys, approves, or executes code. Explicit confirmation authorizes in-memory Apply only; Save, Publish, and Run remain the existing separate Builder actions.

## Slice boundary

| Slice | Scope | Status |
|-------|--------|--------|
| **7-A** | Copilot Backend Foundation — OpenAI-compatible client, draft endpoint, catalog, parse/canonicalize, `validate_graph`, project-reference checks, audit, backend tests | **complete** (PR #70; squash/main `e1927c5f72e0673a96b53a4cb4e2b5d2d422ed62`; post-merge CI #345 / run `36972237806` PASS; Alembic `023_forecasting_training`) |
| **7-B** | Builder Preview / Apply — Drawer UX, read-only visual preview, validation review, explicit confirmation, in-memory Apply | **complete** (PR #71; squash/main `b8e94f5ff87450f48c12add980bd243fe88ee3a8`; post-merge CI #350 / run `37392846125` attempt 2 PASS; Alembic `023_forecasting_training`) |
| **7-C** | Natural-language Graph Patch — modify an existing graph via structured patch (not free-form execution) | **complete** (PR #72; squash/main `0673366d2c67c11b2b1f84bf41ca7176b8cb17d1`; post-merge CI #353 / run `37409599810` SUCCESS; Alembic `023_forecasting_training`) |
| **7-D** | Final Hardening / Browser Regression — security contract regressions, stale-response E2E, docs closeout prep | **complete** (PR #73; final PR HEAD `a8084555779e2d68b0ffeec6ddcb668e6e5c0d12`; exact-head CI #355 PASS; squash/main `483db3859558570c499114ba774bf62b491234e1`; post-merge CI #356 / run `37555997629` SUCCESS; Alembic `023_forecasting_training`) |

```text
7-A Copilot Backend Foundation
    ↓
7-B Builder Preview / Apply
    ↓
7-C Natural-language Graph Patch
    ↓
7-D Final Hardening / Browser Regression
```

**Phase 7 = complete.**
**Phase 7-A = complete.**
**Phase 7-B = complete.**
**Phase 7-C = complete.**
**Phase 7-D = complete.**

Phase 7-B closeout note: CI #350 attempt 1 had a transient MySQL import E2E timeout; no code change; identical tree SHA `d64be8fc401aeb985d5da4ecb2fb87662df5301a` passed PR CI #349 and CI #350 attempt 2.

## Roadmap contract

```text
natural language → pipeline draft
pipeline schema validation against ModelFlow definitions
visual preview before apply
user confirmation gate
natural-language modification via graph patch
LLM generates ModelFlow Pipeline Definition only
no arbitrary code execution
```

## Central UX boundary

```text
Generate/Modify != Apply
Apply != Save
Save != Publish
Publish != Run
```

Copilot must never collapse these boundaries.

## Phase 7-A invariants (complete)

```text
LLM proposes only
no automatic save
no automatic publish
no automatic run
no code execution
existing validate_graph is authoritative
project IDs are validated server-side
no raw dataset rows are sent
provider credentials are server-owned
```

Endpoint: `POST /api/v1/projects/{project_id}/pipeline-copilot/draft` with `{ "prompt": "..." }` only.
Requires `PIPELINE_WRITE`. Response: `{ summary, graph, validation, warnings, model }`.

## Phase 7-B invariants (complete)

```text
Preview does not mutate Builder
Apply requires explicit confirmation
Apply is in-memory only
Apply marks dirty
no auto-save
no auto-publish
no auto-run
invalid draft cannot Apply
graph replacement only (draft path)
```

7-B UX:

1. Writer-only Copilot entry in the Builder Node library.
2. Existing `Drawer` hosts prompt → Generate → read-only ReactFlow preview → validation review.
3. Draft state is separate from live Builder `nodes` / `edges` / `dirty`.
4. Invalid drafts (`validation.valid === false`) are previewable but Apply is disabled.
5. Valid drafts require `Apply to builder` then in-Drawer `Confirm apply`.
6. Confirm Apply replaces the in-memory graph via existing `toStepNodes` / `toDisplayEdges`, sets `dirty=true`, clears live validation highlights, and does **not** call Save/Publish/Run APIs.
7. Closing the Drawer before Confirm discards preview state without mutating the Builder.
8. Stale in-flight responses are invalidated on close / newer Generate (`copilotRequestIdRef`).

## Phase 7-C invariants (complete)

```text
LLM returns allowlisted patch operations only
server applies patch
server-generated proposed graph is authoritative
current in-memory Builder graph is the base
patch Preview does not mutate Builder
Apply requires confirmation
Apply is in-memory only
no auto-save/publish/run/schedule
strict-invalid result cannot Apply
no arbitrary JSON Patch
no arbitrary code execution
```

Endpoint: `POST /api/v1/projects/{project_id}/pipeline-copilot/patch` with `{ "prompt", "current_graph" }` only.
Requires `PIPELINE_WRITE`. Stateless w.r.t. Pipeline persistence (audit only).

Allowed patch ops: `add_node`, `update_node`, `remove_node`, `add_edge`, `update_edge`, `remove_edge` (max 100).
`remove_node` deterministically removes incident edges. `update_node` config_patch shallow-merges.
Base graph may be strict-invalid; result must pass structural validation (`strict=False`) or return 502; strict/project-ref failures return HTTP 200 with `validation.valid=false`.

7-C UX:

1. Node library exposes `Draft new pipeline` and `Modify current pipeline`.
2. Patch mode sends the exact in-memory Builder graph (including unsaved edits).
3. Preview shows summary, operation list, read-only graph, validation, warnings.
4. Empty operations → no-op warning; Apply disabled; dirty unchanged.
5. Invalid result → Preview allowed; Apply disabled.
6. Valid non-empty patch → Apply changes → Confirm apply → in-memory replace + dirty.
7. Same stale-response protection as 7-B for draft and patch.

## Phase 7-D invariants (complete)

```text
hardening and browser regression only — no new Copilot features
user prompt and current-graph labels/config/resource text are untrusted
provider requests never enable tools/functions
API keys and provider secrets never appear in responses or audit bodies
Copilot Generate/Modify never mutates Pipeline / PipelineVersion / PipelineRun
stale draft/patch responses after close or newer Generate must not contaminate UI/Builder
502/503 failures leave live graph and dirty state unchanged
Preview → confirmation → in-memory Apply only
Generate/Modify != Apply != Save != Publish != Run
```

7-D adds focused security/contract regressions (especially patch prompt-injection) and high-value browser coverage for stale-response and failure boundaries. It does not invent new Copilot capabilities.

## Out of scope for 7-D

New Copilot features, multi-turn chat history, streaming, tool calling, MCP, RAG, embeddings, automatic save/publish/run/deploy, LLM settings UI, new node types, Phase 8 enterprise/scale work, and Phase 9 redesign remain outside the completed Phase 7 scope.

## Final status

```text
Phase 7-D: complete
Enhancement Phase 7: complete
Final Phase 7 implementation baseline:
main@483db3859558570c499114ba774bf62b491234e1

Post-merge main CI:
#356
run 37555997629
SUCCESS

Alembic:
023_forecasting_training

Next roadmap phase:
Phase 8 — Enterprise / Scale
```

See [`phase-7d-verification.md`](./phase-7d-verification.md).

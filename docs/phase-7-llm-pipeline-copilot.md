# Phase 7 — LLM Pipeline Copilot

Phase 7 adds a natural-language path to ModelFlow Pipeline drafts. The LLM may propose a `PipelineGraph`; it must never save, publish, run, deploy, approve, execute code, or mutate Pipeline state without an explicit user-gated Builder action.

## Slice boundary

| Slice | Scope | Status |
|-------|--------|--------|
| **7-A** | Copilot Backend Foundation — OpenAI-compatible client, draft endpoint, catalog, parse/canonicalize, `validate_graph`, project-reference checks, audit, backend tests | **complete** (PR #70; squash/main `e1927c5f72e0673a96b53a4cb4e2b5d2d422ed62`; post-merge CI #345 / run `36972237806` PASS; Alembic `023_forecasting_training`) |
| **7-B** | Builder Preview / Apply — Drawer UX, read-only visual preview, validation review, explicit confirmation, in-memory Apply | **current / Draft** |
| **7-C** | Natural-language Graph Patch — modify an existing graph via structured patch (not free-form execution) | planned |
| **7-D** | Final Hardening / Browser Regression — E2E hardening, docs closeout | planned |

```text
7-A Copilot Backend Foundation
    ↓
7-B Builder Preview / Apply
    ↓
7-C Natural-language Graph Patch
    ↓
7-D Final Hardening / Browser Regression
```

**Phase 7 = current.**
**Phase 7-A = complete.**
**Phase 7-B = current / Draft** (not marked complete in this feature PR).

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
Generate != Apply
Apply != Save
Save != Publish
Publish != Run
```

No step may collapse these boundaries.

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

## Phase 7-B invariants (current / Draft)

```text
Preview does not mutate Builder
Apply requires explicit confirmation
Apply is in-memory only
Apply marks dirty
no auto-save
no auto-publish
no auto-run
invalid draft cannot Apply
graph replacement only
no graph patch yet
```

7-B UX:

1. Writer-only Copilot entry in the Builder Node library.
2. Existing `Drawer` hosts prompt → Generate → read-only ReactFlow preview → validation review.
3. Draft state is separate from live Builder `nodes` / `edges` / `dirty`.
4. Invalid drafts (`validation.valid === false`) are previewable but Apply is disabled.
5. Valid drafts require `Apply to builder` then in-Drawer `Confirm apply`.
6. Confirm Apply replaces the in-memory graph via existing `toStepNodes` / `toDisplayEdges`, sets `dirty=true`, clears live validation highlights, and does **not** call Save/Publish/Run APIs.
7. Closing the Drawer before Confirm discards preview state without mutating the Builder.

## Out of scope for 7-B

Natural-language editing of an existing graph, `current_graph` in the request, graph merge/diff/patch, chat history, streaming, tool calling, auto-save/publish/run/deploy, LLM settings UI, new node types, backend changes, Phase 8/9 work.

## Next slice (7-C)

Natural-language Graph Patch: accept a base graph and produce structured patch operations for modification (still with preview + confirmation; still no auto-run/publish/deploy).

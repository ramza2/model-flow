# Phase 7 — LLM Pipeline Copilot

Phase 7 adds a natural-language path to ModelFlow Pipeline drafts. The LLM may propose a `PipelineGraph`; it must never save, publish, run, deploy, approve, execute code, or mutate Pipeline state.

## Slice boundary

| Slice | Scope | Status |
|-------|--------|--------|
| **7-A** | Copilot Backend Foundation — OpenAI-compatible client, draft endpoint, catalog, parse/canonicalize, `validate_graph`, project-reference checks, audit, backend tests | **current / Draft** |
| **7-B** | Builder Preview / Apply — visual preview, confirmation gate, apply into Builder (still user-gated; no auto-run) | planned |
| **7-C** | Natural-language Graph Patch — modify an existing graph via structured patch (not free-form execution) | planned |
| **7-D** | Final Hardening / Browser Regression — E2E, hardening, docs closeout | planned |

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
**Phase 7-A = current / Draft** (not marked complete in this feature PR).

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

## Phase 7-A invariants

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

Additional 7-A boundaries:

- Endpoint is **stateless** with respect to Pipeline state (allowed side effect: normal audit logging only).
- Must not create or modify `Pipeline`, `PipelineVersion`, `PipelineRun`, `TrainingJob`, `ModelVersion`, `Endpoint`, `Dataset`, `DatasetVersion`, or `AutomationSchedule`.
- Copilot generation must not call `_save_version()`, `save_graph`, `publish_pipeline`, `run_pipeline`, pipeline-engine execution, or job factories.
- No frontend / Playwright / Builder UI in 7-A.
- No `current_graph` / patch / JSON Patch input in 7-A (that is 7-C).
- No new Pipeline node types.
- No new Python dependency; reuse existing `httpx`.
- Alembic head remains `023_forecasting_training` (no migration).

## LLM configuration (OpenAI-compatible)

Server-owned settings (backend only; optional in Compose/CI):

| Setting | Env | Default |
|---------|-----|---------|
| `llm_base_url` | `MODELFLOW_LLM_BASE_URL` | `""` |
| `llm_api_key` | `MODELFLOW_LLM_API_KEY` | `""` |
| `llm_model` | `MODELFLOW_LLM_MODEL` | `""` |
| `llm_timeout_seconds` | `MODELFLOW_LLM_TIMEOUT_SECONDS` | `60` |

Empty `base_url` or `model` means Copilot is not configured → HTTP 503.

URL resolution tolerates bases ending in `/`, `/v1`, or `/v1/chat/completions` and always targets chat completions. Optional API key becomes `Authorization: Bearer …` only when non-empty. Temperature is fixed at `0`. Request clients cannot override base URL, API key, model, system prompt, or temperature.

Provider-neutral: do not hardcode vendor URLs, model names, or company hostnames.

## API

```text
POST /api/v1/projects/{project_id}/pipeline-copilot/draft
Permission: PIPELINE_WRITE
```

Request:

```json
{ "prompt": "..." }
```

(`extra` forbidden; trimmed non-empty; max 4000 characters.)

Response (shape):

```json
{
  "summary": "...",
  "graph": { "nodes": [], "edges": [] },
  "validation": { "valid": true, "errors": [], "order": [] },
  "warnings": [],
  "model": "configured-model"
}
```

Never returns system prompt, provider URL, API key, or raw provider HTTP bodies.

## Validation pipeline

1. **Canonical shape** — reject invalid top-level shape, non-array nodes/edges, oversize graphs (max 50 nodes / 100 edges), unsupported types, duplicate/missing ids.
2. **Structural** — `validate_graph(graph, strict=False)`; failure → provider contract error (502), not an applicable draft.
3. **Strict + project refs** — `validate_graph(graph, strict=True)` plus project-scoped checks for `dataset_load`, `batch_prediction`, `quality_check` (and existing gate-policy helper). Config/ref errors may return `validation.valid = false` without saving.

No silent “repair” to latest resources or substitute algorithms.

## Project catalog

Bounded, non-secret authoring metadata only:

- Datasets: id, name, exact latest `dataset_version_id`, version number, column names, dtypes (no preview rows, stats samples, object keys, DSNs, secrets).
- Quality rules: id, name, dataset_id, block_training_on_fail, active.
- Algorithms: reuse `list_algorithms()` metadata only.

## Audit

Action: `pipeline.copilot.draft`

May include: `project_id`, configured model name, `node_count`, `edge_count`, `validation_valid`.

Must not include: API key, raw user prompt, raw LLM response, system prompt, Authorization headers. Audit must not persist the graph as a `PipelineVersion`.

## Error semantics

| Case | Status |
|------|--------|
| Copilot not configured | 503 |
| Upstream / malformed provider output / contract failure | 502 |
| Provider timeout | 504 |

## Out of scope for 7-A

Frontend Copilot UI, visual preview, Apply, confirmation dialog, auto-save/publish/run/deploy, graph patch, conversation history, Copilot DB tables, streaming, tool/function calling, agents, MCP, RAG, embeddings, arbitrary code/SQL execution, new node types, Phase 8/9 work.

## Next slice (7-B)

Builder Preview / Apply: present the draft graph visually, require an explicit user confirmation gate, and apply into the Builder editor without auto-run/publish/deploy.

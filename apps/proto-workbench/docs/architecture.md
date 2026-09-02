# Architecture

## Trust boundaries

```text
Sandboxed React renderer
        |
        | typed contextBridge API
        v
Electron main process ---- SQLite under %APPDATA%/Proto Workbench
        |       |
        |       +---- proto-agent MCP sidecar (structured JSON-RPC tools)
        |
        +------------ LM Studio API on http://127.0.0.1:1234
                         |                    |
                         | native v1          +---- OpenAI-compatible SSE
                         | discover/load/           /v1/chat/completions
                         | unload
                         v
                    LM Studio-owned model catalog and instances
```

LM Studio is an explicit external-process trust boundary. The origin is compiled
as the exact HTTP loopback URL `http://127.0.0.1:1234`; it cannot be replaced by
settings, redirects, a model path, or a renderer argument. Workbench neither
walks the model filesystem nor spawns a model server.

Optional API authentication comes only from `LMSTUDIO_API_KEY`, with
`LM_API_TOKEN` as the compatibility fallback. Credential values are resolved in
the Electron main process on every request and are not persisted, serialized,
logged, or exposed through IPC. Catalog and error bodies, identifiers, arrays,
and SSE frames have explicit size and type bounds. Redirects fail closed.

Native `GET /api/v1/models` is authoritative for capabilities and instance
residency. `POST /api/v1/models/load` is always explicit and its returned
`instance_id` must appear in a subsequent catalog synchronization. An existing
instance can be attached only after the user selects its exact identifier. Such
an attachment is non-owned. `POST /api/v1/models/unload` is issued only for an
exact instance created by this Workbench process; external instances are only
disconnected locally.

LM Studio does not expose a model-file content digest in this catalog. The
Workbench `fingerprint` is therefore a SHA-256 digest of bounded provider
metadata (key, size, format, quantization, context, variant, and capabilities),
not an attestation of weight bytes. The descriptor labels that source explicitly;
review evidence must not reinterpret it as a content hash.

## Agent turn

Each turn is recorded as Goal, Plan, Design, Validate, and Review events. Tool
arguments are validated with JSON Schema. Read-only workspace tools and
deterministic Proto checks may run automatically; patch application, PubMed,
Python/Jupyter/R execution, and other side effects require explicit approval.

The model never receives a shell tool. Workspace writes are represented as
`PatchProposal` records with base hashes and path-containment checks. Applying an
approved `.proto` patch automatically schedules `proto_check`, the captured
workflow, and a review packet.

## Startup reconciliation

The main process opens SQLite before exposing the renderer API. In one
transaction it invalidates pending approvals from the previous process and marks
active ledger events `interrupted` or `effect-unknown` without replaying them.
Indexed SQLite identity is authoritative over legacy JSON payload identity, and
malformed active events or approvals are quarantined rather than blocking the
recovery UI. A separate system event records the
reconciliation so the run history stays explainable and the Launchpad can report
the recovered counts. Startup reconciliation is idempotent: a second launch does
not append another recovery event for an already closed run.

Readiness is derived from verified module integrity, workspace indexing, runtime
availability, and a model connected to an exact loaded LM Studio instance.
Discovery is intentionally not equivalent to activation. Both the renderer and
the main-process agent preflight enforce that distinction.

## Model residency

Model load uses the documented native controls for context length, evaluation
batch size, Flash Attention, MoE expert count, and KV-cache placement. The old
Workbench-local GPU-layer estimator and OOM retry path are not used for LM Studio
models because LM Studio owns allocation and engine selection.

Immediately before each OpenAI-compatible chat request, Workbench re-reads
`loaded_instances` and requires its bound identifier to remain present. It never
sends a catalog model key as an implicit load fallback. LM Studio's global JIT
switch is not exposed by its documented server API, so operators must disable it
in Developer > Server Settings to eliminate the residual external check-to-use
race; Workbench cannot claim to verify that application-level setting.

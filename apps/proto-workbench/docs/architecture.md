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
        +------------ upstream llama-server.exe on 127.0.0.1:<bounded-random>
                              |
                              +---- read-only GGUF weights
                                   %USERPROFILE%\.lmstudio\models
```

LM Studio is not a process dependency or an integration boundary. The only shared
resource is the GGUF file tree selected by the user.

The main process selects a random dynamic-port candidate without pre-binding it;
the owned `llama-server.exe` binds that loopback port directly. The main process
contacts it only after the pinned runtime's post-bind, pre-model-metadata startup
record. Bind conflicts get at most four clean attempts. Authentication uses a
per-launch bearer key read from a short-lived restricted file rather than a
literal command-line argument. Readiness uses the public `/health` endpoint and
never discloses that bearer key.

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
availability, and a model whose load state is active. Discovery is intentionally
not equivalent to activation. Both the renderer and the main-process agent
preflight enforce that distinction.

## Model residency

Quick switch keeps one model resident. Auto-evict can keep active and warm models
within the configured VRAM budget, evicting unpinned warm LRU entries first and
applying a 30-minute TTL. OOM handling evicts eligible models and retries once at
half context with Q8 KV cache; CPU fallback and pinned eviction are never silent.

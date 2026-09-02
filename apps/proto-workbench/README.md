# Proto Workbench

## Offline verification

Run `node scripts/verify-offline.mjs` from this directory for the repository-native offline baseline. The entrypoint never launches pnpm/npm/npx, checks that the installed TypeScript compiler exactly matches the lockfile and declared dependency floor, runs the complete Node test set plus typecheck, permits loopback-only test fixtures, and blocks external Node DNS/socket access. Invoke the Node entrypoint directly; package-manager wrappers may perform their own update or registry checks before a package script starts.

Proto Workbench is an independent Windows desktop workbench for local GGUF models
and auditable Proto design runs. It shares only the user's model weights under
`%USERPROFILE%\.lmstudio\models` by default; it does not call LM Studio's GUI, daemon, CLI,
API, configuration, extensions, or runtime.

## Process boundaries

- Electron main process owns files, SQLite, approvals, model processes, and MCP.
- The sandboxed renderer receives only the typed preload API.
- Upstream `llama-server.exe` listens on a random loopback port with a per-session
  token and is never exposed as a LAN service.
- Models can propose patches but cannot write them. Every write is a separate
  human approval, followed by the Proto check/workflow/review sequence for
  `.proto` files.

## Startup and first run

The desktop opens through a live Launchpad rather than assuming that discovery
means readiness. Core-module integrity, an indexed workspace, the trusted
runtime, and an explicitly loaded model must all be ready before Plan or Act can
start. Model discovery never starts a model process; the user reviews the memory
estimate and loads a model from the Models surface.

On startup, unfinished ledger events are reconciled to `interrupted`, or to
`effect-unknown` when a tool side effect may already have occurred, and pending
approvals are invalidated. The app never replays a write,
network call, or code-execution side effect after a restart. The Launchpad shows
how many events and approvals were recovered and provides direct repair actions.
If a send fails, the renderer restores the goal draft and attachments instead of
leaving a renderer-only message.

## Run evidence and task forks

The Runs workspace exposes a synchronized Timeline, Topology, and Artifacts
explorer. Run-event revisions are appended to a per-run SQLite ledger with stable
sequence numbers and a validated SHA-256 chain; the mutable `run_events` table is
only the current projection. This provides local integrity diagnostics and
recovery evidence, not deterministic replay, exactly-once external effects, or a
tamper-proof audit service.

Task checkpoints are immutable snapshots of a bounded conversation prefix and
its recorded history head. Forking one creates a child task with fresh message
IDs and does not call a model, restore files, copy approvals, or repeat tools.
Patch file checkpoints remain a separate legacy recovery/audit mechanism and can
only prepare a new reviewable restore diff; they are never treated as task forks.

## Local development

Use Node.js 24 and pnpm 11.19.0, then install the locked dependency tree:

```powershell
pnpm install --frozen-lockfile
node scripts/verify-offline.mjs
pnpm dev:desktop
```

The offline verifier runs the full Node test set and TypeScript check with
Node-level external DNS/socket guards. It is not an OS-level network sandbox.

The renderer-only preview is built with `pnpm build` and served with
`pnpm preview`. In a browser-only preview, the app uses realistic local mock data;
the Electron build replaces it with typed IPC.

## Packaging inputs

1. Build the Python catalog sidecar with `scripts/build-proto-sidecar.ps1`.
2. Stage reviewed upstream CUDA and CPU llama.cpp archives with
   `scripts/stage-llama-runtime.ps1`.
3. Run `pnpm package:win` to create NSIS and portable artifacts in `release/`.

The real-model packaged UI verifier defaults to
`%USERPROFILE%\.lmstudio\models`; set `PROTO_WORKBENCH_TEST_MODEL_ROOT` when the
reviewed test model lives elsewhere. That verifier starts owned model processes
and requires its explicit confirmation controls; it is not part of CI.

The packaged app is designed to run without Python, Node, LM Studio processes, or
network access once those runtime inputs are staged.

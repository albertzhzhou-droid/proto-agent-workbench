# Proto Workbench

## Offline verification

Run `node scripts/verify-offline.mjs` from this directory for the repository-native offline baseline. The entrypoint never launches pnpm/npm/npx, checks that the installed TypeScript compiler exactly matches the lockfile and declared dependency floor, runs the complete Node test set plus typecheck, permits loopback-only test fixtures, and blocks external Node DNS/socket access. Invoke the Node entrypoint directly; package-manager wrappers may perform their own update or registry checks before a package script starts.

Proto Workbench is a Windows desktop workbench for auditable Proto design runs.
All model discovery, residency, and inference go through the LM Studio server at
the one fixed loopback origin `http://127.0.0.1:1234`; Workbench no longer scans
LM Studio's model directory or starts a bundled `llama-server.exe`.

The main process uses LM Studio's native `GET /api/v1/models` catalog, including
`loaded_instances`, and the explicit native load/unload endpoints. Agent turns
use OpenAI-compatible `POST /v1/chat/completions` with bounded SSE parsing so the
existing custom-tool stream remains available. Authentication is optional: if
set, `LMSTUDIO_API_KEY` takes precedence over `LM_API_TOKEN`. Tokens are read
from the process environment for each request, never saved to SQLite or settings,
and never sent to the renderer.

## Process boundaries

- Electron main process owns files, SQLite, approvals, LM Studio API calls, and MCP.
- The sandboxed renderer receives only the typed preload API.
- LM Studio is a separately managed local process. Workbench contacts only the
  exact `127.0.0.1:1234` origin and does not start, stop, or reconfigure it.
- Discovery never attaches to a loaded model. A user must explicitly load a model
  or attach to an exact reported instance before Workbench can send a chat.
- Workbench records ownership only for instances returned by its own explicit
  load request. Disconnecting an externally loaded instance never unloads it;
  shutdown unloads only instances owned by the current Workbench process.
- Models can propose patches but cannot write them. Every write is a separate
  human approval, followed by the Proto check/workflow/review sequence for
  `.proto` files.

## Startup and first run

The desktop opens through a live Launchpad rather than assuming that discovery
means readiness. Core-module integrity, an indexed workspace, the trusted
LM Studio endpoint, and an explicitly connected loaded instance must all be ready
before Plan or Act can start. Discovery re-synchronizes `loaded_instances` but
never starts or attaches to a model. The same synchronization runs immediately
before every chat, and a stale or absent binding fails closed before inference.

Workbench never intentionally uses LM Studio's JIT loading path. For defense in
depth against another client changing residency between the preflight and the
chat request, disable **Just in Time Model Loading** in LM Studio's Developer >
Server Settings. Workbench cannot read or change that application-level switch.

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

Real LM Studio verification is deliberately gated and is not part of CI. It
requires an exact, initially unloaded LLM key no larger than 8 GiB plus matching
environment and final command-line confirmations:

```powershell
$env:PROTO_AGENT_ALLOW_REAL_MODEL_TESTS = "YES_LOAD_CHAT_UNLOAD_LM_STUDIO"
node --experimental-strip-types scripts/verify-inference.mjs "YOUR_EXACT_MODEL_KEY" --confirm-owned-execution=YES_LOAD_CHAT_UNLOAD_LM_STUDIO
```

The verifier performs native discovery, an explicit bounded load, a 16-token
SSE chat, and an exact owned-instance unload. It never auto-selects a model,
claims an already loaded instance, or prints completion text.

## Packaging inputs

1. Run `pnpm build:sidecars` to build only the packaged MCP server and bounded
   admin CLI from the repository `.venv`. The script verifies a same-volume
   staging tree before replacing the previous complete runtime.
2. Run `pnpm verify:sidecars` to copy the packaged workspace template into a
   disposable directory, exercise both binaries, require the 7/7 local adapter
   schema/vendor-neutrality/capability audit
   and Skill MCP tools, and confirm that the complete sidecar tree hashes remain
   unchanged. This does not fetch or independently attest upstream repositories.
3. Run `pnpm verify:workspace-template` when auditing an already-synchronized
   tree. `pnpm build:desktop` and `pnpm package:win` run the deterministic
   template sync automatically before generating the embedded SHA-256 module
   manifest; the manifest is integrity metadata, not a cryptographic signature
   or publisher identity.
4. Run `pnpm package:win` to rebuild and verify the two sidecars, then create
   NSIS and portable artifacts in `release/`.

The sync copies the root connector registry, review workflow, and complete
`.codex/skills` tree byte-for-byte into `runtime/workspace-template`, removes
stale Skill files, and verifies the exact path set plus SHA-256 digests. A source
change during synchronization fails the build rather than producing a mixed
template. Installed workspaces use a different, migration-safe rule: startup
copies only missing paths and never overwrites user changes. Operators can
review-copy updated managed files or create a fresh workspace to adopt the exact
latest template.

The packaged app does not contain a model runtime or the legacy model-scanner
sidecar. LM Studio and its local server must already be installed, running, and
configured by the operator. Python and Node are still unnecessary for the
packaged Workbench sidecars.

## License

Proto Workbench is open source under the repository's
[MIT License](../../LICENSE).

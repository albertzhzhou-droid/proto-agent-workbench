# Proto Workbench

The current source is a local scientific workspace organized around **Chat /
Design / Compute**, with Proto and Chemistry accessible from one application
selector. It combines local-model conversations, checked design source,
scientific operators, research documents and inspectable execution evidence.

| Surface | Current source capabilities |
| --- | --- |
| Chat | Research plans, PDF/DOCX/XLSX reading, versioned working documents and canonical tools shared with the scientific workspaces. |
| Design | Source-based DNA edits, governed materials, real protein structure inspection and the integrated Chem Design workspace. |
| Compute | Scientific operators, protein comparative studies, RNA-seq studies and saved artifacts that can be associated with research projects. |
| Execution and evidence | Workspace execution journal, receipt-bound facts, explicit evidence standing, Harness verification diagnostics and bounded repair. |

The package version remains `0.2.0-rc.1`; it does not identify all later source
changes. The published Portable and Setup preview is historical and does **not**
contain this entire source upgrade. Its 15-task local debug campaign and native
package checks are preserved in [the preview evidence](../../docs/upgrade-verification.md).
Current implementation and validation are recorded separately in
[the architecture upgrade](../../docs/ARCHITECTURE_UPGRADE_2026-09-23.md) and
[Harness Slice B](../../docs/HARNESS_ITERATION_IMPLEMENTATION_2026-09-23.md).

See [the unified Chat workflow](../../docs/chat-unified-workflow.md),
[research projects](../../docs/research-projects.md),
[protein comparisons](../../docs/protein-comparative-study.md),
[RNA-seq studies](../../docs/rnaseq-studies.md),
[execution contracts](../../docs/reliable-harness.md),
[DNA placement semantics](../../docs/dna-source-editing.md), and
[protein structures and exports](../../docs/protein-structures.md).
Use [isolated desktop sessions](../../docs/isolated-desktop-sessions.md) to keep a
separate profile and workspace, including when checking a Portable candidate.

## Chem CLI workspace

The far-left application selector switches between **Proto CLI** and **Chem CLI**.
Chem uses the shared Chat / Design / Compute navigation. Structure editing lives
inside Design, alongside the existing conditional interface models, inorganic
candidate tools, governed calculations and XDL document inspection. Its original
3D views, numerical results, evidence, imports, exports and approval workflows
are retained in the shared light/dark paper theme.

The integration includes a verified source snapshot of Chem. Running it requires
a configured Python environment; Psi4 calculations and XDL inspection require
their respective external environments. Those environments are not bundled by
including the source and UI. New work is stored under
the selected Proto workspace's `build/chem-workspace`. See
[Chem integration, runtime configuration, and acceptance](../../docs/chem-workbench-port.md)
for the preserved scope, migrated history, and actual calculation checks.

## Scientific Chat and research evidence

Chat uses the same computation and database implementations as the dedicated
workspaces. Module and skill selections apply to new messages. Saved research
projects connect conversations, datasets, computations and figure boards without
turning a model response into verified scientific evidence.

Source-bound document extracts retain page, paragraph, sheet or cell locations.
Receipt-bound facts keep their literal identities, values, units and artifact
digests; unsupported interpretations remain unreviewed. The workspace journal
records tool identity, policy, effect state and outcome. Unknown effects require
evidence-backed review before recovery can treat them as resolved.

General Python, R and Jupyter execution requires a configured rootless OCI
runtime. WSL bioinformatics engines are separately installed and probed. See
[execution deployment](../../docs/chat-execution-deployment.md),
[document reading](../../docs/chat-document-parsing.md),
[receipt-bound facts](../../docs/research-evidence.md) and
[bioinformatics environments](../../docs/bioinformatics-environment.md).

Harness Slice B adds typed verification diagnostics, task-wide repair allowances,
host-enforced tool preconditions and call caps, persisted negative-result memory,
and per-run diagnostic exports. Unsupported, stale or conflicting evidence can
stop a run for review rather than spending another repair. The paired software
fixture campaign recorded 24/24 possible tasks completed by the direct arm and
23/24 by Harness, with correct abstention on 5/6 and 6/6 impossible tasks
respectively. It does not demonstrate a completion or token-cost improvement.
See [the measured snapshot and limits](../../docs/HARNESS_ITERATION_IMPLEMENTATION_2026-09-23.md).

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
- Starting an Act mission authorizes its declared workspace scope and requested
  capabilities. The host applies in-scope model changes through recorded diffs,
  baseline checks, atomic writes, and validation. DNA changes carry the exact
  materialized library through check, workflow, provenance, and review. Plan
  missions cannot write. Scientific human review remains a separate boundary.

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
approvals are invalidated. Saved autonomous missions preserve their scope,
model binding, results, and consumed budget. Resume first reconciles durable
receipts and source/library hashes; unknown write effects cannot be replayed.
Committed source validation can continue from its journal without reapplying the
source. The Launchpad shows recovery state and explicit resume actions.
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

Use Node.js 24 and pnpm 11.19.0. First prepare the repository Python environment
and optional development extras using [the source setup](../../docs/getting-started.md#development).
Then, from this directory:

```powershell
pnpm install --frozen-lockfile
node scripts/verify-offline.mjs
pnpm dev:desktop
```

The offline verifier runs the full Node test set and TypeScript check with
Node-level external DNS/socket guards. It is not an OS-level network sandbox.

The renderer-only preview is built with `pnpm build` and served with
`pnpm preview`. Use `pnpm dev` for the browser development server with selected
real local service routes for Chat, Chemistry and model discovery; other adapters
may use fixture data. Static preview does not start those development routes.
A successful browser preview is not native Electron acceptance.
`pnpm build:desktop` builds the desktop source bundle.

Public builds bundle Newsreader, Hanken Grotesk and Commit Mono under their
upstream OFL terms. Local self-use builds retain the user-supplied Anthropic
families; their bytes remain Git-ignored. The shared role mapping and explicit
build profiles are documented in [typography](../../docs/typography.md).

The broader Qwen Harness acceptance target uses the twelve-family protocol in
[autonomous acceptance](../../docs/harness-acceptance-protocol.md), with the
exact `qwen3.8-27b@q4_k_m` instance loaded at 32,768 tokens. Its sixty scientific
measurements, fault cases and native desktop evidence are separate gates.

The older short-response LM Studio diagnostic below is not that acceptance
suite. It is deliberately gated and excluded from CI, and retains its own
8 GiB model-size limit. It requires an exact, initially unloaded model key plus
matching environment and command-line confirmations:

```powershell
$env:PROTO_AGENT_ALLOW_REAL_MODEL_TESTS = "YES_LOAD_CHAT_UNLOAD_LM_STUDIO"
node --experimental-strip-types scripts/verify-inference.mjs "YOUR_EXACT_MODEL_KEY" --confirm-owned-execution=YES_LOAD_CHAT_UNLOAD_LM_STUDIO
```

The verifier performs native discovery, an explicit bounded load, a 16-token
SSE chat, and an exact owned-instance unload. It never auto-selects a model,
claims an already loaded instance, or prints completion text.

## Packaging inputs

1. Install the repository's `.[workbench,compute]` extras in its `.venv`, then
   run `pnpm build:sidecars` to build only the packaged MCP server and bounded
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
configured by the operator. The packaged Proto sidecars do not require a separate
Python or Node installation. That statement does not cover external Chemistry,
Psi4, XDL, WSL bioinformatics or OCI scientific runtimes. Their availability and
packaged execution need their own checks on the target machine. Building a new
package does not inherit the historical preview's acceptance results.

## License

Proto Workbench is open source under the repository's
[MIT License](../../LICENSE).

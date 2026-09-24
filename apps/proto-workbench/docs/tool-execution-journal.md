# Tool execution journal

The desktop host records MCP and Chem tool calls in the workspace database at
`build/.proto/execution.sqlite`. `invokeJournaledTool` resolves the canonical tool contract, validates
scope and any policy decision, saves intent, and wraps the backend dispatch and
receipt. Chat, Harness, Compute, workflows and validation share this boundary.

## Durable states

| State | Meaning | Recovery behavior |
| --- | --- | --- |
| `intent` | The operation identity and argument digest were saved before dispatch. | Safe to continue if no request was dispatched. |
| `dispatched` | Dispatch was durably recorded before bytes were handed to the MCP sidecar. | A write becomes `effect-unknown` if its owner disappears before a receipt. |
| `no-effect` | Dispatch did not happen, a read-only request ended without a response, or the server explicitly confirmed no effect. | A saved rejection receipt replays; a transport failure without a receipt can retry. |
| `completed` | The full result envelope was saved with a byte count and SHA-256 digest. | The same operation ID and arguments return that receipt without dispatch. |
| `effect-unknown` | A write was dispatched but no verifiable terminal receipt was saved, or the tool reported an unknown effect. | The same operation ID is refused. Recovery does not replay the write. |
| `reconciled-applied` | An identified reviewer recorded evidence that the effect occurred. | Final; never automatically dispatched again. |
| `reconciled-not-applied` | An identified reviewer recorded evidence that the effect did not occur. | Final; an explicit retry requires a new operation ID. |

Each production call supplies `ExecutionScope {surface, scopeId,
parentOperationId?}`. The record binds it to an operation ID, tool name,
contract-derived effect, argument SHA-256 and optional full policy decision
(including its grant). Callers cannot override the contract effect. Unknown
tools are rejected before dispatch. The legacy `run_id` column remains the
storage alias for `scopeId`, and migrated rows have surface `legacy`.

`outcome: ok | tool-error` is independent of effect state: a tool can fail after
writing an artifact. MCP `isError`, structured `ok:false`, and Chem failed
results are recorded as tool errors. Full MCP envelopes, including text-only
diagnostics and metadata, are preserved for replay (`callEnvelope`); `call`
projects structured content while retaining text and error indicators. Receipts
are bounded by the tool contract (at most 8 MiB) and integrity checked on read.
Raw tool arguments are not duplicated in the journal.

`reconcile(operationId, verdict, actor, evidenceRef)` only accepts an inactive
unknown operation. The state change and append-only reconciliation history are
atomic. Reconciliation establishes the observed effect, not successful software
execution or scientific validity. `executionActivityState` projects the same
terminal category for activity views without converting tool errors to success.

Versioned migrations use the shared `schema_migrations` checksum ledger. The v2
transaction rebuilds the old constrained table without rewriting receipt bytes
or hashes. Old outcomes remain absent because v1 discarded MCP error envelopes;
the migration does not invent successful outcomes. `migrationReport` reports
applied and verified versions. A changed or newer migration fails closed.

The v3 migration adds a canonical `capability_id` alongside the backend tool
name. Known historical names are backfilled through the contract registry;
unregistered historical names remain null. The optional recovered receipt is
stored separately with its own digest, preserving the original observation.
An `applied` verdict alone does not manufacture a successful outcome: only an
independently verified recovery receipt can establish it.

## Harness recovery authority

Harness uses the workspace journal first for uncertainty, result recovery and
completion evidence. `harness_results` remains a result cache. For one release,
`harness_effects` remains a compatibility projection and a fallback only when no
workspace journal record exists. Disagreement and fallback observations are
deduplicated durably and exposed through `executionRecoveryReport()`; the
fallback is not silently treated as equivalent workspace evidence. The Harness
tables use the `harness-store` migration ledger. Version 3 adds a recovery-result
cache with distinct handles: a verified recovery never replaces the bytes,
digest or handle of an earlier unknown receipt. An applied verdict still lacks
completion evidence until a successful, non-unknown recovery receipt exists.

Local workspace and structure tools use the same invocation adapter as MCP.
Source recovery verifies the patch transaction, source and artifact digests,
publishes an exclusive proof under `build/harness-reconciliation/`, and only
then writes a journal verdict referencing the proof and its SHA-256. Recovery
of the journal and its known receipts does not depend on the previous profile's
Harness cache. Existing task checkpoints still live in the profile database.

Chat and Harness build the same `ExecutionActivity` shape from journal rows and
pass their complete operation set to the evidence gate. A later durable success
can supersede a known failure only for the exact same backend tool and argument
digest. An uncertain write cannot be superseded by a later success. Reconciled
but unverified effects, failed legacy results and explicit abstention remain
incomplete evidence. The loops and Harness's independent artifact verifier
remain separate; shared primitives do not claim a rewritten common engine.

`listPage` provides bounded workspace inspection without loading receipt bodies;
`recoverySummary` includes orphaned dispatch recovery before counting unknown
effects. Full receipts are loaded only by explicit record inspection or recovery.

## Stable operation identity

Chat uses the provider tool-call ID; Harness uses its persisted call ID; Compute
uses the operation ID in the immutable request snapshot filename; workflows
persist an operation ID per step and preserve it when recovering an interrupted
step. A repeated workflow attempt therefore uses the same request path and
argument digest. If the source request changed, the identity check fails closed.

Callers that do not supply a stable operation ID receive a fresh ID. Production
MCP calls using a journal must still supply an explicit execution scope. A later user action
is a new operation, while an automatic recovery path must reuse the original
ID. Read-only operations may safely retry after an interrupted dispatch.

This journal does not promise exactly-once effects. A write can finish in the
sidecar or an external provider before its result reaches the host; that gap is
recorded as unknown. Tool-specific reconciliation or explicit human inspection
is needed before starting a distinct operation that might repeat the effect.

`tests/execution-kernel.test.mjs` covers the twelve read/write fault cells for
intent, dispatch, server refusal, tool error, timeout and process exit, including
activity projection and retry/refusal behavior. Additional cases cover full MCP
envelope replay, v1 migration, policy evidence and both reconciliation verdicts.

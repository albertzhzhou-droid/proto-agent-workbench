# Reliable autonomous execution

The Workbench execution path uses a durable mission contract, a model-bound context assembler, a tool router, and workspace transactions. Existing desktop IPC entrypoints remain available. The primary acceptance model is `qwen3.8-27b@q4_k_m`, explicitly loaded with 32,768 tokens. Model catalog maximums do not authorize a larger request.

## Mission lifetime

A mission records its goal, input paths, writable scope, connector permissions, model identity, deliverables, material binding, and execution budget. Defaults are two hours of active execution, 128 model rounds, and 65,536 generated tokens. Queue time and user pauses do not consume active execution time. Resuming preserves consumption already recorded by the checkpoint heartbeat.

Closing the application or changing workspaces pauses owned tasks and waits for
their tool sessions to close. Explicit cancellation remains a separate action.
On startup, an interrupted nonterminal checkpoint without a live owner becomes
available for recovery; a write with an unknown effect still requires journal
reconciliation before continuation. Startup never replays that write or refunds
recorded usage. The mission panel uses the newest checkpoint revision so a
historical generating event cannot conceal a recovered task.

The UI projects the durable execution state. A model's final prose is insufficient to mark a task complete: `harness_finish` requests independent artifact and validation checks. Empty or truncated model output, a missing terminal stream marker, invalid tool arguments, and failed validation remain visible as repairable or incomplete work. Human scientific review remains separate from software completion.

Each tool intent is stored before execution. Full JSON results are stored with their digest and a run-bound handle; large results can be read in bounded pages. Context summaries retain identities, paths, material snapshot bindings, diagnostics and outstanding requirements. They do not replace the stored original result. No fixed example design is substituted for failed model work.

All model generation requests for the same instance are serialized. Each mission has an owned MCP session. Workspace mutations share a canonical workspace queue with manual source edits, including post-write validation; independent read operations use a three-slot limit. Cancellation targets the owning operation and session.

The execution graph uses persisted observed-result dependencies: an arrow means
that an earlier tool result was available to the model when it chose the next
operation. Matching filenames and chronological stage order never invent an
edge. Selecting a tool exposes its recorded arguments, full paged result or
diagnostic, and audit digest.

## Time and context limits

The context assembler includes the system instructions, tool schemas, template and message history. It reserves 4,096 output tokens by default, up to 8,192 for a repair, plus a 2,048-token safety margin. Counts use the loaded model's tokenizer where available; conservative estimates are identified in the projection.

Model loading has a 15-minute bound. Generation permits up to ten minutes before the first meaningful stream increment, then detects a 90-second stall, subject to a 20-minute per-generation limit and the remaining mission budget. Files and material queries use 60 seconds; materialization and compilation use 180 seconds; supported workflow, review and analysis tools can use 600 seconds with a separate outer cleanup allowance.

## Scientific transactions

DNA work binds an eligible material selection before part search or editing. The exact parts path and SHA-256 propagate to validation, compilation, workflow, provenance verification and review. Existing files require an observed baseline before a replacement. An atomic source write and its subsequent validation have separate recorded outcomes.

Manual DNA commands support occurrence ordering, placement orientation and source-anchored annotations through the same patch transaction boundary. Undo and redo are source-digest-bound commands and run validation again. A failed post-write validation retains the draft and diagnostics while the viewer continues to identify the last valid artifact.

Protein structures retain independent content-addressed source bytes. Viewing or downloading coordinates does not alter material eligibility. Sequence linkage requires an unambiguous residue mapping; structure-only viewing remains available when mapping cannot be established. Figure export verifies the saved artifact independently before issuing a success receipt.

## Verification evidence

Local implementation and test evidence is retained under `build/upgrade-20260904/`. The initial working tree and material changes are recorded in `baseline-inventory.json`, `pre-existing.patch` and `baseline/`. These records contain local development data and are not public release inputs.

`scripts/verify-autonomous-harness.mjs` records real-model task results, instance binding, outputs, retries and owned unload observations. The scientific acceptance matrix and injected fault probes are separate. A development probe is not a completed sixty-run reliability gate.

`scripts/verify-harness-wallclock.mjs` uses controlled loopback HTTP and owned
stdio fixtures to exercise real elapsed time beyond the historical 15-second
header and 180-second tool limits, a 90-second post-token stall, and cancellation
isolation. It does not call a live model or execute a biological workflow.

`scripts/verify-scientific-native.mjs` drives an isolated native desktop profile and workspace. Its launch helper records process ownership and stderr. On this Windows host, the initial restricted-token Electron QA launch encountered a native breakpoint before its window became available. A normal desktop-permission launch of the same executable opened and exited successfully with the renderer sandbox enabled. The first failing launch did not retain sufficient native stderr to identify the exact Chromium assertion; the launch-path diagnosis must not be overstated as an identified application-code defect.

Candidate packaging follows [the shared build transaction](build-transactions.md). Native functional checks, performance measurements, model reliability results, package integrity and signing status are reported separately. Source compilation or focused tests alone do not certify an installer.

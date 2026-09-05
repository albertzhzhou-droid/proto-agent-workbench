# Autonomous Harness acceptance protocol

The scientific matrix runs the actual AgentService, durable SQLite execution
store, workspace filesystem, Python MCP sidecar and local LM Studio provider.
It contains twelve scientific task families, five repetitions per family, and
three workspace groups with a fresh workspace for every task. Separate fault
fixtures and development probes do not count toward these sixty measurements.

A user may cap a running campaign as a development/debug sample. Stop between
completed cases, preserve the original frozen plan and every measured result,
and record the user's reduced scope separately. Report completed case counts
and outcome categories; do not treat unstarted cases as model failures or claim
the full sixty-case threshold. A case may contain many model/tool rounds. On
2026-09-05 the user limited the active campaign to fifteen cases for debugging;
the additional live fault suite and Portable model mission were deferred.

The primary binding is the exact approved `qwen3.8-27b@q4_k_m` catalog key and an
observed loaded context of 32,768 tokens. Each mission keeps the production
two-hour active-time budget, 128-round bound and 65,536 generated-token bound.
Generation and workspace execution queue time are excluded from active time.
Initial tool discovery is active preparation and is checkpointed before its
first asynchronous request. The runner follows persisted active time instead
of imposing a second total wall-clock task limit. Its separate liveness guard
allows 180 seconds for the first checkpoint, 90 seconds without a newer
checkpoint, and 60 seconds for budget or terminal-state settlement. A queued
task with continuing checkpoints can wait without a wall-clock task limit.
Paused segments stop monitoring after the new terminal event; resumption keeps
the original budget. Cleanup failures have their own recorded diagnostic and
cannot leave a passing acceptance result.
Sampling is temperature 0.2 with automatic tool choice, 4,096 normal output
tokens and an 8,192-token repair allowance. No explicit sampling seed is sent;
the backend seed is uncontrolled and is recorded as such.

Before inference, `freeze-autonomous-harness.mjs` copies the runtime source,
Python code, schemas, skills, connectors and acceptance scripts to a private
snapshot. Installed Node dependencies are shared, with their actual resolved
bytes hashed by `harness-input-inventory.mjs`. The runner records that boundary,
the Node executable, Python executable/version, TLS certificate bundle and the
active governed-materials snapshot and manifest digest. It rechecks measured
inputs before and after every task. Changed or missing inputs invalidate the
matrix and stop further tasks; UI files outside the runtime graph do not change
the measured kernel. This is a model acceptance snapshot, not a release package.

Independent checks reopen current artifacts and compare their bytes with
durable tool receipts. Scientific outputs additionally require their compiler,
material, source and export lineage. Citation checks establish that returned
publication identifiers were retrieved and cited; they do not establish that a
scientific claim is true. The runner never generates task completion content.
Governed source fixtures are identified as inputs and never substitute for a
model deliverable.

Every result receives exactly one classification:

- `direct_success`: independently verified model completion without recovery.
- `success_after_retry_or_repair`: model completion after bounded transport,
  output or tool-argument repair. The deliberately scheduled public pause and
  resume scenario also belongs here only when the same run resumes once, its
  budgets remain identical, usage is not refunded, and neither journal
  reconstruction nor model-instance rebind occurred. Its
  `intentionalCheckpointResume` flag and before/after audit remain separate.
- `host_recovery`: completion involving unplanned checkpoint continuation,
  journal reconstruction or an exact-model instance rebind. These results do
  not count as model successes for the matrix threshold.
- `incomplete`: the run did not produce a verified completion.
- `false_completion`: the run reported completion but an independent check
  rejected the result. One such result fails the acceptance gate.

After a false completion, the runner preserves that case and stops the campaign.
A corrected implementation starts a new immutable campaign; it does not replace
or relabel the failed case. The initial 2026-09-05 campaign exposed a real
transcription error: a requested 64-character sequence digest was saved with
62 characters and the old completion gate accepted it. Its original result,
receipt database, report and failed classification remain preserved.

Material metadata reports now carry immutable requested-field requirements.
Successful catalogue search/get receipts, or current digest-bound protein
inspection receipts, supply the exact identities and metadata. Each saved
report's resource association is checked for its sequence digest, requested
length, source references and license identity. Metadata may be split across
documents for the same resource; a wrong value in one document remains a
failure even if another document is correct. A completion summary cannot mask
incorrect saved bytes. Diagnostics return to the model for an ordinary scoped
read/patch/verification cycle. This establishes record fidelity, not scientific
correctness or biological readiness.

Explicitly named reports retain their own field requirements. Required fields
in one report cannot be supplied by a different deliverable. User-named literal
copy requests bind to the relevant source read and saved output; quoted labels,
verbatim requests and dotted JSON fields are preserved. Conflicting labelled
values remain failures even if an unrelated note contains the correct value.
Requested artifact metadata is checked as current path/digest pairs, with
"every generated artifact" excluding read-only inputs and requiring all outputs.

The future protein-report assessor uses the output-facing protein `id` requested
by the prompt, while retaining `resource_id` as separate catalogue provenance.
The original frozen campaign and its scores are unchanged. This schema
correction precedes the replacement campaign; it is not a result substitution.

The no-progress guard persists a window of 64 individual tool observations.
Twelve unchanged observations across changing batches trigger one repair;
eight more unchanged observations after that repair leave a durable incomplete
task. Three deliberate repeat checks remain allowed. Source digest or concrete
obligation changes count as progress; timestamp-only validation output paths do
not. Receipts remain readable and no host report replaces a stalled model.

The persisted legacy `hostRecovered` boolean means that the retired static
completion fallback supplied content; it is always false in the new runner.
It must not be interpreted as an absence of recovery. Checkpoint and UI
projections expose `recoveryCounters`, which separately record resumes, journal
reconciliations, instance rebinds and transport/output/progress repairs.

The matrix gate requires all sixty unique planned cases to have a result,
unchanged measured inputs, at least 57 direct or limited-repair successes, all
five governed DNA tasks and all five governed protein tasks passing within
those categories, zero false completions and no static host completion
fallback. `allCasesPassed` is reported separately; a strict diagnostic process
exit can be nonzero even if the 57-of-60 acceptance threshold is met.

The scheduled checkpoint scenario uses the public pause/resume API on the same
AgentService. It is not application-restart evidence. Native application
restart, UI behavior, visualization interaction and independently reopened
image exports are separate gates. Earlier probe reports are retained unchanged;
any correction to an independent assessor is a separately labeled reassessment.

An owned run can be stopped by creating the `STOP` file identified in its
`runner.json`. Cancellation persists execution state, closes the owned MCP
session and unloads only the model instance owned by this runner. Existing user
applications and unrelated model instances are outside that cleanup boundary.

The owner can also create the exact `PAUSE_BETWEEN_CASES` path recorded in
`runner.json`. The current case finishes unchanged, then the runner records a
held state before constructing another mission. Removing the file continues;
`STOP` still cancels the held batch. The owned model remains resident but no
generation is active during this hold. The control is outside all model-visible
case workspaces and does not modify mission budgets, outcomes or repetitions.

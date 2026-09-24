# Frozen software evaluation for Harness iteration

The Section 9 runner is `apps/proto-workbench/scripts/run-harness-evaluation.mjs`.
It measures a direct tool loop and the current production Harness against the
same 30 synthetic software tasks. The pack is deliberately small and easy: six
fixture variants each for file reads, text patch proposals, report assembly,
and schema validation, plus two each for a missing dependency, unavailable
binary renderer, and conflicting source receipts. It is not a scientific
benchmark or evidence of general model reliability.

The pack is frozen in `apps/proto-workbench/evaluation/software-tasks.v1.json`;
its raw-byte SHA-256 is
`29f3e7df6b6556ebc37a12012b63052b5cc9c1266b024c1a8ad7cd594e046d61`.
The adjacent `.sha256` file is checked before a campaign can begin. Existing
packs and campaign outputs must not be edited to repair failed cases. A future
task revision needs a new pack and separately reported campaign.

## Execution contract

Both arms use the same exact loaded provider instance, context length, frozen
inputs, workspace read/patch tools, independent saved-output scorer, shared
execution completion gate, sampling temperature, and resource limits. Arm order
alternates by task. Every task/arm receives a separate workspace under the new
campaign directory. Only `build/` is writable through the model-facing tools;
the tools expose no network, arbitrary execution, or biological operations.

The Harness arm uses production `HarnessController`, `HarnessWorkspace`,
`HarnessStore`, `McpClient.invokeLocal`, and the execution journal. The direct arm
uses an ordinary bounded tool loop without Harness planning, compaction, or
repair rounds. It still uses the same production workspace CAS, journal,
required-read checks, artifact digests, and exact fixture scorer. It gets one
verification when it requests completion. Both arms can declare abstention.
Fixture missions explicitly declare their evidence requirements: required
input reads, current artifact lineage, and frozen expected output. They do not
derive scientific requirements from the evaluation prompt's prose.

The scorer reads the actual saved artifact. Possible tasks require exact text
or JSON equality with the frozen reference. An impossible task cannot pass by
inventing a file or claiming success. The reference and its digest are not
included in model messages. The host never generates the requested output for
the model.

The default per-attempt bounds are 60 seconds wall time, six generation rounds,
8,192 generated tokens, and 2,048 generated tokens per call. Both arms use
temperature 0.2. Provider token usage is recorded when observed; missing usage
is unknown, never zero. Instance or context drift halts the campaign, retaining
the failed attempt and identifying unstarted slots.

## Commands

Run from `apps/proto-workbench` with the supported Node 24 runtime:

```powershell
node --experimental-strip-types scripts/run-harness-evaluation.mjs freeze

# Explicitly create and own a new 32,768-token instance of this exact model.
# The selected model must have no already loaded instances.
node --experimental-strip-types scripts/run-harness-evaluation.mjs run `
  --out ../../build/harness-evaluation-slice-b-20260923 `
  --model unsloth/qwen3.8-27b --load --iteration slice-b `
  --attempt-ms 60000 --max-rounds 6 --max-tokens 8192

# Or attach one already loaded exact instance; it is never unloaded by this run.
node --experimental-strip-types scripts/run-harness-evaluation.mjs run `
  --out ../../build/harness-evaluation-attached `
  --model <exact-model-id> --instance <exact-instance-id> --iteration slice-b

# Reopen and verify ledger/sidecar bindings. Export refuses to overwrite a file.
node --experimental-strip-types scripts/run-harness-evaluation.mjs report `
  --out ../../build/harness-evaluation-slice-b-20260923 `
  --export ../../build/harness-evaluation-slice-b-20260923/reopened-report.json

node --experimental-strip-types --test tests/harness-evaluation.test.mjs
```

`--out` must be a new directory whose parent exists. `--load` is explicit and
uses production provider ownership: an instance created by this runner is
unloaded in `finally`; attaching an existing instance only disconnects the
runner. Ctrl+C requests cancellation, records the active attempt, and stops
launching new slots. A hard process kill cannot execute cleanup; the remaining
start marker is reported as interrupted with unknown resource usage when the
campaign is reopened. Its unfinished ledger row is not invented or repaired.

## Evidence and independent metrics

`campaign.json` records the instance/model/runtime identity, pack digest,
budgets, sampling, and source hashes. The source hashes include controller,
iteration policy, diagnostics, workspace, context, material/artifact/mission
evidence, source-field verifier, store, provider, workspace files, MCP client,
journal, turn engine, shared Harness and tool contracts, runner, and lockfile.
An immutable `started.json` is written
before generation. Each finished slot has an immutable `result.json`; its hash
is stored in the existing append-only `ModelEvaluationAttempt` ledger's
execution receipt field. That result also binds the complete campaign manifest
hash. Reopening rejects drift in the pack, case/reference, result bytes,
instance, protocol identities, or campaign manifest. No raw answers enter the
evaluation ledger; production Harness checkpoints remain in the campaign's
local SQLite file.

`report.json` and the read-only reopened report keep these dimensions separate:

- Completion and validation, each over all 30 planned slots per arm.
- Correct abstention over six impossible tasks, and false abstention over 24
  possible tasks.
- Status/state distributions including errors, timeouts, cancellations,
  refusals, interruptions, and unstarted slots.
- Model-requested tool calls, including Harness controls and malformed/partial
  calls, counted from the same provider stream boundary in both arms. Separate
  `externalToolCalls` count invocations of the shared workspace host boundary.
  These counters survive context compaction and are not confused with confirmed
  mutation counts. Tokens, wall time, and unknown measurements remain separate.
- Duplicate argument digests within each run's journal, with a separate
  write-only counter. Repeated reads are visible in the broader descriptive
  counter; it does not prove a duplicate mutation occurred.
- Recovery counters by name and diagnostic counts by blocking class.

No composite score is computed. Scientific answer scoring is always `not-run`.
Failed/interrupted attempts never leave the frozen denominator. A hard-killed
attempt is identified separately from a slot that was never started; unknown
costs are not fabricated from the configured budget.

## Iteration interpretation and verification

`--iteration` (including `slice-b-and-plan`) is a label bound to the source snapshot; it does not silently
enable or disable mechanisms. Running `slice-b` measures the current source.
An isolated Slice A versus Slice B comparison needs separately preserved code
snapshots differing only in the chosen mechanism, the same frozen pack, and
matching model/runtime/sampling identities. This runner cannot retrospectively
create a Slice A-only result. A present-day direct-versus-Harness baseline must
not be described as that controlled historical comparison.

Nine focused tests cover pack drift, exact saved-output scoring, independent
denominators, 60 scripted-provider slots through real workspace CAS/journal,
cancellation, exact-instance validation, timeout retention, interrupted starts,
and model-instance drift. Those scripted tests validate the runner; they are
not live model measurements. Live campaign evidence, if run, must be reported
from its retained campaign directory rather than inferred from these tests.

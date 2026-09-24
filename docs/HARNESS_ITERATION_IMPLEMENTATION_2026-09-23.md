# Harness iteration implementation — 2026-09-23

This records the implementation of Slice B and the remaining engineering and evaluation work in [the iterative Harness proposal](harness_iteration_proposal.md). It follows the prior Slice A work and the [architecture upgrade](ARCHITECTURE_UPGRADE_2026-09-23.md). The historical proposal remains unchanged apart from its status pointer.

The source changes, browser component acceptance and 60-slot live paired model campaign are complete. The validation table separates source checks, development builds and observed model results.

## Proposal coverage

| Proposal item | Implemented behavior | Main implementation and checks |
| --- | --- | --- |
| Slice B: typed verification | Workspace, mission-evidence and scientific-artifact checks return diagnostics with stable code, blocking class, subject, message and evidence handles. Existing failure prose is retained. Unknown or unclassified diagnostics normalize to `repairable`. | `src/shared/harness.ts`; `harness-diagnostics.ts`; `harness-workspace.ts`; `mission-evidence.ts`; `harness-artifact-verification.ts`; typed-diagnostics and controller tests. |
| Slice B: permanent failures | Missing trusted PNG/PDF renderer receipts and unsupported or legacy read-only artifact versions are `unsupported`; changed bound inputs and artifacts that cannot be reopened are `stale`; incompatible immutable claims are `conflicting`. A permanent diagnostic stops the run even when other diagnostics are repairable. | Workspace and artifact verifier tests; mixed-diagnostic controller test. |
| Slice B: bounded repair | The controller saves a verification verdict and consumes the task's verification repair allowance before continuing. Permanent failures do not consume a repair and do not create a retry prompt. A repeated missing dependency receives one targeted hint before human review. | `harness-iteration.ts`; `harness-controller.ts`; repeated-resume and missing-dependency tests. |
| Slice B: per-run export | Saved projections expose verdict history, diagnostic class counts, repair budgets and tool usage. The mission panel shows these values and exports diagnostic JSON for the selected run. | `harness-store.ts`; `HarnessMissionPanel.tsx`; renderer acceptance recorded below. |
| Section 4: host-owned tool contracts | The existing canonical registry now declares preconditions, receipt classes, idempotence, scheduling cost class and a finite per-run call cap. Python consumes the generated view of the same registry. There is no second hand-maintained authority table. | `src/shared/tool-contracts.ts`; `scripts/export-tool-contracts.mjs`; `src/proto_agent/tool_contracts.py`; cross-language contract tests. |
| Section 4: dispatch enforcement | Schema validation and host facts are checked before intent. Canonical backend call counts and operation reservations are persisted before dispatch. Old checkpoints derive initial usage from durable legacy and journal records; a resumed reservation does not spend a second call. | Controller `evaluateToolDispatch` integration; `HarnessStore.toolUsage`; cap and resume tests. |
| Section 4: remedies | Known receipt obligations map to the canonical `produces` classes. Remedies are filtered against the supplied host inventory, policy, current scope, preconditions and remaining call allowance. A discovery subset alone cannot prove a capability absent. An authorized materializer can be suggested to establish a missing material binding. | `HarnessWorkspace.withDiagnosticRemedies`; tests for unavailable producers, caps, permissions and material prerequisites. |
| Section 4: persisted checkpoints | Checkpoints carry remaining output/progress/verification repairs, all verification verdicts, dependency hints, negative results, per-tool usage and operation reservations. Projections preserve the relevant diagnostic and usage history. | `src/shared/harness.ts`; controller and store recovery tests. |
| Section 5: pinned verification context | The last verdict, remaining repair allowances and bounded negative-result memory are included in the host-state message, which survives history compaction. Original user instructions and the indivisible assistant/tool-result tail remain protected. | `harness-context.ts`; context and controller tests. |
| Section 5: negative-result memory | Up to 128 distinct failed external calls are retained by tool, canonicalized argument hash and failure code. Repeating the same invalid arguments produces a durable rejection without dispatch. Tool discovery displays previous failures and lowers their lexical score. | `harness-iteration.ts`; discovery and invalid-call regression tests. |
| Section 5: context-aware memory | Result memory and projected negative-result record limits scale with the bound context size, with explicit upper and lower bounds. Full receipts remain accessible by handle. Oversized protected context still fails before a request is sent. | `harnessMemoryBudget`; context-compaction tests. |
| Section 7: conflicting evidence | Host-recognized immutable claims are grouped by subject and claim kind. Conflicting hashes, sizes or same-revision material metadata retain every contributing handle and require human review. Sequential CAS edits and later refreshes of derived artifacts are not automatically treated as contradictions. | `conflictingReceiptDiagnostics`; material evidence and typed-verifier tests. |
| Section 8: preserve Slice A behavior | `harness_report_blocked` remains always exposed, read-effect and terminal. Abstention, human review and genuine failures remain distinct. Output and progress repairs retain their spent allowance across resume. | Controller tests for abstention, five resume attempts, old-checkpoint migration and genuine failures. |
| Section 9: frozen synthetic tasks | A digest-bound pack contains 30 software fixture tasks: 24 possible and 6 deliberately impossible. Cases exercise reads, text patching, report assembly, schema validation, missing dependencies, unsupported formats and conflicting evidence. | `evaluation/software-tasks.v1.json`; pack drift and scorer tests. |
| Section 9: paired execution | A runner executes direct-model and production-Harness arms with the same exact model instance, task pack, independent scorer, sampling and limits. Both arms use the production workspace CAS and execution journal. Arm order alternates by case. | `scripts/harness-evaluation-core.mjs`; `scripts/run-harness-evaluation.mjs`; paired-runner and instance-change tests. |
| Section 9: preserve all outcomes | Attempts bind the pack, case, reference, source snapshot, model/runtime instance, tool schemas and prompt template. Results are written once and linked to append-only evaluation records. Reopening verifies result bytes and identities; interrupted starts remain explicit unknown-usage attempts. | Evaluation ledger, digest-tamper, interruption, cancellation and timeout tests. |
| Section 9: separate metrics | Reports retain completion, validation, correct/false abstention, model-requested tool calls, external host calls, tokens, wall time, duplicate journal argument digests and recovery counters as separate dimensions. Both arms count requested calls at the same provider-stream boundary. Every planned frozen slot stays in the denominator. Unknown usage is disclosed. | `summarizeEvaluation`; denominator, call-counter and unknown-value tests. |
| Section 10: evidence before simplification | The new reports make evaluation possible. No claim that Harness improves completion or cost, or that progressive discovery or compaction should be removed, is made from source changes alone. | Interpretation limits below. |

Implementation paths in this table are relative to `apps/proto-workbench/`, except `src/proto_agent/`, which is relative to the repository root.

## Recovery and authority details

The task-wide default repair allowance is one output repair, one progress repair and one verification repair. A saved verification receipt does not grant another allowance when processed again. If a checkpoint already contains a human-review verdict, recovery restores that terminal outcome before another model or tool call.

Terminal decisions and removal of their pending calls are saved together. A crash before the terminal save leaves the durable result available for recovery; successful completion is independently reverified rather than accepted merely because an older result said `ok`. The prose-only output repair is saved before the next asynchronous model-binding lookup. An inconsistent `ok: true` result cannot override a non-completed diagnostic verdict.

A subsequent fault-injection review also protects a successfully committed terminal checkpoint from a failing UI/event notification. The notification exception propagates for separate reporting while the durable terminal state remains authoritative; a failed checkpoint write still follows the execution failure path. The pre-fix controller used by the live campaign is preserved at `build/harness-slice-b-publication-fix/before/harness-controller.ts` (SHA-256 `6fc9affa5f46c51cd2c8fbf8440cbab72c070eda44cd57af45c6f221b6bb42d7`). The post-fix controller is `ae305d67574d3c93a53c329d59fca22eb565212f05d9151a7b6c4051d265cbf3`. The campaign's already-loaded module and manifest were not altered. Its measurements describe the frozen pre-notification-fix snapshot; the additional notification-failure behavior has separate deterministic test evidence.

The canonical dispatch limits are 64 calls for cheap reads, 24 for local writes, and 12 for external tools. Terminal controls remain available through their host-owned handling. The controller persists canonical tool usage and operation IDs before dispatch; aliases cannot create another budget. These limits supplement existing policy, CAS, path, digest and execution-budget checks.

`idempotent` does not authorize replay of an unknown write. All write contracts remain non-idempotent. Existing source recovery uses bound operation evidence and current-file verification; it does not resubmit the write. `costClass` describes scheduling, not price or scientific quality. `produces` declares a possible receipt category, not proof that a particular call generated a valid artifact.

Conflict detection is intentionally limited to host-recognized, identity-bound claims. It does not infer semantic contradictions from arbitrary model prose, choose a newer receipt as truth, or synthesize missing provenance. Partial material metadata is compared by compatible fields within the same receipt scope; unrelated snapshots are not merged into a new authority.

The material eligibility, quarantine, network-grant and execution-grant boundaries remain unchanged. The synthetic evaluation runner has only local fixture read and text-patch tools; it neither executes fixture programs nor generates biological designs.

## Frozen evaluation protocol

The pack is `apps/proto-workbench/evaluation/software-tasks.v1.json`. Its committed SHA-256 is:

```text
29f3e7df6b6556ebc37a12012b63052b5cc9c1266b024c1a8ad7cd594e046d61
```

| Category | Cases |
| --- | ---: |
| File reads | 6 |
| Text patch proposals | 6 |
| Report assembly | 6 |
| Schema validation | 6 |
| Impossible: missing dependency | 2 |
| Impossible: unsupported format | 2 |
| Impossible: conflicting evidence | 2 |

A full campaign plans 60 attempt slots: 30 cases in each arm. Cases with impossible requirements are included to measure appropriate abstention. Fixture scoring uses frozen expected values and cannot be overridden by the model's final summary.

The direct arm is a bounded ordinary tool loop with final verification. The Harness arm uses the current production controller, including its persisted repairs, context handling and terminal gates. This compares two execution paths, not a model with tools against a model without tools.

The runner records an iteration label (`baseline`, `slice-a`, `slice-b` or `slice-b-and-plan`) and source hashes. The label does not toggle mechanisms. A campaign using today's sources cannot reconstruct a historical baseline or establish the isolated causal effect of Slice A versus Slice B. That requires separately frozen implementations, equivalent reviewed runs and retained failed attempts. The detailed [evaluation protocol](harness_iteration_evaluation.md) defines identities, metrics and cancellation handling.

From `apps/proto-workbench/`:

```powershell
# Validate the frozen pack without model inference.
node --experimental-strip-types scripts/run-harness-evaluation.mjs freeze

# Attach an explicitly selected loaded instance; use a fresh output directory.
node --experimental-strip-types scripts/run-harness-evaluation.mjs run --out "../../build/harness-evaluation-unique-run" --model "<exact-model-id>" --instance "<exact-loaded-instance-id>" --iteration slice-b

# Verify saved evidence and create a new report export without rewriting results.
node --experimental-strip-types scripts/run-harness-evaluation.mjs report --out "../../build/harness-evaluation-unique-run" --export "../../build/harness-evaluation-unique-run/reopened-report.json"
```

`--load` is a separate explicit model-loading option and cannot be combined with `--instance`. The runner stops if the bound model, instance or context changes. Its manifest records the actual budgets and sampling values used; report those values when discussing results.

## Validation record

Focused results below were recorded during this implementation. They do not replace the final aggregate run after integration. Counts refer to checks, not model successes.

| Check | Result | Evidence or scope |
| --- | --- | --- |
| Canonical tool contracts, Node | **14/14 passed** | `tests/tool-contracts.test.mjs`: registration, preserved authorization, caps, aliases, host preconditions, available producers and cross-language parity. |
| Canonical tool contracts, Python | **9/9 passed** | Repository `tests/test_tool_contracts.py`. |
| Generated Python registry | **43 tools verified** | `node --experimental-strip-types scripts/export-tool-contracts.mjs --check`. |
| Typed-verifier focused set | **71/71 passed** | `harness-typed-diagnostics`, `harness-artifact-verification`, `harness-material-evidence`, `mission-evidence`, `architecture-followup` test files. |
| Controller after recovery fixes | **57/57 passed** | Includes persisted repairs, terminal crash windows, contradictory `ok`/diagnostic handling, notification failures after three terminal states and a checkpoint-write failure control. Final log: `build/harness-slice-b-publication-fix/controller-final.log`. |
| Evaluation protocol focused set | **9/9 passed** | `tests/harness-evaluation.test.mjs`: pack/scorer, 60 scripted-provider slots through actual workspace CAS/journal, ledger reopen, timeout, cancellation and exact-instance tests. These are runner checks, not live model measurements. |
| Final complete Workbench tests and offline verification | **1,405 passed; 1 skipped; 0 failed** | `node scripts/verify-offline.mjs`, 200 test files, log `build/harness-slice-b-offline-final.log`, including the final notification-failure fix and renderer tests. Earlier successful integration remains in `harness-slice-b-offline-2.log`. The first run retained one obsolete error-code expectation in `harness-slice-b-offline-1.log`; the test now checks the earlier canonical precondition rejection and exact missing material binding. |
| Final TypeScript check | **Passed** | Offline verifier's pinned TypeScript check exited zero; separate `pnpm typecheck` also passed (`build/harness-slice-b-typecheck-2.log`). |
| Browser/UI acceptance | **Passed, synthetic component scope** | Production React component, four explicitly labeled scenarios at `http://127.0.0.1:5201/`. Human review and abstention show unmet requirements without resume; repaired history retains its earlier diagnostic; legacy verification budget is `unknown`. At 390 x 844, document width was 390 without horizontal overflow. Both exported JSON downloads were reopened and SHA-256 recorded in `build/harness-iteration-ui/download-reopen.json`. Four production renderer/export tests passed; final combined renderer/runner set is 13/13 (`build/harness-slice-b-renderer-evaluation-final.log`). This is component acceptance, not native desktop execution. |
| Final desktop source build and artifact identity | **Passed and reverified** | `pnpm build:desktop`; `build/harness-slice-b-desktop-build-final.log`; checker `build/harness-slice-b-build-identity-final.log`. Content ID `caadf5cc9747fdcf20ad86fbee3e6eeacd4a10f62f11886e66bbaa83f070bbfb`; source SHA-256 `9824a146a080bc8f58e6ed47217e8d0bc9af96aebc20478dd9da7da3ca902609`; output SHA-256 `49505c3154f979670fed1e9c64b35a6b85cf8dddce72f569cc8f553c25a4fbb8`. Receipt: `apps/proto-workbench/build/content-identity/d052d625aab845b8bba5ac9501f61239/identity.json`. Earlier build/retry and the initial Windows skill-directory rename failure remain in their separate logs. This is not installer or packaged runtime acceptance. |
| Live 30-case paired campaign and reopened report | **60/60 attempts retained; integrity check passed** | Exact `unsloth/qwen3.8-27b`, Q4_K_M, native instance `unsloth/qwen3.8-27b`, 32,768 context. `build/harness-evaluation-slice-b-20260923/{campaign.json,report.json,reopened-report.json,evaluation.sqlite,attempts/}`; reopen log `build/harness-slice-b-report-reopen.log`. Model ownership lifecycle observations: `build/harness-slice-b-model-loaded.json` and `harness-slice-b-model-unloaded.json`; the owned instance was unloaded. Measurements use the preserved snapshot before the final notification-failure fix. |

Do not remove failed, interrupted, timed-out or cancelled attempts when filling this table. Keep reruns separately identified. A new successful run does not rewrite the earlier evidence.

## Observed live campaign

Campaign `e3f67717-86ac-4ba4-b53a-2e5ded703f4a` ran all frozen slots with the configured 60-second attempt, six-round and 8,192 generated-token budgets. The table reports separate dimensions from the reopened, digest-checked report.

| Dimension | Direct tool loop | Harness |
| --- | ---: | ---: |
| Completed and independently validated, all planned tasks | 24/30 | 23/30 |
| Completed among the 24 possible tasks | 24/24 | 23/24 |
| Correct abstention, impossible tasks | 5/6 | 6/6 |
| False abstention, possible tasks | 0/24 | 0/24 |
| Error / timeout | 1 / 0 | 0 / 1 |
| Requested tool calls / external host invocations | 109 / 80 | 95 / 63 |
| Observed total tokens | 146,964 across 30 attempts | 159,596 across 29 attempts; 1 unknown |
| Aggregate attempt wall time | 374,741 ms | 424,164 ms |
| Duplicate argument digests / duplicate write digests | 0 / 0 | 0 / 0 |

Harness `patch-04` timed out at 60,017 ms; its unfinished attempt remains in the denominator. Direct `unsupported-02` ended incomplete instead of abstaining. The Harness recorded one output repair; transport retry, progress repair, instance rebind, journal reconciliation and resume counters were zero. No case required host verification diagnostics, so this live campaign does not independently demonstrate the typed-diagnostic retry branches; deterministic failure-injection tests cover those branches.

This small run does **not** establish a completion or token-cost improvement. Harness made one more correct abstention, but completed one fewer possible task and had higher observed token use even with one unknown measurement. Wall time is descriptive local-host evidence, not a controlled performance experiment. In line with the proposal's stop criterion, no additional planner, critic, voting or speculative-path mechanism is added on the strength of this result. A future optimization needs a separately frozen controlled comparison; this campaign and its failures remain immutable.

## Interpretation and remaining limits

Software implementation, UI verification, a desktop build and a model campaign are distinct acceptance layers. A fixture passing its exact software scorer does not establish scientific correctness, biological suitability, validated physical measurements or domain-level model reliability. Evaluation ledger entries from this runner mark scientific-answer scoring as `not-run`.

The proposal's controlled sequence of isolated mechanism changes was not reproduced as a historical experiment by this implementation. The paired runner is available for future controlled comparisons, but no isolated Slice A/Slice B causal benefit, model-category ranking, or general benchmark improvement follows from the new code or a single campaign.

Hashes bind files, fixtures and records to the measured bytes. They are not authorship signatures, scientific validation or a guarantee that a model will reproduce the outcome. Duplicate argument-digest counts describe repeated journal entries and are not proof that the same physical or scientific effect occurred twice.

Unknown diagnostics keep the bounded repair behavior; unknown or unversioned evidence does not receive an invented conflict identity. Unsupported trusted binary rendering still requires a separately authorized renderer integration. The existing execution-journal ownership and release limitations in the architecture record continue to apply.

`abstained` and `needs-human` preserve the evidence and summary as terminal outcomes. They do not silently resume or gain permission from a later model response. Human review can establish a new authorized task or resolve an external prerequisite; it does not retroactively turn failed or incomplete evidence into scientific acceptance.

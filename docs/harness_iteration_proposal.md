# Iterative, model-agnostic Harness — architecture proposal

**Implementation follow-up (2026-09-23):** See [the implementation and validation record](HARNESS_ITERATION_IMPLEMENTATION_2026-09-23.md). The original proposal and its historical status below are preserved.

**Status:** proposal only. Read-only review; no code changed and no workloads run.
**Scope:** the execution loop in `apps/proto-workbench/src/main/services/harness-*`, its verification
path, and the evaluation contracts that would measure whether the loop helps.
**Out of scope:** this proposal does not generate or optimize biological parts or sequences, does not
provide wet-lab instructions, and does not alter the existing material eligibility or quarantine
boundaries. The only change near a policy gate is that a gate produces a clean terminal outcome
instead of a retry cycle.

---

## 1. What the current Harness already does well

`harness-controller.ts:56` is already a bounded plan → act → observe → verify loop, and several of the
required controls already sit outside the model's authority.

| Control | Where it lives |
| --- | --- |
| Durable intent → effect → result record | `store.intent()` writes tool/args/effect *before* dispatch (`harness-store.ts:378`); `tool-execution-journal.ts:72` holds the lease-guarded `intent → dispatched → completed \| no-effect \| effect-unknown` machine with digest-checked receipts |
| No replay of unknown writes | `uncertainEffect()` → `reconcile()` → otherwise `TOOL_EFFECT_UNKNOWN` and stop (`harness-controller.ts:96-105`); unknown tools default to `write` (`tool-effects.ts:461`) so adding a tool cannot silently make recovery replay an effect |
| Host-enforced budgets and deadlines | Rounds, generated tokens and active time, with a timer-armed `budgetAbort` and a conservative byte-count upper bound when the provider drops its usage frame |
| Independent verification | `harness_finish` is a *request*; `harness-workspace.ts:296` re-fingerprints deliverables, requires a matching committed digest, and re-runs `verify()` even against a durable success receipt, because the receipt is "evidence of the old state, not authority" |
| Progressive tool exposure, handle-based results | `INITIAL_TOOLS` plus `harness_discover_tools`; `projectToolResult` keeps identity fields and pages large bodies by handle |
| Model-agnostic instance binding | Rebind requires the same model id *and* the same loaded context (`harness-controller.ts:155-167`); `mission-preflight.ts:97` treats `toolCapability: unknown` as a warning, not a block, and never infers capability from a name |

`docs/model-capability-and-evaluation.md` is already explicit that a passed probe certifies one
instance and nothing else, and that no frozen case pack or baseline is bundled yet.

The useful proposal is therefore not "add a loop." It is closing six specific gaps.

---

## 2. Gap analysis (prioritized)

### P0 — There is no abstain path

Terminal states are `completed`, `incomplete`, `cancelled`, `paused`, `effect-unknown`. When
`verify()` fails, the result is fed back and the model tries again until a budget or progress guard
fires; the run then lands in `incomplete` with a failure code, which reads as *the harness broke*,
not *the model correctly determined it cannot establish this*. A weak model has no way to stop on
purpose. This is the largest mismatch with the requirement that the loop expose uncertainty rather
than force a result.

### P0 — Repair budgets do not survive resume

`repairCount`, `repeated` and `lastSignature` are locals in `run()` (`harness-controller.ts:71`).
`recoveryCounters` persist but are never read as a cap. `noProgressRepaired` is partly reconstructed
from `observationProgress.repairIssued`, but output repairs are not. A run resumed N times gets N×
the "one bounded repair."

### P1 — Verification diagnostics are untyped strings

`verify()` returns `string[]`. The model cannot distinguish *missing dependency* ("Required input has
not been read") from *unverifiable-by-software* ("Binary deliverable requires a trusted renderer
receipt; this tool set cannot produce that receipt") from *stale evidence* ("The bound material
snapshot changed"). The second class is permanently unsatisfiable by retry — and the loop currently
invites a retry anyway. This is the mechanism most likely to burn budget for nothing.

### P1 — Conflicting evidence has no representation

`verify()` is a conjunction over `results.filter(r => r.ok)`. Two successful receipts making
incompatible claims about the same path both pass. Nothing detects the contradiction.

### P2 — Tool selection is lexical only

`harness_discover_tools` scores by substring and term overlap and activates the top six. Failed
selections are not remembered; a model that picks a wrong tool can re-activate it repeatedly, since
only argument-identical repeats are caught by the signature check.

### P2 — Nothing aggregates the counters that already exist

`recoveryCounters` and `tokenCountMethod` are in every checkpoint and surface in `project()`, but
there is no export, no frozen task set and no baseline. You currently cannot tell whether the loop
helps.

---

## 3. Proposed state machine

Keep the existing states; add two terminal outcomes and make one class explicit.

```text
queued → preparing → generating → checkpointing → executing → observing
                          ↑                                      │
                          └──────── recovering ←─────────────────┘
                                         │
   observing → verifying → completed
                    │
                    ├→ recovering        (retryable diagnostics, repair budget remains)
                    ├→ needs-human       (NEW: unverifiable by software)
                    └→ abstained         (NEW: model declined, evidence insufficient)

any → paused | cancelled | incomplete | effect-unknown   (unchanged)
```

`needs-human` and `abstained` are **successful outcomes of the harness**, recorded separately from
`incomplete`. They carry the same evidence bundle as `completed`, minus the pass verdict.

A host-scored `blockingClass` on every diagnostic decides the edge:

| Class | Meaning | Loop action |
| --- | --- | --- |
| `repairable` | The model can fix this with another bounded step | back to `recovering`; consumes repair budget |
| `dependency-missing` | A required prior artifact or read does not exist | one targeted hint naming the exact missing item, then `needs-human` |
| `unsupported` | No available tool can produce this receipt | immediate `needs-human`, no retry |
| `stale` | A bound input changed underneath the run | `needs-human`; retrying would re-derive against a moved base |
| `conflicting` | Two receipts disagree | immediate `needs-human`, never auto-resolved |

**Critical rule:** `unsupported`, `stale` and `conflicting` never consume a retry and never generate a
"try again" message. This is what prevents the loop from grinding against a gate.

---

## 4. Tool and checkpoint contracts

### Tool contract

Extends the current `HarnessToolDefinition`. Every field is host-owned.

```ts
interface ToolContract {
  name: string;
  effect: "read" | "write";      // already exists; keep the fail-closed default
  preconditions: string[];       // machine-checkable, host-evaluated before dispatch
  produces: ArtifactClass[];     // what receipts this tool can legitimately create
  idempotent: boolean;           // only idempotent tools may be reconciled by re-read
  costClass: "cheap" | "metered" | "external";
  maxCallsPerRun: number;        // host cap, independent of model intent
}
```

`produces` is what lets the host answer "can any available tool satisfy this diagnostic?" and
therefore emit `unsupported` instead of inviting a retry. The binary-deliverable case at
`harness-workspace.ts:311` is already exactly this judgment, hardcoded in prose.

### Checkpoint contract additions

All of these live in the existing `HarnessCheckpoint`, so they survive crash and resume for free.

```ts
repairBudget: { outputRepairs: number; progressRepairs: number; verifyRepairs: number }; // remaining, decremented, persisted
verdicts: Array<{ round: number; diagnostics: Diagnostic[]; passed: string[] }>;         // verify history, not just the last
abstention?: { reason: string; unmetRequirements: string[]; declaredAt: string };
```

### Diagnostic contract

Replaces the `string[]` returned by `verify()`.

```ts
interface Diagnostic {
  code: string;                  // stable, greppable
  blockingClass: BlockingClass;  // table above
  subject: string;               // path or requirement id
  message: string;               // human text; current strings go here unchanged
  evidenceRefs: string[];        // result handles the host used to decide
  remedy?: { tool: string; reason: string };  // present only when blockingClass === "repairable"
}
```

`remedy` is derived by the host from `ToolContract.produces`. If no available tool produces the
missing class, `remedy` is absent and the class is `unsupported` — the model is never asked to guess.

---

## 5. Context management

The existing strategy is sound. Keep identity-preserving projection (`IDENTITIES` / `RECORD_KEYS`),
handle-based paging, the binary-search truncation that respects surrogate pairs, the indivisible
assistant-call + tool-result tail group, and full preservation of genuine user instructions during
compaction.

Three changes:

1. **Pin the last `verdicts` entry** the way `STATE_PREFIX` state is pinned. Today a compaction can
   drop the failure the model is supposed to be fixing while keeping older, irrelevant reads.
2. **Add a negative-result memory** — a bounded list of `{tool, argsHash, failureCode}` for calls that
   returned `ok: false`, carried through compaction. Prevents re-selecting a tool that already failed
   schema validation with the same shape. Cheap: it is a subset of what `observeHarnessResult`
   already hashes.
3. **Make the memory budget context-aware.** `resultMemory.slice(-24)` and the 18 000-character cap
   are fixed constants tuned for one context size. Scale both from `binding.contextLength` so a small
   local model does not lose its working set to a memory block sized for a large one.

---

## 6. Who decides what

**The model decides:** which deliverables to declare in `harness_plan`; which tool to call next and
with what arguments; when to request completion; when to abstain; how to word summaries.

**Deterministic code decides:** whether a tool exists and is activated; whether arguments validate
(ajv, already); effect classification; whether a write may be dispatched or reconciled; every budget,
deadline and stop condition; whether artifacts exist with matching digests and lineage; each
diagnostic's `blockingClass`; whether `harness_finish` is honored; whether a run is resumable; what
enters context after compaction.

**A person decides:** everything in `needs-human` — scientific validity, whether conflicting evidence
is a real contradiction or a harmless duplicate, whether an `unsupported` deliverable is worth adding
a tool for, and every case where the software checks pass but the claim remains unverified. The
existing eligibility and quarantine boundaries are unchanged and the loop gains no new authority over
gated material.

---

## 7. Failure-mode walkthrough

| Situation | Handling |
| --- | --- |
| **Invalid tool call** | Already correct: an ajv failure is recorded as a durable `ok:false` result with `INVALID_TOOL_ARGUMENTS`, and no intent is registered as dispatched. Addition: the failure enters negative-result memory so the same malformed shape is not re-emitted after compaction. |
| **Missing dependency** | `dependency-missing` diagnostic naming the exact unread path (`verify()` already computes this). One targeted message, one repair, then `needs-human`. |
| **Conflicting evidence** | New check in `verify()`: group successful receipts by `(subject, claim-kind)`; if two disagree, emit `conflicting` and route to `needs-human` immediately. Never auto-resolved, never ranked by recency. |
| **Cancellation** | Unchanged and already careful: `signal.throwIfAborted()` before `harness_finish`, and a *proved* pre-write cancellation is recorded as a durable failed result rather than a false unknown (`harness-controller.ts:289-292`). |
| **Exhausted budget** | Unchanged, plus: a pending write is never started when exhausted (already true at `harness-controller.ts:110`). Exhaustion is reported in its own metric bucket and never folded into "failure." |
| **Plausible but unverified final answer** | The core case. `harness_finish` with clean prose and no artifact lineage already fails `verify()`. The change: once the repair budget is spent, the outcome is `needs-human` with the unmet requirement list attached, not `COMPLETION_UNVERIFIED`. The summary is preserved and clearly labeled unverified rather than discarded. |
| **Weak model, no usable output** | `abstained` if the model calls the abstain tool; `needs-human` if the host exhausts repairs. Either way the evidence bundle is complete and the run is resumable. |

---

## 8. Two implementation slices

### Slice A — abstention and persisted repair budgets

Small. Touches `harness-controller.ts`, `shared/harness.ts`, one renderer status mapping.

1. Add `harness_report_blocked(reason, unmet_requirements[])` to `HARNESS_TOOLS`. It is a `read`-effect
   tool, always active, never counts as progress, and terminates the run in `abstained`.
2. Move `repairCount` / `noProgressRepaired` into `c.repairBudget`; decrement, persist, and read on
   resume.
3. Add `abstained` and `needs-human` to `HarnessState` and to the terminal / non-resumable sets in
   `project()`.

**Acceptance criteria**

- A run resumed five times gets exactly the configured total repairs, not five times that.
- A model calling `harness_report_blocked` terminates in one round with its reason persisted and every
  prior receipt intact.
- No existing test asserting `incomplete` for a genuine failure changes behavior.

### Slice B — typed diagnostics

Medium. Touches `harness-workspace.ts`, `mission-evidence.ts`, and the return type of
`harness-artifact-verification.ts`.

1. Change `verify()` to return `Diagnostic[]`; wrap every existing `diagnostics.push("...")` with its
   code and class. No message text changes — this is mechanical.
2. Classify the three already-known permanent cases as `unsupported` or `stale`: the binary-renderer
   case, the changed material snapshot, and the "cannot reopen" case.
3. Gate the retry message on `diagnostics.some(d => d.blockingClass === "repairable")`.

**Acceptance criteria**

- A task whose only deliverable is a PNG terminates in `needs-human` in one verify cycle instead of
  consuming the full round budget.
- Diagnostic count and class distribution are exportable per run.
- Any unclassified code defaults to `repairable`, so an omission reproduces today's behavior rather
  than introducing a new early-termination path.

---

## 9. Development iteration plan

The evaluation contracts already exist (`ModelEvaluationAttempt`, append-only ledger, separate outcome
dimensions). What is missing is a frozen task set and a baseline, which
`docs/model-capability-and-evaluation.md` states plainly.

1. **Freeze roughly 30 synthetic software tasks** on fixture data only: file reads, patch proposals
   against toy fixtures, report assembly, schema validation, and deliberate impossibles (missing
   dependency, unsupported format, conflicting receipts). Digest the task pack. No task generates or
   optimizes biological content; the impossibles exist to measure correct abstention, not to probe
   gates.
2. **Run direct-model and Harness-assisted arms** over the same frozen pack, same model instance,
   recorded by instance id.
3. **Change one mechanism per iteration.** Slice A alone, then Slice B alone. Never both.
4. **Keep failures, timeouts, cancellations and refusals in the denominator.** The ledger already
   accepts these; the reporting must not drop them.
5. **Apply identical standards to local, open-source and proprietary models.** Evaluate the exact
   model instance by observed capability, failure modes, available permissions and reproducible
   tests. No model category is treated as inherently safe or unsafe.

### Report these separately, never as one score

- Task completion
- Validation pass rate
- Correct abstention (impossible tasks ending in `abstained` / `needs-human`)
- False abstention (possible tasks abstaining)
- Tool calls
- Tokens
- Elapsed wall time
- Duplicate effects (journal entries with identical `arguments_sha256` within one run)
- Recovery outcomes, by counter

---

## 10. Tradeoffs and reasons to stop or simplify

**Tradeoffs**

- Typed diagnostics add a translation layer between existing prose and machine classes. A class that
  is wrong in the `unsupported` direction terminates a satisfiable task early. Mitigated by defaulting
  unclassified codes to `repairable`.
- Abstention can be gamed by a weak model into abstaining on everything. That is why false-abstention
  rate is a first-class metric and is not folded into completion.

**Stop or simplify if**

- Harness-assisted completion on the frozen pack is not measurably above the direct arm at equal or
  lower token cost.
- `harness_discover_tools` activation is not correlated with success — then drop progressive
  disclosure and expose the full tool set.
- `compactHarnessHistory` fires on under roughly 5% of runs — then delete the memory-block machinery
  and fail on context overflow, which is simpler and already the fallback path.

**Do not add** a planner–critic pair, speculative multi-path exploration, or self-consistency voting.
Each multiplies token cost, and none can produce an artifact receipt — the only thing `verify()`
accepts.

---

## 11. Standing caveat

Software success here means artifacts exist with correct lineage and digests. It is not evidence of
scientific correctness and says nothing about the underlying material. The `needs-human` state exists
precisely because that judgment is not delegable to the loop.

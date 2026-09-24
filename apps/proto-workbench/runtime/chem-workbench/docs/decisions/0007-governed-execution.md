# ADR 0007: Governed execution — resolved plans, approvals, and the supervised runner

**Status:** Accepted for bounded source-checkout CLI slices; general M2 gate remains open
**Date:** 2026-09-05
**Depends on:** [ADR 0006](0006-m0-backend-pinning-and-execution-route.md)
**Implements:** Structure Studio roadmap Next 1–3 (plan M2 gate, M3 water slice,
M4 copper batch)

## Context

The Structure Studio delivered read/derive orchestration with draft copper
proposals that were explicitly `draft_not_executable`. The roadmap's Next 1
required the M2 gate: resolved plans, execution approvals bound to exact
content, a reviewed Windows process runner, and negative-test coverage —
before the water (M3) and copper-batch (M4) slices execute real backends.

## Decision

**Resolved plans bind execution to exact content.** `resolved-plan/v1`
records the subject content hash (water geometry) or the full immutable
candidate set (copper batch), the pinned method profile, the worker identity —
first-party script, launcher where applicable, interpreter and lock SHA-256 hashes — resource ceilings (wall-clock
deadline, output byte caps), and the acceptance rule (the −75.1…−74.8 hartree
installation window for water; converged-canonical per candidate for copper).
The plan hash covers all of it; changing anything changes the hash.

**Approvals are user-only CLI actions bound to the plan hash.** `chem approve`
records actor, binding (subject, worker, candidate hashes, ceilings), expiry,
and a launch budget. At submission the runner re-verifies the stored plan
against the complete recomputed plan hash, approval binding and current worker chain.
An explicitly supplied current subject hash is also checked; any mismatch is
`APPROVAL_STALE`. Submissions are idempotent through a submission id derived
from token + plan hash + **launch intent**: the same intent returns the
recorded job and spends nothing; a new intent spends a launch and a spent
one-launch budget rejects new intents.

**The runner is a first-party argv builder with Job Object supervision.** Only
`scripts/worker_{mock,ase_emt,water_psi4}.py` are launchable; model arguments
never reach argv. The Psi4 route goes through the documented launcher. On
Windows every process is created suspended, joins a fresh Job Object
(KILL_ON_JOB_CLOSE), then resumes its initial thread. Assignment failures kill
the suspended process without executing worker code. Deadline expiry or host
unwinding tears down the tree; an owned-job cancel API remains pending.
Pipe capture is bounded while reading; exceeding a pipe or result-file limit
fails the run. File growth is polled, not a disk quota. Per-run scratch and
an allowlisted environment keep routine executions separate.

**Evidence eligibility is structural.** Jobs and results carry
`evidence_eligible`, false by construction for the mock worker. Mock outputs
can never enter scientific evidence. Real results must pass the plan's
acceptance validation (canonical decimals only; non-converged or non-finite
copper candidates are excluded with reasons, never silently dropped; the
ranking is `lowest computed energy among the evaluated candidates under this
profile` and nothing more).

**CLI surface:** `propose-cu` (draft), `propose-water` (pinned geometry
resolve), `resolve` (store the resolved plan), `approve` (user action),
`run [--intent]` (supervised execution). `compute`/`fetch` remain
unavailable.

## Consequences

- The bounded CLI lifecycle works: a mock worker demonstrates the
  authorization lifecycle, and no mock output is scientific evidence. Water
  and copper CLI slices are verified with real executions: water HF/STO-3G through
  the governed chain reproduced the M0 reference
  (`-74.96292824697167` hartree, in window), and the copper batch executed
  0.98/1.00/1.02 with the 1.00 candidate ranked lowest
  (`-0.0049525205258378` eV/atom), exclusions empty, plot data and ranking
  recorded.
- These slices run model-free through the CLI. The roadmap's Next 4 (model
  orchestration with held-out evaluation) and Next 5 (further profiles) remain
  open and unchanged.
- The registry still registers no ComputeAdapter descriptor; execution is
  wired through the governed CLI/store path, and adapter-registry
  computational capabilities remain a separate reviewed step.

## Acceptance correction and remaining scope

The review found and fixed incomplete hash checks, current-worker drift,
post-spawn assignment races, unbounded pipe capture, output-less false success,
premature evidence eligibility, candidate/result mismatch and submission races.
Approval and job state are serialized per store using an OS byte-range lock.
Interrupted reservations fail closed and can consume a launch without executing;
a new approval is needed after review. No automatic recovery/retry is claimed.

The local file store is not an authenticated, tamper-proof authority against its
OS owner. Script/interpreter/lock hashes are not full installed-library, basis,
potential, policy or environment attestation. Broad M2 closure, explicit owned-job
cancellation, CPU/memory enforcement, scratch cleanup, frontend execution/results,
and packaged execution remain open. The UI/model tools still only read or derive.
See [acceptance evidence](../acceptance-2026-09-05-execution.md).

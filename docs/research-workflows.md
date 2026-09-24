# Editable research workflows

Status: implemented; bounded local host, runtime and browser acceptance passed. This is F4 of the
[research upgrade programme](research-upgrade-plan.md), not completion of that programme.

## Architecture decision: reuse the existing Compute execution boundary

### Context

Research projects already retain and reopen Compute runs with input, result and
provenance checks. Researchers need to save a sequence of analyses, bind an earlier
result to a later input, and rerun a changed branch without losing prior outcomes.
Adding a second scientific engine or treating a saved run ID as proof of freshness
would weaken those existing contracts.

### Decision

Add an editable, versioned directed acyclic graph inside the existing Compute
research-project panel. Steps name canonical Compute tools and use their current
input schemas. Literal arguments and typed JSON-pointer bindings are mutually
exclusive for each argument. Bindings define dependencies; card order is only a
display and deterministic scheduling preference. A runtime projection must exist,
match its declared type and satisfy the complete destination input schema.

The host stores definitions, immutable versions, executions, step attempts and
cache records in the same project SQLite database. Definition saves use an expected
revision. A workflow permits one active execution, including across service
instances. Jobs return an ID promptly and can be inspected while computing. Steps
run serially through the existing workspace write queue and canonical Compute MCP
tool, each with a fresh owned sidecar. There is no arbitrary-script step.

Reuse requires all of the following, checked at the time of scheduling:

- Equivalent canonical tool arguments and current file-input bytes.
- A current Python implementation and runtime fingerprint. Unknown execution
  identities or uncontrolled randomness are explicitly non-cacheable.
- The same bound upstream run identities and saved artifact bindings.
- A reopened, verified saved result with current original sources, matching
  retained bindings, and an unchanged execution-time fingerprint.

Generated request filenames and timestamps do not change semantic cache identity.
Actual implementation or environment changes do. Runtime package versions and
dependency metadata identify the inspected environment; they do not attest every
binary in an installation. A completed computation whose source or environment
changes during execution remains visible but is ineligible for reuse.

An explicitly forced step forces its descendants even if values are unchanged.
Other branches may reuse verified results. Failures retain diagnostics and block
dependent steps; independent branches can continue. Cancellation waits for the
owned execution to stop. A later recovery creates a new execution linked to its
parent and preserves every previous attempt. Recovery of nonterminal records
requires proof that the original owner is dead; elapsed time alone is insufficient.
Recovery preserves an earlier explicit force selection and reruns that forced
branch, including any previously completed forced steps.

### Options considered

| Option | Benefit | Reason for the decision |
| --- | --- | --- |
| Reuse Compute and project storage | One scientific implementation and artifact verifier | Selected; adds orchestration without duplicating algorithms |
| UI-only list of tool calls | Small implementation | Cannot provide durable ownership, historical attempts or reliable reuse |
| General workflow engine or arbitrary scripts | Broader scheduling flexibility | Adds a new runtime and authority surface beyond the bounded local research requirement |

### Tradeoffs and consequences

Serial execution and a fresh sidecar per operation cost startup time, but simplify
ownership, cancellation and implementation identity. Conservative invalidation can
rerun more steps than strictly necessary. Reuse is a local optimization, not
scientific validation, signed attestation or the exactly-once effect protocol still
pending under E1. Historical versions and attempts are retained rather than pruned
silently when a limit is reached.

The initial bounds are 16 steps, 40 bindings per step, 50 workflows per project,
100 versions and 100 executions per workflow, a 2 MiB definition and a 4 MiB
execution record. Existing Compute input/result limits still apply. The host owns
database paths, execution identities and fingerprints; renderer requests cannot
supply or override them. The source preview uses the same host service and fixed
loopback/same-origin transport. Static examples cannot claim real persistence.

### Action items and acceptance

Retain focused schema/DAG, immutable-history, cache-invalidation, ownership,
cancellation and renderer tests. Exercise actual Python MCP computations in a
branched workflow, verify the saved files independently, inspect normal and invalid
paths through the browser, and reopen persisted workflow versions after a host
restart. Record build and delivery checks separately. Acceptance artifacts belong
under `build/research-workflows-20260922/`.

## Accepted local scope and retained evidence

The receipt index is `build/research-workflows-20260922/increment-acceptance.json`.
Actual Python MCP runs verified four branched steps, unchanged reuse, parameter
and source-file invalidation, forced descendants, missing projections, blocked
children, retained failed recovery, revision checks and reopening after service
close. Sixteen saved artifact files were independently hash-checked. Inputs were
synthetic numerical controls and RNA count validation; no RNA fit or biological
interpretation was performed for this increment.

The real browser UI checked invalid JSON, a disabled-module refusal, first
execution, verified reuse, historical read-only versions, a missing projection,
cancellation and explicit recovery. The final recovery preserved the forced
branch and produced two new successful runs while retaining its cancelled parent.
Three versions and five UI executions reopened after an actual owned host restart;
saved results were reopened through the existing artifact verifier. Independent
SQLite and artifact checks are recorded separately.

The broader regression passed 131 Node tests and TypeScript. Its first Python
command used an invalid report flag and failed before running tests; that failed
receipt remains unchanged. The corrected selected base-profile command passed
50 Python tests. A later force-recovery fix passed all 16 workflow service tests
and the actual UI path above; the earlier broader receipt is not relabelled as a
test of that final delta. The separate 59-test Python compatibility check overlaps
these suites and is not added to their totals.

The final desktop development build and content checker passed for content ID
`fce3ccc166c21b9774fadb8ae1d7422054c831aaa4fa82c522dfb3e53f99660a`.
Native packaged execution, installation, scientific accuracy, external workflow
engines, parallel scheduling and E1 effect-boundary recovery remain separate.

Implementation stops after this increment at the user's request. Subsequent
open-source research documents propose future work without authorizing or
implementing another feature increment.

# ADR 0005: Workflow Impact Preview and Immutable Branches

- Status: accepted for the local workflow preview and branch prototype
- Date: 2026-09-23
- Scope: U09 and H16–H17 in `OPEN_SOURCE_RESEARCH_BRAINSTORM_2026-09-22.md`

## Run-impact preview

The host builds a bounded pre-run plan from the selected immutable workflow revision. It uses the same topological order and forced-descendant closure as execution. A node is marked reusable only after checking the current request/runtime fingerprint, retained cache record, result binding, artifact integrity, source freshness, and a second fingerprint read. A cache miss, non-cacheable input, or forced node is marked for execution. Downstream requests that depend on an output not available from a verified reusable node are marked conditional; the preview does not invent their future values. It reports changed fingerprint components against a recent successful step receipt where available.

Resource cost is always `unknown` because the current method registry has no verified estimator. The preview hash binds the workflow revision, forced selection, node plan, request/fingerprint/cache identities, comparison warnings, and unknown-cost declaration. Starting requires that hash; the host recomputes the plan and rejects drift. Execution still recomputes source fingerprints before reuse or computation, so a change after the submit check cannot make an old artifact reusable.

## Immutable workflow branches and comparison

Forking a saved revision creates a new workflow ID and revision 1, records the source workflow ID/revision plus a digest of its immutable definition, and leaves all source execution records in place. Workflow-version rows now reject SQL updates and deletes. A branch does not inherit execution results, a conversation, or a continuous goal. Branch comparison opens and verifies both saved runs and reports per-step method identity, top-level argument names, fingerprint-material differences, exact result-byte hash equality, and source-freshness state. It does not assert scientific equivalence, causality, or better quality.

## Limits and remaining acceptance

The implementation has not been behaviorally exercised in this turn. A preview baseline scans at most the eight most recent executions and reports when that limit prevents a complete comparison; this bounds the amount of large execution metadata opened for explanations. That baseline affects the displayed change explanation, while cache reuse still checks the exact cache key and artifact independently. The renderer flow, source-change rejection, repeated bindings from one ancestor, cache corruption, branched historical edits, missing source revisions, concurrent starts, 16-step latency/memory, and desktop reopening still need scoped acceptance. No cost estimate is available. These prototypes do not add external workflow engines.

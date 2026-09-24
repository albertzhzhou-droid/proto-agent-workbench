# ADR 0003: Source-Locatable Compute Values

- Status: accepted for the first Compute result locator
- Date: 2026-09-22
- Scope: U05 and the quantitative-result portion of CROSS-03 in `OPEN_SOURCE_RESEARCH_BRAINSTORM_2026-09-22.md`

## Decision

Each new Compute run writes a bounded numeric-value index into its run manifest. Entries point into `result.json` with RFC 6901 JSON Pointers, retain the JSON scalar type and value, and hash the canonical scalar encoding. The index has a fixed 5,000-entry and 1 MiB ceiling; runs above either limit state the exact indexed and omitted counts and are marked partial.

If an output uses the explicit `proto-agent.quantity.v1` contract, the run validates its unit, quantity kind, entity ID, and relationship to the request's dataset manifest before publishing artifacts. Entity IDs repeated across multiple manifests are ambiguous and rejected when referenced by a typed quantity. Untyped numbers remain locatable, but the index assigns them no unit, entity, or scientific meaning.

The registered `proto_compute_value_read` tool returns one indexed scalar only after checking that the requested result is the named file in `build/compute/<run-id>/`, that the caller-supplied manifest hash matches the current manifest, that the run manifest names the artifact, that the current result-file SHA-256 matches both the caller's expected hash and the recorded hash, and that the indexed scalar matches its value hash. Its response carries the method maturity and review status. These local hashes bind files and values; they are not signatures or scientific validation.

Method maturity remains a separate curated registry. Numerical reference test definitions do not become current-run execution receipts. Runtime availability or successful execution does not promote a method's scientific or domain-validation fields.

## Limits and follow-up acceptance

The value index covers numeric JSON leaves and explicitly typed quantity values only. Free-text scientific claims, source-paper page grounding, method-specific reference datasets, renderer highlighting, and adjudication of scientific interpretation are not implemented here. Index-cap overflow is explicit. The value reader requires the expected result hash and will reject values omitted by a partial index.

Before declaring U05 complete, use controlled negative inputs to verify entity, unit, and coordinate failures across all supported result paths; ensure the UI can navigate from a displayed number to the pointer and source artifact; verify partial indices remain visible; and distinguish software diagnostics from independent numerical-reference and domain-review evidence.

## Consequences

- Any indexed value can be retrieved without asking the model to reinterpret a large result artifact.
- Values can be cited by artifact identity and exact JSON Pointer while method evidence remains attached.
- Untyped output remains numerically locatable but scientifically uninterpreted.
- Large result tables and future scientific claims require separate bounded readers and review surfaces.

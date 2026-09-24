# ADR 0004: Canonical decimal strings and the first typed structure import

**Status:** Accepted for the unreleased alpha increment
**Date:** 2026-09-05
**Depends on:** [ADR 0003](0003-first-format-adapter-cif-probe.md)

## Context

ADR 0003 left `chem convert` unavailable because ChemIR canonicalization
accepts exact integers only: decimal cell parameters and fractional
coordinates could not become typed, hashable values. Binary floats are
deliberately rejected everywhere — they are not deterministic across
platforms and cannot back hash-linked evidence.

A second constraint came from the registry itself: two capabilities sharing
one `(format, direction, ChemIR schema, profile)` coordinate are rejected as
ambiguous, so the probe and the typed import must be distinct profiles.

## Decision

**Decimals are canonical strings, not JSON numbers.** A decimal value is
carried end to end as a string in canonical lexical form: optional sign, no
leading zeros, no exponent, no trailing fractional zeros, plain `0` for every
zero (`chem_workbench.chemir.constraints.canonical_decimal`). The schema gains
`DecimalString`, `DecimalVector3`, and `DecimalMatrix3`; `Lattice.vectors` and
`ExplicitSite.coordinates` use them. Existing artifact loaders keep rejecting
JSON float lexemes; nothing about the exact-integer discipline is relaxed.

**The import capability is `chem.cif.probe.cif-p1-explicit.structure-import`,
profile `cif-p1-explicit-typed-v1`, classification
`SEMANTIC_EQUIVALENT_UNDER_PROFILE`.** It reuses the probe's fail-closed
admission analysis, then emits one `PeriodicStructure` with an exact
orthogonal lattice (`diag(a, b, c)` in Å), fractional sites as canonical
decimals, carried site labels, occupancy exactly 1, and the original CIF text
embedded as the `original` representation with a source content hash. The
equivalence claim covers the profile's fields; anything else stays in the
embedded source and is reported `preserved`, never silently dropped — which is
why the classification is not `LOSSY_WITH_REPORT`.

**Non-orthogonal cells are rejected, not approximated.** Building lattice
vectors from arbitrary angles needs trigonometry and a reviewed algorithm;
`NON_ORTHOGONAL_CELL` (and `NON_POSITIVE_CELL_LENGTH`) fail closed instead.

**`chem convert <file.cif> --output <path>` is live.** It writes the ChemIR
artifact plus a loss report (default `<output>.loss.json`), exits 0 on import,
1 on rejection with a report and no ChemIR, and 3 for a missing `--output`.
Imported documents flow into the existing `inspect` and `review-compile`
evidence paths unchanged.

The manifest's `package_hash` now pins the concatenated bytes of both adapter
modules; `scripts/build_registry.py` recomputes every binding hash.

## Consequences

- Typed explicit structures now exist in ChemIR with deterministic semantic
  hashes; downstream work (slab parents, comparisons) can rely on exact
  decimals without float parsing.
- General triclinic cells, symmetry expansion, disorder, and average-occupancy
  models remain explicitly unsupported pending reviewed profiles.
- The `cif-p1-explicit-v1` (probe) and `cif-p1-explicit-typed-v1` (import)
  profiles stay separate coordinates in the registry, so neither can be
  confused with the other's guarantees.
- The plan's Slice A/B compute gates are still blocked on M0 backend
  compatibility and licensing; this ADR adds no execution capability.

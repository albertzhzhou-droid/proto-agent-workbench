# ADR 0005: Resolved structure imports in .chem compilation

**Status:** Accepted for the unreleased alpha increment
**Date:** 2026-09-05
**Depends on:** [ADR 0004](0004-canonical-decimals-and-structure-import.md)

## Context

The implementation plan requires CLI ingestion to "resolve permitted
source-relative paths, snapshot file bytes, and lower declarations to the same
services used by tool calls." Until now, a `crystal` declaration preserved its
CIF path and always reported `CHM2303` review-required: the source bytes were
never read during compilation, and typed structure data existed only through
the separate `chem convert` path.

ADR 0004 made typed import available through a registered capability, so the
remaining gap is wiring that capability into compilation without weakening the
default offline, source-preserving behavior.

## Decision

**Import resolution is opt-in per invocation.** `chem check` and
`chem compile` accept `--resolve-imports`. Without the flag, compilation is
byte-for-byte unchanged: no referenced file is read.

**Resolution reuses the registered capability unchanged.** For each `crystal`
declaration, the CLI resolves the already-validated portable relative path
against the `.chem` source directory (rejecting traversal and containment
escapes), reads bounded bytes, and runs the exact `chem convert` import. There
is no second parser or a parallel code path.

**Successful resolution enriches the same object and binds the source.** The
crystal payload gains `lattice`, `coordinate_system`, and `sites`; the CIF
content hash is appended to the object's `source_references`, so the semantic
hash covers both the `.chem` and CIF bytes. `CHM2303` is replaced by an info
`CHM2309`. Review packets now bind every recorded source hash, and the parse
observation's evidence list matches them exactly.

**Failures stay honest.** An import rejected by the profile keeps the
preserved source representation and adds `CHM2310` review-required alongside
the original `CHM2303`. An unreadable reference under an opt-in resolution is
an error (`CHM2311`): asking for resolution and not getting it must not pass
silently. Every attempted conversion emits its bound loss report; `chem
compile --output x.json` writes them as `x.json.import-<n>.loss.json`
sidecars.

## Consequences

- `chem check --resolve-imports` on the shipped FCC-copper example now passes
  with zero review-required diagnostics and typed, hash-bound structure data.
- The resolved artifact remains fully inspectable and review-compilable; only
  the evidence surface grows (a second source hash and sidecar loss reports).
- Default compilation stays deterministic and independent of the filesystem
  around the source file; nothing is read without the explicit flag.
- Molecular-representation declarations (`molecule`) are deliberately not
  resolved: no molecular import capability exists yet, and resolution cannot
  imply one.

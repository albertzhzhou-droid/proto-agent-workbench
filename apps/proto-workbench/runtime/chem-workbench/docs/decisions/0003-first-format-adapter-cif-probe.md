# ADR 0003: First repository-owned format adapter — read-only CIF probe

**Status:** Accepted for the unreleased alpha increment
**Date:** 2026-09-05
**Depends on:** [ADR 0002](0002-static-adapter-registry.md)

## Context

`docs/implementation-status.md` gated conversion work on a first
repository-owned, read-only `FormatAdapter` that is reviewed, pinned, added to
the static registry, and covered by a direction-specific conformance corpus and
loss-report fixtures. Until that landed, the shipped registry had to stay empty.

The crystal and surface declarations reference CIF paths that this workbench
preserves but never reads. The plan (Section 7.5, RFC-0004) requires structure
import to be versioned, loss-reported, and fail-closed; nothing may treat a
parser-accepted file as scientific validation.

One hard constraint drives the scope: ChemIR canonicalization in this alpha
accepts exact integers only. Decimal cell parameters and fractional
coordinates therefore cannot yet become typed ChemIR values, so a structure
*import* that emits lattice and site payloads is blocked until the general
quantity work lands.

## Decision

Register and activate the first format adapter: `chem.cif.probe` version
`0.1.0`, capability `chem.cif.probe.cif-p1-explicit.import`, classification
**QUERY_ONLY**, profile `cif-p1-explicit-v1`.

- The adapter is first-party, dependency-free Python in
  `src/chem_workbench/adapters/cif_probe.py`. The manifest pins its
  implementation bytes with a SHA-256 `package_hash`; a conformance test fails
  when the module changes without re-running `scripts/build_registry.py`.
- The profile admits exactly: one data block; six numeric cell parameters; one
  `atom_site` loop with `_atom_site_fract_x/y/z` and `_atom_site_type_symbol`;
  explicit occupancies equal to one (absence is recorded as the CIF default
  with a notice, not silently assumed); identity symmetry only. Everything
  else — multiple blocks, non-identity symmetry operations, partial or unknown
  occupancy, missing type symbols, non-numeric or unknown site values, grammar
  violations — fails closed with a stable loss code.
- Every probe emits a schema-valid `loss/v1alpha1` report bound to the exact
  registered capability hashes. QUERY_ONLY reports carry no output hash and
  resolve as non-publishable and contract-ineligible by design; they are
  evidence of a bounded read, not a conversion contract.
- `chem probe <file.cif>` is the read-only CLI surface. Exit codes mirror
  `check`: 0 admitted, 1 rejected with a report, 2 operational error.
- `chem convert` stays unavailable: no capability admits a structure-emitting
  import until decimal quantities are canonicalizable. This is a dependency,
  not a policy reversal of ADR 0002.

## Consequences

- The shipped registry is no longer empty: one registered, active, enabled
  adapter with `installed_verified` / `experimental` status. External
  descriptors still resolve as unregistered and untrusted.
- Element symbols, occupancy, and symmetry state of an explicit P1 CIF are now
  machine-readable without installing any chemistry toolkit, with loss and
  normalization notices (standard uncertainties stripped, unmapped items
  preserved, occupancy defaulted).
- Reviewing and re-pinning is mechanical: edit the module, run
  `scripts/build_registry.py`, and the corpus must still pass.
- A future structure-import capability is a new registration under the same
  rules; the probe grants it nothing.

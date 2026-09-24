# RFC-0006: Surface and Interface Reaction Representation

**Status:** Draft for alpha implementation
**Target:** Surface and interface extension `v1alpha1` (representation and validation only)
**Last updated:** 2026-09-05
**Decision owners:** Core schema, periodic-structure, and compute maintainers

## Summary

ChemIR gains three preservation-oriented object kinds for the surface and
interface reaction extension described in
`Chem_Workbench_Tool_First_Implementation_Plan.md` (Sections 2.3, 7.2, 7.6, and
10.5): `SurfaceSlab`, `AdsorptionComplex`, and `InterfaceReactionStep`. A slab
is always a derived object carrying construction provenance. An adsorption
complex is a slab plus an explicitly placed adsorbate. An interface reaction
step is declared energy-difference bookkeeping over referenced adsorption
complexes and owns no barrier, rate, or mechanism claim.

This RFC lands the representation and fail-closed validation layer only. No
slab construction, geometry import, placement, execution, or energy evaluation
is performed or claimed.

## Motivation

Surface models are derived structures whose scientific meaning depends on how
they were built. A slab without recorded Miller indices, termination, layer
count, vacuum extent, and construction algorithm cannot be reproduced,
compared, or responsibly used as a calculation subject. Adsorbate placement
and coverage are assertions, not defaults inferred from a structure file.
Interface reaction steps invite the most dangerous overclaim in the extension:
an energy difference being retold as a barrier, a rate, or catalytic activity.

The plan requires these objects to enter through their own RFC with explicit
admission boundaries, so this document fixes the ownership rules before any
adapter or execution profile exists.

## Scope

This RFC defines:

- the `SurfaceSlab` payload and its required construction provenance;
- the `AdsorptionComplex` payload with explicit site, height, and adsorbate
  identity;
- the `InterfaceReactionStep` payload with a closed claim scope;
- source declarations for all three objects in the `chem 0.1` language;
- fail-closed source and artifact validation rules, including the comparability
  gate for reaction steps and the copper-only adsorbate admission for
  calculations;
- the diagnostic code family `CHM25xx`.

It does not define slab construction algorithms, geometry representation,
coverage conventions, transition-state or kinetic profiles, comparison
profiles, execution, or any backend integration.

## SurfaceSlab

The payload records `parent_structure_reference` and a closed `construction`
object: `algorithm`, `algorithm_version`, `miller`, `termination`, `layers`,
and `vacuum` (`value` plus `unit`, whole angstroms). The parent must resolve to
a `PeriodicStructure`. A slab without this provenance is not a calculation
subject, and the compiler emits a review-required diagnostic stating that the
construction is declared but not executed.

The alpha admits exactly one construction, `fcc-cubic-cell-cut` at version
`v1alpha1`, defined for the Miller plane `[1, 1, 1]` only, with 1 to 64 layers
and 1 to 1000 whole angstroms of vacuum. Integer-only lengths are a
canonicalization limit of the exact-integer alpha subset, not a physical
statement; decimal quantities arrive with the general quantity work.

## AdsorptionComplex

The payload records `slab_reference`, `adsorbate_elements` (unique element
symbols), `site` (`top`, `bridge`, `fcc_hollow`, or `hcp_hollow`), and
`height` (`value` plus `unit`, whole angstroms). Site and height are
assertions. Coverage is deliberately absent until a fractional-coverage
convention is separately reviewed; it must not be defaulted.

## InterfaceReactionStep

The payload records `reactant_references`, `product_references`, and the
constant `claim_scope: computed_energy_difference_only`. Both endpoint arrays
must resolve to `AdsorptionComplex` objects, must be disjoint, and must share
one slab. Mixing endpoints from different slabs — which includes different
terminations or thicknesses, since those are slab-level facts — fails closed,
because cross-slab energy differences are incomparable without a separately
reviewed comparison profile.

The claim scope is the encoded form of the plan's rule: a step may be described
as a computed energy difference under a declared profile and nothing else.
Barriers, rates, equilibrium constants, and catalytic-activity statements
require separately reviewed transition-state and thermodynamic method profiles
that do not exist in this alpha.

## Calculation admission

A `CalculationSpec` may target a `SurfaceSlab` or an `AdsorptionComplex`. Both
are classical subjects in this alpha: a finite electronic state cannot be
attached. For an adsorption-complex target, the method must be the admitted
classical name `emt` and the declared adsorbate composition must be copper
only. The ASE EMT calculator exposes parameters for additional elements with
explicit cautions; those parameters are not a workbench profile, so an adsorbate
such as CO is rejected by applicability checks rather than silently evaluated.

Slab-target calculations cannot be composition-checked yet because the parent
crystal remains a preserved, unparsed CIF reference; that check activates with
the first reviewed structure-import adapter.

## Diagnostics

| Code | Meaning |
|---|---|
| CHM2501–CHM2510 | Slab resolution, construction, Miller, termination, layers, vacuum, unit, and not-executed review gate. |
| CHM2511–CHM2519 | Complex resolution, adsorbate identity, site, height, unit, and not-constructed review gate. |
| CHM2520–CHM2525 | Step endpoints, self-reference, cross-slab comparability, and no-energy-evaluation review gate. |
| CHM2530–CHM2532 | Finite state on a classical surface target, unadmitted surface method, out-of-profile adsorbate. |

## Consequences

- The extension enters as data with provenance, not as executed geometry.
- Inspect rejects tampered surface artifacts on the same closed-world terms as
  the core subset.
- Every new example and negative case is deterministic and offline.
- Execution remains blocked behind the M0 compatibility and licensing gates;
  this RFC grants no backend capability.

# RFC-0007: Conditions, unknowns, and task semantics

**Status:** Draft for alpha implementation
**Target:** `chem 0.1` conditions layer, `chemir/v1alpha1` ConditionSet and ComparisonSpec
**Last updated:** 2026-09-05
**Decision owners:** Core schema, workflow, and interface-chemistry maintainers

## Summary

The domain language gains an explicit **conditions** layer and a **comparison
task object**. A calculation or comparison must now declare the conditions it
is asked under: phase, temperature (with unit), and — where the selected
workflow admits them — pressure, solvent/solution environment, total charge,
and spin information. The selected workflow profile defines which fields are
**required** and which are **forbidden**; missing required information fails
closed as an *insufficient-conditions* error (CHM26xx), and no field is ever
silently defaulted. A comparison declares its semantics as data: which kind of
stability, which environment, which reference state, and which method — never
only in prose. Every emitted object separates three validity levels:
**format-valid**, **valid within the model** (requires executed results), and
**experimentally valid** (never claimed by a declaration).

## Motivation

"Compare the stability of two candidates" is not a computable question until
it states which stability, under which environment, against which reference
state, by which method. The research tool catalog confirms that every serious
interface-chemistry workflow (adsorption screening, Wulff morphology, ab
initio surface thermodynamics, Pourbaix, microkinetics) consumes exactly
these dimensions and treats an unstated condition as an error, not a default.
A language model proposing tasks must be forced to surface these fields as
data, so that the host can reject under-specified requests mechanically
instead of debating prose.

## The conditions declaration

```text
chem 0.1

conditions cu111_gas_conditions {
  target cu_adatom_top
  phase gas_solid_interface
  temperature 0
  temperature_unit kelvin
}
```

Field vocabulary (closed; unknown fields are errors):

| Field | Type / unit | Notes |
| --- | --- | --- |
| `target` | reference | Required when the set is used by a calculation or comparison; must match that consumer's subject. |
| `phase` | enum: `solid`, `liquid`, `gas`, `solution`, `gas_solid_interface`, `liquid_solid_interface`, `solid_solid_interface`, `gas_liquid_interface` | Always required; declares the phase state the question is asked in. |
| `temperature`, `temperature_unit` | integer ≥ 0, `kelvin` only in v1 | Declared explicitly; the profile decides whether a non-zero value is admissible. |
| `pressure`, `pressure_unit` | integer ≥ 0, `bar` only in v1 | Forbidden by the 0 K alpha profiles; carried for future thermodynamic workflows. |
| `solvent` | short string | Forbidden by the alpha profiles; required vocabulary for future solution workflows. |
| `total_charge` | integer | Periodic subjects only; finite-molecule charge stays owned by `electronic_state` (duplicate ownership is an error). |
| `spin_multiplicity`, `spin_polarized` | positive integer / boolean | Spin information when the workflow needs it; forbidden under the classical alpha profiles. |

Solute concentrations, activities, and pH are decimal-valued and therefore
deferred with the general decimal-quantity work beyond the integer alpha
subset.

## Workflow profiles decide required fields

The alpha admits exactly two profiles:

- **Classical `emt`** (crystal, surface-slab, adsorption-complex targets):
  requires `conditions` with a matching `target`, `phase` (`solid` for
  crystals and slabs, `gas_solid_interface` for adsorption complexes), and
  `temperature 0`. Forbids pressure, solvent, charge, and spin fields.
- **Finite `hf`** (molecule targets): requires `conditions` with a matching
  `target`, `phase gas`, and `temperature 0`, plus the existing
  `electronic_state` charge/multiplicity. Forbids the same fields as above;
  charge/multiplicity in `conditions` is a duplicate-ownership error.

Missing any required field or the whole `conditions` reference is an
**insufficient-conditions** error (CHM2601/CHM2605), reported with the exact
missing field — never repaired with a default. A field outside the profile is
an error (CHM2604), not a warning, because silently ignoring a declared
condition would misrepresent the question.

## The comparison task object

```text
comparison cu_adatom_site_preference {
  kind stability
  stability_kind adsorption_site_preference
  subjects [cu_adatom_top, cu_adatom_fcc_hollow]
  conditions cu111_gas_conditions
  reference_state "fcc-hollow site of the same slab under the declared profile"
  method "emt"
}
```

`kind` is `stability` in v1. `stability_kind` states *which* stability:
`energy_ordering_under_profile` (lowest computed energy among declared
candidates under the profile — for crystal subjects) or
`adsorption_site_preference` (site-resolved ordering on one slab — for
adsorption-complex subjects sharing a single `surface_slab`). `conditions`
binds the environment; `reference_state` is a required non-empty declaration;
`method` names the profile's method. Every element is data on the object; a
comparison missing any element fails closed as insufficient conditions
(CHM2610), and incomparable subjects (mixed kinds, fewer than two, or
endpoints from different slabs) are rejected (CHM2611) using the same
comparability rules as interface reaction steps.

## Three validity levels

Every conditions-bearing object distinguishes:

1. **Format valid** — parses, type-checks, and satisfies schema closure. This
   is the only level a compilation asserts.
2. **Valid within the model** — the executed computation converged and its
   declared applicability checks passed. Requires run records; in this alpha
   comparisons compile with an explicit CHM2612 notice that model validity is
   unevaluated until results exist.
3. **Experimentally valid** — agreement with measurement under stated
   conditions. Never asserted by a declaration, adapter, or comparison; it
   requires the future reviewed evidence layer. `chem inspect` reports the
   three levels explicitly on every ChemIR document.

## ChemIR mapping

`conditions` lowers to a `ConditionSet` object (closed payload:
`target_reference`, `phase`, and optional `temperature`, `pressure`,
`solvent`, `total_charge`, `spin_multiplicity`, `spin_polarized`).
`CalculationSpec` gains a required `conditions_reference`. `comparison`
lowers to a `ComparisonSpec` object (`kind`, `stability_kind`,
`subject_references`, `conditions_reference`, `reference_state`, `method`).
Reference closure enforces target agreement, subject comparability, and
profile admission on inspection, so tampered artifacts fail closed.

## Consequences

- Existing examples and tests are updated: every calculation now carries an
  explicit conditions reference. This is a deliberate breaking change to the
  alpha language, recorded in the changelog.
- `NEEDS_INPUT`-style rejection becomes mechanical for under-specified
  requests, which is the contract the runtime agent will face through the M2
  gateway.
- Future profiles (solution speciation, Pourbaix, thermodynamic surface
  diagrams) extend the admitted field sets; none of them may introduce a
  silent default.

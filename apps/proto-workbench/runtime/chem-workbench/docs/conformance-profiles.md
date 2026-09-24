# Conformance Profiles

**Implementation status:** Alpha  
**Current conformance:** No release-qualified profile is claimed

Conformance profiles define bounded support. They prevent a parser, adapter,
schema type, or successful example from being advertised as blanket chemistry
support. This document describes the intended profile structure and first
release target; it does not certify that the alpha implementation already meets
them.

## Support labels

Every type and capability scope is classified with one of the following support
labels:

| Label | Meaning |
|---|---|
| `normative` | Part of a named release contract after all applicable schema, corpus, capability, security, and release gates pass |
| `experimental` | An explicitly named unstable scope that cannot be counted as normative and may require migration |
| `deferred` | Outside the current implementation and release boundary |

A label alone does not prove implementation. Actual availability requires a
versioned capability manifest and passing tests for the exact format direction,
dialect, object type, operation, backend, and platform in question.

Adapter availability additionally requires an exact package-owned static
registration, verified manifest and package identity, `enabled` policy state,
`installed_verified` implementation state, and `experimental` or `normative`
conformance. The `0.1.0a2` registry is empty, so no adapter direction is
available.

`import_only` is a direction restriction, not a conformance status. The static
registry uses `unqualified`, `experimental`, or `normative` for conformance and
records import and export as separate direction-specific capabilities. An
import capability never implies export, round-trip, editing, or execution.

## Alpha declaration

The project is currently in alpha. The designated first-release target is
`v1-core-structure-compute`, but it is not release-qualified until all relevant
gates in this document pass. Alpha schemas remain migration-capable; examples,
planned APIs, and documentation are not conformance evidence.

Unknown schema versions must fail closed. Migration between alpha schema
versions must be explicit and tested; a reader cannot silently reinterpret an
unknown version as a supported one.

## `v1-core-structure-compute`

This is the normative **target** for the first software-only release.

### Intended object scope

- `Molecule`
- `Geometry`
- finite `ElectronicState`
- a documented, bounded `CoordinationComplex` subset
- explicit three-dimensional `PeriodicStructure`
- `CalculationSpec`
- `Evidence`

Only the documented subset of each type can qualify. For example, a bounded
coordination profile does not imply support for general excited-state
coordination chemistry, and explicit periodic structures do not imply support
for average occupancy, ensembles, arbitrary disorder, or all CIF semantics.

Other ChemIR design types are not made normative merely because they are
described in the implementation plan or represented by an alpha schema.

### Intended format and compute scope

| Family | First-release target | Required boundary |
|---|---|---|
| SMILES/CXSMILES, InChI, MOL/SDF | Molecular import, normalization, export, and loss reporting | Exact dialect, toolkit version, aromaticity, normalization, stereochemistry, and supported-field policy must be declared |
| CIF | Three-dimensional periodic import/export for lattice, sites, species, occupancy, and a documented symmetry subset | Unsupported dictionaries and semantics are lossy with a report or out of profile; partial occupancy is not normative core v1 |
| QCSchema/QCEngine | Molecular calculation plans, controlled local execution, and normalized results | Requires a pinned real backend and scientific acceptance criteria; QCEngine availability is not calculation success |
| ASE | Atomistic and periodic plans for explicitly supported calculators | Calculators are optional, separately licensed, and accepted individually |

Support is directional. Import, export, semantic comparison, planning,
execution, and normalization must be declared independently.

### Explicit first-release exclusions

The profile excludes:

- magnetic CIF;
- modulated or incommensurate crystals;
- quasicrystals and amorphous bulk models;
- general excited-state coordination chemistry;
- partially occupied structures as normative explicit structures;
- general disorder, defect, and ensemble semantics;
- arbitrary reaction execution;
- procedure execution, platform simulation, and laboratory control; and
- any live device discovery or command path.

An excluded input must be rejected, retained under a clearly non-normative
label, or converted with an explicit loss report according to its declared
adapter profile. It cannot be silently approximated into normative scope.

## Post-v1 profiles

| Profile | Classification and scope | Boundary |
|---|---|---|
| `reaction-record-transform` | Post-v1 | Separates reaction equations, virtual transforms, transform applications, descriptive attempt records, and procedures. ReactionEquation import may appear only as an `import_only` preview before the full profile qualifies. |
| `disorder-defect-ensemble` | Post-v1 `experimental` until its own corpus passes | Keeps average structures, explicit configurations, defect events, ensemble members, occupancy ownership, and sampling semantics distinct. Unsupported average structures cannot become compute-ready. |
| `procedure-draft` | Post-v1, software-only | Allows only bounded logical procedure modeling and abstract simulation. It has no device addresses, platform compatibility claim, or laboratory execution. |

These profiles do not delay the core v1 release and cannot be included in a
core-v1 conformance claim by partial implementation.

## Deferred interoperability

The following capabilities are `deferred` from software-only v1:

- OPTIMADE network query and interchange, except as a separately scoped future
  connector;
- pymatgen utilities and an optional AiiDA workflow bridge;
- ORD reaction records and reaction-transform dialects;
- polymer extensions such as BigSMILES;
- XDL import, export, expansion review, and platform simulation;
- SiLA capability discovery and device communication; and
- vendor- or platform-specific laboratory controllers.

XDL or SiLA documentation and data compatibility must not be interpreted as
permission or capability to control a device. No LabAdapter or `lab_execute`
capability is registered in the v1 distribution.

## Adapter conformance

Each format and each direction is classified as one of:

```text
BYTE_IDENTICAL
SEMANTIC_EQUIVALENT_UNDER_PROFILE
LOSSY_WITH_REPORT
ONE_WAY
QUERY_ONLY
UNSUPPORTED
```

`SEMANTIC_EQUIVALENT_UNDER_PROFILE` is meaningful only when the comparison
names the format version or dialect, parser and writer versions, normalization
profile, aromaticity and stereochemistry policies, numeric tolerances,
supported fields, and allowed loss codes.

Every import and export must produce machine-readable loss information. Metal
coordination, haptic or multicenter interactions, stereochemistry, occupancy,
disorder, defects, source fields, and provenance cannot disappear silently.

No automatic equivalence claim is permitted for different supercells or
disorder models. `BYTE_IDENTICAL` applies to exact bytes, not chemical
similarity. A one-way or lossy path cannot be marketed as round-trip support.

## Scientific and claim boundaries

Conformance means the implementation satisfies a named software contract. It
does not prove that a chemical structure is true, a model is appropriate, a
calculation is scientifically correct, or an experiment is safe or feasible.

In particular:

- `PARSE_VALID` is not chemical correctness.
- `STRUCTURE_MODEL_CONSISTENT` is not proof that the model represents reality.
- `PROCESS_EXITED` is not successful calculation.
- `OUTPUT_PARSED` is not result validity.
- `CONVERGENCE_VERIFIED` is not scientific review or reproducibility.
- `RESULT_VALIDATED` remains bounded by the named result profile, methods,
  tolerances, provenance, and applicability domain.
- No software-only claim is laboratory approval.

The claim DAG, approval invalidation, and typed hash meanings are specified in
[Security and Trust](security-and-trust.md).

## Evidence required for conformance

The `v1-core-structure-compute` target cannot be declared normative until the
applicable evidence includes all of the following:

1. The exact profile and migration policy are versioned and documented.
2. Positive demonstrations and required negative fixtures pass.
3. Parser, schema, source-map, canonicalization, diagnostic, and migration tests
   pass, including byte-identical repeated compilation where required.
4. Every format adapter publishes a direction-specific capability matrix,
   semantic comparator, conformance corpus, and machine-readable loss behavior.
5. One pinned QCEngine calculation and one pinned ASE calculation pass declared
   input, unit, convergence, expected-range or expected-value, tolerance, and
   platform-variance criteria. A fixture, health check, process exit, or
   arbitrary finite output is insufficient.
6. Manifests preserve source, ChemIR, adapter, backend, environment, native
   input, output, result, and typed plan/artifact hashes, together with an
   accurate provenance-completeness state.
7. Timeout, cancellation, missing-backend, changed-executable, malformed-output,
   resource-limit, and interrupted-run recovery behavior passes.
8. Trusted-runner tests cover path escape, environment filtering, network
   policy, startup revalidation, process-tree termination, and resource ceilings.
9. CLI and desktop produce the same semantic and logical-plan hashes for the
   same input; resolved-plan hashes match only under the same frozen execution
   profile.
10. Dependency locks, SBOM, exact-version license register, and third-party
    notices are complete.
11. Final packages pass isolated immutable staging, manifest and module-integrity
    checks, concurrent-builder adversarial testing, post-package hashing, and
    visible desktop QA.
12. `PUBLIC_SANITIZED` is rebuilt from an allowlist and passes a privacy scan
    excluding local paths, identities, logs, credentials, cache, staging, and
    other machine-specific metadata while retaining rights and license fields.
13. No shipped component can discover or command a laboratory device or emit
    `PLATFORM_SIMULATED`, `DEVICE_MAP_VERIFIED`, or any laboratory claim.

Until this evidence exists, the correct status remains alpha and
non-release-qualified, even when individual slices or demonstrations work.

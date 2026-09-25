# Changelog

This file records user-visible pre-release changes. A listed version is a
development milestone, not a claim of release qualification, scientific
validation, trusted execution, or redistribution permission.

## [Unreleased]

### Fixed

- September 13 UTC integrity repair: saved calculation history survives the
  initial compile race; study edits preserve original JSON numeric tokens under
  the existing API; stale or altered mechanism identities are rejected before
  calculation. Interface CSV/JSON now save verified host-record data locally and
  return file receipts, including complete precision and signed zero. Invalid
  imported unit containers produce a clear CSV error while JSON remains available.
- The preceding visual commit `0957a04...` passed Design r1 with 130/130
  first-attempt schemas, 40/40 positive workflows and 90/90 independently correct
  negative explanations. That pass, the earlier full regressions and malformed
  UI records retain their original source binding. The repair has 44 focused
  Python, 52 Design UI, 27 interface helper and 33 workflow checks; actual source
  exports are under independent audit. Full final regression, a rebuilt package
  and new-source model repeats remain pending. See the
  [visual stage record](docs/visual-workbench-stage.md).

### Added

- September 11 Design Studio: prompt-selected organic/inorganic candidate
  workflows, mapped-scaffold enumeration, descriptor constraints and ranking,
  ordered 40-atom multication oxides, and source-bound WebGL views.
- Candidate-bound electrode/electrolyte, catalyst/reactant and solid/liquid
  conditional kinetic models with explicit parameter provenance, conservation
  checks and bounded numerical integration. Supplied-pair comparisons preserve
  shared conditions, objective-specific results and numerical ties.
- Immutable design history, verified raw JSON export/reopening, retained
  rejected and partially completed runs, and English workflow/curve views.
- Complex finite-organic HF/STO-3G plans through the existing isolated Psi4
  supervisor, with source/geometry/profile binding and explicit host approval.
- Frozen Structure and Design evaluation tooling, independent case/reason
  reviews, complete raw provider attempts, runtime identities and functional
  fault/resource evidence. Repaired source passes 806 regression tests and the
  required static checks. Formal model promotion remains open; local
  desktop launch and packaged-backend browser observations retain their
  specific scope in the [stage record](docs/design-and-interface-stage.md).
- September 12 acceptance update: the first Design run retained 40/40 positive
  passes, 45 completed rows, two errors and 83 unrun rows after a user-confirmed
  interruption at 47/130 attempts. The next full run on the same frozen fixtures
  passed 130/130 first-attempt schemas, 40/40 positive workflows and 90/90
  independently reviewed negative responses. This is one scoped pass on frozen
  source `921019a9...`, with matched identity evidence; it does not qualify the
  subsequent visual source or complete model promotion. The packaged UI's separate real model
  call completed all five illustrative modules in 19.2 seconds; the earlier
  90-second timeout remains retained.
- September 12 visual upgrade integrated through a recorded 20-file overlay:
  complete interface
  series/player/exports, declared species graphs, precise 3D/site inspection,
  geometry-bound calculation views, result cards, coordinate comparison and full
  candidate inspection, followed by a viewer-only camera reset/fit repair.
  Independent source/synthetic checks and scoped actual browser evidence cover
  all three interface profiles, exact exports, full-study reopening and revision
  binding. The completed illustrative model study took 18.7 seconds. The prior
  full regression was user-interrupted at 97% with no JUnit result; the separate
  rerun passed all 809 tests in 574.48 seconds. New computation result UI and final source/package/model
  acceptance remain open in the
  [visual stage record](docs/visual-workbench-stage.md).

- September 10 model stage: typed per-object scientific context, constrained
  tool arguments, bounded E4B reasoning, complete provider-attempt observations,
  and evaluation v3 with full frozen denominators and separate model/host scores.
- Independently agent-reviewed 72-case suite, preserved historical comparisons,
  and proposal provenance checks across source, imports, target and parameters.
  The UI links only a matching proposal and displays the selected model name.
  See the [stage report](docs/model-stage-2026-09-10.md) for measured outcomes.

- Governed execution with real backends
  ([ADR 0007](docs/decisions/0007-governed-execution.md); Structure Studio
  roadmap Next 1–3): `chem propose-cu` / `propose-water` / `resolve` /
  `approve` / `run --intent` wire a full authorization lifecycle — resolved
  plans binding exact content and worker identity (first-party script byte
  hashes), user-only approvals with expiry and launch budgets, idempotent
  submissions keyed by launch intent, and a supervised runner that joins every
  worker to a fresh Windows Job Object (KILL_ON_JOB_CLOSE) at spawn with
  deadline tree-teardown and capped, hashed outputs. Mock-worker output is
  structurally ineligible as scientific evidence.
- First-party workers: `scripts/worker_mock.py` (lifecycle demonstrator),
  `worker_ase_emt.py` (copper cell-scale batch, fractional sites preserved
  exactly, energies as canonical decimals in eV/atom), and
  `worker_water_psi4.py` (fixed-geometry water HF/STO-3G through the isolated
  Psi4 environment). Real results: the water slice reproduced
  `-74.96292824697167` hartree (in the declared −75.1…−74.8 acceptance
  window), and the copper batch ranked the unscaled cell lowest at
  `-0.0049525205` eV/atom with empty exclusions.
- The four Structure Studio tools now carry complete output contracts, and
  `invoke_tool` validates its own outputs against them (`INVALID_TOOL_OUTPUT`)
  instead of trusting its own construction.
- The pinned water geometry fixture
  (`examples/molecules/water-hf-sto3g-geometry.json`) used by the acceptance
  plan.
- Conditions, unknowns, and comparison task semantics in the `chem 0.1`
  language ([RFC-0007](docs/rfcs/RFC-0007-conditions-and-task-semantics.md)).
  New `conditions` declarations carry phase, temperature with unit, and the
  workflow-admitted environment fields (pressure, solvent, total charge,
  spin); new `comparison` declarations state which kind of stability, which
  subjects, which environment, which reference state, and which method — all
  as data. ChemIR gains `ConditionSet` and `ComparisonSpec` objects with
  closed v1alpha1 schemas.
- Insufficient-conditions semantics: every calculation must reference a
  matching `conditions` object, and missing required fields fail closed with
  the CHM26xx family (CHM2601/CHM2605 insufficient, CHM2604 outside the
  admitted profile, CHM2603 target mismatch, CHM2610/CHM2611 insufficient or
  incomparable comparison semantics). No field is ever silently defaulted,
  and declared-but-inadmissible fields are errors, not warnings.
- Three-level validity separation: `chem inspect` reports
  `validity_levels` (`format`, `within_model: not_evaluated`,
  `experimental: not_claimed`) on ChemIR documents, and every comparison
  compiles with the CHM2612 notice that format acceptance alone was
  established.
- A researched [tool catalog](docs/tool-catalog.md) of interface-chemistry
  algorithms and serious research tools (adsorption screening, Wulff
  construction, ab initio surface thermodynamics, Pourbaix, CatMap
  microkinetics, Zacros, Bader analysis, PySCF, cclib) with licenses and
  adapter dispositions.

### Changed

- **Breaking:** every `calculation` in `.chem` sources now requires a
  `conditions` reference; all bundled examples were updated accordingly.
  Compile an under-specified calculation and you now get an explicit
  insufficient-conditions error instead of an implied environment.

- The M0 backend gate is closed
  ([spike](docs/compatibility-spikes/2026-09-05-m0-backend-acceptance.md),
  [ADR 0006](docs/decisions/0006-m0-backend-pinning-and-execution-route.md)):
  the locked Windows-native `chemistry` extra (ASE 3.29, QCEngine 0.51,
  QCElemental 0.51.1, RDKit 2026.3.6, pymatgen 2026.5.4, Basis Set Exchange
  0.12) and the isolated conda-forge Psi4 1.11 environment were exercised with
  real checks and reproduced: Cu EMT references, external parsing of the
  bundled CIF fixtures, RDKit identity round trips, QCSchema construction,
  local STO-3G data, and the water HF/STO-3G single point
  (`-74.96292824697167` hartree). The execution route is Windows native with a
  separate quantum environment, and the two acceptance-backend candidates
  (`ase.emt.cu.scan.v1`, `qcengine.psi4.hf_sto3g.smoke.v1`) are pinned. No
  compute adapter, runner, or execution path was added.
- `tests/test_chemistry_acceptance.py`: real-backend acceptance checks that
  run whenever the chemistry extra or the isolated backend environments are
  present and report clean skips otherwise, including a full Psi4 water
  calculation through the documented launcher and an assertion that the
  Workbench environment never imports the quarantined XDL package.
- Resolved structure imports in compilation
  ([ADR 0005](docs/decisions/0005-resolved-structure-imports-in-compilation.md)):
  opt-in `--resolve-imports` on `chem check` and `chem compile`. Each crystal's
  validated portable CIF path is read relative to the source file and run
  through the registered import capability unchanged; typed lattice and site
  data attach to the crystal object, and the CIF content hash is bound into
  `source_references`, the semantic hash, and review packets (which now bind
  every recorded source hash). Successful imports report `CHM2309` info;
  profile rejections keep the preserved representation with `CHM2310`
  review-required; unreadable references fail closed with `CHM2311`.
  Conversion loss reports are written as `<output>.import-<n>.loss.json`
  sidecars. Default compilation reads no referenced file.
- Canonical decimal quantities
  ([ADR 0004](docs/decisions/0004-canonical-decimals-and-structure-import.md)):
  decimals are carried end to end as canonical decimal strings with a fixed
  lexical form (no exponents, no trailing zeros, plain zero). The v1alpha1
  schemas gain `DecimalString`, `DecimalVector3`, and `DecimalMatrix3`, and
  lattice vectors and site coordinates use them. Binary floating-point values
  remain rejected in every artifact and loader.
- The first typed structure import: capability
  `chem.cif.probe.cif-p1-explicit.structure-import` (profile
  `cif-p1-explicit-typed-v1`, classification
  `SEMANTIC_EQUIVALENT_UNDER_PROFILE`), registered and active beside the
  QUERY_ONLY probe. It imports admitted explicit-P1 CIF into a
  `PeriodicStructure` with an exact orthogonal lattice, canonical decimal
  fractional sites, carried site labels, occupancy exactly 1, and the embedded
  original source with a content-hash reference. Non-orthogonal cells and
  non-positive cell lengths fail closed; every probe-level exclusion rejects
  the import without emitting ChemIR.
- `chem convert <file.cif> --output <path> [--loss-output <path>]`: writes the
  ChemIR artifact plus a bound loss report (default
  `<output>.loss.json`), exit 0 on import, 1 on rejection with a report, and
  3 when `--output` is missing. Imported documents work with `chem inspect`
  and `chem review-compile` unchanged.
- The first repository-owned read-only format adapter
  ([ADR 0003](docs/decisions/0003-first-format-adapter-cif-probe.md)):
  `chem.cif.probe` version 0.1.0, capability
  `chem.cif.probe.cif-p1-explicit.import`, classification QUERY_ONLY, profile
  `cif-p1-explicit-v1` — registered, enabled, and active in the bundled static
  registry with its implementation bytes pinned by SHA-256. The shipped
  registry is no longer empty; external descriptors remain unregistered and
  untrusted.
- `chem probe <file.cif>`: a read-only CIF profile probe that emits a
  schema-valid `loss/v1alpha1` report bound to the exact registered capability
  hashes, inspectable with `chem inspect`. Exit codes mirror `check`
  (0 admitted, 1 rejected with a report, 2 operational error).
- A dependency-free bounded CIF 1.1 subset parser with fail-closed admission:
  one data block, complete numeric cell, one explicit `atom_site` loop with
  type symbols, unit occupancies, identity symmetry only. Duplicate items,
  incomplete loop rows, reserved constructs, unterminated strings, multiple
  data blocks, non-identity symmetry, partial or unknown occupancy, missing
  type symbols, and unknown or non-numeric values are rejected with stable
  loss codes; stripped standard uncertainties, defaulted occupancies, and
  unmapped CIF items are recorded as preserved or normalized notices.
- Explicit P1 CIF fixtures for FCC copper and silicon under
  `examples/crystals/structures`, matching the paths referenced by the
  crystal examples.
- `scripts/build_registry.py` to regenerate the bundled registry and recompute
  every binding hash after an adapter change; a conformance test fails if the
  registry pin drifts from the implementation bytes.
- The surface and interface reaction representation extension
  ([RFC-0006](docs/rfcs/RFC-0006-surface-and-interface-reaction-representation.md)):
  `surface_slab`, `adsorption_complex`, and `interface_reaction_step`
  declarations in the `chem 0.1` source language, with closed
  `chemir/v1alpha1` payloads and schemas for `SurfaceSlab`,
  `AdsorptionComplex`, and `InterfaceReactionStep`.
- Construction provenance as a slab readiness gate: algorithm, algorithm
  version, Miller indices, termination, layers, and vacuum extent with an
  explicit unit are required and preserved; a slab without provenance cannot
  become a calculation subject.
- Fail-closed surface validation (diagnostics `CHM2500`–`CHM2532`): dangling
  parents and slabs, unadmitted constructions and Miller planes, non-integer
  lengths, unknown sites and elements, self-referencing reaction steps, and
  finite electronic states on classical surface targets are rejected at the
  source and artifact layers.
- A copper-only adsorbate admission for adsorption-complex calculations:
  out-of-profile adsorbates such as CO are rejected by applicability checks
  instead of being evaluated with cautioned EMT parameters.
- A same-slab comparability rule: interface reaction steps mixing endpoints
  from different slabs (including different terminations or thicknesses) fail
  closed, and every step carries a closed
  `computed_energy_difference_only` claim scope with no barrier, rate, or
  catalytic claim.
- A Cu(111) copper-adatom diffusion example
  (`examples/surfaces/cu111-adatom-diffusion.chem`) and a dedicated offline
  test module covering positive, negative, determinism, review-packet, and
  tamper-rejection cases.

### Security and trust boundary

- The extension is representation-only: no slab construction, geometry import,
  adsorbate placement, calculation execution, energy evaluation, or kinetic
  quantity exists, and surface declarations emit review-required diagnostics
  stating that construction has not run.
- The CIF probe is a bounded local read: it performs no discovery, network
  access, process launch, or third-party import; a QUERY_ONLY loss report is
  not a conversion contract, and `chem convert` remains unavailable.

## [0.1.0a2] - 2026-09-03

### Added

- Strict, closed, versioned adapter-capability, direction-specific
  format-capability, and conversion loss-report contracts.
- An immutable static adapter registry. The registry shipped in this version is
  intentionally empty.
- Deterministic `chem capabilities` JSON by default, with `--json` as an alias
  and `--format text` as a display-only summary.
- Read-only `chem inspect` support for capability, registry, and loss-report
  artifacts.
- Registry-aware inspection states: external schema-valid descriptors remain
  unregistered, untrusted, and inactive; unbound loss reports remain
  non-publishable.
- Read-only inspection compatibility for known `0.1.0a1` review packets while
  newly emitted packets bind the `0.1.0a2` compiler identity.
- [ADR 0002](docs/decisions/0002-static-adapter-registry.md), recording the
  descriptor-only registry and activation boundary.

### Security and trust boundary

- A schema-valid descriptor is not thereby trusted, registered, active,
  installed, reachable, or conformant.
- Capability inventory performs no dynamic discovery, entry-point or
  module-path scan, adapter-implementation import, `PATH` search, dependency or
  service probe, process launch, or network request.
- The adapter protocol is a typed data contract, not an operating-system
  sandbox.
- No format conversion, computation, external fetch, workflow execution, or
  laboratory/device control is available. `chem convert` remains unavailable.

## [0.1.0a1] - 2026-09-02

### Added

- The bounded declarative `.chem` parser, alpha validators, and deterministic
  ChemIR compiler subset.
- Typed exact-source, semantic, and exact-artifact SHA-256 boundaries.
- Deterministic unsigned review packets and read-only self-consistency
  inspection.
- Stable unavailable responses for the planned `convert`, `approve`, `compute`,
  and `fetch` command families.

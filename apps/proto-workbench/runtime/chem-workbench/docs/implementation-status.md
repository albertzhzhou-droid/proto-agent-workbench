# Alpha implementation status

This document describes the September 12 checkout and September 13 UTC integrity
repair status separately from the
broader roadmap in `Chem_Workbench_Tool_First_Implementation_Plan.md`. The current
product includes Design Studio, complex molecular calculation, Structure Lab,
and a configured local Electron preview. The descriptor-only `0.1.0a2` slice and
[September 5 closeout](acceptance-2026-09-05-roadmap.md) are historical increments.
See [Design and interface stage](design-and-interface-stage.md) for current
implementation and acceptance scope. The checkout now includes reviewed result
publication and observation repairs and the integrated V01–V07 visual upgrade.
The earlier repaired source passed all 806 regression tests; the changed visual
source subsequently passed all 809 tests in 574.48 seconds in
`build/visual-full-20260912b.json`, after the retained intentional interruption.
Those full regressions predate the current integrity repair; its complete
regression and rebuilt-package acceptance remain pending. Full model acceptance
remains pending. The prior frozen
formal Structure outcome remains retained without promotion.

The later visual commit `0957a04c79f97b1e7341693f5d0013a4790e4620` also completed
Design r1 with 130/130 first-attempt schemas, 40/40 positive workflows and 90/90
independently correct negative explanations in
`build/design-visual-final-20260912/qwen-r1`. Actual UI work then exposed a
saved-history startup race, loss of original JSON numeric tokens and interface
download requests without confirmed files. That pass and the malformed UI
records are retained as historical evidence; they do not qualify the new source.

The current repair preserves history during initial compilation and numeric
source tokens through the existing study API, rejects stale mechanism identities
before calculation, and saves exact interface CSV/JSON through the local backend
with file receipts. Invalid imported unit containers are rejected for CSV while
their JSON remains available. The scoped independent review at
`build/design-export-integrity-independent-review-20260913.json` records 44
focused Python checks, 52 Design UI scenarios and 27 interface helper tests;
the separate workflow harness reports 33 scenarios. Current source-preview
comparison/partial export artifacts are undergoing independent audit. Full final
regression, rebuilt-package acceptance and new-source model repeats remain open.
See the [visual stage record](visual-workbench-stage.md) for exact scope.

Run the repository gate with [`scripts/verify.ps1`](../scripts/verify.ps1).
Exact local dependency and license evidence, including unresolved
redistribution gates, is recorded in the
[dependency and license register](dependency-license-register.md).

## Implemented now

- An English Design Studio for organic scaffold substitution with MW/logP/TPSA
  screening, ordered multication A2BB'O6 generation and tolerance-factor ranking,
  and real source-bound 3D candidate geometry. Catalog and supplied custom
  mapped scaffolds are supported within the registered structural constraints.
- Three conditional interface models: electrode/electrolyte, catalyst/reactant,
  and solid/liquid. Runs require declared illustrative or supplied parameters.
  Supplied-pair screening compares two to four saved candidate pairs under
  matched conditions, preserves response ties, and ranks the registered
  final-time observable. No kinetic constants are inferred from descriptors.
- Actual module traces, numerical tables and curves, candidate identities,
  parameter provenance, balance checks, and raw study export. **Export study**
  saves a verified record; **Open study** checks its bindings and reopens its
  results and geometry. Direct workflows remain available without a model.
- Structure Studio and Structure Lab provide SMILES/SDF import, explicit CIF
  attachments, RDKit-generated conformers, coordinate revisions, comparisons,
  Cu(111) construction, and admitted copper-adatom geometry placement. Generated
  geometry is labelled separately from supplied coordinates and calculated energy.
- Three registered calculator profiles: complex organic molecular
  `qcengine.psi4.hf_sto3g.organic.v1`, water installation check
  `qcengine.psi4.hf_sto3g.smoke.v1`, and `ase.emt.cu.scan.v1`. The organic profile
  admits bounded, neutral singlet molecules with complete stereochemistry and
  performs real HF/STO-3G single-point calculations through the supervised
  execution service. Source-bound preparation, explicit approval, cancellation,
  retained job history, numerical validation, and evidence export are implemented.
  Water and copper diagnostics do not establish complex-chemistry acceptance.
- The source CLI has `propose-cu`, `propose-water`, `resolve`, `prepare`,
  `approve`, and `run`. The named proposal/prepare wrappers cover water and
  copper; complex molecular preparation and Design workflows use the UI/local
  API. Generic `compute` and `fetch` remain unavailable.
- LM Studio is the only model provider, at `127.0.0.1:1234`. The configured
  default is experimental `google/gemma-4-e4b`. Set `CHEM_MODEL_KEY` before
  launch to select the preserved `google/gemma-4-e2b` baseline, the
  `google/gemma-4-26b-a4b` candidate, or `qwen3.8-27b@q4_k_m`; these are explicit
  allowlisted choices with no silent fallback. Formal acceptance remains pending
  after the prior Structure observations and source repairs. The first Design
  run ended after a user-confirmed interruption. The next full run in
  `build/qwen-design-formal-20260912a-r1` passed 130/130 first-attempt schemas,
  40/40 positive workflows and 90/90 independently reviewed negative responses
  on the earlier frozen source `921019a9...`. Final visual-source acceptance is
  separate and pending. Qwen is not promoted. Model selection grants no additional
  execution authority.
- A configured Windows Electron preview with an owned loopback backend and
  source-bound evidence. It uses installed scientific runtimes; clean-machine
  distribution and relocation remain in the [portable plan](portable-windows-plan.md).

## Current acceptance evidence

The prior frozen Qwen Structure report at
`build/qwen-structure-formal-20260911/report.json` completed 130/130 cases with
stable identities, 128/130 first-attempt schema validity and 36/40 admitted
proposal success. Independent explanation review found 79/82 correct reasons
in `build/structure-abstention-review-20260911-final.json`.

Actual execution in `build/qwen-complex-execution-formal-20260911.json` retained
35/40 completed admitted tasks, below the unchanged 36/40 minimum. Fifteen
calculator submissions yielded 14 accepted real calculation completions.
`plan-complex-03` failed at the result publication/read boundary; its eventual
raw calculation converged, but the observed failure remains in the denominator.
`build/qwen-structure-costs-formal-20260911.json` records incomplete cost
accounting, including one GPU query timeout and missing calculator-phase duration
for the failed harness case. Proposal scores do not replace execution evidence.

The sealed repair review at `build/design-source-repair-review-20260911.json`
binds 166 source entries with identity
`sha256:921019a9449c17618a27a926e14c1a2a28b85e155daff16b7832cb00602d9618`.
It covers committed-result publication, truthful submission/launch observations
and bounded prospective GPU sampling. GPU errors still fail cost completeness;
CPU/RAM observations are retained. Original prompts, scoring, model budgets and
scientific contracts are unchanged. The 16 publication tests and 18
observer/accounting tests passed. The full regression at
`build/design-full-20260911c.xml` then passed all 806 tests in 558.92 seconds,
with no skips, failures or errors and one existing ASE deprecation warning.
`build/design-source-checkpoint-20260911c.json` binds that result, required
static-check evidence and the repaired 166-entry source identity.

The first Design report at `build/qwen-design-formal-20260911c-r1/report.json`
retains 40/40 positive workflow passes. Of 130 cases, 47 were attempted: 45
completed, two errored and 83 were not run. The user confirmed on September 12
that they had deliberately interrupted the service. The incomplete report,
provider errors and full denominators remain unchanged; independent replay is
recorded in `build/design-interrupted-run-review-20260912.json`. This result does
not count as a successful promotion repeat.

The unchanged source identity is
`sha256:921019a9449c17618a27a926e14c1a2a28b85e155daff16b7832cb00602d9618`,
preserved in local commit `925e8701a0e05d2ccf96f4c33cd4e4e9a137c5eb`.
The restored Qwen weights and loaded configuration match the earlier selection;
fresh identity evidence at `build/qwen-design-identity-before-20260912a.json`
observes actual llama.cpp backend 2.37.0, compared with 2.36.0 in the interrupted
run. The next run completed at 14:31:27 UTC on September 12, with all 130
first-attempt schemas and all 40 actual positive workflows passing. Its 20
runtime cases passed with complete resource/token observations. Independent
review found all 90 negative responses semantically correct in
`build/design-abstention-review-20260912a-r1.json`; the existing rationale gate
verified those bindings in `build/design-abstention-review-verification-20260912a-r1.json`.
`build/design-identity-bracket-review-20260912a.json` verifies matching immutable
identity projections before and after the run. This is one scoped Design pass
on the earlier frozen source, not acceptance of the later visual implementation.

The Design cases remain unchanged. Rebound fixtures and all 40 exact
direct repeats are sealed in `build/design-fresh-independent-20260911b-rebind1`.
The same 20 runtime cases passed in normal Windows execution; a first 19/20
restricted-sandbox attempt remains retained with its denied platform-discovery
probes. The provenance addendum records both execution environments. Independent
pre-inference review of these repaired-source bindings is complete in
`build/design-fresh-independent-20260911b-rebind1/independent-review-20260911.json`.
Original authoring dates and prompt-exposure disclosures remain; separate
illustrative UI demo calls are outside this suite. The previous 785-test regression, package,
commit, runtime and contention observations bind the old frozen source; they
are historical evidence and do not establish the same binding after repair.
Formal Structure and Design acceptance, matched E2B comparison, candidate repeats
and model promotion remain pending under the original gates.

The repaired-source one-request/one-complex-job overlap passed with complete
resource observations and cleanup in `build/qwen-model-compute-contention-20260911c.json`.
The repaired preview matched 292 package hashes and passed the direct five-module,
export/reopen and invalid-kinetics UI checks. Its separate real Qwen illustrative
demo call timed out at the unchanged 90-second deadline and remains failed.
After provider restoration, a new real model-directed UI run completed all five
illustrative modules in 19.2 seconds, with eight organic candidates, eight oxide
candidates and three interface models. Its record prefix is `8ff4ab60`; the DOM
and screenshot are retained in `build/ui-acceptance/design-packaged-model-dom-20260912a.txt`
and `build/ui-acceptance/design-packaged-model-organic-20260912a.jpg`.
These separate UI observations do not establish held-out Design acceptance or promotion.

## Earlier implementation increments

The following compiler and adapter notes retain the development sequence from
the earlier alpha slices. Later entries add capabilities to those slices;
their original descriptor-only boundaries do not describe the whole current
Workbench. Dated reports remain historical evidence.

- A dependency-light Python package and `chem` console entry point.
- A bounded lexer and parser for the declarative `chem 0.1` language, including
  source spans, comments, strings, numbers, lists, and deterministic recovery.
- Stable structured diagnostics with severity, code, source location,
  suggestion, optional ChemIR path, and evidence references.
- Fail-closed alpha source validation for `molecule`, finite
  `electronic_state`, source-backed explicit `crystal`, and declarative
  `calculation` blocks.
- Duplicate identifier, unknown kind and field, required-field, reference,
  state/target consistency, finite-state bound, portable CIF path, task,
  property, and method/basis name checks.
- Bundled Draft 2020-12 ChemIR and review-packet JSON Schemas. ChemIR receives
  runtime validation before emission and inspection, followed by narrower
  compiler-subset checks. Review packets receive runtime Schema and binding
  validation immediately before CLI emission and on inspection; the direct
  source-compilation constructor also validates its result, and both
  construction paths have Schema-conformance tests.
- Deterministic ChemIR JSON serialization for the compiler-emitted,
  exact-integer, source-preserving subset, with distinct exact-source, semantic,
  and exact-artifact hashes. Binary floating-point values are rejected; general
  quantity/unit, decimal, and schema-declared set canonicalization is not yet
  implemented.
- A semantic projection in which every currently emitted field participates,
  including all three reference arrays and preserved representation values.
- Typed SHA-256 records at review-evidence boundaries, with explicit digest
  type, algorithm, and lowercase value.
- Strict, closed, versioned contracts for adapter capability descriptors,
  direction-specific format capabilities, and conversion loss reports.
- Registry validation binds each capability to the exact manifest identity and
  hash, limits its operations and profile to the manifest, requires both its
  ChemIR and loss-report schema versions in the manifest, and requires the
  manifest's expected loss codes to equal the capabilities' union. Sorted,
  unique identities and capability IDs are enforced, and duplicate canonical
  `(format, direction, ChemIR schema, profile)` coordinates are rejected as
  ambiguous.
- An immutable static adapter registry and deterministic `chem capabilities`
  inventory. JSON is the default artifact output, `--json` is an alias, and
  `--format text` emits a display-only summary. The registry shipped in
  `0.1.0a2` was intentionally empty; the unreleased increment registers and
  activates the first repository-owned adapter (see ADR 0003 above).
- `check`, `compile`, `review-compile`, `capabilities`, `inspect`, and the
  read-only `probe` command.
- Review packets are closed-schema, unsigned self-consistency evidence, not
  approvals or proof of origin. Inspection recomputes the source-reference,
  semantic, canonical
  ChemIR artifact, and permitted alpha observation bindings, and reports
  `verification_scope: self_consistency` and `signature_status: unsigned`.
- Strict inspection of the subset emitted by this compiler, including
  duplicate-key, duplicate-ID, unknown-field, unsupported-kind, dangling
  reference, malformed source content address, non-finite or floating-point
  number, packet-authority expansion, and hash-binding tamper rejection.
- Strict offline inspection of adapter-capability, format-capability,
  adapter-registry, and loss-report artifacts. Passing inspection establishes
  descriptor validity only; it does not trust, register, activate, import, or
  execute an adapter.
- Registry-aware inspection state. A valid external adapter capability, format
  capability, or loss report that is not the bundled `chem.cif.probe`
  registration is `schema_valid` but not declared, registered, trusted, or
  active. Its loss report additionally has `bindings_valid: false`,
  `contract_eligible: false`, `publishable: false`, and
  `publication_reasons: ["NO_STATIC_REGISTRATION"]`. The exact registry emitted
  by `chem capabilities` matches the bundled trust root with one registered and
  active adapter; its probe loss reports resolve with `bindings_valid: true`
  while remaining non-publishable and contract-ineligible because QUERY_ONLY is
  a bounded read, not a conversion contract.
- A public loss-assessment function that accepts exactly a report and its format
  capability, checks all cross-field bindings, and returns separate
  `contract_eligible`, `publishable`, and reason fields. There is no public
  approvals shortcut. The current function always returns `publishable: false`
  with `PUBLICATION_PATH_UNAVAILABLE`. Dropped, approximated, or
  `review_required` issues also receive
  `LOSS_APPROVAL_UNAVAILABLE:<code>` because no approval ledger is implemented.
- Package ownership is enforced as registry authority. A separately constructed
  registry can be internally valid, but even an exact contained entry resolves
  with `declared`, `registered`, `trusted`, and `active` all false and reason
  `REGISTRY_NOT_PACKAGE_TRUSTED`.
- Draft 2020-12 ChemIR `v1alpha1` schemas for the core object family, a closed
  `review/v1alpha1` packet schema, and offline cross-schema reference tests.
- Positive examples for water, chirality preservation, source-backed silicon,
  and source-backed FCC copper calculation intent, plus a fail-closed
  coordination preview.
- The surface and interface reaction representation extension
  ([RFC-0006](rfcs/RFC-0006-surface-and-interface-reaction-representation.md)):
  `surface_slab`, `adsorption_complex`, and `interface_reaction_step`
  declarations; `SurfaceSlab`, `AdsorptionComplex`, and `InterfaceReactionStep`
  ChemIR payloads with closed v1alpha1 schemas; construction provenance
  (algorithm, Miller indices, termination, layers, vacuum, unit) as a
  readiness gate; a copper-only adsorbate admission for surface calculations
  that rejects out-of-profile adsorbates such as CO; a same-slab comparability
  rule that blocks cross-slab, cross-termination reaction steps; a closed
  `computed_energy_difference_only` claim scope on every step; and the
  `CHM25xx` diagnostic family with positive and negative fixtures.
- The first repository-owned read-only format adapter
  ([ADR 0003](decisions/0003-first-format-adapter-cif-probe.md)):
  `chem.cif.probe` / `cif-p1-explicit-v1` is registered, enabled, and active in
  the static registry with its implementation bytes pinned by hash. `chem probe`
  classifies a CIF against the explicit-P1 profile and emits a schema-valid
  loss report bound to the exact registered capability hashes; admitted sources
  are QUERY_ONLY, and disorder, non-identity symmetry, missing type symbols,
  unknown or non-numeric values, duplicate items, incomplete loops, and
  reserved constructs fail closed with stable loss codes. Explicit P1 CIF
  fixtures for FCC copper and silicon ship under `examples/crystals/structures`.
  `scripts/build_registry.py` regenerates the bundled registry and its binding
  hashes after any adapter change.
- Canonical decimal quantities and the first typed structure import
  ([ADR 0004](decisions/0004-canonical-decimals-and-structure-import.md)):
  decimals are carried end to end as canonical decimal strings (`DecimalString`,
  `DecimalVector3`, `DecimalMatrix3` in the v1alpha1 schemas; lattice vectors
  and site coordinates use them), so binary floats remain rejected everywhere
  while typed exact structures hash deterministically. The registered
  `chem.cif.probe.cif-p1-explicit.structure-import` capability (profile
  `cif-p1-explicit-typed-v1`, classification
  `SEMANTIC_EQUIVALENT_UNDER_PROFILE`) imports admitted explicit-P1 CIF into a
  `PeriodicStructure` with an exact orthogonal lattice, canonical fractional
  sites, carried labels, occupancy 1, and the embedded original source; the
  manifest pins both adapter modules by hash. `chem convert <file.cif>
  --output <path>` writes the ChemIR artifact plus a loss report and rejects
  non-orthogonal cells, non-positive lengths, and every probe-level exclusion
  without writing ChemIR. Imported documents are inspectable and
  review-compilable through the existing evidence paths.
- Resolved structure imports in compilation
  ([ADR 0005](decisions/0005-resolved-structure-imports-in-compilation.md)):
  opt-in `--resolve-imports` on `chem check` and `chem compile` reads each
  crystal's validated portable CIF path relative to the source file, runs the
  registered import capability unchanged, attaches typed lattice/site data to
  the crystal object, and binds the CIF content hash into `source_references`
  (and therefore the semantic hash and review packets, which now bind every
  source hash). Successful imports report `CHM2309` info instead of `CHM2303`;
  profile rejections keep the preserved representation with `CHM2310`
  review-required; unreadable references fail closed with `CHM2311`. Each
  attempted conversion writes a bound loss report as an
  `<output>.import-<n>.loss.json` sidecar. Default compilation still reads no
  referenced file.
- The M0 backend gate is closed
  ([spike 2026-09-05](compatibility-spikes/2026-09-05-m0-backend-acceptance.md),
  [ADR 0006](decisions/0006-m0-backend-pinning-and-execution-route.md)): real
  read-only checks were exercised and reproduced against the locked
  Windows-native `chemistry` extra (ASE 3.29 EMT, RDKit, pymatgen,
  QCElemental, Basis Set Exchange) and the isolated conda-forge Psi4 1.11
  environment (water HF/STO-3G through QCEngine), the execution route was
  recorded as Windows native with a separate quantum environment, and the two
  acceptance-backend candidates for the first planned method profiles were
  pinned with generated smoke references. `tests/test_chemistry_acceptance.py`
  re-runs these checks whenever the environments are present and reports clean
  skips otherwise; the external parsers also cross-validate the bundled CIF
  fixtures. XDL 2.1.0 stays in its isolated, Git-ignored inspection
  environment with no Workbench import path.
- Conditions, unknowns, and comparison task semantics
  ([RFC-0007](rfcs/RFC-0007-conditions-and-task-semantics.md)): a `conditions`
  declaration carries phase, temperature (with unit), and — where a workflow
  admits them — pressure, solvent, total charge, and spin information as
  explicit data; the selected profile decides required and forbidden fields
  and nothing is ever defaulted. Every `calculation` must reference a matching
  `conditions` object (missing or under-specified conditions fail closed as
  CHM2601/CHM2605, never as silent defaults). A `comparison` declaration
  states its semantics as data — kind of stability, subjects, environment,
  reference state, and method (CHM2610/CHM2611 for insufficient or
  incomparable semantics) — and every comparison carries the CHM2612
  three-level validity notice: format-accepted only. ChemIR gains closed
  `ConditionSet` and `ComparisonSpec` objects; `CalculationSpec` carries a
  required `conditions_reference`; `chem inspect` reports `validity_levels`
  (`format` / `within_model: not_evaluated` / `experimental: not_claimed`)
  on every document.
- A researched [tool catalog](tool-catalog.md) of serious chemistry and
  interface-chemistry algorithms and tools (adsorption screening, Wulff
  morphology, ab initio surface thermodynamics, Pourbaix, microkinetics, kMC,
  Bader analysis, PySCF, cclib), each with license and adapter disposition;
  listing installs and licenses nothing.
- Governed execution with real backends
  ([ADR 0007](decisions/0007-governed-execution.md), Structure Studio roadmap
  Next 1–3): resolved plans bind exact subject/candidate content, worker
  identity (first-party script byte hashes), resource ceilings, and acceptance
  rules; user-only `chem approve` binds actor/expiry/launch budget to the plan
  hash; idempotent submission keys include the launch intent; the supervised
  runner launches only first-party workers under a Windows Job Object with
  deadline tree-teardown and capped, hashed outputs; `evidence_eligible` is
  structural and mock output can never be scientific evidence. The water
  HF/STO-3G slice and the copper cell-scale batch now execute model-free
  through the CLI with real results recorded (rankings, plot data,
  exclusions, environment identity).

## Deliberately not claimed

Source compilation preserves chemical representations and calculation intent;
it does not itself perform a scientific calculation or issue general
`STRUCTURE_MODEL_CONSISTENT` or `CHEMISTRY_CHECKED` claims. Supported CIF import,
Structure Lab operations, molecular preparation, and Design modules invoke
their registered tools separately and record the resulting identities and
limitations.

For a packet compiled directly from `.chem` source, `observations` may contain a
bounded `SOURCE_PARSE_ACCEPTED` entry whose `observation_type` and typed evidence
match the packet's source content addresses. It has no prerequisites and is not
a `claim/v1alpha1` ledger record: there is no claim ID, claim registry,
signature, append-only ledger, attestation, or invalidation graph. Every packet
keeps `PARSE_VALID` in `not_claimed`, so no RFC-0002 parse claim is issued. For a
packet built from an existing ChemIR artifact, even the source-parse observation
is absent because the original parser was not re-executed. Packet inspection
establishes internal consistency only; because the packet is unsigned and does
not carry the original source bytes, it establishes neither source availability
nor authenticity.

It does not yet implement signed approval attestations, a general compute gateway,
external data fetching, a general provenance index,
the full RFC-0001 canonicalization domain, the RFC-0002 claim ledger,
general scientific acceptance ranges, or an accepted portable distribution.
The configured desktop preview is implemented. Format conversion exists
for exactly one registered capability (explicit-P1 CIF import); the planned
`compute` and `fetch` command families return a stable unavailable
error without performing a side effect.

The `.chem` surface/interface declaration extension remains representation-only:
declaring a slab or reaction step does not run construction or kinetics.
Separate Structure Lab operations do import and construct geometry, including
the admitted Cu(111)/copper-adatom surface case. Separate Design study records
drive the implemented conditional ODE models and supplied-response comparisons.
Neither geometry construction nor descriptor screening establishes adsorption
energy, reaction barriers, phase stability, or measured catalytic performance.
The current molecular calculator is the registered HF/STO-3G profile, not a
general DFT or unrestricted quantum-chemistry service. General reaction
prediction, inferred or experimentally calibrated kinetics, and arbitrary
atomistic surface calculations are not implemented.

The historical descriptor-only slice performed no adapter invocation,
third-party scientific import, worker launch, or network probe. That is not a
global limitation of the current product: registered imports and numerical
modules load scientific dependencies, supervised execution launches first-party
workers, and model requests reach the configured loopback LM Studio service.
There is no dynamic untrusted plugin execution or generic shell/network action
in those workflows. A valid loss-report contract alone activates no capability;
Python protocols do not constitute an operating-system sandbox.

`contract_eligible` is only the outcome of the implemented local loss-contract
checks. It is not registration, trust, approval, evidence that a conversion
occurred, or permission to publish an artifact.

There is no laboratory procedure executor, device discovery, or device-control
interface in the package.

## Current gate and next work

The current checkout implements complex Structure molecular calculation and
Design Studio generation, all three conditional interface classes, supplied
scenario comparison, real 3D views, and raw export/reopen. Implementation and
direct numerical evidence are distinct from sampled model acceptance.

The MIT license is approved and present. Current package, source and evaluation
scope is recorded in [Design and interface stage](design-and-interface-stage.md);
the [September 5 closeout](acceptance-2026-09-05-roadmap.md) is historical.
The prior formal Structure outcome remains below the required end-to-end result,
with incomplete cost accounting. The repaired source passed 806 regression tests;
the unchanged Design suite's rebound fixtures have independent review. Its first
run remains incomplete after the user-confirmed interruption. The next run passed
all 130 schemas, 40 positive workflows and 90 independently reviewed negatives
on the earlier frozen source. The [visual upgrade](visual-workbench-stage.md)
integrates V01–V07 plus the camera repair, with scoped code/interaction checks
and actual browser evidence for direct/model studies, interface profiles,
exports, full-study reopening and revision binding. The new full regression
passed all 809 tests. New computation result UI and final source/package
acceptance remain open.
Full acceptance and
matched model comparison remain pending.
These remain local alpha artifacts with no public release or scientific
certification. [NEXT_STEPS](NEXT_STEPS.md) preserves the
existing priority order, with portable backend distribution next. XDL and
physical devices remain outside the implemented workflows and this local scope.

# Computation maturity metadata

`compute_maturity.maturity_for(tool_name, metadata)` provides a conservative,
JSON-native scope record for each exact computation ID. It performs no numerical
work, dependency probing, file access or network access. This record supplements
runtime availability and result provenance; it does not replace either.

Every record has `scientific_validation: "not-established"` and
`domain_validation: "not-established"`. These concern validity for a target
research question and dataset. A successful computation, installed dependency,
upstream attribution or caller-supplied metadata cannot change those values.
The helper never promotes methods automatically.

| `method_stage` | Meaning |
| --- | --- |
| `method-implementation` | Conservative default. No specialized assessment is recorded here. It does not mean the method has no tests elsewhere. |
| `numerical-reference-tested` | Explicitly mapped numerical reference cases exist for this implementation. This is a scoped software-evidence label, not a scientific validation or live test result. |
| `demonstration` | The implementation retains known demonstration-level approximations or unresolved inference limitations. |
| `heuristic` | Outputs use an explicitly identified heuristic or partial rule/table adaptation. |

Stages are not an ordered certification ladder. A heuristic can have useful
software tests without becoming a calibrated biological predictor. Unknown
methods always receive the default; names, descriptions and metadata claims do
not trigger inferred promotions.

`applicability` and `known_limitations` explain the scope. `evidence` contains
repository-relative paths, evidence kind, scope and exact test selectors when
applicable. All entries carry `execution_status: "not-evaluated-here"`. They
identify source or test definitions, not their latest execution. Establishing
current test success requires a separate receipt tied to the relevant source,
runtime and artifact hashes. No runtime timestamp or blanket passing status is
manufactured during catalog discovery.

The initial curated inventory covers all eight native statistical methods and
their independent numerical references, with additional inference references
for two-group comparisons and correlations. It highlights these limitations:

- GBLUP uses five fixed demonstration iterations and reports in-sample
  correlation, with no held-out prediction or convergence claim.
- DeepVI fine-mapping retains uncalibrated inclusion scores, possible score
  collapse and raw cumulative credible-set construction. Seed reproducibility
  is documented separately from posterior calibration.
- VCOG grading uses a veterinary numeric-band subset with reported-severity
  fallbacks; it establishes neither human CTCAE grading nor clinical validity.
- Accelerated formulation stability uses fixed illustrative constants and
  scoring thresholds; it does not establish shelf life.
- O-glycosylation hotspot and ABR P1 extraction methods expose their density
  and fixed-window heuristics before a user interprets their outputs.

`tests/test_compute_maturity.py` runs without scientific dependencies. It checks
conservative defaults, exact-ID mappings, resistance to caller promotion claims,
JSON serialization, isolated return values and real evidence file/test selector
references. These inventory tests do not execute or validate the cited algorithms.

The authoritative computation catalog includes the same `maturity` object in
both summary and method-detail records. Each completed run freezes its own
record into `manifest.json` and the returned receipt. Existing provenance binds
the manifest bytes, so editing a saved maturity claim invalidates that manifest's
verification. Numerical result objects and their result hashes retain their
existing meaning; maturity is run metadata rather than a computed measurement.

The Compute method detail shows the stage separately from dependency readiness,
with applicability and limitations. Demonstration and heuristic limitations
start expanded. The evidence inventory explicitly identifies its references as
source/test definitions rather than live acceptance results. Older catalogs
without maturity metadata show that no assessment is available; the UI does not
invent a stronger stage for them.

Dependency-free integration checks exercise full and detailed catalog parity,
dependency-state independence, a real heuristic sequence calculation, saved
manifest/receipt equality and rejection of a changed maturity claim by the
existing provenance verifier.

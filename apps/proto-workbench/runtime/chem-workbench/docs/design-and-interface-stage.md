# Design and interface stage

September 12 status: the earlier repaired source passed all 806 regression tests.
The integrated visual source subsequently passed all 809 tests in 574.48 seconds
in `build/visual-full-20260912b.json`, with no skips, failures or errors.
The prior frozen Structure run is complete,
but its 35/40 observed end-to-end result and incomplete cost accounting do not
establish acceptance. The first Qwen Design run ended after a user-confirmed
interruption; its incomplete result remains retained. The next full run in
`build/qwen-design-formal-20260912a-r1` completed with 130/130 valid first-attempt
schemas, 40/40 completed positive workflows and 90/90 independently correct
negative responses. This scoped pass binds the earlier frozen source
`921019a9...`. The integrated [visual upgrade](visual-workbench-stage.md) has scoped
actual browser evidence, while its new computation result UI and final
source/package acceptance remain open. Final Structure and Design acceptance,
the matched E2B comparison and model promotion remain pending.

The owner expanded the stage on September 10, 2026. The Workbench must generate
and screen organic and inorganic candidates from a prompt, automatically select
predefined computational workflow modules, and support electrode/electrolyte,
catalyst/reactant, and solid/liquid interface simulations. Candidate designs must
be usable in those interface studies. The existing structure and calculation
workflows remain available.

## Product workflow

1. Describe a design objective and choose or supply a study specification.
2. The LM Studio model selects a registered workflow and extracts its bounded
   requirements. Missing inputs and unsupported claims require clarification.
3. The host validates the complete request and runs the selected first-party
   candidate generation, screening, geometry and interface modules within the
   explicit study budget. Models cannot add code, external endpoints or workers.
4. Inspect ranked candidates, actual generated coordinates, response curves,
   exclusions, assumptions and input provenance. Reopen the exported study to
   verify candidate and parameter bindings.

The direct form invokes the same modules and supports model-free parity checks.
Starting a study authorizes only its bounded local design and numerical modules.
The existing separately approved quantum calculation workflow retains its exact
input and worker checks.

## Initial module contracts

| Module | Actual work | Meaning of results |
|---|---|---|
| Organic candidate design | Enumerate bounded scaffold substitutions, sanitize and deduplicate structures, preserve declared stereochemistry, calculate RDKit descriptors, filter/rank and generate seeded conformers | Structural candidates and calculated descriptor screens; no inferred synthesis, toxicity, efficacy or adsorption energy |
| Inorganic candidate design | Enumerate ordered multication oxide candidates with explicit oxidation states and site roles; construct periodic coordinates; evaluate charge and ionic geometry constraints | Hypothetical crystal candidates and a geometric screen; no phase-stability or catalytic-activity prediction |
| Electrode/electrolyte | Evaluate a declared charge-transfer model and its potential-dependent response | Conditional current/rate response under supplied kinetic and concentration parameters |
| Catalyst/reactant | Integrate an explicit adsorption, surface-reaction and desorption model | Conditional site populations and turnover for the declared mechanism; no invented reaction barrier or product |
| Solid/liquid | Integrate a declared adsorption/protonation model with site conservation | Conditional surface populations under the stated liquid and surface assumptions |
| Candidate-pair response screening | Reuse a saved candidate library and run two to four exact supplied pair scenarios under matched physical conditions | Rank final cathodic charge, product-pool concentration or adsorbed coverage; report numerical ties and retain parameter provenance |

Kinetic parameters must carry explicit provenance. Illustrative calibration
fixtures are labeled as such throughout the result and UI. Calculated molecular
descriptors and oxide geometry scores cannot be converted into rate constants,
binding energies, measured data or cross-composition total-energy rankings.

The inorganic candidates are 40-atom ordered double-perovskite prototypes with
explicit oxidation states and A/B/B'/O sites. They are hypothetical structures.
The current reaction recipes use graph-derived catechol/quinone species and a
declared support. A balanced graph transformation does not establish reaction
feasibility, an elementary pathway, an atomistic interface termination or a
measured rate. The inorganic support affects the response only through explicitly
supplied candidate-specific parameters. Equal parameters produce equal model
responses and must not create a chemical winner.

Normal design studies allow three interface simulations; the separately declared
screening budget allows four pair scenarios. Screening requires an existing saved
library, an explicit objective and supplied parameter records. It never fills
missing kinetics from molecular descriptors.

## Current repair and acceptance status

The independent repair review at `build/design-source-repair-review-20260911.json`
records the reviewed 166-entry source identity
`sha256:921019a9449c17618a27a926e14c1a2a28b85e155daff16b7832cb00602d9618`.
Result publication now waits for terminal job status and its committed result
hash. The acceptance harness distinguishes requested submission from an
unobserved launch. GPU observation has a prospective five-second query timeout
and six-second sampler wait; GPU failures retain CPU/RAM observations and remain
errors that fail cost completeness. No failed case becomes a pass. Controller
prompts, scoring, scientific contracts and the 90-second model budget are unchanged.

The 16 publication tests and 18 observer/accounting tests passed. The subsequent
full regression passed all 806 tests in 558.92 seconds, with no skips, failures or
errors and one existing ASE deprecation warning. Evidence is
`build/design-full-20260911c.xml`; required static-check evidence is
`build/repair-static-checks-20260911.json`. The repaired 166-entry identity is
frozen in `build/design-source-checkpoint-20260911c.json`. These checks do not
establish sampled model acceptance.

The retained first Design report at
`build/qwen-design-formal-20260911c-r1/report.json` passed all 40 positive
workflows. It attempted 47/130 cases: 45 completed, two errored and 83 were not
run. The provider returned `MODEL_HTTP_400` with `terminated`, followed by an
unavailable model; the runner stopped with `DESIGN_PROVIDER_OBSERVATION_MISMATCH`.
On September 12 the user confirmed that they had deliberately interrupted the
service. This attribution supplements the retained provider evidence; it does
not change the incomplete report or its denominators. Independent replay and
review are retained in `build/design-interrupted-run-review-20260912.json`.
This run does not count as a successful promotion repeat.

The same Qwen weights and loaded configuration were restored. Fresh identity
evidence in `build/qwen-design-identity-before-20260912a.json` observes LM Studio
0.4.19.0 with the actual llama.cpp backend 2.37.0; the interrupted run used 2.36.0.
The next full run has its own runtime identity and uses the unchanged fixtures.
The 166-entry source identity remains
`sha256:921019a9449c17618a27a926e14c1a2a28b85e155daff16b7832cb00602d9618`,
preserved in local commit `925e8701a0e05d2ccf96f4c33cd4e4e9a137c5eb`.

That run completed at 14:31:27 UTC on September 12. Its report,
`build/qwen-design-formal-20260912a-r1/report.json`, passed all 130 first-attempt
schemas and all 40 actual positive workflows. Independent review of the 90
negative responses found 90 correct, zero incorrect and zero unreviewable in
`build/design-abstention-review-20260912a-r1.json`; the existing rationale gate
accepted those exact response bindings in
`build/design-abstention-review-verification-20260912a-r1.json`.
All 20 frozen runtime cases passed and resource/token observations were complete.
The before/after weight, tokenizer, configuration and runtime projections match,
with a valid capture bracket in `build/design-identity-bracket-review-20260912a.json`.
Report hash: `sha256:e8b210efbfe8ad55ce4e99358ce95c57970a65b2c29574a8258a84fbf68ed223`.
This is one completed Design pass on the pre-visual frozen source. Final visual
source/package binding, required repeats, the preserved E2B comparison and the
remaining Structure gates are still required; no model default changed.

The unchanged 130 Design cases now have new fixtures and 40/40 exact repeated
direct outputs in `build/design-fresh-independent-20260911b-rebind1/fixtures/fixtures.json`
and `build/design-fresh-independent-20260911b-rebind1/direct-audit.json`.
The cross-freeze audit verifies unchanged scientific outputs and explicitly
accounts for regenerated saved-run references and their derived hashes.
The same 20 runtime scenarios passed in normal Windows execution in
`build/design-fresh-independent-20260911b-rebind1/design-runtime-manifest-normal-windows.json`.
The first restricted-sandbox attempt remains 19/20: NumPy platform discovery
attempted three shell version probes, which the audit denied before effect.
Both attempts, their actual execution environments and the original authoring
disclosures are retained in
`build/design-fresh-independent-20260911b-rebind1/provenance-addendum.json`.
Independent pre-inference review of the new bindings is complete at
`build/design-fresh-independent-20260911b-rebind1/independent-review-20260911.json`.
It preserves both runtime outcomes and establishes fixture readiness, not model
competence or promotion.

The repaired-source bounded overlap passed with exactly one model request and
one complex molecular job, 6.2264411 seconds of observed overlap, complete
resource observations and owned cleanup. Evidence is
`build/qwen-model-compute-contention-20260911c.json`. This is a scoped functional
observation, not held-out model acceptance or stress testing.

The repaired preview matched all 292 package file hashes. Its direct UI check
completed five modules, reopened the exported record and retained the invalid
kinetics rejection. A separate real Qwen UI call using the existing illustrative
demo reached the 90-second deadline and remains a failed observation. After
restoring the provider on September 12, a new real model-directed UI run completed
five modules in 19.2 seconds: eight organic candidates, eight oxide candidates
and three interface models, saved as record `8ff4ab60...`. Its DOM and screenshot
are retained in `build/ui-acceptance/design-packaged-model-dom-20260912a.txt` and
`build/ui-acceptance/design-packaged-model-organic-20260912a.jpg`. The new observed
success retains the earlier timeout and is separate from held-out Design
acceptance. The preview's unsigned, installed-runtime and visual inspection
limits remain explicit; formal Design acceptance is pending.

The prior frozen Qwen Structure model report at
`build/qwen-structure-formal-20260911/report.json` completed all 130 cases with
stable identities: 128/130 first-attempt schema validity and 36/40 admitted
proposal success. The final independent explanation review at
`build/structure-abstention-review-20260911-final.json` found 79/82 correct
reasons. Proposal and explanation scores remain separate from actual execution.

The corresponding actual execution record at
`build/qwen-complex-execution-formal-20260911.json` retained 35/40 completed
admitted tasks, below the unchanged 36/40 minimum. There were 15 calculator
submissions and 14 accepted real calculation completions. `plan-complex-03`
failed at the result publication/read boundary. Its eventual raw calculation
converged, but that does not change the retained failed observation or denominator.
Cost evidence at `build/qwen-structure-costs-formal-20260911.json` has
`observed_cost_accounting_complete: false`, including one GPU query timeout and
missing calculator-phase duration for the failed harness case. Repairs apply to
future observations; they do not rewrite this outcome.

## Evidence retained from the prior freeze

The observations below bind the previous frozen implementation. Its source,
package, runtime, contention and commit evidence remains available, but cannot
be described as matching the repaired full-source identity. Applicable bindings
must be reconciled through the existing promotion evidence contract.

- The previous frozen source passed all 785 regression tests, Ruff formatting/lint
  checks and mypy. Its 166-entry code identity matched
  `build/design-source-checkpoint-20260911b.json`; JUnit evidence is
  `build/design-full-20260911b.xml`. One ASE dependency deprecation warning
  remains. Simple installation fixtures do not count toward complex-chemistry
  model acceptance.
- The scientific audit fixed N-substituted pyrrolic nitrogen being misclassified
  as a pyridyl protonation site. Independent finite-pool equilibrium, Nernst,
  conservation and molecular/hydrogen-inventory checks passed.
- Conditional screening preserves ties, requires identical comparison
  conditions, verifies exact candidate bindings and retains completed pair
  evidence if a later solver fails.
- The UI retains failed/rejected records, distinguishes imported evidence,
  clears stale results, and saves local hash-named exports. Source-browser
  export/reopen passed after preserving raw JSON number representations. The
  exact record restored eight organic candidates, eight ordered oxides and all
  three interface responses. A 33-atom organic conformer and 40-atom oxide were
  inspected in WebGL. Changing the selected pair cleared unrelated curves;
  missing kinetics produced a retained rejection. The browser console reported
  no errors or warnings. Evidence and two screenshots are retained in
  `build/ui-acceptance/design-roundtrip-20260911.json`.
- The separate design evaluator preserves raw attempts, complete denominators,
  first-action arguments, actual outcomes and direct parity. Its local success
  additionally requires all 20 injected runtime cases and complete scoped
  security observations. Independent abstention-rationale review is a separate
  gate, since merely selecting `needs_input` does not prove a correct explanation.
- The controller now separates requirements extraction from workflow selection.
  Both sampled stages, their schemas, the single shared repair allowance and the
  90-second routing budget are retained. Host rejections never count as model
  clarification. Uploaded parameter provenance remains unverified.
- September 11 process inspection identified LM Studio 0.4.19.0 and the actual
  loaded llama.cpp backend package 2.36.0. September 12 restoration observes
  backend 2.37.0 as recorded above. Prior 2.34.0 configuration notes are historical.
  Formal runs must bind actual weights, tokenizer, active template and binaries.

The unchanged independent Design suite is sealed at
`evaluations/design-fresh-independent-20260911b.json`: 130 live model cases and
20 separately authored injected runtime cases cover all five lanes. Direct
fixtures are in `build/design-fresh-independent-20260911b/fixtures/fixtures.json`.
All 40 positive cases reproduced exact outputs in repeated direct runs. The
independent review at
`build/design-fresh-independent-20260911b/independent-review-20260911.json`
binds the suite, fixtures and every case, and found no blocking fixture defect.
That review establishes readiness for its original source binding, not model
competence or promotion. No held-out Design suite case has been inferred.
The new direct fixtures and runtime observations are recorded above; their
independent review precedes inference. Original case hashes, authoring dates and
exposure disclosures remain unchanged; the old fixture hash does not identify
the new fixtures. Separate illustrative UI demo calls are outside this suite.

The authoring record at
`build/design-fresh-independent-20260911b/authoring-observation.json` discloses
the earlier router-prompt exposure during contract review and accidental exposure
to the frozen requirements prompt before authoring. The cases were independently
authored against known contracts; no prompt-blind or contamination-free claim is
made. The reviewer retained limits from parallel interface task patterns,
mostly prefilled selectors, explicit top-level authority requests and concentrated
organic size bands. These tests do not establish broad chemistry coverage or
resistance to hidden lower-trust instructions.

The frozen Design runtime suite passed all 20 provider/parser/module/storage
fault cases across five lanes in `build/design-runtime-formal-20260911.json`.
The separately frozen Structure runtime fault suite passed all 20 synthetic cases
in `build/structure-runtime-formal-20260911/report.json`. These suites made no
live model calls or calculator launches; they provide functional fault-injection
evidence rather than model promotion credit or proof of an operating-system sandbox.

The single bounded real model/Psi4 overlap also passed, with 6.22 seconds of
observed overlap, one model request, one owned complex aspirin job, stable
identities and successful cleanup. Evidence is
`build/qwen-model-compute-contention-20260911.json`. This is functional overlap
evidence, not stress testing or held-out molecular competence.

The prior frozen local desktop preview is
`build/desktop-b8d5dc53953e40d0b0b8a2670e3b4650/ChemWorkbench.exe`.
The actual Electron process and its owned loopback backend launched, and all
291 manifest file hashes matched. CUA browser interactions against that
packaged backend completed the five-module study, inspected organic/oxide
geometries and all three curves, retained a missing-kinetics rejection, and
reopened the exact exported record. Evidence is
`build/ui-acceptance/design-packaged-observation-20260911.json`.
The interaction surface was the in-app browser; native-container visuals and
interaction equivalence remain unverified because native computer APIs were
unavailable. This unsigned preview references installed scientific runtimes and
does not establish a clean-machine installation or relocation result.

Local commit `162bff37c41c15704e335a73fe7fd4c77593277a` preserves the prior frozen
implementation and earlier project baseline. Both author and committer are
`Albert_Zhou <albertzhzhou@gmail.com>`. Independent verification matched all 165
committed source files and the synthetic vendor index, and confirmed that the
then-current 166-entry identity remained frozen. It does not contain the later
publication and observation repairs. Evidence is retained in
`build/design-commit-observation-20260911.json` and its scoped correction,
`build/design-commit-observation-20260911-addendum.json`. The addendum establishes
the committed-source check without imposing a clean-worktree requirement on
unfrozen documentation. No remote operation was performed.

## Preserved development history

The earlier 699-test regression preceded the final export, screening-retention
and evaluator-audit changes. The 785-test run above supersedes it for the prior
frozen source; the repaired source has the separate 806-test result above.
Browser JSON number normalization exposed the export/import
defect; the completed raw-text round trips above verify its correction.

Observed development runs remain retained, including failed attempts. Qwen's
first expanded run completed 11/18. Its first two-stage run completed 17/18;
the remaining failure confused screening newly generated libraries with
comparing existing kinetic scenarios. Gemma E4B's observed runs completed
11/18, 10/18 and 8/18 under successive development contracts. These are
development observations, not a matched model comparison or promotion score.

The final targeted development check passed all three known cases: generating
both libraries and completing conditional comparisons of two and four supplied
catalyst pairs. Recorded total times were 52.66, 65.77 and 78.41 seconds under
the existing shared 90-second routing deadline. Evidence is
`build/design-development-b28a750278004b18bdf170042f240d6e`.
These observations use Qwen with one parallel slot and speculative decoding
disabled; they are development evidence. Earlier trials with different loaded
configuration or per-stage timeouts remain retained and are not matched runs.

## Remaining acceptance work

1. Complete full acceptance on the repaired frozen source. Use the independently
   reviewed new bindings of the unchanged Design cases for held-out inference,
   compare the candidate with the preserved E2B baseline on identical
   fixtures and budgets, and complete the candidate repeats. Formal Structure
   and Design acceptance and model promotion remain pending.
2. Inspect every retained failure and abstention explanation, preserve complete
   denominators, verify model/runtime identities and resource/cost accounting,
   and reconcile the results with every original promotion gate. The completed
   direct, runtime, overlap and commit checks do not replace model evidence.
3. Reconcile UI, package, regression, supervisor, contention and commit evidence
   with the final model reports and repaired code identity under the existing
   promotion criteria. Historical bindings do not establish a match to repaired
   source, and these observations do not substitute for actual model runs.
   Preserve scientific inputs and validators.

Unmet original gates keep acceptance open. Clean-machine installation,
relocation and public release remain separate from this installed-runtime preview.

## Acceptance requirements

- Organic positive cases use connected, structurally complex molecules with at
  least eight heavy atoms and at least two substantive structural features.
  Several independent scaffold families and size bands must be represented.
- Inorganic positive cases use genuine multication compositions with at least
  four elements, explicit crystallographic site roles and nontrivial periodic
  coordinates. Elemental copper and simple binary installation fixtures do not
  count as design acceptance.
- Each interface class is exercised with candidate-bound complex organic and
  inorganic subjects, declared model parameters, numerical convergence checks,
  applicable conservation checks and independently checked limiting cases.
- A design is successful only if candidate generation, filtering/ranking,
  parameter binding and the requested numerical modules actually complete.
  Selecting a plausible tool name alone is insufficient.
- Prompt routing uses fresh independently authored scenarios after the code and
  tool contracts are frozen. Original model-promotion thresholds remain: 95%
  first-attempt valid structure, 90% admitted end-to-end completion and 95%
  correct clarification/abstention, with all mandatory boundary regressions.
- Preserve observed development attempts and failed evaluations. Compare the
  stronger candidate against the preserved E2B weights under matched tasks and
  budgets, repeat frozen candidate evaluations, and retain resource/cost evidence.
- Native acceptance includes English UI, real WebGL coordinates, changing the
  selected candidate without stale results, all three response views, invalid
  inputs and export reopening. Local package evidence does not establish clean
  machine installation or a public release.

## Existing evidence reused

The previous calculation controller now separates requirements extraction from
tool selection and binds the result back to the source and approved workflow.
The established regression suite passed 513 tests before this extension. A
complex aspirin HF/STO-3G calculation completed through the isolated Psi4 worker.
Qwen's twenty observed development tasks passed after the schema/repair changes;
these tasks are development evidence, not held-out promotion evidence.

## Technical sources

- [RDKit reaction and enumeration API](https://rdkit.org/docs/source/rdkit.Chem.rdChemReactions.html)
- [pymatgen core and ionic-radius API](https://pymatgen.org/pymatgen.core.html)
- [SciPy initial-value integration](https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.solve_ivp.html)
- [Cantera electrochemical mechanism example](https://www.cantera.org/3.2/examples/input/lithium_ion_battery.html)

Sources guide the reviewed equations and toolkit interfaces. They do not supply
unmeasured parameters for generated candidate chemicals.

# Structure Studio acceptance — September 5, 2026

## Scope

This increment implements the requested English UI, real coordinate viewer,
LM Studio Gemma 4 E2B proposal orchestrator and initial bounded design proposals.
See [the follow-up queue](structure-studio-roadmap.md) for computation, design
execution and model promotion gates that remain incomplete.

## Live evidence

- LM Studio `/api/v1/models` identified `google/gemma-4-e2b@q8_0`, Q8_0,
  loaded instance `chem-gemma-4-e2b`, 8192 context. The local model was actually
  loaded and called; no substitute or remote provider was used.
- A real E2B copper request called `plan_cu_lattice_scan` and returned a draft
  proposal at 0.98, 1.00, 1.02 in 1.72 seconds for the recorded API smoke run.
  Record: `build/ui-acceptance/gemma-e2b-live.json`.
- The browser independently executed the same objective, rendered the successful
  host tool call and candidate controls, and displayed the 1.02 candidate cell
  as 3.687 x 3.687 x 3.687 angstrom. It remained marked proposed, not simulated.
- A second real E2B request inspected water using `object_inspect`, returning
  REPORTED in 1.31 seconds. Record: `build/ui-acceptance/gemma-e2b-water-live.json`.
- The E2B metadata reports `trained_for_tool_use: false`. Strict JSON action
  sampling and independent host validation are used. An initial malformed final
  action was rejected; action-specific sampling schemas were then tightened.
  This is integration evidence, not a held-out model reliability benchmark.
- Copper CIF import produced 4 unique sites and 32 atoms in display copies;
  water produced 3 atoms and two graph-derived bonds; each chiral example
  produced 12 atoms. Unsupported coordinates remain unavailable.
- The browser showed real atom `site4@110` at (5.4223, 5.4223, 0) angstrom and
  a selected pair distance of 5.1122 angstrom, explicitly Cartesian rather than
  minimum-image.
- Candidate selection, representation switching and source invalidation were
  exercised through the UI. Application-owned UI source contains no CJK text.
- Browser PNG export saved an actual 1238 x 720 image under
  `build/ui-exports/02514b7c351fe11cd3eb53f6da036a99d1151ac40be4e67af1fe1a829ca787ff.png`.
  It was independently reopened as an image; its file SHA-256 matches its name.
  The direct data-URL download had no observable in-app download event, so the
  final exporter uses a bounded, content-addressed local PNG store and URL.

## Automated checks

The focused geometry, gateway, controller and HTTP checks passed. They cover
source-derived lattice coordinates, deterministic seeded molecular geometry,
missing-coordinate rejection, source/attachment hash invalidation, invalid
scales, foreign references, forbidden authority arguments, unsupported subjects,
model/direct proposal parity, model offline behavior, single-request budgeting
and rejected-call stop behavior. Controller tests using model doubles are
explicitly labeled as mocks and do not count as live model evidence.

A full gate before the PNG persistence adjustment passed 247 tests, Ruff and
strict mypy, with one ASE/NumPy deprecation warning and no skips. The final gate
result is recorded below after the last server/export changes.

## Limitations

No molecular/periodic energy run is launched from this UI. Draft scales have no
calculated energies or ranking. The installed QCEngine/Psi4 and ASE/EMT checks
remain environment smoke tests, not authorization to execute through Workbench.
No surface construction, empirical-structure deposition claim, chemistry
certification, pressure testing, installer verification or accessibility
conformance is claimed. The source-checkout server remains a local preview.
Model weight hashes and complete runtime/template fingerprints must be pinned
before model promotion. Historical generic review-packet wording about inactive
adapters has not been rewritten and is not used for live capability discovery.

## Upstream references

The local viewer uses [3Dmol GLViewer](https://3dmol.org/doc/GLViewer.html).
The model transport follows [LM Studio structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output).
Runtime inference and rendering have no CDN or cloud fallback. Dependency
version, upstream archive integrity and license copies are recorded in the
[viewer dependency note](viewer-dependency.md).

## Final gate

`scripts/verify.ps1`: **250 passed, no skips**, one existing ASE/NumPy
DeprecationWarning, 72.20 seconds. Ruff formatting/lint and strict mypy passed.
The English 390 x 844 layout was visually checked and the browser viewport
restored. The local server and the requested E2B instance were left available
for user acceptance; no unrelated model or application was stopped.

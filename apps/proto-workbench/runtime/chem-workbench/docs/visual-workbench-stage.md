# Visual workbench stage

Status: V01–V07 were integrated from
`build/visual-workbench-upgrade-20260912` through a recorded 20-file overlay,
followed by a viewer-only camera reset/fit repair. Independent source and
synthetic interaction checks passed, and retained actual browser evidence now
covers direct/model studies, all three interface profiles, coordinate exports,
study reopening, camera resets and revision binding. The full regression rerun
`build/visual-full-20260912b.json` passed all 809 tests in 574.48 seconds.
Those checks bind the source before the September 13 UTC integrity repairs
described below. Full regression, final package/source acceptance and formal
model promotion must be repeated or rebound for the repaired source.

## September 13 UTC integrity repair

The visual source preserved in commit
`0957a04c79f97b1e7341693f5d0013a4790e4620` completed Design r1 at
`build/design-visual-final-20260912/qwen-r1/report.json`: 130/130 first-attempt
schemas, 40/40 actual positive workflows and 90/90 independently correct
negative explanations. The report hash is `d2cb670e...`; the full explanation
review is `build/design-visual-final-20260912/qwen-r1-abstention-review.json`.
This remains a historical pass on that commit. It does not qualify the current
repair or satisfy a new-source candidate repeat.

Subsequent actual UI acceptance exposed three defects: initial compilation could
invalidate the asynchronous saved-history list; browser serialization changed
hashed numeric tokens such as `1.0` to `1`; and interface Blob export clicks
reported a download request without producing a confirmed file. The repairs
preserve history across the startup race, retain original numeric tokens through
native JSON source handling under the existing run API, and check the exact
mechanism hash and registered mechanism before any solver call.

Interface CSV/JSON now save through the local backend using only the verified
study reference, result hash, format and selected sample index. Receipts identify
the saved path, file hash and row count; all retained values, units and signed
zero come from the host record. A successful retained result in a failed study
remains exportable. Invalid imported unit containers produce a clear CSV error;
JSON preserves their original metadata. Imported provenance remains unverified.

The scoped independent review is
`build/design-export-integrity-independent-review-20260913.json`, with review
hash `sha256:a35f17128c4308e5fd94ccfe0e5fa204892603cff7cb0c35498c1b3b9fb95002`.
It records 44 focused Python checks, 52 Design UI scenarios and 27 interface
helper tests. The separate workflow harness reports 33 scenarios; the review
explicitly excludes its author's saved-history fix from independent credit.
These retained-data and synthetic checks are not full regression or live model
acceptance.

The repaired source preview has produced three supplied-pair ties and a retained
partial-result export; the independent file/DOM audit under
`build/ui-acceptance/precision-repair-20260913` is still in progress. The earlier
malformed comparison/partial records under the `d724...` package and their
failed hash checks remain preserved. New full regression, a rebuilt package
with actual export/reopen acceptance, and final-source Structure/Design repeats
and matched E2B comparison remain pending. No gate or scientific scope changed.

The preceding model run, `build/qwen-design-formal-20260912a-r1`, completed with
130/130 valid first-attempt schemas, 40/40 actual positive workflows and 90/90
independently correct negative responses. Its identity bracket passed. That
result binds the earlier source
`sha256:921019a9449c17618a27a926e14c1a2a28b85e155daff16b7832cb00602d9618`;
it does not qualify the changed visual source. See the
[Design and interface stage](design-and-interface-stage.md) for the report and
review receipts, preserved interruption and remaining model gates.

The expanded objective requires a workbench part for every implemented calculation and product. Existing structural coordinates should be inspectable at full available numeric precision. Scientific method limitations and raw evidence must remain visible.

The synchronized reaction player traverses actual solver sample indices, with
exact time and numerical state inspection. Its spatial encoding has a legend
and an explicit scope. The current models do not predict atomistic trajectories,
optical spectra or measured material colors. Full stored numeric precision and
rendering resolution are reported separately from scientific accuracy.

## Existing foundation

Design Studio already has actual organic conformers, ordered oxide cells, ranked candidate tables, selected-pair conditional response charts, module state, evidence exports and reopen. Structure Studio already has imported/generated/edited geometry, a coordinate editor, approved calculation controls, energy results and calculation history. The upgrade extends these existing surfaces.

## Implemented coverage and acceptance criteria

The following implementation is integrated in the checkout. The acceptance
criteria remain the browser and final-package checklist; the scoped evidence
below closes only the observations it explicitly records.

### V01 Expose all computed interface observables (P1)

The observable selector exposes every returned non-time series: eight electrode,
nine catalyst and ten solid/liquid variables, with the exact returned units.
Charts, full-precision tables, selected-time summaries and CSV/JSON export use
the retained samples. Play/pause/reset and keyboard stepping advance exact
sample indices. Catalyst views default to product-pool concentration. Signed
current, charge, flux and reservoir exchange remain signed, including negative
zero in exports. Pair/profile/input changes dispose the previous player.

The isometric scene encodes aggregate occupancy with 60 rounded glyphs and an
explicit palette/position qualifier. Waiting requests show elapsed wall time
and an awaiting-result state; they do not show a conversion percentage before
solver samples arrive. Playback display rate is separate from solver time.
Imported time labels retain their supplied units, and playback requires the
expected `s` unit without silently converting values.

Acceptance:

- All numeric columns of each of the three existing result schemas selectable and represented with returned units.
- Catalyst product pool and product coverage remain distinct; electrode reduction charge/current retain sign; zero and negative series render correctly.
- Pair/profile/input switch and rejected or partial run clear or retain only exact applicable outputs.
- Exported timestamps, rows, units, candidate hashes and result hash match saved record; no fabricated intermediate samples.

### V02 Make derived species and products inspectable (P1)

Species cards use the supplied graph atoms/bonds, formula, charge, radical count,
role, site count and state-column mapping. Stoichiometric controls link every
declared reaction participant to its card. Explicit hydrogen atoms can be shown;
stereochemical identity remains in canonical SMILES. The layout is a connectivity
diagram and does not claim optimized product coordinates or a reaction trajectory.

Imported previews are bounded before layout: 32 species, 256 atoms and 1,024
bonds per graph, 64 reaction steps with 32 participants per side, and 80 layout
iterations. Oversized or invalid previews are explicitly unavailable; full raw
metadata and solver values remain accessible. No partial graph is presented as
the complete supplied graph.

Acceptance:

- Semiquinone radical anion, ortho-quinone and protonated site display exact bound graph identities, charges and radicals.
- Special electron/vacant-site states cannot be rendered as molecular coordinates.
- Graph/site IDs link to exact state columns; product pool does not imply measured yield or feasibility.

### V03 Improve faithful 3D inspection and numeric precision (P1)

The viewer retains unrounded source coordinate arrays and exposes exact atom/site
coordinates, oxidation and sublattice metadata, cell vectors and Cartesian
measurements. CSV/JSON preserve stored values and signed zero. Distinct conventional
element colors, projection, lighting, expanded-view and higher-resolution PNG
controls are present. Sphere radii and colors are labeled as display conventions.
Imported atom/bond/repeat bounds are checked before drawing. Retained browser
exports now verify a 40-atom oxide and a 33-atom organic view, with a valid
2048 × 1040 PNG after the camera repair. Final packaged rendering remains open.

Acceptance:

- A multication oxide exposes A/B/Bprime/O identity and oxidation state on exact site picks; distinct elements are distinguishable.
- Coordinates, bonds, atom count and periodic vectors round-trip unchanged in all styles; displayed decimal controls do not mutate data.
- Full-precision inspection and coordinate export agree for a complex stereochemical organic and 40-atom oxide.
- WebGL loss and unavailable geometry never leave an enabled stale export or false geometry claim.

### V04 Bind every requested view and calculation to the displayed geometry (P1)

Model previews select the requested object and exact geometry hash. Calculation
controls compare the visible coordinates, cell and scale with the recorded
inputs; historical mismatches remain readable but cannot approve or run.
Structure Lab revision selection and mode restoration now keep the coordinate
editor, mutation parent and viewport on the same revision. Late asynchronous
results cannot restore a view invalidated by a newer input.

Acceptance:

- Two compiled molecules: request preview of the second while first is selected and assert viewport subject/hash switches correctly.
- Import/edit lab coordinates then prepare calculation: exact rendered and approved geometry agree or operation clearly reports unsupported binding before approval.
- Reopen a historical calculation with different source or geometry: evidence remains readable, but no unrelated structure is presented as its input.

### V05 Make computation outcomes readable beyond scalar/raw evidence (P2)

Calculation result cards expose the retained energy string, convergence, method,
basis, duration and input/output evidence. Failed results and excluded scan
candidates keep their recorded reasons. Scan rows can display their exact
recorded scaled-coordinate input. Unsupported orbital, force and trajectory
results are not constructed.

Acceptance:

- Actual accepted complex molecular energy string shown without truncation with exact method and geometry reference.
- Nonconverged/failed run has no successful energy card; rejected scan candidates retain their reasons.
- A computed scale row previews that exact candidate and marks calculation scope.

### V06 Visualize the existing geometry comparison result (P2)

The existing geometry comparison now has a dedicated RMS/maximum-displacement
summary, a full per-atom Cartesian delta/distance table and a bar plot, bound to
the parent and revision IDs. It preserves the raw-coordinate comparison scope:
no alignment, minimum-image adjustment or molecular trajectory is inferred.

Acceptance:

- Known coordinate revision displays correct raw Cartesian RMS and maximum displacement.
- Atom-ID/composition mismatch remains rejected; matching parent/revision hashes appear with visual comparison.

### V07 Complete candidate and comparison result inspection (P2)

Selected candidates show all seven organic or four oxide descriptors, stored
ranking score/scope, chemical identity, complexity and scalar oxide validation.
Comparison rows display exact final values and the numerical tie tolerance.
Generation mappings, anchor scope, nested site coordination, rejected candidates
and matched conditions remain available in expandable technical records.
Improving those nested details into dedicated tables is an ergonomic follow-up;
the underlying values and reasons are retained.

Acceptance:

- Organic candidate inspector includes all seven descriptors plus actual ranking score and objective; oxide inspector includes all four descriptors and existing validation metrics.
- Selecting a candidate updates metadata, atom mappings and 3D from one candidate hash.
- Rejected/ranking-limited cases and tied supplied scenarios remain distinguishable from failed chemistry.

## Precision and scientific scope

ETKDG seed-42 conformers and ideal radius-derived ordered oxide cells are genuine tool-generated coordinates, but no optimization or measured geometry accuracy is established. RHF/STO-3G is fixed-geometry energy only. Interface ODEs produce state/flux series, not atomic trajectories.

Full precision means retaining the source/output numeric values and exact identities during visualization and export. It does not establish experimental accuracy. Renderer quality and image resolution should be reported separately from geometry provenance and numerical solver tolerances.

Coordinate CSV and display-only view JSON preserve numeric values and reference
the source geometry hash. A view JSON is not an original hash-verifiable study:
JavaScript can serialize a Python `0.0` as `0`, preserving its numeric value while
changing the canonical envelope. The complete server-produced study export
retains the original values and numeric types for verified study reopening.

No atomistic interface geometry or time-dependent atomic coordinates currently exist. Show the actual species graph, declared reaction network, state populations and candidate structures in linked parts. Label any new molecular conformer separately from a calculated interface state.

## Integration and verification

Independent review is sealed in
`build/visual-workbench-code-review-20260912.json`, with review hash
`sha256:56ed5760cbb3dbfca6f9365052055f9dde9d1230cd03ce4812917b5cc0819954`.
It binds the reviewed isolated files and records five resolved findings:
Structure Lab revision restoration, CSV formula prefixes, repeated-cell drawing
bounds, imported graph-layout bounds and imported time-unit labeling.

The reviewed checks passed: 27 interface data/boundary tests, nine geometry
value/export tests, 21 viewport-binding scenarios, 18 independent handler
scenarios and five independent interface lifecycle checks. The updated Design
UI harness separately passes all 34 existing lifecycle/evidence scenarios plus
three pending-request clock/invalidation scenarios, for 37 total. These use
retained or synthetic inputs and do not emulate WebGL, browser layout, real
downloads or native pixels. No stress run or new chemical calculation was used
for these checks.

The integration is recorded in `build/visual-source-integration-20260912.json`.
The later camera repair has separate source evidence in
`build/visual-full-20260912b-source.json` and supplemental review in
`build/visual-camera-source-review-20260912.json`; the earlier code review does
not silently acquire that later source identity.

Actual browser evidence is retained under
`build/ui-acceptance/visual-upgrade-20260912`. Two unsigned, read-only verification
receipts bind exact files and DOM claims:

- `actual-oxide-export-verification-20260912.json` verifies all 40 atoms and every
  base/display coordinate in the direct study `e2dee045...`, exact metadata and
  cell values, and the three interface selectors and retained final samples.
  It also checks the missing-parameter rejection and the completed model DOM.
  Its oxide PNG predates that direct study and the final camera repair, so it
  provides no same-camera or final-package claim.
- `actual-model-camera-revision-verification-20260912.json` verifies the complete
  exported study `9a3e1a40...`: five succeeded modules, eight organic candidates,
  eight oxides and three interface models in 18.656075 seconds, displayed as
  18.7 seconds. Export SHA-256 is
  `67224ef74628058127710d066f5ee65a26fba77f3275ebcd2c3e102a7561143a`.
  Original values, numeric types and record envelopes match; the workspace and
  export files differ only in CRLF/LF line endings. The browser operator reopened
  this full export in a fresh page; retained DOM identifies the imported record
  and keeps its origin-unverified qualifier.

The second receipt also verifies three byte-identical organic view downloads
around two operator-performed Reset clicks, the camera-fixed PNG
`0e214b15...` at 2048 × 1040, and all 33 revision displacement rows. The retained
revision changes one x coordinate by 0.125 Å, yielding maximum 0.125 Å and RMS
0.02175970699446223 Å. Preparing a compiled-source calculation while a Lab
revision is displayed reports the binding mismatch with approval/run disabled.
The independent receipt reviewer checked files, PNG structure and DOM text;
browser actions and visual inspection were performed by the browser operator.
These illustrative UI runs are outside the held-out model suite.

The previous full regression was intentionally interrupted at the last observed
97% progress. `build/visual-full-20260912-interrupted-addendum.json` retains that
classification: no JUnit result was produced and the prior owned processes were
gone. Ruff formatting/lint and mypy had passed before interruption. The separate
rerun `build/visual-full-20260912b.json` completed with all 809 tests passing in
574.48 seconds and one existing ASE deprecation warning. Its JUnit file,
`build/visual-full-20260912b.xml`, records 809 cases with no skips, failures or
errors; Ruff formatting/lint and mypy also passed. The completion receipt is
`build/visual-full-20260912b-completion.json`. The 20 observed overlay/camera file
hashes match before and after the run. This implementation regression does not
replace complex model acceptance.

The remaining acceptance work is:

- Freeze the integrity-repaired source and run the complete required regression
  and static checks; the earlier 809-test result remains bound to its old source.
- Retain the completed 809-test regression, interrupted attempt and earlier
  model reports with their original source identities through final packaging.
- Close remaining actual browser scenarios, including the new computation result
  UI, supplied-pair comparison and partial-result handling; preserve the scoped
  direct/model, export, reopen, revision and rejection observations above.
- Bind exact input/result geometry and full series values to the final source
  and package through retained API/DOM evidence and actual interactions.
- Rebuild and rebind package/source evidence. Do not use water or elemental Cu fixtures as complex-chemistry promotion evidence.
- Complete the original model gates against the final visual-source identity,
  including candidate repeats, the preserved E2B comparison and Structure acceptance.

The complete output-to-part inventory and exact source locations are in `build/workbench-visual-coverage-audit-20260912.json`.

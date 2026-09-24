# Workbench acceptance and UI review — 2026-09-05

## Decision and scope

The existing checkout passed the executable regression gate before UI changes:
225 tests passed with no skips, Ruff formatting/lint passed, and strict mypy
passed. Acceptance covers the implemented compiler, CIF probe/import, resolved
imports, surface/interface declaration contracts, and the installed optional
backend smoke checks exercised by that suite. It does not establish scientific
accuracy or completion of the broader Workbench roadmap.

Git reports the project files as untracked. There is no usable committed base
for attributing an exact diff to GLM, so this is acceptance of the current
checkout, not a claim about individual authorship. No commit, push, or merge
was performed.

## Frontend delivered

Run `scripts/start-workbench.ps1` from the repository and visit
`http://127.0.0.1:8765`. The existing `.venv` is required. The service is a
source-checkout preview, using Python's standard-library HTTP server and local
HTML/CSS/JavaScript; no new runtime dependency or external CDN is needed.

- Chinese desktop workspace with example navigation and responsive layout.
- Editable `.chem` source and local text-file import.
- Real compiler requests, structured diagnostics, and source selection from a
  clicked diagnostic.
- Object overview, ChemIR, unsigned review packet, and actual static registry.
- Download controls for successful compilation outputs.
- Immediate output invalidation on edits and stale-response suppression.
- Loopback binding, exact Host/origin checks, fixed static-file routing, request
  size limits, CSP, and no arbitrary host-file access from source compilation.

## Verification evidence

- Baseline: `scripts/verify.ps1` — 225 passed, one dependency warning, 63.74 s.
- Final gate after UI changes: 228 passed, no skips, one dependency warning,
  64.97 s; Ruff formatting/lint and strict mypy also passed.
- Browser: water compiled to 3 objects; copper surface example compiled to 7
  objects with 5 review-required diagnostics.
- Browser: editing invalidated old results and disabled both downloads.
- Browser: invalid molecule returned CHM2002 and no downloadable artifacts.
- Browser: clicking CHM2002 focused the editor at source offset 9 (line 2).
- Browser: review tab displayed `self_consistency` and `unsigned`; registry tab
  displayed the real `chem.cif.probe` registration.
- Browser: desktop visual inspection and 390 x 844 responsive inspection passed;
  viewport was reset. No captured browser warning/error logs were present.
- Browser review download control was invoked. The browser's final download
  destination was not exposed, so independent reopening of that exact browser
  download is not claimed.
- Independently saved the UI API's review output to
  `build/ui-acceptance/water.review.json`. `chem inspect` returned
  `bindings_valid: true`, `signature_status: unsigned`, and
  `verification_scope: self_consistency`.
- Added tests for valid review bindings, failure without artifacts, foreign
  Host/origin rejection, static path confinement, and oversized requests.

The warning is ASE's use of NumPy array shape assignment deprecated by NumPy
2.5. It did not fail the installed copper EMT acceptance test. No pressure
tests, installer/package verification, or full accessibility audit were run.

## Review findings and remaining boundaries

The README described the old empty-registry slice and unavailable conversion.
It was updated to the current checkout and now documents the UI launch and
limits. Some historical wording remains in deeper documentation and the review
packet's generic `not_claimed` reason ("format adapters are not active"). The
actual registry has the bounded CIF adapter; that generic reason must not be
used as a capability inventory. No positive scientific claim is conferred.

UI compilation intentionally uses declaration-only compilation: referenced
CIF files are not resolved through the browser endpoint. CLI CIF import and
`--resolve-imports` retain their existing separate paths. Editor changes live
in memory and are lost on reload. There is no project save workflow, molecular
3D viewer, execution queue, approval ledger, or packaged desktop application.
The current UI does not expose backend execution, publication, or laboratory
control.

## Deferred work

1. Add project save/open and explicit unsaved-change handling.
2. Add a reviewed file-bundle import route with source-relative CIF resolution.
3. Add typed structure visualization only after supported geometry import.
4. Reconcile historical documentation and generic review reasons without
   changing authority or accidentally invalidating legacy review packets.
5. Implement the plan's governed execution layer before exposing compute UI.
6. Package and test a desktop release, then audit keyboard and contrast access.

These items are recorded for later work and were not started in this change.

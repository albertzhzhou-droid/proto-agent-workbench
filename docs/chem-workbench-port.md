# Chem Workbench integration

The Chem selector opens the complete existing chemistry workspace inside Proto
Workbench. Scientific implementation files are preserved from the local Chem CLI
working tree; the integration adds process ownership, a local bridge, deployment
bindings, and the shared paper/ink presentation with the supplied Anthropic fonts.

## Navigation and presentation

Use the application selector at the far left of the top bar, in the original
`Proto CLI` position, to switch between **Proto CLI** and **Chem CLI**. Both
choices use that same fixed location. Chem now uses the shared **Chat / Design /
Compute** switch and the same sidebar dimensions as Proto. Structure editing is
part of Design: one central 3D canvas with Source, Geometry, Calculate, Refine,
Evidence and Plan inspector panels. XDL documents remain accessible in Design.
The top breadcrumb identifies the active chemistry section; the embedded view
does not repeat a separate `Chemistry` subtitle beneath the application selector.

The chemistry interface uses the same light/dark paper and ink theme as Proto.
Neutral buttons, selected states, menus, editors, evidence panels, and result
controls share the same visual rules. The original interactive molecular and
crystal viewports, atom inspection, plots, tables, refinement panels, export
controls, and scientific result identities remain available.

The same user-supplied Anthropic fonts are applied across both workspaces:
Sans Text/Display for navigation, controls and compact interface headings;
Serif Display for editorial headings and Serif Text for reading-oriented copy;
Mono Web for source, coordinates, hashes, numerical tables and exact results.
UI overlays are loaded separately from the original scientific source, preserving
the existing control IDs and workflow handlers. The Claude-inspired presentation
does not import Claude application code or replace the scientific workspace with
a chatbot layout.

## Preserved chemistry capabilities

- Design Studio: organic scaffold substitution and descriptor screening; ordered
  charge-neutral multication oxide construction; the existing
  electrode/electrolyte, catalyst/reactant, and solid/liquid conditional models;
  supplied candidate/scenario comparison; study and exact interface exports.
- Structure tools inside Design: `.chem` editing, compile diagnostics, ChemIR/review exports,
  CIF attachment import, original 3D geometry views, SDF/SMILES import, coordinate
  revisions, Cu(111) geometry construction, comparisons, and project revisions.
- Governed calculations: the existing prepare, approve, run, cancel, history,
  result, and evidence interfaces, including the original refinement preparation
  and approval routes. All profile restrictions and validation semantics remain.
- XDL inspection: the already installed standalone XDL 2.1.0 parser is exposed
  through `PlaceholderPlatform`, with XML/JSON import and round-trip exports.
  The existing inspection does not compile or execute a procedure.

The integrated Computation workspace and shared Chat now expose ten local
scientific operators; see [Chem science tools](chem-science-tools.md) and
[Scientific methods and sources](chem-science-operators.md). These additions live
outside the immutable snapshot. The legacy generic `chem compute` and `chem fetch`
CLI placeholders are unchanged.
The ferrocene preview remains rejected by the original compiler (`CHM2001`).
Surface reaction declarations retain their existing representation-only limits;
the separately implemented conditional interface calculations retain their
original assumptions. Porting the refinement code does not add scientific
validation or change its existing acceptance state.

## Source, runtime, and data

`apps/proto-workbench/runtime/chem-workbench/snapshot-manifest.json` records the
254 source/resource files and their SHA-256 hashes, including the uncommitted
refinement implementation present at capture. The source identity is
`4fab5293651958bc7763b74f510d341e2f5951538a77546b611735d6d95f655d`.
The original Chem repository is not changed. The snapshot includes its MIT
license and existing third-party notices; installed Python, Psi4 and XDL
environments are not copied into the application.

At launch the checked source is expanded under the selected Proto workspace's
`build/chem-workspace`. Its original resource-relative data layout is preserved:
new studies and calculations are stored under
`build/chem-workspace/build/workspace`; exported files remain inside the same
owned root. This layout preserves the refinement code's path and evidence
bindings without rewriting scientific algorithms.

The first launch copied nine saved studies and one project revision from the
original Chem workspace as exact bytes. The migration receipt records each
file hash. Existing plans, approvals, jobs, runs, and refinement preparations
remain in the original Chem repository; execution approvals are not transferred.

The original working tree contained a generated compute registry that did not
match its newer implementation bytes. The runtime launcher uses Chem's existing
`scripts/build_registry.py` to regenerate that derived registration only in the
expanded copy. `runtime-registration-receipt.json` binds the original and derived
registry hashes, generator hash, and immutable source manifest. This operation
does not issue an approval or change any calculation profile.

The default configuration reuses the original local installations. Trusted host
configuration can override `PROTO_CHEM_PYTHON`, `CHEM_PSI4_PREFIX`, and
`PROTO_CHEM_XDL_PYTHON`; these executable paths are not renderer arguments.
The bridge forwards Chem's existing Windows runtime descriptors, including the
real processor architecture needed by QCEngine/py-cpuinfo.

## Bridge contract

`ChemWorkbenchService.start(parentOrigin)` returns a live status and an opaque
token URL on a newly owned loopback port. The preview's `GET /__proto/chem`
and the desktop's `chem:open` IPC use the same service. The iframe receives no
Electron API. The bridge permits only the existing seven GET and 21 POST API
routes, plus the two XDL inspection routes; original request limits remain.

The upstream Chem HTTP handler is unchanged: its exact loopback Host/Origin,
anti-framing headers, and scientific input validators remain in place. The
presentation bridge serves the full original static interface with separate UI
overlays and allows embedding only by the invoking Workbench origin. API bytes
and scientific record hashes pass through unchanged. Child processes and their
descendants are stopped when their owning service closes.

To check the snapshot and copy current UI overlays during a build:

```powershell
cd apps/proto-workbench
node scripts/sync-chem-workbench.mjs
```

Refreshing the scientific snapshot is a separate explicit maintenance action:

```powershell
node scripts/sync-chem-workbench.mjs --source "C:/Users/pc/Documents/Chem CLI"
```

Normal builds do not silently import subsequent changes from the sibling Chem
repository.

## Integration evidence

- `build/chem-integration-qa/acceptance.json`: 18 successful checks covering
  real service launch, bridge restrictions, original examples and diagnostics,
  the five workflow catalogue entries, migration, a completed combined study
  with eight organic candidates, eight inorganic candidates and three interface
  calculations, exact study export/reopen, and real XDL import/round trips.
- `build/chem-integration-qa/compute-acceptance.json`: real Cu/ASE-EMT and
  water/Psi4 calculations both succeeded through the complete original approval
  workflow; submission before approval was rejected on fresh source bindings.
- `build/chem-integration-qa/xdl/acceptance.json`: seven direct XDL checks,
  including Unicode and invalid input behavior.
- `build/chem-integration-qa/ui-acceptance.json`: browser layout measurements,
  light/dark themes, font roles, saved study and 3D inspection, compiler error
  recovery and XDL UI checks. Both product switches start at `(252, 14)` and
  both mode sliders at `(13, 69)` in the inspected expanded-sidebar viewport.
- `build/chem-integration-qa/host-regression.log`: 29 focused host regression
  checks passed. `desktop-build.log` records the completed desktop build;
  `module-integrity.json` records enforcement against the resulting resources.
- The pre-rebinding registry failure and the first missing-runtime-environment
  observation remain retained next to the final compute report.

These are local integration checks. They do not establish a clean-machine
installer, broader chemistry accuracy, or new refinement validation.

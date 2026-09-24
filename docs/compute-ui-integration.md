# Compute workspace integration

The original acceptance below covered the 119-method catalog. The current 124-method catalog and live source UI are documented in [Science tool expansion](science-tool-expansion.md).

Original verification on 2026-09-19 covered 119 offline methods
in 15 collections, including 44 methods with workspace file inputs. This
acceptance covers source execution, the browser UI and the desktop source build;
it is not a new installer or hosted CI acceptance.

## Catalog and navigation

The Python catalog supplies each method's collection and domain. Both desktop
and browser preview use that metadata, replacing the renderer's hardcoded list
of eight statistical IDs and a single catch-all biological group. New methods
inherit their module's collection. A parity test detects missing preview entries,
changed schemas, missing file declarations and missing collection metadata.

The left navigation exposes statistics and learning (10 methods), biology (59),
simulations (12), imaging (36) and chemistry (2). The method library adds
collection and file-input filters. Search matches method IDs, titles,
descriptions, collections and supported extensions. The Design / Compute switch
keeps its existing whole-workspace behavior.

## Shared input and result patterns

- Every method uses the same field component: required state, defaults, numeric
  ranges, explicit enum choices, boolean choices and accessible error feedback.
- Arrays and objects use formatted JSON with expandable nested field guidance.
  File sequences accept one workspace-relative path per line or a JSON array,
  retaining order. Extension, byte and file-count limits appear beside the field.
- Client validation identifies the field to fix; host schema and workspace
  containment checks remain authoritative. The desktop IPC ID grammar now accepts
  digits, including P1, CD4, CYP2C19 and 3D method identifiers.
- Scalar result summaries, bounded record/metric tables, explicit time-series
  trajectories, the full JSON, interpretation notes and provenance share one
  layout. Tables show at most 50 rows and eight scalar columns; complete values
  remain in JSON. Each trajectory has its own vertical scale and uses the source
  time coordinates. No axes are inferred for unrelated numeric arrays.
- Results / Run inputs / Provenance support arrow-key navigation. Editing inputs
  leaves the last result intact and displays an explanation. Large results omitted
  by the backend point to their complete workspace artifact.

All added surfaces use paper/stone/ink tokens. Serif titles, Sans controls and
Mono scientific values inherit the Anthropic font hierarchy. Dense tables scroll
inside their panel instead of breaking numeric values across lines. Below the
desktop breakpoint, input and output panels stack vertically.

The original static browser preview labels results as recorded example replays and rejects altered data.
It does not claim installed computation dependencies, read the referenced files
or create native run artifacts. The desktop uses the current runtime dependency
catalog and the real fixed-handler computation path. Connector-gated remote
services remain outside this offline method catalog.

## Verification

| Check | Evidence |
| --- | --- |
| All 119 methods | Example values round-trip through the form parser and both desktop IPC schemas; every recorded result is present and accepted by shared result renderers. |
| Registry parity | UI catalog IDs, categories, schemas and file contracts match the current Python catalog. |
| Python computation tests | 128 passed. |
| Node computation tests | 16 passed, including source MCP execution and workspace publication. |
| New native execution | ABR P1 example returns latency 2 ms and amplitude 1.6; six synthetic microscopy frames return displacement 10 with per-file hashes and retained order. |
| TypeScript | Typecheck passed. |
| Desktop build | Passed; all 16 module integrity checks verified. |
| Browser interaction | Medical collection, ordered file inputs, invalid traversal, restore/run example, nested parameter guide, batch-result table, ODE trajectories, provenance, 3D method search, keyboard tabs and Design / Compute state retention checked. |
| Responsive and type audit | Light/dark reviewed; 1024 × 768 and 800 × 700 have no page-width overflow. Computed title, control, data-entry and chart fonts use the Anthropic families. |

Logs and integrity receipt are in `build/compute-ui/`. The build required a retry
after Windows briefly rejected a workspace-template directory rename. Existing
SciPy/scikit-image warnings appeared in the Python tests; no computation tests
failed. No dependency installation or algorithm-equivalence claim is added by
this UI acceptance.

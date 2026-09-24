# Design and Compute workbench

## Product brief

The September 18, 2026 redesign separates the original design workflow from Biomni computations through a horizontal, top-left Design / Compute switch. Each mode occupies the full work surface; the existing design routes remain in left navigation. Switching modes keeps both work surfaces mounted, preserving an open structure, sequence selection, analysis inputs, and result snapshot.

The user's final direction is explicitly neutral: warm paper, stone borders, and ink. Neither fluorescent green nor terracotta decorates the working interface. Color is reserved for scientific encodings and restrained semantic feedback. Serif headings, compact navigation, fine borders, and matte buttons provide an editorial, hardcover-book character without decorative images or textures that compete with data.

## Public reference research

The reference material was inspected in the browser, including the actual public interactive examples linked from [Claude Science's official product page](https://claude.com/product/claude-science). The installed native Claude application was not inspected.

- The [official artifact viewer example](https://assets.claude.ai/brand/artifacts/product/science/artifact-hero-samosa-viewer.html) places project navigation at the left, a scientific figure centrally, and code, inputs, execution history, and other context in an adjacent panel. Its work surfaces are predominantly neutral. This supports separating persistent navigation, the primary artifact, and contextual evidence.
- The [official protein example](https://assets.claude.ai/brand/artifacts/product/science/protein_dashboard.html) gives a molecular viewport substantial space and puts confidence, domains, and variants alongside it. Color communicates scientific data. Proto retains its genuine Mol* structure viewer and linked residue mapping.
- The [official Science announcement](https://www.anthropic.com/news/claude-science-ai-workbench) describes analysis and reproducibility as core workflow concerns. Proto makes the saved run inputs and provenance directly accessible beside each computation result.

These are public product references, not copied proprietary implementation details or an assertion of feature parity with Claude Science. The later user-supplied local font integration is documented below.

## Implementation

`WorkspaceNavigation.tsx` owns mode selection and left navigation. The original routes, run selection, archive visibility, settings, local models, and evidence tools remain accessible. Less frequent global tools move into a compact Tools menu; keyboard shortcuts remain available.

`paper-workbench.css` supplies warm neutral light and dark themes, persistent mode controls, adaptive navigation, matte buttons, and scientific workspace layouts. DNA colors are muted and shared between the circular map and linear navigator; coordinates and feature meaning are unchanged. The protein viewport uses reduced-chroma chain colors and responds to theme changes while retaining geometry and residue interaction. Scientific confidence and residue schemes retain their conventions. The expanded design summary wraps its trust labels instead of allowing them to collide with the title and metrics.

`ComputeWorkspace.tsx` provides the 15-tool method library, search, statistical and biological categories, schema-derived inputs, execution feedback, scalar results, input observation plots, full JSON, original run inputs, provenance, downloads, and session history. Plots show submitted observations, not simulated predictions. Saved results retain their own input snapshots after the form is edited.

The desktop bridge exposes only `compute:catalog` and `compute:run`. Requests contain a tool identifier and JSON arguments, with bounded IPC validation. The main process checks the Biomni module setting, creates a unique request under `build/compute-inputs`, and executes the existing computation MCP tool through a dedicated owned process and the workspace write queue. Python validates the method schema and creates result, input, manifest, and provenance artifacts. Workspace switching is held during the operation.

Browser preview replays source-calculated examples only. Editing input cannot silently reuse a canned result: requests different from the recorded example are refused. It creates no workspace run or claimed provenance. A small attributed GFP/PDB 1GFL reference exercises the genuine structure renderer using checked source bytes; its fixtures retain source, license, and digest information.

## Verification

- TypeScript checking passed.
- 55 focused transport, computation, schema, path, visualization, and security tests passed, including a real Python computation through the new UI service.
- All 15 browser example receipts are tested as explicit previews; modified examples are refused.
- The final focused rerun passed 19/19 after the UI refinements, and TypeScript checking passed again.
- The full Node regression run recorded 819 passes and one known intermittent Windows inherited-stdio cleanup failure in unchanged `owned-process.test.mjs:268` (820 tests). Source-marker tests were updated where the navigation component moved; their behavioral boundaries remain checked.
- The desktop build completed with a 16-module integrity manifest. This verifies a source build, not an installer release or hosted CI.
- Browser interaction evidence is recorded in `build/biomni-research/ui-browser-acceptance.md`.

Logs: `build/biomni-research/ui-tests.log`, `ui-contracts-recheck.log`, `ui-final-focused.log`, `ui-regression-final.log`, and `ui-desktop-build.log`.


## Typography and state consistency follow-up

The supplied Anthropic archives contain 46 distinct OTF faces (2,933,356 bytes). The original bytes are included in `apps/proto-workbench/src/renderer/assets/fonts/anthropic/`, with source archive names, copyright metadata, and SHA-256 hashes in `manifest.json`. `fonts.css` registers the exact weights and styles. These are user-supplied assets for this local workspace; the archives did not include a redistribution license. This integration does not classify the fonts as open source or grant redistribution rights.

| Role | Family |
| --- | --- |
| Navigation, controls, labels, utility copy | Anthropic Sans Text |
| Compact utility headings | Anthropic Sans Display |
| Page titles, editorial and dialog headings | Anthropic Serif Display |
| Reading passages and explanatory prose | Anthropic Serif Text |
| Code, identifiers, scientific values, sequence text | Anthropic Mono Web |

Native CJK fallbacks remain available. Initial layout waits for the four principal faces; Monaco, CGView, sequence labels, and computation canvas labels use the same font system. All 46 source font hashes match the OTF assets in the final desktop build.

Legacy decorative palettes in the shared, DNA, and protein stylesheets now resolve through the warm neutral theme tokens. Shared hover, selection, focus, and disabled treatments cover secondary dialogs as well as the main pages. Scientific color encodings and meaningful error/warning statuses remain distinct. The top bar now contains its controls in normal layout flow, and the Tools menu closes on an outside click, Escape, or selection. Short screens give recent research its own scrolling region so it cannot overlap utility navigation.

## Live models and Design extensions

The browser preview no longer uses a fixed model fixture catalog. A development-only, same-origin route reads `GET /api/v1/models` through the same LM Studio provider and schema parser used by the desktop. It accepts no arbitrary destination, model lifecycle mutation, or inference request. Credentials, when configured, stay server-side. POST/DELETE are rejected with 405 and foreign origins with 403.

Overview readiness, the model page, the top model switcher, and settings share a current catalog snapshot. Visible pages refresh every five seconds and when focus/visibility returns. Catalog and status derive from the same successful response; a failed query clears visible models and connection claims. Desktop startup ignores persisted MCP-era inventory until authoritative discovery succeeds. An explicit Workbench binding must match a currently reported loaded instance. Native preflight and resume capture also refresh the model catalog before evaluating readiness.

The final live comparison found 11 catalog models and zero loaded instances, matching LM Studio Server exactly. GPT-OSS was absent. Reachable server, discovered model, loaded instance, and Workbench connection are separate states. No model was loaded, unloaded, or invoked for this UI verification.

The model page now has a keyboard-accessible horizontal Models / Design plugins & Skills switch. It preserves the two panels while switching. The extensions panel supports search, staged selection, pending enable/disable labels, Apply selection, and Reset. Ten optional modules use the existing persistent module settings and tool-exposure gates. Six core modules remain required. Seven actual repository Skills are bundled from their `proto-skill.json`, `SKILL.md`, and local references, retaining source hashes. Selected Skill instructions are included in new native mission system messages; unknown IDs are rejected or normalized out, and enabling guidance does not grant additional tool permissions. Configuration cannot change during an active desktop mission.

Browser extension preferences are session-only and marked accordingly. Model inventory in the preview is live and read-only; loading, unloading, and native mission execution use the desktop bridge. This follow-up verifies configuration and prompt composition, not model generation quality or installer acceptance.

## Follow-up verification

- Final TypeScript check passed.
- An initial full Node run passed 826/826. The final broad rerun passed 825/826, with one Windows `EPERM` rename failure in the unchanged workspace file test. The isolated rerun of that file and the affected renderer contracts passed 10/10. Model disappearance, external unload, empty catalog, connection failure/recovery, stale Overview readiness, saved legacy inventory, and Skill activation tests passed.
- Final desktop build and independent enforced integrity verification passed for all 16 modules. Manifest SHA-256: `502863d8ba0d1d5b5f86cc94280b12a245b69c9e8a31cf46007b1aed91b6fe97`.
- UI coverage and evidence limits are recorded in `build/ui-consistency/acceptance.md`. The final browser checks produced no new console warnings or errors after the temporary development import error was fixed.
- Evidence: `build/ui-consistency/full-tests.log`, `final-targeted-tests.log`, `desktop-build.log`, `module-integrity.json`, `lm-studio-live-check.json`.
